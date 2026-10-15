'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb, prepareDb, seedDemo } = require('../db');
const { createApp } = require('../server');
const vindecode = require('../lib/vindecode');
const carphotos = require('../lib/carphotos');
const alg = require('../lib/algorithms');

let server;
let base;

// Each test database is in memory, or, with TEST_LIBSQL=1, a temporary file opened through the
// libsql client that Vinzuu uses online with Turso, so both database paths get the same tests.
// TEST_DB_URLS (comma-separated, one empty database server per test database, e.g. local sqld
// servers at http://127.0.0.1:8081,...) runs them against a real server, the way Turso is reached.
let dbCounter = 0;
function testDbTarget() {
  if (process.env.TEST_DB_URLS) return process.env.TEST_DB_URLS.split(',')[dbCounter++];
  if (!process.env.TEST_LIBSQL) return ':memory:';
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'vz-db-'));
  return `file:${require('node:path').join(dir, `t${++dbCounter}.db`)}`;
}

// Stands in for the online VIN decoder (NHTSA vPIC): it knows one US-built Kia Sorento, the way
// vPIC answers for a North American VIN, and nothing else. Counts calls to prove the cache works.
const VPIC_SORENTO = {
  Make: 'KIA', Model: 'Sorento', ModelYear: '2018', DisplacementL: '2.4', EngineCylinders: '4',
  FuelTypePrimary: 'Gasoline', EngineModel: 'GDI THETA-II', Turbo: '', TransmissionStyle: 'Automatic',
  BodyClass: 'Sport Utility Vehicle (SUV)/Multi-Purpose Vehicle (MPV)', PlantCountry: 'UNITED STATES (USA)', Trim: 'LX',
};
const vinLookups = [];

