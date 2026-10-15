/* Admin console. Approve shops and garages that apply, post parts (only admins can, so nobody
   can sell a fake part), manage the fitment reference (the core data asset), and see what
   customers searched for that we could not answer. Signs in with an admin account. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let meta = null;
  let categories = [];
  let makes = [];          // the model lineup, for the car pickers
  let prefill = null;      // set when jumping from the "missing parts" report to the add form
  let editing = null;      // fitment row being edited

  // The session cookie of the signed-in admin account authorises every call.
  const call = (path, opts = {}) => api(path, opts);

  const TABS = [
    ['overview', 'Overview', renderOverview],
    ['applications', 'Applications', renderApplications],
    ['reports', 'Reports', renderReports],
    ['parts', 'Parts', renderParts],
    ['shops', 'Shops', renderShops],
    ['garages', 'Garages', renderGarages],
    ['customers', 'Customers', renderCustomers],
    ['bookings', 'Bookings', renderBookings],
    ['reviews', 'Reviews', renderReviews],
    ['fitment', 'Part numbers', renderFitment],
    ['gaps', 'Missing parts', renderGaps],
    ['cars', 'Cars', renderCars],
    ['log', 'Admin log', renderLog],
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
    ({ categories, makes } = await api('/api/catalog'));
    $('admin-account').replaceChildren(accountMenu(user, 'admin'));
    $('admin-switch').replaceChildren(portalSwitch(user, 'admin') || '');
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
    const [s, activity] = await Promise.all([call('/api/admin/stats'), call('/api/admin/activity?weeks=12')]);
    // label is [singular, plural], so "1 booking request" and "2 booking requests" both read right.
    const stat = (n, [one, many], tone) => h('div', { class: `stat${tone && n ? ` stat-${tone}` : ''}` }, h('b', { text: String(n) }), h('span', { text: n === 1 ? one : many }));
    const tally = (title, rows) => h('div', {},
      h('h3', { text: title }),
      dataTable([{ label: 'Value', key: 'label' }, { label: 'Cars', key: 'n', num: true }], rows));
    const todo = [
      s.pending_applications ? [`${s.pending_applications} ${s.pending_applications === 1 ? 'business is' : 'businesses are'} waiting for approval.`, 'Check applications', 'applications'] : null,
      s.open_reports ? [`${s.open_reports} customer ${s.open_reports === 1 ? 'report is' : 'reports are'} open.`, 'Look into reports', 'reports'] : null,
      s.pending_part_requests ? [`${s.pending_part_requests} part ${s.pending_part_requests === 1 ? 'request is' : 'requests are'} waiting.`, 'Check part requests', 'parts'] : null,
    ].filter(Boolean);
    return h('div', {},
      todo.length ? h('div', { class: 'note-box todo-box' }, ...todo.map(([msg, btn, tab]) => h('p', {}, `${msg} `,
        h('button', { class: 'link-btn', type: 'button', text: btn, onclick: () => showTab(tab) })))) : null,
      h('div', { class: 'stat-grid' },
        stat(s.pending_applications, ['application waiting', 'applications waiting'], 'new'),
        stat(s.open_reports, ['open report', 'open reports'], 'warn'),
        stat(s.pending_part_requests, ['part request waiting', 'part requests waiting'], 'new'),
        stat(s.customers, ['customer', 'customers']),
        stat(s.vehicles, ['registered car', 'registered cars']),
        stat(s.bookings, ['booking', 'bookings']),
        stat(s.live_listings, ['part in stock', 'parts in stock']),
        stat(s.shops, ['shop', 'shops']), stat(s.garages, ['garage', 'garages']),
        stat(s.suspended, ['business suspended', 'businesses suspended'], 'warn'),
        stat(s.reviews, ['review', 'reviews']),
        stat(s.fitment_rows, ['part number row', 'part number rows'])),
      meta && meta.demo ? h('p', { class: 'note-box', text: 'These numbers include demo cars, shops and bookings. Do not quote them in your thesis until you have cleared the demo data.' }) : null,

      h('h2', { text: 'The last 12 weeks' }),
      h('div', { class: 'chart-grid' },
        weekChart('Bookings per week', activity.weeks, 'bookings'),
        weekChart('New cars per week', activity.weeks, 'cars'),
        weekChart('New customers per week', activity.weeks, 'customers')),
      h('div', { class: 'chart-grid' },
        barList('Most booked parts', activity.top_parts, 'bookings'),
        barList('Shops with the most bookings', activity.top_shops, 'bookings'),
        barList('Most searched parts we do not have yet', activity.top_missing, 'searches')),

      downloadsBox(),
      h('h2', { text: 'Cars on Vinzuu' }),
      h('p', { class: 'muted', text: 'The tables below are real data about the cars your users register. When you have enough real registrations, they can support your thesis (always state how many cars they are based on).' }),
      h('div', { class: 'row' }, tally('Cars by make', s.vehicles_by_make), tally('Cars by where they were built', s.vehicles_by_origin_market)),
      tally('Cars by where they were imported from (as the owner told us)', s.vehicles_by_import_source));
  }

  // ---------------------------------------------------------------- charts (inline SVG, no library)

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs, ...kids) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    kids.forEach((k) => k && el.append(k));
    return el;
  };
  const weekLabel = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

  /** One series per chart, one bar per week. Hover (or tap) a bar for its exact number; the
   *  numbers are also in a table under the chart. */
  function weekChart(title, weeks, key) {
    const W = 320; const H = 170; const left = 26; const bottom = 22; const top = 14;
    const values = weeks.map((w) => w[key]);
    const max = Math.max(...values);
    const niceMax = max <= 4 ? 4 : Math.ceil(max / 4) * 4;
    const plotH = H - bottom - top;
    const step = (W - left) / weeks.length;
    const barW = Math.max(6, step - 6);
    const y = (v) => top + plotH - (v / niceMax) * plotH;
    const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'week-chart', role: 'img', 'aria-label': `${title}: ${values.join(', ')} over the last ${weeks.length} weeks` });
    for (const g of [0, niceMax / 2, niceMax]) {
      chart.append(svg('line', { x1: left, x2: W, y1: y(g), y2: y(g), class: g ? 'grid' : 'axis' }));
      const t = svg('text', { x: left - 6, y: y(g) + 4, 'text-anchor': 'end', class: 'tick' }); t.textContent = String(g); chart.append(t);
    }
    weeks.forEach((w, i) => {
      const v = w[key];
      const x = left + i * step + (step - barW) / 2;
      const hgt = (v / niceMax) * plotH;
      const r = Math.min(4, hgt / 2, barW / 2);
      const base = top + plotH;
      const tip = svg('title'); tip.textContent = `Week of ${weekLabel(w.week_start)}: ${v}`;
      // Rounded at the top (the value end), square on the baseline.
      const d = v ? `M${x},${base} V${base - hgt + r} Q${x},${base - hgt} ${x + r},${base - hgt} H${x + barW - r} Q${x + barW},${base - hgt} ${x + barW},${base - hgt + r} V${base} Z` : '';
      const g = svg('g', { class: `bar-g${i === weeks.length - 1 ? ' is-now' : ''}`, tabindex: '0' },
        svg('rect', { x: left + i * step, y: top, width: step, height: plotH, class: 'hit' }), d ? svg('path', { d, class: 'bar' }) : null, tip);
      chart.append(g);
      if (i % 3 === (weeks.length - 1) % 3) {
        const t = svg('text', { x: x + barW / 2, y: H - 6, 'text-anchor': 'middle', class: 'tick' }); t.textContent = weekLabel(w.week_start); chart.append(t);
      }
    });
    const total = values.reduce((a, b) => a + b, 0);
    const now = values[values.length - 1];
    return h('figure', { class: 'chart-card panel' },
      h('figcaption', {}, h('strong', { text: title }), h('span', { class: 'small muted', text: `${total} in 12 weeks · ${now} this week so far` })),
      chart,
      h('details', { class: 'chart-table' }, h('summary', { text: 'See the numbers' }),
        dataTable([{ label: 'Week of', render: (w) => weekLabel(w.week_start) }, { label: title.replace(/ per week$/, ''), key, num: true }], weeks)));
  }

  /** Horizontal bars for a top-6 list, longest first, with the number at the end of each bar. */
  function barList(title, rows, unit) {
    const max = Math.max(1, ...rows.map((r) => r.n));
    return h('figure', { class: 'chart-card panel' },
      h('figcaption', {}, h('strong', { text: title })),
      rows.length ? h('ul', { class: 'bar-list' }, ...rows.map((r) => h('li', { title: `${r.label}: ${r.n} ${unit}` },
        h('span', { class: 'bl-label', text: r.label }),
        h('span', { class: 'bl-track' }, h('span', { class: 'bl-bar', style: `width:${Math.max(2, (r.n / max) * 100)}%` })),
        h('span', { class: 'bl-n', text: String(r.n) })))) : h('p', { class: 'empty muted', text: 'Nothing yet.' }));
  }

  // ---------------------------------------------------------------- CSV downloads

  const EXPORTS = [['bookings', 'Bookings'], ['parts', 'Parts'], ['cars', 'Cars'], ['shops', 'Shops'], ['garages', 'Garages'],
    ['customers', 'Accounts'], ['reviews', 'Reviews'], ['reports', 'Reports']];
  const csvLink = (what, label) => h('a', { class: 'btn btn-secondary btn-small', href: `/api/admin/export/${what}.csv`, download: '' }, `⤓ ${label || 'Download CSV'}`);
  function downloadsBox() {
    return h('div', { class: 'panel downloads' },
      h('h2', { text: 'Download data' }),
      h('p', { class: 'muted', text: 'CSV files open in Excel or Google Sheets, for example for your thesis appendix. Downloads are kept in the admin log.' }),
      h('div', { class: 'btn-row' }, ...EXPORTS.map(([w, l]) => csvLink(w, l))));
  }

  // ---------------------------------------------------------------- dialogs

  function dialog(title, build) {
    let dlg = $('admin-dialog');
    if (!dlg) { dlg = h('dialog', { id: 'admin-dialog', 'aria-labelledby': 'admin-dialog-title' }); document.body.append(dlg); }
    const close = () => { if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open'); };
    dlg.replaceChildren(h('div', { class: 'dialog-body' }, h('h2', { id: 'admin-dialog-title', text: title }), ...build(close).filter(Boolean)));
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
  }
  const showPhoto = (src, title) => dialog(title, (close) => [
    h('img', { class: 'detail-photo detail-photo-lg', src, alt: title }),
    h('div', { class: 'dialog-actions' }, h('button', { class: 'btn btn-quiet', type: 'button', text: 'Close', onclick: close }))]);

  /** Ask for a reason, then run fn(reason). Used for every "reject", "suspend", "block"... */
  function askReason(title, hint, fn, { action = 'Reject', label = 'Reason (they will see it)', danger = true, intro = null } = {}) {
    const box = h('textarea', { id: 'reason-box', rows: 3, maxLength: 300 });
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    dialog(title, (close) => [
      intro ? h('p', { class: 'muted', text: intro }) : null,
      fieldEl(label, box, hint),
      status,
      h('div', { class: 'dialog-actions' },
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', text: action, onclick: async () => {
          if (!box.value.trim()) return setStatus(status, label.startsWith('Reason') ? 'Write the reason.' : 'Write a short note.', 'error');
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

  // ---------------------------------------------------------------- reports from customers

  async function renderReports() {
    const { reports, reasons } = await call('/api/admin/reports');
    let filter = reports.some((r) => r.status === 'open') ? 'open' : 'all';
    const mount = h('div', { class: 'app-list' });
    const draw = () => {
      const rows = reports.filter((r) => filter === 'all' || r.status === filter);
      mount.replaceChildren(...(rows.length ? rows.map((r) => reportCard(r, reasons)) : [h('p', { class: 'empty muted', text: filter === 'open' ? 'No open reports.' : 'Nothing here.' })]));
    };
    draw();
    const count = (st) => reports.filter((r) => r.status === st).length;
    return h('div', {},
      h('h2', { text: 'Problems customers reported' }),
      h('p', { class: 'muted', text: 'Call the customer and the business, then decide. You can hide the part, suspend the business, or cancel a booking from the Bookings tab. Close the report with a note saying what you did.' }),
      segFilter([['open', `Open (${count('open')})`], ['closed', `Closed (${count('closed')})`], ['all', 'All']], filter, (k) => { filter = k; draw(); }),
      mount);
  }

  function reportCard(r, reasons) {
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const about = r.target === 'garage' ? `Garage: ${r.garage_name}` : r.target === 'listing'
      ? `Part: ${r.part_category} ${r.oe_number || r.universal_spec || ''} at ${r.shop_name}` : `Shop: ${r.shop_name}`;
    const act = (fn, done) => async () => {
      try { await fn(); setStatus(status, done, 'ok'); setTimeout(() => showTab('reports'), 1200); } catch (err) { setStatus(status, err.message, 'error'); }
    };
    const suspendable = r.garage_id ? ['garages', r.garage_id, r.garage_name, r.garage_suspended] : ['shops', r.shop_id, r.shop_name, r.shop_suspended];
    return h('article', { class: `app-card report-card${r.status === 'closed' ? ' is-closed' : ''}` },
      r.photo_url ? h('div', { class: 'app-photos' }, h('button', { class: 'thumb-btn', type: 'button', onclick: () => showPhoto(r.photo_url, r.part_category) },
        h('img', { src: r.photo_url, alt: `Photo of ${r.part_category}` }), h('span', { text: 'The part' }))) : null,
      h('div', { class: 'app-body' },
        h('div', { class: 'app-top' }, r.status === 'open' ? pill('Open', 'pill-warn') : pill('Closed', 'pill-done'),
          h('span', { class: 'small muted', text: `Reported ${when(r.created_at)}${r.booking_id ? ` · booking #${r.booking_id}` : ''}` })),
        h('h3', { text: reasons[r.reason] || r.reason }),
        h('dl', { class: 'detail-list' },
          h('dt', { text: 'About' }), h('dd', {}, about,
            r.shop_suspended && r.target !== 'garage' ? h('span', { class: 'pill pill-off inline-pill', text: 'Suspended' }) : null,
            r.garage_suspended && r.target === 'garage' ? h('span', { class: 'pill pill-off inline-pill', text: 'Suspended' }) : null,
            r.listing_hidden ? h('span', { class: 'pill pill-off inline-pill', text: 'Part hidden' }) : null),
          h('dt', { text: 'What happened' }), h('dd', { text: r.details || 'No details given.' }),
          h('dt', { text: 'From' }), h('dd', {}, `${r.user_name || 'Deleted account'}${r.user_email ? ` (${r.user_email})` : ''} `,
            r.user_phone ? h('a', { href: whatsappLink(r.user_phone, `Hello ${String(r.user_name || '').split(' ')[0]}, this is the Vinzuu team about the problem you reported.`), target: '_blank', rel: 'noopener', text: r.user_phone }) : null),
          r.admin_note ? h('dt', { text: 'What we did' }) : null, r.admin_note ? h('dd', { text: `${r.admin_note} (${when(r.closed_at)})` }) : null),
        r.status === 'open' ? h('div', { class: 'btn-row' },
          h('button', { class: 'btn btn-primary btn-small', type: 'button', text: 'Close with a note', onclick: () => askReason('Close this report',
            'For example: called the shop, they refunded the difference.',
            async (note) => { await call(`/api/admin/reports/${r.id}/close`, { method: 'POST', body: { admin_note: note } }); showTab('reports'); },
            { action: 'Close report', label: 'What did you do?', danger: false }) }),
          r.listing_id && !r.listing_hidden ? h('button', { class: 'btn btn-secondary btn-small', type: 'button', text: 'Hide the part',
            onclick: act(() => call(`/api/admin/listings/${r.listing_id}`, { method: 'PUT', body: { hidden: true } }), 'The part is hidden from customers.') }) : null,
          suspendable[1] && !suspendable[3] ? h('button', { class: 'btn btn-danger btn-small', type: 'button', text: `Suspend ${suspendable[0] === 'shops' ? 'the shop' : 'the garage'}`,
            onclick: () => suspendBusiness(suspendable[0], { id: suspendable[1], name: suspendable[2] }, () => showTab('reports')) }) : null,
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
      cat: h('select', { id: 'pp-cat' }, ...categoryOptions(categories, 'Choose a part')),
      oe: h('select', { id: 'pp-oe' }), spec: input('pp-spec', { placeholder: 'For example 12V 60Ah' }),
      brand: input('pp-brand', { placeholder: 'For example Bosch' }),
      cond: select('pp-cond', [['genuine', 'Genuine part'], ['aftermarket', 'Aftermarket part']]),
      war: input('pp-war', { type: 'number', min: 0, placeholder: 'No warranty' }),
      price: input('pp-price', { type: 'number', min: 1 }), stock: input('pp-stock', { type: 'number', min: 0, value: 1 }),
      desc: h('textarea', { id: 'pp-desc', rows: 3, maxLength: 600 }),
      photo: h('input', { id: 'pp-photo', type: 'file', accept: 'image/*' }),
      preview: h('img', { class: 'photo-preview', alt: 'Photo preview', hidden: true }),
    };
    // Like a parts catalogue: the car narrows the part numbers, so the list stays short.
    const car = carSelects(makes, 'pp', { onChange: () => loadNumbers() });
    // A number that isn't in the table yet can be typed here: posting saves it for the chosen car
    // first (LOW confidence until checked), so a new part never has to wait for the Part numbers tab.
    const NEW = '__new';
    const newOe = input('pp-newoe', { placeholder: 'Type it exactly as printed', maxLength: 60 });
    const newWrap = h('div', { class: 'row stack-sm' },
      fieldEl('New part number', newOe, 'As printed on the part, its box or the old part.'),
      fieldEl('Engine', car.engine, 'Leave it at "Any" if it fits every engine of that car.'));
    newWrap.hidden = true;
    f.oe.addEventListener('change', () => { newWrap.hidden = f.oe.value !== NEW; });
    const oeWrap = h('div', {},
      h('div', { class: 'field' }, h('label', { for: 'pp-make', text: 'Which car is it for?' }),
        h('div', { class: 'car-selects' }, ...car.fields),
        h('p', { class: 'hint', text: 'Choose the car to see only its part numbers. Leave the model at "Any" to see every car of that make.' })),
      fieldEl('Part number', f.oe), newWrap);
    const specWrap = fieldEl('Size or specification', f.spec);
    oeWrap.hidden = true; specWrap.hidden = true;
    async function loadNumbers() {
      const cat = categories.find((c) => c.name === f.cat.value);
      if (!cat || cat.type !== 'model_specific') return;
      f.oe.replaceChildren(h('option', { value: '', text: 'Loading…' }));
      const { rows } = await call(`/api/admin/oe-numbers?part_category=${enc(cat.name)}&${car.query()}`);
      const choices = oeChoices(rows);
      f.oe.replaceChildren(
        ...(choices.length ? [h('option', { value: '', text: `Choose the part number (${choices.length})` })] : []),
        ...choices.map((c) => h('option', { value: c.oe, text: c.text })),
        h('option', { value: NEW, text: choices.length ? 'Not listed: type a new part number' : 'No part numbers for this car yet: type a new one' }));
      newWrap.hidden = f.oe.value !== NEW;
    }

    /** Saves a typed number for the chosen car and returns it. Years come from the generation, or
     *  from every generation of the model when none is chosen. */
    async function saveNewNumber(cat) {
      const oe = newOe.value.trim().toUpperCase();
      if (!oe) throw new Error('Type the new part number.');
      const model = (makes.find((m) => m.make === car.make.value) || { models: [] }).models.find((m) => m.model === car.model.value);
      if (!model) throw new Error('Choose the make and model the part fits, so customers with that car find it.');
      const gens = car.generation.value ? model.generations.filter((g) => g.generation === car.generation.value) : model.generations;
      await call('/api/admin/fitment-reference', { method: 'POST', body: {
        part_category: cat.name, oe_number: oe, make: car.make.value, model: car.model.value,
        generation: car.generation.value || null, engine: car.engine.value || null,
        year_start: Math.min(...gens.map((g) => g.year_start)), year_end: Math.max(...gens.map((g) => g.year_end)),
        origin_market: null, confidence_level: 'LOW', source: 'Added by the admin when posting a part',
      } });
      return oe;
    }
    f.cat.addEventListener('change', () => {
      const cat = categories.find((c) => c.name === f.cat.value);
      oeWrap.hidden = !cat || cat.type !== 'model_specific';
      specWrap.hidden = !cat || cat.type !== 'universal';
      loadNumbers();
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
      if (cat.type === 'model_specific' && !f.oe.value) return setStatus(status, 'Choose the part number, or type a new one.', 'error');
      if (!photo) return setStatus(status, 'Add a photo of the part.', 'error');
      setStatus(status, 'Posting…');
      try {
        let oe = cat.type === 'model_specific' ? f.oe.value : null;
        if (oe === NEW) oe = await saveNewNumber(cat);
        await call('/api/admin/listings', { method: 'POST', body: {
          shop_id: Number(f.shop.value), part_category: cat.name,
          oe_number: oe, universal_spec: cat.type === 'universal' ? f.spec.value : null,
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
    // The car comes from the model lineup, so names match what customers register exactly.
    const car = carSelects(makes, 'f', { withEngine: true, anyText: 'Every', onChange: () => {
      const g = car.generationInfo();
      if (g) { f.yearStart.value = g.year_start; f.yearEnd.value = g.year_end; }
    } });
    const f = {
      category: h('select', { id: 'f-cat' }, ...categoryOptions(modelSpecific, null)),
      oe: input('f-oe', { placeholder: 'For example 90915-YZZE1' }), make: car.make, model: car.model, generation: car.generation,
      yearStart: input('f-ys', { type: 'number', min: 1980 }), yearEnd: input('f-ye', { type: 'number', min: 1980 }),
      engine: car.engine,
      origin: select('f-origin', [['', 'Any (this part fits every origin)'], ...meta.origins.map((o) => [o, `${o}-built only`])]),
      confidence: select('f-conf', [['LOW', 'LOW: one unconfirmed source'], ['MEDIUM', 'MEDIUM: confirmed by more than one shop'], ['HIGH', 'HIGH: official catalogue or physical check']]),
      source: input('f-src'), verifiedBy: input('f-ver'),
    };

    function load(row) {
      f.category.value = row.part_category || modelSpecific[0].name;
      f.oe.value = row.oe_number || '';
      car.set({ make: row.make, model: row.model, generation: row.generation, engine: row.engine });
      f.yearStart.value = row.year_start || ''; f.yearEnd.value = row.year_end || '';
      f.origin.value = row.origin_market || '';
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
      h('div', { class: 'row stack-sm' }, fieldEl('Generation', f.generation, 'Choosing one fills in its years. Leave it at "Every" if the part fits every generation in the years given.'), fieldEl('Engine', f.engine, 'Leave it at "Every" if it fits every engine.')),
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
        { label: 'Source', render: (r) => sourceLinks(r.source) },
        { label: 'Verified by', render: (r) => r.verified_by || '' },
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
    wrap.append(form, importPanel(reloadList), h('h2', { text: 'All part numbers' }),
      h('div', { class: 'filter-bar' }, h('div', { class: 'field' }, search), csvLink('part-numbers', 'Download all')), listMount);
    return wrap;
  }

  /** A source is free text or one or more web pages (separated by " ; "): pages show as short links. */
  function sourceLinks(source) {
    const parts = String(source || '').split(/\s+;\s+/);
    if (!parts.every((p) => /^https?:\/\/\S+$/.test(p))) return source;
    return h('span', {}, ...parts.flatMap((p, i) => {
      let host = p;
      try { host = new URL(p).hostname.replace(/^www\./, ''); } catch (err) { /* show it as written */ }
      return [i ? ', ' : null, h('a', { href: p, target: '_blank', rel: 'noopener', text: host })];
    }));
  }

  /** Many part numbers at once, from a spreadsheet saved as CSV (for example a catalogue export). */
  function importPanel(after) {
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const file = h('input', { id: 'imp-file', type: 'file', accept: '.csv,text/csv' });
    const problems = h('ul', { class: 'import-errors small' });
    const COLS = 'oe_number, part, make, model, generation, year_from, year_to, engine, built_in, confidence, source, verified_by';
    const sample = `${COLS.replace(/ /g, '')}\n90915-YZZE1,Oil Filter,Toyota,RAV4,XA40,2013,2018,2.0L Petrol,,MEDIUM,Toyota parts catalogue,\n`;
    async function send(dryRun) {
      problems.replaceChildren();
      if (!file.files[0]) return setStatus(status, 'Choose the CSV file first.', 'error');
      if (file.files[0].size > 900 * 1024) return setStatus(status, 'That file is too big. Split it into files under 900 KB.', 'error');
      setStatus(status, dryRun ? 'Checking…' : 'Importing…');
      try {
        const r = await call('/api/admin/fitment-reference/import', { method: 'POST', body: { csv: await file.files[0].text(), dry_run: dryRun } });
        const bad = r.error_count ? ` ${r.error_count} ${r.error_count === 1 ? 'row has a problem' : 'rows have problems'} (listed below).` : '';
        setStatus(status, dryRun
          ? `Checked ${r.rows} rows: ${r.added} would be added, ${r.skipped} are already there.${bad}`
          : `Added ${r.added} part numbers. ${r.skipped} were already there.${bad}`, r.error_count ? 'error' : 'ok');
        problems.replaceChildren(...r.errors.map((e) => h('li', { text: `Line ${e.line}: ${e.message}` })));
        if (!dryRun && r.added) after();
      } catch (err) { setStatus(status, err.message, 'error'); }
    }
    return h('details', { class: 'panel import-panel' },
      h('summary', {}, h('strong', { text: 'Import part numbers from a spreadsheet' })),
      h('p', { class: 'muted', text: 'Save the spreadsheet as CSV with these columns in the first row. Blank generation, engine or built_in means it fits every one. Part names must match the Part list exactly.' }),
      h('p', {}, h('code', { text: COLS })),
      h('p', {}, h('a', { href: `data:text/csv;charset=utf-8,${encodeURIComponent(sample)}`, download: 'part-numbers-template.csv', text: 'Download an empty template' })),
      h('div', { class: 'field' }, h('label', { for: 'imp-file', text: 'CSV file' }), file),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-secondary', type: 'button', text: 'Check the file', onclick: () => send(true) }),
        h('button', { class: 'btn btn-primary', type: 'button', text: 'Import', onclick: () => send(false) })),
      status, problems);
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

  // ---------------------------------------------------------------- shops and garages (with scorecards)

  /** Suspend (with a reason) or reactivate a shop or garage. table is 'shops' or 'garages'. */
  function suspendBusiness(table, b, then) {
    const kind = table === 'shops' ? 'shop' : 'garage';
    askReason(`Suspend ${b.name}`, 'For example: three customers reported fake brake pads. We are checking.',
      async (reason) => { await call(`/api/admin/${table}/${b.id}/suspend`, { method: 'POST', body: { reason } }); then(); },
      { action: `Suspend ${kind}`, intro: kind === 'shop'
        ? 'Its parts disappear from search and nobody can book them until you reactivate it. The owner can still sign in and sees your reason.'
        : 'It disappears from the garage list and nobody can book it until you reactivate it. The owner can still sign in and sees your reason.' });
  }
  async function reactivate(table, b, then) {
    if (!confirm(`Reactivate ${b.name}? Customers will see it again.`)) return;
    try { await call(`/api/admin/${table}/${b.id}/reactivate`, { method: 'POST' }); then(); } catch (err) { alert(err.message); }
  }
  /** Opens Vinzuu Sellers & Garages as this shop or garage, read-only. */
  function openAsOwner(kind, id) {
    store.set('vz.biz.view', JSON.stringify({ kind, id }), 'sessionStorage');
    store.set('vz.biz.side', kind, 'sessionStorage');
    location.href = '/business.html';
  }

  function editBusiness(table, b) {
    const kind = table === 'shops' ? 'shop' : 'garage';
    const f = {
      name: input('eb-name', { value: b.name, maxLength: 80 }), phone: input('eb-phone', { type: 'tel', value: b.phone || '' }),
      wa: input('eb-wa', { type: 'tel', value: b.whatsapp_number || '', placeholder: 'Same as phone if blank' }),
      address: input('eb-addr', { value: b.address_text || '', maxLength: 120 }),
      hours: input('eb-hours', { value: b.opening_hours || '', maxLength: 120, placeholder: 'For example: Mon to Sat 8:00 to 18:00' }),
      lat: input('eb-lat', { value: b.latitude, inputMode: 'decimal' }), lon: input('eb-lon', { value: b.longitude, inputMode: 'decimal' }),
      vetted: kind === 'shop' ? h('input', { id: 'eb-vet', type: 'checkbox', checked: !!b.vetted }) : null,
      spec: kind === 'garage' ? input('eb-spec', { value: b.specialties || '', maxLength: 160 }) : null,
      photo: kind === 'garage' ? h('input', { id: 'eb-photo', type: 'file', accept: 'image/*' }) : null,
      preview: kind === 'garage' ? h('img', { class: 'photo-preview', alt: 'Garage photo', src: b.photo_url || null, hidden: !b.photo_url }) : null,
    };
    let photo = null;
    if (f.photo) f.photo.addEventListener('change', async (e) => {
      photo = null; f.preview.src = b.photo_url || ''; f.preview.hidden = !b.photo_url;
      if (!e.target.files[0]) return;
      try { photo = await resizeImage(e.target.files[0], 800); f.preview.src = photo; f.preview.hidden = false; } catch (err) { setStatus(status, err.message, 'error'); }
    });
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    dialog(`Edit ${b.name}`, (close) => [
      h('p', { class: 'muted', text: `Only the vinzuu team can change the name and the map location. The ${kind} owner can change the rest themselves too.` }),
      h('div', { class: 'row stack-sm' }, fieldEl('Name', f.name), fieldEl('Phone', f.phone)),
      h('div', { class: 'row stack-sm' }, fieldEl('WhatsApp', f.wa), fieldEl('Area or address', f.address)),
      fieldEl('Opening hours', f.hours),
      h('div', { class: 'row stack-sm' }, fieldEl('Latitude', f.lat), fieldEl('Longitude', f.lon)),
      f.spec ? fieldEl('What they are good at', f.spec) : null,
      f.photo ? fieldEl(b.photo_url ? 'Change the photo' : 'Photo of the garage', f.photo) : null, f.preview,
      f.vetted ? h('div', { class: 'field' }, h('label', {}, f.vetted, ' Vetted: we checked they sell genuine parts')) : null,
      status,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn btn-primary', type: 'button', text: 'Save', onclick: async () => {
          const body = { name: f.name.value, phone: f.phone.value, whatsapp_number: f.wa.value || null, address_text: f.address.value,
            opening_hours: f.hours.value, latitude: f.lat.value, longitude: f.lon.value };
          if (f.vetted) body.vetted = f.vetted.checked;
          if (f.spec) body.specialties = f.spec.value;
          if (photo) body.photo_url = photo;
          try { await call(`/api/admin/${table}/${b.id}`, { method: 'PUT', body }); close(); showTab(table); } catch (err) { setStatus(status, err.message, 'error'); }
        } }),
        h('button', { class: 'btn btn-quiet', type: 'button', text: 'Cancel', onclick: close }))]);
  }

  /** The scorecard table shared by the Shops and Garages tabs. */
  function scorecardList(table, rows, extraColumns) {
    const kind = table === 'shops' ? 'shop' : 'garage';
    let filter = 'all';
    const mount = h('div', {});
    const attention = (b) => b.flags.length > 0;
    const draw = () => mount.replaceChildren(dataTable([
      { label: kind === 'shop' ? 'Shop' : 'Garage', render: (b) => h('div', { class: 'part-cell' }, h('strong', { text: b.name }),
        h('span', { class: 'small muted', text: [b.address_text, kind === 'shop' ? (b.vetted ? 'vetted' : 'not vetted') : null].filter(Boolean).join(' · ') }),
        b.flags.length ? h('span', { class: 'flag-row' }, ...b.flags.map((fl) => h('span', { class: `pill ${fl === 'Suspended' ? 'pill-off' : 'pill-warn'}`, text: fl }))) : null) },
      { label: 'Sign-in', render: (b) => (b.login_email ? h('div', { class: 'part-cell' }, h('span', { text: b.login_email }),
        h('span', { class: 'small muted', text: b.last_active ? `Last in ${when(b.last_active)}` : 'Not signed in yet' })) : h('span', { class: 'muted', text: 'No account' })) },
      { label: 'Rating', render: (b) => (b.review_count ? h('span', { class: 'nowrap' }, starsEl(b.rating), ` ${b.rating} (${b.review_count})`) : h('span', { class: 'muted', text: 'None yet' })) },
      { label: 'Bookings', render: (b) => h('div', { class: 'part-cell' }, h('strong', { text: String(b.bookings) }),
        b.bookings ? h('span', { class: 'small muted', text: `${b.cancel_rate}% ${kind === 'shop' ? 'cancelled' : 'declined'}` }) : null) },
      { label: 'Reports', render: (b) => (b.open_reports ? h('b', { class: 'text-warn', text: `${b.open_reports} open` }) : '0'), num: true },
      ...extraColumns,
      { label: '', render: (b) => h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-secondary btn-small', type: 'button', text: 'Edit', onclick: () => editBusiness(table, b) }),
        b.login_email ? h('button', { class: 'btn btn-secondary btn-small', type: 'button', text: 'Open dashboard', title: `See what ${b.name} sees (read-only)`, onclick: () => openAsOwner(kind, b.id) }) : null,
        b.suspended
          ? h('button', { class: 'btn btn-primary btn-small', type: 'button', text: 'Reactivate', onclick: () => reactivate(table, b, () => showTab(table)) })
          : h('button', { class: 'btn btn-danger btn-small', type: 'button', text: 'Suspend', onclick: () => suspendBusiness(table, b, () => showTab(table)) })) },
    ], rows.filter((b) => filter === 'all' || (filter === 'attention' ? attention(b) : b.suspended))));
    draw();
    const n = (fn) => rows.filter(fn).length;
    return h('div', {},
      h('h2', { text: `All ${table} (${rows.length})` }),
      h('p', { class: 'muted', text: `Flags: rating under 3.5 (from 3 or more reviews), more than 20% of bookings ${kind === 'shop' ? 'cancelled' : 'declined'} (from 5 or more), an open customer report, or no sign-in for 30 days.` }),
      h('div', { class: 'parts-tools' },
        segFilter([['all', 'All'], ['attention', `Needs attention (${n(attention)})`], ['suspended', `Suspended (${n((b) => b.suspended)})`]], filter, (k) => { filter = k; draw(); }),
        csvLink(table)),
      mount);
  }

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
        setTimeout(() => showTab('shops'), 4000);
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

    return h('div', {}, form, scorecardList('shops', shops, [
      { label: 'On sale', key: 'parts_on_sale', num: true },
    ]));
  }

  async function renderGarages() {
    const { garages } = await call('/api/admin/garages');
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const f = {
      name: input('g-name'), phone: input('g-phone', { type: 'tel' }), whatsapp: input('g-wa', { type: 'tel' }),
      lat: input('g-lat'), lon: input('g-lon'), address: input('g-addr'), specialties: input('g-spec'),
      photo: h('input', { id: 'g-photo', type: 'file', accept: 'image/*' }),
      preview: h('img', { class: 'photo-preview', alt: 'Photo preview', hidden: true }),
    };
    let photo = null;
    f.photo.addEventListener('change', async (e) => {
      photo = null; f.preview.hidden = true;
      if (!e.target.files[0]) return;
      try { photo = await resizeImage(e.target.files[0], 800); f.preview.src = photo; f.preview.hidden = false; setStatus(status, ''); } catch (err) { setStatus(status, err.message, 'error'); }
    });
    const form = h('form', { class: 'panel', novalidate: true, onsubmit: async (event) => {
      event.preventDefault();
      if (!photo) return setStatus(status, 'Add a photo of the garage.', 'error');
      setStatus(status, 'Saving…');
      try {
        await call('/api/admin/garages', { method: 'POST', body: {
          name: f.name.value, phone: f.phone.value, whatsapp_number: f.whatsapp.value || null,
          latitude: f.lat.value, longitude: f.lon.value, address_text: f.address.value, specialties: f.specialties.value,
          photo_url: photo,
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
      fieldEl('Photo of the garage', f.photo, 'The front of the garage, so customers recognise it when they arrive.'), h('div', {}, f.preview),
      h('button', { class: 'btn btn-primary', type: 'submit', text: 'Add garage' }), status);
    return h('div', {}, form, scorecardList('garages', garages, [
      { label: 'Labour prices', key: 'services', num: true },
    ]));
  }

  // ---------------------------------------------------------------- customers (every account)

  async function renderCustomers() {
    let role = 'customer';
    const search = input('u-q', { type: 'search', placeholder: 'Search name, email or phone', 'aria-label': 'Search accounts' });
    const mount = h('div', {});
    const ROLE = { customer: 'Customer', business: 'Shop or garage', admin: 'Admin' };
    let timer = null;
    async function reload() {
      const { users } = await call(`/api/admin/users?role=${role === 'all' ? '' : role}&q=${enc(search.value)}`);
      mount.replaceChildren(dataTable([
        { label: 'Name', render: (u) => h('div', { class: 'part-cell' }, h('strong', { text: u.name }), h('span', { class: 'small muted', text: u.email }),
          u.phone ? h('span', { class: 'small muted', text: u.phone }) : null) },
        { label: 'Type', render: (u) => h('div', { class: 'part-cell' }, h('span', { text: ROLE[u.role] || u.role }),
          u.shop_name || u.garage_name ? h('span', { class: 'small muted', text: [u.shop_name, u.garage_name].filter(Boolean).join(' + ') }) : null) },
        { label: 'Cars', key: 'cars', num: true }, { label: 'Bookings', key: 'bookings', num: true }, { label: 'Reports', key: 'reports', num: true },
        { label: 'Joined', render: (u) => h('span', { class: 'nowrap', text: String(u.created_at || '').slice(0, 10) }) },
        { label: 'Last signed in', render: (u) => (u.last_login_at ? h('span', { class: 'nowrap', text: shortWhen(u.last_login_at) }) : h('span', { class: 'muted', text: 'Not yet' })) },
        { label: 'Status', render: (u) => (u.blocked ? h('span', { title: u.blocked_reason || '' }, pill('Blocked', 'pill-off')) : pill('Active', 'pill-ok')) },
        { label: '', render: (u) => (u.role === 'admin' ? null : u.blocked
          ? h('button', { class: 'btn btn-secondary btn-small', type: 'button', text: 'Unblock', onclick: async () => {
            if (!confirm(`Unblock ${u.email}? They can sign in again.`)) return;
            try { await call(`/api/admin/users/${u.id}/unblock`, { method: 'POST' }); reload(); } catch (err) { alert(err.message); }
          } })
          : h('button', { class: 'btn btn-danger btn-small', type: 'button', text: 'Block', onclick: () => askReason(`Block ${u.name}`,
            'For example: made fake bookings with other people\'s numbers.',
            async (reason) => { await call(`/api/admin/users/${u.id}/block`, { method: 'POST', body: { reason } }); reload(); },
            { action: 'Block account', intro: `${u.email} is signed out at once and cannot sign in again until you unblock it. They see your reason when they try.` }) })) },
      ], users));
    }
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(reload, 250); });
    await reload();
    return h('div', {},
      h('h2', { text: 'Accounts' }),
      h('p', { class: 'muted', text: 'Everyone with a Vinzuu account. Block an account that is abusing the site; a shop or garage owner who is blocked also loses their dashboard.' }),
      h('div', { class: 'parts-tools' }, search,
        segFilter([['customer', 'Customers'], ['business', 'Shops and garages'], ['admin', 'Admins'], ['all', 'All']], role, (k) => { role = k; reload(); }),
        csvLink('customers')),
      mount);
  }

  // ---------------------------------------------------------------- cars

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
    return h('div', {}, form, h('div', { class: 'h2-row' }, h('h2', { text: 'Registered cars' }), csvLink('cars')),
      h('p', { class: 'muted', text: 'Full VINs and phone numbers are visible here only. Handle them carefully.' }), listMount);
  }

  const shortWhen = (ts) => {
    const d = new Date(String(ts || '').replace(' ', 'T') + 'Z');
    return Number.isNaN(d.getTime()) ? (ts || '') : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  const STAGE = { open: ['Open', 'pill-new'], finished: ['Finished', 'pill-done'], cancelled: ['Cancelled', 'pill-off'] };
  const SHOP_SIDE = { requested: 'New', confirmed: 'Reserved', collected: 'Collected', cancelled: 'Cancelled' };
  const GARAGE_SIDE = { requested: 'New', accepted: 'Booked', done: 'Done', declined: 'Declined' };

  async function renderBookings() {
    const [{ shops }, { garages }] = await Promise.all([call('/api/admin/shops'), call('/api/admin/garages')]);
    const q = { stage: 'open', shop_id: '', garage_id: '', from: '', to: '', q: '' };
    const shopSel = select('bk-shop', [['', 'All shops'], ...shops.map((x) => [String(x.id), x.name])], { 'aria-label': 'Shop' });
    const garageSel = select('bk-garage', [['', 'All garages'], ...garages.map((x) => [String(x.id), x.name])], { 'aria-label': 'Garage' });
    const from = input('bk-from', { type: 'date', 'aria-label': 'From' });
    const to = input('bk-to', { type: 'date', 'aria-label': 'To' });
    const search = input('bk-q', { type: 'search', placeholder: 'Phone, plate, car or part', 'aria-label': 'Search bookings' });
    const mount = h('div', {});
    const count = h('p', { class: 'small muted' });
    let timer = null;
    async function reload() {
      Object.assign(q, { shop_id: shopSel.value, garage_id: garageSel.value, from: from.value, to: to.value, q: search.value.trim() });
      const { bookings } = await call(`/api/admin/bookings?${new URLSearchParams(q)}`);
      count.textContent = `${bookings.length} ${bookings.length === 1 ? 'booking' : 'bookings'}`;
      mount.replaceChildren(dataTable([
        { label: 'When', render: (b) => h('span', { class: 'nowrap', text: shortWhen(b.created_at) }) },
        { label: 'Car and customer', render: (b) => h('div', { class: 'part-cell' }, h('strong', { text: `${b.year} ${b.make} ${b.model}` }),
          h('span', { class: 'small muted', text: b.plate_number || '' }), h('a', { class: 'small', href: `tel:${b.customer_phone}`, text: b.customer_phone })) },
        { label: 'Part', render: (b) => (b.part_category ? h('div', { class: 'part-cell' }, h('span', { text: b.part_category }),
          h('span', { class: 'small muted', text: [b.oe_number || b.universal_spec, b.price_rwf ? fmtRwf(b.price_rwf) : null].filter(Boolean).join(' · ') })) : 'Repair only') },
        { label: 'Shop', render: (b) => (b.shop_name ? h('div', { class: 'part-cell' }, h('span', { text: b.shop_name }), h('span', { class: 'small muted', text: SHOP_SIDE[b.shop_status] || b.shop_status })) : '') },
        { label: 'Garage', render: (b) => (b.garage_name ? h('div', { class: 'part-cell' }, h('span', { text: b.garage_name }),
          h('span', { class: 'small muted', text: b.garage_status === 'accepted' && b.garage_time ? `Booked ${b.garage_time}` : GARAGE_SIDE[b.garage_status] || b.garage_status })) : '') },
        { label: 'Status', render: (b) => h('div', { class: 'part-cell' }, pill(...STAGE[b.stage]), b.admin_note ? h('span', { class: 'small muted', text: `vinzuu: ${b.admin_note}` }) : null) },
        { label: '', render: (b) => (b.stage === 'open' ? h('button', { class: 'btn btn-quiet btn-small', type: 'button', text: 'Cancel', onclick: () => askReason('Cancel this booking',
          'For example: the customer called to cancel, or the shop sold the part.',
          async (reason) => { await call(`/api/admin/bookings/${b.id}/cancel`, { method: 'POST', body: { reason } }); reload(); },
          { action: 'Cancel booking', intro: `${b.part_category || 'Repair'} for a ${b.year} ${b.make} ${b.model}. The customer, the shop and the garage all see your reason.` }) }) : null) },
      ], bookings));
    }
    const later = () => { clearTimeout(timer); timer = setTimeout(reload, 250); };
    [shopSel, garageSel, from, to].forEach((el) => el.addEventListener('change', reload));
    search.addEventListener('input', later);
    await reload();
    return h('div', {},
      h('h2', { text: 'Bookings' }),
      h('div', { class: 'filter-bar' },
        segFilter([['open', 'Open'], ['finished', 'Finished'], ['cancelled', 'Cancelled'], ['', 'All']], q.stage, (k) => { q.stage = k; reload(); }),
        search, shopSel, garageSel,
        h('label', { class: 'date-range' }, 'From ', from), h('label', { class: 'date-range' }, 'to ', to),
        csvLink('bookings')),
      count, mount);
  }

  // ---------------------------------------------------------------- admin log

  async function renderLog() {
    const typeSel = select('log-type', [['', 'Everything'], ['application', 'Applications'], ['part', 'Parts'], ['part_request', 'Part requests'],
      ['shop', 'Shops'], ['garage', 'Garages'], ['user', 'Accounts'], ['booking', 'Bookings'], ['report', 'Reports'], ['review', 'Reviews'],
      ['part_number', 'Part numbers'], ['car', 'Cars'], ['export', 'Downloads']], { 'aria-label': 'Show' });
    const mount = h('div', {});
    async function reload() {
      const { log } = await call(`/api/admin/log?type=${enc(typeSel.value)}`);
      mount.replaceChildren(dataTable([
        { label: 'When', render: (l) => h('span', { class: 'nowrap', text: when(l.created_at) }) },
        { label: 'Admin', key: 'admin_email' },
        { label: 'Did', render: (l) => h('strong', { text: l.action }) },
        { label: 'Details', render: (l) => l.detail || '' },
      ], log));
    }
    typeSel.addEventListener('change', reload);
    await reload();
    return h('div', {},
      h('h2', { text: 'What admins changed' }),
      h('p', { class: 'muted', text: 'Every approval, rejection, edit, suspension, block, cancellation and download, newest first. Nobody can edit this list.' }),
      h('div', { class: 'field filter-field' }, typeSel), mount);
  }
})();
