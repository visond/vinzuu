/* "Sell on vinzuu": a parts shop or garage applies to join Vinzuu Sellers & Garages. Nothing it
   sends is shown to customers; the vinzuu team checks it first, then the owner signs in. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const photos = { cert: null, front: null };
  let coords = null;

  const kind = () => (document.querySelector('input[name="kind"]:checked') || {}).value;
  function syncKind() { $('ap-spec-wrap').hidden = kind() === 'shop'; }
  document.querySelectorAll('input[name="kind"]').forEach((r) => r.addEventListener('change', syncKind));
  // /sell.html?kind=garage opens with "A garage" chosen.
  const asked = new URLSearchParams(location.search).get('kind');
  if (['shop', 'garage', 'both'].includes(asked)) document.querySelector(`input[name="kind"][value="${asked}"]`).checked = true;
  syncKind();

  $('ap-tin').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/[^\d ]/g, ''); });

  $('ap-locate').addEventListener('click', () => {
    if (!navigator.geolocation) { $('ap-loc-text').textContent = 'This phone cannot share its location. Type it below instead.'; return; }
    $('ap-loc-text').textContent = 'Finding your location…';
    navigator.geolocation.getCurrentPosition((pos) => {
      coords = { lat: Number(pos.coords.latitude.toFixed(5)), lon: Number(pos.coords.longitude.toFixed(5)) };
      $('ap-lat').value = coords.lat;
      $('ap-lon').value = coords.lon;
      $('ap-loc-text').textContent = `Location saved: ${coords.lat}, ${coords.lon}`;
    }, () => {
      $('ap-loc-text').textContent = 'We could not get your location. Allow it in your browser, or type it below.';
      document.querySelector('.loc-manual').open = true;
    }, { timeout: 10000, enableHighAccuracy: true });
  });

  for (const [key, input, preview] of [['cert', 'ap-cert', 'ap-cert-preview'], ['front', 'ap-front', 'ap-front-preview']]) {
    $(input).addEventListener('change', async (e) => {
      photos[key] = null;
      $(preview).hidden = true;
      const file = e.target.files[0];
      if (!file) return;
      try {
        // The certificate needs its small print readable, so it keeps more pixels.
        photos[key] = await resizeImage(file, key === 'cert' ? 1100 : 800);
        $(preview).src = photos[key];
        $(preview).hidden = false;
      } catch (err) { setStatus($('apply-status'), err.message, 'error'); }
    });
  }

  function passwordProblem(password) {
    const missing = [];
    if (password.length < 8) missing.push('at least 8 characters');
    if (!/[A-Z]/.test(password)) missing.push('an uppercase letter');
    if (!/[0-9]/.test(password)) missing.push('a number');
    if (!/[^A-Za-z0-9]/.test(password)) missing.push('a special character');
    return missing.length ? `Your password needs ${missing.join(', ')}.` : null;
  }

  $('apply-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = $('apply-status');
    const val = (id) => $(id).value.trim();
    const problems = [
      [!val('ap-name'), 'ap-name', 'Enter your business name.'],
      [!/^\d{9}$/.test(val('ap-tin').replace(/\s/g, '')), 'ap-tin', 'Enter the 9-digit TIN from your RDB certificate.'],
      [!val('ap-address'), 'ap-address', 'Enter your address or area.'],
      [!val('ap-lat') || !val('ap-lon'), 'ap-locate', 'Add where your business is on the map.'],
      [!photos.cert, 'ap-cert', 'Add a photo of your RDB certificate.'],
      [!photos.front, 'ap-front', 'Add a photo of your shop or garage front.'],
      [!val('ap-owner'), 'ap-owner', 'Enter your full name.'],
      [!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val('ap-email')), 'ap-email', 'Enter a valid email address.'],
      [!val('ap-phone'), 'ap-phone', 'Enter your phone number.'],
      [!!passwordProblem($('ap-pass').value), 'ap-pass', passwordProblem($('ap-pass').value)],
      [$('ap-pass').value !== $('ap-pass2').value, 'ap-pass2', 'The two passwords do not match.'],
      [!$('ap-agree').checked, 'ap-agree', 'Tick the box to confirm the documents are yours.'],
    ].find(([bad]) => bad);
    if (problems) {
      setStatus(status, problems[2], 'error');
      $(problems[1]).focus();
      return;
    }
    setStatus(status, 'Sending your application…');
    try {
      await api('/api/business/apply', { method: 'POST', body: {
        kind: kind(), business_name: val('ap-name'), tin: val('ap-tin'), address_text: val('ap-address'),
        latitude: Number(val('ap-lat')), longitude: Number(val('ap-lon')),
        specialties: kind() === 'shop' ? null : val('ap-spec') || null,
        certificate_photo: photos.cert, front_photo: photos.front,
        owner_name: val('ap-owner'), email: val('ap-email'), phone: val('ap-phone'),
        whatsapp_number: val('ap-wa') || null, password: $('ap-pass').value, note: val('ap-note') || null,
      } });
      $('apply-form').hidden = true;
      $('apply-done').hidden = false;
      $('apply-done').focus();
      $('apply-done').scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (err) { setStatus(status, err.message, 'error'); }
  });
})();