// Stands in for Wikipedia and Commons: a Tucson article with an overview infobox and one per
// generation (wikitext shaped like the real article's), and Commons answers for its photos, one
// of them non-free. Counts calls to prove the cache works.
const TUCSON_WIKITEXT = `{{Short description|Compact crossover SUV}}
{{Infobox automobile
| name = Hyundai Tucson
| image = 2021 Hyundai Tucson (NX4) front.jpg
| production = 2004–present
| model_years = 2005–present
}}
== First generation (JM; 2004) ==
{{Infobox automobile
| name = First generation
| image = [[File:2005 Hyundai Tucson JM.jpg|250px]]
| model_code = JM
| production = 2004–2010<ref>{{cite web|title=x}}</ref>
}}
== Third generation (TL; 2015) ==
{{Infobox automobile
| name = Third generation
| image = 2016 Hyundai Tucson TL front.jpg <!-- best photo -->
| model_code = {{ubl|TL|TLe}}
| production = 2015–2020
}}`;
const COMMONS = {
  '2016 Hyundai Tucson TL front.jpg': { Artist: '<a href="//commons.wikimedia.org/wiki/User:Jane">Jane Doe</a>', LicenseShortName: 'CC BY-SA 4.0' },
  '2021 Hyundai Tucson (NX4) front.jpg': { Artist: 'Kim', LicenseShortName: 'CC BY 2.0' },
  '2005 Hyundai Tucson JM.jpg': { Artist: 'Studio', LicenseShortName: 'Fair use', NonFree: 'true' },
};
const wikiCalls = [];
async function fakeWiki(url) {
  wikiCalls.push(url);
  const u = new URL(url);
  if (u.hostname === 'en.wikipedia.org') {
    if (u.searchParams.get('page') === 'Kia Picanto') return null; // as if Wikipedia were unreachable
    return u.searchParams.get('page') === 'Hyundai Tucson'
      ? { parse: { title: 'Hyundai Tucson', wikitext: TUCSON_WIKITEXT } }
      : { error: { code: 'missingtitle' } };
  }
  const name = u.searchParams.get('titles').replace(/^File:/, '');
  const meta = COMMONS[name];
  if (!meta) return { query: { pages: [{ title: name, missing: true }] } };
  const extmetadata = Object.fromEntries(Object.entries(meta).map(([k, value]) => [k, { value }]));
  return { query: { pages: [{ title: `File:${name}`, imageinfo: [{ thumburl: `https://upload.wikimedia.org/thumb/${encodeURIComponent(name)}/800px.jpg`, descriptionurl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(name)}`, extmetadata }] }] } };
}
async function fakeVinLookup(vin) {
  vinLookups.push(vin);
  return vin === '5XYPGDA30JG100001' ? VPIC_SORENTO : null;
}
const ADMIN = { 'x-admin-token': 'test-admin' };

before(async () => {
  const db = await openDb(testDbTarget());
  await seedDemo(db);
  const app = createApp(db, { adminToken: 'test-admin', writeLimit: { windowMs: 60_000, max: 10_000 }, vinLookup: fakeVinLookup, wikiJson: fakeWiki });
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
  return {
    get: (p) => request('GET', p), post: (p, b) => request('POST', p, b), patch: (p, b) => request('PATCH', p, b),
    put: (p, b) => request('PUT', p, b), del: (p) => request('DELETE', p),
  };
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

test('the 10th VIN character gives the model year, and an unused code gives no year', () => {
  const now = new Date('2026-10-13');
  assert.equal(alg.decodeModelYear('KNDPM3AC8J7100002', now).year, 2018);
  assert.equal(alg.decodeModelYear('KMHB3516BRW102898', now).year, 2024);
  assert.equal(alg.decodeModelYear('JTMBK31V996054321', now).year, 2009, '9 is 2009; 2039 is in the future');
  // North America: a digit in position 7 means the 1980-2009 cycle.
  assert.equal(alg.decodeModelYear('1HGCM82633A004352', now).year, 2003);
  assert.equal(alg.decodeModelYear('4T1BF1FK5CU123456', now).year, 2012);
  assert.equal(alg.decodeModelYear('SB1ZS3JE50E123456', now).year, null, '0 is never a year code');
  assert.equal(alg.decodeModelYear('SHORT', now).year, null);
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

test('the catalog lists the full Hyundai, Kia and Toyota lineups with their logos', async () => {
  const cat = await get('/api/catalog');
  for (const [make, model] of [['Hyundai', 'Santa Fe'], ['Kia', 'Picanto'], ['Toyota', 'Land Cruiser Prado']]) {
    const m = cat.json.makes.find((x) => x.make === make);
    assert.match(m.logo, /^\/img\/makes\/[a-z]+\.svg$/);
    const found = m.models.find((x) => x.model === model);
    assert.ok(found, `${make} ${model} is in the list`);
    assert.ok(found.generations.length > 0, `${make} ${model} has its generations even with no part numbers yet`);
  }
  const toyota = cat.json.makes.find((x) => x.make === 'Toyota');
  assert.equal(toyota.models.filter((x) => x.model === 'RAV4').length, 1, 'a model with part numbers is not listed twice');
  const rav4 = toyota.models.find((x) => x.model === 'RAV4');
  assert.deepEqual(rav4.generations.map((g) => g.generation), ['XA20', 'XA30', 'XA40', 'XA50', 'XA60']);
  assert.ok(rav4.engines.some((e) => e.label === '2.0L Petrol'), 'the demo part numbers still find their engine');
});

test('every model file parses, covers 2000 to 2026, and each generation lists its engines', () => {
  const { loadLineup } = require('../lib/lineup');
  const lineup = loadLineup();
  for (const [make, models] of Object.entries(lineup)) {
    assert.ok(models.length >= 35, `${make} has its full lineup`);
    const names = models.map((m) => m.model.toLowerCase());
    assert.equal(new Set(names).size, names.length, `${make} lists each model once`);
    for (const m of models) {
      for (const g of m.generations) {
        assert.ok(g.year_start <= g.year_end, `${make} ${m.model} ${g.generation} years`);
        assert.ok(g.year_end >= 2000 && g.year_start <= 2026, `${make} ${m.model} ${g.generation} is on sale between 2000 and 2026`);
        assert.ok(g.engines.length > 0, `${make} ${m.model} ${g.generation} lists engines`);
        for (const e of g.engines) assert.match(e.label, /^(\d\.\d{1,2}L [A-Za-z -]+|Electric|Hydrogen fuel cell)$/, `${make} ${m.model} engine "${e.label}"`);
      }
    }
  }
  const tl = lineup.Hyundai.find((m) => m.model === 'Tucson').generations.find((g) => g.generation === 'TL');
  assert.deepEqual([tl.year_start, tl.year_end], [2015, 2020]);
  assert.deepEqual(tl.engines.find((e) => e.label === '1.7L Diesel').codes, ['D4FD']);
});

test('a malformed model file line is reported with its line number', () => {
  const { parseMakeFile } = require('../lib/lineup');
  assert.throws(() => parseMakeFile('Tucson | | SUV\n  TL | 2015 to 2020 | 2.0L Petrol (G4NA)'), /line 2: years must look like/);
  assert.throws(() => parseMakeFile('Tucson | | SUV'), /Tucson has no generations/);
  const [m] = parseMakeFile('Tucson | ix35 | SUV\n  NX4 | 2020-now | 1.6L Turbo Petrol (G4FP); 1.6L Turbo Petrol (G4FT)', 2027);
  assert.equal(m.generations[0].year_end, 2027);
  assert.equal(m.generations[0].ongoing, true);
  assert.deepEqual(m.generations[0].engines, [{ label: '1.6L Turbo Petrol', codes: ['G4FP', 'G4FT'] }]);
  assert.deepEqual(m.aka, ['ix35']);
});

test('VIN decode returns the maker, build country and model year together', async () => {
  const r = await get('/api/vin/decode?vin=KNDPM3AC8J7100002');
  assert.equal(r.json.valid, true);
  assert.equal(r.json.maker, 'Kia');
  assert.equal(r.json.origin, 'Korea');
  assert.equal(r.json.model_year, 2018);
  assert.equal(r.json.model_year_code, 'J');
  assert.equal((await get('/api/vin/decode?vin=nope')).json.valid, false);
});

test('a lineup model with no part numbers yet registers, and a part search for it is logged as a gap', async () => {
  const reg = await post('/api/vehicles/register', {
    plate_number: 'RXA321Z', vin: 'KMHSU81XDCU123321', make: 'Hyundai', model: 'Santa Fe', year: 2012,
  });
  assert.equal(reg.status, 201);
  // Nobody has added an oxygen sensor number for any car yet.
  const s = await get(`/api/parts/search?vehicle_id=${reg.json.vehicle.id}&part_category=Oxygen%20Sensor`);
  assert.equal(s.json.match_type, 'none');
  assert.equal(s.json.reason, 'not_in_database');
});

test('each matched part number says which cars it fits', async () => {
  const v = (await get('/api/vehicles/by-vin/KNDPM3AC8J7100002')).json.vehicle;
  const s = await get(`/api/parts/search?vehicle_id=${v.id}&part_category=Front%20Bumper`);
  const fit = s.json.oe_numbers[0];
  assert.equal(fit.oe_number, 'DEMO-KIA-QL-FB-KR');
  assert.equal(fit.origin_market, 'Korea');
  assert.equal(fit.year_start, 2016);
  assert.equal(fit.year_end, 2021);
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

test('the online decoder\'s engine and fuel become our engine labels', () => {
  assert.equal(vindecode.engineLabel({ DisplacementL: '2.4', FuelTypePrimary: 'Gasoline' }), '2.4L Petrol');
  assert.equal(vindecode.engineLabel({ DisplacementL: '1.998', FuelTypePrimary: 'Gasoline', Turbo: 'Yes' }), '2.0L Turbo Petrol');
  assert.equal(vindecode.engineLabel({ DisplacementL: '2.2', FuelTypePrimary: 'Diesel', Turbo: 'Yes' }), '2.2L Diesel');
  assert.equal(vindecode.engineLabel({ DisplacementL: '2.5', FuelTypePrimary: 'Gasoline', ElectrificationLevel: 'Strong HEV (Hybrid Electric Vehicle)' }), '2.5L Hybrid');
  assert.equal(vindecode.engineLabel({ DisplacementL: '', FuelTypePrimary: 'Electric' }), null);
});

test('a VIN the online decoder knows comes back as the exact car to confirm, and is looked up only once', async () => {
  const before = vinLookups.length;
  const r = await get('/api/vin/decode?vin=5XYPGDA30JG100001');
  assert.equal(r.status, 200);
  assert.deepEqual(
    { make: r.json.car.make, model: r.json.car.model, year: r.json.car.year, generation: r.json.car.generation, engine: r.json.car.engine, origin: r.json.car.origin_market, source: r.json.car.source },
    { make: 'Kia', model: 'Sorento', year: 2018, generation: 'UM', engine: '2.4L Petrol', origin: 'USA', source: 'vpic' });
  await get('/api/vin/decode?vin=5XYPGDA30JG100001');
  assert.equal(vinLookups.length - before, 1, 'the second decode is answered from the cache');
});

test('a VIN nobody knows yet gives the maker and year but no exact car', async () => {
  const r = await get('/api/vin/decode?vin=KMHHT61DXCU900001');
  assert.equal(r.json.maker, 'Hyundai');
  assert.equal(r.json.car, null);
});

test('a VIN sharing its build characters with a saved car is suggested as the same build', async () => {
  await post('/api/vehicles/register', {
    vin: 'KNAFK4A61J7400001', make: 'Kia', model: 'Sportage', generation: 'QL', year: 2018, engine: '2.0L Diesel', origin_market: 'Korea',
  });
  const r = await get('/api/vin/decode?vin=KNAFK4A69J7400777');
  assert.equal(r.json.car.source, 'saved');
  assert.equal(r.json.car.model, 'Sportage');
  assert.equal(r.json.car.engine, '2.0L Diesel');
  assert.equal(r.json.car.year, 2018);
});

test('the owner can update the mileage at any time, and nobody else can', async () => {
  const owner = makeClient();
  await owner.post('/api/auth/signup', { name: 'Mileage Owner', email: 'mileage@example.com', password: 'Long-password123' });
  const reg = await owner.post('/api/vehicles/register', { vin: 'JTMBK31V996400002', make: 'Toyota', model: 'RAV4', year: 2009 });
  const id = reg.json.vehicle.id;
  const first = await owner.patch(`/api/vehicles/id/${id}`, { mileage_km: 84500 });
  assert.equal(first.json.vehicle.mileage_km, 84500);
  const second = await owner.patch(`/api/vehicles/id/${id}`, { mileage_km: 86000 });
  assert.equal(second.json.vehicle.mileage_km, 86000);
  const stranger = await call('PATCH', `/api/vehicles/id/${id}`, { mileage_km: 1 });
  assert.deepEqual(stranger.json.ignored, ['mileage_km']);
  assert.equal(stranger.json.vehicle.mileage_km, null, 'and the stranger is not shown it');
  assert.equal((await owner.get(`/api/vehicles/id/${id}`)).json.vehicle.mileage_km, 86000);
});

test('the photo for a generation comes from its own infobox, with the photographer and licence', async () => {
  const before = wikiCalls.length;
  const r = await get('/api/car-photo?make=Hyundai&model=Tucson&generation=TL');
  assert.equal(r.json.photo.exact, true);
  assert.match(r.json.photo.src, /2016%20Hyundai%20Tucson%20TL/);
  assert.equal(r.json.photo.credit, 'Jane Doe');
  assert.equal(r.json.photo.license, 'CC BY-SA 4.0');
  await get('/api/car-photo?make=Hyundai&model=Tucson&generation=TL');
  assert.equal(wikiCalls.length - before, 2, 'one article read and one Commons lookup, then cached');
});

test('a generation whose own photo is not free falls back to the model\'s lead photo, marked as not exact', async () => {
  const r = await get('/api/car-photo?make=Hyundai&model=Tucson&generation=JM');
  assert.equal(r.json.photo.exact, false);
  assert.equal(r.json.photo.credit, 'Kim');
});

test('a generation with no infobox of its own matches by years, or falls back to the lead photo', () => {
  const boxes = carphotos.infoboxes(TUCSON_WIKITEXT);
  assert.equal(boxes.length, 3);
  assert.equal(carphotos.imageName(boxes[1].fields.image), '2005 Hyundai Tucson JM.jpg');
  assert.equal(carphotos.imageName(boxes[2].fields.image), '2016 Hyundai Tucson TL front.jpg');
  assert.equal(carphotos.pickInfobox(boxes, { generation: 'XX', year_start: 2015, year_end: 2021 }), boxes[2]);
  assert.equal(carphotos.pickInfobox(boxes, { generation: 'NX4', year_start: 2021, year_end: 2027 }), null);
});

test('when the server cannot reach Wikipedia it says so, does not cache it, and hands the browser what it needs', async () => {
  const first = await get('/api/car-photo?make=Kia&model=Picanto');
  assert.equal(first.json.photo, null);
  assert.equal(first.json.reason, 'unreachable');
  assert.equal(first.json.lookup.model, 'Picanto');
  const before = wikiCalls.length;
  await get('/api/car-photo?make=Kia&model=Picanto');
  assert.ok(wikiCalls.length > before, 'tried again rather than cached');
  const lib = await fetch(`${base}/carphotos.js`);
  assert.equal(lib.status, 200);
  assert.match(await lib.text(), /root\.carphotos = factory\(\)/);
});

test('a model with no Wikipedia article is reported as such', async () => {
  const r = await get('/api/car-photo?make=Kia&model=Rio');
  assert.equal(r.json.photo, null);
  assert.equal(r.json.reason, 'no_article');
});

test('the customer page is allowed to show Wikimedia photos and look them up', async () => {
  const res = await fetch(`${base}/index.html`);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /img-src [^;]*https:\/\/upload\.wikimedia\.org/);
  // Commons now hands out resized photos from thumb.wikimedia.org.
  assert.match(csp, /img-src [^;]*https:\/\/thumb\.wikimedia\.org/);
  assert.match(csp, /connect-src [^;]*https:\/\/en\.wikipedia\.org/);
});

test('photos are only looked up for models in our lineup', async () => {
  const before = wikiCalls.length;
  const r = await get('/api/car-photo?make=Hyundai&model=Not%20A%20Car');
  assert.equal(r.json.photo, null);
  assert.equal(wikiCalls.length, before);
});

test('anyone with the VIN sees the car, but only its owner sees the mileage and when it was saved', async () => {
  const owner = makeClient();
  await owner.post('/api/auth/signup', { name: 'Car Owner', email: 'owner2@example.com', password: 'Long-password123' });
  const reg = await owner.post('/api/vehicles/register', { vin: 'KMHB3516BRW400003', make: 'Hyundai', model: 'Casper', year: 2024 });
  await owner.patch(`/api/vehicles/id/${reg.json.vehicle.id}`, { mileage_km: 12000 });
  const mine = await owner.get('/api/vehicles/by-vin/KMHB3516BRW400003');
  assert.equal(mine.json.vehicle.mine, true);
  assert.equal(mine.json.vehicle.mileage_km, 12000);
  const other = makeClient();
  await other.post('/api/auth/signup', { name: 'Someone Else', email: 'else@example.com', password: 'Long-password123' });
  const theirs = await other.get('/api/vehicles/by-vin/KMHB3516BRW400003');
  assert.equal(theirs.json.vehicle.model, 'Casper');
  assert.equal(theirs.json.vehicle.mine, false);
  assert.equal(theirs.json.vehicle.mileage_km, null);
  assert.equal(theirs.json.vehicle.created_at, null);
  assert.equal((await other.get('/api/me/vehicles')).json.vehicles.length, 0);
});

test('a customer registers by VIN alone, with no plate', async () => {
  const one = await post('/api/vehicles/register', {
    vin: 'JTMBK31V996077001', make: 'Toyota', model: 'RAV4', year: 2016,
  });
  assert.equal(one.status, 201);
  assert.equal(one.json.vehicle.plate_number, '');
  assert.equal(one.json.vehicle.origin_market, 'Japan');
  // A second plate-less car is a separate record, not merged on the empty plate.
  const two = await post('/api/vehicles/register', {
    vin: 'KNDPMCAC5J7077002', make: 'Kia', model: 'Sportage', year: 2018,
  });
  assert.equal(two.status, 201);
  assert.notEqual(two.json.vehicle.id, one.json.vehicle.id);
  // The same VIN again finds the same car.
  const again = await post('/api/vehicles/register', {
    vin: 'JTMBK31V996077001', make: 'Toyota', model: 'RAV4', year: 2016,
  });
  assert.equal(again.json.vehicle.id, one.json.vehicle.id);
  // Neither a VIN nor a plate: nothing to identify the car by.
  const none = await post('/api/vehicles/register', { make: 'Kia', model: 'Rio', year: 2015 });
  assert.equal(none.status, 400);
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

test('a "Not sure" generation is settled by the year when only one generation covers it', async () => {
  // 2018 Corolla: the catalog only has E170 for that year, so "Not sure" must not dead-end.
  const both = await post('/api/vehicles/register', {
    plate_number: 'RXD001A', make: 'Toyota', model: 'Corolla', year: 2018, origin_market: 'Japan',
  });
  const unsure = await get(`/api/parts/search?vehicle_id=${both.json.vehicle.id}&part_category=Front%20Brake%20Pad`);
  assert.equal(unsure.json.match_type, 'relaxed', 'the engine is still unknown, so the match is only a close one');
  assert.ok(unsure.json.oe_numbers.some((o) => o.oe_number === 'DEMO-TYT-E170-FBP-01'));
  assert.ok(unsure.json.oe_numbers.every((o) => o.confidence === 'LOW'));

  const genOnly = await post('/api/vehicles/register', {
    plate_number: 'RXD002B', make: 'Toyota', model: 'Corolla', year: 2018, engine: '1.8L Petrol', origin_market: 'Japan',
  });
  const exact = await get(`/api/parts/search?vehicle_id=${genOnly.json.vehicle.id}&part_category=Front%20Brake%20Pad`);
  assert.equal(exact.json.match_type, 'exact');
  assert.equal(exact.json.oe_numbers[0].confidence, 'HIGH');
  const stored = await get(`/api/vehicles/id/${genOnly.json.vehicle.id}`);
  assert.equal(stored.json.vehicle.generation, null, 'the stored car is not silently rewritten');
});

test('a "Not sure" generation is never guessed when two generations were sold that year', async () => {
  const row = {
    part_category: 'Front Brake Pad', make: 'Honda', model: 'Fit', engine: null, origin_market: null,
    confidence_level: 'MEDIUM', source: 'Test data',
  };
  await post('/api/admin/fitment-reference', { ...row, oe_number: 'TEST-FIT-GD', generation: 'GD', year_start: 2001, year_end: 2008 }, ADMIN);
  await post('/api/admin/fitment-reference', { ...row, oe_number: 'TEST-FIT-GE', generation: 'GE', year_start: 2007, year_end: 2014 }, ADMIN);

  const overlap = await post('/api/vehicles/register', { plate_number: 'RXD003C', make: 'Honda', model: 'Fit', year: 2008 });
  const r = await get(`/api/parts/search?vehicle_id=${overlap.json.vehicle.id}&part_category=Front%20Brake%20Pad`);
  assert.equal(r.json.match_type, 'none');
  assert.equal(r.json.reason, 'generation_unknown');
  assert.match(r.json.message, /which one/);

  const patched = await call('PATCH', `/api/vehicles/id/${overlap.json.vehicle.id}`, { generation: 'GE' });
  assert.deepEqual(patched.json.updated, ['generation']);
  const fixed = await get(`/api/parts/search?vehicle_id=${overlap.json.vehicle.id}&part_category=Front%20Brake%20Pad`);
  assert.equal(fixed.json.match_type, 'exact');
  assert.equal(fixed.json.oe_numbers[0].oe_number, 'TEST-FIT-GE');

  const later = await post('/api/vehicles/register', { plate_number: 'RXD004D', make: 'Honda', model: 'Fit', year: 2012 });
  const single = await get(`/api/parts/search?vehicle_id=${later.json.vehicle.id}&part_category=Front%20Brake%20Pad`);
  assert.equal(single.json.oe_numbers[0].oe_number, 'TEST-FIT-GE');
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

test('shops cannot post parts: they send requests, and only an admin can post or approve them', async () => {
  const noCode = await get('/api/shop/me');
  assert.equal(noCode.status, 401);
  const me = await get('/api/shop/me', { 'x-shop-code': '111111' });
  assert.equal(me.json.shop.id, 1);
  assert.ok(!JSON.stringify(me.json).includes('111111'), 'the access code is never echoed back');

  const other = await get('/api/shops/2/listings', { 'x-shop-code': '111111' });
  assert.equal(other.status, 403);

  const photo = '/img/placeholder.svg?text=test';
  const part = {
    part_category: 'Front Brake Pad', oe_number: 'DEMO-TYT-XA40-FBP-01', price_rwf: 41000,
    stock_quantity: 4, condition: 'genuine', photo_url: photo, brand: 'Toyota', description: 'Set of 4 ceramic pads.',
  };
  const direct = await post('/api/shops/1/listings', part, { 'x-shop-code': '111111' });
  assert.equal(direct.status, 403, 'a shop can no longer post a part itself');
  assert.equal(direct.json.code, 'admin_only');

  const unknown = await post('/api/shops/1/listing-requests', { ...part, oe_number: 'NOT-A-REAL-NUMBER' }, { 'x-shop-code': '111111' });
  assert.equal(unknown.status, 422);
  assert.equal(unknown.json.code, 'unknown_oe');
  const noPhoto = await post('/api/shops/1/listing-requests', { ...part, photo_url: null }, { 'x-shop-code': '111111' });
  assert.equal(noPhoto.status, 400);
  const badPhoto = await post('/api/shops/1/listing-requests', { ...part, photo_url: 'javascript:alert(1)' }, { 'x-shop-code': '111111' });
  assert.equal(badPhoto.status, 400);

  const sent = await post('/api/shops/1/listing-requests', part, { 'x-shop-code': '111111' });
  assert.equal(sent.status, 201);
  assert.equal(sent.json.request.status, 'pending');
  const before = (await get('/api/shops/1/listings', { 'x-shop-code': '111111' })).json.listings.length;

  assert.equal((await post(`/api/admin/listing-requests/${sent.json.request.id}/approve`, {}, { 'x-shop-code': '111111' })).status, 401,
    'a shop cannot approve its own request');
  const approved = await post(`/api/admin/listing-requests/${sent.json.request.id}/approve`, { price_rwf: 40000 }, ADMIN);
  assert.equal(approved.status, 200);
  assert.equal(approved.json.listing.price_rwf, 40000, 'the admin can correct the price while approving');
  assert.equal(approved.json.listing.description, 'Set of 4 ceramic pads.');
  const after = (await get('/api/shops/1/listings', { 'x-shop-code': '111111' })).json.listings;
  assert.equal(after.length, before + 1);
  assert.ok(after.find((l) => l.id === approved.json.listing.id).fits.length > 0, 'each part says which cars it fits');
  assert.equal((await post(`/api/admin/listing-requests/${sent.json.request.id}/approve`, {}, ADMIN)).status, 409, 'approved only once');

  // The shop keeps price and stock; what the part is stays as the admin checked it.
  const id = approved.json.listing.id;
  const priced = await call('PUT', `/api/shops/1/listings/${id}`, { price_rwf: 39000, stock_quantity: 2 }, { 'x-shop-code': '111111' });
  assert.equal(priced.json.listing.price_rwf, 39000);
  const relabel = await call('PUT', `/api/shops/1/listings/${id}`, { condition: 'aftermarket' }, { 'x-shop-code': '111111' });
  assert.equal(relabel.status, 403);
  const redescribe = await call('PUT', `/api/shops/1/listings/${id}`, { description: 'Genuine Toyota!!' }, { 'x-shop-code': '111111' });
  assert.equal(redescribe.status, 403);

  // An admin posts directly, and can hide a part so customers stop seeing it.
  const posted = await post('/api/admin/listings', { ...part, shop_id: 2, oe_number: 'DEMO-TYT-XA40-OF-20', part_category: 'Oil Filter' }, ADMIN);
  assert.equal(posted.status, 201);
  const visible = async () => (await get('/api/parts/listings?oe_numbers=DEMO-TYT-XA40-OF-20&radius_km=any')).json.listings
    .some((l) => l.listing_id === posted.json.listing.id);
  assert.ok(await visible());
  await call('PUT', `/api/admin/listings/${posted.json.listing.id}`, { hidden: true }, ADMIN);
  assert.ok(!(await visible()), 'a hidden part is off sale');

  const rejectMe = await post('/api/shops/1/listing-requests', part, { 'x-shop-code': '111111' });
  assert.equal((await post(`/api/admin/listing-requests/${rejectMe.json.request.id}/reject`, {}, ADMIN)).status, 400, 'a rejection needs a reason');
  await post(`/api/admin/listing-requests/${rejectMe.json.request.id}/reject`, { admin_note: 'Photo is blurry.' }, ADMIN);
  const mine = (await get('/api/shops/1/listing-requests', { 'x-shop-code': '111111' })).json.requests;
  assert.equal(mine.find((r) => r.id === rejectMe.json.request.id).admin_note, 'Photo is blurry.');
});

test('a business applies, cannot sign in until approved, then lands on its dashboard', async () => {
  const photo = 'data:image/jpeg;base64,AAAA';
  const form = {
    kind: 'both', business_name: 'Kimihurura Auto', owner_name: 'Alice Uwase', email: 'alice.auto@gmail.com',
    password: 'Strong-pass1', phone: '+250 788 555 111', address_text: 'Kimihurura', latitude: -1.95, longitude: 30.08,
    tin: '123456789', certificate_photo: photo, front_photo: photo, specialties: 'Brakes',
  };
  assert.equal((await post('/api/business/apply', { ...form, tin: '12' })).status, 400, 'TIN is 9 digits');
  assert.equal((await post('/api/business/apply', { ...form, latitude: 10 })).status, 400, 'the location must be in Rwanda');
  const applied = await post('/api/business/apply', form);
  assert.equal(applied.status, 201);
  assert.equal((await post('/api/business/apply', form)).status, 409, 'one pending application per email');

  const owner = makeClient();
  const early = await owner.post('/api/auth/login', { email: form.email, password: form.password });
  assert.equal(early.status, 403);
  assert.equal(early.json.code, 'application_pending');

  const list = (await get('/api/admin/applications?status=pending', ADMIN)).json.applications;
  const mine = list.find((a) => a.email === form.email);
  assert.ok(mine && !('password_hash' in mine), 'the password hash never leaves the server');
  const ok = await post(`/api/admin/applications/${mine.id}/approve`, {}, ADMIN);
  assert.ok(ok.json.shop_id && ok.json.garage_id);

  const signedIn = await owner.post('/api/auth/login', { email: form.email, password: form.password });
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.json.user.role, 'business');
  assert.equal(signedIn.json.user.home, '/business.html');
  const me = await owner.get('/api/business/me');
  assert.equal(me.json.shop.name, 'Kimihurura Auto');
  assert.equal(me.json.garage.specialties, 'Brakes');
  assert.equal((await get('/api/admin/garages', ADMIN)).json.garages.find((g) => g.id === ok.json.garage_id).photo_url, photo,
    'the front photo becomes the garage photo');
  // The new shop cannot post either, and cannot touch another shop.
  assert.equal((await owner.post(`/api/shops/${me.json.shop.id}/listings`, {})).status, 403);
  assert.equal((await owner.get('/api/shops/1/listings')).status, 403);
  assert.equal((await owner.get('/api/admin/stats')).status, 401, 'a business is not an admin');

  // A customer account is told it is not a business, and a rejected applicant hears why.
  const customer = makeClient();
  await customer.post('/api/auth/signup', { name: 'Bob', email: 'bob.customer@example.com', password: 'Long-password123' });
  assert.equal((await customer.get('/api/business/me')).json.code, 'not_business');
  const second = await post('/api/business/apply', { ...form, email: 'second@example.com', kind: 'garage' });
  await post(`/api/admin/applications/${second.json.application.id}/reject`, { admin_note: 'TIN does not match.' }, ADMIN);
  const rejected = await makeClient().post('/api/auth/login', { email: 'second@example.com', password: form.password });
  assert.equal(rejected.json.code, 'application_rejected');
  assert.match(rejected.json.error, /TIN does not match/);
});

test('admins and demo businesses sign in with accounts, and "/" sends each to its own home', async () => {
  const admin = makeClient();
  const a = await admin.post('/api/auth/login', { email: 'admin@vinzuu.rw', password: 'Admin-vinzuu1' });
  assert.equal(a.json.user.home, '/admin.html');
  assert.equal((await admin.get('/api/admin/stats')).status, 200, 'the admin session works without the token');
  const both = makeClient();
  const b = await both.post('/api/auth/login', { email: 'both@vinzuu.rw', password: 'Vinzuu-demo1' });
  assert.equal(b.json.user.role, 'business');
  const me = (await both.get('/api/business/me')).json;
  assert.ok(me.shop && me.garage, 'this demo account runs a shop and a garage');
  const res = await fetch(`${base}/`, { redirect: 'manual', headers: { cookie: '' } });
  assert.equal(res.status, 200, 'signed out, "/" is the public homepage');
  const old = await fetch(`${base}/shop.html`, { redirect: 'manual' });
  assert.equal(old.headers.get('location'), '/business.html');
});

test('garages accept, decline and finish jobs, and set labour prices customers can see', async () => {
  const garage = makeClient();
  await garage.post('/api/auth/login', { email: 'garage1@vinzuu.rw', password: 'Vinzuu-demo1' });
  const listing = (await get('/api/parts/listings?oe_numbers=DEMO-TYT-XA40-FBP-01&radius_km=any')).json.listings[0];
  const customer = makeClient();
  await customer.post('/api/auth/signup', { name: 'Grace Mukamana', email: 'grace.jobs@example.com', password: 'Long-password123' });
  const booked = await customer.post('/api/bookings', { plate_number: 'RXA001A', customer_phone: '+250788123456', shop_listing_id: listing.listing_id, garage_id: 1 });
  assert.equal(booked.status, 201);
  const id = booked.json.booking.id;

  const jobs = (await garage.get('/api/garage/jobs')).json.jobs;
  const job = jobs.find((j) => j.id === id);
  assert.equal(job.garage_status, 'requested');
  assert.ok(!('vin' in job), 'garages see a masked VIN only');
  assert.equal((await garage.put(`/api/garage/jobs/${id}`, { action: 'done' })).status, 409, 'accept before done');
  assert.equal((await garage.put(`/api/garage/jobs/${id}`, { action: 'accept' })).status, 400, 'accepting needs a time');
  const accepted = await garage.put(`/api/garage/jobs/${id}`, { action: 'accept', time: '2026-10-20T10:30' });
  assert.equal(accepted.json.job.garage_time, '2026-10-20 10:30');
  assert.equal((await garage.put(`/api/garage/jobs/${id}`, { action: 'done' })).json.job.garage_status, 'done');

  const other = makeClient();
  await other.post('/api/auth/login', { email: 'garage2@vinzuu.rw', password: 'Vinzuu-demo1' });
  assert.equal((await other.put(`/api/garage/jobs/${id}`, { action: 'decline', reason: 'x' })).status, 404, 'only the chosen garage');
  assert.equal((await garage.get('/api/shop/me')).status, 401, 'a garage-only account has no shop side');

  const added = await garage.post('/api/garage/services', { name: 'Fit a radiator', price_rwf: 25000, duration_minutes: 120 });
  assert.equal(added.status, 201);
  const near = (await get('/api/garages/nearby?radius_km=any')).json.garages.find((g) => g.id === 1);
  assert.ok(near.services.some((s) => s.name === 'Fit a radiator' && s.price_rwf === 25000));
  assert.ok(near.services.some((s) => s.part_category === 'Front Brake Pad'), 'demo garages have labour prices per part');
});

test('only a customer whose booking is finished can review, once, and the business can reply', async () => {
  const listing = (await get('/api/parts/listings?oe_numbers=DEMO-TYT-XA40-FBP-01&radius_km=any')).json.listings[0];
  const customer = makeClient();
  await customer.post('/api/auth/signup', { name: 'Jean Claude Habimana', email: 'jc.reviews@example.com', password: 'Long-password123' });
  const id = (await customer.post('/api/bookings', { plate_number: 'RXA001A', customer_phone: '+250788123456', shop_listing_id: listing.listing_id, garage_id: 2 })).json.booking.id;

  let mine = (await customer.get('/api/me/bookings')).json.bookings.find((b) => b.id === id);
  assert.deepEqual(mine.review, { shop: null, garage: null }, 'nothing to review yet');
  assert.equal((await customer.post(`/api/me/bookings/${id}/reviews`, { target: 'shop', rating: 5 })).status, 409);

  const code = ['111111', '222222', '333333', '444444', '555555'][listing.shop_id - 1];
  await call('PUT', `/api/shops/${listing.shop_id}/bookings/${id}`, { status: 'collected' }, { 'x-shop-code': code });
  mine = (await customer.get('/api/me/bookings')).json.bookings.find((b) => b.id === id);
  assert.equal(mine.review.shop, 'can_review');

  const stranger = makeClient();
  await stranger.post('/api/auth/signup', { name: 'Not Me', email: 'stranger.reviews@example.com', password: 'Long-password123' });
  assert.equal((await stranger.post(`/api/me/bookings/${id}/reviews`, { target: 'shop', rating: 1 })).status, 404, 'only the customer who booked');

  assert.equal((await customer.post(`/api/me/bookings/${id}/reviews`, { target: 'shop', rating: 6 })).status, 400);
  const rated = await customer.post(`/api/me/bookings/${id}/reviews`, { target: 'shop', rating: 4, comment: 'Good pads, fair price.' });
  assert.equal(rated.status, 201);
  assert.equal((await customer.post(`/api/me/bookings/${id}/reviews`, { target: 'shop', rating: 5 })).status, 409, 'one review per booking');

  const pub = (await get(`/api/reviews?shop_id=${listing.shop_id}`)).json;
  const review = pub.reviews.find((r) => r.comment === 'Good pads, fair price.');
  assert.equal(review.author_name, 'Jean H.', 'first name and last initial only');
  const shown = (await get('/api/parts/listings?oe_numbers=DEMO-TYT-XA40-FBP-01&radius_km=any')).json.listings.find((l) => l.shop_id === listing.shop_id);
  assert.equal(shown.shop_rating.count, pub.rating.count, 'listings carry the shop rating');

  const replied = await call('PUT', `/api/shop/reviews/${review.id}`, { reply: 'Thank you!' }, { 'x-shop-code': code });
  assert.equal(replied.json.review.reply, 'Thank you!');
  const otherCode = code === '111111' ? '222222' : '111111';
  assert.equal((await call('PUT', `/api/shop/reviews/${review.id}`, { reply: 'spam' }, { 'x-shop-code': otherCode })).status, 404);
  assert.equal((await call('DELETE', `/api/admin/reviews/${review.id}`, null, ADMIN)).status, 200, 'an admin can remove an abusive review');
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

test('sign up needs an uppercase letter, a number and a special character, and says what is missing', async () => {
  const weak = await post('/api/auth/signup', { name: 'Test', email: 'weak@example.com', password: 'alllowercase' });
  assert.equal(weak.status, 400);
  assert.match(weak.json.error, /uppercase letter, a number, a special character/);
  const noSymbol = await post('/api/auth/signup', { name: 'Test', email: 'weak@example.com', password: 'Password1' });
  assert.equal(noSymbol.status, 400);
  assert.match(noSymbol.json.error, /special character/);
  assert.doesNotMatch(noSymbol.json.error, /uppercase|a number/);
});

test('sign up saves an optional phone number, and rejects one that is not a phone number', async () => {
  const withPhone = await makeClient().post('/api/auth/signup', { name: 'Eric', email: 'eric@example.com', phone: '+250 788 000 000', password: 'Strong-pass-6' });
  assert.equal(withPhone.status, 201);
  assert.equal(withPhone.json.user.phone, '+250788000000');
  const noPhone = await makeClient().post('/api/auth/signup', { name: 'Fiona', email: 'fiona@example.com', password: 'Strong-pass-7' });
  assert.equal(noPhone.status, 201);
  assert.equal(noPhone.json.user.phone, null);
  const badPhone = await post('/api/auth/signup', { name: 'Gad', email: 'gad@example.com', phone: '12', password: 'Strong-pass-8' });
  assert.equal(badPhone.status, 400);
});

test('sign up, sign in, see the session, and sign out, with no password ever echoed back', async () => {
  const client = makeClient();
  const up = await client.post('/api/auth/signup', { name: 'Alice Uwase', email: 'alice@example.com', password: 'Correct-horse-1' });
  assert.equal(up.status, 201);
  assert.equal(up.json.user.email, 'alice@example.com');
  assert.ok(!JSON.stringify(up.json).toLowerCase().includes('password'));

  const dup = await client.post('/api/auth/signup', { name: 'Alice again', email: 'alice@example.com', password: 'Another-pass-2' });
  assert.equal(dup.status, 409);

  const me = await client.get('/api/auth/me');
  assert.equal(me.json.user.email, 'alice@example.com');

  await client.post('/api/auth/logout');
  assert.equal((await client.get('/api/auth/me')).json.user, null);

  const wrongPw = await client.post('/api/auth/login', { email: 'alice@example.com', password: 'nope nope nope' });
  assert.equal(wrongPw.status, 401);
  const right = await client.post('/api/auth/login', { email: 'alice@example.com', password: 'Correct-horse-1' });
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
  await client.post('/api/auth/signup', { name: 'Bosco', email: 'bosco@example.com', password: 'Another-strong-3' });
  const reg = await client.post('/api/vehicles/register', { plate_number: 'RXG001A', make: 'Toyota', model: 'Corolla', year: 2016 });
  assert.equal(reg.status, 201);
  const mine = await client.get('/api/me/vehicles');
  assert.equal(mine.json.vehicles.length, 1);
  assert.equal(mine.json.vehicles[0].plate_number, 'RXG001A');

  // a second account never sees the first account's cars
  const other = makeClient();
  await other.post('/api/auth/signup', { name: 'Claudine', email: 'claudine@example.com', password: 'Yet-another-4' });
  assert.equal((await other.get('/api/me/vehicles')).json.vehicles.length, 0);
});

test('signing in and re-entering a plate that nobody claimed yet adopts it into the account', async () => {
  await post('/api/vehicles/register', { plate_number: 'RXG002B', make: 'Toyota', model: 'Corolla', year: 2017 }); // guest registration
  const client = makeClient();
  await client.post('/api/auth/signup', { name: 'Didier', email: 'didier@example.com', password: 'Yet-another-5' });
  const again = await client.post('/api/vehicles/register', { plate_number: 'RXG002B', make: 'Toyota', model: 'Corolla', year: 2017 });
  assert.equal(again.status, 200);
  assert.equal(again.json.existing, true);
  const mine = await client.get('/api/me/vehicles');
  assert.ok(mine.json.vehicles.some((v) => v.plate_number === 'RXG002B'));
});

test('Google sign-in is refused cleanly when the server has no client id configured', async () => {
  const g = await post('/api/auth/google', { id_token: 'whatever' });
  assert.equal(g.status, 503);
});

test('Google sign-in creates an account, links a verified email to a password account, and the password still works', async () => {
  const { openDb: open } = require('../db');
  const tokens = {
    new: { sub: 'g-1', email: 'new.google@example.com', email_verified: true, name: 'New Person' },
    verified: { sub: 'g-2', email: 'both@example.com', email_verified: true, name: 'Both Ways' },
    unverified: { sub: 'g-3', email: 'victim@example.com', email_verified: false, name: 'Someone Else' },
  };
  const app = createApp(await open(testDbTarget()), {
    writeLimit: { windowMs: 60_000, max: 10_000 },
    googleClientId: 'test-client.apps.googleusercontent.com',
    verifyGoogleIdToken: async (idToken) => { if (!tokens[idToken]) throw new Error('That sign-in could not be verified.'); return tokens[idToken]; },
  });
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const url = `http://127.0.0.1:${srv.address().port}`;
  const send = (path, body) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, json: await r.json() }));
  try {
    assert.equal((await fetch(`${url}/api/auth/config`).then((r) => r.json())).google, true);

    const fresh = await send('/api/auth/google', { id_token: 'new' });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.json.user.email, 'new.google@example.com');
    assert.equal(fresh.json.user.provider, 'google');

    assert.equal((await send('/api/auth/google', { id_token: 'forged' })).status, 401);

    const pw = 'Both-ways1';
    assert.equal((await send('/api/auth/signup', { name: 'Both Ways', email: 'both@example.com', password: pw })).status, 201);
    const linked = await send('/api/auth/google', { id_token: 'verified' });
    assert.equal(linked.status, 200);
    assert.equal(linked.json.user.email, 'both@example.com', 'the same account, not a new one');
    const again = await send('/api/auth/login', { email: 'both@example.com', password: pw });
    assert.equal(again.status, 200, 'the password still works after Google was added');

    assert.equal((await send('/api/auth/signup', { name: 'Victim', email: 'victim@example.com', password: 'Victim-pass1' })).status, 201);
    const takeover = await send('/api/auth/google', { id_token: 'unverified' });
    assert.equal(takeover.status, 409, 'an unverified Google email never opens someone else\'s account');
  } finally {
    srv.close();
  }
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

test('a demo database seeded before demo cars had VINs gets them on the next start', async () => {
  const db = await openDb(testDbTarget());
  await seedDemo(db);
  await db.exec("UPDATE vehicles SET vin = NULL WHERE registered_by = 'demo seed'");
  assert.equal(await seedDemo(db), false); // already seeded: only the VINs are filled in
  const rows = await db.prepare("SELECT plate_number, vin FROM vehicles WHERE registered_by = 'demo seed' ORDER BY plate_number").all();
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

test('the garage lists only the parts that fit this car, with how many shops stock each', async () => {
  const v = (await get('/api/vehicles/by-vin/KNDPM3AC8J7100002')).json.vehicle;
  const r = await get(`/api/parts/for-vehicle?vehicle_id=${v.id}`);
  assert.equal(r.status, 200);
  const bumper = r.json.categories.find((c) => c.name === 'Front Bumper');
  assert.ok(['exact', 'relaxed'].includes(bumper.fit));
  const wiper = r.json.categories.find((c) => c.name === 'Wiper Blade');
  assert.equal(wiper.fit, 'universal');
  // A car we have no part numbers for gets nothing but the standard-size parts.
  const reg = await post('/api/vehicles/register', { vin: 'KMHSU81XDCU777001', make: 'Hyundai', model: 'Santa Fe', year: 2012 });
  const none = await get(`/api/parts/for-vehicle?vehicle_id=${reg.json.vehicle.id}`);
  assert.ok(none.json.categories.filter((c) => c.type !== 'universal').every((c) => c.fit === 'none' && c.shops === 0));
  assert.equal((await get('/api/parts/for-vehicle?vehicle_id=999999')).status, 404);
});

test('the mileage can be given when the car is first saved', async () => {
  const reg = await post('/api/vehicles/register', { vin: 'KMHSU81XDCU777002', make: 'Hyundai', model: 'Santa Fe', year: 2012, mileage_km: 84500 });
  assert.equal(reg.status, 201);
  assert.equal(reg.json.vehicle.mileage_km, 84500);
  assert.equal((await post('/api/vehicles/register', { vin: 'KMHSU81XDCU777003', make: 'Hyundai', model: 'Santa Fe', year: 2012, mileage_km: -5 })).status, 400);
});

test('signed in, "/" opens your garage; signed out it is the public homepage', async () => {
  const out = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(out.status, 200);
  const c = makeClient();
  await c.post('/api/auth/signup', { name: 'Logo', email: 'logo@example.com', password: 'Long-password123' });
  const me = await c.get('/api/auth/me');
  assert.ok(me.json.user);
  const cookieRes = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'logo@example.com', password: 'Long-password123' }) });
  const cookie = cookieRes.headers.getSetCookie()[0].split(';')[0];
  const signedIn = await fetch(`${base}/`, { redirect: 'manual', headers: { cookie } });
  assert.equal(signedIn.status, 302);
  assert.equal(signedIn.headers.get('location'), '/index.html');
  assert.equal((await fetch(`${base}/welcome.html`, { redirect: 'manual', headers: { cookie } })).status, 200);
});

