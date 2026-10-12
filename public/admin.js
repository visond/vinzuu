/* Admin console. Manage the fitment reference (the core data asset), onboard shops, and see what
   customers searched for that we could not answer. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'kpf.admintoken';

  let token = store.get(TOKEN_KEY, 'sessionStorage');
  let meta = null;
  let categories = [];
  let prefill = null;      // set when jumping from the "missing parts" report to the add form
  let editing = null;      // fitment row being edited

  const call = (path, opts = {}) => api(path, { ...opts, headers: { 'x-admin-token': token } });

  const TABS = [
    ['overview', 'Overview', renderOverview],
    ['fitment', 'Part numbers', renderFitment],
    ['gaps', 'Missing parts', renderGaps],
    ['shops', 'Shops', renderShops],
    ['garages', 'Garages', renderGarages],
    ['cars', 'Cars', renderCars],
    ['bookings', 'Bookings', renderBookings],
  ];

  init();

  async function init() {
    $('login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const value = $('token').value;
      if (!value) return setStatus($('login-status'), 'Enter the admin token.', 'error');
      login(value);
    });
    $('sign-out').addEventListener('click', () => { store.remove(TOKEN_KEY, 'sessionStorage'); location.reload(); });
    try { meta = await api('/api/meta'); $('demo-banner').hidden = !meta.demo; } catch (err) { /* optional */ }
    if (token) await login(token, true);
  }

  async function login(value, quiet) {
    token = value;
    setStatus($('login-status'), quiet ? '' : 'Checking…');
    try {
      await call('/api/admin/stats');
      store.set(TOKEN_KEY, token, 'sessionStorage');
      categories = (await api('/api/catalog')).categories;
      $('login').hidden = true;
      $('console').hidden = false;
      $('tabs').replaceChildren(...TABS.map(([key, label]) => h('button', {
        type: 'button', role: 'tab', id: `tab-${key}`, text: label, onclick: () => showTab(key),
      })));
      showTab('overview');
    } catch (err) {
      token = null;
      store.remove(TOKEN_KEY, 'sessionStorage');
      setStatus($('login-status'), err.status === 401 ? 'That token is not right.' : err.message, 'error');
    }
  }

  async function showTab(key) {
    for (const [k] of TABS) $(`tab-${k}`).setAttribute('aria-selected', String(k === key));
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
      h('div', { class: 'stat-grid' },
        stat(s.vehicles, ['registered car', 'registered cars']), stat(s.fitment_rows, ['part number row', 'part number rows']),
        stat(s.live_listings, ['part in stock', 'parts in stock']), stat(s.shops, ['shop', 'shops']), stat(s.garages, ['garage', 'garages']),
        stat(s.bookings, ['booking request', 'booking requests']), stat(s.open_gaps, ['missing-part search', 'missing-part searches'])),
      meta && meta.demo ? h('p', { class: 'note-box', text: 'These numbers include demo cars and shops. Do not quote them in your thesis until you have cleared the demo data.' }) : null,
      h('p', { class: 'muted', text: 'The tables below are real data about the cars your users register. When you have enough real registrations, they can support your thesis (always state how many cars they are based on).' }),
      h('div', { class: 'row' }, tally('Cars by make', s.vehicles_by_make), tally('Cars by where they were built', s.vehicles_by_origin_market)),
      tally('Cars by where they were imported from (as the owner told us)', s.vehicles_by_import_source));
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
        setStatus(status, `Shop added. Give them this access code: ${shop.access_code}`, 'ok');
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
      { label: 'Access code', key: 'access_code' },
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
