'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb, seedDemo } = require('../db');
const { createApp } = require('../server');
const alg = require('../lib/algorithms');

let server;
let base;
const ADMIN = { 'x-admin-token': 'test-admin' };

before(async () => {
  const db = openDb(':memory:');
  seedDemo(db);
  const app = createApp(db, { adminToken: 'test-admin', writeLimit: { windowMs: 60_000, max: 10_000 } });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
const get = (p, h) => call('GET', p, null, h);

/** A client with its own cookie jar, for tests that need a signed-in session. */
function makeClient() {
  let cookie = '';
  async function request(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of setCookies) cookie = c.split(';')[0];
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }
  return { get: (p) => request('GET', p), post: (p, b) => request('POST', p, b) };
}
const post = (p, b, h) => call('POST', p, b, h);

// ---------- pure functions ----------

test('plates are normalised and VINs are checked', () => {
  assert.equal(alg.normalizePlate('rae 123-a'), 'RAE123A');
  assert.ok(alg.isValidPlate('RAE123A'));
  assert.ok(!alg.isValidPlate('ABC'));
  assert.ok(alg.isValidVin('KMHB3516BRW102898'), 'the real Casper VIN is 17 characters');
  assert.ok(!alg.isValidVin('KMHB3516BRW10289'), '16 characters');
  assert.ok(!alg.isValidVin('KMHB3516BRW10289O'), 'the letter O is never used in a VIN');
});

test('WMI decodes where a car was built', () => {
  assert.equal(alg.decodeWmi('KMHB3516BRW102898').origin, 'Korea');
  assert.equal(alg.decodeWmi('KMHB3516BRW102898').maker, 'Hyundai');
  assert.equal(alg.decodeWmi('5XYPH4A50GG000001').origin, 'USA');
  assert.equal(alg.decodeWmi('JTMBFREV5GD000001').origin, 'Japan');
  assert.equal(alg.decodeWmi('LZWBAAAA1J0000001').source, 'region');
  assert.equal(alg.decodeWmi('XXXBAAAA1J0000001').origin, null);
});

test('haversine gives a sensible Kigali distance', () => {
  const d = alg.haversineKm({ lat: -1.9441, lon: 30.0619 }, { lat: -1.9490, lon: 30.1265 });
  assert.ok(d > 6 && d < 8, `expected about 7 km, got ${d}`);
});

test('Verified Genuine needs HIGH confidence, genuine condition AND a vetted shop', () => {
  const b = (o) => alg.badgeFor({ universal: false, ...o }).key;
  assert.equal(b({ confidence: 'HIGH', condition: 'genuine', vetted: true }), 'verified_genuine');
  assert.equal(b({ confidence: 'HIGH', condition: 'genuine', vetted: false }), 'verified_compatible');
  assert.equal(b({ confidence: 'HIGH', condition: 'aftermarket', vetted: true }), 'verified_compatible');
  assert.equal(b({ confidence: 'MEDIUM', condition: 'genuine', vetted: true }), 'verified_compatible');
  assert.equal(b({ confidence: 'LOW', condition: 'genuine', vetted: true }), 'unverified');
});

// ---------- registration (Algorithm A) ----------

test('meta and catalog load, and the demo banner flag is on', async () => {
  const meta = await get('/api/meta');
  assert.equal(meta.json.demo, true);
  const cat = await get('/api/catalog');
  assert.ok(cat.json.categories.length >= 9);
  const kia = cat.json.makes.find((m) => m.make === 'Kia');
  assert.ok(kia.models.find((m) => m.model === 'Sportage').generations.length > 0);
});

test('registering with a VIN derives the origin market from the WMI', async () => {
  const r = await post('/api/vehicles/register', {
    plate_number: 'rxb 001 a', vin: 'KNDPMCAC5J7000001', make: 'Kia', model: 'Sportage',
    generation: 'QL', year: 2018, engine: '2.0L Diesel', import_source: 'Korea',
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.vehicle.plate_number, 'RXB001A');
  assert.equal(r.json.vehicle.origin_market, 'Korea');
  assert.equal(r.json.origin_source, 'vin');
});

test('a public vehicle response never contains the full VIN or the owner phone', async () => {
  await post('/api/vehicles/register', {
    plate_number: 'RXB002B', vin: 'KNDPMCAC5J7000002', make: 'Kia', model: 'Sportage', year: 2018,
    owner_phone: '+250700000099',
  });
  const r = await get('/api/vehicles/RXB002B');
  const body = JSON.stringify(r.json);
  assert.ok(!body.includes('KNDPMCAC5J7000002'));
  assert.ok(!body.includes('250700000099'));
  assert.ok(r.json.vehicle.vin_masked.includes('•'));
});

test('registering an existing plate returns the stored car and ignores new details', async () => {
  // A plate-only car (no VIN on file). The demo cars all have VINs now, so they can't stand in here.
  await post('/api/vehicles/register', { plate_number: 'RXB000K', make: 'Kia', model: 'Sportage', year: 2018 });
  const r = await post('/api/vehicles/register', { plate_number: 'RXB000K', make: 'Toyota', model: 'Corolla', year: 2010 });
  assert.equal(r.status, 200);
  assert.equal(r.json.existing, true);
  assert.equal(r.json.vehicle.make, 'Kia');
});

// ---------- VIN is the identity key, plate is a non-trusted convenience label ----------

test('re-registering a known VIN under a new plate is recognized as the same car, and the plate label updates', async () => {
  const first = await post('/api/vehicles/register', {
    plate_number: 'RXC001A', vin: '1HGCM82633A004352', make: 'Hyundai', model: 'Santa Fe', year: 2013,
  });
  assert.equal(first.status, 201);

  // The owner sold the car and bought another, which the authorities reissued this same plate
  // string for -- but Vinzuu's own customer later re-enters the OLD car's VIN under its NEW plate.
  const again = await post('/api/vehicles/register', {
    plate_number: 'RXC009Z', vin: '1HGCM82633A004352', make: 'Hyundai', model: 'Santa Fe', year: 2013,
  });
  assert.equal(again.status, 200);
  assert.equal(again.json.existing, true);
  assert.equal(again.json.vehicle.plate_number, 'RXC009Z');

  // The car is now found under its new plate, and the old plate string no longer resolves to it.
  const byNewPlate = await get('/api/vehicles/RXC009Z');
  assert.equal(byNewPlate.json.vehicle.vin_masked, again.json.vehicle.vin_masked);
  const byOldPlate = await get('/api/vehicles/RXC001A');
  assert.equal(byOldPlate.status, 404);
});

test('a plate reassigned to a genuinely different car (different VIN) is not merged with the old record', async () => {
  await post('/api/vehicles/register', {
    plate_number: 'RXC010A', vin: 'KNDPMCAC5J7000099', make: 'Kia', model: 'Sportage', year: 2018,
  });
  // Same plate string, a different car's VIN: this must become its own record, not overwrite
  // the Kia that currently holds that plate label.
  const reassigned = await post('/api/vehicles/register', {
    plate_number: 'RXC010A', vin: 'KMHB3516BRW102899', make: 'Hyundai', model: 'Tucson', year: 2019,
  });
  assert.equal(reassigned.status, 201);
  assert.equal(reassigned.json.vehicle.make, 'Hyundai');
  // The plate now resolves to the newer (Hyundai) car, since it most recently claimed it.
  const byPlate = await get('/api/vehicles/RXC010A');
  assert.equal(byPlate.json.vehicle.make, 'Hyundai');
});

test('adding a VIN to a car that was only ever registered by plate enriches that same record', async () => {
  await post('/api/vehicles/register', { plate_number: 'RXC011B', make: 'Toyota', model: 'RAV4', year: 2016 });
  const enriched = await post('/api/vehicles/register', {
    plate_number: 'RXC011B', vin: 'JTMBK31V996054399', make: 'Toyota', model: 'RAV4', year: 2016,
  });
  assert.equal(enriched.status, 200);
  assert.equal(enriched.json.existing, true);
  assert.ok(enriched.json.vehicle.has_vin);
  // That VIN now also resolves this same car directly, under a different plate.
  const viaVin = await post('/api/vehicles/register', {
    plate_number: 'RXC099Z', vin: 'JTMBK31V996054399', make: 'Toyota', model: 'RAV4', year: 2016,
  });
  assert.equal(viaVin.json.vehicle.plate_number, 'RXC099Z');
});

test('bad input gets a clear message', async () => {
  const badVin = await post('/api/vehicles/register', { plate_number: 'RXB003C', vin: 'TOOSHORT', make: 'Kia', model: 'Rio', year: 2015 });
  assert.equal(badVin.status, 400);
  assert.match(badVin.json.error, /17/);
  const badPlate = await post('/api/vehicles/register', { plate_number: '??', make: 'Kia', model: 'Rio', year: 2015 });
  assert.equal(badPlate.status, 400);
  const unknown = await get('/api/vehicles/RZZ999Z');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.code, 'not_registered');
});

test('a VIN that contradicts the chosen make produces a warning, not an error', async () => {
  const r = await post('/api/vehicles/register', {
    plate_number: 'RXB004D', vin: 'KMHB3516BRW102898', make: 'Toyota', model: 'RAV4', year: 2023,
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.warnings.length, 1);
});

test('GET /api/vehicles/by-vin finds a car the trusted way, for the garage-facing lookup', async () => {
  await post('/api/vehicles/register', {
    plate_number: 'RXC020A', vin: 'JTMBK31V996099001', make: 'Toyota', model: 'RAV4', year: 2017,
  });
  const found = await get('/api/vehicles/by-vin/JTMBK31V996099001');
  assert.equal(found.status, 200);
  assert.equal(found.json.vehicle.plate_number, 'RXC020A');

  const missing = await get('/api/vehicles/by-vin/JTMBK31V996099999');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, 'not_registered');

  const badVin = await get('/api/vehicles/by-vin/TOOSHORT');
  assert.equal(badVin.status, 400);
});

test('publicVehicle exposes a numeric id, and /api/vehicles/id/:id, parts search/listings, PATCH and bookings all accept vehicle_id instead of plate_number', async () => {
  const reg = await post('/api/vehicles/register', {
    plate_number: 'RXC021B', vin: 'JTMBK31V996099021', make: 'Toyota', model: 'RAV4', generation: 'XA40', year: 2017,
  });
  const id = reg.json.vehicle.id;
  assert.ok(Number.isInteger(id));

  const byId = await get(`/api/vehicles/id/${id}`);
  assert.equal(byId.status, 200);
  assert.equal(byId.json.vehicle.plate_number, 'RXC021B');

  const missing = await get('/api/vehicles/id/999999');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, 'not_registered');

  const search = await get(`/api/parts/search?vehicle_id=${id}&part_category=Front%20Brake%20Pad`);
  assert.equal(search.status, 200);
  assert.equal(search.json.match_type, 'exact');

  const listings = await get(`/api/parts/listings?oe_numbers=DEMO-TYT-XA40-FBP-01&vehicle_id=${id}&radius_km=any`);
  assert.equal(listings.status, 200);

  const patched = await call('PATCH', `/api/vehicles/id/${id}`, { engine: '2.2L Diesel' });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.vehicle.engine, '2.2L Diesel');

  const booking = await post('/api/bookings', { vehicle_id: id, customer_phone: '+250788123456', garage_id: 1 });
  assert.equal(booking.status, 201);
});

