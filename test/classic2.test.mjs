import test from 'node:test';
import assert from 'node:assert/strict';

// 与 gameplay.test.mjs 相同的隔离方式：禁音、不读真实偏好。
globalThis.localStorage = { getItem: (key) => key.endsWith(':sound') ? 'off' : null, setItem() {} };

const { chooseClassicDrop } = await import('../src/drop-sequence.js');
const { Game } = await import('../src/game.js');
const { SaveStore } = await import('../src/save-store.js');
const { RAINBOW } = await import('../src/crabs.js');

function mockGame(overrides = {}) {
  return {
    rulesVersion: 'classic-2',
    drops: 20,
    current: 1,
    currentSpecial: null,
    maxLevel: 5,
    specialLastAt: {},
    activeSpecialCount: () => 0,
    ...overrides,
  };
}
function seq(...values) {
  let i = 0;
  return () => values[i++ % values.length];
}

test('classic-1 keeps the legacy roll and never rolls specials', () => {
  const g = mockGame({ rulesVersion: 'classic-1', drops: 50 });
  const drop = chooseClassicDrop(seq(0.001), g);
  assert.equal(drop.special, null);
  assert.equal(drop.level, 0); // 旧彩虹独立掷骰仍然生效
});

test('the special slot picks kinds by weight and records the cooldown anchor', () => {
  const g = mockGame();
  // 0.001 通过 8% 特殊位；第二个 0.001 落在 rainbow 的 44/100 份额内
  assert.deepEqual(chooseClassicDrop(seq(0.001, 0.001), g), { level: 0, special: null });
  // 第二个 0.99: rainbow(44)+gold(24)+magnet(19)=87 之后落入 freeze
  const drop = chooseClassicDrop(seq(0.001, 0.99, 0.0), g);
  assert.equal(drop.special, 'freeze');
  assert.equal(drop.level, 1);
  assert.equal(g.specialLastAt.freeze, 20);
});

test('no consecutive specials; cooldown and active caps exclude kinds', () => {
  assert.equal(chooseClassicDrop(seq(0.001), mockGame({ currentSpecial: 'gold' })).special, null);
  assert.equal(chooseClassicDrop(seq(0.001), mockGame({ current: 0 })).special, null);
  assert.equal(chooseClassicDrop(seq(0.001), mockGame({ drops: 11 })).special, null);
  const g = mockGame({ drops: 20, specialLastAt: { magnet: 10 }, activeSpecialCount: (k) => k === 'freeze' ? 1 : 0 });
  // magnet 冷却中、freeze 已生效：只剩 rainbow(44)+gold(24)=68，0.99 只能落 gold
  const drop = chooseClassicDrop(seq(0.001, 0.99), g);
  assert.equal(drop.special, 'gold');
  // 三个非彩虹类全被挡住时，池里仍有 rainbow
  const blocked = mockGame({ drops: 20, specialLastAt: { gold: 19, magnet: 19, freeze: 19 } });
  assert.deepEqual(chooseClassicDrop(seq(0.001, 0.001), blocked), { level: 0, special: null });
});

test('new games default to classic-2; classic-1 saves restore and re-save under classic-1', () => {
  const g = new Game({ getContext: () => ({}) });
  assert.equal(g.rulesVersion, 'classic-2');
  assert.equal(g.specialRules, true);
  g.restore(g.snapshot(), 'classic-1');
  assert.equal(g.rulesVersion, 'classic-1');
  assert.equal(g.specialRules, false);
  assert.equal(g.snapshot().rulesVersion, 'classic-1');
});

test('challenge games never use classic-2 special rules', () => {
  const c = new Game({ getContext: () => ({}) }, {}, { seed: 1, challenge: { challengeId: 't1', rulesVersion: 'daily-1', count: 100 } });
  assert.equal(c.specialRules, false);
});

test('SaveStore accepts both versions and keeps outer stamps consistent', () => {
  const storage = new Map();
  const store = new SaveStore({
    scope: 'test',
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
  });
  store.owned = true;
  const g = new Game({ getContext: () => ({}) });
  g.restore(g.snapshot(), 'classic-1');
  const record = store.record('round-1', g.snapshot(), null);
  assert.equal(record.rulesVersion, 'classic-1');
  store.write(record);
  assert.equal(store.read().record.rulesVersion, 'classic-1');
  assert.throws(() => store.validate({ ...record, rulesVersion: 'classic-3' }));
  assert.throws(() => store.validate({ ...record, game: { ...record.game, rulesVersion: 'classic-2' } }));
});

