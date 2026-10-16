/* Shared helpers for all pages. Loaded before customer.js, business.js, sell.js and admin.js.
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
      h('img', { src: g.photo || GARAGE_PHOTOS[i % GARAGE_PHOTOS.length], alt: g.photo ? `${g.name}, from outside` : '', loading: 'lazy', width: 400, height: 250 }),
      h('span', { class: 'gc-distance', text: `${g.distance_km} km` })),
    h('div', { class: 'gc-body' },
      h('h3', { text: g.name }),
      g.rating ? h('p', { class: 'gc-rating' }, ratingEl(g.rating, 'garage', g.id, g.name)) : null,
      h('p', { class: 'gc-address' }, icon('pin'), g.address || 'Kigali'),
      tags.length ? h('ul', { class: 'gc-tags' }, ...tags.map((t) => h('li', { text: t }))) : null,
      h('div', { class: 'gc-actions' },
        h('a', { class: 'btn btn-primary', href: bookHref, target: '_blank', rel: 'noopener' }, icon('calendar'), 'Book now'),
        h('a', { class: 'btn', href: mapHref, target: '_blank', rel: 'noopener', 'aria-label': `Location of ${g.name} on the map` }, icon('pin'), 'Location'))));
}

/** Five stars, filled to the nearest half: "★★★★½"-style, drawn with CSS widths. */
function starsEl(average, label) {
  const pct = Math.max(0, Math.min(100, (Math.round((average || 0) * 2) / 2) * 20));
  return h('span', { class: 'stars', role: 'img', 'aria-label': label || `${average} out of 5 stars` },
    h('span', { class: 'stars-bg', 'aria-hidden': 'true', text: '★★★★★' }),
    h('span', { class: 'stars-fg', 'aria-hidden': 'true', style: `width:${pct}%`, text: '★★★★★' }));
}

/** "★★★★½ 4.5 (12 reviews)" as a button that opens the reviews; "No reviews yet" otherwise. */
function ratingEl(rating, target, id, name) {
  if (!rating || !rating.count) return h('span', { class: 'rating rating-none', text: 'No reviews yet' });
  return h('button', {
    class: 'rating', type: 'button', title: `Read reviews of ${name}`,
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); openReviews(target, id, name); },
  }, starsEl(rating.average), h('b', { text: String(rating.average) }),
  h('span', { class: 'rating-n', text: `(${rating.count} ${rating.count === 1 ? 'review' : 'reviews'})` }));
}

/** A list of reviews with the business's replies. Shared by customer pages and the dashboard. */
function reviewList(reviews, opts = {}) {
  if (!reviews.length) return h('p', { class: 'empty muted', text: opts.empty || 'No reviews yet.' });
  return h('ul', { class: 'review-list' }, ...reviews.map((r) => h('li', { class: 'review' },
    h('div', { class: 'review-head' }, starsEl(r.rating), h('strong', { text: r.author_name }),
      h('span', { class: 'small muted', text: String(r.created_at || '').slice(0, 10) })),
    r.comment ? h('p', { class: 'review-text', text: r.comment }) : null,
    r.reply ? h('p', { class: 'review-reply' }, h('b', { text: 'Reply: ' }), r.reply) : null,
    opts.actions ? opts.actions(r) : null)));
}