// ---------- part lookup (Algorithm B) ----------

test('exact match returns the right OE number with its confidence', async () => {
  const r = await get('/api/parts/search?plate_number=RXA001A&part_category=Front%20Brake%20Pad');
  assert.equal(r.json.match_type, 'exact');
  assert.equal(r.json.oe_numbers[0].oe_number, 'DEMO-TYT-XA40-FBP-01');
  assert.equal(r.json.oe_numbers[0].confidence, 'HIGH');
});

test('same model and year, different origin market: different part numbers', async () => {
  const korea = await get('/api/parts/search?plate_number=RXA002B&part_category=Front%20Bumper');
  const usa = await get('/api/parts/search?plate_number=RXA003C&part_category=Front%20Bumper');
  assert.equal(korea.json.oe_numbers[0].oe_number, 'DEMO-KIA-QL-FB-KR');
  assert.equal(usa.json.oe_numbers[0].oe_number, 'DEMO-KIA-QL-FB-US');
});

test('an unknown engine is relaxed to LOW confidence, never silently trusted', async () => {
  await post('/api/vehicles/register', {
    plate_number: 'RXB005E', make: 'Toyota', model: 'RAV4', generation: 'XA40', year: 2015,
    engine: '2.2L Diesel', origin_market: 'Japan',
  });
  const r = await get('/api/parts/search?plate_number=RXB005E&part_category=Oil%20Filter');
  assert.equal(r.json.match_type, 'relaxed');
  assert.ok(r.json.oe_numbers.every((o) => o.confidence === 'LOW'));
});

