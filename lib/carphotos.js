/**
 * Real photos of each model and generation, from Wikipedia and Wikimedia Commons.
 *
 * Each car article on English Wikipedia has an infobox per generation, and each infobox names a
 * photo of that generation that is stored on Commons under a free licence. This module reads the
 * article, picks the infobox for the car's generation (by its code, else by its years), and asks
 * Commons for a resized copy and who took it, because the licences require the photographer and
 * licence to be shown next to the photo. Non-free images are never used.
 *
 * Answers are cached in the car_photos table, so each model and generation is looked up once.
 * When Wikipedia can't be reached the page simply keeps showing the drawn outline instead.
 *
 * The same file runs in the browser (served as /carphotos.js), so a server whose own internet
 * access is blocked can still show photos: the customer's browser does the lookup then.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.carphotos = factory();
}(typeof self !== 'undefined' ? self : this, () => {
'use strict';

const UA = 'Vinzuu/1.0 (car parts finder for Kigali; https://github.com/visond/vinzuu)';
const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';

/** The default fetcher: JSON from a Wikimedia API, or null. Never throws. */
const inBrowser = typeof window !== 'undefined';
async function wikiJson(url, { timeoutMs = 6000 } = {}) {
  try {
    // Browsers may not set User-Agent; Wikimedia asks them to send Api-User-Agent instead.
    const headers = inBrowser ? { 'Api-User-Agent': UA } : { 'User-Agent': UA, 'Api-User-Agent': UA };
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

/** Every {{Infobox automobile ...}} in the wikitext, as { fields }, in page order. */
function infoboxes(wikitext) {
  const out = [];
  const re = /\{\{\s*Infobox automobile/gi;
  let m;
  while ((m = re.exec(wikitext))) {
    // Walk to the matching closing braces, since infoboxes contain nested templates.
    let depth = 0;
    let i = m.index;
    for (; i < wikitext.length - 1; i++) {
      if (wikitext[i] === '{' && wikitext[i + 1] === '{') { depth++; i++; } else if (wikitext[i] === '}' && wikitext[i + 1] === '}') {
        depth--; i++;
        if (depth === 0) break;
      }
    }
    out.push({ fields: fieldsOf(wikitext.slice(m.index + 2, i - 1)) });
    re.lastIndex = i;
  }
  return out;
}

/** "| image = X.jpg" lines of one template, ignoring pipes inside nested templates and links. */
function fieldsOf(body) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === '{{' || two === '[[') { depth++; cur += two; i++; continue; }
    if (two === '}}' || two === ']]') { depth--; cur += two; i++; continue; }
    if (body[i] === '|' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += body[i];
  }
  parts.push(cur);
  const fields = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0) fields[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim();
  }
  return fields;
}

/** "[[File:2019 Tucson.jpg|250px]]" or "2019 Tucson.jpg" -> "2019 Tucson.jpg" */
function imageName(value) {
  if (!value) return null;
  const v = String(value).replace(/<!--[\s\S]*?-->/g, '').trim();
  const link = v.match(/\[\[\s*(?:File|Image)\s*:\s*([^|\]]+)/i);
  const name = (link ? link[1] : v.split('|')[0]).replace(/^(File|Image)\s*:/i, '').trim();
  return /\.(jpe?g|png|webp)$/i.test(name) ? name : null;
}

/** First and last year an infobox covers ("2015–2020", "2020–present"), or null. */
function yearsOf(fields, now = new Date().getFullYear()) {
  const text = `${fields.model_years || ''} ${fields.production || ''}`.replace(/<ref[\s\S]*?(\/>|<\/ref>)/g, '');
  const years = (text.match(/\b(19[5-9]\d|20[0-4]\d)\b/g) || []).map(Number);
  if (!years.length) return null;
  const end = /present|current/i.test(text) ? now + 1 : Math.max(...years);
  return { start: Math.min(...years), end };
}

/**
 * The infobox for our generation: one naming its code wins; otherwise the one whose years best
 * fit the generation's years; otherwise null (the caller falls back to the article's lead photo).
 */
function pickInfobox(boxes, gen) {
  const withImage = boxes.filter((b) => imageName(b.fields.image));
  if (!gen) return null;
  const code = String(gen.generation || '');
  if (code) {
    const word = new RegExp(`(^|[^A-Za-z0-9])${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`);
    const named = withImage.find((b) => ['model_code', 'name', 'chassis', 'platform', 'aka'].some((k) => word.test(b.fields[k] || '')));
    if (named) return named;
  }
  let best = null;
  for (const b of withImage) {
    const y = yearsOf(b.fields);
    if (!y) continue;
    const overlap = Math.min(y.end, gen.year_end) - Math.max(y.start, gen.year_start) + 1;
    if (overlap <= 0) continue;
    // Overlap counted against the longer of the two spans, so the article's overview box
    // ("2004-present") loses to the box for just this generation.
    const score = overlap / Math.max(y.end - y.start + 1, gen.year_end - gen.year_start + 1);
    if (score >= 0.5 && (!best || score > best.score)) best = { box: b, score };
  }
  return best ? best.box : null;
}

const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#039;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

/** Commons details for one file: a resized URL and the credit its licence asks for, or null. */
async function commonsPhoto(name, getJson) {
  const q = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', origin: '*', prop: 'imageinfo', iiprop: 'url|extmetadata',
    iiurlwidth: '800', iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl|NonFree', titles: `File:${name}`,
  });
  const data = await getJson(`${COMMONS_API}?${q}`);
  if (data === null) return undefined; // Commons unreachable, as opposed to "no free photo"
  const page = data && data.query && data.query.pages && data.query.pages[0];
  const info = page && !page.missing && page.imageinfo && page.imageinfo[0];
  if (!info) return null;
  const meta = info.extmetadata || {};
  const license = meta.LicenseShortName && meta.LicenseShortName.value;
  if (!license || (meta.NonFree && /true/i.test(meta.NonFree.value)) || /fair use|non-free/i.test(license)) return null;
  return {
    src: info.thumburl || info.url,
    file_page: info.descriptionurl,
    credit: stripHtml(meta.Artist && meta.Artist.value) || 'Wikimedia Commons contributor',
    license,
    license_url: (meta.LicenseUrl && meta.LicenseUrl.value) || null,
  };
}

