const latestBarcodeEl = document.getElementById('latestBarcode');
const latestTimeEl = document.getElementById('latestTime');
const recordsBodyEl = document.getElementById('recordsBody');
const searchInputEl = document.getElementById('searchInput');
const dateFromInputEl = document.getElementById('dateFromInput');
const dateToInputEl = document.getElementById('dateToInput');
const statusSelectEl = document.getElementById('statusSelect');
const searchBtnEl = document.getElementById('searchBtn');
const resetBtnEl = document.getElementById('resetBtn');
const exportBtnEl = document.getElementById('exportBtn');
const retryVideoBatchBtnEl = document.getElementById('retryVideoBatchBtn');
const simulateBtnEl = document.getElementById('simulateBtn');
const flashEl = document.getElementById('flash');
const latestCardEl = document.querySelector('.latest-card');
const deviceFilterSelectEl = document.getElementById('deviceFilterSelect');
const videoStatusSelectEl = document.getElementById('videoStatusSelect');
const modalEl = document.getElementById('modal');
const modalBodyEl = document.getElementById('modalBody');
const cancelDeleteBtnEl = document.getElementById('cancelDeleteBtn');
const confirmDeleteBtnEl = document.getElementById('confirmDeleteBtn');
const prevPageBtnEl = document.getElementById('prevPageBtn');
const nextPageBtnEl = document.getElementById('nextPageBtn');
const pageInfoEl = document.getElementById('pageInfo');
const pageSizeSelectEl = document.getElementById('pageSizeSelect');
const toastEl = document.getElementById('toast');
const alertBarEl = document.getElementById('alertBar');
const alertTextEl = document.getElementById('alertText');
const appStartedAt = Date.now();

// 常驻告警条：仅断链 / 连接异常 / 未知设备才红条告警；
// 「长时间无数据」属于在线空闲提示，不在首页告警（状态详情看工作台管理页）
function updateAlertBar(info) {
  if (!alertBarEl || !alertTextEl) return;
  const devices = Array.isArray(info?.devices) ? info.devices : [];
  const problems = [];
  for (const d of devices) {
    if (!d.enabled) continue;
    if (d.state === 'error') {
      problems.push(`${d.name} 连接异常${d.lastError ? `(${d.lastError})` : ''}`);
    } else if (d.state === 'disconnected' || d.state === 'waiting_connection') {
      // 启动后 30 秒内不报，避免开机瞬间的误报
      if (Date.now() - appStartedAt > 30000) problems.push(`${d.name} 未连接`);
    }
  }
  const unknown = Array.isArray(info?.unknownClients) ? info.unknownClients : [];
  if (unknown.length) {
    problems.push(`未知设备尝试连接: ${unknown.map((u) => u.ip).join('、')}`);
  }
  if (problems.length) {
    alertTextEl.textContent = problems.join('；');
    alertBarEl.classList.remove('hidden');
  } else {
    alertBarEl.classList.add('hidden');
  }
}

window.api.onScannersStatus?.((info) => {
  updateAlertBar(info);
});

let currentRecords = [];
let audioCtx;
let pendingDeleteId = null;
let currentPage = 1;
let pageSize = 10;
let totalRecords = 0;
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

function formatTime(raw) {
  return raw || '--';
}

function setLatest(record) {
  if (!record) return;
  latestBarcodeEl.textContent = record.barcode || '暂无';
  latestTimeEl.textContent = formatTime(record.scanned_at);
}

// ============ 多选操作 ============
const selectAllCheckboxEl = document.getElementById('selectAllCheckbox');
const batchDeleteBtnEl = document.getElementById('batchDeleteBtn');
const batchRetryVideoBtnEl = document.getElementById('batchRetryVideoBtn');
const selectedCountHintEl = document.getElementById('selectedCountHint');
const selectedIds = new Set();

