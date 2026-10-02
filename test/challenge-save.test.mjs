import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.localStorage = { getItem: (key) => (key.endsWith(':sound') ? 'off' : null), setItem() {} };
const { Game } = await import('../src/game.js');
const definition = { challengeId: '2026-10-03', rulesVersion: 'daily-1', count: 100 };
const make = () => new Game({ getContext: () => ({}) }, {}, { challenge: definition });

test('challenge persistence is a separate practice-only namespace and preserves completed state', async () => {
  const { ChallengeStore } = await import('../src/challenge-store.js');
  const { SaveStore } = await import('../src/save-store.js');
  const data = new Map(),
    storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  const classic = new SaveStore({ scope: 'api', storage });
  const daily = new ChallengeStore({ scope: 'api', storage });
  assert.notEqual(classic.key, daily.key);
  data.set(classic.key, 'untouched-classic');
  daily.owned = true;
  const g = make();
  g.drop();
  g.gameOver();
  const record = daily.record('round-1', g.snapshot());
  daily.write(record);
  assert.equal(daily.read().record.game.challenge.phase, 'finished');
  assert.equal(data.get(classic.key), 'untouched-classic');
  assert.throws(() => daily.write({ ...record, mode: 'formal' }));
  assert.throws(() => classic.validate({ ...record, scope: 'api', rulesVersion: 'classic-1', online: null }));
});
test('damaged and foreign daily saves are rejected without replacing existing bytes', async () => {
  const { ChallengeStore } = await import('../src/challenge-store.js');
  let value = null;
  const store = new ChallengeStore({
    scope: 'api',
    storage: { getItem: () => value, setItem: (_, v) => (value = v) },
  });
  store.owned = true;
  const record = store.record('round-1', make().snapshot());
  store.write(record);
  const before = value;
  for (const patch of [
    { scope: 'other' },
    { schemaVersion: 2 },
    { rulesVersion: 'daily-2' },
    { mode: 'formal' },
    { online: { sessionId: 'x' } },
    { game: {} },
  ]) {
    assert.throws(() => store.write({ ...record, ...patch }));
    assert.equal(value, before);
  }
  value = '{bad';
  assert.equal(store.read().kind, 'invalid');
});
test('practice date uses Shanghai midnight, and formal service fails closed', async () => {
  const { practiceDefinition, challengeService } = await import('../src/challenge.js');
  assert.equal(practiceDefinition(new Date('2026-10-02T15:59:59Z')).challengeId, '2026-10-02');
  assert.equal(practiceDefinition(new Date('2026-10-02T16:00:00Z')).challengeId, '2026-10-03');
  assert.equal(challengeService.formalAvailable, false);
  await assert.rejects(challengeService.startFormal(), /formal_unavailable/);
});
