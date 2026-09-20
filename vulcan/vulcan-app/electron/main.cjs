const { app, BrowserWindow, shell, ipcMain, safeStorage, powerMonitor, protocol, session, net, webContents, nativeImage, Tray, Menu, Notification, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createSecurePasswordStore, registerSecurePasswordIpc } = require('./securePasswordStore.cjs');
const { createSemanticToolCacheStore, registerSemanticToolCacheIpc } = require('./semanticToolCacheStore.cjs');
const { ensurePackagedRuntime, relaunchInstalledLinuxApp } = require('./installCoordinator.cjs');

const isDev = process.env.NODE_ENV === 'development';

const startHidden = process.argv.includes('--hidden');
let mainWindow = null;
let tray = null;
let isQuitting = false;
let shouldShowOnReady = !startHidden;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    shouldShowOnReady = true;
    showMainWindow();
  });
}

function showMainWindow(chatId = null) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!app.isReady()) return;
    createWindow();
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (chatId) mainWindow.webContents.send('vulcan-open-chat', String(chatId));
}

function installTray() {
  if (tray) return tray;
  const trayIconPath = path.join(__dirname, '../build/icon-titlebar.png');
  tray = new Tray(nativeImage.createFromPath(trayIconPath));
  tray.setToolTip('Vulcan');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Vulcan', click: () => showMainWindow() },
    { type: 'separator' },
    { label: 'Exit', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => showMainWindow());
  return tray;
}

function notifyCompletion(payload = {}) {
  if (!Notification.isSupported()) return { shown: false, reason: 'unsupported' };
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
    return { shown: false, reason: 'focused' };
  }
  const chatId = payload?.chatId ? String(payload.chatId) : null;
  const note = new Notification({
    title: String(payload?.title || 'Vulcan'),
    body: String(payload?.body || 'Response complete').slice(0, 240),
    icon: path.join(__dirname, '../build/icon.png'),
  });
  note.on('click', () => showMainWindow(chatId));
  note.show();
  return { shown: true };
}


// Design surfaces use a private, DNS-free origin. The renderer registers a
// route from this logical origin to the currently connected Vulcan server;
// Electron then transports ordinary HTTP-style requests through the existing
// server-side Design proxy.
protocol.registerSchemesAsPrivileged([{
  scheme: 'vulcan-design',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
}]);

const designTransportRoutes = new Map();
const designProtocolPartitions = new Set();
const attachedDesignGuests = new Set();
let modelCatalogFetchPromise = null;

// models.dev is application metadata, not Vulcan-server traffic. Fetch it in
// Electron so a catalog refresh can never occupy the encrypted General WS that
// carries provider streams and latency-sensitive control RPCs.
ipcMain.handle('vulcan-model-catalog-fetch', async () => {
  if (modelCatalogFetchPromise) return modelCatalogFetchPromise;
  modelCatalogFetchPromise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await net.fetch('https://models.dev/models.json', {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  })().finally(() => { modelCatalogFetchPromise = null; });
  return modelCatalogFetchPromise;
});

function designRouteKey(partition, originHost) {
  return `${String(partition)}\0${String(originHost).toLowerCase()}`;
}

function validateTransportBase(raw, schemes) {
  const value = new URL(String(raw || ''));
  if (!schemes.includes(value.protocol)) throw new Error(`Unsupported Design transport scheme: ${value.protocol}`);
  return value.toString().replace(/\/$/, '');
}

