const localIpInfoEl = document.getElementById('localIpInfo');
const devicesBodyEl = document.getElementById('devicesBody');
const deviceNameInputEl = document.getElementById('deviceNameInput');
const deviceHostInputEl = document.getElementById('deviceHostInput');
const devicePortInputEl = document.getElementById('devicePortInput');
const addDeviceBtnEl = document.getElementById('addDeviceBtn');
const connectEnabledBtnEl = document.getElementById('connectEnabledBtn');
const disconnectAllBtnEl = document.getElementById('disconnectAllBtn');

function deviceStatusText(state) {
  if (state === 'connected') return '已连接';
  if (state === 'connecting') return '连接中';
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
    cell.colSpan = 6;
    cell.textContent = '暂无工作台，请先添加';
    cell.style.color = '#888';
    row.appendChild(cell);
    devicesBodyEl.appendChild(row);
    return;
  }

  list.forEach((d) => {
    const row = document.createElement('tr');

    const nameCell = document.createElement('td');
    nameCell.textContent = d.name || `${d.host}:${d.port}`;
    row.appendChild(nameCell);

    const hostCell = document.createElement('td');
    hostCell.textContent = d.host || '--';
    row.appendChild(hostCell);

    const portCell = document.createElement('td');
    portCell.textContent = String(d.port ?? '--');
    row.appendChild(portCell);

    const enabledCell = document.createElement('td');
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = Boolean(d.enabled);
    enabledInput.addEventListener('change', async () => {
      const result = await window.api.updateDevice({ id: d.id, enabled: enabledInput.checked ? 1 : 0 });
      if (!result?.ok) alert(`更新失败: ${result?.message || 'unknown error'}`);
    });
    enabledCell.appendChild(enabledInput);
    row.appendChild(enabledCell);

    const statusCell = document.createElement('td');
    const base = deviceStatusText(d.state);
    statusCell.textContent = d.lastError ? `${base}: ${d.lastError}` : base;
    row.appendChild(statusCell);

    const actionCell = document.createElement('td');
    const connectBtn = document.createElement('button');
    connectBtn.className = 'mini-btn';
    connectBtn.textContent = d.state === 'connected' ? '断开' : '连接';
    connectBtn.addEventListener('click', async () => {
      const res =
        d.state === 'connected'
          ? await window.api.disconnectDevice(d.id)
          : await window.api.connectDevice(d.id);
      if (!res?.ok) alert(`操作失败: ${res?.message || 'unknown error'}`);
    });
    actionCell.appendChild(connectBtn);

    const editBtn = document.createElement('button');
    editBtn.className = 'mini-btn';
    editBtn.textContent = '编辑';
    editBtn.addEventListener('click', async () => {
      const nextName = window.prompt('工作台名称(可选)', d.name || '');
      if (nextName === null) return;
      const nextHost = window.prompt('IP', d.host || '');
      if (nextHost === null) return;
      const nextPortText = window.prompt('端口', String(d.port ?? ''));
      if (nextPortText === null) return;
      const nextPort = Number(nextPortText);
      const result = await window.api.updateDevice({ id: d.id, name: nextName, host: nextHost, port: nextPort });
      if (!result?.ok) alert(`更新失败: ${result?.message || 'unknown error'}`);
    });
    actionCell.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'action-btn';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', async () => {
      const ok = window.confirm(`确定删除工作台 ${d.name || `${d.host}:${d.port}`} 吗？`);
      if (!ok) return;
      const result = await window.api.deleteDevice(d.id);
      if (!result?.ok) alert(`删除失败: ${result?.message || 'unknown error'}`);
    });
    actionCell.appendChild(delBtn);

    row.appendChild(actionCell);
    devicesBodyEl.appendChild(row);
  });
}

function applyRuntimeInfo(info) {
  if (localIpInfoEl) {
    const ips = Array.isArray(info?.localIps) ? info.localIps.filter(Boolean) : [];
    localIpInfoEl.textContent = ips.length ? `本机IP: ${ips.join(' / ')}` : '本机IP: --';
  }
  renderDevices(info?.devices);
}

addDeviceBtnEl?.addEventListener('click', async () => {
  const name = String(deviceNameInputEl?.value || '').trim() || null;
  const host = String(deviceHostInputEl?.value || '').trim();
  const port = Number(devicePortInputEl?.value);
  const result = await window.api.addDevice({ name, host, port, enabled: 1 });
  if (!result?.ok) {
    alert(`添加失败: ${result?.message || 'unknown error'}`);
    return;
  }
  if (deviceNameInputEl) deviceNameInputEl.value = '';
  if (deviceHostInputEl) deviceHostInputEl.value = '';
  if (devicePortInputEl) devicePortInputEl.value = '';
});

connectEnabledBtnEl?.addEventListener('click', async () => {
  const result = await window.api.connectEnabledDevices();
  if (!result?.ok) alert(`操作失败: ${result?.message || 'unknown error'}`);
});

disconnectAllBtnEl?.addEventListener('click', async () => {
  const result = await window.api.disconnectAllDevices();
  if (!result?.ok) alert(`操作失败: ${result?.message || 'unknown error'}`);
});

window.api.onScannersStatus?.((info) => {
  applyRuntimeInfo(info);
});

window.addEventListener('DOMContentLoaded', async () => {
  const info = await window.api.getRuntimeInfo();
  applyRuntimeInfo(info);
});
