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
      deleted_at DATETIME
    );`);

    this.db.run(`CREATE TABLE IF NOT EXISTS scanner_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT (datetime('now', 'localtime')),
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
      d.name as device_name,
      d.host as device_host,
      d.port as device_port
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

  queryRecords({ keyword, date, deviceId, page = 1, pageSize = 10, onlyDeleted = false }) {
    let sql = `SELECT
      r.id,
      r.barcode,
      r.device_id,
      r.scanned_at,
      r.deleted,
      d.name as device_name,
      d.host as device_host,
      d.port as device_port
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
      `SELECT id, name, host, port, enabled, created_at, updated_at
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

  addDevice({ name, host, port, enabled = 1 }) {
    const safeName = String(name || '').trim() || null;
    const safeHost = String(host || '').trim();
    const safePort = Number(port);
    const safeEnabled = enabled ? 1 : 0;
    if (!safeHost) return { ok: false, message: 'empty host' };
    if (!Number.isFinite(safePort) || safePort <= 0 || safePort > 65535) {
      return { ok: false, message: 'invalid port' };
    }
    this.db.run(
      `INSERT INTO scanner_devices (name, host, port, enabled)
       VALUES (?, ?, ?, ?);`,
      [safeName, safeHost, safePort, safeEnabled]
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
      `SELECT id, name, host, port, enabled, created_at, updated_at
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

  updateDevice(id, { name, host, port, enabled }) {
    const safeId = Number(id);
    if (!Number.isFinite(safeId)) return { ok: false, message: 'invalid id' };

    const existing = this.getDeviceById(safeId);
    if (!existing) return { ok: false, message: 'not found' };

    const nextName = name === undefined ? existing.name : String(name || '').trim() || null;
    const nextHost = host === undefined ? existing.host : String(host || '').trim();
    const nextPort = port === undefined ? Number(existing.port) : Number(port);
    const nextEnabled = enabled === undefined ? Number(existing.enabled) : enabled ? 1 : 0;

    if (!nextHost) return { ok: false, message: 'empty host' };
    if (!Number.isFinite(nextPort) || nextPort <= 0 || nextPort > 65535) {
      return { ok: false, message: 'invalid port' };
    }

    this.db.run(
      `UPDATE scanner_devices
       SET name = ?, host = ?, port = ?, enabled = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ?;`,
      [nextName, nextHost, nextPort, nextEnabled, safeId]
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
}

module.exports = { Database };
