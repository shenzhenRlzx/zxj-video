const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

class Database {
  constructor(app) {
    this.app = app;
    this.db = null;
    this.dbFile = null;
    this.SQL = null;
  }

  async init() {
    const appPath = this.app.getAppPath();
    // sql.js loads wasm by filename, so we provide an absolute path.
    const locateFile = (file) => path.join(appPath, 'node_modules', 'sql.js', 'dist', file);
    this.SQL = await initSqlJs({ locateFile });

    const userData = this.app.getPath('userData');
    this.dbFile = path.join(userData, 'records.db');

    if (fs.existsSync(this.dbFile)) {
      const fileBuffer = fs.readFileSync(this.dbFile);
      this.db = new this.SQL.Database(fileBuffer);
    } else {
      this.db = new this.SQL.Database();
    }

    this.db.run(`CREATE TABLE IF NOT EXISTS scan_records (
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

    this.db.run(`CREATE TABLE IF NOT EXISTS scanner_devices (
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

    this.db.run(`CREATE TABLE IF NOT EXISTS video_devices (
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

    this.db.run(`CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
    );`);

    // Ensure new columns exist for older databases.
    const columns = this.db.exec("PRAGMA table_info(scan_records);");
    const existing = new Set((columns[0]?.values || []).map((row) => row[1]));
    if (!existing.has('deleted')) {
      this.db.run('ALTER TABLE scan_records ADD COLUMN deleted INTEGER DEFAULT 0;');
    }
    if (!existing.has('deleted_at')) {
      this.db.run('ALTER TABLE scan_records ADD COLUMN deleted_at DATETIME;');
    }
    if (!existing.has('device_id')) {
      this.db.run('ALTER TABLE scan_records ADD COLUMN device_id INTEGER;');
    }
    if (!existing.has('video_path')) {
      this.db.run('ALTER TABLE scan_records ADD COLUMN video_path TEXT;');
    }
    if (!existing.has('video_status')) {
      this.db.run('ALTER TABLE scan_records ADD COLUMN video_status TEXT;');
    }
    if (!existing.has('video_backend_id')) {
      this.db.run('ALTER TABLE scan_records ADD COLUMN video_backend_id TEXT;');
    }
    if (!existing.has('video_message')) {
      this.db.run('ALTER TABLE scan_records ADD COLUMN video_message TEXT;');
    }
    if (!existing.has('video_updated_at')) {
      this.db.run('ALTER TABLE scan_records ADD COLUMN video_updated_at DATETIME;');
    }

    const deviceColumns = this.db.exec("PRAGMA table_info(scanner_devices);");
    const existingDeviceCols = new Set((deviceColumns[0]?.values || []).map((row) => row[1]));
    if (!existingDeviceCols.has('type')) {
      this.db.run("ALTER TABLE scanner_devices ADD COLUMN type TEXT DEFAULT 'tcp';");
    }
    if (!existingDeviceCols.has('identifier')) {
      this.db.run("ALTER TABLE scanner_devices ADD COLUMN identifier TEXT;");
      this.db.run("UPDATE scanner_devices SET identifier = host WHERE type = 'tcp' AND identifier IS NULL;");
    }
    if (!existingDeviceCols.has('channel_id')) {
      this.db.run("ALTER TABLE scanner_devices ADD COLUMN channel_id TEXT;");
    }
    if (!existingDeviceCols.has('video_device_id')) {
      this.db.run('ALTER TABLE scanner_devices ADD COLUMN video_device_id INTEGER;');
    }

    // Persist the DB so the file exists even before the first insert.
    this.save();
  }

  save() {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbFile, buffer);
  }

  insertRecord(barcode, deviceId = null) {
    const safeDeviceId = deviceId == null ? null : Number(deviceId);
    const hasDeviceId = safeDeviceId == null ? null : Number.isFinite(safeDeviceId) ? safeDeviceId : null;
    this.db.run('INSERT INTO scan_records (barcode, device_id) VALUES (?, ?);', [barcode, hasDeviceId]);
    const last = this.db.exec('SELECT last_insert_rowid() as id;');
    const id = last[0]?.values?.[0]?.[0];
    this.save();
    if (id != null) {
      const record = this.getRecordById(id);
      if (record) return record;
    }
    return { barcode, device_id: hasDeviceId, scanned_at: new Date().toISOString() };
  }

  setRecordVideoPath(id, videoPath) {
    const safeId = Number(id);
    if (!Number.isFinite(safeId)) return;
    const safePath = videoPath == null ? null : String(videoPath);
    this.db.run('UPDATE scan_records SET video_path = ? WHERE id = ?;', [safePath, safeId]);
    this.save();
  }

  setRecordVideoInfo(id, { status, backendId, videoPath, message } = {}) {
    const safeId = Number(id);
    if (!Number.isFinite(safeId)) return;

    const safeStatus = status == null ? null : String(status);
    const safeBackendId = backendId == null ? null : String(backendId);
    const safePath = videoPath == null ? null : String(videoPath);
    const safeMessage = message == null ? null : String(message);

    this.db.run(
      `UPDATE scan_records
       SET video_status = ?,
           video_backend_id = ?,
           video_path = COALESCE(?, video_path),
           video_message = ?,
           video_updated_at = datetime('now', 'localtime')
       WHERE id = ?;`,
      [safeStatus, safeBackendId, safePath, safeMessage, safeId]
    );
    this.save();
  }

  deleteRecord(id) {
    this.db.run(
      "UPDATE scan_records SET deleted = 1, deleted_at = datetime('now', 'localtime') WHERE id = ?;",
      [id]
    );
    this.save();
  }

  getRecordById(id) {
    const safeId = Number(id);
    if (!Number.isFinite(safeId)) return null;
    const sql = `SELECT
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
    FROM scan_records r
    LEFT JOIN scanner_devices d ON r.device_id = d.id
    WHERE r.id = ?`;
    const result = this.db.exec(sql, [safeId]);
    if (result.length === 0) return null;
    const { columns, values } = result[0];
    const row = values[0];
    const obj = {};
    columns.forEach((col, idx) => {
      obj[col] = row[idx];
    });
    return obj;
  }

  listPendingVideoRecords() {
    const result = this.db.exec(
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
        AND lower(trim(coalesce(video_status, ''))) IN ('等待', 'waiting', 'pending', 'processing', 'running', 'queue', 'queued')
      ORDER BY scanned_at DESC, id DESC
      LIMIT 500;`
    );
    if (result.length === 0) return [];
    const { columns, values } = result[0];
    return values.map((row) => {
      const obj = {};
      columns.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      return obj;
    });
  }

  queryRecords({ keyword, date, deviceId, page = 1, pageSize = 10, onlyDeleted = false }) {
    let sql = `SELECT
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
    FROM scan_records r
    LEFT JOIN scanner_devices d ON r.device_id = d.id`;
    const params = [];
    const where = [];

    if (keyword) {
      where.push('r.barcode LIKE ?');
      params.push(`%${keyword}%`);
    }
    if (date) {
      where.push("date(r.scanned_at) = ?");
      params.push(date);
    }
    if (deviceId != null && deviceId !== '') {
      const safeDeviceId = Number(deviceId);
      if (Number.isFinite(safeDeviceId)) {
        where.push('r.device_id = ?');
        params.push(safeDeviceId);
      }
    }
    if (onlyDeleted) {
      where.push('r.deleted = 1');
    } else {
      where.push('r.deleted = 0');
    }
    if (where.length) {
      sql += ' WHERE ' + where.join(' AND ');
    }
    sql += ' ORDER BY r.scanned_at DESC, r.id DESC';
    const limit = Math.max(1, Number(pageSize) || 10);
    const offset = Math.max(0, (Number(page) - 1) * limit);
    sql += ` LIMIT ${limit} OFFSET ${offset}`;

    const result = this.db.exec(sql, params);
    if (result.length === 0) return [];
    const { columns, values } = result[0];
    return values.map((row) => {
      const obj = {};
      columns.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      return obj;
    });
  }

  countRecords({ keyword, date, deviceId, onlyDeleted = false }) {
    let sql = 'SELECT COUNT(1) as total FROM scan_records r';
    const params = [];
    const where = [];
    if (keyword) {
      where.push('r.barcode LIKE ?');
      params.push(`%${keyword}%`);
    }
    if (date) {
      where.push("date(r.scanned_at) = ?");
      params.push(date);
    }
    if (deviceId != null && deviceId !== '') {
      const safeDeviceId = Number(deviceId);
      if (Number.isFinite(safeDeviceId)) {
        where.push('r.device_id = ?');
        params.push(safeDeviceId);
      }
    }
    if (onlyDeleted) {
      where.push('r.deleted = 1');
    } else {
      where.push('r.deleted = 0');
    }
    if (where.length) {
      sql += ' WHERE ' + where.join(' AND ');
    }
    const result = this.db.exec(sql, params);
    return result[0]?.values?.[0]?.[0] || 0;
  }

  listDevices() {
    const result = this.db.exec(
      `SELECT id, name, type, identifier, video_device_id, channel_id, host, port, enabled, created_at, updated_at
       FROM scanner_devices
       ORDER BY enabled DESC, id DESC;`
    );
    if (result.length === 0) return [];
    const { columns, values } = result[0];
    return values.map((row) => {
      const obj = {};
      columns.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      return obj;
    });
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
    
    this.db.run(
      `INSERT INTO scanner_devices (name, type, identifier, video_device_id, channel_id, host, port, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      [safeName, safeType, safeIdentifier, hasVideoDeviceId, safeChannelId, safeHost, safePort, safeEnabled]
    );
    const last = this.db.exec('SELECT last_insert_rowid() as id;');
    const id = last[0]?.values?.[0]?.[0];
    this.save();
    if (id == null) return { ok: true };
    return { ok: true, device: this.getDeviceById(id) };
  }

  getDeviceById(id) {
    const safeId = Number(id);
    if (!Number.isFinite(safeId)) return null;
    const result = this.db.exec(
      `SELECT id, name, type, identifier, video_device_id, channel_id, host, port, enabled, created_at, updated_at
       FROM scanner_devices
       WHERE id = ?;`,
      [safeId]
    );
    if (result.length === 0) return null;
    const { columns, values } = result[0];
    const row = values[0];
    const obj = {};
    columns.forEach((col, idx) => {
      obj[col] = row[idx];
    });
    return obj;
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

    this.db.run(
      `UPDATE scanner_devices
       SET name = ?, type = ?, identifier = ?, video_device_id = ?, channel_id = ?, host = ?, port = ?, enabled = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ?;`,
      [nextName, nextType, nextIdentifier, hasVideoDeviceId, nextChannelId, nextHost, nextPort, nextEnabled, safeId]
    );
    this.save();
    return { ok: true, device: this.getDeviceById(safeId) };
  }

  deleteDevice(id) {
    const safeId = Number(id);
    if (!Number.isFinite(safeId)) return { ok: false, message: 'invalid id' };
    this.db.run('DELETE FROM scanner_devices WHERE id = ?;', [safeId]);
    this.save();
    return { ok: true };
  }

  getSetting(key) {
    const safeKey = String(key || '').trim();
    if (!safeKey) return null;
    const result = this.db.exec('SELECT value FROM app_settings WHERE key = ?;', [safeKey]);
    return result[0]?.values?.[0]?.[0] ?? null;
  }

  setSetting(key, value) {
    const safeKey = String(key || '').trim();
    if (!safeKey) return { ok: false, message: 'empty key' };
    const safeValue = value == null ? null : String(value);
    this.db.run(
      "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now', 'localtime'));",
      [safeKey, safeValue]
    );
    this.save();
    return { ok: true };
  }

  listVideoDevices() {
    const result = this.db.exec(
      `SELECT id, name, base_url, username, password, extra_json, enabled, created_at, updated_at
       FROM video_devices
       ORDER BY enabled DESC, id DESC;`
    );
    if (result.length === 0) return [];
    const { columns, values } = result[0];
    return values.map((row) => {
      const obj = {};
      columns.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      return obj;
    });
  }

  getVideoDeviceById(id) {
    const safeId = Number(id);
    if (!Number.isFinite(safeId)) return null;
    const result = this.db.exec(
      `SELECT id, name, base_url, username, password, extra_json, enabled, created_at, updated_at
       FROM video_devices
       WHERE id = ?;`,
      [safeId]
    );
    if (result.length === 0) return null;
    const { columns, values } = result[0];
    const row = values[0];
    const obj = {};
    columns.forEach((col, idx) => {
      obj[col] = row[idx];
    });
    return obj;
  }

  addVideoDevice({ name, base_url = '', username = '', password = '', extra = null, enabled = 1 }) {
    const safeName = String(name || '').trim();
    if (!safeName) return { ok: false, message: 'empty name' };
    const safeBaseUrl = String(base_url || '').trim();
    const safeUsername = String(username || '').trim();
    const safePassword = String(password || '');
    const safeExtraJson = extra == null ? null : JSON.stringify(extra);
    const safeEnabled = enabled ? 1 : 0;

    this.db.run(
      `INSERT INTO video_devices (name, base_url, username, password, extra_json, enabled)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [safeName, safeBaseUrl, safeUsername, safePassword, safeExtraJson, safeEnabled]
    );
    const last = this.db.exec('SELECT last_insert_rowid() as id;');
    const id = last[0]?.values?.[0]?.[0];
    this.save();
    if (id == null) return { ok: true };
    return { ok: true, device: this.getVideoDeviceById(id) };
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

    this.db.run(
      `UPDATE video_devices
       SET name = ?, base_url = ?, username = ?, password = ?, extra_json = ?, enabled = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ?;`,
      [nextName, nextBaseUrl, nextUsername, nextPassword, nextExtraJson, nextEnabled, safeId]
    );
    this.save();
    return { ok: true, device: this.getVideoDeviceById(safeId) };
  }

  deleteVideoDevice(id) {
    const safeId = Number(id);
    if (!Number.isFinite(safeId)) return { ok: false, message: 'invalid id' };
    this.db.run('DELETE FROM video_devices WHERE id = ?;', [safeId]);
    this.save();
    return { ok: true };
  }
}

module.exports = { Database };
