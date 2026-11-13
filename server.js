// UFTI: AirDrop-style file/text sharing between devices on the same Wi-Fi.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const Busboy = require('busboy');
const hotspot = require('./hotspot');
const { describe } = require('./netkinds');
const { createAuth } = require('./auth');

const PORT = Number(process.env.PORT) || 8787;
const DATA = process.env.UFTI_DATA || __dirname;
const DIR = path.join(DATA, 'received');
const PUBLIC = path.join(__dirname, 'public');
fs.mkdirSync(DIR, { recursive: true });

const auth = createAuth({ dataDir: DATA });

// Network addresses this PC can be reached on. `kind` tells the UI which connection mode they belong to
// (PC hotspot, phone hotspot for iPhone or Android, or an ordinary network); see netkinds.js.
function netAddrs() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const i of list || [])
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
        out.push({ ip: i.address, name, ...describe(i.address) });
  return out;
}
let preferredIp = ''; // chosen in the PC window when several networks are available
let hotspotOwned = false; // true only while a hotspot that UFTI itself started is running
function lanIPs() {
  if (process.env.UFTI_HOST) return [process.env.UFTI_HOST]; // manual override (VPN, virtual adapters)
  // Prefer typical home-router ranges first.
  const ips = netAddrs().map(a => a.ip).sort((a, b) => (b.startsWith('192.168.') - a.startsWith('192.168.')));
  return preferredIp && ips.includes(preferredIp) ? [preferredIp, ...ips.filter(i => i !== preferredIp)] : ips;
}

// What phones are sent: the current one-time pairing code.
const pairUrl = ip => `http://${ip}:${PORT}/?p=${auth.currentPairing().code}`;
// The PC window signs itself in with its own one-time code, over loopback only.
const localUrl = () => `http://localhost:${PORT}/?p=${auth.bootCode()}`;

// The desktop app registers a function that copies a file to the system clipboard: (filePath, item) => { as: 'image' | 'file' }.
let copyHandler = null;
const setCopyHandler = fn => { copyHandler = fn; };

const isLoopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const cleanName = raw => path.basename(String(raw)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function readBody(req) {
  let body = '';
  for await (const c of req) { body += c; if (body.length > 1e6) break; }
  return body;
}
const sendJSON = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

// ---- live updates to every open page (Server-Sent Events; the pages only ever listen) ----
const streams = new Set(); // { res, sid }
function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const c of streams) c.res.write(data);
}
function closeStreams(sid) {
  for (const c of streams) if (c.sid === sid) { c.res.end(); streams.delete(c); }
}
setInterval(() => { for (const c of streams) c.res.write(': ping\n\n'); }, 20000).unref();

// multipart/form-data upload, as sent by Android share tools (HTTP Shortcuts, Tasker, curl -F ...).
// Every file part becomes a file item; the title, text and url fields become one text item.
function handleMultipart(req, res, device, client) {
  let bb;
  try { bb = Busboy({ headers: req.headers, defParamCharset: 'utf8' }); }
  catch { return sendJSON(res, 400, { error: 'bad multipart body' }); }
  const files = [], writes = [], texts = {};
  let failed = false;
  bb.on('file', (field, stream, info) => {
    if (!info.filename) return stream.resume(); // empty file field
    const name = cleanName(info.filename), id = crypto.randomBytes(4).toString('hex');
    const dest = path.join(DIR, id + '__' + name), out = fs.createWriteStream(dest);
    files.push({ id, name, dest, out });
    writes.push(new Promise(done => { out.on('finish', done); out.on('error', () => { failed = true; done(); }); }));
    stream.pipe(out);
  });
  bb.on('field', (name, value) => { if (['title', 'text', 'url'].includes(name) && value.trim()) texts[name] = value.trim(); });
  bb.on('error', () => { failed = true; });
  bb.on('close', async () => {
    await Promise.all(writes);
    if (failed) { files.forEach(f => fs.unlink(f.dest, () => {})); return sendJSON(res, 400, { error: 'upload failed' }); }
    const added = [];
    for (const f of files) {
      const item = { id: f.id, kind: 'file', name: f.name, size: fs.statSync(f.dest).size, from: device, fromId: client, ts: Date.now() };
      addItem(item); added.push(item);
    }
    const text = ['title', 'text', 'url'].map(k => texts[k]).filter(Boolean).join('\n');
    if (text) {
      const item = { id: crypto.randomBytes(4).toString('hex'), kind: 'text', text: text.slice(0, 100000), from: device, fromId: client, ts: Date.now() };
      addItem(item); added.push(item);
    }
    if (!added.length) return sendJSON(res, 400, { error: 'nothing to save' });
    sendJSON(res, 200, { items: added });
  });
  req.on('aborted', () => files.forEach(f => { f.out.destroy(); fs.unlink(f.dest, () => {}); }));
  req.pipe(bb);
}

