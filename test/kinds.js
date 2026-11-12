// Unit test: which network address ranges map to which connection kind.
const assert = require('assert');
const { describe } = require('../netkinds');

const cases = [
  ['192.168.137.1', 'pc-hotspot', 'PC hotspot'],
  ['172.20.10.2', 'phone-hotspot', 'iPhone hotspot'],
  ['192.168.43.7', 'phone-hotspot', 'Android hotspot'],
  ['192.168.42.12', 'phone-hotspot', 'Android USB tethering'],
  ['192.168.1.16', 'network', 'Wi-Fi / network'],
  ['10.0.0.5', 'network', 'Wi-Fi / network'],
];
for (const [ip, kind, via] of cases) assert.deepStrictEqual(describe(ip), { kind, via }, ip);
console.log('kinds test passed');
