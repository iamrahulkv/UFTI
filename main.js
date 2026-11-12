// UFTI native Windows app: wraps the local server in a desktop window + tray icon.
const { app, BrowserWindow, Tray, Menu, shell, clipboard, nativeImage, nativeTheme } = require('electron');
const path = require('path');

process.env.NO_OPEN = '1';
process.env.UFTI_DATA = app.getPath('userData');

if (!app.requestSingleInstanceLock()) app.quit();

let win, tray, quitting = false, srv;
const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));

function phoneUrl() {
  const ip = srv.lanIPs()[0];
  return ip ? `http://${ip}:${srv.PORT}/?t=${srv.TOKEN}` : null;
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 520, height: 760, minWidth: 380, minHeight: 520,
    title: 'UFTI', icon, backgroundColor: nativeTheme.shouldUseDarkColors ? '#071226' : '#F2F5FB', autoHideMenuBar: true,
  });
  win.loadURL(`http://localhost:${srv.PORT}/?t=${srv.TOKEN}`);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // Closing the window keeps the app running in the tray so the phone can still send.
  win.on('close', e => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
}

function createTray() {
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('UFTI: ready to receive');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open UFTI', click: showWindow },
    { label: 'Open received folder', click: () => shell.openPath(srv.DIR) },
    { label: 'Copy phone link', click: () => { const u = phoneUrl(); if (u) clipboard.writeText(u); } },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: m => app.setLoginItemSettings({ openAtLogin: m.checked }) },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

app.on('second-instance', showWindow);
app.whenReady().then(() => {
  srv = require('./server.js'); // starts listening on 0.0.0.0:PORT
  createWindow();
  createTray();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Open received folder', accelerator: 'Ctrl+O', click: () => shell.openPath(srv.DIR) },
      { label: 'Copy phone link', click: () => { const u = phoneUrl(); if (u) clipboard.writeText(u); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } } ] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] },
  ]));
});
// Quitting from the tray also switches off a hotspot that UFTI started.
let cleaned = false;
app.on('before-quit', e => {
  quitting = true;
  if (cleaned || !srv) return;
  cleaned = true;
  e.preventDefault();
  srv.stopOwnedHotspot().finally(() => app.quit());
});
app.on('window-all-closed', () => {}); // stay in tray
