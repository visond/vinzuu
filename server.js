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
const { openDb, tx, addFitmentIfNew, seedDemo, isDemo, DEMO_VIN, DEMO_ADMIN, DEMO_BUSINESS_PASSWORD } = require('./db');
const alg = require('./lib/algorithms');
const auth = require('./lib/auth');
const { findCompatible, logGap, resolveListings, buildCatalog } = require('./lib/matching');
const { withLineup } = require('./lib/lineup');
const { csvToFitment } = require('./lib/fitmentcsv');
const vindecode = require('./lib/vindecode');
const carphotos = require('./lib/carphotos');

const APP_NAME = 'Vinzuu';

const ORIGINS = ['Korea', 'Japan', 'USA', 'Canada', 'Mexico', 'Germany', 'UK', 'France', 'Spain',
  'Italy', 'Turkey', 'Slovakia', 'China', 'India', 'Thailand', 'Indonesia', 'South Africa'];
// What a customer can report about a shop, a garage or a part.
const REPORT_REASONS = {
  fake: 'Fake or not genuine part', wrong_part: 'Wrong part, or it did not fit', price: 'Price not honoured',
  no_show: 'Did not answer, or did not keep the booking', rude: 'Rude or unfair treatment', other: 'Something else',
};
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
    // Tests pass their own client id and token check, so Google sign-in can be tested offline.
    googleClientId: config.googleClientId || null,
    verifyGoogleIdToken: config.verifyGoogleIdToken || auth.verifyGoogleIdToken,
    // The online VIN decoder. Tests pass their own (or null to stay offline); VIN_LOOKUP=off
    // turns it off on a server with no internet.
    vinLookup: config.vinLookup !== undefined ? config.vinLookup
      : process.env.VIN_LOOKUP === 'off' ? null : vindecode.vpicLookup,
    // Reads Wikipedia/Commons for car photos (null = offline: the drawn outline is shown).
    wikiJson: config.wikiJson !== undefined ? config.wikiJson
      : process.env.CAR_PHOTOS === 'off' ? null : carphotos.wikiJson,
  };
  const googleClientId = () => cfg.googleClientId || process.env.GOOGLE_CLIENT_ID || null;
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
        // Car photos come from Wikimedia's image hosts (lib/carphotos.js), and the browser may look them up
        // itself when the server can't reach Wikipedia.
        : "default-src 'self'; img-src 'self' data: https://upload.wikimedia.org https://thumb.wikimedia.org; " +
          "connect-src 'self' https://en.wikipedia.org https://commons.wikimedia.org; " +
          "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });

  // Attaches req.userId (or null) from the session cookie. Does not require sign-in by itself;
  // individual routes decide whether they need req.userId to be set.
  app.use((req, res, next) => {
    const cookies = auth.parseCookies(req);
    req.userId = auth.verifySession(cookies[auth.COOKIE_NAME]);
    // A blocked account is signed out everywhere at once: its cookie no longer counts.
    if (req.userId != null && db.prepare('SELECT blocked FROM users WHERE id = ?').get(req.userId)?.blocked) req.userId = null;
    next();
  });

  const limitWrites = rateLimit(cfg.writeLimit);

  // ----- auth helpers -----
  // Each account has a role. An admin runs the platform and is the only one who posts parts. A
  // business account runs a shop (users.shop_id), a garage (users.garage_id) or both, and works in
  // Vinzuu Sellers & Garages. Everyone else is a customer.
  const roleOf = (u) => (!u ? null : u.role === 'admin' ? 'admin'
    : (u.role === 'business' && (u.shop_id || u.garage_id)) ? 'business' : 'customer');
  const homeFor = (u) => ({ admin: '/admin.html', business: '/business.html' }[roleOf(u)] || '/index.html');
  // The places an account can switch between from its account menu. An admin lands on the admin
  // dashboard and can also open the sellers' dashboard (as any shop or garage) and the customer
  // site; a shop or garage can also use the customer site; a customer has nowhere else to go.
  const PORTALS = {
    admin: { key: 'admin', label: 'Admin', sub: 'Run vinzuu', href: '/admin.html' },
    seller: { key: 'seller', label: 'Sellers & Garages', sub: 'Shop and garage dashboard', href: '/business.html' },
    customer: { key: 'customer', label: 'Customer site', sub: 'Find parts and book a garage', href: '/index.html' },
  };
  const portalsFor = (u) => ({ admin: [PORTALS.admin, PORTALS.seller, PORTALS.customer],
    business: [PORTALS.seller, PORTALS.customer] }[roleOf(u)] || []);
  const sessionUser = (req) => (req.userId == null ? null : db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId));
  // The admin token still works for scripts and tests; people sign in with an admin account.
  const isAdmin = (req) => roleOf(sessionUser(req)) === 'admin' || safeEqual(req.get('x-admin-token'), cfg.adminToken);
  // An admin can open the sellers' dashboard as any shop or garage (to see what they see when
  // they ask for help). It is read-only: the x-view-shop / x-view-garage header picks which one.
  const viewAsId = (req, u, header) => (roleOf(u) === 'admin' && req.get(header) ? Number(req.get(header)) : null);
  const shopFromReq = (req) => {
    const u = sessionUser(req);
    const viewId = viewAsId(req, u, 'x-view-shop');
    if (viewId) { req.viewAs = true; return db.prepare('SELECT * FROM shops WHERE id = ?').get(viewId); }
    if (roleOf(u) === 'business' && u.shop_id) return db.prepare('SELECT * FROM shops WHERE id = ?').get(u.shop_id);
    const code = req.get('x-shop-code');
    return code ? db.prepare('SELECT * FROM shops WHERE access_code = ?').get(String(code).trim()) : null;
  };
  const requireAdmin = (req, res, next) => (isAdmin(req)
    ? next() : res.status(401).json({ error: 'Sign in with an admin account.' }));
  const requireShop = (req, res, next) => {
    const shop = shopFromReq(req);
    if (!shop) return res.status(401).json({ error: 'Sign in with your shop account.' });
    if (req.viewAs && req.method !== 'GET') return res.status(403).json({ error: VIEW_ONLY, code: 'view_only' });
    req.shop = shop;
    next();
  };
  const VIEW_ONLY = 'You are looking at this dashboard as the vinzuu team, so it is read-only. Only the business itself can change it.';
  const requireGarage = (req, res, next) => {
    const u = sessionUser(req);
    const viewId = viewAsId(req, u, 'x-view-garage');
    const garageId = viewId || (roleOf(u) === 'business' ? u.garage_id : null);
    const garage = garageId ? db.prepare('SELECT * FROM garages WHERE id = ?').get(garageId) : null;
    if (!garage) return res.status(401).json({ error: 'Sign in with your garage account.' });
    if (viewId && req.method !== 'GET') return res.status(403).json({ error: VIEW_ONLY, code: 'view_only' });
    req.garage = garage;
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
  // The car's own facts (what its VIN decodes to) go to anyone who has the VIN. Its owner's
  // details stay with the owner: mileage and when it was saved are only sent to the account
  // that owns it (or to anyone while it has no owner), and the owner is never named.
  const publicVehicle = (v, req) => {
    const mine = !!(req && req.userId && v.user_id === req.userId);
    const showPrivate = mine || !v.user_id;
    return {
      id: v.id, plate_number: v.plate_number, make: v.make, model: v.model, generation: v.generation,
      year: v.year, engine: v.engine, transmission: v.transmission, origin_market: v.origin_market,
      drive_side: v.drive_side, has_vin: !!v.vin, vin_masked: alg.maskVin(v.vin), mine,
      mileage_km: showPrivate && v.mileage_km != null ? v.mileage_km : null,
      mileage_at: showPrivate ? v.mileage_at || null : null,
      created_at: showPrivate ? v.created_at : null,
    };
  };
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
  const publicUser = (u) => (u && {
    id: u.id, name: u.name, email: u.email, phone: u.phone || null, provider: u.auth_provider,
    role: roleOf(u), home: homeFor(u), portals: portalsFor(u),
  });
  // Signing in: a blocked account is refused with the reason, and the time is kept for the
  // admin's "last active" column.
  function startSession(req, res, user) {
    if (user.blocked) {
      throw new HttpError(403, `This account has been blocked by the vinzuu team: ${user.blocked_reason || 'no reason given'}. Contact us if you think this is a mistake.`, 'blocked');
    }
    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
    auth.setSessionCookie(req, res, user.id);
  }

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
   *  address), and only creates a new row if neither matched. Linking by email needs Google to
   *  have verified that address; otherwise anyone could add an unverified address to a Google
   *  account and walk into someone else's Vinzuu account. The password stays, so the person can
   *  still sign in with either. */
  function upsertOAuthUser(provider, providerId, email, name, emailVerified) {
    const byProvider = db.prepare('SELECT * FROM users WHERE auth_provider = ? AND provider_id = ?').get(provider, providerId);
    if (byProvider) return byProvider;
    const normalizedEmail = email ? String(email).toLowerCase().trim() : null;
    if (normalizedEmail && db.prepare('SELECT 1 FROM users WHERE email = ?').get(normalizedEmail) && !emailVerified) {
      throw new HttpError(409, 'An account with that email already exists. Sign in with your email and password instead.');
    }
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
      google: !!googleClientId(), google_client_id: googleClientId(),
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
    startSession(req, res, getUserById(Number(info.lastInsertRowid)));
    res.status(201).json({ user: publicUser(getUserById(Number(info.lastInsertRowid))) });
  });

  app.post('/api/auth/login', limitWrites, (req, res) => {
    const b = req.body || {};
    const email = normalizeEmail(b.email);
    const password = String(b.password || '');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      // A business that applied but is not approved yet: say where its application is.
      const app = db.prepare('SELECT * FROM business_applications WHERE email = ? ORDER BY id DESC LIMIT 1').get(email);
      if (app && app.status !== 'approved' && auth.verifyPassword(password, app.password_hash)) {
        throw new HttpError(403, app.status === 'pending'
          ? 'Thanks for applying. We are still checking your business, so you cannot sign in yet. We will contact you on your phone or email.'
          : `Your application was not approved: ${app.admin_note || 'no reason given'}. You can apply again on the Sell on vinzuu page.`,
        `application_${app.status}`);
      }
    }
    if (!user || !user.password_hash || !auth.verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, 'That email and password do not match. If you signed up with Google, use the Google button instead.');
    }
    startSession(req, res, user);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    auth.clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  app.post('/api/auth/google', limitWrites, asyncRoute(async (req, res) => {
    if (!googleClientId()) throw new HttpError(503, 'Google sign-in is not set up on this server yet.');
    let payload;
    try {
      payload = await cfg.verifyGoogleIdToken((req.body || {}).id_token, googleClientId());
    } catch (err) {
      throw new HttpError(401, err.message);
    }
    // Google sends email_verified as a boolean (older tokens used the string "true").
    const verified = payload.email_verified === true || payload.email_verified === 'true';
    const user = upsertOAuthUser('google', payload.sub, payload.email, payload.name, verified);
    startSession(req, res, user);
    res.json({ user: publicUser(user) });
  }));

  app.get('/api/me/vehicles', (req, res) => {
    if (!req.userId) throw new HttpError(401, 'Sign in to see your cars.');
    const rows = db.prepare('SELECT * FROM vehicles WHERE user_id = ? ORDER BY id DESC').all(req.userId);
    res.json({ vehicles: rows.map((v) => publicVehicle(v, req)) });
  });

  // =====================  PUBLIC API  =====================

  app.get('/api/meta', (req, res) => {
    const demo = isDemo(db);
    res.json({
      app_name: APP_NAME, demo, demo_vin: demo ? DEMO_VIN : null, kigali_center: alg.KIGALI_CENTER,
      origins: ORIGINS, import_sources: IMPORT_SOURCES, default_radius_km: 15, report_reasons: REPORT_REASONS,
    });
  });

  app.get('/api/catalog', (req, res) => {
    res.json({
      categories: db.prepare('SELECT name, type, keywords, grp AS "group" FROM part_categories ORDER BY sort_order, id').all(),
      makes: withLineup(buildCatalog(db)),
    });
  });

  // A real photo of the model (and generation, when we can tell) with the credit its licence
  // asks for. { photo: null } when there is none or Wikipedia can't be reached.
  app.get('/api/car-photo', asyncRoute(async (req, res) => {
    const make = text(req.query.make, { field: 'make', max: 40, required: true });
    const modelName = text(req.query.model, { field: 'model', max: 60, required: true });
    if (!cfg.wikiJson) return res.json({ photo: null, reason: 'off' });
    const lineupMake = withLineup(buildCatalog(db)).find((m) => m.make.toLowerCase() === make.toLowerCase());
    const model = lineupMake && lineupMake.models.find((m) => m.model.toLowerCase() === modelName.toLowerCase());
    // Only cars in our lineup, so this can't be used to fetch arbitrary Wikipedia pages.
    if (!model) return res.json({ photo: null, reason: 'not_in_lineup' });
    const generation = req.query.generation
      ? model.generations.find((g) => g.generation.toLowerCase() === String(req.query.generation).toLowerCase()) || null
      : null;
    const found = await carphotos.photoFor(db, { make: lineupMake.make, model: model.model, aka: model.aka, generation }, cfg.wikiJson);
    if (found.reason === 'unreachable') {
      console.warn(`Car photos: could not reach Wikipedia for the ${lineupMake.make} ${model.model}; the browser will try instead.`);
    } else res.set('Cache-Control', 'public, max-age=86400');
    // The browser needs the article names and generation years to look the photo up itself.
    res.json({ ...found, ...(found.reason === 'unreachable' ? { lookup: { make: lineupMake.make, model: model.model, aka: model.aka, generation } } : {}) });
  }));

  // The maker, build country and model year come from the VIN itself. `car` is the exact build
  // (model, generation, engine) when a saved car or the online decoder knows it, for the customer
  // to confirm; null when they need to pick it themselves.
  app.get('/api/vin/decode', asyncRoute(async (req, res) => {
    const vin = String(req.query.vin || '').toUpperCase().trim();
    if (!alg.isValidVin(vin)) return res.json({ valid: false });
    const year = alg.decodeModelYear(vin);
    const wmi = alg.decodeWmi(vin);
    const car = await vindecode.findCar(db, vin, {
      lineupMakes: withLineup(buildCatalog(db)), year: year.year, lookup: cfg.vinLookup,
    });
    if (car) {
      car.year = car.year || year.year;
      car.origin_market = car.origin_market || wmi.origin || null;
    }
    res.json({ valid: true, ...wmi, model_year: year.year, model_year_code: year.code, car });
  }));

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
    // Customers register by VIN alone, so the plate is optional when a VIN is given (stored as
    // '' since the column is NOT NULL). Without a VIN the plate is still the only handle, so it
    // stays required there (shop console and older clients).
    const plate = alg.normalizePlate(b.plate_number);
    const hasVin = b.vin != null && String(b.vin).trim() !== '';
    if ((plate || !hasVin) && !alg.isValidPlate(plate)) {
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
          ...(plate && byVin.plate_number !== plate ? { plate_number: plate } : {}),
          ...(req.userId && !byVin.user_id ? { user_id: req.userId } : {}),
        });
        return res.json({ vehicle: publicVehicle(db.prepare('SELECT * FROM vehicles WHERE id = ?').get(byVin.id), req), existing: true, warnings: [] });
      }
    }

    // No VIN given, or this VIN hasn't been seen before. A plate match with no VIN of its own
    // yet is very likely this same car being re-registered (or enriched with a VIN for the first
    // time), so it is reused and enriched rather than duplicated. A plate match that already HAS
    // a different VIN means the plate has moved on to a different car since -- that old row is
    // left alone, and a fresh car is registered below.
    const existingByPlate = plate ? getVehicleByPlate(plate) : null;
    if (existingByPlate && !existingByPlate.vin) {
      updateRow('vehicles', existingByPlate.id, {
        ...(req.userId && !existingByPlate.user_id ? { user_id: req.userId } : {}),
        ...(vin ? { vin, wmi_code: decoded.wmi } : {}),
      });
      return res.json({ vehicle: publicVehicle(getVehicleByPlate(plate), req), existing: true, warnings: [] });
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

    const mileage = b.mileage_km != null && String(b.mileage_km).trim() !== ''
      ? integer(b.mileage_km, { field: 'mileage_km', min: 0, max: 2_000_000 }) : null;

    const registeredBy = isAdmin(req) ? 'admin' : (shopFromReq(req) ? `shop:${shopFromReq(req).name}` : 'customer');
    const inserted = db.prepare(`INSERT INTO vehicles
      (plate_number, vin, wmi_code, make, model, generation, year, engine, transmission, origin_market,
       drive_side, import_source, owner_phone, registered_by, user_id, mileage_km, mileage_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      plate, vin, decoded.wmi, make, model,
      text(b.generation, { field: 'generation', max: 30 }), year,
      text(b.engine, { field: 'engine', max: 40 }), text(b.transmission, { field: 'transmission', max: 20 }),
      // The dashboards only look cars up, so whoever registers a car here (a shop owner or an
      // admin using the customer site too) is adding their own car.
      origin, driveSide, importSource, phone(b.owner_phone, 'owner_phone', false), registeredBy,
      req.userId ?? null,
      mileage, mileage != null ? new Date().toISOString().slice(0, 10) : null);

    res.status(201).json({
      vehicle: publicVehicle(getVehicleById(Number(inserted.lastInsertRowid)), req), existing: false, origin_source: originSource, warnings,
    });
  });

  app.get('/api/vehicles/:plate', (req, res) => {
    res.json({ vehicle: publicVehicle(needVehicle(req.params.plate), req) });
  });

  // Lets a garage (or anyone) look a car up the trusted way, by VIN, instead of by whatever
  // plate happens to be on it today. Mirrors GET /api/vehicles/:plate above.
  app.get('/api/vehicles/by-vin/:vin', (req, res) => {
    const vin = String(req.params.vin || '').toUpperCase().replace(/\s/g, '');
    if (!alg.isValidVin(vin)) throw new HttpError(400, 'A VIN has exactly 17 letters and numbers (the letters I, O and Q are never used).');
    const v = getVehicleByVin(vin);
    if (!v) throw new HttpError(404, 'This VIN is not registered yet.', 'not_registered');
    res.json({ vehicle: publicVehicle(v, req) });
  });

  // Once a car has been found (by VIN above, or from the signed-in person's own saved cars), the
  // client refers back to it by this id for every other call -- never by VIN, which is never sent
  // to the browser in full, and never by plate, which can be reassigned to a different car later.
  app.get('/api/vehicles/id/:id', (req, res) => {
    res.json({ vehicle: publicVehicle(needVehicleById(req.params.id), req) });
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
    // The odometer reading changes all the time, so its owner can always update it (anyone can
    // while the car has no owner yet, as with every other detail here).
    if (b.mileage_km != null && String(b.mileage_km).trim() !== '') {
      if (v.user_id && v.user_id !== req.userId && !admin) ignored.push('mileage_km');
      else {
        updates.mileage_km = integer(b.mileage_km, { field: 'mileage_km', min: 0, max: 2_000_000 });
        updates.mileage_at = new Date().toISOString().slice(0, 10);
      }
    }
    const names = Object.keys(updates);
    if (names.length) {
      db.prepare(`UPDATE vehicles SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE id = ?`)
        .run(...names.map((n) => updates[n]), v.id);
    }
    res.json({ vehicle: publicVehicle(getVehicleById(v.id), req), updated: names, ignored });
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

  // Every part category for one car, saying whether we have something that fits it and how many
  // shops stock it, so the garage page can list only the parts that fit this car.
  //   fit: 'exact' (part number matches this exact build), 'relaxed' (matches all but the engine),
  //        'universal' (standard sizes, no part number), or 'none'.
  app.get('/api/parts/for-vehicle', (req, res) => {
    const vehicle = needVehicleById(req.query.vehicle_id);
    const categories = db.prepare('SELECT name, type FROM part_categories ORDER BY sort_order, id').all().map((c) => {
      let fit = 'none';
      let listings = [];
      if (c.type === 'universal') {
        fit = 'universal';
        listings = resolveListings(db, { category: c.name, radiusKm: null });
      } else {
        const found = findCompatible(db, vehicle, c.name);
        if (found.match_type !== 'none') {
          fit = found.match_type;
          listings = resolveListings(db, { oeNumbers: found.results.map((r) => r.oe_number), vehicle, radiusKm: null });
        }
      }
      return {
        name: c.name, type: c.type, fit,
        shops: new Set(listings.map((l) => l.shop_id)).size,
        from_price_rwf: listings.length ? Math.min(...listings.map((l) => l.price_rwf)) : null,
      };
    });
    res.json({ vehicle_id: vehicle.id, categories });
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
    const garages = db.prepare('SELECT * FROM garages WHERE suspended = 0').all()
      .map((g) => ({ ...g, distance_km: alg.haversineKm(origin, { lat: g.latitude, lon: g.longitude }) }))
      .filter((g) => radiusKm == null || g.distance_km <= radiusKm)
      .sort((a, b) => a.distance_km - b.distance_km)
      .map((g) => ({
        id: g.id, name: g.name, phone: g.phone, whatsapp: g.whatsapp_number, address: g.address_text,
        specialties: g.specialties, opening_hours: g.opening_hours, latitude: g.latitude, longitude: g.longitude,
        distance_km: Math.round(g.distance_km * 10) / 10,
        rating: ratingFor('garage', g.id),
        services: db.prepare('SELECT name, part_category, price_rwf, duration_minutes FROM garage_services WHERE garage_id = ? ORDER BY price_rwf').all(g.id),
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

    if (listing && listing.hidden) throw new HttpError(404, 'That listing no longer exists.');
    if (listing && db.prepare('SELECT suspended FROM shops WHERE id = ?').get(listing.shop_id).suspended) {
      throw new HttpError(409, 'This shop is not taking bookings on Vinzuu right now. Choose another shop.');
    }
    if (garage && garage.suspended) throw new HttpError(409, 'This garage is not taking bookings on Vinzuu right now. Choose another garage.');
    const info = db.prepare(`INSERT INTO bookings (customer_phone, vehicle_id, shop_listing_id, garage_id, note, user_id)
      VALUES (?,?,?,?,?,?)`).run(customerPhone, vehicle.id, listingId, garageId, note, req.userId ?? null);

    const car = `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.plate_number ? `, plate ${vehicle.plate_number}`
      : vehicle.vin ? `, VIN ending ${vehicle.vin.slice(-6)}` : ''}`;
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

  // =====================  VINZUU SELLERS & GARAGES  =====================
  // The business side. A shop or garage applies on /sell.html; an admin checks it and approves
  // it; the owner then signs in and lands on /business.html. Only an admin posts parts, so no
  // shop can put a fake part on sale: shops send requests and keep their own price and stock.

  const APPLICATION_KINDS = ['shop', 'garage', 'both'];

  app.post('/api/business/apply', limitWrites, (req, res) => {
    const b = req.body || {};
    const email = normalizeEmail(b.email);
    const password = String(b.password || '');
    checkNewPassword(password);
    if (db.prepare('SELECT 1 FROM business_applications WHERE email = ? AND status = ?').get(email, 'pending')) {
      throw new HttpError(409, 'We already have an application from this email and are checking it. Sign in with it to see where it is.');
    }
    const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (existing && roleOf(existing) !== 'customer') {
      throw new HttpError(409, 'This email already has a business or admin account. Sign in instead.');
    }
    const tin = text(b.tin, { field: 'TIN', max: 20, required: true }).replace(/\s/g, '');
    if (!/^\d{9}$/.test(tin)) throw new HttpError(400, 'The TIN is the 9-digit number on your RDB certificate.');
    const kind = oneOf(b.kind, APPLICATION_KINDS, 'business type');
    const info = db.prepare(`INSERT INTO business_applications
      (kind, business_name, owner_name, email, password_hash, phone, whatsapp_number, address_text, latitude, longitude,
       tin, certificate_photo, front_photo, specialties, note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      kind, text(b.business_name, { field: 'Business name', max: 80, required: true }),
      text(b.owner_name, { field: 'Owner name', max: 60, required: true }), email, auth.hashPassword(password),
      phone(b.phone, 'Phone'), phone(b.whatsapp_number, 'WhatsApp', false),
      text(b.address_text, { field: 'Address', max: 120, required: true }),
      number(b.latitude, { field: 'Latitude', min: -3, max: -1 }), number(b.longitude, { field: 'Longitude', min: 28.8, max: 31 }),
      tin, photoUrl(b.certificate_photo), photoUrl(b.front_photo),
      kind === 'shop' ? null : text(b.specialties, { field: 'What you are good at', max: 160 }),
      text(b.note, { field: 'Note', max: 300 }));
    res.status(201).json({ application: { id: Number(info.lastInsertRowid), status: 'pending' } });
  });

  /** What a business account sees about itself: its shop and/or its garage. An admin viewing
   *  the dashboard passes the shop or garage to show instead. */
  function businessView(u, ids = { shopId: u.shop_id, garageId: u.garage_id }) {
    const shop = ids.shopId ? db.prepare('SELECT * FROM shops WHERE id = ?').get(ids.shopId) : null;
    const garage = ids.garageId ? db.prepare('SELECT * FROM garages WHERE id = ?').get(ids.garageId) : null;
    return {
      user: publicUser(u),
      shop: shop && {
        id: shop.id, name: shop.name, phone: shop.phone, whatsapp_number: shop.whatsapp_number,
        address_text: shop.address_text, opening_hours: shop.opening_hours, vetted: !!shop.vetted,
        latitude: shop.latitude, longitude: shop.longitude, rating: ratingFor('shop', shop.id),
        suspended: !!shop.suspended, suspended_reason: shop.suspended ? shop.suspended_reason : null,
      },
      garage: garage && {
        id: garage.id, name: garage.name, phone: garage.phone, whatsapp_number: garage.whatsapp_number,
        address_text: garage.address_text, opening_hours: garage.opening_hours, specialties: garage.specialties,
        latitude: garage.latitude, longitude: garage.longitude, rating: ratingFor('garage', garage.id),
        suspended: !!garage.suspended, suspended_reason: garage.suspended ? garage.suspended_reason : null,
      },
    };
  }

  app.get('/api/business/me', (req, res) => {
    const u = sessionUser(req);
    if (!u) throw new HttpError(401, 'Sign in to open Vinzuu Sellers & Garages.');
    if (roleOf(u) === 'admin') {
      // The admin first picks which shop or garage to look at (read-only).
      const shopId = req.query.shop_id ? Number(req.query.shop_id) : null;
      const garageId = req.query.garage_id ? Number(req.query.garage_id) : null;
      if (!shopId && !garageId) throw new HttpError(409, 'Choose a shop or garage to open.', 'admin_pick');
      const view = businessView(u, { shopId, garageId });
      if (!view.shop && !view.garage) throw new HttpError(404, 'That shop or garage no longer exists.', 'admin_pick');
      return res.json({ ...view, view_as_admin: true });
    }
    if (roleOf(u) !== 'business') throw new HttpError(403, 'This account is not a shop or garage account.', 'not_business');
    res.json(businessView(u));
  });

  // ----- ratings and reviews (shared by the shop side, the garage side and customers) -----

  function ratingFor(target, id) {
    const col = target === 'shop' ? 'shop_id' : 'garage_id';
    const r = db.prepare(`SELECT ROUND(AVG(rating), 1) AS average, COUNT(*) AS count FROM reviews WHERE target = ? AND ${col} = ?`).get(target, id);
    return { average: r.count ? r.average : null, count: r.count };
  }
  const reviewRows = (target, id, limit = 100) => db.prepare(`
    SELECT id, author_name, rating, comment, reply, replied_at, created_at FROM reviews
    WHERE target = ? AND ${target === 'shop' ? 'shop_id' : 'garage_id'} = ? ORDER BY id DESC LIMIT ?`).all(target, id, limit);

  // Anyone can read a shop's or garage's reviews before choosing it.
  app.get('/api/reviews', (req, res) => {
    const target = oneOf(req.query.shop_id ? 'shop' : req.query.garage_id ? 'garage' : '', ['shop', 'garage'], 'shop_id or garage_id');
    const id = Number(target === 'shop' ? req.query.shop_id : req.query.garage_id);
    res.json({ rating: ratingFor(target, id), reviews: reviewRows(target, id, 50) });
  });

  function replyToReview(target, ownerId, req, res) {
    const col = target === 'shop' ? 'shop_id' : 'garage_id';
    const review = db.prepare(`SELECT * FROM reviews WHERE id = ? AND target = ? AND ${col} = ?`).get(Number(req.params.id), target, ownerId);
    if (!review) throw new HttpError(404, 'Review not found.');
    const reply = text((req.body || {}).reply, { field: 'Reply', max: 300 });
    db.prepare('UPDATE reviews SET reply = ?, replied_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime(\'now\') END WHERE id = ?')
      .run(reply, reply, review.id);
    res.json({ review: db.prepare('SELECT * FROM reviews WHERE id = ?').get(review.id) });
  }

  // ----- the shop side -----

  app.get('/api/shop/me', requireShop, (req, res) => {
    const { id, name, phone: p, address_text, vetted } = req.shop;
    res.json({ shop: { id, name, phone: p, address: address_text, vetted: !!vetted } });
  });

  // Name and map location stay with the admin, so a shop cannot pass itself off as another one.
  app.put('/api/shop/profile', limitWrites, requireShop, (req, res) => {
    const b = req.body || {};
    db.prepare('UPDATE shops SET phone = ?, whatsapp_number = ?, address_text = ?, opening_hours = ? WHERE id = ?').run(
      phone(b.phone, 'Phone'), phone(b.whatsapp_number, 'WhatsApp', false),
      text(b.address_text, { field: 'Address', max: 120 }), text(b.opening_hours, { field: 'Opening hours', max: 120 }), req.shop.id);
    res.json(businessView(sessionUser(req) || { shop_id: req.shop.id, role: 'business' }));
  });

  // The fitment table is the core asset, so only signed-in shops (and admins) can browse part numbers.
  const oeNumberRows = (req, res) => {
    const category = getCategory(String(req.query.part_category || ''));
    if (!category) throw new HttpError(400, 'Choose a part category.');
    // Narrowed to one car when the form has one (make, then model, then generation), so the list
    // stays short however many part numbers the table holds.
    const make = req.query.make ? String(req.query.make) : null;
    const model = make && req.query.model ? String(req.query.model) : null;
    const generation = model && req.query.generation ? String(req.query.generation) : null;
    const rows = db.prepare(`
      SELECT oe_number, make, model, generation, year_start, year_end, engine, origin_market, confidence_level
      FROM fitment_reference WHERE part_category = ?
        AND (? IS NULL OR make = ?) AND (? IS NULL OR model = ?) AND (? IS NULL OR generation IS NULL OR generation = ?)
      ORDER BY make, model, year_start, oe_number LIMIT 500`)
      .all(category.name, make, make, model, model, generation, generation);
    res.json({ part_category: category.name, type: category.type, rows });
  };
  app.get('/api/shop/oe-numbers', requireShop, oeNumberRows);

  /** The checked fields of a part for sale, shared by a shop's request and the admin's post.
   *  A model-specific part must use a part number from the fitment table, so it only ever
   *  shows for cars it is known to fit. */
  function partFields(b) {
    const category = getCategory(String(b.part_category || ''));
    if (!category) throw new HttpError(400, 'Choose a part category from the list.');
    let oe = null;
    let spec = null;
    if (category.type === 'model_specific') {
      oe = text(b.oe_number, { field: 'Part number', max: 60, required: true });
      const known = db.prepare('SELECT 1 FROM fitment_reference WHERE oe_number = ? AND part_category = ? LIMIT 1').get(oe, category.name);
      if (!known) {
        throw new HttpError(422, `We do not have part number ${oe} for ${category.name} yet. It has to be added under Part numbers first.`, 'unknown_oe');
      }
    } else {
      spec = text(b.universal_spec, { field: 'Size or specification', max: 80, required: true });
    }
    return {
      oe_number: oe, part_category: category.name, universal_spec: spec,
      price_rwf: integer(b.price_rwf, { field: 'Price', min: 1, max: 100_000_000 }),
      stock_quantity: integer(b.stock_quantity, { field: 'Stock', min: 0, max: 10_000 }),
      condition: oneOf(b.condition, ['genuine', 'aftermarket'], 'condition'),
      photo_url: photoUrl(b.photo_url),
      brand: text(b.brand, { field: 'Brand', max: 60 }),
      description: text(b.description, { field: 'Description', max: 600 }),
      warranty_months: integer(b.warranty_months, { field: 'Warranty (months)', min: 0, max: 120, required: false }),
    };
  }
  const insertListing = (shopId, p) => Number(db.prepare(`INSERT INTO shop_listings
      (shop_id, oe_number, part_category, universal_spec, price_rwf, stock_quantity, condition, photo_url, brand, description, warranty_months)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(shopId, p.oe_number, p.part_category, p.universal_spec,
    p.price_rwf, p.stock_quantity, p.condition, p.photo_url, p.brand, p.description, p.warranty_months).lastInsertRowid);

  /** "Toyota RAV4 XA40, 2013 to 2018, 2.0L Petrol" for each car a part number fits. */
  const fitsFor = (oe) => (oe ? db.prepare(`
    SELECT DISTINCT make, model, generation, year_start, year_end, engine, origin_market FROM fitment_reference
    WHERE oe_number = ? ORDER BY make, model, year_start`).all(oe) : []);

  const listingRows = (shopId) => db.prepare(`
    SELECT l.*, (SELECT COUNT(*) FROM bookings b WHERE b.shop_listing_id = l.id) AS bookings
    FROM shop_listings l WHERE l.shop_id = ? ORDER BY l.updated_at DESC, l.id DESC`).all(shopId)
    .map((l) => ({ ...l, hidden: !!l.hidden, fits: fitsFor(l.oe_number) }));

  app.get('/api/shops/:shop_id/listings', requireShop, ownShop, (req, res) => {
    res.json({ listings: listingRows(req.shop.id) });
  });

  // Only the vinzuu team posts parts. A shop sends a request instead (below).
  app.post('/api/shops/:shop_id/listings', requireShop, ownShop, () => {
    throw new HttpError(403, 'Only the vinzuu team can post parts. Send it from "Request a part" and we will check it.', 'admin_only');
  });

  // A shop keeps its own price and stock current. What the part is (number, type, photo,
  // description) is what the admin checked, so only an admin can change that.
  app.put('/api/shops/:shop_id/listings/:listing_id', limitWrites, requireShop, ownShop, (req, res) => {
    const listing = db.prepare('SELECT * FROM shop_listings WHERE id = ? AND shop_id = ?')
      .get(Number(req.params.listing_id), req.shop.id);
    if (!listing) throw new HttpError(404, 'Part not found.');
    const b = req.body || {};
    for (const locked of ['condition', 'photo_url', 'brand', 'description', 'warranty_months', 'oe_number', 'part_category', 'universal_spec']) {
      if (b[locked] != null && b[locked] !== listing[locked]) {
        throw new HttpError(403, 'Only the vinzuu team can change what the part is. Send a request to change it.', 'admin_only');
      }
    }
    db.prepare(`UPDATE shop_listings SET price_rwf = ?, stock_quantity = ?, updated_at = datetime('now') WHERE id = ?`).run(
      b.price_rwf != null ? integer(b.price_rwf, { field: 'Price', min: 1, max: 100_000_000 }) : listing.price_rwf,
      b.stock_quantity != null ? integer(b.stock_quantity, { field: 'Stock', min: 0, max: 10_000 }) : listing.stock_quantity,
      listing.id);
    res.json({ listing: db.prepare('SELECT * FROM shop_listings WHERE id = ?').get(listing.id) });
  });

  app.get('/api/shops/:shop_id/listing-requests', requireShop, ownShop, (req, res) => {
    res.json({ requests: db.prepare('SELECT * FROM listing_requests WHERE shop_id = ? ORDER BY id DESC LIMIT 100').all(req.shop.id) });
  });

  app.post('/api/shops/:shop_id/listing-requests', limitWrites, requireShop, ownShop, (req, res) => {
    const b = req.body || {};
    const p = partFields(b);
    const info = db.prepare(`INSERT INTO listing_requests
      (shop_id, oe_number, part_category, universal_spec, price_rwf, stock_quantity, condition, photo_url, brand, description, warranty_months, note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.shop.id, p.oe_number, p.part_category, p.universal_spec,
      p.price_rwf, p.stock_quantity, p.condition, p.photo_url, p.brand, p.description, p.warranty_months,
      text(b.note, { field: 'Note', max: 300 }));
    res.status(201).json({ request: db.prepare('SELECT * FROM listing_requests WHERE id = ?').get(Number(info.lastInsertRowid)) });
  });

  // Bookings, seen from either side: the car, the part, the shop and the garage, each side's progress.
  const bookingSelect = `
    SELECT b.id, b.created_at, b.customer_phone, b.note, b.status, b.admin_note, b.user_id,
           b.shop_status, b.garage_status, b.garage_time, b.garage_note,
           v.plate_number, v.make, v.model, v.year, v.generation, v.engine, v.vin,
           l.id AS listing_id, l.part_category, l.oe_number, l.universal_spec, l.price_rwf, l.photo_url,
           s.id AS shop_id, s.name AS shop_name, s.phone AS shop_phone, s.whatsapp_number AS shop_whatsapp, s.address_text AS shop_address,
           g.id AS garage_id, g.name AS garage_name, g.phone AS garage_phone, g.whatsapp_number AS garage_whatsapp, g.address_text AS garage_address
    FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id
    LEFT JOIN shop_listings l ON l.id = b.shop_listing_id
    LEFT JOIN shops s ON s.id = l.shop_id
    LEFT JOIN garages g ON g.id = b.garage_id`;
  const bookingOut = (r) => {
    const { vin, ...rest } = r;
    return { ...rest, vin_masked: alg.maskVin(vin) };
  };

  app.get('/api/shops/:shop_id/bookings', requireShop, ownShop, (req, res) => {
    const rows = db.prepare(`${bookingSelect} WHERE l.shop_id = ? ORDER BY b.id DESC LIMIT 200`).all(req.shop.id);
    res.json({ bookings: rows.map(bookingOut) });
  });

  const SHOP_STATUSES = ['requested', 'confirmed', 'collected', 'cancelled'];
  app.put('/api/shops/:shop_id/bookings/:booking_id', limitWrites, requireShop, ownShop, (req, res) => {
    const row = db.prepare(`${bookingSelect} WHERE b.id = ? AND l.shop_id = ?`).get(Number(req.params.booking_id), req.shop.id);
    if (!row) throw new HttpError(404, 'Booking not found.');
    const status = oneOf((req.body || {}).status, SHOP_STATUSES.slice(1), 'status');
    db.prepare('UPDATE bookings SET shop_status = ? WHERE id = ?').run(status, row.id);
    res.json({ booking: bookingOut(db.prepare(`${bookingSelect} WHERE b.id = ?`).get(row.id)) });
  });

  app.get('/api/shop/reviews', requireShop, (req, res) => {
    res.json({ rating: ratingFor('shop', req.shop.id), reviews: reviewRows('shop', req.shop.id) });
  });
  app.put('/api/shop/reviews/:id', limitWrites, requireShop, (req, res) => replyToReview('shop', req.shop.id, req, res));

  // ----- the garage side -----

  app.put('/api/garage/profile', limitWrites, requireGarage, (req, res) => {
    const b = req.body || {};
    db.prepare('UPDATE garages SET phone = ?, whatsapp_number = ?, address_text = ?, opening_hours = ?, specialties = ? WHERE id = ?').run(
      phone(b.phone, 'Phone'), phone(b.whatsapp_number, 'WhatsApp', false),
      text(b.address_text, { field: 'Address', max: 120 }), text(b.opening_hours, { field: 'Opening hours', max: 120 }),
      text(b.specialties, { field: 'What you are good at', max: 160 }), req.garage.id);
    res.json(businessView(sessionUser(req)));
  });

  app.get('/api/garage/jobs', requireGarage, (req, res) => {
    const rows = db.prepare(`${bookingSelect} WHERE b.garage_id = ? ORDER BY b.id DESC LIMIT 200`).all(req.garage.id);
    res.json({ jobs: rows.map(bookingOut) });
  });

  // accept (with a date and time), decline (with a reason), or done.
  app.put('/api/garage/jobs/:id', limitWrites, requireGarage, (req, res) => {
    const job = db.prepare('SELECT * FROM bookings WHERE id = ? AND garage_id = ?').get(Number(req.params.id), req.garage.id);
    if (!job) throw new HttpError(404, 'Job not found.');
    const b = req.body || {};
    const action = oneOf(b.action, ['accept', 'decline', 'done'], 'action');
    if (action === 'accept') {
      const time = text(b.time, { field: 'Date and time', max: 16, required: true });
      if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(time)) throw new HttpError(400, 'Choose the date and time for the job.');
      db.prepare("UPDATE bookings SET garage_status = 'accepted', garage_time = ?, garage_note = NULL WHERE id = ?").run(time.replace('T', ' '), job.id);
    } else if (action === 'decline') {
      const reason = text(b.reason, { field: 'Reason', max: 200, required: true });
      db.prepare("UPDATE bookings SET garage_status = 'declined', garage_note = ? WHERE id = ?").run(reason, job.id);
    } else {
      if (job.garage_status !== 'accepted') throw new HttpError(409, 'Accept the job before marking it done.');
      db.prepare("UPDATE bookings SET garage_status = 'done' WHERE id = ?").run(job.id);
    }
    res.json({ job: bookingOut(db.prepare(`${bookingSelect} WHERE b.id = ?`).get(job.id)) });
  });

  const serviceRows = (garageId) => db.prepare(
    'SELECT * FROM garage_services WHERE garage_id = ? ORDER BY part_category IS NULL, name').all(garageId);
  const serviceFields = (b) => ({
    name: text(b.name, { field: 'Service', max: 80, required: true }),
    part_category: b.part_category ? getCategory(String(b.part_category))?.name ?? (() => { throw new HttpError(400, 'Choose a part from the list.'); })() : null,
    price_rwf: integer(b.price_rwf, { field: 'Price', min: 1, max: 10_000_000 }),
    duration_minutes: integer(b.duration_minutes, { field: 'Time it takes (minutes)', min: 5, max: 2880, required: false }),
  });
  app.get('/api/garage/services', requireGarage, (req, res) => res.json({ services: serviceRows(req.garage.id) }));
  app.post('/api/garage/services', limitWrites, requireGarage, (req, res) => {
    const f = serviceFields(req.body || {});
    db.prepare('INSERT INTO garage_services (garage_id, name, part_category, price_rwf, duration_minutes) VALUES (?,?,?,?,?)')
      .run(req.garage.id, f.name, f.part_category, f.price_rwf, f.duration_minutes);
    res.status(201).json({ services: serviceRows(req.garage.id) });
  });
  app.put('/api/garage/services/:id', limitWrites, requireGarage, (req, res) => {
    const svc = db.prepare('SELECT * FROM garage_services WHERE id = ? AND garage_id = ?').get(Number(req.params.id), req.garage.id);
    if (!svc) throw new HttpError(404, 'Service not found.');
    const f = serviceFields({ ...svc, ...(req.body || {}) });
    db.prepare('UPDATE garage_services SET name = ?, part_category = ?, price_rwf = ?, duration_minutes = ? WHERE id = ?')
      .run(f.name, f.part_category, f.price_rwf, f.duration_minutes, svc.id);
    res.json({ services: serviceRows(req.garage.id) });
  });
  app.delete('/api/garage/services/:id', limitWrites, requireGarage, (req, res) => {
    const info = db.prepare('DELETE FROM garage_services WHERE id = ? AND garage_id = ?').run(Number(req.params.id), req.garage.id);
    if (!info.changes) throw new HttpError(404, 'Service not found.');
    res.json({ services: serviceRows(req.garage.id) });
  });

  app.get('/api/garage/reviews', requireGarage, (req, res) => {
    res.json({ rating: ratingFor('garage', req.garage.id), reviews: reviewRows('garage', req.garage.id) });
  });
  app.put('/api/garage/reviews/:id', limitWrites, requireGarage, (req, res) => replyToReview('garage', req.garage.id, req, res));

  // ----- a customer's own bookings, and reviewing them -----

  app.get('/api/me/bookings', (req, res) => {
    if (!req.userId) throw new HttpError(401, 'Sign in to see your bookings.');
    const rows = db.prepare(`${bookingSelect} WHERE b.user_id = ? ORDER BY b.id DESC LIMIT 50`).all(req.userId);
    const reviewed = db.prepare('SELECT target, rating FROM reviews WHERE booking_id = ?');
    const reported = db.prepare("SELECT DISTINCT target FROM reports WHERE booking_id = ? AND user_id = ? AND status = 'open'");
    res.json({
      bookings: rows.map((r) => {
        const done = Object.fromEntries(reviewed.all(r.id).map((x) => [x.target, x.rating]));
        return {
          ...bookingOut(r),
          reported: Object.fromEntries(reported.all(r.id, req.userId).map((x) => [x.target, true])),
          review: {
            shop: done.shop ?? (r.shop_id && r.shop_status === 'collected' ? 'can_review' : null),
            garage: done.garage ?? (r.garage_id && r.garage_status === 'done' ? 'can_review' : null),
          },
        };
      }),
    });
  });

  app.post('/api/me/bookings/:id/reviews', limitWrites, (req, res) => {
    if (!req.userId) throw new HttpError(401, 'Sign in to leave a review.');
    const row = db.prepare(`${bookingSelect} WHERE b.id = ? AND b.user_id = ?`).get(Number(req.params.id), req.userId);
    if (!row) throw new HttpError(404, 'Booking not found.');
    const b = req.body || {};
    const target = oneOf(b.target, ['shop', 'garage'], 'target');
    const finished = target === 'shop' ? row.shop_id && row.shop_status === 'collected' : row.garage_id && row.garage_status === 'done';
    if (!finished) {
      throw new HttpError(409, target === 'shop' ? 'You can review the shop once you have collected the part.' : 'You can review the garage once the job is done.');
    }
    if (db.prepare('SELECT 1 FROM reviews WHERE booking_id = ? AND target = ?').get(row.id, target)) {
      throw new HttpError(409, 'You already reviewed this.');
    }
    const user = getUserById(req.userId);
    const parts = String(user.name || 'Customer').trim().split(/\s+/);
    const author = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.` : parts[0];
    db.prepare('INSERT INTO reviews (booking_id, target, shop_id, garage_id, user_id, author_name, rating, comment) VALUES (?,?,?,?,?,?,?,?)').run(
      row.id, target, target === 'shop' ? row.shop_id : null, target === 'garage' ? row.garage_id : null, req.userId, author,
      integer(b.rating, { field: 'Stars', min: 1, max: 5 }), text(b.comment, { field: 'Comment', max: 500 }));
    res.status(201).json({ rating: ratingFor(target, target === 'shop' ? row.shop_id : row.garage_id) });
  });

  // ----- reporting a problem with a shop, a garage or a part -----

  // A signed-in customer reports a problem from one of their bookings (the shop or the garage
  // side), or a part straight from the search results. The admin looks into it.
  app.post('/api/reports', limitWrites, (req, res) => {
    if (!req.userId) throw new HttpError(401, 'Sign in to report a problem.');
    const b = req.body || {};
    const reason = oneOf(b.reason, Object.keys(REPORT_REASONS), 'reason');
    const details = text(b.details, { field: 'What happened', max: 500, required: reason === 'other' });
    let r;
    if (b.booking_id) {
      const row = db.prepare(`${bookingSelect} WHERE b.id = ? AND b.user_id = ?`).get(Number(b.booking_id), req.userId);
      if (!row) throw new HttpError(404, 'Booking not found.');
      const target = oneOf(b.target, ['shop', 'garage'], 'target');
      if (!row[`${target}_id`]) throw new HttpError(400, `This booking has no ${target}.`);
      r = { booking_id: row.id, target, shop_id: target === 'shop' ? row.shop_id : null,
        garage_id: target === 'garage' ? row.garage_id : null, listing_id: target === 'shop' ? row.listing_id : null };
    } else if (b.listing_id) {
      const listing = db.prepare('SELECT * FROM shop_listings WHERE id = ?').get(Number(b.listing_id));
      if (!listing) throw new HttpError(404, 'That part no longer exists.');
      r = { booking_id: null, target: 'listing', shop_id: listing.shop_id, garage_id: null, listing_id: listing.id };
    } else throw new HttpError(400, 'Say which booking or part this is about.');
    const already = db.prepare(`SELECT 1 FROM reports WHERE user_id = ? AND status = 'open' AND target = ?
      AND COALESCE(booking_id, 0) = COALESCE(?, 0) AND COALESCE(listing_id, 0) = COALESCE(?, 0)
      AND COALESCE(shop_id, 0) = COALESCE(?, 0) AND COALESCE(garage_id, 0) = COALESCE(?, 0)`)
      .get(req.userId, r.target, r.booking_id, r.listing_id, r.shop_id, r.garage_id);
    if (already) throw new HttpError(409, 'You already reported this. The vinzuu team is looking into it.');
    const info = db.prepare(`INSERT INTO reports (user_id, booking_id, target, shop_id, garage_id, listing_id, reason, details)
      VALUES (?,?,?,?,?,?,?,?)`).run(req.userId, r.booking_id, r.target, r.shop_id, r.garage_id, r.listing_id, reason, details);
    res.status(201).json({ report: { id: Number(info.lastInsertRowid), status: 'open' } });
  });

  // =====================  ADMIN API  =====================

  const admin = express.Router();
  admin.use(requireAdmin);

  /** Keeps a line in the admin log: who did what to which record. */
  function logAdmin(req, action, targetType, targetId, detail) {
    const u = sessionUser(req);
    db.prepare('INSERT INTO admin_log (admin_id, admin_email, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?)').run(
      roleOf(u) === 'admin' ? u.id : null, roleOf(u) === 'admin' ? u.email : 'admin token', action, targetType || null,
      targetId == null ? null : Number(targetId), detail == null ? null : String(detail).slice(0, 300));
  }

  admin.get('/stats', (req, res) => {
    const count = (sql) => db.prepare(sql).get().n;
    const tally = (col) => db.prepare(
      `SELECT COALESCE(${col}, 'Unknown') AS label, COUNT(*) AS n FROM vehicles GROUP BY 1 ORDER BY n DESC`).all();
    res.json({
      vehicles: count('SELECT COUNT(*) AS n FROM vehicles'),
      fitment_rows: count('SELECT COUNT(*) AS n FROM fitment_reference'),
      shops: count('SELECT COUNT(*) AS n FROM shops'),
      garages: count('SELECT COUNT(*) AS n FROM garages'),
      live_listings: count('SELECT COUNT(*) AS n FROM shop_listings WHERE stock_quantity > 0 AND hidden = 0'),
      pending_applications: count("SELECT COUNT(*) AS n FROM business_applications WHERE status = 'pending'"),
      pending_part_requests: count("SELECT COUNT(*) AS n FROM listing_requests WHERE status = 'pending'"),
      reviews: count('SELECT COUNT(*) AS n FROM reviews'),
      open_reports: count("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"),
      suspended: count('SELECT COUNT(*) AS n FROM shops WHERE suspended = 1') + count('SELECT COUNT(*) AS n FROM garages WHERE suspended = 1'),
      customers: count("SELECT COUNT(*) AS n FROM users WHERE role = 'customer'"),
      bookings: count('SELECT COUNT(*) AS n FROM bookings'),
      open_gaps: count('SELECT COUNT(*) AS n FROM search_gaps'),
      vehicles_by_make: tally('make'),
      vehicles_by_origin_market: tally('origin_market'),
      vehicles_by_import_source: tally('import_source'),
    });
  });

  const fitmentInput = (b) => {
    const category = getCategory(String(b.part_category || ''));
    if (!category) throw new HttpError(400, `"${b.part_category || ''}" is not a part in the list. Use the exact name, for example "Front Brake Pad".`);
    if (category.type !== 'model_specific') {
      throw new HttpError(400, `${category.name} is sold by size, not by part number, so it does not need one.`);
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
    const values = fitmentInput(req.body || {});
    // The same number for the same car already there (for example a post that failed and was
    // sent again): hand back that row instead of adding a copy.
    const same = db.prepare(`SELECT * FROM fitment_reference WHERE oe_number = ? AND part_category = ? AND make = ? AND model = ?
      AND generation IS ? AND year_start = ? AND year_end = ? AND engine IS ? AND origin_market IS ? LIMIT 1`).get(...values.slice(0, 9));
    if (same) return res.json({ row: same, existing: true });
    const info = db.prepare(`INSERT INTO fitment_reference
      (oe_number, part_category, make, model, generation, year_start, year_end, engine, origin_market,
       confidence_level, source, verified_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values);
    const row = db.prepare('SELECT * FROM fitment_reference WHERE id = ?').get(Number(info.lastInsertRowid));
    logAdmin(req, 'Added a part number', 'part_number', row.id, `${row.oe_number} for ${row.make} ${row.model}`);
    res.status(201).json({ row: db.prepare('SELECT * FROM fitment_reference WHERE id = ?').get(Number(info.lastInsertRowid)) });
  });
  // A spreadsheet of part numbers (columns in lib/fitmentcsv.js). Every row is checked like the
  // form checks one; good rows are added, numbers already there for that car are skipped, and
  // each bad row comes back with its line number. dry_run checks without saving.
  admin.post('/fitment-reference/import', (req, res) => {
    const { csv, dry_run: dryRun } = req.body || {};
    if (typeof csv !== 'string' || !csv.trim()) throw new HttpError(400, 'Choose a CSV file with a header row.');
    const rows = csvToFitment(csv);
    if (!rows.length) throw new HttpError(400, 'The file has a header but no rows.');
    if (rows.length > 5000) throw new HttpError(413, 'Import at most 5,000 rows at a time. Split the file.');
    const errors = [];
    let added = 0;
    let skipped = 0;
    db.exec('BEGIN');
    try {
      for (const { line, body } of rows) {
        let values;
        try { values = fitmentInput(body); } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          errors.push({ line, message: err.message });
          continue;
        }
        if (addFitmentIfNew(db, values)) added++; else skipped++;
      }
      db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    if (!dryRun && added) logAdmin(req, 'Imported part numbers', 'part_number', null, `${added} added from a spreadsheet`);
    res.json({ rows: rows.length, added, skipped, errors: errors.slice(0, 200), error_count: errors.length, dry_run: !!dryRun });
  });
  admin.put('/fitment-reference/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM fitment_reference WHERE id = ?').get(id)) throw new HttpError(404, 'Row not found.');
    db.prepare(`UPDATE fitment_reference SET oe_number=?, part_category=?, make=?, model=?, generation=?,
      year_start=?, year_end=?, engine=?, origin_market=?, confidence_level=?, source=?, verified_by=? WHERE id = ?`)
      .run(...fitmentInput(req.body || {}), id);
    logAdmin(req, 'Changed a part number', 'part_number', id, db.prepare('SELECT oe_number FROM fitment_reference WHERE id = ?').get(id).oe_number);
    res.json({ row: db.prepare('SELECT * FROM fitment_reference WHERE id = ?').get(id) });
  });
  admin.delete('/fitment-reference/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM fitment_reference WHERE id = ?').get(Number(req.params.id));
    db.prepare('DELETE FROM fitment_reference WHERE id = ?').run(Number(req.params.id));
    if (row) logAdmin(req, 'Deleted a part number', 'part_number', row.id, `${row.oe_number} for ${row.make} ${row.model}`);
    res.json({ ok: true });
  });

  // Each shop and garage with its scorecard: rating, bookings, cancellations, open reports and
  // when its owner last signed in. flags name what needs the admin's attention.
  const daysSince = (ts) => (ts ? (Date.now() - new Date(String(ts).replace(' ', 'T') + 'Z').getTime()) / 864e5 : null);
  function flagsFor(x) {
    const flags = [];
    if (x.suspended) flags.push('Suspended');
    if (x.open_reports) flags.push(`${x.open_reports} open ${x.open_reports === 1 ? 'report' : 'reports'}`);
    if (x.review_count >= 3 && x.rating < 3.5) flags.push('Low rating');
    if (x.bookings >= 5 && x.cancelled / x.bookings > 0.2) flags.push('Many cancellations');
    if (x.last_active && daysSince(x.last_active) > 30) flags.push('Not signed in for 30 days');
    return flags;
  }
  const scorecard = (x) => ({ ...x, vetted: x.vetted == null ? undefined : !!x.vetted, suspended: !!x.suspended,
    cancel_rate: x.bookings ? Math.round((x.cancelled / x.bookings) * 100) : null, flags: flagsFor(x) });

  admin.get('/shops', (req, res) => {
    res.json({ shops: db.prepare(`SELECT s.*,
      (SELECT email FROM users u WHERE u.shop_id = s.id LIMIT 1) AS login_email,
      (SELECT MAX(last_login_at) FROM users u WHERE u.shop_id = s.id) AS last_active,
      (SELECT ROUND(AVG(rating), 1) FROM reviews r WHERE r.shop_id = s.id) AS rating,
      (SELECT COUNT(*) FROM reviews r WHERE r.shop_id = s.id) AS review_count,
      (SELECT COUNT(*) FROM bookings b JOIN shop_listings l ON l.id = b.shop_listing_id WHERE l.shop_id = s.id) AS bookings,
      (SELECT COUNT(*) FROM bookings b JOIN shop_listings l ON l.id = b.shop_listing_id WHERE l.shop_id = s.id AND b.shop_status = 'cancelled') AS cancelled,
      (SELECT COUNT(*) FROM reports p WHERE p.shop_id = s.id AND p.status = 'open') AS open_reports,
      (SELECT COUNT(*) FROM shop_listings l WHERE l.shop_id = s.id AND l.hidden = 0 AND l.stock_quantity > 0) AS parts_on_sale
      FROM shops s ORDER BY s.id`).all().map(scorecard) });
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
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(Number(info.lastInsertRowid));
    logAdmin(req, 'Added a shop', 'shop', shop.id, shop.name);
    res.status(201).json({ shop });
  });

  /** The admin edits any detail of a shop or garage, including the name and map location that
   *  the business itself cannot change. Only the fields sent are changed. */
  function editBusiness(table, req) {
    const id = Number(req.params.id);
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404, table === 'shops' ? 'Shop not found.' : 'Garage not found.');
    const b = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    const updates = {};
    if (has('name')) updates.name = text(b.name, { field: 'Name', max: 80, required: true });
    if (has('phone')) updates.phone = phone(b.phone, 'Phone');
    if (has('whatsapp_number')) updates.whatsapp_number = phone(b.whatsapp_number, 'WhatsApp', false);
    if (has('address_text')) updates.address_text = text(b.address_text, { field: 'Address', max: 120 });
    if (has('opening_hours')) updates.opening_hours = text(b.opening_hours, { field: 'Opening hours', max: 120 });
    if (has('latitude')) updates.latitude = number(b.latitude, { field: 'Latitude', min: -90, max: 90 });
    if (has('longitude')) updates.longitude = number(b.longitude, { field: 'Longitude', min: -180, max: 180 });
    if (table === 'shops' && has('vetted')) updates.vetted = b.vetted ? 1 : 0;
    if (table === 'garages' && has('specialties')) updates.specialties = text(b.specialties, { field: 'What they are good at', max: 160 });
    updateRow(table, id, updates);
    const changed = Object.keys(updates).filter((k) => updates[k] !== row[k]);
    if (changed.length) {
      const what = changed.map((k) => ({ vetted: updates.vetted ? 'marked vetted' : 'marked not vetted', latitude: 'location', longitude: 'location', whatsapp_number: 'WhatsApp', address_text: 'address', opening_hours: 'opening hours' }[k] || k));
      logAdmin(req, table === 'shops' ? 'Edited a shop' : 'Edited a garage', table.slice(0, -1), id, `${updates.name || row.name}: ${[...new Set(what)].join(', ')}`);
    }
    return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  }
  admin.put('/shops/:id', (req, res) => res.json({ shop: editBusiness('shops', req) }));
  admin.put('/garages/:id', (req, res) => res.json({ garage: editBusiness('garages', req) }));

  // Suspending hides a shop's parts (or a garage) from customers until it is reactivated. The
  // owner can still sign in and sees the reason on their dashboard.
  function setSuspended(table, req, suspend) {
    const id = Number(req.params.id);
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404, table === 'shops' ? 'Shop not found.' : 'Garage not found.');
    const reason = suspend ? text((req.body || {}).reason, { field: 'Reason', max: 300, required: true }) : null;
    db.prepare(`UPDATE ${table} SET suspended = ?, suspended_reason = ? WHERE id = ?`).run(suspend ? 1 : 0, reason, id);
    const kind = table === 'shops' ? 'shop' : 'garage';
    logAdmin(req, suspend ? `Suspended a ${kind}` : `Reactivated a ${kind}`, kind, id, suspend ? `${row.name}: ${reason}` : row.name);
    return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  }
  admin.post('/shops/:id/suspend', (req, res) => res.json({ shop: setSuspended('shops', req, true) }));
  admin.post('/shops/:id/reactivate', (req, res) => res.json({ shop: setSuspended('shops', req, false) }));
  admin.post('/garages/:id/suspend', (req, res) => res.json({ garage: setSuspended('garages', req, true) }));
  admin.post('/garages/:id/reactivate', (req, res) => res.json({ garage: setSuspended('garages', req, false) }));

  admin.get('/garages', (req, res) => {
    res.json({ garages: db.prepare(`SELECT g.*,
      (SELECT email FROM users u WHERE u.garage_id = g.id LIMIT 1) AS login_email,
      (SELECT MAX(last_login_at) FROM users u WHERE u.garage_id = g.id) AS last_active,
      (SELECT ROUND(AVG(rating), 1) FROM reviews r WHERE r.garage_id = g.id) AS rating,
      (SELECT COUNT(*) FROM reviews r WHERE r.garage_id = g.id) AS review_count,
      (SELECT COUNT(*) FROM bookings b WHERE b.garage_id = g.id) AS bookings,
      (SELECT COUNT(*) FROM bookings b WHERE b.garage_id = g.id AND b.garage_status = 'declined') AS cancelled,
      (SELECT COUNT(*) FROM reports p WHERE p.garage_id = g.id AND p.status = 'open') AS open_reports,
      (SELECT COUNT(*) FROM garage_services v WHERE v.garage_id = g.id) AS services
      FROM garages g ORDER BY g.id`).all().map(scorecard) });
  });
  admin.post('/garages', (req, res) => {
    const b = req.body || {};
    const info = db.prepare(`INSERT INTO garages (name, phone, whatsapp_number, latitude, longitude, address_text, specialties)
      VALUES (?,?,?,?,?,?,?)`).run(
      text(b.name, { field: 'name', max: 80, required: true }), phone(b.phone, 'phone'),
      phone(b.whatsapp_number, 'whatsapp_number', false),
      number(b.latitude, { field: 'latitude', min: -90, max: 90 }), number(b.longitude, { field: 'longitude', min: -180, max: 180 }),
      text(b.address_text, { field: 'address', max: 120 }), text(b.specialties, { field: 'specialties', max: 160 }));
    const garage = db.prepare('SELECT * FROM garages WHERE id = ?').get(Number(info.lastInsertRowid));
    logAdmin(req, 'Added a garage', 'garage', garage.id, garage.name);
    res.status(201).json({ garage });
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
      logAdmin(req, 'Corrected a car', 'car', existing.id, `${plate}: ${year} ${make} ${model}`);
      return res.json({ vehicle: db.prepare('SELECT * FROM vehicles WHERE id = ?').get(existing.id), updated: true });
    }
    const info = db.prepare(`INSERT INTO vehicles
      (plate_number, vin, wmi_code, make, model, generation, year, engine, transmission, origin_market,
       drive_side, import_source, registered_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      plate, vin, wmi, make, model, generation, year, engine, transmission, originMarket, 'LHD', importSource, 'admin');
    logAdmin(req, 'Added a car', 'car', Number(info.lastInsertRowid), `${plate}: ${year} ${make} ${model}`);
    res.status(201).json({ vehicle: db.prepare('SELECT * FROM vehicles WHERE id = ?').get(Number(info.lastInsertRowid)), updated: false });
  });

  admin.delete('/vehicles/:id', (req, res) => {
    const id = Number(req.params.id);
    const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id);
    if (!vehicle) throw new HttpError(404, 'Car not found.');
    const bookingCount = db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE vehicle_id = ?').get(id).n;
    if (bookingCount > 0) throw new HttpError(409, 'This car has booking history, so it cannot be deleted.');
    db.prepare('DELETE FROM vehicles WHERE id = ?').run(id);
    logAdmin(req, 'Deleted a car', 'car', id, `${vehicle.plate_number || vehicle.vin || ''}: ${vehicle.year} ${vehicle.make} ${vehicle.model}`);
    res.json({ ok: true });
  });

  // Where a booking is: 'cancelled' (by the shop, the garage or vinzuu), 'finished' (every side
  // it has is done) or 'open'.
  const stageOf = (b) => {
    if (b.status === 'cancelled' || b.shop_status === 'cancelled' || b.garage_status === 'declined') return 'cancelled';
    const shopDone = !b.shop_id || b.shop_status === 'collected';
    const garageDone = !b.garage_id || b.garage_status === 'done';
    return shopDone && garageDone ? 'finished' : 'open';
  };
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  function adminBookings(q) {
    const from = DATE.test(q.from || '') ? q.from : null;
    const to = DATE.test(q.to || '') ? q.to : null;
    const shopId = q.shop_id ? Number(q.shop_id) : null;
    const garageId = q.garage_id ? Number(q.garage_id) : null;
    const rows = db.prepare(`${bookingSelect}
      WHERE (? IS NULL OR date(b.created_at) >= ?) AND (? IS NULL OR date(b.created_at) <= ?)
        AND (? IS NULL OR s.id = ?) AND (? IS NULL OR g.id = ?)
      ORDER BY b.id DESC LIMIT 1000`).all(from, from, to, to, shopId, shopId, garageId, garageId)
      .map((b) => ({ ...b, stage: stageOf(b) }));
    const stage = ['open', 'finished', 'cancelled'].includes(q.stage) ? q.stage : null;
    const needle = String(q.q || '').trim().toLowerCase();
    return rows.filter((b) => (!stage || b.stage === stage)
      && (!needle || [b.customer_phone, b.plate_number, b.make, b.model, b.part_category, b.oe_number, b.shop_name, b.garage_name]
        .some((x) => String(x || '').toLowerCase().includes(needle))));
  }
  admin.get('/bookings', (req, res) => {
    res.json({ bookings: adminBookings(req.query) });
  });
  // The admin can cancel a booking (for example after a report) with a reason that both the
  // customer and the business see. Sides that are already finished are left as they are.
  admin.post('/bookings/:id/cancel', (req, res) => {
    const row = db.prepare(`${bookingSelect} WHERE b.id = ?`).get(Number(req.params.id));
    if (!row) throw new HttpError(404, 'Booking not found.');
    if (stageOf(row) !== 'open') throw new HttpError(409, `This booking is already ${stageOf(row)}.`);
    const reason = text((req.body || {}).reason, { field: 'Reason', max: 300, required: true });
    tx(db, () => {
      db.prepare("UPDATE bookings SET status = 'cancelled', admin_note = ? WHERE id = ?").run(reason, row.id);
      if (row.shop_id && row.shop_status !== 'collected') db.prepare("UPDATE bookings SET shop_status = 'cancelled' WHERE id = ?").run(row.id);
      if (row.garage_id && row.garage_status !== 'done') {
        db.prepare("UPDATE bookings SET garage_status = 'declined', garage_note = ? WHERE id = ?").run(`Cancelled by vinzuu: ${reason}`, row.id);
      }
    });
    logAdmin(req, 'Cancelled a booking', 'booking', row.id, `${row.part_category || 'Repair'} for ${row.year} ${row.make} ${row.model}: ${reason}`);
    res.json({ booking: { ...db.prepare(`${bookingSelect} WHERE b.id = ?`).get(row.id), stage: 'cancelled' } });
  });

  // ----- customers and other accounts -----

  admin.get('/users', (req, res) => {
    const q = `%${String(req.query.q || '').trim()}%`;
    const role = ['customer', 'business', 'admin'].includes(req.query.role) ? req.query.role : null;
    const rows = db.prepare(`SELECT u.id, u.name, u.email, u.phone, u.role, u.auth_provider, u.blocked, u.blocked_reason,
        u.created_at, u.last_login_at, s.name AS shop_name, g.name AS garage_name,
        (SELECT COUNT(*) FROM vehicles v WHERE v.user_id = u.id) AS cars,
        (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id) AS bookings,
        (SELECT COUNT(*) FROM reports r WHERE r.user_id = u.id) AS reports
      FROM users u LEFT JOIN shops s ON s.id = u.shop_id LEFT JOIN garages g ON g.id = u.garage_id
      WHERE (? IS NULL OR u.role = ?) AND (u.name LIKE ? OR u.email LIKE ? OR COALESCE(u.phone, '') LIKE ?)
      ORDER BY u.id DESC LIMIT 500`).all(role, role, q, q, q);
    res.json({ users: rows.map((u) => ({ ...u, blocked: !!u.blocked })) });
  });
  function setBlocked(req, block) {
    const user = getUserById(Number(req.params.id));
    if (!user) throw new HttpError(404, 'Account not found.');
    if (block && roleOf(user) === 'admin') throw new HttpError(409, 'An admin account cannot be blocked here.');
    const reason = block ? text((req.body || {}).reason, { field: 'Reason', max: 300, required: true }) : null;
    db.prepare('UPDATE users SET blocked = ?, blocked_reason = ? WHERE id = ?').run(block ? 1 : 0, reason, user.id);
    logAdmin(req, block ? 'Blocked an account' : 'Unblocked an account', 'user', user.id, block ? `${user.email}: ${reason}` : user.email);
    return { ok: true };
  }
  admin.post('/users/:id/block', (req, res) => res.json(setBlocked(req, true)));
  admin.post('/users/:id/unblock', (req, res) => res.json(setBlocked(req, false)));

  // ----- reports from customers -----

  admin.get('/reports', (req, res) => {
    const status = ['open', 'closed'].includes(req.query.status) ? req.query.status : null;
    const rows = db.prepare(`SELECT p.*, u.name AS user_name, u.email AS user_email, u.phone AS user_phone,
        s.name AS shop_name, s.suspended AS shop_suspended, g.name AS garage_name, g.suspended AS garage_suspended,
        l.part_category, l.oe_number, l.universal_spec, l.photo_url, l.hidden AS listing_hidden
      FROM reports p LEFT JOIN users u ON u.id = p.user_id LEFT JOIN shops s ON s.id = p.shop_id
      LEFT JOIN garages g ON g.id = p.garage_id LEFT JOIN shop_listings l ON l.id = p.listing_id
      WHERE (? IS NULL OR p.status = ?) ORDER BY p.status = 'open' DESC, p.id DESC LIMIT 300`).all(status, status);
    res.json({ reasons: REPORT_REASONS, reports: rows.map((r) => ({ ...r, shop_suspended: !!r.shop_suspended,
      garage_suspended: !!r.garage_suspended, listing_hidden: r.listing_id ? !!r.listing_hidden : null })) });
  });
  admin.post('/reports/:id/close', (req, res) => {
    const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(Number(req.params.id));
    if (!r) throw new HttpError(404, 'Report not found.');
    if (r.status === 'closed') throw new HttpError(409, 'This report is already closed.');
    const note = text((req.body || {}).admin_note, { field: 'What you did', max: 300, required: true });
    db.prepare("UPDATE reports SET status = 'closed', admin_note = ?, closed_at = datetime('now') WHERE id = ?").run(note, r.id);
    logAdmin(req, 'Closed a report', 'report', r.id, `${REPORT_REASONS[r.reason] || r.reason}: ${note}`);
    res.json({ ok: true });
  });

  // ----- activity over time, for the overview charts -----

  admin.get('/activity', (req, res) => {
    const weeks = Math.min(26, Math.max(4, Number(req.query.weeks) || 12));
    // Weeks start on Monday (UTC). The last bucket is the current, unfinished week.
    const now = new Date();
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));
    const starts = Array.from({ length: weeks }, (_, i) => new Date(monday.getTime() - (weeks - 1 - i) * 7 * 864e5).toISOString().slice(0, 10));
    const since = starts[0];
    const bucket = (sql) => {
      const counts = new Array(weeks).fill(0);
      for (const { d } of db.prepare(sql).all(since)) {
        const i = starts.findLastIndex((w) => d >= w);
        if (i >= 0) counts[i] += 1;
      }
      return counts;
    };
    const bookings = bucket('SELECT date(created_at) AS d FROM bookings WHERE date(created_at) >= ?');
    const cars = bucket('SELECT date(created_at) AS d FROM vehicles WHERE date(created_at) >= ?');
    const customers = bucket("SELECT date(created_at) AS d FROM users WHERE role = 'customer' AND date(created_at) >= ?");
    res.json({
      weeks: starts.map((week_start, i) => ({ week_start, bookings: bookings[i], cars: cars[i], customers: customers[i] })),
      top_parts: db.prepare(`SELECT l.part_category AS label, COUNT(*) AS n FROM bookings b JOIN shop_listings l ON l.id = b.shop_listing_id
        WHERE date(b.created_at) >= ? GROUP BY 1 ORDER BY n DESC, label LIMIT 6`).all(since),
      top_shops: db.prepare(`SELECT s.name AS label, COUNT(*) AS n FROM bookings b JOIN shop_listings l ON l.id = b.shop_listing_id
        JOIN shops s ON s.id = l.shop_id WHERE date(b.created_at) >= ? GROUP BY s.id ORDER BY n DESC, label LIMIT 6`).all(since),
      top_missing: db.prepare(`SELECT part_category || ' for ' || make || ' ' || model AS label, SUM(times_searched) AS n FROM search_gaps
        GROUP BY part_category, make, model ORDER BY n DESC, label LIMIT 6`).all(),
    });
  });

  // ----- the admin log -----

  admin.get('/log', (req, res) => {
    const type = String(req.query.type || '') || null;
    res.json({ log: db.prepare('SELECT * FROM admin_log WHERE (? IS NULL OR target_type = ?) ORDER BY id DESC LIMIT 500').all(type, type) });
  });

  // ----- CSV downloads (they open in Excel) -----

  const csvCell = (v) => {
    if (v == null) return '';
    const str = String(v);
    // A leading = + - @ would run as a formula in Excel, so it is quoted with a ' in front.
    const safe = /^[=+\-@]/.test(str) && !/^-?\d+(\.\d+)?$/.test(str) ? `'${str}` : str;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const EXPORTS = {
    bookings: () => adminBookings({}).map((b) => ({
      id: b.id, created_at: b.created_at, stage: b.stage, customer_phone: b.customer_phone,
      car: `${b.year} ${b.make} ${b.model}${b.generation ? ` ${b.generation}` : ''}`, plate: b.plate_number, part: b.part_category,
      part_number: b.oe_number || b.universal_spec, price_rwf: b.price_rwf, shop: b.shop_name, shop_status: b.shop_id ? b.shop_status : null,
      garage: b.garage_name, garage_status: b.garage_id ? b.garage_status : null, garage_time: b.garage_time, note: b.note, vinzuu_note: b.admin_note,
    })),
    parts: () => db.prepare(`SELECT l.id, s.name AS shop, l.part_category AS part, l.oe_number AS part_number, l.universal_spec AS size,
      l.brand, l.condition, l.price_rwf, l.stock_quantity, l.warranty_months, l.hidden, l.description, l.updated_at
      FROM shop_listings l JOIN shops s ON s.id = l.shop_id ORDER BY s.name, l.part_category`).all(),
    'part-numbers': () => db.prepare(`SELECT oe_number, part_category AS part, make, model, generation, year_start AS year_from,
      year_end AS year_to, engine, origin_market AS built_in, confidence_level AS confidence, source, verified_by
      FROM fitment_reference ORDER BY make, model, part_category, year_start`).all(),
    cars: () => db.prepare(`SELECT id, plate_number, vin, make, model, generation, year, engine, transmission, origin_market,
      import_source, registered_by, created_at FROM vehicles ORDER BY id`).all(),
    shops: () => db.prepare('SELECT id, name, phone, whatsapp_number, address_text, latitude, longitude, vetted, suspended, suspended_reason, created_at FROM shops ORDER BY id').all(),
    garages: () => db.prepare('SELECT id, name, phone, whatsapp_number, address_text, latitude, longitude, specialties, suspended, suspended_reason FROM garages ORDER BY id').all(),
    customers: () => db.prepare(`SELECT id, name, email, phone, role, blocked, created_at, last_login_at FROM users ORDER BY id`).all(),
    reviews: () => db.prepare(`SELECT r.id, r.created_at, r.target, COALESCE(s.name, g.name) AS business, r.rating, r.author_name, r.comment, r.reply
      FROM reviews r LEFT JOIN shops s ON s.id = r.shop_id LEFT JOIN garages g ON g.id = r.garage_id ORDER BY r.id`).all(),
    reports: () => db.prepare(`SELECT p.id, p.created_at, p.status, p.target, COALESCE(s.name, g.name) AS business, p.reason, p.details,
      p.admin_note, p.closed_at FROM reports p LEFT JOIN shops s ON s.id = p.shop_id LEFT JOIN garages g ON g.id = p.garage_id ORDER BY p.id`).all(),
  };
  admin.get('/export/:what', (req, res) => {
    const what = String(req.params.what).replace(/\.csv$/, '');
    if (!EXPORTS[what]) throw new HttpError(404, `Nothing to download called ${what}.`);
    const rows = EXPORTS[what]();
    const cols = rows.length ? Object.keys(rows[0]) : ['no_rows'];
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
    logAdmin(req, 'Downloaded a CSV', 'export', null, `${what} (${rows.length} rows)`);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="vinzuu-${what}-${new Date().toISOString().slice(0, 10)}.csv"` });
    // The byte-order mark makes Excel read the file as UTF-8 (names with accents stay right).
    res.send('﻿' + csv + '\r\n');
  });

  // ----- applications to join Vinzuu Sellers & Garages -----

  admin.get('/applications', (req, res) => {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
    const rows = db.prepare(`SELECT * FROM business_applications WHERE (? IS NULL OR status = ?)
      ORDER BY status = 'pending' DESC, id DESC LIMIT 200`).all(status, status);
    res.json({ applications: rows.map(({ password_hash, ...a }) => a) });
  });
  const pendingApplication = (id) => {
    const a = db.prepare('SELECT * FROM business_applications WHERE id = ?').get(Number(id));
    if (!a) throw new HttpError(404, 'Application not found.');
    if (a.status !== 'pending') throw new HttpError(409, `This application was already ${a.status}.`);
    return a;
  };
  // Approving creates the shop and/or garage and the owner's account, with the password they
  // chose when applying. An existing customer account with that email becomes the business account.
  admin.post('/applications/:id/approve', (req, res) => {
    const a = pendingApplication(req.params.id);
    const b = req.body || {};
    const kind = b.kind ? oneOf(b.kind, APPLICATION_KINDS, 'business type') : a.kind;
    const vetted = b.vetted === false ? 0 : 1;
    const out = tx(db, () => {
      let shopId = null;
      let garageId = null;
      if (kind !== 'garage') {
        let code;
        do { code = String(crypto.randomInt(100000, 1000000)); }
        while (db.prepare('SELECT 1 FROM shops WHERE access_code = ?').get(code));
        shopId = Number(db.prepare(`INSERT INTO shops
          (name, phone, whatsapp_number, latitude, longitude, address_text, vetted, access_code, onboarded_by)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(a.business_name, a.phone, a.whatsapp_number, a.latitude, a.longitude,
          a.address_text, vetted, code, 'application').lastInsertRowid);
      }
      if (kind !== 'shop') {
        garageId = Number(db.prepare(`INSERT INTO garages (name, phone, whatsapp_number, latitude, longitude, address_text, specialties)
          VALUES (?,?,?,?,?,?,?)`).run(a.business_name, a.phone, a.whatsapp_number, a.latitude, a.longitude,
          a.address_text, a.specialties).lastInsertRowid);
      }
      const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(a.email);
      if (existing) {
        if (roleOf(existing) !== 'customer') throw new HttpError(409, 'This email already has a business or admin account.');
        db.prepare("UPDATE users SET role = 'business', shop_id = ?, garage_id = ? WHERE id = ?").run(shopId, garageId, existing.id);
      } else {
        db.prepare(`INSERT INTO users (name, email, phone, password_hash, auth_provider, role, shop_id, garage_id)
          VALUES (?,?,?,?,'local','business',?,?)`).run(a.owner_name, a.email, a.phone, a.password_hash, shopId, garageId);
      }
      db.prepare(`UPDATE business_applications SET status = 'approved', kind = ?, shop_id = ?, garage_id = ?, admin_note = ?,
        decided_at = datetime('now') WHERE id = ?`).run(kind, shopId, garageId, text(b.admin_note, { field: 'Note', max: 300 }), a.id);
      logAdmin(req, 'Approved an application', 'application', a.id, `${a.business_name} as ${{ shop: 'a shop', garage: 'a garage', both: 'a shop and a garage' }[kind]}`);
      return { shop_id: shopId, garage_id: garageId, existing_account: !!existing };
    });
    res.json(out);
  });
  admin.post('/applications/:id/reject', (req, res) => {
    const a = pendingApplication(req.params.id);
    const reason = text((req.body || {}).admin_note, { field: 'Reason', max: 300, required: true });
    db.prepare("UPDATE business_applications SET status = 'rejected', admin_note = ?, decided_at = datetime('now') WHERE id = ?").run(reason, a.id);
    logAdmin(req, 'Rejected an application', 'application', a.id, `${a.business_name}: ${reason}`);
    res.json({ ok: true });
  });

  // ----- parts for sale: only an admin posts them -----

  admin.get('/oe-numbers', oeNumberRows);

  const adminListing = (id) => db.prepare(`
    SELECT l.*, s.name AS shop_name FROM shop_listings l JOIN shops s ON s.id = l.shop_id WHERE l.id = ?`).get(id);

  admin.get('/listings', (req, res) => {
    const shopId = req.query.shop_id ? Number(req.query.shop_id) : null;
    res.json({
      listings: db.prepare(`
        SELECT l.*, s.name AS shop_name FROM shop_listings l JOIN shops s ON s.id = l.shop_id
        WHERE (? IS NULL OR l.shop_id = ?) ORDER BY l.updated_at DESC, l.id DESC LIMIT 500`).all(shopId, shopId)
        .map((l) => ({ ...l, hidden: !!l.hidden })),
    });
  });
  admin.post('/listings', (req, res) => {
    const b = req.body || {};
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(Number(b.shop_id));
    if (!shop) throw new HttpError(400, 'Choose the shop that has this part.');
    const listing = adminListing(insertListing(shop.id, partFields(b)));
    logAdmin(req, 'Posted a part', 'part', listing.id, `${listing.part_category} ${listing.oe_number || listing.universal_spec || ''} at ${shop.name}`);
    res.status(201).json({ listing });
  });
  admin.put('/listings/:id', (req, res) => {
    const listing = db.prepare('SELECT * FROM shop_listings WHERE id = ?').get(Number(req.params.id));
    if (!listing) throw new HttpError(404, 'Part not found.');
    const b = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    db.prepare(`UPDATE shop_listings SET price_rwf = ?, stock_quantity = ?, condition = ?, photo_url = ?, brand = ?,
      description = ?, warranty_months = ?, hidden = ?, updated_at = datetime('now') WHERE id = ?`).run(
      has('price_rwf') ? integer(b.price_rwf, { field: 'Price', min: 1, max: 100_000_000 }) : listing.price_rwf,
      has('stock_quantity') ? integer(b.stock_quantity, { field: 'Stock', min: 0, max: 10_000 }) : listing.stock_quantity,
      has('condition') ? oneOf(b.condition, ['genuine', 'aftermarket'], 'condition') : listing.condition,
      has('photo_url') ? photoUrl(b.photo_url) : listing.photo_url,
      has('brand') ? text(b.brand, { field: 'Brand', max: 60 }) : listing.brand,
      has('description') ? text(b.description, { field: 'Description', max: 600 }) : listing.description,
      has('warranty_months') ? integer(b.warranty_months, { field: 'Warranty (months)', min: 0, max: 120, required: false }) : listing.warranty_months,
      has('hidden') ? (b.hidden ? 1 : 0) : listing.hidden, listing.id);
    const after = adminListing(listing.id);
    const name = `${after.part_category} ${after.oe_number || after.universal_spec || ''} at ${after.shop_name}`;
    if (has('hidden') && !!b.hidden !== !!listing.hidden) logAdmin(req, b.hidden ? 'Hid a part' : 'Showed a part again', 'part', listing.id, name);
    if (Object.keys(b).some((k) => k !== 'hidden')) logAdmin(req, 'Edited a part', 'part', listing.id, name);
    res.json({ listing: after });
  });
  admin.delete('/listings/:id', (req, res) => {
    const id = Number(req.params.id);
    const gone = adminListing(id);
    if (!gone) throw new HttpError(404, 'Part not found.');
    // Old bookings keep their row but no longer point at the removed part.
    tx(db, () => {
      db.prepare('UPDATE bookings SET shop_listing_id = NULL WHERE shop_listing_id = ?').run(id);
      db.prepare('UPDATE listing_requests SET listing_id = NULL WHERE listing_id = ?').run(id);
      db.prepare('UPDATE reports SET listing_id = NULL WHERE listing_id = ?').run(id);
      db.prepare('DELETE FROM shop_listings WHERE id = ?').run(id);
    });
    logAdmin(req, 'Deleted a part', 'part', id, `${gone.part_category} ${gone.oe_number || gone.universal_spec || ''} at ${gone.shop_name}`);
    res.json({ ok: true });
  });

  admin.get('/listing-requests', (req, res) => {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
    res.json({
      requests: db.prepare(`
        SELECT r.*, s.name AS shop_name, s.vetted AS shop_vetted FROM listing_requests r JOIN shops s ON s.id = r.shop_id
        WHERE (? IS NULL OR r.status = ?) ORDER BY r.status = 'pending' DESC, r.id DESC LIMIT 200`).all(status, status),
    });
  });
  const pendingRequest = (id) => {
    const r = db.prepare('SELECT * FROM listing_requests WHERE id = ?').get(Number(id));
    if (!r) throw new HttpError(404, 'Request not found.');
    if (r.status !== 'pending') throw new HttpError(409, `This request was already ${r.status}.`);
    return r;
  };
  // Approving posts the part. The admin can correct any detail while approving.
  admin.post('/listing-requests/:id/approve', (req, res) => {
    const r = pendingRequest(req.params.id);
    const b = req.body || {};
    const p = partFields({ ...r, ...Object.fromEntries(
      ['price_rwf', 'stock_quantity', 'condition', 'brand', 'description', 'warranty_months'].filter((k) => k in b).map((k) => [k, b[k]])) });
    const id = tx(db, () => {
      const listingId = insertListing(r.shop_id, p);
      db.prepare(`UPDATE listing_requests SET status = 'approved', listing_id = ?, admin_note = ?, decided_at = datetime('now') WHERE id = ?`)
        .run(listingId, text(b.admin_note, { field: 'Note', max: 300 }), r.id);
      return listingId;
    });
    const posted = adminListing(id);
    logAdmin(req, 'Approved a part request', 'part', id, `${posted.part_category} ${posted.oe_number || posted.universal_spec || ''} at ${posted.shop_name}`);
    res.json({ listing: posted });
  });
  admin.post('/listing-requests/:id/reject', (req, res) => {
    const r = pendingRequest(req.params.id);
    const reason = text((req.body || {}).admin_note, { field: 'Reason', max: 300, required: true });
    db.prepare(`UPDATE listing_requests SET status = 'rejected', admin_note = ?, decided_at = datetime('now') WHERE id = ?`).run(reason, r.id);
    logAdmin(req, 'Rejected a part request', 'part_request', r.id, `${r.part_category} ${r.oe_number || r.universal_spec || ''}: ${reason}`);
    res.json({ request: db.prepare('SELECT * FROM listing_requests WHERE id = ?').get(r.id) });
  });

  // ----- reviews: the admin can remove an abusive one -----

  admin.get('/reviews', (req, res) => {
    res.json({
      reviews: db.prepare(`
        SELECT r.*, s.name AS shop_name, g.name AS garage_name FROM reviews r
        LEFT JOIN shops s ON s.id = r.shop_id LEFT JOIN garages g ON g.id = r.garage_id
        ORDER BY r.id DESC LIMIT 300`).all(),
    });
  });
  admin.delete('/reviews/:id', (req, res) => {
    const review = db.prepare('SELECT * FROM reviews WHERE id = ?').get(Number(req.params.id));
    if (!review) throw new HttpError(404, 'Review not found.');
    db.prepare('DELETE FROM reviews WHERE id = ?').run(review.id);
    logAdmin(req, 'Removed a review', 'review', review.id, `${review.rating} stars by ${review.author_name}: ${review.comment || 'no comment'}`);
    res.json({ ok: true });
  });

  app.use('/api/admin', admin);

  // =====================  static files + errors  =====================

  app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route.' }));
  // "/" serves welcome.html (sign in / create account) rather than the plate-finder app directly,
  // so every visitor lands on the account page first. /index.html is still reachable directly.
  // The photo lookup also runs in the browser when this server can't reach Wikipedia.
  app.get('/carphotos.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'lib', 'carphotos.js')));
  // Signed in, "/" (and the logo) is your own home, the garage. The public homepage's sections
  // stay reachable at /welcome.html, which the nav links point to for signed-in visitors.
  // A shop owner's home is their shop dashboard, and an admin's is the admin console.
  app.get('/', (req, res, next) => (req.userId ? res.redirect(302, homeFor(getUserById(req.userId))) : next()));
  // The old shop console is now part of Vinzuu Sellers & Garages.
  app.get('/shop.html', (req, res) => res.redirect(301, '/business.html'));
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

/** ADMIN_EMAIL + ADMIN_PASSWORD (in .env or the environment) make sure that account exists and
 *  is an admin, so a real deployment has an admin without any demo data. */
function ensureAdminFromEnv(db) {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) return null;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (user) db.prepare("UPDATE users SET role = 'admin', shop_id = NULL, garage_id = NULL WHERE id = ?").run(user.id);
  else {
    db.prepare("INSERT INTO users (name, email, password_hash, auth_provider, role) VALUES ('Admin', ?, ?, 'local', 'admin')")
      .run(email, auth.hashPassword(password));
  }
  return email;
}