// ---------- admin dashboard: suspend, reports, scorecards, accounts, bookings, charts, log, CSV ----------

test('suspending a shop hides its parts and blocks bookings until it is reactivated, and the owner sees why', async () => {
  const oe = 'DEMO-TYT-XA40-FBP-01';
  const before = (await get(`/api/parts/listings?oe_numbers=${oe}&radius_km=any`)).json.listings;
  const target = before[0];
  assert.equal((await post(`/api/admin/shops/${target.shop_id}/suspend`, {}, ADMIN)).status, 400, 'a reason is required');
  assert.equal((await post(`/api/admin/shops/${target.shop_id}/suspend`, { reason: 'Customers report fake pads' }, ADMIN)).status, 200);
  const during = (await get(`/api/parts/listings?oe_numbers=${oe}&radius_km=any`)).json.listings;
  assert.ok(!during.some((l) => l.shop_id === target.shop_id), 'its parts are not shown');
  const booked = await post('/api/bookings', { plate_number: 'RXA001A', customer_phone: '+250788123456', shop_listing_id: target.listing_id });
  assert.equal(booked.status, 409);

  const owner = makeClient();
  await owner.post('/api/auth/login', { email: `shop${target.shop_id}@vinzuu.rw`, password: 'Vinzuu-demo1' });
  const me = (await owner.get('/api/business/me')).json;
  assert.equal(me.shop.suspended, true);
  assert.equal(me.shop.suspended_reason, 'Customers report fake pads');

  const card = (await get('/api/admin/shops', ADMIN)).json.shops.find((s) => s.id === target.shop_id);
  assert.ok(card.flags.includes('Suspended'));
  assert.equal((await post(`/api/admin/shops/${target.shop_id}/reactivate`, {}, ADMIN)).status, 200);
  const after = (await get(`/api/parts/listings?oe_numbers=${oe}&radius_km=any`)).json.listings;
  assert.ok(after.some((l) => l.shop_id === target.shop_id), 'back on sale');

  assert.equal((await post('/api/admin/garages/3/suspend', { reason: 'Closed for renovation' }, ADMIN)).status, 200);
  assert.ok(!(await get('/api/garages/nearby?radius_km=any')).json.garages.some((g) => g.id === 3));
  assert.equal((await post('/api/admin/garages/3/reactivate', {}, ADMIN)).status, 200);
  assert.ok((await get('/api/garages/nearby?radius_km=any')).json.garages.some((g) => g.id === 3));
});

