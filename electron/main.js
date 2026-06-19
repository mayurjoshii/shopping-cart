const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');

const isDev = process.env.ELECTRON_DEV === 'true';

const MEDIA_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic',
  'mp4', 'mov', 'avi', 'mkv', 'm4v',
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#111111',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    win.loadURL('http://localhost:3000');
  } else {
    win.loadURL(
      url.format({
        pathname: path.join(__dirname, '..', 'build', 'index.html'),
        protocol: 'file:',
        slashes: true,
      })
    );
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('open-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    message: 'Choose a folder of photos and videos to review',
  });
  if (result.canceled || !result.filePaths.length) return [];

  const folder = result.filePaths[0];
  const entries = fs.readdirSync(folder);
  return entries
    .filter((name) => {
      const ext = name.split('.').pop().toLowerCase();
      return MEDIA_EXTENSIONS.has(ext) && !name.startsWith('.');
    })
    .map((name) => path.join(folder, name))
    .sort();
});

ipcMain.handle('delete-files', async (_event, filePaths) => {
  for (const filePath of filePaths) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error('Failed to delete', filePath, err);
    }
  }
});
