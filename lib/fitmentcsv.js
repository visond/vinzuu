'use strict';
/**
 * Part numbers as CSV: the admin's "Import from a spreadsheet" button and the real part numbers
 * shipped in lib/oe/*.csv use the same columns, so a catalogue export or a shared spreadsheet can
 * be loaded in one go.
 *
 *   oe_number, part, make, model, generation, year_from, year_to, engine, built_in, confidence, source, verified_by
 *
 * generation, engine, built_in and verified_by may be blank (blank means "fits every one").
 * A header row is required; columns may come in any order and extra columns are ignored.
 */

/** RFC 4180 CSV: quoted fields, doubled quotes, separators and newlines inside quotes. The
 *  separator is whichever of , ; or tab the first line uses most (Excel saves ; in some regions). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text).replace(/^\uFEFF/, '');
  const first = s.split(/\r?\n/, 1)[0];
  const count = (c) => first.split(c).length;
  const sep = [',', ';', '\t'].reduce((a, b) => (count(b) > count(a) ? b : a));
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

// Header names people are likely to use for each column.
const ALIASES = {
  oe_number: ['oe_number', 'oe', 'part_number', 'part number', 'oe number', 'number'],
  part_category: ['part', 'part_category', 'category', 'part type'],
  make: ['make', 'brand'],
  model: ['model'],
  generation: ['generation', 'gen', 'chassis', 'chassis code'],
  year_start: ['year_from', 'year_start', 'from', 'year from'],
  year_end: ['year_to', 'year_end', 'to', 'year to'],
  engine: ['engine'],
  origin_market: ['built_in', 'origin_market', 'origin', 'built in'],
  confidence_level: ['confidence', 'confidence_level'],
  source: ['source', 'url'],
  verified_by: ['verified_by', 'verified by'],
};

/** CSV text -> [{ line, body }] with body in the shape the fitment API takes. */
function csvToFitment(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const norm = header.map((x) => x.trim().toLowerCase());
  const col = {};
  for (const [key, names] of Object.entries(ALIASES)) col[key] = norm.findIndex((x) => names.includes(x));
  return rows.map((r, i) => {
    const body = {};
    for (const [key, idx] of Object.entries(col)) {
      const v = idx >= 0 ? String(r[idx] ?? '').trim() : '';
      body[key] = v === '' ? null : v;
    }
    if (body.confidence_level) body.confidence_level = body.confidence_level.toUpperCase();
    return { line: i + 2, body };
  });
}

const COLUMNS = ['oe_number', 'part', 'make', 'model', 'generation', 'year_from', 'year_to', 'engine', 'built_in', 'confidence', 'source', 'verified_by'];

module.exports = { parseCsv, csvToFitment, COLUMNS };