test('unknown origin market is never guessed when parts differ by market', async () => {
  await post('/api/vehicles/register', {
    plate_number: 'RXB006F', make: 'Kia', model: 'Sportage', generation: 'QL', year: 2018, engine: '2.0L Diesel',
  });
  const r = await get('/api/parts/search?plate_number=RXB006F&part_category=Front%20Bumper');
  assert.equal(r.json.match_type, 'none');
  assert.equal(r.json.reason, 'origin_unknown');
});

test('a customer can fill in a missing origin, after which the right part appears', async () => {
  const patch = await call('PATCH', '/api/vehicles/RXB006F', { origin_market: 'Korea' });
  assert.deepEqual(patch.json.updated, ['origin_market']);
  const r = await get('/api/parts/search?plate_number=RXB006F&part_category=Front%20Bumper');
  assert.equal(r.json.match_type, 'exact');
  assert.equal(r.json.oe_numbers[0].oe_number, 'DEMO-KIA-QL-FB-KR');
});

test('a customer cannot overwrite a detail that is already set, but an admin can', async () => {
  const attempt = await call('PATCH', '/api/vehicles/RXB006F', { origin_market: 'USA' });
  assert.deepEqual(attempt.json.updated, []);
  assert.deepEqual(attempt.json.ignored, ['origin_market']);
  assert.equal(attempt.json.vehicle.origin_market, 'Korea');
  const admin = await call('PATCH', '/api/vehicles/RXB006F', { origin_market: 'USA' }, ADMIN);
  assert.equal(admin.json.vehicle.origin_market, 'USA');
  const invalid = await call('PATCH', '/api/vehicles/RXB005E', { origin_market: 'Narnia' });
  assert.equal(invalid.status, 400);
});

