const videoDevicesBodyEl = document.getElementById('videoDevicesBody');
const videoNameInputEl = document.getElementById('videoNameInput');
const videoIpInputEl = document.getElementById('videoIpInput');
const videoHttpPortInputEl = document.getElementById('videoHttpPortInput');
const videoPortInputEl = document.getElementById('videoPortInput');
const videoUserInputEl = document.getElementById('videoUserInput');
const videoPassInputEl = document.getElementById('videoPassInput');
const videoRtspPortInputEl = document.getElementById('videoRtspPortInput');
const newBtnEl = document.getElementById('newBtn');
const deleteBtnEl = document.getElementById('deleteBtn');
const saveBtnEl = document.getElementById('saveBtn');
const loadChannelsBtnEl = document.getElementById('loadChannelsBtn');
const channelListEl = document.getElementById('channelList');

let videoDevices = [];
let currentId = null;
let liveFlvPlayer = null;
let liveCurrentChannel = null;
let liveCurrentOrigin = null;

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

let liveBaseFlvUrl = null;
let liveRetryCount = 0;
let liveReconnectTimer = null;
let liveMetricsTimer = null;
let liveErrorHandler = null;
let liveWatchdogTimer = null;
let liveOpening = false;
let liveVideoHandlers = null;
let liveCurrentVideoDeviceId = null;

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

function applyForm(device) {
  const d = device || {};
  if (videoNameInputEl) videoNameInputEl.value = String(d.name || '');
  if (videoIpInputEl) videoIpInputEl.value = String(d.base_url || '');
  if (videoUserInputEl) videoUserInputEl.value = String(d.username || '');
  if (videoPassInputEl) videoPassInputEl.value = String(d.password || '');
  let extraObj = {};
  try {
    extraObj = d.extra_json ? JSON.parse(String(d.extra_json)) : {};
  } catch (e) {
    extraObj = {};
  }
  const httpPort = extraObj && Object.prototype.hasOwnProperty.call(extraObj, 'httpPort') ? extraObj.httpPort : '';
  if (videoHttpPortInputEl) {
    if (httpPort === '' || httpPort == null) {
      videoHttpPortInputEl.value = '';
    } else {
      videoHttpPortInputEl.value = String(httpPort);
    }
  }
  const sdkPort = extraObj && Object.prototype.hasOwnProperty.call(extraObj, 'sdkPort') ? extraObj.sdkPort : '';
  if (videoPortInputEl) {
    if (sdkPort === '' || sdkPort == null) {
      videoPortInputEl.value = '';
    } else {
      videoPortInputEl.value = String(sdkPort);
    }
  }
  const rtspPort = extraObj && Object.prototype.hasOwnProperty.call(extraObj, 'rtspPort') ? extraObj.rtspPort : '';
  if (videoRtspPortInputEl) {
    if (rtspPort === '' || rtspPort == null) {
      videoRtspPortInputEl.value = '';
    } else {
      videoRtspPortInputEl.value = String(rtspPort);
    }
  }
}

async function loadVideoDevices() {
  videoDevices = (await window.api.listVideoDevices()) || [];
  renderVideoDevices();
}

