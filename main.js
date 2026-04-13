const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const net = require('net');
const os = require('os');
const path = require('path');
const { Database } = require('./database');
const fs = require('fs');

let mainWindow;
let toastWindow;
let toastTimer;
let db;

const DEFAULT_SCANNER_HOST = String(process.env.SCAN_DEVICE_HOST || '').trim();
const DEFAULT_SCANNER_PORT = Number(process.env.SCAN_DEVICE_PORT) || 33333;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    sendRuntimeInfoToRenderer();
  });
}

function ensureToastWindow() {
  if (toastWindow && !toastWindow.isDestroyed()) return;

  toastWindow = new BrowserWindow({
    width: 320,
    height: 90,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'toast-preload.js')
    }
  });

  toastWindow.loadFile(path.join(__dirname, 'renderer', 'toast.html'));
}

function positionToastWindow() {
  if (!toastWindow || toastWindow.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  const margin = 16;
  const x = workArea.x + workArea.width - toastWindow.getBounds().width - margin;
  const y = workArea.y + workArea.height - toastWindow.getBounds().height - margin;
  toastWindow.setPosition(x, y, false);
}

function showToast(message) {
  ensureToastWindow();
  positionToastWindow();

  toastWindow.webContents.send('toast', { message });
  toastWindow.showInactive();

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (!toastWindow || toastWindow.isDestroyed()) return;
    toastWindow.hide();
  }, 1800);
}

function handleScan(barcode, device) {
  const deviceId = device?.id ?? null;
  const record = db.insertRecord(barcode, deviceId);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('barcode', record);
  }
  const deviceName = record.device_name || device?.name || null;
  const prefix = deviceName ? `${deviceName} - ` : '';
  showToast(`${prefix}扫码成功: ${record.barcode}`);
  return record;
}

function getLocalIPv4Addresses() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const netInfo of nets[name] || []) {
      if (netInfo.family !== 'IPv4') continue;
      if (netInfo.internal) continue;
      if (!netInfo.address) continue;
      ips.push(netInfo.address);
    }
  }
  return Array.from(new Set(ips)).sort();
}

function buildDeviceName(device) {
  const name = String(device?.name || '').trim();
  if (name) return name;
  const host = String(device?.host || '').trim();
  const port = Number(device?.port);
  if (host && Number.isFinite(port)) return `${host}:${port}`;
  return '未命名';
}

class ScannerManager {
  constructor() {
    this.devices = new Map();
  }

  setDevices(devices) {
    const next = new Map();
    for (const d of Array.isArray(devices) ? devices : []) {
      const id = Number(d?.id);
      if (!Number.isFinite(id)) continue;
      const existing = this.devices.get(id);
      const cfg = {
        id,
        name: d?.name ?? null,
        host: String(d?.host || '').trim(),
        port: Number(d?.port),
        enabled: d?.enabled ? 1 : 0
      };
      if (existing) {
        existing.device = cfg;
        next.set(id, existing);
      } else {
        next.set(id, {
          device: cfg,
          state: 'disconnected',
          lastError: null,
          socket: null,
          buffer: '',
          reconnectTimer: null,
          reconnectDelayMs: 800,
          shouldReconnect: false
        });
      }
    }

    for (const [id, entry] of this.devices.entries()) {
      if (next.has(id)) continue;
      this.disconnect(id);
    }

    this.devices = next;
    this.broadcast();
  }

  getLocalIps() {
    return getLocalIPv4Addresses();
  }

  getStatuses() {
    const list = [];
    for (const entry of this.devices.values()) {
      const d = entry.device;
      list.push({
        id: d.id,
        name: buildDeviceName(d),
        host: d.host,
        port: d.port,
        enabled: d.enabled,
        state: entry.state,
        lastError: entry.lastError
      });
    }
    list.sort((a, b) => Number(b.enabled) - Number(a.enabled) || Number(a.id) - Number(b.id));
    return list;
  }

