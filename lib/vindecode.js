'use strict';
/**
 * Finds the exact car (model, generation, engine) behind a VIN, the way PartZone and other parts
 * catalogues do, using two sources:
 *
 *   1. Cars already saved here. Characters 1-8 of a VIN (maker, then model line, body and engine)
 *      are the same for every car of that build, so a VIN that shares them, and the year
 *      character, with a car a customer has already confirmed is very likely the same build.
 *   2. The US government's free VIN decoder (NHTSA vPIC). It knows every car built for the North
 *      American market, which is a large share of the Hyundais, Kias and Toyotas imported here.
 *      It knows nothing about Korean or Japanese home-market cars.
 *
 * Either way the customer is shown the result and asked "Is this your car?" before it is used.
 * When neither source knows the VIN, the customer picks the details from the lineup instead.
 */

const VPIC_URL = 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/';

/** The default online lookup: the raw vPIC values for a VIN, or null. Never throws. */
async function vpicLookup(vin, { timeoutMs = 4000 } = {}) {
  try {
    const res = await fetch(`${VPIC_URL}${encodeURIComponent(vin)}?format=json`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data && data.Results && data.Results[0]) || null;
  } catch (err) {
    return null; // offline, slow or blocked: the customer can still pick the details
  }
}

const sameText = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Our lineup's model for a name the decoder gave ("Santa Fe Sport" -> Santa Fe, "RAV-4" -> RAV4). */
function findModel(make, name) {
  if (!make || !name) return null;
  const wanted = squash(name);
  const names = (m) => [m.model, ...(m.aka || [])].map(squash);
  return make.models.find((m) => names(m).includes(wanted))
    // The longest model name the decoder's name starts with, so "Elantra GT" finds Elantra and
    // "Santa Fe Sport" finds Santa Fe rather than nothing.
    || make.models.filter((m) => names(m).some((n) => n && wanted.startsWith(n)))
      .sort((a, b) => b.model.length - a.model.length)[0]
    || null;
}

const generationFor = (model, year) => {
  const gens = model ? model.generations.filter((g) => year >= g.year_start && year <= g.year_end) : [];
  return gens.length === 1 ? gens[0] : null;
};

/** vPIC fuel and engine fields as our engine label: "2.4L Petrol", "2.0L Turbo Petrol", "1.6L Hybrid". */
function engineLabel(v) {
  const litres = Number(v.DisplacementL);
  if (!litres) return null;
  const fuel = `${v.FuelTypePrimary || ''} ${v.FuelTypeSecondary || ''} ${v.ElectrificationLevel || ''}`.toLowerCase();
  let kind = 'Petrol';
  if (/plug-?in|phev/.test(fuel)) kind = 'Plug-in Hybrid';
  else if (/hybrid|hev/.test(fuel) || (/electric/.test(fuel) && /gasoline/.test(fuel))) kind = 'Hybrid';
  else if (/diesel/.test(fuel)) kind = 'Diesel';
  else if (/lpg|propane/.test(fuel)) kind = 'LPG';
  // Our lineup only marks petrol engines as turbo; every diesel here is turbocharged anyway.
  const turbo = /yes/i.test(v.Turbo || '') && kind === 'Petrol';
  return `${litres.toFixed(1)}L ${turbo ? 'Turbo ' : ''}${kind}`;
}

/** The engine label from the generation's own list that matches vPIC's engine, or vPIC's label. */
function pickEngine(gen, v) {
  const label = engineLabel(v);
  const code = String(v.EngineModel || '').toUpperCase();
  const engines = gen ? gen.engines : [];
  return (code && engines.find((e) => e.codes.some((c) => code.includes(c.toUpperCase()))))?.label
    || engines.find((e) => sameText(e.label, label))?.label
    || label;
}

const PLANT_COUNTRIES = {
  'UNITED STATES (USA)': 'USA', 'CANADA': 'Canada', 'MEXICO': 'Mexico', 'JAPAN': 'Japan',
  'SOUTH KOREA': 'Korea', 'KOREA (SOUTH)': 'Korea', 'REPUBLIC OF KOREA': 'Korea',
  'CZECH REPUBLIC': null, 'SLOVAKIA': 'Slovakia', 'TURKEY': 'Turkey', 'CHINA': 'China', 'INDIA': 'India',
  'UNITED KINGDOM (UK)': 'UK', 'FRANCE': 'France', 'THAILAND': 'Thailand',
};

