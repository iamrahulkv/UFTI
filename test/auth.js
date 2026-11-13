// Unit tests for auth.js (pairing, sessions, share keys, rate limit). No server needed.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { createAuth, parseCookies, deviceName, sha } = require('../auth');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufti-auth-'));
  let t = 1_000_000;
  const mk = () => createAuth({ dataDir: dir, now: () => t });
  let auth = mk();
  const req = (cookie, headers = {}) => ({ headers: { ...(cookie ? { cookie: `ufti_session=${cookie}` } : {}), ...headers } });
  const url = q => new URL('http://x/' + (q || ''));

  // pairing: single use
  const p1 = auth.currentPairing();
  assert.ok(p1.code.length >= 21, '128-bit code');
  assert.strictEqual(auth.peek(p1.code).ok, true);
  const s1 = auth.consume(p1.code, 'iPhone Safari');
  assert.ok(s1.ok && s1.secret, 'first use pairs');
  assert.strictEqual(auth.consume(p1.code, 'x').ok, false, 'code works only once');
  assert.notStrictEqual(auth.currentPairing().code, p1.code, 'a new code appears after use');

  // session authenticates, wrong cookie does not
  assert.strictEqual(auth.authenticate(req(s1.secret), url()).session.kind, 'device');
  const bad = auth.authenticate(req('nope'), url());
  assert.ok(bad.presented && !bad.session, 'wrong credentials are flagged as presented');
  assert.ok(!auth.authenticate(req(), url()).presented, 'no credentials presented');

  // expiry and early refresh
  const p2 = auth.currentPairing();
  t += 4.5 * 60 * 1000; // less than a minute left: the PC window gets a fresh code
  assert.notStrictEqual(auth.currentPairing().code, p2.code, 'near-expiry code is replaced');
  assert.strictEqual(auth.peek(p2.code).ok, false, 'replaced code no longer works');
  const p3 = auth.currentPairing();
  t += 6 * 60 * 1000;
  assert.strictEqual(auth.peek(p3.code).ok, false, 'code expires after 5 minutes');
  assert.strictEqual(auth.consume(p3.code, 'x').ok, false, 'expired code cannot pair');

  // boot codes (the PC window signing itself in) work once
  const b = auth.bootCode();
  assert.ok(auth.consume(b, 'Electron').ok && !auth.consume(b, 'x').ok, 'boot code works once');

  // share keys: only usable as keys, revocable
  const k = auth.create('key', 'My phone shortcut');
  assert.ok(k.secret.startsWith('uk_'));
  const viaKey = auth.authenticate(req(null, { 'x-token': k.secret }), url());
  assert.strictEqual(viaKey.via, 'key');
  assert.strictEqual(auth.authenticate(req(null), url('?t=' + k.secret)).via, 'key', 'key also accepted as ?t=');
  assert.ok(!auth.authenticate(req(k.secret), url()).session, 'a key is not accepted as a cookie');
  assert.ok(!auth.authenticate(req(null, { 'x-token': s1.secret }), url()).session, 'a device session is not accepted as a key');
  const id = auth.list().find(x => x.kind === 'key').id;
  assert.ok(auth.revoke(id), 'revoke');
  assert.ok(!auth.authenticate(req(null, { 'x-token': k.secret }), url()).session, 'revoked key stops working');

  // revoking a device signs it out
  const s2 = auth.consume(auth.currentPairing().code, 'Android Chrome');
  assert.ok(auth.authenticate(req(s2.secret), url()).session);
  assert.ok(auth.revoke(auth.list().find(x => x.name === 'Android · Chrome').id));
  assert.ok(!auth.authenticate(req(s2.secret), url()).session, 'revoked device is signed out');
  assert.strictEqual(auth.revoke('doesnotexist'), null, 'unknown id');

  // only hashes are stored on disk
  await new Promise(r => setTimeout(r, 400));
  const disk = fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8');
  assert.ok(!disk.includes(s1.secret) && disk.includes(sha(s1.secret)), 'sessions.json holds hashes, not secrets');
  auth = mk(); // survives restart
  assert.ok(auth.authenticate(req(s1.secret), url()).session, 'session survives a restart');

  // rate limit
  const ip = '10.0.0.9';
  assert.strictEqual(auth.blockedFor(ip), 0);
  for (let i = 0; i < 21; i++) auth.fail(ip);
  assert.ok(auth.blockedFor(ip) > 0, 'blocked after too many failures');
  t += 61 * 1000;
  assert.strictEqual(auth.blockedFor(ip), 0, 'block lifts after a minute');

  // helpers
  assert.strictEqual(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Safari/604'), 'iPhone · Safari');
  assert.strictEqual(deviceName('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari/537'), 'Android · Chrome');
  assert.strictEqual(deviceName('Mozilla/5.0 (Windows NT 10.0) Electron/30 Chrome/120'), 'UFTI app (PC)');
  assert.deepStrictEqual(parseCookies('a=1; ufti_session=abc; b=2'), { a: '1', ufti_session: 'abc', b: '2' });
  const c = auth.cookieHeader('v');
  assert.ok(/HttpOnly/.test(c) && /SameSite=Strict/.test(c) && /Max-Age=/.test(c));

  console.log('auth test passed');
  fs.rmSync(dir, { recursive: true, force: true });
})().catch(e => { console.error('FAILED:', e.message); process.exitCode = 1; });
