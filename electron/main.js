const { app, BrowserWindow, dialog, ipcMain, shell, nativeImage, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const url = require('url');

const isDev = process.env.ELECTRON_DEV === 'true';

const MEDIA_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic',
  'mp4', 'mov', 'avi', 'mkv', 'm4v',
  'pdf',
]);

// gif is excluded — re-encoding to JPEG would drop animation, which matters
// for reviewing it.
const RESIZABLE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);
const THUMB_CACHE_HEADERS = { 'Cache-Control': 'private, max-age=31536000, immutable' };

// Serves local media files to the renderer via a dedicated scheme. In dev the
// renderer is loaded over http://localhost:3000, and Chromium blocks an http
// page from loading file:// resources directly — so a raw `file://` <img src>
// only works in the packaged (file://-loaded) build. This protocol works the
// same way in both dev and prod.
//
// pinder-thumb serves a downscaled copy of the same file (resized in-memory
// via nativeImage, original bytes on disk never touched) so the renderer
// isn't decoding/compositing full multi-megabyte originals for thumbnails
// and the main preview — that's what was causing the swipe/filmstrip lag on
// large photos.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pinder-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
  {
    scheme: 'pinder-thumb',
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

  protocol.handle('pinder-thumb', async (request) => {
    const parsed = new URL(request.url);
    const filePath = decodeURIComponent(parsed.pathname);
    const targetWidth = Number(parsed.searchParams.get('w')) || 160;
    const ext = filePath.split('.').pop().toLowerCase();

    const original = () => net.fetch(url.pathToFileURL(filePath).toString());
    if (!RESIZABLE_EXTENSIONS.has(ext)) return original();

    try {
      const image = nativeImage.createFromPath(filePath);
      if (image.isEmpty()) return original();

      const { width } = image.getSize();
      const resized = width > targetWidth
        ? image.resize({ width: targetWidth })
        : image;
      return new Response(resized.toJPEG(80), {
        headers: { 'Content-Type': 'image/jpeg', ...THUMB_CACHE_HEADERS },
      });
    } catch (err) {
      console.error('pinder-thumb: failed, falling back to original', filePath, err);
      return original();
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

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

// Groups files with identical content. Bucketing by size first means only
// files that could plausibly match ever get read and hashed.
async function findDuplicateGroups(filePaths, stats) {
  const bySize = new Map();
  stats.forEach((s, i) => {
    if (!s) return;
    if (!bySize.has(s.size)) bySize.set(s.size, []);
    bySize.get(s.size).push(filePaths[i]);
  });

  const groups = [];
  for (const candidates of bySize.values()) {
    if (candidates.length < 2) continue;
    const byHash = new Map();
    for (const fp of candidates) {
      try {
        const hash = await hashFile(fp);
        if (!byHash.has(hash)) byHash.set(hash, []);
        byHash.get(hash).push(fp);
      } catch (err) {
        console.error('hashFile failed', fp, err);
      }
    }
    for (const group of byHash.values()) {
      if (group.length > 1) groups.push(group);
    }
  }
  return groups;
}

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

  const duplicateGroups = await findDuplicateGroups(filePaths, stats);

  return { folder, paths: filePaths, totalSize, duplicateGroups };
});

// Marks a reviewed folder as done by prepending "DONE- " to its name.
ipcMain.handle('rename-folder-done', (_event, folderPath) => {
  const parent = path.dirname(folderPath);
  const name = path.basename(folderPath);
  if (name.startsWith('DONE- ')) return folderPath;

  const newPath = path.join(parent, `DONE- ${name}`);
  try {
    fs.renameSync(folderPath, newPath);
    return newPath;
  } catch (err) {
    console.error('rename-folder-done: failed', folderPath, err);
    return null;
  }
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
