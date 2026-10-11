'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'parts.db');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Customer accounts. password_hash is NULL for an account created via Google or Apple.
-- provider_id is that provider's own user id, so a repeat sign-in finds the same account
-- even if the person's email changes.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  auth_provider TEXT NOT NULL DEFAULT 'local' CHECK (auth_provider IN ('local','google','apple')),
  provider_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider ON users (auth_provider, provider_id)
  WHERE provider_id IS NOT NULL;

-- Spec 8.1. import_source is an addition: where the owner says the car was imported from.
-- It is not used for matching, but it gives you real data about Rwanda's import channels.
-- user_id is an addition: which signed-in customer this car belongs to (NULL if registered
-- as a guest, or added directly by an admin).
--
-- plate_number is deliberately NOT unique: in Rwanda a plate is bound to a registration event
-- (the person), not to the chassis, so the same plate string can legitimately belong to a
-- different car later. VIN is the trusted identity key (it never changes), so it alone gets a
-- unique index below, scoped to rows where it is known. plate_number is kept only as a
-- convenience label for lookup -- "WHERE plate_number = ? ORDER BY id DESC LIMIT 1" (see
-- getVehicleByPlate in server.js) always resolves to whichever car most recently claimed it.
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plate_number TEXT NOT NULL,
  vin TEXT,
  wmi_code TEXT,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  generation TEXT,
  year INTEGER NOT NULL,
  engine TEXT,
  transmission TEXT,
  origin_market TEXT,
  drive_side TEXT CHECK (drive_side IN ('LHD','RHD')),
  import_source TEXT,
  owner_phone TEXT,
  registered_by TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vehicles_plate ON vehicles (plate_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicles_vin ON vehicles (vin) WHERE vin IS NOT NULL;

-- Spec 8.5. "keywords" powers the symptom search ("brake noise" -> Front Brake Pad).
CREATE TABLE IF NOT EXISTS part_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('model_specific','universal')),
  keywords TEXT NOT NULL DEFAULT ''
);

-- Spec 8.2. origin_market is an addition (the spec's own business rules require it):
-- NULL means "applies to any origin". generation and engine are also wildcards when NULL.
CREATE TABLE IF NOT EXISTS fitment_reference (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  oe_number TEXT NOT NULL,
  part_category TEXT NOT NULL,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  generation TEXT,
  year_start INTEGER NOT NULL,
  year_end INTEGER NOT NULL,
  engine TEXT,
  origin_market TEXT,
  confidence_level TEXT NOT NULL CHECK (confidence_level IN ('HIGH','MEDIUM','LOW')),
  source TEXT NOT NULL,
  verified_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fitment_lookup ON fitment_reference (make, model, part_category);
CREATE INDEX IF NOT EXISTS idx_fitment_oe ON fitment_reference (oe_number);

-- Spec 8.3. vetted + access_code are additions: "vetted" gates the Verified Genuine badge,
-- "access_code" is the simple shop login.
CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  whatsapp_number TEXT,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  address_text TEXT,
  vetted INTEGER NOT NULL DEFAULT 0,
  access_code TEXT NOT NULL UNIQUE,
  onboarded_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Spec 8.4
CREATE TABLE IF NOT EXISTS shop_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  oe_number TEXT,
  part_category TEXT NOT NULL,
  universal_spec TEXT,
  price_rwf INTEGER NOT NULL CHECK (price_rwf > 0),
  stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  condition TEXT NOT NULL CHECK (condition IN ('genuine','aftermarket')),
  photo_url TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_listings_oe ON shop_listings (oe_number);
CREATE INDEX IF NOT EXISTS idx_listings_cat ON shop_listings (part_category);

-- Spec 8.6
CREATE TABLE IF NOT EXISTS garages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  whatsapp_number TEXT,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  address_text TEXT,
  specialties TEXT
);

-- Spec 8.7
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_phone TEXT NOT NULL,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  shop_listing_id INTEGER REFERENCES shop_listings(id),
  garage_id INTEGER REFERENCES garages(id),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','confirmed','completed','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Backs the spec's /admin/fitment-reference/gaps report: what customers searched for that
-- we could not answer. Empty strings (not NULL) so the UNIQUE key works.
CREATE TABLE IF NOT EXISTS search_gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER NOT NULL,
  engine TEXT NOT NULL DEFAULT '',
  origin_market TEXT NOT NULL DEFAULT '',
  part_category TEXT NOT NULL,
  times_searched INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (make, model, year, engine, origin_market, part_category)
);
`;

function openDb(dbPath = process.env.DB_PATH || DEFAULT_DB_PATH) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  ensureColumn(db, 'vehicles', 'user_id', 'INTEGER REFERENCES users(id)');
  migratePlateNotUnique(db);
  ensureCategories(db);
  return db;
}

/** Upgrade a database file created before plate_number stopped being the identity key. A column's
 *  UNIQUE constraint can't be dropped with ALTER TABLE in SQLite, so this rebuilds the table
 *  without it when an old one is found, preserving every row (and re-adds the vin unique index,
 *  since dropping the table drops its indexes too). No-ops on a database that never had it. */
function migratePlateNotUnique(db) {
  const hasOldConstraint = db.prepare("PRAGMA index_list('vehicles')").all().some((idx) => {
    if (!idx.unique || !idx.name.startsWith('sqlite_autoindex_')) return false;
    const cols = db.prepare(`PRAGMA index_info('${idx.name}')`).all();
    return cols.length === 1 && cols[0].name === 'plate_number';
  });
  if (!hasOldConstraint) return;
  tx(db, () => {
    db.exec(`
      CREATE TABLE vehicles_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plate_number TEXT NOT NULL,
        vin TEXT,
        wmi_code TEXT,
        make TEXT NOT NULL,
        model TEXT NOT NULL,
        generation TEXT,
        year INTEGER NOT NULL,
        engine TEXT,
        transmission TEXT,
        origin_market TEXT,
        drive_side TEXT CHECK (drive_side IN ('LHD','RHD')),
        import_source TEXT,
        owner_phone TEXT,
        registered_by TEXT,
        user_id INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec(`INSERT INTO vehicles_new
      (id, plate_number, vin, wmi_code, make, model, generation, year, engine, transmission,
       origin_market, drive_side, import_source, owner_phone, registered_by, user_id, created_at)
      SELECT id, plate_number, vin, wmi_code, make, model, generation, year, engine, transmission,
       origin_market, drive_side, import_source, owner_phone, registered_by, user_id, created_at
      FROM vehicles`);
    db.exec('DROP TABLE vehicles');
    db.exec('ALTER TABLE vehicles_new RENAME TO vehicles');
    db.exec('CREATE INDEX IF NOT EXISTS idx_vehicles_plate ON vehicles (plate_number)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicles_vin ON vehicles (vin) WHERE vin IS NOT NULL');
  });
}

