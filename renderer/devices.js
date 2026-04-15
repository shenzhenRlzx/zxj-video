const localIpInfoEl = document.getElementById('localIpInfo');
const devicesBodyEl = document.getElementById('devicesBody');
const deviceTypeSelectEl = document.getElementById('deviceTypeSelect');
const deviceNameInputEl = document.getElementById('deviceNameInput');
const deviceIdentifierInputEl = document.getElementById('deviceIdentifierInput');
const videoDeviceSelectEl = document.getElementById('videoDeviceSelect');
const deviceChannelSelectEl = document.getElementById('deviceChannelSelect');
const addDeviceBtnEl = document.getElementById('addDeviceBtn');
const connectEnabledBtnEl = document.getElementById('connectEnabledBtn');
const disconnectAllBtnEl = document.getElementById('disconnectAllBtn');
const openLogsBtnEl = document.getElementById('openLogsBtn');
const logModalEl = document.getElementById('logModal');
const logTextEl = document.getElementById('logText');
const closeLogsBtnEl = document.getElementById('closeLogsBtn');
const clearLogsBtnEl = document.getElementById('clearLogsBtn');
const copyLogsBtnEl = document.getElementById('copyLogsBtn');

const editDeviceModalEl = document.getElementById('editDeviceModal');
const editDeviceTypeSelectEl = document.getElementById('editDeviceTypeSelect');
const editDeviceNameInputEl = document.getElementById('editDeviceNameInput');
const editDeviceIdentifierInputEl = document.getElementById('editDeviceIdentifierInput');
const editVideoDeviceSelectEl = document.getElementById('editVideoDeviceSelect');
const editDeviceChannelSelectEl = document.getElementById('editDeviceChannelSelect');
const cancelEditDeviceBtnEl = document.getElementById('cancelEditDeviceBtn');
const saveEditDeviceBtnEl = document.getElementById('saveEditDeviceBtn');

const livePreviewModalEl = document.getElementById('livePreviewModal');
const livePreviewTitleEl = document.getElementById('livePreviewTitle');
let livePreviewVideoEl = document.getElementById('livePreviewVideo');
const livePreviewStatusEl = document.getElementById('livePreviewStatus');
const startLivePreviewBtnEl = document.getElementById('startLivePreviewBtn');
const stopLivePreviewBtnEl = document.getElementById('stopLivePreviewBtn');
const closeLivePreviewBtnEl = document.getElementById('closeLivePreviewBtn');
const toggleMuteBtnEl = document.getElementById('toggleMuteBtn');
const streamTypeSelectEl = document.getElementById('streamTypeSelect');
const autoReconnectChkEl = document.getElementById('autoReconnectChk');
const fullscreenBtnEl = document.getElementById('fullscreenBtn');
const liveLatencyEl = document.getElementById('liveLatency');
const liveRetryEl = document.getElementById('liveRetry');
const toastEl = document.getElementById('toast');

let videoDevices = [];
let logText = '';
let editingDevice = null;
const channelsCache = new Map(); // videoDeviceId -> channels[]

let toastTimer = null;
function showToast(message) {
  if (!toastEl) return;
  toastEl.textContent = String(message || '');
  toastEl.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.add('hidden');
  }, 2200);
}

let flvJsLoadPromise = null;
function ensureFlvJsLoaded() {
  if (window.flvjs) return Promise.resolve(true);
  if (flvJsLoadPromise) return flvJsLoadPromise;
  flvJsLoadPromise = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.bootcdn.net/ajax/libs/flv.js/1.6.2/flv.min.js';
    s.async = true;
    const timer = setTimeout(() => resolve(false), 5000);
    s.onload = () => {
      clearTimeout(timer);
      resolve(!!window.flvjs);
    };
    s.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    document.head.appendChild(s);
  });
  return flvJsLoadPromise;
}

let liveFlvPlayer = null;
let liveCurrentChannel = null;
let liveCurrentOrigin = null;
let liveBaseFlvUrl = null;
let liveRetryCount = 0;
let liveReconnectTimer = null;
let liveMetricsTimer = null;
let liveErrorHandler = null;
let liveWatchdogTimer = null;
let liveOpening = false;
let liveVideoHandlers = null;
let liveCurrentVideoDeviceId = null;

