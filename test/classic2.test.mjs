import test from 'node:test';
import assert from 'node:assert/strict';

// 与 gameplay.test.mjs 相同的隔离方式：禁音、不读真实偏好。
globalThis.localStorage = { getItem: (key) => key.endsWith(':sound') ? 'off' : null, setItem() {} };

const { chooseClassicDrop } = await import('../src/drop-sequence.js');
const { Game } = await import('../src/game.js');
const { SaveStore } = await import('../src/save-store.js');

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
  // 0.001 通过 6% 特殊位；第二个 0.001 落在 rainbow 的 40/100 份额内
  assert.deepEqual(chooseClassicDrop(seq(0.001, 0.001), g), { level: 0, special: null });
  // 第二个 0.99: rainbow(40)+gold(25)+magnet(20)=85 之后落入 freeze
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
  // magnet 冷却中、freeze 已生效：只剩 rainbow(40)+gold(25)=65，0.99 只能落 gold
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
