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
      scanned_at DATETIME DEFAULT (datetime('now', 'localtime')),
      deleted INTEGER DEFAULT 0,
      deleted_at DATETIME
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

    // Persist the DB so the file exists even before the first insert.
    this.save();
  }

  save() {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbFile, buffer);
  }

  insertRecord(barcode) {
    this.db.run('INSERT INTO scan_records (barcode) VALUES (?);', [barcode]);
    this.save();
    const rows = this.queryRecords({ page: 1, pageSize: 1, onlyDeleted: false });
    return rows[0] || { barcode, scanned_at: new Date().toISOString() };
  }

  deleteRecord(id) {
    this.db.run(
      "UPDATE scan_records SET deleted = 1, deleted_at = datetime('now', 'localtime') WHERE id = ?;",
      [id]
    );
    this.save();
  }

  queryRecords({ keyword, date, page = 1, pageSize = 10, onlyDeleted = false }) {
    let sql = 'SELECT id, barcode, scanned_at, deleted FROM scan_records';
    const params = [];
    const where = [];

    if (keyword) {
      where.push('barcode LIKE ?');
      params.push(`%${keyword}%`);
    }
    if (date) {
      where.push("date(scanned_at) = ?");
      params.push(date);
    }
    if (onlyDeleted) {
      where.push('deleted = 1');
    } else {
      where.push('deleted = 0');
    }
    if (where.length) {
      sql += ' WHERE ' + where.join(' AND ');
    }
    sql += ' ORDER BY scanned_at DESC';
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

  countRecords({ keyword, date, onlyDeleted = false }) {
    let sql = 'SELECT COUNT(1) as total FROM scan_records';
    const params = [];
    const where = [];
    if (keyword) {
      where.push('barcode LIKE ?');
      params.push(`%${keyword}%`);
    }
    if (date) {
      where.push("date(scanned_at) = ?");
      params.push(date);
    }
    if (onlyDeleted) {
      where.push('deleted = 1');
    } else {
      where.push('deleted = 0');
    }
    if (where.length) {
      sql += ' WHERE ' + where.join(' AND ');
    }
    const result = this.db.exec(sql, params);
    return result[0]?.values?.[0]?.[0] || 0;
  }
}

module.exports = { Database };