function installDesignProtocolForPartition(partition) {
  if (designProtocolPartitions.has(partition)) return;
  const ses = session.fromPartition(partition);
  ses.protocol.handle('vulcan-design', async (request) => {
    const logical = new URL(request.url);
    const route = designTransportRoutes.get(designRouteKey(partition, logical.hostname));
    if (!route) return new Response('Design transport is not configured', { status: 404 });

    const base = new URL(route.httpBase + '/');
    const basePath = route.targetPath.endsWith('/') ? route.targetPath : route.targetPath + '/';
    const withinBase = logical.pathname === route.targetPath || logical.pathname.startsWith(basePath);
    const suffix = withinBase
      ? logical.pathname.slice(route.targetPath.length).replace(/^\/+/, '')
      : logical.pathname.replace(/^\/+/, '');
    const target = new URL(`/design/${encodeURIComponent(route.chatId)}/${encodeURIComponent(route.designId)}/${suffix}`, base);
    target.search = logical.search;
    if (!withinBase) target.searchParams.set('vulcan_design_root', '1');

    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('origin');
    headers.delete('referer');
    headers.set('x-vulcan-design-transport', 'electron');
    if (route.sessionToken) headers.set('authorization', `Bearer ${route.sessionToken}`);

    const init = {
      method: request.method,
      headers,
      redirect: 'manual',
    };
    if (!['GET', 'HEAD'].includes(String(request.method || 'GET').toUpperCase()) && request.body) {
      init.body = request.body;
      init.duplex = 'half';
    }
    const response = await net.fetch(target.toString(), init);

    // Server-side same-Design redirects are transport details. Rewrite them
    // back into the private origin so app navigation never escapes to the
    // server's physical address.
    const location = response.headers.get('location');
    if (location) {
      try {
        const resolved = new URL(location, target);
        const prefix = `/design/${encodeURIComponent(route.chatId)}/${encodeURIComponent(route.designId)}/`;
        if (resolved.origin === base.origin && resolved.pathname.startsWith(prefix)) {
          const redirected = new URL(request.url);
          redirected.pathname = '/' + resolved.pathname.slice(prefix.length);
          redirected.search = resolved.search;
          const headersOut = new Headers(response.headers);
          headersOut.set('location', redirected.toString());
          return new Response(response.body, { status: response.status, statusText: response.statusText, headers: headersOut });
        }
      } catch { /* preserve upstream redirect */ }
    }
    return response;
  });
  designProtocolPartitions.add(partition);
}

ipcMain.handle('vulcan-design-transport-configure', async (_event, payload) => {
  const partition = String(payload?.partition || '');
  const originHost = String(payload?.originHost || '').toLowerCase();
  const chatId = String(payload?.chatId || '');
  const designId = String(payload?.designId || '');
  if (!partition || !originHost || !chatId || !designId) throw new Error('Incomplete Design transport configuration');
  const httpBase = validateTransportBase(payload?.httpBase, ['http:', 'https:']);
  const wsBase = validateTransportBase(payload?.wsBase, ['ws:', 'wss:']);
  let targetPath = '/';
  try { targetPath = new URL(String(payload?.targetUrl || '')).pathname || '/'; } catch { /* validated server-side */ }
  const route = { partition, originHost, chatId, designId, httpBase, wsBase, targetPath, sessionToken: String(payload?.sessionToken || '') };
  designTransportRoutes.set(designRouteKey(partition, originHost), route);
  installDesignProtocolForPartition(partition);
  return { ok: true };
});

ipcMain.on('vulcan-design-transport-resolve', (event, payload) => {
  const originHost = String(payload?.originHost || '').toLowerCase();
  const route = [...designTransportRoutes.values()].find((candidate) => candidate.originHost === originHost);
  event.returnValue = route ? {
    chatId: route.chatId,
    designId: route.designId,
    wsBase: route.wsBase,
    sessionToken: route.sessionToken,
    targetPath: route.targetPath,
  } : null;
});

