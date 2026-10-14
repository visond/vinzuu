'use strict';
const { haversineKm, badgeFor, CONFIDENCE_RANK, KIGALI_CENTER } = require('./algorithms');

/** NULL in the reference table is a wildcard ("applies to any"); otherwise values must match. */
function matches(rowValue, vehicleValue) {
  if (rowValue == null || rowValue === '') return true;
  if (vehicleValue == null || vehicleValue === '') return false;
  return String(rowValue).toLowerCase() === String(vehicleValue).toLowerCase();
}

/** Keep one entry per OE number (the most confident one), best first. */
function dedupeByOe(items) {
  const best = new Map();
  for (const it of items) {
    const prev = best.get(it.oe_number);
    if (!prev || CONFIDENCE_RANK[it.confidence] > CONFIDENCE_RANK[prev.confidence]) best.set(it.oe_number, it);
  }
  return [...best.values()].sort(
    (a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] || a.oe_number.localeCompare(b.oe_number)
  );
}

/**
 * A generation left as "Not sure" is not a dead end when the car's year settles it: if exactly one
 * generation of this make and model covers that year, that is the car's generation. With two or
 * more candidates nothing is guessed. The engine is never filled in this way: an unknown engine
 * already falls through to the relaxed (LOW confidence) match below, which is the honest answer.
 */
function fillUnknownSpec(db, vehicle) {
  if (!vehicle || vehicle.generation) return vehicle;
  const gens = db.prepare(`
    SELECT DISTINCT generation FROM fitment_reference
    WHERE lower(make) = lower(?) AND lower(model) = lower(?) AND ? BETWEEN year_start AND year_end
      AND generation IS NOT NULL AND generation <> ''`).all(vehicle.make, vehicle.model, vehicle.year);
  return gens.length === 1 ? { ...vehicle, generation: gens[0].generation } : vehicle;
}

/**
 * Algorithm B: which OE part number(s) fit this vehicle for this part category?
 *
 * 1. Exact: make, model, year range, generation, engine and origin market all agree.
 * 2. Relaxed: same, but the ENGINE is ignored. These are returned as LOW confidence.
 *    Generation and origin market are never relaxed: wrong-generation or wrong-market
 *    parts are exactly the mistake this product exists to prevent.
 * 3. None: nothing safe to show. The caller logs the gap for the admin to research.
 *
 * A generation the owner left as "Not sure" is filled in first when the year leaves only one
 * possibility (see fillUnknownSpec), so that answer alone never dead-ends a search.
 */
function findCompatible(db, rawVehicle, category) {
  const vehicle = fillUnknownSpec(db, rawVehicle);
  const rows = db.prepare(`
    SELECT * FROM fitment_reference
    WHERE part_category = ? AND lower(make) = lower(?) AND lower(model) = lower(?)
      AND ? BETWEEN year_start AND year_end`).all(category, vehicle.make, vehicle.model, vehicle.year);

  const toResult = (r, confidence) => ({
    oe_number: r.oe_number, confidence, source: r.source,
    generation: r.generation, engine: r.engine, origin_market: r.origin_market,
    year_start: r.year_start, year_end: r.year_end,
  });

  const exact = rows.filter((r) =>
    matches(r.generation, vehicle.generation) && matches(r.engine, vehicle.engine) &&
    matches(r.origin_market, vehicle.origin_market));
  if (exact.length) {
    return { match_type: 'exact', results: dedupeByOe(exact.map((r) => toResult(r, r.confidence_level))) };
  }

  const relaxed = rows.filter((r) =>
    matches(r.generation, vehicle.generation) && matches(r.origin_market, vehicle.origin_market));
  if (relaxed.length) {
    return { match_type: 'relaxed', results: dedupeByOe(relaxed.map((r) => toResult(r, 'LOW'))) };
  }

  let reason = 'not_in_database';
  if (rows.length) {
    if (!vehicle.generation && rows.some((r) => r.generation)) reason = 'generation_unknown';
    else if (!vehicle.origin_market && rows.some((r) => r.origin_market)) reason = 'origin_unknown';
    else reason = 'no_match_for_spec';
  }
  return { match_type: 'none', results: [], reason };
}

/** Remember what customers asked for that we could not answer (admin "gaps" report). */
function logGap(db, vehicle, category) {
  db.prepare(`
    INSERT INTO search_gaps (make, model, year, engine, origin_market, part_category)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (make, model, year, engine, origin_market, part_category)
    DO UPDATE SET times_searched = times_searched + 1, last_seen = datetime('now')`)
    .run(vehicle.make, vehicle.model, vehicle.year, vehicle.engine || '', vehicle.origin_market || '', category);
}

/**
 * Algorithm C: which shops have these part numbers in stock, how far are they, what do they charge?
 *
 * opts.oeNumbers   model-specific parts: list of OE numbers (from Algorithm B)
 * opts.category    universal parts (wipers, oil, battery): match on category, no OE number
 * opts.vehicle     optional. When given, each listing's confidence is recomputed for THIS car,
 *                  so a "relaxed" match stays LOW on the results screen too.
 * opts.origin      { lat, lon } of the customer (defaults to central Kigali)
 * opts.radiusKm    number, or null for "any distance"
 * opts.sortBy      'price' | 'distance'
 */
