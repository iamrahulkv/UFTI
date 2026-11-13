# UFTI for iPhone (native app)

The iPhone app is the host, the way the Windows app is. It shows the same screen as the Windows app (the same `public/index.html`), and an Android phone, or any browser, scans its QR code to send and receive files.

```
 Android (browser)                       iPhone (UFTI app)
 ┌───────────────┐   HTTP + live events  ┌──────────────────────────────┐
 │ public/       │ <-------------------> │ UFTIServer.swift (port 8787) │
 │ index.html    │      same Wi-Fi       │  same routes as server.js    │
 └───────────────┘                       │ WKWebView shows the same page│
                                         └──────────────────────────────┘
```

## What is in `ios/`
| File | Port of |
|---|---|
| `UFTI/UFTIServer.swift` | `server.js`: same routes and JSON |
| `UFTI/HTTPServer.swift` | the Node `http` module (Network.framework, streaming uploads and downloads, Server-Sent Events) |
| `UFTI/Auth.swift` | `auth.js`: one-time pairing, per-device sessions, share keys, rate limiting |
| `UFTI/Store.swift` | history and the received files |
| `UFTI/Network.swift` | `netkinds.js`, plus the QR image |
| `UFTI/UFTIApp.swift` | the app shell: a web view signed in as "This iPhone" |
| `project.yml` | [XcodeGen](https://github.com/yonaskolb/XcodeGen) spec; `public/` is bundled unchanged |

## Build it
iOS apps can only be built with Xcode, which runs only on a Mac. You don't need to own one: the **iOS** workflow in `.github/workflows/ios.yml` builds on a GitHub macOS runner. Run it from the Actions tab (**Run workflow**) and download the `UFTI-ios-unsigned` artifact (`UFTI-ios-unsigned.ipa`).

On a Mac you can also build locally:
```bash
brew install xcodegen
cd ios && xcodegen generate && open UFTI.xcodeproj
```
In Xcode choose your Apple ID under Signing & Capabilities, pick your iPhone, and press Run.

## Install it on your iPhone
See the step-by-step guide: [INSTALL-IPHONE.md](INSTALL-IPHONE.md). Tagging a commit `ios-vX.Y.Z` makes the workflow publish the `.ipa` as a GitHub release.

## Use it
1. Open UFTI on the iPhone. The top of the screen shows the QR code and the address.
2. On the Android phone, scan the QR code with the camera and open the link. Both phones must be on the same Wi-Fi, or the Android phone must be joined to the iPhone's Personal Hotspot.
3. Send files and text from either side. Received files are kept in the Files app under **On My iPhone, UFTI, received**. Tap **Save** on an item to open the iOS share sheet (Save to Photos, Save to Files, AirDrop).

## Limits to know about
- **Keep the app open.** iOS suspends apps in the background, so the server only answers while UFTI is on screen. UFTI keeps the screen awake while it is open.
- **Local network permission.** iOS asks "UFTI would like to find and connect to devices on your local network". Allow it.
- **No PC hotspot or firewall controls.** Those panels do nothing on iPhone. To work without Wi-Fi, turn on Personal Hotspot in Settings and join it from the Android phone.
- **Multipart uploads** (some Android share apps) are not supported yet. Raw uploads, the web page, and share keys with `curl --data-binary` all work.
- **Not compiled or tested yet.** The Swift code was written on Windows without Xcode. Expect to fix a few compile errors on the first CI run.
