'use strict';
// node:sqlite (built in, no install needed) arrived in Node 22.5 and lost its flag in 22.13.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
  console.error(`\nThis project needs Node.js 22.13 or newer. You have ${process.versions.node}.` +
    '\nDownload the current LTS version from https://nodejs.org and try again.\n');
  process.exit(1);
}
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { openDb, tx, seedDemo, isDemo, DEMO_VIN } = require('./db');
const alg = require('./lib/algorithms');
const auth = require('./lib/auth');
const { findCompatible, logGap, resolveListings, buildCatalog } = require('./lib/matching');
const { withLineup } = require('./lib/lineup');

const APP_NAME = 'Vinzuu';

const ORIGINS = ['Korea', 'Japan', 'USA', 'Canada', 'Mexico', 'Germany', 'UK', 'France', 'Spain',
  'Italy', 'Turkey', 'Slovakia', 'China', 'India', 'Thailand', 'Indonesia', 'South Africa'];
const IMPORT_SOURCES = ['Japan', 'Korea', 'UAE / Dubai', 'China', 'USA', 'Europe',
  'Local dealer in Rwanda', 'Another African country', 'Not sure'];

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------- small validation helpers ----------

function text(value, { field, max = 120, required = false } = {}) {
  if (value == null || String(value).trim() === '') {
    if (required) throw new HttpError(400, `${field} is required.`);
    return null;
  }
  const s = String(value).trim();
  if (s.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters).`);
  return s;
}

function integer(value, { field, min, max, required = true } = {}) {
  if (value == null || value === '') {
    if (required) throw new HttpError(400, `${field} is required.`);
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || (min != null && n < min) || (max != null && n > max)) {
    throw new HttpError(400, `${field} must be a whole number${min != null ? ` from ${min}` : ''}${max != null ? ` to ${max}` : ''}.`);
  }
  return n;
}

function number(value, { field, min, max }) {
  const n = Number(value);
  if (value == null || value === '' || !Number.isFinite(n) || n < min || n > max) {
    throw new HttpError(400, `${field} must be a number between ${min} and ${max}.`);
  }
  return n;
}

function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw new HttpError(400, `${field} must be one of: ${allowed.join(', ')}.`);
  return value;
}

function phone(value, field, required = true) {
  const raw = text(value, { field, max: 30, required });
  if (raw == null) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) {
    throw new HttpError(400, `${field} does not look like a phone number. Include the country code, for example +250 788 123 456.`);
  }
  return '+' + digits;
}

/** Only our own placeholder, an uploaded (resized) image, or an https URL. */
function photoUrl(value) {
  const s = text(value, { field: 'photo_url', max: 450000, required: true });
  if (!/^(data:image\/(png|jpeg|webp);base64,|\/img\/|https:\/\/)/.test(s)) {
    throw new HttpError(400, 'photo_url must be an uploaded image or an https link.');
  }
  return s;
}

function normalizeEmail(raw) {
  const email = text(raw, { field: 'email', max: 120, required: true }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  return email;
}

/** Express does not await async route handlers, so an async function's rejection must be routed to next() by hand. */
function asyncRoute(fn) {
  return (req, res, next) => { fn(req, res, next).catch(next); };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const recent = (hits.get(req.ip) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
    }
    recent.push(now);
    hits.set(req.ip, recent);
    next();
  };
}

function placeholderSvg(label) {
  const clean = String(label || 'Spare part').replace(/[<>&"']/g, '').slice(0, 28);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240" role="img" aria-label="${clean}">
<rect width="320" height="240" fill="#E4EAEE"/>
<circle cx="160" cy="105" r="52" fill="none" stroke="#9AAAB5" stroke-width="10"/>
<circle cx="160" cy="105" r="14" fill="#9AAAB5"/>
<g fill="#9AAAB5"><circle cx="160" cy="62" r="5"/><circle cx="160" cy="148" r="5"/><circle cx="117" cy="105" r="5"/><circle cx="203" cy="105" r="5"/></g>
<text x="160" y="205" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" fill="#5B6B76">${clean}</text>
</svg>`;
}

// ---------------------------------------------------------------------------

