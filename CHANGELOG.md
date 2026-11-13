# Changelog

## Unreleased
- The **Clear history** box no longer says "PC" on phones. It says "this PC" or "this iPhone" on the device that runs UFTI, and names that device (for example the PC's name) on any other device. The "not paired" message is reworded the same way

## 1.3.1
- **Copy for received images in phone browsers.** Browsers block the clipboard on plain `http://` pages, which is what a QR link on your Wi-Fi is, so Copy was hidden there. Images now get a Copy button in phone browsers too, using the older copy method (the image is prepared as soon as it arrives). Other file types still need Save. The iPhone app's own Copy is more reliable
- The iPhone app adds its own Copy button when it is connected to another device, so Copy works even with older Windows versions
- **Scan QR inside the iPhone app.** The iPhone app has a **Scan QR** button. Scan the QR code of the Windows app (or another phone running UFTI) and send and receive in the app itself, with no browser. Save opens the iOS share sheet and Copy puts the file on the iPhone clipboard. The app remembers the last device (**Reconnect**), and **Disconnect** returns to this iPhone's own screen. The browser way still works as before

## 1.3.0
- **Copy button for received files**, next to Save, in the Windows app and the iPhone app. Images go on the clipboard as an image so they paste straight into a chat or document without being saved. Other files are copied as files (Windows: paste into Explorer or an email)
- **Native iPhone app (in `ios/`).** The iPhone hosts UFTI, shows the same screen as the Windows app, and an Android phone (or any browser) scans its QR code to send and receive files. See [docs/IOS.md](docs/IOS.md)

## 1.2.1
- The Windows downloads now have "win" in their names: `UFTI-win-Setup-x.y.z.exe` and `UFTI-win-Portable-x.y.z.exe`. The app itself is unchanged

## 1.2.0
Security release. How transfers work is unchanged.
- **One-time pairing.** The QR code holds a code that works once and expires in 5 minutes, then becomes a session for that one device in an HttpOnly cookie. The address bar no longer carries a secret
- **Paired devices list with Revoke.** The new **Paired devices and share keys** panel in the PC window lists every paired device and removes any of them instantly
- **Share keys** for the iPhone Shortcut and Android share apps: named, shown once, revocable, and able to send files and text only
- Live updates now use Server-Sent Events instead of WebSocket, so the `ws` dependency is gone
- Rate limiting of failed attempts, cross-site and DNS-rebinding protection, Content Security Policy and other security headers
- Large transfers are no longer cut off after 5 minutes (Node's default request timeout is off)
- Existing paired phones must scan the QR code once more, and old `?t=` links stop working

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
