/* Customer page, the same steps as a parts site's "my garage":
     1. Vehicle inquiry: the VIN is all we ask for.
     2. Vehicle check: "Is your car a 2021 Hyundai?", read from the VIN. No means re-check the VIN.
     3. The car's details: model, generation and engine are required (parts depend on them), the
        rest optional. Maker, year and build country come from the VIN and are not asked again.
     4. Check and save, then home to the garage.
     5. My garage: the parts that fit this car (-> shops -> book a garage), service schedule,
        repair shops. A VIN that is already saved skips straight here.
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
    $('part-q').addEventListener('input', renderPartList);
    $('all-parts').addEventListener('click', () => showAllParts($('all-parts').getAttribute('aria-expanded') !== 'true'));

    // A VIN in the URL (from the homepage's quick-search box) wins over a remembered car,
    // since typing a different VIN there is a deliberate new search. A part in the URL (a
    // homepage "Shop now" button) is opened as soon as a car is known.
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('vin');
    state.wantedPart = state.catalog.categories.find((c) => c.name === params.get('part')) || null;
    if (fromUrl || params.has('part')) history.replaceState(null, '', location.pathname); // tidy the URL, keep the lookup
    // Who is signed in decides which cars this page may reopen and list.
    state.user = await api('/api/auth/me').then((r) => r.user).catch(() => null);
    const rememberedId = rememberedCar();
    if (state.wantedPart && !fromUrl && !rememberedId) {
      setStatus($('vin-status'), `Enter your VIN and we'll show the ${state.wantedPart.name.toLowerCase()} that fits your car.`);
    }
    if (fromUrl) {
      const vin = normalizeVin(fromUrl);
      $('vin').value = vin;
      await lookupVin(vin);
    } else if (rememberedId) {
      await lookupById(rememberedId);
    } else if (state.user) {
      // Signing in opens your garage: your most recently saved car, like a parts site's My Garage.
      const mine = await api('/api/me/vehicles').then((r) => r.vehicles).catch(() => []);
      if (mine.length) setVehicle(mine[0]);
    }
    if (state.user) loadMyCars();
    goToSection(location.hash.slice(1), { settle: true });
    // Signed in, the nav's "Find parts", "Popular parts" and "Garages" point at sections of this
    // page (common.js). Already here, they jump to that section instead of reloading the page.
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="/index.html#"]');
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      history.replaceState(null, '', location.pathname);
      goToSection(a.getAttribute('href').split('#')[1]);
    });
  }

  /** Shows the garage section asked for ("picker" = parts that fit, "shops-near" = repair shops).
   *  With no car open yet there is nothing to show there, so the VIN box is shown instead. */
  function goToSection(id, { settle = false } = {}) {
    if (!['picker', 'shops-near'].includes(id)) return;
    if (location.hash) history.replaceState(null, '', location.pathname);
    if (!state.vehicle) {
      if ($('start').hidden) { showStep('start'); }
      $('start').scrollIntoView({ behavior: motion(), block: 'start' });
      $('vin').focus({ preventScroll: true });
      return;
    }
    if ($('vehicle').hidden) showStep('vehicle');
    $(id).scrollIntoView({ behavior: motion(), block: 'start' });
    // Arriving from another page, the parts and shops above are still loading and push the
    // section down, so line it up again once they are in (unless the person scrolled meanwhile).
    if (settle) {
      let last = null;
      for (const ms of [400, 1000, 1800]) {
        setTimeout(() => {
          if (last !== null && Math.abs(window.scrollY - last) > 2) return;
          $(id).scrollIntoView({ behavior: 'auto', block: 'start' });
          last = window.scrollY;
        }, ms);
      }
    }
  }

  // ---------------------------------------------------------------- account state

  // The last car opened is remembered per account ("userId:vehicleId"), so signing in as someone
  // else on the same browser never reopens the previous person's car. Signed out, nothing is
  // reopened.
  function rememberedCar() {
    const [userId, vehicleId] = String(store.get(VEHICLE_ID_KEY) || '').split(':');
    if (state.user && vehicleId && userId === String(state.user.id)) return vehicleId;
    store.remove(VEHICLE_ID_KEY);
    return null;
  }
  function rememberCar(vehicle) {
    if (state.user) store.set(VEHICLE_ID_KEY, `${state.user.id}:${vehicle.id}`);
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
  // Cars built for Japan have a chassis (frame) number instead, like NZE121-3123456.
  const validFrame = (v) => /^[A-Z]{2,5}\d{2,3}[A-Z]?\d{5,8}$/.test(v) && v.length <= 14;
  const isFrame = (d) => !!d && d.kind === 'frame';

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
    if (!validVin(vin) && !validFrame(vin)) {
      setStatus($('vin-status'), 'Enter the full 17-character VIN (the letters I, O and Q are never used), or a Japanese chassis number like NZE121-3123456.', 'error');
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
        showVerify((d && d.vin) || vin, d);
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
    rememberCar(vehicle);
    showStep('vehicle');
    $('part-q').value = '';
    renderGarageHero();
    state.fits = null;
    showAllParts(false);
    loadFits();
    renderInspection();
    loadShopsNear();
    loadMyBookings();
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
  /** When the server can't reach Wikipedia, this browser looks the photo up itself. */
  let photoLib = null;
  function photoFromBrowser(lookup) {
    photoLib = photoLib || new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = '/carphotos.js';
      s.onload = () => resolve(window.carphotos);
      s.onerror = () => resolve(null);
      document.head.append(s);
    });
    return photoLib.then((lib) => lib && lib.findPhoto(lookup)).then((p) => (p && p.src ? p : null)).catch(() => null);
  }
  function carPhoto(v) {
    const key = [v.make, v.model, v.generation || ''].join('|');
    if (!photoCache.has(key)) {
      const q = new URLSearchParams({ make: v.make, model: v.model });
      if (v.generation) q.set('generation', v.generation);
      photoCache.set(key, api(`/api/car-photo?${q}`).then((r) => (r.photo || (r.reason === 'unreachable' && r.lookup ? photoFromBrowser(r.lookup) : null))).catch(() => null));
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

  // ---------------------------------------------------------------- my garage

  const kmFmt = (n) => `${rwf.format(n)} km`;
  const monthYear = (iso) => {
    const d = new Date(String(iso).replace(' ', 'T') + (String(iso).includes('Z') ? '' : 'Z'));
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  };

  function renderGarageHero() {
    const v = state.vehicle;
    // Another account's car (found by its VIN) shows the car itself, not its owner's mileage.
    const since = v.mine && v.created_at ? monthYear(v.created_at) : null;
    const ownerDetails = v.mine || v.created_at != null;
    const mileageBox = h('div', { class: 'gh-stat' });
    const showMileage = () => mileageBox.replaceChildren(
      h('span', { class: 'gh-stat-label', text: 'Mileage' }),
      h('span', { class: 'gh-stat-value', text: v.mileage_km != null ? kmFmt(v.mileage_km) : 'Not added' }),
      h('button', { class: 'btn-link', type: 'button', text: v.mileage_km != null ? 'Update' : 'Add mileage', onclick: editMileage }));
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
      mileageBox.replaceChildren(h('span', { class: 'gh-stat-label', text: 'Mileage' }), h('form', { class: 'gh-mileage-form', onsubmit: save },
        input, h('span', { text: 'km' }), h('button', { class: 'btn btn-small btn-primary', type: 'submit', text: 'Save' })));
      input.focus();
    }
    showMileage();
    // The car's build, as chips: the details its parts are matched on.
    const chips = [
      String(v.year), v.generation ? `${v.generation} generation` : null, v.engine, v.transmission,
      v.origin_market ? `Built in ${v.origin_market}` : null,
    ].filter(Boolean);
    $('vehicle-bar').replaceChildren(h('div', { class: 'garage-hero' },
      h('div', { class: 'wrap-wide gh-inner' },
        h('div', { class: 'gh-art' }, carArt(v)),
        h('div', { class: 'gh-text' },
          h('p', { class: 'gh-kicker', text: v.mine ? 'My garage' : 'Found by VIN' }),
          h('div', { class: 'gh-title' }, h('span', { class: 'gh-badge' }, makeLogo(v.make, 'gh-logo')), h('h1', { text: `${v.make} ${v.model}` })),
          h('ul', { class: 'gh-chips', 'aria-label': 'Matched on' }, ...chips.map((c) => h('li', { text: c }))),
          h('div', { class: 'gh-stats' },
            h('div', { class: 'gh-stat' }, h('span', { class: 'gh-stat-label', text: 'VIN' }), vinPill(v)),
            ownerDetails ? mileageBox : null,
            since ? h('div', { class: 'gh-stat' }, h('span', { class: 'gh-stat-label', text: 'Saved' }), h('span', { class: 'gh-stat-value', text: since })) : null),
          h('button', { class: 'btn btn-small gh-change', type: 'button', text: 'Change car', onclick: changeCar })))));
  }

  // Usual service intervals from the makers' owner's manuals for normal driving. Without the car's
  // service history these are estimates counted from 0 km, and the section says so.
  const INSPECTIONS = [
    { name: 'Engine oil', km: 10000, months: 12, category: 'Engine Oil' },
    { name: 'Oil filter', km: 10000, months: 12, category: 'Oil Filter' },
    { name: 'Front brake pads', km: 30000, months: 24, category: 'Front Brake Pad' },
    { name: 'Rear brake pads', km: 40000, months: 36, category: 'Rear Brake Pad' },
    { name: 'Air filter', km: 20000, months: 24, category: 'Air Filter' },
    { name: 'Battery', months: 36, category: 'Battery' },
    { name: 'Wiper blades', months: 12, category: 'Wiper Blade' },
  ];

  /** A service schedule: each item's interval and, with a mileage, how far along it is. */
  function renderInspection() {
    const v = state.vehicle;
    const km = v.mileage_km;
    const rows = INSPECTIONS.map((item, i) => {
      const every = [item.km ? kmFmt(item.km) : null, `${item.months} months`].filter(Boolean).join(' or ');
      let meter = null;
      if (item.km && km != null) {
        const done = (km % item.km) / item.km;
        const next = (Math.floor(km / item.km) + 1) * item.km;
        const soon = done >= 0.85;
        const fill = h('span', {});
        fill.style.width = `${Math.max(4, Math.round(done * 100))}%`;
        meter = h('div', { class: `sched-meter${soon ? ' due' : ''}` },
          h('div', { class: 'sched-bar', role: 'img', 'aria-label': `${Math.round(done * 100)}% of the way to the next change` }, fill),
          h('span', { class: 'sched-next', text: soon ? `Due soon, at ${kmFmt(next)}` : `Next at ${kmFmt(next)}` }));
      }
      const fit = fitFor(item.category);
      const cat = state.catalog.categories.find((c) => c.name === item.category);
      return h('li', { class: 'sched-row', hidden: i >= 4 },
        h('div', { class: 'sched-name' }, h('strong', { text: item.name }), h('span', { text: `Every ${every}` })),
        meter || h('span', { class: 'sched-next muted', text: km != null || !item.km ? 'Check by date' : 'Add mileage to track' }),
        cat && (!fit || fit.fit !== 'none') ? h('button', { class: 'btn btn-secondary btn-small', type: 'button', text: 'Shop', 'aria-label': `Shop ${item.name.toLowerCase()}`, onclick: () => pickCategory(cat) }) : h('span', {}));
    });
    const more = h('button', { class: 'btn btn-secondary', type: 'button', text: 'View full schedule', onclick: () => {
      rows.forEach((r) => { r.hidden = false; });
      more.remove();
    } });
    $('inspection').replaceChildren(
      h('div', { class: 'g-head' }, h('div', {},
        h('h2', { id: 'inspection-title', class: 'g-title', text: 'Service schedule' }),
        h('p', { class: 'g-sub', text: km != null
          ? `Counted from ${kmFmt(km)} with the usual intervals. If you replaced something recently, go by your service record.`
          : v.mine || v.created_at != null ? 'Add your mileage above to see when each one is due.' : 'The usual service intervals for this car.' }))),
      h('ul', { class: 'sched' }, ...rows),
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

  // ---------------------------------------------------------------- my bookings and reviews

  const BOOKING_SHOP = { requested: 'Waiting for the shop', confirmed: 'Reserved for you', collected: 'Collected', cancelled: 'Cancelled by the shop' };
  const BOOKING_GARAGE = { requested: 'Waiting for the garage', accepted: 'Booked', done: 'Done', declined: 'Declined' };

  async function loadMyBookings() {
    const section = $('my-bookings');
    if (!state.user) { section.hidden = true; return; }
    let bookings = [];
    try { bookings = (await api('/api/me/bookings')).bookings; } catch (err) { section.hidden = true; return; }
    section.hidden = !bookings.length;
    $('booking-list').replaceChildren(...bookings.map(bookingItem));
  }

  function bookingItem(b) {
    const slot = b.garage_time ? new Date(b.garage_time.replace(' ', 'T')).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const side = (who, name, statusText, review, target) => h('div', { class: 'bk-side' },
      h('span', { class: 'bk-who', text: who }), h('strong', { text: name }),
      h('span', { class: 'small muted', text: statusText }),
      typeof review === 'number' ? h('span', { class: 'bk-rated' }, starsEl(review), ' You rated this')
        : review === 'can_review' ? h('button', { class: 'btn btn-primary btn-small', type: 'button', text: `Rate the ${target}`, onclick: () => openReviewForm(b, target, name) }) : null,
      b.reported && b.reported[target] ? h('span', { class: 'small muted bk-reported', text: 'You reported a problem. The vinzuu team is looking into it.' })
        : h('button', { class: 'link-btn small bk-report', type: 'button', text: 'Report a problem', onclick: () => openReportForm({ booking_id: b.id, target }, name) }));
    return h('li', { class: 'booking-item' },
      h('div', { class: 'bk-head' }, h('strong', { text: b.part_category ? `${b.part_category}${b.oe_number ? ` (${b.oe_number})` : ''}` : 'Repair' }),
        h('span', { class: 'small muted', text: `${b.year} ${b.make} ${b.model} · booked ${String(b.created_at).slice(0, 10)}` })),
      h('div', { class: 'bk-sides' },
        b.shop_name ? side('Part from', b.shop_name, b.admin_note && b.shop_status === 'cancelled' ? `Cancelled by vinzuu: ${b.admin_note}`
          : BOOKING_SHOP[b.shop_status] || b.shop_status, b.review.shop, 'shop') : null,
        b.garage_name ? side('Fitted by', b.garage_name,
          b.garage_status === 'accepted' ? `Booked for ${slot}` : b.garage_status === 'declined' ? (/^Cancelled by vinzuu/.test(b.garage_note || '') ? b.garage_note : `Declined: ${b.garage_note || ''}`) : (BOOKING_GARAGE[b.garage_status] || b.garage_status),
          b.review.garage, 'garage') : null));
  }

  function openReviewForm(b, target, name) {
    const dlg = $('booking-dialog');
    let stars = 0;
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const comment = h('textarea', { id: 'rv-comment', maxLength: 500, rows: 4, placeholder: target === 'shop' ? 'Was the part as described? How was the service?' : 'Was the work good? Was it ready on time?' });
    const picker = h('div', { class: 'star-pick', role: 'radiogroup', 'aria-label': 'Stars' }, ...[1, 2, 3, 4, 5].map((n) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': 'false', 'aria-label': `${n} ${n === 1 ? 'star' : 'stars'}`, text: '★',
      onclick: () => { stars = n; picker.querySelectorAll('button').forEach((x, i) => { x.classList.toggle('on', i < n); x.setAttribute('aria-checked', String(i + 1 === n)); }); },
    })));
    dlg.replaceChildren(h('div', { class: 'dialog-body' },
      h('h2', { id: 'booking-title', text: `Rate ${name}` }),
      h('p', { class: 'muted', text: 'Your first name and last initial are shown with your review.' }),
      picker,
      h('div', { class: 'field' }, h('label', { for: 'rv-comment', text: 'Comment (optional)' }), comment),
      status,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn btn-primary', type: 'button', text: 'Send review', onclick: async () => {
          if (!stars) return setStatus(status, 'Choose from 1 to 5 stars.', 'error');
          try {
            await api(`/api/me/bookings/${b.id}/reviews`, { method: 'POST', body: { target, rating: stars, comment: comment.value || null } });
            closeDialog(dlg);
            loadMyBookings();
          } catch (err) { setStatus(status, err.message, 'error'); }
        } }),
        h('button', { class: 'btn btn-quiet', type: 'button', text: 'Cancel', onclick: () => closeDialog(dlg) }))));
    showDialog(dlg);
  }

  /** Tell the vinzuu team about a problem with a shop, a garage or a part. what is
   *  { booking_id, target } from "My bookings", or { listing_id } from the search results. */
  function openReportForm(what, name) {
    const dlg = $('booking-dialog');
    const reasons = Object.entries(state.meta.report_reasons || {});
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const details = h('textarea', { id: 'rp-details', maxLength: 500, rows: 4, placeholder: 'What happened? For example: the price at the counter was higher than on Vinzuu.' });
    const list = h('div', { class: 'report-reasons', role: 'radiogroup', 'aria-label': 'What went wrong?' }, ...reasons.map(([key, label], i) => h('label', { class: 'report-reason' },
      h('input', { type: 'radio', name: 'rp-reason', value: key, checked: i === 0 }), h('span', { text: label }))));
    dlg.replaceChildren(h('div', { class: 'dialog-body' },
      h('h2', { id: 'booking-title', text: `Report a problem with ${name}` }),
      h('p', { class: 'muted', text: 'Only the vinzuu team sees this. We check every report and can hide a part or suspend a shop or garage.' }),
      h('fieldset', { class: 'plain-fieldset' }, h('legend', { text: 'What went wrong?' }), list),
      h('div', { class: 'field' }, h('label', { for: 'rp-details', text: 'Tell us more' }), details),
      status,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn btn-primary', type: 'button', text: 'Send report', onclick: async () => {
          const reason = (list.querySelector('input:checked') || {}).value;
          if (reason === 'other' && !details.value.trim()) return setStatus(status, 'Tell us what happened.', 'error');
          try {
            await api('/api/reports', { method: 'POST', body: { ...what, reason, details: details.value || null } });
            dlg.querySelector('.dialog-body').replaceChildren(
              h('h2', { id: 'booking-title', text: 'Thank you' }),
              h('p', { text: 'The vinzuu team will look into it and may call you on your phone number.' }),
              h('div', { class: 'dialog-actions' }, h('button', { class: 'btn btn-primary', type: 'button', text: 'Close', onclick: () => closeDialog(dlg) })));
            if (what.booking_id) loadMyBookings();
          } catch (err) { setStatus(status, err.message, 'error'); }
        } }),
        h('button', { class: 'btn btn-quiet', type: 'button', text: 'Cancel', onclick: () => closeDialog(dlg) }))));
    showDialog(dlg);
  }

  // ---------------------------------------------------------------- a new car: check, details, save

  const STEPS = ['VIN', 'Check', 'Details', 'Save'];
  /** "1 VIN  2 Check  3 Details  4 Save", with the current step marked. */
  function stepper(now) {
    return h('ol', { class: 'stepper' },
      ...STEPS.map((name, i) => h('li', { class: i < now ? 'done' : i === now ? 'now' : null, 'aria-current': i === now ? 'step' : null },
        h('span', { class: 'st-dot', 'aria-hidden': 'true', text: i < now ? '✓' : String(i + 1) }),
        h('span', { class: 'st-name', text: name }))));
  }
  const article = (word) => (/^[AEIOU]/i.test(word) ? 'an' : 'a');

  /**
   * Step 2, vehicle verification. Without the makers' own databases we can't read a whole VIN,
   * but its first three characters name the maker and the country it was built in, and the 10th
   * the model year. So we say what we read and ask. A "no" almost always means a mistyped VIN.
   */
  function showVerify(vin, d) {
    if (isFrame(d)) return showVerifyFrame(vin, d);
    const maker = d && d.maker;
    const year = d && d.model_year;
    const facts = [
      maker ? ['Maker', h('span', { class: 'vv-maker' }, makeLogo(maker, 'vv-logo'), maker), `from "${vin.slice(0, 3)}"`] : null,
      d && d.origin ? ['Built in', d.origin, `from "${vin.slice(0, 3)}"`] : null,
      year ? ['Model year', String(year), `from the 10th character "${vin[9]}"`] : null,
    ].filter(Boolean);
    const vinView = h('p', { class: 'vv-vin', 'aria-label': `VIN ${vin.split('').join(' ')}` },
      h('mark', { class: 'vv-wmi', text: vin.slice(0, 3) }), vin.slice(3, 9), h('mark', { class: 'vv-year', text: vin[9] }), vin.slice(10));
    const model = maker && d.car && sameText(d.car.make, maker) ? ` ${d.car.model}` : '';
    const title = maker
      ? `Is your car ${year ? `a ${year}` : article(maker)} ${maker}${model}?`
      : 'We could not tell the maker from this VIN';
    const yes = h('button', { class: 'btn btn-primary', type: 'button', text: maker ? 'Yes, that\'s my car' : 'My VIN is right, continue', onclick: () => showRegister(vin, d) });
    const recheck = h('button', { class: maker ? 'btn btn-secondary' : 'btn btn-primary', type: 'button', text: maker ? 'No, let me check my VIN' : 'Check my VIN again', onclick: reenter });
    $('confirm').replaceChildren(stepper(1), h('div', { class: 'verify-card' },
      h('p', { class: 'vv-kicker', text: 'Vehicle check' }),
      h('h1', { id: 'confirm-title', class: 'vv-title', text: title }),
      vinView,
      facts.length
        ? h('dl', { class: 'vv-facts' }, ...facts.map(([k, value, from]) => h('div', {},
          h('dt', { text: k }), h('dd', {}, value), h('p', { class: 'vv-from', text: from }))))
        : null,
      h('p', { class: 'vv-help', text: maker
        ? 'If this is not your car, the VIN was probably typed wrong. Check it against your registration card.'
        : 'This usually means a character was typed wrong. If you have checked it and it matches your papers, you can carry on and choose the maker yourself.' }),
      h('div', { class: 'vv-actions' }, maker ? yes : recheck, maker ? recheck : yes)));
    showStep('confirm');
    (maker ? yes : recheck).focus({ preventScroll: true });

    function reenter() {
      showStep('start');
      $('vin').value = vin;
      setStatus($('vin-status'), 'Compare each character with the VIN on your registration card, then search again. 0 and D, 1 and 7, and 8 and B are easy to mix up.');
      $('vin').focus();
      $('vin').select();
    }
  }

  /**
   * Step 2 for a Japanese chassis number. Its model code (NZE121) names the model, generation and
   * engine, so we say what we read and ask. It has no model year; that is asked next.
   */
  function showVerifyFrame(frame, d) {
    const car = d.car;
    const code = d.frame_code || frame.split('-')[0];
    const facts = car ? [
      ['Maker', h('span', { class: 'vv-maker' }, makeLogo(car.make, 'vv-logo'), car.make), `from "${code}"`],
      ['Model', `${car.model}${car.generation ? ` (${car.generation}, ${car.year_start} to ${car.year_end})` : ''}`, `from "${code}"`],
      car.engine ? ['Engine', `${car.engine}${car.engine_code ? ` (${car.engine_code})` : ''}`, `from "${code}"`] : null,
      ['Built for', 'Japan', 'a chassis number instead of a VIN'],
    ].filter(Boolean) : [];
    const title = car ? `Is your car a ${car.make} ${car.model}?` : 'We could not tell the model from this chassis number';
    const yes = h('button', { class: 'btn btn-primary', type: 'button', text: car ? 'Yes, that\'s my car' : 'My number is right, continue', onclick: () => showRegister(frame, d) });
    const recheck = h('button', { class: car ? 'btn btn-secondary' : 'btn btn-primary', type: 'button', text: car ? 'No, let me check the number' : 'Check the number again', onclick: reenter });
    $('confirm').replaceChildren(stepper(1), h('div', { class: 'verify-card' },
      h('p', { class: 'vv-kicker', text: 'Vehicle check' }),
      h('h1', { id: 'confirm-title', class: 'vv-title', text: title }),
      h('p', { class: 'vv-vin', 'aria-label': `Chassis number ${frame.split('').join(' ')}` },
        h('mark', { class: 'vv-wmi', text: code }), frame.slice(code.length)),
      facts.length
        ? h('dl', { class: 'vv-facts' }, ...facts.map(([k, value, from]) => h('div', {},
          h('dt', { text: k }), h('dd', {}, value), h('p', { class: 'vv-from', text: from }))))
        : null,
      h('p', { class: 'vv-help', text: car
        ? 'If this is not your car, the number was probably typed wrong. Check it against your registration card.'
        : 'We know the most common Toyota chassis codes, and this one is not on our list yet. If it matches your papers, carry on and choose the details yourself.' }),
      h('div', { class: 'vv-actions' }, car ? yes : recheck, car ? recheck : yes)));
    showStep('confirm');
    (car ? yes : recheck).focus({ preventScroll: true });

    function reenter() {
      showStep('start');
      $('vin').value = frame;
      setStatus($('vin-status'), 'Compare each character with the chassis number on your registration card, then search again.');
      $('vin').focus();
      $('vin').select();
    }
  }

  function fillSelect(select, items, placeholder) {
    select.replaceChildren(h('option', { value: '', text: placeholder }),
      ...items.map((it) => h('option', { value: it.value, text: it.text })));
  }

  /** A form row. `need` is 'required' or 'optional', shown next to the label. */
  function field(labelText, control, { need, hint, id = control.id } = {}) {
    return h('div', { class: 'field' },
      h('label', { for: id }, labelText, need === 'required' ? h('span', { class: 'need req', text: 'Required' }) : need === 'optional' ? h('span', { class: 'need', text: 'Optional' }) : null),
      control, hint ? h('p', { class: 'hint', text: hint }) : null);
  }

  /**
   * Step 3, the car's details. What the VIN told us (maker, year, build country) is shown, not
   * asked again. Model, generation and engine decide which part numbers fit, so they are required;
   * the rest is optional. When a saved car or the US decoder knew this VIN's build, it is filled in
   * for the customer to check.
   */
  function showRegister(vin, d) {
    const makes = state.catalog.makes;
    const f = {};
    const vinMaker = d && d.maker ? (findMake(d.maker) || { make: d.maker, models: [] }) : null;
    const vinYear = d && d.model_year;
    const vinOrigin = d && d.origin;

    // Only asked when the VIN didn't say.
    f.makeTiles = vinMaker ? null : makeTiles(makes, (value) => { f.make = value; f.makeOther.hidden = value !== '__other'; syncMake(); });
    f.make = vinMaker ? vinMaker.make : '';
    f.makeOther = h('input', { id: 'r-make-other', type: 'text', placeholder: 'Type the make', hidden: true, 'aria-label': 'Make' });
    f.year = h('input', { id: 'r-year', type: 'number', inputMode: 'numeric', min: 1980, max: new Date().getFullYear() + 1, placeholder: 'For example 2018' });
    f.origin = h('select', { id: 'r-origin' });
    fillSelect(f.origin, state.meta.origins.map((o) => ({ value: o, text: o })), 'Choose a country');
    if (vinYear) f.year.value = String(vinYear);

    f.model = h('select', { id: 'r-model' });
    f.modelOther = h('input', { id: 'r-model-other', type: 'text', placeholder: 'Type the model', hidden: true, 'aria-label': 'Model name' });
    f.modelHint = h('p', { class: 'hint', hidden: true });
    f.generation = h('select', { id: 'r-generation' });
    f.engineSelect = h('select', { id: 'r-engine' });
    f.engineText = h('input', { id: 'r-engine-text', type: 'text', placeholder: 'For example 2.0L Petrol', hidden: true, 'aria-label': 'Engine' });
    f.transmission = h('select', { id: 'r-trans' });
    fillSelect(f.transmission, [{ value: 'Automatic', text: 'Automatic' }, { value: 'Manual', text: 'Manual' }], 'Not sure');
    f.importSource = h('select', { id: 'r-import' });
    fillSelect(f.importSource, state.meta.import_sources.map((o) => ({ value: o, text: o })), 'Not sure');
    f.mileage = h('input', { id: 'r-mileage', type: 'number', inputMode: 'numeric', min: 0, max: 2000000, step: 1, placeholder: 'For example 84500' });
    f.status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });

    const wrapModel = h('div', { class: 'field' },
      h('label', { for: 'r-model' }, 'Model', h('span', { class: 'need req', text: 'Required' })), f.model, f.modelOther, f.modelHint);
    const wrapGeneration = field('Generation', f.generation, { need: 'required', hint: 'Each generation is a new design with different parts. The years tell them apart.' });
    const wrapEngine = h('div', { class: 'field' },
      h('label', { for: 'r-engine' }, 'Engine', h('span', { class: 'need req', text: 'Required' })), f.engineSelect, f.engineText,
      h('p', { class: 'hint', text: 'Shown on your registration card as the engine size (cc). 1,999 cc is the 2.0L.' }));

    const lineupMake = () => makes.find((m) => m.make === f.make);
    const currentModel = () => { const m = lineupMake(); return m && m.models.find((x) => x.model === f.model.value); };
    const yearNow = () => Number(f.year.value) || null;

    // Models made in the car's year come first, so the list is short.
    function fillModels() {
      const make = lineupMake();
      const keep = f.model.value;
      const year = yearNow();
      const opt = (m) => h('option', { value: m.model, text: m.aka && m.aka.length ? `${m.model} (${m.aka.slice(0, 2).join(', ')})` : m.model });
      const models = make ? make.models : [];
      const madeThen = year ? models.filter((m) => m.generations.some((g) => year >= g.year_start && year <= g.year_end)) : [];
      const others = models.filter((m) => !madeThen.includes(m));
      f.model.replaceChildren(h('option', { value: '', text: 'Choose the model' }),
        ...(madeThen.length
          ? [h('optgroup', { label: `Made in ${year}` }, ...madeThen.map(opt)), h('optgroup', { label: 'Other models' }, ...others.map(opt))]
          : others.map(opt)),
        h('option', { value: '__other', text: 'Other model' }));
      if ([...f.model.options].some((o) => o.value === keep)) f.model.value = keep;
      // A make we have no lineup for: just type the model.
      f.model.hidden = !make;
      if (!make) f.model.value = '__other';
    }
    function syncModel() {
      const model = currentModel();
      f.modelOther.hidden = f.model.value !== '__other';
      // The engine list depends on the model, so it waits until one is chosen.
      wrapEngine.hidden = !!lineupMake() && !f.model.value;
      const gens = model ? model.generations : [];
      wrapGeneration.hidden = gens.length === 0;
      fillSelect(f.generation, gens.map((g) => ({ value: g.generation, text: generationText(g) })), 'Choose the generation');
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
      fillSelect(f.engineSelect, engineOptions(engines), 'Choose the engine');
      if ([...f.engineSelect.options].some((o) => o.value === keep)) f.engineSelect.value = keep;
      pickOnlyChoice(f.engineSelect);
    }
    function syncMake() {
      if (f.makeTiles) f.makeTiles.select(f.make);
      fillModels();
      syncModel();
    }
    f.model.addEventListener('change', syncModel);
    f.year.addEventListener('input', () => { fillModels(); syncModel(); });
    f.generation.addEventListener('change', () => { f.generation.dataset.auto = ''; syncEngines(); });
    syncMake();

    // The build a saved car or the US decoder knew for this VIN, for the customer to check.
    const guess = d && d.car && vinMaker && sameText(d.car.make, vinMaker.make) ? d.car : null;
    let guessNote = null;
    if (guess) {
      const has = (sel, value) => value && [...sel.options].some((o) => o.value === value);
      if (has(f.model, guess.model)) { f.model.value = guess.model; syncModel(); }
      if (has(f.generation, guess.generation)) { f.generation.value = guess.generation; syncEngines(); }
      if (has(f.engineSelect, guess.engine)) f.engineSelect.value = guess.engine;
      if (guess.transmission) f.transmission.value = guess.transmission;
      if (f.model.value === guess.model) {
        guessNote = h('p', { class: 'note-box', role: 'note', text: guess.source === 'vpic'
          ? 'We filled in the model and engine from the makers\' database for this VIN. Please check them.'
          : guess.source === 'frame'
            ? 'We filled in the model and engine from your chassis number. Please check them, and add the model year.'
            : guess.source === 'line'
              ? 'We filled in the model from your VIN. Please check it, and choose the generation and engine if they are empty.'
            : 'We filled in the model and engine from cars already saved with a VIN like yours. Please check them.' });
      }
    }

    const fromVin = [
      vinMaker ? ['Maker', h('span', { class: 'vv-maker' }, makeLogo(vinMaker.make, 'vv-logo'), vinMaker.make)] : null,
      vinYear ? ['Model year', String(vinYear)] : null,
      vinOrigin ? ['Built in', vinOrigin] : null,
    ].filter(Boolean);

    const form = h('form', { class: 'details-form', novalidate: true, onsubmit: onSubmit },
      h('h1', { id: 'register-title', class: 'step-title', text: 'Your car\'s details' }),
      h('p', { class: 'muted', text: 'We need these to find parts that fit. You only fill them in once.' }),
      h('div', { class: 'from-vin' },
        h('div', { class: 'fv-head' }, h('span', { class: 'fv-tag', text: isFrame(d) ? 'From your chassis number' : 'From your VIN' }), h('span', { class: 'fv-vin', text: vin })),
        fromVin.length ? h('dl', { class: 'fv-list' }, ...fromVin.map(([k, value]) => h('div', {}, h('dt', { text: k }), h('dd', {}, value)))) : null),
      guessNote,
      h('fieldset', { class: 'group' },
        h('legend', { text: 'Needed to match parts' }),
        vinMaker ? null : h('div', { class: 'field' }, h('p', { class: 'field-label' }, 'Make', h('span', { class: 'need req', text: 'Required' })), f.makeTiles.el, f.makeOther),
        vinYear ? null : field('Model year', f.year, { need: 'required', hint: 'On your registration card.' }),
        vinOrigin ? null : field('Where was it built?', f.origin, { need: 'required', hint: 'The same model built in Korea and in the USA can need different parts.' }),
        wrapModel, wrapGeneration, wrapEngine),
      h('fieldset', { class: 'group' },
        h('legend', { text: 'Optional' }),
        field('Transmission', f.transmission, { need: 'optional' }),
        field('Imported from', f.importSource, { need: 'optional' }),
        h('div', { class: 'field' },
          h('label', { for: 'r-mileage' }, 'Current mileage', h('span', { class: 'need', text: 'Optional' })),
          h('div', { class: 'unit-input' }, f.mileage, h('span', { text: 'km' })),
          h('p', { class: 'hint', text: 'The number on your odometer. We use it to tell you when oil, filters and brake pads are due.' }))),
      f.status,
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn btn-primary', type: 'submit', text: 'Continue' }),
        h('button', { class: 'btn btn-quiet', type: 'button', text: 'Back', onclick: () => showVerify(vin, d) })));

    function onSubmit(event) {
      event.preventDefault();
      form.querySelectorAll('.field.invalid').forEach((el) => el.classList.remove('invalid'));
      const model = currentModel();
      const car = {
        make: f.make === '__other' ? f.makeOther.value.trim() : f.make,
        model: f.model.value === '__other' || !lineupMake() ? f.modelOther.value.trim() : f.model.value,
        year: yearNow(),
        origin_market: vinOrigin || f.origin.value || null,
        generation: f.generation.value || null,
        engine: (f.engineSelect.hidden ? f.engineText.value.trim() : f.engineSelect.value) || null,
        transmission: f.transmission.value || null,
        import_source: f.importSource.value || null,
        mileage_km: f.mileage.value === '' ? null : Number(f.mileage.value),
      };
      const missing = [
        [!car.make, f.makeTiles && f.makeTiles.el, 'the make'],
        [!car.year, f.year, 'the model year'],
        [!car.origin_market, f.origin, 'where it was built'],
        [!car.model, f.model.hidden ? f.modelOther : f.model, 'the model'],
        [model && model.generations.length && !car.generation, f.generation, 'the generation'],
        [!car.engine && !wrapEngine.hidden, f.engineSelect.hidden ? f.engineText : f.engineSelect, 'the engine'],
      ].filter(([isMissing]) => isMissing);
      if (car.mileage_km != null && !(car.mileage_km >= 0 && car.mileage_km <= 2000000)) missing.push([true, f.mileage, 'a mileage between 0 and 2,000,000 km']);
      if (missing.length) {
        for (const [, el] of missing) el && el.closest('.field') && el.closest('.field').classList.add('invalid');
        setStatus(f.status, `Please fill in ${listText(missing.map(([, , what]) => what))}.`, 'error');
        const first = missing[0][1];
        if (first) (first.querySelector ? first.querySelector('input') || first : first).focus();
        return;
      }
      setStatus(f.status, '');
      showReview(vin, car);
    }

    $('register').replaceChildren(stepper(2), form);
    showStep('register');
    // Start where there is something to do.
    const firstEmpty = [!f.model.hidden && !f.model.value ? f.model : null,
      !wrapGeneration.hidden && !f.generation.value ? f.generation : null].find(Boolean);
    if (f.makeTiles) f.makeTiles.focus(); else if (firstEmpty) firstEmpty.focus({ preventScroll: true });
  }

  const listText = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

  /** Step 4: everything once more, then save. Nothing is saved until "Save my car". */
  function showReview(vin, car) {
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const rows = [
      ['Manufacturer', car.make], ['Model', car.model], ['Model year', car.year],
      ['Generation', generationLabel(car)], ['Engine', engineText(car)], ['Fuel', fuelOf(car.engine)],
      ['Built in', car.origin_market], ['Transmission', car.transmission || 'Not given'],
      ['Imported from', car.import_source || 'Not given'],
      ['Mileage', car.mileage_km != null ? kmFmt(car.mileage_km) : 'Not given'], [validVin(vin) ? 'VIN' : 'Chassis number', vin],
    ].filter(([, value]) => value != null && value !== '');
    const save = h('button', { class: 'btn btn-primary', type: 'button', text: 'Save my car', onclick: onSave });
    $('basic').replaceChildren(stepper(3),
      h('div', { class: 'review-card' },
        h('div', { class: 'rv-top' },
          h('div', {}, makeLogo(car.make, 'cc-logo'), h('h1', { id: 'basic-title', class: 'rv-title', text: `${car.make} ${car.model}` }),
            h('p', { class: 'cc-sub', text: [car.year, car.engine].filter(Boolean).join(' · ') })),
          carArt(car)),
        h('dl', { class: 'spec-grid' }, ...rows.map(([k, value]) => h('div', {}, h('dt', { text: k }), h('dd', { text: String(value) }))))),
      h('p', { class: 'muted', text: 'Is everything right? Save it, and from now on we\'ll only show you parts that fit this car.' }),
      status,
      h('div', { class: 'form-actions' },
        save,
        h('button', { class: 'btn btn-quiet', type: 'button', text: 'Change details', onclick: () => showStep('register') })));
    showStep('basic');
    save.focus({ preventScroll: true });

    async function onSave() {
      save.disabled = true;
      setStatus(status, 'Saving your car…');
      try {
        const res = await api('/api/vehicles/register', { method: 'POST', body: { vin, ...car } });
        setStatus(status, '');
        showSaved(res.vehicle);
      } catch (err) {
        save.disabled = false;
        setStatus(status, err.message, 'error');
      }
    }
  }

  /** "Saved." Then home, to the garage. */
  function showSaved(v) {
    const dlg = $('saved-dialog');
    const go = h('button', { class: 'btn btn-primary btn-block', type: 'button', text: 'Go to my garage', onclick: () => {
      closeDialog(dlg);
      if (typeof dlg.close !== 'function') setVehicle(v); // no 'close' event without <dialog> support
    } });
    dlg.replaceChildren(h('div', { class: 'dialog-body saved-body' },
      h('span', { class: 'saved-icon', 'aria-hidden': 'true' }, icon('check')),
      h('h2', { id: 'saved-title', text: 'Saved' }),
      h('p', { text: `Your ${vehicleTitle(v)} is in your garage. Next time, ${state.user ? 'just sign in' : 'just enter your VIN'} and it opens straight away.` }),
      go));
    dlg.addEventListener('close', () => setVehicle(v), { once: true });
    showDialog(dlg);
    go.focus();
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

  /** Which parts fit this car and who stocks them (GET /api/parts/for-vehicle). */
  async function loadFits() {
    const id = state.vehicle.id;
    let fits = null;
    try { fits = (await api(`/api/parts/for-vehicle?vehicle_id=${enc(id)}`)).categories; } catch (err) { /* list every part instead */ }
    if (!state.vehicle || state.vehicle.id !== id) return; // another car was opened meanwhile
    state.fits = fits;
    renderPartList();
    renderInspection();
  }
  const fitFor = (name) => (state.fits ? state.fits.find((c) => c.name === name) : null);

  const FIT_TAGS = {
    exact: ['fits', 'Fits your car'],
    relaxed: ['close', 'Close match, check engine'],
    universal: ['std', 'Standard size'],
  };
  const SHOWN = 6;

  /**
   * Only the parts that fit this car: matched to its model, generation, engine and build country,
   * or standard-size parts (oil, wipers, batteries). Anything we can't match yet is tucked away
   * below, and asking for it is noted so we can add it.
   */
  function renderPartList() {
    if (!state.catalog || !state.vehicle) return;
    const terms = $('part-q').value.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
    let cats = state.catalog.categories.map((c) => {
      const hay = `${c.name} ${c.keywords}`.toLowerCase();
      return { c, fit: fitFor(c.name), score: terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0) };
    });
    if (terms.length) cats = cats.filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    const loading = !state.fits;
    // Standard-size parts (oil, bulbs, tyres) fit every car, so they only make the list when a
    // shop has them; otherwise they would bury the parts matched to this car.
    const listed = (x) => x.fit.fit !== 'none' && (x.fit.fit !== 'universal' || x.fit.shops > 0);
    const fitting = cats.filter((x) => loading || listed(x));
    const unmatched = loading ? [] : cats.filter((x) => !listed(x));
    // In stock first, then the closest matches.
    if (!loading) fitting.sort((a, b) => (b.fit.shops > 0) - (a.fit.shops > 0) || (a.fit.fit === 'relaxed') - (b.fit.fit === 'relaxed'));

    const v = state.vehicle;
    $('picker-title').textContent = `Parts that fit your ${v.model}`;
    $('picker-sub').textContent = loading ? 'Matching parts to your car…'
      : `Matched by VIN to your ${v.year} ${v.model}${v.generation ? ` (${v.generation})` : ''}${v.engine ? `, ${v.engine}` : ''}.`;

    const all = $('part-list').classList.contains('show-all') || terms.length > 0;
    const list = $('part-list');
    if (!fitting.length) {
      list.replaceChildren(h('li', { class: 'fit-empty muted', text: terms.length
        ? 'None of the parts that fit your car match that. Try a simpler word, like "brake" or "oil".'
        : 'We have not matched any parts to this car yet. Ask for one below and we\'ll look for it.' }));
    } else {
      list.replaceChildren(...fitting.map(({ c, fit }, i) => h('li', { hidden: !all && i >= SHOWN }, partCard(c, fit))));
    }
    $('all-parts').parentElement.hidden = terms.length > 0 || fitting.length <= SHOWN;

    const box = $('part-unlisted');
    box.replaceChildren(unmatched.length ? h('details', { class: 'unlisted' },
      h('summary', { text: `Can't find your part? ${unmatched.length} more ${unmatched.length === 1 ? 'isn\'t' : 'aren\'t'} matched to your ${v.model} yet` }),
      h('p', { class: 'small muted', text: 'Ask for one and we\'ll note it, so shops know what to stock for your car.' }),
      ...groupBy(unmatched, ({ c }) => c.group || 'Other parts').map(([g, list]) => [
        h('p', { class: 'unlisted-group', text: g }),
        h('div', { class: 'unlisted-list' }, ...list.map(({ c }) => h('button', {
          class: 'chip-btn', type: 'button', 'aria-pressed': String(state.category === c.name), text: c.name, onclick: () => pickCategory(c),
        })))])) : '');
  }

  /** [[key, items], …] in first-seen order. */
  function groupBy(items, keyOf) {
    const m = new Map();
    for (const x of items) { const k = keyOf(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
    return [...m];
  }

  function partCard(c, fit) {
    const tag = fit && FIT_TAGS[fit.fit];
    const stock = !fit ? null : fit.shops > 0
      ? `From ${fmtRwf(fit.from_price_rwf)} · ${fit.shops} ${fit.shops === 1 ? 'shop' : 'shops'}`
      : 'Not in stock right now';
    return h('button', {
      class: `fit-card${fit && !fit.shops ? ' out' : ''}`, type: 'button', 'aria-pressed': String(state.category === c.name),
      onclick: () => pickCategory(c),
    },
    h('span', { class: 'fc-photo' }, PART_PHOTOS[c.name] || (fit && fit.photo)
      ? h('img', { src: PART_PHOTOS[c.name] ? `/img/parts/${PART_PHOTOS[c.name]}` : fit.photo, alt: '', width: 72, height: 72, loading: 'lazy' })
      : h('span', { class: 'pt-initial', 'aria-hidden': 'true', text: c.name.charAt(0) })),
    h('span', { class: 'fc-body' },
      h('span', { class: 'fc-name', text: c.name }),
      stock ? h('span', { class: 'fc-stock', text: stock }) : null,
      tag ? h('span', { class: `fc-tag ${tag[0]}` }, tag[0] === 'fits' ? icon('check') : null, tag[1]) : null),
    h('span', { class: 'fc-go', 'aria-hidden': 'true', text: '›' }));
  }

  /** The first few parts, or all of them. */
  function showAllParts(all) {
    $('part-list').classList.toggle('show-all', all);
    $('all-parts').setAttribute('aria-expanded', String(all));
    $('all-parts').textContent = all ? 'Show fewer parts' : 'View all parts';
    renderPartList();
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
    if (state.query.oe) { q.set('oe_numbers', state.query.oe.join(',')); q.set('vehicle_id', state.vehicle.id); q.set('part_category', state.category); }
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
      h('div', {}, h('div', { class: 'shop', text: l.shop_name }), h('div', { class: 'small muted', text: l.shop_address || '' }),
        l.shop_rating ? h('div', { class: 'shop-rating' }, ratingEl(l.shop_rating, 'shop', l.shop_id, l.shop_name)) : null),
      h('div', { class: 'price' }, rwf.format(l.price_rwf), ' ', h('small', { text: 'RWF' })),
      h('div', { class: 'meta', text: `${l.distance_km} km away, ${l.condition === 'genuine' ? 'genuine part' : 'aftermarket part'}, ${l.in_stock} in stock` }),
      h('div', { class: 'meta', text: [detail, l.brand ? `Brand: ${l.brand}` : null, l.warranty_months ? `${l.warranty_months}-month warranty` : null].filter(Boolean).join(' · ') }),
      fits ? h('div', { class: 'meta', text: fits }) : null,
      l.description ? h('p', { class: 'result-desc', text: l.description }) : null,
      h('div', { class: 'badge-row' }, badgeEl(l.badge)),
      h('div', { class: 'actions' },
        wa ? h('a', { class: 'btn btn-secondary btn-small', href: wa, target: '_blank', rel: 'noopener', text: 'WhatsApp the shop' }) : null,
        h('a', { class: 'btn btn-secondary btn-small', href: `tel:${l.shop_phone}`, text: 'Call' }),
        h('button', { class: 'btn btn-primary btn-small', type: 'button', text: 'Book installation', onclick: () => openBooking(l) }),
        state.user ? h('button', { class: 'link-btn small result-report', type: 'button', text: 'Report this part', onclick: () => openReportForm({ listing_id: l.listing_id }, `${l.part_category} at ${l.shop_name}`) }) : null));
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

    // Each garage shows its rating and, when it has one, its fixed labour price for this part.
    const labour = (g) => (g.services || []).find((s) => s.part_category === listing.part_category);
    const garageChoices = garages.map((g, i) => h('label', { class: 'garage-option' },
      h('input', { type: 'radio', name: 'garage', value: String(g.id), checked: i === 0 }),
      h('span', {}, h('strong', { text: g.name }),
        g.rating && g.rating.count ? h('span', { class: 'sub go-rating' }, starsEl(g.rating.average), ` ${g.rating.average} (${g.rating.count})`) : null,
        h('span', { class: 'small muted sub', text: `${g.distance_km} km away. ${g.specialties || ''}` }),
        labour(g) ? h('span', { class: 'sub go-price' }, `Fitting: ${fmtRwf(labour(g).price_rwf)}`,
          h('span', { class: 'muted', text: ` · total with the part ${fmtRwf(labour(g).price_rwf + listing.price_rwf)}` })) : null)));

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
        loadMyBookings();
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
