# Send from the iPhone Share button

Web pages cannot add themselves to the iOS share sheet, but an iOS Shortcut can. With one, you can tap Share in Photos, Files, Safari and more, then choose **Send to PC**. It takes about two minutes and is free.

You need a **share key**. In the UFTI window on the PC, open **Security and devices**, type a name such as *My iPhone*, and press **Create key**. Copy the upload address it shows, for example `http://192.168.1.20:8787/api/upload?t=uk_AbC123&device=`. A share key can only send files and text, it is shown once, and you can remove it any time.

> Shortcuts can't accept a self-signed certificate, so keep these addresses as `http://`. They keep working even when you turn on HTTPS for the browser.
>
> Tip: give your PC a fixed IP in your router (a "DHCP reservation"), otherwise the shortcut breaks when the IP changes.

## Shortcut 1: files and photos
1. Open **Shortcuts**, tap **+**, and name it **Send to PC**.
2. Tap the **(i)** button and turn on **Show in Share Sheet**. Allow Images, Media, Files, URLs and Text.
3. Add the action **Get Contents of URL** and set:
   - **URL:** `http://192.168.1.20:8787/api/upload?t=<your share key>` (use your PC's IP and your key)
   - Tap **Show More**, **Method:** POST
   - **Headers:**
     - `x-filename` = the variable *Shortcut Input*, then **Name**
     - `x-device` = `iPhone`
   - **Request Body:** File, choose *Shortcut Input*
4. *(Optional)* Add **Show Notification** with text "Sent to PC".

## Shortcut 2: text and links
Make another shortcut named **Send text to PC** with the same steps, but:
- URL: `http://192.168.1.20:8787/api/text?t=<your share key>`
- No `x-filename` header is needed.

## Photos tip
When you share photos, Shortcuts may offer to convert them. In the Get Contents of URL action, the photo is sent as is (usually HEIC). Convert to JPEG first with the **Convert Image** action if you need that.