function setLiveStatus(text) {
  if (livePreviewStatusEl) livePreviewStatusEl.textContent = String(text || '');
}

function resetLiveVideoElement() {
  if (!livePreviewVideoEl) return;
  const parent = livePreviewVideoEl.parentNode;
  if (!parent) return;
  const fresh = livePreviewVideoEl.cloneNode(false);
  parent.replaceChild(fresh, livePreviewVideoEl);
  livePreviewVideoEl = fresh;
}

function setLiveRetry(count) {
  if (liveRetryEl) liveRetryEl.textContent = `重连: ${Number(count) || 0}`;
}

function setLiveLatencyText(text) {
  if (liveLatencyEl) liveLatencyEl.textContent = String(text || '延迟: --');
}

function buildFlvUrlWithStreamType(rawUrl, streamType) {
  try {
    const u = new URL(String(rawUrl));
    u.searchParams.set('streamType', String(streamType));
    return u.toString();
  } catch (e) {
    return String(rawUrl);
  }
}

function updateMuteButton() {
  if (!toggleMuteBtnEl || !livePreviewVideoEl) return;
  toggleMuteBtnEl.textContent = livePreviewVideoEl.muted ? '取消静音' : '静音';
}

function startMetrics() {
  if (!livePreviewVideoEl) return;
  if (liveMetricsTimer) clearInterval(liveMetricsTimer);
  liveMetricsTimer = setInterval(() => {
    try {
      const v = livePreviewVideoEl;
      if (!v || v.readyState === 0) {
        setLiveLatencyText('延迟: --');
        return;
      }
      const b = v.buffered;
      if (!b || b.length === 0) {
        setLiveLatencyText('延迟: --');
        return;
      }
      const end = b.end(b.length - 1);
      const cur = v.currentTime || 0;
      const lag = Math.max(0, end - cur);
      setLiveLatencyText(`延迟: ${lag.toFixed(1)}s`);
    } catch (e) {
      setLiveLatencyText('延迟: --');
    }
  }, 500);
}

function stopMetrics() {
  if (liveMetricsTimer) clearInterval(liveMetricsTimer);
  liveMetricsTimer = null;
  setLiveLatencyText('延迟: --');
}

function clearReconnectTimer() {
  if (liveReconnectTimer) clearTimeout(liveReconnectTimer);
  liveReconnectTimer = null;
}

function clearWatchdogTimer() {
  if (liveWatchdogTimer) clearInterval(liveWatchdogTimer);
  liveWatchdogTimer = null;
}

function clearVideoHandlers() {
  if (!livePreviewVideoEl || !liveVideoHandlers) return;
  try {
    livePreviewVideoEl.removeEventListener('playing', liveVideoHandlers.onPlaying);
    livePreviewVideoEl.removeEventListener('waiting', liveVideoHandlers.onWaiting);
    livePreviewVideoEl.removeEventListener('stalled', liveVideoHandlers.onStalled);
    livePreviewVideoEl.removeEventListener('error', liveVideoHandlers.onError);
  } catch (e) {}
  liveVideoHandlers = null;
}

function shouldAutoReconnect() {
  return !!autoReconnectChkEl?.checked;
}

function scheduleReconnect({ force } = {}) {
  if (!liveBaseFlvUrl) return;
  if (!shouldAutoReconnect()) return;
  if (liveReconnectTimer) return;
  if (liveOpening && !force) return;
  liveRetryCount += 1;
  setLiveRetry(liveRetryCount);
  setLiveStatus(`连接异常，${Math.min(10, 2 + liveRetryCount)}秒后重连...`);
  const delayMs = Math.min(10_000, (2_000 + liveRetryCount * 1_000));
  liveReconnectTimer = setTimeout(() => {
    liveReconnectTimer = null;
    const streamType = Number(streamTypeSelectEl?.value || 2) || 2;
    const nextUrl = buildFlvUrlWithStreamType(liveBaseFlvUrl, streamType);
    openLivePreview({ title: livePreviewTitleEl?.textContent || '实时预览', flvUrl: nextUrl, channelId: liveCurrentChannel, videoDeviceId: liveCurrentVideoDeviceId, isReconnect: true });
  }, delayMs);
}

