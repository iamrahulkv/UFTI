# Contributing to UFTI

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Set up
```bash
git clone https://github.com/iamrahulkv/UFTI.git
cd UFTI
npm install
npm run app    # desktop app
npm test       # smoke test of the API
```
Node.js 18+ is required. The project has no build step: `server.js`, `main.js` and `public/index.html` run as written.

## Project layout
| Path | What it is |
|---|---|
| `server.js` | HTTP + WebSocket backend |
| `main.js` | Electron shell (window, tray) |
| `public/` | The web UI used on PC and phone (single page, no framework) |
| `test/smoke.js` | End-to-end API test |
| `docs/` | Documentation and screenshots |

See [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) for the design and API.

## Pull requests
1. Fork, then create a branch from `main`.
2. Keep changes focused. Match the existing style (plain JS, small functions, no new heavy dependencies without discussion).
3. Run `npm test`. Add a check to `test/smoke.js` for new API behaviour.
4. Test the UI on a real phone if you touch `public/`.
5. Update the README or docs if behaviour changes, and add a line to `CHANGELOG.md`.

## Good first issues
Short pairing PIN, mDNS discovery, clipboard sync, dark/light theme toggle, drag-to-reorder, translations.

## Reporting bugs
Include your Windows and iOS versions, what you expected, what happened, and the output of `npm start` if relevant.