function withTimeout(promise, timeoutMs, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function validateWorkspacePngPath(raw) {
  const value = String(raw || '').trim().replace(/\\/g, '/').replace(/^\/workspace\//, '');
  if (!value || value.startsWith('/') || !value.toLowerCase().endsWith('.png')) {
    throw new Error('Invalid Design screenshot workspace path');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid Design screenshot workspace path');
  }
  return value;
}

ipcMain.handle('vulcan-design-screenshot-capture', async (_event, payload) => {
  const guestId = Number(payload?.webContentsId);
  const chatId = String(payload?.chatId || '');
  const designId = String(payload?.designId || '');
  const workspacePath = validateWorkspacePngPath(payload?.workspacePath);
  if (!Number.isInteger(guestId) || guestId <= 0 || !attachedDesignGuests.has(guestId)) {
    throw new Error('Design surface is not attached');
  }
  const guest = webContents.fromId(guestId);
  if (!guest || guest.isDestroyed()) throw new Error('Design surface is unavailable');
  const route = [...designTransportRoutes.values()].find(
    (candidate) => candidate.chatId === chatId && candidate.designId === designId,
  );
  if (!route) throw new Error('Design transport is not configured');
  try {
    const guestUrl = new URL(guest.getURL());
    if (guestUrl.protocol !== 'vulcan-design:' || guestUrl.hostname !== route.originHost) {
      throw new Error('Design surface does not match the requested Design');
    }
  } catch (error) {
    if (error?.message === 'Design surface does not match the requested Design') throw error;
    throw new Error('Design surface URL is unavailable');
  }

  // Capture in Electron main so PNG allocation/encoding and upload cannot wedge
  // or OOM the host React renderer. `webContents.capturePage()` is normally the
  // cheapest path, but Electron can leave that promise pending for a guest that
  // is visible and otherwise healthy. Force a paint, retry once, then fall back
  // to Chromium's DevTools Page.captureScreenshot so one wedged Electron capture
  // primitive cannot stall the agent relay until its 30 s timeout.
  const captureNativePng = async () => {
    try { guest.invalidate?.(); } catch { /* best-effort repaint hint */ }
    try {
      await withTimeout(
        guest.executeJavaScript?.('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))', true) ?? Promise.resolve(),
        1500,
        'design_screenshot_paint_timeout',
      );
    } catch { /* paint hint failure is not fatal */ }
    const image = await withTimeout(guest.capturePage(), 5000, 'design_screenshot_capture_timeout');
    const bytes = image?.toPNG?.();
    if (!bytes?.length) throw new Error('design_screenshot_capture_failed');
    return bytes;
  };

  const captureCdpPng = async () => {
    const dbg = guest.debugger;
    if (!dbg) throw new Error('design_screenshot_cdp_unavailable');
    const wasAttached = dbg.isAttached();
    if (!wasAttached) dbg.attach('1.3');
    try {
      await withTimeout(dbg.sendCommand('Page.enable'), 2000, 'design_screenshot_cdp_enable_timeout');
      const shot = await withTimeout(dbg.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      }), 7000, 'design_screenshot_cdp_timeout');
      const bytes = Buffer.from(String(shot?.data || ''), 'base64');
      if (!bytes.length) throw new Error('design_screenshot_cdp_failed');
      return bytes;
    } finally {
      if (!wasAttached && dbg.isAttached()) {
        try { dbg.detach(); } catch { /* already detached */ }
      }
    }
  };

  let png;
  let nativeError = null;
  try {
    png = await captureNativePng();
  } catch (error) {
    nativeError = error;
    // A second native attempt after a repaint handles transient compositor races
    // without paying the debugger cost on the normal path.
    try { png = await captureNativePng(); } catch { /* fall through to CDP */ }
  }
  if (!png?.length) {
    try {
      png = await captureCdpPng();
    } catch (cdpError) {
      const nativeCode = nativeError?.message || 'design_screenshot_native_failed';
      const cdpCode = cdpError?.message || 'design_screenshot_cdp_failed';
      throw new Error(`${nativeCode}; fallback=${cdpCode}`);
    }
  }

  const target = new URL(`/design-screenshot/${encodeURIComponent(chatId)}/${encodeURIComponent(designId)}`, route.httpBase);
  target.searchParams.set('path', workspacePath);
  const uploadOnce = async () => {
    const headers = new Headers({
      'content-type': 'image/png',
      'x-vulcan-design-transport': 'electron',
    });
    if (route.sessionToken) headers.set('authorization', `Bearer ${route.sessionToken}`);
    const controller = new AbortController();
    const uploadTimer = setTimeout(() => controller.abort(), 7500);
    try {
      return await net.fetch(target.toString(), {
        method: 'POST',
        headers,
        body: png,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error('design_screenshot_upload_timeout');
      throw error;
    } finally {
      clearTimeout(uploadTimer);
    }
  };

  let response;
  try {
    response = await uploadOnce();
  } catch (firstError) {
    // The screenshot endpoint is idempotent for this generated workspace path;
    // one retry covers a transient local transport reset without duplicating data.
    try { response = await uploadOnce(); }
    catch (secondError) { throw secondError?.message ? secondError : firstError; }
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.error || `Design screenshot upload failed: HTTP ${response.status}`);
  const size = nativeImage.createFromBuffer(png).getSize();
  return { ...result, width: size.width, height: size.height };
});

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Vulcan',
    show: shouldShowOnReady,
    icon: path.join(__dirname, '../build/icon-titlebar.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      webviewTag: true, // beta Design: isolated guest web surface with selector preload
      // Pin localStorage to a stable partition based on userData path,
      // not the URL origin — this prevents data loss when switching between
      // dev (localhost:5173) and production (file://) modes.
      partition: `persist:vulcan`,
    },
  });

  mainWindow = win;
  win.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    win.hide();
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Open external links in the system browser, not inside Electron
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Beta Design guests are untrusted app surfaces. Keep Node disabled and
  // force the one selector preload we ship instead of accepting guest-provided
  // preload or webPreferences values from page content.
  win.webContents.on('will-attach-webview', (_event, webPreferences) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.preload = path.join(__dirname, 'designPreload.cjs');
  });
  win.webContents.on('did-attach-webview', (_event, guestContents) => {
    attachedDesignGuests.add(guestContents.id);
    guestContents.once('destroyed', () => attachedDesignGuests.delete(guestContents.id));
    guestContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
  });

  if (isDev) {
    // Dev: load from Vite dev server
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools();
  } else {
    // Production: load the built static files
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
  return win;
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

let quitFlushStarted = false;
app.on('before-quit', async (e) => {
  isQuitting = true;
  if (quitFlushStarted) return;
  quitFlushStarted = true;
  e.preventDefault();
  await flushAndQuit();
  app.exit(0);
});

// Handle being killed by the parent shell (setup.sh launches with `&`)
process.on('SIGTERM', async () => { await flushAndQuit(); app.exit(0); });
process.on('SIGHUP', async () => { await flushAndQuit(); app.exit(0); });

ipcMain.handle('vulcan-native-notify', async (_event, payload) => notifyCompletion(payload));
ipcMain.handle('vulcan-window-show', async (_event, payload) => {
  showMainWindow(payload?.chatId ?? null);
  return { ok: true };
});

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

app.whenReady().then(async () => {
  const repair = await ensurePackagedRuntime({ app, dialog, shell });
  if (repair?.relaunching || repair?.quit) {
    app.exit(0);
    return;
  }
  if (repair?.relaunchPath && relaunchInstalledLinuxApp({ app, relaunchPath: repair.relaunchPath })) return;
  if (repair?.ok === false) {
    dialog.showErrorBox('Vulcan repair failed', repair.message || 'Vulcan could not repair its local runtime.');
    app.exit(1);
    return;
  }

  const passwordStore = createSecurePasswordStore({
    safeStorage,
    userDataPath: app.getPath('userData'),
  });
  registerSecurePasswordIpc({
    ipcMain,
    store: passwordStore,
    isDev,
    indexPath: path.join(__dirname, '../dist/index.html'),
  });
  const semanticToolCacheStore = createSemanticToolCacheStore({ userDataPath: app.getPath('userData') });
  registerSemanticToolCacheIpc({ ipcMain, store: semanticToolCacheStore });

  installTray();
  const win = createWindow();
  if (!shouldShowOnReady) win.hide();

  // Electron is only one of Vulcan's three lifecycle surfaces. Do not put
  // reconnect/auth logic here: main merely reports OS resume to the renderer's
  // platform-neutral connection lifecycle adapter.
  powerMonitor.on('resume', () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('vulcan-connection-may-be-stale', 'electron-resume');
    }
  });
});

// Closing the visible window is tray behavior, not process termination.
app.on('window-all-closed', () => {});
app.on('activate', () => showMainWindow());