async function probeStream(urlString) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3500);
  try {
    const res = await fetch(urlString, { method: 'GET', signal: ctrl.signal });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    if (ct && !ct.includes('video/x-flv') && !ct.includes('application/octet-stream')) {
      return { ok: false, message: `content-type=${ct || 'unknown'}` };
    }
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const r = await reader.read();
      try { reader.cancel(); } catch (e) {}
      if (!r || !r.value || r.value.length === 0) return { ok: false, message: 'no data' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

async function stopLivePreview({ preserve } = {}) {
  clearReconnectTimer();
  clearWatchdogTimer();
  stopMetrics();
  clearVideoHandlers();
  liveOpening = false;
  if (liveFlvPlayer) {
    try {
      if (liveErrorHandler && typeof liveFlvPlayer.off === 'function' && window.flvjs?.Events?.ERROR) {
        liveFlvPlayer.off(window.flvjs.Events.ERROR, liveErrorHandler);
      }
      liveFlvPlayer.pause();
      liveFlvPlayer.unload();
      liveFlvPlayer.detachMediaElement();
      liveFlvPlayer.destroy();
    } catch (e) {}
    liveFlvPlayer = null;
    liveErrorHandler = null;
  }
  if (livePreviewVideoEl) {
    try {
      livePreviewVideoEl.pause();
      livePreviewVideoEl.removeAttribute('src');
      livePreviewVideoEl.load();
    } catch (e) {}
  }
  resetLiveVideoElement();
  if (liveCurrentOrigin && liveCurrentChannel != null) {
    try {
      await fetch(`${liveCurrentOrigin}/live/stop?channel=${encodeURIComponent(liveCurrentChannel)}`, { method: 'POST' });
    } catch (e) {}
  }
  if (!preserve) {
    liveCurrentChannel = null;
    liveCurrentOrigin = null;
    liveBaseFlvUrl = null;
    liveCurrentVideoDeviceId = null;
  }
  liveRetryCount = 0;
  setLiveRetry(0);
  setLiveStatus('已停止');
}

async function openLivePreview({ title, flvUrl, channelId, videoDeviceId, isReconnect } = {}) {
  if (!livePreviewModalEl || !livePreviewVideoEl) return;
  const ok = await ensureFlvJsLoaded();
  if (!ok || !window.flvjs || typeof window.flvjs.isSupported !== 'function' || !window.flvjs.isSupported()) {
    showToast('当前环境不支持 HTTP-FLV 播放');
    return;
  }
  await stopLivePreview();
  resetLiveVideoElement();

  if (livePreviewTitleEl) livePreviewTitleEl.textContent = title || '实时预览';
  livePreviewModalEl.classList.remove('hidden');
  setLiveStatus('连接中...');
  liveOpening = true;
  if (!isReconnect) {
    liveRetryCount = 0;
    setLiveRetry(0);
  }
  liveBaseFlvUrl = String(flvUrl || '');

  let origin = null;
  try {
    const u = new URL(String(flvUrl));
    origin = u.origin;
  } catch (e) {}
  liveCurrentOrigin = origin;
  liveCurrentChannel = channelId;
  liveCurrentVideoDeviceId = videoDeviceId;

  try {
    const streamType = Number(streamTypeSelectEl?.value || 2) || 2;
    const realUrl = buildFlvUrlWithStreamType(flvUrl, streamType);
    livePreviewVideoEl.autoplay = true;
    livePreviewVideoEl.muted = true;
    livePreviewVideoEl.playsInline = true;
    livePreviewVideoEl.setAttribute('playsinline', '');
    liveFlvPlayer = window.flvjs.createPlayer(
      { type: 'flv', url: String(realUrl), isLive: true, hasAudio: false, hasVideo: true, cors: true },
      { enableWorker: false, enableStashBuffer: false, stashInitialSize: 0, isLive: true, autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 30, autoCleanupMinBackwardDuration: 15 }
    );
    liveFlvPlayer.attachMediaElement(livePreviewVideoEl);
    liveFlvPlayer.load();
    updateMuteButton();
    const p = liveFlvPlayer.play?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
    setLiveStatus('缓冲中...');
    startMetrics();
    if (window.flvjs?.Events?.METADATA_ARRIVED) {
      liveFlvPlayer.on(window.flvjs.Events.METADATA_ARRIVED, () => {
        liveOpening = false;
        setLiveStatus('播放中');
      });
    }
    if (window.flvjs?.Events?.LOADING_COMPLETE) {
      liveFlvPlayer.on(window.flvjs.Events.LOADING_COMPLETE, () => {
        if (livePreviewVideoEl?.readyState < 2) {
          liveOpening = false;
          scheduleReconnect({ force: true });
        }
      });
    }
    if (window.flvjs?.Events?.ERROR) {
      liveErrorHandler = (_type, detail, info) => {
        const parts = [];
        if (detail != null) parts.push(String(detail));
        if (info != null) parts.push(String(info));
        const extraMsg = parts.length ? ` (${parts.join(' ')})` : '';
        setLiveStatus(`播放器错误${extraMsg}`);
        liveOpening = false;
        scheduleReconnect({ force: true });
      };
      liveFlvPlayer.on(window.flvjs.Events.ERROR, liveErrorHandler);
    }
    liveVideoHandlers = {
      onPlaying: () => {
        liveOpening = false;
        setLiveStatus('播放中');
      },
      onWaiting: () => setLiveStatus('缓冲中...'),
      onStalled: () => {
        liveOpening = false;
        scheduleReconnect({ force: true });
      },
      onError: () => {
        liveOpening = false;
        scheduleReconnect({ force: true });
      }
    };
    livePreviewVideoEl.addEventListener('playing', liveVideoHandlers.onPlaying);
    livePreviewVideoEl.addEventListener('waiting', liveVideoHandlers.onWaiting);
    livePreviewVideoEl.addEventListener('stalled', liveVideoHandlers.onStalled);
    livePreviewVideoEl.addEventListener('error', liveVideoHandlers.onError);

    const startedAt = Date.now();
    liveWatchdogTimer = setInterval(() => {
      if (!livePreviewVideoEl) return;
      const elapsed = Date.now() - startedAt;
      if (elapsed < 8000) return;
      const b = livePreviewVideoEl.buffered;
      const hasBuf = b && b.length > 0;
      if (livePreviewVideoEl.readyState < 2 && !hasBuf) {
        scheduleReconnect({ force: true });
      }
    }, 1000);
  } catch (e) {
    setLiveStatus(`播放失败: ${e?.message || String(e)}`);
    liveOpening = false;
    scheduleReconnect({ force: true });
  }
}

function formatLogEntry(entry) {
  const ts = entry?.ts ? String(entry.ts).replace('T', ' ').replace('Z', '') : '';
  const level = entry?.level ? String(entry.level).toUpperCase() : 'INFO';
  const msg = entry?.message ? String(entry.message) : '';
  return `${ts} [${level}] ${msg}`.trim();
}

function appendLog(entry) {
  const line = formatLogEntry(entry);
  if (!line) return;
  logText = logText ? `${logText}\n${line}` : line;
  if (logTextEl) {
    logTextEl.textContent = logText;
    logTextEl.scrollTop = logTextEl.scrollHeight;
  }
}

async function openLogs() {
  if (!logModalEl) return;
  logModalEl.classList.remove('hidden');
  logText = '';
  if (logTextEl) logTextEl.textContent = '加载中...';
  const res = await window.api.getLogs?.();
  const list = Array.isArray(res?.logs) ? res.logs : [];
  logText = list.map(formatLogEntry).filter(Boolean).join('\n');
  if (logTextEl) {
    logTextEl.textContent = logText || '暂无日志';
    logTextEl.scrollTop = logTextEl.scrollHeight;
  }
}

function closeLogs() {
  if (!logModalEl) return;
  logModalEl.classList.add('hidden');
}

function videoDeviceNameById(id) {
  const safeId = Number(id);
  if (!Number.isFinite(safeId)) return '--';
  const found = videoDevices.find((v) => Number(v.id) === safeId);
  return found?.name || `ID:${safeId}`;
}

function renderVideoDeviceSelect() {
  if (!videoDeviceSelectEl) return;
  const currentValue = videoDeviceSelectEl.value;
  videoDeviceSelectEl.innerHTML = '';
  const optNone = document.createElement('option');
  optNone.value = '';
  optNone.textContent = '录像设备(可选)';
  videoDeviceSelectEl.appendChild(optNone);
  videoDevices.forEach((d) => {
    const opt = document.createElement('option');
    opt.value = String(d.id);
    const enabled = Boolean(d.enabled);
    opt.textContent = enabled ? d.name : `${d.name} (已禁用)`;
    if (!enabled) opt.disabled = true;
    videoDeviceSelectEl.appendChild(opt);
  });
  const hasValue = Array.from(videoDeviceSelectEl.options).some((o) => o.value === currentValue);
  videoDeviceSelectEl.value = hasValue ? currentValue : '';
}

function renderChannelSelect(selectEl, channels, placeholder) {
  if (!selectEl) return;
  const currentValue = selectEl.value;
  selectEl.innerHTML = '';
  const optNone = document.createElement('option');
  optNone.value = '';
  optNone.textContent = placeholder || '录像通道';
  selectEl.appendChild(optNone);
  const list = Array.isArray(channels) ? channels : [];
  list.forEach((ch) => {
    const opt = document.createElement('option');
    const id = String(ch.id || '').trim();
    opt.value = id;
    const name = ch.name ? ` (${String(ch.name).trim()})` : '';
    const online = ch?.online;
    const statusText = online === true ? '在线' : online === false ? '离线' : '未知';
    opt.textContent = `${id}${name} - ${statusText}`;
    if (online === false) opt.disabled = true;
    selectEl.appendChild(opt);
  });
  const hasValue = Array.from(selectEl.options).some((o) => o.value === currentValue);
  selectEl.value = hasValue ? currentValue : '';
}

async function loadChannelsForVideoDevice(videoDeviceId) {
  const safeId = Number(videoDeviceId);
  if (!Number.isFinite(safeId)) return [];
  if (channelsCache.has(safeId)) return channelsCache.get(safeId) || [];
  const res = await window.api.listVideoChannels?.(safeId);
  const list = res?.ok ? (Array.isArray(res.channels) ? res.channels : []) : [];
  channelsCache.set(safeId, list);
  return list;
}

async function refreshAddChannelOptions() {
  if (!deviceChannelSelectEl) return;
  const videoDeviceId = String(videoDeviceSelectEl?.value || '').trim();
  const safeId = Number(videoDeviceId);
  if (!Number.isFinite(safeId)) {
    renderChannelSelect(deviceChannelSelectEl, [], '录像通道(先选录像设备)');
    return;
  }
  const dev = videoDevices.find((v) => Number(v.id) === safeId) || null;
  if (dev && !dev.enabled) {
    renderChannelSelect(deviceChannelSelectEl, [], '录像设备已禁用');
    return;
  }
  renderChannelSelect(deviceChannelSelectEl, [], '通道加载中...');
  const channels = await loadChannelsForVideoDevice(safeId);
  renderChannelSelect(deviceChannelSelectEl, channels, channels.length ? '请选择录像通道' : '未获取到通道');
}

function renderEditVideoDeviceSelect() {
  if (!editVideoDeviceSelectEl) return;
  const currentValue = editVideoDeviceSelectEl.value;
  editVideoDeviceSelectEl.innerHTML = '';
  const optNone = document.createElement('option');
  optNone.value = '';
  optNone.textContent = '录像设备(可选)';
  editVideoDeviceSelectEl.appendChild(optNone);
  videoDevices.forEach((d) => {
    const opt = document.createElement('option');
    opt.value = String(d.id);
    const enabled = Boolean(d.enabled);
    opt.textContent = enabled ? d.name : `${d.name} (已禁用)`;
    if (!enabled) opt.disabled = true;
    editVideoDeviceSelectEl.appendChild(opt);
  });
  const hasValue = Array.from(editVideoDeviceSelectEl.options).some((o) => o.value === currentValue);
  editVideoDeviceSelectEl.value = hasValue ? currentValue : '';
}

async function refreshEditChannelOptions() {
  if (!editDeviceChannelSelectEl) return;
  const videoDeviceId = String(editVideoDeviceSelectEl?.value || '').trim();
  const safeId = Number(videoDeviceId);
  if (!Number.isFinite(safeId)) {
    renderChannelSelect(editDeviceChannelSelectEl, [], '录像通道(先选录像设备)');
    return;
  }
  const dev = videoDevices.find((v) => Number(v.id) === safeId) || null;
  if (dev && !dev.enabled) {
    renderChannelSelect(editDeviceChannelSelectEl, [], '录像设备已禁用');
    return;
  }
  renderChannelSelect(editDeviceChannelSelectEl, [], '通道加载中...');
  const channels = await loadChannelsForVideoDevice(safeId);
  renderChannelSelect(editDeviceChannelSelectEl, channels, channels.length ? '请选择录像通道' : '未获取到通道');
}

function openEditDeviceModal(device) {
  if (!editDeviceModalEl) return;
  editingDevice = device || null;
  if (editDeviceTypeSelectEl) editDeviceTypeSelectEl.value = String(device?.type || 'tcp').toLowerCase() === 'usb' ? 'usb' : 'tcp';
  if (editDeviceNameInputEl) editDeviceNameInputEl.value = device?.name || '';
  if (editDeviceIdentifierInputEl) editDeviceIdentifierInputEl.value = device?.identifier || '';
  if (editVideoDeviceSelectEl) {
    renderEditVideoDeviceSelect();
    editVideoDeviceSelectEl.value = device?.video_device_id == null ? '' : String(device.video_device_id);
  }
  if (editDeviceChannelSelectEl) {
    editDeviceChannelSelectEl.value = device?.channel_id || '';
    refreshEditChannelOptions().then(() => {
      editDeviceChannelSelectEl.value = device?.channel_id || '';
    });
  }
  editDeviceModalEl.classList.remove('hidden');
}

function closeEditDeviceModal() {
  if (!editDeviceModalEl) return;
  editingDevice = null;
  editDeviceModalEl.classList.add('hidden');
}

function deviceStatusText(state) {
  if (state === 'connected') return '已连接';
  if (state === 'connecting') return '连接中';
  if (state === 'waiting_connection') return '等待连接';
  if (state === 'error') return '异常';
  return '未连接';
}

function renderDevices(devices) {
  if (!devicesBodyEl) return;
  devicesBodyEl.innerHTML = '';
  const list = Array.isArray(devices) ? devices : [];
  if (!list.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 8;
    cell.textContent = '暂无工作台，请先添加';
    cell.style.color = '#888';
    row.appendChild(cell);
    devicesBodyEl.appendChild(row);
    return;
  }

  list.forEach((d) => {
    const row = document.createElement('tr');

    const nameCell = document.createElement('td');
    nameCell.textContent = d.name || `${d.type.toUpperCase()}:${d.identifier}`;
    row.appendChild(nameCell);

    const typeCell = document.createElement('td');
    typeCell.textContent = d.type === 'usb' ? 'USB虚拟串口' : 'TCP';
    row.appendChild(typeCell);

    const idCell = document.createElement('td');
    idCell.textContent = d.identifier || '--';
    row.appendChild(idCell);

    const videoCell = document.createElement('td');
    videoCell.textContent = d.video_device_id ? videoDeviceNameById(d.video_device_id) : '--';
    row.appendChild(videoCell);

    const channelCell = document.createElement('td');
    channelCell.textContent = d.channel_id || '--';
    row.appendChild(channelCell);

    const enabledCell = document.createElement('td');
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = Boolean(d.enabled);
    enabledInput.addEventListener('change', async () => {
      const result = await window.api.updateDevice({ id: d.id, enabled: enabledInput.checked ? 1 : 0 });
      if (!result?.ok) showToast(`更新失败: ${result?.message || 'unknown error'}`);
    });
    enabledCell.appendChild(enabledInput);
    row.appendChild(enabledCell);

    const statusCell = document.createElement('td');
    const base = deviceStatusText(d.state);
    const clientPortText = d?.client?.port ? ` 客户端:${String(d.client.port)}` : '';
    statusCell.textContent = d.lastError ? `${base}: ${d.lastError}${clientPortText}` : `${base}${clientPortText}`;
    row.appendChild(statusCell);

    const actionCell = document.createElement('td');
    const connectBtn = document.createElement('button');
    connectBtn.className = 'mini-btn';
    connectBtn.textContent = (d.state === 'connected' || d.state === 'waiting_connection') ? '断开' : '连接';
    connectBtn.addEventListener('click', async () => {
      const res =
        (d.state === 'connected' || d.state === 'waiting_connection')
          ? await window.api.disconnectDevice(d.id)
          : await window.api.connectDevice(d.id);
      if (!res?.ok) showToast(`操作失败: ${res?.message || 'unknown error'}`);
    });
    actionCell.appendChild(connectBtn);

    const previewBtn = document.createElement('button');
    previewBtn.className = 'mini-btn';
    previewBtn.textContent = '实时预览';
    previewBtn.disabled = !(d.video_device_id && d.channel_id);
    previewBtn.addEventListener('click', async () => {
      if (!d.video_device_id || !d.channel_id) {
        showToast('请先绑定录像设备和通道');
        return;
      }
      const dev = videoDevices.find((v) => Number(v.id) === Number(d.video_device_id)) || null;
      if (dev && !dev.enabled) {
        showToast('录像设备已禁用');
        return;
      }
      const channels = await loadChannelsForVideoDevice(d.video_device_id);
      const found = (channels || []).find((c) => String(c.id) === String(d.channel_id));
      if (found?.online === false) {
        showToast('通道离线');
        return;
      }
      const flvUrl = found?.flv;
      if (!flvUrl) {
        showToast('未找到该通道的实时流地址，请先加载通道列表或检查后端');
        return;
      }
      await openLivePreview({
        title: `${d.name || '工作台'} - 通道 ${d.channel_id}`,
        flvUrl,
        channelId: d.channel_id,
        videoDeviceId: d.video_device_id
      });
    });
    actionCell.appendChild(previewBtn);

    const editBtn = document.createElement('button');
    editBtn.className = 'mini-btn';
    editBtn.textContent = '编辑';
    editBtn.addEventListener('click', async () => {
      openEditDeviceModal(d);
    });
    actionCell.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'action-btn';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', async () => {
      const ok = window.confirm(`确定删除工作台 ${d.name || d.identifier} 吗？`);
      if (!ok) return;
      const result = await window.api.deleteDevice(d.id);
      if (!result?.ok) showToast(`删除失败: ${result?.message || 'unknown error'}`);
    });
    actionCell.appendChild(delBtn);

    row.appendChild(actionCell);
    devicesBodyEl.appendChild(row);
  });
}

