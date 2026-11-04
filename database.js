const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { localTimestamp } = require('./utils');

const RECORD_SELECT_FIELDS = `
  r.id,
  r.barcode,
  r.device_id,
  r.scanned_at,
  r.deleted,
  r.video_path,
  r.video_status,
  r.video_backend_id,
  r.video_message,
  r.video_updated_at,
  d.name as device_name,
  d.type as device_type,
  d.identifier as device_identifier,
  d.channel_id as device_channel_id
`;

const RECORD_FROM = `FROM scan_records r LEFT JOIN scanner_devices d ON r.device_id = d.id`;

class AppDatabase {
  constructor(app) {
    this.app = app;
    this.db = null;
    this.dbFile = null;
    this._stmts = new Map();
  }

  async init() {
    const userData = this.app.getPath('userData');
    fs.mkdirSync(userData, { recursive: true });
    this.dbFile = path.join(userData, 'records.db');

    // 旧版使用 sql.js 导出的也是标准 SQLite 文件，better-sqlite3 可直接打开，无需迁移。
    this.db = new Database(this.dbFile);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');

    this.db.exec(`CREATE TABLE IF NOT EXISTS scan_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barcode TEXT NOT NULL,
      device_id INTEGER,
      scanned_at DATETIME DEFAULT (datetime('now', 'localtime')),
      deleted INTEGER DEFAULT 0,
      deleted_at DATETIME,
      video_path TEXT,
      video_status TEXT,
      video_backend_id TEXT,
      video_message TEXT,
      video_updated_at DATETIME
    );`);

    this.db.exec(`CREATE TABLE IF NOT EXISTS scanner_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      type TEXT DEFAULT 'tcp',
      identifier TEXT,
      video_device_id INTEGER,
      channel_id TEXT,
      host TEXT,
      port INTEGER,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT (datetime('now', 'localtime')),
      updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
    );`);

    this.db.exec(`CREATE TABLE IF NOT EXISTS video_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base_url TEXT,
      username TEXT,
      password TEXT,
      extra_json TEXT,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT (datetime('now', 'localtime')),
      updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
    );`);

    this.db.exec(`CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
    );`);

    // Ensure new columns exist for older databases.
    const recordColumns = new Set(
      this.db.prepare('PRAGMA table_info(scan_records)').all().map((row) => row.name)
    );
    const addRecordColumn = (name, ddl) => {
      if (!recordColumns.has(name)) this.db.exec(ddl);
    };
    addRecordColumn('deleted', 'ALTER TABLE scan_records ADD COLUMN deleted INTEGER DEFAULT 0;');
    addRecordColumn('deleted_at', 'ALTER TABLE scan_records ADD COLUMN deleted_at DATETIME;');
    addRecordColumn('device_id', 'ALTER TABLE scan_records ADD COLUMN device_id INTEGER;');
    addRecordColumn('video_path', 'ALTER TABLE scan_records ADD COLUMN video_path TEXT;');
    addRecordColumn('video_status', 'ALTER TABLE scan_records ADD COLUMN video_status TEXT;');
    addRecordColumn('video_backend_id', 'ALTER TABLE scan_records ADD COLUMN video_backend_id TEXT;');
    addRecordColumn('video_message', 'ALTER TABLE scan_records ADD COLUMN video_message TEXT;');
    addRecordColumn('video_updated_at', 'ALTER TABLE scan_records ADD COLUMN video_updated_at DATETIME;');

    const deviceColumns = new Set(
      this.db.prepare('PRAGMA table_info(scanner_devices)').all().map((row) => row.name)
    );
    if (!deviceColumns.has('type')) {
      this.db.exec("ALTER TABLE scanner_devices ADD COLUMN type TEXT DEFAULT 'tcp';");
    }
    if (!deviceColumns.has('identifier')) {
      this.db.exec('ALTER TABLE scanner_devices ADD COLUMN identifier TEXT;');
      this.db.exec("UPDATE scanner_devices SET identifier = host WHERE type = 'tcp' AND identifier IS NULL;");
    }
    if (!deviceColumns.has('channel_id')) {
      this.db.exec('ALTER TABLE scanner_devices ADD COLUMN channel_id TEXT;');
    }
    if (!deviceColumns.has('video_device_id')) {
      this.db.exec('ALTER TABLE scanner_devices ADD COLUMN video_device_id INTEGER;');
    }

    // WAL 模式下由 SQLite 自动增量落盘，save() 仅为兼容旧调用保留。
  }

