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