function applyRuntimeInfo(info) {
  if (localIpInfoEl) {
    const ips = Array.isArray(info?.localIps) ? info.localIps.filter(Boolean) : [];
    const port = info?.tcpListenPort ? Number(info.tcpListenPort) : 2006;
    localIpInfoEl.textContent = ips.length ? `本机IP: ${ips.join(' / ')} (TCP监听端口: ${port})` : '本机IP: --';
  }
  renderDevices(info?.devices);
}

addDeviceBtnEl?.addEventListener('click', async () => {
  const type = String(deviceTypeSelectEl?.value || 'tcp').trim();
  const name = String(deviceNameInputEl?.value || '').trim() || null;
  const identifier = String(deviceIdentifierInputEl?.value || '').trim();
  const video_device_id = String(videoDeviceSelectEl?.value || '').trim();
  const channel_id = String(deviceChannelSelectEl?.value || '').trim();
  
  if (!identifier) {
    showToast('标识(IP/COM)不能为空');
    return;
  }
  
  const result = await window.api.addDevice({ name, type, identifier, video_device_id, channel_id, enabled: 1 });
  if (!result?.ok) {
    showToast(`添加失败: ${result?.message || 'unknown error'}`);
    return;
  }
  if (deviceNameInputEl) deviceNameInputEl.value = '';
  if (deviceIdentifierInputEl) deviceIdentifierInputEl.value = '';
  if (videoDeviceSelectEl) videoDeviceSelectEl.value = '';
  if (deviceChannelSelectEl) renderChannelSelect(deviceChannelSelectEl, [], '录像通道(先选录像设备)');
});

