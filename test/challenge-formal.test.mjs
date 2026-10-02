import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.localStorage = { getItem: (k) => (k.endsWith(':sound') ? 'off' : null), setItem() {} };
const { Game } = await import('../src/game.js');
const { ChallengeStore } = await import('../src/challenge-store.js');
const { ChallengeSession } = await import('../src/challenge-session.js');
const d = {
  challengeId: '2026-10-03',
  rulesVersion: 'daily-1',
  count: 100,
  startsAt: Date.parse('2026-10-02T16:00:00Z'),
  endsAt: Date.parse('2026-10-03T16:00:00Z'),
  submitUntil: Date.parse('2026-10-03T16:10:00Z'),
  attemptLimit: 3,
  settleSeconds: 8,
  stableSeconds: 0.75,
};
async function setup() {
  const data = new Map();
  let fail = false;
  let lost = true;
  const requests = [];
  let p = { id: 'p1', token: 'token-only-in-memory', name: '测试' };
  const store = new ChallengeStore({
    scope: 'api',
    storage: {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => {
        if (fail) throw Error('write');
        data.set(k, v);
      },
      removeItem: (k) => data.delete(k),
    },
  });
  store.acquire = async () => {
    store.owned = true;
    return true;
  };
  const api = {
    formalAvailable: true,
    start: async (intent) => {
      requests.push(intent.requestId);
      if (lost) {
        lost = false;
        throw Object.assign(Error('lost response'), { code: 'offline' });
      }
      return {
        status: 'valid',
        challenge: d,
        serverNow: d.startsAt + 100,
        session: {
          sessionId: 'server-ticket',
          playerId: 'p1',
          challengeId: d.challengeId,
          rulesVersion: d.rulesVersion,
          attempt: 1,
          startedAt: d.startsAt,
          submitUntil: d.submitUntil,
        },
      };
    },
    check: async () => ({ status: 'valid' }),
  };
  const make = () =>
    new ChallengeSession({
      store,
      api,
      getPlayer: () => p,
      createGame: (challenge, onGameOver) =>
        new Game({ getContext: () => ({}) }, { onGameOver }, { challenge }),
    });
  const session = make();
  await session.initialize();
  return {
    session,
    store,
    data,
    requests,
    make,
    api,
    setPlayer: (v) => (p = v),
    block: () => (fail = true),
    allow: () => (fail = false),
  };
}
test('unknown formal start survives refresh and retries the same durable request without a token', async () => {
  const x = await setup();
  assert.equal(await x.session.startFormal(d), false);
  const intent = x.store.readIntent().intent;
  assert.ok(intent.requestId);
  assert.ok(!JSON.stringify([...x.data.values()]).includes('token-only-in-memory'));
  const resumed = x.make();
  await resumed.initialize();
  assert.equal(resumed.status, 'starting');
  assert.equal(await resumed.retryStart(), true);
  assert.equal(new Set(x.requests).size, 1);
  assert.equal(resumed.record.mode, 'formal');
  assert.equal(x.store.readIntent().kind, 'empty');
});
test('formal issuance never happens before durable intent or with a changed identity', async () => {
  const x = await setup();
  x.block();
  assert.equal(await x.session.startFormal(d), false);
  assert.equal(x.requests.length, 0);
  x.allow();
  await x.session.startFormal(d);
  x.setPlayer({ id: 'other', token: 'other' });
  assert.equal(await x.session.retryStart(), false);
  assert.equal(x.requests.length, 1);
});
test('formal restoration checks original ticket; failed eligibility leaves bytes unchanged until explicit conversion', async () => {
  const x = await setup();
  await x.session.startFormal(d);
  await x.session.retryStart();
  x.session.game.drop();
  x.session.flush();
  const before = x.data.get(x.store.key);
  x.session.game = null;
  x.session.status = 'detached';
  await x.session.initialize();
  x.api.check = async () => ({ status: 'expired' });
  assert.equal(await x.session.resumeFormal(), false);
  assert.equal(x.data.get(x.store.key), before);
  assert.equal(x.session.toPractice(), true);
  assert.equal(x.session.record.mode, 'practice');
  assert.equal(x.session.game.drops, 1);
  assert.equal(x.session.record.online, undefined);
});
test('a handed-off page cannot install a late formal-start reply', async () => {
  const x = await setup();
  let resolve;
  x.api.start = () => new Promise((r) => (resolve = r));
  const pending = x.session.startFormal(d);
  await Promise.resolve();
  x.store.onLost();
  resolve({
    status: 'valid',
    challenge: d,
    serverNow: d.startsAt + 100,
    session: {
      sessionId: 'server-ticket',
      playerId: 'p1',
      challengeId: d.challengeId,
      rulesVersion: d.rulesVersion,
      attempt: 1,
      startedAt: d.startsAt,
      submitUntil: d.submitUntil,
    },
  });
  assert.equal(await pending, false);
  assert.equal(x.session.status, 'busy');
  assert.equal(x.store.readIntent().kind, 'intent');
});

test('replaying an already completed start never opens a new playable formal round', async () => {
  const x = await setup();
  x.session.start(d);
  x.session.game.drop();
  x.session.flush();
  const oldId = x.session.record.roundId;
  x.api.start = async () => ({
    status: 'used',
    challenge: d,
    serverNow: d.startsAt + 100,
    session: {
      sessionId: 'already-used',
      playerId: 'p1',
      challengeId: d.challengeId,
      rulesVersion: d.rulesVersion,
      attempt: 1,
      startedAt: d.startsAt,
      submitUntil: d.submitUntil,
    },
  });
  assert.equal(await x.session.startFormal(d), false);
  assert.equal(x.session.record.roundId, oldId);
  assert.equal(x.session.record.mode, 'practice');
  assert.equal(x.store.readIntent().kind, 'empty');
});
