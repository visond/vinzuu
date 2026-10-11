/* Shared helpers for all pages. Loaded before customer.js, shop.js and admin.js.
   Everything the server sends back is inserted with textContent (never innerHTML),
   so shop names, notes and part numbers cannot inject markup. */
'use strict';

/** Build a DOM element: h('button', { class: 'btn', onclick: fn, text: 'Save' }, child, child) */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'for') el.setAttribute('for', value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key in el && key !== 'list') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** fetch wrapper that returns JSON and throws an Error with a plain-language message. */
async function api(path, { method = 'GET', body, headers } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (networkError) {
    const err = new Error('No connection. Check your internet and try again.');
    err.status = 0;
    throw err;
  }
  let data = null;
  try { data = await res.json(); } catch (parseError) { /* empty body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Something went wrong (${res.status}).`);
    err.status = res.status;
    err.code = data && data.code;
    throw err;
  }
  return data;
}

const store = {
  get(key, area = 'localStorage') {
    try { return window[area].getItem(key); } catch (e) { return null; }
  },
  set(key, value, area = 'localStorage') {
    try { window[area].setItem(key, value); } catch (e) { /* private mode: ignore */ }
  },
  remove(key, area = 'localStorage') {
    try { window[area].removeItem(key); } catch (e) { /* ignore */ }
  },
};

const rwf = new Intl.NumberFormat('en-US');
const fmtRwf = (n) => `${rwf.format(n)} RWF`;

function enc(value) { return encodeURIComponent(value); }

/** "rae123a" -> "RAE 123 A" (only for the usual private-car pattern) */
function formatPlate(raw) {
  const p = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = p.match(/^(R[A-Z]{2})(\d{1,3})([A-Z]?)$/);
  return m ? [m[1], m[2], m[3]].filter(Boolean).join(' ') : p;
}

function whatsappLink(number, message) {
  const digits = String(number || '').replace(/\D/g, '');
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : null;
}

function setStatus(el, message, kind) {
  el.textContent = message || '';
  el.className = 'status' + (kind ? ` ${kind}` : '');
}

/** Static, trusted SVG strings only (no user data), so innerHTML is safe here. */
const ICONS = {
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z" fill="currentColor"/><path d="m8.4 12.2 2.5 2.5 4.7-5.2" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m7.8 12.4 3 3 5.4-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  alert: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 2.8 19.5h18.4L12 3.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.2v.1" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  ruler: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="8" width="19" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 8v3M11 8v4M15 8v3M19 8v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};
function icon(name) {
  const t = document.createElement('template');
  t.innerHTML = ICONS[name] || '';
  return t.content.firstElementChild;
}

const BADGE_ICON = {
  verified_genuine: 'shield', verified_compatible: 'check', unverified: 'alert', universal: 'ruler',
};
function badgeEl(badge) {
  return h('span', { class: `badge badge-${badge.key}` }, icon(BADGE_ICON[badge.key]), badge.label);
}

/** Shrink a phone photo to about 640px so uploads stay small on mobile data. */
function resizeImage(file, maxSide = 640) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that photo.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not a photo we can use. Try a JPG or PNG.'));
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        let quality = 0.8;
        let out = canvas.toDataURL('image/jpeg', quality);
        while (out.length > 300000 && quality > 0.3) {
          quality -= 0.15;
          out = canvas.toDataURL('image/jpeg', quality);
        }
        resolve(out);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* Shared mobile nav hamburger toggle: present on the welcome, about and contact pages. A no-op
   where the markup isn't there, so it's safe to load on every page via common.js. */
(() => {
  const toggle = document.getElementById('nav-toggle');
  const linksWrap = document.getElementById('nav-links-wrap');
  if (!toggle || !linksWrap) return;
  toggle.addEventListener('click', () => {
    const open = linksWrap.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  linksWrap.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => {
    linksWrap.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
  }));
})();