connectEnabledBtnEl?.addEventListener('click', async () => {
  const result = await window.api.connectEnabledDevices();
  if (!result?.ok) showToast(`操作失败: ${result?.message || 'unknown error'}`);
});

disconnectAllBtnEl?.addEventListener('click', async () => {
  const result = await window.api.disconnectAllDevices();
  if (!result?.ok) showToast(`操作失败: ${result?.message || 'unknown error'}`);
});

openLogsBtnEl?.addEventListener('click', openLogs);
closeLogsBtnEl?.addEventListener('click', closeLogs);
logModalEl?.addEventListener('click', (e) => {
  if (e.target === logModalEl) closeLogs();
});
clearLogsBtnEl?.addEventListener('click', async () => {
  await window.api.clearLogs?.();
  logText = '';
  if (logTextEl) logTextEl.textContent = '已清空';
});
copyLogsBtnEl?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(logText || '');
  } catch (e) {
    showToast('复制失败');
    return;
  }
  showToast('已复制到剪贴板');
});

window.api.onScannersStatus?.((info) => {
  applyRuntimeInfo(info);
});

window.api.onLogEntry?.((entry) => {
  if (logModalEl && !logModalEl.classList.contains('hidden')) {
    appendLog(entry);
  }
});

window.addEventListener('DOMContentLoaded', async () => {
  videoDevices = (await window.api.listVideoDevices?.()) || [];
  renderVideoDeviceSelect();
  renderEditVideoDeviceSelect();
  renderChannelSelect(deviceChannelSelectEl, [], '录像通道(先选录像设备)');
  renderChannelSelect(editDeviceChannelSelectEl, [], '录像通道(先选录像设备)');
  const info = await window.api.getRuntimeInfo();
  applyRuntimeInfo(info);
});

