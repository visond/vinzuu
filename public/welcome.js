/* Welcome page: the animated road is pure decoration (built once below); everything else is
   the sign in / create account flow. Uses helpers from common.js. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- the moving-cars road
  // Two simple side-profile silhouettes, alternated. Each lane's track is duplicated once so
  // its content is exactly double width; the CSS animation then shifts it by precisely -50%,
  // which loops seamlessly no matter how many cars are in a lane.
  const CAR_SVGS = [
    '<svg class="car" viewBox="0 0 64 24" aria-hidden="true"><path d="M3 18 Q3 10 13 9 L19 9 Q23 3 33 3 L41 9 L53 9 Q59 9 59 15 L59 18 Z" fill="currentColor"/><circle cx="15" cy="19" r="4" fill="#0A1420"/><circle cx="47" cy="19" r="4" fill="#0A1420"/><rect class="headlight" x="57" y="12" width="3" height="3" rx="1"/></svg>',
    '<svg class="car" viewBox="0 0 64 24" aria-hidden="true"><path d="M2 18 Q2 7 12 7 L17 7 Q20 2 30 2 L38 2 Q42 7 48 7 L54 7 Q60 7 60 15 L60 18 Z" fill="currentColor"/><circle cx="14" cy="19" r="4" fill="#0A1420"/><circle cx="48" cy="19" r="4" fill="#0A1420"/><rect class="headlight" x="58" y="12" width="3" height="3" rx="1"/></svg>',
  ];
  document.querySelectorAll('.car-track').forEach((track, laneIndex) => {
    let html = '';
    for (let i = 0; i < 4; i++) html += CAR_SVGS[(i + laneIndex) % 2];
    track.innerHTML = html + html;
  });

  // (The nav hamburger toggle lives in common.js, since About and Contact use the same nav
  // but don't load this file, which also wires up the sign-in form.)

  // ---------------------------------------------------------------- hero VIN quick-search
  // No account needed: this jumps straight to the finder with the VIN pre-filled, same as
  // the "Continue without an account" link, just the primary action instead of a quiet footnote.
  // VIN is the only thing that finds a car anywhere on the site -- see customer.js.

  const heroSearch = $('hero-search');
  if (heroSearch) {
    const heroVinInput = $('hs-vin');
    heroVinInput.addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/\s/g, ''); });
    heroSearch.addEventListener('submit', (event) => {
      event.preventDefault();
      const vin = heroVinInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!vin) { heroVinInput.focus(); return; }
      location.href = `/index.html?vin=${encodeURIComponent(vin)}`;
    });
  }

  // ---------------------------------------------------------------- sign-in popup
  // Sign in / create account lives in a small dialog opened from the nav button only -- not a
  // big section in the middle of the homepage. About/Contact link here with #auth-card in the
  // URL (they don't load this file), so that hash is also honoured on arrival.

  const authDialog = $('auth-dialog');
  function showAuthDialog() {
    if (typeof authDialog.showModal === 'function') { if (!authDialog.open) authDialog.showModal(); }
    else authDialog.setAttribute('open', '');
    // Start on the heading rather than the first button, so the close X doesn't open highlighted.
    $('auth-head').focus({ preventScroll: true });
  }
  function closeAuthDialog() {
    if (typeof authDialog.close === 'function') authDialog.close(); else authDialog.removeAttribute('open');
  }
  $('open-auth')?.addEventListener('click', showAuthDialog);
  $('auth-dialog-close')?.addEventListener('click', closeAuthDialog);
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
    signup: ['Create your account', 'Save your cars once and book garages faster next time.'],
  };

  function showForm(which) {
    const isIn = which === 'signin';
    signinForm.hidden = !isIn;
    signupForm.hidden = isIn;
    [$('auth-head').textContent, $('auth-sub').textContent] = HEADINGS[which];
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

  // Errors from the Google / Apple buttons show under whichever form is on screen.
  function oauthStatus(message) {
    setStatus(signinForm.hidden ? $('signup-status') : $('signin-status'), message, 'error');
  }

  function afterSignIn() { location.href = '/index.html'; }

  // If already signed in, skip straight to the app rather than showing the form again.
  api('/api/meta').then((meta) => { $('demo-banner').hidden = !meta.demo; }).catch(() => {});
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

  // ---------------------------------------------------------------- Google / Apple
  // Both buttons are always on screen. Until the server reports a client id for one, its button
  // just says that option isn't available yet. Once Google is configured, Google's own button
  // (styled to match) replaces ours, because Google only allows sign-in through its button.

  const NOT_READY = {
    google: 'Google sign-in is not available yet. Please use your email for now.',
    apple: 'Apple sign-in is not available yet. Please use your email for now.',
  };
  let appleReady = false;
  $('google-fallback').addEventListener('click', () => oauthStatus(NOT_READY.google));
  $('apple-btn').addEventListener('click', async () => {
    if (!appleReady) { oauthStatus(NOT_READY.apple); return; }
    try {
      const result = await window.AppleID.auth.signIn();
      const name = result.user && result.user.name ? `${result.user.name.firstName} ${result.user.name.lastName}` : null;
      await api('/api/auth/apple', { method: 'POST', body: { id_token: result.authorization.id_token, name } });
      afterSignIn();
    } catch (err) { oauthStatus('Apple sign-in did not complete. Please try again or use email.'); }
  });

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
          } catch (err) { oauthStatus(err.message); }
        },
      });
      const slot = $('google-btn');
      const width = Math.min(400, Math.round(slot.getBoundingClientRect().width) || 400);
      slot.replaceChildren();
      window.google.accounts.id.renderButton(slot, { theme: 'outline', size: 'large', shape: 'rectangular', width, text: 'continue_with', logo_alignment: 'center' });
    } catch (err) { /* offline or blocked: the email form below still works */ }
  }

  async function setupApple(clientId, redirectURI) {
    try {
      await loadScript('https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js');
      window.AppleID.auth.init({ clientId, scope: 'name email', redirectURI: redirectURI || location.origin, usePopup: true });
      appleReady = true;
    } catch (err) { /* offline or blocked: the button keeps saying it isn't available */ }
  }

  api('/api/auth/config').then((cfg) => {
    if (cfg.google) setupGoogle(cfg.google_client_id);
    if (cfg.apple) setupApple(cfg.apple_client_id, cfg.apple_redirect_uri);
  }).catch(() => {});
})();
