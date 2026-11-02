// LostLink server: zero dependencies. Needs Node 22.5+ (built-in SQLite). Run: node server.js
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { qrSvg } = require('./qr.js');

const PORT = +process.env.PORT || 3000;
const STAFF_PIN = process.env.STAFF_PIN || '1234';
const SCHOOL = process.env.SCHOOL_NAME || 'Your School';
const HOSTED = !!(process.env.NODE_ENV === 'production' || process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME);
if (HOSTED && !process.env.STAFF_PIN) { console.error('Set a STAFF_PIN environment variable before running online (the default PIN is public).'); process.exit(1); }
const DATA_DIR = process.env.DATA_DIR || __dirname;      // point this at a persistent disk when hosting
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'lostlink.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE,
  item_name TEXT NOT NULL, category TEXT, description TEXT, photo TEXT,
  owner_name TEXT NOT NULL, grade_section TEXT, student_no TEXT NOT NULL, contact TEXT,
  status TEXT NOT NULL DEFAULT 'pending',            -- pending | tagged | found | returned
  created_at TEXT DEFAULT (datetime('now')), tagged_at TEXT);
CREATE TABLE IF NOT EXISTS found_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  finder_name TEXT, finder_contact TEXT, location TEXT, note TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`);

const lanIPs = () => Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);
const baseUrl = req => {   // address printed inside QR codes: saved setting > BASE_URL env > the address staff opened > wifi IP
  const saved = db.prepare("SELECT value FROM settings WHERE key='base_url'").get()?.value, h = req?.headers.host;
  const auto = h && !/^(localhost|127\.|\[::1\])/.test(h) ? `${String(req.headers['x-forwarded-proto'] || 'http').split(',')[0]}://${h}` : `http://${lanIPs()[0] || 'localhost'}:${PORT}`;
  return (saved || process.env.BASE_URL || auto).replace(/\/+$/, '');
};
const ref = id => 'LL-' + String(id).padStart(4, '0');
const clip = (s, n) => String(s ?? '').trim().slice(0, n);

