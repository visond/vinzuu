/* Shop console. A shop signs in with its access code, lists parts, and keeps price and stock current. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const CODE_KEY = 'kpf.shopcode';

  let code = store.get(CODE_KEY, 'sessionStorage');
  let shop = null;
  let catalog = null;
  let meta = null;
  let photoData = null;

  const authed = () => ({ headers: { 'x-shop-code': code } });

  init();

  async function init() {
    try {
      meta = await api('/api/meta');
      $('demo-banner').hidden = !meta.demo;
    } catch (err) { /* the banner is optional */ }
    $('login-form').addEventListener('submit', onLogin);
    $('sign-out').addEventListener('click', signOut);
    if (code) await login(code, true);
  }

  function onLogin(event) {
    event.preventDefault();
    const value = $('code').value.trim();
    if (!value) return setStatus($('login-status'), 'Enter your shop access code.', 'error');
    login(value);
  }

  async function login(value, quiet) {
    setStatus($('login-status'), quiet ? '' : 'Checking…');
    try {
      code = value;
      const res = await api('/api/shop/me', authed());
      shop = res.shop;
      store.set(CODE_KEY, code, 'sessionStorage');
      catalog = await api('/api/catalog');
      showConsole();
    } catch (err) {
      code = null;
      store.remove(CODE_KEY, 'sessionStorage');
      setStatus($('login-status'), err.status === 401 ? 'That code is not right. Check it with the platform team.' : err.message, 'error');
    }
  }

  function signOut() {
    store.remove(CODE_KEY, 'sessionStorage');
    location.reload();
  }

  // ---------------------------------------------------------------- console shell

  function showConsole() {
    $('login').hidden = true;
    $('console').hidden = false;
    $('shop-name').textContent = shop.name;
    $('shop-vetted').textContent = shop.vetted
      ? 'Vetted by the platform team. Your genuine parts can earn the Verified Genuine label.'
      : 'Not vetted yet. Ask the platform team to vet your shop so your genuine parts can earn the Verified Genuine label.';

    const tabs = [['lookup', 'Look up a car'], ['add', 'Add a part'], ['parts', 'My parts'], ['bookings', 'Booking requests']];
    $('tabs').replaceChildren(...tabs.map(([key, label]) => h('button', {
      type: 'button', role: 'tab', id: `tabbtn-${key}`, 'aria-selected': String(key === 'lookup'), text: label,
      onclick: () => showTab(key),
    })));

    initLookup();
    fillCategories();
    $('a-cat').addEventListener('change', onCategoryChange);
    $('a-photo').addEventListener('change', onPhoto);
    $('add-form').addEventListener('submit', onAdd);
    showTab('lookup');
  }

  function showTab(key) {
    for (const k of ['lookup', 'add', 'parts', 'bookings']) {
      $(`tab-${k}`).hidden = k !== key;
      $(`tabbtn-${k}`).setAttribute('aria-selected', String(k === key));
    }
    if (key === 'parts') loadParts();
    if (key === 'bookings') loadBookings();
  }

  // ---------------------------------------------------------------- vehicle lookup (VIN-first)

  const normalizePlate = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  function fillSelect(select, items, placeholder) {
    select.replaceChildren(h('option', { value: '', text: placeholder }),
      ...items.map((it) => h('option', { value: it.value, text: it.text })));
  }

  function field(labelText, control, hint) {
    return h('div', { class: 'field' },
      h('label', { for: control.id, text: labelText }), control, hint ? h('p', { class: 'hint', text: hint }) : null);
  }

  function initLookup() {
    const mount = $('lookup-mount');
    const vin = h('input', {
      id: 'lk-vin', type: 'text', maxLength: 17, autocomplete: 'off', autocapitalize: 'characters',
      placeholder: '17-character VIN',
      oninput: (e) => { e.target.value = e.target.value.toUpperCase().replace(/\s/g, ''); },
    });
    const plate = h('input', {
      id: 'lk-plate', type: 'text', autocomplete: 'off', autocapitalize: 'characters', placeholder: 'RAE 123 A',
      oninput: (e) => { e.target.value = e.target.value.toUpperCase(); },
    });
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const resultMount = h('div');

    const form = h('form', { class: 'panel', novalidate: true, onsubmit: onSearch },
      field('VIN (recommended)', vin, 'The one identifier that always points to the same car, even after a plate changes.'),
      field('Plate (if the VIN is not to hand)', plate),
      h('button', { class: 'btn btn-primary', type: 'submit', text: 'Search' }),
      status);
    mount.replaceChildren(form, resultMount);

    async function onSearch(event) {
      event.preventDefault();
      resultMount.replaceChildren();
      const v = vin.value.trim();
      const p = plate.value.trim();
      if (!v && !p) return setStatus(status, 'Enter a VIN or a plate number.', 'error');
      setStatus(status, 'Searching…');
      try {
        let vehicle = await tryFind(v ? `/api/vehicles/by-vin/${enc(v)}` : null);
        if (!vehicle && p) vehicle = await tryFind(`/api/vehicles/${enc(normalizePlate(p))}`);
        setStatus(status, '');
        if (vehicle) showKnownCar(vehicle, resultMount);
        else showRegisterFallback({ vin: v, plate: p }, resultMount, () => onSearch(event));
      } catch (err) {
        setStatus(status, err.message, 'error');
      }
    }

    async function tryFind(path) {
      if (!path) return null;
      try { return (await api(path)).vehicle; }
      catch (err) { if (err.code === 'not_registered') return null; throw err; }
    }
  }

  function showKnownCar(vehicle, mount) {
    const details = [
      vehicle.generation, vehicle.engine, vehicle.transmission ? vehicle.transmission.toLowerCase() : null,
      vehicle.origin_market ? `built in ${vehicle.origin_market}` : null,
    ].filter(Boolean).join(', ');
    mount.replaceChildren(h('div', { class: 'panel' },
      h('p', { class: 'status ok', text: 'Known car -- nothing to register.' }),
      h('div', { class: 'vehicle-bar' },
        h('span', { class: 'plate plate-sm' },
          h('span', { class: 'plate-strip', 'aria-hidden': 'true' }, 'RW'),
          h('span', { class: 'plate-text', text: formatPlate(vehicle.plate_number) })),
        h('div', { class: 'vehicle-text' },
          h('strong', { text: `${vehicle.year} ${vehicle.make} ${vehicle.model}` }),
          h('span', { text: details || 'No further build details on file yet.' }))),
      h('p', { class: 'small muted', text: vehicle.has_vin ? `VIN on file: ${vehicle.vin_masked}` : 'No VIN on file for this car yet -- search its plate and re-save with the VIN to add one.' })));
  }

  /** The VIN (or plate) search above found nothing. Rather than send the garage elsewhere, this
   *  registers the car on the spot -- the same Algorithm A endpoint the customer app uses, so the
   *  car instantly becomes searchable by VIN from any entry point afterwards. */
  function showRegisterFallback(prefill, mount, onRegistered) {
    const makes = catalog.makes;
    const f = {};
    f.vin = h('input', { id: 'lk-r-vin', type: 'text', maxLength: 17, autocomplete: 'off', autocapitalize: 'characters', value: prefill.vin || '' });
    f.plate = h('input', { id: 'lk-r-plate', type: 'text', autocomplete: 'off', autocapitalize: 'characters', value: prefill.plate || '' });
    f.make = h('select', { id: 'lk-r-make' });
    fillSelect(f.make, [...makes.map((m) => ({ value: m.make, text: m.make })), { value: '__other', text: 'Other make' }], 'Choose the make');
    f.makeOther = h('input', { id: 'lk-r-make-other', type: 'text', placeholder: 'Type the make', hidden: true, 'aria-label': 'Make' });
    f.model = h('select', { id: 'lk-r-model', hidden: true });
    f.modelOther = h('input', { id: 'lk-r-model-other', type: 'text', placeholder: 'Type the model', hidden: true, 'aria-label': 'Model' });
    f.year = h('input', { id: 'lk-r-year', type: 'number', inputMode: 'numeric', min: 1980, max: new Date().getFullYear() + 1 });
    f.generation = h('select', { id: 'lk-r-gen' });
    f.engineSelect = h('select', { id: 'lk-r-engine' });
    f.engineText = h('input', { id: 'lk-r-engine-text', type: 'text', placeholder: 'For example 2.0L Diesel', hidden: true, 'aria-label': 'Engine' });
    f.origin = h('select', { id: 'lk-r-origin' });
    fillSelect(f.origin, (meta && meta.origins ? meta.origins : []).map((o) => ({ value: o, text: o })), 'Not sure');
    f.status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });

    const wrapModel = h('div', { class: 'field', hidden: true }, h('label', { for: 'lk-r-model', text: 'Model' }), f.model, f.modelOther);
    const wrapGen = field('Generation (optional)', f.generation, 'Leave as "Not sure" if you do not know it.');
    const wrapEngine = h('div', { class: 'field', hidden: true }, h('label', { for: 'lk-r-engine', text: 'Engine' }), f.engineSelect, f.engineText);

    const currentMake = () => makes.find((m) => m.make === f.make.value);
    const currentModel = () => { const m = currentMake(); return m && m.models.find((x) => x.model === f.model.value); };
    function syncModel() {
      const model = currentModel();
      f.modelOther.hidden = !(f.make.value === '__other' || f.model.value === '__other');
      wrapEngine.hidden = !(f.make.value === '__other' || f.model.value);
      const gens = model ? model.generations : [];
      wrapGen.hidden = gens.length === 0;
      fillSelect(f.generation, gens.map((g) => ({ value: g.generation, text: `${g.generation} (${g.year_start} to ${g.year_end})` })), 'Not sure');
      const engines = model ? model.engines : [];
      f.engineSelect.hidden = engines.length === 0;
      f.engineText.hidden = engines.length !== 0;
      fillSelect(f.engineSelect, engines.map((e) => ({ value: e, text: e })), 'Not sure');
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
    syncMake();

    const form = h('form', { class: 'panel', novalidate: true, onsubmit: onSubmit },
      h('h3', { text: 'Not on file yet -- register it now' }),
      h('p', { class: 'muted small', text: 'This takes a minute, and the car is then searchable by VIN from any entry point afterwards.' }),
      field('Plate', f.plate, 'As shown on the car, for example RAE 123 A.'),
      field('VIN (recommended)', f.vin, '17 characters. The letters I, O and Q are never used.'),
      h('div', { class: 'field' }, h('label', { for: 'lk-r-make', text: 'Make' }), f.make, f.makeOther),
      wrapModel, field('Year', f.year), wrapGen, wrapEngine,
      field('Where was it built?', f.origin),
      h('button', { class: 'btn btn-primary', type: 'submit', text: 'Register car' }),
      f.status);
    mount.replaceChildren(form);

    async function onSubmit(event) {
      event.preventDefault();
      const make = f.make.value === '__other' ? f.makeOther.value.trim() : f.make.value;
      const model = (f.make.value === '__other' || f.model.value === '__other') ? f.modelOther.value.trim() : f.model.value;
      if (!f.plate.value.trim()) return setStatus(f.status, 'Enter the plate number.', 'error');
      if (!make || !model) return setStatus(f.status, 'Choose the make and the model.', 'error');
      if (!f.year.value) return setStatus(f.status, 'Enter the year.', 'error');
      setStatus(f.status, 'Registering…');
      try {
        await api('/api/vehicles/register', {
          ...authed(), method: 'POST',
          body: {
            plate_number: f.plate.value, vin: f.vin.value || null, make, model, year: Number(f.year.value),
            generation: f.generation.value || null,
            engine: (f.engineSelect.hidden ? f.engineText.value : f.engineSelect.value) || null,
            origin_market: f.origin.value || null,
          },
        });
        setStatus(f.status, 'Registered.', 'ok');
        if (onRegistered) onRegistered();
      } catch (err) {
        setStatus(f.status, err.message, 'error');
      }
    }
  }

  // ---------------------------------------------------------------- add a part

  function fillCategories() {
    $('a-cat').replaceChildren(
      h('option', { value: '', text: 'Choose a part' }),
      ...catalog.categories.map((c) => h('option', { value: c.name, text: c.name })));
  }

  const categoryByName = (name) => catalog.categories.find((c) => c.name === name);

  async function onCategoryChange() {
    const cat = categoryByName($('a-cat').value);
    $('a-oe-wrap').hidden = !cat || cat.type !== 'model_specific';
    $('a-spec-wrap').hidden = !cat || cat.type !== 'universal';
    if (!cat || cat.type !== 'model_specific') return;
    setStatus($('add-status'), 'Loading part numbers…');
    try {
      const data = await api(`/api/shop/oe-numbers?part_category=${enc(cat.name)}`, authed());
      $('a-oe').replaceChildren(
        h('option', { value: '', text: data.rows.length ? 'Choose the part number' : 'No part numbers yet for this part' }),
        ...data.rows.map((r) => h('option', {
          value: r.oe_number,
          text: `${r.oe_number}: ${r.make} ${r.model}${r.generation ? ` ${r.generation}` : ''}, ${r.year_start} to ${r.year_end}` +
            `${r.engine ? `, ${r.engine}` : ''}${r.origin_market ? `, ${r.origin_market}-built` : ''}`,
        })));
      setStatus($('add-status'), '');
    } catch (err) { setStatus($('add-status'), err.message, 'error'); }
  }

  async function onPhoto(event) {
    const file = event.target.files[0];
    photoData = null;
    $('a-preview').hidden = true;
    if (!file) return;
    try {
      photoData = await resizeImage(file);
      $('a-preview').src = photoData;
      $('a-preview').hidden = false;
      setStatus($('add-status'), '');
    } catch (err) { setStatus($('add-status'), err.message, 'error'); }
  }

  async function onAdd(event) {
    event.preventDefault();
    const status = $('add-status');
    const cat = categoryByName($('a-cat').value);
    if (!cat) return setStatus(status, 'Choose which part you are listing.', 'error');
    if (cat.type === 'model_specific' && !$('a-oe').value) return setStatus(status, 'Choose the part number.', 'error');
    if (cat.type === 'universal' && !$('a-spec').value.trim()) return setStatus(status, 'Enter the size or specification.', 'error');
    if (!$('a-price').value) return setStatus(status, 'Enter the price in RWF.', 'error');
    if (!photoData) return setStatus(status, 'Add a photo of the part. Customers only see parts with a photo.', 'error');

    setStatus(status, 'Adding…');
    try {
      await api(`/api/shops/${shop.id}/listings`, {
        ...authed(), method: 'POST',
        body: {
          part_category: cat.name,
          oe_number: cat.type === 'model_specific' ? $('a-oe').value : null,
          universal_spec: cat.type === 'universal' ? $('a-spec').value : null,
          condition: $('a-condition').value, price_rwf: Number($('a-price').value),
          stock_quantity: Number($('a-stock').value || 0), photo_url: photoData,
        },
      });
      $('add-form').reset();
      $('a-oe-wrap').hidden = true;
      $('a-spec-wrap').hidden = true;
      $('a-preview').hidden = true;
      photoData = null;
      setStatus(status, 'Added. Customers can see it now.', 'ok');
    } catch (err) { setStatus(status, err.message, 'error'); }
  }

  // ---------------------------------------------------------------- my parts

  async function loadParts() {
    const mount = $('parts-mount');
    mount.replaceChildren(h('p', { class: 'muted', text: 'Loading…' }));
    try {
      const { listings } = await api(`/api/shops/${shop.id}/listings`, authed());
      if (!listings.length) {
        mount.replaceChildren(h('p', { class: 'empty', text: 'You have not added any parts yet. Use "Add a part" to list your first one.' }));
        return;
      }
      const rows = listings.map(partRow);
      mount.replaceChildren(h('div', { class: 'table-scroll' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, ...['Photo', 'Part', 'Price (RWF)', 'In stock', 'Type', ''].map((t) => h('th', { text: t })))),
        h('tbody', {}, ...rows))));
    } catch (err) { mount.replaceChildren(h('p', { class: 'status error', text: err.message })); }
  }

  function partRow(l) {
    const price = h('input', { type: 'number', inputMode: 'numeric', min: 1, value: l.price_rwf, 'aria-label': `Price for ${l.part_category}` });
    const stock = h('input', { type: 'number', inputMode: 'numeric', min: 0, value: l.stock_quantity, 'aria-label': `Stock for ${l.part_category}` });
    const cond = h('select', { 'aria-label': `Type for ${l.part_category}` },
      h('option', { value: 'genuine', text: 'Genuine', selected: l.condition === 'genuine' }),
      h('option', { value: 'aftermarket', text: 'Aftermarket', selected: l.condition === 'aftermarket' }));
    const msg = h('span', { class: 'small', role: 'status' });
    const save = h('button', { class: 'btn btn-secondary btn-small', type: 'button', text: 'Save', onclick: async () => {
      msg.textContent = 'Saving…';
      try {
        await api(`/api/shops/${shop.id}/listings/${l.id}`, {
          ...authed(), method: 'PUT',
          body: { price_rwf: Number(price.value), stock_quantity: Number(stock.value), condition: cond.value },
        });
        msg.textContent = 'Saved';
      } catch (err) { msg.textContent = err.message; }
    } });
    return h('tr', {},
      h('td', {}, h('img', { class: 'thumb', src: l.photo_url, alt: '' })),
      h('td', {}, h('strong', { text: l.part_category }), h('br'), h('span', { class: 'small muted', text: l.oe_number || l.universal_spec })),
      h('td', {}, price), h('td', {}, stock), h('td', {}, cond),
      h('td', {}, save, ' ', msg));
  }

  // ---------------------------------------------------------------- booking requests

  async function loadBookings() {
    const mount = $('bookings-mount');
    mount.replaceChildren(h('p', { class: 'muted', text: 'Loading…' }));
    try {
      const { bookings } = await api(`/api/shops/${shop.id}/bookings`, authed());
      if (!bookings.length) {
        mount.replaceChildren(h('p', { class: 'empty', text: 'No requests yet. When a customer books an installation for one of your parts, it shows up here.' }));
        return;
      }
      const rows = bookings.map((b) => h('tr', {},
        h('td', { text: b.created_at }),
        h('td', {}, h('strong', { text: `${b.year} ${b.make} ${b.model}` }), h('br'), h('span', { class: 'small muted', text: `Plate ${b.plate_number}` })),
        h('td', { text: `${b.part_category}, ${fmtRwf(b.price_rwf)}` }),
        h('td', {}, h('a', { href: whatsappLink(b.customer_phone, `Hello, about your request on Vinzuu for ${b.part_category}.`), target: '_blank', rel: 'noopener', text: b.customer_phone })),
        h('td', { text: b.note || '' })));
      mount.replaceChildren(h('div', { class: 'table-scroll' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, ...['When', 'Car', 'Part', 'Customer', 'Note'].map((t) => h('th', { text: t })))),
        h('tbody', {}, ...rows))));
    } catch (err) { mount.replaceChildren(h('p', { class: 'status error', text: err.message })); }
  }
})();