livePreviewModalEl?.addEventListener('click', (e) => {
  if (e.target === livePreviewModalEl) {
    stopLivePreview().then(() => livePreviewModalEl.classList.add('hidden'));
  }
});
closeLivePreviewBtnEl?.addEventListener('click', () => {
  stopLivePreview().then(() => livePreviewModalEl?.classList.add('hidden'));
});
startLivePreviewBtnEl?.addEventListener('click', () => {
  if (!liveBaseFlvUrl || liveCurrentChannel == null) {
    showToast('暂无可播放的实时流');
    return;
  }
  openLivePreview({ title: livePreviewTitleEl?.textContent || '实时预览', flvUrl: liveBaseFlvUrl, channelId: liveCurrentChannel, videoDeviceId: liveCurrentVideoDeviceId });
});
stopLivePreviewBtnEl?.addEventListener('click', () => {
  stopLivePreview({ preserve: true });
});
toggleMuteBtnEl?.addEventListener('click', () => {
  if (!livePreviewVideoEl) return;
  livePreviewVideoEl.muted = !livePreviewVideoEl.muted;
  updateMuteButton();
});
streamTypeSelectEl?.addEventListener('change', () => {
  if (!liveBaseFlvUrl || liveCurrentChannel == null) return;
  openLivePreview({ title: livePreviewTitleEl?.textContent || '实时预览', flvUrl: liveBaseFlvUrl, channelId: liveCurrentChannel, videoDeviceId: liveCurrentVideoDeviceId });
});
fullscreenBtnEl?.addEventListener('click', () => {
  const el = livePreviewVideoEl;
  if (!el) return;
  const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
  if (typeof fn !== 'function') {
    showToast('当前环境不支持全屏');
    return;
  }
  fn.call(el);
});