test('the admin can edit any detail of a shop or garage, including its name and location', async () => {
  const r = await call('PUT', '/api/admin/garages/2', { name: 'Demo Garage Two Renamed', latitude: -1.95, longitude: 30.1, opening_hours: 'Mon to Sat 8 to 18' }, ADMIN);
  assert.equal(r.status, 200);
  assert.equal(r.json.garage.name, 'Demo Garage Two Renamed');
  assert.equal(r.json.garage.latitude, -1.95);
  assert.equal((await call('PUT', '/api/admin/shops/2', { phone: '123' }, ADMIN)).status, 400);
  const shop = await call('PUT', '/api/admin/shops/2', { opening_hours: 'Every day 7 to 20', vetted: true }, ADMIN);
  assert.equal(shop.json.shop.opening_hours, 'Every day 7 to 20');
  const log = (await get('/api/admin/log', ADMIN)).json.log;
  assert.ok(log.some((l) => l.action === 'Edited a garage' && /Renamed/.test(l.detail)));
});

test('a customer can report a problem once from a booking or a part, and the admin closes it', async () => {
  const listing = (await get('/api/parts/listings?oe_numbers=DEMO-TYT-XA40-FBP-01&radius_km=any')).json.listings[0];
  assert.equal((await post('/api/reports', { listing_id: listing.listing_id, reason: 'fake' })).status, 401, 'sign in first');
  const customer = makeClient();
  await customer.post('/api/auth/signup', { name: 'Report Tester', email: 'report.tester@example.com', password: 'Long-password123' });
  const id = (await customer.post('/api/bookings', { plate_number: 'RXA001A', customer_phone: '+250788123456', shop_listing_id: listing.listing_id, garage_id: 1 })).json.booking.id;

  assert.equal((await customer.post('/api/reports', { booking_id: id, target: 'shop', reason: 'made_up' })).status, 400);
  assert.equal((await customer.post('/api/reports', { booking_id: id, target: 'garage', reason: 'other' })).status, 400, '"something else" needs details');
  const made = await customer.post('/api/reports', { booking_id: id, target: 'shop', reason: 'price', details: 'Asked for more at the counter.' });
  assert.equal(made.status, 201);
  assert.equal((await customer.post('/api/reports', { booking_id: id, target: 'shop', reason: 'price' })).status, 409, 'once');
  assert.equal((await customer.post('/api/reports', { listing_id: listing.listing_id, reason: 'fake' })).status, 201, 'a part straight from the results');
  const mine = (await customer.get('/api/me/bookings')).json.bookings.find((b) => b.id === id);
  assert.deepEqual(mine.reported, { shop: true });

  const stranger = makeClient();
  await stranger.post('/api/auth/signup', { name: 'Someone Else', email: 'report.stranger@example.com', password: 'Long-password123' });
  assert.equal((await stranger.post('/api/reports', { booking_id: id, target: 'shop', reason: 'rude' })).status, 404);

  const { reports } = (await get('/api/admin/reports?status=open', ADMIN)).json;
  const report = reports.find((r) => r.id === made.json.report.id);
  assert.equal(report.user_email, 'report.tester@example.com');
  assert.equal(report.shop_id, listing.shop_id);
  const card = (await get('/api/admin/shops', ADMIN)).json.shops.find((s) => s.id === listing.shop_id);
  assert.ok(card.open_reports >= 1 && card.flags.some((f) => /open report/.test(f)));
  assert.equal((await post(`/api/admin/reports/${report.id}/close`, {}, ADMIN)).status, 400, 'say what you did');
  assert.equal((await post(`/api/admin/reports/${report.id}/close`, { admin_note: 'Called the shop, price corrected.' }, ADMIN)).status, 200);
  assert.equal((await post(`/api/admin/reports/${report.id}/close`, { admin_note: 'again' }, ADMIN)).status, 409);
});