  getRuntimeInfo() {
    return { localIps: this.getLocalIps(), devices: this.getStatuses() };
  }

  broadcast() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('scanners-status', this.getRuntimeInfo());
  }

  setState(id, next) {
    const entry = this.devices.get(id);
    if (!entry) return;
    entry.state = next.state ?? entry.state;
    entry.lastError = next.lastError ?? entry.lastError;
    this.broadcast();
  }

  clearReconnectTimer(id) {
    const entry = this.devices.get(id);
    if (!entry || !entry.reconnectTimer) return;
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }

  scheduleReconnect(id) {
    const entry = this.devices.get(id);
    if (!entry || !entry.shouldReconnect) return;
    this.clearReconnectTimer(id);
    entry.reconnectTimer = setTimeout(() => {
      const e = this.devices.get(id);
      if (!e || !e.shouldReconnect) return;
      this.connect(id);
    }, entry.reconnectDelayMs);
    entry.reconnectDelayMs = Math.min(10000, Math.floor(entry.reconnectDelayMs * 1.6));
  }

  destroySocket(id) {
    const entry = this.devices.get(id);
    if (!entry || !entry.socket) return;
    const s = entry.socket;
    entry.socket = null;
    try {
      s.removeAllListeners();
      s.destroy();
    } catch (e) {}
  }

  connect(id) {
    const entry = this.devices.get(id);
    if (!entry) return { ok: false, message: 'not found' };
    const d = entry.device;
    const host = String(d.host || '').trim();
    const port = Number(d.port);
    if (!host) return { ok: false, message: 'empty host' };
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return { ok: false, message: 'invalid port' };

    entry.shouldReconnect = true;
    entry.reconnectDelayMs = 800;
    this.clearReconnectTimer(id);
    this.destroySocket(id);
    entry.buffer = '';

    this.setState(id, { state: 'connecting', lastError: null });

    const socket = net.createConnection({ host, port });
    entry.socket = socket;
    socket.setEncoding('utf8');

    socket.on('connect', () => {
      const e = this.devices.get(id);
      if (!e || e.socket !== socket) return;
      this.setState(id, { state: 'connected', lastError: null });
      showToast(`已连接: ${buildDeviceName(d)}`);
    });

    socket.on('data', (chunk) => {
      const e = this.devices.get(id);
      if (!e || e.socket !== socket) return;
      e.buffer += String(chunk || '');
      if (e.buffer.length > 8192) e.buffer = e.buffer.slice(-8192);

      const parts = e.buffer.split(/[\r\n]+/);
      e.buffer = parts.pop() ?? '';
      for (const part of parts) {
        const barcode = String(part || '').trim();
        if (!barcode) continue;
        handleScan(barcode, { id: d.id, name: buildDeviceName(d) });
      }
    });

    socket.on('error', (err) => {
      const e = this.devices.get(id);
      if (!e || e.socket !== socket) return;
      this.setState(id, { state: 'error', lastError: String(err?.message || err) });
    });

    socket.on('close', () => {
      const e = this.devices.get(id);
      if (!e || e.socket !== socket) return;
      this.destroySocket(id);
      this.setState(id, { state: 'disconnected' });
      if (e.shouldReconnect) this.scheduleReconnect(id);
    });

    return { ok: true };
  }

  disconnect(id) {
    const entry = this.devices.get(id);
    if (!entry) return { ok: false, message: 'not found' };
    entry.shouldReconnect = false;
    this.clearReconnectTimer(id);
    this.destroySocket(id);
    entry.buffer = '';
    this.setState(id, { state: 'disconnected', lastError: null });
    return { ok: true };
  }

  connectEnabled() {
    for (const entry of this.devices.values()) {
      if (!entry.device.enabled) continue;
      this.connect(entry.device.id);
    }
    return { ok: true };
  }

  disconnectAll() {
    for (const entry of this.devices.values()) {
      this.disconnect(entry.device.id);
    }
    return { ok: true };
  }
}

