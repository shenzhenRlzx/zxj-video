const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onBarcode: (callback) => {
    ipcRenderer.on('barcode', (_event, data) => callback(data));
  },
  queryRecords: (params) => ipcRenderer.invoke('query-records', params),
  exportCSV: (records) => ipcRenderer.invoke('export-csv', records),
  simulateScan: (barcode) => ipcRenderer.invoke('simulate-scan', { barcode }),
  deleteRecord: (id) => ipcRenderer.invoke('delete-record', { id })
});