test('a search we cannot answer is logged for the admin gaps report', async () => {
  await post('/api/vehicles/register', { plate_number: 'RXB007G', make: 'Mazda', model: 'CX-5', year: 2019, origin_market: 'Japan' });
  await get('/api/parts/search?plate_number=RXB007G&part_category=Front%20Brake%20Pad');
  await get('/api/parts/search?plate_number=RXB007G&part_category=Front%20Brake%20Pad');
  const gaps = await get('/api/admin/fitment-reference/gaps', ADMIN);
  const gap = gaps.json.gaps.find((g) => g.make === 'Mazda');
  assert.equal(gap.times_searched, 2);
});

test('universal parts skip part numbers entirely', async () => {
  const r = await get('/api/parts/search?plate_number=RXA001A&part_category=Wiper%20Blade');
  assert.equal(r.json.type, 'universal');
  const l = await get('/api/parts/listings?part_category=Wiper%20Blade');
  assert.ok(l.json.count > 0);
  assert.equal(l.json.listings[0].badge.key, 'universal');
});

// ---------- shop listings (Algorithm C + D) ----------

test('listings are sorted by price by default and by distance on request', async () => {
  const r = await get('/api/parts/listings?oe_numbers=DEMO-TYT-XA40-FBP-01&plate_number=RXA001A&radius_km=any');
  assert.ok(r.json.count >= 1);
  const prices = r.json.listings.map((l) => l.price_rwf);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  const byDist = await get('/api/parts/listings?oe_numbers=DEMO-TYT-XA40-FBP-01&plate_number=RXA001A&radius_km=any&sort=distance');
  const d = byDist.json.listings.map((l) => l.distance_km);
  assert.deepEqual(d, [...d].sort((a, b) => a - b));
});

