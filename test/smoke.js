// End-to-end test: starts the real server on a temp data folder and exercises pairing, sessions, share keys,
// every API route, live events and the rate limiter. The rate limiter test runs last on purpose.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const http = require('http');

const PORT = 18787;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ufti-'));
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT, UFTI_DATA: data, NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
let out = '';
srv.stdout.on('data', d => (out += d));
const base = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Safari/604.1';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';

// Open the one-time link without following the redirect, so the cookie can be read.
async function pair(url, ua = UA_IPHONE) {
  const r = await fetch(url, { redirect: 'manual', headers: { 'user-agent': ua } });
  const sc = r.headers.get('set-cookie');
  return { status: r.status, cookie: sc ? sc.split(';')[0] : null, setCookie: sc, location: r.headers.get('location'), body: r.status === 303 ? '' : await r.text() };
}
const call = (cookie, p, o = {}) => fetch(base + p, { ...o, headers: { ...(cookie ? { cookie } : {}), ...(o.headers || {}) } });
const json = async (cookie, p, body, method = 'POST') => (await call(cookie, p, { method, body: JSON.stringify(body || {}) })).json();

function rawRequest(mod, opts, body) {
  return new Promise((resolve, reject) => {
    const req = mod.request({ host: '127.0.0.1', port: PORT, rejectUnauthorized: false, ...opts }, res => {
      let text = ''; res.on('data', c => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

(async () => {
  try {
    for (let i = 0; i < 50 && !/This PC:/.test(out); i++) await sleep(200);
    const boot = (out.match(/This PC:\s+(http:\/\/localhost:\d+\/\?p=\S+)/) || [])[1];
    assert.ok(boot, 'server prints a one-time link for the PC window');
    const bootUrl = boot.replace('localhost', '127.0.0.1');

    // ---- the page is public, the API is not ----
    let r = await fetch(base + '/');
    assert.strictEqual(r.status, 200, 'UI served');
    assert.strictEqual(r.headers.get('referrer-policy'), 'no-referrer');
    assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(/default-src 'self'/.test(r.headers.get('content-security-policy')), 'CSP set');
    assert.strictEqual((await fetch(base + '/api/info')).status, 401, 'API needs pairing');
    assert.strictEqual((await fetch(base + '/api/info?t=abc')).status, 401, 'a made-up token is refused');
    assert.strictEqual((await rawRequest(http, { path: '/', headers: { Host: 'evil.example' } })).status, 421, 'DNS rebinding guard');

    // ---- one-time pairing ----
    const pc = await pair(bootUrl, 'Mozilla/5.0 (Windows NT 10.0) Electron/30 Chrome/120');
    assert.strictEqual(pc.status, 303); assert.strictEqual(pc.location, '/', 'redirects to a clean address');
    assert.ok(/HttpOnly/.test(pc.setCookie) && /SameSite=Strict/.test(pc.setCookie), 'cookie flags');
    assert.strictEqual((await pair(bootUrl)).status, 403, 'the PC code works only once');
    const C = pc.cookie;
    r = await call(C, '/api/info');
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).me.name, 'UFTI app (PC)');

    // ---- transfers (as before) ----
    const payload = Buffer.from('hello ufti');
    r = await call(C, '/api/upload', { method: 'POST', body: payload, headers: { 'x-filename': encodeURIComponent('my file.txt'), 'x-device': 'test' } });
    const file = await r.json();
    assert.strictEqual(file.name, 'my file.txt'); assert.strictEqual(file.size, payload.length);
    r = await call(C, '/api/upload?name=..%2F..%2Fevil.txt', { method: 'POST', body: 'x' });
    assert.strictEqual((await r.json()).name, 'evil.txt', 'path traversal stripped');
    r = await call(C, '/api/text', { method: 'POST', body: 'a link' });
    assert.strictEqual((await r.json()).text, 'a link');
    assert.strictEqual((await (await call(C, '/api/info')).json()).items.length, 3);
    assert.ok(Buffer.from(await (await call(C, `/api/file/${file.id}`)).arrayBuffer()).equals(payload), 'download matches upload');
    assert.strictEqual((await call(C, `/api/item/${file.id}`, { method: 'DELETE' })).status, 200);
    assert.strictEqual((await call(C, `/api/file/${file.id}`)).status, 404);

    // history and clear
    r = await call(C, '/api/upload?device=iPhone&client=phone1', { method: 'POST', body: 'keep me', headers: { 'x-filename': 'keep.txt' } });
    const kept = await r.json();
    assert.strictEqual(kept.fromId, 'phone1'); assert.strictEqual(kept.from, 'iPhone');
    await sleep(400);
    assert.ok(fs.existsSync(path.join(data, 'history.json')), 'history persisted');
    assert.strictEqual((await json(C, '/api/clear', { ids: [kept.id], deleteFiles: false })).removed, 1);
    assert.ok(fs.existsSync(path.join(data, 'received', `${kept.id}__keep.txt`)), 'file kept when deleteFiles=false');
    await json(C, '/api/clear', { deleteFiles: true });
    assert.strictEqual((await (await call(C, '/api/info')).json()).items.length, 0, 'clear all empties history');

    // multipart (Android share tools)
    const fd = new FormData();
    fd.append('file', new Blob(['android file']), 'Réport (1).txt');
    fd.append('file', new Blob(['second']), '../../evil2.txt');
    fd.append('title', 'Page title'); fd.append('url', 'https://example.com');
    r = await call(C, '/api/upload?device=Android&client=droid1', { method: 'POST', body: fd });
    const mp = await r.json();
    assert.strictEqual(mp.items.length, 3, 'two files and one text item');
    assert.strictEqual(mp.items[0].name, 'Réport (1).txt'); assert.strictEqual(mp.items[1].name, 'evil2.txt');
    assert.strictEqual(mp.items.find(i => i.kind === 'text').text, 'Page title' + String.fromCharCode(10) + 'https://example.com');
    assert.strictEqual(await (await call(C, `/api/file/${mp.items[0].id}`)).text(), 'android file');
    const fd2 = new FormData(); fd2.append('note', 'nothing useful');
    assert.strictEqual((await call(C, '/api/upload', { method: 'POST', body: fd2 })).status, 400, 'multipart with nothing to save is rejected');

    // network and hotspot controls
    const netInfo = await (await call(C, '/api/network')).json();
    assert.ok(Array.isArray(netInfo.addresses) && netInfo.port === PORT);
    assert.strictEqual(typeof (await (await call(C, '/api/hotspot')).json()).state, 'string');
    assert.strictEqual((await call(C, '/api/hotspot', { method: 'POST', body: '{"action":"explode"}' })).status, 400);
    assert.strictEqual((await call(C, '/api/network/select', { method: 'POST', body: '{"ip":"8.8.8.8"}' })).status, 400);
    const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal);
    if (lan) {
      for (const [m, p] of [['GET', '/api/network'], ['GET', '/api/pairing'], ['GET', '/api/devices'], ['POST', '/api/hotspot'], ['POST', '/api/firewall'], ['POST', '/api/keys']]) {
        const x = await rawRequest(http, { host: lan.address, path: p, method: m, headers: { cookie: C } }, m === 'POST' ? '{}' : undefined);
        assert.strictEqual(x.status, 403, `${m} ${p} must be PC-only`);
      }
    }

    // ---- pairing a second device with the code from the PC window ----
    const p1 = await (await call(C, '/api/pairing')).json();
    assert.ok(p1.code.length >= 21);
    const phone = await pair(`${base}/?p=${p1.code}`, UA_ANDROID);
    assert.strictEqual(phone.status, 303); const P = phone.cookie;
    assert.strictEqual((await (await call(P, '/api/info')).json()).me.name, 'Android · Chrome');
    assert.strictEqual((await pair(`${base}/?p=${p1.code}`)).status, 403, 'a pairing code works only once');
    assert.notStrictEqual((await (await call(C, '/api/pairing')).json()).code, p1.code, 'a new code appears after use');

    // ---- live events (server-sent events) ----
    const ac = new AbortController();
    const evRes = await fetch(base + '/api/events', { headers: { cookie: P }, signal: ac.signal });
    assert.strictEqual(evRes.status, 200); assert.ok(/text\/event-stream/.test(evRes.headers.get('content-type')));
    const reader = evRes.body.getReader(); let seen = '';
    const gotEvent = (async () => { const dec = new TextDecoder(); for (;;) { const { value, done } = await reader.read(); if (done) return false; seen += dec.decode(value); if (/"type":"add"/.test(seen)) return true; } })();
    await sleep(150);
    await call(C, '/api/text', { method: 'POST', body: 'live event' });
    assert.ok(await Promise.race([gotEvent, sleep(3000).then(() => false)]), 'an added item reaches other devices live');

    // ---- devices list and revoke ----
    const list = (await (await call(C, '/api/devices')).json()).devices;
    assert.ok(list.length >= 2 && list.some(d => d.current), 'devices list');
    const phoneId = list.find(d => /Android/.test(d.name)).id;
    assert.strictEqual((await call(C, `/api/devices/${phoneId}`, { method: 'DELETE' })).status, 200);
    assert.strictEqual((await call(P, '/api/info')).status, 401, 'revoked device is signed out');
    assert.ok(await Promise.race([reader.read().then(x => x.done), sleep(2000).then(() => false)]), 'revoking closes its live stream');
    ac.abort();

        // ---- share keys: can only send, revocable ----
    const key = await json(C, '/api/keys', { name: 'Test shortcut' });
    assert.ok(key.key.startsWith('uk_'));
    r = await call(null, `/api/upload?t=${key.key}&device=Android`, { method: 'POST', body: 'from a shortcut', headers: { 'x-filename': 'sc.txt' } });
    assert.strictEqual(r.status, 200, 'key can upload');
    r = await call(null, '/api/text', { method: 'POST', body: 'hi', headers: { 'x-token': key.key } });
    assert.strictEqual(r.status, 200, 'key can send text, also as a header');
    assert.strictEqual((await call(null, `/api/info?t=${key.key}`)).status, 403, 'key cannot read history');
    assert.strictEqual((await call(null, `/api/network?t=${key.key}`)).status, 403, 'key cannot use PC controls');
    assert.strictEqual((await call(`ufti_session=${key.key}`, '/api/info')).status, 401, 'a key is not a session cookie');
    assert.strictEqual((await call(C, `/api/devices/${key.id}`, { method: 'DELETE' })).status, 200);
    assert.strictEqual((await call(null, `/api/text?t=${key.key}`, { method: 'POST', body: 'x' })).status, 401, 'revoked key stops working');

    // ---- cross-site requests are refused ----
    for (const h of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
      assert.strictEqual((await call(C, '/api/text', { method: 'POST', body: 'x', headers: h })).status, 403, 'CSRF refused');
    }
    assert.strictEqual((await call(C, '/api/text', { method: 'POST', body: 'same origin', headers: { origin: base } })).status, 200);

    // ---- rate limit (last: it blocks this address for a minute) ----
    let blocked = null;
    for (let i = 0; i < 30 && !blocked; i++) { const x = await call('ufti_session=wrong', '/api/info'); if (x.status === 429) blocked = x; }
    assert.ok(blocked && Number(blocked.headers.get('retry-after')) > 0, 'too many wrong attempts are rate limited');
    assert.strictEqual((await call(C, '/api/info')).status, 429, 'the block applies to that address');

    console.log('smoke test passed');
  } catch (e) { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; }
  finally { srv.kill(); await sleep(100); fs.rmSync(data, { recursive: true, force: true }); process.exit(process.exitCode || 0); }
})();