test('special carriers ride the drop queue; snapshots keep gold and expire magnet/freeze', () => {
  const g = new Game({ getContext: () => ({}) }, {}, { seed: 7 });
  g.current = 2; g.currentSpecial = 'gold';
  g.drop();
  const gold = g.world.bodies.at(-1);
  assert.equal(gold.special, 'gold');
  assert.equal(g.currentSpecial, null); // 新 next 由 RNG 重掷
  g.discoverSpecial('gold');
  assert.ok(g.seenSpecials.has('gold'));

  const h = new Game({ getContext: () => ({}) }, {}, { seed: 9 });
  h.restore(JSON.parse(JSON.stringify(g.snapshot())));
  assert.equal(h.world.bodies.at(-1).special, 'gold'); // 金色无时限，持久化
  const magnet = h.spawnCrab(2, 200, 400);
  magnet.special = 'magnet'; magnet.specialUntil = h.time + 5;
  const frozen = h.spawnCrab(3, 260, 400);
  frozen.special = 'freeze'; frozen.specialUntil = h.time + 5;
  const state = JSON.parse(JSON.stringify(h.snapshot()));
  const k = new Game({ getContext: () => ({}) }, {}, { seed: 11 });
  k.restore(state);
  const levels = k.world.bodies.map((b) => b.special);
  assert.equal(levels.filter((s) => s === 'magnet' || s === 'freeze').length, 0); // 磁力/冰冻恢复即过期
  assert.equal(levels.filter((s) => s === 'gold').length, 1);
});

test('challenge drops never carry specials', () => {
  const c = new Game({ getContext: () => ({}) }, {}, { seed: 1, challenge: { challengeId: 't1', rulesVersion: 'daily-1', count: 100 } });
  c.drop();
  assert.equal(c.currentSpecial, null);
  assert.equal(c.nextSpecial, null);
});

test('special cooldown anchors survive a snapshot restore', () => {
  const g = new Game({ getContext: () => ({}) }, {}, { seed: 3 });
  g.drops = 20;
  g.specialLastAt = { gold: 20 };
  const h = new Game({ getContext: () => ({}) }, {}, { seed: 4 });
  h.restore(JSON.parse(JSON.stringify(g.snapshot())));
  assert.deepEqual(h.specialLastAt, { gold: 20 });
  h.specialLastAt.gold = 99;
  assert.equal(g.specialLastAt.gold, 20); // 恢复为独立副本，不共享原对象
});

function game(t) {
  t.mock.method(Math, 'random', () => 0.5);
  return new Game({ getContext: () => ({}) });
}
function contact(a, b) { return { a, b, ia: 0, ib: 0, nx: 0, ny: 1, pen: 1, px: 0, py: 0, Pn: 0, Pt: 0 }; }
function merge(g, aLevel, bLevel = aLevel) {
  const a = g.spawnCrab(aLevel, 180, 400);
  const b = g.spawnCrab(bLevel, 200, 400);
  g.world.contacts = [contact(a, b)];
  g.handleMerges();
  return [a, b];
}

test('gold doubles the merge base once, stacking with combo and fever to x8', (t) => {
  const g = game(t);
  const [a, b] = [g.spawnCrab(2, 180, 400), g.spawnCrab(2, 200, 400)];
  a.special = 'gold';
  g.world.contacts = [contact(a, b)];
  g.handleMerges();
  assert.equal(g.score, 8); // 4 × 2
  const [c, d] = [g.spawnCrab(2, 180, 400), g.spawnCrab(2, 200, 400)];
  c.special = 'gold';
  g.combo = 5; g.lastMergeAt = g.time; g.feverTime = 8;
  g.world.contacts = [contact(c, d)];
  g.handleMerges();
  assert.equal(g.score - 8, 32); // 4 × gold2 × combo2 × fever2
  assert.equal(g.world.bodies.filter((x) => x.special === 'gold').length, 0); // 金光耗尽
});

test('armed magnets pull same-level bodies inside the radius, then expire', (t) => {
  const g = game(t);
  const m = g.spawnCrab(2, 200, 500);
  m.special = 'magnet'; m.magnetArmed = true; m.specialUntil = g.time + 2.5;
  const t1 = g.spawnCrab(2, 320, 500); t1.vx = 0; t1.vy = 0;
  const other = g.spawnCrab(3, 260, 500); other.vx = 0;
  const far = g.spawnCrab(2, 200, 150); far.vx = 0;
  g.updateSpecials(1 / 120);
  assert.ok(t1.vx < 0); // 被拉向 x=200 的磁力
  assert.equal(other.vx, 0); // 不同级不拉
  assert.equal(far.vx, 0); // 超出半径不拉
  m.specialUntil = g.time; // 到期
  t1.vx = 0;
  g.updateSpecials(1 / 120);
  assert.equal(t1.vx, 0);
  assert.equal(m.special, null); // 载体普通化
});