function updateBatchButtons() {
  const n = selectedIds.size;
  if (batchDeleteBtnEl) batchDeleteBtnEl.disabled = n === 0;
  if (batchRetryVideoBtnEl) batchRetryVideoBtnEl.disabled = n === 0;
  if (selectedCountHintEl) selectedCountHintEl.textContent = n > 0 ? `已选 ${n} 条` : '';
}

function clearSelection() {
  selectedIds.clear();
  if (selectAllCheckboxEl) selectAllCheckboxEl.checked = false;
  updateBatchButtons();
}

function renderRecords(records) {
  recordsBodyEl.innerHTML = '';
  clearSelection();
  if (!records.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.textContent = '暂无记录';
    cell.style.color = '#888';
    row.appendChild(cell);
    recordsBodyEl.appendChild(row);
    return;
  }

  const frag = document.createDocumentFragment();
  records.forEach((record, index) => {
    const row = document.createElement('tr');

    const selectCell = document.createElement('td');
    selectCell.className = 'select-col';
    if (!record.deleted) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selectedIds.has(record.id);
      cb.addEventListener('change', () => {
        if (cb.checked) selectedIds.add(record.id);
        else selectedIds.delete(record.id);
        updateBatchButtons();
      });
      selectCell.appendChild(cb);
    }
    row.appendChild(selectCell);

    const idCell = document.createElement('td');
    idCell.className = 'id-col';
    idCell.textContent = String(record.id);
    row.appendChild(idCell);

    const barcodeCell = document.createElement('td');
    barcodeCell.textContent = record.barcode;
    row.appendChild(barcodeCell);

    const deviceCell = document.createElement('td');
    const deviceName = record.device_name ? String(record.device_name) : '';
    const deviceType = record.device_type ? String(record.device_type).toUpperCase() : 'TCP';
    const deviceIdentifier = record.device_identifier ? String(record.device_identifier) : '';
    deviceCell.textContent = deviceName || (deviceIdentifier ? `${deviceType}:${deviceIdentifier}` : '--');
    row.appendChild(deviceCell);

    const timeCell = document.createElement('td');
    timeCell.textContent = formatTime(record.scanned_at);
    row.appendChild(timeCell);

    const videoCell = document.createElement('td');
    if (record.video_path) {
      const openBtn = document.createElement('button');
      openBtn.className = 'mini-btn';
      openBtn.textContent = '打开视频';
      openBtn.addEventListener('click', async () => {
        const res = await window.api.openVideo(record.id);
        if (!res?.ok && res?.message !== 'no video') {
          showToast(`打开视频失败: ${res?.message || 'unknown error'}`);
        }
      });
      videoCell.appendChild(openBtn);

      const downloadBtn = document.createElement('button');
      downloadBtn.className = 'mini-btn';
      downloadBtn.style.marginLeft = '8px';
      downloadBtn.textContent = '下载';
      downloadBtn.addEventListener('click', async () => {
        const res = await window.api.downloadVideo?.(record.id);
        if (res?.ok) {
          showToast(`已保存到: ${res.filePath}`);
          return;
        }
        if (res?.message && res.message !== 'no video') {
          showToast(`下载失败: ${res.message}`);
        }
      });
      videoCell.appendChild(downloadBtn);
    } else if (record.video_status) {
      const s = String(record.video_status);
      const msg = record.video_message ? ` (${String(record.video_message)})` : '';
      const lower = s.toLowerCase();
      const failed = s === '失败' || ['fail', 'failed', 'error'].includes(lower);
      const waiting = s === '等待' || s === '下载中' || ['waiting', 'pending', 'processing', 'running', 'queue', 'queued', 'downloading'].includes(lower);
      const statusSpan = document.createElement('span');
      statusSpan.textContent = `${s}${msg}`;
      videoCell.appendChild(statusSpan);
      if ((failed || waiting) && !record.deleted) {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'mini-btn';
        retryBtn.style.marginLeft = '8px';
        retryBtn.textContent = waiting ? '重新下载' : '重试下载';
        retryBtn.addEventListener('click', async () => {
          const res = await window.api.retryVideoDownload?.(record.id);
          if (res?.ok) {
            showToast('已提交重试任务');
            await loadRecords();
            return;
          }
          showToast(`重试失败: ${res?.message || 'unknown error'}`);
        });
        videoCell.appendChild(retryBtn);
      }
    } else {
      videoCell.textContent = '--';
    }
    row.appendChild(videoCell);

    const actionCell = document.createElement('td');
    if (!record.deleted) {
      const delBtn = document.createElement('button');
      delBtn.className = 'action-btn';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', () => openDeleteModal(record));
      actionCell.appendChild(delBtn);
    } else {
      actionCell.textContent = '-';
    }
    row.appendChild(actionCell);

    frag.appendChild(row);
  });
  recordsBodyEl.appendChild(frag);
}