videoDeviceSelectEl?.addEventListener('change', () => {
  refreshAddChannelOptions();
});

editVideoDeviceSelectEl?.addEventListener('change', () => {
  refreshEditChannelOptions();
});

editDeviceModalEl?.addEventListener('click', (e) => {
  if (e.target === editDeviceModalEl) closeEditDeviceModal();
});
cancelEditDeviceBtnEl?.addEventListener('click', closeEditDeviceModal);
saveEditDeviceBtnEl?.addEventListener('click', async () => {
  const d = editingDevice;
  if (!d) return;
  const id = d.id;
  const type = String(editDeviceTypeSelectEl?.value || 'tcp').trim();
  const name = String(editDeviceNameInputEl?.value || '').trim() || null;
  const identifier = String(editDeviceIdentifierInputEl?.value || '').trim();
  const video_device_id = String(editVideoDeviceSelectEl?.value || '').trim();
  const channel_id = String(editDeviceChannelSelectEl?.value || '').trim();

  if (!identifier) {
    showToast('标识(IP/COM)不能为空');
    return;
  }

  const result = await window.api.updateDevice({
    id,
    name,
    type,
    identifier,
    video_device_id,
    channel_id
  });
  if (!result?.ok) {
    showToast(`更新失败: ${result?.message || 'unknown error'}`);
    return;
  }
  closeEditDeviceModal();
});
