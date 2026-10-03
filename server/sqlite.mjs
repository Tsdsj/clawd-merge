import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const migrationRoot = new URL('../leaderboard/migrations/', import.meta.url);

class Statement {
  constructor(owner, sql, values = []) { this.owner = owner; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.owner, this.sql, values); }
  async first(column) {
    const row = this.owner.raw.prepare(this.sql).get(...this.values);
    return row === undefined ? null : column === undefined ? row : row[column];
  }
  async all() { return { success: true, results: this.owner.raw.prepare(this.sql).all(...this.values) }; }
  async run() { return this.execute(); }
  execute() {
    const result = this.owner.raw.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: result.changes, last_row_id: result.lastInsertRowid } };
  }
}

export function openDatabase(path, { migrations = migrationRoot } = {}) {
  const raw = new DatabaseSync(path, { timeout: 5000 });
  try {
    raw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const existing = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(x => x.name);
    if (existing.length && !existing.includes('app_migrations') && !existing.includes('d1_migrations')) throw new Error('Database has no recognized migration history; refusing to alter it');
    raw.exec('CREATE TABLE IF NOT EXISTS app_migrations(name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    const imported = new Set(existing.includes('d1_migrations') ? raw.prepare('SELECT name FROM d1_migrations').all().map(x => x.name) : []);
    const files = readdirSync(migrations).filter(x => /^\d+_.*\.sql$/.test(x)).sort();
    for (const name of imported) if (!files.includes(name)) throw new Error('Imported database contains an unknown migration');
    for (const name of files) {
      const sql = readFileSync(new URL(name, migrations), 'utf8');
      const digest = createHash('sha256').update(sql).digest('hex');
      const applied = raw.prepare('SELECT sha256 FROM app_migrations WHERE name=?').get(name);
      if (applied) {
        if (applied.sha256 !== digest) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      raw.exec('BEGIN IMMEDIATE');
      try {
        if (!imported.has(name)) raw.exec(sql);
        raw.prepare('INSERT INTO app_migrations VALUES (?,?,?)').run(name, digest, Date.now());
        raw.exec('COMMIT');
      } catch (error) { raw.exec('ROLLBACK'); throw error; }
    }
    const db = {
      raw,
      prepare: sql => new Statement(db, sql),
      async batch(statements) {
        if (statements.some(s => !(s instanceof Statement) || s.owner !== db)) throw new Error('Foreign batch statement');
        raw.exec('BEGIN IMMEDIATE');
        try {
          const result = statements.map(s => s.execute());
          raw.exec('COMMIT');
          return result;
        } catch (error) { raw.exec('ROLLBACK'); throw error; }
      },
      // No await is allowed while this connection holds a write transaction.
      // Expensive KDF work happens first; callers recheck versions inside here.
      transaction(callback) {
        raw.exec('BEGIN IMMEDIATE');
        try {
          const result=callback(raw);
          if(result && typeof result.then==='function')throw new Error('SQLite transaction callback must be synchronous');
          raw.exec('COMMIT');
          return result;
        } catch(error) { raw.exec('ROLLBACK'); throw error; }
      },
      close() { raw.close(); },
    };
    return db;
  } catch (error) { raw.close(); throw error; }
}