const sessions = new Map(), hits = new Map();
const limited = (ip, kind, max, ms) => { const k = kind + ip, now = Date.now(), a = (hits.get(k) || []).filter(t => now - t < ms); a.push(now); hits.set(k, a); return a.length > max; };
const cookie = req => /(?:^|; )ll=([^;]+)/.exec(req.headers.cookie || '')?.[1];
const isStaff = req => sessions.has(cookie(req));

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const send = (res, code, body, type = 'application/json', extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readJson = req => new Promise((ok, bad) => { let n = 0; const c = []; req.on('data', d => { n += d.length; if (n > 2e6) { bad(new Error('too big')); req.destroy(); } else c.push(d); }); req.on('end', () => { try { ok(JSON.parse(Buffer.concat(c) || '{}')); } catch { bad(new Error('bad json')); } }); });
const page = (res, name) => send(res, 200, fs.readFileSync(path.join(__dirname, 'public', name)), MIME['.html']);

const STATUSES = ['pending', 'tagged', 'found', 'returned'];
const staffItem = r => ({ ...r, ref: ref(r.id), has_photo: !!r.photo, photo: undefined });

async function api(req, res, url) {
  const m = req.method, p = url.pathname, ip = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress;   // behind a host's proxy, use the real visitor IP
  let a;

  // ---- students
  if (m === 'POST' && p === '/api/register') {
    if (limited(ip, 'reg', 20, 3600e3)) return send(res, 429, { error: 'Too many registrations. Try again later.' });
    const b = await readJson(req);
    const d = { item_name: clip(b.item_name, 80), category: clip(b.category, 40), description: clip(b.description, 500), owner_name: clip(b.owner_name, 80),
      grade_section: clip(b.grade_section, 40), student_no: clip(b.student_no, 30), contact: clip(b.contact, 60) };
    const photo = typeof b.photo === 'string' && b.photo.startsWith('data:image/') && b.photo.length < 1.5e6 ? b.photo : null;
    if (!d.item_name || !d.owner_name || !d.student_no || !d.contact) return send(res, 400, { error: 'Fill in the item name, your name, student number, and contact number.' });
    const r = db.prepare('INSERT INTO items (item_name,category,description,photo,owner_name,grade_section,student_no,contact) VALUES (?,?,?,?,?,?,?,?)')
      .run(d.item_name, d.category, d.description, photo, d.owner_name, d.grade_section, d.student_no, d.contact);
    return send(res, 200, { ref: ref(r.lastInsertRowid) });
  }
  if (m === 'POST' && p === '/api/check') {
    if (limited(ip, 'chk', 30, 600e3)) return send(res, 429, { error: 'Too many tries. Wait a few minutes.' });
    const b = await readJson(req), id = parseInt(String(b.ref || '').replace(/\D/g, ''), 10);
    const it = db.prepare('SELECT * FROM items WHERE id=? AND student_no=?').get(id || 0, clip(b.student_no, 30));
    if (!it) return send(res, 404, { error: 'No match. Check your reference code and student number.' });
    const reports = db.prepare('SELECT location, note, created_at FROM found_reports WHERE item_id=? ORDER BY id DESC').all(it.id);
    return send(res, 200, { ref: ref(it.id), item_name: it.item_name, status: it.status, reports });
  }

  // ---- public scan
  if ((a = /^\/api\/public\/item\/([\w-]{6,32})(\/found)?$/.exec(p))) {
    const it = db.prepare("SELECT * FROM items WHERE token=? AND status!='pending'").get(a[1]);
    if (!it) return send(res, 404, { error: 'This tag is not registered.' });
    if (m === 'GET' && !a[2]) return send(res, 200, { school: SCHOOL, item_name: it.item_name, category: it.category, description: it.description, photo: it.photo,
      owner_name: it.owner_name, grade_section: it.grade_section, status: it.status });
    if (m === 'POST' && a[2]) {
      if (limited(ip, 'fnd', 10, 3600e3)) return send(res, 429, { error: 'Too many reports. Try again later.' });
      const b = await readJson(req);
      db.prepare('INSERT INTO found_reports (item_id,finder_name,finder_contact,location,note) VALUES (?,?,?,?,?)').run(it.id, clip(b.finder_name, 80), clip(b.finder_contact, 60), clip(b.location, 120), clip(b.note, 300));
      if (it.status === 'tagged') db.prepare("UPDATE items SET status='found' WHERE id=?").run(it.id);
      return send(res, 200, { ok: true });
    }
  }

  // ---- staff
  if (m === 'POST' && p === '/api/staff/login') {
    if (limited(ip, 'pin', 8, 600e3)) return send(res, 429, { error: 'Too many attempts. Wait 10 minutes.' });
    const b = await readJson(req);
    const ok = crypto.timingSafeEqual(crypto.createHash('sha256').update(String(b.pin)).digest(), crypto.createHash('sha256').update(STAFF_PIN).digest());
    if (!ok) return send(res, 401, { error: 'Wrong PIN.' });
    const t = crypto.randomBytes(24).toString('base64url'); sessions.set(t, Date.now());
    return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': `ll=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}` });
  }
  if (!p.startsWith('/api/staff/')) return send(res, 404, { error: 'Not found' });
  if (!isStaff(req)) return send(res, 401, { error: 'Staff login required.' });

  if (m === 'POST' && p === '/api/staff/logout') { sessions.delete(cookie(req)); return send(res, 200, { ok: true }); }
  if (m === 'GET' && p === '/api/staff/items') {
    const rows = db.prepare(`SELECT i.*, (SELECT COUNT(*) FROM found_reports f WHERE f.item_id=i.id) AS reports FROM items i ORDER BY (i.status='found') DESC, (i.status='pending') DESC, i.id DESC`).all();
    return send(res, 200, { base_url: baseUrl(req), site_qr: qrSvg(baseUrl(req), { px: 5 }), items: rows.map(staffItem) });
  }
  if (m === 'POST' && p === '/api/staff/settings') {
    const b = await readJson(req), u = clip(b.base_url, 120);
    if (!/^https?:\/\/[\w.\-]+(:\d+)?$/.test(u)) return send(res, 400, { error: 'Use a format like http://192.168.1.10:3000' });
    db.prepare("INSERT INTO settings (key,value) VALUES ('base_url',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(u);
    return send(res, 200, { base_url: baseUrl(req) });
  }
  if ((a = /^\/api\/staff\/items\/(\d+)(?:\/(\w+))?(?:\.svg)?$/.exec(p))) {
    const id = +a[1], it = db.prepare('SELECT * FROM items WHERE id=?').get(id);
    if (!it) return send(res, 404, { error: 'Item not found.' });
    const act = a[2];
    if (m === 'GET' && !act) {
      const reports = db.prepare('SELECT * FROM found_reports WHERE item_id=? ORDER BY id DESC').all(id);
      return send(res, 200, { ...staffItem(it), photo: it.photo, reports, qr: it.token ? qrSvg(`${baseUrl(req)}/i/${it.token}`, { px: 6 }) : null, url: it.token ? `${baseUrl(req)}/i/${it.token}` : null, school: SCHOOL });
    }
    if (m === 'POST' && act === 'issue') {     // verify + create the QR tied to this student
      if (!it.token) { db.prepare("UPDATE items SET token=?, status='tagged', tagged_at=datetime('now') WHERE id=?").run(crypto.randomBytes(8).toString('base64url'), id); }
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && act === 'status') {
      const b = await readJson(req); if (!STATUSES.includes(b.status) || (b.status !== 'pending' && !it.token)) return send(res, 400, { error: 'Invalid status.' });
      db.prepare('UPDATE items SET status=? WHERE id=?').run(b.status, id); return send(res, 200, { ok: true });
    }
    if (m === 'DELETE' && !act) { db.prepare('DELETE FROM items WHERE id=?').run(id); return send(res, 200, { ok: true }); }
  }
  return send(res, 404, { error: 'Not found' });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    if (p.startsWith('/api/')) return await api(req, res, url);
    if (/^\/i\/[\w-]+$/.test(p)) return page(res, 'scan.html');
    const routes = { '/': 'index.html', '/register': 'register.html', '/check': 'check.html', '/scan': 'scanner.html', '/staff': 'staff.html', '/print': 'print.html' };
    if (routes[p]) return page(res, routes[p]);
    const f = path.join(__dirname, 'public', path.basename(p));
    if (/^\/[\w.-]+\.(css|js|svg)$/.test(p) && fs.existsSync(f)) return send(res, 200, fs.readFileSync(f), MIME[path.extname(f)]);
    send(res, 404, 'Not found', 'text/plain');
  } catch (e) { send(res, 400, { error: e.message }); }
}).listen(PORT, '0.0.0.0', () => {
  console.log('\nLostLink is running.\n  This computer:  http://localhost:' + PORT);
  lanIPs().forEach(ip => console.log(`  On your wifi:   http://${ip}:${PORT}   <- phones on the same wifi open this`));
  if (process.env.OPEN_APP) {   // open the staff screen in its own app-style window
    const u = `http://localhost:${PORT}/staff`, { spawn } = require('node:child_process');
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', `start "" msedge --app=${u} || start "" ${u}`], { windowsVerbatimArguments: true }]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [u], {}];
    try { spawn(cmd[0], cmd[1], { ...cmd[2], detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch {}
  }
  console.log(`  Staff page:     /staff   (PIN: ${STAFF_PIN === '1234' ? '1234 - change it with STAFF_PIN=yourpin' : 'set'})\n`);
});