function createApp(db, config = {}) {
  const cfg = {
    adminToken: config.adminToken || 'dev-admin-token',
    writeLimit: config.writeLimit || { windowMs: 60_000, max: 40 },
  };
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use((req, res, next) => {
    // The welcome page optionally loads Google's own sign-in script, so it alone gets a
    // looser policy that names exactly Google's sign-in host. Every other page keeps the
    // strict 'self'-only policy.
    const onWelcomePage = req.path === '/' || req.path === '/welcome.html';
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': onWelcomePage
        ? "default-src 'self'; img-src 'self' data:; " +
          // The Google Sign-In entries Google documents for its button. Its button also sets a
          // few inline styles, so this page alone allows those; styles cannot run script.
          "connect-src 'self' https://accounts.google.com/gsi/; " +
          "script-src 'self' https://accounts.google.com/gsi/client; " +
          "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; " +
          "frame-src https://accounts.google.com/gsi/; " +
          "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        : "default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });

  // Attaches req.userId (or null) from the session cookie. Does not require sign-in by itself;
  // individual routes decide whether they need req.userId to be set.
  app.use((req, res, next) => {
    const cookies = auth.parseCookies(req);
    req.userId = auth.verifySession(cookies[auth.COOKIE_NAME]);
    next();
  });

  const limitWrites = rateLimit(cfg.writeLimit);

  // ----- auth helpers -----
  const isAdmin = (req) => safeEqual(req.get('x-admin-token'), cfg.adminToken);
  const shopFromReq = (req) => {
    const code = req.get('x-shop-code');
    return code ? db.prepare('SELECT * FROM shops WHERE access_code = ?').get(String(code).trim()) : null;
  };
  const requireAdmin = (req, res, next) => (isAdmin(req)
    ? next() : res.status(401).json({ error: 'Admin token required.' }));
  const requireShop = (req, res, next) => {
    const shop = shopFromReq(req);
    if (!shop) return res.status(401).json({ error: 'Shop access code required.' });
    req.shop = shop;
    next();
  };
  const ownShop = (req, res, next) => (Number(req.params.shop_id) === req.shop.id
    ? next() : res.status(403).json({ error: 'You can only manage your own shop.' }));

  // ----- shared lookups -----
  const getCategory = (name) => db.prepare('SELECT * FROM part_categories WHERE name = ?').get(name);
  // plate_number is not unique (see db.js): a plate can be reassigned to a different car over
  // time, so this resolves to whichever car most recently claimed it -- "this plate, right now,
  // belongs to this car". VIN (below) is the only identifier that is trusted to mean "same car".
  const getVehicleByPlate = (plate) => db.prepare(
    'SELECT * FROM vehicles WHERE plate_number = ? ORDER BY id DESC LIMIT 1').get(plate);
  const getVehicleByVin = (vin) => db.prepare('SELECT * FROM vehicles WHERE vin = ?').get(vin);
  const needVehicle = (rawPlate) => {
    const v = getVehicleByPlate(alg.normalizePlate(rawPlate));
    if (!v) throw new HttpError(404, 'This plate is not registered yet.', 'not_registered');
    return v;
  };
  // The server never hands a full VIN back to the browser (see publicVehicle below), so once a
  // car has been found the client cannot use VIN again to refer to it. The numeric id is not
  // sensitive and never changes, so it is what the client uses for every follow-up call about a
  // car it already found -- parts search, listings, updates, bookings.
  const getVehicleById = (id) => db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id);
  const needVehicleById = (rawId) => {
    const id = integer(rawId, { field: 'vehicle_id', min: 1, required: true });
    const v = getVehicleById(id);
    if (!v) throw new HttpError(404, 'Car not found.', 'not_registered');
    return v;
  };
  const publicVehicle = (v) => ({
    id: v.id, plate_number: v.plate_number, make: v.make, model: v.model, generation: v.generation,
    year: v.year, engine: v.engine, transmission: v.transmission, origin_market: v.origin_market,
    drive_side: v.drive_side, has_vin: !!v.vin, vin_masked: alg.maskVin(v.vin),
  });
  const parseOrigin = (query) => {
    if (query.lat == null && query.lon == null) return { origin: alg.KIGALI_CENTER, used: 'default' };
    return {
      origin: { lat: number(query.lat, { field: 'lat', min: -90, max: 90 }), lon: number(query.lon, { field: 'lon', min: -180, max: 180 }) },
      used: 'device',
    };
  };
  const parseRadius = (raw) => {
    if (raw == null || raw === '') return 15;
    if (raw === 'any') return null;
    return number(raw, { field: 'radius_km', min: 1, max: 500 });
  };

  const getUserById = (id) => (id == null ? null : db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  const publicUser = (u) => (u && { id: u.id, name: u.name, email: u.email, phone: u.phone || null, provider: u.auth_provider });

  /** New passwords: at least 8 characters with an uppercase letter, a number and a symbol.
   *  (Only checked when an account is created, so older accounts can still sign in.) */
  function checkNewPassword(password) {
    const missing = [];
    if (password.length < 8) missing.push('at least 8 characters');
    if (!/[A-Z]/.test(password)) missing.push('an uppercase letter');
    if (!/[0-9]/.test(password)) missing.push('a number');
    if (!/[^A-Za-z0-9]/.test(password)) missing.push('a special character');
    if (missing.length) throw new HttpError(400, `Your password needs ${missing.join(', ')}.`);
  }

  /** Find or create the local account for a Google sign-in. Matches by provider id first,
   *  then by email (so someone who signed up with a password can later add Google with the same
   *  address), and only creates a new row if neither matched. */
  function upsertOAuthUser(provider, providerId, email, name) {
    const byProvider = db.prepare('SELECT * FROM users WHERE auth_provider = ? AND provider_id = ?').get(provider, providerId);
    if (byProvider) return byProvider;
    const normalizedEmail = email ? String(email).toLowerCase().trim() : null;
    if (normalizedEmail) {
      const byEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
      if (byEmail) {
        db.prepare('UPDATE users SET auth_provider = ?, provider_id = ? WHERE id = ?').run(provider, providerId, byEmail.id);
        return db.prepare('SELECT * FROM users WHERE id = ?').get(byEmail.id);
      }
    }
    const info = db.prepare('INSERT INTO users (name, email, auth_provider, provider_id) VALUES (?,?,?,?)').run(
      name || 'Customer', normalizedEmail || `${provider}-${providerId}@no-email.kigaliparts.local`, provider, providerId);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
  }

  // =====================  ACCOUNTS  =====================

  // Tells the welcome page whether Google sign-in is set up. The button only works once
  // GOOGLE_CLIENT_ID is set; until then it says Google isn't available yet.
  app.get('/api/auth/config', (req, res) => {
    res.json({
      google: !!process.env.GOOGLE_CLIENT_ID, google_client_id: process.env.GOOGLE_CLIENT_ID || null,
    });
  });

  app.get('/api/auth/me', (req, res) => {
    res.json({ user: publicUser(getUserById(req.userId)) });
  });

  app.post('/api/auth/signup', limitWrites, (req, res) => {
    const b = req.body || {};
    const name = text(b.name, { field: 'name', max: 60, required: true });
    const email = normalizeEmail(b.email);
    const password = String(b.password || '');
    checkNewPassword(password);
    const userPhone = phone(b.phone, 'Phone', false);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'An account with that email already exists. Try signing in instead.');
    }
    const info = db.prepare("INSERT INTO users (name, email, phone, password_hash, auth_provider) VALUES (?,?,?,?,'local')")
      .run(name, email, userPhone, auth.hashPassword(password));
    auth.setSessionCookie(req, res, Number(info.lastInsertRowid));
    res.status(201).json({ user: publicUser(getUserById(Number(info.lastInsertRowid))) });
  });

  app.post('/api/auth/login', limitWrites, (req, res) => {
    const b = req.body || {};
    const email = normalizeEmail(b.email);
    const password = String(b.password || '');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || user.auth_provider !== 'local' || !auth.verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, 'That email and password do not match. If you signed up with Google, use the Google button instead.');
    }
    auth.setSessionCookie(req, res, user.id);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    auth.clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  app.post('/api/auth/google', limitWrites, asyncRoute(async (req, res) => {
    if (!process.env.GOOGLE_CLIENT_ID) throw new HttpError(503, 'Google sign-in is not set up on this server yet.');
    let payload;
    try {
      payload = await auth.verifyGoogleIdToken((req.body || {}).id_token, process.env.GOOGLE_CLIENT_ID);
    } catch (err) {
      throw new HttpError(401, err.message);
    }
    const user = upsertOAuthUser('google', payload.sub, payload.email, payload.name);
    auth.setSessionCookie(req, res, user.id);
    res.json({ user: publicUser(user) });
  }));

  app.get('/api/me/vehicles', (req, res) => {
    if (!req.userId) throw new HttpError(401, 'Sign in to see your cars.');
    const rows = db.prepare('SELECT * FROM vehicles WHERE user_id = ? ORDER BY id DESC').all(req.userId);
    res.json({ vehicles: rows.map(publicVehicle) });
  });

  // =====================  PUBLIC API  =====================

  app.get('/api/meta', (req, res) => {
    const demo = isDemo(db);
    res.json({
      app_name: APP_NAME, demo, demo_vin: demo ? DEMO_VIN : null, kigali_center: alg.KIGALI_CENTER,
      origins: ORIGINS, import_sources: IMPORT_SOURCES, default_radius_km: 15,
    });
  });

  app.get('/api/catalog', (req, res) => {
    res.json({
      categories: db.prepare('SELECT name, type, keywords FROM part_categories ORDER BY id').all(),
      makes: withLineup(buildCatalog(db)),
    });
  });

  app.get('/api/vin/decode', (req, res) => {
    const vin = String(req.query.vin || '').toUpperCase().trim();
    if (!alg.isValidVin(vin)) return res.json({ valid: false });
    const year = alg.decodeModelYear(vin);
    res.json({ valid: true, ...alg.decodeWmi(vin), model_year: year.year, model_year_code: year.code });
  });

  // Algorithm A. VIN-first: a VIN never changes, so it is the trusted key that decides whether
  // this is a car we already know. The plate is checked only as a fallback for cars that don't
  // have a VIN on file yet, since Rwanda's plate is bound to a registration event, not the
  // chassis, and can legitimately point to a different car later.
  const updateRow = (table, id, updates) => {
    const names = Object.keys(updates);
    if (!names.length) return;
    db.prepare(`UPDATE ${table} SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE id = ?`)
      .run(...names.map((n) => updates[n]), id);
  };

  app.post('/api/vehicles/register', limitWrites, (req, res) => {
    const b = req.body || {};
    const plate = alg.normalizePlate(b.plate_number);
    if (!alg.isValidPlate(plate)) {
      throw new HttpError(400, 'Enter the plate number as shown on the car, for example RAE 123 A.');
    }

    let vin = null;
    let decoded = { wmi: null, origin: null, maker: null, source: 'unknown' };
    if (b.vin != null && String(b.vin).trim() !== '') {
      vin = String(b.vin).toUpperCase().replace(/\s/g, '');
      if (!alg.isValidVin(vin)) {
        throw new HttpError(400, 'A VIN has exactly 17 letters and numbers (the letters I, O and Q are never used). Check it or leave it empty.');
      }
      decoded = alg.decodeWmi(vin);
    }

    // This VIN is already on file: it is the same car, however the plate strip reads today.
    // Refresh the plate label and hand back everything we already know, instead of asking the
    // person to re-enter it.
    if (vin) {
      const byVin = getVehicleByVin(vin);
      if (byVin) {
        updateRow('vehicles', byVin.id, {
          ...(byVin.plate_number !== plate ? { plate_number: plate } : {}),
          ...(req.userId && !byVin.user_id ? { user_id: req.userId } : {}),
        });
        return res.json({ vehicle: publicVehicle(db.prepare('SELECT * FROM vehicles WHERE id = ?').get(byVin.id)), existing: true, warnings: [] });
      }
    }

    // No VIN given, or this VIN hasn't been seen before. A plate match with no VIN of its own
    // yet is very likely this same car being re-registered (or enriched with a VIN for the first
    // time), so it is reused and enriched rather than duplicated. A plate match that already HAS
    // a different VIN means the plate has moved on to a different car since -- that old row is
    // left alone, and a fresh car is registered below.
    const existingByPlate = getVehicleByPlate(plate);
    if (existingByPlate && !existingByPlate.vin) {
      updateRow('vehicles', existingByPlate.id, {
        ...(req.userId && !existingByPlate.user_id ? { user_id: req.userId } : {}),
        ...(vin ? { vin, wmi_code: decoded.wmi } : {}),
      });
      return res.json({ vehicle: publicVehicle(getVehicleByPlate(plate)), existing: true, warnings: [] });
    }

    const warnings = [];
    const make = text(b.make, { field: 'make', max: 40, required: true });
    const model = text(b.model, { field: 'model', max: 60, required: true });
    const year = integer(b.year, { field: 'year', min: 1980, max: new Date().getFullYear() + 1 });
    if (decoded.maker && decoded.maker.toLowerCase() !== make.toLowerCase()) {
      warnings.push(`The VIN looks like a ${decoded.maker}, but you chose ${make}. Please double-check both.`);
    }

    let origin = text(b.origin_market, { field: 'origin_market', max: 40 });
    let originSource = origin ? 'manual' : 'unknown';
    if (!origin && decoded.origin) { origin = decoded.origin; originSource = 'vin'; }

    const driveSide = b.drive_side ? oneOf(String(b.drive_side).toUpperCase(), ['LHD', 'RHD'], 'drive_side') : 'LHD';
    const importSource = text(b.import_source, { field: 'import_source', max: 40 });

    const registeredBy = isAdmin(req) ? 'admin' : (shopFromReq(req) ? `shop:${shopFromReq(req).name}` : 'customer');
    db.prepare(`INSERT INTO vehicles
      (plate_number, vin, wmi_code, make, model, generation, year, engine, transmission, origin_market,
       drive_side, import_source, owner_phone, registered_by, user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      plate, vin, decoded.wmi, make, model,
      text(b.generation, { field: 'generation', max: 30 }), year,
      text(b.engine, { field: 'engine', max: 40 }), text(b.transmission, { field: 'transmission', max: 20 }),
      origin, driveSide, importSource, phone(b.owner_phone, 'owner_phone', false), registeredBy, req.userId || null);

    res.status(201).json({
      vehicle: publicVehicle(getVehicleByPlate(plate)), existing: false, origin_source: originSource, warnings,
    });
  });

  app.get('/api/vehicles/:plate', (req, res) => {
    res.json({ vehicle: publicVehicle(needVehicle(req.params.plate)) });
  });

  // Lets a garage (or anyone) look a car up the trusted way, by VIN, instead of by whatever
  // plate happens to be on it today. Mirrors GET /api/vehicles/:plate above.
  app.get('/api/vehicles/by-vin/:vin', (req, res) => {
    const vin = String(req.params.vin || '').toUpperCase().replace(/\s/g, '');
    if (!alg.isValidVin(vin)) throw new HttpError(400, 'A VIN has exactly 17 letters and numbers (the letters I, O and Q are never used).');
    const v = getVehicleByVin(vin);
    if (!v) throw new HttpError(404, 'This VIN is not registered yet.', 'not_registered');
    res.json({ vehicle: publicVehicle(v) });
  });

  // Once a car has been found (by VIN above, or from the signed-in person's own saved cars), the
  // client refers back to it by this id for every other call -- never by VIN, which is never sent
  // to the browser in full, and never by plate, which can be reassigned to a different car later.
  app.get('/api/vehicles/id/:id', (req, res) => {
    res.json({ vehicle: publicVehicle(needVehicleById(req.params.id)) });
  });

  // Anyone can FILL IN a missing detail (for example where the car was built), but only an admin
  // can change a detail that is already set. That stops one person from vandalising another's car.
  function patchVehicle(v, req, res) {
    const b = req.body || {};
    const admin = isAdmin(req);
    const cleaners = {
      origin_market: (x) => oneOf(x, ORIGINS, 'origin_market'),
      engine: (x) => text(x, { field: 'engine', max: 40 }),
      generation: (x) => text(x, { field: 'generation', max: 30 }),
      transmission: (x) => text(x, { field: 'transmission', max: 20 }),
    };
    const updates = {};
    const ignored = [];
    for (const [name, clean] of Object.entries(cleaners)) {
      if (b[name] == null || String(b[name]).trim() === '') continue;
      const value = clean(String(b[name]).trim());
      if (value == null || value === v[name]) continue;
      if (v[name] && !admin) { ignored.push(name); continue; }
      updates[name] = value;
    }
    const names = Object.keys(updates);
    if (names.length) {
      db.prepare(`UPDATE vehicles SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE id = ?`)
        .run(...names.map((n) => updates[n]), v.id);
    }
    res.json({ vehicle: publicVehicle(getVehicleById(v.id)), updated: names, ignored });
  }
  app.patch('/api/vehicles/:plate', limitWrites, (req, res) => {
    patchVehicle(needVehicle(req.params.plate), req, res);
  });
  app.patch('/api/vehicles/id/:id', limitWrites, (req, res) => {
    patchVehicle(needVehicleById(req.params.id), req, res);
  });

  // Algorithm B
  app.get('/api/parts/search', (req, res) => {
    const vehicle = req.query.vehicle_id ? needVehicleById(req.query.vehicle_id) : needVehicle(req.query.plate_number);
    const category = getCategory(String(req.query.part_category || ''));
    if (!category) throw new HttpError(400, 'Choose a part from the list.');

    if (category.type === 'universal') {
      return res.json({ part_category: category.name, type: 'universal', match_type: 'universal', oe_numbers: [] });
    }
    const found = findCompatible(db, vehicle, category.name);
    const messages = {
      not_in_database: "We don't have part numbers for your car yet. We noted your request and will research it.",
      origin_unknown: 'Parts for this model differ by where the car was built. Tell us where yours was built to see the right ones.',
      generation_unknown: 'More than one generation of this model was made that year, and their parts differ. Tell us which one yours is to see the right parts.',
      no_match_for_spec: 'We have this model, but not for your exact engine or build yet. We noted your request.',
    };
    if (found.match_type === 'none') logGap(db, vehicle, category.name);
    res.json({
      part_category: category.name, type: 'model_specific', match_type: found.match_type,
      oe_numbers: found.results, reason: found.reason || null, message: found.reason ? messages[found.reason] : null,
    });
  });

  // Algorithm C (+ D for distance)
  app.get('/api/parts/listings', (req, res) => {
    const oeNumbers = String(req.query.oe_numbers || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
    const category = req.query.part_category ? String(req.query.part_category) : null;
    if (!oeNumbers.length && !category) throw new HttpError(400, 'Give oe_numbers or a universal part_category.');
    const vehicle = req.query.vehicle_id ? getVehicleById(integer(req.query.vehicle_id, { field: 'vehicle_id', min: 1, required: false }))
      : req.query.plate_number ? getVehicleByPlate(alg.normalizePlate(req.query.plate_number)) : null;
    const { origin, used } = parseOrigin(req.query);
    const radiusKm = parseRadius(req.query.radius_km);
    const sortBy = req.query.sort === 'distance' ? 'distance' : 'price';

    const listings = resolveListings(db, { oeNumbers, category, vehicle, origin, radiusKm, sortBy });
    res.json({ count: listings.length, listings, radius_km: radiusKm, sort: sortBy, location_used: used });
  });

  app.get('/api/garages/nearby', (req, res) => {
    const { origin } = parseOrigin(req.query);
    const radiusKm = parseRadius(req.query.radius_km);
    const garages = db.prepare('SELECT * FROM garages').all()
      .map((g) => ({ ...g, distance_km: alg.haversineKm(origin, { lat: g.latitude, lon: g.longitude }) }))
      .filter((g) => radiusKm == null || g.distance_km <= radiusKm)
      .sort((a, b) => a.distance_km - b.distance_km)
      .map((g) => ({
        id: g.id, name: g.name, phone: g.phone, whatsapp: g.whatsapp_number, address: g.address_text,
        specialties: g.specialties, latitude: g.latitude, longitude: g.longitude,
        distance_km: Math.round(g.distance_km * 10) / 10,
      }));
    res.json({ count: garages.length, garages });
  });

  app.post('/api/bookings', limitWrites, (req, res) => {
    const b = req.body || {};
    const vehicle = b.vehicle_id ? needVehicleById(b.vehicle_id) : needVehicle(b.plate_number);
    const customerPhone = phone(b.customer_phone, 'customer_phone');
    const listingId = integer(b.shop_listing_id, { field: 'shop_listing_id', min: 1, required: false });
    const garageId = integer(b.garage_id, { field: 'garage_id', min: 1, required: false });
    if (!listingId && !garageId) throw new HttpError(400, 'Choose a shop listing or a garage.');

    const listing = listingId ? db.prepare(`
      SELECT l.*, s.whatsapp_number AS shop_wa, s.phone AS shop_phone FROM shop_listings l
      JOIN shops s ON s.id = l.shop_id WHERE l.id = ?`).get(listingId) : null;
    if (listingId && !listing) throw new HttpError(404, 'That listing no longer exists.');
    const garage = garageId ? db.prepare('SELECT * FROM garages WHERE id = ?').get(garageId) : null;
    if (garageId && !garage) throw new HttpError(404, 'That garage no longer exists.');
    const note = text(b.note, { field: 'note', max: 300 });

    const info = db.prepare(`INSERT INTO bookings (customer_phone, vehicle_id, shop_listing_id, garage_id, note)
      VALUES (?,?,?,?,?)`).run(customerPhone, vehicle.id, listingId, garageId, note);

    const car = `${vehicle.year} ${vehicle.make} ${vehicle.model}, plate ${vehicle.plate_number}`;
    const partText = listing ? `${listing.part_category}${listing.oe_number ? ` (${listing.oe_number})` : ''}` : null;
    const whatsapp = {
      shop: listing ? alg.whatsappLink(listing.shop_wa || listing.shop_phone,
        `Hello, I saw ${partText} for ${listing.price_rwf.toLocaleString('en-US')} RWF on ${APP_NAME}. Is it still in stock? My car: ${car}.`) : null,
      garage: garage ? alg.whatsappLink(garage.whatsapp_number || garage.phone,
        `Hello, I found your garage on ${APP_NAME}. ${partText ? `I need ${partText} installed` : 'I would like a repair'} on my ${car}.${note ? ` ${note}` : ''} My number: ${customerPhone}`) : null,
    };
    res.status(201).json({
      booking: { id: Number(info.lastInsertRowid), status: 'requested' }, whatsapp,
    });
  });

  app.get('/img/placeholder.svg', (req, res) => {
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(placeholderSvg(req.query.text));
  });

  // =====================  SHOP API  =====================

  app.get('/api/shop/me', requireShop, (req, res) => {
    const { id, name, phone: p, address_text, vetted } = req.shop;
    res.json({ shop: { id, name, phone: p, address: address_text, vetted: !!vetted } });
  });

  // The fitment table is the core asset, so only signed-in shops (and admins) can browse part numbers.
  app.get('/api/shop/oe-numbers', requireShop, (req, res) => {
    const category = getCategory(String(req.query.part_category || ''));
    if (!category) throw new HttpError(400, 'Choose a part category.');
    const rows = db.prepare(`
      SELECT oe_number, make, model, generation, year_start, year_end, engine, origin_market, confidence_level
      FROM fitment_reference WHERE part_category = ? ORDER BY make, model, year_start, oe_number`).all(category.name);
    res.json({ part_category: category.name, type: category.type, rows });
  });

  const listingRows = (shopId) => db.prepare(
    'SELECT * FROM shop_listings WHERE shop_id = ? ORDER BY updated_at DESC, id DESC').all(shopId);

  app.get('/api/shops/:shop_id/listings', requireShop, ownShop, (req, res) => {
    res.json({ listings: listingRows(req.shop.id) });
  });

  app.post('/api/shops/:shop_id/listings', limitWrites, requireShop, ownShop, (req, res) => {
    const b = req.body || {};
    const category = getCategory(String(b.part_category || ''));
    if (!category) throw new HttpError(400, 'Choose a part category from the list.');

    let oe = null;
    let spec = null;
    if (category.type === 'model_specific') {
      oe = text(b.oe_number, { field: 'oe_number', max: 60, required: true });
      const known = db.prepare('SELECT 1 FROM fitment_reference WHERE oe_number = ? AND part_category = ? LIMIT 1').get(oe, category.name);
      if (!known) {
        throw new HttpError(422, `We do not have part number ${oe} for ${category.name} yet. Ask the platform team to add it, then list it.`, 'unknown_oe');
      }
    } else {
      spec = text(b.universal_spec, { field: 'size or specification', max: 80, required: true });
    }
    const info = db.prepare(`INSERT INTO shop_listings
      (shop_id, oe_number, part_category, universal_spec, price_rwf, stock_quantity, condition, photo_url)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      req.shop.id, oe, category.name, spec,
      integer(b.price_rwf, { field: 'price', min: 1, max: 100_000_000 }),
      integer(b.stock_quantity, { field: 'stock', min: 0, max: 10_000 }),
      oneOf(b.condition, ['genuine', 'aftermarket'], 'condition'),
      photoUrl(b.photo_url));
    res.status(201).json({ listing: db.prepare('SELECT * FROM shop_listings WHERE id = ?').get(Number(info.lastInsertRowid)) });
  });

  app.put('/api/shops/:shop_id/listings/:listing_id', limitWrites, requireShop, ownShop, (req, res) => {
    const listing = db.prepare('SELECT * FROM shop_listings WHERE id = ? AND shop_id = ?')
      .get(Number(req.params.listing_id), req.shop.id);
    if (!listing) throw new HttpError(404, 'Listing not found.');
    const b = req.body || {};
    db.prepare(`UPDATE shop_listings SET price_rwf = ?, stock_quantity = ?, condition = ?, photo_url = ?,
      updated_at = datetime('now') WHERE id = ?`).run(
      b.price_rwf != null ? integer(b.price_rwf, { field: 'price', min: 1, max: 100_000_000 }) : listing.price_rwf,
      b.stock_quantity != null ? integer(b.stock_quantity, { field: 'stock', min: 0, max: 10_000 }) : listing.stock_quantity,
      b.condition != null ? oneOf(b.condition, ['genuine', 'aftermarket'], 'condition') : listing.condition,
      b.photo_url != null ? photoUrl(b.photo_url) : listing.photo_url,
      listing.id);
    res.json({ listing: db.prepare('SELECT * FROM shop_listings WHERE id = ?').get(listing.id) });
  });

  app.get('/api/shops/:shop_id/bookings', requireShop, ownShop, (req, res) => {
    const rows = db.prepare(`
      SELECT b.id, b.status, b.created_at, b.customer_phone, b.note,
             v.plate_number, v.make, v.model, v.year, l.part_category, l.oe_number, l.price_rwf
      FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id
      JOIN shop_listings l ON l.id = b.shop_listing_id
      WHERE l.shop_id = ? ORDER BY b.id DESC LIMIT 100`).all(req.shop.id);
    res.json({ bookings: rows });
  });

  // =====================  ADMIN API  =====================

  const admin = express.Router();
  admin.use(requireAdmin);

  admin.get('/stats', (req, res) => {
    const count = (sql) => db.prepare(sql).get().n;
    const tally = (col) => db.prepare(
      `SELECT COALESCE(${col}, 'Unknown') AS label, COUNT(*) AS n FROM vehicles GROUP BY 1 ORDER BY n DESC`).all();
    res.json({
      vehicles: count('SELECT COUNT(*) AS n FROM vehicles'),
      fitment_rows: count('SELECT COUNT(*) AS n FROM fitment_reference'),
      shops: count('SELECT COUNT(*) AS n FROM shops'),
      garages: count('SELECT COUNT(*) AS n FROM garages'),
      live_listings: count('SELECT COUNT(*) AS n FROM shop_listings WHERE stock_quantity > 0'),
      bookings: count('SELECT COUNT(*) AS n FROM bookings'),
      open_gaps: count('SELECT COUNT(*) AS n FROM search_gaps'),
      vehicles_by_make: tally('make'),
      vehicles_by_origin_market: tally('origin_market'),
      vehicles_by_import_source: tally('import_source'),
    });
  });

  const fitmentInput = (b) => {
    const category = getCategory(String(b.part_category || ''));
    if (!category || category.type !== 'model_specific') {
      throw new HttpError(400, 'part_category must be a model-specific category. Universal parts do not need part numbers.');
    }
    const yearStart = integer(b.year_start, { field: 'year_start', min: 1980, max: 2100 });
    const yearEnd = integer(b.year_end, { field: 'year_end', min: 1980, max: 2100 });
    if (yearEnd < yearStart) throw new HttpError(400, 'year_end cannot be before year_start.');
    const confidence = oneOf(b.confidence_level, ['HIGH', 'MEDIUM', 'LOW'], 'confidence_level');
    const verifiedBy = text(b.verified_by, { field: 'verified_by', max: 80 });
    if (confidence === 'HIGH' && !verifiedBy) {
      throw new HttpError(400, 'HIGH confidence means an official catalogue or a physical check. Say who verified it in "verified_by".');
    }
    const origin = text(b.origin_market, { field: 'origin_market', max: 40 });
    if (origin && !ORIGINS.includes(origin)) throw new HttpError(400, `origin_market must be blank (any) or one of: ${ORIGINS.join(', ')}.`);
    return [
      text(b.oe_number, { field: 'oe_number', max: 60, required: true }), category.name,
      text(b.make, { field: 'make', max: 40, required: true }), text(b.model, { field: 'model', max: 60, required: true }),
      text(b.generation, { field: 'generation', max: 30 }), yearStart, yearEnd,
      text(b.engine, { field: 'engine', max: 40 }), origin, confidence,
      text(b.source, { field: 'source', max: 200, required: true }), verifiedBy,
    ];
  };

  admin.get('/fitment-reference', (req, res) => {
    const q = `%${String(req.query.q || '').trim()}%`;
    res.json({
      rows: db.prepare(`SELECT * FROM fitment_reference
        WHERE oe_number LIKE ? OR make LIKE ? OR model LIKE ? OR part_category LIKE ?
        ORDER BY make, model, part_category, year_start LIMIT 500`).all(q, q, q, q),
    });
  });
  admin.get('/fitment-reference/gaps', (req, res) => {
    res.json({ gaps: db.prepare('SELECT * FROM search_gaps ORDER BY times_searched DESC, last_seen DESC LIMIT 200').all() });
  });
  admin.post('/fitment-reference', (req, res) => {
    const info = db.prepare(`INSERT INTO fitment_reference
      (oe_number, part_category, make, model, generation, year_start, year_end, engine, origin_market,
       confidence_level, source, verified_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(...fitmentInput(req.body || {}));
    res.status(201).json({ row: db.prepare('SELECT * FROM fitment_reference WHERE id = ?').get(Number(info.lastInsertRowid)) });
  });
  admin.put('/fitment-reference/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM fitment_reference WHERE id = ?').get(id)) throw new HttpError(404, 'Row not found.');
    db.prepare(`UPDATE fitment_reference SET oe_number=?, part_category=?, make=?, model=?, generation=?,
      year_start=?, year_end=?, engine=?, origin_market=?, confidence_level=?, source=?, verified_by=? WHERE id = ?`)
      .run(...fitmentInput(req.body || {}), id);
    res.json({ row: db.prepare('SELECT * FROM fitment_reference WHERE id = ?').get(id) });
  });
  admin.delete('/fitment-reference/:id', (req, res) => {
    db.prepare('DELETE FROM fitment_reference WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  admin.get('/shops', (req, res) => {
    res.json({ shops: db.prepare('SELECT * FROM shops ORDER BY id').all() });
  });
  admin.post('/shops', (req, res) => {
    const b = req.body || {};
    let code = text(b.access_code, { field: 'access_code', max: 20 });
    if (!code) {
      do { code = String(crypto.randomInt(100000, 1000000)); }
      while (db.prepare('SELECT 1 FROM shops WHERE access_code = ?').get(code));
    }
    if (db.prepare('SELECT 1 FROM shops WHERE access_code = ?').get(code)) {
      throw new HttpError(409, 'That access code is already used by another shop.');
    }
    const info = db.prepare(`INSERT INTO shops
      (name, phone, whatsapp_number, latitude, longitude, address_text, vetted, access_code, onboarded_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      text(b.name, { field: 'name', max: 80, required: true }), phone(b.phone, 'phone'),
      phone(b.whatsapp_number, 'whatsapp_number', false),
      number(b.latitude, { field: 'latitude', min: -90, max: 90 }), number(b.longitude, { field: 'longitude', min: -180, max: 180 }),
      text(b.address_text, { field: 'address', max: 120 }), b.vetted ? 1 : 0, code,
      text(b.onboarded_by, { field: 'onboarded_by', max: 60 }));
    res.status(201).json({ shop: db.prepare('SELECT * FROM shops WHERE id = ?').get(Number(info.lastInsertRowid)) });
  });
  admin.put('/shops/:id', (req, res) => {
    const id = Number(req.params.id);
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(id);
    if (!shop) throw new HttpError(404, 'Shop not found.');
    const b = req.body || {};
    db.prepare('UPDATE shops SET name = ?, phone = ?, vetted = ? WHERE id = ?').run(
      b.name != null ? text(b.name, { field: 'name', max: 80, required: true }) : shop.name,
      b.phone != null ? phone(b.phone, 'phone') : shop.phone,
      b.vetted != null ? (b.vetted ? 1 : 0) : shop.vetted, id);
    res.json({ shop: db.prepare('SELECT * FROM shops WHERE id = ?').get(id) });
  });

  admin.get('/garages', (req, res) => {
    res.json({ garages: db.prepare('SELECT * FROM garages ORDER BY id').all() });
  });
  admin.post('/garages', (req, res) => {
    const b = req.body || {};
    const info = db.prepare(`INSERT INTO garages (name, phone, whatsapp_number, latitude, longitude, address_text, specialties)
      VALUES (?,?,?,?,?,?,?)`).run(
      text(b.name, { field: 'name', max: 80, required: true }), phone(b.phone, 'phone'),
      phone(b.whatsapp_number, 'whatsapp_number', false),
      number(b.latitude, { field: 'latitude', min: -90, max: 90 }), number(b.longitude, { field: 'longitude', min: -180, max: 180 }),
      text(b.address_text, { field: 'address', max: 120 }), text(b.specialties, { field: 'specialties', max: 160 }));
    res.status(201).json({ garage: db.prepare('SELECT * FROM garages WHERE id = ?').get(Number(info.lastInsertRowid)) });
  });

  admin.get('/vehicles', (req, res) => {
    res.json({ vehicles: db.prepare('SELECT * FROM vehicles ORDER BY id DESC LIMIT 500').all() });
  });

  // Admin can add a car directly (for a customer who calls in) or correct one by re-posting the
  // same plate. Unlike the customer endpoint, posting an existing plate here overwrites its
  // details rather than just returning them, since an admin is trusted to fix mistakes.
  admin.post('/vehicles', (req, res) => {
    const b = req.body || {};
    const plate = alg.normalizePlate(b.plate_number);
    if (!alg.isValidPlate(plate)) throw new HttpError(400, 'Enter the plate number as shown on the car, for example RAE 123 A.');
    const make = text(b.make, { field: 'make', max: 40, required: true });
    const model = text(b.model, { field: 'model', max: 60, required: true });
    const year = integer(b.year, { field: 'year', min: 1980, max: new Date().getFullYear() + 1 });
    let vin = null;
    if (b.vin != null && String(b.vin).trim() !== '') {
      vin = String(b.vin).toUpperCase().replace(/\s/g, '');
      if (!alg.isValidVin(vin)) throw new HttpError(400, 'A VIN has exactly 17 letters and numbers (the letters I, O and Q are never used).');
    }
    const wmi = vin ? alg.decodeWmi(vin).wmi : null;
    const generation = text(b.generation, { field: 'generation', max: 30 });
    const engine = text(b.engine, { field: 'engine', max: 40 });
    const transmission = text(b.transmission, { field: 'transmission', max: 20 });
    const originMarket = text(b.origin_market, { field: 'origin_market', max: 40 });
    const importSource = text(b.import_source, { field: 'import_source', max: 40 });

    const existing = db.prepare('SELECT id FROM vehicles WHERE plate_number = ?').get(plate);
    if (existing) {
      db.prepare(`UPDATE vehicles SET vin=?, wmi_code=?, make=?, model=?, generation=?, year=?, engine=?,
        transmission=?, origin_market=?, import_source=? WHERE id = ?`).run(
        vin, wmi, make, model, generation, year, engine, transmission, originMarket, importSource, existing.id);
      return res.json({ vehicle: db.prepare('SELECT * FROM vehicles WHERE id = ?').get(existing.id), updated: true });
    }
    const info = db.prepare(`INSERT INTO vehicles
      (plate_number, vin, wmi_code, make, model, generation, year, engine, transmission, origin_market,
       drive_side, import_source, registered_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      plate, vin, wmi, make, model, generation, year, engine, transmission, originMarket, 'LHD', importSource, 'admin');
    res.status(201).json({ vehicle: db.prepare('SELECT * FROM vehicles WHERE id = ?').get(Number(info.lastInsertRowid)), updated: false });
  });

  admin.delete('/vehicles/:id', (req, res) => {
    const id = Number(req.params.id);
    const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id);
    if (!vehicle) throw new HttpError(404, 'Car not found.');
    const bookingCount = db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE vehicle_id = ?').get(id).n;
    if (bookingCount > 0) throw new HttpError(409, 'This car has booking history, so it cannot be deleted.');
    db.prepare('DELETE FROM vehicles WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  admin.get('/bookings', (req, res) => {
    res.json({
      bookings: db.prepare(`
        SELECT b.*, v.plate_number, v.make, v.model, v.year FROM bookings b
        JOIN vehicles v ON v.id = b.vehicle_id ORDER BY b.id DESC LIMIT 200`).all(),
    });
  });
  app.use('/api/admin', admin);

  // =====================  static files + errors  =====================

  app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route.' }));
  // "/" serves welcome.html (sign in / create account) rather than the plate-finder app directly,
  // so every visitor lands on the account page first. /index.html is still reachable directly.
  app.use(express.static(path.join(__dirname, 'public'), { index: 'welcome.html' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large.' });
    if (err.code === 'ERR_SQLITE_ERROR' && /UNIQUE/.test(err.message)) {
      return res.status(409).json({ error: 'That record already exists.' });
    }
    if (err.code === 'ERR_SQLITE_ERROR' && /FOREIGN KEY constraint failed/i.test(err.message)) {
      return res.status(409).json({ error: 'This action is blocked because something else still refers to this record.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  });

  return app;
}

module.exports = { createApp, HttpError };

/** Tiny .env reader so you do not need to set environment variables by hand (works on Windows too). */
function loadEnvFile(file = path.join(__dirname, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

if (require.main === module) {
  loadEnvFile();
  if (process.argv.includes('--no-demo')) process.env.SEED_DEMO = 'false';
  const db = openDb();
  const seeded = process.env.SEED_DEMO !== 'false' && seedDemo(db);
  const adminToken = process.env.ADMIN_TOKEN;
  const port = Number(process.env.PORT) || 3000;
  const app = createApp(db, { adminToken });
  app.listen(port, () => {
    console.log(`\n${APP_NAME} running at http://localhost:${port}`);
    console.log(`  Customer app:  http://localhost:${port}/`);
    console.log(`  Shop console:  http://localhost:${port}/shop.html`);
    console.log(`  Admin console: http://localhost:${port}/admin.html`);
    if (seeded) console.log('\nDemo data loaded (fake shops, prices and DEMO- part numbers). Shop codes 111111 to 555555.');
    if (!adminToken) console.log('\nWARNING: using the default admin token "dev-admin-token". Set ADMIN_TOKEN before sharing this with anyone.');
  });
}
