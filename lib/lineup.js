'use strict';
/**
 * Every Hyundai, Kia and Toyota model on sale in model years 2000 to 2026, with each generation's
 * years and engines, read from lib/models/<make>.txt (see the header of those files for the format
 * and the sources). Models without part numbers yet can still be registered, and a part search for
 * one is logged as a gap for the admin to research. That is how the fitment table grows.
 */
const fs = require('node:fs');
const path = require('node:path');

const MAKES = { Hyundai: 'hyundai', Kia: 'kia', Toyota: 'toyota' };

/** Logos shown instead of the make's name on the customer page. */
const LOGOS = {
  Hyundai: '/img/makes/hyundai.svg',
  Kia: '/img/makes/kia.svg',
  Toyota: '/img/makes/toyota.svg',
};

/** "1.6L Turbo Petrol (G4FJ)" -> { label: '1.6L Turbo Petrol', code: 'G4FJ' } */
function parseEngine(text) {
  const m = text.trim().match(/^(.*?)\s*(?:\(([^)]+)\))?$/);
  return { label: m[1].trim(), code: m[2] ? m[2].trim() : null };
}

/** Engines grouped by label, so two 1.6L Petrol engines are one choice listing both codes. */
function groupEngines(list) {
  const byLabel = new Map();
  for (const e of list) {
    if (!byLabel.has(e.label)) byLabel.set(e.label, { label: e.label, codes: [] });
    if (e.code && !byLabel.get(e.label).codes.includes(e.code)) byLabel.get(e.label).codes.push(e.code);
  }
  return [...byLabel.values()];
}

/**
 * Parses one make's file. `latest` stands in for "now" so a running generation still matches
 * this year's and next year's cars; `ongoing` says it is still made.
 */
function parseMakeFile(text, latest = new Date().getFullYear() + 1) {
  const models = [];
  let current = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) return;
    const fail = (why) => { throw new Error(`line ${i + 1}: ${why}: ${line.trim()}`); };
    const cells = line.split('|').map((c) => c.trim());
    if (!/^\s/.test(line)) {
      if (cells.length !== 3 || !cells[0]) fail('a model line needs "Model | other names | body"');
      current = {
        model: cells[0],
        aka: cells[1] ? cells[1].split(',').map((s) => s.trim()).filter(Boolean) : [],
        body: cells[2],
        generations: [],
      };
      models.push(current);
      return;
    }
    if (!current) fail('a generation line comes before any model');
    if (cells.length !== 3) fail('a generation line needs "CODE | years | engines"');
    const years = cells[1].match(/^(\d{4})-(\d{4}|now)$/);
    if (!years) fail('years must look like 2015-2020 or 2021-now');
    const ongoing = years[2] === 'now';
    const yearStart = Number(years[1]);
    const yearEnd = ongoing ? latest : Number(years[2]);
    if (yearEnd < yearStart) fail('the last year is before the first');
    current.generations.push({
      generation: cells[0],
      year_start: yearStart,
      year_end: yearEnd,
      ongoing,
      engines: groupEngines(cells[2].split(';').filter((s) => s.trim()).map(parseEngine)),
    });
  });
  for (const m of models) {
    if (!m.generations.length) throw new Error(`${m.model} has no generations`);
    m.engines = groupEngines(m.generations.flatMap((g) => g.engines.flatMap((e) =>
      (e.codes.length ? e.codes : [null]).map((code) => ({ label: e.label, code })))));
  }
  return models;
}

let cache = null;
/** { Hyundai: [models], Kia: [...], Toyota: [...] }, read once. */
function loadLineup() {
  if (cache) return cache;
  cache = {};
  for (const [make, file] of Object.entries(MAKES)) {
    const text = fs.readFileSync(path.join(__dirname, 'models', `${file}.txt`), 'utf8');
    try {
      cache[make] = parseMakeFile(text);
    } catch (err) {
      throw new Error(`lib/models/${file}.txt ${err.message}`);
    }
  }
  return cache;
}

const sameText = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * Adds the full lineup and the logo to the catalog built from the fitment table. A model in both
 * gets the lineup's generations and engines plus any generation or engine only the fitment table
 * knows (so a part number added by an admin is never hidden). A make or model only the fitment
 * table knows is kept as it is.
 *
 * Every engine comes out as { label, codes }: the label is what is stored and matched on, the
 * codes are shown alongside it to help the owner pick.
 */
function withLineup(catalogMakes) {
  const lineup = loadLineup();
  const out = [];
  const makeNames = [...new Set([...Object.keys(lineup), ...catalogMakes.map((m) => m.make)])];
  for (const makeName of makeNames) {
    const lineupKey = Object.keys(lineup).find((k) => sameText(k, makeName));
    const fromFitment = catalogMakes.find((m) => sameText(m.make, makeName));
    const make = lineupKey || fromFitment.make;
    const models = (lineup[lineupKey] || []).map((m) => ({
      ...m, generations: m.generations.map((g) => ({ ...g })), engines: m.engines.slice(),
    }));
    for (const fm of (fromFitment ? fromFitment.models : [])) {
      let model = models.find((m) => sameText(m.model, fm.model));
      if (!model) {
        model = { model: fm.model, aka: [], body: '', generations: [], engines: [] };
        models.push(model);
      }
      for (const g of fm.generations) {
        if (!model.generations.some((x) => sameText(x.generation, g.generation))) {
          model.generations.push({ ...g, ongoing: false, engines: [] });
        }
      }
      for (const label of fm.engines) {
        if (!model.engines.some((e) => sameText(e.label, label))) model.engines.push({ label, codes: [] });
      }
    }
    models.sort((a, b) => a.model.localeCompare(b.model, 'en', { sensitivity: 'base' }));
    for (const m of models) m.generations.sort((a, b) => a.year_start - b.year_start);
    out.push({ make, logo: LOGOS[lineupKey] || null, models });
  }
  return out.sort((a, b) => a.make.localeCompare(b.make));
}

module.exports = { LOGOS, loadLineup, parseMakeFile, withLineup };
