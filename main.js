const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const path = require('path');
const { Database } = require('./database');
const fs = require('fs');

let mainWindow;
let toastWindow;
let toastTimer;
let db;

const SCAN_MAX_INTERVAL_MS = 50;
const SCAN_RESET_INTERVAL_MS = 100;

let buffer = '';
let lastKeyTime = 0;
let maxInterval = 0;

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

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key;
    const now = Date.now();

    // If the interval is too large, treat it as manual input and reset.
    if (lastKeyTime && now - lastKeyTime > SCAN_RESET_INTERVAL_MS) {
      buffer = '';
      maxInterval = 0;
    }

    if (key === 'Enter') {
      // Fast key stream + Enter means scanner input.
      if (buffer.length > 0 && maxInterval < SCAN_MAX_INTERVAL_MS) {
        handleScan(buffer);
      }
      buffer = '';
      maxInterval = 0;
      lastKeyTime = 0;
      return;
    }

    if (key.length === 1) {
      if (lastKeyTime) {
        maxInterval = Math.max(maxInterval, now - lastKeyTime);
      }
      buffer += key;
      lastKeyTime = now;
    }
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

function handleScan(barcode) {
  const record = db.insertRecord(barcode);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('barcode', record);
  }
  showToast(`扫码成功: ${record.barcode}`);
  return record;
}

app.whenReady().then(async () => {
  db = new Database(app);
  await db.init();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('query-records', (event, params) => {
  const records = db.queryRecords(params || {});
  const total = db.countRecords(params || {});
  return { records, total };
});

ipcMain.handle('simulate-scan', (event, { barcode }) => {
  const safeBarcode = String(barcode || '').trim();
  if (!safeBarcode) return { ok: false, message: 'empty barcode' };
  const record = handleScan(safeBarcode);
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

  const header = 'id,barcode,scanned_at';
  const lines = records.map((r) => {
    const safe = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return [safe(r.id), safe(r.barcode), safe(r.scanned_at)].join(',');
  });
  const csv = [header, ...lines].join('\n');
  fs.writeFileSync(filePath, csv, 'utf8');
  return { ok: true, filePath };
});