  _stmt(sql) {
    let stmt = this._stmts.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this._stmts.set(sql, stmt);
    }
    return stmt;
  }

  // 兼容旧接口：WAL 模式下数据已实时落盘，无需手动导出。
  save() {}

  close() {
    if (!this.db) return;
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (e) { }
    try {
      this.db.close();
    } catch (e) { }
    this.db = null;
  }

  insertRecord(barcode, deviceId = null) {
    const safeDeviceId = deviceId == null ? null : Number(deviceId);
    const hasDeviceId = safeDeviceId == null ? null : Number.isFinite(safeDeviceId) ? safeDeviceId : null;
    const info = this._stmt('INSERT INTO scan_records (barcode, device_id) VALUES (?, ?);').run(barcode, hasDeviceId);
    const record = this.getRecordById(info.lastInsertRowid);
    if (record) return record;
    return { barcode, device_id: hasDeviceId, scanned_at: localTimestamp() };
  }

  setRecordVideoPath(id, videoPath) {
    const safeId = Number(id);
    if (!Number.isFinite(safeId)) return;
    // 视频地址清洗：去控制字符与首尾空白（保留路径内部空格）
    const safePath = videoPath == null ? null : String(videoPath).replace(/[\x00-\x1F\x7F]/g, '').trim();
    this._stmt('UPDATE scan_records SET video_path = ? WHERE id = ?;').run(safePath, safeId);
  }

  setRecordVideoInfo(id, { status, backendId, videoPath, message } = {}) {
    const safeId = Number(id);
    if (!Number.isFinite(safeId)) return;

    const safeStatus = status == null ? null : String(status);
    const safeBackendId = backendId == null ? null : String(backendId);
    // 视频地址清洗：去控制字符与首尾空白（保留路径内部空格）
    const safePath = videoPath == null ? null : String(videoPath).replace(/[\x00-\x1F\x7F]/g, '').trim();
    const safeMessage = message == null ? null : String(message);

    this._stmt(
      `UPDATE scan_records
       SET video_status = ?,
           video_backend_id = ?,
           video_path = COALESCE(?, video_path),
           video_message = ?,
           video_updated_at = datetime('now', 'localtime')
       WHERE id = ?;`
    ).run(safeStatus, safeBackendId, safePath, safeMessage, safeId);
  }

  deleteRecord(id) {
    this._stmt(
      "UPDATE scan_records SET deleted = 1, deleted_at = datetime('now', 'localtime') WHERE id = ?;"
    ).run(Number(id));
  }

  getRecordById(id) {
    const safeId = Number(id);
    if (!Number.isFinite(safeId)) return null;
    return this._stmt(
      `SELECT ${RECORD_SELECT_FIELDS} ${RECORD_FROM} WHERE r.id = ?`
    ).get(safeId) || null;
  }

  listPendingVideoRecords() {
    return this._stmt(
      `SELECT
        id,
        barcode,
        device_id,
        scanned_at,
        video_status,
        video_backend_id,
        video_path
      FROM scan_records
      WHERE deleted = 0
        AND (video_path IS NULL OR trim(video_path) = '')
        AND lower(trim(coalesce(video_status, ''))) IN ('等待', '下载中', 'waiting', 'pending', 'processing', 'running', 'queue', 'queued', 'downloading')
      ORDER BY id DESC
      LIMIT 500;`
    ).all();
  }

  queryRecords({ keyword, date, dateFrom, dateTo, deviceId, page = 1, pageSize = 10, onlyDeleted = false, videoStatus = '' }) {
    const where = [];
    const params = {};

    if (keyword) {
      where.push('r.barcode LIKE @keyword');
      params.keyword = `%${keyword}%`;
    }
    if (date) {
      where.push('date(r.scanned_at) = @date');
      params.date = date;
    }
    if (dateFrom) {
      where.push('date(r.scanned_at) >= @dateFrom');
      params.dateFrom = dateFrom;
    }
    if (dateTo) {
      where.push('date(r.scanned_at) <= @dateTo');
      params.dateTo = dateTo;
    }
    if (deviceId != null && deviceId !== '') {
      const safeDeviceId = Number(deviceId);
      if (Number.isFinite(safeDeviceId)) {
        where.push('r.device_id = @deviceId');
        params.deviceId = safeDeviceId;
      }
    }
    if (videoStatus) {
      const v = String(videoStatus);
      if (v === 'waiting') {
        where.push("lower(trim(coalesce(r.video_status, ''))) IN ('等待', '下载中', 'waiting', 'pending', 'processing', 'running', 'queue', 'queued', 'downloading')");
      } else if (v === 'failed') {
        where.push("r.video_status LIKE '失败%'");
      } else if (v === 'success') {
        where.push("r.video_status = '成功'");
      } else if (v === 'none') {
        where.push("(r.video_status IS NULL OR trim(r.video_status) = '')");
      }
    }
    where.push(onlyDeleted ? 'r.deleted = 1' : 'r.deleted = 0');

    // 以自增 id 为主序，避免系统时间回拨导致新记录沉底。
    // pageSize='all' → 不分页，一次取全部
    const limit = pageSize === 'all' ? 1000000 : Math.max(1, Number(pageSize) || 10);
    const offset = Math.max(0, (Number(page) - 1) * limit);
    const sql = `SELECT ${RECORD_SELECT_FIELDS} ${RECORD_FROM}`
      + (where.length ? ' WHERE ' + where.join(' AND ') : '')
      + ' ORDER BY r.id DESC LIMIT @limit OFFSET @offset';
    params.limit = limit;
    params.offset = offset;
    return this._stmt(sql).all(params);
  }

  countRecords({ keyword, date, dateFrom, dateTo, deviceId, onlyDeleted = false, videoStatus = '' }) {
    const where = [];
    const params = {};

    if (keyword) {
      where.push('r.barcode LIKE @keyword');
      params.keyword = `%${keyword}%`;
    }
    if (date) {
      where.push('date(r.scanned_at) = @date');
      params.date = date;
    }
    if (dateFrom) {
      where.push('date(r.scanned_at) >= @dateFrom');
      params.dateFrom = dateFrom;
    }
    if (dateTo) {
      where.push('date(r.scanned_at) <= @dateTo');
      params.dateTo = dateTo;
    }
    if (deviceId != null && deviceId !== '') {
      const safeDeviceId = Number(deviceId);
      if (Number.isFinite(safeDeviceId)) {
        where.push('r.device_id = @deviceId');
        params.deviceId = safeDeviceId;
      }
    }
    if (videoStatus) {
      const v = String(videoStatus);
      if (v === 'waiting') {
        where.push("lower(trim(coalesce(r.video_status, ''))) IN ('等待', '下载中', 'waiting', 'pending', 'processing', 'running', 'queue', 'queued', 'downloading')");
      } else if (v === 'failed') {
        where.push("r.video_status LIKE '失败%'");
      } else if (v === 'success') {
        where.push("r.video_status = '成功'");
      } else if (v === 'none') {
        where.push("(r.video_status IS NULL OR trim(r.video_status) = '')");
      }
    }
    where.push(onlyDeleted ? 'r.deleted = 1' : 'r.deleted = 0');

    const sql = 'SELECT COUNT(1) as total FROM scan_records r'
      + (where.length ? ' WHERE ' + where.join(' AND ') : '');
    return this._stmt(sql).get(params).total || 0;
  }

  listDevices() {
    return this._stmt(
      `SELECT id, name, type, identifier, video_device_id, channel_id, host, port, enabled, created_at, updated_at
       FROM scanner_devices
       ORDER BY enabled DESC, id DESC;`
    ).all();
  }

  addDevice({ name, type = 'tcp', identifier, video_device_id = null, channel_id = '', host = '', port = 0, enabled = 1 }) {
    const safeName = String(name || '').trim() || null;
    const safeType = String(type || 'tcp').trim();
    const safeIdentifier = String(identifier || '').trim();
    const safeVideoDeviceId =
      video_device_id == null || video_device_id === '' ? null : Number(video_device_id);
    const hasVideoDeviceId = safeVideoDeviceId == null ? null : Number.isFinite(safeVideoDeviceId) ? safeVideoDeviceId : null;
    const safeChannelId = String(channel_id || '').trim();
    const safeHost = String(host || '').trim();
    const safePort = Number(port);
    const safeEnabled = enabled ? 1 : 0;

    if (!safeIdentifier) return { ok: false, message: 'empty identifier' };

    const info = this._stmt(
      `INSERT INTO scanner_devices (name, type, identifier, video_device_id, channel_id, host, port, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`
    ).run(safeName, safeType, safeIdentifier, hasVideoDeviceId, safeChannelId, safeHost, safePort, safeEnabled);
    return { ok: true, device: this.getDeviceById(info.lastInsertRowid) };
  }

  getDeviceById(id) {
    const safeId = Number(id);
    if (!Number.isFinite(safeId)) return null;
    return this._stmt(
      `SELECT id, name, type, identifier, video_device_id, channel_id, host, port, enabled, created_at, updated_at
       FROM scanner_devices
       WHERE id = ?;`
    ).get(safeId) || null;
  }

  updateDevice(id, { name, type, identifier, video_device_id, channel_id, host, port, enabled }) {
    const safeId = Number(id);
    if (!Number.isFinite(safeId)) return { ok: false, message: 'invalid id' };

    const existing = this.getDeviceById(safeId);
    if (!existing) return { ok: false, message: 'not found' };

    const nextName = name === undefined ? existing.name : String(name || '').trim() || null;
    const nextType = type === undefined ? existing.type : String(type || 'tcp').trim();
    const nextIdentifier = identifier === undefined ? existing.identifier : String(identifier || '').trim();
    const nextVideoDeviceIdRaw = video_device_id === undefined ? existing.video_device_id : video_device_id;
    const nextVideoDeviceId =
      nextVideoDeviceIdRaw == null || nextVideoDeviceIdRaw === '' ? null : Number(nextVideoDeviceIdRaw);
    const hasVideoDeviceId = nextVideoDeviceId == null ? null : Number.isFinite(nextVideoDeviceId) ? nextVideoDeviceId : null;
    const nextChannelId = channel_id === undefined ? existing.channel_id : String(channel_id || '').trim();
    const nextHost = host === undefined ? existing.host : String(host || '').trim();
    const nextPort = port === undefined ? Number(existing.port) : Number(port);
    const nextEnabled = enabled === undefined ? Number(existing.enabled) : enabled ? 1 : 0;

    if (!nextIdentifier) return { ok: false, message: 'empty identifier' };

    this._stmt(
      `UPDATE scanner_devices
       SET name = ?, type = ?, identifier = ?, video_device_id = ?, channel_id = ?, host = ?, port = ?, enabled = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ?;`
    ).run(nextName, nextType, nextIdentifier, hasVideoDeviceId, nextChannelId, nextHost, nextPort, nextEnabled, safeId);
    return { ok: true, device: this.getDeviceById(safeId) };
  }

  deleteDevice(id) {
    const safeId = Number(id);
    if (!Number.isFinite(safeId)) return { ok: false, message: 'invalid id' };
    this._stmt('DELETE FROM scanner_devices WHERE id = ?;').run(safeId);
    return { ok: true };
  }

  getSetting(key) {
    const safeKey = String(key || '').trim();
    if (!safeKey) return null;
    const row = this._stmt('SELECT value FROM app_settings WHERE key = ?;').get(safeKey);
    return row ? row.value : null;
  }

  setSetting(key, value) {
    const safeKey = String(key || '').trim();
    if (!safeKey) return { ok: false, message: 'empty key' };
    const safeValue = value == null ? null : String(value);
    this._stmt(
      "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now', 'localtime'));"
    ).run(safeKey, safeValue);
    return { ok: true };
  }

  listVideoDevices() {
    return this._stmt(
      `SELECT id, name, base_url, username, password, extra_json, enabled, created_at, updated_at
       FROM video_devices
       ORDER BY enabled DESC, id DESC;`
    ).all();
  }

  getVideoDeviceById(id) {
    const safeId = Number(id);
    if (!Number.isFinite(safeId)) return null;
    return this._stmt(
      `SELECT id, name, base_url, username, password, extra_json, enabled, created_at, updated_at
       FROM video_devices
       WHERE id = ?;`
    ).get(safeId) || null;
  }

  addVideoDevice({ name, base_url = '', username = '', password = '', extra = null, enabled = 1 }) {
    const safeName = String(name || '').trim();
    if (!safeName) return { ok: false, message: 'empty name' };
    const safeBaseUrl = String(base_url || '').trim();
    const safeUsername = String(username || '').trim();
    const safePassword = String(password || '');
    const safeExtraJson = extra == null ? null : JSON.stringify(extra);
    const safeEnabled = enabled ? 1 : 0;

    const info = this._stmt(
      `INSERT INTO video_devices (name, base_url, username, password, extra_json, enabled)
       VALUES (?, ?, ?, ?, ?, ?);`
    ).run(safeName, safeBaseUrl, safeUsername, safePassword, safeExtraJson, safeEnabled);
    return { ok: true, device: this.getVideoDeviceById(info.lastInsertRowid) };
  }

  updateVideoDevice(id, { name, base_url, username, password, extra, enabled }) {
    const safeId = Number(id);
    if (!Number.isFinite(safeId)) return { ok: false, message: 'invalid id' };

    const existing = this.getVideoDeviceById(safeId);
    if (!existing) return { ok: false, message: 'not found' };

    const nextName = name === undefined ? existing.name : String(name || '').trim();
    if (!nextName) return { ok: false, message: 'empty name' };
    const nextBaseUrl = base_url === undefined ? existing.base_url : String(base_url || '').trim();
    const nextUsername = username === undefined ? existing.username : String(username || '').trim();
    const nextPassword = password === undefined ? existing.password : String(password || '');
    const nextExtraJson =
      extra === undefined ? existing.extra_json : extra == null ? null : JSON.stringify(extra);
    const nextEnabled = enabled === undefined ? Number(existing.enabled) : enabled ? 1 : 0;

    this._stmt(
      `UPDATE video_devices
       SET name = ?, base_url = ?, username = ?, password = ?, extra_json = ?, enabled = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ?;`
    ).run(nextName, nextBaseUrl, nextUsername, nextPassword, nextExtraJson, nextEnabled, safeId);
    return { ok: true, device: this.getVideoDeviceById(safeId) };
  }

  deleteVideoDevice(id) {
    const safeId = Number(id);
    if (!Number.isFinite(safeId)) return { ok: false, message: 'invalid id' };
    this._stmt('DELETE FROM video_devices WHERE id = ?;').run(safeId);
    return { ok: true };
  }
}

module.exports = { Database: AppDatabase };