// ---- state: transfer history, saved to history.json; files live in received/ ----
// item: {id, kind:'file'|'text', name, size, text, from (device label), fromId (client id), ts}
const HISTORY_FILE = path.join(DATA, 'history.json');
const HISTORY_MAX = 500;
const items = [];
function loadHistory() {
  try {
    const saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    for (const it of saved) {
      // Drop file entries whose file was removed outside the app.
      if (it.kind === 'file' && !fs.existsSync(path.join(DIR, `${it.id}__${it.name}`))) continue;
      items.push(it);
    }
    return;
  } catch {}
  // First run: rebuild the list from files already on disk.
  for (const f of fs.readdirSync(DIR)) {
    const m = f.match(/^([0-9a-f]{8})__(.+)$/);
    if (!m) continue;
    const st = fs.statSync(path.join(DIR, f));
    items.push({ id: m[1], kind: 'file', name: m[2], size: st.size, from: 'earlier', ts: st.mtimeMs });
  }
  items.sort((a, b) => a.ts - b.ts);
}
let saveTimer;
function saveHistory() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(HISTORY_FILE, JSON.stringify(items), () => {}), 200);
}
function addItem(item) {
  items.push(item);
  // Keep the log bounded; deleting the oldest entries also deletes their files.
  while (items.length > HISTORY_MAX) removeItem(items[0].id, true);
  saveHistory();
  broadcast({ type: 'add', item });
}
function removeItem(id, deleteFile) {
  const idx = items.findIndex(i => i.id === id);
  if (idx < 0) return false;
  const [item] = items.splice(idx, 1);
  if (item.kind === 'file' && deleteFile) fs.unlink(path.join(DIR, `${item.id}__${item.name}`), () => {});
  saveHistory();
  broadcast({ type: 'remove', id });
  return true;
}
loadHistory();

// ---- small HTML pages for the pairing flow ----
const PAGE_CSS = 'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F2F5FB;color:#10213F;font:16px/1.4 -apple-system,"Segoe UI",system-ui,sans-serif}' +
  '@media(prefers-color-scheme:dark){body{background:#071226;color:#EAF0FF}.c{background:#0F2145!important;border-color:#1F3568!important}}' +
  '.c{max-width:340px;margin:16px;padding:22px;border:1px solid #DCE3F0;border-radius:16px;background:#fff;border-top:4px solid #F58220}' +
  'h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#5A6B88}';
