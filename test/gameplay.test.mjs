import test from 'node:test';
import assert from 'node:assert/strict';

// Exercise real gameplay methods; rendering and persistent preferences are isolated.
globalThis.localStorage = { getItem: (key) => key === 'clawd-merge:sound' ? 'off' : null, setItem() {} };
const { Game } = await import('../src/game.js');
function game(t) {
  t.mock.method(Math, 'random', () => 0.5);
  return new Game({ getContext: () => ({}) });
}
function contact(a, b) { return { a, b, ia: 0, pen: 1 }; }
function merge(g, aLevel, bLevel = aLevel) {
  const a = g.spawnCrab(aLevel, 180, 400);
  const b = g.spawnCrab(bLevel, 200, 400);
  g.world.contacts = [contact(a, b)];
  g.handleMerges();
}

test('compound contacts and a third neighbour consume each crab at most once', (t) => {
  const g = game(t);
  const [a, b, c] = [180, 200, 220].map(x => g.spawnCrab(2, x, 400));
  g.world.contacts = [contact(a, b), contact(a, b), contact(b, c), contact(c, a)];
  g.handleMerges();
  assert.equal(g.score, 4);
  assert.deepEqual(g.world.bodies.map(b => b.level).sort(), [2, 3]);
  g.handleMerges(); // stale solver contacts must not consume them again
  assert.equal(g.score, 4);
});

test('rainbow upgrades the touched level in either order; two rainbows stay separate', (t) => {
  for (const levels of [[0, 5], [5, 0]]) {
    const g = game(t);
    merge(g, ...levels);
    assert.equal(g.score, 32);
    assert.deepEqual(g.world.bodies.map(b => b.level), [6]);
  }
  const g = game(t);
  merge(g, 0);
  assert.equal(g.score, 0);
  assert.equal(g.world.bodies.length, 2);
});

test('kings ascend without creating an invalid level, including rainbow + king', (t) => {
  for (const levels of [[11, 11], [0, 11]]) {
    const g = game(t);
    merge(g, ...levels);
    assert.equal(g.score, 4048);
    assert.equal(g.world.bodies.length, 0);
  }
});

test('different levels and separated contacts cannot merge', (t) => {
  const g = game(t);
  merge(g, 2, 3);
  const a = g.spawnCrab(2, 120, 400);
  g.world.contacts = [{ ...contact(g.world.bodies[0], a), pen: -1 }];
  g.handleMerges();
  assert.equal(g.score, 0);
  assert.equal(g.world.bodies.length, 3);
});

test('claws are rewarded only for new level milestones, capped at three, consumed only on hit', (t) => {
  const g = game(t);
  merge(g, 6);
  assert.equal(g.claws, 1);
  merge(g, 6);
  assert.equal(g.claws, 1);
  merge(g, 7);
  merge(g, 8);
  merge(g, 9);
  assert.equal(g.claws, 3);
  g.toggleClaw();
  assert.equal(g.useClawAt(-100, -100), false);
  assert.equal(g.claws, 3);
  const target = g.world.bodies[0];
  assert.equal(g.useClawAt(target.x, target.y), true);
  assert.equal(g.claws, 2);
  assert.equal(g.clawsUsed, 1);
  assert.equal(g.clawMode, false);
});

test('combo increases by 25%, caps at double, expires, and stacks with fever', (t) => {
  const g = game(t);
  const scores = [];
  for (let i = 0; i < 6; i++) {
    const before = g.score;
    merge(g, 4);
    scores.push(g.score - before);
    g.time += 0.2;
  }
  assert.deepEqual(scores, [16, 20, 24, 28, 32, 32]);
  g.time += 1.3;
  const before = g.score;
  merge(g, 4);
  assert.equal(g.score - before, 16);
  g.feverTime = 8;
  const feverBefore = g.score;
  merge(g, 4);
  assert.equal(g.score - feverBefore, 40);
});

test('fever threshold starts eight seconds and expires with simulation time', (t) => {
  const g = game(t);
  g.addFever(179);
  assert.equal(g.fever, false);
  g.addFever(1);
  assert.equal(g.feverTime, 8);
  assert.equal(g.feverMeter, 0);
  g.addFever(180);
  assert.equal(g.feverTime, 8);
  for (let i = 0; i < 481; i++) g.update(1 / 60);
  assert.equal(g.fever, false);
});

function highPile(g, grounded) {
  g.time = 5;
  const a = g.spawnCrab(2, 100, 120);
  const b = g.spawnCrab(3, 100, 300);
  a.born = b.born = 0;
  g.world.contacts = [contact(a, b)];
  if (grounded) g.world.contacts.push({ ia: -1, b });
  return a;
}
test('airborne touching cluster does not count as a settled dangerous pile', (t) => {
  const g = game(t);
  highPile(g, false);
  g.danger = 2;
  for (let i = 0; i < 240; i++) g.checkDanger(1 / 60);
  assert.equal(g.over, false);
  assert.equal(g.danger, 0);
});

test('supported pile loses after three settled seconds; fresh and fast crabs are exempt', (t) => {
  const g = game(t);
  const top = highPile(g, true);
  top.born = g.time;
  g.checkDanger(0.2);
  assert.equal(g.danger, 0);
  top.born = 0;
  top.vy = -300;
  g.checkDanger(0.2);
  assert.equal(g.danger, 0);
  top.vy = 0;
  g.checkDanger(0.1);
  assert.equal(g.danger, 0);
  for (let i = 0; i < 175; i++) g.checkDanger(1 / 60);
  assert.equal(g.over, false);
  for (let i = 0; i < 10; i++) g.checkDanger(1 / 60);
  assert.equal(g.over, true);
});

test('sleeping bodies retain support even when solver omits their contacts', (t) => {
  const g = game(t);
  const top = highPile(g, false);
  top.sleeping = true;
  g.world.contacts = [];
  g.checkDanger(0.2);
  assert.equal(g.warning, 2);
  assert.equal(g.danger, 0.2);
});
