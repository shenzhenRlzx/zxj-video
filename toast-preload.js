const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toastApi', {
  onToast: (callback) => {
    ipcRenderer.on('toast', (_event, data) => callback(data));
  }
});
