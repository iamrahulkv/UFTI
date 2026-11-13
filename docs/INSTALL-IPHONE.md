# Install UFTI on your iPhone

UFTI for iPhone is not on the App Store, so you install it yourself ("sideloading"). It takes about 15 minutes the first time. Once it is on your iPhone it works like any other app.

**What you need**
- An iPhone with a recent iOS. The app needs iOS 15 or newer. Developer Mode, which iOS 16 and later require, is covered in step 3.
- A Windows PC or a Mac, and a USB cable
- A free Apple ID (the one you use for the App Store is fine)
- The UFTI `.ipa` file from the [releases page](https://github.com/iamrahulkv/UFTI/releases). Pick the release whose name starts with **ios-v**, and download `UFTI-iOS-unsigned-x.y.z.ipa`.

> **Why a tool is needed.** Apple only runs apps that are signed. The `.ipa` on the releases page is unsigned, so a sideloading tool signs it with *your* Apple ID while installing it on *your* iPhone.
>
> **The 7-day limit.** Apps signed with a free Apple ID stop opening after 7 days. You then sign and install again, which keeps your data, or let AltStore refresh it for you (Option A). A paid Apple Developer account ($99 a year) lifts the limit to one year.

Pick **one** option below. Option B is the quickest to try. Option A is better if you plan to keep the app, because it refreshes itself.

---

## Option A: AltStore (refreshes the app for you)

AltStore puts a small helper app on your iPhone. A program on your computer (AltServer) signs apps for it and renews them over Wi-Fi, so you don't have to reinstall every week.

### On Windows
1. Install **iTunes** and **iCloud** from Apple's website, not from the Microsoft Store. AltServer does not work with the Microsoft Store versions. If you already have the Store versions, uninstall them first.
2. Download **AltServer for Windows** from [altstore.io](https://altstore.io) and install it. Windows may ask for firewall access; allow it.
3. Connect the iPhone with the cable and tap **Trust This Computer** on the iPhone.
4. In iTunes, click the small iPhone icon, open **Summary**, and tick **Sync with this iPhone over Wi-Fi**. Click **Apply**.
5. Open AltServer. It lives in the system tray (the arrow at the right of the taskbar). Click its icon, then **Install AltStore**, and choose your iPhone.
6. Enter your Apple ID email and password when asked. They are sent to Apple to sign the app, not to anyone else. If you would rather not use your main Apple ID, create a free second one at appleid.apple.com and use that.

### On a Mac
1. Download **AltServer for macOS** from [altstore.io](https://altstore.io) and open it. It appears in the menu bar.
2. Connect the iPhone and tap **Trust This Computer**.
3. Click the AltServer icon in the menu bar, then **Install AltStore**, and choose your iPhone. Enter your Apple ID when asked.

### Then, on the iPhone (both)
1. Go to **Settings, General, VPN & Device Management**. Under your Apple ID, tap **Trust**.
2. Turn on **Developer Mode** (iOS 16 and later): **Settings, Privacy & Security, Developer Mode**, switch it on, and restart when asked. Confirm after the restart. If you do not see the switch, it appears only after an app has been sideloaded, so finish the steps above first.
3. Open Safari on the iPhone, go to the [releases page](https://github.com/iamrahulkv/UFTI/releases), and download the UFTI `.ipa`. Tap it, then **Share**, then **AltStore**. (Or save it to the Files app, open AltStore, go to **My Apps**, tap **+** and pick the file.)
4. Wait for UFTI to appear in **My Apps**. Open it from your Home Screen.

**Keeping it alive.** AltStore renews the app in the background while the iPhone and the computer running AltServer are on the same Wi-Fi and AltServer is running. You can also open AltStore, go to **My Apps**, and tap **Refresh All**. A free Apple ID allows three active apps, and AltStore counts as one.

---

## Option B: Sideloadly (one install, quick)

1. Download **Sideloadly** for Windows or macOS from [sideloadly.io](https://sideloadly.io). On Windows, it also needs iTunes from Apple's website (see step 1 of Option A).
2. Connect the iPhone with the cable and tap **Trust This Computer**.
3. Open Sideloadly. Your iPhone should appear in the device list.
4. Drag the UFTI `.ipa` onto the Sideloadly window, or click the IPA icon and pick it.
5. Type your Apple ID in the box and click **Start**. Enter your password and the verification code if Apple asks. If sign-in fails, try again with an [app-specific password](https://support.apple.com/102654).
6. Wait for **Done**. UFTI is now on your Home Screen, but it will not open yet.
7. On the iPhone: **Settings, General, VPN & Device Management**, tap your Apple ID, and tap **Trust**.
8. Turn on **Developer Mode** (iOS 16 and later): **Settings, Privacy & Security, Developer Mode**, switch it on and restart. If the switch is missing, it appears once an app has been sideloaded, which you just did, so reopen Settings.
9. Open UFTI.

After 7 days the app stops opening. Repeat steps 3 to 5 with the same file to renew it. Your history and files stay.

---

## Option C: Build it yourself with Xcode (Mac only)
1. Install Xcode from the Mac App Store and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).
2. In Terminal:
   ```bash
   git clone https://github.com/iamrahulkv/UFTI.git
   cd UFTI/ios
   xcodegen generate
   open UFTI.xcodeproj
   ```
3. In Xcode, click the **UFTI** project, open **Signing & Capabilities**, choose your Apple ID as the **Team**, and change the **Bundle Identifier** to something unique, such as `com.yourname.ufti`.
4. Connect your iPhone, choose it at the top of the window, and press **Run**. Then do the **Trust** and **Developer Mode** steps from Option B (steps 7 and 8).

---

## First launch
1. Open UFTI. When iOS asks **"UFTI would like to find and connect to devices on your local network"**, tap **Allow**. UFTI cannot work without it. If you tapped Don't Allow, turn it on under **Settings, UFTI, Local Network**.
2. The app shows a QR code and an address. Keep the app open: iOS pauses apps in the background, so UFTI only answers while it is on screen. It keeps the screen awake while it is open.
3. On the other phone (Android or iPhone), make sure it is on the **same Wi-Fi**, scan the QR code with the camera, and open the link.
4. Send files and text from either side. Received files are in the **Files** app under **On My iPhone, UFTI, received**. Tap **Save** on an item to open the iPhone share sheet (Photos, Files, AirDrop).

To connect to a PC (or another phone) from inside the app instead, tap **Scan QR** at the top, allow the camera, and scan the QR code that UFTI shows there. You can still scan with the Camera app and use the browser any time.

No shared Wi-Fi? Turn on **Settings, Personal Hotspot, Allow Others to Join** on the iPhone, join it from the other phone, then open the **No Wi-Fi** tab in UFTI.

## Troubleshooting
| Problem | Fix |
|---|---|
| "Untrusted Developer" when opening the app | **Settings, General, VPN & Device Management**, tap your Apple ID, then **Trust**. |
| No **Developer Mode** switch in Settings | It shows up only after a sideloaded app is on the iPhone. Install first, then look again. Restart the iPhone if it still is not there. |
| The app closes at once, or says it can't be verified | The 7 days ran out. Install again (Option A refreshes itself; Option B, repeat the install). |
| The computer does not see the iPhone | Use an original or good cable, unlock the iPhone, tap **Trust This Computer**, and make sure iTunes is from Apple's site, not the Microsoft Store. |
| AltStore or Sideloadly refuses with an Apple ID error | Try an app-specific password, or a second free Apple ID. Apple limits a free account to 10 new app IDs a week, so wait a few days if you installed many apps. |
| The other phone can't open the link | Both phones must be on the same Wi-Fi, UFTI must be open on screen, and **Local Network** must be on for UFTI. Some public or guest Wi-Fi blocks device-to-device traffic. Try Personal Hotspot instead. |
| The QR code says "Pairing link expired" | Each code works once. A new one appears on the iPhone within seconds. Scan again. |

More help: [Troubleshooting](TROUBLESHOOTING.md). For how the iPhone app is built, see [IOS.md](IOS.md).

## Is it safe?
The `.ipa` is built by a [GitHub Actions workflow](../.github/workflows/ios.yml) from the source in this repository, so you can read exactly what it does. UFTI sends data only between your own devices over your local network, with no cloud server. See [SECURITY.md](../SECURITY.md). The sideloading tools send your Apple ID to Apple only, to sign the app.