/**
 * A photo for this make, model and generation, or null. `exact` says whether it is of this
 * generation; when false it is the article's lead photo (usually the newest model).
 */
async function findPhoto({ make, model, aka = [], generation }, getJson = wikiJson) {
  let parsed = null;
  for (const name of [model, ...aka].slice(0, 3)) {
    const q = new URLSearchParams({ action: 'parse', format: 'json', formatversion: '2', origin: '*', prop: 'wikitext', redirects: '1', page: `${make} ${name}` });
    const data = await getJson(`${WIKI_API}?${q}`);
    if (data === null) return { unreachable: true };
    if (data.parse && data.parse.wikitext) { parsed = data.parse; break; }
  }
  if (!parsed) return { none: 'no_article' };
  const boxes = infoboxes(parsed.wikitext);
  const match = pickInfobox(boxes, generation);
  const candidates = match ? [{ box: match, exact: true }] : [];
  const lead = boxes.find((b) => imageName(b.fields.image));
  if (lead && lead !== match) candidates.push({ box: lead, exact: false });
  for (const c of candidates) {
    const photo = await commonsPhoto(imageName(c.box.fields.image), getJson);
    if (photo === undefined) return { unreachable: true };
    if (photo) return { ...photo, exact: c.exact, article: `https://en.wikipedia.org/wiki/${encodeURIComponent(parsed.title.replace(/ /g, '_'))}` };
  }
  return { none: candidates.length ? 'no_free_photo' : 'no_photo_in_article' };
}

/**
 * Cached findPhoto: { photo } or { photo: null, reason }. A failed connection is not cached, so
 * it is retried next time; "no photo" is cached for a week, in case the article gains one.
 */
async function photoFor(db, car, getJson) {
  // 'v2' skips answers cached by the first version, which kept a miss forever.
  const key = ['v2', car.make, car.model, car.generation ? car.generation.generation : ''].join('|').toLowerCase();
  const hit = await db.prepare("SELECT data FROM car_photos WHERE key = ? AND (data <> 'null' OR fetched_at > datetime('now', '-7 days'))").get(key);
  if (hit) {
    const photo = JSON.parse(hit.data);
    return photo ? { photo } : { photo: null, reason: 'no_free_photo' };
  }
  const found = await findPhoto(car, getJson);
  if (found.unreachable) return { photo: null, reason: 'unreachable' };
  const photo = found.none ? null : found;
  await db.prepare("INSERT OR REPLACE INTO car_photos (key, data, fetched_at) VALUES (?, ?, datetime('now'))").run(key, JSON.stringify(photo));
  return photo ? { photo } : { photo: null, reason: found.none };
}

return { photoFor, findPhoto, infoboxes, pickInfobox, imageName, yearsOf, wikiJson };
}));
