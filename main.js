const { app, BrowserWindow, ipcMain, dialog, screen, Menu, globalShortcut } = require('electron');
const net = require('net');
const os = require('os');
const path = require('path');
const { Database } = require('./database');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { buildRtspUrl } = require('./hikvision');
const util = require('util');

let SerialPort = null;
function getSerialPort() {
  if (SerialPort) return SerialPort;
  try {
    const mod = require('serialport');
    SerialPort = mod?.SerialPort || null;
    return SerialPort;
  } catch (e) {
    SerialPort = null;
    return null;
  }
}

let mainWindow;
let toastWindow;
let toastTimer;
let db;

const logEntries = [];
let logSeq = 0;

function addLog(level, message) {
  const entry = {
    id: ++logSeq,
    ts: new Date().toISOString(),
    level: String(level || 'info'),
    message: String(message || '')
  };
  logEntries.push(entry);
  if (logEntries.length > 1000) logEntries.splice(0, logEntries.length - 1000);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log-entry', entry);
  }
}

const originalConsole = {
  log: console.log.bind(console),
  info: console.info ? console.info.bind(console) : console.log.bind(console),
  warn: console.warn ? console.warn.bind(console) : console.log.bind(console),
  error: console.error ? console.error.bind(console) : console.log.bind(console)
};

console.log = (...args) => {
  addLog('info', util.format(...args));
  originalConsole.log(...args);
};
console.info = (...args) => {
  addLog('info', util.format(...args));
  originalConsole.info(...args);
};
console.warn = (...args) => {
  addLog('warn', util.format(...args));
  originalConsole.warn(...args);
};
console.error = (...args) => {
  addLog('error', util.format(...args));
  originalConsole.error(...args);
};