const scannerManager = new ScannerManager();

function sendRuntimeInfoToRenderer() {
  scannerManager.broadcast();
}

app.whenReady().then(async () => {
  db = new Database(app);
  await db.init();

  createWindow();
  const devices = db.listDevices();
  if (!devices.length && DEFAULT_SCANNER_HOST) {
    db.addDevice({ name: null, host: DEFAULT_SCANNER_HOST, port: DEFAULT_SCANNER_PORT, enabled: 1 });
  }
  scannerManager.setDevices(db.listDevices());
  scannerManager.connectEnabled();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  scannerManager.disconnectAll();
});

ipcMain.handle('query-records', (event, params) => {
  const records = db.queryRecords(params || {});
  const total = db.countRecords(params || {});
  return { records, total };
});

ipcMain.handle('get-runtime-info', () => {
  return scannerManager.getRuntimeInfo();
});

ipcMain.handle('list-devices', () => {
  return db.listDevices();
});

ipcMain.handle('add-device', (event, params) => {
  const result = db.addDevice(params || {});
  scannerManager.setDevices(db.listDevices());
  if (result?.ok && result?.device?.enabled) {
    scannerManager.connect(Number(result.device.id));
  }
  return result;
});

ipcMain.handle('update-device', (event, params) => {
  const safeId = Number(params?.id);
  const result = db.updateDevice(safeId, params || {});
  scannerManager.setDevices(db.listDevices());
  const updated = result?.device;
  if (result?.ok && updated) {
    if (updated.enabled) {
      scannerManager.connect(Number(updated.id));
    } else {
      scannerManager.disconnect(Number(updated.id));
    }
  }
  return result;
});

ipcMain.handle('delete-device', (event, params) => {
  const safeId = Number(params?.id);
  scannerManager.disconnect(safeId);
  const result = db.deleteDevice(safeId);
  scannerManager.setDevices(db.listDevices());
  return result;
});

ipcMain.handle('connect-device', (event, params) => {
  const safeId = Number(params?.id);
  const result = scannerManager.connect(safeId);
  return { ...result, info: scannerManager.getRuntimeInfo() };
});

ipcMain.handle('disconnect-device', (event, params) => {
  const safeId = Number(params?.id);
  const result = scannerManager.disconnect(safeId);
  return { ...result, info: scannerManager.getRuntimeInfo() };
});

ipcMain.handle('connect-enabled-devices', () => {
  const result = scannerManager.connectEnabled();
  return { ...result, info: scannerManager.getRuntimeInfo() };
});

ipcMain.handle('disconnect-all-devices', () => {
  const result = scannerManager.disconnectAll();
  return { ...result, info: scannerManager.getRuntimeInfo() };
});

ipcMain.handle('simulate-scan', (event, { barcode }) => {
  const safeBarcode = String(barcode || '').trim();
  if (!safeBarcode) return { ok: false, message: 'empty barcode' };
  const record = handleScan(safeBarcode, null);
  return { ok: true, record };
});

ipcMain.handle('delete-record', (event, { id }) => {
  const safeId = Number(id);
  if (!Number.isFinite(safeId)) return { ok: false, message: 'invalid id' };
  db.deleteRecord(safeId);
  return { ok: true };
});

ipcMain.handle('export-csv', async (event, records) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出CSV',
    defaultPath: `scan-records-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (canceled || !filePath) return { ok: false };

  const header = 'id,barcode,device_name,device_host,device_port,scanned_at';
  const lines = records.map((r) => {
    const safe = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return [
      safe(r.id),
      safe(r.barcode),
      safe(r.device_name),
      safe(r.device_host),
      safe(r.device_port),
      safe(r.scanned_at)
    ].join(',');
  });
  const csv = [header, ...lines].join('\n');
  fs.writeFileSync(filePath, csv, 'utf8');
  return { ok: true, filePath };
});
