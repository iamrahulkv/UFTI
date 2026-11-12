// Classifies a PC network address by the subnet each platform uses for its own hotspot or tethering,
// so the UI can tell "PC hotspot", "phone hotspot" and ordinary networks apart.
// These ranges are defaults and some phones use others; anything not listed is an ordinary network,
// which still works (the Same Wi-Fi view lists every address and lets you pick one).
const RANGES = [
  { prefix: '192.168.137.', kind: 'pc-hotspot', via: 'PC hotspot' },               // Windows Mobile Hotspot
  { prefix: '172.20.10.', kind: 'phone-hotspot', via: 'iPhone hotspot' },          // iPhone Personal Hotspot, Wi-Fi or USB
  { prefix: '192.168.43.', kind: 'phone-hotspot', via: 'Android hotspot' },        // Android Wi-Fi hotspot (common default)
  { prefix: '192.168.42.', kind: 'phone-hotspot', via: 'Android USB tethering' },  // Android USB tethering
];

function describe(ip) {
  const r = RANGES.find(x => ip.startsWith(x.prefix));
  return r ? { kind: r.kind, via: r.via } : { kind: 'network', via: 'Wi-Fi / network' };
}

module.exports = { describe, RANGES };
