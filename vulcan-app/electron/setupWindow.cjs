const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const COLLAPSED = { width: 560, height: 124 };
const EXPANDED = { width: 560, height: 300 };
const SHOW_DELAY_MS = 400;
const COMPLETE_HOLD_MS = 240;

function createSetupWindow({ allowShow = true } = {}) {
  let ready = false;
  let revealRequested = false;
  let visible = false;
  let closing = false;
  let destroyed = false;
  let showAllowed = Boolean(allowShow);
  const pending = [];

  const win = new BrowserWindow({
    width: COLLAPSED.width,
    height: COLLAPSED.height,
    useContentSize: true,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Vulcan Setup',
    backgroundColor: '#17191d',
    icon: path.join(__dirname, '../build/icon-titlebar.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'setupPreload.cjs'),
    },
  });

  win.setMenuBarVisibility(false);

  const send = (payload) => {
    if (destroyed || win.isDestroyed()) return;
    if (!ready) {
      pending.push(payload);
      return;
    }
    win.webContents.send('vulcan-setup-progress', payload);
  };

  const reveal = () => {
    revealRequested = true;
    if (!showAllowed || !ready || destroyed || win.isDestroyed()) return;
    if (!win.isVisible()) win.show();
    visible = true;
  };

  const onDetails = (event, open) => {
    if (destroyed || win.isDestroyed()) return;
    if (event.sender.id !== win.webContents.id) return;

    const size = open ? EXPANDED : COLLAPSED;
    win.setContentSize(size.width, size.height);
  };

  ipcMain.on('vulcan-setup-details', onDetails);

  win.on('close', (event) => {
    if (closing) return;
    // Setup owns convergence. Do not leave an orphaned repair process merely
    // because a frameless setup surface received an OS close gesture.
    event.preventDefault();
  });

  win.once('ready-to-show', () => {
    ready = true;

    for (const payload of pending.splice(0)) {
      win.webContents.send('vulcan-setup-progress', payload);
    }

    if (revealRequested && showAllowed) reveal();
  });

  win.once('closed', () => {
    destroyed = true;
    ipcMain.removeListener('vulcan-setup-details', onDetails);
  });

  void win.loadFile(path.join(__dirname, 'setup.html')).catch((error) => {
    console.error('Failed to load Vulcan setup surface:', error);
  });

  const showTimer = setTimeout(reveal, SHOW_DELAY_MS);

  function show() {
    showAllowed = true;
    reveal();
    if (ready && !win.isDestroyed()) win.focus();
  }

  function close() {
    if (destroyed) return;
    clearTimeout(showTimer);
    closing = true;
    ipcMain.removeListener('vulcan-setup-details', onDetails);

    if (!win.isDestroyed()) win.destroy();
    destroyed = true;
  }

  async function complete() {
    clearTimeout(showTimer);
    send({ type: 'complete' });

    // If setup actually became visible, let the success state register before
    // replacing it with the real Vulcan window. Fast healthy launches skip this.
    if (visible && !destroyed) {
      await new Promise((resolve) => setTimeout(resolve, COMPLETE_HOLD_MS));
    }

    close();
  }

  return {
    progress: send,
    show,
    complete,
    close,
    isVisible: () => visible && !destroyed,
  };
}

module.exports = {
  createSetupWindow,
  COLLAPSED,
  EXPANDED,
  SHOW_DELAY_MS,
};
