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
  phone TEXT,
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

-- Photos of each model and generation found on Wikipedia/Commons (lib/carphotos.js). data is
-- JSON: the photo's URL and credit, or null when the article has no free photo.
CREATE TABLE IF NOT EXISTS car_photos (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Answers from the online VIN decoder (lib/vindecode.js), kept so each VIN is looked up once.
CREATE TABLE IF NOT EXISTS vin_lookups (
  vin TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  data TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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

-- A shop asking the vinzuu team to put a part on sale. Only an admin posts parts (so no shop
-- can post a fake one): approving a request creates the shop_listings row it describes.
CREATE TABLE IF NOT EXISTS listing_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  oe_number TEXT,
  part_category TEXT NOT NULL,
  universal_spec TEXT,
  price_rwf INTEGER NOT NULL CHECK (price_rwf > 0),
  stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  condition TEXT NOT NULL CHECK (condition IN ('genuine','aftermarket')),
  photo_url TEXT NOT NULL,
  brand TEXT,
  description TEXT,
  warranty_months INTEGER,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  admin_note TEXT,
  listing_id INTEGER REFERENCES shop_listings(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);

-- A business applying on /sell.html to join Vinzuu Sellers & Garages. Nothing it sends is
-- shown to customers: an admin checks the documents, then approving it creates the shop
-- and/or garage and the owner's account (with the password chosen here).
CREATE TABLE IF NOT EXISTS business_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('shop','garage','both')),
  business_name TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  phone TEXT NOT NULL,
  whatsapp_number TEXT,
  address_text TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  tin TEXT NOT NULL,
  certificate_photo TEXT NOT NULL,
  front_photo TEXT NOT NULL,
  specialties TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  admin_note TEXT,
  shop_id INTEGER REFERENCES shops(id) ON DELETE SET NULL,
  garage_id INTEGER REFERENCES garages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_applications_email ON business_applications (email);

-- A garage's fixed labour prices, shown to customers before they book. part_category links a
-- service to the part it fits ("Fit front brake pads" -> Front Brake Pad) so the booking
-- dialog can show the right price; it is NULL for general work such as a diagnosis.
CREATE TABLE IF NOT EXISTS garage_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  garage_id INTEGER NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  part_category TEXT,
  price_rwf INTEGER NOT NULL CHECK (price_rwf > 0),
  duration_minutes INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A customer's stars and comment on a shop or a garage. Only the customer who made the booking
-- can review, and only once that side of it is finished (part collected / job done), so every
-- review comes from a real customer. One review per booking per side; the business can reply.
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  target TEXT NOT NULL CHECK (target IN ('shop','garage')),
  shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
  garage_id INTEGER REFERENCES garages(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  reply TEXT,
  replied_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_once ON reviews (booking_id, target) WHERE booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reviews_shop ON reviews (shop_id);
CREATE INDEX IF NOT EXISTS idx_reviews_garage ON reviews (garage_id);

-- A customer's complaint about a shop, a garage or one part (a fake part, the wrong part, a
-- price the shop did not honour...). The admin looks into it and closes it with a note.
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  target TEXT NOT NULL CHECK (target IN ('shop','garage','listing')),
  shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
  garage_id INTEGER REFERENCES garages(id) ON DELETE CASCADE,
  listing_id INTEGER REFERENCES shop_listings(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  admin_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status);

-- What each admin changed and when: approvals, rejections, hiding, suspending, deleting.
CREATE TABLE IF NOT EXISTS admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
  ensureColumn(db, 'users', 'phone', 'TEXT');
  // The odometer reading the owner last gave, for the "My garage" inspection reminders.
  ensureColumn(db, 'vehicles', 'mileage_km', 'INTEGER');
  ensureColumn(db, 'vehicles', 'mileage_at', 'TEXT');
  // Who an account belongs to: a customer, a business (it runs the shop in shop_id and/or the
  // garage in garage_id) or an admin. Signing in sends each one to its own dashboard.
  ensureColumn(db, 'users', 'role', "TEXT NOT NULL DEFAULT 'customer'");
  ensureColumn(db, 'users', 'shop_id', 'INTEGER REFERENCES shops(id)');
  ensureColumn(db, 'users', 'garage_id', 'INTEGER REFERENCES garages(id)');
  // What the admin checked about a part: its brand, a description customers read, and the
  // warranty. hidden = 1 takes it off sale without deleting it.
  ensureColumn(db, 'shop_listings', 'brand', 'TEXT');
  ensureColumn(db, 'shop_listings', 'description', 'TEXT');
  ensureColumn(db, 'shop_listings', 'warranty_months', 'INTEGER');
  ensureColumn(db, 'shop_listings', 'hidden', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'shops', 'opening_hours', 'TEXT');
  ensureColumn(db, 'garages', 'opening_hours', 'TEXT');
  // A booking is one request seen from two sides: the shop reserves the part, the garage
  // schedules the fitting. Each side keeps its own progress.
  ensureColumn(db, 'bookings', 'shop_status', "TEXT NOT NULL DEFAULT 'requested'");
  ensureColumn(db, 'bookings', 'garage_status', "TEXT NOT NULL DEFAULT 'requested'");
  ensureColumn(db, 'bookings', 'garage_time', 'TEXT');
  ensureColumn(db, 'bookings', 'garage_note', 'TEXT');
  // The signed-in customer who made the booking: they see it under "My bookings" and review it.
  ensureColumn(db, 'bookings', 'user_id', 'INTEGER REFERENCES users(id)');
  // The admin can suspend a shop or garage (it disappears from search until reactivated), block
  // an account (it can no longer sign in), and cancel a booking. Each keeps the reason.
  ensureColumn(db, 'shops', 'suspended', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'shops', 'suspended_reason', 'TEXT');
  ensureColumn(db, 'garages', 'suspended', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'garages', 'suspended_reason', 'TEXT');
  ensureColumn(db, 'users', 'blocked', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'blocked_reason', 'TEXT');
  ensureColumn(db, 'users', 'last_login_at', 'TEXT');
  ensureColumn(db, 'bookings', 'admin_note', 'TEXT');
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
// Each demo car also has an invented VIN, because the customer page finds cars by VIN only.
// The first one is the "e.g." VIN shown in every VIN box, so typing the example just works.
// [plate, make, model, generation, year, engine, transmission, wmi, origin, importSource, vin]
const VEHICLES = [
  ['RXA001A', 'Toyota', 'RAV4', 'XA40', 2016, '2.0L Petrol', 'Automatic', 'JTM', 'Japan', 'UAE / Dubai', 'JTMBK31V996054321'],
  ['RXA002B', 'Kia', 'Sportage', 'QL', 2018, '2.0L Diesel', 'Automatic', 'KND', 'Korea', 'Korea', 'KNDPM3AC8J7100002'],
  ['RXA003C', 'Kia', 'Sportage', 'QL', 2018, '2.0L Diesel', 'Automatic', '5XY', 'USA', 'USA', '5XYPG4A38JG100003'],
  ['RXA004D', 'Hyundai', 'Tucson', 'TL', 2017, '1.7L Diesel', 'Automatic', 'KMH', 'Korea', 'Korea', 'KMHJ3813DHU100004'],
];
const DEMO_VIN = VEHICLES[0][10];

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
  if (already > 0) { backfillDemoVins(db); ensureDemoAccounts(db); return false; }

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
      (plate_number, vin, wmi_code, make, model, generation, year, engine, transmission, origin_market,
       drive_side, import_source, registered_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const v of VEHICLES) {
      insVeh.run(v[0], v[10], v[7], v[1], v[2], v[3], v[4], v[5], v[6], v[8], 'LHD', v[9], 'demo seed');
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
  ensureDemoAccounts(db);
  return true;
}

// Demo sign-ins, so the admin console and Vinzuu Sellers & Garages can be tried. Invented,
// like the rest of the demo data.
const DEMO_ADMIN = { email: 'admin@vinzuu.rw', password: 'Admin-vinzuu1' };
const DEMO_BUSINESS_PASSWORD = 'Vinzuu-demo1';
const DEMO_CUSTOMER_EMAIL = 'customer@vinzuu.rw';

// [name, part_category or null, price, minutes]: labour prices for each demo garage.
const DEMO_SERVICES = [
  ['Fit front brake pads', 'Front Brake Pad', 15000, 60],
  ['Fit rear brake pads', 'Rear Brake Pad', 15000, 60],
  ['Oil and filter change', 'Oil Filter', 10000, 45],
  ['Replace air filter', 'Air Filter', 5000, 20],
  ['Fit and test a battery', 'Battery', 5000, 20],
  ['Fit wiper blades', 'Wiper Blade', 2000, 10],
  ['Fit a headlight', 'Headlight Assembly', 20000, 90],
  ['Fit a front bumper', 'Front Bumper', 35000, 180],
  ['Engine diagnosis', null, 15000, 60],
];

/** Adds the demo admin, one business account per demo shop and garage, plus one account that
 *  runs both a shop and a garage (it lands on the "shop or garage?" choice). Also labour prices
 *  and a few bookings, so the dashboards are not empty. Runs on older demo databases too, and
 *  never touches an account or row that already exists. */
function ensureDemoAccounts(db) {
  if (!isDemo(db)) return;
  const { hashPassword } = require('./lib/auth');
  const exists = (email) => db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
  const ins = db.prepare(`INSERT INTO users (name, email, password_hash, auth_provider, role, shop_id, garage_id)
    VALUES (?,?,?,'local',?,?,?)`);
  const bizHash = hashPassword(DEMO_BUSINESS_PASSWORD);
  tx(db, () => {
    if (!exists(DEMO_ADMIN.email)) ins.run('Vinzuu Admin', DEMO_ADMIN.email, hashPassword(DEMO_ADMIN.password), 'admin', null, null);
    const shops = db.prepare("SELECT id, name FROM shops WHERE onboarded_by = 'demo seed' ORDER BY id").all();
    shops.forEach((shop, i) => {
      const email = `shop${i + 1}@vinzuu.rw`;
      if (!exists(email)) ins.run(shop.name, email, bizHash, 'business', shop.id, null);
    });
    const garages = db.prepare(`SELECT id, name FROM garages WHERE name LIKE 'Demo Garage %' ORDER BY id`).all();
    garages.forEach((garage, i) => {
      const email = `garage${i + 1}@vinzuu.rw`;
      if (!exists(email)) ins.run(garage.name, email, bizHash, 'business', null, garage.id);
    });
    if (shops.length && garages.length && !exists('both@vinzuu.rw')) {
      ins.run('Demo Shop and Garage', 'both@vinzuu.rw', bizHash, 'business', shops[0].id, garages[0].id);
    }

    if (db.prepare("SELECT 1 FROM meta WHERE key = 'demo_business'").get()) return;
    const insSvc = db.prepare('INSERT INTO garage_services (garage_id, name, part_category, price_rwf, duration_minutes) VALUES (?,?,?,?,?)');
    garages.forEach((garage, gi) => {
      for (const [name, cat, price, mins] of DEMO_SERVICES) insSvc.run(garage.id, name, cat, price + gi * 1000, mins);
    });
    // Three bookings on the first demo shop's parts, fitted at the first demo garage.
    const car = db.prepare("SELECT id FROM vehicles WHERE registered_by = 'demo seed' ORDER BY id LIMIT 1").get();
    const listings = shops.length ? db.prepare('SELECT id FROM shop_listings WHERE shop_id = ? AND stock_quantity > 0 ORDER BY id LIMIT 3').all(shops[0].id) : [];
    const insBk = db.prepare(`INSERT INTO bookings (customer_phone, vehicle_id, shop_listing_id, garage_id, note, shop_status, garage_status, garage_time, created_at)
      VALUES (?,?,?,?,?,?,?,?, datetime('now', ?))`);
    const plan = [
      ['+250788000101', 'Please keep it for me until Saturday.', 'requested', 'requested', null, '-2 hours'],
      ['+250788000102', null, 'confirmed', 'accepted', "date('now', '+1 day') || ' 10:00'", '-1 day'],
      ['+250788000103', 'Car makes a noise when braking.', 'collected', 'done', "date('now', '-2 day') || ' 14:00'", '-3 day'],
    ];
    if (car && garages.length) {
      listings.forEach((l, i) => {
        const [ph, note, ss, gs, timeSql, ago] = plan[i];
        const time = timeSql ? db.prepare(`SELECT ${timeSql} AS t`).get().t : null;
        insBk.run(ph, car.id, l.id, garages[0].id, note, ss, gs, time, ago);
      });
    }
    // A few invented reviews, so the stars and comments can be seen.
    const insRv = db.prepare(`INSERT INTO reviews (target, shop_id, garage_id, author_name, rating, comment, reply, created_at)
      VALUES (?,?,?,?,?,?,?, datetime('now', ?))`);
    const DEMO_REVIEWS = [
      [5, 'Genuine part, exactly what the site said. They kept it for me until I came.', 'Thank you, welcome back!'],
      [4, 'Good price. I waited a little at the counter.', null],
      [3, 'The part was fine but the shop was hard to find.', 'Sorry about that, we are next to the bus park.'],
    ];
    shops.forEach((shop, si) => DEMO_REVIEWS.slice(si % 2).forEach(([r, c, rep], i) =>
      insRv.run('shop', shop.id, null, ['Eric M.', 'Aline U.', 'Jean B.'][i], r, c, rep, `-${si + i + 1} day`)));
    const GARAGE_REVIEWS = [
      [5, 'Fitted my brake pads in under an hour, fair price.', 'Thanks for choosing us.'],
      [4, 'Good work, they explained what they changed.', null],
    ];
    garages.forEach((garage, gi) => GARAGE_REVIEWS.forEach(([r, c, rep], i) =>
      insRv.run('garage', null, garage.id, ['Diane K.', 'Patrick N.'][i], r, c, rep, `-${gi + i + 1} day`)));
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('demo_business', '1')").run();
  });
  ensureDemoAdminData(db, bizHash);
}

/** A demo customer account, a few weeks of past bookings (so the admin's charts have something
 *  to draw) and one open customer report. Runs once per demo database. */
function ensureDemoAdminData(db, bizHash) {
  if (db.prepare("SELECT 1 FROM meta WHERE key = 'demo_admin'").get()) return;
  tx(db, () => {
    let customer = db.prepare('SELECT id FROM users WHERE email = ?').get(DEMO_CUSTOMER_EMAIL);
    if (!customer) {
      customer = { id: Number(db.prepare(`INSERT INTO users (name, email, phone, password_hash, auth_provider, role, created_at)
        VALUES ('Demo Customer', ?, '+250788000100', ?, 'local', 'customer', datetime('now', '-40 day'))`).run(DEMO_CUSTOMER_EMAIL, bizHash).lastInsertRowid) };
    }
    db.prepare('UPDATE bookings SET user_id = ? WHERE user_id IS NULL').run(customer.id);
    const car = db.prepare("SELECT id FROM vehicles WHERE registered_by = 'demo seed' ORDER BY id LIMIT 1").get();
    const listings = db.prepare(`SELECT l.id FROM shop_listings l JOIN shops s ON s.id = l.shop_id
      WHERE s.onboarded_by = 'demo seed' ORDER BY l.id LIMIT 12`).all();
    const garages = db.prepare("SELECT id FROM garages WHERE name LIKE 'Demo Garage %' ORDER BY id").all();
    if (car && listings.length && garages.length) {
      const ins = db.prepare(`INSERT INTO bookings (customer_phone, vehicle_id, shop_listing_id, garage_id, shop_status, garage_status, garage_time, created_at)
        VALUES (?,?,?,?,?,?,?, datetime('now', ?))`);
      // Past weeks: mostly finished, a few cancelled, so the charts and scorecards show something.
      const ago = [5, 9, 12, 16, 19, 23, 26, 33, 37, 41, 48, 52];
      ago.forEach((days, i) => {
        const cancelled = i % 5 === 3;
        ins.run(`+25078800${String(200 + i)}`, car.id, listings[i % listings.length].id, garages[i % garages.length].id,
          cancelled ? 'cancelled' : 'collected', cancelled ? 'declined' : 'done',
          cancelled ? null : db.prepare(`SELECT date('now', ?) || ' 10:00' AS t`).get(`-${days - 1} day`).t, `-${days} day`);
      });
    }
    const shop = db.prepare("SELECT id FROM shops WHERE onboarded_by = 'demo seed' ORDER BY id LIMIT 1 OFFSET 1").get();
    if (shop) {
      db.prepare(`INSERT INTO reports (user_id, target, shop_id, reason, details, created_at)
        VALUES (?, 'shop', ?, 'price', 'The site said 45,000 RWF but at the counter they asked for 60,000.', datetime('now', '-1 day'))`).run(customer.id, shop.id);
    }
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('demo_admin', '1')").run();
  });
}

/** Demo databases created before the demo cars had VINs: give each seeded car its VIN, so the
 *  VIN-only customer page can reach them. Skips a car that already has a VIN, and a VIN that some
 *  other car has since claimed, so it never overwrites anything a person entered. */
function backfillDemoVins(db) {
  if (!isDemo(db)) return;
  const setVin = db.prepare(`UPDATE vehicles SET vin = ? WHERE id = (
      SELECT id FROM vehicles WHERE plate_number = ? AND registered_by = 'demo seed' AND vin IS NULL
      ORDER BY id LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM vehicles WHERE vin = ?)`);
  for (const v of VEHICLES) setVin.run(v[10], v[0], v[10]);
}

function isDemo(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'demo'").get();
  return !!row && row.value === '1';
}

module.exports = { openDb, tx, seedDemo, isDemo, DEMO_VIN, DEFAULT_DB_PATH, DEMO_ADMIN, DEMO_BUSINESS_PASSWORD, DEMO_CUSTOMER_EMAIL };
