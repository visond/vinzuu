/* Homepage: VIN finder, popular-parts marquee, garages near you, and the sign in / create
   account popup. Uses helpers from common.js. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const validVin = (v) => /^[A-HJ-NPR-Z0-9]{17}$/.test(v); // I, O, Q are never used in a real VIN
  const normalizeVin = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  // (The nav hamburger toggle lives in common.js, since About and Contact use the same nav
  // but don't load this file, which also wires up the sign-in form.)

  // ---------------------------------------------------------------- VIN finder
  // No account needed: this jumps straight to the finder with the VIN pre-filled.
  // VIN is the only thing that finds a car anywhere on the site -- see customer.js.

  const heroSearch = $('hero-search');
  const heroVinInput = $('hs-vin');
  const vinCount = $('hs-count');
  function updateVinCount() {
    const n = heroVinInput.value.length;
    vinCount.textContent = `${n} / 17`;
    vinCount.classList.toggle('done', n === 17 && validVin(heroVinInput.value));
  }
  heroVinInput.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    $('hs-status').hidden = true;
    updateVinCount();
  });
  heroSearch.addEventListener('submit', (event) => {
    event.preventDefault();
    const vin = normalizeVin(heroVinInput.value);
    const status = $('hs-status');
    if (!validVin(vin)) {
      status.textContent = vin
        ? 'A VIN has exactly 17 letters and numbers (never I, O or Q). Check it and try again.'
        : 'Type your 17-character VIN first.';
      status.hidden = false;
      heroVinInput.focus();
      return;
    }
    status.hidden = true;
    location.href = `/index.html?vin=${encodeURIComponent(vin)}`;
  });
  $('vin-use-example').addEventListener('click', () => {
    heroVinInput.value = 'JTMBK31V996054321';
    $('hs-status').hidden = true;
    updateVinCount();
    heroVinInput.focus();
  });

  // ---------------------------------------------------------------- popular parts marquee
  // Names match the part categories in db.js exactly, so "Shop now" can open that part
  // straight away on the finder once the car is known.

  // [category, image]. The card shows only the part's name.
  const PARTS = [
    ['Front Bumper', 'front-bumper.jpg'],
    ['Headlight Assembly', 'headlight.jpg'],
    ['Front Brake Pad', 'brake-disc.jpg'],
    ['Oil Filter', 'oil-filter.jpg'],
    ['Air Filter', 'air-filter.jpg'],
    ['Battery', 'battery.jpg'],
    ['Wiper Blade', 'wiper-blade.jpg'],
    ['Engine Oil', 'engine-oil.jpg'],
  ];

  function shopNowHref(part) {
    const q = new URLSearchParams({ part });
    const vin = normalizeVin(heroVinInput.value);
    if (validVin(vin)) q.set('vin', vin); // already typed above? carry it over
    return `/index.html?${q}`;
  }

  function partCard([name, img], copy) {
    const link = h('a', { class: 'btn btn-primary', href: `/index.html?part=${encodeURIComponent(name)}`, text: 'Shop now' });
    link.addEventListener('click', () => { link.href = shopNowHref(name); });
    return h('li', { class: 'part-card', 'aria-hidden': copy ? 'true' : null, inert: copy || null },
      h('div', { class: 'pc-photo' },
        h('img', { src: `/img/parts/${img}`, alt: '', width: 220, height: 154, loading: 'lazy' })),
      h('div', { class: 'pc-body' },
        h('h3', { text: name }),
        link));
  }
  // The second copy only exists so the loop is seamless; screen readers and Tab skip it.
  $('parts-track').replaceChildren(...PARTS.map((p) => partCard(p, false)), ...PARTS.map((p) => partCard(p, true)));
  // Phones have no hover: a touch pauses the strip so the card under the finger holds still,
  // and it starts moving again a few seconds after the last touch.
  const marquee = $('parts-marquee');
  let resumeTimer = null;
  marquee.addEventListener('pointerdown', () => {
    marquee.classList.add('paused');
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => marquee.classList.remove('paused'), 4000);
  });

  // ---------------------------------------------------------------- garages near you
  // Photos are placeholders until garages upload their own: they are assigned in order.
  const GARAGE_PHOTOS = ['/img/garages/garage-1.jpg', '/img/garages/garage-2.jpg', '/img/garages/garage-3.jpg', '/img/garages/garage-4.jpg'];
  const ICON_PIN = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="9.5" r="2.5" stroke="currentColor" stroke-width="2"/></svg>';
  const ICON_CAL = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2" stroke="currentColor" stroke-width="2"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const icon = (svg) => { const s = document.createElement('span'); s.innerHTML = svg; return s.firstChild; }; // fixed markup above, never server data

  function garageCard(g, i) {
    const digits = String(g.whatsapp || g.phone || '').replace(/\D/g, '');
    const bookHref = digits
      ? `https://wa.me/${digits}?text=${encodeURIComponent(`Hello ${g.name}, I found your garage on Vinzuu and would like to book a repair.`)}`
      : `tel:${g.phone}`;
    const mapHref = `https://www.google.com/maps/search/?api=1&query=${g.latitude},${g.longitude}`;
    const tags = String(g.specialties || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 3);
    return h('article', { class: 'garage-card' },
      h('div', { class: 'gc-photo' },
        h('img', { src: GARAGE_PHOTOS[i % GARAGE_PHOTOS.length], alt: '', loading: 'lazy', width: 400, height: 250 }),
        h('span', { class: 'gc-distance', text: `${g.distance_km} km` })),
      h('div', { class: 'gc-body' },
        h('h3', { text: g.name }),
        h('p', { class: 'gc-address' }, icon(ICON_PIN), g.address || 'Kigali'),
        tags.length ? h('ul', { class: 'gc-tags' }, ...tags.map((t) => h('li', { text: t }))) : null,
        h('div', { class: 'gc-actions' },
          h('a', { class: 'btn btn-primary', href: bookHref, target: '_blank', rel: 'noopener' }, icon(ICON_CAL), 'Book now'),
          h('a', { class: 'btn', href: mapHref, target: '_blank', rel: 'noopener', 'aria-label': `Location of ${g.name} on the map` }, icon(ICON_PIN), 'Location'))));
  }

  async function loadGarages(coords) {
    const grid = $('garage-grid');
    const q = new URLSearchParams({ radius_km: 'any' });
    if (coords) { q.set('lat', coords.latitude.toFixed(5)); q.set('lon', coords.longitude.toFixed(5)); }
    try {
      const { garages } = await api(`/api/garages/nearby?${q}`);
      grid.replaceChildren(...(garages.length
        ? garages.slice(0, 6).map(garageCard)
        : [h('p', { class: 'muted', text: 'No garages are listed yet. Check back soon.' })]));
    } catch (err) {
      grid.replaceChildren(h('p', { class: 'muted', text: 'We could not load garages right now. Refresh the page to try again.' }));
    }
  }
  loadGarages(null);

  const locateBtn = $('garages-locate');
  if (!('geolocation' in navigator)) locateBtn.hidden = true;
  locateBtn.addEventListener('click', () => {
    const origin = $('garages-origin');
    origin.textContent = 'Finding where you are…';
    locateBtn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        origin.textContent = 'Distances from where you are now.';
        locateBtn.disabled = false;
        loadGarages(pos.coords);
      },
      () => {
        origin.textContent = "We couldn't get your location, so distances are from Kigali city centre.";
        locateBtn.disabled = false;
      },
      { timeout: 10000, maximumAge: 300000 });
  });

  // ---------------------------------------------------------------- sign-in popup
  // Sign in / create account lives in a small dialog opened from the nav button only -- not a
  // big section in the middle of the homepage. About/Contact link here with #auth-card in the
  // URL (they don't load this file), so that hash is also honoured on arrival.

  const authDialog = $('auth-dialog');
  function showAuthDialog() {
    if (typeof authDialog.showModal === 'function') { if (!authDialog.open) authDialog.showModal(); }
    else authDialog.setAttribute('open', '');
  }
  function closeAuthDialog() {
    if (typeof authDialog.close === 'function') authDialog.close(); else authDialog.removeAttribute('open');
  }
  $('open-auth')?.addEventListener('click', showAuthDialog);
  $('auth-dialog-close')?.addEventListener('click', closeAuthDialog);
  // Tapping or clicking the dimmed area around the card dismisses it. Taps on the backdrop land on
  // the <dialog> itself, so check the point is outside its box. Only close when the press also
  // started outside, so dragging to select text in a field and releasing past the edge won't close it.
  function outsideDialog(event) {
    if (event.target !== authDialog) return false;
    const r = authDialog.getBoundingClientRect();
    return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
  }
  let pressedOutside = false;
  authDialog.addEventListener('pointerdown', (event) => { pressedOutside = outsideDialog(event); });
  authDialog.addEventListener('click', (event) => {
    if (pressedOutside && outsideDialog(event)) closeAuthDialog();
    pressedOutside = false;
  });
  if (location.hash === '#auth-card') {
    history.replaceState(null, '', location.pathname);
    showAuthDialog();
  }

  // ---------------------------------------------------------------- tabs

  const signinForm = $('signin-form');
  const signupForm = $('signup-form');
  const tabSignin = $('tab-signin');
  const tabSignup = $('tab-signup');

  function showTab(which) {
    const isIn = which === 'signin';
    signinForm.hidden = !isIn;
    signupForm.hidden = isIn;
    tabSignin.setAttribute('aria-selected', String(isIn));
    tabSignup.setAttribute('aria-selected', String(!isIn));
    (isIn ? $('si-email') : $('su-name')).focus({ preventScroll: true });
  }
  tabSignin.addEventListener('click', () => showTab('signin'));
  tabSignup.addEventListener('click', () => showTab('signup'));

  function afterSignIn() { location.href = '/index.html'; }

  // If already signed in, skip straight to the app rather than showing the form again.
  api('/api/meta').then((meta) => {
    $('demo-banner').hidden = !meta.demo;
    // Demo data only: a one-tap way in, since nobody visiting has a demo car's VIN to hand.
    if (meta.demo_vin) {
      $('hs-demo-link').href = `/index.html?vin=${encodeURIComponent(meta.demo_vin)}`;
      $('hs-demo').hidden = false;
    }
  }).catch(() => {});
  api('/api/auth/me').then((r) => { if (r.user) afterSignIn(); }).catch(() => {});

  // ---------------------------------------------------------------- email sign in / sign up

  signinForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = $('signin-status');
    setStatus(status, 'Signing in…');
    try {
      await api('/api/auth/login', { method: 'POST', body: { email: $('si-email').value, password: $('si-password').value } });
      afterSignIn();
    } catch (err) { setStatus(status, err.message, 'error'); }
  });

  signupForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = $('signup-status');
    setStatus(status, 'Creating your account…');
    try {
      await api('/api/auth/signup', {
        method: 'POST',
        body: { name: $('su-name').value, email: $('su-email').value, password: $('su-password').value },
      });
      afterSignIn();
    } catch (err) { setStatus(status, err.message, 'error'); }
  });

  // ---------------------------------------------------------------- optional Google / Apple
  // These stay hidden until the server reports a client id is configured, so the page looks
  // deliberate (email-only) rather than broken when nobody has set them up yet.

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.defer = true;
      s.onload = resolve; s.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(s);
    });
  }

  async function setupGoogle(clientId) {
    try {
      await loadScript('https://accounts.google.com/gsi/client');
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async (response) => {
          try {
            await api('/api/auth/google', { method: 'POST', body: { id_token: response.credential } });
            afterSignIn();
          } catch (err) { setStatus($('signin-status'), err.message, 'error'); }
        },
      });
      window.google.accounts.id.renderButton($('google-btn'), { theme: 'outline', size: 'large', width: 320, text: 'continue_with' });
    } catch (err) { /* offline or blocked: the email form below still works */ }
  }

  async function setupApple(clientId, redirectURI) {
    try {
      await loadScript('https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js');
      window.AppleID.auth.init({ clientId, scope: 'name email', redirectURI: redirectURI || location.origin, usePopup: true });
      const btn = $('apple-btn');
      btn.hidden = false;
      btn.addEventListener('click', async () => {
        try {
          const result = await window.AppleID.auth.signIn();
          const name = result.user && result.user.name ? `${result.user.name.firstName} ${result.user.name.lastName}` : null;
          await api('/api/auth/apple', { method: 'POST', body: { id_token: result.authorization.id_token, name } });
          afterSignIn();
        } catch (err) { setStatus($('signin-status'), 'Apple sign-in did not complete. Please try again or use email.', 'error'); }
      });
    } catch (err) { /* offline or blocked */ }
  }

  api('/api/auth/config').then((cfg) => {
    if (!cfg.google && !cfg.apple) return; // keep the page to email only until one is configured
    $('oauth-buttons').hidden = false;
    document.querySelector('.divider').hidden = false;
    if (cfg.google) setupGoogle(cfg.google_client_id);
    if (cfg.apple) setupApple(cfg.apple_client_id, cfg.apple_redirect_uri);
  }).catch(() => {});
})();
