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
    const err = new Error('Could not reach Vinzuu. Check your connection and try again in a moment.');
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

// ---------- car registration forms (customer app and shop console) ----------

/** The one generation of this model on sale in `year`, or null when the year does not settle it. */
function generationForYear(generations, year) {
  const y = Number(year);
  if (!y) return null;
  const hits = generations.filter((g) => y >= g.year_start && y <= g.year_end);
  return hits.length === 1 ? hits[0].generation : null;
}

/** "TL (2015 to 2020)", or "NX4 (2020 to now)" for a generation still being made. */
function generationText(g) {
  return `${g.generation} (${g.year_start} to ${g.ongoing ? 'now' : g.year_end})`;
}

/** Engine choices: the label is what is saved and matched on; engine codes help the owner pick. */
function engineOptions(engines) {
  return engines.map((e) => (typeof e === 'string' ? { value: e, text: e }
    : { value: e.label, text: e.codes && e.codes.length ? `${e.label} (${e.codes.join(', ')})` : e.label }));
}

/** The engines of the chosen generation when it lists them, otherwise every engine of the model. */
function enginesFor(model, generationCode) {
  if (!model) return [];
  const gen = generationCode && model.generations.find((g) => g.generation === generationCode);
  return gen && gen.engines && gen.engines.length ? gen.engines : model.engines;
}

/** When a select offers exactly one real choice and none is made yet, make it. */
function pickOnlyChoice(select) {
  const real = [...select.options].filter((o) => o.value);
  if (real.length === 1 && !select.value) select.value = real[0].value;
}

/**
 * Keeps the generation in step with the year: picks the generation that year settles, and clears
 * it again if a later change of year no longer settles it. A generation the person chose by hand
 * is left alone.
 */
function syncGenerationToYear(genSelect, generations, year) {
  if (genSelect.value && genSelect.dataset.auto !== '1') return;
  const g = generationForYear(generations, year);
  genSelect.value = g || '';
  genSelect.dataset.auto = g ? '1' : '';
}

/** Fill the make and the build country from the VIN prefix, without overriding a choice already made. */
async function prefillFromVin(vin, f, onMakeChange) {
  if (!vin) return;
  const has = (select, value) => [...select.options].some((o) => o.value === value);
  try {
    const d = await api(`/api/vin/decode?vin=${enc(vin)}`);
    if (!d.valid) return;
    if (d.maker && !f.make.value && has(f.make, d.maker)) { f.make.value = d.maker; onMakeChange(); }
    if (d.origin && !f.origin.value && has(f.origin, d.origin)) f.origin.value = d.origin;
  } catch (err) { /* a convenience only: the person can still fill these in */ }
}

/** Static, trusted SVG strings only (no user data), so innerHTML is safe here. */
const ICONS = {
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z" fill="currentColor"/><path d="m8.4 12.2 2.5 2.5 4.7-5.2" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m7.8 12.4 3 3 5.4-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  alert: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 2.8 19.5h18.4L12 3.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.2v.1" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="9.5" r="2.5" stroke="currentColor" stroke-width="2"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2" stroke="currentColor" stroke-width="2"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  ruler: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="8" width="19" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 8v3M11 8v4M15 8v3M19 8v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};
function icon(name) {
  const t = document.createElement('template');
  t.innerHTML = ICONS[name] || '';
  return t.content.firstElementChild;
}

/* A garage card for the homepage's "Garages near you" and the garage page's "Repair shops near
   me". Photos are placeholders until garages upload their own: they are assigned in order. */
const GARAGE_PHOTOS = ['/img/garages/garage-1.jpg', '/img/garages/garage-2.jpg', '/img/garages/garage-3.jpg', '/img/garages/garage-4.jpg'];
function garageCard(g, i, message) {
  const digits = String(g.whatsapp || g.phone || '').replace(/\D/g, '');
  const text = message || `Hello ${g.name}, I found your garage on Vinzuu and would like to book a repair.`;
  const bookHref = digits ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}` : `tel:${g.phone}`;
  const mapHref = `https://www.google.com/maps/search/?api=1&query=${g.latitude},${g.longitude}`;
  const tags = String(g.specialties || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 3);
  return h('article', { class: 'garage-card' },
    h('div', { class: 'gc-photo' },
      h('img', { src: GARAGE_PHOTOS[i % GARAGE_PHOTOS.length], alt: '', loading: 'lazy', width: 400, height: 250 }),
      h('span', { class: 'gc-distance', text: `${g.distance_km} km` })),
    h('div', { class: 'gc-body' },
      h('h3', { text: g.name }),
      h('p', { class: 'gc-address' }, icon('pin'), g.address || 'Kigali'),
      tags.length ? h('ul', { class: 'gc-tags' }, ...tags.map((t) => h('li', { text: t }))) : null,
      h('div', { class: 'gc-actions' },
        h('a', { class: 'btn btn-primary', href: bookHref, target: '_blank', rel: 'noopener' }, icon('calendar'), 'Book now'),
        h('a', { class: 'btn', href: mapHref, target: '_blank', rel: 'noopener', 'aria-label': `Location of ${g.name} on the map` }, icon('pin'), 'Location'))));
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

/* The top navigation is the same on every customer page. Signed in, its "Sign in" button
   becomes "Sign out" in the same place and style; nothing else in the bar changes. */
(() => {
  const signIn = document.querySelector('.site-nav [data-auth="sign-in"]');
  if (!signIn) return;
  api('/api/auth/me').then(({ user }) => {
    if (!user) return;
    const signOut = h('button', {
      class: signIn.className, type: 'button', text: 'Sign out',
      onclick: async () => {
        store.remove('kpf.vehicle_id'); // the customer page's remembered car belongs to this account
        try { await api('/api/auth/logout', { method: 'POST' }); } finally { location.href = '/'; }
      },
    });
    signIn.replaceWith(signOut);
    // Signed in, the nav stays in your own garage (/index.html) instead of the public homepage:
    // the logo opens it, "Find parts" and "Popular parts" jump to the parts that fit your car,
    // "Garages" to the repair shops near you. Other links into the homepage use /welcome.html,
    // since "/" itself now opens the garage.
    document.querySelectorAll('a.nav-logo').forEach((a) => { a.href = '/index.html'; });
    const inGarage = { find: 'picker', parts: 'picker', garages: 'shops-near' };
    document.querySelectorAll('.site-nav .nav-links a').forEach((a) => {
      const href = a.getAttribute('href');
      const hash = href === '/index.html' ? 'find' : (href.match(/^\/?#(.+)$/) || [])[1];
      if (inGarage[hash]) a.href = `/index.html#${inGarage[hash]}`;
    });
    document.querySelectorAll('a[href^="/#"]').forEach((a) => { a.href = `/welcome.html${a.getAttribute('href').slice(1)}`; });
  }).catch(() => { /* offline: leave Sign in as it is */ });
})();

/* Tapping the dimmed area outside an open dialog closes it, like most apps. Dialogs have no
   padding, so a click whose target is the <dialog> itself landed on the backdrop. The press
   must also start there, so a text selection dragged out of a field doesn't close it. */
(function closeDialogsOnBackdropTap() {
  let pressedOn = null;
  document.addEventListener('pointerdown', (e) => { pressedOn = e.target; });
  document.addEventListener('click', (e) => {
    const dlg = e.target;
    if (!(dlg instanceof HTMLDialogElement) || !dlg.open || pressedOn !== dlg) return;
    if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
  });
})();
