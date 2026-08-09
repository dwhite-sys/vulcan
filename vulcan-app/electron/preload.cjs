const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
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
});
