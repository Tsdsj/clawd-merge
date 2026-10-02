// Optional real workerd/D1 check, without adding a project dependency.
// MINIFLARE_MODULE=/path/to/node_modules/miniflare node leaderboard/test/d1-receipts.integration.mjs
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mergeChallengeStatements } from '../src/challenges.js';
import { collectReport, cleanupStatements } from '../ops/report.mjs';

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
  modulesRoot: fileURLToPath(new URL('../../', import.meta.url)),
  modules: ['leaderboard/src/index.js','leaderboard/src/challenges.js','src/rules.js'].map(path=>({type:'ESModule',path:fileURLToPath(new URL('../../'+path,import.meta.url))})),
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
  const challenge=(await api('/api/challenges/today',{token})).data.challenge;
  const intent={challengeId:challenge.challengeId,rulesVersion:challenge.rulesVersion,requestId:crypto.randomUUID()};
  const issues=await Promise.all(Array.from({length:8},()=>api('/api/challenges/session',{token,body:intent})));
  for(const r of issues){assert.equal(r.status,200);assert.deepEqual(r.data.session,issues[0].data.session);}
  assert.equal((await api('/api/challenges/today',{token})).data.allowance.remaining,2);
  const extra=await Promise.all(Array.from({length:6},()=>api('/api/challenges/session',{token,body:{...intent,requestId:crypto.randomUUID()}})));
  assert.equal(extra.filter(r=>r.status===200).length,2);
  assert.equal((await api('/api/challenges/today',{token})).data.allowance.remaining,0);
  const ticket=issues[0].data.session;
  await db.prepare('UPDATE challenge_sessions SET started_at=started_at-10000 WHERE id=?').bind(ticket.sessionId).run();
  const dailyBody={mode:'formal',sessionId:ticket.sessionId,challengeId:ticket.challengeId,rulesVersion:ticket.rulesVersion,score:80,drops:10,maxLevel:5,clawsUsed:0,settlingMs:0,reason:'danger'};
  const dailyResults=await Promise.all(Array.from({length:8},()=>api('/api/challenges/score',{token,body:dailyBody})));
  for(const r of dailyResults){assert.equal(r.status,200);assert.deepEqual(r.data,dailyResults[0].data);}
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM challenge_scores').first()).n,1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM challenge_bests').first()).n,1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM scores').first()).n,2);
  assert.equal((await api('/api/challenges/score',{token,body:{...dailyBody,score:81}})).status,409);
  const spare=extra.find(r=>r.status===200).data.session;
  await db.prepare('UPDATE challenge_sessions SET started_at=started_at-10000 WHERE id=?').bind(spare.sessionId).run();
  await db.prepare("CREATE TRIGGER fail_daily BEFORE INSERT ON challenge_bests BEGIN SELECT RAISE(ABORT,'isolated daily rollback'); END").run();
  assert.equal((await api('/api/challenges/score',{token,body:{...dailyBody,sessionId:spare.sessionId,score:100}})).status,500);
  assert.equal((await db.prepare('SELECT used FROM challenge_sessions WHERE id=?').bind(spare.sessionId).first()).used,0);
  await db.prepare('DROP TRIGGER fail_daily').run();
  assert.equal((await api('/api/challenges/score',{token,body:{...dailyBody,sessionId:spare.sessionId,score:100}})).status,200);
  const target=(await api('/api/register',{body:{name:'D1合并目标'}})).data;
  const targetSession=(await api('/api/challenges/session',{token:target.token,body:{...intent,requestId:crypto.randomUUID()}})).data.session;
  await db.prepare('UPDATE challenge_sessions SET started_at=started_at-10000 WHERE id=?').bind(targetSession.sessionId).run();
  assert.equal((await api('/api/challenges/score',{token:target.token,body:{...dailyBody,sessionId:targetSession.sessionId,score:50}})).status,200);
  await db.batch(mergeChallengeStatements(db,target.player.id,registered.data.player.id));
  const budget=(await api('/api/challenges/today',{token:target.token})).data.allowance;
  assert.equal(budget.used,4);assert.equal(budget.remaining,0);
  const mergedBoard=(await api('/api/challenges/leaderboard?challengeId='+challenge.challengeId,{token:target.token})).data;
  assert.equal(mergedBoard.total,1);assert.equal(mergedBoard.me.best,100);
  assert.deepEqual((await api('/api/challenges/score',{token:target.token,body:dailyBody})).data,dailyResults[0].data);
  // T12 aggregates and bounded cleanup execute against the real D1 engine too.
  const observed=Date.now()+1;
  await db.prepare('INSERT INTO sessions(id,player_id,started_at,used) VALUES(?,?,?,0)').bind('ops-expired',target.player.id,observed-28*3600000).run();
  await db.prepare('INSERT INTO login_codes(code_hash,player_id,created_at) VALUES(?,?,0)').bind('ops-expired-code',target.player.id).run();
  const report=await collectReport(async sql=>{const r=await db.prepare(sql).all();return {rows:r.results,meta:r.meta};},{from:observed-3600000,to:observed,asOf:observed,source:'isolated-d1'});
  assert.equal(report.classic.accepted,2);assert.equal(report.daily.issued,4);assert.equal(report.daily.accepted,3);assert.equal(report.daily.cohortAcceptedRatio,.75);
  assert.equal(report.cleanup.login_codes,1);assert.equal(report.cleanup.sessions,1);
  for(const statement of cleanupStatements(report))await db.prepare(statement.sql).run();
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM sessions WHERE id=?').bind('ops-expired').first()).n,0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM score_receipts').first()).n,2);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM challenge_sessions').first()).n,4);
  assert.equal((await api('/api/challenges/today',{token:target.token})).data.allowance.used,4);
  assert.deepEqual((await api('/api/score',{token,body})).data,results[0].data);
  assert.deepEqual((await api('/api/challenges/score',{token:target.token,body:dailyBody})).data,dailyResults[0].data);
  console.log('PASS: operations aggregates count credentials/receipts once; bounded cleanup preserves classic/daily replay and quota.');
  console.log('PASS: D1 identity merge combines quota and best scores; original acceptance receipt remains immutable.');
  console.log('PASS: challenge D1 — 8 identical starts spend once, concurrent distinct starts capped at 3, 8 score replays accepted once, classic isolated, failed result rolls back.');
  console.log(
    'PASS: isolated workerd/D1 — 8 concurrent identical requests accepted once, conflicts rejected, cleanup replay stable, failed transaction rolls back and retries.',
  );
} finally {
  await mf.dispose();
}
