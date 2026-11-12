# How UFTI works

## Architecture

```
 iPhone (Safari)                          Windows PC
 ┌───────────────┐   HTTP + WebSocket   ┌───────────────────────────────┐
 │ public/       │ <------------------> │ server.js (Node http + ws)    │
 │ index.html    │      same Wi-Fi      │   - REST API                  │
 └───────────────┘                      │   - WebSocket broadcast       │
                                        │   - files on disk, text in RAM│
 PC window = Electron (main.js) showing └───────────────────────────────┘
 the same page on http://localhost:8787
```

- `server.js` is the whole backend: a plain Node `http` server plus the `ws` WebSocket library. It listens on `0.0.0.0:8787`.
- `public/index.html` is the single-page UI used on both devices. It is also a PWA (manifest and icon), so iOS can add it to the Home Screen.
- `hotspot.js` starts and stops the Windows Mobile Hotspot (WinRT `NetworkOperatorTetheringManager`, driven through PowerShell) and adds the firewall rule. It is Windows-only and reports `supported: false` elsewhere.
- `netkinds.js` maps a network address to a connection kind: PC hotspot (`192.168.137.x`), phone hotspot (iPhone `172.20.10.x`, Android `192.168.43.x` and USB tethering `192.168.42.x`), or an ordinary network.
- `main.js` is the Electron shell. It starts the server in-process, opens a window, and adds the tray icon.
- Connection modes: UFTI recognises `192.168.137.x` as the Windows hotspot and the default ranges of iPhone and Android hotspots (Wi-Fi or USB) as a phone hotspot, so the PC window can show the right QR code for whichever network is active. See [NO-WIFI.md](NO-WIFI.md).
- Pairing: on first start the server creates a random token (`.token` in the data folder). The QR code encodes `http://<LAN-IP>:8787/?t=<token>`. The page stores the token in `localStorage`. Every API call and the WebSocket must present it.
- History: every device generates a random id (kept in `localStorage`) and sends it as `x-client`. The UI uses it to show what *this* device sent and what it received.
- Sync: when anything is added or removed, the server broadcasts a WebSocket message, so every connected device updates immediately.

## Data locations
| Run mode | Received files and token |
|---|---|
| Desktop app | `%APPDATA%\ufti\` |
| `npm start` | the project folder (`received/`, `.token`) |
| Custom | set the `UFTI_DATA` environment variable |

The transfer history (files and text) is saved in `history.json` in the same folder, so it survives restarts. It keeps the latest 500 entries; older ones are dropped, and their files are deleted.

## Configuration
| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP/WebSocket port |
| `UFTI_DATA` | project folder | where `received/` and `.token` live |
| `UFTI_HOST` | auto-detected | force the address shown in the QR code and phone link, for example `192.168.1.20` (useful with VPNs or virtual adapters) |
| `NO_OPEN` | unset | set to stop `npm start` opening the browser |

## HTTP API
All routes except static files need the token, either as `?t=<token>` or the `x-token` header.

| Method and path | Purpose |
|---|---|
| `GET /api/info` | `{ urls, items, host }`: LAN URLs and everything shared |
| `GET /api/qr?u=<url>` | QR code (SVG) for a URL |
| `POST /api/upload` | Either raw file bytes in the body, or a `multipart/form-data` body (any number of file fields, plus optional `title`, `text`, `url` fields that become one text item). Name in the `x-filename` header (URL-encoded) or `?name=`. Optional `x-device` (device label) and `x-client` (sender id, used for the Sent/Received split), either as headers or as `?device=` and `?client=` in the URL |
| `POST /api/text` | Plain text body, or JSON `{ "text": "...", "from": "..." }` |
| `GET /api/file/<id>` | Download a file |
| `POST /api/clear` | Clear history. JSON `{ "ids": [...], "deleteFiles": false }`. Omit `ids` to clear everything. With `deleteFiles: true` the stored files are deleted too |
| `DELETE /api/item/<id>` | Delete a file or text |
| `GET /api/network` | PC window only. Detected addresses with a kind (`network`, `pc-hotspot`, `iphone-hotspot`) and the ready-made phone link for each |
| `POST /api/network/select` | PC window only. `{ "ip": "..." }`: choose which address the QR code uses |
| `GET /api/hotspot`, `POST /api/hotspot` | PC window only. Windows Mobile Hotspot status, and `{ "action": "start" \| "stop" }` |
| `POST /api/firewall` | PC window only. Adds a Windows Firewall rule for the app port (shows the admin prompt) |

Routes marked "PC window only" answer only requests that come from the PC itself (loopback). A phone on the network gets `403`, even with a valid token, so it can never start the hotspot or read the hotspot password.

Examples:
```bash
curl -X POST "http://PC-IP:8787/api/upload?t=TOKEN&name=photo.jpg" --data-binary @photo.jpg
curl -X POST "http://PC-IP:8787/api/text?t=TOKEN" -d "hello from the terminal"
```

## WebSocket
Connect to `ws://<host>:8787/ws?t=<token>`. Messages from the server:
- `{ "type": "add", "item": { ... } }`
- `{ "type": "remove", "id": "..." }`

## Build and test
```bash
npm test        # starts the server on a temp dir and exercises every route
npm run app     # run the desktop app
npm run dist    # build installer + portable exe into dist/
```