test('magnet arms after landing, not at spawn', (t) => {
  const g = game(t);
  const m = g.spawnCrab(2, 200, 500);
  m.special = 'magnet';
  g.updateSpecials(1 / 120);
  assert.equal(m.magnetArmed, false);
  m.landedFor = 0.2;
  g.updateSpecials(1 / 120);
  assert.equal(m.magnetArmed, true);
  assert.ok(m.specialUntil > g.time);
});

test('freeze sleeps the connected pile, times out, and frozen crabs still merge', (t) => {
  const g = game(t);
  const carrier = g.spawnCrab(2, 200, 500);
  carrier.special = 'freeze'; carrier.landedFor = 0.2;
  const neighbour = g.spawnCrab(3, 200, 500);
  neighbour.y = 500 - carrier.bound - neighbour.bound; // 表面紧贴，必在冻结半径内
  const distant = g.spawnCrab(3, 60, 500);
  g.updateSpecials(1 / 120);
  assert.equal(carrier.special, null); // 效果已花在冻结上
  assert.equal(carrier.sleeping, true);
  assert.equal(neighbour.sleeping, true); // 几何相邻入堆
  assert.equal(distant.sleeping, false);
  assert.ok(carrier.frozenUntil > g.time);
  const partner = g.spawnCrab(2, 210, 380);
  g.world.contacts = [contact(carrier, partner)];
  g.handleMerges();
  assert.deepEqual(g.world.bodies.map((b) => b.level).sort(), [3, 3, 3]);
  assert.equal(g.score, 4);
});

test('frozen bodies above the line still feed the danger countdown and wake on timeout', (t) => {
  const g = game(t);
  g.time = 5;
  const f = g.spawnCrab(1, 200, 100);
  f.born = 0; f.sleep(); f.frozenUntil = g.time + 3;
  g.checkDanger(0.3);
  assert.ok(g.danger > 0); // 冻结不解救危险线
  f.frozenUntil = g.time;
  g.updateSpecials(1 / 120);
  assert.equal(f.sleeping, false);
});

test('two kings pause for a choice; ascend pays and crowns cycle every third', (t) => {
  const g = game(t);
  merge(g, 11);
  assert.ok(g.choice);
  assert.equal(g.score, 0);
  assert.equal(g.world.bodies.length, 2);
  assert.equal(g.resolveChoice('nonsense'), false);
  assert.equal(g.resolveChoice('ascend'), true);
  assert.equal(g.score, 4048);
  assert.equal(g.crowns, 1);
  assert.equal(g.world.bodies.length, 0);
  g.time += 0.1; merge(g, 11); g.resolveChoice('ascend');
  assert.equal(g.crowns, 2);
  g.time += 0.1; merge(g, 11); g.resolveChoice('ascend');
  assert.equal(g.crowns, 0);
  assert.equal(g.crownCycles, 1);
  // 升天沿用既有连击倍率：4048 + 4048×1.25 + (2048+2000+5000)×1.5
  assert.equal(g.score, 4048 + 5060 + 13572);
});

test('sweep spends the pair to clear levels 1-2 only, keeping rainbows and score', (t) => {
  const g = game(t);
  const a = g.spawnCrab(11, 180, 400);
  const b = g.spawnCrab(11, 200, 400);
  g.spawnCrab(1, 100, 550); g.spawnCrab(2, 150, 550);
  g.spawnCrab(3, 260, 550); g.spawnCrab(RAINBOW, 320, 550);
  g.world.contacts = [contact(a, b)];
  g.handleMerges();
  assert.ok(g.choice);
  g.requestDrop(); // 抉择期间输入被挡
  assert.equal(g.drops, 0);
  g.resolveChoice('sweep');
  assert.equal(g.score, 0);
  assert.deepEqual(g.world.bodies.map((x) => x.level).sort(), [0, 3]);
  assert.equal(g.crowns, 0);
});

test('classic-1 and challenge games keep automatic ascension', (t) => {
  const old = new Game({ getContext: () => ({}) }, {}, { seed: 1, rulesVersion: 'classic-1' });
  merge(old, 11);
  assert.equal(old.choice, null);
  assert.equal(old.score, 4048);
  const c = new Game({ getContext: () => ({}) }, {}, { seed: 1, challenge: { challengeId: 't1', rulesVersion: 'daily-1', count: 100 } });
  merge(c, 11);
  assert.equal(c.choice, null);
  assert.equal(c.score, 4048);
});

test('a snapshot taken mid-choice re-presents the choice after restore', (t) => {
  const g = game(t);
  merge(g, 11);
  const state = JSON.parse(JSON.stringify(g.snapshot()));
  const h = new Game({ getContext: () => ({}) }, {}, { seed: 5 });
  h.restore(state);
  h.handleMerges();
  assert.ok(h.choice);
  h.resolveChoice('ascend');
  assert.equal(h.score, 4048);
});