/** Upgrade a database file created by an earlier version that did not have this column yet. */
function ensureColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/** Part categories are real reference data (not demo data), so they exist even in a clean database. */
function ensureCategories(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM part_categories').get().n > 0) return;
  const ins = db.prepare('INSERT INTO part_categories (name, type, keywords) VALUES (?, ?, ?)');
  tx(db, () => { for (const c of CATEGORIES) ins.run(...c); });
}

/** Run fn inside a transaction; roll back on any error. */
function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Real reference data: the part categories customers can pick from. Add new ones here.
// "keywords" are the everyday words people use, so "brake noise" finds Front Brake Pad.
const CATEGORIES = [
  ['Front Brake Pad', 'model_specific', 'brake,brakes,braking,squeal,squealing,noise,grinding,stopping,pedal'],
  ['Rear Brake Pad', 'model_specific', 'brake,brakes,rear brake,noise'],
  ['Oil Filter', 'model_specific', 'oil,filter,service,maintenance'],
  ['Air Filter', 'model_specific', 'air,filter,service,dust,power'],
  ['Front Bumper', 'model_specific', 'bumper,accident,crash,body,damage'],
  ['Headlight Assembly', 'model_specific', 'headlight,light,lamp,night,dim'],
  ['Battery', 'universal', 'battery,start,starting,dead,flat,electrical'],
  ['Wiper Blade', 'universal', 'wiper,wipers,rain,windscreen,windshield,streaks'],
  ['Engine Oil', 'universal', 'engine oil,oil,service,lubricant,oil change'],
];

// ---------------------------------------------------------------------------
// DEMO DATA. Everything below is invented so you can click through the app.
// Part numbers all start with "DEMO-": they are NOT real OE numbers.
// Shops, garages, prices and phone numbers are fake. Never ship this to real customers.
// ---------------------------------------------------------------------------

const DEMO_SOURCE = 'DEMO DATA (invented, not a real part number)';

