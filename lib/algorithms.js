'use strict';
/**
 * Pure functions only (no database, no HTTP). Easy to test and reason about.
 * Maps to the specification:
 *   Algorithm A  -> normalizePlate, isValidVin, decodeWmi
 *   Algorithm D  -> haversineKm
 *   Algorithm E  -> badgeFor
 * (Algorithms B and C need the database, so they live in lib/matching.js)
 */

const KIGALI_CENTER = { lat: -1.9441, lon: 30.0619 };

// ---------- Plate numbers ----------

/** "rae 123 a" -> "RAE123A" */
function normalizePlate(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Deliberately loose: Rwanda issues several plate styles (private, government,
 * motorcycle, diplomatic). We only require 4-10 letters/digits with at least one of each.
 */
function isValidPlate(plate) {
  return /^[A-Z0-9]{4,10}$/.test(plate) && /[A-Z]/.test(plate) && /[0-9]/.test(plate);
}

// ---------- VIN ----------

/** A VIN is exactly 17 characters; the letters I, O and Q are never used. */
function isValidVin(vin) {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(String(vin || '').toUpperCase());
}

/** Public API responses never expose a full VIN: KMHB35••••••••••98 */
function maskVin(vin) {
  if (!vin) return null;
  const v = String(vin);
  return v.slice(0, 6) + '•'.repeat(Math.max(v.length - 8, 0)) + v.slice(-2);
}

/**
 * Exact 3-character WMI codes for the makers in the MVP scope (Toyota, Hyundai, Kia).
 * IMPORTANT: this is a STARTER list written from public WMI directories. Verify it
 * against ISO 3780 / manufacturer data before relying on it, and extend it as you meet
 * new codes in the field. Anything not listed falls back to the region rules below.
 */
const WMI_EXACT = {
  // Hyundai
  KMH: ['Korea', 'Hyundai'], KMF: ['Korea', 'Hyundai'], KMJ: ['Korea', 'Hyundai'],
  '5NP': ['USA', 'Hyundai'], '5NM': ['USA', 'Hyundai'], MAL: ['India', 'Hyundai'],
  NLH: ['Turkey', 'Hyundai'],
  // Kia
  KNA: ['Korea', 'Kia'], KNB: ['Korea', 'Kia'], KNC: ['Korea', 'Kia'],
  KND: ['Korea', 'Kia'], KNE: ['Korea', 'Kia'],
  '5XY': ['USA', 'Kia'], '5XX': ['USA', 'Kia'], '3KP': ['Mexico', 'Kia'],
  MZB: ['India', 'Kia'], U5Y: ['Slovakia', 'Kia'],
  // Toyota
  JTD: ['Japan', 'Toyota'], JTE: ['Japan', 'Toyota'], JTM: ['Japan', 'Toyota'],
  JTN: ['Japan', 'Toyota'], JTF: ['Japan', 'Toyota'], JT2: ['Japan', 'Toyota'],
  JT3: ['Japan', 'Toyota'], JT4: ['Japan', 'Toyota'], JT6: ['Japan', 'Toyota'],
  '4T1': ['USA', 'Toyota'], '4T3': ['USA', 'Toyota'], '5TD': ['USA', 'Toyota'],
  '5TF': ['USA', 'Toyota'], '2T1': ['Canada', 'Toyota'], '2T3': ['Canada', 'Toyota'],
  AHT: ['South Africa', 'Toyota'], MR0: ['Thailand', 'Toyota'], MHF: ['Indonesia', 'Toyota'],
  SB1: ['UK', 'Toyota'], VNK: ['France', 'Toyota'], NMT: ['Turkey', 'Toyota'],
};

/** Coarse country-of-manufacture rules from the first two characters. */
function regionFromWmi(wmi) {
  const c1 = wmi[0];
  const c2 = wmi[1] || '';
  if (c1 === 'J') return 'Japan';
  if (c1 === 'K' && 'LMNOPQR'.includes(c2)) return 'Korea';   // KL-KR
  if (c1 === 'L') return 'China';
  if ('145'.includes(c1)) return 'USA';
  if (c1 === '2') return 'Canada';
  if (c1 === '3') return 'Mexico';
  if (c1 === 'W') return 'Germany';
  if (c1 === 'Z') return 'Italy';
  if (c1 === 'S' && 'ABCDEFGHIJKLM'.includes(c2)) return 'UK';
  if (c1 === 'V' && 'FGHIJKLMNOPQR'.includes(c2)) return 'France';
  if (c1 === 'V' && 'STUVW'.includes(c2)) return 'Spain';
  if (c1 === 'M' && 'ABCDE'.includes(c2)) return 'India';
  if (c1 === 'M' && 'FGHIJK'.includes(c2)) return 'Indonesia';
  if (c1 === 'M' && 'LMNOPQR'.includes(c2)) return 'Thailand';
  if (c1 === 'A' && 'ABCDEFGH'.includes(c2)) return 'South Africa';
  return null;
}

/**
 * Algorithm A, step 3-4: first 3 characters of the VIN -> where it was built.
 * Returns { wmi, origin, maker, source } where source is 'exact' | 'region' | 'unknown'.
 */
function decodeWmi(vin) {
  const wmi = String(vin || '').toUpperCase().slice(0, 3);
  if (wmi.length < 3) return { wmi: null, origin: null, maker: null, source: 'unknown' };
  if (WMI_EXACT[wmi]) {
    const [origin, maker] = WMI_EXACT[wmi];
    return { wmi, origin, maker, source: 'exact' };
  }
  const region = regionFromWmi(wmi);
  if (region) return { wmi, origin: region, maker: null, source: 'region' };
  return { wmi, origin: null, maker: null, source: 'unknown' };
}

/**
 * The 10th VIN character is the model year. The 30 codes repeat every 30 years (A = 1980 or 2010,
 * 1 = 2001 or 2031), and I, O, Q, U, Z and 0 are never used. For North American VINs a letter in
 * position 7 means 2010 or later; elsewhere we take the latest year that is not in the future.
 * Makers outside North America are not obliged to code the year, so a missing or invalid code
 * gives { year: null } rather than a guess. Returns { code, year, candidates }.
 */
const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';
function decodeModelYear(vin, now = new Date()) {
  const v = String(vin || '').toUpperCase();
  const code = v[9] || null;
  const i = code ? YEAR_CODES.indexOf(code) : -1;
  if (v.length !== 17 || i < 0) return { code, year: null, candidates: [] };
  const latest = now.getFullYear() + 1;
  const candidates = [1980 + i, 2010 + i, 2040 + i].filter((y) => y <= latest);
  let year = candidates[candidates.length - 1] || null;
  if ('12345'.includes(v[0]) && candidates.length > 1) {
    year = /[A-Z]/.test(v[6]) ? 2010 + i : 1980 + i;
    if (year > latest) year = 1980 + i;
  }
  return { code, year, candidates };
}

// ---------- Algorithm D: distance ----------

/** Great-circle distance in km between two {lat, lon} points. */
function haversineKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// ---------- Algorithm E: confidence -> customer-facing badge ----------

const BADGES = {
  verified_genuine: {
    key: 'verified_genuine',
    label: 'Verified Genuine',
    explain: "The part number matches the manufacturer's record for your car, and we have vetted this shop.",
  },
  verified_compatible: {
    key: 'verified_compatible',
    label: 'Verified Compatible',
    explain: 'Our records show this fits your car. It may not be the manufacturer\'s own part.',
  },
  unverified: {
    key: 'unverified',
    label: 'Unverified, use with caution',
    explain: 'We could not confirm this fits your car. Ask the shop to check before you buy.',
  },
  universal: {
    key: 'universal',
    label: 'Check the size',
    explain: 'This part fits many cars. Compare the size or specification with your old part.',
  },
};

/**
 * The badge a customer sees.
 *  - "Verified Genuine" needs all three: HIGH confidence, the shop declares it genuine,
 *    AND the shop is vetted by us. Otherwise a random shop could claim "genuine" and
 *    earn our badge, which is exactly the trust failure this product exists to prevent.
 */
function badgeFor({ confidence, condition, vetted, universal }) {
  if (universal) return BADGES.universal;
  if (confidence === 'HIGH' && condition === 'genuine' && vetted) return BADGES.verified_genuine;
  if (confidence === 'HIGH' || confidence === 'MEDIUM') return BADGES.verified_compatible;
  return BADGES.unverified;
}

const CONFIDENCE_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 };

// ---------- WhatsApp deep links (no API needed for the MVP) ----------

function whatsappLink(number, message) {
  const digits = String(number || '').replace(/\D/g, '');
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

module.exports = {
  KIGALI_CENTER,
  normalizePlate,
  isValidPlate,
  isValidVin,
  maskVin,
  decodeWmi,
  decodeModelYear,
  haversineKm,
  badgeFor,
  BADGES,
  CONFIDENCE_RANK,
  whatsappLink,
};
