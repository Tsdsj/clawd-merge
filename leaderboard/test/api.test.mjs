// API tests for the leaderboard Worker. Run: node --test 'leaderboard/test/*.test.mjs'
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createD1 } from './d1-mock.mjs';
import { openDatabase } from '../../server/sqlite.mjs';

const GAME = 'https://tsdsj.github.io/clawd-merge/';
let env;
let ipCounter = 0;

// ---- fake LINUX DO Connect ----
const LD = { token: 'https://ld.test/oauth2/token', user: 'https://ld.test/api/user' };
let ldUsers; // code -> LINUX DO user payload
const realFetch = globalThis.fetch;

beforeEach(() => {
  env = {
    DB: process.env.CLAWD_TEST_DATABASE === 'production-sqlite' ? openDatabase(':memory:') : createD1(),
    ALLOWED_ORIGINS: 'https://tsdsj.github.io',
    GAME_URL: GAME,
    BLOCKED_WORDS: '坏词',
    LINUXDO_CLIENT_ID: 'client-id',
    LINUXDO_CLIENT_SECRET: 'client-secret',
    LINUXDO_AUTHORIZE_URL: 'https://ld.test/oauth2/authorize',
    LINUXDO_TOKEN_URL: LD.token,
    LINUXDO_USER_URL: LD.user,
  };
  ldUsers = new Map();
  globalThis.fetch = async (url, init = {}) => {
    if (url === LD.token) {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('client_secret'), 'client-secret');
      assert.equal(body.get('redirect_uri'), 'https://api.test/api/auth/linuxdo/callback');
      const user = ldUsers.get(body.get('code'));
      return Response.json(user ? { access_token: `at-${body.get('code')}` } : { error: 'invalid_grant' }, {
        status: user ? 200 : 400,
      });
    }
    if (url === LD.user) {
      const code = init.headers.Authorization.replace('Bearer at-', '');
      return Response.json(ldUsers.get(code));
    }
    return realFetch(url, init);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  env.DB.raw.close();
});

async function call(method, path, { body, token, ip, origin } = {}) {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip ?? `10.0.0.${++ipCounter}` };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  const res = await worker.fetch(
    new Request(`https://api.test${path}`, { method, headers, body: body && JSON.stringify(body) }),
    env,
  );
  const data = res.status === 204 || res.status === 302 ? null : await res.json();
  return { status: res.status, headers: res.headers, data };
}

const register = async (name) => (await call('POST', '/api/register', { body: { name } })).data;

// Plays a game "for real": starts a session, waits `seconds` of fake time, submits.
async function play(token, { score, drops, maxLevel = 5, seconds }) {
  const { data } = await call('POST', '/api/session', { token });
  const realNow = Date.now;
  const start = realNow();
  Date.now = () => start + (seconds ?? drops) * 1000;
  try {
    return await call('POST', '/api/score', { token, body: { sessionId: data.sessionId, score, drops, maxLevel } });
  } finally {
    Date.now = realNow;
  }
}

// Full LINUX DO login: start → (user approves) → callback → exchange.
async function linuxdoLogin(user, { guestToken, returnTo = `${GAME}?x=1` } = {}) {
  const start = await call('POST', '/api/auth/linuxdo/start', { token: guestToken, body: { returnTo } });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const authorize = new URL(start.data.url);
  const code = `code-${Math.random()}`;
  ldUsers.set(code, { active: true, silenced: false, trust_level: 2, ...user });
  const cb = await call(
    'GET',
    `/api/auth/linuxdo/callback?code=${encodeURIComponent(code)}&state=${authorize.searchParams.get('state')}`,
  );
  assert.equal(cb.status, 302);
  const location = new URL(cb.headers.get('Location'));
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('login_error')) return { error: hash.get('login_error'), location };
  const exchanged = await call('POST', '/api/auth/exchange', { body: { code: hash.get('login') } });
  assert.equal(exchanged.status, 200);
  return { ...exchanged.data, location, authorize, loginCode: hash.get('login') };
}

// ---------- guests ----------

test('A01: concurrent registration respects the initial and expired fixed windows', async t => {
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const attempt=()=>Promise.all(Array.from({length:12},(_,i)=>call('POST','/api/register',{ip:'rate-race',body:{name:`窗口${i}`}})));
  for(let round=0;round<2;round++) {
    const responses=await attempt();
    assert.equal(responses.filter(r=>r.status===201).length,5);
    assert.equal(responses.filter(r=>r.status===429).length,7);
    assert.ok(responses.filter(r=>r.status===429).every(r=>Number(r.headers.get('Retry-After'))===3600));
    assert.equal(env.DB.raw.prepare("SELECT count FROM rate_limits WHERE key='register:rate-race'").get().count,5);
    now+=3600_000;
  }
  env.DB.raw.prepare('INSERT INTO rate_limits VALUES (?,?,?)').run('register:partial-window',now-1000,4);
  const partial=await Promise.all(Array.from({length:12},(_,i)=>call('POST','/api/register',{ip:'partial-window',body:{name:`余量${i}`}})));
  assert.equal(partial.filter(r=>r.status===201).length,1);
  assert.ok(partial.filter(r=>r.status===429).every(r=>r.headers.get('Retry-After')==='3599'));
  assert.equal((await call('POST','/api/register',{ip:'another-ip',body:{name:'独立窗口'}})).status,201);
});

