const $ = (s, r = document) => r.querySelector(s);
async function api(path, body, method) {
  const r = await fetch(path, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.error || 'Something went wrong.'), { status: r.status }); return j;
}
function show(el, text, kind) { el.textContent = text; el.className = 'msg ' + kind + (text ? '' : ' hidden'); }
function when(s) { return new Date(s.replace(' ', 'T') + 'Z').toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
function resizePhoto(file, max = 800) {   // shrink phone photos before upload
  return new Promise((ok, bad) => { const img = new Image(); img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
    c.width = img.width * k; c.height = img.height * k; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); ok(c.toDataURL('image/jpeg', .72)); }; img.onerror = () => bad(new Error('Could not read that photo.')); img.src = URL.createObjectURL(file); });
}
const STATUS_TEXT = { pending: 'Waiting for staff', tagged: 'QR issued', found: 'Someone found it', returned: 'Returned to owner' };
function header(active) {
  document.body.insertAdjacentHTML('afterbegin', `<header class="top"><a class="logo" href="/">Lost<b>Link</b></a><nav><a href="/scan">Scan</a><a href="/register">Register</a><a href="/check">Check</a><a href="/staff">Staff</a></nav></header>`);
}
