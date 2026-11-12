# Changelog

## 1.1.0
Security release. No change to how transfers work, and no slower: on the test PC, 1 GiB uploads ran at 656 MB/s before and 718 MB/s after over HTTP.
- **One-time pairing.** The QR code holds a code that works once and expires in 5 minutes, then becomes a per-device session in an HttpOnly cookie. The address bar no longer carries a secret
- **Revocable devices.** New **Security and devices** panel lists paired devices and removes any of them instantly
- **Optional PIN** to pair, shown on the PC; three wrong tries burn the code
- **Share keys** for the iPhone Shortcut and Android share apps: named, shown once, revocable, can only send files and text
- **Optional HTTPS** on the same port with a self-signed certificate created on first use (about 375 MB/s over HTTPS in the same test)
- Live updates now use Server-Sent Events instead of WebSocket (works with self-signed certificates); the `ws` dependency is gone
- Rate limiting of failed attempts, cross-site and DNS-rebinding protection, Content Security Policy and other security headers
- Large transfers are no longer cut off after 5 minutes (Node's default request timeout is off)
- Existing paired phones must scan the QR code once more; old `?t=` links stop working

## 1.0.0
First release of UFTI (Unified File Transfer Interface): Scan and Send, cross-platform Wi-Fi file transfer via QR.
- Windows desktop app with a tray icon and optional start with Windows
- Phone side is a web page: works in the phone's default browser on iPhone and Android, nothing to install on the phone
- Scan a QR code to connect; send and receive files and text in both directions with live progress
- Sent and received history on both devices, with a clear option
- Compact interface with light and dark themes
- No Wi-Fi mode: PC hotspot, or the phone's own hotspot (iPhone, Android Wi-Fi or USB tethering)
- iPhone Share button support through an iOS Shortcut; Android share apps through a standard multipart upload
- Pairing token, PC-only controls for hotspot and firewall, sanitized file names
- Windows installer and portable builds
