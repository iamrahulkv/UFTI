# Send from the iPhone Share button

Safari web apps cannot add themselves to the iOS share sheet, but an iOS Shortcut can. With one, you can tap Share in Photos, Files, Safari and more, then choose **Send to PC**. It takes about two minutes and is free.

You need your phone link. Open UFTI on the PC and copy it (tray icon, then **Copy phone link**). It looks like `http://192.168.1.20:8787/?t=abc123`. Note two parts: the **IP** (`192.168.1.20`) and the **token** (`abc123`).

> Tip: give your PC a fixed IP in your router (a "DHCP reservation"), otherwise the shortcut breaks when the IP changes.

## Shortcut 1: files and photos
1. Open **Shortcuts**, tap **+**, and name it **Send to PC**.
2. Tap the **(i)** button and turn on **Show in Share Sheet**. Allow Images, Media, Files, URLs and Text.
3. Add the action **Get Contents of URL** and set:
   - **URL:** `http://192.168.1.20:8787/api/upload?t=abc123` (use your IP and token)
   - Tap **Show More**, **Method:** POST
   - **Headers:**
     - `x-filename` = the variable *Shortcut Input*, then **Name**
     - `x-device` = `iPhone`
   - **Request Body:** File, choose *Shortcut Input*
4. *(Optional)* Add **Show Notification** with text "Sent to PC".

## Shortcut 2: text and links
Make another shortcut named **Send text to PC** with the same steps, but:
- URL: `http://192.168.1.20:8787/api/text?t=abc123`
- No `x-filename` header is needed.

## Photos tip
When you share photos, Shortcuts may offer to convert them. In the Get Contents of URL action, the photo is sent as is (usually HEIC). Convert to JPEG first with the **Convert Image** action if you need that.
