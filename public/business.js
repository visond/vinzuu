/* Vinzuu Sellers & Garages: the dashboard for approved parts shops and garages.
   A business account can run a shop, a garage, or both; with both, it first picks a side.
   Shop side: overview, my parts (price and stock only), request a part, bookings, look up a car,
   reviews, profile. Garage side: overview, jobs, services and prices, reviews, profile.
   Only the vinzuu team posts parts, so a shop asks for new parts through "Request a part". */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SIDE_KEY = 'vz.biz.side';
  // An admin opens the dashboard as one shop or garage at a time, read-only: { kind, id }.
  const VIEW_KEY = 'vz.biz.view';
  let view = null;
  try { view = JSON.parse(store.get(VIEW_KEY, 'sessionStorage') || 'null'); } catch (e) { view = null; }
  // Every call says which shop or garage the admin is looking at; the server only honours it
  // for an admin, and only for reading.
  const api = (path, opts = {}) => window.api(path, view
    ? { ...opts, headers: { ...(opts.headers || {}), [view.kind === 'shop' ? 'x-view-shop' : 'x-view-garage']: String(view.id) } } : opts);

  let me = null;          // { user, shop, garage }
  let side = null;        // 'shop' | 'garage'
  let catalog = null;
  let meta = null;

  const SHOP_TABS = [
    ['overview', 'Overview', shopOverview],
    ['parts', 'My parts', shopParts],
    ['request', 'Request a part', shopRequest],
    ['bookings', 'Bookings', shopBookings],
    ['lookup', 'Look up a car', lookupTab],
    ['reviews', 'Reviews', () => reviewsTab('shop')],
    ['profile', 'Profile', shopProfile],
  ];
  const GARAGE_TABS = [
    ['overview', 'Overview', garageOverview],
    ['jobs', 'Jobs', garageJobs],
    ['services', 'Services and prices', garageServices],
    ['reviews', 'Reviews', () => reviewsTab('garage')],
    ['profile', 'Profile', garageProfile],
  ];
  const tabsFor = () => (side === 'shop' ? SHOP_TABS : GARAGE_TABS);

  init();

  async function init() {
    document.querySelectorAll('[data-sign-out]').forEach((b) => b.addEventListener('click', signOut));
    $('login-form').addEventListener('submit', onLogin);
    document.querySelectorAll('[data-side]').forEach((b) => b.addEventListener('click', () => openSide(b.dataset.side)));
    $('view-another').addEventListener('click', () => {
      view = null;
      store.remove(VIEW_KEY, 'sessionStorage');
      location.hash = '';
      showAdminPicker();
    });
    api('/api/meta').then((m) => { meta = m; $('demo-banner').hidden = !m.demo; }).catch(() => {});
    await load();
  }

  async function load() {
    try {
      me = await api(`/api/business/me${view ? `?${view.kind}_id=${enc(view.id)}` : ''}`);
    } catch (err) {
      if (err.code === 'admin_pick') {
        view = null;
        store.remove(VIEW_KEY, 'sessionStorage');
        await showAdminPicker();
        return;
      }
      if (err.code === 'not_business') {
        const user = (await api('/api/auth/me').catch(() => ({}))).user;
        show('not-business');
        $('not-business-text').textContent = `${user ? user.email : 'This account'} is a customer account, so it has no shop or garage. To sell parts or fit them, apply to join. It only takes a few minutes.`;
        return;
      }
      show('login');
      return;
    }
    catalog = await api('/api/catalog');
    showAccount(me.user);
    $('view-banner').hidden = !me.view_as_admin;
    if (me.view_as_admin) {
      $('view-banner-text').textContent = `You are looking at ${(me.shop || me.garage).name} the way its owner sees it. It is read-only.`;
    }
    const remembered = store.get(SIDE_KEY, 'sessionStorage');
    if (me.shop && me.garage) {
      if (remembered === 'shop' || remembered === 'garage') openSide(remembered);
      else {
        $('choose-sub').textContent = `${me.user.email} runs ${me.shop.name} and ${me.garage.name}. You can switch at any time.`;
        show('choose');
      }
    } else {
      openSide(me.shop ? 'shop' : 'garage');
    }
  }

  function show(id) {
    for (const s of ['login', 'not-business', 'choose', 'pick', 'console']) $(s).hidden = s !== id;
  }

  function showAccount(user) {
    $('biz-switch').replaceChildren(portalSwitch(user, 'seller') || '');
    $('pick-switch').replaceChildren(portalSwitch(user, 'seller') || '');
    $('biz-user').hidden = false;
    $('biz-user').replaceChildren(accountMenu(user, 'seller', { onSignOut: () => {
      store.remove(SIDE_KEY, 'sessionStorage');
      store.remove(VIEW_KEY, 'sessionStorage');
    } }));
  }

  /** An admin chooses which shop or garage to open (read-only), to see what its owner sees. */
  async function showAdminPicker() {
    const user = (await api('/api/auth/me')).user;
    showAccount(user);
    show('pick');
    const [{ shops }, { garages }] = await Promise.all([api('/api/admin/shops'), api('/api/admin/garages')]);
    const all = [...shops.map((s) => ({ ...s, kind: 'shop' })), ...garages.map((g) => ({ ...g, kind: 'garage' }))];
    const search = $('pick-q');
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const rows = all.filter((b) => !q || [b.name, b.address_text, b.login_email].some((x) => String(x || '').toLowerCase().includes(q)));
      $('pick-list').replaceChildren(...(rows.length ? rows.map((b) => h('li', {},
        h('button', { class: 'pick-item', type: 'button', onclick: () => {
          view = { kind: b.kind, id: b.id };
          store.set(VIEW_KEY, JSON.stringify(view), 'sessionStorage');
          store.set(SIDE_KEY, b.kind, 'sessionStorage');
          load();
        } },
        h('span', { class: `pill ${b.kind === 'shop' ? 'pill-new' : 'pill-done'}`, text: b.kind === 'shop' ? 'Shop' : 'Garage' }),
        h('strong', { text: b.name }),
        h('span', { class: 'small muted', text: [b.address_text, b.login_email || 'No sign-in yet', b.suspended ? 'Suspended' : null].filter(Boolean).join(' · ') })))) :
        [h('li', { class: 'empty muted', text: 'Nothing matches.' })]));
    };
    search.oninput = draw;
    draw();
  }

  async function onLogin(event) {
    event.preventDefault();
    const status = $('login-status');
    setStatus(status, 'Signing in…');
    try {
      const res = await api('/api/auth/login', { method: 'POST', body: { email: $('bz-email').value, password: $('bz-password').value } });
      if (res.user.role === 'admin') { location.href = '/admin.html'; return; }
      setStatus(status, '');
      await load();
    } catch (err) { setStatus(status, err.message, 'error'); }
  }

  async function signOut() {
    store.remove(SIDE_KEY, 'sessionStorage');
    store.remove(VIEW_KEY, 'sessionStorage');
    try { await api('/api/auth/logout', { method: 'POST' }); } finally { location.href = '/business.html'; }
  }

  function openSide(next) {
    if (!me || !me[next]) return;
    side = next;
    store.set(SIDE_KEY, side, 'sessionStorage');
    show('console');
    renderHead();
    $('tabs').replaceChildren(...tabsFor().map(([key, label]) => h('button', {
      type: 'button', role: 'tab', id: `tab-${key}`, text: label, onclick: () => showTab(key),
    })));
    const wanted = location.hash.slice(1);
    showTab(tabsFor().some(([k]) => k === wanted) ? wanted : 'overview');
  }

  function renderHead() {
    const biz = me[side];
    $('side-label').textContent = side === 'shop' ? 'Parts shop' : 'Garage';
    $('biz-name').textContent = biz.name;
    const sub = [];
    if (side === 'shop') {
      sub.push(biz.vetted
        ? h('span', { class: 'biz-verified' }, icon('shield'), 'Verified shop')
        : h('span', { class: 'biz-unverified', text: 'Not verified yet' }));
    }
    sub.push(biz.rating && biz.rating.count
      ? h('span', { class: 'biz-rating' }, starsEl(biz.rating.average), ` ${biz.rating.average} (${biz.rating.count} ${biz.rating.count === 1 ? 'review' : 'reviews'})`)
      : h('span', { class: 'muted', text: 'No reviews yet' }));
    $('biz-sub').replaceChildren(...sub);
    $('side-switch').hidden = !(me.shop && me.garage);
    // A suspended shop or garage is hidden from customers; its owner sees why.
    $('biz-alert').hidden = !biz.suspended;
    $('biz-alert').textContent = biz.suspended
      ? `The vinzuu team has suspended your ${side} on Vinzuu, so customers cannot see it right now. Reason: ${biz.suspended_reason || 'not given'}. Contact the vinzuu team to fix it.` : '';
    $('side-switch').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.side === side)));
  }

  async function showTab(key) {
    for (const [k] of tabsFor()) $(`tab-${k}`).setAttribute('aria-selected', String(k === key));
    history.replaceState(null, '', `#${key}`);
    const panel = $('panel');
    panel.replaceChildren(h('p', { class: 'muted', text: 'Loading…' }));
    const render = tabsFor().find(([k]) => k === key)[2];
    try { panel.replaceChildren(await render()); } catch (err) {
      if (err.status === 401) { location.reload(); return; }
      panel.replaceChildren(h('p', { class: 'status error', text: err.message }));
    }
  }

  // ---------------------------------------------------------------- small helpers

  const statusEl = () => h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
  function field(labelText, control, hint) {
    return h('div', { class: 'field' }, h('label', { for: control.id, text: labelText }), control, hint ? h('p', { class: 'hint', text: hint }) : null);
  }
  function table(columns, rows, empty) {
    if (!rows.length) return h('p', { class: 'empty muted', text: empty || 'Nothing here yet.' });
    return h('div', { class: 'table-scroll' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ...columns.map((c) => h('th', { text: c.label })))),
      h('tbody', {}, ...rows.map((r) => h('tr', { class: c0(r, columns) }, ...columns.map((c) => {
        const v = c.render ? c.render(r) : r[c.key];
        return h('td', { class: c.num ? 'num' : '', 'data-label': c.label }, v == null ? '' : v);
      }))))));
  }
  const c0 = (r, columns) => (columns.rowClass ? columns.rowClass(r) : null);
  const stat = (n, [one, many], tone) => h('div', { class: `stat${tone ? ` stat-${tone}` : ''}` },
    h('b', { text: String(n) }), h('span', { text: n === 1 ? one : many }));

  /** "14 Oct, 09:30" from the server's UTC timestamps. */
  function fmtWhen(ts) {
    if (!ts) return '';
    const d = new Date(String(ts).replace(' ', 'T') + 'Z');
    return Number.isNaN(d.getTime()) ? ts : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  /** A garage's own appointment time ("2026-10-15 10:00") is local already. */
  function fmtSlot(t) {
    if (!t) return '';
    const d = new Date(String(t).replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? t : d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  const carTitle = (b) => `${b.year} ${b.make} ${b.model}${b.generation ? ` ${b.generation}` : ''}`;
  const partTitle = (b) => (b.part_category
    ? `${b.part_category}${b.oe_number ? ` (${b.oe_number})` : b.universal_spec ? ` (${b.universal_spec})` : ''}` : 'Repair only');
  function fitsLine(f) {
    return `${f.make} ${f.model}${f.generation ? ` ${f.generation}` : ''}, ${f.year_start} to ${f.year_end}${f.engine ? `, ${f.engine}` : ''}${f.origin_market ? `, ${f.origin_market}-built` : ''}`;
  }

  const SHOP_STATUS = {
    requested: ['New', 'pill-new'], confirmed: ['Reserved', 'pill-ok'], collected: ['Collected', 'pill-done'], cancelled: ['Cancelled', 'pill-off'],
  };
  const GARAGE_STATUS = {
    requested: ['New', 'pill-new'], accepted: ['Booked', 'pill-ok'], done: ['Done', 'pill-done'], declined: ['Declined', 'pill-off'],
  };
  const pill = (map, status) => h('span', { class: `pill ${map[status] ? map[status][1] : ''}`, text: map[status] ? map[status][0] : status });

  function dialog(title, content) {
    const dlg = $('biz-dialog');
    const close = () => { if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open'); };
    dlg.replaceChildren(h('div', { class: 'dialog-body' }, h('h2', { id: 'biz-dialog-title', text: title }), ...content(close)));
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
    return close;
  }

  // ================================================================ SHOP SIDE

  const shopId = () => me.shop.id;

  async function shopOverview() {
    const [{ listings }, { bookings }, { requests }] = await Promise.all([
      api(`/api/shops/${shopId()}/listings`), api(`/api/shops/${shopId()}/bookings`), api(`/api/shops/${shopId()}/listing-requests`),
    ]);
    const onSale = listings.filter((l) => !l.hidden && l.stock_quantity > 0).length;
    const out = listings.filter((l) => !l.hidden && l.stock_quantity === 0).length;
    const fresh = bookings.filter((b) => b.shop_status === 'requested').length;
    const waiting = requests.filter((r) => r.status === 'pending').length;
    return h('div', {},
      h('div', { class: 'stat-grid' },
        stat(onSale, ['part on sale', 'parts on sale']),
        stat(out, ['part out of stock', 'parts out of stock'], out ? 'warn' : null),
        stat(fresh, ['new booking', 'new bookings'], fresh ? 'new' : null),
        stat(waiting, ['request waiting for vinzuu', 'requests waiting for vinzuu'])),
      out ? h('p', { class: 'note-box' }, `${out} of your parts ${out === 1 ? 'is' : 'are'} out of stock, so customers cannot see ${out === 1 ? 'it' : 'them'}. `,
        h('button', { class: 'link-btn', type: 'button', text: 'Update stock', onclick: () => showTab('parts') })) : null,
      h('h2', { text: 'Latest bookings' }),
      table([
        { label: 'When', render: (b) => fmtWhen(b.created_at) },
        { label: 'Part', render: (b) => partTitle(b) },
        { label: 'Car', render: (b) => carTitle(b) },
        { label: 'Status', render: (b) => pill(SHOP_STATUS, b.shop_status) },
      ], bookings.slice(0, 5), 'No bookings yet. When a customer reserves one of your parts, it shows up here.'),
      bookings.length > 5 ? h('button', { class: 'btn btn-secondary btn-small', type: 'button', text: 'See all bookings', onclick: () => showTab('bookings') }) : null);
  }

  // ---------------------------------------------------------------- my parts

  async function shopParts() {
    const { listings } = await api(`/api/shops/${shopId()}/listings`);
    let filter = 'all';
    const search = h('input', { id: 'parts-q', type: 'search', placeholder: 'Search part, part number or brand', 'aria-label': 'Search your parts' });
    const mount = h('div', {});
    const filters = [['all', 'All'], ['sale', 'On sale'], ['out', 'Out of stock'], ['hidden', 'Hidden by vinzuu']];
    const seg = h('div', { class: 'seg seg-wrap', role: 'group', 'aria-label': 'Show' }, ...filters.map(([k, label]) => h('button', {
      type: 'button', 'aria-pressed': String(k === filter), text: label,
      onclick: (e) => { filter = k; seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.target))); draw(); },
    })));
    const statusOf = (l) => (l.hidden ? 'hidden' : l.stock_quantity > 0 ? 'sale' : 'out');
    function draw() {
      const q = search.value.trim().toLowerCase();
      const rows = listings.filter((l) => (filter === 'all' || statusOf(l) === filter)
        && (!q || [l.part_category, l.oe_number, l.universal_spec, l.brand, l.description].some((x) => String(x || '').toLowerCase().includes(q))));
      mount.replaceChildren(table(partColumns(), rows,
        listings.length ? 'No parts match.' : 'You have no parts on Vinzuu yet. Use "Request a part" and the vinzuu team will post it for you.'));
    }
    search.addEventListener('input', draw);
    draw();
    return h('div', {},
      h('p', { class: 'muted', text: 'The vinzuu team posts your parts after checking them. You keep the price and stock up to date. A part with 0 in stock is hidden from customers until you restock it.' }),
      h('div', { class: 'parts-tools' }, search, seg), mount);
  }

  function partColumns() {
    return [
      { label: 'Photo', render: (l) => h('button', { class: 'thumb-btn', type: 'button', title: 'See details', onclick: () => partDetails(l) },
        h('img', { class: 'thumb', src: l.photo_url, alt: `Photo of ${l.part_category}` })) },
      { label: 'Part', render: (l) => h('div', { class: 'part-cell' },
        h('strong', { text: l.part_category }),
        h('span', { class: 'small muted', text: [l.oe_number ? `Part number ${l.oe_number}` : l.universal_spec, l.brand].filter(Boolean).join(' · ') }),
        l.description ? h('span', { class: 'small part-desc', text: l.description }) : null,
        h('button', { class: 'link-btn small', type: 'button', text: 'Details', onclick: () => partDetails(l) })) },
      { label: 'Fits', render: (l) => (l.fits.length
        ? h('span', { class: 'small', text: fitsLine(l.fits[0]) + (l.fits.length > 1 ? ` and ${l.fits.length - 1} more` : '') })
        : h('span', { class: 'small muted', text: 'Any car (universal)' })) },
      { label: 'Type', render: (l) => (l.condition === 'genuine' ? 'Genuine' : 'Aftermarket') },
      { label: 'Price and stock', render: priceStockCell },
      { label: 'Status', render: (l) => (l.hidden ? pill({ x: ['Hidden by vinzuu', 'pill-off'] }, 'x')
        : l.stock_quantity > 0 ? pill({ x: ['On sale', 'pill-ok'] }, 'x') : pill({ x: ['Out of stock', 'pill-warn'] }, 'x')) },
      { label: 'Bookings', num: true, key: 'bookings' },
      { label: 'Updated', render: (l) => h('span', { class: 'small', text: fmtWhen(l.updated_at) }) },
    ];
  }

  function priceStockCell(l) {
    const price = h('input', { type: 'number', inputMode: 'numeric', min: 1, value: l.price_rwf, 'aria-label': `Price of ${l.part_category} in RWF` });
    const stock = h('input', { type: 'number', inputMode: 'numeric', min: 0, value: l.stock_quantity, 'aria-label': `Stock of ${l.part_category}` });
    const msg = h('span', { class: 'small', role: 'status' });
    const save = h('button', { class: 'btn btn-secondary btn-small', type: 'button', text: 'Save', onclick: async () => {
      msg.textContent = 'Saving…';
      try {
        const res = await api(`/api/shops/${shopId()}/listings/${l.id}`, { method: 'PUT', body: { price_rwf: Number(price.value), stock_quantity: Number(stock.value) } });
        Object.assign(l, res.listing, { hidden: !!res.listing.hidden });
        msg.textContent = 'Saved';
      } catch (err) { msg.textContent = err.message; }
    } });
    return h('div', { class: 'price-stock' },
      h('label', { class: 'ps-field' }, h('span', { text: 'RWF' }), price),
      h('label', { class: 'ps-field' }, h('span', { text: 'Stock' }), stock),
      h('span', { class: 'ps-actions' }, save, msg));
  }

  function partDetails(l) {
    dialog(l.part_category, (close) => [
      h('img', { class: 'detail-photo', src: l.photo_url, alt: `Photo of ${l.part_category}` }),
      h('dl', { class: 'detail-list' },
        ...[
          ['Part number', l.oe_number], ['Size', l.universal_spec], ['Brand', l.brand],
          ['Type', l.condition === 'genuine' ? 'Genuine part' : 'Aftermarket part'],
          ['Warranty', l.warranty_months ? `${l.warranty_months} months` : null],
          ['Price', fmtRwf(l.price_rwf)], ['In stock', String(l.stock_quantity)],
        ].filter(([, v]) => v).flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
      l.description ? h('p', { class: 'detail-desc', text: l.description }) : h('p', { class: 'muted', text: 'No description yet.' }),
      l.fits.length ? h('div', {}, h('h3', { text: 'Fits these cars' }), h('ul', { class: 'fits-list' }, ...l.fits.map((f) => h('li', { text: fitsLine(f) })))) : null,
      h('p', { class: 'small muted', text: 'To change anything except price and stock, send a request from "Request a part" with a note, or contact the vinzuu team.' }),
      h('div', { class: 'dialog-actions' }, h('button', { class: 'btn btn-quiet', type: 'button', text: 'Close', onclick: close })),
    ]);
  }

  // ---------------------------------------------------------------- request a part

  async function shopRequest() {
    const { requests } = await api(`/api/shops/${shopId()}/listing-requests`);
    const status = statusEl();
    let photo = null;
    const f = {
      cat: h('select', { id: 'rq-cat' }, ...categoryOptions(catalog.categories, 'Choose a part')),
      oe: h('select', { id: 'rq-oe' }),
      spec: h('input', { id: 'rq-spec', type: 'text', maxLength: 80, placeholder: 'For example 12V 60Ah, or 24 inch' }),
      brand: h('input', { id: 'rq-brand', type: 'text', maxLength: 60, placeholder: 'For example Toyota, Bosch, Denso' }),
      condition: h('select', { id: 'rq-cond' }, h('option', { value: 'genuine', text: 'Genuine part' }), h('option', { value: 'aftermarket', text: 'Aftermarket part' })),
      warranty: h('input', { id: 'rq-war', type: 'number', inputMode: 'numeric', min: 0, max: 120, placeholder: 'No warranty' }),
      price: h('input', { id: 'rq-price', type: 'number', inputMode: 'numeric', min: 1 }),
      stock: h('input', { id: 'rq-stock', type: 'number', inputMode: 'numeric', min: 0, value: 1 }),
      desc: h('textarea', { id: 'rq-desc', maxLength: 600, rows: 3, placeholder: 'For example: Ceramic front brake pads, set of 4, low dust, includes wear sensor.' }),
      photo: h('input', { id: 'rq-photo', type: 'file', accept: 'image/*' }),
      preview: h('img', { class: 'photo-preview', alt: 'Photo preview', hidden: true }),
      note: h('textarea', { id: 'rq-note', maxLength: 300, rows: 2, placeholder: 'Anything the vinzuu team should know (optional)' }),
    };
    // The car narrows the part numbers, so the list stays short.
    const car = carSelects(catalog.makes, 'rq', { onChange: () => loadNumbers() });
    const oeWrap = h('div', {},
      h('div', { class: 'field' }, h('label', { for: 'rq-make', text: 'Which car is it for?' }),
        h('div', { class: 'car-selects' }, ...car.fields),
        h('p', { class: 'hint', text: 'Choose the car to see only its part numbers.' })),
      field('Part number', f.oe, 'Choose the number printed on the box or on the old part. If it is missing, write it in the note.'));
    const specWrap = field('Size or specification', f.spec);
    oeWrap.hidden = true; specWrap.hidden = true;
    async function loadNumbers() {
      const cat = catalog.categories.find((c) => c.name === f.cat.value);
      if (!cat || cat.type !== 'model_specific') return;
      f.oe.replaceChildren(h('option', { value: '', text: 'Loading…' }));
      try {
        const data = await api(`/api/shop/oe-numbers?part_category=${enc(cat.name)}&${car.query()}`);
        const choices = oeChoices(data.rows);
        f.oe.replaceChildren(h('option', { value: '', text: choices.length ? `Choose the part number (${choices.length})` : 'No part numbers for this car yet: write it in the note' }),
          ...choices.map((c) => h('option', { value: c.oe, text: c.text })));
      } catch (err) { setStatus(status, err.message, 'error'); }
    }
    f.cat.addEventListener('change', () => {
      const cat = catalog.categories.find((c) => c.name === f.cat.value);
      oeWrap.hidden = !cat || cat.type !== 'model_specific';
      specWrap.hidden = !cat || cat.type !== 'universal';
      loadNumbers();
    });
    f.photo.addEventListener('change', async (e) => {
      photo = null; f.preview.hidden = true;
      const file = e.target.files[0];
      if (!file) return;
      try { photo = await resizeImage(file); f.preview.src = photo; f.preview.hidden = false; } catch (err) { setStatus(status, err.message, 'error'); }
    });

    const form = h('form', { class: 'panel', novalidate: true, onsubmit: async (event) => {
      event.preventDefault();
      const cat = catalog.categories.find((c) => c.name === f.cat.value);
      const problem = !cat ? 'Choose which part it is.'
        : cat.type === 'model_specific' && !f.oe.value ? 'Choose the part number.'
          : cat.type === 'universal' && !f.spec.value.trim() ? 'Enter the size or specification.'
            : !f.price.value ? 'Enter the price in RWF.'
              : !f.desc.value.trim() ? 'Write a short description, so customers know what they get.'
                : !photo ? 'Add a photo of the actual part.' : null;
      if (problem) return setStatus(status, problem, 'error');
      setStatus(status, 'Sending…');
      try {
        await api(`/api/shops/${shopId()}/listing-requests`, { method: 'POST', body: {
          part_category: cat.name, oe_number: cat.type === 'model_specific' ? f.oe.value : null,
          universal_spec: cat.type === 'universal' ? f.spec.value : null, brand: f.brand.value || null,
          condition: f.condition.value, warranty_months: f.warranty.value === '' ? null : Number(f.warranty.value),
          price_rwf: Number(f.price.value), stock_quantity: Number(f.stock.value || 0),
          description: f.desc.value, photo_url: photo, note: f.note.value || null,
        } });
        setStatus(status, 'Sent. The vinzuu team will check it; you will see the answer below.', 'ok');
        setTimeout(() => showTab('request'), 1500);
      } catch (err) { setStatus(status, err.message, 'error'); }
    } },
      h('h2', { text: 'Ask vinzuu to post a part' }),
      h('p', { class: 'muted', text: 'We check every part before customers see it, so nobody can sell a fake one. Most requests are answered within a day.' }),
      field('Part', f.cat), oeWrap, specWrap,
      h('div', { class: 'row stack-sm' }, field('Brand', f.brand), field('Type of part', f.condition, 'Genuine means the car maker\'s own part.')),
      h('div', { class: 'row stack-sm' }, field('Price in RWF', f.price), field('How many in stock', f.stock)),
      field('Warranty in months (optional)', f.warranty),
      field('Description', f.desc, 'What customers read on the part. Say what is in the box and anything special about it.'),
      h('div', { class: 'field' }, h('label', { for: 'rq-photo', text: 'Photo of the actual part' }), f.photo,
        h('p', { class: 'hint', text: 'Take it on your shelf, in good light. Customers only see parts with a photo.' }), f.preview),
      field('Note to the vinzuu team', f.note),
      h('button', { class: 'btn btn-primary', type: 'submit', text: 'Send for checking' }), status);

    const REQ = { pending: ['Waiting', 'pill-new'], approved: ['Approved, on sale', 'pill-ok'], rejected: ['Not approved', 'pill-off'] };
    return h('div', {}, form,
      h('h2', { text: 'My requests' }),
      table([
        { label: 'Sent', render: (r) => fmtWhen(r.created_at) },
        { label: 'Part', render: (r) => h('div', { class: 'part-cell' }, h('strong', { text: r.part_category }),
          h('span', { class: 'small muted', text: [r.oe_number || r.universal_spec, r.brand].filter(Boolean).join(' · ') })) },
        { label: 'Price', render: (r) => fmtRwf(r.price_rwf) },
        { label: 'Status', render: (r) => pill(REQ, r.status) },
        { label: 'Answer from vinzuu', render: (r) => r.admin_note || (r.status === 'pending' ? 'Not checked yet' : '') },
      ], requests, 'You have not asked for any parts yet.'));
  }

  // ---------------------------------------------------------------- bookings

  async function shopBookings() {
    const { bookings } = await api(`/api/shops/${shopId()}/bookings`);
    const actions = (b) => {
      const go = (status) => async () => {
        try { await api(`/api/shops/${shopId()}/bookings/${b.id}`, { method: 'PUT', body: { status } }); showTab('bookings'); }
        catch (err) { alert(err.message); }
      };
      const btn = (text, status, cls = 'btn-secondary') => h('button', { class: `btn ${cls} btn-small`, type: 'button', text, onclick: go(status) });
      if (b.shop_status === 'requested') return h('div', { class: 'btn-row' }, btn('Reserve it', 'confirmed', 'btn-primary'), btn('Cancel', 'cancelled', 'btn-quiet'));
      if (b.shop_status === 'confirmed') return h('div', { class: 'btn-row' }, btn('Collected', 'collected', 'btn-primary'), btn('Cancel', 'cancelled', 'btn-quiet'));
      return null;
    };
    return h('div', {},
      h('p', { class: 'muted', text: 'Customers who reserved one of your parts. Reserve it for them, then mark it collected when they pick it up. Once collected, the customer can rate your shop.' }),
      table([
        { label: 'When', render: (b) => fmtWhen(b.created_at) },
        { label: 'Part', render: (b) => h('div', { class: 'part-cell' }, h('strong', { text: partTitle(b) }), h('span', { class: 'small muted', text: fmtRwf(b.price_rwf) })) },
        { label: 'Car', render: (b) => h('div', { class: 'part-cell' }, h('strong', { text: carTitle(b) }),
          h('span', { class: 'small muted', text: [b.engine, b.vin_masked ? `VIN ${b.vin_masked}` : null].filter(Boolean).join(' · ') })) },
        { label: 'Customer', render: (b) => h('div', { class: 'part-cell' },
          h('a', { href: whatsappLink(b.customer_phone, `Hello, this is ${me.shop.name} about your Vinzuu booking for ${partTitle(b)}.`), target: '_blank', rel: 'noopener', text: b.customer_phone }),
          b.note ? h('span', { class: 'small', text: `"${b.note}"` }) : null) },
        { label: 'Fitting', render: (b) => (b.garage_name ? h('div', { class: 'part-cell' }, h('span', { text: b.garage_name }),
          h('span', { class: 'small muted', text: b.garage_status === 'accepted' ? `Booked ${fmtSlot(b.garage_time)}` : GARAGE_STATUS[b.garage_status] ? GARAGE_STATUS[b.garage_status][0] : '' })) : 'No garage') },
        { label: 'Status', render: (b) => pill(SHOP_STATUS, b.shop_status) },
        { label: '', render: actions },
      ], bookings, 'No bookings yet. When a customer reserves one of your parts, it shows up here.'));
  }

  // ---------------------------------------------------------------- look up a car (VIN-first)

  async function lookupTab() {
    const normalizePlate = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const vin = h('input', {
      id: 'lk-vin', type: 'text', maxLength: 17, autocomplete: 'off', autocapitalize: 'characters', placeholder: '17-character VIN',
      oninput: (e) => { e.target.value = e.target.value.toUpperCase().replace(/\s/g, ''); },
    });
    const plate = h('input', { id: 'lk-plate', type: 'text', autocomplete: 'off', autocapitalize: 'characters', placeholder: 'RAE 123 A',
      oninput: (e) => { e.target.value = e.target.value.toUpperCase(); } });
    const status = statusEl();
    const resultMount = h('div');
    async function tryFind(path) {
      if (!path) return null;
      try { return (await api(path)).vehicle; } catch (err) { if (err.code === 'not_registered') return null; throw err; }
    }
    const form = h('form', { class: 'panel', novalidate: true, onsubmit: async (event) => {
      event.preventDefault();
      resultMount.replaceChildren();
      const v = vin.value.trim();
      const p = plate.value.trim();
      if (!v && !p) return setStatus(status, 'Enter a VIN or a plate number.', 'error');
      setStatus(status, 'Searching…');
      try {
        let vehicle = await tryFind(v ? `/api/vehicles/by-vin/${enc(v)}` : null);
        if (!vehicle && p) vehicle = await tryFind(`/api/vehicles/${enc(normalizePlate(p))}`);
        setStatus(status, vehicle ? '' : 'This car is not on Vinzuu yet. Ask the customer to add it from their garage page.', vehicle ? null : 'error');
        if (vehicle) showKnownCar(vehicle, resultMount);
      } catch (err) { setStatus(status, err.message, 'error'); }
    } },
      field('VIN (recommended)', vin, 'The one number that always points to the same car, even after a plate changes.'),
      field('Plate (if the VIN is not to hand)', plate),
      h('button', { class: 'btn btn-primary', type: 'submit', text: 'Search' }), status);
    return h('div', {},
      h('p', { class: 'muted', text: 'Check a customer\'s exact car before you sell, so the part fits the first time.' }), form, resultMount);
  }

  function showKnownCar(vehicle, mount) {
    const details = [vehicle.generation, vehicle.engine, vehicle.transmission ? vehicle.transmission.toLowerCase() : null,
      vehicle.origin_market ? `built in ${vehicle.origin_market}` : null].filter(Boolean).join(', ');
    mount.replaceChildren(h('div', { class: 'panel' },
      h('p', { class: 'status ok', text: 'Car found.' }),
      h('div', { class: 'vehicle-text' },
        h('strong', { text: `${vehicle.year} ${vehicle.make} ${vehicle.model}` }),
        h('span', { text: details || 'No further build details on file yet.' })),
      h('p', { class: 'small muted', text: vehicle.has_vin ? `VIN on file: ${vehicle.vin_masked}` : 'No VIN on file for this car yet.' })));
  }

  // ---------------------------------------------------------------- profile (both sides)

  function profileForm(kind) {
    const biz = me[kind];
    const status = statusEl();
    const f = {
      phone: h('input', { id: 'pf-phone', type: 'tel', value: biz.phone || '' }),
      wa: h('input', { id: 'pf-wa', type: 'tel', value: biz.whatsapp_number || '', placeholder: 'Same as phone if blank' }),
      address: h('input', { id: 'pf-addr', type: 'text', maxLength: 120, value: biz.address_text || '' }),
      hours: h('input', { id: 'pf-hours', type: 'text', maxLength: 120, value: biz.opening_hours || '', placeholder: 'For example: Mon to Sat 8:00 to 18:00' }),
      spec: kind === 'garage' ? h('input', { id: 'pf-spec', type: 'text', maxLength: 160, value: biz.specialties || '', placeholder: 'For example: brakes, suspension, Korean cars' }) : null,
    };
    const mapHref = `https://www.google.com/maps/search/?api=1&query=${biz.latitude},${biz.longitude}`;
    return h('div', {},
      h('form', { class: 'panel', novalidate: true, onsubmit: async (event) => {
        event.preventDefault();
        setStatus(status, 'Saving…');
        try {
          const body = { phone: f.phone.value, whatsapp_number: f.wa.value || null, address_text: f.address.value, opening_hours: f.hours.value };
          if (kind === 'garage') body.specialties = f.spec.value;
          me = await api(`/api/${kind}/profile`, { method: 'PUT', body });
          renderHead();
          setStatus(status, 'Saved. Customers see the new details now.', 'ok');
        } catch (err) { setStatus(status, err.message, 'error'); }
      } },
        h('h2', { text: kind === 'shop' ? 'Shop profile' : 'Garage profile' }),
        h('p', { class: 'muted', text: 'What customers see when they choose you.' }),
        h('div', { class: 'row stack-sm' }, field('Phone', f.phone), field('WhatsApp', f.wa)),
        field('Address or area', f.address),
        field('Opening hours', f.hours),
        f.spec ? field('What you are good at', f.spec, 'Customers see up to three of these, separated by commas.') : null,
        h('button', { class: 'btn btn-primary', type: 'submit', text: 'Save profile' }), status),
      h('div', { class: 'panel locked-box' },
        h('h3', { text: 'Checked by vinzuu' }),
        h('p', { class: 'muted', text: 'Your name and map location were checked when you joined, so only the vinzuu team can change them. This stops anyone from pretending to be another business.' }),
        h('dl', { class: 'detail-list' },
          h('dt', { text: 'Name' }), h('dd', { text: biz.name }),
          h('dt', { text: 'Location' }), h('dd', {}, h('a', { href: mapHref, target: '_blank', rel: 'noopener', text: 'Open on the map' })))));
  }
  function shopProfile() { return profileForm('shop'); }
  function garageProfile() { return profileForm('garage'); }

  // ---------------------------------------------------------------- reviews (both sides)

  async function reviewsTab(kind) {
    const { rating, reviews } = await api(`/api/${kind}/reviews`);
    const counts = [5, 4, 3, 2, 1].map((n) => [n, reviews.filter((r) => r.rating === n).length]);
    const replyActions = (r) => h('div', { class: 'review-actions' },
      h('button', { class: 'link-btn small', type: 'button', text: r.reply ? 'Edit reply' : 'Reply', onclick: () => {
        const box = h('textarea', { id: 'rv-reply', maxLength: 300, rows: 3, value: r.reply || '' });
        const status = statusEl();
        dialog(`Reply to ${r.author_name}`, (close) => [
          h('p', { class: 'muted', text: `"${r.comment || `${r.rating} stars, no comment`}"` }),
          field('Your reply (everyone can see it)', box),
          status,
          h('div', { class: 'dialog-actions' },
            h('button', { class: 'btn btn-primary', type: 'button', text: 'Save reply', onclick: async () => {
              try { await api(`/api/${kind}/reviews/${r.id}`, { method: 'PUT', body: { reply: box.value } }); close(); showTab('reviews'); }
              catch (err) { setStatus(status, err.message, 'error'); }
            } }),
            h('button', { class: 'btn btn-quiet', type: 'button', text: 'Cancel', onclick: close })),
        ]);
        box.focus();
      } }));
    return h('div', {},
      h('div', { class: 'review-summary panel' },
        h('div', { class: 'rs-score' },
          h('b', { text: rating.count ? String(rating.average) : '–' }),
          rating.count ? starsEl(rating.average) : null,
          h('span', { class: 'muted', text: `${rating.count} ${rating.count === 1 ? 'review' : 'reviews'}` })),
        h('ul', { class: 'rs-bars' }, ...counts.map(([n, c]) => h('li', {},
          h('span', { text: `${n} ★` }),
          h('span', { class: 'rs-bar' }, h('span', { style: `width:${rating.count ? Math.round((c / rating.count) * 100) : 0}%` })),
          h('span', { class: 'small muted', text: String(c) }))))),
      h('p', { class: 'muted', text: `Only customers who ${kind === 'shop' ? 'collected a part from you' : 'had a job done by you'} through Vinzuu can review you, so every review is from a real customer. A polite reply helps.` }),
      reviewList(reviews, { empty: 'No reviews yet.', actions: replyActions }));
  }

  // ================================================================ GARAGE SIDE

  async function garageOverview() {
    const [{ jobs }, { services }] = await Promise.all([api('/api/garage/jobs'), api('/api/garage/services')]);
    const today = new Date().toISOString().slice(0, 10);
    const weekEnd = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    const fresh = jobs.filter((j) => j.garage_status === 'requested');
    const booked = jobs.filter((j) => j.garage_status === 'accepted').sort((a, b) => String(a.garage_time).localeCompare(String(b.garage_time)));
    const todays = booked.filter((j) => String(j.garage_time).startsWith(today));
    const week = booked.filter((j) => String(j.garage_time).slice(0, 10) <= weekEnd);
    const done = jobs.filter((j) => j.garage_status === 'done').length;
    return h('div', {},
      h('div', { class: 'stat-grid' },
        stat(fresh.length, ['new job request', 'new job requests'], fresh.length ? 'new' : null),
        stat(todays.length, ['job today', 'jobs today']),
        stat(week.length, ['job this week', 'jobs this week']),
        stat(done, ['job done', 'jobs done'])),
      !services.length ? h('p', { class: 'note-box' }, 'Add your labour prices so customers know the cost before they book. ',
        h('button', { class: 'link-btn', type: 'button', text: 'Add prices', onclick: () => showTab('services') })) : null,
      fresh.length ? h('p', { class: 'note-box' }, `${fresh.length} ${fresh.length === 1 ? 'customer is' : 'customers are'} waiting for your answer. `,
        h('button', { class: 'link-btn', type: 'button', text: 'Answer now', onclick: () => showTab('jobs') })) : null,
      h('h2', { text: 'Coming up' }),
      table([
        { label: 'When', render: (j) => h('strong', { text: fmtSlot(j.garage_time) }) },
        { label: 'Job', render: (j) => partTitle(j) },
        { label: 'Car', render: (j) => carTitle(j) },
        { label: 'Customer', render: (j) => h('a', { href: whatsappLink(j.customer_phone, `Hello, this is ${me.garage.name} about your Vinzuu booking.`), target: '_blank', rel: 'noopener', text: j.customer_phone }) },
      ], booked.slice(0, 6), 'No jobs booked yet. Accept a job request and it shows up here.'));
  }

  async function garageJobs() {
    const { jobs } = await api('/api/garage/jobs');
    let filter = jobs.some((j) => j.garage_status === 'requested') ? 'requested' : 'accepted';
    const filters = [['requested', 'New'], ['accepted', 'Booked'], ['done', 'Done'], ['declined', 'Declined'], ['all', 'All']];
    const mount = h('div', { class: 'job-list' });
    const seg = h('div', { class: 'seg seg-wrap', role: 'group', 'aria-label': 'Show' }, ...filters.map(([k, label]) => {
      const n = k === 'all' ? jobs.length : jobs.filter((j) => j.garage_status === k).length;
      return h('button', { type: 'button', 'aria-pressed': String(k === filter), text: `${label} (${n})`,
        onclick: (e) => { filter = k; seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.target))); draw(); } });
    }));
    function draw() {
      const rows = jobs.filter((j) => filter === 'all' || j.garage_status === filter);
      mount.replaceChildren(...(rows.length ? rows.map(jobCard) : [h('p', { class: 'empty muted', text: 'No jobs here.' })]));
    }
    draw();
    return h('div', {},
      h('p', { class: 'muted', text: 'Customers who bought a part on Vinzuu and chose you to fit it. Accept with a date and time, or decline with a reason. Mark it done when the car is ready: the customer can then rate your garage.' }),
      seg, mount);
  }

  function jobCard(j) {
    const act = async (body) => {
      try { await api(`/api/garage/jobs/${j.id}`, { method: 'PUT', body }); showTab('jobs'); } catch (err) { alert(err.message); }
    };
    const accept = () => {
      const when = h('input', { id: 'job-when', type: 'datetime-local', min: new Date().toISOString().slice(0, 16) });
      if (j.garage_time) when.value = j.garage_time.replace(' ', 'T');
      const status = statusEl();
      dialog('Accept this job', (close) => [
        h('p', { class: 'muted', text: `${partTitle(j)} on a ${carTitle(j)}.` }),
        field('When should the customer come?', when),
        status,
        h('div', { class: 'dialog-actions' },
          h('button', { class: 'btn btn-primary', type: 'button', text: 'Accept job', onclick: async () => {
            if (!when.value) return setStatus(status, 'Choose the date and time.', 'error');
            try { await api(`/api/garage/jobs/${j.id}`, { method: 'PUT', body: { action: 'accept', time: when.value } }); close(); showTab('jobs'); }
            catch (err) { setStatus(status, err.message, 'error'); }
          } }),
          h('button', { class: 'btn btn-quiet', type: 'button', text: 'Cancel', onclick: close })),
      ]);
    };
    const decline = () => {
      const reason = h('select', { id: 'job-reason' }, ...['We are fully booked', 'We do not work on this car', 'We do not do this job', 'Other'].map((r) => h('option', { value: r, text: r })));
      const other = h('input', { id: 'job-reason-other', type: 'text', maxLength: 200, placeholder: 'Say why (the customer sees this)', hidden: true });
      reason.addEventListener('change', () => { other.hidden = reason.value !== 'Other'; });
      const status = statusEl();
      dialog('Decline this job', (close) => [
        field('Reason', reason), other, status,
        h('div', { class: 'dialog-actions' },
          h('button', { class: 'btn btn-danger', type: 'button', text: 'Decline job', onclick: async () => {
            const why = reason.value === 'Other' ? other.value.trim() : reason.value;
            if (!why) return setStatus(status, 'Say why you are declining.', 'error');
            try { await api(`/api/garage/jobs/${j.id}`, { method: 'PUT', body: { action: 'decline', reason: why } }); close(); showTab('jobs'); }
            catch (err) { setStatus(status, err.message, 'error'); }
          } }),
          h('button', { class: 'btn btn-quiet', type: 'button', text: 'Cancel', onclick: close })),
      ]);
    };
    const wa = whatsappLink(j.customer_phone, `Hello, this is ${me.garage.name} about fitting ${partTitle(j)} on your ${carTitle(j)} (Vinzuu booking).`);
    return h('article', { class: `job-card job-${j.garage_status}` },
      h('div', { class: 'job-top' },
        pill(GARAGE_STATUS, j.garage_status),
        h('span', { class: 'small muted', text: `Requested ${fmtWhen(j.created_at)}` })),
      j.garage_status === 'accepted' || j.garage_status === 'done' ? h('p', { class: 'job-when' }, icon('calendar'), fmtSlot(j.garage_time)) : null,
      h('h3', { text: partTitle(j) }),
      h('dl', { class: 'job-facts' },
        h('dt', { text: 'Car' }), h('dd', { text: [carTitle(j), j.engine, j.vin_masked ? `VIN ${j.vin_masked}` : null].filter(Boolean).join(' · ') }),
        j.shop_name ? h('dt', { text: 'Part from' }) : null,
        j.shop_name ? h('dd', {}, `${j.shop_name}, ${j.shop_address || ''} `, h('a', { href: `tel:${j.shop_phone}`, text: j.shop_phone }),
          ` (${SHOP_STATUS[j.shop_status] ? SHOP_STATUS[j.shop_status][0].toLowerCase() : j.shop_status})`) : null,
        h('dt', { text: 'Customer' }), h('dd', {}, h('a', { href: wa, target: '_blank', rel: 'noopener', text: j.customer_phone })),
        j.note ? h('dt', { text: 'Note' }) : null, j.note ? h('dd', { text: `"${j.note}"` }) : null,
        j.garage_status === 'declined' ? h('dt', { text: 'Your reason' }) : null,
        j.garage_status === 'declined' ? h('dd', { text: j.garage_note || '' }) : null),
      h('div', { class: 'btn-row' },
        j.garage_status === 'requested' ? h('button', { class: 'btn btn-primary btn-small', type: 'button', text: 'Accept', onclick: accept }) : null,
        j.garage_status === 'requested' ? h('button', { class: 'btn btn-quiet btn-small', type: 'button', text: 'Decline', onclick: decline }) : null,
        j.garage_status === 'accepted' ? h('button', { class: 'btn btn-primary btn-small', type: 'button', text: 'Mark done', onclick: () => {
          if (confirm(`Is the ${carTitle(j)} ready?`)) act({ action: 'done' });
        } }) : null,
        j.garage_status === 'accepted' ? h('button', { class: 'btn btn-secondary btn-small', type: 'button', text: 'Change time', onclick: accept }) : null,
        h('a', { class: 'btn btn-secondary btn-small', href: wa, target: '_blank', rel: 'noopener', text: 'WhatsApp customer' })));
  }

  async function garageServices() {
    const { services } = await api('/api/garage/services');
    const status = statusEl();
    const catOptions = (selected) => categoryOptions(catalog.categories, 'General work (no part)', { selected, label: (c) => `Fitting: ${c.name}` });
    const f = {
      name: h('input', { id: 'sv-name', type: 'text', maxLength: 80, placeholder: 'For example: Fit front brake pads' }),
      cat: h('select', { id: 'sv-cat' }, ...catOptions(null)),
      price: h('input', { id: 'sv-price', type: 'number', inputMode: 'numeric', min: 1 }),
      mins: h('input', { id: 'sv-mins', type: 'number', inputMode: 'numeric', min: 5, placeholder: 'Optional' }),
    };
    f.cat.addEventListener('change', () => { if (!f.name.value && f.cat.value) f.name.value = `Fit ${f.cat.value.toLowerCase()}`; });
    const form = h('form', { class: 'panel', novalidate: true, onsubmit: async (event) => {
      event.preventDefault();
      if (!f.name.value.trim()) return setStatus(status, 'Name the service.', 'error');
      if (!f.price.value) return setStatus(status, 'Enter the price in RWF.', 'error');
      try {
        await api('/api/garage/services', { method: 'POST', body: { name: f.name.value, part_category: f.cat.value || null, price_rwf: Number(f.price.value), duration_minutes: f.mins.value ? Number(f.mins.value) : null } });
        showTab('services');
      } catch (err) { setStatus(status, err.message, 'error'); }
    } },
      h('h2', { text: 'Add a service' }),
      h('div', { class: 'row stack-sm' }, field('Which part does it fit?', f.cat, 'Linking a part shows this price when a customer books that part.'), field('Service name', f.name)),
      h('div', { class: 'row stack-sm' }, field('Labour price in RWF', f.price), field('Time it takes (minutes)', f.mins)),
      h('button', { class: 'btn btn-primary', type: 'submit', text: 'Add service' }), status);

    const row = (s) => {
      const price = h('input', { type: 'number', inputMode: 'numeric', min: 1, value: s.price_rwf, 'aria-label': `Price of ${s.name}` });
      const mins = h('input', { type: 'number', inputMode: 'numeric', min: 5, value: s.duration_minutes || '', 'aria-label': `Minutes for ${s.name}` });
      const msg = h('span', { class: 'small', role: 'status' });
      return { ...s, _price: price, _mins: mins, _msg: msg };
    };
    const rows = services.map(row);
    return h('div', {},
      h('p', { class: 'muted', text: 'Your labour prices, without the part. Customers see them before they book you, like a menu.' }),
      table([
        { label: 'Service', render: (s) => h('div', { class: 'part-cell' }, h('strong', { text: s.name }), h('span', { class: 'small muted', text: s.part_category ? `Shown when booking ${s.part_category}` : 'General work' })) },
        { label: 'Price (RWF)', render: (s) => s._price },
        { label: 'Minutes', render: (s) => s._mins },
        { label: '', render: (s) => h('div', { class: 'btn-row' },
          h('button', { class: 'btn btn-secondary btn-small', type: 'button', text: 'Save', onclick: async () => {
            s._msg.textContent = 'Saving…';
            try { await api(`/api/garage/services/${s.id}`, { method: 'PUT', body: { price_rwf: Number(s._price.value), duration_minutes: s._mins.value ? Number(s._mins.value) : null } }); s._msg.textContent = 'Saved'; }
            catch (err) { s._msg.textContent = err.message; }
          } }),
          h('button', { class: 'btn btn-quiet btn-small', type: 'button', text: 'Remove', onclick: async () => {
            if (!confirm(`Remove "${s.name}"?`)) return;
            try { await api(`/api/garage/services/${s.id}`, { method: 'DELETE' }); showTab('services'); } catch (err) { alert(err.message); }
          } }), s._msg) },
      ], rows, 'No services yet. Add your first one below.'),
      form);
  }
})();
