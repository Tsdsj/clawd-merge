import test from 'node:test';
import assert from 'node:assert/strict';

test('closing a modal preserves manual/background pause until explicit resume', async () => {
  const { PauseState } = await import('../src/pause.js');
  const state = new PauseState();
  state.set('manual', true);
  state.set('modal', true);
  state.set('background', true);
  state.set('modal', false);
  assert.equal(state.paused, true);
  assert.equal(state.has('background'), true);
  state.resume();
  assert.equal(state.paused, false);
  state.set('modal', true);
  state.resume();
  assert.equal(state.paused, true);
  state.clear();
  assert.equal(state.paused, false);
});

test('modal-only pause resumes on close and changes notify only when reasons change', async () => {
  const { PauseState } = await import('../src/pause.js');
  let changes = 0;
  const state = new PauseState(() => changes++);
  state.set('modal', true);
  state.set('modal', true);
  assert.equal(state.paused, true);
  state.set('modal', false);
  assert.equal(state.paused, false);
  assert.equal(changes, 2);
});

// Use the real Game methods with a minimal canvas: these tests do not render.
async function game(t) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  globalThis.localStorage = { getItem: (key) => key === 'clawd-merge:sound' ? 'off' : null, setItem() {} };
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  });
  const { Game } = await import('../src/game.js');
  return new Game({ getContext: () => ({}) });
}

test('pause freezes physics, danger, fever, cooldown and effects; resume never queues a drop', async (t) => {
  const g = await game(t);
  const body = g.spawnCrab(1, 120, 500);
  body.vy = 40;
  g.cooldown = 0.4;
  g.pendingDrop = true;
  g.danger = 2.8;
  g.feverTime = 6;
  g.acc = 0.004;
  g.card = { level: 2, t: 0.5, dur: 2.2 };
  g.setPaused(true);
  const before = { x: body.x, y: body.y, time: g.time, visual: g.visualTime, danger: g.danger, fever: g.feverTime, cooldown: g.cooldown, card: g.card.t };
  for (let i = 0; i < 120; i++) g.update(1 / 60);
  assert.deepEqual({ x: body.x, y: body.y, time: g.time, visual: g.visualTime, danger: g.danger, fever: g.feverTime, cooldown: g.cooldown, card: g.card.t }, before);
  assert.equal(g.pendingDrop, false);
  assert.equal(g.acc, 0);
  g.setPaused(false);
  g.update(1 / 60);
  assert.ok(g.time > 0 && g.time < 0.03);
  assert.equal(g.drops, 0);
  assert.ok(g.feverTime < before.fever);
});

test('paused game rejects aim, drops and claw use; reset preserves best and collection', async (t) => {
  const g = await game(t);
  const body = g.spawnCrab(1, 120, 500);
  g.claws = 1;
  g.clawMode = true;
  g.score = 120;
  g.best = 900;
  g.seen.add(5);
  const aim = g.aimX;
  g.setPaused(true);
  g.setAim(25);
  g.requestDrop();
  g.drop();
  g.toggleClaw();
  g.useClawAt(body.x, body.y);
  assert.equal(g.aimX, aim);
  assert.equal(g.drops, 0);
  assert.equal(g.claws, 1);
  assert.equal(g.clawMode, true);
  assert.equal(g.world.bodies.length, 1);
  g.reset();
  assert.equal(g.paused, false);
  assert.equal(g.score, 0);
  assert.equal(g.best, 900);
  assert.ok(g.seen.has(5));
  assert.equal(g.world.bodies.length, 0);
});
