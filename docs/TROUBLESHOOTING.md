# Troubleshooting

## The iPhone can't open the link
1. **Same Wi-Fi?** Both devices must be on the same network. Guest networks often block device-to-device traffic.
2. **Windows Firewall.** On first launch, Windows asks for network access. Allow **Private and Public**. If you clicked Cancel, fix it with:
   ```powershell
   # run PowerShell as Administrator
   netsh advfirewall firewall add rule name="UFTI" dir=in action=allow protocol=TCP localport=8787 profile=any
   ```
3. **Router "AP/client isolation".** Some routers block devices from talking to each other. Turn it off in the router's Wi-Fi settings.
4. **Wrong IP.** A PC with a VPN or virtual adapters (WSL, Hyper-V, VirtualBox) may show several addresses. UFTI prints all of them in the terminal in `npm start` mode. Use the one that starts with your Wi-Fi range, usually `192.168.x.x`. To force it, set `UFTI_HOST` (for example `$env:UFTI_HOST="192.168.1.20"; npm run app`).
5. **iPhone Private Wi-Fi Address / Limit IP Address Tracking** can interfere on some networks. Toggle them off for your home network if nothing else works.
6. Test from the PC itself: open `http://localhost:8787`. If that works, the problem is network or firewall, not the app.

## No Wi-Fi mode problems
- **"Windows needs one network connection to share".** Windows can't start a hotspot with no network on record. Connect to any Wi-Fi or Ethernet once, or use the **iPhone hotspot** tab.
- **The hotspot starts but the iPhone can't open the link.** Click **Phone can't connect? Allow UFTI through the firewall** in the No Wi-Fi view and approve the Windows prompt. Or run PowerShell as Administrator: `netsh advfirewall firewall add rule name="UFTI" dir=in action=allow protocol=TCP localport=8787 profile=any`
- **The iPhone says "No Internet Connection".** Normal for a hotspot with no internet. Stay connected and scan the second QR code.
- **iPhone hotspot isn't detected.** Check the PC is on the iPhone's network (or the USB cable is trusted), then wait a few seconds. UFTI looks for an address starting with `172.20.10.`.
- **Personal Hotspot is greyed out on the iPhone.** Your mobile plan or carrier settings must allow it. Use the PC hotspot option instead.

## Android problems
- **The page won't load on Android over a hotspot.** Android may be sending traffic over mobile data because the hotspot has no internet. Tap **Stay connected** when asked, or turn mobile data off for the transfer. Details in [docs/ANDROID.md](ANDROID.md).
- **Android phone hotspot isn't detected.** UFTI recognises the common default ranges only. Open **Same Wi-Fi** and pick the PC's address from the list instead.
- **Share-sheet entry.** The web page itself can't appear in Android's Share menu (that needs trusted HTTPS). Use a share app such as HTTP Shortcuts with the upload request in [docs/ANDROID.md](ANDROID.md).

## "Not paired" on the phone
The phone isn't paired, or it was removed on the PC. Scan the QR code in the UFTI window with the phone camera. If the PIN is on, type the 4-digit PIN shown there.

## "Pairing link expired"
Each QR code works once and expires after 5 minutes. Scan the current one in the UFTI window. If you didn't pair it yourself, open **Security and devices** and remove any device you don't recognise.

## Certificate warning after turning on HTTPS
That's expected: UFTI's certificate is self-signed. iPhone: Show Details, then visit this website. Android: Advanced, then Proceed. You do it once per phone. Share keys keep using `http://`.

## "Too many attempts" (429)
More than 20 wrong attempts in a minute from one address blocks it for a minute. Wait and try again.

## Port already in use (EADDRINUSE)
Another copy of UFTI, or another program, uses port 8787. Quit the tray copy, or start on another port:
```powershell
$env:PORT=9000; npm start
```

## iPhone download behaviour
Tapping **Save** downloads through your browser's download manager (on iPhone Safari, or any other browser you use). Find files in the **Files** app, under Downloads. To get a photo into the Photos app, open it from Downloads, tap Share, then **Save Image**.

## Large files stall
Keep the phone screen on and the browser in the foreground while uploading. iOS and Android suspend background tabs and can pause the transfer.

## Windows SmartScreen blocks the installer
The installer is not code-signed yet. Click **More info**, then **Run anyway**.

## Still stuck?
[Open an issue](https://github.com/iamrahulkv/UFTI/issues/new/choose) with your Windows version, iOS version, and what you see.
