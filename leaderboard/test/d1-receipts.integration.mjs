// Optional real workerd/D1 check, without adding a project dependency.
// MINIFLARE_MODULE=/path/to/node_modules/miniflare node leaderboard/test/d1-receipts.integration.mjs
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const modulePath = process.env.MINIFLARE_MODULE;
if (!modulePath) throw new Error('Set MINIFLARE_MODULE to an installed Miniflare package directory');
const { Miniflare, convertV4MiniflareOptions } = require(modulePath);
const compatibilityDate = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').match(
  /compatibility_date\s*=\s*"([^"]+)"/,
)[1];
const options = {
  name: 'clawd-receipts-integration',
  host: '127.0.0.1',
  port: 0,
  modules: true,
  scriptPath: fileURLToPath(new URL('../src/index.js', import.meta.url)),
  compatibilityDate,
  d1Databases: { DB: 'isolated-receipt-test' },
  d1Persist: false,
  cf: false,
  bindings: { ALLOWED_ORIGINS: '*', BLOCKED_WORDS: '' },
};
const normalized = convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options;
if (convertV4MiniflareOptions) normalized.telemetry = { enabled: false };
const mf = new Miniflare(normalized);

try {
  const db = await mf.getD1Database('DB');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(new URL(file, migrations), 'utf8').replace(/--[^\n]*/g, '');
    for (const statement of sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(statement).run();
  }
  async function api(path, { token, body } = {}) {
    const response = await mf.dispatchFetch(`http://localhost${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  }
  const registered = await api('/api/register', { body: { name: 'D1隔离验证' } });
  assert.equal(registered.status, 201);
  const token = registered.data.token;
  const sessionId = (await api('/api/session', { token, body: {} })).data.sessionId;
  const body = { sessionId, score: 30, drops: 1, maxLevel: 3 };
  const results = await Promise.all(Array.from({ length: 8 }, () => api('/api/score', { token, body })));
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, results[0].data);
  }
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM scores').first()).n, 1);
  assert.equal((await db.prepare('SELECT games FROM players').first()).games, 1);
  assert.equal((await api('/api/score', { token, body: { ...body, score: 31 } })).status, 409);
  const next = (await api('/api/session', { token, body: {} })).data.sessionId;
  assert.deepEqual((await api('/api/score', { token, body })).data, results[0].data);

  await db
    .prepare(
      "CREATE TRIGGER fail_score BEFORE INSERT ON scores BEGIN SELECT RAISE(ABORT, 'isolated rollback test'); END",
    )
    .run();
  const failed = await api('/api/score', {
    token,
    body: { sessionId: next, score: 40, drops: 1, maxLevel: 3 },
  });
  assert.equal(failed.status, 500);
  assert.equal((await db.prepare('SELECT used FROM sessions WHERE id = ?').bind(next).first()).used, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM score_receipts').first()).n, 1);
  await db.prepare('DROP TRIGGER fail_score').run();
  assert.equal(
    (await api('/api/score', { token, body: { sessionId: next, score: 40, drops: 1, maxLevel: 3 } })).status,
    200,
  );
  assert.equal((await db.prepare('SELECT games FROM players').first()).games, 2);
  console.log(
    'PASS: isolated workerd/D1 — 8 concurrent identical requests accepted once, conflicts rejected, cleanup replay stable, failed transaction rolls back and retries.',
  );
} finally {
  await mf.dispose();
}
