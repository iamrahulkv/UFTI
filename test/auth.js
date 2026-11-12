// Unit tests for auth.js (pairing, sessions, share keys, rate limit) and tlsCert.js. No server needed.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { createAuth, parseCookies, deviceName, sha } = require('../auth');
const { ensureCert } = require('../tlsCert');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufti-auth-'));
  let t = 1_000_000, settings = { requirePin: false };
  const mk = () => createAuth({ dataDir: dir, getSettings: () => settings, now: () => t });
  let auth = mk();
  const req = (cookie, headers = {}) => ({ headers: { ...(cookie ? { cookie: `ufti_session=${cookie}` } : {}), ...headers } });
  const url = q => new URL('http://x/' + (q || ''));

  // pairing: single use
  const p1 = auth.currentPairing();
  assert.ok(p1.code.length >= 21, '128-bit code');
  assert.strictEqual(auth.peek(p1.code).ok, true);
  const s1 = auth.consume(p1.code, '', 'iPhone Safari');
  assert.ok(s1.ok && s1.secret, 'first use pairs');
  assert.strictEqual(auth.consume(p1.code, '', 'x').ok, false, 'code works only once');
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

  // PIN: wrong tries burn the code, right one pairs
  settings = { requirePin: true };
  const p4 = auth.currentPairing();
  assert.ok(/^\d{4}$/.test(p4.pin), '4-digit pin');
  assert.strictEqual(auth.peek(p4.code).needsPin, true);
  const w1 = auth.consume(p4.code, '0000' === p4.pin ? '1111' : '0000', 'x');
  assert.ok(!w1.ok && w1.reason === 'pin' && w1.triesLeft === 2);
  const ok = auth.consume(p4.code, p4.pin, 'Android Chrome');
  assert.ok(ok.ok, 'right pin pairs');
  const p5 = auth.currentPairing();
  for (let i = 0; i < 3; i++) auth.consume(p5.code, p5.pin === '9999' ? '1' : '9999', 'x');
  assert.strictEqual(auth.peek(p5.code).ok, false, 'three wrong pins burn the code');
  assert.strictEqual(auth.consume(p5.code, p5.pin, 'x').ok, false, 'even the right pin fails after that');
  settings = { requirePin: false };

  // boot codes (the PC window signing itself in) skip the pin and work once
  settings = { requirePin: true };
  const b = auth.bootCode();
  assert.ok(auth.consume(b, '', 'Electron').ok && !auth.consume(b, '', 'x').ok, 'boot code: once, no pin');
  settings = { requirePin: false };

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
  const c = auth.cookieHeader('v', true);
  assert.ok(/HttpOnly/.test(c) && /SameSite=Strict/.test(c) && /; Secure/.test(c) && /Max-Age=/.test(c));

  // certificate: generated once, reused, names present, EC key
  const t0 = Date.now();
  const a = await ensureCert(dir, ['192.168.1.20']);
  const ms = Date.now() - t0;
  const b2 = await ensureCert(dir, ['10.9.9.9']);
  assert.strictEqual(a.fingerprint, b2.fingerprint, 'certificate is reused, not regenerated');
  const x = new crypto.X509Certificate(a.cert);
  assert.ok(/IP Address:192\.168\.1\.20/.test(x.subjectAltName) && /DNS:localhost/.test(x.subjectAltName), 'SAN has the addresses');
  assert.strictEqual(x.publicKey.asymmetricKeyType, 'ec');
  assert.ok(x.checkIP('127.0.0.1'), 'valid for 127.0.0.1');
  console.log(`auth test passed (certificate generated in ${ms} ms)`);
  fs.rmSync(dir, { recursive: true, force: true });
})().catch(e => { console.error('FAILED:', e.message); process.exitCode = 1; });
