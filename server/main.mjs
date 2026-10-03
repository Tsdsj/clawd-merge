import { readFileSync } from 'node:fs';
import { openDatabase } from './sqlite.mjs';
import { createApiServer } from './http.mjs';
import { configurePasswordAuth } from './password-config.mjs';

process.umask(0o077);
const secret = process.env.LINUXDO_CLIENT_SECRET_FILE
  ? readFileSync(process.env.LINUXDO_CLIENT_SECRET_FILE, 'utf8').trim()
  : process.env.LINUXDO_CLIENT_SECRET;
if (!secret || !process.env.LINUXDO_CLIENT_ID) throw new Error('LINUX DO credentials must be configured');
const db = openDatabase(process.env.DB_FILE || '/data/clawd.sqlite');
const env = {
  DB: db,
  PASSWORD_AUTH: configurePasswordAuth(db),
  PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN,
  GAME_URL: process.env.GAME_URL || `${process.env.PUBLIC_ORIGIN}/`,
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || process.env.PUBLIC_ORIGIN,
  TRUST_PROXY: process.env.TRUST_PROXY || '0',
  ACCOUNT_BINDING_ENABLED: process.env.ACCOUNT_BINDING_ENABLED==='1'?'1':'0',
  LINUXDO_CLIENT_ID: process.env.LINUXDO_CLIENT_ID,
  LINUXDO_CLIENT_SECRET: secret,
  LINUXDO_MIN_TRUST_LEVEL: process.env.LINUXDO_MIN_TRUST_LEVEL || '0',
  BLOCKED_WORDS: process.env.BLOCKED_WORDS || '',
};
const server = createApiServer(env);
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Clawd API ready'));
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => { server.closeAllConnections(); }, 20_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
