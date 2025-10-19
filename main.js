const { app, BrowserWindow, ipcMain, Menu  } = require('electron');
const { AccessToken } = require('livekit-server-sdk');

ipcMain.handle('getAppVersion', () => app.getVersion());

const API_KEY = 'devkey';
const API_SECRET = 'devsecret';

const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');



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
  const win = new BrowserWindow({
    width: 1620,
    height: 920,
    resizable: false,        // 👈 disables resizing
    maximizable: false,      // 👈 disables the maximize button
    fullscreenable: false,   // 👈 disables fullscreen (optional)
    icon: path.join(__dirname, 'assets/icons/png/64x64.png'),
    webPreferences: {
      nodeIntegration: true,      // ok for dev
      contextIsolation: false     // ok for dev
    }
  });
  win.loadFile('index.html');
  win.webContents.openDevTools();

    // --- Remove all default menus ---
  Menu.setApplicationMenu(null);
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

app.whenReady().then(createWindow);