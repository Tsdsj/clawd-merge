import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createD1 } from './d1-mock.mjs';
let env, now, serial;
beforeEach((t) => {
  now = Date.parse('2026-10-02T12:00:00Z');
  serial = 0;
  t.mock.method(Date, 'now', () => now);
  env = { DB: createD1(), ALLOWED_ORIGINS: '*', BLOCKED_WORDS: '' };
});
afterEach(() => env.DB.raw.close());
async function api(path, token, body) {
  const r = await worker.fetch(
    new Request('https://api.test' + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': `10.1.0.${++serial}`,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
  );
  return { status: r.status, data: await r.json() };
}
async function guest(name = '挑战用户') {
  return (await api('/api/register', null, { name })).data;
}
async function today(token) {
  const r = await api('/api/challenges/today', token);
  assert.equal(r.status, 200);
  return r.data;
}
async function start(token, requestId = crypto.randomUUID(), definition) {
  const d = definition || (await today(token)).challenge;
  return api('/api/challenges/session', token, {
    challengeId: d.challengeId,
    rulesVersion: d.rulesVersion,
    requestId,
  });
}
const resultBody = (session) => ({
  mode: 'formal',
  sessionId: session.sessionId,
  challengeId: session.challengeId,
  rulesVersion: session.rulesVersion,
  score: 80,
  drops: 10,
  maxLevel: 5,
  clawsUsed: 0,
  settlingMs: 0,
  reason: 'danger',
});
async function score(token, session, extra = {}) {
  return api('/api/challenges/score', token, { ...resultBody(session), ...extra });
}

test('server Shanghai day, immutable definition and next-day ten-minute cutoff', async () => {
  const p = await guest();
  const d = await today(p.token);
  assert.equal(d.challenge.challengeId, '2026-10-02');
  assert.equal(d.challenge.count, 100);
  assert.equal(d.challenge.submitUntil, Date.parse('2026-10-02T16:10:00Z'));
  assert.equal(d.allowance.remaining, 3);
  now = Date.parse('2026-10-02T16:00:00Z');
  assert.equal((await today(p.token)).challenge.challengeId, '2026-10-03');
  assert.equal((await api('/api/challenges/today')).data.allowance, null);
});
test('concurrent starts spend at most three attempts; same request replays once', async () => {
  const p = await guest(),
    d = (await today(p.token)).challenge,
    id = crypto.randomUUID();
  const replay = await Promise.all(Array.from({ length: 8 }, () => start(p.token, id, d)));
  for (const r of replay) {
    assert.equal(r.status, 200);
    assert.equal(r.data.session.sessionId, replay[0].data.session.sessionId);
  }
  assert.equal((await today(p.token)).allowance.remaining, 2);
  const more = await Promise.all(Array.from({ length: 6 }, () => start(p.token, crypto.randomUUID(), d)));
  assert.equal(more.filter((r) => r.status === 200).length, 2);
  assert.equal(more.filter((r) => r.data.error === 'attempts_exhausted').length, 4);
  assert.equal((await today(p.token)).allowance.remaining, 0);
  assert.equal((await start(p.token, id, d)).data.session.sessionId, replay[0].data.session.sessionId);
});
test('start identity, version, old-day and intent conflicts never spend another chance', async () => {
  const a = await guest(),
    b = await guest('另一用户'),
    d = (await today(a.token)).challenge,
    id = crypto.randomUUID();
  assert.equal((await start(a.token, id, d)).status, 200);
  assert.equal((await start(b.token, id, d)).status, 409);
  assert.equal((await start(a.token, crypto.randomUUID(), { ...d, rulesVersion: 'daily-2' })).status, 409);
  now = Date.parse('2026-10-02T16:00:00Z');
  assert.equal((await start(a.token, crypto.randomUUID(), d)).status, 409);
  assert.equal((await start(a.token, id, d)).status, 200);
  assert.equal((await today(a.token)).allowance.remaining, 3);
});
test('formal receipt is atomic, concurrent, immutable and isolated from classic scores', async () => {
  const p = await guest(),
    session = (await start(p.token)).data.session;
  now += 10000;
  const answers = await Promise.all(Array.from({ length: 8 }, () => score(p.token, session)));
  for (const r of answers) {
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, answers[0].data);
  }
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM challenge_scores').get().n, 1);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM scores').get().n, 0);
  assert.equal(env.DB.raw.prepare('SELECT games FROM players').get().games, 0);
  assert.equal((await score(p.token, session, { score: 81 })).status, 409);
  assert.equal(
    (await api('/api/challenges/session/check?sessionId=' + session.sessionId, p.token)).data.status,
    'used',
  );
  now = Date.parse('2026-10-02T16:10:00Z');
  assert.deepEqual((await score(p.token, session)).data, answers[0].data);
});
test('first submission rejects cutoff, mode mixing, excessive drops/tools and implausible timing', async () => {
  const p = await guest(),
    session = (await start(p.token)).data.session;
  for (const extra of [
    { mode: 'practice' },
    { challengeId: '2026-10-01' },
    { rulesVersion: 'daily-2' },
    { drops: 101 },
    { clawsUsed: 1 },
    { reason: 'limit' },
    { settlingMs: 8001 },
    { score: 999999 },
  ]) {
    const r = await score(p.token, session, extra);
    assert.ok(r.status >= 400 && r.status < 500, JSON.stringify(extra));
  }
  assert.equal((await score(p.token, session)).status, 422);
  now += 10000;
  const classic = (await api('/api/session', p.token, {})).data;
  assert.equal(
    (
      await api('/api/score', p.token, {
        sessionId: classic.sessionId,
        score: 0,
        drops: 1,
        maxLevel: 1,
        mode: 0,
      })
    ).status,
    400,
  );
  assert.ok(
    (await api('/api/score', p.token, { ...resultBody(session), sessionId: classic.sessionId })).status >=
      400,
  );
  assert.ok((await score(p.token, { ...session, sessionId: classic.sessionId })).status >= 400);
  now = Date.parse('2026-10-02T16:10:00Z');
  assert.equal((await score(p.token, session)).data.error, 'challenge_expired');
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM challenge_scores').get().n, 0);
});
test('check never extends or replaces a ticket and does not disclose another owner', async () => {
  const a = await guest(),
    b = await guest('其他玩家'),
    s = (await start(a.token)).data.session;
  assert.equal(
    (await api('/api/challenges/session/check?sessionId=' + s.sessionId, b.token)).data.status,
    'invalid',
  );
  assert.equal(
    (await api('/api/challenges/session/check?sessionId=' + s.sessionId, a.token)).data.status,
    'valid',
  );
  now = s.submitUntil;
  assert.equal(
    (await api('/api/challenges/session/check?sessionId=' + s.sessionId, a.token)).data.status,
    'expired',
  );
  assert.equal(env.DB.raw.prepare('SELECT used FROM challenge_allowances').get().used, 1);
});
test('best scores and personal rank are isolated by challenge and cannot regress', async () => {
  const a = await guest(),
    b = await guest('排名用户');
  const a1 = (await start(a.token)).data.session,
    a2 = (await start(a.token)).data.session,
    b1 = (await start(b.token)).data.session;
  now += 10000;
  await score(a.token, a1, { score: 100 });
  now++;
  await score(b.token, b1, { score: 80 });
  await score(a.token, a2, { score: 50 });
  const board = (await api('/api/challenges/leaderboard?challengeId=2026-10-02', a.token)).data;
  assert.equal(board.total, 2);
  assert.equal(board.entries[0].score, 100);
  assert.equal(board.me.rank, 1);
  assert.equal(board.me.best, 100);
  now = Date.parse('2026-10-02T16:00:00Z');
  await today(a.token);
  assert.equal((await api('/api/challenges/leaderboard?challengeId=2026-10-03', a.token)).data.total, 0);
  assert.equal((await api('/api/leaderboard')).data.total, 0);
});
test('failed issuing/submission transactions roll back and the same requests can retry', async () => {
  const p = await guest(),
    d = (await today(p.token)).challenge,
    id = crypto.randomUUID();
  env.DB.raw.exec(
    "CREATE TRIGGER fail_issue BEFORE UPDATE ON challenge_allowances BEGIN SELECT RAISE(ABORT,'isolated challenge issue'); END;",
  );
  assert.equal((await start(p.token, id, d)).status, 500);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM challenge_sessions').get().n, 0);
  env.DB.raw.exec('DROP TRIGGER fail_issue');
  const session = (await start(p.token, id, d)).data.session;
  now += 10000;
  env.DB.raw.exec(
    "CREATE TRIGGER fail_result BEFORE INSERT ON challenge_bests BEGIN SELECT RAISE(ABORT,'isolated challenge result'); END;",
  );
  assert.equal((await score(p.token, session)).status, 500);
  assert.equal(env.DB.raw.prepare('SELECT used FROM challenge_sessions').get().used, 0);
  env.DB.raw.exec('DROP TRIGGER fail_result');
  assert.equal((await score(p.token, session)).status, 200);
});

test('identity disappearing during an issue cannot create orphan attempts or allowances', async () => {
  const p = await guest(),
    d = (await today(p.token)).challenge,
    batch = env.DB.batch.bind(env.DB);
  env.DB.batch = async (statements) => {
    env.DB.raw.prepare('DELETE FROM players WHERE id=?').run(p.player.id);
    return batch(statements);
  };
  const r = await start(p.token, crypto.randomUUID(), d);
  assert.equal(r.status, 401);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM challenge_sessions').get().n, 0);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM challenge_allowances').get().n, 0);
});
test('identity disappearing during submission cannot leave an orphan best or receipt', async () => {
  const p = await guest(),
    s = (await start(p.token)).data.session,
    batch = env.DB.batch.bind(env.DB);
  now += 10000;
  env.DB.batch = async (statements) => {
    env.DB.raw.prepare('DELETE FROM players WHERE id=?').run(p.player.id);
    return batch(statements);
  };
  assert.equal((await score(p.token, s)).status, 401);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM challenge_scores').get().n, 0);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM challenge_bests').get().n, 0);
});
