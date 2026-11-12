// Self-signed certificate for the optional HTTPS mode.
// Generated once with the PC's addresses in it, kept in the data folder, and reused on every start so a phone
// that has accepted it once is not asked again. Elliptic-curve (P-256) keys: fast to generate, small, strong.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const selfsigned = require('selfsigned');

const DAYS = 825;
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

function read(dir) {
  try {
    const key = fs.readFileSync(path.join(dir, 'key.pem'), 'utf8');
    const cert = fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8');
    const x = new crypto.X509Certificate(cert);
    if (new Date(x.validTo).getTime() - Date.now() < RENEW_BEFORE_MS) return null;
    return { key, cert, fingerprint: x.fingerprint256 };
  } catch { return null; }
}

// Returns { key, cert, fingerprint }. `ips` are added to the certificate's names.
async function ensureCert(dataDir, ips = []) {
  const dir = path.join(dataDir, 'tls');
  const existing = read(dir);
  if (existing) return existing;

  const names = [...new Set(['127.0.0.1', '192.168.137.1', ...ips])];
  const notBeforeDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'UFTI' }], {
    keyType: 'ec', curve: 'P-256', algorithm: 'sha256',
    notBeforeDate, notAfterDate: new Date(notBeforeDate.getTime() + DAYS * 24 * 60 * 60 * 1000),
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, ...names.map(ip => ({ type: 7, ip }))] },
    ],
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'key.pem'), pems.private, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'cert.pem'), pems.cert);
  return read(dir) || { key: pems.private, cert: pems.cert, fingerprint: new crypto.X509Certificate(pems.cert).fingerprint256 };
}

module.exports = { ensureCert };
