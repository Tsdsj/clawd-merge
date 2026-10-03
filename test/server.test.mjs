import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createD1 } from '../leaderboard/test/d1-mock.mjs';

const sqliteModule = new URL('../server/sqlite.mjs', import.meta.url);
const httpModule = new URL('../server/http.mjs', import.meta.url);
const modules = async () => ({ ...(await import(sqliteModule)), ...(await import(httpModule)) });
const migrations = new URL('../leaderboard/migrations/', import.meta.url);

function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'clawd-server-'));
  t.after(() => rmSync(dir, { recursive: true }));
  return join(dir, 'game.sqlite');
}

test('production SQLite persists data and applies each migration only once across restarts', async t => {
  const { openDatabase } = await modules();
  const path = temporary(t);
  let db = openDatabase(path);
  await db.prepare("INSERT INTO rate_limits VALUES ('durable', 1, 2)").run();
  db.close();
  db = openDatabase(path);
  assert.equal((await db.prepare("SELECT count FROM rate_limits WHERE key='durable'").first()).count, 2);
  assert.equal((await db.prepare('SELECT count(*) n FROM app_migrations').first()).n, 4);
  db.close();
});

test('production SQLite adopts exported D1 migration history without reapplying ALTER statements', async t => {
  const { openDatabase } = await modules();
  const path = temporary(t);
  const old = createD1(path);
  old.raw.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
  for (const name of readdirSync(migrations).filter(x => x.endsWith('.sql')).sort()) {
    old.raw.prepare('INSERT INTO d1_migrations(name) VALUES (?)').run(name);
  }
  old.raw.exec("INSERT INTO rate_limits VALUES ('existing', 1, 3)");
  old.raw.close();
  const db = openDatabase(path);
  assert.equal((await db.prepare("SELECT count FROM rate_limits WHERE key='existing'").first()).count, 3);
  assert.equal((await db.prepare('SELECT count(*) n FROM app_migrations').first()).n, 4);
  db.close();
});

test('SQLite batch rolls back all dependent statements on constraint failure', async t => {
  const { openDatabase } = await modules();
  const db = openDatabase(temporary(t));
  await assert.rejects(db.batch([
    db.prepare("INSERT INTO rate_limits VALUES ('atomic',1,1)"),
    db.prepare("INSERT INTO rate_limits VALUES ('atomic',1,2)"),
  ]));
  assert.equal(await db.prepare("SELECT * FROM rate_limits WHERE key='atomic'").first(), null);
  db.close();
});

test('real HTTP API registers, issues a ticket and keeps identity and score after server restart', async t => {
  const { openDatabase, createApiServer } = await modules();
  const file = temporary(t);
  const env = { PUBLIC_ORIGIN: 'https://game.example.test', ALLOWED_ORIGINS: 'https://game.example.test', GAME_URL: 'https://game.example.test/' };
  const start = async () => {
    const db = openDatabase(file);
    const server = createApiServer({ ...env, DB: db });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { db, server, base: `http://127.0.0.1:${server.address().port}` };
  };
  let app = await start();
  const close = async () => { await new Promise(resolve => app.server.close(resolve)); app.db.close(); };
  t.after(close);
  const call = async (path, body, token) => {
    const res = await fetch(app.base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const guest = await call('/api/register', { name: '持久游客' });
  assert.equal(guest.status, 201);
  const session = await call('/api/session', {}, guest.data.token);
  assert.equal(session.status, 200);
  const result = await call('/api/score', { sessionId: session.data.sessionId, score: 20, drops: 1, maxLevel: 2 }, guest.data.token);
  assert.equal(result.status, 200);
  await close();
  app = await start();
  const me = await call('/api/me', undefined, guest.data.token);
  assert.equal(me.status, 200);
  assert.equal(me.data.best, 20);
  assert.equal(me.data.player.id, guest.data.player.id);
  const replay = await call('/api/score', { sessionId: session.data.sessionId, score: 20, drops: 1, maxLevel: 2 }, guest.data.token);
  assert.deepEqual(replay.data, result.data);
  assert.equal((await call('/api/me', undefined, guest.data.token)).data.games, 1);
});

test('HTTP adapter fixes public origin, bounds bodies and does not accept forged Cloudflare IP headers', async t => {
  const { createApiServer } = await modules();
  const requests = [];
  const worker = { async fetch(request) { requests.push(request); return Response.json({ ok: true }); } };
  const server = createApiServer({ PUBLIC_ORIGIN: 'https://game.example.test' }, { worker, maxBodyBytes: 32 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health=await fetch(base + '/api/health', { headers: { 'cf-connecting-ip': '1.2.3.4', 'x-real-ip': '5.6.7.8', 'x-forwarded-proto': 'http' } });
  assert.equal(health.status,200);
  assert.equal(health.headers.get('Cache-Control'),'no-store');
  assert.equal(requests[0].url, 'https://game.example.test/api/health');
  assert.equal(requests[0].headers.get('cf-connecting-ip'), '127.0.0.1');
  assert.equal((await fetch(base + '/api/register', { method: 'POST', body: 'x'.repeat(40) })).status, 413);
  assert.equal(requests.length, 1);
  assert.equal((await fetch(base + '/.env')).status, 404);
});
