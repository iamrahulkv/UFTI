// Smoke test: starts the server on a temp dir and exercises every API route.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');

const PORT = 18787;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ufti-'));
fs.writeFileSync(path.join(data, '.token'), 'testtoken');
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT, UFTI_DATA: data, NO_OPEN: '1' }, stdio: 'ignore' });
const base = `http://127.0.0.1:${PORT}`, t = '?t=testtoken';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  try {
    for (let i = 0; i < 30; i++) { try { await fetch(base + '/'); break; } catch { await sleep(200); } }
    assert.strictEqual((await fetch(base + '/')).status, 200, 'UI served');
    assert.strictEqual((await fetch(base + '/api/info')).status, 401, 'token required');

    const payload = Buffer.from('hello ufti');
    let r = await fetch(`${base}/api/upload${t}`, { method: 'POST', body: payload,
      headers: { 'x-filename': encodeURIComponent('my file.txt'), 'x-device': 'test' } });
    const file = await r.json();
    assert.strictEqual(file.name, 'my file.txt'); assert.strictEqual(file.size, payload.length);

    r = await fetch(`${base}/api/upload${t}&name=..%2F..%2Fevil.txt`, { method: 'POST', body: 'x' });
    assert.strictEqual((await r.json()).name, 'evil.txt', 'path traversal stripped');

    r = await fetch(`${base}/api/text${t}`, { method: 'POST', body: 'a link' });
    assert.strictEqual((await r.json()).text, 'a link');

    const info = await (await fetch(`${base}/api/info${t}`)).json();
    assert.strictEqual(info.items.length, 3);

    r = await fetch(`${base}/api/file/${file.id}${t}`);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(payload), 'download matches upload');

    r = await fetch(`${base}/api/item/${file.id}${t}`, { method: 'DELETE' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await fetch(`${base}/api/file/${file.id}${t}`)).status, 404);

    // History: sender id is recorded, clear removes entries, files optionally survive.
    r = await fetch(`${base}/api/upload${t}`, { method: 'POST', body: 'keep me',
      headers: { 'x-filename': 'keep.txt', 'x-client': 'phone1', 'x-device': 'iPhone' } });
    const kept = await r.json();
    assert.strictEqual(kept.fromId, 'phone1', 'client id stored');
    await sleep(400); // history.json is written shortly after a change
    assert.ok(fs.existsSync(path.join(data, 'history.json')), 'history persisted');

    r = await fetch(`${base}/api/clear${t}`, { method: 'POST', body: JSON.stringify({ ids: [kept.id], deleteFiles: false }) });
    assert.strictEqual((await r.json()).removed, 1);
    assert.ok(fs.existsSync(path.join(data, 'received', `${kept.id}__keep.txt`)), 'file kept when deleteFiles=false');
    assert.strictEqual((await fetch(`${base}/api/file/${kept.id}${t}`)).status, 404, 'entry gone from history');

    r = await fetch(`${base}/api/clear${t}`, { method: 'POST', body: JSON.stringify({ deleteFiles: true }) });
    const left = await (await fetch(`${base}/api/info${t}`)).json();
    assert.strictEqual(left.items.length, 0, 'clear all empties history');
    const files = fs.readdirSync(path.join(data, 'received')).filter(f => f !== `${kept.id}__keep.txt`);
    assert.strictEqual(files.length, 0, 'deleteFiles removes stored files');

    // Multipart upload, as sent by Android share tools. Device and client can come from the query string.
    const fd = new FormData();
    fd.append('file', new Blob(['android file']), 'Réport (1).txt');
    fd.append('file', new Blob(['second']), '../../evil2.txt');
    fd.append('title', 'Page title'); fd.append('url', 'https://example.com');
    r = await fetch(`${base}/api/upload${t}&device=Android&client=droid1`, { method: 'POST', body: fd });
    const mp = await r.json();
    assert.strictEqual(r.status, 200); assert.strictEqual(mp.items.length, 3, 'two files and one text item');
    assert.strictEqual(mp.items[0].name, 'Réport (1).txt', 'unicode file name kept');
    assert.strictEqual(mp.items[1].name, 'evil2.txt', 'path stripped from multipart file name');
    assert.ok(mp.items.every(i => i.from === 'Android' && i.fromId === 'droid1'), 'device and client from query');
    assert.strictEqual(mp.items.find(i => i.kind === 'text').text, 'Page title' + String.fromCharCode(10) + 'https://example.com');
    r = await fetch(`${base}/api/file/${mp.items[0].id}${t}`);
    assert.strictEqual(await r.text(), 'android file', 'multipart file downloads intact');
    const fd2 = new FormData(); fd2.append('note', 'nothing useful');
    r = await fetch(`${base}/api/upload${t}`, { method: 'POST', body: fd2 });
    assert.strictEqual(r.status, 400, 'multipart with nothing to save is rejected');

    // Connection panel APIs: available on the PC itself, refused from any network address.
    r = await fetch(`${base}/api/network${t}`);
    const netInfo = await r.json();
    assert.ok(Array.isArray(netInfo.addresses) && netInfo.port === PORT, 'network info');
    const hsInfo = await (await fetch(`${base}/api/hotspot${t}`)).json();
    assert.strictEqual(typeof hsInfo.state, 'string', 'hotspot status shape');
    r = await fetch(`${base}/api/hotspot${t}`, { method: 'POST', body: JSON.stringify({ action: 'explode' }) });
    assert.strictEqual(r.status, 400, 'unknown hotspot action rejected');
    r = await fetch(`${base}/api/network/select${t}`, { method: 'POST', body: JSON.stringify({ ip: '8.8.8.8' }) });
    assert.strictEqual(r.status, 400, 'cannot select an address the PC does not have');
    const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal);
    if (lan) {
      for (const [m, p] of [['GET', '/api/network'], ['GET', '/api/hotspot'], ['POST', '/api/hotspot'], ['POST', '/api/firewall']]) {
        r = await fetch(`http://${lan.address}:${PORT}${p}${t}`, { method: m, body: m === 'POST' ? '{"action":"start"}' : undefined });
        assert.strictEqual(r.status, 403, `${m} ${p} must be PC-only`);
      }
    }
    console.log('smoke test passed');
  } catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; }
  finally { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); }
})();
