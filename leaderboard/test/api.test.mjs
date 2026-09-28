// API tests for the leaderboard Worker. Run: node --test 'leaderboard/test/*.test.mjs'
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createD1 } from './d1-mock.mjs';

let env;
beforeEach(() => {
  env = { DB: createD1(), ALLOWED_ORIGINS: 'https://tsdsj.github.io', BLOCKED_WORDS: '坏词' };
  mock.timers.reset();
});

let ipCounter = 0;
async function call(method, path, { body, token, ip, origin } = {}) {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip ?? `10.0.0.${++ipCounter}` };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  const res = await worker.fetch(
    new Request(`https://api.test${path}`, { method, headers, body: body && JSON.stringify(body) }),
    env,
  );
  return { status: res.status, headers: res.headers, data: res.status === 204 ? null : await res.json() };
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

test('register returns a token and rejects duplicate names case-insensitively', async () => {
  const a = await register('Clawd粉丝');
  assert.equal(a.player.name, 'Clawd粉丝');
  assert.ok(a.token.length > 30);
  const dup = await call('POST', '/api/register', { body: { name: 'clawd粉丝' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error, 'name_taken');
  // Full-width letters normalise to the same name (NFKC).
  const dup2 = await call('POST', '/api/register', { body: { name: 'ＣＬＡＷＤ粉丝' } });
  assert.equal(dup2.status, 409);
});

test('name validation', async () => {
  for (const name of ['a', '这个名字实在是太长了超过十二个字', 'has space', 'x<script>', '管理员', 'Anthropic', 'CLAWD', '我是坏词']) {
    const res = await call('POST', '/api/register', { body: { name } });
    assert.equal(res.status, 400, name);
  }
  const ok = await call('POST', '/api/register', { body: { name: '  小钳子_01  ' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.player.name, '小钳子_01'); // trimmed
});

test('score flow: best score, rank and leaderboard order', async () => {
  const a = await register('阿甲');
  const b = await register('阿乙');
  assert.equal((await play(a.token, { score: 3000, drops: 100 })).data.rank, 1);
  const rb = await play(b.token, { score: 5000, drops: 100, maxLevel: 9 });
  assert.deepEqual(rb.data, { improved: true, best: 5000, rank: 1 });
  // A worse game doesn't lower the personal best.
  const worse = await play(b.token, { score: 100, drops: 20 });
  assert.deepEqual(worse.data, { improved: false, best: 5000, rank: 1 });

  const board = await call('GET', '/api/leaderboard?limit=10');
  assert.deepEqual(
    board.data.entries.map((e) => [e.rank, e.name, e.score, e.level]),
    [
      [1, '阿乙', 5000, 9],
      [2, '阿甲', 3000, 5],
    ],
  );
  const me = await call('GET', '/api/me', { token: a.token });
  assert.equal(me.data.rank, 2);
  assert.equal(me.data.games, 1);
});

test('sessions are single-use and required', async () => {
  const a = await register('玩家一');
  const { data } = await call('POST', '/api/session', { token: a.token });
  const body = { sessionId: data.sessionId, score: 10, drops: 1, maxLevel: 2 };
  assert.equal((await call('POST', '/api/score', { token: a.token, body })).status, 200);
  assert.equal((await call('POST', '/api/score', { token: a.token, body })).status, 400);
  const fake = { ...body, sessionId: 'made-up' };
  assert.equal((await call('POST', '/api/score', { token: a.token, body: fake })).data.error, 'bad_session');
  // Another player's session can't be used either.
  const b = await register('玩家二');
  const s2 = (await call('POST', '/api/session', { token: b.token })).data.sessionId;
  assert.equal((await call('POST', '/api/score', { token: a.token, body: { ...body, sessionId: s2 } })).status, 400);
});

test('implausible scores are rejected', async () => {
  const a = await register('作弊者');
  // 200 drops in 10 seconds is impossible with a 0.5 s cooldown.
  assert.equal((await play(a.token, { score: 5000, drops: 200, seconds: 10 })).data.error, 'too_fast');
  // 10 drops can't be worth a million points.
  assert.equal((await play(a.token, { score: 1_000_000, drops: 10 })).data.error, 'implausible');
  const bad = await call('POST', '/api/score', { token: a.token, body: { sessionId: 'x', score: -5, drops: 1, maxLevel: 1 } });
  assert.equal(bad.status, 400);
});

test('auth, rate limits and CORS', async () => {
  assert.equal((await call('POST', '/api/session')).status, 401);
  assert.equal((await call('POST', '/api/session', { token: 'nope' })).status, 401);
  for (let i = 0; i < 5; i++) {
    assert.equal((await call('POST', '/api/register', { body: { name: `同IP${i}号` }, ip: '1.2.3.4' })).status, 201);
  }
  const limited = await call('POST', '/api/register', { body: { name: '同IP第六个' }, ip: '1.2.3.4' });
  assert.equal(limited.status, 429);

  const allowed = await call('GET', '/api/leaderboard', { origin: 'https://tsdsj.github.io' });
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'https://tsdsj.github.io');
  const other = await call('GET', '/api/leaderboard', { origin: 'https://evil.example' });
  assert.equal(other.headers.get('Access-Control-Allow-Origin'), null);
  const preflight = await call('OPTIONS', '/api/score', { origin: 'https://tsdsj.github.io' });
  assert.equal(preflight.status, 204);
});
