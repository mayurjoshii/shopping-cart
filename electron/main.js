const { app, BrowserWindow, dialog, ipcMain, shell, nativeImage, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');

const isDev = process.env.ELECTRON_DEV === 'true';

const MEDIA_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic',
  'mp4', 'mov', 'avi', 'mkv', 'm4v',
  'pdf',
]);

// Serves local media files to the renderer via a dedicated scheme. In dev the
// renderer is loaded over http://localhost:3000, and Chromium blocks an http
// page from loading file:// resources directly — so a raw `file://` <img src>
// only works in the packaged (file://-loaded) build. This protocol works the
// same way in both dev and prod.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pinder-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
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
      plugins: true, // enables Chromium's built-in PDF viewer for <embed type="application/pdf">
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

app.whenReady().then(() => {
  protocol.handle('pinder-media', async (request) => {
    const filePath = decodeURIComponent(new URL(request.url).pathname);
    if (!fs.existsSync(filePath)) {
      console.error('pinder-media: no such file', filePath);
    }
    try {
      const response = await net.fetch(url.pathToFileURL(filePath).toString());
      if (!response.ok) {
        console.error('pinder-media: fetch not ok', response.status, filePath);
      }
      return response;
    } catch (err) {
      console.error('pinder-media: fetch threw', filePath, err);
      throw err;
    }
  });

  // macOS ignores BrowserWindow's `icon` option, and in dev the Dock shows the
  // default Electron icon. Packaged builds get theirs from assets/icon.icns.
  if (isDev && process.platform === 'darwin') {
    app.dock.setIcon(
      nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'))
    );
  }
  createWindow();
});

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
  if (result.canceled || !result.filePaths.length) return null;

  const folder = result.filePaths[0];
  const entries = fs.readdirSync(folder);
  const filePaths = entries
    .filter((name) => {
      const ext = name.split('.').pop().toLowerCase();
      return MEDIA_EXTENSIONS.has(ext) && !name.startsWith('.');
    })
    .map((name) => path.join(folder, name))
    .sort();

  // Gather stats for each file
  const stats = filePaths.map((fp) => {
    try { return fs.statSync(fp); } catch { return null; }
  });

  // Total size
  const totalSize = stats.reduce((sum, s) => sum + (s ? s.size : 0), 0);

  // Duplicate detection: files sharing the exact same byte size
  const sizeMap = new Map();
  stats.forEach((s, i) => {
    if (!s) return;
    const key = s.size;
    if (!sizeMap.has(key)) sizeMap.set(key, []);
    sizeMap.get(key).push(filePaths[i]);
  });
  const duplicates = [];
  for (const group of sizeMap.values()) {
    if (group.length > 1) duplicates.push(...group);
  }

  return { paths: filePaths, totalSize, duplicates };
});

ipcMain.handle('get-file-info', (_event, filePath) => {
  try {
    const stat = fs.statSync(filePath);
    return { size: stat.size, created: stat.birthtime.toISOString() };
  } catch {
    return null;
  }
});

// Move to Trash instead of permanent deletion
ipcMain.handle('delete-files', async (_event, filePaths) => {
  for (const filePath of filePaths) {
    try {
      await shell.trashItem(filePath);
    } catch (err) {
      console.error('Failed to trash', filePath, err);
    }
  }
});
