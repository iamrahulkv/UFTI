# Security and privacy

## What UFTI does
- Runs a small web server on your PC, reachable only from your local network.
- Stores received files, and a history of transfers (including shared text), on your PC. Use **Clear history** to remove them.
- Sends nothing to any third party. There is no analytics, account or cloud service.

## Protection model
- Every API call and WebSocket connection needs a random 48-bit pairing token. It is created on first run and stored in `.token` in the data folder.
- Anyone who has the pairing link (or the QR code) can send and download files while the app runs. Treat the link like a password.
- Delete `.token` and restart the app to invalidate every paired device.
- Hotspot, network and firewall controls answer only requests from the PC itself. A phone on the network gets `403` even with a valid token, so it cannot start the hotspot or read its password.
- Hotspot mode uses the name and password saved in Windows (a WPA2 network). Anyone who joins it can reach UFTI's page but still needs the pairing token.
- Uploaded file names are sanitized (no path traversal; reserved characters removed).

## Known limitations
- Traffic is plain **HTTP**, not HTTPS. On a network you do not trust (public or shared Wi-Fi), others could sniff the token or file contents. Use UFTI on your home or a trusted network.
- The token travels in the URL, so it can appear in browser history.
- The token is short enough to stop casual access but is not hardened against a determined attacker on the same network.

Planned improvements: optional HTTPS, a short pairing PIN, and token rotation.

## Reporting a vulnerability
Please do not open a public issue. Use GitHub's private reporting: **Security**, then **Report a vulnerability** on this repository. You will get a response as soon as possible.
