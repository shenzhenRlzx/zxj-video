const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onBarcode: (callback) => {
    ipcRenderer.on('barcode', (_event, data) => callback(data));
  },
  onRecordVideoUpdated: (callback) => {
    ipcRenderer.on('record-video-updated', (_event, data) => callback(data));
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
  deleteRecord: (id) => ipcRenderer.invoke('delete-record', { id }),
  getVideoConfig: () => ipcRenderer.invoke('get-video-config'),
  setVideoConfig: (config) => ipcRenderer.invoke('set-video-config', config),
  listVideoDevices: () => ipcRenderer.invoke('list-video-devices'),
  addVideoDevice: (device) => ipcRenderer.invoke('add-video-device', device),
  updateVideoDevice: (device) => ipcRenderer.invoke('update-video-device', device),
  deleteVideoDevice: (id) => ipcRenderer.invoke('delete-video-device', { id }),
  listVideoChannels: (video_device_id) => ipcRenderer.invoke('list-video-channels', { video_device_id }),
  openVideo: (id) => ipcRenderer.invoke('open-video', { id }),
  downloadVideo: (id) => ipcRenderer.invoke('download-video', { id }),
  retryVideoDownload: (id) => ipcRenderer.invoke('retry-video-download', { id }),
  openLivePreview: (params) => ipcRenderer.invoke('open-live-preview', params),
  getLogs: () => ipcRenderer.invoke('get-logs'),
  clearLogs: () => ipcRenderer.invoke('clear-logs'),
  onLogEntry: (callback) => {
    ipcRenderer.on('log-entry', (_event, data) => callback(data));
  }
});