function renderVideoDevices() {
  if (!videoDevicesBodyEl) return;
  videoDevicesBodyEl.innerHTML = '';
  if (!videoDevices.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.textContent = '暂无录像设备，请先新增';
    cell.style.color = '#888';
    row.appendChild(cell);
    videoDevicesBodyEl.appendChild(row);
    applyForm(null);
    currentId = null;
    return;
  }

  videoDevices.forEach((d) => {
    const row = document.createElement('tr');
    if (Number.isFinite(currentId) && Number(d.id) === Number(currentId)) {
      row.classList.add('row-selected');
    }
    row.addEventListener('click', () => {
      currentId = Number(d.id);
      applyForm(d);
      renderVideoDevices();
    });

    const nameCell = document.createElement('td');
    nameCell.textContent = d.name || '--';
    row.appendChild(nameCell);

    const urlCell = document.createElement('td');
    let addressText = d.base_url || '--';
    if (d.extra_json) {
      try {
        const extra = JSON.parse(String(d.extra_json));
        if (extra && Object.prototype.hasOwnProperty.call(extra, 'httpPort') && extra.httpPort) {
          addressText = `${d.base_url}:${extra.httpPort}`;
        }
      } catch (e) {}
    }
    urlCell.textContent = addressText;
    row.appendChild(urlCell);

    const userCell = document.createElement('td');
    userCell.textContent = d.username || '--';
    row.appendChild(userCell);

    const enabledCell = document.createElement('td');
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = Boolean(d.enabled);
    enabledInput.addEventListener('click', (e) => e.stopPropagation());
    enabledInput.addEventListener('change', async () => {
      const res = await window.api.updateVideoDevice({
        id: d.id,
        enabled: enabledInput.checked ? 1 : 0
      });
      if (!res?.ok) showToast(`更新失败: ${res?.message || 'unknown error'}`);
    });
    enabledCell.appendChild(enabledInput);
    row.appendChild(enabledCell);

    const actionCell = document.createElement('td');
    const editBtn = document.createElement('button');
    editBtn.className = 'mini-btn';
    editBtn.textContent = '选择';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      currentId = Number(d.id);
      applyForm(d);
      renderVideoDevices();
    });
    actionCell.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'action-btn';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = window.confirm(`确定删除录像设备 ${d.name} 吗？`);
      if (!ok) return;
      const res = await window.api.deleteVideoDevice(d.id);
      if (!res?.ok) {
        showToast(`删除失败: ${res?.message || 'unknown error'}`);
        return;
      }
      if (currentId === Number(d.id)) {
        currentId = null;
        applyForm(null);
      }
      await loadVideoDevices();
    });
    actionCell.appendChild(delBtn);

    row.appendChild(actionCell);
    videoDevicesBodyEl.appendChild(row);
  });
}

newBtnEl?.addEventListener('click', () => {
  currentId = null;
  applyForm(null);
});

deleteBtnEl?.addEventListener('click', async () => {
  if (!Number.isFinite(currentId)) {
    showToast('请先在上方表格中选择要删除的录像设备');
    return;
  }
  const target = videoDevices.find((v) => Number(v.id) === currentId);
  const name = target?.name || `ID:${currentId}`;
  const ok = window.confirm(`确定删除录像设备 ${name} 吗？`);
  if (!ok) return;
  const res = await window.api.deleteVideoDevice(currentId);
  if (!res?.ok) {
    showToast(`删除失败: ${res?.message || 'unknown error'}`);
    return;
  }
  currentId = null;
  await loadVideoDevices();
});

saveBtnEl?.addEventListener('click', async () => {
  const name = String(videoNameInputEl?.value || '').trim();
  if (!name) {
    showToast('录像设备名称必填');
    return;
  }
  const ip = String(videoIpInputEl?.value || '').trim();
  if (!ip) {
    showToast('设备IP地址必填');
    return;
  }
  const username = String(videoUserInputEl?.value || '').trim();
  if (!username) {
    showToast('登录账号必填');
    return;
  }
  const password = String(videoPassInputEl?.value || '');
  if (!String(password).trim()) {
    showToast('登录密码必填');
    return;
  }
  const httpPortRaw = String(videoHttpPortInputEl?.value || '').trim();
  const httpPortNum = Number(httpPortRaw);
  const sdkPortRaw = String(videoPortInputEl?.value || '').trim();
  const sdkPortNum = Number(sdkPortRaw);
  const rtspPortRaw = String(videoRtspPortInputEl?.value || '').trim();
  const rtspPortNum = Number(rtspPortRaw);
  if (!httpPortRaw || !Number.isFinite(httpPortNum) || httpPortNum <= 0 || httpPortNum > 65535) {
    showToast('HTTP端口必填(1-65535)');
    return;
  }
  if (!sdkPortRaw || !Number.isFinite(sdkPortNum) || sdkPortNum <= 0 || sdkPortNum > 65535) {
    showToast('SDK端口必填(1-65535)');
    return;
  }
  if (!rtspPortRaw || !Number.isFinite(rtspPortNum) || rtspPortNum <= 0 || rtspPortNum > 65535) {
    showToast('RTSP端口必填(1-65535)');
    return;
  }
  const current = Number.isFinite(currentId) ? (videoDevices.find((v) => Number(v.id) === Number(currentId)) || null) : null;
  const enabled = current ? (current.enabled ? 1 : 0) : 1;
  const payload = {
    name,
    base_url: ip,
    username,
    password,
    extra: { httpPort: httpPortNum, sdkPort: sdkPortNum, rtspPort: rtspPortNum },
    enabled
  };

  let res;
  if (Number.isFinite(currentId)) {
    res = await window.api.updateVideoDevice({ id: currentId, ...payload });
  } else {
    res = await window.api.addVideoDevice(payload);
  }
  if (!res?.ok) {
    showToast(`保存失败: ${res?.message || 'unknown error'}`);
    return;
  }
  showToast('保存成功');
  await loadVideoDevices();
  if (res?.device?.id) {
    currentId = Number(res.device.id);
    const latest = videoDevices.find((v) => Number(v.id) === currentId) || null;
    applyForm(latest);
  }
});

