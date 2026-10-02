import test from 'node:test';
import assert from 'node:assert/strict';
const writes = [];
globalThis.localStorage = {
  getItem: (key) => (key.endsWith(':sound') ? 'off' : null),
  setItem: (...args) => writes.push(args),
};
const { Game } = await import('../src/game.js');
const { createChallengeSequence } = await import('../src/drop-sequence.js');
const definition = { challengeId: '2026-10-03', rulesVersion: 'daily-1', count: 100 };
const make = (events = {}) => new Game({ getContext: () => ({}) }, events, { challenge: definition });
function exhaust(g) {
  for (let i = 0; i < 100; i++) {
    g.drop();
    g.world.clear();
  }
}

test('challenge consumes the shared sequence independently of player growth and stops at 100', () => {
  const g = make(),
    levels = [];
  for (let i = 0; i < 100; i++) {
    levels.push(g.current);
    g.maxLevel = 1 + (i % 11);
    g.drop();
    g.world.clear();
  }
  assert.deepEqual(levels, createChallengeSequence(definition).levels);
  assert.equal(g.drops, 100);
  assert.equal(g.current, null);
  assert.equal(g.next, null);
  assert.equal(g.challenge.phase, 'settling');
  g.requestDrop();
  g.drop();
  g.pendingDrop = true;
  g.update(0.1);
  assert.equal(g.drops, 100);
  assert.equal(g.world.bodies.length, 0);
});
test('final settlement blocks tools and ends once after 0.75 settled seconds', () => {
  let ended = 0;
  const g = make({ onGameOver: () => ended++ });
  exhaust(g);
  const b = g.spawnCrab(2, 200, 580);
  b.sleeping = true;
  b.im = b.ii = 0;
  g.claws = 2;
  g.clawMode = true;
  g.useClawAt(b.x, b.y);
  g.toggleClaw();
  assert.equal(g.claws, 2);
  assert.equal(g.world.bodies.length, 1);
  for (let i = 0; i < 7; i++) g.update(0.1);
  assert.equal(g.over, false);
  g.update(0.1);
  assert.equal(g.over, true);
  assert.equal(g.challenge.reason, 'limit');
  for (let i = 0; i < 20; i++) g.update(0.1);
  assert.equal(ended, 1);
});
test('unsettled board is bounded at eight seconds and background pause freezes settlement', () => {
  const g = make();
  exhaust(g);
  const b = g.spawnCrab(1, 200, 300);
  for (let i = 0; i < 35; i++) {
    b.sleeping = false;
    b.vx = 400;
    g.update(0.1);
  }
  const time = g.challenge.settlingTime;
  g.setPaused(true);
  for (let i = 0; i < 100; i++) g.update(0.1);
  assert.equal(g.challenge.settlingTime, time);
  assert.equal(g.over, false);
  g.setPaused(false);
  for (let i = 0; i < 46; i++) {
    b.sleeping = false;
    b.vx = 400;
    g.danger = 0;
    g.update(0.1);
  }
  assert.equal(g.over, true);
  assert.equal(g.challenge.settlingTime, 8);
});
test('settlement resumes its remaining duration and does not award a new drop', () => {
  const g = make();
  exhaust(g);
  g.challenge.settlingTime = 7.8;
  const b = g.spawnCrab(1, 200, 300);
  b.vx = 400;
  const saved = JSON.parse(JSON.stringify(g.snapshot()));
  const restored = make();
  restored.restore(saved);
  assert.equal(restored.paused, true);
  assert.equal(restored.challenge.settlingTime, 7.8);
  restored.setPaused(false);
  restored.update(0.1);
  restored.update(0.1);
  restored.update(0.1);
  assert.equal(restored.over, true);
  assert.equal(restored.drops, 100);
});
test('challenge death before the limit finishes once with a danger reason', () => {
  let count = 0;
  const g = make({ onGameOver: () => count++ });
  g.drop();
  g.gameOver();
  g.gameOver();
  assert.equal(g.challenge.reason, 'danger');
  assert.equal(g.challenge.phase, 'finished');
  assert.equal(count, 1);
  const restored = make();
  restored.restore(g.snapshot());
  assert.equal(restored.over, true);
});
test('daily snapshot rejects mixed sequence, counter and version before mutating either game', () => {
  const g = make();
  g.drop();
  const saved = g.snapshot();
  const classic = new Game({ getContext: () => ({}) });
  const baseline = classic.snapshot();
  assert.throws(() => classic.restore(saved));
  assert.deepEqual(classic.snapshot(), baseline);
  for (const mutate of [
    (s) => (s.current = 5),
    (s) => (s.challenge.rulesVersion = 'daily-2'),
    (s) => (s.challenge.count = 101),
    (s) => (s.drops = 101),
    (s) => (s.challenge.phase = 'settling'),
    (s) => (s.challenge.settlingTime = -1),
  ]) {
    const broken = structuredClone(saved);
    mutate(broken);
    assert.throws(() => g.restore(broken));
    assert.deepEqual(g.snapshot(), saved);
  }
  assert.throws(() => g.restore(baseline));
});
test('practice never changes classic best, collection or persistent preferences', () => {
  writes.length = 0;
  const g = make();
  g.addScore(1000, 200, 300);
  g.discover(11);
  g.restore(g.snapshot());
  assert.deepEqual(writes, []);
});

test('danger-line overshoot still produces a valid durable challenge result', () => {
  const g = make();
  g.drop();
  g.danger = 3.04;
  g.gameOver();
  assert.equal(g.snapshot().danger, 3);
  assert.equal(g.snapshot().challenge.reason, 'danger');
});

test('queued hundredth drop starts its settlement clock after that drop, not before it', () => {
  const g = make();
  for (let i = 0; i < 99; i++) {
    g.drop();
    g.world.clear();
  }
  g.cooldown = 0.001;
  g.pendingDrop = true;
  g.update(0.01);
  assert.equal(g.drops, 100);
  assert.equal(g.challenge.settlingTime, 0);
  g.update(0.01);
  assert.equal(g.challenge.settlingTime, 0.01);
});