async function openReviews(target, id, name) {
  let dlg = document.getElementById('reviews-dialog');
  if (!dlg) {
    dlg = h('dialog', { id: 'reviews-dialog', 'aria-labelledby': 'reviews-title' });
    document.body.append(dlg);
  }
  const close = () => { if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open'); };
  const body = h('div', { class: 'dialog-body' }, h('h2', { id: 'reviews-title', text: `Reviews of ${name}` }), h('p', { class: 'muted', text: 'Loading…' }));
  dlg.replaceChildren(body);
  if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
  try {
    const res = await api(`/api/reviews?${target}_id=${encodeURIComponent(id)}`);
    body.replaceChildren(h('h2', { id: 'reviews-title', text: `Reviews of ${name}` }),
      res.rating.count ? h('p', { class: 'rating-summary' }, starsEl(res.rating.average), h('b', { text: ` ${res.rating.average} out of 5` }),
        h('span', { class: 'muted rs-from', text: `From ${res.rating.count} ${res.rating.count === 1 ? 'customer' : 'customers'} who booked through Vinzuu` })) : null,
      reviewList(res.reviews),
      h('div', { class: 'dialog-actions' }, h('button', { class: 'btn btn-quiet', type: 'button', text: 'Close', onclick: close })));
  } catch (err) {
    body.append(h('p', { class: 'status error', text: err.message }));
  }
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

/* The account menu of a shop, garage or admin account: who is signed in, the places this
   account can switch between (the server sends them as user.portals, so an admin sees Admin,
   Sellers & Garages and the customer site, a shop or garage the last two), and Sign out. A
   customer account has nowhere else to go, so it never gets this menu. */
const PORTAL_ICONS = {
  admin: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3 5 6v5c0 4.4 3 8.3 7 9.5 4-1.2 7-5.1 7-9.5V6l-7-3z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="m9 12 2 2 4-4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  seller: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 9h16l-1.2-4.2A1 1 0 0 0 17.8 4H6.2a1 1 0 0 0-1 .8L4 9z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M5 9v10h14V9M9 19v-5h6v5" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  customer: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 16v-3.5l2-5A2 2 0 0 1 6.9 6h10.2a2 2 0 0 1 1.9 1.5l2 5V16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M3.5 12.5h17" stroke="currentColor" stroke-width="2"/><circle cx="7.5" cy="17" r="1.8" fill="currentColor"/><circle cx="16.5" cy="17" r="1.8" fill="currentColor"/></svg>',
};
const ROLE_TEXT = { admin: 'Admin', business: 'Seller', customer: 'Customer' };
function svgEl(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup; // static strings from PORTAL_ICONS only
  return t.content.firstElementChild;
}

/** current: which portal this page is ('admin', 'seller' or 'customer'). */
function accountMenu(user, current, { onSignOut } = {}) {
  const name = String(user.name || '').trim() || String(user.email || '').split('@')[0] || 'You';
  const initial = name.charAt(0).toUpperCase();
  const menuId = `acct-menu-${Math.random().toString(36).slice(2, 8)}`;
  const signOut = async () => {
    if (onSignOut) onSignOut();
    store.remove('kpf.vehicle_id');
    try { await api('/api/auth/logout', { method: 'POST' }); } finally { location.href = '/'; }
  };
  const menu = h('div', { class: 'acct-menu', id: menuId, hidden: true },
    h('p', { class: 'acct-label', text: 'Signed in' }),
    h('div', { class: 'acct-who' },
      h('span', { class: 'nav-avatar', 'aria-hidden': 'true' }, initial),
      h('span', { class: 'acct-who-text' }, h('strong', { text: user.email || name }), h('span', { text: ROLE_TEXT[user.role] || '' }))),
    h('p', { class: 'acct-label', text: 'Go to' }),
    h('ul', { class: 'acct-portals' }, ...(user.portals || []).map((p) => h('li', {},
      h('a', { class: `acct-portal${p.key === current ? ' is-current' : ''}`, href: p.href, 'aria-current': p.key === current ? 'page' : null },
        h('span', { class: `acct-portal-icon acct-${p.key}` }, svgEl(PORTAL_ICONS[p.key] || '')),
        h('span', { class: 'acct-portal-text' }, h('strong', { text: p.label }), h('span', { text: p.sub })),
        p.key === current ? h('span', { class: 'acct-tick', 'aria-label': 'You are here', text: '✓' }) : null)))),
    h('button', { class: 'acct-signout', type: 'button', text: 'Sign out', onclick: signOut }));
  const button = h('button', { class: 'acct-btn', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': menuId,
    title: `Signed in as ${name}` },
  h('span', { class: 'nav-avatar', 'aria-hidden': 'true' }, initial, h('span', { class: 'nav-online' })),
  h('span', { class: 'acct-btn-text' }, h('span', { class: 'acct-btn-name', text: name.split(/\s+/)[0] }), h('span', { class: 'acct-btn-role', text: ROLE_TEXT[user.role] || '' })),
  h('span', { class: 'acct-chev', 'aria-hidden': 'true', text: '▾' }));
  const wrap = h('div', { class: 'acct' }, button, menu);
  const setOpen = (open) => { menu.hidden = !open; button.setAttribute('aria-expanded', String(open)); };
  button.addEventListener('click', (e) => { e.stopPropagation(); setOpen(menu.hidden); });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { setOpen(false); button.focus(); } });
  return wrap;
}

