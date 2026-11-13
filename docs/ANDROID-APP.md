# UFTI for Android (native app)

The Android app works like the [iPhone app](IOS.md). The phone is the host, the way the Windows app is: it shows the same screen as the Windows app (the same `public/index.html`) and a QR code. A Windows PC, an iPhone, another Android phone or any browser scans that code to send and receive files. The app can also be a client: scan another UFTI's QR code and use it inside the app.

```
 Windows / iPhone / Android / browser          Android (UFTI app)
 ┌───────────────┐   HTTP + live events   ┌────────────────────────────────┐
 │ public/       │ <--------------------> │ UFTIServer.kt (port 8787)      │
 │ index.html    │      same Wi-Fi        │  same routes as server.js      │
 └───────────────┘                        │ WebView shows the same page    │
                                          └────────────────────────────────┘
```

## Works with the other UFTI apps
All the apps speak the same protocol ([HOW-IT-WORKS.md](HOW-IT-WORKS.md)), so every pairing works in both directions:

| Host (shows the QR code) | Client (scans it) |
|---|---|
| Android app | iPhone app (**Scan QR**), Android app (**Scan QR**), Windows PC or any phone browser |
| iPhone app | Android app (**Scan QR**), iPhone app, any browser |
| Windows app | Android app (**Scan QR**), iPhone app, any browser |

The QR code holds `http://<ip>:8787/?p=<one-time code>` in every app, and every app accepts only links like that on a private network address.

## Install it
Download `UFTI-Android-x.y.z.apk` from the [releases page](https://github.com/iamrahulkv/UFTI/releases) (the release named **android-v…**), open it on the phone and allow **Install unknown apps** for the app you opened it from (your browser or Files app). It is signed with a debug key, so it is for sideloading, not the Play Store.

Android may ask for two permissions:
- **Notifications**, so the "UFTI is ready" notice is visible while UFTI runs in the background.
- **Camera**, only when you tap **Scan QR**.

## Use it
1. Open UFTI on the Android phone. The top of the page shows the QR code and the address.
2. On the other device (PC, iPhone or another phone on the **same Wi-Fi**), scan the QR code with the camera and open the link. Or use that device's UFTI app and its **Scan QR** button.
3. Send files and text from either side. Received files are kept inside the app. Tap **Save** to copy one to **Downloads/UFTI** (on Android 9 and older a file picker asks where to put it). Tap **Copy** to put an image or file on the clipboard and paste it into a chat.
4. For a connection without Wi-Fi, turn on the phone's **Wi-Fi hotspot** (Settings, Network, Hotspot and tethering) and join it from the other device. UFTI detects the hotspot and shows its QR code under **No Wi-Fi, Phone hotspot**.

## Scan a QR code inside the app
Tap **Scan QR** and point the camera at the QR code shown by UFTI on a PC or another phone. The app pairs with it and shows that device's UFTI page inside the app.

- **Save** downloads the file into **Downloads/UFTI**. **Copy** puts it on the clipboard (the app adds this itself, so it works with every UFTI version).
- **Reconnect** opens the last device again without a new scan, unless it was removed there. **Disconnect** returns to this phone's own screen, which keeps sharing meanwhile.

## Running in the background
Unlike iOS, Android lets an app keep a server running behind a visible notification. While UFTI is open, a foreground service keeps it answering with the screen off or another app in front. The notification has a **Stop** button. The CPU and Wi-Fi are held awake only while a transfer is under way. The Back button sends UFTI to the background instead of closing it.

## What is in `android/`
| File (`app/src/main/java/com/ufti/android/`) | Port of |
|---|---|
| `server/UFTIServer.kt` | `server.js`: same routes and JSON |
| `server/HttpServer.kt` | the Node `http` module (sockets, streaming uploads and downloads, Server-Sent Events) |
| `server/Auth.kt` | `auth.js`: one-time pairing, per-device sessions, share keys, rate limiting |
| `server/Store.kt` | history and the received files |
| `server/Net.kt` | `netkinds.js`, plus the QR image (SVG) |
| `UFTIApp.kt` | owns the server for the whole process, and the connection state |
| `UFTIService.kt` | the foreground service that keeps the server alive |
| `MainActivity.kt` | the top bar, the web view, the QR scanner, native Save and Copy |
| `RemoteLink.kt` | which scanned links are accepted (same rules as the iPhone app) |
| `Files.kt` | clipboard and Save to Downloads |

The `server/` package uses no Android classes, so its tests run on the plain JVM. `public/` is copied into the app unchanged at build time.

## Build it
Needs JDK 17 and the Android SDK (platform 34). Android Studio sets both up.
```bash
cd android
./gradlew testDebugUnitTest   # server tests, including a Node client talking to the Android server
./gradlew assembleRelease     # app/build/outputs/apk/release/app-release.apk
```
The **Android** workflow in `.github/workflows/android.yml` does the same on GitHub. Tagging a commit `android-vX.Y.Z` publishes the APK as a release.

## Limits to know about
- **Multipart uploads** (some share apps) are not supported yet, as in the iPhone app. Raw uploads, the web page and share keys with `curl --data-binary` all work.
- **Hotspot control:** an app can't start the phone's hotspot, so the PC hotspot and firewall panels don't apply. Turn the hotspot on in Settings.
- **Not tried on a physical phone yet.** The server is tested end to end on the JVM and against a Node client, the APK builds and passes lint, but the screens (web view, scanner, Save, Copy, foreground service) have not been run on a device or emulator. Please [open an issue](https://github.com/iamrahulkv/UFTI/issues/new/choose) with what you find.
