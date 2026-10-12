/* Customer page: VIN -> car -> part -> shops -> book a garage. Uses helpers from common.js.
   VIN is the only identifier that ever finds or unlocks a car here. A plate can still be shown
   as a label once a car is found (and is stored for the car's own record), but typing a plate
   never looks anything up. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const VEHICLE_ID_KEY = 'kpf.vehicle_id';

  const state = {
    meta: null,
    catalog: null,
    vehicle: null,
    category: null,
    query: null,        // { oe: [..] } or { category: 'Wiper Blade' }
    searchInfo: null,   // response from /api/parts/search
    coords: null,       // { lat, lon } once the customer shares their location
    sort: 'price',
    radius: '15',
    listings: [],
    locationNote: '',
  };

  init();

  // ---------------------------------------------------------------- start-up

  async function init() {
    try {
      [state.meta, state.catalog] = await Promise.all([api('/api/meta'), api('/api/catalog')]);
    } catch (err) {
      setStatus($('vin-status'), err.message, 'error');
      return;
    }
    $('demo-banner').hidden = !state.meta.demo;
    state.radius = String(state.meta.default_radius_km);

    $('vin').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/\s/g, ''); });
    $('vin-form').addEventListener('submit', onVinSubmit);
    $('part-q').addEventListener('input', renderPartList);

    // A VIN in the URL (from the homepage's quick-search box) wins over a remembered car,
    // since typing a different VIN there is a deliberate new search.
    const fromUrl = new URLSearchParams(location.search).get('vin');
    if (fromUrl) {
      history.replaceState(null, '', location.pathname); // tidy the URL, keep the lookup
      const vin = normalizeVin(fromUrl);
      $('vin').value = vin;
      await lookupVin(vin);
    } else {
      const storedId = store.get(VEHICLE_ID_KEY);
      if (storedId) await lookupById(storedId);
    }
    loadAccount();
  }

  // ---------------------------------------------------------------- account state

  async function loadAccount() {
    const slot = $('account-slot');
    try {
      const { user } = await api('/api/auth/me');
      if (!user) { slot.replaceChildren(h('a', { class: 'nav-link', href: '/', text: 'Sign in' })); return; }
      slot.replaceChildren(
        h('span', { class: 'small muted', text: user.name }), ' ',
        h('button', {
          class: 'btn-quiet', type: 'button', text: 'Sign out',
          onclick: async () => { try { await api('/api/auth/logout', { method: 'POST' }); } finally { location.href = '/'; } },
        }));
      loadMyCars();
    } catch (err) { /* not signed in, or offline: the page still works without this */ }
  }

  async function loadMyCars() {
    try {
      const { vehicles } = await api('/api/me/vehicles');
      document.querySelector('.my-cars')?.remove();
      if (!vehicles.length || state.vehicle) return; // don't clutter the screen once a car is already chosen
      // These came straight from the signed-in account, so there is no need to search again --
      // the plate shown here is just a label, same as everywhere else.
      const row = h('div', { class: 'my-cars' }, ...vehicles.map((v) => h('button', {
        class: 'plate plate-sm', type: 'button', onclick: () => setVehicle(v),
      },
        h('span', { class: 'plate-strip', 'aria-hidden': 'true' }, 'RW'),
        h('span', { class: 'plate-text', text: formatPlate(v.plate_number) }))));
      $('start').insertBefore(row, $('vin-form'));
    } catch (err) { /* offline, or nothing saved yet */ }
  }

  const normalizeVin = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const validVin = (v) => /^[A-HJ-NPR-Z0-9]{17}$/.test(v); // I, O, Q are never used in a real VIN
  const normalizePlate = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const validPlate = (p) => /^[A-Z0-9]{4,10}$/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p);

  function hideSections() {
    $('register').hidden = true;
    $('vehicle').hidden = true;
    $('results').hidden = true;
  }

  // ---------------------------------------------------------------- VIN -> car

  function onVinSubmit(event) {
    event.preventDefault();
    const vin = normalizeVin($('vin').value);
    if (!validVin(vin)) {
      setStatus($('vin-status'), 'Enter the full 17-character VIN. The letters I, O and Q are never used.', 'error');
      $('vin').focus();
      return;
    }
    lookupVin(vin);
  }

  async function lookupVin(vin) {
    const button = $('vin-go');
    button.disabled = true;
    setStatus($('vin-status'), 'Looking for your car…');
    try {
      const { vehicle } = await api(`/api/vehicles/by-vin/${enc(vin)}`);
      setStatus($('vin-status'), '');
      setVehicle(vehicle);
    } catch (err) {
      if (err.code === 'not_registered') {
        setStatus($('vin-status'), '');
        showRegister(vin);
      } else {
        setStatus($('vin-status'), err.message, 'error');
      }
    } finally {
      button.disabled = false;
    }
  }

  /** Re-opens a car remembered from a previous visit, by its id -- never by VIN (the server
   *  never sends a full VIN back to the browser, so there is nothing to remember it by) and
   *  never by plate (a plate can move to a different car). If the id no longer resolves, this
   *  quietly falls back to the empty search screen instead of showing an error. */
  async function lookupById(id) {
    try {
      const { vehicle } = await api(`/api/vehicles/id/${enc(id)}`);
      setVehicle(vehicle);
    } catch (err) {
      store.remove(VEHICLE_ID_KEY);
    }
  }

  function vehicleTitle(v) { return `${v.year} ${v.make} ${v.model}`; }

  function vehicleDetails(v) {
    return [
      v.engine,
      v.transmission ? v.transmission.toLowerCase() : null,
      v.origin_market ? `built in ${v.origin_market}` : 'build location not known',
    ].filter(Boolean).join(', ');
  }

  function platePill(text) {
    return h('span', { class: 'plate plate-sm' },
      h('span', { class: 'plate-strip', 'aria-hidden': 'true' }, 'RW'),
      h('span', { class: 'plate-text' }, text));
  }

  function setVehicle(vehicle) {
    state.vehicle = vehicle;
    state.category = null;
    state.query = null;
    store.set(VEHICLE_ID_KEY, String(vehicle.id));
    hideSections();
    $('start').hidden = true;
    $('vehicle').hidden = false;
    $('part-q').value = '';
    $('vehicle-bar').replaceChildren(
      h('div', { class: 'vehicle-bar' },
        platePill(formatPlate(vehicle.plate_number)),
        h('div', { class: 'vehicle-text' },
          h('strong', { text: vehicleTitle(vehicle) }),
          h('span', { text: vehicleDetails(vehicle) })),
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: changeCar, text: 'Change car' })));
    renderPartList();
  }

  function changeCar() {
    store.remove(VEHICLE_ID_KEY);
    state.vehicle = null;
    hideSections();
    $('start').hidden = false;
    $('vin').value = '';
    $('vin').focus();
    loadMyCars();
  }

  // ---------------------------------------------------------------- register a new car

  function fillSelect(select, items, placeholder) {
    select.replaceChildren(h('option', { value: '', text: placeholder }),
      ...items.map((it) => h('option', { value: it.value, text: it.text })));
  }

  function field(labelText, control, hint) {
    const id = control.id;
    return h('div', { class: 'field' },
      h('label', { for: id, text: labelText }), control, hint ? h('p', { class: 'hint', text: hint }) : null);
  }

  function showRegister(vin) {
    hideSections();
    const makes = state.catalog.makes;
    const mount = $('register');
    const f = {};

    f.plate = h('input', { id: 'r-plate', type: 'text', maxLength: 12, autocomplete: 'off', autocapitalize: 'characters', placeholder: 'RAE 123 A' });
    f.make = h('select', { id: 'r-make' });
    fillSelect(f.make, [...makes.map((m) => ({ value: m.make, text: m.make })), { value: '__other', text: 'Other make' }], 'Choose the make');
    f.makeOther = h('input', { id: 'r-make-other', type: 'text', placeholder: 'Type the make', hidden: true, 'aria-label': 'Make' });
    f.model = h('select', { id: 'r-model', hidden: true });
    f.modelOther = h('input', { id: 'r-model-other', type: 'text', placeholder: 'Type the model', hidden: true, 'aria-label': 'Model' });
    f.year = h('input', { id: 'r-year', type: 'number', inputMode: 'numeric', min: 1980, max: new Date().getFullYear() + 1, placeholder: 'For example 2018' });
    f.generation = h('select', { id: 'r-generation' });
    f.engineSelect = h('select', { id: 'r-engine' });
    f.engineText = h('input', { id: 'r-engine-text', type: 'text', placeholder: 'For example 2.0L Petrol', hidden: true, 'aria-label': 'Engine' });
    f.transmission = h('select', { id: 'r-trans' });
    fillSelect(f.transmission, [{ value: 'Automatic', text: 'Automatic' }, { value: 'Manual', text: 'Manual' }], 'Not sure');
    f.origin = h('select', { id: 'r-origin' });
    fillSelect(f.origin, state.meta.origins.map((o) => ({ value: o, text: o })), 'Not sure');
    f.importSource = h('select', { id: 'r-import' });
    fillSelect(f.importSource, state.meta.import_sources.map((o) => ({ value: o, text: o })), 'Choose one');
    f.status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });

    const wrapGeneration = field('Generation (optional)', f.generation, 'If you do not know it, leave it as "Not sure".');
    const wrapEngine = h('div', { class: 'field', hidden: true }, h('label', { for: 'r-engine', text: 'Engine' }), f.engineSelect, f.engineText);
    const wrapModel = h('div', { class: 'field', hidden: true }, h('label', { for: 'r-model', text: 'Model' }), f.model, f.modelOther);

    const currentMake = () => makes.find((m) => m.make === f.make.value);
    const currentModel = () => { const m = currentMake(); return m && m.models.find((x) => x.model === f.model.value); };

    function syncModel() {
      const model = currentModel();
      const custom = f.make.value === '__other' || f.model.value === '__other';
      f.modelOther.hidden = !custom;
      wrapEngine.hidden = !(f.make.value === '__other' || f.model.value);
      const gens = model ? model.generations : [];
      wrapGeneration.hidden = gens.length === 0;
      fillSelect(f.generation, gens.map((g) => ({ value: g.generation, text: `${g.generation} (${g.year_start} to ${g.year_end})` })), 'Not sure');
      const engines = model ? model.engines : [];
      f.engineSelect.hidden = engines.length === 0;
      f.engineText.hidden = engines.length !== 0;
      fillSelect(f.engineSelect, engines.map((e) => ({ value: e, text: e })), 'Not sure');
      syncGenerationToYear(f.generation, gens, f.year.value);
      pickOnlyChoice(f.engineSelect);
    }
    function syncMake() {
      const make = currentMake();
      f.makeOther.hidden = f.make.value !== '__other';
      wrapModel.hidden = !f.make.value;
      f.model.hidden = !make;
      if (make) fillSelect(f.model, [...make.models.map((m) => ({ value: m.model, text: m.model })), { value: '__other', text: 'Other model' }], 'Choose the model');
      syncModel();
    }
    f.make.addEventListener('change', syncMake);
    f.model.addEventListener('change', syncModel);
    f.year.addEventListener('input', () => {
      const model = currentModel();
      syncGenerationToYear(f.generation, model ? model.generations : [], f.year.value);
    });
    f.generation.addEventListener('change', () => { f.generation.dataset.auto = ''; });
    syncMake();
    prefillFromVin(vin, f, syncMake);

    f.plate.addEventListener('input', () => { f.plate.value = f.plate.value.toUpperCase(); });
    f.plate.addEventListener('blur', () => { f.plate.value = formatPlate(f.plate.value); });

    const form = h('form', { class: 'panel', novalidate: true, onsubmit: onSubmit },
      h('h2', { id: 'register-title', text: 'We do not know this VIN yet' }),
      h('p', { class: 'muted', text: `Tell us about this car once. Next time, VIN ${vin} is all you need.` }),
      h('div', { class: 'field' }, h('label', { text: 'VIN' }), h('p', { class: 'vin-locked', text: vin })),
      field('Plate number', f.plate, 'Shown as a label on your car once saved. It is not used to search.'),
      h('div', { class: 'field' }, h('label', { for: 'r-make', text: 'Make' }), f.make, f.makeOther),
      wrapModel,
      field('Year', f.year),
      wrapGeneration,
      wrapEngine,
      field('Transmission', f.transmission),
      field('Where was it built?', f.origin, 'This matters. The same model built in Korea and in the USA can need different parts.'),
      field('Where was it imported from?', f.importSource),
      f.status,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn btn-primary', type: 'submit', text: 'Save my car' }),
        h('button', { class: 'btn btn-quiet', type: 'button', text: 'Cancel', onclick: () => { mount.hidden = true; $('vin').focus(); } })));

    async function onSubmit(event) {
      event.preventDefault();
      const plate = normalizePlate(f.plate.value);
      if (!validPlate(plate)) return setStatus(f.status, 'Enter the plate as shown on your car, for example RAE 123 A.', 'error');
      const make = f.make.value === '__other' ? f.makeOther.value.trim() : f.make.value;
      const model = (f.make.value === '__other' || f.model.value === '__other') ? f.modelOther.value.trim() : f.model.value;
      if (!make || !model) return setStatus(f.status, 'Choose the make and the model.', 'error');
      if (!f.year.value) return setStatus(f.status, 'Enter the year the car was made.', 'error');
      setStatus(f.status, 'Saving…');
      try {
        const res = await api('/api/vehicles/register', {
          method: 'POST',
          body: {
            plate_number: plate, vin, make, model, year: Number(f.year.value),
            generation: f.generation.value || null,
            engine: (f.engineSelect.hidden ? f.engineText.value : f.engineSelect.value) || null,
            transmission: f.transmission.value || null, origin_market: f.origin.value || null,
            import_source: f.importSource.value || null,
          },
        });
        mount.hidden = true;
        setVehicle(res.vehicle);
        if (res.warnings && res.warnings.length) setStatus($('results-status'), res.warnings.join(' '));
      } catch (err) {
        setStatus(f.status, err.message, 'error');
      }
    }

    mount.replaceChildren(form);
    mount.hidden = false;
    mount.scrollIntoView({ behavior: motion(), block: 'start' });
    f.plate.focus({ preventScroll: true });
  }

  const motion = () => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

  // ---------------------------------------------------------------- pick a part

  function renderPartList() {
    if (!state.catalog) return;
    const terms = $('part-q').value.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
    let cats = state.catalog.categories.map((c) => {
      const hay = `${c.name} ${c.keywords}`.toLowerCase();
      const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
      return { c, score };
    });
    if (terms.length) cats = cats.filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    const list = $('part-list');
    if (!cats.length) {
      list.replaceChildren(h('li', { class: 'muted', text: 'No part matches that. Try a simpler word, like "brake" or "oil".' }));
      return;
    }
    list.replaceChildren(...cats.map(({ c }) => h('li', {},
      h('button', {
        class: 'part-btn', type: 'button', 'aria-pressed': String(state.category === c.name),
        onclick: () => pickCategory(c), text: c.name,
      }))));
  }

  async function pickCategory(cat) {
    state.category = cat.name;
    renderPartList();
    await runSearch();
  }

  async function runSearch() {
    const results = $('results');
    results.hidden = false;
    results.replaceChildren(h('p', { class: 'muted', text: 'Searching…' }));
    try {
      const s = await api(`/api/parts/search?vehicle_id=${enc(state.vehicle.id)}&part_category=${enc(state.category)}`);
      state.searchInfo = s;
      if (s.type === 'universal') state.query = { category: state.category };
      else if (s.oe_numbers.length) state.query = { oe: s.oe_numbers.map((o) => o.oe_number) };
      else { state.query = null; state.listings = []; return renderNoMatch(s); }
      await loadListings();
    } catch (err) {
      results.replaceChildren(h('p', { class: 'status error', text: err.message }));
    }
  }

  async function loadListings() {
    const q = new URLSearchParams();
    if (state.query.oe) { q.set('oe_numbers', state.query.oe.join(',')); q.set('vehicle_id', state.vehicle.id); }
    else q.set('part_category', state.query.category);
    if (state.coords) { q.set('lat', state.coords.lat); q.set('lon', state.coords.lon); }
    q.set('radius_km', state.radius);
    q.set('sort', state.sort);
    const data = await api(`/api/parts/listings?${q}`);
    state.listings = data.listings;
    renderResults();
  }

  function renderNoMatch(s) {
    const box = [
      h('h2', { id: 'results-title', tabindex: -1, text: state.category }),
      h('p', { class: 'empty', text: s.message || 'We could not find this part for your car yet.' }),
    ];
    if (s.reason === 'origin_unknown') {
      const sel = h('select', { id: 'fix-origin', 'aria-label': 'Where was your car built?' });
      fillSelect(sel, state.meta.origins.map((o) => ({ value: o, text: o })), 'Where was your car built?');
      const status = h('p', { class: 'status', role: 'status' });
      box.push(h('div', { class: 'field' }, sel), h('button', {
        class: 'btn btn-primary', type: 'button', text: 'Save and search again',
        onclick: async () => {
          if (!sel.value) return setStatus(status, 'Choose a country first.', 'error');
          try {
            const res = await api(`/api/vehicles/id/${enc(state.vehicle.id)}`, { method: 'PATCH', body: { origin_market: sel.value } });
            state.vehicle = res.vehicle;
            setVehicle(res.vehicle);
            state.category = s.part_category;
            renderPartList();
            await runSearch();
          } catch (err) { setStatus(status, err.message, 'error'); }
        },
      }), status);
    }
    if (s.reason === 'generation_unknown') {
      const v = state.vehicle;
      const make = state.catalog.makes.find((m) => m.make.toLowerCase() === v.make.toLowerCase());
      const model = make && make.models.find((m) => m.model.toLowerCase() === v.model.toLowerCase());
      const gens = (model ? model.generations : []).filter((g) => v.year >= g.year_start && v.year <= g.year_end);
      const sel = h('select', { id: 'fix-generation', 'aria-label': 'Which generation is your car?' });
      fillSelect(sel, gens.map((g) => ({ value: g.generation, text: `${g.generation} (${g.year_start} to ${g.year_end})` })), 'Which generation is it?');
      const status = h('p', { class: 'status', role: 'status' });
      box.push(h('div', { class: 'field' }, sel), h('button', {
        class: 'btn btn-primary', type: 'button', text: 'Save and search again',
        onclick: async () => {
          if (!sel.value) return setStatus(status, 'Choose a generation first.', 'error');
          try {
            const res = await api(`/api/vehicles/id/${enc(v.id)}`, { method: 'PATCH', body: { generation: sel.value } });
            setVehicle(res.vehicle);
            state.category = s.part_category;
            renderPartList();
            await runSearch();
          } catch (err) { setStatus(status, err.message, 'error'); }
        },
      }), status);
    }
    $('results').replaceChildren(...box);
    $('results-status').textContent = s.message || '';
    focusResults();
  }

  // ---------------------------------------------------------------- results

  function focusResults() {
    const r = $('results');
    r.scrollIntoView({ behavior: motion(), block: 'start' });
  }

  function whatBadgesMean() {
    return h('details', { class: 'how-badges' },
      h('summary', { text: 'What do the labels mean?' }),
      ...['verified_genuine', 'verified_compatible', 'unverified'].map((key) => {
        const badge = { verified_genuine: ['Verified Genuine', "The part number matches the manufacturer's record for your car, and we have vetted this shop."],
          verified_compatible: ['Verified Compatible', "Our records show this fits your car. It may not be the manufacturer's own part."],
          unverified: ['Unverified, use with caution', 'We could not confirm this fits your car. Ask the shop to check before you buy.'] }[key];
        return h('div', {}, badgeEl({ key, label: badge[0] }), h('p', { class: 'small', text: badge[1] }));
      }));
  }

  function renderResults() {
    const v = state.vehicle;
    const parts = [];
    parts.push(h('h2', { id: 'results-title', tabindex: -1, text: state.category }));
    parts.push(h('p', { class: 'muted', text: `For your ${vehicleTitle(v)}` }));

    if (state.searchInfo && state.searchInfo.match_type === 'relaxed') {
      parts.push(h('div', { class: 'note-box', role: 'note',
        text: 'We could not confirm the exact part for your engine. These are close matches, so ask the shop to check before you buy.' }));
    }

    // sort + distance controls
    const sortBtn = (value, label) => h('button', {
      type: 'button', 'aria-pressed': String(state.sort === value), text: label,
      onclick: () => { state.sort = value; loadListings(); },
    });
    const radius = h('select', { id: 'radius', 'aria-label': 'Distance', onchange: (e) => { state.radius = e.target.value; loadListings(); } },
      ...[['5', 'Within 5 km'], ['15', 'Within 15 km'], ['30', 'Within 30 km'], ['any', 'Any distance']]
        .map(([value, text]) => h('option', { value, text, selected: state.radius === value })));
    parts.push(h('div', { class: 'controls' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Sort by' }, sortBtn('price', 'Lowest price'), sortBtn('distance', 'Nearest')),
      radius));

    const where = state.coords ? 'Distances are measured from your location.' : 'Distances are measured from central Kigali.';
    const locBtn = !state.coords && navigator.geolocation
      ? h('button', { class: 'btn btn-quiet flush', type: 'button', text: 'Use my location', onclick: useMyLocation }) : null;
    parts.push(h('p', { class: 'small muted' }, where, ' ', locBtn));
    if (state.locationNote) parts.push(h('p', { class: 'small', text: state.locationNote }));

    if (state.searchInfo && state.searchInfo.type !== 'universal') parts.push(whatBadgesMean());

    if (!state.listings.length) {
      parts.push(h('div', { class: 'empty' },
        h('p', { text: state.radius === 'any'
          ? 'No shop we know has this in stock right now. Check again soon, or call a garage to source it.'
          : `No shop within ${state.radius} km has this in stock.` }),
        state.radius !== 'any'
          ? h('button', { class: 'btn btn-secondary', type: 'button', text: 'Search any distance', onclick: () => { state.radius = 'any'; loadListings(); } })
          : null));
    } else {
      parts.push(h('ul', { class: 'results' }, ...state.listings.map(resultRow)));
    }

    $('results').hidden = false;
    $('results').replaceChildren(...parts);
    const n = state.listings.length;
    $('results-status').textContent = n ? `${n} ${n === 1 ? 'shop has' : 'shops have'} this in stock.` : 'No shops found.';
    focusResults();
  }

  function shopMessage(l) {
    const v = state.vehicle;
    const what = `${l.part_category}${l.oe_number ? ` (${l.oe_number})` : l.universal_spec ? ` (${l.universal_spec})` : ''}`;
    return `Hello, I saw ${what} for ${fmtRwf(l.price_rwf)} on ${state.meta.app_name}. Is it still in stock? My car: ${vehicleTitle(v)}, plate ${v.plate_number}.`;
  }

  function resultRow(l) {
    const detail = l.oe_number ? `Part number ${l.oe_number}` : `Size: ${l.universal_spec}`;
    const wa = whatsappLink(l.shop_whatsapp || l.shop_phone, shopMessage(l));
    return h('li', { class: 'result' },
      h('img', { class: 'photo', src: l.photo_url, alt: `${l.part_category} at ${l.shop_name}`, loading: 'lazy', width: 88, height: 88 }),
      h('div', {}, h('div', { class: 'shop', text: l.shop_name }), h('div', { class: 'small muted', text: l.shop_address || '' })),
      h('div', { class: 'price' }, rwf.format(l.price_rwf), ' ', h('small', { text: 'RWF' })),
      h('div', { class: 'meta', text: `${l.distance_km} km away, ${l.condition === 'genuine' ? 'genuine part' : 'aftermarket part'}, ${l.in_stock} in stock` }),
      h('div', { class: 'meta', text: detail }),
      h('div', { class: 'badge-row' }, badgeEl(l.badge)),
      h('div', { class: 'actions' },
        wa ? h('a', { class: 'btn btn-secondary btn-small', href: wa, target: '_blank', rel: 'noopener', text: 'WhatsApp the shop' }) : null,
        h('a', { class: 'btn btn-secondary btn-small', href: `tel:${l.shop_phone}`, text: 'Call' }),
        h('button', { class: 'btn btn-primary btn-small', type: 'button', text: 'Book installation', onclick: () => openBooking(l) })));
  }

  function useMyLocation() {
    state.locationNote = 'Finding your location…';
    renderResults();
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.coords = { lat: Number(pos.coords.latitude.toFixed(4)), lon: Number(pos.coords.longitude.toFixed(4)) };
        state.locationNote = '';
        loadListings();
      },
      () => {
        state.locationNote = 'We could not get your location, so distances stay measured from central Kigali.';
        renderResults();
      },
      { timeout: 8000, maximumAge: 600000 });
  }

  // ---------------------------------------------------------------- book a garage

  function showDialog(dlg) {
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
  }
  function closeDialog(dlg) {
    if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
  }

  async function openBooking(listing) {
    const dlg = $('booking-dialog');
    dlg.replaceChildren(h('div', { class: 'dialog-body' }, h('h2', { id: 'booking-title', text: 'Book installation' }), h('p', { class: 'muted', text: 'Finding garages near you…' })));
    showDialog(dlg);

    let garages = [];
    try {
      const q = new URLSearchParams({ radius_km: 'any' });
      if (state.coords) { q.set('lat', state.coords.lat); q.set('lon', state.coords.lon); }
      garages = (await api(`/api/garages/nearby?${q}`)).garages;
    } catch (err) { /* handled below */ }

    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const phoneInput = h('input', { id: 'b-phone', type: 'tel', inputMode: 'tel', autocomplete: 'tel', placeholder: '+250 788 123 456' });
    const note = h('textarea', { id: 'b-note', maxLength: 300, placeholder: 'For example: I can come after 5pm' });

    const garageChoices = garages.map((g, i) => h('label', { class: 'garage-option' },
      h('input', { type: 'radio', name: 'garage', value: String(g.id), checked: i === 0 }),
      h('span', {}, h('strong', { text: g.name }), h('span', { class: 'small muted sub', text: `${g.distance_km} km away. ${g.specialties || ''}` }))));

    const form = h('form', { novalidate: true, onsubmit: async (event) => {
      event.preventDefault();
      const chosen = dlg.querySelector('input[name="garage"]:checked');
      if (!chosen) return setStatus(status, 'Choose a garage.', 'error');
      if (!phoneInput.value.trim()) return setStatus(status, 'Enter your phone number so the garage can reach you.', 'error');
      setStatus(status, 'Saving your request…');
      try {
        const res = await api('/api/bookings', { method: 'POST', body: {
          vehicle_id: state.vehicle.id, customer_phone: phoneInput.value,
          shop_listing_id: listing.listing_id, garage_id: Number(chosen.value), note: note.value || null,
        } });
        showBookingDone(dlg, res);
      } catch (err) { setStatus(status, err.message, 'error'); }
    } },
      h('p', { class: 'muted', text: `${listing.part_category} from ${listing.shop_name}, ${fmtRwf(listing.price_rwf)}` }),
      garages.length
        ? h('fieldset', {}, h('legend', { text: 'Choose a garage' }), ...garageChoices)
        : h('p', { class: 'status error', text: 'We could not load garages right now. Close this and try again.' }),
      h('div', { class: 'field' }, h('label', { for: 'b-phone', text: 'Your phone number' }), phoneInput,
        h('p', { class: 'hint', text: 'The garage and the shop will see this number.' })),
      h('div', { class: 'field' }, h('label', { for: 'b-note', text: 'Note (optional)' }), note),
      status,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn btn-primary', type: 'submit', text: 'Send request', disabled: !garages.length }),
        h('button', { class: 'btn btn-quiet', type: 'button', text: 'Cancel', onclick: () => closeDialog(dlg) })));

    dlg.replaceChildren(h('div', { class: 'dialog-body' }, h('h2', { id: 'booking-title', text: 'Book installation' }), form));
    phoneInput.focus();
  }

  function showBookingDone(dlg, res) {
    dlg.replaceChildren(h('div', { class: 'dialog-body' },
      h('h2', { id: 'booking-title', text: 'Request saved' }),
      h('p', { text: 'Now send it on WhatsApp so the garage sees it straight away. Nothing is sent until you tap the button.' }),
      h('div', { class: 'dialog-actions' },
        res.whatsapp.garage ? h('a', { class: 'btn btn-primary', href: res.whatsapp.garage, target: '_blank', rel: 'noopener', text: 'Message the garage' }) : null,
        res.whatsapp.shop ? h('a', { class: 'btn btn-secondary', href: res.whatsapp.shop, target: '_blank', rel: 'noopener', text: 'Message the shop' }) : null,
        h('button', { class: 'btn btn-quiet', type: 'button', text: 'Close', onclick: () => closeDialog(dlg) }))));
  }
})();
