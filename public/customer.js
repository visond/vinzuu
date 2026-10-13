/* Customer page, laid out like a parts site's "my garage":
     1. Vehicle inquiry: the VIN is all we ask for.
     2. "Is this your car?" when the VIN told us the exact build, or pick the details when not.
     3. Basic information and mileage, once, for a newly added car.
     4. My garage: purchase parts (-> shops -> book a garage), inspection items, repair shops.
   The VIN is the only thing a customer types or sees to identify a car. Uses common.js. */
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
    wantedPart: null,   // a category picked on the homepage before the car was known
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
    if (state.meta.demo_vin) {
      // Demo data only: fills in a demo car's VIN and looks it up, so there is something to try.
      $('demo-try').hidden = false;
      $('demo-try-btn').addEventListener('click', () => { $('vin').value = state.meta.demo_vin; lookupVin(state.meta.demo_vin); });
    }
    state.radius = String(state.meta.default_radius_km);

    $('vin').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/\s/g, ''); });
    $('vin-form').addEventListener('submit', onVinSubmit);
    $('part-q').addEventListener('input', () => { if ($('part-q').value) showAllParts(true); renderPartList(); });
    $('all-parts').addEventListener('click', () => showAllParts($('all-parts').getAttribute('aria-expanded') !== 'true'));
    document.querySelectorAll('.strip-arrow').forEach((b) => b.addEventListener('click', () => {
      const list = $('part-list');
      list.scrollBy({ left: Number(b.dataset.dir) * list.clientWidth * 0.8, behavior: motion() });
    }));

    // A VIN in the URL (from the homepage's quick-search box) wins over a remembered car,
    // since typing a different VIN there is a deliberate new search. A part in the URL (a
    // homepage "Shop now" button) is opened as soon as a car is known.
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('vin');
    state.wantedPart = state.catalog.categories.find((c) => c.name === params.get('part')) || null;
    if (fromUrl || params.has('part')) history.replaceState(null, '', location.pathname); // tidy the URL, keep the lookup
    if (state.wantedPart && !fromUrl && !store.get(VEHICLE_ID_KEY)) {
      setStatus($('vin-status'), `Enter your VIN and we'll show the ${state.wantedPart.name.toLowerCase()} that fits your car.`);
    }
    if (fromUrl) {
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
    try {
      const { user } = await api('/api/auth/me');
      if (user) loadMyCars();
    } catch (err) { /* not signed in, or offline: the page still works without this */ }
  }

  async function loadMyCars() {
    try {
      const { vehicles } = await api('/api/me/vehicles');
      document.querySelector('.my-cars')?.remove();
      if (!vehicles.length || state.vehicle) return; // don't clutter the screen once a car is already chosen
      // These came straight from the signed-in account, so there is no need to search again.
      // Each is shown by its make's logo, model and the end of its VIN, never by plate.
      const row = h('div', { class: 'my-cars' },
        h('p', { class: 'hint', text: 'Your cars' }),
        ...vehicles.map((v) => h('button', { class: 'btn btn-secondary my-car', type: 'button', onclick: () => setVehicle(v) },
          makeLogo(v.make), h('span', { text: vehicleTitle(v) }),
          v.vin_masked ? h('span', { class: 'small muted', text: `VIN …${v.vin_masked.slice(-2)}` }) : null)));
      $('start').insertBefore(row, $('vin-form'));
    } catch (err) { /* offline, or nothing saved yet */ }
  }

  const normalizeVin = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const validVin = (v) => /^[A-HJ-NPR-Z0-9]{17}$/.test(v); // I, O, Q are never used in a real VIN

  function hideSections() {
    for (const id of ['confirm', 'register', 'basic', 'vehicle', 'results']) $(id).hidden = true;
  }

  /** Shows one step of the flow and brings it to the top of the screen. */
  function showStep(id) {
    hideSections();
    $('start').hidden = id !== 'start';
    $(id).hidden = false;
    window.scrollTo({ top: 0, behavior: 'auto' });
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
        setStatus($('vin-status'), 'Reading your VIN…');
        const d = await decodeVin(vin);
        setStatus($('vin-status'), '');
        if (d && d.car && findModelIn(d.car.make, d.car.model)) showConfirm(vin, d);
        else showRegister(vin, d);
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

  /** The car's VIN as a small label (masked: the server never sends the full VIN back). */
  function vinPill(v) {
    return h('span', { class: 'vinbox vinbox-sm', title: 'VIN' },
      h('span', { class: 'vinbox-tag', 'aria-hidden': 'true' }, 'VIN'),
      h('span', { class: 'vinbox-text' }, v.vin_masked || 'No VIN saved'));
  }

  function makeLogo(make, cls = 'make-logo') {
    const m = state.catalog.makes.find((x) => x.make.toLowerCase() === String(make).toLowerCase());
    return m && m.logo ? h('img', { class: cls, src: m.logo, alt: '', width: 28, height: 28 }) : null;
  }

  function setVehicle(vehicle) {
    state.vehicle = vehicle;
    state.category = null;
    state.query = null;
    store.set(VEHICLE_ID_KEY, String(vehicle.id));
    showStep('vehicle');
    $('part-q').value = '';
    renderGarageHero();
    showAllParts(false);
    renderPartList();
    renderInspection();
    loadShopsNear();
    if (state.wantedPart) {
      const wanted = state.wantedPart;
      state.wantedPart = null; // only once: picking another car later starts from the list
      pickCategory(wanted);
    }
  }

  function changeCar() {
    store.remove(VEHICLE_ID_KEY);
    state.vehicle = null;
    showStep('start');
    $('start').hidden = false;
    $('vin').value = '';
    $('vin').focus();
    loadMyCars();
  }

  // ---------------------------------------------------------------- the exact car

  const sameText = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  const findMake = (make) => state.catalog.makes.find((m) => sameText(m.make, make)) || null;
  function findModelIn(make, model) {
    const m = findMake(make);
    return (m && m.models.find((x) => sameText(x.model, model))) || null;
  }

  /** Which silhouette to draw for a model's body ("Sedan, hatchback" -> sedan). */
  function bodyShape(v) {
    const model = findModelIn(v.make, v.model);
    const body = String((model && model.body) || v.body || '').toLowerCase();
    if (/pickup|truck/.test(body)) return 'pickup';
    if (/mpv|van|minibus/.test(body)) return 'van';
    if (/suv|crossover|sport utility/.test(body)) return 'suv';
    if (/^hatch/.test(body)) return 'hatch';
    return 'sedan';
  }
  /**
   * The car's picture: a drawn outline of its body type straight away, replaced by a real photo of
   * the model (from Wikipedia, credited as its licence asks) once one has loaded. A photo of a
   * different generation says the car may look different.
   */
  function carArt(v) {
    const fig = h('figure', { class: 'car-figure' },
      h('img', { class: 'car-art', src: `/img/cars/${bodyShape(v)}.svg`, alt: '', width: 242, height: 104 }));
    carPhoto(v).then((p) => {
      if (!p) return;
      const img = new Image();
      img.onload = () => {
        img.className = 'car-photo';
        img.alt = `${v.make} ${v.model}`;
        fig.classList.add('has-photo');
        fig.replaceChildren(img, h('figcaption', {},
          p.exact ? null : 'Yours may look different. ',
          'Photo: ', h('a', { href: p.file_page, target: '_blank', rel: 'noopener', text: p.credit }), `, ${p.license}`));
      };
      img.referrerPolicy = 'no-referrer';
      img.src = p.src; // if it fails to load, the outline simply stays
    });
    return fig;
  }
  const photoCache = new Map();
  function carPhoto(v) {
    const key = [v.make, v.model, v.generation || ''].join('|');
    if (!photoCache.has(key)) {
      const q = new URLSearchParams({ make: v.make, model: v.model });
      if (v.generation) q.set('generation', v.generation);
      photoCache.set(key, api(`/api/car-photo?${q}`).then((r) => r.photo).catch(() => null));
    }
    return photoCache.get(key);
  }

  /** "2.4L Petrol (G4KJ)": the engine with its codes for that generation, when we know them. */
  function engineText(v) {
    if (!v.engine) return null;
    const engines = enginesFor(findModelIn(v.make, v.model), v.generation);
    const e = engines.find((x) => sameText(x.label, v.engine));
    return e && e.codes.length ? `${v.engine} (${e.codes.join(', ')})` : v.engine;
  }
  function generationLabel(v) {
    const model = findModelIn(v.make, v.model);
    const g = model && model.generations.find((x) => sameText(x.generation, v.generation));
    return g ? generationText(g) : v.generation || null;
  }
  const fuelOf = (engine) => {
    const m = String(engine || '').match(/(Plug-in Hybrid|Hybrid|Diesel|LPG|CNG|Petrol|Electric|Hydrogen)/i);
    return m ? m[1] : null;
  };

  /** Step 2: the decoder found the exact build. Same question PartZone asks before going on. */
  function showConfirm(vin, d) {
    const c = d.car;
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const facts = [
      ['Model year', c.year],
      ['Generation', generationLabel(c)],
      ['Engine', engineText(c)],
      ['Transmission', c.transmission],
      ['Built in', c.origin_market],
    ].filter(([, value]) => value);
    const source = c.source === 'vpic'
      ? 'Found in the vehicle makers\' database for this VIN.'
      : `Matched to ${c.matches === 1 ? 'a car' : `${c.matches} cars`} already saved with the same VIN pattern.`;
    const yes = h('button', { class: 'btn btn-primary btn-block', type: 'button', text: 'Yes, that is my car', onclick: onYes });
    $('confirm').replaceChildren(h('div', { class: 'confirm-card' },
      h('div', { class: 'cc-top' },
        h('div', { class: 'cc-text' },
          makeLogo(c.make, 'cc-logo'),
          h('p', { class: 'cc-model', text: `${c.make} ${c.model}` }),
          h('p', { class: 'cc-sub', text: [c.year, c.engine].filter(Boolean).join(' · ') })),
        carArt(c)),
      h('dl', { class: 'spec-list' }, ...facts.flatMap(([k, value]) => [h('dt', { text: k }), h('dd', { text: String(value) })])),
      h('p', { class: 'small muted', text: source })),
    h('h2', { id: 'confirm-title', class: 'confirm-q', text: 'Is the vehicle information correct?' }),
    h('div', { class: 'confirm-actions' },
      yes,
      h('button', { class: 'btn btn-secondary btn-block', type: 'button', text: 'No, I\'ll choose the details', onclick: () => showRegister(vin, d, c) })),
    status);
    showStep('confirm');
    yes.focus({ preventScroll: true });

    async function onYes() {
      yes.disabled = true;
      setStatus(status, 'Saving your car…');
      try {
        const res = await api('/api/vehicles/register', { method: 'POST', body: {
          vin, make: c.make, model: c.model, year: c.year, generation: c.generation || null, engine: c.engine || null,
          transmission: c.transmission || null, origin_market: state.meta.origins.includes(c.origin_market) ? c.origin_market : null,
        } });
        showBasic(res.vehicle);
      } catch (err) {
        yes.disabled = false;
        setStatus(status, err.message, 'error');
      }
    }
  }

  /** Step 3: the car's details at a glance, and its mileage for the inspection reminders. */
  function showBasic(vehicle) {
    const v = vehicle;
    const mileage = h('input', { id: 'b-mileage', type: 'number', inputMode: 'numeric', min: 0, max: 2000000, step: 1, placeholder: 'For example 84500' });
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const rows = [
      ['Manufacturer', v.make], ['Model', v.model], ['Generation', generationLabel(v) || 'Not sure'],
      ['Engine', engineText(v) || 'Not sure'], ['Fuel', fuelOf(v.engine) || 'Not sure'], ['Model year', v.year],
      ['Transmission', v.transmission || 'Not sure'], ['Built in', v.origin_market || 'Not sure'], ['VIN', v.vin_masked],
    ];
    const done = async (event) => {
      event.preventDefault();
      if (mileage.value === '') return setVehicle(v);
      setStatus(status, 'Saving…');
      try {
        const res = await api(`/api/vehicles/id/${enc(v.id)}`, { method: 'PATCH', body: { mileage_km: Number(mileage.value) } });
        setVehicle(res.vehicle);
      } catch (err) { setStatus(status, err.message, 'error'); }
    };
    $('basic').replaceChildren(
      h('div', { class: 'basic-hero' },
        h('div', {}, makeLogo(v.make, 'cc-logo'), h('h1', { id: 'basic-title', text: `${v.make} ${v.model}` }),
          h('p', { class: 'cc-sub', text: `${v.year}${v.engine ? ` · ${v.engine}` : ''}` })),
        carArt(v)),
      h('h2', { class: 'g-title', text: 'Vehicle basic information' }),
      h('dl', { class: 'spec-grid' }, ...rows.map(([k, value]) => h('div', {}, h('dt', { text: k }), h('dd', { text: String(value) })))),
      h('form', { class: 'basic-form', novalidate: true, onsubmit: done },
        h('label', { for: 'b-mileage', text: 'Current mileage' }),
        h('div', { class: 'unit-input' }, mileage, h('span', { text: 'km' })),
        h('p', { class: 'hint', text: 'The number on your odometer. We use it to show when oil, filters and brake pads are due. You can change it any time.' }),
        status,
        h('button', { class: 'btn btn-primary btn-block', type: 'submit', text: 'Complete input' }),
        h('button', { class: 'btn btn-quiet btn-block', type: 'button', text: 'Skip for now', onclick: () => setVehicle(v) })));
    showStep('basic');
    mileage.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- my garage

  const kmFmt = (n) => `${rwf.format(n)} km`;
  const monthYear = (iso) => {
    const d = new Date(String(iso).replace(' ', 'T') + (String(iso).includes('Z') ? '' : 'Z'));
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  };

  function renderGarageHero() {
    const v = state.vehicle;
    const since = v.created_at ? monthYear(v.created_at) : null;
    const mileageBox = h('span', { class: 'gh-mileage' });
    const showMileage = () => mileageBox.replaceChildren(
      h('span', { text: v.mileage_km != null ? kmFmt(v.mileage_km) : 'Mileage not added' }),
      h('button', { class: 'btn-link', type: 'button', text: v.mileage_km != null ? 'Update' : 'Add', onclick: editMileage }));
    function editMileage() {
      const input = h('input', { type: 'number', inputMode: 'numeric', min: 0, max: 2000000, value: v.mileage_km ?? '', 'aria-label': 'Current mileage in km' });
      const save = async (event) => {
        event.preventDefault();
        if (input.value === '') return showMileage();
        try {
          const res = await api(`/api/vehicles/id/${enc(v.id)}`, { method: 'PATCH', body: { mileage_km: Number(input.value) } });
          state.vehicle = res.vehicle;
          renderGarageHero();
          renderInspection();
        } catch (err) { input.setCustomValidity(err.message); input.reportValidity(); }
      };
      mileageBox.replaceChildren(h('form', { class: 'gh-mileage-form', onsubmit: save },
        input, h('span', { text: 'km' }), h('button', { class: 'btn btn-small btn-primary', type: 'submit', text: 'Save' })));
      input.focus();
    }
    showMileage();
    $('vehicle-bar').replaceChildren(h('div', { class: 'garage-hero' },
      h('div', { class: 'wrap-wide gh-inner' },
        h('div', { class: 'gh-text' },
          h('div', { class: 'gh-title' }, makeLogo(v.make, 'gh-logo'), h('h1', { text: `${v.make} ${v.model}` })),
          h('p', { class: 'gh-sub' }, h('span', { text: `${v.year}${v.engine ? ` · ${v.engine}` : ''}` }), h('span', { class: 'gh-sep', 'aria-hidden': 'true' }), mileageBox),
          h('div', { class: 'gh-row' }, vinPill(v), since ? h('span', { class: 'gh-since', text: `In your garage since ${since}` }) : null),
          h('button', { class: 'btn btn-secondary btn-small gh-change', type: 'button', text: 'Change car', onclick: changeCar })),
        h('div', { class: 'gh-art' }, carArt(v)))));
  }

  // Usual service intervals from the makers' owner's manuals for normal driving. Without the car's
  // service history these are estimates counted from 0 km, and the card says so.
  const INSPECTIONS = [
    { name: 'Engine oil', km: 10000, months: 12, category: 'Engine Oil' },
    { name: 'Oil filter', km: 10000, months: 12, category: 'Oil Filter' },
    { name: 'Front brake pads', km: 30000, months: 24, category: 'Front Brake Pad' },
    { name: 'Rear brake pads', km: 40000, months: 36, category: 'Rear Brake Pad' },
    { name: 'Air filter', km: 20000, months: 24, category: 'Air Filter' },
    { name: 'Battery', months: 36, category: 'Battery' },
    { name: 'Wiper blades', months: 12, category: 'Wiper Blade' },
  ];

  function renderInspection() {
    const v = state.vehicle;
    const km = v.mileage_km;
    const cards = INSPECTIONS.map((item, i) => {
      const every = [item.km ? kmFmt(item.km) : null, `${item.months} months`].filter(Boolean).join(' or ');
      let tag = null;
      if (item.km && km != null) {
        const next = (Math.floor(km / item.km) + 1) * item.km;
        const soon = next - km <= item.km * 0.15;
        tag = h('span', { class: `insp-tag${soon ? ' due' : ''}`, text: soon ? `Due at ${kmFmt(next)}` : `Next at ${kmFmt(next)}` });
      }
      const cat = state.catalog.categories.find((c) => c.name === item.category);
      return h('article', { class: 'insp-card', hidden: i >= 3 },
        h('span', { class: 'insp-check', 'aria-hidden': 'true' }, icon('check')),
        h('div', { class: 'insp-body' },
          h('h3', { text: item.name }),
          h('p', { text: `Replace every ${every}` }),
          tag,
          cat ? h('div', {}, h('button', { class: 'btn-link', type: 'button', text: `Find ${item.name.toLowerCase()}`, onclick: () => pickCategory(cat) })) : null));
    });
    const more = h('button', { class: 'btn btn-secondary', type: 'button', text: 'View all inspection items', onclick: () => {
      cards.forEach((c) => { c.hidden = false; });
      more.remove();
    } });
    $('inspection').replaceChildren(
      h('h2', { id: 'inspection-title', class: 'g-title', text: 'Let\'s check the inspection items' }),
      h('p', { class: 'small muted', text: km != null
        ? `Counted from ${kmFmt(km)} using the usual service intervals. If you replaced something recently, go by your service record instead.`
        : 'Add your mileage above to see when each one is due.' }),
      h('div', { class: 'insp-grid' }, ...cards),
      h('div', { class: 'g-more' }, more));
  }

  async function loadShopsNear() {
    const grid = $('garage-grid');
    const v = state.vehicle;
    const q = new URLSearchParams({ radius_km: 'any' });
    if (state.coords) { q.set('lat', state.coords.lat); q.set('lon', state.coords.lon); }
    try {
      const { garages } = await api(`/api/garages/nearby?${q}`);
      const message = (g) => `Hello ${g.name}, I found your garage on Vinzuu and would like to book a repair for my ${vehicleTitle(v)}.`;
      grid.replaceChildren(...(garages.length
        ? garages.slice(0, 4).map((g, i) => garageCard(g, i, message(g)))
        : [h('p', { class: 'muted', text: 'No repair shops are listed yet. Check back soon.' })]));
    } catch (err) {
      grid.replaceChildren(h('p', { class: 'muted', text: 'We could not load repair shops right now. Refresh the page to try again.' }));
    }
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

  /** Step 2b: pick the details. `known` is what the VIN told us (decoded once by lookupVin);
   *  `prefill` is a suggested car the customer said was wrong, kept so they only fix what is. */
  function showRegister(vin, known, prefill) {
    const makes = state.catalog.makes;
    const mount = $('register');
    const f = {};

    // The make is picked by logo. The hidden select keeps the value, so everything below reads
    // f.make.value exactly as before.
    f.make = h('select', { id: 'r-make', hidden: true, 'aria-hidden': 'true', tabIndex: -1 });
    fillSelect(f.make, [...makes.map((m) => ({ value: m.make, text: m.make })), { value: '__other', text: 'Other make' }], 'Choose the make');
    f.makeOther = h('input', { id: 'r-make-other', type: 'text', placeholder: 'Type the make', hidden: true, 'aria-label': 'Make' });
    f.makeTiles = makeTiles(makes, (value) => { f.make.value = value; syncMake(); });
    f.model = h('select', { id: 'r-model', hidden: true });
    f.modelOther = h('input', { id: 'r-model-other', type: 'text', placeholder: 'Type the model', hidden: true, 'aria-label': 'Model' });
    f.year = h('input', { id: 'r-year', type: 'number', inputMode: 'numeric', min: 1980, max: new Date().getFullYear() + 1, placeholder: 'For example 2018' });
    f.yearHint = h('p', { class: 'hint', hidden: true });
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
    f.modelHint = h('p', { class: 'hint', hidden: true });
    const wrapModel = h('div', { class: 'field', hidden: true }, h('label', { for: 'r-model', text: 'Model' }), f.model, f.modelOther, f.modelHint);

    const currentMake = () => makes.find((m) => m.make === f.make.value);
    const currentModel = () => { const m = currentMake(); return m && m.models.find((x) => x.model === f.model.value); };

    function syncModel() {
      const model = currentModel();
      const custom = f.make.value === '__other' || f.model.value === '__other';
      f.modelOther.hidden = !custom;
      wrapEngine.hidden = !(f.make.value === '__other' || f.model.value);
      const gens = model ? model.generations : [];
      wrapGeneration.hidden = gens.length === 0;
      fillSelect(f.generation, gens.map((g) => ({ value: g.generation, text: generationText(g) })), 'Not sure');
      f.modelHint.hidden = !model || !model.body;
      if (model) f.modelHint.textContent = modelSummary(model);
      syncGenerationToYear(f.generation, gens, f.year.value);
      syncEngines();
    }
    // Only the engines the chosen generation was sold with, so a 2018 Tucson never offers a 2005 engine.
    function syncEngines() {
      const engines = enginesFor(currentModel(), f.generation.value);
      const keep = f.engineSelect.value;
      f.engineSelect.hidden = engines.length === 0;
      f.engineText.hidden = engines.length !== 0;
      fillSelect(f.engineSelect, engineOptions(engines), 'Not sure');
      if ([...f.engineSelect.options].some((o) => o.value === keep)) f.engineSelect.value = keep;
      pickOnlyChoice(f.engineSelect);
    }
    // Models made in the car's year come first, so the list is short when the VIN gave the year.
    function fillModels() {
      const make = currentMake();
      if (!make) return;
      const keep = f.model.value;
      const year = Number(f.year.value);
      const opt = (m) => h('option', { value: m.model, text: m.aka && m.aka.length ? `${m.model} (${m.aka.slice(0, 2).join(', ')})` : m.model });
      const madeThen = year ? make.models.filter((m) => m.generations.some((g) => year >= g.year_start && year <= g.year_end)) : [];
      const others = make.models.filter((m) => !madeThen.includes(m));
      f.model.replaceChildren(h('option', { value: '', text: 'Choose the model' }),
        ...(madeThen.length
          ? [h('optgroup', { label: `Made in ${year}` }, ...madeThen.map(opt)), h('optgroup', { label: 'Other models' }, ...others.map(opt))]
          : others.map(opt)),
        h('option', { value: '__other', text: 'Other model' }));
      if ([...f.model.options].some((o) => o.value === keep)) f.model.value = keep;
    }
    function syncMake() {
      const make = currentMake();
      f.makeTiles.select(f.make.value);
      f.makeOther.hidden = f.make.value !== '__other';
      wrapModel.hidden = !f.make.value;
      f.model.hidden = !make;
      fillModels();
      syncModel();
    }
    f.make.addEventListener('change', syncMake);
    f.model.addEventListener('change', syncModel);
    f.year.addEventListener('input', () => {
      const model = currentModel();
      fillModels();
      syncGenerationToYear(f.generation, model ? model.generations : [], f.year.value);
      syncEngines();
    });
    f.generation.addEventListener('change', () => { f.generation.dataset.auto = ''; syncEngines(); });
    syncMake();
    const decoded = h('div', { class: 'vin-decoded', 'aria-live': 'polite' });
    (known !== undefined ? Promise.resolve(known) : decodeVin(vin)).then((d) => {
      if (!d) return;
      // Fill in only what the person has not chosen yet; the VIN is a strong hint, not the last word.
      if (d.maker && !f.make.value && makes.some((m) => m.make === d.maker)) { f.make.value = d.maker; syncMake(); }
      if (d.origin && !f.origin.value && state.meta.origins.includes(d.origin)) f.origin.value = d.origin;
      if (d.model_year && !f.year.value) {
        f.year.value = String(d.model_year);
        f.yearHint.textContent = `Read from your VIN (10th character "${d.model_year_code}"). Change it if your papers say otherwise.`;
        f.yearHint.hidden = false;
        f.year.dispatchEvent(new Event('input'));
      }
      decoded.replaceChildren(...decodedFacts(d));
      if (prefill && f.make.value === prefill.make) {
        if ([...f.model.options].some((o) => o.value === prefill.model)) { f.model.value = prefill.model; syncModel(); }
        if (prefill.generation && [...f.generation.options].some((o) => o.value === prefill.generation)) { f.generation.value = prefill.generation; syncEngines(); }
        if (prefill.engine && [...f.engineSelect.options].some((o) => o.value === prefill.engine)) f.engineSelect.value = prefill.engine;
        if (prefill.transmission) f.transmission.value = prefill.transmission;
      }
    }).finally(() => {
      // Start where the person has something to do: the model when the VIN gave the make.
      if (f.make.value && !f.model.hidden) f.model.focus({ preventScroll: true });
      else f.makeTiles.focus();
    });


    const form = h('form', { class: 'panel', novalidate: true, onsubmit: onSubmit },
      h('h2', { id: 'register-title', text: 'Tell us about your car' }),
      h('p', { class: 'muted', text: `We read what we could from your VIN. Fill in the rest once, and next time VIN ${vin} is all you need.` }),
      h('div', { class: 'field' }, h('label', { text: 'VIN' }), h('p', { class: 'vin-locked', text: vin }), decoded),
      h('fieldset', { class: 'field' }, h('legend', { text: 'Make' }), f.makeTiles.el, f.make, f.makeOther),
      wrapModel,
      h('div', { class: 'field' }, h('label', { for: 'r-year', text: 'Model year' }), f.year, f.yearHint),
      wrapGeneration,
      wrapEngine,
      field('Transmission', f.transmission),
      field('Where was it built?', f.origin, 'This matters. The same model built in Korea and in the USA can need different parts.'),
      field('Where was it imported from?', f.importSource),
      f.status,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn btn-primary', type: 'submit', text: 'Save my car' }),
        h('button', { class: 'btn btn-quiet', type: 'button', text: 'Cancel', onclick: () => { showStep('start'); $('vin').focus(); } })));

    async function onSubmit(event) {
      event.preventDefault();
      const make = f.make.value === '__other' ? f.makeOther.value.trim() : f.make.value;
      const model = (f.make.value === '__other' || f.model.value === '__other') ? f.modelOther.value.trim() : f.model.value;
      if (!make || !model) return setStatus(f.status, 'Choose the make and the model.', 'error');
      if (!f.year.value) return setStatus(f.status, 'Enter the year the car was made.', 'error');
      setStatus(f.status, 'Saving…');
      try {
        const res = await api('/api/vehicles/register', {
          method: 'POST',
          body: {
            vin, make, model, year: Number(f.year.value),
            generation: f.generation.value || null,
            engine: (f.engineSelect.hidden ? f.engineText.value : f.engineSelect.value) || null,
            transmission: f.transmission.value || null, origin_market: f.origin.value || null,
            import_source: f.importSource.value || null,
          },
        });
        showBasic(res.vehicle);
        if (res.warnings && res.warnings.length) setStatus($('results-status'), res.warnings.join(' '));
      } catch (err) {
        setStatus(f.status, err.message, 'error');
      }
    }

    mount.replaceChildren(form);
    showStep('register');
  }

  /** "SUV. 4 generations since 2000, the latest from 2020." */
  function modelSummary(m) {
    const n = m.generations.length;
    const latest = m.generations[n - 1];
    const gens = n ? ` ${n} ${n === 1 ? 'generation' : 'generations'} since ${m.generations[0].year_start}${n > 1 ? `, the latest from ${latest.year_start}` : ''}.` : '';
    return `${m.body}.${gens}`;
  }

  /** What the VIN alone tells us: maker, build country and model year. null when it says nothing. */
  async function decodeVin(vin) {
    try {
      const d = await api(`/api/vin/decode?vin=${enc(vin)}`);
      return d.valid ? d : null;
    } catch (err) { return null; } // a convenience only: the person can still fill everything in
  }

  function decodedFacts(d) {
    const make = d.maker && state.catalog.makes.find((m) => m.make === d.maker);
    const facts = [
      make && make.logo ? h('span', { class: 'fact' }, h('img', { class: 'fact-logo', src: make.logo, alt: make.make, width: 22, height: 22 })) : null,
      d.origin ? h('span', { class: 'fact', text: `Built in ${d.origin}` }) : null,
      d.model_year ? h('span', { class: 'fact', text: `${d.model_year} model year` }) : null,
    ].filter(Boolean);
    if (!facts.length) return [h('p', { class: 'hint', text: 'We could not read the maker or year from this VIN, so please choose them below.' })];
    return [h('p', { class: 'hint', text: 'From your VIN:' }), h('div', { class: 'facts' }, ...facts)];
  }

  /**
   * Hyundai, Kia and Toyota are chosen by their logos (radio buttons, so arrow keys and screen
   * readers work as usual). "Other make" opens a text box for anything else.
   */
  function makeTiles(makes, onPick) {
    const name = 'r-make-tile';
    const tile = (value, content, label) => {
      const input = h('input', { type: 'radio', name, value, class: 'make-radio', onchange: () => onPick(value) });
      return { input, el: h('label', { class: 'make-tile', title: label }, input, content) };
    };
    const tiles = makes.map((m) => tile(m.make,
      m.logo ? h('img', { src: m.logo, alt: m.make, width: 44, height: 44 }) : h('span', { class: 'make-name', text: m.make }), m.make));
    tiles.push(tile('__other', h('span', { class: 'make-name', text: 'Other make' }), 'Other make'));
    return {
      el: h('div', { class: 'make-tiles' }, ...tiles.map((t) => t.el)),
      select(value) { for (const t of tiles) t.input.checked = t.input.value === value; },
      focus() { (tiles.find((t) => t.input.checked) || tiles[0]).input.focus({ preventScroll: true }); },
    };
  }

  const motion = () => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

  // ---------------------------------------------------------------- pick a part

  // The same photos as the homepage parts strip. Categories without one show just their name.
  const PART_PHOTOS = {
    'Front Bumper': 'front-bumper.jpg', 'Headlight Assembly': 'headlight.jpg',
    'Front Brake Pad': 'brake-disc.jpg', 'Rear Brake Pad': 'brake-disc.jpg',
    'Oil Filter': 'oil-filter.jpg', 'Air Filter': 'air-filter.jpg', 'Battery': 'battery.jpg',
    'Wiper Blade': 'wiper-blade.jpg', 'Engine Oil': 'engine-oil.jpg',
  };

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
        class: 'part-tile', type: 'button', 'aria-pressed': String(state.category === c.name),
        onclick: () => pickCategory(c),
      },
      h('span', { class: 'pt-photo' }, PART_PHOTOS[c.name]
        ? h('img', { src: `/img/parts/${PART_PHOTOS[c.name]}`, alt: '', width: 120, height: 120, loading: 'lazy' })
        : h('span', { class: 'pt-initial', 'aria-hidden': 'true', text: c.name.charAt(0) })),
      h('span', { class: 'pt-name', text: c.name })))));
  }

  /** The parts strip scrolls sideways; "View all parts" lays every part out in a grid instead. */
  function showAllParts(all) {
    $('part-list').classList.toggle('show-all', all);
    $('picker').classList.toggle('all-open', all);
    $('all-parts').setAttribute('aria-expanded', String(all));
    $('all-parts').textContent = all ? 'Show fewer parts' : 'View all parts';
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
      fillSelect(sel, gens.map((g) => ({ value: g.generation, text: generationText(g) })), 'Which generation is it?');
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
    return `Hello, I saw ${what} for ${fmtRwf(l.price_rwf)} on ${state.meta.app_name}. Is it still in stock? My car: ${vehicleTitle(v)}${v.vin_masked ? `, VIN ${v.vin_masked}` : ''}.`;
  }

  /** Why a part number fits, the way a parts catalogue lists its "applicable cars". */
  function fitsText(oe) {
    const fit = state.searchInfo && (state.searchInfo.oe_numbers || []).find((o) => o.oe_number === oe);
    if (!fit) return null;
    const v = state.vehicle;
    return 'Fits ' + [
      `${v.make} ${v.model}${fit.generation ? ` ${fit.generation}` : ''}`,
      fit.year_start ? `${fit.year_start} to ${fit.year_end}` : null,
      fit.engine || 'any engine',
      fit.origin_market ? `built in ${fit.origin_market}` : 'any build country',
    ].filter(Boolean).join(', ');
  }

  function resultRow(l) {
    const detail = l.oe_number ? `Part number ${l.oe_number}` : `Size: ${l.universal_spec}`;
    const fits = l.oe_number ? fitsText(l.oe_number) : null;
    const wa = whatsappLink(l.shop_whatsapp || l.shop_phone, shopMessage(l));
    return h('li', { class: 'result' },
      h('img', { class: 'photo', src: l.photo_url, alt: `${l.part_category} at ${l.shop_name}`, loading: 'lazy', width: 88, height: 88 }),
      h('div', {}, h('div', { class: 'shop', text: l.shop_name }), h('div', { class: 'small muted', text: l.shop_address || '' })),
      h('div', { class: 'price' }, rwf.format(l.price_rwf), ' ', h('small', { text: 'RWF' })),
      h('div', { class: 'meta', text: `${l.distance_km} km away, ${l.condition === 'genuine' ? 'genuine part' : 'aftermarket part'}, ${l.in_stock} in stock` }),
      h('div', { class: 'meta', text: detail }),
      fits ? h('div', { class: 'meta', text: fits }) : null,
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