test('the radius filter removes far shops, and out-of-stock listings never appear', async () => {
  const wide = await get('/api/parts/listings?oe_numbers=DEMO-TYT-XA40-FBP-01&radius_km=any');
  const tight = await get('/api/parts/listings?oe_numbers=DEMO-TYT-XA40-FBP-01&radius_km=1');
  assert.ok(tight.json.count <= wide.json.count);
  assert.ok(wide.json.listings.every((l) => l.in_stock > 0));
});

test('a relaxed match stays LOW on the results screen too', async () => {
  const s = await get('/api/parts/search?plate_number=RXB005E&part_category=Oil%20Filter');
  const oes = s.json.oe_numbers.map((o) => o.oe_number).join(',');
  const l = await get(`/api/parts/listings?oe_numbers=${oes}&plate_number=RXB005E&radius_km=any`);
  assert.ok(l.json.count > 0);
  assert.ok(l.json.listings.every((x) => x.badge.key === 'unverified'));
});

test('bad coordinates are rejected instead of producing nonsense distances', async () => {
  const r = await get('/api/parts/listings?oe_numbers=DEMO-TYT-XA40-FBP-01&lat=abc&lon=30');
  assert.equal(r.status, 400);
});

// ---------- shop console ----------

test('shops need their code, only manage their own listings, and cannot list unknown part numbers', async () => {
  const noCode = await get('/api/shop/me');
  assert.equal(noCode.status, 401);
  const me = await get('/api/shop/me', { 'x-shop-code': '111111' });
  assert.equal(me.json.shop.id, 1);
  assert.ok(!JSON.stringify(me.json).includes('111111'), 'the access code is never echoed back');

  const other = await get('/api/shops/2/listings', { 'x-shop-code': '111111' });
  assert.equal(other.status, 403);

  const photo = '/img/placeholder.svg?text=test';
  const good = await post('/api/shops/1/listings', {
    part_category: 'Front Brake Pad', oe_number: 'DEMO-TYT-XA40-FBP-01', price_rwf: 41000,
    stock_quantity: 4, condition: 'genuine', photo_url: photo,
  }, { 'x-shop-code': '111111' });
  assert.equal(good.status, 201);

  const unknown = await post('/api/shops/1/listings', {
    part_category: 'Front Brake Pad', oe_number: 'NOT-A-REAL-NUMBER', price_rwf: 41000,
    stock_quantity: 4, condition: 'genuine', photo_url: photo,
  }, { 'x-shop-code': '111111' });
  assert.equal(unknown.status, 422);
  assert.equal(unknown.json.code, 'unknown_oe');

  const noPhoto = await post('/api/shops/1/listings', {
    part_category: 'Front Brake Pad', oe_number: 'DEMO-TYT-XA40-FBP-01', price_rwf: 41000,
    stock_quantity: 4, condition: 'genuine',
  }, { 'x-shop-code': '111111' });
  assert.equal(noPhoto.status, 400);

  const badPhoto = await post('/api/shops/1/listings', {
    part_category: 'Front Brake Pad', oe_number: 'DEMO-TYT-XA40-FBP-01', price_rwf: 41000,
    stock_quantity: 4, condition: 'genuine', photo_url: 'javascript:alert(1)',
  }, { 'x-shop-code': '111111' });
  assert.equal(badPhoto.status, 400);
});

