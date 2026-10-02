import test from "node:test";
import assert from "node:assert/strict";
globalThis.localStorage = {
  getItem: (k) => (k.endsWith(":sound") ? "off" : null),
  setItem() {},
};
const { Game, enableHaptics } = await import("../src/game.js");
const standard = {
    reduced: false,
    shake: true,
    particles: true,
    haptics: false,
  },
  reduced = { reduced: true, shake: false, particles: false, haptics: false };
const make = (effects, challenge = null) =>
  new Game(
    { getContext: () => ({}) },
    {},
    { seed: 787, challenge, comfort: () => effects },
  );
test("disabled particles do not allocate; live reduction clears existing decoration but preserves messages", () => {
  const g = make(standard);
  g.burst(1, 1, 20);
  g.confetti();
  assert.ok(g.particles.length > 0);
  g.comfort = () => reduced;
  g.shake = 8;
  g.ring(1, 1, 2, 3, "red");
  g.floatText("+30", 1, 1, 16, "white");
  g.applyComfort();
  assert.equal(g.particles.length, 0);
  assert.equal(g.rings.length, 0);
  assert.equal(g.shake, 0);
  g.burst(1, 1, 10);
  g.dust(1, 1, 10);
  g.confetti();
  assert.equal(g.particles.length, 0);
  g.updateEffects(0.1);
  assert.equal(g.texts[0].y, 1);
});
test("standard and reduced settings have identical real physics and challenge results", () => {
  for (const challenge of [
    null,
    { challengeId: "2026-10-03", rulesVersion: "daily-1", count: 100 },
  ]) {
    const a = make(standard, challenge),
      b = make(reduced, challenge);
    for (let frame = 0; frame < 4200; frame++) {
      if (frame % 36 === 0) {
        const x = 45 + ((frame / 36) % 5) * 75;
        a.setAim(x);
        b.setAim(x);
        a.requestDrop();
        b.requestDrop();
      }
      a.update(1 / 60);
      b.update(1 / 60);
    }
    assert.deepEqual(a.snapshot(), b.snapshot());
    assert.ok(a.drops > 20);
    assert.ok(a.score > 0);
  }
});
test("reduced sprite preserves position and angle without squash/pop; danger still renders", () => {
  const g = make(reduced);
  let args;
  g.drawSprite = (...a) => (args = a);
  g.drawCrab(
    {},
    {
      blinkAt: 100,
      born: 0,
      pop: true,
      squash: 0.2,
      level: 3,
      x: 50,
      y: 70,
      angle: 0.4,
    },
  );
  assert.equal(args[4].sx, 1);
  assert.equal(args[4].sy, 1);
  assert.equal(args[4].angle, 0.4);
  const lines = [];
  const ctx = new Proxy(
    { strokeText: (t) => lines.push(t), fillText: (t) => lines.push(t) },
    {
      get: (o, k) => (k in o ? o[k] : () => {}),
      set: (o, k, v) => ((o[k] = v), true),
    },
  );
  g.danger = 1;
  g.drawCountdown(ctx, 3);
  assert.ok(lines.includes("危险 2.0"));
});
test("vibration requires explicit preference and a trusted-touch gate", () => {
  let calls = 0;
  const old = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      vibrate: () => {
        calls++;
      },
    },
  });
  try {
    const g = make({ ...standard, haptics: true });
    g.buzz(20);
    assert.equal(calls, 0);
    enableHaptics();
    g.buzz(20);
    assert.equal(calls, 1);
    g.comfort = () => reduced;
    g.buzz(20);
    assert.equal(calls, 1);
  } finally {
    if (old) Object.defineProperty(globalThis, "navigator", old);
    else delete globalThis.navigator;
  }
});
