const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onBarcode: (callback) => {
    ipcRenderer.on('barcode', (_event, data) => callback(data));
  },
  queryRecords: (params) => ipcRenderer.invoke('query-records', params),
  onScannersStatus: (callback) => {
    ipcRenderer.on('scanners-status', (_event, data) => callback(data));
  },
  getRuntimeInfo: () => ipcRenderer.invoke('get-runtime-info'),
  listDevices: () => ipcRenderer.invoke('list-devices'),
  addDevice: (device) => ipcRenderer.invoke('add-device', device),
  updateDevice: (device) => ipcRenderer.invoke('update-device', device),
  deleteDevice: (id) => ipcRenderer.invoke('delete-device', { id }),
  connectDevice: (id) => ipcRenderer.invoke('connect-device', { id }),
  disconnectDevice: (id) => ipcRenderer.invoke('disconnect-device', { id }),
  connectEnabledDevices: () => ipcRenderer.invoke('connect-enabled-devices'),
  disconnectAllDevices: () => ipcRenderer.invoke('disconnect-all-devices'),
  exportCSV: (records) => ipcRenderer.invoke('export-csv', records),
  simulateScan: (barcode) => ipcRenderer.invoke('simulate-scan', { barcode }),
  deleteRecord: (id) => ipcRenderer.invoke('delete-record', { id })
});