test('A01: equal timestamps use the same stable order in list, personal rank and new receipt',async t=>{
  t.mock.method(Date,'now',()=>2_000_000_000_000);
  const players=await Promise.all(['同分甲','同分乙'].map(register));
  players.sort((a,b)=>a.player.id<b.player.id?-1:1);
  // Put the later ID first, then create the earlier ID's equal-score receipt.
  await play(players[1].token,{score:100,drops:1,seconds:0});
  const first=await play(players[0].token,{score:100,drops:1,seconds:0});
  assert.equal(first.data.rank,1);
  const board=(await call('GET','/api/leaderboard')).data.entries;
  assert.deepEqual(board.map(p=>p.id),players.map(p=>p.player.id));
  for(const [index,p] of players.entries())assert.equal((await call('GET','/api/me',{token:p.token})).data.rank,index+1);
  const secondReceipt=await play(players[1].token,{score:1,drops:1,seconds:0});
  assert.equal(secondReceipt.data.rank,2);
  const original=env.DB.raw.prepare('SELECT session_id FROM score_receipts WHERE player_id=? AND score=100').get(players[1].player.id);
  const replay=await call('POST','/api/score',{token:players[1].token,body:{sessionId:original.session_id,score:100,drops:1,maxLevel:5}});
  assert.equal(replay.data.rank,1); // Historical receipt remains an immutable snapshot.
});

for(const changed of ['target','guest'])test(`A01: merge reads the current ${changed} score inside its transaction`,async t=>{
  const user={id:991,username:'atomic_member'};
  const account=await linuxdoLogin(user),guest=await register('事务游客');
  await play(account.token,{score:100,drops:1});await play(guest.token,{score:200,drops:1});
  const session=(await call('POST','/api/session',{token:changed==='target'?account.token:guest.token})).data.sessionId;
  const batch=env.DB.batch.bind(env.DB);let injected=false;
  t.mock.method(env.DB,'batch',async statements=>{
    if(!injected&&statements.some(s=>s.sql.includes('UPDATE scores SET player_id'))) {
      injected=true;
      const result=await call('POST','/api/score',{token:changed==='target'?account.token:guest.token,body:{sessionId:session,score:300,drops:1,maxLevel:7}});
      assert.equal(result.status,200);
    }
    return batch(statements);
  });
  const login=await linuxdoLogin(user,{guestToken:guest.token});
  assert.equal(login.error,undefined);assert.equal(injected,true);
  const me=(await call('GET','/api/me',{token:account.token})).data;
  assert.equal(me.best,300);assert.equal(me.bestLevel,7);assert.equal(me.games,3);
});

test('A01: concurrent callbacks merge one guest once and preserve the earliest tied best',async()=>{
  const user={id:992,username:'once_member'};
  const account=await linuxdoLogin(user),guest=await register('只合并一次');
  await play(account.token,{score:200,drops:1});await play(guest.token,{score:200,drops:1,maxLevel:8});
  env.DB.raw.prepare('UPDATE players SET best_at=? WHERE id=?').run(1000,guest.player.id);
  env.DB.raw.prepare('UPDATE players SET best_at=? WHERE id=?').run(2000,account.player.id);
  env.DB.raw.prepare('INSERT INTO challenge_allowances VALUES (?,?,?)').run('fixture-day',guest.player.id,2);
  env.DB.raw.prepare('INSERT INTO challenge_allowances VALUES (?,?,?)').run('fixture-day',account.player.id,1);
  const results=await Promise.all(Array.from({length:6},()=>linuxdoLogin(user,{guestToken:guest.token})));
  assert.ok(results.every(r=>!r.error));
  const row=env.DB.raw.prepare('SELECT * FROM players WHERE id=?').get(account.player.id);
  assert.equal(row.games,2);assert.equal(row.best_at,1000);assert.equal(row.best_level,8);
  assert.equal(env.DB.raw.prepare('SELECT used FROM challenge_allowances WHERE player_id=?').get(account.player.id).used,3);
  assert.equal(env.DB.raw.prepare('SELECT count(*) n FROM players').get().n,1);
});

