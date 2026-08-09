const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const isDev = process.env.NODE_ENV === 'development';

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Vulcan',
    icon: path.join(__dirname, '../build/icon-titlebar.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      // Pin localStorage to a stable partition based on userData path,
      // not the URL origin — this prevents data loss when switching between
      // dev (localhost:5173) and production (file://) modes.
      partition: `persist:vulcan`,
    },
  });

  // Open external links in the system browser, not inside Electron
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    // Dev: load from Vite dev server
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools();
  } else {
    // Production: load the built static files
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

// Flush storage to disk before quitting. Electron/Chromium buffers localStorage
// writes and flushes them asynchronously; if the process is terminated (e.g. the
// parent shell from setup.sh exits and sends SIGTERM) before a flush completes,
// recent writes — including config and chats — are silently lost. This handler,
// plus handling termination signals, makes persistence reliable.
async function flushAndQuit() {
  try {
    const ses = require('electron').session.defaultSession;
    await ses.flushStorageData();
  } catch { /* best effort */ }
}

app.on('before-quit', async (e) => {
  // Give the flush a chance to complete before the process exits
  e.preventDefault();
  await flushAndQuit();
  app.exit(0);
});

// Handle being killed by the parent shell (setup.sh launches with `&`)
process.on('SIGTERM', async () => { await flushAndQuit(); app.exit(0); });
process.on('SIGHUP', async () => { await flushAndQuit(); app.exit(0); });

// IPC: open a folder in the native file explorer
ipcMain.handle('open-folder', async (_event, folderPath) => {
  await shell.openPath(folderPath);
});


// Prepared native export sessions. Bytes arrive from the encrypted Vulcan WS in
// the renderer, are appended here to <filename>.tmp, and are atomically renamed
// only after the full transfer completes.
const preparedNativeExports = new Map();

ipcMain.handle('native-file-export-prepare', async (_event, payload) => {
  const transferId = String(payload?.transferId || '');
  if (!transferId) throw new Error('Missing native export transfer id');
  const rawName = String(payload?.filename || 'workspace-export');
  const filename = path.basename(rawName).replace(/[\x00-\x1f]/g, '_') || 'workspace-export';
  const dragDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vulcan-drag-'));
  const finalPath = path.join(dragDir, filename);
  const tmpPath = finalPath + '.tmp';
  fs.writeFileSync(tmpPath, Buffer.alloc(0));
  preparedNativeExports.set(transferId, { dragDir, filename, tmpPath, finalPath, complete: false });
  return { ok: true, filename };
});

ipcMain.handle('native-file-export-append', async (_event, payload) => {
  const transferId = String(payload?.transferId || '');
  const state = preparedNativeExports.get(transferId);
  if (!state) throw new Error('Native export session not found');
  if (state.complete) throw new Error('Native export is already complete');
  const base64 = String(payload?.base64 || '');
  if (base64) fs.appendFileSync(state.tmpPath, Buffer.from(base64, 'base64'));
  return { ok: true };
});

ipcMain.handle('native-file-export-finish', async (_event, payload) => {
  const transferId = String(payload?.transferId || '');
  const state = preparedNativeExports.get(transferId);
  if (!state) throw new Error('Native export session not found');
  if (!state.complete) {
    fs.renameSync(state.tmpPath, state.finalPath);
    state.complete = true;
  }
  return { ok: true, filename: state.filename };
});

ipcMain.handle('native-file-export-cancel', async (_event, payload) => {
  const transferId = String(payload?.transferId || '');
  const state = preparedNativeExports.get(transferId);
  if (state) {
    preparedNativeExports.delete(transferId);
    try { fs.rmSync(state.dragDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return { ok: true };
});

ipcMain.on('native-file-drag-prepared-start', (event, payload) => {
  try {
    const transferId = String(payload?.transferId || '');
    const state = preparedNativeExports.get(transferId);
    if (!state || !state.complete) throw new Error('Prepared native export is not complete');
    event.sender.startDrag({
      file: state.finalPath,
      icon: path.join(__dirname, '../build/icon.png'),
    });
    event.sender.send('native-file-drag-end');
    setTimeout(() => {
      const latest = preparedNativeExports.get(transferId);
      if (latest === state) preparedNativeExports.delete(transferId);
      try { fs.rmSync(state.dragDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }, 60_000);
  } catch (err) {
    console.error('Failed to start prepared native workspace drag:', err);
  }
});

// IPC: materialize a server-exported workspace item and hand it to the OS drag cursor.
// The renderer never needs the harness filesystem path; local and remote harnesses
// therefore use the exact same export flow.
ipcMain.on('native-file-drag-start', (event, payload) => {
  try {
    const rawName = String(payload?.filename || 'workspace-export');
    // basename prevents a server-provided filename from escaping the temp directory.
    const filename = path.basename(rawName).replace(/[\x00-\x1f]/g, '_') || 'workspace-export';
    const base64 = String(payload?.base64 || '');
    const dragDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vulcan-drag-'));
    const exportPath = path.join(dragDir, filename);
    fs.writeFileSync(exportPath, Buffer.from(base64, 'base64'));

    event.sender.startDrag({
      file: exportPath,
      icon: path.join(__dirname, '../build/icon.png'),
    });
    event.sender.send('native-file-drag-end');

    // startDrag returns after the native drag operation finishes. Give the target
    // application time to consume the source path, then discard our temp copy.
    setTimeout(() => {
      try { fs.rmSync(dragDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }, 60_000);
  } catch (err) {
    console.error('Failed to start native workspace drag:', err);
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