test('the fitment table is not browsable without signing in', async () => {
  assert.equal((await get('/api/shop/oe-numbers?part_category=Oil%20Filter')).status, 401);
  assert.equal((await get('/api/admin/fitment-reference')).status, 401);
  const ok = await get('/api/shop/oe-numbers?part_category=Oil%20Filter', { 'x-shop-code': '111111' });
  assert.ok(ok.json.rows.length > 0);
});

// ---------- bookings ----------

test('a booking returns WhatsApp links and shares the customer number only with the shop it concerns', async () => {
  const listing = (await get('/api/parts/listings?oe_numbers=DEMO-TYT-XA40-FBP-01&radius_km=any')).json.listings[0];
  const r = await post('/api/bookings', {
    plate_number: 'RXA001A', customer_phone: '0788 123 456'.replace(/^0/, '+250 '),
    shop_listing_id: listing.listing_id, garage_id: 1, note: 'Please call after 5pm',
  });
  assert.equal(r.status, 201);
  assert.match(r.json.whatsapp.shop, /^https:\/\/wa\.me\/250700/);
  assert.ok(r.json.whatsapp.garage.includes('RXA001A'));

  const shopView = await get(`/api/shops/${listing.shop_id}/bookings`, { 'x-shop-code': ['111111', '222222', '333333', '444444', '555555'][listing.shop_id - 1] });
  assert.equal(shopView.json.bookings[0].customer_phone, '+250788123456');

  const nothing = await post('/api/bookings', { plate_number: 'RXA001A', customer_phone: '+250788123456' });
  assert.equal(nothing.status, 400);
  const badPhone = await post('/api/bookings', { plate_number: 'RXA001A', customer_phone: '123', garage_id: 1 });
  assert.equal(badPhone.status, 400);
});

// ---------- admin ----------

test('admin rules: HIGH confidence needs a named verifier, then the new part number works end to end', async () => {
  const row = {
    oe_number: 'DEMO-NEW-1', part_category: 'Front Brake Pad', make: 'Mazda', model: 'CX-5', generation: 'KE',
    year_start: 2012, year_end: 2016, engine: null, origin_market: 'Japan', confidence_level: 'HIGH',
    source: 'Checked against a physical part', verified_by: null,
  };
  assert.equal((await post('/api/admin/fitment-reference', row, ADMIN)).status, 400);
  assert.equal((await post('/api/admin/fitment-reference', { ...row, verified_by: 'Ngoga' }, ADMIN)).status, 201);
  assert.equal((await post('/api/admin/fitment-reference', { ...row, year_end: 2000, verified_by: 'x' }, ADMIN)).status, 400);
  assert.equal((await post('/api/admin/fitment-reference', { ...row, part_category: 'Battery', verified_by: 'x' }, ADMIN)).status, 400);
});

test('admin can onboard a shop, and the stats include import-source data for the thesis', async () => {
  const s = await post('/api/admin/shops', {
    name: 'Test Shop', phone: '+250700000077', latitude: -1.95, longitude: 30.06, vetted: true,
  }, ADMIN);
  assert.equal(s.status, 201);
  assert.match(s.json.shop.access_code, /^\d{6}$/);
  const stats = await get('/api/admin/stats', ADMIN);
  assert.ok(stats.json.vehicles_by_import_source.length > 0);
  assert.equal((await get('/api/admin/stats', { 'x-admin-token': 'wrong' })).status, 401);
});

test('unknown API routes return JSON, not HTML', async () => {
  const r = await get('/api/nope');
  assert.equal(r.status, 404);
  assert.ok(r.json.error);
});

test('the placeholder image endpoint escapes its input', async () => {
  const res = await fetch(`${base}/img/placeholder.svg?text=${encodeURIComponent('<script>alert(1)</script>')}`);
  const svg = await res.text();
  assert.ok(!svg.includes('<script>'));
});

// ---------- accounts ----------