test('a blocked account cannot sign in and its open session stops working; unblocking restores it', async () => {
  const user = makeClient();
  await user.post('/api/auth/signup', { name: 'Block Me', email: 'block.me@example.com', password: 'Long-password123' });
  assert.ok((await user.get('/api/auth/me')).json.user);
  const row = (await get('/api/admin/users?q=block.me', ADMIN)).json.users[0];
  assert.equal(row.role, 'customer');
  assert.equal((await post(`/api/admin/users/${row.id}/block`, {}, ADMIN)).status, 400, 'a reason is required');
  assert.equal((await post(`/api/admin/users/${row.id}/block`, { reason: 'Fake bookings' }, ADMIN)).status, 200);
  assert.equal((await user.get('/api/auth/me')).json.user, null, 'signed out at once');
  const again = await user.post('/api/auth/login', { email: 'block.me@example.com', password: 'Long-password123' });
  assert.equal(again.status, 403);
  assert.match(again.json.error, /Fake bookings/);
  const adminRow = (await get('/api/admin/users?role=admin', ADMIN)).json.users[0];
  assert.equal((await post(`/api/admin/users/${adminRow.id}/block`, { reason: 'x' }, ADMIN)).status, 409);
  assert.equal((await post(`/api/admin/users/${row.id}/unblock`, {}, ADMIN)).status, 200);
  assert.equal((await user.post('/api/auth/login', { email: 'block.me@example.com', password: 'Long-password123' })).status, 200);
});

