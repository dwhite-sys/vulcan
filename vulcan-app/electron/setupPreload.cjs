const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vulcanSetup', {
  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('vulcan-setup-progress', listener);
    return () => ipcRenderer.removeListener('vulcan-setup-progress', listener);
  },

  setDetailsOpen: (open) => {
    ipcRenderer.send('vulcan-setup-details', Boolean(open));
  },
});