test('sign up rejects a bad email and a short password before creating anything', async () => {
  const badEmail = await post('/api/auth/signup', { name: 'Test', email: 'not-an-email', password: 'longenough1' });
  assert.equal(badEmail.status, 400);
  const shortPw = await post('/api/auth/signup', { name: 'Test', email: 'ok@example.com', password: 'short' });
  assert.equal(shortPw.status, 400);
});

test('sign up, sign in, see the session, and sign out, with no password ever echoed back', async () => {
  const client = makeClient();
  const up = await client.post('/api/auth/signup', { name: 'Alice Uwase', email: 'alice@example.com', password: 'correct horse battery' });
  assert.equal(up.status, 201);
  assert.equal(up.json.user.email, 'alice@example.com');
  assert.ok(!JSON.stringify(up.json).toLowerCase().includes('password'));

  const dup = await client.post('/api/auth/signup', { name: 'Alice again', email: 'alice@example.com', password: 'another password' });
  assert.equal(dup.status, 409);

  const me = await client.get('/api/auth/me');
  assert.equal(me.json.user.email, 'alice@example.com');

  await client.post('/api/auth/logout');
  assert.equal((await client.get('/api/auth/me')).json.user, null);

  const wrongPw = await client.post('/api/auth/login', { email: 'alice@example.com', password: 'nope nope nope' });
  assert.equal(wrongPw.status, 401);
  const right = await client.post('/api/auth/login', { email: 'alice@example.com', password: 'correct horse battery' });
  assert.equal(right.status, 200);
  assert.equal(right.json.user.email, 'alice@example.com');
});

test('signed out, /api/auth/me and /api/me/vehicles both say so instead of erroring or guessing', async () => {
  const anon = await get('/api/auth/me');
  assert.equal(anon.json.user, null);
  const mine = await get('/api/me/vehicles');
  assert.equal(mine.status, 401);
});

test('registering a car while signed in attaches it to the account, and it appears in "my cars"', async () => {
  const client = makeClient();
  await client.post('/api/auth/signup', { name: 'Bosco', email: 'bosco@example.com', password: 'another-strong-pw' });
  const reg = await client.post('/api/vehicles/register', { plate_number: 'RXG001A', make: 'Toyota', model: 'Corolla', year: 2016 });
  assert.equal(reg.status, 201);
  const mine = await client.get('/api/me/vehicles');
  assert.equal(mine.json.vehicles.length, 1);
  assert.equal(mine.json.vehicles[0].plate_number, 'RXG001A');

  // a second account never sees the first account's cars
  const other = makeClient();
  await other.post('/api/auth/signup', { name: 'Claudine', email: 'claudine@example.com', password: 'yet-another-pw' });
  assert.equal((await other.get('/api/me/vehicles')).json.vehicles.length, 0);
});

test('signing in and re-entering a plate that nobody claimed yet adopts it into the account', async () => {
  await post('/api/vehicles/register', { plate_number: 'RXG002B', make: 'Toyota', model: 'Corolla', year: 2017 }); // guest registration
  const client = makeClient();
  await client.post('/api/auth/signup', { name: 'Didier', email: 'didier@example.com', password: 'yet-another-pw-2' });
  const again = await client.post('/api/vehicles/register', { plate_number: 'RXG002B', make: 'Toyota', model: 'Corolla', year: 2017 });
  assert.equal(again.status, 200);
  assert.equal(again.json.existing, true);
  const mine = await client.get('/api/me/vehicles');
  assert.ok(mine.json.vehicles.some((v) => v.plate_number === 'RXG002B'));
});

test('Google and Apple sign-in are refused cleanly when the server has no client id configured', async () => {
  const g = await post('/api/auth/google', { id_token: 'whatever' });
  assert.equal(g.status, 503);
  const a = await post('/api/auth/apple', { id_token: 'whatever' });
  assert.equal(a.status, 503);
});

// ---------- admin: add or remove a car ----------