// 当前筛选条件摘要：避免客户带着筛选条件却以为"没有记录"
function renderFilterSummary() {
  const parts = [];
  const keyword = searchInputEl.value.trim();
  if (keyword) parts.push(`单号含"${keyword}"`);
  if (dateFromInputEl.value || dateToInputEl.value) parts.push(`日期 ${dateFromInputEl.value || '…'} ~ ${dateToInputEl.value || '…'}`);
  if (deviceFilterSelectEl && deviceFilterSelectEl.value) {
    const opt = deviceFilterSelectEl.selectedOptions && deviceFilterSelectEl.selectedOptions[0];
    parts.push(`工作台 ${opt ? opt.textContent : deviceFilterSelectEl.value}`);
  }
  if (statusSelectEl.value === 'deleted') parts.push('仅已删除');
  if (videoStatusSelectEl && videoStatusSelectEl.value) {
    const opt = videoStatusSelectEl.selectedOptions && videoStatusSelectEl.selectedOptions[0];
    parts.push(opt ? opt.textContent : videoStatusSelectEl.value);
  }
  return parts.length ? `（筛选: ${parts.join('，')}）` : '';
}

function renderPagination() {
  // pageSize='all' 时不分页，一页展示全部
  const totalPages = pageSize === 'all' ? 1 : Math.max(1, Math.ceil(totalRecords / pageSize));
  if (currentPage > totalPages) currentPage = totalPages;
  pageInfoEl.textContent = pageSize === 'all'
    ? `共 ${totalRecords} 条（全部）${renderFilterSummary()}`
    : `共 ${totalRecords} 条 · 第 ${currentPage} 页 / 共 ${totalPages} 页${renderFilterSummary()}`;
  prevPageBtnEl.disabled = currentPage <= 1 || pageSize === 'all';
  nextPageBtnEl.disabled = currentPage >= totalPages || pageSize === 'all';
}

let loadSeq = 0;
let reloadTimer = null;

async function loadRecords() {
  const seq = ++loadSeq;
  const keyword = searchInputEl.value.trim();
  const dateFrom = dateFromInputEl.value || null;
  const dateTo = dateToInputEl.value || null;
  const deviceId = deviceFilterSelectEl ? deviceFilterSelectEl.value : '';
  const onlyDeleted = statusSelectEl.value === 'deleted';
  const videoStatus = videoStatusSelectEl ? videoStatusSelectEl.value : '';
  const result = await window.api.queryRecords({
    keyword: keyword || null,
    dateFrom,
    dateTo,
    deviceId: deviceId || null,
    page: currentPage,
    pageSize,
    onlyDeleted,
    videoStatus
  });
  if (seq !== loadSeq) return; // 已有更新的查询在途，丢弃过期响应
  currentRecords = result.records || [];
  totalRecords = result.total || 0;
  renderRecords(currentRecords);
  renderPagination();
}

