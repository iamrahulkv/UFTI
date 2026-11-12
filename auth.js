// Authentication for UFTI.
//
//  - Pairing: the QR code carries a one-time code (single use, expires in 5 minutes). Scanning it creates a
//    long-lived session for that device only, held in an HttpOnly cookie. An optional PIN adds a second factor.
//  - Sessions and share keys are random 128-bit values. Only their SHA-256 hashes are stored on disk, so a leaked
//    sessions.json can't be used to log in. Each one can be revoked on its own.
//  - Share keys (kind "key") are for tools that can't use cookies (iOS Shortcuts, Android share apps).
//  - Failed attempts are rate limited per client address.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PAIR_TTL_MS = 5 * 60 * 1000;        // how long a pairing code works
const PAIR_REFRESH_MS = 60 * 1000;        // the PC window gets a fresh code when less than this is left
const BOOT_TTL_MS = 2 * 60 * 1000;        // codes the PC window uses to sign itself in
const PIN_TRIES = 3;
const LIMIT = { window: 60 * 1000, max: 20, block: 60 * 1000 };
const COOKIE = 'ufti_session';
const COOKIE_AGE_S = 365 * 24 * 60 * 60;

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const secret = (prefix = '') => prefix + crypto.randomBytes(16).toString('base64url'); // 128 bits
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function deviceName(ua = '') {
  if (/Electron/.test(ua)) return 'UFTI app (PC)';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows PC' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /CriOS|Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : '';
  return browser ? `${os} · ${browser}` : os;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function createAuth({ dataDir, getSettings = () => ({}), now = () => Date.now() }) {
  const file = path.join(dataDir, 'sessions.json');
  const sessions = new Map(); // hash -> { h, kind: 'device' | 'key', name, created, lastSeen }

  try {
    for (const s of JSON.parse(fs.readFileSync(file, 'utf8'))) sessions.set(s.h, s);
  } catch {}

  let timer;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => fs.writeFile(file, JSON.stringify([...sessions.values()]), { mode: 0o600 }, () => {}), 200);
  };

  // ---- sessions and share keys ----
  function create(kind, name) {
    const value = secret(kind === 'key' ? 'uk_' : '');
    const s = { h: sha(value), kind, name: String(name || 'Device').slice(0, 60), created: now(), lastSeen: now() };
    sessions.set(s.h, s);
    save();
    return { secret: value, session: s };
  }
  function lookup(value) {
    if (!value) return null;
    const s = sessions.get(sha(value));
    if (!s) return null;
    if (now() - s.lastSeen > 60 * 1000) { s.lastSeen = now(); save(); } // touch at most once a minute
    return s;
  }
  const view = s => ({ id: s.h.slice(0, 12), kind: s.kind, name: s.name, created: s.created, lastSeen: s.lastSeen });
  const list = () => [...sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen).map(view);
  function revoke(id) {
    for (const s of sessions.values()) {
      if (s.h.slice(0, 12) === id) { sessions.delete(s.h); save(); return s; }
    }
    return null;
  }

  // Who is making this request? Cookie (browsers) or share key (tools). `presented` tells the caller
  // whether credentials were sent at all, so only wrong credentials count as failed attempts.
  function authenticate(req, url) {
    const cookie = parseCookies(req.headers.cookie)[COOKIE];
    const key = (req.headers['x-token'] || (url && url.searchParams.get('t')) || '').toString();
    if (!cookie && !key) return { session: null, presented: false };
    if (cookie) {
      const s = lookup(cookie);
      if (s && s.kind === 'device') return { session: s, via: 'cookie', presented: true };
    }
    if (key) {
      const s = lookup(key);
      if (s && s.kind === 'key') return { session: s, via: 'key', presented: true };
    }
    return { session: null, presented: true };
  }

  // ---- one-time pairing codes ----
  let pairing = null;                 // the code shown in the PC window
  const boot = new Map();             // codes the PC window itself uses to sign in (loopback only)
  const fresh = () => {
    pairing = { code: secret(), pin: String(crypto.randomInt(0, 10000)).padStart(4, '0'),
      expires: now() + PAIR_TTL_MS, used: false, tries: 0 };
    return pairing;
  };
  function currentPairing() {
    if (!pairing || pairing.used || pairing.tries >= PIN_TRIES || pairing.expires - now() < PAIR_REFRESH_MS) fresh();
    return { code: pairing.code, pin: pairing.pin, expires: pairing.expires };
  }
  function bootCode() {
    const code = secret();
    boot.set(code, now() + BOOT_TTL_MS);
    return code;
  }
  const codeState = code => {
    if (boot.has(code)) return boot.get(code) > now() ? 'boot' : 'expired';
    if (pairing && same(pairing.code, code || '')) return !pairing.used && pairing.tries < PIN_TRIES && pairing.expires > now() ? 'pair' : 'expired';
    return 'unknown';
  };
  // Is this code still usable? Does not use it up.
  const peek = code => { const s = codeState(code); return { ok: s === 'pair' || s === 'boot', kind: s, needsPin: s === 'pair' && !!getSettings().requirePin }; };
  // Use a code up and create the device session. Boot codes only work for loopback requests (checked by the caller).
  function consume(code, pin, ua) {
    const s = codeState(code);
    if (s === 'boot') { boot.delete(code); return { ok: true, ...create('device', deviceName(ua)) }; }
    if (s !== 'pair') return { ok: false, reason: s };
    if (getSettings().requirePin) {
      if (!same(pairing.pin, String(pin || ''))) {
        pairing.tries++;
        return { ok: false, reason: pairing.tries >= PIN_TRIES ? 'expired' : 'pin', triesLeft: PIN_TRIES - pairing.tries };
      }
    }
    pairing.used = true;
    return { ok: true, ...create('device', deviceName(ua)) };
  }

  // ---- rate limiting of failed attempts, per client address ----
  const fails = new Map();
  function blockedFor(ip) {
    const f = fails.get(ip);
    return f && f.blockedUntil > now() ? Math.ceil((f.blockedUntil - now()) / 1000) : 0;
  }
  function fail(ip) {
    let f = fails.get(ip);
    if (!f || now() - f.start > LIMIT.window) f = { start: now(), count: 0, blockedUntil: 0 };
    f.count++;
    if (f.count > LIMIT.max) f.blockedUntil = now() + LIMIT.block;
    fails.set(ip, f);
    if (fails.size > 1000) for (const [k, v] of fails) if (now() - v.start > LIMIT.window && v.blockedUntil < now()) fails.delete(k);
  }

  const cookieHeader = (value, secure) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_AGE_S}${secure ? '; Secure' : ''}`;

  return { create, lookup, list, revoke, authenticate, currentPairing, bootCode, peek, consume,
    blockedFor, fail, cookieHeader, deviceName, PIN_TRIES };
}

module.exports = { createAuth, parseCookies, deviceName, COOKIE, sha };