test('the admin filters bookings and cancels an open one with a reason both sides see', async () => {
  const listing = (await get('/api/parts/listings?oe_numbers=DEMO-TYT-XA40-FBP-01&radius_km=any')).json.listings[0];
  const id = (await post('/api/bookings', { plate_number: 'RXA001A', customer_phone: '+250788555444', shop_listing_id: listing.listing_id, garage_id: 1 })).json.booking.id;
  const open = (await get('/api/admin/bookings?stage=open&q=788555444', ADMIN)).json.bookings;
  assert.deepEqual(open.map((b) => b.id), [id]);
  assert.equal((await post(`/api/admin/bookings/${id}/cancel`, {}, ADMIN)).status, 400);
  const done = await post(`/api/admin/bookings/${id}/cancel`, { reason: 'The customer asked us to cancel.' }, ADMIN);
  assert.equal(done.status, 200);
  assert.equal(done.json.booking.shop_status, 'cancelled');
  assert.equal(done.json.booking.garage_status, 'declined');
  assert.equal((await post(`/api/admin/bookings/${id}/cancel`, { reason: 'again' }, ADMIN)).status, 409);
  const cancelled = (await get('/api/admin/bookings?stage=cancelled&q=788555444', ADMIN)).json.bookings;
  assert.equal(cancelled[0].admin_note, 'The customer asked us to cancel.');
  const finished = (await get('/api/admin/bookings?stage=finished', ADMIN)).json.bookings;
  assert.ok(finished.every((b) => b.stage === 'finished'));
});