const DEFAULT_SCANNER_HOST = String(process.env.SCAN_DEVICE_HOST || '').trim();
const DEFAULT_SCANNER_PORT = Number(process.env.SCAN_DEVICE_PORT) || 2006;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

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
  mainWindow.on('close', () => {
    if (toastWindow && !toastWindow.isDestroyed()) {
      try {
        toastWindow.destroy();
      } catch (e) { }
    }
    toastWindow = null;
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (!app.isPackaged || process.env.ZXJ_DEBUG === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function toggleDevTools() {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.webContents.isDevToolsOpened()) {
    win.webContents.closeDevTools();
  } else {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

function setupAppMenu() {
  const template = [
    {
      label: '查看',
      submenu: [
        { label: '刷新', accelerator: 'F5', click: () => (BrowserWindow.getFocusedWindow() || mainWindow)?.reload() },
        { type: 'separator' },
        { label: '开发者工具', accelerator: 'F12', click: () => toggleDevTools() }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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

function notifyRecordVideoUpdated(recordId) {
  if (!Number.isFinite(Number(recordId))) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('record-video-updated', { id: Number(recordId) });
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

  if (device && device.channel_id) {
    downloadVideo(device, record);
  }

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
  const type = String(device?.type || 'tcp');
  const identifier = String(device?.identifier || '').trim();
  return `${type.toUpperCase()}:${identifier}`;
}

function normalizeBarcode(text) {
  const raw = String(text ?? '');
  const cleaned = raw.replace(/[\x00-\x1F\x7F]/g, '').trim();
  return cleaned;
}

function extractCompletedLines(buffer) {
  const parts = String(buffer || '').split(/[\r\n\0]+/);
  const rest = parts.pop() ?? '';
  const barcodes = parts.map(normalizeBarcode).filter(Boolean);
  return { barcodes, rest };
}

function flushBufferedBarcode(entry) {
  if (!entry) return;
  const barcode = normalizeBarcode(entry.buffer);
  if (!barcode) return;
  entry.buffer = '';
  console.log(`[SCAN] ${buildDeviceName(entry.device)} => ${barcode}`);
  handleScan(barcode, {
    id: entry.device.id,
    name: buildDeviceName(entry.device),
    video_device_id: entry.device.video_device_id,
    channel_id: entry.device.channel_id
  });
}

function scheduleFlush(entry) {
  if (!entry) return;
  if (entry.flushTimer) clearTimeout(entry.flushTimer);
  entry.flushTimer = setTimeout(() => {
    entry.flushTimer = null;
    flushBufferedBarcode(entry);
  }, 250);
}

function clearFlush(entry) {
  if (!entry?.flushTimer) return;
  clearTimeout(entry.flushTimer);
  entry.flushTimer = null;
}

function getVideoBackendUrl() {
  return 'http://127.0.0.1:8222';
}

function httpGetJson(urlString) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (e) {
      reject(new Error('invalid url'));
      return;
    }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        timeout: 20000
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            reject(new Error(`backend request failed: ${res.statusCode} ${text}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(new Error('backend json parse failed'));
          }
        });
      }
    );
    req.on('error', (err) => reject(err));
    req.end();
  });
}

function resolveBackendSavedPath(backendUrl, value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[a-zA-Z]:\\/.test(raw) || raw.startsWith('\\\\')) return raw;
  if (raw.startsWith('/')) {
    try {
      return new URL(raw, backendUrl).toString();
    } catch (e) {
      return raw;
    }
  }
  return raw;
}

function normalizeVideoStatus(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (s === '成功' || ['success', 'ok', 'done', 'completed', 'complete', 'true', '1'].includes(lower)) return '成功';
  if (s === '失败' || ['fail', 'failed', 'error', 'false', '0'].includes(lower)) return '失败';
  if (s === '等待' || ['waiting', 'pending', 'processing', 'running', 'queue', 'queued'].includes(lower)) return '等待';
  return s;
}

const videoStatusPollers = new Map(); // recordId -> { timer, deadlineMs }
const videoRetryCounts = new Map(); // recordId -> count

function stopVideoPolling(recordId) {
  const safeId = Number(recordId);
  if (!Number.isFinite(safeId)) return;
  const entry = videoStatusPollers.get(safeId);
  if (entry?.timer) clearTimeout(entry.timer);
  videoStatusPollers.delete(safeId);
  videoRetryCounts.delete(safeId);
}

function shouldIgnoreVideoUpdate(recordId, expectedTaskId) {
  const safeId = Number(recordId);
  if (!Number.isFinite(safeId) || !db) return true;
  const row = db.getRecordById(safeId);
  if (!row) return true;

  const currentPath = String(row.video_path || '').trim();
  if (currentPath) return true;

  const currentStatus = normalizeVideoStatus(row.video_status);
  if (currentStatus === '成功') return true;

  if (expectedTaskId != null) {
    const expected = String(expectedTaskId).trim();
    const currentBackendId = String(row.video_backend_id || '').trim();
    if (currentBackendId && expected && currentBackendId !== expected) return true;
  }
  return false;
}

function startVideoStatusPolling(recordId, backendUrl, endMs, taskId) {
  const safeId = Number(recordId);
  if (!Number.isFinite(safeId)) return;
  if (videoStatusPollers.has(safeId)) return;

  const safeTaskId = Number(taskId ?? safeId);
  if (!Number.isFinite(safeTaskId)) return;

  const now = Date.now();
  const safeEndMs = Number(endMs);
  const deadlineMs = Number.isFinite(safeEndMs)
    ? Math.max(now + 60_000, safeEndMs + 120_000)
    : now + 180_000;

  const pollOnce = () => {
    const current = videoStatusPollers.get(safeId);
    if (!current) return;
    if (shouldIgnoreVideoUpdate(safeId, safeTaskId)) {
      stopVideoPolling(safeId);
      return;
    }
    if (Date.now() > deadlineMs) {
      const count = videoRetryCounts.get(safeId) || 0;
      if (count < 1) {
        videoRetryCounts.set(safeId, count + 1);
        if (current.timer) clearTimeout(current.timer);
        videoStatusPollers.delete(safeId);
        tryVideoRetry(safeId, backendUrl);
        return;
      }
      if (shouldIgnoreVideoUpdate(safeId, safeTaskId)) {
        stopVideoPolling(safeId);
        return;
      }
      db.setRecordVideoInfo(safeId, { status: '失败', backendId: String(safeTaskId), videoPath: null, message: 'timeout' });
      notifyRecordVideoUpdated(safeId);
      stopVideoPolling(safeId);
      return;
    }
    let url;
    try {
      url = new URL('/findByFree/status', backendUrl);
      url.searchParams.set('id', String(safeTaskId));
    } catch (e) {
      videoStatusPollers.delete(safeId);
      return;
    }

    requestVideoInfoFromBackend(url.toString(), backendUrl)
      .then((info) => {
        const status = info?.status || (info?.path ? '成功' : '等待');
        const backendId = info?.backendId ?? String(safeTaskId);
        const savedPathOrUrl = info?.path ?? null;
        if (shouldIgnoreVideoUpdate(safeId, safeTaskId)) {
          stopVideoPolling(safeId);
          return;
        }

        if (savedPathOrUrl) {
          db.setRecordVideoInfo(safeId, { status: '成功', backendId, videoPath: savedPathOrUrl, message: info?.message ?? null });
          notifyRecordVideoUpdated(safeId);
          stopVideoPolling(safeId);
          return;
        }

        if (status === '失败') {
          const count = videoRetryCounts.get(safeId) || 0;
          if (count < 1) {
            videoRetryCounts.set(safeId, count + 1);
            db.setRecordVideoInfo(safeId, { status: '等待', backendId, videoPath: null, message: 'retry' });
            notifyRecordVideoUpdated(safeId);
            if (current.timer) clearTimeout(current.timer);
            videoStatusPollers.delete(safeId);
            tryVideoRetry(safeId, backendUrl);
            return;
          }
          if (shouldIgnoreVideoUpdate(safeId, safeTaskId)) {
            stopVideoPolling(safeId);
            return;
          }
          db.setRecordVideoInfo(safeId, { status: '失败', backendId, videoPath: null, message: info?.message ?? null });
          notifyRecordVideoUpdated(safeId);
          stopVideoPolling(safeId);
          return;
        }

        db.setRecordVideoInfo(safeId, { status: '等待', backendId, videoPath: null, message: info?.message ?? null });
        notifyRecordVideoUpdated(safeId);

        current.timer = setTimeout(pollOnce, 5000);
      })
      .catch(() => {
        const entry = videoStatusPollers.get(safeId);
        if (!entry) return;
        entry.timer = setTimeout(pollOnce, 8000);
      });
  };

  videoStatusPollers.set(safeId, { timer: null, deadlineMs });
  pollOnce();
}

function parseLocalDateTime(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}`);
  return Number.isFinite(d.getTime()) ? d : null;
}

function generateTaskId() {
  const suffix = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  const n = Number(`${Date.now()}${suffix}`);
  return Number.isFinite(n) ? n : Date.now();
}

function tryVideoRetry(recordId, backendUrl) {
  const safeId = Number(recordId);
  if (!Number.isFinite(safeId)) return;
  const record = db.getRecordById(safeId);
  const deviceId = record?.device_id ?? null;
  const scannerDevice = deviceId == null ? null : db.getDeviceById(deviceId);
  if (!scannerDevice) {
    db.setRecordVideoInfo(safeId, { status: '失败', backendId: String(recordId), videoPath: null, message: 'no device' });
    notifyRecordVideoUpdated(safeId);
    videoRetryCounts.delete(safeId);
    return;
  }
  downloadVideo(scannerDevice, record, { backendUrl, taskId: generateTaskId(), isRetry: true });
}

function restorePendingVideoTasks() {
  if (!db) return;
  const list = db.listPendingVideoRecords?.();
  const pending = Array.isArray(list) ? list : [];
  console.log(`[VideoRestore] 启动恢复检查: 等待任务 ${pending.length} 条`);
  if (!pending.length) return;
  showToast(`已恢复 ${pending.length} 条等待录像任务`);

  const backendUrl = getVideoBackendUrl();
  pending.forEach((row, idx) => {
    setTimeout(() => {
      const recordId = Number(row?.id);
      if (!Number.isFinite(recordId)) return;
      const scannedAt = parseLocalDateTime(row?.scanned_at);
      const estimatedEndMs = scannedAt ? (scannedAt.getTime() + 25_000) : (Date.now() + 30_000);
      const backendTaskIdRaw = Number(row?.video_backend_id);
      const backendTaskId = Number.isFinite(backendTaskIdRaw) ? backendTaskIdRaw : recordId;
      startVideoStatusPolling(recordId, backendUrl, estimatedEndMs, backendTaskId);
    }, idx * 120);
  });
}

function requestVideoInfoFromBackend(urlString, backendUrl) {
  return httpGetJson(urlString).then((obj) => {
    // 兼容多种常见的 Java 后端返回格式 (直接返回对象, 或者包在 data 字段里)
    let p = obj?.filePath || obj?.path || obj?.file;
    let u = obj?.url || obj?.downloadUrl;
    let backendId = obj?.id ?? obj?.taskId ?? obj?.jobId ?? obj?.recordId;
    let status = obj?.status ?? obj?.state;
    let message = obj?.message ?? obj?.msg;
    
    if (obj?.data) {
      if (typeof obj.data === 'string') {
        // 如果 data 直接是字符串，假设它就是路径或URL
        p = p || obj.data;
      } else {
        // 如果 data 是对象
        p = p || obj.data.filePath || obj.data.path || obj.data.file;
        u = u || obj.data.url || obj.data.downloadUrl;
        backendId = backendId ?? obj.data.id ?? obj.data.taskId ?? obj.data.jobId ?? obj.data.recordId;
        status = status ?? obj.data.status ?? obj.data.state;
        message = message ?? obj.data.message ?? obj.data.msg;
      }
    }

    const resolved = resolveBackendSavedPath(backendUrl, u || p);
    const normalizedStatus = normalizeVideoStatus(status);
    if (!resolved && !normalizedStatus && backendId == null) {
      console.error('[Video] 后端返回的 JSON 未包含有效的文件路径或 URL:', obj);
      throw new Error('后端返回的 JSON 未包含有效的文件路径(filePath/path/data)或 URL(url/downloadUrl)');
    }
    return { path: resolved || null, backendId: backendId == null ? null : String(backendId), status: normalizedStatus, message: message == null ? null : String(message) };
  });
}

// 触发海康录像下载
function downloadVideo(scannerDevice, record, { backendUrl, taskId, isRetry } = {}) {
  const barcode = String(record?.barcode || '');
  const recordIdRaw = record?.id;
  const recordId = recordIdRaw == null || recordIdRaw === '' ? null : Number(recordIdRaw);
  const channelId = String(scannerDevice?.channel_id || '').trim();
  const videoDeviceIdRaw = scannerDevice?.video_device_id;
  const videoDeviceId =
    videoDeviceIdRaw == null || videoDeviceIdRaw === '' ? null : Number(videoDeviceIdRaw);

  if (!channelId) {
    console.log(`[VideoDownload] 没有配置通道ID，跳过下载。条码: ${barcode}`);
    return;
  }
  if (!Number.isFinite(videoDeviceId)) {
    console.log(`[VideoDownload] 没有绑定录像设备，跳过下载。条码: ${barcode} 通道ID: ${channelId}`);
    return;
  }

  const videoDevice = db.getVideoDeviceById(videoDeviceId);
  if (!videoDevice) {
    console.log(`[VideoDownload] 找不到录像设备配置(id=${videoDeviceId})，跳过下载。条码: ${barcode} 通道ID: ${channelId}`);
    return;
  }

  const baseTime = parseLocalDateTime(record?.scanned_at) || new Date();
  const startTime = new Date(baseTime.getTime() - 5_000);
  const endTime = new Date(startTime.getTime() + 30_000);

  const formatTime = (d) => d.toISOString().replace('T', ' ').substring(0, 19);

  let extra = null;
  try {
    extra = videoDevice.extra_json ? JSON.parse(String(videoDevice.extra_json)) : null;
  } catch (e) {
    extra = null;
  }

  let sdkPort = null;
  let rtspPort = null;
  let streamType = null;
  if (extra && Object.prototype.hasOwnProperty.call(extra, 'sdkPort')) {
    const p = extra.sdkPort;
    const n = Number(p);
    sdkPort = Number.isFinite(n) ? n : p;
  }
  if (extra && Object.prototype.hasOwnProperty.call(extra, 'rtspPort')) {
    const p = extra.rtspPort;
    const n = Number(p);
    rtspPort = Number.isFinite(n) ? n : p;
  } else {
    rtspPort = 554;
  }
  if (extra && Object.prototype.hasOwnProperty.call(extra, 'streamType')) {
    const n = Number(extra.streamType);
    streamType = Number.isFinite(n) ? n : extra.streamType;
  } else {
    streamType = 1;
  }
  if (sdkPort == null || sdkPort === '') {
    sdkPort = 8000;
  }

  const payload = {
    expressNo: barcode,
    status: '已扫描',
    channelId,
    startTime: formatTime(startTime),
    endTime: formatTime(endTime),
    videoDevice: {
      id: videoDevice.id,
      name: videoDevice.name,
      baseUrl: videoDevice.base_url,
      username: videoDevice.username
    },
    extra
  };

  console.log(`[VideoDownload] 触发录像下载:`);
  console.log(JSON.stringify(payload, null, 2));

  try {
    const finalBackendUrl = backendUrl || getVideoBackendUrl();
    const url = new URL('/findByFree', finalBackendUrl);
    const chosenTaskId = Number(taskId ?? recordId);
    if (Number.isFinite(recordId)) {
      db.setRecordVideoInfo(recordId, { status: '等待', backendId: null, videoPath: null, message: null });
      notifyRecordVideoUpdated(recordId);
      if (Number.isFinite(chosenTaskId)) url.searchParams.set('id', String(chosenTaskId));
    }
    url.searchParams.set('c', channelId);
    url.searchParams.set('expressNo', barcode);
    url.searchParams.set('s', String(startTime.getTime()));
    url.searchParams.set('e', String(endTime.getTime()));
    url.searchParams.set('ip', String(videoDevice.base_url || ''));
    url.searchParams.set('port', String(sdkPort || ''));
    url.searchParams.set('username', String(videoDevice.username || ''));
    url.searchParams.set('password', String(videoDevice.password || ''));
    url.searchParams.set('rtspPort', String(rtspPort || ''));
    url.searchParams.set('streamType', String(streamType || ''));

    requestVideoInfoFromBackend(url.toString(), finalBackendUrl)
      .then((info) => {
        const status = info?.status || (info?.path ? '成功' : '等待');
        const backendId = info?.backendId ?? (Number.isFinite(chosenTaskId) ? String(chosenTaskId) : null);
        const savedPathOrUrl = info?.path ?? null;
        const expectedTaskId = Number.isFinite(chosenTaskId) ? String(chosenTaskId) : (backendId || null);

        if (savedPathOrUrl) console.log(`[VideoDownload] 后端已生成: ${savedPathOrUrl}`);
        if (Number.isFinite(recordId)) {
          if (shouldIgnoreVideoUpdate(recordId, expectedTaskId)) {
            return;
          }
          if (savedPathOrUrl) {
            db.setRecordVideoInfo(recordId, { status: '成功', backendId, videoPath: savedPathOrUrl, message: info?.message ?? null });
          } else {
            db.setRecordVideoInfo(recordId, { status: status === '失败' ? '失败' : '等待', backendId, videoPath: null, message: info?.message ?? null });
          }
          notifyRecordVideoUpdated(recordId);
        }

        if (savedPathOrUrl) {
          showToast(`录像下载完成: ${barcode}`);
        } else if (status === '失败') {
          showToast(`录像下载失败: ${barcode}`);
        } else {
          showToast(isRetry ? `录像补偿已提交: ${barcode}` : `录像下载任务已提交: ${barcode}`);
          if (Number.isFinite(recordId)) startVideoStatusPolling(recordId, finalBackendUrl, endTime.getTime(), backendId);
        }
      })
      .catch((err) => {
        console.log(`[VideoDownload] 下载失败: ${err.message || err}`);
        if (Number.isFinite(recordId)) {
          db.setRecordVideoInfo(recordId, { status: '失败', backendId: null, videoPath: null, message: err?.message || String(err) });
          notifyRecordVideoUpdated(recordId);
        }
        showToast(`录像下载失败: ${barcode}`);
      });
  } catch (e) {
    console.log(`[VideoDownload] 调用下载出错: ${e.message || e}`);
  }
}

const { cleanIp } = require('./utils');

class ScannerManager {
  constructor() {
    this.devices = new Map();
    this.tcpServer = null;
    this.tcpClients = new Map(); // ip -> socket
    this.tcpServerPort = DEFAULT_SCANNER_PORT;
    this.startTcpServer();
  }

  stopTcpServer() {
    if (!this.tcpServer) return;
    try {
      this.tcpServer.close();
    } catch (e) { }
    this.tcpServer = null;
  }

  startTcpServer() {
    if (this.tcpServer) return;
    this.tcpServer = net.createServer((socket) => {
      const ip = cleanIp(socket.remoteAddress);
      const remotePort = Number(socket.remotePort);

      // 查找对应的已启用TCP设备
      let matchedDeviceEntry = null;
      for (const entry of this.devices.values()) {
        const d = entry.device;
        if (d.enabled && String(d.type || '').toLowerCase() === 'tcp' && String(d.identifier || '').trim() === ip) {
          matchedDeviceEntry = entry;
          break;
        }
      }

      if (!matchedDeviceEntry) {
        // 未知设备，可能记录日志或直接断开
        console.log(`[TCP Server] 收到未知设备连接: ${ip}，断开。`);
        socket.destroy();
        return;
      }

      const id = matchedDeviceEntry.device.id;
      const prevSocket = this.tcpClients.get(ip);
      if (prevSocket && !prevSocket.destroyed) {
        prevSocket.destroy();
      }
      this.tcpClients.set(ip, socket);

      socket.setEncoding('utf8');
      matchedDeviceEntry.buffer = '';
      matchedDeviceEntry.client = {
        ip,
        port: Number.isFinite(remotePort) ? remotePort : null,
        connected_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString()
      };
      this.setState(id, { state: 'connected', lastError: null });
      showToast(`已连接: ${buildDeviceName(matchedDeviceEntry.device)}`);

      socket.on('data', (chunk) => {
        const e = this.devices.get(id);
        if (!e || !this.tcpClients.has(ip)) return;
        if (e.client) e.client.last_seen_at = new Date().toISOString();
        e.buffer += String(chunk || '');
        if (e.buffer.length > 8192) e.buffer = e.buffer.slice(-8192);

        const extracted = extractCompletedLines(e.buffer);
        e.buffer = extracted.rest;
        for (const barcode of extracted.barcodes) {
          console.log(`[SCAN] ${buildDeviceName(e.device)} => ${barcode}`);
          handleScan(barcode, { id: e.device.id, name: buildDeviceName(e.device), video_device_id: e.device.video_device_id, channel_id: e.device.channel_id });
        }
        scheduleFlush(e);
      });

      socket.on('error', (err) => {
        const e = this.devices.get(id);
        if (e) this.setState(id, { state: 'error', lastError: String(err?.message || err) });
      });

      socket.on('close', () => {
        if (this.tcpClients.get(ip) === socket) {
          this.tcpClients.delete(ip);
        }
        const e = this.devices.get(id);
        if (e) {
          clearFlush(e);
          e.client = null;
          this.setState(id, { state: 'disconnected' });
        }
      });
    });

    this.tcpServer.on('error', (err) => {
      console.error(`[TCP Server] 错误: ${err.message}`);
      setTimeout(() => {
        if (this.tcpServer) {
          this.tcpServer.close();
          this.tcpServer = null;
          this.startTcpServer();
        }
      }, 5000);
    });

    this.tcpServer.listen(this.tcpServerPort, '0.0.0.0', () => {
      console.log(`[TCP Server] 监听端口 ${this.tcpServerPort}`);
    });
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
        type: String(d?.type || 'tcp').toLowerCase(),
        identifier: String(d?.identifier || '').trim(),
        video_device_id: d?.video_device_id ?? null,
        channel_id: String(d?.channel_id || '').trim(),
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
          serialPort: null,
          client: null,
          buffer: '',
          flushTimer: null,
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
        type: d.type,
        identifier: d.identifier,
        video_device_id: d.video_device_id,
        channel_id: d.channel_id,
        enabled: d.enabled,
        state: entry.state,
        lastError: entry.lastError,
        client: entry.client
      });
    }
    list.sort((a, b) => Number(b.enabled) - Number(a.enabled) || Number(a.id) - Number(b.id));
    return list;
  }

  getRuntimeInfo() {
    return { localIps: this.getLocalIps(), devices: this.getStatuses(), tcpListenPort: this.tcpServerPort };
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
    if (!entry) return;
    clearFlush(entry);
    if (entry.device.type === 'usb' && entry.serialPort) {
      const sp = entry.serialPort;
      entry.serialPort = null;
      if (sp.isOpen) sp.close();
    } else if (entry.device.type === 'tcp') {
      const ip = entry.device.identifier;
      const socket = this.tcpClients.get(ip);
      if (socket && !socket.destroyed) {
        socket.destroy();
      }
      this.tcpClients.delete(ip);
    }
  }

  connect(id) {
    const entry = this.devices.get(id);
    if (!entry) return { ok: false, message: 'not found' };
    const d = entry.device;
    const identifier = String(d.identifier || '').trim();
    if (!identifier) return { ok: false, message: 'empty identifier' };

    entry.shouldReconnect = true;
    entry.reconnectDelayMs = 800;
    this.clearReconnectTimer(id);
    this.destroySocket(id);
    entry.buffer = '';
    clearFlush(entry);

    this.setState(id, { state: 'connecting', lastError: null });

    if (d.type === 'usb') {
      const SerialPortCtor = getSerialPort();
      if (!SerialPortCtor) {
        this.setState(id, { state: 'error', lastError: 'serialport 模块加载失败' });
        showToast('USB串口不可用：serialport 模块加载失败，请使用 Windows 环境重新打包');
        entry.shouldReconnect = false;
        return { ok: false, message: 'serialport load failed' };
      }
      const sp = new SerialPortCtor({ path: identifier, baudRate: 9600 }, (err) => {
        if (err) {
          const e = this.devices.get(id);
          if (e) this.setState(id, { state: 'error', lastError: String(err.message) });
        }
      });
      entry.serialPort = sp;

      sp.on('open', () => {
        const e = this.devices.get(id);
        if (!e || e.serialPort !== sp) return;
        e.client = {
          port: identifier,
          connected_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString()
        };
        this.setState(id, { state: 'connected', lastError: null });
        showToast(`已连接: ${buildDeviceName(d)}`);
      });

      sp.on('data', (chunk) => {
        const e = this.devices.get(id);
        if (!e || e.serialPort !== sp) return;
        if (e.client) e.client.last_seen_at = new Date().toISOString();
        e.buffer += String(chunk || '');
        if (e.buffer.length > 8192) e.buffer = e.buffer.slice(-8192);
        const extracted = extractCompletedLines(e.buffer);
        e.buffer = extracted.rest;
        for (const barcode of extracted.barcodes) {
          console.log(`[SCAN] ${buildDeviceName(d)} => ${barcode}`);
          handleScan(barcode, { id: d.id, name: buildDeviceName(d), video_device_id: d.video_device_id, channel_id: d.channel_id });
        }
        scheduleFlush(e);
      });

      sp.on('error', (err) => {
        const e = this.devices.get(id);
        if (!e || e.serialPort !== sp) return;
        this.setState(id, { state: 'error', lastError: String(err?.message || err) });
      });

      sp.on('close', () => {
        const e = this.devices.get(id);
        if (!e || e.serialPort !== sp) return;
        entry.serialPort = null;
        clearFlush(entry);
        e.client = null;
        this.setState(id, { state: 'disconnected' });
        if (e.shouldReconnect) this.scheduleReconnect(id);
      });
    } else {
      // TCP mode
      const ip = d.identifier;
      if (this.tcpClients.has(ip)) {
        this.setState(id, { state: 'connected', lastError: null });
      } else {
        this.setState(id, { state: 'waiting_connection', lastError: null });
      }
    }

    return { ok: true };
  }

  disconnect(id) {
    const entry = this.devices.get(id);
    if (!entry) return { ok: false, message: 'not found' };
    entry.shouldReconnect = false;
    this.clearReconnectTimer(id);
    this.destroySocket(id);
    entry.buffer = '';
    entry.client = null;
    clearFlush(entry);
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

let scannerManager = null;
if (gotTheLock) {
  scannerManager = new ScannerManager();
}

function sendRuntimeInfoToRenderer() {
  if (!scannerManager) return;
  scannerManager.broadcast();
}

if (gotTheLock) app.whenReady().then(async () => {
  db = new Database(app);
  await db.init();

  setupAppMenu();
  globalShortcut.register('F12', toggleDevTools);
  globalShortcut.register('CommandOrControl+Shift+I', toggleDevTools);

  createWindow();
  const devices = db.listDevices();
  if (!devices.length && DEFAULT_SCANNER_HOST) {
    db.addDevice({ name: null, type: 'tcp', identifier: DEFAULT_SCANNER_HOST, channel_id: '', host: DEFAULT_SCANNER_HOST, port: DEFAULT_SCANNER_PORT, enabled: 1 });
  }
  scannerManager.setDevices(db.listDevices());
  scannerManager.connectEnabled();
  restorePendingVideoTasks();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

if (gotTheLock) {
  app.on('window-all-closed', () => {
    app.quit();
  });
}

if (gotTheLock) {
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  app.on('before-quit', () => {
    if (!scannerManager) return;
    scannerManager.disconnectAll();
    scannerManager.stopTcpServer();
  });
}

ipcMain.handle('query-records', (event, params) => {
  const records = db.queryRecords(params || {});
  const total = db.countRecords(params || {});
  return { records, total };
});

ipcMain.handle('get-runtime-info', () => {
  return scannerManager.getRuntimeInfo();
});

ipcMain.handle('get-logs', () => {
  return { ok: true, logs: logEntries.slice(-1000) };
});

ipcMain.handle('clear-logs', () => {
  logEntries.length = 0;
  return { ok: true };
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

ipcMain.handle('list-video-devices', () => {
  return db.listVideoDevices();
});

ipcMain.handle('add-video-device', (event, params) => {
  return db.addVideoDevice(params || {});
});

ipcMain.handle('update-video-device', (event, params) => {
  const safeId = Number(params?.id);
  return db.updateVideoDevice(safeId, params || {});
});

ipcMain.handle('delete-video-device', (event, params) => {
  const safeId = Number(params?.id);
  return db.deleteVideoDevice(safeId);
});

ipcMain.handle('list-video-channels', async (event, params) => {
  const safeId = Number(params?.video_device_id);
  if (!Number.isFinite(safeId)) return { ok: false, message: 'invalid video_device_id' };
  const device = db.getVideoDeviceById(safeId);
  if (!device) return { ok: false, message: 'video device not found' };
  try {
    let sdkPort = 8000;
    let rtspPort = 554;
    if (device.extra_json) {
      try {
        const obj = JSON.parse(String(device.extra_json));
        if (Object.prototype.hasOwnProperty.call(obj, 'sdkPort') && obj.sdkPort) {
          sdkPort = obj.sdkPort;
        }
        if (Object.prototype.hasOwnProperty.call(obj, 'rtspPort') && obj.rtspPort) {
          rtspPort = obj.rtspPort;
        }
      } catch (e) { }
    }
    const backendUrl = getVideoBackendUrl();
    const url = new URL('/getChannelList', backendUrl);
    url.searchParams.set('ip', String(device.base_url || ''));
    url.searchParams.set('port', String(sdkPort || ''));
    url.searchParams.set('username', String(device.username || ''));
    url.searchParams.set('password', String(device.password || ''));
    url.searchParams.set('rtspPort', String(rtspPort || ''));
    const list = await httpGetJson(url.toString());
    const channels = (Array.isArray(list) ? list : []).map((ch) => {
      const id = String(ch?.channel ?? ch?.id ?? '').trim();
      const name = String(ch?.name ?? '').trim();
      const onLine = ch?.onLine;
      const online =
        typeof onLine === 'boolean'
          ? onLine
          : (typeof ch?.online === 'boolean' ? ch.online : (typeof ch?.on_line === 'boolean' ? ch.on_line : null));
      const rtsp = buildRtspUrl({
        ip: device.base_url,
        username: device.username,
        password: device.password,
        channelId: id,
        rtspPort,
        streamType: 2
      });
      const flvUrl = new URL('/live/stream', backendUrl);
      flvUrl.searchParams.set('channel', id);
      flvUrl.searchParams.set('ip', String(device.base_url || ''));
      flvUrl.searchParams.set('port', String(sdkPort || ''));
      flvUrl.searchParams.set('username', String(device.username || ''));
      flvUrl.searchParams.set('password', String(device.password || ''));
      flvUrl.searchParams.set('rtspPort', String(rtspPort || ''));
      flvUrl.searchParams.set('streamType', '2');
      return { id, name, online, rtsp, flv: flvUrl.toString() };
    });
    return { ok: true, channels };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
});

ipcMain.handle('get-video-config', () => {
  const raw = db.getSetting('video_config');
  if (!raw) return { ok: true, config: null };
  try {
    const config = JSON.parse(String(raw));
    return { ok: true, config };
  } catch (e) {
    return { ok: true, config: null };
  }
});

ipcMain.handle('set-video-config', (event, config) => {
  const safeConfig = config && typeof config === 'object' ? config : {};
  const raw = JSON.stringify(safeConfig);
  const result = db.setSetting('video_config', raw);
  return result;
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

ipcMain.handle('open-video', (event, { id }) => {
  const safeId = Number(id);
  if (!Number.isFinite(safeId)) return { ok: false, message: 'invalid id' };
  const record = db.getRecordById(safeId);
  const videoPath = record?.video_path;
  if (!videoPath) return { ok: false, message: 'no video' };
  let shell;
  try {
    shell = require('electron').shell;
  } catch (e) {
    return { ok: false, message: 'shell unavailable' };
  }
  if (/^https?:\/\//i.test(String(videoPath))) {
    shell.openExternal(String(videoPath));
  } else {
    shell.openPath(String(videoPath));
  }
  return { ok: true };
});

function guessFileNameFromVideo(record, videoPath) {
  const barcode = String(record?.barcode || '').trim();
  const base = barcode || `video-${Number(record?.id) || Date.now()}`;
  let ext = '.mp4';
  const raw = String(videoPath || '');
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const p = u.pathname || '';
      const m = p.match(/\.([a-zA-Z0-9]{1,6})$/);
      if (m) ext = `.${m[1].toLowerCase()}`;
    } catch (e) {}
  } else {
    const p = path.extname(raw);
    if (p) ext = p;
  }
  return `${base}${ext}`;
}

function downloadUrlToFile(urlString, destPath) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(String(urlString));
    } catch (e) {
      reject(new Error('invalid url'));
      return;
    }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        timeout: 60_000
      },
      (res) => {
        const code = Number(res.statusCode) || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          try {
            const next = new URL(String(res.headers.location), url).toString();
            res.resume();
            downloadUrlToFile(next, destPath).then(resolve, reject);
            return;
          } catch (e) {}
        }
        if (code < 200 || code >= 300) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            reject(new Error(`download failed: HTTP ${code} ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`));
          });
          return;
        }
        const out = fs.createWriteStream(destPath);
        out.on('error', reject);
        res.on('error', reject);
        out.on('finish', () => resolve());
        res.pipe(out);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

ipcMain.handle('download-video', async (event, { id }) => {
  const safeId = Number(id);
  if (!Number.isFinite(safeId)) return { ok: false, message: 'invalid id' };
  const record = db.getRecordById(safeId);
  const videoPath = record?.video_path;
  if (!videoPath) return { ok: false, message: 'no video' };

  const defaultName = guessFileNameFromVideo(record, videoPath);
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '保存视频',
    defaultPath: defaultName,
    filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'avi', 'flv'] }]
  });
  if (canceled || !filePath) return { ok: false };

  const raw = String(videoPath || '');
  try {
    if (/^https?:\/\//i.test(raw)) {
      await downloadUrlToFile(raw, filePath);
      return { ok: true, filePath };
    }
    const src = raw;
    if (!fs.existsSync(src)) return { ok: false, message: 'source file not found' };
    await fs.promises.copyFile(src, filePath);
    return { ok: true, filePath };
  } catch (e) {
    return { ok: false, message: e?.message || String(e) };
  }
});

ipcMain.handle('retry-video-download', async (event, { id }) => {
  const safeId = Number(id);
  if (!Number.isFinite(safeId)) return { ok: false, message: 'invalid id' };
  const record = db.getRecordById(safeId);
  if (!record) return { ok: false, message: 'record not found' };
  if (record.deleted) return { ok: false, message: 'record deleted' };

  const deviceId = Number(record.device_id);
  if (!Number.isFinite(deviceId)) return { ok: false, message: 'record has no device' };
  const scannerDevice = db.getDeviceById(deviceId);
  if (!scannerDevice) return { ok: false, message: 'device not found' };
  if (!scannerDevice.enabled) return { ok: false, message: 'device disabled' };
  if (!scannerDevice.channel_id) return { ok: false, message: 'device has no channel' };

  stopVideoPolling(safeId);
  const backendUrl = getVideoBackendUrl();
  downloadVideo(scannerDevice, record, { backendUrl, taskId: generateTaskId(), isRetry: true });
  return { ok: true };
});

ipcMain.handle('open-live-preview', (event, params) => {
  const videoDeviceId = Number(params?.video_device_id);
  const channelId = String(params?.channel_id || '').trim();
  if (!Number.isFinite(videoDeviceId)) return { ok: false, message: 'invalid video_device_id' };
  if (!channelId) return { ok: false, message: 'empty channel_id' };
  const device = db.getVideoDeviceById(videoDeviceId);
  if (!device) return { ok: false, message: 'video device not found' };
  let rtspPort = 554;
  let sdkPort = 8000;
  let streamType = 2;
  if (device.extra_json) {
    try {
      const extra = JSON.parse(String(device.extra_json));
      if (extra && Object.prototype.hasOwnProperty.call(extra, 'rtspPort') && extra.rtspPort) {
        const n = Number(extra.rtspPort);
        rtspPort = Number.isFinite(n) ? n : rtspPort;
      }
      if (extra && Object.prototype.hasOwnProperty.call(extra, 'sdkPort') && extra.sdkPort) {
        const n = Number(extra.sdkPort);
        sdkPort = Number.isFinite(n) ? n : sdkPort;
      }
      if (extra && Object.prototype.hasOwnProperty.call(extra, 'streamType') && extra.streamType) {
        const n = Number(extra.streamType);
        streamType = Number.isFinite(n) ? n : streamType;
      }
    } catch (e) { }
  }

  const backendUrl = getVideoBackendUrl();
  let pageUrl;
  try {
    pageUrl = new URL('/video/live', backendUrl);
    pageUrl.searchParams.set('channel', channelId);
    pageUrl.searchParams.set('ip', String(device.base_url || ''));
    pageUrl.searchParams.set('port', String(sdkPort || ''));
    pageUrl.searchParams.set('username', String(device.username || ''));
    pageUrl.searchParams.set('password', String(device.password || ''));
    pageUrl.searchParams.set('rtspPort', String(rtspPort || ''));
    pageUrl.searchParams.set('streamType', String(streamType || ''));
  } catch (e) {
    return { ok: false, message: 'invalid backend url' };
  }

  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: `实时预览 - 通道 ${channelId}`,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadURL(pageUrl.toString());
  return { ok: true, url: pageUrl.toString() };
});

ipcMain.handle('export-csv', async (event, records) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出CSV',
    defaultPath: `scan-records-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (canceled || !filePath) return { ok: false };

  const header = 'id,barcode,device_name,device_type,device_identifier,device_channel_id,scanned_at';
  const lines = records.map((r) => {
    const safe = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return [
      safe(r.id),
      safe(r.barcode),
      safe(r.device_name),
      safe(r.device_type),
      safe(r.device_identifier),
      safe(r.device_channel_id),
      safe(r.scanned_at)
    ].join(',');
  });
  const csv = [header, ...lines].join('\n');
  fs.writeFileSync(filePath, csv, 'utf8');
  return { ok: true, filePath };
});