// [oe, category, make, model, generation, yearStart, yearEnd, engine, origin, confidence]
const FITMENT = [
  // Toyota RAV4 (XA40)
  ['DEMO-TYT-XA40-FBP-01', 'Front Brake Pad', 'Toyota', 'RAV4', 'XA40', 2013, 2018, null, null, 'HIGH'],
  ['DEMO-TYT-XA40-OF-20', 'Oil Filter', 'Toyota', 'RAV4', 'XA40', 2013, 2018, '2.0L Petrol', null, 'HIGH'],
  ['DEMO-TYT-XA40-OF-25', 'Oil Filter', 'Toyota', 'RAV4', 'XA40', 2013, 2018, '2.5L Petrol', null, 'HIGH'],
  ['DEMO-TYT-XA40-AF-01', 'Air Filter', 'Toyota', 'RAV4', 'XA40', 2013, 2018, null, null, 'MEDIUM'],
  ['DEMO-TYT-XA40-FB-01', 'Front Bumper', 'Toyota', 'RAV4', 'XA40', 2013, 2018, null, null, 'MEDIUM'],
  ['DEMO-TYT-XA40-HL-01', 'Headlight Assembly', 'Toyota', 'RAV4', 'XA40', 2013, 2018, null, null, 'LOW'],
  // Toyota Corolla (E170)
  ['DEMO-TYT-E170-FBP-01', 'Front Brake Pad', 'Toyota', 'Corolla', 'E170', 2014, 2019, '1.8L Petrol', null, 'HIGH'],
  ['DEMO-TYT-E170-OF-01', 'Oil Filter', 'Toyota', 'Corolla', 'E170', 2014, 2019, '1.8L Petrol', null, 'HIGH'],
  ['DEMO-TYT-E170-AF-01', 'Air Filter', 'Toyota', 'Corolla', 'E170', 2014, 2019, '1.8L Petrol', null, 'MEDIUM'],
  // Hyundai Tucson (TL)
  ['DEMO-HYN-TL-FBP-01', 'Front Brake Pad', 'Hyundai', 'Tucson', 'TL', 2015, 2020, null, null, 'HIGH'],
  ['DEMO-HYN-TL-OF-01', 'Oil Filter', 'Hyundai', 'Tucson', 'TL', 2015, 2020, null, null, 'MEDIUM'],
  ['DEMO-HYN-TL-FB-01', 'Front Bumper', 'Hyundai', 'Tucson', 'TL', 2015, 2020, null, null, 'LOW'],
  // Kia Sportage (QL): the bumper differs by where the car was built
  ['DEMO-KIA-QL-FBP-01', 'Front Brake Pad', 'Kia', 'Sportage', 'QL', 2016, 2021, null, null, 'HIGH'],
  ['DEMO-KIA-QL-OF-D', 'Oil Filter', 'Kia', 'Sportage', 'QL', 2016, 2021, '2.0L Diesel', null, 'MEDIUM'],
  ['DEMO-KIA-QL-OF-P', 'Oil Filter', 'Kia', 'Sportage', 'QL', 2016, 2021, '2.0L Petrol', null, 'MEDIUM'],
  ['DEMO-KIA-QL-FB-KR', 'Front Bumper', 'Kia', 'Sportage', 'QL', 2016, 2021, null, 'Korea', 'HIGH'],
  ['DEMO-KIA-QL-FB-US', 'Front Bumper', 'Kia', 'Sportage', 'QL', 2016, 2021, null, 'USA', 'HIGH'],
];

// [name, phone, whatsapp, lat, lon, address, vetted, accessCode]
const SHOPS = [
  ['Demo Shop Nyabugogo', '+250700000001', '+250700000001', -1.9390, 30.0450, 'Nyabugogo (demo)', 1, '111111'],
  ['Demo Shop Kimironko', '+250700000002', '+250700000002', -1.9490, 30.1265, 'Kimironko (demo)', 1, '222222'],
  ['Demo Shop Remera', '+250700000003', '+250700000003', -1.9560, 30.1090, 'Remera (demo)', 0, '333333'],
  ['Demo Shop Kicukiro', '+250700000004', '+250700000004', -1.9750, 30.1030, 'Kicukiro (demo)', 0, '444444'],
  ['Demo Shop Nyamirambo', '+250700000005', '+250700000005', -1.9750, 30.0420, 'Nyamirambo (demo)', 1, '555555'],
];

// [name, phone, whatsapp, lat, lon, address, specialties]
const GARAGES = [
  ['Demo Garage Gikondo', '+250700000011', '+250700000011', -1.9760, 30.0790, 'Gikondo (demo)', 'Brakes, servicing, Korean and Japanese cars'],
  ['Demo Garage Kacyiru', '+250700000012', '+250700000012', -1.9420, 30.0900, 'Kacyiru (demo)', 'Body work, electrical'],
  ['Demo Garage Kanombe', '+250700000013', '+250700000013', -1.9740, 30.1370, 'Kanombe (demo)', 'General repairs, suspension'],
];

