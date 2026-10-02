import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.localStorage = { getItem: (k) => (k.endsWith(':sound') ? 'off' : null), setItem() {} };
const { Game } = await import('../src/game.js');
const def = { challengeId: '2026-10-03', rulesVersion: 'daily-1', count: 100 };
async function setup() {
  const { ChallengeStore } = await import('../src/challenge-store.js');
  const { ChallengeSession } = await import('../src/challenge-session.js');
  const data = new Map();
  let fail = false;
  const store = new ChallengeStore({
    scope: 'api',
    storage: {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => {
        if (fail) throw Error('blocked');
        data.set(k, v);
      },
    },
  });
  store.acquire = async () => {
    store.owned = true;
    return true;
  };
  const createGame = (challenge, onFinish) =>
    new Game({ getContext: () => ({}) }, { onGameOver: onFinish }, { challenge });
  return { session: new ChallengeSession({ store, createGame }), store, data, block: () => (fail = true) };
}
test('replacing a challenge only becomes active after its new snapshot is durable', async () => {
  const { session, block } = await setup();
  await session.initialize();
  assert.equal(session.status, 'empty');
  assert.equal(session.start(def), true);
  session.game.drop();
  session.flush();
  const old = session.game;
  block();
  assert.equal(session.start(def), false);
  assert.equal(session.game, old);
  assert.equal(session.game.drops, 1);
});
test('round and finished result survive reopening without replaying completion', async () => {
  const { session, store } = await setup();
  await session.initialize();
  session.start(def);
  session.game.drop();
  session.flush();
  session.game = null;
  session.status = 'detached';
  await session.initialize();
  assert.equal(session.status, 'saved');
  assert.equal(session.resume(), true);
  assert.equal(session.game.drops, 1);
  assert.equal(session.game.paused, true);
  session.game.gameOver();
  assert.equal(store.read().record.game.challenge.phase, 'finished');
  session.game = null;
  session.status = 'detached';
  await session.initialize();
  session.resume();
  assert.equal(session.game.over, true);
});
test('handoff refuses failed writes and a yielded page can no longer save its stale board', async () => {
  const { session, store, block } = await setup();
  await session.initialize();
  session.start(def);
  session.game.drop();
  block();
  assert.equal(await store.onYield(), false);
  assert.equal(session.game.paused, true);
  store.onLost();
  assert.equal(session.status, 'busy');
  assert.equal(session.flush(), false);
});

test('explicit temporary practice never overwrites a blocked existing save', async () => {
  const { session, store, data, block } = await setup();
  await session.initialize();
  session.start(def);
  const before = data.get(store.key);
  block();
  assert.equal(session.start(def, true), true);
  session.game.drop();
  session.game.gameOver();
  assert.equal(session.temporary, true);
  assert.equal(data.get(store.key), before);
  assert.ok(session.warning.includes('临时'));
});