/** The same places as buttons, shown beside Sign out on the admin and seller dashboards, so
 *  switching is one tap without opening the menu. Nothing for an account with nowhere to go. */
function portalSwitch(user, current) {
  if (!user || !user.portals || !user.portals.length) return null;
  return h('nav', { class: 'portal-switch', 'aria-label': 'Go to' },
    ...user.portals.map((p) => h('a', { class: `portal-link${p.key === current ? ' is-current' : ''}`, href: p.href, 'aria-current': p.key === current ? 'page' : null },
      h('span', { class: `acct-portal-icon acct-${p.key}` }, svgEl(PORTAL_ICONS[p.key] || '')), p.label)));
}

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
    // Who is signed in, with a green dot for online: first name and an initial avatar.
    const name = String(user.name || '').trim() || String(user.email || '').split('@')[0] || 'You';
    const first = name.split(/\s+/)[0];
    signOut.before(h('span', { class: 'nav-user', title: `Signed in as ${name}${user.email ? ` (${user.email})` : ''}` },
      h('span', { class: 'nav-avatar', 'aria-hidden': 'true' }, first.charAt(0).toUpperCase(), h('span', { class: 'nav-online' })),
      h('span', { class: 'nav-user-text' },
        h('span', { class: 'nav-user-name', text: first }),
        h('span', { class: 'nav-user-status', text: 'Online' }))));
    // A shop, garage or admin account: the name opens the account menu, to switch to the other
    // places this account can use. A customer's stays as it is.
    if (user.portals && user.portals.length) {
      const nameChip = signOut.previousElementSibling;
      nameChip.replaceWith(accountMenu(user, 'customer'));
    }
    // On a phone the links fold into the menu, so the avatar also sits next to the menu button.
    const toggle = document.getElementById('nav-toggle');
    if (toggle) {
      toggle.before(h('span', { class: 'nav-avatar nav-avatar-mini', title: `Signed in as ${name}`, 'aria-label': `Signed in as ${name}, online`, role: 'img' },
        first.charAt(0).toUpperCase(), h('span', { class: 'nav-online' })));
    }
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
    // A shop, garage or admin account: the logo and the "Sell on vinzuu" button open its dashboard.
    if (user.role === 'business' || user.role === 'admin') {
      document.querySelectorAll('a.nav-logo').forEach((a) => { a.href = user.home; });
      document.querySelectorAll('.site-nav a[href="/sell.html"]').forEach((a) => {
        a.href = user.home;
        a.textContent = user.role === 'admin' ? 'Admin' : 'My dashboard';
      });
    }
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

/** Brands a part can come from, so the admin and shops pick one instead of typing it. The
 *  genuine ones are the car makers' own parts; the rest are well-known aftermarket makers, listed
 *  per group of the parts catalogue (lib/partcatalog.js) so the list stays short. Korean brands
 *  first in each group, since most cars on Vinzuu are Hyundai and Kia. */
const GENUINE_BRANDS = ['Hyundai Genuine (Mobis)', 'Kia Genuine (Mobis)', 'Toyota Genuine'];
const AFTERMARKET_BRANDS = {
  'Service parts': ['Parts-Mall (PMC)', 'Sakura', 'Mann-Filter', 'Mahle', 'Bosch', 'Denso', 'NGK', 'Champion', 'Gates', 'Dayco', 'Aisin', 'Valeo', 'ZIC', 'Kixx', 'Total', 'Shell', 'Castrol', 'Mobil'],
  Brakes: ['Sangsin (Hi-Q)', 'Mando', 'Parts-Mall (PMC)', 'Brembo', 'TRW', 'Bosch', 'Akebono', 'ATE', 'Textar'],
  Engine: ['Parts-Mall (PMC)', 'Mahle', 'Aisin', 'Gates', 'Dayco', 'GMB', 'Victor Reinz', 'Elring', 'Febi'],
  Cooling: ['Parts-Mall (PMC)', 'Aisin', 'GMB', 'Gates', 'Denso', 'Koyorad', 'Nissens', 'Valeo'],
  'Fuel and ignition': ['Parts-Mall (PMC)', 'Bosch', 'Denso', 'NGK', 'Delphi', 'Champion'],
  Exhaust: ['Parts-Mall (PMC)', 'Bosal', 'Walker'],
  'Suspension and steering': ['Mando', 'CTR', 'Parts-Mall (PMC)', 'KYB', 'Monroe', 'Sachs', '555', 'Lemförder', 'Febi'],
  'Transmission and drive': ['Valeo', 'Exedy', 'Aisin', 'Sachs', 'GKN', 'Parts-Mall (PMC)'],
  Electrical: ['Rocket', 'Solite', 'Mando', 'Parts-Mall (PMC)', 'Bosch', 'Denso', 'Valeo', 'Hella', 'Varta', 'Exide', 'Amaron'],
  Lighting: ['Depo', 'TYC', 'Philips', 'Osram', 'Hella'],
  Body: ['Depo', 'TYC', 'Gordon', 'Parts-Mall (PMC)', 'Fuyao', 'AGC', 'Saint-Gobain'],
  'Air conditioning and heating': ['Hanon (Halla)', 'Doowon', 'Denso', 'Valeo', 'Sanden', 'Parts-Mall (PMC)'],
  Interior: ['Parts-Mall (PMC)'],
  'Wheels and tyres': ['Hankook', 'Kumho', 'Nexen', 'Bridgestone', 'Michelin', 'Dunlop', 'Goodyear', 'Yokohama'],
};

