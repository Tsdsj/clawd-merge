// A tiny stand-in for Cloudflare D1 on top of Node's built-in SQLite, so the
// Worker can be tested and run locally without wrangler.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const MIGRATIONS = new URL('../migrations/', import.meta.url);
const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.db, this.sql, params);
  }
  async first() {
    return this.db.prepare(this.sql).get(...this.params) ?? null;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params), success: true };
  }
  async run() {
    const meta = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta };
  }
}

// Applies migrations like `wrangler d1 migrations apply`. `upTo` stops after
// that many files (to test upgrading an older database); call migrate() later
// to apply the rest.
export function createD1(file = ':memory:', { upTo = Infinity } = {}) {
  const db = new DatabaseSync(file);
  let applied = 0;
  const migrate = (limit = Infinity) => {
    for (const f of migrationFiles().slice(applied, limit)) {
      db.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
      applied++;
    }
  };
  migrate(upTo);
  return {
    migrate,
    raw: db,
    prepare: (sql) => new Statement(db, sql),
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}