// 合并短时间内的多次刷新请求，避免扫码高峰期的并发查询风暴
function scheduleReload() {
  if (reloadTimer) return;
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    loadRecords();
  }, 300);
}

function renderDeviceFilter(devices) {
  if (!deviceFilterSelectEl) return;
  const currentValue = deviceFilterSelectEl.value;
  deviceFilterSelectEl.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = '全部工作台';
  deviceFilterSelectEl.appendChild(allOpt);

  (devices || []).forEach((d) => {
    const opt = document.createElement('option');
    opt.value = String(d.id);
    opt.textContent = d.name || `${(d.type || 'TCP').toUpperCase()}:${d.identifier}`;
    deviceFilterSelectEl.appendChild(opt);
  });

  const hasValue = Array.from(deviceFilterSelectEl.options).some((o) => o.value === currentValue);
  deviceFilterSelectEl.value = hasValue ? currentValue : '';
}

async function loadDevicesForFilter() {
  if (!deviceFilterSelectEl) return;
  const devices = await window.api.listDevices();
  renderDeviceFilter(devices);
}

function flash() {
  flashEl.classList.add('active');
  latestCardEl.classList.add('scan');
  setTimeout(() => {
    flashEl.classList.remove('active');
    latestCardEl.classList.remove('scan');
  }, 220);
}

function beep() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = 880;
    gain.gain.value = 0.04;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.12);
  } catch (err) {
    // Audio feedback is optional, ignore errors silently.
  }
}

function openDeleteModal(record) {
  pendingDeleteId = record.id;
  modalBodyEl.textContent = `确定要删除单号 ${record.barcode} 的记录吗？`;
  modalEl.classList.remove('hidden');
}

function closeDeleteModal() {
  pendingDeleteId = null;
  modalEl.classList.add('hidden');
}

searchBtnEl.addEventListener('click', loadRecords);
resetBtnEl.addEventListener('click', () => {
  searchInputEl.value = '';
  dateFromInputEl.value = '';
  dateToInputEl.value = '';
  statusSelectEl.value = 'active';
  if (videoStatusSelectEl) videoStatusSelectEl.value = '';
  currentPage = 1;
  loadRecords();
});
selectAllCheckboxEl?.addEventListener('change', () => {
  const checked = !!selectAllCheckboxEl.checked;
  currentRecords.forEach((r) => {
    if (r.deleted) return;
    if (checked) selectedIds.add(r.id);
    else selectedIds.delete(r.id);
  });
  document.querySelectorAll('#recordsBody input[type="checkbox"]').forEach((cb) => { cb.checked = checked; });
  updateBatchButtons();
});

batchDeleteBtnEl?.addEventListener('click', async () => {
  const ids = Array.from(selectedIds);
  if (!ids.length) return;
  if (!confirm(`确定删除选中的 ${ids.length} 条记录吗？\n（删除为软删除，可在"已删除记录"筛选中查看）`)) return;
  let okCount = 0;
  for (const id of ids) {
    const res = await window.api.deleteRecord(id);
    if (res?.ok) okCount += 1;
  }
  showToast(`已删除 ${okCount}/${ids.length} 条`);
  clearSelection();
  await loadRecords();
});

batchRetryVideoBtnEl?.addEventListener('click', async () => {
  const ids = Array.from(selectedIds);
  if (!ids.length) return;
  if (!confirm(`对选中的 ${ids.length} 条记录重新提交录像下载？（已成功的会自动跳过，每条间隔 8 秒）`)) return;
  const result = await window.api.retryVideoIds?.(ids);
  if (result?.ok) {
    showToast(result.submitted > 0 ? `已提交 ${result.submitted} 条补下载，结果稍后刷新可见` : '选中的记录都不需要补下载（已成功或已下载）');
    clearSelection();
    scheduleReload();
  } else {
    showToast('批量补下载失败，请查看日志');
  }
});

