const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  modelCatalog: {
    fetch: () => ipcRenderer.invoke('vulcan-model-catalog-fetch'),
  },
  designTransport: {
    configure: (payload) => ipcRenderer.invoke('vulcan-design-transport-configure', payload),
  },
  designScreenshot: {
    capture: (payload) => ipcRenderer.invoke('vulcan-design-screenshot-capture', payload),
  },
  serverPasswords: {
    status: () => ipcRenderer.invoke('vulcan-server-password-status'),
    get: (endpoint) => ipcRenderer.invoke('vulcan-server-password-get', endpoint),
    set: (endpoint, password) => ipcRenderer.invoke('vulcan-server-password-set', endpoint, password),
    remove: (endpoint) => ipcRenderer.invoke('vulcan-server-password-remove', endpoint),
  },
  semanticToolCache: {
    read: (endpoint) => ipcRenderer.invoke('vulcan-semantic-tool-cache-read', endpoint),
    write: (endpoint, value) => ipcRenderer.invoke('vulcan-semantic-tool-cache-write', endpoint, value),
    remove: (endpoint) => ipcRenderer.invoke('vulcan-semantic-tool-cache-remove', endpoint),
  },
  desktop: {
    notify: (payload) => ipcRenderer.invoke('vulcan-native-notify', payload),
    show: (payload) => ipcRenderer.invoke('vulcan-window-show', payload),
    onOpenChat: (callback) => {
      const listener = (_event, chatId) => callback(chatId);
      ipcRenderer.on('vulcan-open-chat', listener);
      return () => ipcRenderer.removeListener('vulcan-open-chat', listener);
    },
  },
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),
  prepareNativeFileExport: (payload) => ipcRenderer.invoke('native-file-export-prepare', payload),
  appendNativeFileExport: (payload) => ipcRenderer.invoke('native-file-export-append', payload),
  finishNativeFileExport: (payload) => ipcRenderer.invoke('native-file-export-finish', payload),
  cancelNativeFileExport: (payload) => ipcRenderer.invoke('native-file-export-cancel', payload),
  startPreparedNativeFileDrag: (payload) => ipcRenderer.send('native-file-drag-prepared-start', payload),
  startNativeFileDrag: (payload) => ipcRenderer.send('native-file-drag-start', payload),
  onNativeFileDragEnd: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('native-file-drag-end', listener);
    return () => ipcRenderer.removeListener('native-file-drag-end', listener);
  },
  // Electron powerMonitor -> renderer. The renderer intentionally treats this
  // identically to Capacitor-active and web-resume hints; see
  // services/connectionLifecycle.ts for the three-platform topology.
  onConnectionMayBeStale: (callback) => {
    const listener = (_event, reason) => callback(reason);
    ipcRenderer.on('vulcan-connection-may-be-stale', listener);
    return () => ipcRenderer.removeListener('vulcan-connection-may-be-stale', listener);
  },
});
