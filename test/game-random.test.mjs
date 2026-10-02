import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.localStorage = { getItem: key => key.endsWith(':sound') ? 'off' : null, setItem() {} };
const { Game } = await import('../src/game.js');
const game = seed => new Game({ getContext: () => ({}) }, {}, { seed });
function drops(g, count, effects = false) {
  const levels = [];
  for (let i = 0; i < count; i++) {
    levels.push(g.current);
    if (effects) {
      g.burst(200, 400, 40); g.confetti(); g.dust(100, 100, 20);
      // Real blink rescheduling; only raster drawing is omitted in this unit test.
      g.drawSprite = () => {};
      g.drawCrab({}, { x: 100, y: 200, blinkAt: -10, born: 0, squash: 0, level: 1 });
      for (let j = 0; j < i % 5; j++) g.updateEffects(1 / 120);
    }
    g.drop(); g.world.clear();
  }
  return levels;
}
test('Game gameplay stream is independent of particles, blink/render calls and visual updates', () => {
  const quiet = game(78), busy = game(78);
  assert.deepEqual(drops(quiet, 100), drops(busy, 100, true));
});

test('snapshot preserves future classic sequence across different constructor seeds', () => {
  const original = game(9876);
  drops(original, 30);
  const state = JSON.parse(JSON.stringify(original.snapshot()));
  assert.ok(state.gameplayRandom, 'RNG state must be durable');
  const resumed = game(1234);
  resumed.restore(state); resumed.setPaused(false);
  assert.deepEqual(drops(original, 50), drops(resumed, 50, true));
});

test('old classic-1 snapshots stay loadable while invalid new RNG state is rejected atomically', () => {
  const original = game(78);
  drops(original, 3);
  const legacy = original.snapshot();
  delete legacy.gameplayRandom;
  const restored = game(3);
  restored.restore(legacy);
  assert.equal(restored.current, legacy.current);
  assert.equal(restored.next, legacy.next);
  assert.equal(restored.drops, 3);
  const before = restored.snapshot();
  for (const invalid of [null, {}, { algorithm: 'other', state: 1 }, { algorithm: 'mulberry32-1', state: -1 }]) {
    assert.throws(() => restored.restore({ ...before, gameplayRandom: invalid }));
    assert.deepEqual(restored.snapshot(), before);
  }
});
