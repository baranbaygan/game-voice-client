const { app, BrowserWindow, ipcMain, Menu, screen  } = require('electron');
const { AccessToken } = require('livekit-server-sdk');

ipcMain.handle('getAppVersion', () => app.getVersion());

const API_KEY = 'devkey';
const API_SECRET = 'devsecret';

const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

let overlayWin = null;
let mainWin = null;
let IS_QUITTING = false;

function createOverlayWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const w = 360, h = 96; // compact toast area
  overlayWin = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(workArea.x + workArea.width - w - 16),
    y: Math.round(workArea.y + 16),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    type: process.platform === 'darwin' ? 'panel' : 'toolbar',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  overlayWin.setIgnoreMouseEvents(true, { forward: true });
  overlayWin.loadFile('overlay.html');

  overlayWin.on('closed', () => { overlayWin = null; });
}


function readSettings() {
  try {
    // Print the SETTINGS_PATH for debugging
    console.log('Reading settings from:', SETTINGS_PATH);
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch (_) {
    return {}; // first run or invalid JSON
  }
}

function writeSettings(obj) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to write settings:', e);
  }
}

ipcMain.on('overlay:show', (_evt, payload) => {
  if (!overlayWin) return;
  overlayWin.webContents.send('overlay:show', payload);
});

// IPC endpoints
ipcMain.handle('getSetting', (_evt, key) => {
  const s = readSettings();
  return s[key];
});

ipcMain.handle('setSetting', (_evt, { key, value }) => {
  const s = readSettings();
  s[key] = value;
  writeSettings(s);
  return true;
});

function createWindow() {
  mainWin = new BrowserWindow({
    width: 620,
    height: 920,
    resizable: true,        // 👈 disables resizing
    maximizable: false,      // 👈 disables the maximize button
    fullscreenable: false,   // 👈 disables fullscreen (optional)
    icon: path.join(__dirname, 'assets/icons/png/64x64.png'),
    webPreferences: {
      nodeIntegration: true,      // ok for dev
      contextIsolation: false     // ok for dev
    }
  });
  mainWin.loadFile('index.html');
  // win.webContents.openDevTools();

    // --- Remove all default menus ---
  Menu.setApplicationMenu(null);

  // optional, if you want Ctrl+W / close button to fully quit on Windows/Linux
  mainWin.on('close', () => {
    if (!IS_QUITTING) app.quit();
  });
}

ipcMain.handle('getToken', async (_evt, { identity, roomName }) => {
  const at = new AccessToken(API_KEY, API_SECRET, { identity, ttl: 3600 });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true
  });
  return await at.toJwt();
});

// destroy everything on quit
app.on('before-quit', () => {
  IS_QUITTING = true;
  try {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy();
  } catch {}
});

// quit when all windows are closed (except macOS standard behavior)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.whenReady().then(() => {
  createWindow();
  createOverlayWindow();
});