test('admin can add a car directly, correct it by re-posting the same plate, and delete it', async () => {
  const add = await post('/api/admin/vehicles', { plate_number: 'RXH001A', make: 'Honda', model: 'CR-V', year: 2015 }, ADMIN);
  assert.equal(add.status, 201);
  assert.equal(add.json.updated, false);

  const corrected = await post('/api/admin/vehicles', { plate_number: 'RXH001A', make: 'Honda', model: 'CR-V', year: 2016 }, ADMIN);
  assert.equal(corrected.status, 200);
  assert.equal(corrected.json.updated, true);
  assert.equal(corrected.json.vehicle.year, 2016);
  assert.equal(corrected.json.vehicle.id, add.json.vehicle.id, 're-posting the same plate edits the same row, not a new one');

  const del = await call('DELETE', `/api/admin/vehicles/${corrected.json.vehicle.id}`, null, ADMIN);
  assert.equal(del.status, 200);
  assert.equal((await get('/api/admin/vehicles', ADMIN)).json.vehicles.some((v) => v.id === corrected.json.vehicle.id), false);

  const missing = await call('DELETE', '/api/admin/vehicles/999999', null, ADMIN);
  assert.equal(missing.status, 404);
  assert.equal((await post('/api/admin/vehicles', { plate_number: 'bad', make: 'Honda', model: 'Fit', year: 2015 }, ADMIN)).status, 400);
});

test('admin cannot delete a car that has booking history', async () => {
  const listing = (await get('/api/parts/listings?oe_numbers=DEMO-TYT-XA40-FBP-01&radius_km=any')).json.listings[0];
  await post('/api/bookings', { plate_number: 'RXA001A', customer_phone: '+250788111222', shop_listing_id: listing.listing_id });
  const vehicle = (await get('/api/admin/vehicles', ADMIN)).json.vehicles.find((v) => v.plate_number === 'RXA001A');
  const del = await call('DELETE', `/api/admin/vehicles/${vehicle.id}`, null, ADMIN);
  assert.equal(del.status, 409);
});

// ---------- demo cars are reachable by VIN ----------

test('every demo car has a VIN, and the example VIN shown on the site finds the demo RAV4', async () => {
  const meta = await get('/api/meta');
  assert.equal(meta.json.demo, true);
  assert.equal(meta.json.demo_vin, 'JTMBK31V996054321');
  const found = await get(`/api/vehicles/by-vin/${meta.json.demo_vin}`);
  assert.equal(found.status, 200);
  assert.equal(found.json.vehicle.plate_number, 'RXA001A');
  assert.equal(found.json.vehicle.model, 'RAV4');
  for (const vin of ['KNDPM3AC8J7100002', '5XYPG4A38JG100003', 'KMHJ3813DHU100004']) {
    assert.equal((await get(`/api/vehicles/by-vin/${vin}`)).status, 200, vin);
  }
});

test('a demo database seeded before demo cars had VINs gets them on the next start', () => {
  const db = openDb(':memory:');
  seedDemo(db);
  db.exec("UPDATE vehicles SET vin = NULL WHERE registered_by = 'demo seed'");
  assert.equal(seedDemo(db), false); // already seeded: only the VINs are filled in
  const rows = db.prepare("SELECT plate_number, vin FROM vehicles WHERE registered_by = 'demo seed' ORDER BY plate_number").all();
  assert.deepEqual(rows.map((r) => r.vin), ['JTMBK31V996054321', 'KNDPM3AC8J7100002', '5XYPG4A38JG100003', 'KMHJ3813DHU100004']);
});

test('nearby garages come back nearest first, with coordinates for the map link', async () => {
  const r = await get('/api/garages/nearby?radius_km=any');
  assert.equal(r.status, 200);
  assert.ok(r.json.count >= 3);
  const d = r.json.garages.map((g) => g.distance_km);
  assert.deepEqual(d, [...d].sort((a, b) => a - b));
  for (const g of r.json.garages) {
    assert.equal(typeof g.latitude, 'number');
    assert.equal(typeof g.longitude, 'number');
  }
  const fromKanombe = await get('/api/garages/nearby?radius_km=any&lat=-1.974&lon=30.137');
  assert.equal(fromKanombe.json.garages[0].name, 'Demo Garage Kanombe');
});
