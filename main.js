const { app, BrowserWindow, ipcMain } = require('electron');
const { AccessToken } = require('livekit-server-sdk');

const API_KEY = 'devkey';
const API_SECRET = 'devsecret';

function createWindow() {
  const win = new BrowserWindow({
    width: 420,
    height: 320,
    webPreferences: {
      nodeIntegration: true,      // ok for dev
      contextIsolation: false     // ok for dev
    }
  });
  win.loadFile('index.html');
  win.webContents.openDevTools();
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