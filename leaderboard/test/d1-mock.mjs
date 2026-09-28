// A tiny stand-in for Cloudflare D1 on top of Node's built-in SQLite, so the
// Worker can be tested and run locally without wrangler.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

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

export function createD1(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return {
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
