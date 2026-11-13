// Copy button: POST /api/copy/<id> hands the stored file to the handler the desktop app registers (main.js).
// Runs the server in-process so a fake handler can be installed. Uses its own port and data folder.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');

process.env.PORT = '18788';
process.env.NO_OPEN = '1';
process.env.UFTI_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ufti-copy-'));
const srv = require('../server.js');
const base = `http://127.0.0.1:${process.env.PORT}`;

(async () => {
  try {
    await srv.ready;
    const boot = srv.localUrl().replace('localhost', '127.0.0.1');
    const cookie = (await fetch(boot, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
    const call = (p, o = {}) => fetch(base + p, { ...o, headers: { cookie, ...(o.headers || {}) } });
    const up = await (await call('/api/upload', { method: 'POST', body: 'pretend image', headers: { 'x-filename': 'pic.png' } })).json();

    assert.strictEqual((await call('/api/copy/ffffffff', { method: 'POST' })).status, 404, 'unknown item');
    assert.strictEqual((await call(`/api/copy/${up.id}`, { method: 'POST' })).status, 501, 'no handler registered yet');

    let seen = null;
    srv.setCopyHandler(async (file, item) => { seen = { file, item }; return { as: 'image' }; });
    const r = await call(`/api/copy/${up.id}`, { method: 'POST' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { ok: true, as: 'image' });
    assert.strictEqual(seen.item.id, up.id);
    assert.strictEqual(fs.readFileSync(seen.file, 'utf8'), 'pretend image', 'the handler gets the stored file');

    srv.setCopyHandler(async () => { throw new Error('boom'); });
    assert.strictEqual((await call(`/api/copy/${up.id}`, { method: 'POST' })).status, 500, 'a handler error is reported');

    const text = await (await call('/api/text', { method: 'POST', body: 'just text' })).json();
    assert.strictEqual((await call(`/api/copy/${text.id}`, { method: 'POST' })).status, 404, 'text items use the Copy button that already exists');
    console.log('copy test passed');
  } catch (e) { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; }
  finally {
    fs.rmSync(process.env.UFTI_DATA, { recursive: true, force: true });
    // Let open sockets close first; exiting at once trips a libuv assertion on Windows.
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  }
})();
