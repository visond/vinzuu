/* Homepage: VIN finder, popular-parts marquee, garages near you, and the sign in / create
   account popup. Uses helpers from common.js. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const validVin = (v) => /^[A-HJ-NPR-Z0-9]{17}$/.test(v); // I, O, Q are never used in a real VIN
  // Cars built for Japan have a chassis (frame) number instead, like NZE121-3123456.
  const validFrame = (v) => /^[A-Z]{2,5}\d{2,3}[A-Z]?\d{5,8}$/.test(v) && v.length <= 14;
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
    if (!validVin(vin) && !validFrame(vin)) {
      status.textContent = vin
        ? 'A VIN has exactly 17 letters and numbers (never I, O or Q). A car built for Japan may have a chassis number instead, like NZE121-3123456.'
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
    if (validVin(vin) || validFrame(vin)) q.set('vin', vin); // already typed above? carry it over
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
  // garageCard() is in common.js: the garage page shows the same cards.

  async function loadGarages(coords) {
    const grid = $('garage-grid');
    const q = new URLSearchParams({ radius_km: 'any' });
    if (coords) { q.set('lat', coords.latitude.toFixed(5)); q.set('lon', coords.longitude.toFixed(5)); }
    try {
      const { garages } = await api(`/api/garages/nearby?${q}`);
      grid.replaceChildren(...(garages.length
        ? garages.slice(0, 6).map((g, i) => garageCard(g, i))
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
    // Google's button was drawn while the popup was closed (no width to measure, so 400px, wider
    // than a phone's popup). Redraw it now that it can be measured.
    requestAnimationFrame(() => renderGoogleButton());
    // Start on the heading rather than the first button, so the close X doesn't open highlighted.
    $('auth-head').focus({ preventScroll: true });
  }
  function closeAuthDialog() {
    if (typeof authDialog.close === 'function') authDialog.close(); else authDialog.removeAttribute('open');
  }
  $('open-auth')?.addEventListener('click', showAuthDialog);
  $('auth-dialog-close')?.addEventListener('click', closeAuthDialog);
  // Tapping the dimmed area outside the popup closes it: handled for every dialog in common.js.
  if (location.hash === '#auth-card') {
    history.replaceState(null, '', location.pathname);
    showAuthDialog();
  }

  // ---------------------------------------------------------------- sign in <-> create account
  // One form at a time; the link under each form swaps to the other, and the heading follows.

  const signinForm = $('signin-form');
  const signupForm = $('signup-form');
  const HEADINGS = {
    signin: ['Welcome back', 'Sign in to save your cars and track your bookings.'],
    signup: ['Create your account', 'Register to save your cars and book garages on Vinzuu.'],
  };

  function showForm(which) {
    const isIn = which === 'signin';
    signinForm.hidden = !isIn;
    signupForm.hidden = isIn;
    [$('auth-head').textContent, $('auth-sub').textContent] = HEADINGS[which];
    // Our own Google button until Google's replaces it (then the label is gone and Google's is redrawn).
    const googleLabel = $('google-label');
    if (googleLabel) googleLabel.textContent = isIn ? 'Continue with Google' : 'Sign up with Google';
    renderGoogleButton();
    setStatus($('signin-status'), '');
    setStatus($('signup-status'), '');
    (isIn ? $('si-email') : $('su-name')).focus({ preventScroll: true });
  }
  $('to-signup').addEventListener('click', () => showForm('signup'));
  $('to-signin').addEventListener('click', () => showForm('signin'));

  // Show / hide password. The icon is static markup, so innerHTML is safe here.
  const EYE_OPEN = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.7"/></svg>';
  const EYE_SHUT = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.8 0 3.3-.5 4.6-1.2M9.9 9.9a3 3 0 0 0 4.2 4.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  document.querySelectorAll('#auth-dialog .eye').forEach((eye) => {
    const input = $(eye.dataset.for);
    eye.innerHTML = EYE_OPEN;
    eye.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      eye.innerHTML = show ? EYE_SHUT : EYE_OPEN;
      eye.setAttribute('aria-pressed', String(show));
      eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  });

  // Errors from the Google button show under whichever form is on screen.
  function oauthStatus(message) {
    setStatus(signinForm.hidden ? $('signup-status') : $('signin-status'), message, 'error');
  }

  // Each account has its own home: customers their garage, shops and garages Vinzuu Sellers &
  // Garages, admins the admin console.
  function afterSignIn(res) { location.href = (res && res.user && res.user.home) || '/index.html'; }

  api('/api/meta').then((meta) => {
    $('demo-banner').hidden = !meta.demo;
    // Demo data only: a one-tap way in, since nobody visiting has a demo car's VIN to hand.
    if (meta.demo_vin) {
      $('hs-demo-link').href = `/index.html?vin=${encodeURIComponent(meta.demo_vin)}`;
      $('hs-demo').hidden = false;
    }
  }).catch(() => {});

  // ---------------------------------------------------------------- email sign in / sign up

  signinForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = $('signin-status');
    setStatus(status, 'Signing in…');
    try {
      afterSignIn(await api('/api/auth/login', { method: 'POST', body: { email: $('si-email').value, password: $('si-password').value } }));
    } catch (err) { setStatus(status, err.message, 'error'); }
  });

  // Same rule the server enforces; checked here too so people see the problem before sending.
  function passwordProblem(password) {
    const missing = [];
    if (password.length < 8) missing.push('at least 8 characters');
    if (!/[A-Z]/.test(password)) missing.push('an uppercase letter');
    if (!/[0-9]/.test(password)) missing.push('a number');
    if (!/[^A-Za-z0-9]/.test(password)) missing.push('a special character');
    return missing.length ? `Your password needs ${missing.join(', ')}.` : null;
  }

  signupForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = $('signup-status');
    const password = $('su-password').value;
    const problem = passwordProblem(password)
      || (password !== $('su-password2').value ? 'The two passwords do not match.' : null);
    if (problem) { setStatus(status, problem, 'error'); return; }
    setStatus(status, 'Creating your account…');
    try {
      afterSignIn(await api('/api/auth/signup', {
        method: 'POST',
        body: { name: $('su-name').value, email: $('su-email').value, phone: $('su-phone').value, password },
      }));
    } catch (err) { setStatus(status, err.message, 'error'); }
  });

  // ---------------------------------------------------------------- Google
  // The button is always on screen. Until the server reports a client id, it just says Google
  // isn't available yet. Once configured, Google's own button (styled to match) replaces ours,
  // because Google only allows sign-in through its button.

  let googleReady = false;
  // 'checking' until the server answers, then 'off' (no client id), 'loading' or 'failed'
  // (Google's script could not be reached). Each says something different when tapped, so a
  // slow or blocked Google script is never mistaken for "not set up".
  let googleState = 'checking';
  const GOOGLE_MESSAGES = {
    checking: 'Google sign-in is still loading. Try again in a moment.',
    loading: 'Google sign-in is still loading. Try again in a moment.',
    off: 'Google sign-in is not available yet. Please use your email for now.',
    failed: 'We could not reach Google. Check your connection (or any ad blocker), reload the page, or use your email.',
  };
  $('google-fallback').addEventListener('click', () => oauthStatus(GOOGLE_MESSAGES[googleState]));

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.defer = true;
      s.onload = resolve; s.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(s);
    });
  }

  async function setupGoogle(clientId) {
    googleState = 'loading';
    try {
      await loadScript('https://accounts.google.com/gsi/client');
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async (response) => {
          try {
            afterSignIn(await api('/api/auth/google', { method: 'POST', body: { id_token: response.credential } }));
          } catch (err) { oauthStatus(err.message); }
        },
      });
      googleReady = true;
      renderGoogleButton();
    } catch (err) { googleState = 'failed'; /* the email form below still works */ }
  }

  // Draw (or redraw) Google's own button, saying "Sign up with Google" on the create-account form.
  function renderGoogleButton() {
    if (!googleReady) return;
    const slot = $('google-btn');
    const measured = Math.round(slot.getBoundingClientRect().width);
    if (!measured) return; // popup closed: drawn when it opens
    const width = Math.min(400, measured);
    slot.replaceChildren();
    window.google.accounts.id.renderButton(slot, {
      theme: 'outline', size: 'large', shape: 'rectangular', width, logo_alignment: 'center',
      text: signupForm.hidden ? 'continue_with' : 'signup_with',
    });
  }

  api('/api/auth/config').then((cfg) => {
    if (cfg.google) setupGoogle(cfg.google_client_id);
    else googleState = 'off';
  }).catch(() => { googleState = 'failed'; });
})();