test('A01: simultaneous first Linux.do sign-ins converge on one account without doubling guest quota',async()=>{
  const guest=await register('首次绑定');
  env.DB.raw.prepare('INSERT INTO challenge_allowances VALUES (?,?,?)').run('fixture-day',guest.player.id,2);
  const results=await Promise.all(Array.from({length:6},()=>linuxdoLogin({id:993,username:'first_member'},{guestToken:guest.token})));
  assert.ok(results.every(r=>!r.error));
  assert.equal(new Set(results.map(r=>r.player.id)).size,1);
  assert.equal(results[0].player.id,guest.player.id);
  assert.equal(env.DB.raw.prepare('SELECT used FROM challenge_allowances WHERE player_id=?').get(guest.player.id).used,2);
});

test('A01: simultaneous anonymous OAuth sign-ins create exactly one provider account',async()=>{
  const results=await Promise.all(Array.from({length:6},()=>linuxdoLogin({id:995,username:'new_member'})));
  assert.ok(results.every(r=>!r.error));
  assert.equal(new Set(results.map(r=>r.player.id)).size,1);
  assert.equal(env.DB.raw.prepare('SELECT count(*) n FROM players').get().n,1);
});

test('A01: failed merge rolls back profile, scores, ownership and quota together',async t=>{
  const user={id:994,username:'before_failure'};
  const account=await linuxdoLogin(user),guest=await register('回滚游客');
  await play(guest.token,{score:200,drops:1});
  env.DB.raw.exec("CREATE TRIGGER reject_guest_delete BEFORE DELETE ON players BEGIN SELECT RAISE(ABORT,'test rollback'); END");
  t.mock.method(console,'error',()=>{});
  const result=await linuxdoLogin({...user,username:'after_failure'},{guestToken:guest.token});
  assert.ok(result.error);
  const a=(await call('GET','/api/me',{token:account.token})).data;
  const g=(await call('GET','/api/me',{token:guest.token})).data;
  assert.equal(a.player.name,'before_failure');assert.equal(a.games,0);
  assert.equal(g.player.id,guest.player.id);assert.equal(g.best,200);
});

test('A01: a classic start cannot create an orphan ticket after its owner is merged away',async t=>{
  const guest=await register('开局交错');const batch=env.DB.batch.bind(env.DB);
  t.mock.method(env.DB,'batch',async statements=>{
    if(statements.some(s=>s.sql.includes('INSERT INTO sessions')))env.DB.raw.prepare('DELETE FROM players WHERE id=?').run(guest.player.id);
    return batch(statements);
  });
  const response=await call('POST','/api/session',{token:guest.token});
  assert.equal(response.status,409);assert.equal(response.data.error,'identity_changed');
  assert.equal(env.DB.raw.prepare('SELECT count(*) n FROM sessions').get().n,0);
});

test('A01: a pending guest rename cannot overwrite a newly bound Linux.do profile',async t=>{
  const guest=await register('改名交错');const batch=env.DB.batch.bind(env.DB);
  t.mock.method(env.DB,'batch',async statements=>{
    if(statements.some(s=>s.sql.startsWith('UPDATE players SET name')))env.DB.raw.prepare("UPDATE players SET linuxdo_id=999,name='bound_member',name_key='ld:999',tag=NULL WHERE id=?").run(guest.player.id);
    return batch(statements);
  });
  const response=await call('POST','/api/rename',{token:guest.token,body:{name:'不应覆盖'}});
  assert.equal(response.status,409);assert.equal(response.data.error,'identity_changed');
  assert.equal((await call('GET','/api/me',{token:guest.token})).data.player.name,'bound_member');
});

test('guest names may repeat and get distinct 4-digit tags', async () => {
  const a = await register('Clawd粉丝');
  const b = await register('clawd粉丝');
  assert.match(a.player.tag, /^\d{4}$/);
  assert.equal(b.player.name, 'clawd粉丝');
  assert.notEqual(a.player.tag + a.player.name.toLowerCase(), b.player.tag + b.player.name.toLowerCase());
  assert.equal(a.player.linuxdo, false);
  assert.ok(a.token.length > 30);
});

