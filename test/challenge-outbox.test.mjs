import test from 'node:test';
import assert from 'node:assert/strict';
import { Outbox } from '../src/outbox.js';
const value = {
  roundId: 'round-1',
  playerId: 'player-1',
  playerName: '游客',
  sessionId: 'ticket-1',
  mode: 'formal',
  challengeId: '2026-10-03',
  rulesVersion: 'daily-1',
  submitUntil: 1791043800000,
  score: 0,
  drops: 1,
  maxLevel: 1,
  clawsUsed: 0,
  settlingMs: 0,
  reason: 'danger',
};
function storage() {
  const data = new Map();
  return {
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
}
test('formal outbox persists zero-score metadata and never writes tokens or classic keys', async () => {
  const { challengeResultCodec } = await import('../src/challenge-result.js');
  const disk = storage();
  let sent;
  const queue = new Outbox({
    scope: 'daily:api',
    storage: disk,
    codec: challengeResultCodec,
    getPlayer: () => ({ id: 'player-1', token: 'memory-token' }),
    send: async (body) => {
      sent = body;
      return {
        sessionId: 'ticket-1',
        challengeId: '2026-10-03',
        rulesVersion: 'daily-1',
        best: 0,
        rank: null,
        improved: false,
      };
    },
  });
  const entry = queue.enqueue(value);
  const raw = disk.getItem(entry.key);
  assert.ok(!raw.includes('memory-token'));
  assert.equal(JSON.parse(raw).challengeId, value.challengeId);
  await queue.process(entry.key);
  assert.equal(sent.mode, 'formal');
  assert.equal(sent.score, 0);
  assert.equal(sent.reason, 'danger');
  assert.equal(queue.get(entry.key).state, 'accepted');
  const classic = new Outbox({ scope: 'api', storage: disk });
  assert.notEqual(classic.prefix, queue.prefix);
  assert.throws(() => classic.enqueue(value));
  assert.throws(() => classic.enqueue({ ...value, score: 80 }));
  assert.throws(() => classic.enqueue({ ...value, score: 80, mode: 0, challengeId: undefined }));
});
test('challenge codec rejects cross-topic receipt and payload conflicts', async () => {
  const { challengeResultCodec } = await import('../src/challenge-result.js');
  const queue = new Outbox({
    scope: 'daily:api',
    storage: storage(),
    codec: challengeResultCodec,
    getPlayer: () => ({ id: 'player-1', token: 't' }),
    send: async () => ({
      sessionId: 'ticket-1',
      challengeId: '2026-10-04',
      rulesVersion: 'daily-1',
      best: 0,
      rank: null,
      improved: false,
    }),
  });
  const entry = queue.enqueue(value);
  assert.throws(() => queue.enqueue({ ...value, challengeId: '2026-10-04' }));
  await queue.process(entry.key);
  assert.equal(queue.get(entry.key).state, 'retry');
});

test('accepted challenge receipt is journaled before queue cleanup and can repair an older snapshot', async () => {
  globalThis.localStorage = { getItem: (k) => (k.endsWith(':sound') ? 'off' : null), setItem() {} };
  const { Game } = await import('../src/game.js');
  const { ChallengeStore } = await import('../src/challenge-store.js');
  const { ChallengeUploads } = await import('../src/challenge-uploads.js');
  const disk = storage();
  const store = new ChallengeStore({ scope: 'api', storage: disk });
  store.owned = true;
  const d = { challengeId: '2026-10-03', rulesVersion: 'daily-1', count: 100 };
  const g = new Game({ getContext: () => ({}) }, {}, { challenge: d });
  const online = {
    sessionId: 'ticket-1',
    requestId: 'request-00000001',
    playerId: 'player-1',
    challengeId: d.challengeId,
    rulesVersion: d.rulesVersion,
    attempt: 1,
    startedAt: Date.parse('2026-10-02T16:00:00Z'),
    submitUntil: Date.parse('2026-10-03T16:10:00Z'),
  };
  const record = store.record('ticket-1', g.snapshot(), online);
  store.write(record);
  g.drop();
  g.gameOver();
  const uploads = new ChallengeUploads({
    scope: 'api',
    store,
    getPlayer: () => ({ id: 'player-1', token: 't' }),
    api: {
      send: async () => ({
        sessionId: 'ticket-1',
        challengeId: d.challengeId,
        rulesVersion: d.rulesVersion,
        best: 0,
        rank: null,
        improved: false,
      }),
    },
    isOnline: () => true,
  });
  const entry = uploads.stage(record, g.snapshot());
  await uploads.queue.process(entry.key);
  assert.equal(store.read().record.game.challenge.phase, 'finished');
  assert.equal(store.read().record.upload.state, 'accepted');
  assert.equal(disk.getItem(entry.key), null);
  assert.equal(uploads.recover(), null);
});

test('a durable finished journal can protect auth navigation but cannot be overwritten before queue persistence', async () => {
  globalThis.localStorage = { getItem: (k) => (k.endsWith(':sound') ? 'off' : null), setItem() {} };
  const { Game } = await import('../src/game.js');
  const { ChallengeStore } = await import('../src/challenge-store.js');
  const { ChallengeUploads } = await import('../src/challenge-uploads.js');
  const disk = storage(),
    write = disk.setItem;
  disk.setItem = (key, value) => {
    if (key.includes(':outbox:')) throw Error('quota');
    write(key, value);
  };
  const store = new ChallengeStore({ scope: 'api', storage: disk });
  store.owned = true;
  const d = { challengeId: '2026-10-03', rulesVersion: 'daily-1', count: 100 },
    g = new Game({ getContext: () => ({}) }, {}, { challenge: d });
  g.drop();
  g.gameOver();
  const online = {
    sessionId: 'ticket-1',
    requestId: 'request-00000001',
    playerId: 'player-1',
    challengeId: d.challengeId,
    rulesVersion: d.rulesVersion,
    attempt: 1,
    startedAt: Date.parse('2026-10-02T16:00:00Z'),
    submitUntil: Date.parse('2026-10-03T16:10:00Z'),
  };
  const record = store.record('ticket-1', g.snapshot(), online);
  store.write(record);
  const uploads = new ChallengeUploads({
    scope: 'api',
    store,
    api: {},
    getPlayer: () => null,
    isOnline: () => false,
  });
  const entry = uploads.stage(record);
  assert.equal(entry.durable, false);
  assert.equal(entry.journaled, true);
  assert.equal(uploads.canReplace(record, g), false);
  assert.equal(store.read().record.game.challenge.phase, 'finished');
});