test('activity counts come per week, and every admin change is in the log', async () => {
  const a = (await get('/api/admin/activity?weeks=8', ADMIN)).json;
  assert.equal(a.weeks.length, 8);
  assert.ok(a.weeks.reduce((n, w) => n + w.bookings, 0) > 0, 'demo bookings are counted');
  assert.ok(a.top_parts.length && a.top_shops.length);
  const log = (await get('/api/admin/log', ADMIN)).json.log;
  for (const action of ['Suspended a shop', 'Reactivated a shop', 'Blocked an account', 'Cancelled a booking', 'Closed a report']) {
    assert.ok(log.some((l) => l.action === action), action);
  }
  assert.ok((await get('/api/admin/log?type=user', ADMIN)).json.log.every((l) => l.target_type === 'user'));
});

test('the admin downloads bookings, parts and cars as CSV files Excel can open', async () => {
  const res = await fetch(`${base}/api/admin/export/bookings.csv`, { headers: ADMIN });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /vinzuu-bookings-\d{4}-\d{2}-\d{2}\.csv/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'starts with the UTF-8 byte-order mark');
  const body = bytes.subarray(3).toString('utf8');
  assert.ok(body.startsWith('id,created_at,stage'));
  assert.ok(body.split('\r\n').length > 5);
  for (const what of ['parts', 'cars', 'shops', 'garages', 'customers', 'reviews', 'reports']) {
    assert.equal((await fetch(`${base}/api/admin/export/${what}.csv`, { headers: ADMIN })).status, 200, what);
  }
  assert.equal((await fetch(`${base}/api/admin/export/passwords.csv`, { headers: ADMIN })).status, 404);
  assert.equal((await fetch(`${base}/api/admin/export/bookings.csv`)).status, 401);
});

test('each account gets the places it can switch to, and an admin opens a shop dashboard read-only', async () => {
  const admin = makeClient();
  const signedIn = (await admin.post('/api/auth/login', { email: 'admin@vinzuu.rw', password: 'Admin-vinzuu1' })).json.user;
  assert.equal(signedIn.home, '/admin.html', 'the admin lands on the admin dashboard');
  assert.deepEqual(signedIn.portals.map((p) => p.key), ['admin', 'seller', 'customer']);
  const shop = makeClient();
  assert.deepEqual((await shop.post('/api/auth/login', { email: 'shop1@vinzuu.rw', password: 'Vinzuu-demo1' })).json.user.portals.map((p) => p.key), ['seller', 'customer']);
  const customer = makeClient();
  assert.deepEqual((await customer.post('/api/auth/login', { email: 'customer@vinzuu.rw', password: 'Vinzuu-demo1' })).json.user.portals, []);

  assert.equal((await admin.get('/api/business/me')).json.code, 'admin_pick');
  const view = (await admin.get('/api/business/me?shop_id=1')).json;
  assert.equal(view.view_as_admin, true);
  assert.equal(view.shop.id, 1);
  assert.equal(view.garage, null);

  const asShop = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-view-shop': '1', cookie: await adminCookie() }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  assert.equal((await asShop('GET', '/api/shops/1/listings')).status, 200, 'the admin can look');
  const write = await asShop('PUT', '/api/shop/profile', { phone: '+250788000000' });
  assert.equal(write.status, 403, 'but not change anything');
  assert.equal(write.json.code, 'view_only');
  assert.equal((await call('GET', '/api/shops/1/listings', null, { 'x-view-shop': '1' })).status, 401, 'the header alone opens nothing');
  const nosy = await fetch(`${base}/api/shops/1/listings`, { headers: { 'x-view-shop': '1', cookie: await cookieFor('shop2@vinzuu.rw', 'Vinzuu-demo1') } });
  assert.equal(nosy.status, 403, 'another shop cannot use it to look at shop 1');
});

