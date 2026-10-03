// Optional real workerd/D1 check, without adding a project dependency.
// MINIFLARE_MODULE=/path/to/node_modules/miniflare node leaderboard/test/d1-receipts.integration.mjs
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mergeChallengeStatements } from '../src/challenges.js';
import { collectReport, cleanupStatements } from '../ops/report.mjs';

const require = createRequire(import.meta.url);
const modulePath = process.env.MINIFLARE_MODULE;
if (!modulePath) throw new Error('Set MINIFLARE_MODULE to an installed Miniflare package directory');
const { Miniflare, convertV4MiniflareOptions } = require(modulePath);
// Only loopback fixture endpoints; no real provider or credential is used.
const oauth = createServer(async (req, res) => {
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const code=req.url==='/token'?new URLSearchParams(Buffer.concat(chunks).toString()).get('code'):String(req.headers.authorization||'').replace('Bearer ','');
  const id=Number(String(code).split(':')[0]);
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify(req.url==='/token'?{access_token:code}:{id,username:`member_${id}`,active:true,silenced:false,trust_level:1}));
});
await new Promise(resolve=>oauth.listen(0,'127.0.0.1',resolve));oauth.unref();
const oauthOrigin=`http://127.0.0.1:${oauth.address().port}`;
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
  bindings: { ALLOWED_ORIGINS: '*', BLOCKED_WORDS: '', GAME_URL:'https://game.example.test/',
    LINUXDO_CLIENT_ID:'fixture',LINUXDO_CLIENT_SECRET:'fixture',LINUXDO_TOKEN_URL:oauthOrigin+'/token',LINUXDO_USER_URL:oauthOrigin+'/user' },
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
  let ipCounter=0;
  async function api(path, { token, body, ip } = {}) {
    const response = await mf.dispatchFetch(`http://localhost${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP':ip||`198.51.100.${++ipCounter}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  }
  const registered = await api('/api/register', { body: { name: 'D1隔离验证' } });
  assert.equal(registered.status, 201);
  const token = registered.data.token;
  const legacyEmpty=await mf.dispatchFetch('http://localhost/api/session',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:''});
  assert.equal(legacyEmpty.status,200);assert.ok((await legacyEmpty.json()).sessionId);
  const sessionId = (await api('/api/session', { token, body: {mode:'classic'} })).data.sessionId;
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

  for(let round=0;round<2;round++) {
    if(round)await db.prepare("UPDATE rate_limits SET window_start=? WHERE key='register:a01-limit'").bind(Date.now()-3600_001).run();
    const registrations=await Promise.all(Array.from({length:12},(_,i)=>api('/api/register',{ip:'a01-limit',body:{name:`限流${i}`}})));
    assert.equal(registrations.filter(r=>r.status===201).length,5);
    assert.equal(registrations.filter(r=>r.status===429).length,7);
    assert.equal((await db.prepare("SELECT count FROM rate_limits WHERE key='register:a01-limit'").first()).count,5);
  }
  async function beginLogin(id,guestToken) {
    const start=await api('/api/auth/linuxdo/start',{token:guestToken,body:{returnTo:'https://game.example.test/'}});
    assert.equal(start.status,200);
    const state=new URL(start.data.url).searchParams.get('state');
    return async()=>{
      const response=await mf.dispatchFetch(`http://localhost/api/auth/linuxdo/callback?code=${id}:${crypto.randomUUID()}&state=${state}`,{redirect:'manual'});
      const hash=new URLSearchParams(new URL(response.headers.get('Location')).hash.slice(1));
      if(hash.has('login_error'))return {error:hash.get('login_error')};
      const result=await api('/api/auth/exchange',{body:{code:hash.get('login')}});
      assert.equal(result.status,200);return result.data;
    };
  }
  const initial=await Promise.all(Array.from({length:6},()=>beginLogin(887)));
  const accounts=await Promise.all(initial.map(f=>f()));
  assert.ok(accounts.every(x=>!x.error));assert.equal(new Set(accounts.map(x=>x.player.id)).size,1);
  const owner=accounts[0];const guest=(await api('/api/register',{body:{name:'合并验证'}})).data;
  const renamed=await api('/api/rename',{token:guest.token,body:{name:'改名验证'}});
  assert.equal(renamed.status,200);assert.equal(renamed.data.player.name,'改名验证');
  await db.prepare('UPDATE players SET best_score=300,best_level=7,best_at=1000,games=1 WHERE id=?').bind(owner.player.id).run();
  await db.prepare('UPDATE players SET best_score=200,best_level=6,best_at=900,games=1 WHERE id=?').bind(guest.player.id).run();
  await db.prepare('INSERT INTO challenge_allowances VALUES (?,?,?)').bind(challenge.challengeId,guest.player.id,2).run();
  await db.prepare('INSERT INTO challenge_allowances VALUES (?,?,?)').bind(challenge.challengeId,owner.player.id,1).run();
  const starts=await Promise.all(Array.from({length:6},()=>beginLogin(887,guest.token)));
  const merged=await Promise.all(starts.map(f=>f()));assert.ok(merged.every(x=>!x.error&&x.player.id===owner.player.id));
  const result=(await api('/api/me',{token:owner.token})).data;
  assert.equal(result.best,300);assert.equal(result.games,2);
  assert.equal((await db.prepare('SELECT used FROM challenge_allowances WHERE player_id=?').bind(owner.player.id).first()).used,3);
  const failedGuest=(await api('/api/register',{body:{name:'回滚验证'}})).data;
  await db.prepare('UPDATE players SET best_score=500,best_level=8,best_at=800,games=1 WHERE id=?').bind(failedGuest.player.id).run();
  await db.prepare("CREATE TRIGGER a01_reject_delete BEFORE DELETE ON players BEGIN SELECT RAISE(ABORT,'A01 rollback fixture'); END").run();
  assert.ok((await (await beginLogin(887,failedGuest.token))()).error);
  assert.equal((await api('/api/me',{token:owner.token})).data.best,300);
  assert.equal((await api('/api/me',{token:failedGuest.token})).data.player.id,failedGuest.player.id);
  await db.prepare('DROP TRIGGER a01_reject_delete').run();
  const ranked=await Promise.all(['同分前','同分后'].map(name=>api('/api/register',{body:{name}}).then(x=>x.data)));
  ranked.sort((a,b)=>a.player.id<b.player.id?-1:1);
  for(const p of ranked)await db.prepare('UPDATE players SET best_score=900,best_level=8,best_at=500 WHERE id=?').bind(p.player.id).run();
  const board=(await api('/api/leaderboard')).data.entries;
  assert.deepEqual(board.slice(0,2).map(x=>x.id),ranked.map(x=>x.player.id));
  for(const [i,p] of ranked.entries())assert.equal((await api('/api/me',{token:p.token})).data.rank,i+1);
  const rankingSession=(await api('/api/session',{body:{},token:ranked[1].token})).data.sessionId;
  assert.equal((await api('/api/score',{token:ranked[1].token,body:{sessionId:rankingSession,score:1,drops:1,maxLevel:1}})).data.rank,2);
  console.log('PASS: A01 real D1 atomic limits, concurrent account creation/guest merging, quota, rollback and stable ranks.');
} finally {
  await mf.dispose();
  await new Promise(resolve=>oauth.close(resolve));
}
