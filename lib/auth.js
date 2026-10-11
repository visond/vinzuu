'use strict';
/**
 * Everything here uses only Node's built-in crypto module: no bcrypt, no jsonwebtoken,
 * no passport. That keeps the project at zero extra dependencies (just like node:sqlite).
 */
const crypto = require('crypto');

// ---------------------------------------------------------------- passwords

const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------- session cookie
// Stateless: "<userId>.<expiryMs>.<hmac>". No session table, so signing out just
// deletes the cookie, and restarting the server does not sign anyone out early.

const COOKIE_NAME = 'kpf_session';
const SESSION_DAYS = 30;

function sessionSecret() {
  return process.env.SESSION_SECRET || 'dev-session-secret-change-me-before-sharing-this-server';
}

function signSession(userId) {
  const expires = Date.now() + SESSION_DAYS * 86400000;
  const payload = `${userId}.${expires}`;
  const mac = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex');
  return `${payload}.${mac}`;
}

function verifySession(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [id, expires, mac] = parts;
  const expected = crypto.createHmac('sha256', sessionSecret()).update(`${id}.${expires}`).digest('hex');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(expires) < Date.now()) return null;
  return Number(id);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Secure cookies are rejected by browsers over plain http, so only add it when https is in use. */
function isSecureRequest(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function setSessionCookie(req, res, userId) {
  const token = signSession(userId);
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}

function clearSessionCookie(req, res) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

// ---------------------------------------------------------------- Google / Apple ID tokens
// Both issue a signed JWT (RS256) after the person signs in with their own JS SDK.
// We verify the signature ourselves against the provider's published public keys,
// rather than trusting whatever the browser sends us.

function base64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

const jwksCache = new Map(); // jwks uri -> { keys, fetchedAt }
const JWKS_TTL_MS = 3600000;

async function getJwks(uri) {
  const cached = jwksCache.get(uri);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const res = await fetch(uri);
  if (!res.ok) throw new Error('Could not reach the sign-in service. Please try again.');
  const { keys } = await res.json();
  jwksCache.set(uri, { keys, fetchedAt: Date.now() });
  return keys;
}

async function verifyIdToken(idToken, { jwksUri, issuer, audience }) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('That sign-in response was not valid.');
  const [headerB64, payloadB64, sigB64] = parts;
  let header, payload;
  try {
    header = JSON.parse(base64urlDecode(headerB64));
    payload = JSON.parse(base64urlDecode(payloadB64));
  } catch (err) {
    throw new Error('That sign-in response was not valid.');
  }
  const keys = await getJwks(jwksUri);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('Could not verify that sign-in. Please try again.');
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const signed = Buffer.from(`${headerB64}.${payloadB64}`);
  const ok = crypto.verify('RSA-SHA256', signed, publicKey, base64urlDecode(sigB64));
  if (!ok) throw new Error('That sign-in could not be verified.');
  const issuers = Array.isArray(issuer) ? issuer : [issuer];
  if (!issuers.includes(payload.iss)) throw new Error('That sign-in came from an unexpected source.');
  if (payload.aud !== audience) throw new Error('That sign-in was not issued for this app.');
  if (!payload.exp || payload.exp * 1000 < Date.now()) throw new Error('That sign-in has expired. Please try again.');
  return payload;
}

function verifyGoogleIdToken(idToken, clientId) {
  return verifyIdToken(idToken, {
    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
    issuer: ['accounts.google.com', 'https://accounts.google.com'],
    audience: clientId,
  });
}

function verifyAppleIdToken(idToken, clientId) {
  return verifyIdToken(idToken, {
    jwksUri: 'https://appleid.apple.com/auth/keys',
    issuer: 'https://appleid.apple.com',
    audience: clientId,
  });
}

module.exports = {
  hashPassword, verifyPassword,
  COOKIE_NAME, parseCookies, setSessionCookie, clearSessionCookie, verifySession,
  verifyGoogleIdToken, verifyAppleIdToken,
};