if (require.main === module) {
  loadEnvFile();
  if (process.argv.includes('--no-demo')) process.env.SEED_DEMO = 'false';
  const db = openDb();
  const seeded = process.env.SEED_DEMO !== 'false' && seedDemo(db);
  const adminAccount = ensureAdminFromEnv(db);
  const adminToken = process.env.ADMIN_TOKEN;
  const port = Number(process.env.PORT) || 3000;
  const app = createApp(db, { adminToken });
  app.listen(port, () => {
    console.log(`\n${APP_NAME} running at http://localhost:${port}`);
    console.log(`  Customer app:  http://localhost:${port}/`);
    console.log(`  Sellers & Garages: http://localhost:${port}/business.html`);
    console.log(`  Admin console: http://localhost:${port}/admin.html`);
    if (seeded) console.log('\nDemo data loaded (fake shops, prices and DEMO- part numbers).');
    if (isDemo(db)) {
      console.log(`Demo sign-ins: admin ${DEMO_ADMIN.email} / ${DEMO_ADMIN.password}; shops shop1@vinzuu.rw to shop5@vinzuu.rw,`);
      console.log(`garages garage1@vinzuu.rw to garage3@vinzuu.rw, shop and garage both@vinzuu.rw, all with password ${DEMO_BUSINESS_PASSWORD}.`);
    }
    if (adminAccount) console.log(`Admin account: ${adminAccount}`);
    if (!adminToken) console.log('\nWARNING: using the default admin token "dev-admin-token". Set ADMIN_TOKEN before sharing this with anyone.');
  });
}