/** A Brand <select> for a part form: genuine brands, then the aftermarket brands of the chosen
 *  part's group, then "Other brand" which shows a text box. Picking a brand also sets the
 *  "Genuine / Aftermarket" select, so the two can't disagree. Put `select` in a field, then call
 *  `mount()` to add the text box under it. `value()` is the brand to save, or null. */
function brandPicker(id, typeSelect, { value = '', placeholder = 'Type the brand on the box' } = {}) {
  const OTHER = '__other';
  const select = h('select', { id });
  const other = h('input', { id: `${id}-other`, type: 'text', maxLength: 60, placeholder, 'aria-label': 'Brand name', style: 'margin-top: 8px', hidden: true });
  let group = null;
  function draw(keep, typed) {
    const aftermarket = (group && AFTERMARKET_BRANDS[group]) || [];
    const known = [...GENUINE_BRANDS, ...aftermarket];
    const match = keep && known.find((b) => b.toLowerCase() === keep.toLowerCase());
    select.replaceChildren(
      h('option', { value: '', text: 'Choose the brand' }),
      h('optgroup', { label: 'Genuine (the car maker\'s own part)' }, ...GENUINE_BRANDS.map((b) => h('option', { value: b, text: b }))),
      aftermarket.length ? h('optgroup', { label: 'Aftermarket' }, ...aftermarket.map((b) => h('option', { value: b, text: b }))) : null,
      h('option', { value: OTHER, text: 'Other brand: type it' }));
    if (match) select.value = match;
    else if (keep && typed) { select.value = OTHER; other.value = keep; }
    else select.value = '';
    other.hidden = select.value !== OTHER;
  }
  select.addEventListener('change', () => {
    other.hidden = select.value !== OTHER;
    if (select.value === OTHER) other.focus();
    if (!typeSelect || !select.value || select.value === OTHER) return;
    typeSelect.value = GENUINE_BRANDS.includes(select.value) ? 'genuine' : 'aftermarket';
  });
  draw(value, true);
  return {
    select,
    mount() { select.after(other); },
    /** Shows the brands for this part type's group. A picked brand stays if it is still listed; a typed one always stays. */
    setCategory(cat) { const typed = select.value === OTHER, keep = this.value(); group = cat ? cat.group : null; draw(keep || '', typed); },
    value() { return select.value === OTHER ? (other.value.trim() || null) : (select.value || null); },
  };
}

/** <option>s for a part-type <select>, grouped like a parts catalogue (Service parts, Brakes…).
 *  `only` narrows it, for example to the parts that have part numbers. */