function resolveListings(db, opts) {
  const { oeNumbers = [], category = null, vehicle = null, radiusKm = 15, sortBy = 'price' } = opts;
  const origin = opts.origin || KIGALI_CENTER;

  const selectFrom = `
    SELECT l.id AS listing_id, l.shop_id, l.oe_number, l.part_category, l.universal_spec, l.price_rwf,
           l.stock_quantity, l.condition, l.photo_url, l.updated_at, l.brand, l.description, l.warranty_months,
           (SELECT ROUND(AVG(rating), 1) FROM reviews r WHERE r.shop_id = s.id) AS shop_rating,
           (SELECT COUNT(*) FROM reviews r WHERE r.shop_id = s.id) AS shop_reviews,
           s.name AS shop_name, s.phone AS shop_phone, s.whatsapp_number AS shop_whatsapp,
           s.latitude, s.longitude, s.address_text AS shop_address, s.vetted
    FROM shop_listings l JOIN shops s ON s.id = l.shop_id
    WHERE l.stock_quantity > 0 AND l.hidden = 0 AND l.photo_url IS NOT NULL AND l.photo_url <> ''`;

  let rows;
  if (oeNumbers.length) {
    const marks = oeNumbers.map(() => '?').join(',');
    rows = db.prepare(`${selectFrom} AND l.oe_number IN (${marks})`).all(...oeNumbers);
  } else if (category) {
    rows = db.prepare(`${selectFrom} AND l.part_category = ? AND l.oe_number IS NULL`).all(category);
  } else {
    return [];
  }

  // Confidence per OE number, for the badge.
  const confidenceFor = new Map();
  const cats = [...new Set(rows.map((r) => r.part_category))];
  if (vehicle) {
    for (const c of cats) {
      for (const r of findCompatible(db, vehicle, c).results) confidenceFor.set(r.oe_number, r.confidence);
    }
  } else {
    const q = db.prepare('SELECT confidence_level AS c FROM fitment_reference WHERE oe_number = ?');
    for (const oe of new Set(rows.map((r) => r.oe_number).filter(Boolean))) {
      const best = q.all(oe).map((x) => x.c).sort((a, b) => CONFIDENCE_RANK[b] - CONFIDENCE_RANK[a])[0];
      if (best) confidenceFor.set(oe, best);
    }
  }

  const out = [];
  for (const r of rows) {
    const km = haversineKm(origin, { lat: r.latitude, lon: r.longitude });
    if (radiusKm != null && km > radiusKm) continue;
    const universal = !r.oe_number;
    const confidence = universal ? null : (confidenceFor.get(r.oe_number) || 'LOW');
    out.push({
      listing_id: r.listing_id,
      shop_id: r.shop_id,
      shop_name: r.shop_name,
      shop_address: r.shop_address,
      shop_phone: r.shop_phone,
      shop_whatsapp: r.shop_whatsapp,
      part_category: r.part_category,
      oe_number: r.oe_number,
      universal_spec: r.universal_spec,
      price_rwf: r.price_rwf,
      in_stock: r.stock_quantity,
      condition: r.condition,
      photo_url: r.photo_url,
      brand: r.brand,
      description: r.description,
      warranty_months: r.warranty_months,
      shop_rating: r.shop_reviews ? { average: r.shop_rating, count: r.shop_reviews } : null,
      vetted: !!r.vetted,
      confidence,
      badge: badgeFor({ confidence, condition: r.condition, vetted: !!r.vetted, universal }),
      distance_km: Math.round(km * 10) / 10,
      _km: km,
    });
  }

  out.sort(sortBy === 'distance'
    ? (a, b) => a._km - b._km || a.price_rwf - b.price_rwf
    : (a, b) => a.price_rwf - b.price_rwf || a._km - b._km);
  for (const o of out) delete o._km;
  return out;
}

/** Makes -> models -> generations/engines, built from what the reference table actually covers. */
function buildCatalog(db) {
  const gens = db.prepare(`
    SELECT make, model, COALESCE(generation, '') AS generation,
           MIN(year_start) AS year_start, MAX(year_end) AS year_end
    FROM fitment_reference GROUP BY make, model, COALESCE(generation, '')
    ORDER BY make, model, year_start`).all();
  const engines = db.prepare(`
    SELECT DISTINCT make, model, engine FROM fitment_reference
    WHERE engine IS NOT NULL ORDER BY make, model, engine`).all();

  const makes = new Map();
  for (const g of gens) {
    if (!makes.has(g.make)) makes.set(g.make, new Map());
    const models = makes.get(g.make);
    if (!models.has(g.model)) models.set(g.model, { model: g.model, generations: [], engines: [] });
    if (g.generation) {
      models.get(g.model).generations.push({
        generation: g.generation, year_start: g.year_start, year_end: g.year_end,
      });
    }
  }
  for (const e of engines) makes.get(e.make)?.get(e.model)?.engines.push(e.engine);

  return [...makes.entries()].map(([make, models]) => ({ make, models: [...models.values()] }));
}

module.exports = { findCompatible, fillUnknownSpec, logGap, resolveListings, buildCatalog, matches };