async function cookieFor(email, password) {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return res.headers.getSetCookie()[0].split(';')[0];
}
const adminCookie = () => cookieFor('admin@vinzuu.rw', 'Admin-vinzuu1');

// ---------- full part list and part numbers ----------

test('the part list is grouped like a parts catalogue and keeps every older part name', async () => {
  const { json } = await get('/api/catalog');
  const names = json.categories.map((c) => c.name);
  for (const old of ['Front Brake Pad', 'Rear Brake Pad', 'Oil Filter', 'Air Filter', 'Front Bumper', 'Headlight Assembly', 'Battery', 'Wiper Blade', 'Engine Oil']) {
    assert.ok(names.includes(old), old);
  }
  assert.ok(json.categories.length > 100);
  assert.equal(new Set(names).size, names.length, 'no duplicate names');
  assert.ok(json.categories.every((c) => c.group), 'every part has a group');
  assert.equal(json.categories[0].group, 'Service parts');
  assert.equal(json.categories.find((c) => c.name === 'Tyre').type, 'universal');
  assert.equal(json.categories.find((c) => c.name === 'Cabin Air Filter').type, 'model_specific');
});

test('part numbers for a form are narrowed to the chosen car', async () => {
  const all = await get('/api/admin/oe-numbers?part_category=Oil%20Filter', ADMIN);
  const rav4 = await get('/api/admin/oe-numbers?part_category=Oil%20Filter&make=Toyota&model=RAV4&generation=XA40', ADMIN);
  assert.equal(rav4.status, 200);
  assert.ok(rav4.json.rows.length > 0);
  assert.ok(rav4.json.rows.every((r) => r.make === 'Toyota' && r.model === 'RAV4' && (r.generation === 'XA40' || r.generation === null)));
  assert.ok(all.json.rows.length > rav4.json.rows.length);
});

test('part numbers import from a CSV: good rows added, repeats skipped, bad rows reported by line', async () => {
  const csv = [
    'oe_number;part;make;model;generation;year_from;year_to;engine;built_in;confidence;source',
    'CSV-TEST-1;Cabin Air Filter;Hyundai;Tucson;TL;2015;2020;;;medium;"Hyundai catalogue; page 4"',
    'CSV-TEST-2;Not a part;Hyundai;Tucson;TL;2015;2020;;;LOW;test',
    'CSV-TEST-3;Spark Plug;Hyundai;Tucson;TL;2020;2015;;;LOW;test',
    'CSV-TEST-4;Tyre;Hyundai;Tucson;TL;2015;2020;;;LOW;test',
  ].join('\r\n');
  const dry = await post('/api/admin/fitment-reference/import', { csv, dry_run: true }, ADMIN);
  assert.equal(dry.status, 200);
  assert.equal(dry.json.added, 1);
  assert.deepEqual(dry.json.errors.map((e) => e.line), [3, 4, 5]);
  assert.equal((await get('/api/admin/fitment-reference?q=CSV-TEST-1', ADMIN)).json.rows.length, 0, 'a check saves nothing');

  const first = await post('/api/admin/fitment-reference/import', { csv }, ADMIN);
  assert.equal(first.json.added, 1);
  const again = await post('/api/admin/fitment-reference/import', { csv }, ADMIN);
  assert.equal(again.json.added, 0);
  assert.equal(again.json.skipped, 1);
  const [row] = (await get('/api/admin/fitment-reference?q=CSV-TEST-1', ADMIN)).json.rows;
  assert.equal(row.confidence_level, 'MEDIUM');
  assert.equal(row.source, 'Hyundai catalogue; page 4');
  assert.equal(row.engine, null);
  assert.equal((await post('/api/admin/fitment-reference/import', { csv: '' }, ADMIN)).status, 400);
});

test('real part numbers in lib/oe load once into a clean database, alongside the demo data', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { ensureRealPartNumbers } = require('../db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-oe-'));
  fs.writeFileSync(path.join(dir, 'toyota.csv'), 'oe_number,part,make,model,generation,year_from,year_to,engine,built_in,confidence,source\n'
    + 'REAL-1,Oil Filter,Toyota,RAV4,XA40,2013,2018,2.0L Petrol,,MEDIUM,https://example.com/a\n'
    + 'REAL-2,Battery,Toyota,RAV4,XA40,2013,2018,,,MEDIUM,https://example.com/b\n'
    + 'REAL-3,Spark Plug,Toyota,RAV4,XA40,2013,2018,,,HIGH,https://example.com/c\n');
  const db = await openDb(testDbTarget());
  assert.equal(await ensureRealPartNumbers(db, dir), 2, 'the universal Battery row is skipped');
  assert.equal((await db.prepare("SELECT confidence_level FROM fitment_reference WHERE oe_number = 'REAL-3'").get()).confidence_level, 'LOW',
    'HIGH without a "verified by" is lowered');
  assert.equal(await ensureRealPartNumbers(db, dir), 0, 'an unchanged file is not loaded again');
  assert.ok(await seedDemo(db), 'demo data still seeds next to real part numbers');
  await db.close();
});

test('online, a database setup that failed is tried again on the next request', async () => {
  const db = await openDb(testDbTarget());
  let attempts = 0;
  let setup = null;
  const ready = () => {
    if (!setup) {
      setup = (async () => { attempts += 1; if (attempts === 1) throw new Error('database is locked'); })()
        .catch((err) => { setup = null; throw err; });
    }
    return setup;
  };
  const app = createApp(db, { ready });
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const url = `http://127.0.0.1:${srv.address().port}/api/meta`;
  const errLog = console.error; console.error = () => {};
  try {
    assert.equal((await fetch(url)).status, 500, 'the first setup fails');
    assert.equal((await fetch(url)).status, 200, 'the next request sets up again and works');
    assert.equal(attempts, 2);
  } finally { console.error = errLog; srv.close(); }
});

test('start-up removes part numbers loaded twice for the same car, keeping the first', async () => {
  const db = await openDb(testDbTarget());
  const one = await db.prepare('SELECT * FROM fitment_reference ORDER BY id LIMIT 1').get();
  const before = (await db.prepare('SELECT COUNT(*) AS n FROM fitment_reference').get()).n;
  await db.prepare(`INSERT INTO fitment_reference (oe_number, part_category, make, model, generation, year_start, year_end,
    engine, origin_market, confidence_level, source) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(one.oe_number, one.part_category, one.make,
    one.model, one.generation, one.year_start, one.year_end, one.engine, one.origin_market, one.confidence_level, one.source);
  await prepareDb(db);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM fitment_reference').get()).n, before);
  assert.ok(await db.prepare('SELECT 1 FROM fitment_reference WHERE id = ?').get(one.id), 'the first row stays');
});

test('a garage the admin adds needs a photo, which customers then see', async () => {
  const photo = 'data:image/jpeg;base64,/9j/4AAQ';
  const garage = { name: 'Kigali Auto Win Garage', phone: '+250 788 333 444', latitude: -1.95, longitude: 30.06,
    address_text: 'Kicukiro', specialties: 'Brakes, suspension' };
  const missing = await post('/api/admin/garages', garage, ADMIN);
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /photo of the garage/);
  assert.equal((await post('/api/admin/garages', { ...garage, photo_url: 'javascript:alert(1)' }, ADMIN)).status, 400);

  const added = await post('/api/admin/garages', { ...garage, photo_url: photo }, ADMIN);
  assert.equal(added.status, 201);
  const near = (await get('/api/garages/nearby?radius_km=any')).json.garages.find((g) => g.id === added.json.garage.id);
  assert.match(near.photo, new RegExp(`^/api/garages/${added.json.garage.id}/photo\\?v=`));
  assert.ok(!('photo_url' in near), 'the list links to the photo instead of carrying it');
  const img = await fetch(base + near.photo);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await img.arrayBuffer())], [...Buffer.from('/9j/4AAQ', 'base64')]);

  // The admin can change the photo later; a garage without one shows a stock photo instead.
  const changed = await call('PUT', `/api/admin/garages/${added.json.garage.id}`, { photo_url: 'data:image/png;base64,iVBO' }, ADMIN);
  assert.equal(changed.json.garage.photo_url, 'data:image/png;base64,iVBO');
  assert.equal((await call('PUT', `/api/admin/garages/${added.json.garage.id}`, { photo_url: '' }, ADMIN)).status, 400, 'the photo cannot be removed');
  assert.equal((await get('/api/garages/1/photo')).status, 404);
});