function page(res, status, title, bodyHtml) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>UFTI</title><style>${PAGE_CSS}</style><div class="c"><h1>${esc(title)}</h1>${bodyHtml}</div>`);
}
const tooMany = (res, wait) => {
  res.writeHead(429, { 'Retry-After': String(wait), 'Content-Type': 'text/plain' });
  res.end(`Too many attempts. Try again in ${wait} seconds.`);
};
const expiredPage = res => page(res, 403, 'Pairing link expired', '<p>This link was already used or has expired. Scan the QR code in the UFTI window on the PC again.</p>');
const paired = (res, result) => {
  res.writeHead(303, { 'Set-Cookie': auth.cookieHeader(result.secret), Location: '/' });
  res.end();
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const loop = isLoopback(req);
  const ip = req.socket.remoteAddress || '';
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Cache-Control', 'no-store');
  try {
    // Requests from the PC itself must be addressed to localhost (guards against DNS rebinding).
    if (loop && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || '')) {
      res.writeHead(421); return res.end('Misdirected request');
    }

    // ---- pairing: one-time code in the QR link becomes a session cookie, then the address is cleaned ----
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('p')) {
      const wait = auth.blockedFor(ip); if (wait) return tooMany(res, wait);
      const code = url.searchParams.get('p');
      const st = auth.peek(code);
      if (!st.ok || (st.kind === 'boot' && !loop)) { auth.fail(ip); return expiredPage(res); }
      return paired(res, auth.consume(code, req.headers['user-agent']));
    }
    // ---- the page itself and its icons are public; everything useful sits behind the API ----
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.normalize(path.join(PUBLIC, rel));
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return fs.createReadStream(file).pipe(res);
    }

    // ---- API: needs a paired device (cookie) or a share key ----
    const wait = auth.blockedFor(ip); if (wait) return tooMany(res, wait);
    const a = auth.authenticate(req, url);
    if (!a.session) {
      if (a.presented) auth.fail(ip); // only wrong credentials count as a failed attempt
      return sendJSON(res, 401, { error: 'not paired' });
    }
    const viaKey = a.via === 'key';
    const p = url.pathname;
    if (viaKey && !(req.method === 'POST' && (p === '/api/upload' || p === '/api/text'))) {
      return sendJSON(res, 403, { error: 'share keys can only send files and text' });
    }
    if (!viaKey && req.method !== 'GET' && req.method !== 'HEAD') { // CSRF: changes must come from our own page
      const origin = req.headers.origin;
      if ((origin && (() => { try { return new URL(origin).host !== req.headers.host; } catch { return true; } })())
          || req.headers['sec-fetch-site'] === 'cross-site') return sendJSON(res, 403, { error: 'cross-site request refused' });
    }
    const sid = a.session.h;
    const pcOnly = () => {
      if (loop && !viaKey) return true;
      sendJSON(res, 403, { error: 'only available in the UFTI window on the PC' });
      return false;
    };

    // live updates
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      const c = { res, sid };
      streams.add(c);
      req.on('close', () => streams.delete(c));
      return;
    }

    // PC window only: connection, hotspot, firewall, pairing, paired devices and share keys
    if (['/api/network', '/api/network/select', '/api/hotspot', '/api/firewall', '/api/pairing', '/api/devices', '/api/keys']
        .includes(p) || p.startsWith('/api/devices/') || p.startsWith('/api/copy/')) {
      if (!pcOnly()) return;

      // Put a received file on this PC's clipboard (the desktop app supplies the handler; see main.js).
      if (req.method === 'POST' && p.startsWith('/api/copy/')) {
        const item = items.find(i => i.id === p.slice('/api/copy/'.length) && i.kind === 'file');
        if (!item) return sendJSON(res, 404, { error: 'gone' });
        if (!copyHandler) return sendJSON(res, 501, { error: 'copy is not available here' });
        try { return sendJSON(res, 200, { ok: true, ...(await copyHandler(path.join(DIR, `${item.id}__${item.name}`), item)) }); }
        catch (e) { return sendJSON(res, 500, { error: String(e.message || e) }); }
      }

      if (req.method === 'GET' && p === '/api/network') {
        const pr = auth.currentPairing();
        const addresses = netAddrs().map(x => ({ ...x, url: pairUrl(x.ip) }));
        return sendJSON(res, 200, { port: PORT, preferred: lanIPs()[0] || '', addresses, expires: pr.expires,
          firewall: await hotspot.firewallRuleExists() });
      }
      if (req.method === 'POST' && p === '/api/network/select') {
        let ip2 = ''; try { ip2 = JSON.parse(await readBody(req)).ip; } catch {}
        if (!netAddrs().some(x => x.ip === ip2)) return sendJSON(res, 400, { error: 'unknown address' });
        preferredIp = ip2;
        return sendJSON(res, 200, { ok: true });
      }
      if (req.method === 'GET' && p === '/api/pairing') {
        const pr = auth.currentPairing();
        return sendJSON(res, 200, { code: pr.code, expires: pr.expires });
      }
      if (req.method === 'GET' && p === '/api/devices') {
        return sendJSON(res, 200, { devices: auth.list().map(d => ({ ...d, current: d.id === sid.slice(0, 12) })) });
      }
      if (req.method === 'DELETE' && p.startsWith('/api/devices/')) {
        const gone = auth.revoke(p.slice('/api/devices/'.length));
        if (!gone) return sendJSON(res, 404, { error: 'not found' });
        closeStreams(gone.h);
        return sendJSON(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/keys') {
        let name = ''; try { name = JSON.parse(await readBody(req)).name; } catch {}
        const k = auth.create('key', name || 'Share key');
        return sendJSON(res, 200, { key: k.secret, id: k.session.h.slice(0, 12), name: k.session.name });
      }
      if (req.method === 'GET' && p === '/api/hotspot') return sendJSON(res, 200, await hotspot.status());
      if (req.method === 'POST' && p === '/api/hotspot') {
        let action = ''; try { action = JSON.parse(await readBody(req)).action; } catch {}
        if (action === 'start') {
          const r = await hotspot.start();
          if (r.ok) hotspotOwned = true;
          if (r.ok) { // Windows needs a moment to assign the hotspot address; then make it the QR default.
            for (let i = 0; i < 10 && !preferredIp.startsWith('192.168.137.'); i++) {
              const x = netAddrs().find(y => y.kind === 'pc-hotspot');
              if (x) preferredIp = x.ip; else await new Promise(s => setTimeout(s, 500));
            }
          }
          return sendJSON(res, 200, r);
        }
        if (action === 'stop') { preferredIp = ''; hotspotOwned = false; return sendJSON(res, 200, await hotspot.stop()); }
        return sendJSON(res, 400, { error: 'unknown action' });
      }
      if (req.method === 'POST' && p === '/api/firewall') return sendJSON(res, 200, await hotspot.allowFirewall(PORT));
    }

    if (req.method === 'GET' && p === '/api/info') {
      return sendJSON(res, 200, { items, host: os.hostname(), me: { id: sid.slice(0, 12), name: a.session.name } });
    }

    if (req.method === 'GET' && p === '/api/qr') {
      const svg = await QRCode.toString(url.searchParams.get('u') || '', { type: 'svg', margin: 1 });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return res.end(svg);
    }

    if (req.method === 'POST' && p === '/api/upload') {
      // Device label and sender id can come as headers or as ?device= and ?client= (some tools can't set headers).
      const device = req.headers['x-device'] || url.searchParams.get('device') || 'device';
      const client = req.headers['x-client'] || url.searchParams.get('client') || '';
      if (/^multipart\/form-data/i.test(req.headers['content-type'] || '')) return handleMultipart(req, res, device, client);
      let raw = req.headers['x-filename'] || url.searchParams.get('name') || 'file';
      try { raw = decodeURIComponent(raw); } catch {}
      const name = cleanName(raw);
      const id = crypto.randomBytes(4).toString('hex');
      const dest = path.join(DIR, `${id}__${name}`);
      const out = fs.createWriteStream(dest);
      req.pipe(out);
      out.on('finish', () => {
        const item = { id, kind: 'file', name, size: fs.statSync(dest).size, from: device, fromId: client, ts: Date.now() };
        addItem(item);
        sendJSON(res, 200, item);
      });
      out.on('error', () => sendJSON(res, 500, { error: 'write failed' }));
      req.on('aborted', () => { out.destroy(); fs.unlink(dest, () => {}); });
      return;
    }

    if (req.method === 'POST' && p === '/api/text') {
      const body = await readBody(req);
      let text = body, from = req.headers['x-device'] || url.searchParams.get('device'), fromId = req.headers['x-client'] || url.searchParams.get('client') || '';
      try { const j = JSON.parse(body); if (j && typeof j.text === 'string') { text = j.text; from = j.from || from; fromId = j.fromId || fromId; } } catch {}
      if (!text.trim()) return sendJSON(res, 400, { error: 'empty' });
      const item = { id: crypto.randomBytes(4).toString('hex'), kind: 'text', text: String(text).slice(0, 100000),
        from: from || 'device', fromId, ts: Date.now() };
      addItem(item);
      return sendJSON(res, 200, item);
    }

    let m;
    if (req.method === 'GET' && (m = p.match(/^\/api\/file\/([0-9a-f]{8})$/))) {
      const item = items.find(i => i.id === m[1] && i.kind === 'file');
      if (!item) { res.writeHead(404); return res.end(); }
      res.writeHead(200, {
        'Content-Length': item.size,
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`,
      });
      return fs.createReadStream(path.join(DIR, `${item.id}__${item.name}`)).pipe(res);
    }

    if (req.method === 'DELETE' && (m = p.match(/^\/api\/item\/([0-9a-f]{8})$/))) {
      return removeItem(m[1], true) ? sendJSON(res, 200, { ok: true }) : sendJSON(res, 404, { error: 'gone' });
    }

    // Clear history entries. Body: { ids: [...], deleteFiles: bool }. Omit ids to clear everything.
    if (req.method === 'POST' && p === '/api/clear') {
      let opts = {};
      try { opts = JSON.parse((await readBody(req)) || '{}'); } catch {}
      const ids = Array.isArray(opts.ids) ? opts.ids : items.map(i => i.id);
      let removed = 0;
      for (const id of ids) if (removeItem(String(id), !!opts.deleteFiles)) removed++;
      return sendJSON(res, 200, { removed });
    }

    sendJSON(res, 404, { error: 'unknown route' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJSON(res, 500, { error: String(e.message || e) });
  }
}