// Plates use the "RXA" series, which Rwanda has not issued, so they cannot match a real car.
// [plate, make, model, generation, year, engine, transmission, wmi, origin, importSource]
const VEHICLES = [
  ['RXA001A', 'Toyota', 'RAV4', 'XA40', 2016, '2.0L Petrol', 'Automatic', 'JTM', 'Japan', 'UAE / Dubai'],
  ['RXA002B', 'Kia', 'Sportage', 'QL', 2018, '2.0L Diesel', 'Automatic', 'KND', 'Korea', 'Korea'],
  ['RXA003C', 'Kia', 'Sportage', 'QL', 2018, '2.0L Diesel', 'Automatic', '5XY', 'USA', 'USA'],
  ['RXA004D', 'Hyundai', 'Tucson', 'TL', 2017, '1.7L Diesel', 'Automatic', 'KMH', 'Korea', 'Korea'],
];

const BASE_PRICE = {
  'Front Brake Pad': 38000, 'Rear Brake Pad': 34000, 'Oil Filter': 7500, 'Air Filter': 11000,
  'Front Bumper': 120000, 'Headlight Assembly': 95000,
};
const UNIVERSAL_LISTINGS = [
  ['Battery', '12V 60Ah (NS60)', 85000], ['Battery', '12V 45Ah (NS40)', 68000],
  ['Wiper Blade', '24 inch', 7000], ['Wiper Blade', '20 inch', 6000],
  ['Engine Oil', '5W-30, 4 litres', 32000], ['Engine Oil', '10W-40, 4 litres', 26000],
];

/** Tiny deterministic hash so the demo data is the same every time. */
function hash(str) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

function placeholderPhoto(text) {
  return `/img/placeholder.svg?text=${encodeURIComponent(text)}`;
}

function seedDemo(db) {
  const already = db.prepare('SELECT COUNT(*) AS n FROM fitment_reference').get().n;
  if (already > 0) return false;

  tx(db, () => {
    const insFit = db.prepare(`INSERT INTO fitment_reference
      (oe_number, part_category, make, model, generation, year_start, year_end, engine, origin_market,
       confidence_level, source, verified_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const f of FITMENT) insFit.run(...f, DEMO_SOURCE, null);

    const insShop = db.prepare(`INSERT INTO shops
      (name, phone, whatsapp_number, latitude, longitude, address_text, vetted, access_code, onboarded_by)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const s of SHOPS) insShop.run(...s, 'demo seed');

    const insGarage = db.prepare(`INSERT INTO garages
      (name, phone, whatsapp_number, latitude, longitude, address_text, specialties) VALUES (?,?,?,?,?,?,?)`);
    for (const g of GARAGES) insGarage.run(...g);

    const insVeh = db.prepare(`INSERT INTO vehicles
      (plate_number, wmi_code, make, model, generation, year, engine, transmission, origin_market,
       drive_side, import_source, registered_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const v of VEHICLES) {
      insVeh.run(v[0], v[7], v[1], v[2], v[3], v[4], v[5], v[6], v[8], 'LHD', v[9], 'demo seed');
    }

    // Listings: each OE number is stocked by 3 of the 5 demo shops, with prices that differ.
    const insListing = db.prepare(`INSERT INTO shop_listings
      (shop_id, oe_number, part_category, universal_spec, price_rwf, stock_quantity, condition, photo_url)
      VALUES (?,?,?,?,?,?,?,?)`);
    const shopIds = db.prepare('SELECT id FROM shops ORDER BY id').all().map((r) => r.id);
    for (const f of FITMENT) {
      const [oe, category] = f;
      const h = hash(oe);
      for (let k = 0; k < 3; k++) {
        const shopId = shopIds[(h + k * 2) % shopIds.length];
        const factor = 0.8 + ((hash(oe + shopId) % 60) / 100); // 0.80 .. 1.39
        const price = Math.round((BASE_PRICE[category] * factor) / 500) * 500;
        const stock = hash(oe + 's' + shopId) % 7 === 0 ? 0 : 1 + (hash(oe + shopId) % 6);
        const condition = hash(oe + 'c' + shopId) % 2 === 0 ? 'genuine' : 'aftermarket';
        insListing.run(shopId, oe, category, null, price, stock, condition, placeholderPhoto(category));
      }
    }
    UNIVERSAL_LISTINGS.forEach(([category, spec, base], i) => {
      for (let k = 0; k < 2; k++) {
        const shopId = shopIds[(i + k * 2) % shopIds.length];
        const factor = 0.9 + ((hash(spec + shopId) % 40) / 100);
        insListing.run(shopId, null, category, spec, Math.round((base * factor) / 500) * 500,
          2 + (i % 4), 'aftermarket', placeholderPhoto(category));
      }
    });

    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('demo', '1')").run();
  });
  return true;
}

function isDemo(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'demo'").get();
  return !!row && row.value === '1';
}

module.exports = { openDb, tx, seedDemo, isDemo, DEFAULT_DB_PATH };
