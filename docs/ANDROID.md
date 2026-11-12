# Using UFTI with an Android phone

UFTI works with Android the same way it works with an iPhone: the PC runs the app, the phone opens a web page in Chrome (or any browser). Nothing to install on the phone.

> **Status:** verified with emulated Android Chrome and with the same upload requests Android share tools send. It has not yet been run on a physical Android phone, so tell us what you find ([open an issue](https://github.com/iamrahulkv/UFTI/issues/new/choose)).

## Quick start
1. Open UFTI on the PC. The **Connect** card shows a QR code.
2. On the Android phone, make sure it's on the **same Wi-Fi**, then scan the QR code with the **Camera** app or **Google Lens** and open the link in Chrome.
3. Send with **Tap or drop files to send** (it opens the Android file picker, camera and gallery) or the text box.
4. Items from the PC show a **Save** button. Saved files go to your **Downloads** folder.
5. *(Optional)* In Chrome, open the menu and choose **Add to Home screen** for an app-style icon.

## No Wi-Fi? Use a hotspot
Same two options as on iPhone. See [no-Wi-Fi guide](NO-WIFI.md) for the full steps.

- **PC hotspot:** in UFTI choose **No Wi-Fi**, then **PC hotspot**, then **Start**. On the phone, scan the left QR code (Camera or Google Lens offers to join the Wi-Fi), then scan the right one.
- **Android phone hotspot:** on the phone, open Settings, Network, Hotspot and tethering, and turn on **Wi-Fi hotspot** (or **USB tethering** with the cable). Join it from the PC. UFTI recognises the usual address ranges (`192.168.43.x` for Wi-Fi hotspot, `192.168.42.x` for USB tethering) and shows the QR code under **No Wi-Fi, Phone hotspot**. Some phones use other ranges. If it isn't detected, open **Same Wi-Fi** and pick the PC's address from the list.

### "No internet" warnings on Android
A hotspot with no internet makes Android ask whether to stay connected, and it may quietly send traffic over mobile data instead. UFTI needs the phone to use the Wi-Fi link:
- Tap **Stay connected** / **Keep Wi-Fi** when Android asks.
- If the page still won't load, turn **mobile data off** for the test, or switch off *Switch to mobile data automatically* in Wi-Fi settings.

## Share straight from other apps (optional)
Android's browser feature for adding an app to the Share menu needs a trusted HTTPS site, and UFTI runs on your local network over plain HTTP. So the web page can't appear in the Share sheet by itself. A free share tool can, the same idea as the [iPhone Shortcut](IPHONE-SHORTCUT.md).

UFTI accepts a standard `multipart/form-data` upload, which most Android tools can send. The request to configure is:

| Setting | Value |
|---|---|
| Method | `POST` |
| URL | `http://<PC-IP>:8787/api/upload?t=<TOKEN>&device=Android` |
| Body | `multipart/form-data` with the shared file in a field (any name, for example `file`) |
| Optional text fields | `title`, `text`, `url` become one text item |

Get `<PC-IP>` and `<TOKEN>` from the phone link in the UFTI window. For example, `http://192.168.1.20:8787/?t=abc123` gives IP `192.168.1.20` and token `abc123`.

Apps that can do this and appear in the Share menu include **HTTP Shortcuts** (free, open source) and **Tasker**. Menu names differ between versions, so follow the app's own guide for "receive shared files" and use the request above. Several files in one share are all saved.

Test it from a terminal (for example Termux) with:
```bash
curl -F "file=@photo.jpg" "http://192.168.1.20:8787/api/upload?t=abc123&device=Android"
```

## Good to know
- **Bluetooth, Wi-Fi Direct and Quick Share** aren't used. UFTI works over a normal Wi-Fi or hotspot link, which is also faster.
- **Large files:** keep the phone screen on and Chrome in the foreground while uploading, or Android may pause the transfer.
- **Photos and videos:** pick them through the file picker's **Photos** or **Gallery** option.
