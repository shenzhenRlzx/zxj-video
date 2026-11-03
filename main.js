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
let logDir = null;
const pendingLogPush = [];
let logPushTimer = null;

function logFilePath(day) {
  return path.join(logDir, `app-${day}.log`);
}

function writeLogEntry(entry) {
  if (!logDir) return;
  try {
    const day = entry.ts.slice(0, 10);
    fs.appendFileSync(logFilePath(day), `[${entry.ts}] [${String(entry.level || 'info').toUpperCase()}] ${entry.message}\n`);
  } catch (e) { }
}

function initLogger() {
  try {
    logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    for (const entry of logEntries) writeLogEntry(entry);
  } catch (e) {
    logDir = null;
  }
}

function addLog(level, message) {
  const entry = {
    id: ++logSeq,
    ts: new Date().toISOString(),
    level: String(level || 'info'),
    message: String(message || '')
  };
  logEntries.push(entry);
  if (logEntries.length > 2000) logEntries.splice(0, logEntries.length - 2000);
  writeLogEntry(entry);
  if (mainWindow && !mainWindow.isDestroyed()) {
    pendingLogPush.push(entry);
    if (!logPushTimer) {
      logPushTimer = setTimeout(flushLogPush, 200);
    }
  }
}

function flushLogPush() {
  logPushTimer = null;
  if (!pendingLogPush.length) return;
  const batch = pendingLogPush.splice(0, pendingLogPush.length);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log-batch', batch);
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

const pendingToasts = []; // app ready 前收到的 toast 暂存，ready 后补显

function showToast(message) {
  // app ready 之前不允许创建 BrowserWindow（扫码枪可能在初始化完成前连入）
  if (!app.isReady()) {
    pendingToasts.push(String(message));
    if (pendingToasts.length > 10) pendingToasts.shift();
    return;
  }
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

const pendingVideoNotify = new Set();
let videoNotifyTimer = null;

function notifyRecordVideoUpdated(recordId) {
  if (!Number.isFinite(Number(recordId))) return;
  pendingVideoNotify.add(Number(recordId));
  if (videoNotifyTimer) return;
  videoNotifyTimer = setTimeout(() => {
    videoNotifyTimer = null;
    if (!mainWindow || mainWindow.isDestroyed() || !pendingVideoNotify.size) return;
    mainWindow.webContents.send('record-video-updated', { ids: Array.from(pendingVideoNotify) });
    pendingVideoNotify.clear();
  }, 1000);
}

// 立即推送状态变化：重试提交/失败这类关键节点不等 1 秒合并，界面立刻能看到
function notifyRecordVideoUpdatedNow(recordId) {
  if (!Number.isFinite(Number(recordId))) return;
  notifyRecordVideoUpdated(recordId);
  if (videoNotifyTimer) {
    clearTimeout(videoNotifyTimer);
    videoNotifyTimer = null;
  }
  if (mainWindow && !mainWindow.isDestroyed() && pendingVideoNotify.size) {
    mainWindow.webContents.send('record-video-updated', { ids: Array.from(pendingVideoNotify) });
    pendingVideoNotify.clear();
  }
}

// 统一：任何一次下载/重试提交，写状态并清空旧失败原因，立即通知。
// status：时间窗未结束时的「等待」（等录像生成），真正提交后端后的「下载中」
function markVideoSubmitted(recordId, taskId, status = '等待', message = null) {
  const safeId = Number(recordId);
  if (!Number.isFinite(safeId) || !db) return;
  // 计数不在这里重置：轮询超时触发的自动重试用它防止无限重试；
  // 仅用户手动重试/批量补下载的入口处重置
  db.setRecordVideoInfo(safeId, {
    status,
    backendId: Number.isFinite(Number(taskId)) ? String(taskId) : null,
    videoPath: null,
    message
  });
  notifyRecordVideoUpdatedNow(safeId);
}

// 统一：任何失败都必须写明原因并立即通知，不允许静默 return
function markVideoFailed(recordId, message) {
  const safeId = Number(recordId);
  if (!Number.isFinite(safeId) || !db) return;
  videoRetryCounts.delete(safeId);
  db.setRecordVideoInfo(safeId, { status: '失败', backendId: null, videoPath: null, message: String(message || '未知原因') });
  notifyRecordVideoUpdatedNow(safeId);
}

// 仅在状态/信息变化时写库并通知，避免轮询风暴
function setVideoStatusIfChanged(recordId, status, backendId, message) {
  if (!db) return;
  const row = db.getRecordById(recordId);
  if (!row) return;
  if (
    String(row.video_status || '') === String(status || '') &&
    String(row.video_backend_id || '') === String(backendId || '') &&
    String(row.video_message || '') === String(message || '')
  ) {
    return;
  }
  db.setRecordVideoInfo(recordId, { status, backendId, videoPath: null, message });
  notifyRecordVideoUpdated(recordId);
}

// 扫码内容清洗：去除控制字符、空白（含全角/零宽），防止脏条码入库及传给视频后端报错
function sanitizeBarcode(raw) {
  return String(raw ?? '')
    .replace(/[\x00-\x1F\x7F\u200B-\u200D\uFEFF\s\u3000]/g, '');
}

function handleScan(barcodeRaw, device) {
  const barcode = sanitizeBarcode(barcodeRaw);
  if (!barcode) {
    console.warn(`[Scan] 丢弃无效条码(清洗后为空): ${JSON.stringify(String(barcodeRaw ?? ''))}`);
    return null;
  }
  const deviceId = device?.id ?? null;
  let record;
  try {
    record = db.insertRecord(barcode, deviceId);
  } catch (e) {
    console.error(`[Scan] 记录入库失败(${barcode}): ${e?.message || e}`);
    showToast(`扫码入库失败: ${barcode}（详见日志）`);
    return null;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('barcode', record);
  }
  const deviceName = record.device_name || device?.name || null;
  const prefix = deviceName ? `${deviceName} - ` : '';
  showToast(`${prefix}扫码成功: ${record.barcode}`);

  if (device && device.channel_id) {
    try {
      downloadVideo(device, record);
    } catch (e) {
      console.error(`[VideoDownload] 触发下载异常(${barcode}): ${e?.message || e}`);
    }
  } else if (device) {
    // 工作台未配置录像：显性标记原因，界面上可见，不再静默
    const hasVideoDevice = device.video_device_id != null && device.video_device_id !== '';
    const reason = hasVideoDevice ? '未配置录像通道' : '未绑定录像设备';
    try {
      db.setRecordVideoInfo(record.id, { status: '失败', backendId: null, videoPath: null, message: reason });
      record.video_status = '失败';
      record.video_message = reason;
      notifyRecordVideoUpdated(record.id);
    } catch (e) { }
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
  if (s === '等待' || ['waiting', 'pending', 'queue', 'queued'].includes(lower)) return '等待';
  // 后端只区分：未完成=等待、成功、失败；「下载中」仅作旧数据兼容归一到等待
  if (s === '等待' || s === '下载中' || ['waiting', 'pending', 'queue', 'queued', 'downloading', 'download', 'running', 'processing'].includes(lower)) return '等待';
  return s;
}

// ============ 提交给视频后端前的单号转换 ============
// 依据（项目内实际约束）：
//   hikvision.js 把 expressNo 当 fileName 直接 path.join(saveDir, fileName)；
//   expressNo 同时走 /findByFree 的 URL 查询串；海康 ISAPI 使用 XML 报文。
// 规则（最简）：
//   1. 本来就安全（只含字母数字/连字符/下划线）→ 原样传（含尾部 -）
//   2. 只有歧义字符（\ / : * ? " < > | # % & = + '，文件名/路径/URL/XML 冲突）→ 转义成 '-' 后传
//   3. 含无法转义处理的非法字符（中文、乱码等）→ 整个单号直接传记录 ID
//   后端保存文件时自己会附加时间戳，前端不再生成时间戳后缀
const AMBIGUOUS_BARCODE_CHARS_RE = /[\\/:*?"<>|#%&='+]/g;
const SAFE_BARCODE_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

function ambiguousCharsRe() {
  return new RegExp(AMBIGUOUS_BARCODE_CHARS_RE.source, 'g');
}

function replaceAmbiguousChars(s) {
  return String(s).replace(ambiguousCharsRe(), '-');
}

// 无法处理的扫码内容：直接传记录 ID（数据库自增，天然唯一）
function fallbackBarcodeToken(record) {
  const id = Number(record?.id);
  return Number.isFinite(id) && id > 0 ? String(id) : `0${Date.now()}`;
}

// 返回 { value, converted, reason }：value 为传给后端的单号
function normalizeBackendBarcode(raw, record) {
  const s = sanitizeBarcode(raw);
  if (!s) {
    return { value: fallbackBarcodeToken(record), converted: true, reason: 'id' };
  }
  let base = s;
  let extracted = false;
  const paramMatch = s.match(/[?&](?:sn|code|no|barcode|expressno|waybill|id)=([^&#]+)/i);
  if (paramMatch) {
    base = paramMatch[1];
    extracted = true;
  } else if (/^https?:\/\//i.test(s)) {
    const tail = s.replace(/\?.*$/, '').split('/').filter(Boolean).pop();
    if (tail) { base = tail; extracted = true; }
  }

  // 1. 本来就安全 → 原样传
  if (SAFE_BARCODE_TOKEN_RE.test(base)) {
    return { value: base, converted: extracted, reason: extracted ? 'url' : 'plain' };
  }
  // 2. 只有歧义字符（可安全转义）→ 转义成 '-' 后传；转义后只剩分隔符的视同无法处理
  const converted = replaceAmbiguousChars(base);
  if (SAFE_BARCODE_TOKEN_RE.test(converted) && !/^[_-]+$/.test(converted)) {
    return { value: converted, converted: true, reason: 'ambiguous' };
  }
  // 3. 含无法转义处理的非法字符（中文/乱码等）→ 直接传记录 ID
  return { value: fallbackBarcodeToken(record), converted: true, reason: 'id' };
}

const videoStatusPollers = new Map(); // recordId -> { timer, deadlineMs }
const videoRetryCounts = new Map(); // recordId -> count
const videoSubmitTimers = new Map(); // recordId -> timer（等待录像时间窗结束的延迟提交）
const VIDEO_SUBMIT_BUFFER_MS = 2000; // 时间窗结束后再缓冲 2 秒提交，确保录像已落盘
const DEFAULT_CLIP_BEFORE_SECONDS = 5;
const DEFAULT_CLIP_AFTER_SECONDS = 55;

function getVideoConfig() {
  if (!db) return {};
  const raw = db.getSetting('video_config');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

function getClipWindowMs() {
  const config = getVideoConfig();
  const beforeRaw = Number(config.clipBeforeSeconds);
  const afterRaw = Number(config.clipAfterSeconds);
  if (Number.isFinite(beforeRaw) && beforeRaw >= 0 && Number.isFinite(afterRaw) && afterRaw >= 0 && beforeRaw + afterRaw > 0) {
    return {
      beforeMs: Math.round(beforeRaw * 1000),
      afterMs: Math.round(afterRaw * 1000),
      durationMs: Math.round((beforeRaw + afterRaw) * 1000)
    };
  }

  const durationRaw = Number(config.clipDurationSeconds);
  const durationSeconds = Number.isFinite(durationRaw) && durationRaw > 0
    ? durationRaw
    : DEFAULT_CLIP_BEFORE_SECONDS + DEFAULT_CLIP_AFTER_SECONDS;
  const beforeSeconds = Math.min(DEFAULT_CLIP_BEFORE_SECONDS, durationSeconds);
  const afterSeconds = Math.max(0, durationSeconds - beforeSeconds);
  return {
    beforeMs: Math.round(beforeSeconds * 1000),
    afterMs: Math.round(afterSeconds * 1000),
    durationMs: Math.round(durationSeconds * 1000)
  };
}

function stopVideoPolling(recordId) {
  const safeId = Number(recordId);
  if (!Number.isFinite(safeId)) return;
  const entry = videoStatusPollers.get(safeId);
  if (entry?.timer) clearTimeout(entry.timer);
  videoStatusPollers.delete(safeId);
  const submitTimer = videoSubmitTimers.get(safeId);
  if (submitTimer) clearTimeout(submitTimer);
  videoSubmitTimers.delete(safeId);
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
  // 后端 SDK 下载实测耗时可达 1 分钟以上；补下载历史记录时时间窗早已过去，
  // 超时线若只给 60 秒，会出现「后端最终下载成功、软件却已判 timeout」——给足 10 分钟
  const deadlineMs = Number.isFinite(safeEndMs) && safeEndMs > now
    ? Math.max(safeEndMs + 120_000, now + 180_000)   // 新扫码：等时间窗结束再留 2 分钟
    : Math.max(now + 600_000, Number.isFinite(safeEndMs) ? safeEndMs + 120_000 : 0); // 补下载：10 分钟

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
      db.setRecordVideoInfo(safeId, { status: '失败', backendId: String(safeTaskId), videoPath: null, message: '下载超时，自动重试后仍无结果' });
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
        // 与提交时写入的 backendId 保持一致，避免 shouldIgnoreVideoUpdate 误判导致轮询被掐断
        const backendId = String(safeTaskId);
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
            db.setRecordVideoInfo(safeId, { status: '等待', backendId, videoPath: null, message: '后端返回失败，自动重试中' });
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
          db.setRecordVideoInfo(safeId, { status: '失败', backendId, videoPath: null, message: info?.message || '后端返回失败' });
          notifyRecordVideoUpdated(safeId);
          stopVideoPolling(safeId);
          return;
        }

        setVideoStatusIfChanged(safeId, '等待', backendId, info?.message ?? null);

        current.timer = setTimeout(pollOnce, 10000);
      })
      .catch(() => {
        const entry = videoStatusPollers.get(safeId);
        if (!entry) return;
        entry.timer = setTimeout(pollOnce, 15000);
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
  if (!record || record.deleted) {
    markVideoFailed(safeId, '记录不存在或已删除');
    return;
  }
  const deviceId = record?.device_id ?? null;
  const scannerDevice = deviceId == null ? null : db.getDeviceById(deviceId);
  if (!scannerDevice) {
    markVideoFailed(safeId, '未绑定工作台设备');
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
      const clipWindow = getClipWindowMs();
      const estimatedEndMs = scannedAt
        ? (scannedAt.getTime() + clipWindow.afterMs)
        : (Date.now() + clipWindow.durationMs);
      const backendTaskIdRaw = Number(row?.video_backend_id);
      const hasBackendTask = String(row?.video_backend_id || '').trim() !== '';
      const backendTaskId = Number.isFinite(backendTaskIdRaw) ? backendTaskIdRaw : recordId;
      if (hasBackendTask && estimatedEndMs + VIDEO_SUBMIT_BUFFER_MS <= Date.now()) {
        // 已提交过且时间窗已过：后端正在下载，恢复轮询即可
        startVideoStatusPolling(recordId, backendUrl, estimatedEndMs, backendTaskId);
      } else {
        // 从未提交（重启丢了延迟定时器）或时间窗还没到：重新走提交流程（内含延迟等待）
        stopVideoPolling(recordId);
        tryVideoRetry(recordId, backendUrl);
      }
    }, idx * 120);
  });
}

// 旧版曾因「单号格式不符」被跳过下载的记录，升级后按转换后的单号自动重新提交。
// 必须限流：每个任务都要登录一次 NVR，密集请求会触发海康设备的连接数限制/防暴力锁定（lUserID=-1）
function resubmitPreviouslySkippedRecords() {
  if (!db) return;
  try {
    const rows = db.queryRecords({ videoStatus: 'failed', page: 1, pageSize: 20, onlyDeleted: false });
    const skipped = rows.filter((r) => String(r.video_message || '').includes('单号格式不符，未提交下载'));
    if (!skipped.length) return;
    console.log(`[VideoRetry] 自动补提交历史被跳过的记录 ${skipped.length} 条（每条间隔 8 秒，防止 NVR 登录锁定）`);
    const backendUrl = getVideoBackendUrl();
    skipped.forEach((r, idx) => {
      setTimeout(() => {
        try {
          stopVideoPolling(Number(r.id));
          videoRetryCounts.delete(Number(r.id));
          tryVideoRetry(Number(r.id), backendUrl);
        } catch (e) {
          console.error(`[VideoRetry] 自动补提交单条失败(id=${r.id}): ${e?.message || e}`);
        }
      }, 5000 + idx * 8000);
    });
  } catch (e) {
    console.error(`[VideoRetry] 自动补提交失败: ${e?.message || e}`);
  }
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
  // 记录原样入库；提交后端前只转换有歧义的字符，任何内容都照常发起下载
  const backendBarcodeResult = normalizeBackendBarcode(barcode, record);
  const backendBarcode = backendBarcodeResult.value;
  if (backendBarcodeResult.converted) {
    console.log(`[VideoDownload] 单号转换(${backendBarcodeResult.reason}): ${JSON.stringify(barcode)} -> ${JSON.stringify(backendBarcode)}`);
  }

  const channelId = String(scannerDevice?.channel_id || '').trim();
  const videoDeviceIdRaw = scannerDevice?.video_device_id;
  const videoDeviceId =
    videoDeviceIdRaw == null || videoDeviceIdRaw === '' ? null : Number(videoDeviceIdRaw);

  // 所有前置失败都必须写回状态与原因，绝不静默 return（否则界面看起来「重试没反应」）
  if (!channelId) {
    console.log(`[VideoDownload] 没有配置通道ID，跳过下载。条码: ${barcode}`);
    markVideoFailed(recordId, '未配置录像通道');
    return;
  }
  if (!Number.isFinite(videoDeviceId)) {
    console.log(`[VideoDownload] 没有绑定录像设备，跳过下载。条码: ${barcode} 通道ID: ${channelId}`);
    markVideoFailed(recordId, '未绑定录像设备');
    return;
  }

  const videoDevice = db.getVideoDeviceById(videoDeviceId);
  if (!videoDevice) {
    console.log(`[VideoDownload] 找不到录像设备配置(id=${videoDeviceId})，跳过下载。条码: ${barcode} 通道ID: ${channelId}`);
    markVideoFailed(recordId, '录像设备配置不存在');
    return;
  }
  if (!Number(videoDevice.enabled)) {
    console.log(`[VideoDownload] 录像设备已禁用(id=${videoDeviceId})，跳过下载。条码: ${barcode}`);
    markVideoFailed(recordId, '录像设备已禁用');
    return;
  }

  const baseTime = parseLocalDateTime(record?.scanned_at) || new Date();
  const clipWindow = getClipWindowMs();
  const startTime = new Date(baseTime.getTime() - clipWindow.beforeMs);
  const endTime = new Date(baseTime.getTime() + clipWindow.afterMs);

  const formatTime = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

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
    expressNo: backendBarcode,
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

  console.log(`[VideoDownload] 触发录像下载: 条码=${barcode} 通道=${channelId} 录像设备=${videoDevice?.name || videoDeviceId} 时间窗=${formatTime(startTime)} ~ ${formatTime(endTime)}`);
  if (process.env.ZXJ_DEBUG === '1') {
    console.log(JSON.stringify(payload, null, 2));
  }

  try {
    const finalBackendUrl = backendUrl || getVideoBackendUrl();
    const url = new URL('/findByFree', finalBackendUrl);
    const chosenTaskId = Number(taskId ?? recordId);
    if (Number.isFinite(recordId) && Number.isFinite(chosenTaskId)) {
      url.searchParams.set('id', String(chosenTaskId));
    }
    url.searchParams.set('c', channelId);
    url.searchParams.set('expressNo', backendBarcode);
    url.searchParams.set('s', String(startTime.getTime()));
    url.searchParams.set('e', String(endTime.getTime()));
    url.searchParams.set('ip', String(videoDevice.base_url || ''));
    url.searchParams.set('port', String(sdkPort || ''));
    url.searchParams.set('username', String(videoDevice.username || ''));
    url.searchParams.set('password', String(videoDevice.password || ''));
    url.searchParams.set('rtspPort', String(rtspPort || ''));
    url.searchParams.set('streamType', String(streamType || ''));

    const doSubmit = () => {
      if (Number.isFinite(recordId)) videoSubmitTimers.delete(recordId);
      if (record?.deleted) return; // 等待期间被删除，不再提交
      // 诊断用：打印完整请求 URL（密码脱敏），可复制到浏览器直接访问验证后端响应
      console.log(`[VideoDownload] 请求URL: ${url.toString().replace(/password=[^&]*/, 'password=***')}`);
      const taskIdStr = Number.isFinite(chosenTaskId) ? String(chosenTaskId) : null;
      // 时间窗已结束才到这里：此时提交才是真正「下载中」，记录离开「视频等待中」的语义清晰
      if (Number.isFinite(recordId)) {
        if (shouldIgnoreVideoUpdate(recordId, taskIdStr)) return; // 期间已被新任务覆盖或已成功
        markVideoSubmitted(recordId, chosenTaskId, '等待');
      }
      requestVideoInfoFromBackend(url.toString(), finalBackendUrl)
      .then((info) => {
        const status = info?.status || (info?.path ? '成功' : '等待');
        // 全程使用自己生成的 taskId：避免后端返回不同 id 时 shouldIgnoreVideoUpdate 误判、轮询被掐断
        const taskIdStr = Number.isFinite(chosenTaskId) ? String(chosenTaskId) : null;
        const savedPathOrUrl = info?.path ?? null;

        if (savedPathOrUrl) console.log(`[VideoDownload] 后端已生成: ${savedPathOrUrl}`);
        if (Number.isFinite(recordId)) {
          if (shouldIgnoreVideoUpdate(recordId, taskIdStr)) return;
          if (savedPathOrUrl) {
            db.setRecordVideoInfo(recordId, { status: '成功', backendId: taskIdStr, videoPath: savedPathOrUrl, message: info?.message ?? null });
            notifyRecordVideoUpdatedNow(recordId);
          } else {
            // 后端已接收任务：保持「下载中」交给轮询确认，不立刻打回「失败」，
            // 最终失败由轮询写明原因（timeout / 后端失败），避免「点重试又秒回失败」
            db.setRecordVideoInfo(recordId, {
              status: '等待',
              backendId: taskIdStr,
              videoPath: null,
              message: status === '失败' ? `后端返回失败，轮询确认中: ${info?.message || '无原因'}` : (info?.message ?? null)
            });
            notifyRecordVideoUpdatedNow(recordId);
          }
        }

        if (savedPathOrUrl) {
          showToast(`录像下载完成: ${barcode}`);
        } else {
          showToast(isRetry ? `录像补偿已提交: ${barcode}` : `录像下载任务已提交: ${barcode}`);
          if (Number.isFinite(recordId)) startVideoStatusPolling(recordId, finalBackendUrl, endTime.getTime(), chosenTaskId);
        }
      })
      .catch((err) => {
        console.log(`[VideoDownload] 下载失败: ${err.message || err}`);
        const taskIdStr = Number.isFinite(chosenTaskId) ? String(chosenTaskId) : null;
        // 旧任务的异常回调不得覆盖新任务状态
        if (Number.isFinite(recordId) && !shouldIgnoreVideoUpdate(recordId, taskIdStr)) {
          markVideoFailed(recordId, `后端请求失败: ${err?.message || String(err)}`);
        }
        showToast(`录像下载失败: ${barcode}`);
      });
    };

    // 时间窗还没走完（扫码后未来 N 秒的录像尚不存在）：先显示「等待」，到点再提交后端
    const submitDelayMs = endTime.getTime() + VIDEO_SUBMIT_BUFFER_MS - Date.now();
    if (Number.isFinite(recordId) && submitDelayMs > 0) {
      const waitSec = Math.ceil(submitDelayMs / 1000);
      // 还没提交过后端：backendId 必须留空，重启恢复时据此判断需要重新提交而不是只恢复轮询
      db.setRecordVideoInfo(recordId, { status: '等待', backendId: null, videoPath: null, message: `等待录像生成(约${waitSec}秒)` });
      notifyRecordVideoUpdatedNow(recordId);
      console.log(`[VideoDownload] 时间窗未结束，${waitSec}秒后提交后端。条码: ${barcode}`);
      videoSubmitTimers.set(recordId, setTimeout(doSubmit, submitDelayMs));
      return;
    }
    doSubmit();
  } catch (e) {
    console.log(`[VideoDownload] 调用下载出错: ${e.message || e}`);
    markVideoFailed(recordId, `下载调用异常: ${e?.message || String(e)}`);
  }
}

const { cleanIp } = require('./utils');

const STALE_THRESHOLD_MS = 10 * 60 * 1000;      // 超过 10 分钟无数据 → stale
const FORCE_DROP_STALE_MS = 30 * 60 * 1000;      // stale 超过 30 分钟 → 主动断开等待重连

class ScannerManager {
  constructor() {
    this.devices = new Map();
    this.tcpServer = null;
    this.tcpClients = new Map(); // ip -> socket
    this.unknownClients = new Map(); // ip -> { count, lastSeen }
    this.tcpServerPort = DEFAULT_SCANNER_PORT;
    // TCP 监听延迟到 app ready 后启动（startTcpServer 由 whenReady 调用），
    // 避免 ready 前收到连接时设备表尚未加载且无法创建窗口
    this.watchdogTimer = setInterval(() => this.runWatchdog(), 30000);
  }

  identityKeyOf(device) {
    return `${String(device?.type || 'tcp').toLowerCase()}|${String(device?.identifier || '').trim()}`;
  }

  hasLiveSession(entry) {
    const d = entry?.device;
    if (!d) return false;
    if (String(d.type || '').toLowerCase() === 'usb') {
      return !!(entry.serialPort && entry.serialPort.isOpen);
    }
    return this.tcpClients.has(String(d.identifier || '').trim());
  }

  runWatchdog() {
    try {
      const now = Date.now();
      for (const entry of this.devices.values()) {
        if (entry.state !== 'connected' && entry.state !== 'stale') continue;
        const lastSeenRaw = entry.client?.last_seen_at;
        const lastSeen = lastSeenRaw ? Date.parse(lastSeenRaw) : NaN;
        const idleMs = Number.isFinite(lastSeen) ? now - lastSeen : Infinity;
        if (entry.state === 'connected' && idleMs > STALE_THRESHOLD_MS) {
          entry.state = 'stale';
          console.warn(`[Watchdog] ${buildDeviceName(entry.device)} 已 ${Math.round(idleMs / 60000)} 分钟未收到数据，链路可能异常`);
        } else if (entry.state === 'stale') {
          if (idleMs <= STALE_THRESHOLD_MS) {
            entry.state = 'connected';
          } else if (idleMs > FORCE_DROP_STALE_MS) {
            console.warn(`[Watchdog] ${buildDeviceName(entry.device)} 长时间无数据，主动断开以等待扫码枪重连`);
            this.destroySocket(entry.device.id);
            entry.client = null;
            entry.state = 'disconnected';
          }
        }
      }
      this.broadcast();
    } catch (e) {
      console.error(`[Watchdog] 异常: ${e?.message || e}`);
    }
  }

  stopTcpServer() {
    if (!this.tcpServer) return;
    try {
      this.tcpServer.close();
    } catch (e) { }
    this.tcpServer = null;
  }

  // 支持精确 IP 匹配；identifier 含 * 时按网段匹配（如 192.168.1.*）
  matchDeviceByIp(ip) {
    let fallback = null;
    for (const entry of this.devices.values()) {
      const d = entry.device;
      if (!d.enabled || String(d.type || '').toLowerCase() !== 'tcp') continue;
      const idf = String(d.identifier || '').trim();
      if (!idf) continue;
      if (idf === ip) return entry;
      if (idf.includes('*') && !fallback) {
        const pattern = new RegExp('^' + idf.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
        if (pattern.test(ip)) fallback = entry;
      }
    }
    return fallback;
  }

  startTcpServer() {
    if (this.tcpServer) return;
    this.tcpServer = net.createServer((socket) => {
      const ip = cleanIp(socket.remoteAddress);
      const remotePort = Number(socket.remotePort);

      // 查找对应的已启用TCP设备
      const matchedDeviceEntry = this.matchDeviceByIp(ip);

      if (!matchedDeviceEntry) {
        const prev = this.unknownClients.get(ip);
        this.unknownClients.set(ip, {
          count: (prev?.count || 0) + 1,
          lastSeen: new Date().toISOString()
        });
        console.warn(`[TCP Server] 收到未知设备连接: ${ip}，已拒绝。请检查扫码枪 IP 是否变化，或在工作台管理中添加该 IP`);
        if (!prev) showToast(`未知设备尝试连接: ${ip}`);
        this.broadcast();
        socket.destroy();
        return;
      }
      this.unknownClients.delete(ip);

      const id = matchedDeviceEntry.device.id;
      const prevSocket = this.tcpClients.get(ip);
      if (prevSocket && !prevSocket.destroyed) {
        prevSocket.destroy();
      }
      this.tcpClients.set(ip, socket);

      // TCP 保活探测：拔线/断电后约 1~2 分钟内可感知并触发 close
      socket.setKeepAlive(true, 20000);
      socket.setNoDelay(true);
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
        const text = String(chunk || '');
        if (process.env.ZXJ_DEBUG === '1' && text.trim()) {
          console.log(`[RAW] ${buildDeviceName(e.device)} <- ${JSON.stringify(text.length > 100 ? text.slice(0, 100) + '…' : text)}`);
        }
        e.buffer += text;
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
          shouldReconnect: false,
          identityKey: this.identityKeyOf(cfg)
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
    return {
      localIps: this.getLocalIps(),
      devices: this.getStatuses(),
      tcpListenPort: this.tcpServerPort,
      unknownClients: Array.from(this.unknownClients.entries()).map(([ip, v]) => ({ ip, count: v.count, lastSeen: v.lastSeen }))
    };
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

  connect(id, { force = false } = {}) {
    const entry = this.devices.get(id);
    if (!entry) return { ok: false, message: 'not found' };
    const d = entry.device;
    const identifier = String(d.identifier || '').trim();
    if (!identifier) return { ok: false, message: 'empty identifier' };

    // 幂等：会话在线且标识(type/identifier)未变化时直接返回，避免误断正在收数的连接
    const key = this.identityKeyOf(d);
    const live = entry.state === 'connected' || entry.state === 'stale' || entry.state === 'waiting_connection';
    if (!force && live && entry.identityKey === key && this.hasLiveSession(entry)) {
      return { ok: true, message: 'unchanged' };
    }
    entry.identityKey = key;

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
  initLogger();
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
  scannerManager.startTcpServer(); // app ready 且设备表加载后再监听端口
  scannerManager.connectEnabled();
  restorePendingVideoTasks();
  resubmitPreviouslySkippedRecords();
  startAutoRestartScheduler();
  while (pendingToasts.length) showToast(pendingToasts.shift());

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
    if (scannerManager) {
      if (scannerManager.watchdogTimer) clearInterval(scannerManager.watchdogTimer);
      scannerManager.disconnectAll();
      scannerManager.stopTcpServer();
    }
    if (logPushTimer) clearTimeout(logPushTimer);
    if (videoNotifyTimer) clearTimeout(videoNotifyTimer);
    if (autoRestartTimer) clearInterval(autoRestartTimer);
    if (db) db.close();
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
  // 文件名只替换有歧义的字符（与后端单号同一套规则），其余原样保留；并限制长度
  let base = replaceAmbiguousChars(sanitizeBarcode(String(record?.barcode || ''))).slice(0, 120);
  if (!base || !/[^._-]/.test(base) || base === '.' || base === '..') {
    base = `video-${Number(record?.id) || Date.now()}`;
  }
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
  const scannerDevice = Number.isFinite(deviceId) ? db.getDeviceById(deviceId) : null;
  // 前置失败一律写回状态与原因，不再静默返回
  if (!scannerDevice) {
    markVideoFailed(safeId, '未绑定工作台设备');
    return { ok: false, message: 'device not found' };
  }
  if (!scannerDevice.enabled) {
    markVideoFailed(safeId, '工作台设备已禁用');
    return { ok: false, message: 'device disabled' };
  }
  if (!scannerDevice.channel_id) {
    markVideoFailed(safeId, '未配置录像通道');
    return { ok: false, message: 'device has no channel' };
  }

  stopVideoPolling(safeId);
  videoRetryCounts.delete(safeId); // 用户手动重试：恢复完整自动重试机会
  const backendUrl = getVideoBackendUrl();
  downloadVideo(scannerDevice, record, { backendUrl, taskId: generateTaskId(), isRetry: true });
  showToast('已重新提交录像下载，状态稍后刷新');
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

ipcMain.handle('export-csv', async (event, params) => {
  // 支持两种入参：旧版传记录数组（导出所给记录），新版传筛选条件（导出全部匹配结果）
  let records;
  if (Array.isArray(params)) {
    records = params;
  } else {
    const filter = params && typeof params === 'object' ? params : {};
    records = db.queryRecords({
      keyword: filter.keyword || null,
      date: filter.date || null,
      dateFrom: filter.dateFrom || null,
      dateTo: filter.dateTo || null,
      deviceId: filter.deviceId || null,
      onlyDeleted: !!filter.onlyDeleted,
      videoStatus: filter.videoStatus || '',
      page: 1,
      pageSize: 100000
    });
  }
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
  return { ok: true, filePath, count: records.length };
});

// ============ 开机自启 / 定时重启 / 批量补下载 ============

ipcMain.handle('open-logs-folder', () => {
  if (!logDir) return { ok: false, message: '日志目录尚未初始化' };
  try {
    require('electron').shell.openPath(logDir);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String(e?.message || e) };
  }
});

ipcMain.handle('get-autostart', () => {
  try {
    return { ok: true, enabled: !!app.getLoginItemSettings().openAtLogin };
  } catch (e) {
    return { ok: false, enabled: false };
  }
});

ipcMain.handle('set-autostart', (event, enabled) => {
  if (!app.isPackaged) {
    return { ok: false, message: '开发模式下不支持设置开机自启，请使用安装版' };
  }
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled });
    return { ok: true, enabled: !!app.getLoginItemSettings().openAtLogin };
  } catch (e) {
    return { ok: false, message: String(e?.message || e) };
  }
});

let autoRestartTimer = null;
let autoRestartLastRunDay = '';

function getAutoRestartConfig() {
  const fallback = { enabled: false, time: '04:00' };
  try {
    const raw = db ? db.getSetting('auto_restart_config') : null;
    if (!raw) return fallback;
    const parsed = JSON.parse(String(raw));
    return {
      enabled: !!parsed.enabled,
      time: /^\d{2}:\d{2}$/.test(String(parsed.time)) ? String(parsed.time) : '04:00'
    };
  } catch (e) {
    return fallback;
  }
}

function startAutoRestartScheduler() {
  if (autoRestartTimer) clearInterval(autoRestartTimer);
  autoRestartTimer = null;
  const cfg = getAutoRestartConfig();
  if (!cfg.enabled || !cfg.time) return;
  console.log(`[AutoRestart] 定时重启已开启: 每日 ${cfg.time}`);
  autoRestartTimer = setInterval(() => {
    try {
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      if (hhmm === cfg.time && autoRestartLastRunDay !== day) {
        autoRestartLastRunDay = day;
        console.log(`[AutoRestart] 到达定时重启时间 ${cfg.time}，2 秒后自动重启`);
        showToast(`到达定时重启时间 ${cfg.time}，正在自动重启…`);
        setTimeout(() => {
          app.relaunch();
          app.exit(0);
        }, 2000);
      }
    } catch (e) { }
  }, 30000);
}

ipcMain.handle('get-auto-restart', () => ({ ok: true, ...getAutoRestartConfig() }));

ipcMain.handle('set-auto-restart', (event, params) => {
  const enabled = !!(params && params.enabled);
  const rawTime = String((params && params.time) || '04:00').trim();
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(rawTime) ? rawTime : '04:00';
  db.setSetting('auto_restart_config', JSON.stringify({ enabled, time }));
  startAutoRestartScheduler();
  return { ok: true, enabled, time };
});

// 批量补下载：对当前筛选条件下"无视频且非成功"的记录重新提交下载（上限 300 条）
ipcMain.handle('retry-video-batch', (event, params) => {
  const filter = params && typeof params === 'object' ? params : {};
  const rows = db.queryRecords({
    keyword: filter.keyword || null,
    date: filter.date || null,
    dateFrom: filter.dateFrom || null,
    dateTo: filter.dateTo || null,
    deviceId: filter.deviceId || null,
    onlyDeleted: false,
    videoStatus: filter.videoStatus || '',
    page: 1,
    pageSize: 50
  });
  const candidates = rows.filter((r) => !r.deleted && !String(r.video_path || '').trim() && String(r.video_status || '') !== '成功');
  if (!candidates.length) return { ok: true, submitted: 0 };

  console.log(`[VideoRetry] 批量补下载 ${candidates.length} 条（按当前筛选条件）`);
  showToast(`正在补下载 ${candidates.length} 条视频…（每条间隔 8 秒，防止 NVR 登录锁定）`);
  candidates.forEach((r, idx) => {
    setTimeout(() => {
      try {
        stopVideoPolling(Number(r.id)); // 先停掉可能存在的旧轮询，避免双轮询
        videoRetryCounts.delete(Number(r.id)); // 用户发起的补下载：恢复完整自动重试机会
        tryVideoRetry(Number(r.id), getVideoBackendUrl());
      } catch (e) {
        console.error(`[VideoRetry] 补下载单条失败(id=${r.id}): ${e?.message || e}`);
      }
    }, 3000 + idx * 8000);
  });
  return { ok: true, submitted: candidates.length };
});

// 按选中记录 ID 批量补下载（列表多选操作）
ipcMain.handle('retry-video-ids', (event, params) => {
  const ids = Array.isArray(params?.ids)
    ? params.ids.map((v) => Number(v)).filter((v) => Number.isFinite(v))
    : [];
  if (!ids.length) return { ok: true, submitted: 0 };

  const candidates = [];
  for (const id of ids) {
    const r = db.getRecordById(id);
    if (r && !r.deleted && !String(r.video_path || '').trim() && String(r.video_status || '') !== '成功') {
      candidates.push(r);
    }
  }
  if (!candidates.length) return { ok: true, submitted: 0 };

  console.log(`[VideoRetry] 按选中补下载 ${candidates.length} 条`);
  showToast(`正在补下载选中的 ${candidates.length} 条视频…`);
  candidates.forEach((r, idx) => {
    setTimeout(() => {
      try {
        stopVideoPolling(Number(r.id));
        videoRetryCounts.delete(Number(r.id)); // 用户发起的补下载：恢复完整自动重试机会
        tryVideoRetry(Number(r.id), getVideoBackendUrl());
      } catch (e) {
        console.error(`[VideoRetry] 补下载单条失败(id=${r.id}): ${e?.message || e}`);
      }
    }, 3000 + idx * 8000);
  });
  return { ok: true, submitted: candidates.length };
});
