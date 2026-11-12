// UFTI: AirDrop-style file/text sharing between devices on the same Wi-Fi.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 8787;
const DATA = process.env.UFTI_DATA || __dirname;
const DIR = path.join(DATA, 'received');
const PUBLIC = path.join(__dirname, 'public');
const TOKEN_FILE = path.join(DATA, '.token');
fs.mkdirSync(DIR, { recursive: true });

// Persistent pairing token so a bookmarked/paired phone keeps working across restarts.
let TOKEN;
try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
if (!TOKEN) { TOKEN = crypto.randomBytes(6).toString('hex'); fs.writeFileSync(TOKEN_FILE, TOKEN); }

const hotspot = require('./hotspot');
const Busboy = require('busboy');
const { describe } = require('./netkinds');

// Network addresses this PC can be reached on. `kind` tells the UI which connection mode they belong to:
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
// Network, hotspot and firewall controls are for the PC window only (never a phone on the network).
const isLoopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const cleanName = raw => path.basename(String(raw)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';

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
async function readBody(req) {
  let body = '';
  for await (const c of req) { body += c; if (body.length > 1e6) break; }
  return body;
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
  // First run after upgrade: rebuild the list from files already on disk.
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

const sendJSON = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};
const authed = (url, req) =>
  url.searchParams.get('t') === TOKEN || (req.headers['x-token'] === TOKEN);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // Static UI (open; it needs the token to do anything useful).
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.normalize(path.join(PUBLIC, rel));
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return fs.createReadStream(file).pipe(res);
    }

    if (!authed(url, req)) return sendJSON(res, 401, { error: 'bad token' });

    if (url.pathname === '/api/network' || url.pathname === '/api/network/select' ||
        url.pathname === '/api/hotspot' || url.pathname === '/api/firewall') {
      if (!isLoopback(req)) return sendJSON(res, 403, { error: 'only available in the UFTI window on the PC' });

      if (req.method === 'GET' && url.pathname === '/api/network') {
        const addresses = netAddrs().map(a => ({ ...a, url: `http://${a.ip}:${PORT}/?t=${TOKEN}` }));
        return sendJSON(res, 200, { port: PORT, preferred: lanIPs()[0] || '', addresses, firewall: await hotspot.firewallRuleExists() });
      }
      if (req.method === 'POST' && url.pathname === '/api/network/select') {
        let ip = ''; try { ip = JSON.parse(await readBody(req)).ip; } catch {}
        if (!netAddrs().some(a => a.ip === ip)) return sendJSON(res, 400, { error: 'unknown address' });
        preferredIp = ip;
        return sendJSON(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/hotspot') return sendJSON(res, 200, await hotspot.status());
      if (req.method === 'POST' && url.pathname === '/api/hotspot') {
        let action = ''; try { action = JSON.parse(await readBody(req)).action; } catch {}
        if (action === 'start') {
          const r = await hotspot.start();
          if (r.ok) hotspotOwned = true;
          if (r.ok) { // Windows needs a moment to assign the hotspot address; then make it the QR default.
            for (let i = 0; i < 10 && !preferredIp.startsWith('192.168.137.'); i++) {
              const a = netAddrs().find(x => x.kind === 'pc-hotspot');
              if (a) preferredIp = a.ip; else await new Promise(s => setTimeout(s, 500));
            }
          }
          return sendJSON(res, 200, r);
        }
        if (action === 'stop') { preferredIp = ''; hotspotOwned = false; return sendJSON(res, 200, await hotspot.stop()); }
        return sendJSON(res, 400, { error: 'unknown action' });
      }
      if (req.method === 'POST' && url.pathname === '/api/firewall') return sendJSON(res, 200, await hotspot.allowFirewall(PORT));
    }

    if (req.method === 'GET' && url.pathname === '/api/info') {
      const urls = lanIPs().map(ip => `http://${ip}:${PORT}/?t=${TOKEN}`);
      return sendJSON(res, 200, { urls, items, host: os.hostname() });
    }

    if (req.method === 'GET' && url.pathname === '/api/qr') {
      const svg = await QRCode.toString(url.searchParams.get('u') || '', { type: 'svg', margin: 1 });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return res.end(svg);
    }

    if (req.method === 'POST' && url.pathname === '/api/upload') {
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
        const item = { id, kind: 'file', name, size: fs.statSync(dest).size,
          from: device, fromId: client, ts: Date.now() };
        addItem(item);
        sendJSON(res, 200, item);
      });
      out.on('error', () => sendJSON(res, 500, { error: 'write failed' }));
      req.on('aborted', () => { out.destroy(); fs.unlink(dest, () => {}); });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/text') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 1e6) break; }
      let text = body, from = req.headers['x-device'] || url.searchParams.get('device'), fromId = req.headers['x-client'] || url.searchParams.get('client') || '';
      try { const j = JSON.parse(body); if (j && typeof j.text === 'string') { text = j.text; from = j.from || from; fromId = j.fromId || fromId; } } catch {}
      if (!text.trim()) return sendJSON(res, 400, { error: 'empty' });
      const item = { id: crypto.randomBytes(4).toString('hex'), kind: 'text', text: String(text).slice(0, 100000),
        from: from || 'device', fromId, ts: Date.now() };
      addItem(item);
      return sendJSON(res, 200, item);
    }

    let m;
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/file\/([0-9a-f]{8})$/))) {
      const item = items.find(i => i.id === m[1] && i.kind === 'file');
      if (!item) { res.writeHead(404); return res.end(); }
      const p = path.join(DIR, `${item.id}__${item.name}`);
      res.writeHead(200, {
        'Content-Length': item.size,
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`,
      });
      return fs.createReadStream(p).pipe(res);
    }

    if (req.method === 'DELETE' && (m = url.pathname.match(/^\/api\/item\/([0-9a-f]{8})$/))) {
      return removeItem(m[1], true) ? sendJSON(res, 200, { ok: true }) : sendJSON(res, 404, { error: 'gone' });
    }

    // Clear history entries. Body: { ids: [...], deleteFiles: bool }. Omit ids to clear everything.
    if (req.method === 'POST' && url.pathname === '/api/clear') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 1e6) break; }
      let opts = {};
      try { opts = JSON.parse(body || '{}'); } catch {}
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
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws' || url.searchParams.get('t') !== TOKEN) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
});
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
}
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
});
setInterval(() => {
  for (const c of wss.clients) { if (!c.isAlive) c.terminate(); else { c.isAlive = false; c.ping(); } }
}, 20000);

// Used on quit so a hotspot UFTI started doesn't keep running after the app is gone.
async function stopOwnedHotspot() { if (!hotspotOwned) return; hotspotOwned = false; try { await hotspot.stop(); } catch {} }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stopOwnedHotspot().finally(() => process.exit(0)));
module.exports = { PORT, TOKEN, DIR, lanIPs, stopOwnedHotspot };
server.listen(PORT, '0.0.0.0', async () => {
  const ips = lanIPs();
  console.log('\n  UFTI is running\n');
  if (!ips.length) console.log('  No LAN address found. Connect to Wi-Fi first.');
  for (const ip of ips) console.log(`  Phone URL:  http://${ip}:${PORT}/?t=${TOKEN}`);
  console.log(`  This PC:    http://localhost:${PORT}/?t=${TOKEN}\n`);
  if (ips[0]) console.log(await QRCode.toString(`http://${ips[0]}:${PORT}/?t=${TOKEN}`, { type: 'terminal', small: true }));
  console.log('  Files are saved in:', DIR, '\n');
  if (process.platform === 'win32' && !process.env.NO_OPEN)
    require('child_process').exec(`start "" "http://localhost:${PORT}/?t=${TOKEN}"`);
});