test('guest name validation', async () => {
  for (const name of ['a', '这个名字实在是太长了超过十二个字', 'has space', 'x<script>', '管理员', 'Anthropic', 'CLAWD', '我是坏词']) {
    const res = await call('POST', '/api/register', { body: { name } });
    assert.equal(res.status, 400, name);
  }
  const ok = await call('POST', '/api/register', { body: { name: '  小钳子_01  ' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.player.name, '小钳子_01'); // trimmed
});

test('guests can rename; the token keeps working', async () => {
  const a = await register('旧名字');
  const r = await call('POST', '/api/rename', { token: a.token, body: { name: '新名字' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.player.name, '新名字');
  const me = await call('GET', '/api/me', { token: a.token });
  assert.equal(me.data.player.name, '新名字');
  assert.equal((await call('POST', '/api/rename', { token: a.token, body: { name: '管理员' } })).status, 400);
});

// ---------- scores ----------

test('score flow: best score, rank and leaderboard order', async () => {
  const a = await register('阿甲');
  const b = await register('阿乙');
  assert.equal((await play(a.token, { score: 3000, drops: 100 })).data.rank, 1);
  const rb = await play(b.token, { score: 5000, drops: 100, maxLevel: 9 });
  assert.deepEqual(rb.data, { improved: true, best: 5000, rank: 1 });
  const worse = await play(b.token, { score: 100, drops: 20 });
  assert.deepEqual(worse.data, { improved: false, best: 5000, rank: 1 });

  const board = await call('GET', '/api/leaderboard?limit=10');
  assert.deepEqual(
    board.data.entries.map((e) => [e.rank, e.name, e.score, e.level, e.linuxdo]),
    [
      [1, '阿乙', 5000, 9, false],
      [2, '阿甲', 3000, 5, false],
    ],
  );
  assert.match(board.data.entries[0].tag, /^\d{4}$/);
  assert.equal(board.data.total, 2);
  const top1 = await call('GET', '/api/leaderboard?limit=1');
  assert.equal(top1.data.entries.length, 1);
  assert.equal(top1.data.total, 2); // total counts everyone ranked, not just this page
  const me = await call('GET', '/api/me', { token: a.token });
  assert.equal(me.data.rank, 2);
  assert.equal(me.data.games, 1);
});

// Hold one request immediately before its score transaction. A second device
// commits while the first still holds the player snapshot read at authentication.
for (const scenario of [
  { name: 'higher score commits first', delayed: 300, other: 600, initial: 0, improved: false },
  { name: 'lower score commits first', delayed: 600, other: 300, initial: 0, improved: true },
  { name: 'equal score preserves the first committed record', delayed: 600, other: 600, initial: 0, improved: false },
  { name: 'non-improving submission returns the current best', delayed: 100, other: 800, initial: 500, improved: false },
]) {
  test(`concurrent devices: ${scenario.name}`, { timeout: 5000 }, async (t) => {
    const a = await linuxdoLogin({ id: 12345, username: 'race_player' });
    const b = await linuxdoLogin({ id: 12345, username: 'race_player' });
    assert.notEqual(a.token, b.token);
    if (scenario.initial) await play(a.token, { score: scenario.initial, drops: 1 });
    const sessionA = (await call('POST', '/api/session', { token: a.token })).data.sessionId;
    const sessionB = (await call('POST', '/api/session', { token: b.token })).data.sessionId;
    let signalHeld;
    let release;
    const held = new Promise((resolve) => { signalHeld = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const batch = env.DB.batch.bind(env.DB);
    let intercepted = false;
    t.mock.method(env.DB, 'batch', async (statements) => {
      if (!intercepted && statements.some((s) => s.sql.includes('INSERT INTO scores'))) {
        intercepted = true;
        signalHeld();
        await gate;
      }
      return batch(statements);
    });
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const delayedAt = now;
    const pending = call('POST', '/api/score', { token: a.token,
      body: { sessionId: sessionA, score: scenario.delayed, drops: 1, maxLevel: 5 } });
    let first;
    try {
      await held;
      now += 100;
      first = await call('POST', '/api/score', { token: b.token,
        body: { sessionId: sessionB, score: scenario.other, drops: 1, maxLevel: 8 } });
    } finally {
      release();
    }
    const delayed = await pending;
    assert.equal(first.status, 200);
    assert.equal(delayed.status, 200);
    const expectedBest = Math.max(scenario.delayed, scenario.other);
    assert.deepEqual(delayed.data, { improved: scenario.improved, best: expectedBest, rank: 1 });
    const best = await env.DB.prepare('SELECT best_score, best_level, best_at, games FROM players WHERE id = ?').bind(a.player.id).first();
    assert.deepEqual({ ...best }, {
      best_score: expectedBest,
      best_level: scenario.improved ? 5 : 8,
      best_at: scenario.improved ? delayedAt : now,
      games: scenario.initial ? 3 : 2,
    });
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM scores WHERE player_id = ?').bind(a.player.id).first();
    assert.equal(n, best.games);
    const board = await call('GET', '/api/leaderboard');
    assert.equal(board.data.entries[0].score, expectedBest);
    assert.equal(board.data.entries[0].level, best.best_level);
  });
}

test('sessions require ownership and identical retries replay once', async () => {
  const a = await register('玩家一');
  const { data } = await call('POST', '/api/session', { token: a.token });
  const body = { sessionId: data.sessionId, score: 10, drops: 1, maxLevel: 2 };
  assert.equal((await call('POST', '/api/score', { token: a.token, body })).status, 200);
  assert.equal((await call('POST', '/api/score', { token: a.token, body })).status, 200);
  assert.equal((await call('POST', '/api/score', { token:a.token,body:{...body,score:11} })).status,409);
  const fake = { ...body, sessionId: 'made-up' };
  assert.equal((await call('POST', '/api/score', { token: a.token, body: fake })).data.error, 'bad_session');
  const b = await register('玩家二');
  const s2 = (await call('POST', '/api/session', { token: b.token })).data.sessionId;
  assert.equal((await call('POST', '/api/score', { token: a.token, body: { ...body, sessionId: s2 } })).status, 400);
});

test('accepted receipt survives response loss, session cleanup and expiry', async (t) => {
  const a=await register('补传验证');
  const sessionId=(await call('POST','/api/session',{token:a.token})).data.sessionId;
  const body={sessionId,score:30,drops:1,maxLevel:3};
  const first=await call('POST','/api/score',{token:a.token,body});
  assert.equal(first.status,200);
  await play(a.token,{score:60,drops:1}); // improves best and cleans used sessions
  const now=Date.now();t.mock.method(Date,'now',()=>now+4*3600_000);
  const replay=await call('POST','/api/score',{token:a.token,body});
  assert.equal(replay.status,200);assert.deepEqual(replay.data,first.data);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM scores').get().n,2);
  assert.equal((await call('GET','/api/me',{token:a.token})).data.games,2);
});

test('simultaneous identical submissions accept exactly once', async () => {
  const a=await register('并发补传');
  const sessionId=(await call('POST','/api/session',{token:a.token})).data.sessionId;
  const body={sessionId,score:30,drops:1,maxLevel:3};
  const results=await Promise.all(Array.from({length:5},()=>call('POST','/api/score',{token:a.token,body})));
  for(const r of results){assert.equal(r.status,200);assert.deepEqual(r.data,results[0].data);}
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM scores').get().n,1);
  assert.equal((await call('GET','/api/me',{token:a.token})).data.games,1);
});

test('a failed score transaction rolls back ticket consumption and can be retried', async (t) => {
  t.mock.method(console,'error',()=>{});
  const a=await register('回滚验证');
  const sessionId=(await call('POST','/api/session',{token:a.token})).data.sessionId;
  const body={sessionId,score:30,drops:1,maxLevel:3};
  env.DB.raw.exec("CREATE TRIGGER reject_score BEFORE INSERT ON scores BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.equal((await call('POST','/api/score',{token:a.token,body})).status,500);
  assert.equal(env.DB.raw.prepare('SELECT used FROM sessions WHERE id = ?').get(sessionId).used,0);
  env.DB.raw.exec('DROP TRIGGER reject_score');
  assert.equal((await call('POST','/api/score',{token:a.token,body})).status,200);
  assert.equal((await call('GET','/api/me',{token:a.token})).data.games,1);
});

test('rejected rules do not consume an otherwise valid session', async () => {
  const a=await register('校验重试');
  const sessionId=(await call('POST','/api/session',{token:a.token})).data.sessionId;
  assert.equal((await call('POST','/api/score',{token:a.token,body:{sessionId,score:100000,drops:1,maxLevel:3}})).status,422);
  assert.equal(env.DB.raw.prepare('SELECT used FROM sessions WHERE id = ?').get(sessionId).used,0);
});

test('accepted receipts follow an explicitly merged guest identity', async () => {
  const user={id:785,username:'receipt_owner'};
  await linuxdoLogin(user);
  const guest=await register('回执游客');
  const sessionId=(await call('POST','/api/session',{token:guest.token})).data.sessionId;
  const body={sessionId,score:30,drops:1,maxLevel:3};
  const first=await call('POST','/api/score',{token:guest.token,body});
  const account=await linuxdoLogin(user,{guestToken:guest.token});
  const replay=await call('POST','/api/score',{token:account.token,body});
  assert.equal(replay.status,200);assert.deepEqual(replay.data,first.data);
  assert.equal((await call('GET','/api/me',{token:account.token})).data.games,1);
});

test('restoring checks ticket ownership, expiry and usage without consuming or extending it', async () => {
  const a = await register('续玩甲'), b = await register('续玩乙');
  const { data } = await call('POST', '/api/session', { token:a.token });
  const path = `/api/session/check?sessionId=${data.sessionId}`;
  assert.equal((await call('GET', path)).status, 401);
  assert.equal((await call('GET', path, { token:b.token })).data.status, 'invalid');
  const first = await call('GET', path, { token:a.token });
  assert.equal(first.data.status, 'valid');
  assert.ok(first.data.expiresAt > first.data.serverNow);
  const again = await call('GET', path, { token:a.token });
  assert.equal(again.data.expiresAt, first.data.expiresAt);
  assert.equal((await call('POST', '/api/score', { token:a.token, body:{ sessionId:data.sessionId,score:20,drops:1,maxLevel:2 } })).status, 200);
  assert.equal((await call('GET', path, { token:a.token })).data.status, 'used');
  env.DB.raw.prepare('UPDATE sessions SET used = 0, started_at = ? WHERE id = ?').run(Date.now()-4*3600_000,data.sessionId);
  assert.equal((await call('GET', path, { token:a.token })).data.status, 'expired');
});

test('implausible scores are rejected', async () => {
  const a = await register('作弊者');
  assert.equal((await play(a.token, { score: 5000, drops: 200, seconds: 10 })).data.error, 'too_fast');
  assert.equal((await play(a.token, { score: 1_000_000, drops: 10 })).data.error, 'implausible');
  const bad = await call('POST', '/api/score', { token: a.token, body: { sessionId: 'x', score: -5, drops: 1, maxLevel: 1 } });
  assert.equal(bad.status, 400);
});

test('auth, logout, rate limits and CORS', async () => {
  assert.equal((await call('POST', '/api/session')).status, 401);
  assert.equal((await call('POST', '/api/session', { token: 'nope' })).status, 401);
  const a = await register('要退出的');
  assert.equal((await call('POST', '/api/logout', { token: a.token })).status, 200);
  assert.equal((await call('GET', '/api/me', { token: a.token })).status, 401);

  for (let i = 0; i < 5; i++) {
    assert.equal((await call('POST', '/api/register', { body: { name: `同IP${i}号` }, ip: '1.2.3.4' })).status, 201);
  }
  const limited = await call('POST', '/api/register', { body: { name: '同IP第六个' }, ip: '1.2.3.4' });
  assert.equal(limited.status, 429);

  const allowed = await call('GET', '/api/leaderboard', { origin: 'https://tsdsj.github.io' });
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'https://tsdsj.github.io');
  const other = await call('GET', '/api/leaderboard', { origin: 'https://evil.example' });
  assert.equal(other.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await call('OPTIONS', '/api/score', { origin: 'https://tsdsj.github.io' })).status, 204);
});

// ---------- LINUX DO login ----------

test('LINUX DO login creates an account; several devices can be signed in', async () => {
  const user = { id: 42, username: 'tsdsj', avatar_template: '/user_avatar/linux.do/tsdsj/{size}/1_2.png' };
  const phone = await linuxdoLogin(user);
  assert.equal(phone.authorize.searchParams.get('client_id'), 'client-id');
  assert.equal(phone.authorize.searchParams.get('redirect_uri'), 'https://api.test/api/auth/linuxdo/callback');
  assert.equal(phone.location.origin + phone.location.pathname, GAME);
  assert.equal(phone.location.search, '?x=1'); // back to the exact page
  assert.deepEqual(phone.player, {
    id: phone.player.id,
    name: 'tsdsj',
    tag: null,
    linuxdo: true,
    avatar: 'https://linux.do/user_avatar/linux.do/tsdsj/64/1_2.png',
    trustLevel: 2,
  });

  const laptop = await linuxdoLogin({ ...user, username: 'tsdsj-renamed', trust_level: 3 });
  assert.equal(laptop.player.id, phone.player.id); // same account
  assert.equal(laptop.player.name, 'tsdsj-renamed'); // name follows LINUX DO
  assert.equal((await call('GET', '/api/me', { token: phone.token })).status, 200);
  assert.equal((await call('GET', '/api/me', { token: laptop.token })).status, 200);

  // LINUX DO names can't be changed here; logging out one device keeps the other.
  assert.equal((await call('POST', '/api/rename', { token: phone.token, body: { name: '别的名字' } })).status, 400);
  await call('POST', '/api/logout', { token: phone.token });
  assert.equal((await call('GET', '/api/me', { token: phone.token })).status, 401);
  assert.equal((await call('GET', '/api/me', { token: laptop.token })).status, 200);

  const board = await play(laptop.token, { score: 900, drops: 20 });
  assert.equal(board.data.rank, 1);
  const entry = (await call('GET', '/api/leaderboard')).data.entries[0];
  assert.equal(entry.linuxdo, true);
  assert.equal(entry.tag, null);
});

test('a guest logging in keeps their scores (becomes the account)', async () => {
  const guest = await register('游客小明');
  await play(guest.token, { score: 3000, drops: 60, maxLevel: 8 });
  const login = await linuxdoLogin({ id: 7, username: 'xiaoming' }, { guestToken: guest.token });
  assert.equal(login.player.id, guest.player.id);
  const me = await call('GET', '/api/me', { token: guest.token }); // the old guest token still works
  assert.equal(me.data.player.name, 'xiaoming');
  assert.equal(me.data.player.linuxdo, true);
  assert.equal(me.data.best, 3000);
});

test('a guest logging into an existing account merges into it', async () => {
  const first = await linuxdoLogin({ id: 9, username: 'ld_user' });
  await play(first.token, { score: 1000, drops: 30 });
  const guest = await register('另一台手机');
  await play(guest.token, { score: 5000, drops: 80, maxLevel: 9 });
  await play(guest.token, { score: 200, drops: 10 });

  const login = await linuxdoLogin({ id: 9, username: 'ld_user' }, { guestToken: guest.token });
  assert.equal(login.player.id, first.player.id);
  const me = await call('GET', '/api/me', { token: first.token });
  assert.equal(me.data.best, 5000); // guest's better score wins
  assert.equal(me.data.bestLevel, 9);
  assert.equal(me.data.games, 3);
  assert.equal((await call('GET', '/api/me', { token: guest.token })).data.player.id, first.player.id);
  const names = (await call('GET', '/api/leaderboard')).data.entries.map((e) => e.name);
  assert.deepEqual(names, ['ld_user']); // the guest row is gone
});

test('OAuth safety: state, codes, redirects and blocked accounts', async () => {
  // Unknown state → back to the game with an error, no account made.
  const forged = await call('GET', '/api/auth/linuxdo/callback?code=x&state=forged');
  const forgedTo = new URL(forged.headers.get('Location'));
  assert.equal(forgedTo.origin + forgedTo.pathname, GAME);
  assert.ok(new URLSearchParams(forgedTo.hash.slice(1)).get('login_error'));

  // State and login codes are single use.
  const ok = await linuxdoLogin({ id: 1, username: 'once' });
  const replay = await call(
    'GET',
    `/api/auth/linuxdo/callback?code=x&state=${ok.authorize.searchParams.get('state')}`,
  );
  assert.ok(new URL(replay.headers.get('Location')).hash.includes('login_error'));
  assert.equal((await call('POST', '/api/auth/exchange', { body: { code: ok.loginCode } })).status, 400);

  // No open redirects.
  const evil = await call('POST', '/api/auth/linuxdo/start', { body: { returnTo: 'https://evil.example/steal' } });
  assert.equal(evil.status, 400);

  // Silenced accounts and a raised minimum trust level are refused.
  assert.match((await linuxdoLogin({ id: 2, username: 'muted', silenced: true })).error, /禁言/);
  env.LINUXDO_MIN_TRUST_LEVEL = '2';
  assert.match((await linuxdoLogin({ id: 3, username: 'newbie', trust_level: 1 })).error, /信任等级 2/);

  // Denied on the LINUX DO page → callback without a code.
  const start = await call('POST', '/api/auth/linuxdo/start', { body: { returnTo: GAME } });
  const state = new URL(start.data.url).searchParams.get('state');
  const denied = await call('GET', `/api/auth/linuxdo/callback?error=access_denied&state=${state}`);
  assert.match(decodeURIComponent(new URL(denied.headers.get('Location')).hash), /取消/);

  // Login is off until the secret is configured.
  delete env.LINUXDO_CLIENT_SECRET;
  assert.equal((await call('POST', '/api/auth/linuxdo/start', { body: { returnTo: GAME } })).status, 503);
});

// ---------- migration ----------

test('upgrading a pre-login database keeps old players working', async () => {
  const db = createD1(':memory:', { upTo: 1 }); // schema before LINUX DO login
  const oldToken = 'legacy-token';
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(oldToken).digest('hex');
  db.raw
    .prepare(
      'INSERT INTO players (id, name, name_key, token_hash, best_score, best_level, best_at, games, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run('p1', '老玩家', '老玩家', hash, 4200, 9, 1, 3, 1);
  db.migrate();
  env.DB = db;

  const me = await call('GET', '/api/me', { token: oldToken });
  assert.equal(me.status, 200);
  assert.equal(me.data.player.name, '老玩家');
  assert.match(me.data.player.tag, /^\d{4}$/);
  assert.equal(me.data.best, 4200);
  // The old name no longer blocks anyone.
  assert.equal((await call('POST', '/api/register', { body: { name: '老玩家' } })).status, 201);
});

test('guest binding combines daily allowance and best history without changing classic scores', async () => {
  const account = await linuxdoLogin({ id: 606060, username: 'daily_member' });
  const guest = await register('挑战游客');
  const definition = (await call('GET', '/api/challenges/today')).data.challenge;
  async function daily(token, score) {
    const start = await call('POST','/api/challenges/session',{token,body:{challengeId:definition.challengeId,rulesVersion:definition.rulesVersion,requestId:crypto.randomUUID()}});
    const s=start.data.session;
    env.DB.raw.prepare('UPDATE challenge_sessions SET started_at=started_at-10000 WHERE id=?').run(s.sessionId);
    return call('POST','/api/challenges/score',{token,body:{mode:'formal',sessionId:s.sessionId,challengeId:s.challengeId,rulesVersion:s.rulesVersion,score,drops:10,maxLevel:5,clawsUsed:0,settlingMs:0,reason:'danger'}});
  }
  assert.equal((await daily(account.token,50)).status,200);
  assert.equal((await daily(guest.token,100)).status,200);
  const merged=await linuxdoLogin({id:606060,username:'daily_member'},{guestToken:guest.token});
  const today=(await call('GET','/api/challenges/today',{token:merged.token})).data;
  assert.equal(today.allowance.used,2);assert.equal(today.allowance.remaining,1);
  const board=(await call('GET',`/api/challenges/leaderboard?challengeId=${definition.challengeId}`,{token:merged.token})).data;
  assert.equal(board.total,1);assert.equal(board.me.best,100);
  assert.equal((await call('GET','/api/me',{token:merged.token})).data.best,0);
});

test('classic session accepts legacy empty POST streams while rejecting malformed and challenge payloads',async()=>{
 const {token}=await register('空开局兼容');
 for(const body of ['', '   ', '{}']){
  const r=await worker.fetch(new Request('https://api.test/api/session',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body}),env);
  assert.equal(r.status,200);assert.ok((await r.json()).sessionId);
 }
 for(const body of ['{bad','null','[]','{"mode":"formal"}','{"challengeId":"2026-10-03"}']){
  const r=await worker.fetch(new Request('https://api.test/api/session',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body}),env);
  assert.equal(r.status,400,body);
 }
});

test('A03: register and rename use the same curated and separator-aware name policy', async()=>{
  for(const name of ['傻逼','傻-逼','賭博','f_u_c_k','官-方']) {
    const r=await call('POST','/api/register',{body:{name}});assert.equal(r.status,400,name);assert.equal(r.data.error,'bad_name');assert.ok(!r.data.message.includes(name));
  }
  const p=await register('王伟');assert.ok(p.token);
  const bad=await call('POST','/api/rename',{token:p.token,body:{name:'販毒'}});assert.equal(bad.status,400);
  assert.equal((await call('GET','/api/me',{token:p.token})).data.player.name,'王伟');
});

test('A03: unsafe external names keep OAuth access and share one stable alias across both boards',async()=>{
 const p=await linuxdoLogin({id:703,username:'傻逼'});assert.ok(p.token);assert.match(p.player.name,/^玩家·\d+$/u);
 const raw=env.DB.raw.prepare('SELECT * FROM players WHERE id=?').get(p.player.id);assert.equal(raw.name,'傻逼');assert.equal(raw.linuxdo_id,703);
 env.DB.raw.prepare('UPDATE players SET best_score=99,best_at=1 WHERE id=?').run(p.player.id);
 const me=await call('GET','/api/me',{token:p.token});const board=await call('GET','/api/leaderboard');assert.equal(me.data.player.name,p.player.name);assert.equal(board.data.entries[0].name,p.player.name);
 const today=await call('GET','/api/challenges/today',{token:p.token});const id=today.data.challenge.challengeId;
 env.DB.raw.prepare('INSERT INTO challenge_bests VALUES (?,?,?,?,?)').run(id,p.player.id,88,5,1);
 const daily=await call('GET',`/api/challenges/leaderboard?challengeId=${id}`,{token:p.token});assert.equal(daily.status,200);assert.equal(daily.data.entries[0].name,p.player.name);assert.equal(daily.data.me.player.name,p.player.name);
 const again=await linuxdoLogin({id:703,username:'傻逼'});assert.equal(again.player.id,p.player.id);assert.equal(again.player.name,p.player.name);
 assert.equal('auth_version' in board.data.entries[0],false);
});

test('A03: a policy change masks a guest without deleting identity, sessions or scores',async()=>{
 const p=await register('普通玩家');const s=await call('POST','/api/session',{token:p.token});
 env.BLOCKED_WORDS='普通玩家';const me=await call('GET','/api/me',{token:p.token});assert.equal(me.status,200);assert.match(me.data.player.name,/^玩家·\d+$/u);
 assert.equal(me.data.player.id,p.player.id);assert.equal(env.DB.raw.prepare('SELECT name FROM players WHERE id=?').get(p.player.id).name,'普通玩家');
 assert.equal((await call('GET',`/api/session/check?sessionId=${s.data.sessionId}`,{token:p.token})).status,200);
 const renamed=await call('POST','/api/rename',{token:p.token,body:{name:'新的名字'}});assert.equal(renamed.status,200);assert.equal(renamed.data.player.name,'新的名字');
});

test('A03 foundation does not enable password or recovery endpoints',async()=>{
 for(const path of ['/api/auth/password/register','/api/auth/password/login','/api/account/password','/api/auth/password/recover'])assert.equal((await call('POST',path,{body:{}})).status,404,path);
});
