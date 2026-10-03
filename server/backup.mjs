import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

process.umask(0o077);
const directory = process.env.BACKUP_DIR || '/backups';
mkdirSync(directory, { recursive: true });
const output = join(directory, `clawd-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
const db = new DatabaseSync(process.env.DB_FILE || '/data/clawd.sqlite', { readOnly: true });
try { await backup(db, output); } finally { db.close(); }
chmodSync(output, 0o600);
const verify = new DatabaseSync(output, { readOnly: true });
try { if (verify.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Backup integrity check failed'); }
finally { verify.close(); }
// Rotate only backups created by this script, after a verified replacement.
for (const file of readdirSync(directory)) {
  if (/^clawd-\d{4}-\d{2}-\d{2}T.*\.sqlite$/.test(file) && Date.now() - statSync(join(directory, file)).mtimeMs > 14 * 86400000) unlinkSync(join(directory, file));
}
console.log('SQLite backup verified');