/** vPIC's values as a car in our terms, or null when vPIC did not recognise the VIN. */
function fromVpic(v, lineupMakes) {
  if (!v || !v.Make || !v.Model) return null;
  const make = lineupMakes.find((m) => sameText(m.make, v.Make));
  const year = Number(v.ModelYear) || null;
  const model = findModel(make, v.Model);
  const gen = model && year ? generationFor(model, year) : null;
  const plant = String(v.PlantCountry || '').toUpperCase();
  const trans = String(v.TransmissionStyle || '').toLowerCase();
  return {
    source: 'vpic',
    make: make ? make.make : titleCase(v.Make),
    model: model ? model.model : v.Model,
    year,
    generation: gen ? gen.generation : null,
    engine: pickEngine(gen, v),
    engine_code: v.EngineModel || null,
    cylinders: Number(v.EngineCylinders) || null,
    fuel: v.FuelTypePrimary || null,
    transmission: /manual/.test(trans) ? 'Manual' : /auto|cvt|dual/.test(trans) ? 'Automatic' : null,
    origin_market: plant in PLANT_COUNTRIES ? PLANT_COUNTRIES[plant] : null,
    trim: v.Trim || v.Series || null,
    body: v.BodyClass || null,
    in_lineup: !!model,
  };
}

const titleCase = (s) => String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * The build most customers saved for VINs sharing characters 1-8 (and the year character when
 * possible). Only a clear winner counts: two different models for the same pattern means the
 * pattern is not telling us enough, so nothing is suggested.
 */
async function fromSavedCars(db, vin) {
  const pick = async (sql, ...args) => {
    const rows = await db.prepare(sql).all(...args);
    if (!rows.length || (rows[1] && rows[1].n === rows[0].n)) return null;
    return rows[0];
  };
  const base = `SELECT make, model, generation, engine, transmission, origin_market, year, COUNT(*) AS n
    FROM vehicles WHERE vin IS NOT NULL AND vin <> ? AND substr(vin, 1, 8) = ?`;
  const row = (await pick(`${base} AND substr(vin, 10, 1) = ? GROUP BY make, model, generation, engine ORDER BY n DESC LIMIT 2`,
    vin, vin.slice(0, 8), vin[9]))
    || (await pick(`${base} GROUP BY make, model, engine ORDER BY n DESC LIMIT 2`, vin, vin.slice(0, 8)));
  if (!row) return null;
  return {
    source: 'saved', make: row.make, model: row.model, generation: row.generation, engine: row.engine,
    transmission: row.transmission, origin_market: row.origin_market, matches: row.n,
  };
}

/**
 * The exact car for a VIN, or null. `lookup` is the online decoder (injectable for tests, null to
 * stay offline); `cache` remembers its answers so each VIN is only looked up once.
 */
async function findCar(db, vin, { lineupMakes, year, lookup, cache = true }) {
  const saved = await fromSavedCars(db, vin);
  if (saved) {
    // The year comes from this VIN; the generation is re-checked against it.
    const make = lineupMakes.find((m) => sameText(m.make, saved.make));
    const model = findModel(make, saved.model);
    const gen = model && year ? generationFor(model, year) : null;
    return { ...saved, year, generation: gen ? gen.generation : saved.generation };
  }
  if (!lookup) return null;
  let values = null;
  const hit = cache && (await db.prepare('SELECT data FROM vin_lookups WHERE vin = ?').get(vin));
  if (hit) values = JSON.parse(hit.data);
  else {
    values = await lookup(vin);
    // Only remember real answers, so a VIN looked up while offline is tried again next time.
    if (values && cache) {
      await db.prepare('INSERT OR REPLACE INTO vin_lookups (vin, source, data) VALUES (?, ?, ?)').run(vin, 'vpic', JSON.stringify(values));
    }
  }
  return fromVpic(values, lineupMakes);
}

module.exports = { findCar, fromVpic, fromSavedCars, engineLabel, findModel, vpicLookup };
