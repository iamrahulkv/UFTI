# How UFTI works

## Architecture

```
 Phone (any browser)                      Windows PC
 ┌───────────────┐   HTTP + live events   ┌───────────────────────────────┐
 │ public/       │ <--------------------> │ server.js (Node http)         │
 │ index.html    │      same Wi-Fi        │   - REST API                  │
 └───────────────┘                        │   - Server-Sent Events        │
                                          │   - files on disk, history    │
 PC window = Electron (main.js) showing   └───────────────────────────────┘
 the same page on http://localhost:8787
```

- `server.js` is the backend: a plain Node `http` server. It listens on `0.0.0.0:8787`.
- `auth.js` handles pairing codes, sessions, share keys and the rate limiter.
- `public/index.html` is the single-page UI used on both devices. It is also a PWA (manifest and icon), so phones can add it to the Home Screen.
- `hotspot.js` starts and stops the Windows Mobile Hotspot (WinRT `NetworkOperatorTetheringManager`, driven through PowerShell) and adds the firewall rule. It is Windows-only and reports `supported: false` elsewhere.
- `netkinds.js` maps a network address to a connection kind: PC hotspot (`192.168.137.x`), phone hotspot (iPhone `172.20.10.x`, Android `192.168.43.x` and USB tethering `192.168.42.x`), or an ordinary network.
- `main.js` is the Electron shell. It starts the server in-process, opens a window, and adds the tray icon.

## How a device gets in
1. The PC window shows a QR code for `http://<PC-IP>:8787/?p=<code>`. The code is random, works **once**, and expires in 5 minutes. A fresh one appears after each scan.
2. The phone opens the link. UFTI checks the code, creates a session for that device, sets it as an `HttpOnly`, `SameSite=Strict` cookie, and redirects to `/`. The address bar is clean from then on.
3. Every API call and the live-events stream carry that cookie. Revoking the device on the PC deletes the session and closes its stream.
4. The PC window signs itself in the same way, with its own one-time code over `localhost`.
5. Tools that can't use cookies (iOS Shortcuts, Android share apps) use a **share key** created in the PC window. A key works only for uploading files and text.

Sessions and keys are random 128-bit values. Only their SHA-256 hashes are written to `sessions.json`.

## Other design notes
- Connection modes: UFTI recognises `192.168.137.x` as the Windows hotspot and the default ranges of iPhone and Android hotspots (Wi-Fi or USB) as a phone hotspot, so the PC window can show the right QR code for whichever network is active. See [NO-WIFI.md](NO-WIFI.md).
- History: every device generates a random id (kept in `localStorage`) and sends it as `x-client`. The UI uses it to show what *this* device sent and what it received.
- Live updates: when anything is added or removed, the server pushes a Server-Sent Event, so every connected device updates immediately. The phone only listens, so no WebSocket is needed.
- Transfers stream straight to and from disk, and the request timeout is switched off so very large files are not cut off after five minutes.

## Data locations
| Run mode | Where the files below live |
|---|---|
| Desktop app | `%APPDATA%\ufti\` |
| `npm start` | the project folder |
| Custom | set the `UFTI_DATA` environment variable |

| File | What it holds |
|---|---|
| `received/` | the transferred files |
| `history.json` | the transfer history (latest 500 entries; older ones are dropped, and their files are deleted) |
| `sessions.json` | paired devices and share keys, as hashes |

## Configuration
| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `UFTI_DATA` | project folder | where the data files live |
| `UFTI_HOST` | auto-detected | force the address shown in the QR code, for example `192.168.1.20` (useful with VPNs or virtual adapters) |
| `NO_OPEN` | unset | set to stop `npm start` opening the browser |

## HTTP API
Browsers authenticate with the session cookie. Tools use a share key, as `?t=<key>` or the `x-token` header, and only for `POST /api/upload` and `POST /api/text`. Routes marked **PC** answer only the UFTI window on the PC (a phone gets `403`).

| Method and path | Purpose |
|---|---|
| `GET /?p=<code>` | Pair: use a one-time code, set the session cookie, redirect to `/` |
| `GET /api/info` | `{ items, host, me }`: everything shared, and this device |
| `GET /api/events` | Server-Sent Events: `{ "type": "add", "item": ... }` and `{ "type": "remove", "id": ... }` |
| `GET /api/qr?u=<text>` | QR code (SVG) for any text |
| `POST /api/upload` | Raw file bytes in the body, or a `multipart/form-data` body (any number of file fields, plus optional `title`, `text`, `url` fields that become one text item). Name in the `x-filename` header (URL-encoded) or `?name=`. Optional `x-device` (device label) and `x-client` (sender id, used for the Sent/Received split), as headers or as `?device=` and `?client=` |
| `POST /api/text` | Plain text body, or JSON `{ "text": "...", "from": "..." }` |
| `GET /api/file/<id>` | Download a file |
| `DELETE /api/item/<id>` | Delete a file or text |
| `POST /api/clear` | Clear history. JSON `{ "ids": [...], "deleteFiles": false }`. Omit `ids` to clear everything. With `deleteFiles: true` the stored files are deleted too |
| `GET /api/network` **PC** | Detected addresses with a kind and the ready-made pairing link for each |
| `POST /api/network/select` **PC** | `{ "ip": "..." }`: choose which address the QR code uses |
| `GET /api/pairing` **PC** | The current one-time pairing code |
| `GET /api/devices`, `DELETE /api/devices/<id>` **PC** | List paired devices and share keys; remove one |
| `POST /api/keys` **PC** | `{ "name": "..." }`: create a share key (returned once) |
| `GET /api/hotspot`, `POST /api/hotspot` **PC** | Windows Mobile Hotspot status, and `{ "action": "start" \| "stop" }` |
| `POST /api/firewall` **PC** | Adds a Windows Firewall rule for the app port (shows the admin prompt) |

Examples with a share key from the PC window:
```bash
curl -X POST "http://PC-IP:8787/api/upload?t=KEY&name=photo.jpg" --data-binary @photo.jpg
curl -X POST "http://PC-IP:8787/api/text?t=KEY" -d "hello from the terminal"
curl -F "file=@photo.jpg" "http://PC-IP:8787/api/upload?t=KEY&device=Android"
```

## Build and test
```bash
npm test        # unit tests, then the end-to-end test (pairing, sessions, keys, live events, rate limit)
npm run app     # run the desktop app
npm run dist    # build installer + portable exe into dist/
```