const httpServer = http.createServer(handler);
httpServer.requestTimeout = 0; // big transfers may take longer than Node's 5 minute default

// Used on quit so a hotspot UFTI started doesn't keep running after the app is gone.
async function stopOwnedHotspot() { if (!hotspotOwned) return; hotspotOwned = false; try { await hotspot.stop(); } catch {} }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stopOwnedHotspot().finally(() => process.exit(0)));

const ready = (async () => {
  await new Promise(resolve => httpServer.listen(PORT, '0.0.0.0', resolve));
  const ips = lanIPs();
  const local = localUrl();
  console.log('\n  UFTI is running\n');
  if (!ips.length) console.log('  No LAN address found. Connect to Wi-Fi first.');
  else console.log(`  Pair a phone:  ${pairUrl(ips[0])}   (one-time link, 5 minutes)`);
  console.log(`  This PC:       ${local}\n`);
  if (ips[0]) console.log(await QRCode.toString(pairUrl(ips[0]), { type: 'terminal', small: true }));
  console.log('  Files are saved in:', DIR, '\n');
  if (process.platform === 'win32' && !process.env.NO_OPEN) require('child_process').exec(`start "" "${local}"`);
})();

module.exports = { PORT, DIR, lanIPs, stopOwnedHotspot, pairUrl, localUrl, ready, setCopyHandler };