retryVideoBatchBtnEl?.addEventListener('click', async () => {
  if (!confirm('将对当前筛选条件下“没有视频且未成功”的记录重新提交录像下载（最多 50 条，每条间隔 8 秒，防止监控设备登录锁定）。\n\n提示：可先在“视频状态”里筛选“视频失败”或“无视频状态”后再执行。\n\n确定继续吗？')) {
    return;
  }
  const result = await window.api.retryVideoBatch({
    keyword: searchInputEl.value.trim() || null,
    dateFrom: dateFromInputEl.value || null,
    dateTo: dateToInputEl.value || null,
    deviceId: deviceFilterSelectEl ? deviceFilterSelectEl.value : '',
    videoStatus: videoStatusSelectEl ? videoStatusSelectEl.value : ''
  });
  if (result?.ok) {
    showToast(result.submitted > 0 ? `已提交 ${result.submitted} 条补下载，结果稍后刷新可见` : '当前筛选条件下没有需要补下载的记录');
    scheduleReload();
  } else {
    showToast('补下载失败，请查看日志');
  }
});

exportBtnEl.addEventListener('click', async () => {
  if (!totalRecords) {
    showToast('当前筛选条件下没有可导出的记录');
    return;
  }
  const result = await window.api.exportCSV({
    keyword: searchInputEl.value.trim() || null,
    dateFrom: dateFromInputEl.value || null,
    dateTo: dateToInputEl.value || null,
    deviceId: deviceFilterSelectEl ? deviceFilterSelectEl.value : '',
    onlyDeleted: statusSelectEl.value === 'deleted',
    videoStatus: videoStatusSelectEl ? videoStatusSelectEl.value : ''
  });
  if (result?.ok) {
    showToast(`已导出 ${result.count ?? ''} 条到: ${result.filePath}`);
  }
});

simulateBtnEl.addEventListener('click', async () => {
  const result = await window.api.simulateScan('123456');
  if (!result?.ok) {
    showToast('模拟扫码失败');
  }
});

cancelDeleteBtnEl.addEventListener('click', closeDeleteModal);
modalEl.addEventListener('click', (event) => {
  if (event.target === modalEl) closeDeleteModal();
});
confirmDeleteBtnEl.addEventListener('click', async () => {
  if (!pendingDeleteId) return;
  const result = await window.api.deleteRecord(pendingDeleteId);
  if (!result?.ok) {
    showToast('删除失败');
  }
  closeDeleteModal();
  loadRecords();
});


searchInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') loadRecords();
});
dateFromInputEl.addEventListener('change', loadRecords);
dateToInputEl.addEventListener('change', loadRecords);
statusSelectEl.addEventListener('change', () => {
  currentPage = 1;
  loadRecords();
});
videoStatusSelectEl?.addEventListener('change', () => {
  currentPage = 1;
  loadRecords();
});
pageSizeSelectEl.addEventListener('change', () => {
  pageSize = pageSizeSelectEl.value === 'all' ? 'all' : Number(pageSizeSelectEl.value);
  currentPage = 1;
  loadRecords();
});
prevPageBtnEl.addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage -= 1;
    loadRecords();
  }
});
nextPageBtnEl.addEventListener('click', () => {
  currentPage += 1;
  loadRecords();
});

deviceFilterSelectEl?.addEventListener('change', () => {
  currentPage = 1;
  loadRecords();
});

window.api.onBarcode((record) => {
  // Real-time feedback for each scan.
  setLatest(record);
  flash();
  beep();
  currentPage = 1;
  scheduleReload();
});

window.api.onRecordVideoUpdated?.(() => {
  scheduleReload();
});

window.addEventListener('DOMContentLoaded', async () => {
  pageSize = pageSizeSelectEl.value === 'all' ? 'all' : Number(pageSizeSelectEl.value);
  await loadDevicesForFilter();
  await loadRecords();
  if (currentRecords.length) setLatest(currentRecords[0]);
});
