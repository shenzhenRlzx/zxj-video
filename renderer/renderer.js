const latestBarcodeEl = document.getElementById('latestBarcode');
const latestTimeEl = document.getElementById('latestTime');
const recordsBodyEl = document.getElementById('recordsBody');
const searchInputEl = document.getElementById('searchInput');
const dateInputEl = document.getElementById('dateInput');
const statusSelectEl = document.getElementById('statusSelect');
const searchBtnEl = document.getElementById('searchBtn');
const resetBtnEl = document.getElementById('resetBtn');
const exportBtnEl = document.getElementById('exportBtn');
const simulateBtnEl = document.getElementById('simulateBtn');
const flashEl = document.getElementById('flash');
const latestCardEl = document.querySelector('.latest-card');
const deviceFilterSelectEl = document.getElementById('deviceFilterSelect');
const modalEl = document.getElementById('modal');
const modalBodyEl = document.getElementById('modalBody');
const cancelDeleteBtnEl = document.getElementById('cancelDeleteBtn');
const confirmDeleteBtnEl = document.getElementById('confirmDeleteBtn');
const prevPageBtnEl = document.getElementById('prevPageBtn');
const nextPageBtnEl = document.getElementById('nextPageBtn');
const pageInfoEl = document.getElementById('pageInfo');
const pageSizeSelectEl = document.getElementById('pageSizeSelect');

let currentRecords = [];
let audioCtx;
let pendingDeleteId = null;
let currentPage = 1;
let pageSize = 10;
let totalRecords = 0;

function formatTime(raw) {
  return raw || '--';
}

function setLatest(record) {
  if (!record) return;
  latestBarcodeEl.textContent = record.barcode || '暂无';
  latestTimeEl.textContent = formatTime(record.scanned_at);
}

function renderRecords(records) {
  recordsBodyEl.innerHTML = '';
  if (!records.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.textContent = '暂无记录';
    cell.style.color = '#888';
    row.appendChild(cell);
    recordsBodyEl.appendChild(row);
    return;
  }

  records.forEach((record, index) => {
    const row = document.createElement('tr');

    const idCell = document.createElement('td');
    idCell.className = 'hidden-col';
    idCell.textContent = String(index + 1);
    row.appendChild(idCell);

    const barcodeCell = document.createElement('td');
    barcodeCell.textContent = record.barcode;
    row.appendChild(barcodeCell);

    const deviceCell = document.createElement('td');
    deviceCell.textContent = record.device_name || record.device_host || '--';
    row.appendChild(deviceCell);

    const timeCell = document.createElement('td');
    timeCell.textContent = formatTime(record.scanned_at);
    row.appendChild(timeCell);

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

    recordsBodyEl.appendChild(row);
  });
}

function renderPagination() {
  const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
  if (currentPage > totalPages) currentPage = totalPages;
  pageInfoEl.textContent = `第 ${currentPage} 页 / 共 ${totalPages} 页`;
  prevPageBtnEl.disabled = currentPage <= 1;
  nextPageBtnEl.disabled = currentPage >= totalPages;
}

async function loadRecords() {
  const keyword = searchInputEl.value.trim();
  const date = dateInputEl.value || null;
  const deviceId = deviceFilterSelectEl ? deviceFilterSelectEl.value : '';
  const onlyDeleted = statusSelectEl.value === 'deleted';
  const result = await window.api.queryRecords({
    keyword: keyword || null,
    date,
    deviceId: deviceId || null,
    page: currentPage,
    pageSize,
    onlyDeleted
  });
  currentRecords = result.records || [];
  totalRecords = result.total || 0;
  renderRecords(currentRecords);
  renderPagination();
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
    opt.textContent = d.name || `${d.host}:${d.port}`;
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
  dateInputEl.value = '';
  statusSelectEl.value = 'active';
  currentPage = 1;
  loadRecords();
});
exportBtnEl.addEventListener('click', async () => {
  if (!currentRecords.length) {
    alert('没有可导出的记录');
    return;
  }
  const result = await window.api.exportCSV(currentRecords);
  if (result?.ok) {
    alert(`已导出到: ${result.filePath}`);
  }
});

simulateBtnEl.addEventListener('click', async () => {
  const result = await window.api.simulateScan('123456');
  if (!result?.ok) {
    alert('模拟扫码失败');
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
    alert('删除失败');
  }
  closeDeleteModal();
  loadRecords();
});

searchInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') loadRecords();
});
dateInputEl.addEventListener('change', loadRecords);
statusSelectEl.addEventListener('change', () => {
  currentPage = 1;
  loadRecords();
});
pageSizeSelectEl.addEventListener('change', () => {
  pageSize = Number(pageSizeSelectEl.value);
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
  loadRecords();
});

window.addEventListener('DOMContentLoaded', async () => {
  pageSize = Number(pageSizeSelectEl.value);
  await loadDevicesForFilter();
  await loadRecords();
  if (currentRecords.length) setLatest(currentRecords[0]);
});