function categoryOptions(categories, firstText, { only, selected, label = (c) => c.name } = {}) {
  const list = only ? categories.filter(only) : categories;
  const groups = new Map();
  for (const c of list) {
    const g = c.group || 'Other parts';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  return [
    firstText != null ? h('option', { value: '', text: firstText, selected: !selected }) : null,
    ...[...groups].map(([g, cats]) => h('optgroup', { label: g },
      ...cats.map((c) => h('option', { value: c.name, text: label(c), selected: c.name === selected })))),
  ].filter(Boolean);
}

/**
 * Make, model, generation and engine <select>s filled from the catalogue's model lineup
 * (/api/catalog makes), each narrowing the next, the way parts catalogues start from the car.
 * Every level but the make can be left at "Any". `onChange` runs after any of them changes.
 */
function carSelects(makes, prefix, { onChange, anyText = 'Any', withEngine = false } = {}) {
  const sel = (id, label) => h('select', { id: `${prefix}-${id}`, 'aria-label': label });
  const f = { make: sel('make', 'Make'), model: sel('model', 'Model'), generation: sel('gen', 'Generation'), engine: sel('eng', 'Engine') };
  const opt = (value, text) => h('option', { value, text });
  const make = () => makes.find((m) => m.make === f.make.value);
  const model = () => (make() ? make().models.find((m) => m.model === f.model.value) : null);
  const gen = () => (model() ? model().generations.find((g) => g.generation === f.generation.value) : null);
  const years = (g) => `${g.year_start} to ${g.ongoing ? 'now' : g.year_end}`;
  function fillModels() {
    const m = make();
    f.model.replaceChildren(opt('', m ? `${anyText} ${m.make} model` : 'Choose the make first'),
      ...(m ? m.models.map((x) => opt(x.model, x.model)) : []));
    f.model.disabled = !m;
  }
  function fillGens() {
    const m = model();
    f.generation.replaceChildren(opt('', m ? `${anyText} generation` : 'Choose the model first'),
      ...(m ? m.generations.map((g) => opt(g.generation, `${g.generation} (${years(g)})`)) : []));
    f.generation.disabled = !m;
  }
  function fillEngines() {
    const g = gen();
    f.engine.replaceChildren(opt('', g ? `${anyText} engine` : 'Choose the generation first'),
      ...(g ? g.engines.map((e) => opt(e.label, e.codes.length ? `${e.label} (${e.codes.join(', ')})` : e.label)) : []));
    f.engine.disabled = !g;
  }
  f.make.replaceChildren(opt('', 'Choose the make'), ...makes.map((m) => opt(m.make, m.make)));
  fillModels(); fillGens(); fillEngines();
  const changed = () => { if (onChange) onChange(); };
  f.make.addEventListener('change', () => { fillModels(); fillGens(); fillEngines(); changed(); });
  f.model.addEventListener('change', () => { fillGens(); fillEngines(); changed(); });
  f.generation.addEventListener('change', () => { fillEngines(); changed(); });
  f.engine.addEventListener('change', changed);
  return {
    ...f,
    fields: withEngine ? [f.make, f.model, f.generation, f.engine] : [f.make, f.model, f.generation],
    generationInfo: gen,
    /** Sets all four; values the lineup doesn't know are added so nothing typed earlier is lost. */
    set({ make: mk = '', model: md = '', generation: g = '', engine: e = '' } = {}) {
      const ensure = (s, v) => { if (v && ![...s.options].some((o) => o.value === v)) s.append(opt(v, v)); s.disabled = false; s.value = v || ''; };
      ensure(f.make, mk); fillModels(); ensure(f.model, md); fillGens(); ensure(f.generation, g); fillEngines(); ensure(f.engine, e);
    },
    query() {
      const q = new URLSearchParams();
      if (f.make.value) q.set('make', f.make.value);
      if (f.model.value) q.set('model', f.model.value);
      if (f.generation.value) q.set('generation', f.generation.value);
      return q.toString();
    },
  };
}

/** Part-number rows (one per car) folded into one choice per number, listing every car it fits. */
function oeChoices(rows) {
  const byOe = new Map();
  for (const r of rows) {
    if (!byOe.has(r.oe_number)) byOe.set(r.oe_number, []);
    byOe.get(r.oe_number).push(r);
  }
  const car = (r) => `${r.make} ${r.model}${r.generation ? ` ${r.generation}` : ''} ${r.year_start} to ${r.year_end}${r.engine ? `, ${r.engine}` : ''}${r.origin_market ? `, ${r.origin_market}-built` : ''}`;
  return [...byOe].map(([oe, fits]) => ({
    oe, fits,
    text: `${oe}: ${car(fits[0])}${fits.length > 1 ? ` and ${fits.length - 1} more` : ''}`,
  }));
}
