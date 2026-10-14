/* Admin console. Approve shops and garages that apply, post parts (only admins can, so nobody
   can sell a fake part), manage the fitment reference (the core data asset), and see what
   customers searched for that we could not answer. Signs in with an admin account. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let meta = null;
  let categories = [];
  let prefill = null;      // set when jumping from the "missing parts" report to the add form
  let editing = null;      // fitment row being edited

  // The session cookie of the signed-in admin account authorises every call.
  const call = (path, opts = {}) => api(path, opts);

  const TABS = [
    ['overview', 'Overview', renderOverview],
    ['applications', 'Applications', renderApplications],
    ['parts', 'Parts', renderParts],
    ['reviews', 'Reviews', renderReviews],
    ['fitment', 'Part numbers', renderFitment],
    ['gaps', 'Missing parts', renderGaps],
    ['shops', 'Shops', renderShops],
    ['garages', 'Garages', renderGarages],
    ['cars', 'Cars', renderCars],
    ['bookings', 'Bookings', renderBookings],
  ];

  init();

  async function init() {
    $('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const status = $('login-status');
      setStatus(status, 'Signing in…');
      try {
        const { user } = await api('/api/auth/login', { method: 'POST', body: { email: $('ad-email').value, password: $('ad-password').value } });
        if (user.role !== 'admin') {
          await api('/api/auth/logout', { method: 'POST' });
          return setStatus(status, 'This account is not an admin account. Shops and garages sign in on Vinzuu Sellers & Garages.', 'error');
        }
        await openConsole(user);
      } catch (err) { setStatus(status, err.message, 'error'); }
    });
    $('sign-out').addEventListener('click', async () => {
      try { await api('/api/auth/logout', { method: 'POST' }); } finally { location.reload(); }
    });
    try { meta = await api('/api/meta'); $('demo-banner').hidden = !meta.demo; } catch (err) { /* optional */ }
    const { user } = await api('/api/auth/me').catch(() => ({ user: null }));
    if (user && user.role === 'admin') await openConsole(user);
    else if (user && user.role === 'business') location.href = '/business.html';
  }

  async function openConsole(user) {
    categories = (await api('/api/catalog')).categories;
    $('admin-who').textContent = user.email;
    $('login').hidden = true;
    $('console').hidden = false;
    $('tabs').replaceChildren(...TABS.map(([key, label]) => h('button', {
      type: 'button', role: 'tab', id: `tab-${key}`, text: label, onclick: () => showTab(key),
    })));
    const wanted = location.hash.slice(1);
    showTab(TABS.some(([k]) => k === wanted) ? wanted : 'overview');
  }

  async function showTab(key) {
    for (const [k] of TABS) $(`tab-${k}`).setAttribute('aria-selected', String(k === key));
    history.replaceState(null, '', `#${key}`);
    const panel = $('panel');
    panel.replaceChildren(h('p', { class: 'muted', text: 'Loading…' }));
    const render = TABS.find(([k]) => k === key)[2];
    try { panel.replaceChildren(await render()); } catch (err) { panel.replaceChildren(h('p', { class: 'status error', text: err.message })); }
  }

  // ---------------------------------------------------------------- helpers

  function dataTable(columns, rows) {
    if (!rows.length) return h('p', { class: 'empty muted', text: 'Nothing here yet.' });
    return h('div', { class: 'table-scroll' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ...columns.map((c) => h('th', { text: c.label })))),
      h('tbody', {}, ...rows.map((r) => h('tr', {}, ...columns.map((c) => {
        const v = c.render ? c.render(r) : r[c.key];
        return h('td', { class: c.num ? 'num' : '' }, v == null ? '' : v);
      }))))));
  }

  const tag = (level) => h('span', { class: `tag tag-${level}`, text: level });

  function fieldEl(label, control, hint) {
    return h('div', { class: 'field' }, h('label', { for: control.id, text: label }), control, hint ? h('p', { class: 'hint', text: hint }) : null);
  }
  const input = (id, attrs = {}) => h('input', { id, type: 'text', ...attrs });
  const select = (id, options, attrs = {}) => h('select', { id, ...attrs },
    ...options.map(([value, text]) => h('option', { value, text })));

  // ---------------------------------------------------------------- overview

  async function renderOverview() {
    const s = await call('/api/admin/stats');
    // label is [singular, plural], so "1 booking request" and "2 booking requests" both read right.
    const stat = (n, [one, many]) => h('div', { class: 'stat' }, h('b', { text: String(n) }), h('span', { text: n === 1 ? one : many }));
    const tally = (title, rows) => h('div', {},
      h('h3', { text: title }),
      dataTable([{ label: 'Value', key: 'label' }, { label: 'Cars', key: 'n', num: true }], rows));
    return h('div', {},
      (s.pending_applications || s.pending_part_requests) ? h('div', { class: 'note-box todo-box' },
        s.pending_applications ? h('p', {}, `${s.pending_applications} ${s.pending_applications === 1 ? 'business is' : 'businesses are'} waiting for approval. `,
          h('button', { class: 'link-btn', type: 'button', text: 'Check applications', onclick: () => showTab('applications') })) : null,
        s.pending_part_requests ? h('p', {}, `${s.pending_part_requests} part ${s.pending_part_requests === 1 ? 'request is' : 'requests are'} waiting. `,
          h('button', { class: 'link-btn', type: 'button', text: 'Check part requests', onclick: () => showTab('parts') })) : null) : null,
      h('div', { class: 'stat-grid' },
        stat(s.pending_applications, ['application waiting', 'applications waiting']),
        stat(s.pending_part_requests, ['part request waiting', 'part requests waiting']),
        stat(s.reviews, ['review', 'reviews']),
        stat(s.vehicles, ['registered car', 'registered cars']), stat(s.fitment_rows, ['part number row', 'part number rows']),
        stat(s.live_listings, ['part in stock', 'parts in stock']), stat(s.shops, ['shop', 'shops']), stat(s.garages, ['garage', 'garages']),
        stat(s.bookings, ['booking request', 'booking requests']), stat(s.open_gaps, ['missing-part search', 'missing-part searches'])),
      meta && meta.demo ? h('p', { class: 'note-box', text: 'These numbers include demo cars and shops. Do not quote them in your thesis until you have cleared the demo data.' }) : null,
      h('p', { class: 'muted', text: 'The tables below are real data about the cars your users register. When you have enough real registrations, they can support your thesis (always state how many cars they are based on).' }),
      h('div', { class: 'row' }, tally('Cars by make', s.vehicles_by_make), tally('Cars by where they were built', s.vehicles_by_origin_market)),
      tally('Cars by where they were imported from (as the owner told us)', s.vehicles_by_import_source));
  }

  // ---------------------------------------------------------------- dialogs

  function dialog(title, build) {
    let dlg = $('admin-dialog');
    if (!dlg) { dlg = h('dialog', { id: 'admin-dialog', 'aria-labelledby': 'admin-dialog-title' }); document.body.append(dlg); }
    const close = () => { if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open'); };
    dlg.replaceChildren(h('div', { class: 'dialog-body' }, h('h2', { id: 'admin-dialog-title', text: title }), ...build(close)));
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
  }
  const showPhoto = (src, title) => dialog(title, (close) => [
    h('img', { class: 'detail-photo detail-photo-lg', src, alt: title }),
    h('div', { class: 'dialog-actions' }, h('button', { class: 'btn btn-quiet', type: 'button', text: 'Close', onclick: close }))]);

  /** Ask for a reason, then run fn(reason). Used for every "reject". */
  function askReason(title, hint, fn) {
    const box = h('textarea', { id: 'reason-box', rows: 3, maxLength: 300 });
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    dialog(title, (close) => [
      fieldEl('Reason (they will see it)', box, hint),
      status,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn btn-danger', type: 'button', text: 'Reject', onclick: async () => {
          if (!box.value.trim()) return setStatus(status, 'Write the reason.', 'error');
          try { await fn(box.value.trim()); close(); } catch (err) { setStatus(status, err.message, 'error'); }
        } }),
        h('button', { class: 'btn btn-quiet', type: 'button', text: 'Cancel', onclick: close }))]);
    box.focus();
  }

  const pill = (text, cls) => h('span', { class: `pill ${cls}`, text });
  const STATUS_PILL = { pending: ['Waiting', 'pill-new'], approved: ['Approved', 'pill-ok'], rejected: ['Rejected', 'pill-off'] };
  const KIND_TEXT = { shop: 'Parts shop', garage: 'Garage', both: 'Shop and garage' };
  const when = (ts) => {
    const d = new Date(String(ts || '').replace(' ', 'T') + 'Z');
    return Number.isNaN(d.getTime()) ? (ts || '') : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  function segFilter(options, current, onChange) {
    const seg = h('div', { class: 'seg seg-wrap', role: 'group', 'aria-label': 'Show' }, ...options.map(([k, label]) => h('button', {
      type: 'button', 'aria-pressed': String(k === current), text: label,
      onclick: (e) => { seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.target))); onChange(k); },
    })));
    return seg;
  }

  // ---------------------------------------------------------------- applications

  async function renderApplications() {
    const { applications } = await call('/api/admin/applications');
    let filter = 'pending';
    const mount = h('div', { class: 'app-list' });
    const draw = () => {
      const rows = applications.filter((a) => filter === 'all' || a.status === filter);
      mount.replaceChildren(...(rows.length ? rows.map(applicationCard) : [h('p', { class: 'empty muted', text: filter === 'pending' ? 'No applications waiting.' : 'Nothing here.' })]));
    };
    draw();
    const count = (st) => applications.filter((a) => a.status === st).length;
    return h('div', {},
      h('h2', { text: 'Shops and garages that want to join' }),
      h('p', { class: 'muted', text: 'Check the RDB certificate (the name and TIN must match the form) and the front photo. Call the owner or visit if anything looks wrong. Approving creates their shop and/or garage and lets the owner sign in.' }),
      segFilter([['pending', `Waiting (${count('pending')})`], ['approved', `Approved (${count('approved')})`], ['rejected', `Rejected (${count('rejected')})`], ['all', 'All']], filter, (k) => { filter = k; draw(); }),
      mount);
  }

  function applicationCard(a) {
    const kind = select(`ap-kind-${a.id}`, Object.entries(KIND_TEXT));
    kind.value = a.kind;
    const vetted = h('input', { type: 'checkbox', checked: true, id: `ap-vet-${a.id}` });
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const mapHref = `https://www.google.com/maps/search/?api=1&query=${a.latitude},${a.longitude}`;
    const [label, cls] = STATUS_PILL[a.status];
    return h('article', { class: 'app-card' },
      h('div', { class: 'app-photos' },
        h('button', { class: 'thumb-btn', type: 'button', onclick: () => showPhoto(a.certificate_photo, `RDB certificate of ${a.business_name}`) },
          h('img', { src: a.certificate_photo, alt: 'RDB certificate' }), h('span', { text: 'RDB certificate' })),
        h('button', { class: 'thumb-btn', type: 'button', onclick: () => showPhoto(a.front_photo, `Front of ${a.business_name}`) },
          h('img', { src: a.front_photo, alt: 'Business front' }), h('span', { text: 'Front photo' }))),
      h('div', { class: 'app-body' },
        h('div', { class: 'app-top' }, pill(label, cls), h('span', { class: 'small muted', text: `Applied ${when(a.created_at)}` })),
        h('h3', { text: a.business_name }),
        h('dl', { class: 'detail-list' },
          h('dt', { text: 'Wants to be' }), h('dd', { text: KIND_TEXT[a.kind] }),
          h('dt', { text: 'TIN' }), h('dd', { text: a.tin }),
          h('dt', { text: 'Owner' }), h('dd', { text: a.owner_name }),
          h('dt', { text: 'Email' }), h('dd', { text: a.email }),
          h('dt', { text: 'Phone' }), h('dd', {}, h('a', { href: `tel:${a.phone}`, text: a.phone }),
            a.whatsapp_number ? ' · WhatsApp ' : '', a.whatsapp_number ? h('a', { href: whatsappLink(a.whatsapp_number, `Hello ${a.owner_name}, this is the Vinzuu team about your application for ${a.business_name}.`), target: '_blank', rel: 'noopener', text: a.whatsapp_number }) : null),
          h('dt', { text: 'Address' }), h('dd', {}, `${a.address_text} · `, h('a', { href: mapHref, target: '_blank', rel: 'noopener', text: 'Open on the map' })),
          a.specialties ? h('dt', { text: 'Good at' }) : null, a.specialties ? h('dd', { text: a.specialties }) : null,
          a.note ? h('dt', { text: 'Their note' }) : null, a.note ? h('dd', { text: a.note }) : null,
          a.admin_note ? h('dt', { text: a.status === 'rejected' ? 'Why rejected' : 'Your note' }) : null, a.admin_note ? h('dd', { text: a.admin_note }) : null),
        a.status === 'pending' ? h('div', { class: 'app-actions' },
          h('div', { class: 'row stack-sm' }, fieldEl('Approve as', kind),
            h('div', { class: 'field' }, h('label', {}, vetted, ' Vetted: we checked they sell genuine parts'))),
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn btn-primary btn-small', type: 'button', text: 'Approve', onclick: async () => {
              setStatus(status, 'Approving…');
              try {
                const res = await call(`/api/admin/applications/${a.id}/approve`, { method: 'POST', body: { kind: kind.value, vetted: vetted.checked } });
                setStatus(status, `Approved. ${a.owner_name} can now sign in with ${a.email}${res.existing_account ? ' (their existing account and password)' : ''}.`, 'ok');
                setTimeout(() => showTab('applications'), 2500);
              } catch (err) { setStatus(status, err.message, 'error'); }
            } }),
            h('button', { class: 'btn btn-quiet btn-small', type: 'button', text: 'Reject', onclick: () => askReason(`Reject ${a.business_name}`,
              'For example: the TIN does not match the certificate. They can apply again.',
              async (reason) => { await call(`/api/admin/applications/${a.id}/reject`, { method: 'POST', body: { admin_note: reason } }); showTab('applications'); }) })),
          status) : null));
  }

  // ---------------------------------------------------------------- parts (only admins post them)

  async function renderParts() {
    const [{ requests }, { listings }, { shops }] = await Promise.all([
      call('/api/admin/listing-requests'), call('/api/admin/listings'), call('/api/admin/shops')]);
    const pending = requests.filter((r) => r.status === 'pending');
    const decided = requests.filter((r) => r.status !== 'pending').slice(0, 20);
    return h('div', {},
      h('h2', { text: `Requests from shops (${pending.length} waiting)` }),
      h('p', { class: 'muted', text: 'Check the photo matches the part and the part number, and that the price is sensible. You can correct the price, stock or description before approving.' }),
      pending.length ? h('div', { class: 'app-list' }, ...pending.map(requestCard)) : h('p', { class: 'empty muted', text: 'No part requests waiting.' }),
      decided.length ? h('details', { class: 'decided' }, h('summary', { text: 'Recently decided' }), dataTable([
        { label: 'When', render: (r) => when(r.decided_at) }, { label: 'Shop', key: 'shop_name' },
        { label: 'Part', render: (r) => `${r.part_category} ${r.oe_number || r.universal_spec || ''}` },
        { label: 'Status', render: (r) => pill(...STATUS_PILL[r.status]) }, { label: 'Note', key: 'admin_note' },
      ], decided)) : null,
      postPartForm(shops),
      allPartsList(listings, shops));
  }

  function requestCard(r) {
    const price = input(`rq-price-${r.id}`, { type: 'number', min: 1, value: r.price_rwf });
    const stock = input(`rq-stock-${r.id}`, { type: 'number', min: 0, value: r.stock_quantity });
    const desc = h('textarea', { id: `rq-desc-${r.id}`, rows: 3, maxLength: 600, value: r.description || '' });
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    return h('article', { class: 'app-card' },
      h('div', { class: 'app-photos' }, h('button', { class: 'thumb-btn', type: 'button', onclick: () => showPhoto(r.photo_url, r.part_category) },
        h('img', { src: r.photo_url, alt: `Photo of ${r.part_category}` }), h('span', { text: 'Part photo' }))),
      h('div', { class: 'app-body' },
        h('div', { class: 'app-top' }, pill('Waiting', 'pill-new'), h('span', { class: 'small muted', text: `Sent ${when(r.created_at)} by ${r.shop_name}${r.shop_vetted ? ' (vetted)' : ' (not vetted)'}` })),
        h('h3', { text: `${r.part_category}${r.oe_number ? `: ${r.oe_number}` : r.universal_spec ? `: ${r.universal_spec}` : ''}` }),
        h('dl', { class: 'detail-list' },
          h('dt', { text: 'Brand' }), h('dd', { text: r.brand || 'Not given' }),
          h('dt', { text: 'Type' }), h('dd', { text: r.condition === 'genuine' ? 'Genuine' : 'Aftermarket' }),
          h('dt', { text: 'Warranty' }), h('dd', { text: r.warranty_months ? `${r.warranty_months} months` : 'None' }),
          r.note ? h('dt', { text: 'Shop note' }) : null, r.note ? h('dd', { text: r.note }) : null),
        h('div', { class: 'row stack-sm' }, fieldEl('Price (RWF)', price), fieldEl('Stock', stock)),
        fieldEl('Description customers will read', desc),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn btn-primary btn-small', type: 'button', text: 'Approve and post', onclick: async () => {
            setStatus(status, 'Posting…');
            try {
              await call(`/api/admin/listing-requests/${r.id}/approve`, { method: 'POST', body: { price_rwf: Number(price.value), stock_quantity: Number(stock.value), description: desc.value } });
              setStatus(status, 'Posted. Customers can see it now.', 'ok');
              setTimeout(() => showTab('parts'), 1500);
            } catch (err) { setStatus(status, err.message, 'error'); }
          } }),
          h('button', { class: 'btn btn-quiet btn-small', type: 'button', text: 'Reject', onclick: () => askReason('Reject this part',
            'For example: the photo does not show the part number. Send a clearer photo.',
            async (reason) => { await call(`/api/admin/listing-requests/${r.id}/reject`, { method: 'POST', body: { admin_note: reason } }); showTab('parts'); }) })),
        status));
  }

  function postPartForm(shops) {
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    let photo = null;
    const f = {
      shop: select('pp-shop', [['', 'Choose the shop'], ...shops.map((s) => [String(s.id), `${s.name}${s.vetted ? '' : ' (not vetted)'}`])]),
      cat: select('pp-cat', [['', 'Choose a part'], ...categories.map((c) => [c.name, c.name])]),
      oe: h('select', { id: 'pp-oe' }), spec: input('pp-spec', { placeholder: 'For example 12V 60Ah' }),
      brand: input('pp-brand', { placeholder: 'For example Bosch' }),
      cond: select('pp-cond', [['genuine', 'Genuine part'], ['aftermarket', 'Aftermarket part']]),
      war: input('pp-war', { type: 'number', min: 0, placeholder: 'No warranty' }),
      price: input('pp-price', { type: 'number', min: 1 }), stock: input('pp-stock', { type: 'number', min: 0, value: 1 }),
      desc: h('textarea', { id: 'pp-desc', rows: 3, maxLength: 600 }),
      photo: h('input', { id: 'pp-photo', type: 'file', accept: 'image/*' }),
      preview: h('img', { class: 'photo-preview', alt: 'Photo preview', hidden: true }),
    };
    const oeWrap = fieldEl('Part number and the cars it fits', f.oe);
    const specWrap = fieldEl('Size or specification', f.spec);
    oeWrap.hidden = true; specWrap.hidden = true;
    f.cat.addEventListener('change', async () => {
      const cat = categories.find((c) => c.name === f.cat.value);
      oeWrap.hidden = !cat || cat.type !== 'model_specific';
      specWrap.hidden = !cat || cat.type !== 'universal';
      if (!cat || cat.type !== 'model_specific') return;
      const { rows } = await call(`/api/admin/oe-numbers?part_category=${enc(cat.name)}`);
      f.oe.replaceChildren(h('option', { value: '', text: rows.length ? 'Choose the part number' : 'No part numbers yet: add one under Part numbers' }),
        ...rows.map((r) => h('option', { value: r.oe_number, text: `${r.oe_number}: ${r.make} ${r.model}${r.generation ? ` ${r.generation}` : ''}, ${r.year_start} to ${r.year_end}${r.engine ? `, ${r.engine}` : ''}` })));
    });
    f.photo.addEventListener('change', async (e) => {
      photo = null; f.preview.hidden = true;
      if (!e.target.files[0]) return;
      try { photo = await resizeImage(e.target.files[0]); f.preview.src = photo; f.preview.hidden = false; } catch (err) { setStatus(status, err.message, 'error'); }
    });
    return h('form', { class: 'panel', novalidate: true, onsubmit: async (event) => {
      event.preventDefault();
      const cat = categories.find((c) => c.name === f.cat.value);
      if (!f.shop.value) return setStatus(status, 'Choose the shop.', 'error');
      if (!cat) return setStatus(status, 'Choose the part.', 'error');
      if (!photo) return setStatus(status, 'Add a photo of the part.', 'error');
      setStatus(status, 'Posting…');
      try {
        await call('/api/admin/listings', { method: 'POST', body: {
          shop_id: Number(f.shop.value), part_category: cat.name,
          oe_number: cat.type === 'model_specific' ? f.oe.value : null, universal_spec: cat.type === 'universal' ? f.spec.value : null,
          brand: f.brand.value || null, condition: f.cond.value, warranty_months: f.war.value === '' ? null : Number(f.war.value),
          price_rwf: Number(f.price.value), stock_quantity: Number(f.stock.value || 0), description: f.desc.value || null, photo_url: photo,
        } });
        setStatus(status, 'Posted. Customers can see it now.', 'ok');
        setTimeout(() => showTab('parts'), 1500);
      } catch (err) { setStatus(status, err.message, 'error'); }
    } },
      h('h2', { text: 'Post a part' }),
      h('p', { class: 'muted', text: 'For a part you checked yourself, for example at the shop.' }),
      h('div', { class: 'row stack-sm' }, fieldEl('Shop', f.shop), fieldEl('Part', f.cat)),
      oeWrap, specWrap,
      h('div', { class: 'row stack-sm' }, fieldEl('Brand', f.brand), fieldEl('Type', f.cond)),
      h('div', { class: 'row stack-sm' }, fieldEl('Price (RWF)', f.price), fieldEl('Stock', f.stock)),
      fieldEl('Warranty in months (optional)', f.war),
      fieldEl('Description', f.desc, 'What customers read about the part.'),
      h('div', { class: 'field' }, h('label', { for: 'pp-photo', text: 'Photo' }), f.photo, f.preview),
      h('button', { class: 'btn btn-primary', type: 'submit', text: 'Post part' }), status);
  }

  function allPartsList(listings, shops) {
    const mount = h('div', {});
    const shopFilter = select('pl-shop', [['', 'All shops'], ...shops.map((s) => [String(s.id), s.name])], { 'aria-label': 'Shop' });
    const draw = () => mount.replaceChildren(dataTable([
      { label: 'Photo', render: (l) => h('button', { class: 'thumb-btn', type: 'button', onclick: () => showPhoto(l.photo_url, l.part_category) }, h('img', { class: 'thumb', src: l.photo_url, alt: '' })) },
      { label: 'Shop', key: 'shop_name' },
      { label: 'Part', render: (l) => h('div', { class: 'part-cell' }, h('strong', { text: l.part_category }),
        h('span', { class: 'small muted', text: [l.oe_number || l.universal_spec, l.brand, l.condition].filter(Boolean).join(' · ') })) },
      { label: 'Price', render: (l) => fmtRwf(l.price_rwf) }, { label: 'Stock', key: 'stock_quantity', num: true },
      { label: 'Status', render: (l) => (l.hidden ? pill('Hidden', 'pill-off') : l.stock_quantity ? pill('On sale', 'pill-ok') : pill('Out of stock', 'pill-warn')) },
      { label: '', render: (l) => h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-secondary btn-small', type: 'button', text: 'Edit', onclick: () => editListing(l) }),
        h('button', { class: 'btn btn-secondary btn-small', type: 'button', text: l.hidden ? 'Show' : 'Hide', onclick: async () => {
          try { await call(`/api/admin/listings/${l.id}`, { method: 'PUT', body: { hidden: !l.hidden } }); l.hidden = !l.hidden; draw(); } catch (err) { alert(err.message); }
        } }),
        h('button', { class: 'btn btn-danger btn-small', type: 'button', text: 'Delete', onclick: async () => {
          if (!confirm(`Delete ${l.part_category} at ${l.shop_name}? Hide it instead if it may come back.`)) return;
          try { await call(`/api/admin/listings/${l.id}`, { method: 'DELETE' }); showTab('parts'); } catch (err) { alert(err.message); }
        } })) },
    ], listings.filter((l) => !shopFilter.value || String(l.shop_id) === shopFilter.value)));
    shopFilter.addEventListener('change', draw);
    draw();
    return h('div', {}, h('h2', { text: `All parts on Vinzuu (${listings.length})` }), h('div', { class: 'field filter-field' }, shopFilter), mount);
  }

  function editListing(l) {
    const f = {
      price: input('el-price', { type: 'number', min: 1, value: l.price_rwf }), stock: input('el-stock', { type: 'number', min: 0, value: l.stock_quantity }),
      brand: input('el-brand', { value: l.brand || '' }), war: input('el-war', { type: 'number', min: 0, value: l.warranty_months ?? '' }),
      cond: select('el-cond', [['genuine', 'Genuine part'], ['aftermarket', 'Aftermarket part']]),
      desc: h('textarea', { id: 'el-desc', rows: 4, maxLength: 600, value: l.description || '' }),
    };
    f.cond.value = l.condition;
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    dialog(`Edit ${l.part_category} at ${l.shop_name}`, (close) => [
      h('div', { class: 'row stack-sm' }, fieldEl('Price (RWF)', f.price), fieldEl('Stock', f.stock)),
      h('div', { class: 'row stack-sm' }, fieldEl('Brand', f.brand), fieldEl('Type', f.cond)),
      fieldEl('Warranty in months', f.war), fieldEl('Description', f.desc), status,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn btn-primary', type: 'button', text: 'Save', onclick: async () => {
          try {
            await call(`/api/admin/listings/${l.id}`, { method: 'PUT', body: {
              price_rwf: Number(f.price.value), stock_quantity: Number(f.stock.value), brand: f.brand.value || null, condition: f.cond.value,
              warranty_months: f.war.value === '' ? null : Number(f.war.value), description: f.desc.value || null,
            } });
            close(); showTab('parts');
          } catch (err) { setStatus(status, err.message, 'error'); }
        } }),
        h('button', { class: 'btn btn-quiet', type: 'button', text: 'Cancel', onclick: close }))]);
  }

  // ---------------------------------------------------------------- reviews

  async function renderReviews() {
    const { reviews } = await call('/api/admin/reviews');
    return h('div', {},
      h('h2', { text: 'Reviews of shops and garages' }),
      h('p', { class: 'muted', text: 'Only customers whose booking was finished can review. Remove a review only if it is abusive or not about the business; a bad but honest review stays.' }),
      dataTable([
        { label: 'When', render: (r) => when(r.created_at) },
        { label: 'For', render: (r) => (r.target === 'shop' ? `Shop: ${r.shop_name}` : `Garage: ${r.garage_name}`) },
        { label: 'Stars', render: (r) => starsEl(r.rating) },
        { label: 'By', key: 'author_name' }, { label: 'Comment', key: 'comment' }, { label: 'Reply', key: 'reply' },
        { label: '', render: (r) => h('button', { class: 'btn btn-danger btn-small', type: 'button', text: 'Remove', onclick: async () => {
          if (!confirm(`Remove this review by ${r.author_name}?`)) return;
          try { await call(`/api/admin/reviews/${r.id}`, { method: 'DELETE' }); showTab('reviews'); } catch (err) { alert(err.message); }
        } }) },
      ], reviews));
  }

  // ---------------------------------------------------------------- part numbers (fitment reference)

  async function renderFitment() {
    const wrap = h('div', {});
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const listMount = h('div', {});
    const search = input('f-search', { type: 'search', placeholder: 'Search part number, make, model or part', 'aria-label': 'Search' });

    const modelSpecific = categories.filter((c) => c.type === 'model_specific');
    const f = {
      category: select('f-cat', modelSpecific.map((c) => [c.name, c.name])),
      oe: input('f-oe'), make: input('f-make'), model: input('f-model'), generation: input('f-gen'),
      yearStart: input('f-ys', { type: 'number', min: 1980 }), yearEnd: input('f-ye', { type: 'number', min: 1980 }),
      engine: input('f-eng'),
      origin: select('f-origin', [['', 'Any (this part fits every origin)'], ...meta.origins.map((o) => [o, `${o}-built only`])]),
      confidence: select('f-conf', [['LOW', 'LOW: one unconfirmed source'], ['MEDIUM', 'MEDIUM: confirmed by more than one shop'], ['HIGH', 'HIGH: official catalogue or physical check']]),
      source: input('f-src'), verifiedBy: input('f-ver'),
    };

    function load(row) {
      f.category.value = row.part_category || modelSpecific[0].name;
      f.oe.value = row.oe_number || ''; f.make.value = row.make || ''; f.model.value = row.model || '';
      f.generation.value = row.generation || ''; f.yearStart.value = row.year_start || ''; f.yearEnd.value = row.year_end || '';
      f.engine.value = row.engine || ''; f.origin.value = row.origin_market || '';
      f.confidence.value = row.confidence_level || 'LOW'; f.source.value = row.source || ''; f.verifiedBy.value = row.verified_by || '';
    }
    editing = null;
    load(prefill || {});
    prefill = null;

    const formTitle = h('h2', { text: 'Add a part number' });
    const form = h('form', { class: 'panel', novalidate: true, onsubmit: async (event) => {
      event.preventDefault();
      const body = {
        part_category: f.category.value, oe_number: f.oe.value, make: f.make.value, model: f.model.value,
        generation: f.generation.value, year_start: f.yearStart.value, year_end: f.yearEnd.value, engine: f.engine.value,
        origin_market: f.origin.value, confidence_level: f.confidence.value, source: f.source.value, verified_by: f.verifiedBy.value,
      };
      setStatus(status, 'Saving…');
      try {
        if (editing) await call(`/api/admin/fitment-reference/${editing}`, { method: 'PUT', body });
        else await call('/api/admin/fitment-reference', { method: 'POST', body });
        setStatus(status, editing ? 'Updated.' : 'Added.', 'ok');
        editing = null; formTitle.textContent = 'Add a part number';
        await reloadList();
      } catch (err) { setStatus(status, err.message, 'error'); }
    } },
      formTitle,
      h('div', { class: 'row stack-sm' }, fieldEl('Part', f.category), fieldEl('Part number (OE number)', f.oe)),
      h('div', { class: 'row stack-sm' }, fieldEl('Make', f.make), fieldEl('Model', f.model)),
      h('div', { class: 'row stack-sm' }, fieldEl('Generation (optional)', f.generation, 'Leave blank if it fits every generation in the years given.'), fieldEl('Engine (optional)', f.engine, 'Leave blank if it fits every engine.')),
      h('div', { class: 'row stack-sm' }, fieldEl('Year from', f.yearStart), fieldEl('Year to', f.yearEnd)),
      fieldEl('Built in', f.origin, 'Choose a country only if the part differs by where the car was built.'),
      fieldEl('How sure are we?', f.confidence),
      h('div', { class: 'row stack-sm' }, fieldEl('Source', f.source, 'For example: Hyundai MOBIS catalogue, or checked against the old part.'), fieldEl('Verified by', f.verifiedBy, 'Required for HIGH. Who checked it?')),
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn btn-primary', type: 'submit', text: 'Save part number' }),
        h('button', { class: 'btn btn-quiet', type: 'button', text: 'Clear form', onclick: () => { editing = null; formTitle.textContent = 'Add a part number'; load({}); } })),
      status);

    async function reloadList() {
      const { rows } = await call(`/api/admin/fitment-reference?q=${enc(search.value)}`);
      listMount.replaceChildren(dataTable([
        { label: 'Part number', key: 'oe_number' }, { label: 'Part', key: 'part_category' },
        { label: 'Car', render: (r) => `${r.make} ${r.model}${r.generation ? ` ${r.generation}` : ''}` },
        { label: 'Years', render: (r) => `${r.year_start} to ${r.year_end}` },
        { label: 'Engine', render: (r) => r.engine || 'any' }, { label: 'Built in', render: (r) => r.origin_market || 'any' },
        { label: 'Confidence', render: (r) => tag(r.confidence_level) },
        { label: 'Source', key: 'source' }, { label: 'Verified by', render: (r) => r.verified_by || '' },
        { label: '', render: (r) => h('span', {},
          h('button', { class: 'btn btn-secondary btn-small', type: 'button', text: 'Edit', onclick: () => {
            editing = r.id; formTitle.textContent = `Edit part number #${r.id}`; load(r); form.scrollIntoView({ block: 'start' });
          } }), ' ',
          h('button', { class: 'btn btn-danger btn-small', type: 'button', text: 'Delete', onclick: async () => {
            if (!confirm(`Delete ${r.oe_number} for ${r.make} ${r.model}? Shop listings using it will stop matching.`)) return;
            await call(`/api/admin/fitment-reference/${r.id}`, { method: 'DELETE' });
            reloadList();
          } })) },
      ], rows));
    }
    search.addEventListener('input', () => reloadList());
    await reloadList();
    wrap.append(form, h('h2', { text: 'All part numbers' }), h('div', { class: 'field' }, search), listMount);
    return wrap;
  }

  // ---------------------------------------------------------------- missing parts

  async function renderGaps() {
    const { gaps } = await call('/api/admin/fitment-reference/gaps');
    return h('div', {},
      h('h2', { text: 'What customers searched for that we could not answer' }),
      h('p', { class: 'muted', text: 'Most-searched first. Research the top rows, then press "Add part number" to fill them in. This list tells you where your data effort pays off.' }),
      dataTable([
        { label: 'Searches', key: 'times_searched', num: true },
        { label: 'Car', render: (g) => `${g.year} ${g.make} ${g.model}` },
        { label: 'Engine', render: (g) => g.engine || 'not given' }, { label: 'Built in', render: (g) => g.origin_market || 'not given' },
        { label: 'Part', key: 'part_category' }, { label: 'Last searched', key: 'last_seen' },
        { label: '', render: (g) => h('button', { class: 'btn btn-secondary btn-small', type: 'button', text: 'Add part number', onclick: () => {
          prefill = { part_category: g.part_category, make: g.make, model: g.model, year_start: g.year, year_end: g.year, engine: g.engine, origin_market: g.origin_market };
          showTab('fitment');
        } }) },
      ], gaps));
  }

  // ---------------------------------------------------------------- shops

  async function renderShops() {
    const { shops } = await call('/api/admin/shops');
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const f = {
      name: input('s-name'), phone: input('s-phone', { type: 'tel', placeholder: '+250 788 123 456' }),
      whatsapp: input('s-wa', { type: 'tel', placeholder: 'Same as phone if blank' }),
      lat: input('s-lat', { placeholder: '-1.9441' }), lon: input('s-lon', { placeholder: '30.0619' }),
      address: input('s-addr'), onboarded: input('s-by'),
      vetted: h('input', { id: 's-vetted', type: 'checkbox' }),
    };
    const form = h('form', { class: 'panel', novalidate: true, onsubmit: async (event) => {
      event.preventDefault();
      setStatus(status, 'Saving…');
      try {
        const { shop } = await call('/api/admin/shops', { method: 'POST', body: {
          name: f.name.value, phone: f.phone.value, whatsapp_number: f.whatsapp.value || null,
          latitude: f.lat.value, longitude: f.lon.value, address_text: f.address.value,
          vetted: f.vetted.checked, onboarded_by: f.onboarded.value,
        } });
        setStatus(status, `${shop.name} added. To give it a sign-in, ask the owner to apply on the Sell on vinzuu page.`, 'ok');
        showTabKeepStatus();
      } catch (err) { setStatus(status, err.message, 'error'); }
    } },
      h('h2', { text: 'Add a shop' }),
      h('div', { class: 'row stack-sm' }, fieldEl('Shop name', f.name), fieldEl('Phone', f.phone)),
      h('div', { class: 'row stack-sm' }, fieldEl('WhatsApp (optional)', f.whatsapp), fieldEl('Area or address', f.address)),
      h('div', { class: 'row stack-sm' }, fieldEl('Latitude', f.lat, 'On Google Maps, press and hold the shop, then copy the two numbers.'), fieldEl('Longitude', f.lon)),
      fieldEl('Onboarded by', f.onboarded, 'Which of your team visited this shop?'),
      h('div', { class: 'field' }, h('label', {}, f.vetted, ' Vetted: we visited and checked they sell genuine parts'),
        h('p', { class: 'hint', text: 'Only vetted shops can earn the Verified Genuine label.' })),
      h('button', { class: 'btn btn-primary', type: 'submit', text: 'Add shop' }), status);

    function showTabKeepStatus() { setTimeout(() => showTab('shops'), 4000); }

    return h('div', {}, form, h('h2', { text: 'All shops' }), dataTable([
      { label: 'Shop', key: 'name' }, { label: 'Phone', key: 'phone' }, { label: 'Area', key: 'address_text' },
      { label: 'Signs in as', render: (s) => s.login_email || h('span', { class: 'muted', text: 'No account' }) },
      { label: 'Rating', render: (s) => (s.rating ? h('span', {}, starsEl(s.rating), ` ${s.rating}`) : '') },
      { label: 'Vetted', render: (s) => {
        const box = h('input', { type: 'checkbox', checked: !!s.vetted, 'aria-label': `Vetted: ${s.name}`, onchange: async (e) => {
          try { await call(`/api/admin/shops/${s.id}`, { method: 'PUT', body: { vetted: e.target.checked } }); } catch (err) { e.target.checked = !e.target.checked; alert(err.message); }
        } });
        return box;
      } },
    ], shops));
  }

  // ---------------------------------------------------------------- garages

  async function renderGarages() {
    const { garages } = await call('/api/admin/garages');
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const f = {
      name: input('g-name'), phone: input('g-phone', { type: 'tel' }), whatsapp: input('g-wa', { type: 'tel' }),
      lat: input('g-lat'), lon: input('g-lon'), address: input('g-addr'), specialties: input('g-spec'),
    };
    const form = h('form', { class: 'panel', novalidate: true, onsubmit: async (event) => {
      event.preventDefault();
      setStatus(status, 'Saving…');
      try {
        await call('/api/admin/garages', { method: 'POST', body: {
          name: f.name.value, phone: f.phone.value, whatsapp_number: f.whatsapp.value || null,
          latitude: f.lat.value, longitude: f.lon.value, address_text: f.address.value, specialties: f.specialties.value,
        } });
        setStatus(status, 'Garage added.', 'ok');
        setTimeout(() => showTab('garages'), 1200);
      } catch (err) { setStatus(status, err.message, 'error'); }
    } },
      h('h2', { text: 'Add a garage' }),
      h('div', { class: 'row stack-sm' }, fieldEl('Garage name', f.name), fieldEl('Phone', f.phone)),
      h('div', { class: 'row stack-sm' }, fieldEl('WhatsApp (optional)', f.whatsapp), fieldEl('Area or address', f.address)),
      h('div', { class: 'row stack-sm' }, fieldEl('Latitude', f.lat), fieldEl('Longitude', f.lon)),
      fieldEl('What they are good at', f.specialties, 'For example: brakes, body work, Korean cars.'),
      h('button', { class: 'btn btn-primary', type: 'submit', text: 'Add garage' }), status);
    return h('div', {}, form, h('h2', { text: 'All garages' }), dataTable([
      { label: 'Garage', key: 'name' }, { label: 'Phone', key: 'phone' }, { label: 'Area', key: 'address_text' }, { label: 'Specialties', key: 'specialties' },
    ], garages));
  }

  // ---------------------------------------------------------------- cars and bookings (read only)

  async function renderCars() {
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const listMount = h('div', {});

    const f = {
      plate: input('c-plate', { placeholder: 'RAE 123 A' }), make: input('c-make'), model: input('c-model'),
      year: input('c-year', { type: 'number', min: 1980, max: new Date().getFullYear() + 1 }),
      generation: input('c-gen'), engine: input('c-eng'), vin: input('c-vin', { maxLength: 17 }),
      origin: select('c-origin', [['', 'Not sure'], ...meta.origins.map((o) => [o, o])]),
      importSource: select('c-import', [['', 'Not sure'], ...meta.import_sources.map((o) => [o, o])]),
    };
    const form = h('form', { class: 'panel', novalidate: true, onsubmit: async (event) => {
      event.preventDefault();
      setStatus(status, 'Saving…');
      try {
        const res = await call('/api/admin/vehicles', { method: 'POST', body: {
          plate_number: f.plate.value, make: f.make.value, model: f.model.value, year: f.year.value,
          generation: f.generation.value, engine: f.engine.value, vin: f.vin.value,
          origin_market: f.origin.value, import_source: f.importSource.value,
        } });
        setStatus(status, res.updated ? `Updated ${res.vehicle.plate_number}.` : `Added ${res.vehicle.plate_number}.`, 'ok');
        form.reset();
        await reloadList();
      } catch (err) { setStatus(status, err.message, 'error'); }
    } },
      h('h2', { text: 'Add or correct a car' }),
      h('p', { class: 'muted', text: 'Posting a plate that already exists updates that car instead of creating a second one.' }),
      h('div', { class: 'row stack-sm' }, fieldEl('Plate', f.plate), fieldEl('VIN (optional)', f.vin)),
      h('div', { class: 'row stack-sm' }, fieldEl('Make', f.make), fieldEl('Model', f.model)),
      h('div', { class: 'row stack-sm' }, fieldEl('Year', f.year), fieldEl('Generation (optional)', f.generation)),
      h('div', { class: 'row stack-sm' }, fieldEl('Engine (optional)', f.engine), fieldEl('Built in', f.origin)),
      fieldEl('Imported from', f.importSource),
      h('button', { class: 'btn btn-primary', type: 'submit', text: 'Save car' }), status);

    async function reloadList() {
      const { vehicles } = await call('/api/admin/vehicles');
      listMount.replaceChildren(dataTable([
        { label: 'Plate', key: 'plate_number' }, { label: 'Car', render: (v) => `${v.year} ${v.make} ${v.model}${v.generation ? ` ${v.generation}` : ''}` },
        { label: 'Engine', key: 'engine' }, { label: 'Built in', key: 'origin_market' }, { label: 'Imported from', key: 'import_source' },
        { label: 'VIN', key: 'vin' }, { label: 'Added by', key: 'registered_by' }, { label: 'When', key: 'created_at' },
        { label: '', render: (v) => h('button', { class: 'btn btn-danger btn-small', type: 'button', text: 'Delete', onclick: async () => {
          if (!confirm(`Delete ${v.plate_number} (${v.year} ${v.make} ${v.model})?`)) return;
          try { await call(`/api/admin/vehicles/${v.id}`, { method: 'DELETE' }); await reloadList(); }
          catch (err) { alert(err.message); }
        } }) },
      ], vehicles));
    }
    await reloadList();
    return h('div', {}, form, h('h2', { text: 'Registered cars' }),
      h('p', { class: 'muted', text: 'Full VINs and phone numbers are visible here only. Handle them carefully.' }), listMount);
  }

  async function renderBookings() {
    const { bookings } = await call('/api/admin/bookings');
    return h('div', {}, h('h2', { text: 'Booking requests' }), dataTable([
      { label: 'When', key: 'created_at' }, { label: 'Car', render: (b) => `${b.year} ${b.make} ${b.model} (${b.plate_number})` },
      { label: 'Customer', key: 'customer_phone' }, { label: 'Status', key: 'status' }, { label: 'Note', key: 'note' },
    ], bookings));
  }
})();