loadChannelsBtnEl?.addEventListener('click', async () => {
  if (!Number.isFinite(currentId)) {
    if (channelListEl) channelListEl.textContent = '请先在上方表格中选择一个录像设备';
    return;
  }
  const current = videoDevices.find((v) => Number(v.id) === Number(currentId)) || null;
  if (current && !current.enabled) {
    if (channelListEl) channelListEl.textContent = '录像设备已禁用';
    showToast('录像设备已禁用');
    return;
  }
  if (!String(videoIpInputEl?.value || '').trim()) {
    showToast('设备IP地址必填');
    return;
  }
  if (!String(videoUserInputEl?.value || '').trim()) {
    showToast('登录账号必填');
    return;
  }
  if (!String(videoPassInputEl?.value || '').trim()) {
    showToast('登录密码必填');
    return;
  }
  const httpPortRaw = String(videoHttpPortInputEl?.value || '').trim();
  const httpPortNum = Number(httpPortRaw);
  if (!httpPortRaw || !Number.isFinite(httpPortNum) || httpPortNum <= 0 || httpPortNum > 65535) {
    showToast('HTTP端口必填(1-65535)');
    return;
  }
  const sdkPortRaw = String(videoPortInputEl?.value || '').trim();
  const sdkPortNum = Number(sdkPortRaw);
  if (!sdkPortRaw || !Number.isFinite(sdkPortNum) || sdkPortNum <= 0 || sdkPortNum > 65535) {
    showToast('SDK端口必填(1-65535)');
    return;
  }
  const rtspPortRaw = String(videoRtspPortInputEl?.value || '').trim();
  const rtspPortNum = Number(rtspPortRaw);
  if (!rtspPortRaw || !Number.isFinite(rtspPortNum) || rtspPortNum <= 0 || rtspPortNum > 65535) {
    showToast('RTSP端口必填(1-65535)');
    return;
  }
  if (channelListEl) channelListEl.textContent = '正在加载通道列表...';
  const res = await window.api.listVideoChannels(currentId);
  if (!res?.ok) {
    if (channelListEl) channelListEl.textContent = `加载失败: ${res?.message || 'unknown error'}`;
    return;
  }
  const list = Array.isArray(res.channels) ? res.channels : [];
  if (!list.length) {
    if (channelListEl) channelListEl.textContent = '未返回任何通道，请检查设备配置或权限';
    return;
  }
  if (channelListEl) {
    channelListEl.innerHTML = '';
    list.forEach((ch) => {
      const name = ch.name ? ` (${ch.name})` : '';
      const flv = ch.flv || '';
      const statusText = ch?.online === true ? '在线' : ch?.online === false ? '离线' : '未知';

      const itemDiv = document.createElement('div');
      itemDiv.className = 'channel-item';

      const infoDiv = document.createElement('div');
      infoDiv.className = 'channel-info';
      infoDiv.innerHTML = `
        <strong>通道ID: ${ch.id}${name}</strong>
        <span style="font-size: 12px; color: #888;">状态: ${statusText}</span>
      `;

      const btn = document.createElement('button');
      btn.className = 'mini-btn';
      btn.textContent = '实时预览';
      if (ch?.online === false) btn.disabled = true;
      btn.addEventListener('click', async () => {
        if (ch?.online === false) {
          showToast('通道离线');
          return;
        }
        if (!flv) {
          showToast('该通道未返回 HTTP-FLV 地址');
          return;
        }
        await openLivePreview({
          title: `通道 ${ch.id}${name}`,
          flvUrl: flv,
          channelId: ch.id,
          videoDeviceId: currentId
        });
      });

      itemDiv.appendChild(infoDiv);
      itemDiv.appendChild(btn);
      channelListEl.appendChild(itemDiv);
    });
  }
});

window.addEventListener('DOMContentLoaded', async () => {
  await loadVideoDevices();
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
