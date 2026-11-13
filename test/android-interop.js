// Interop check: a Node client (standing in for any other UFTI device) uses a running Android server.
// Usage: node test/android-interop.js <base-url> <pairing-url>
// Run by the Android unit tests (ServerTest.nodeClientInterop); it needs no network beyond localhost.
const assert = require('assert');
const [base, pairUrl] = process.argv.slice(2);
assert.ok(base && pairUrl, 'usage: node android-interop.js <base> <pairing-url>');
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Safari/604.1';

(async () => {
  // Pair exactly like a phone's browser: open the one-time link, keep the cookie, follow the redirect to /.
  let r = await fetch(pairUrl, { redirect: 'manual', headers: { 'user-agent': UA } });
  assert.strictEqual(r.status, 303, 'pairing redirects');
  assert.strictEqual(r.headers.get('location'), '/');
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const call = (p, o = {}) => fetch(base + p, { ...o, headers: { cookie, ...(o.headers || {}) } });
  assert.strictEqual((await fetch(pairUrl, { redirect: 'manual' })).status, 403, 'a pairing link works once');

  r = await call('/');
  assert.ok((await r.text()).includes("UFTI_HOST = 'android'"), 'page is served and tagged');
  r = await call('/api/info');
  const info = await r.json();
  assert.ok(Array.isArray(info.items) && info.me.id && /iPhone/.test(info.me.name), 'info shape and device name: ' + JSON.stringify(info.me));

  // Live events, read the way EventSource does.
  const ev = await call('/api/events');
  assert.strictEqual(ev.headers.get('content-type'), 'text/event-stream');
  const reader = ev.body.getReader();
  const dec = new TextDecoder();
  let seen = '';
  const gotAdd = (async () => { while (!/"type":"add"/.test(seen)) { const { value, done } = await reader.read(); if (done) break; seen += dec.decode(value); } })();

  r = await call('/api/text', { method: 'POST', body: JSON.stringify({ text: 'hello from node', from: 'iPhone', fromId: 'n1' }), headers: { 'content-type': 'application/json' } });
  assert.strictEqual(r.status, 200);
  await Promise.race([gotAdd, new Promise((_, no) => setTimeout(() => no(new Error('no live event')), 5000))]);
  assert.ok(seen.includes('hello from node'), 'event carries the item');
  await reader.cancel();

  // Upload a file the way the page does (raw body, URL-encoded name) and fetch it back.
  const bytes = Buffer.alloc(1_500_000, 7);
  r = await call('/api/upload', { method: 'POST', body: bytes, headers: { 'x-filename': encodeURIComponent('résumé 1.bin'), 'x-device': 'iPhone', 'x-client': 'n1' } });
  assert.strictEqual(r.status, 200);
  const item = await r.json();
  assert.strictEqual(item.name, 'résumé 1.bin'); assert.strictEqual(item.size, bytes.length);
  r = await call('/api/file/' + item.id);
  assert.strictEqual(r.status, 200);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(bytes), 'file comes back byte for byte');
  assert.ok(/filename\*=UTF-8''r%C3%A9sum%C3%A9%201\.bin/.test(r.headers.get('content-disposition')), r.headers.get('content-disposition'));

  // Share key, as used by an iOS Shortcut or an Android share app.
  const k = await (await call('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'node' }) })).json();
  r = await fetch(base + '/api/upload?t=' + k.key + '&name=key.txt&device=Android', { method: 'POST', body: 'via key' });
  assert.strictEqual(r.status, 200, 'share key upload');
  assert.strictEqual((await fetch(base + '/api/info?t=' + k.key)).status, 403, 'share key cannot read');

  r = await call('/api/clear', { method: 'POST', body: JSON.stringify({ deleteFiles: true }) });
  assert.ok((await r.json()).removed >= 3, 'clear removes everything');
  console.log('android interop OK');
})().catch(e => { console.error(e); process.exit(1); });
