# classic-2 特殊掉落与后期目标 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 [classic-2 设计](design/classic-2-specials.md) 实现三只特殊Clawd（金色/磁力/冰冻）与后期目标（王冠信物、升天抉择），经典模式升 `classic-2`，历史榜与每日挑战不受影响。

**Architecture:** 规则常量集中在 `src/rules.js`，掉落由 `chooseClassicDrop` 单点分发；`Game` 按 `rulesVersion` 参数化（`classic-1` 旧局按旧规则打完）；磁力/冰冻只在 `Game.updateSpecials` 里以速度微调与强制休眠实现，不改物理求解器；王冠/抉择为 `Game` 状态 + 事件，UI 由 `main.js` 接线。

**Tech Stack:** 原生 ES Module + Canvas（零依赖）、node:test；`npm test` 全量回归。

**分支提示:** 当前分支是 `codex/a01-account-correctness`。开工前从当前 HEAD 拉 `classic-2` 分支执行，避免混入账号线提交。

**通用命令:**
- 单任务测试：`node --test test/classic2.test.mjs`
- 全量回归：`npm test`（预期基线 166 项 + 本计划新增项全部通过）
- 每个任务完成后按给定信息提交，不要混提无关文件。

---

### Task 1: 规则常量与特殊掉落函数

**Files:**
- Modify: `src/rules.js`（末尾追加常量，暂不把 `CLASSIC_RULES_VERSION` 改成 `classic-2`）
- Modify: `src/drop-sequence.js`
- Create: `test/classic2.test.mjs`

- [ ] **Step 1: 写失败测试**

新建 `test/classic2.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

// 与 gameplay.test.mjs 相同的隔离方式：禁音、不读真实偏好。
globalThis.localStorage = { getItem: (key) => key.endsWith(':sound') ? 'off' : null, setItem() {} };

const { chooseClassicDrop } = await import('../src/drop-sequence.js');

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/classic2.test.mjs`
Expected: FAIL — `chooseClassicDrop` 不是导出（`Does not provide an export named`）。

- [ ] **Step 3: 实现**

`src/rules.js` 末尾追加：

```js
// classic-2 特殊掉落与后期目标；classic-1 行为保持在其版本内不变。
export const CLASSIC_RULES_VERSIONS = ['classic-1', 'classic-2'];
export const SPECIAL_KINDS = Object.freeze(['gold', 'magnet', 'freeze']);
export const SPECIALS = Object.freeze({
  minDrops: 12,
  chance: 0.06,
  weights: Object.freeze({ rainbow: 40, gold: 25, magnet: 20, freeze: 15 }),
  kindCooldown: 25,
  maxActive: Object.freeze({ magnet: 1, freeze: 1 }),
  magnet: Object.freeze({ seconds: 2.5, radius: 130, accel: 320 }),
  freeze: Object.freeze({ seconds: 3 }),
});
export const CROWN_MAX = 3;
export const CROWN_BONUS = 5000;
```

`src/drop-sequence.js` 顶部 import 行改为：

```js
import { RULES, RAINBOW_CHANCE, RAINBOW_MIN_DROPS, CHALLENGE_RULES, SPECIALS, SPECIAL_KINDS } from './rules.js';
```

`chooseClassicLevel` 之后新增：

```js
function weightedKind(random, kinds) {
  const total = kinds.reduce((sum, kind) => sum + SPECIALS.weights[kind], 0);
  let value = random() * total;
  for (const kind of kinds) {
    value -= SPECIALS.weights[kind];
    if (value < 0) return kind;
  }
  return kinds.at(-1);
}

function eligibleKinds(game) {
  const kinds = [];
  for (const kind of ['rainbow', ...SPECIAL_KINDS]) {
    if (kind !== 'rainbow') {
      if (game.drops - (game.specialLastAt[kind] ?? -Infinity) < SPECIALS.kindCooldown) continue;
      const limit = SPECIALS.maxActive[kind];
      if (limit && game.activeSpecialCount(kind) >= limit) continue;
    }
    kinds.push(kind);
  }
  return kinds;
}

// classic-2: one special slot replaces the standalone rainbow roll.
export function chooseClassicDrop(random, game) {
  const cap = Math.max(3, Math.min(game.maxLevel, RULES.spawnWeights.length));
  if (game.rulesVersion !== 'classic-2') {
    return { level: chooseClassicLevel(random, game), special: null };
  }
  const busy = game.currentSpecial !== null || game.current === 0;
  if (!busy && game.drops >= SPECIALS.minDrops && random() < SPECIALS.chance) {
    const kind = weightedKind(random, eligibleKinds(game));
    if (kind === 'rainbow') return { level: 0, special: null };
    if (kind) {
      game.specialLastAt[kind] = game.drops;
      return { level: weightedLevel(random, RULES.spawnWeights.slice(0, cap)), special: kind };
    }
  }
  return { level: weightedLevel(random, RULES.spawnWeights.slice(0, cap)), special: null };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/classic2.test.mjs && npm test`
Expected: PASS（新增 3 项；全量不回归）。

- [ ] **Step 5: 提交**

```bash
git add src/rules.js src/drop-sequence.js test/classic2.test.mjs
git commit -m "feat: add classic-2 special drop rules and chooser"
```

---

### Task 2: 规则版本接入（classic-2 默认、双版本存档）

**Files:**
- Modify: `src/rules.js:2`（`CLASSIC_RULES_VERSION` 翻成 `classic-2`）
- Modify: `src/game.js`（构造/restore/reset、`specialRules`）
- Modify: `src/game-state.js`（快照 `rulesVersion`、恢复）
- Modify: `src/save-store.js`（受支持版本列表）
- Modify: `src/save-flow.js:147`
- Test: `test/classic2.test.mjs`

- [ ] **Step 1: 写失败测试**

`test/classic2.test.mjs` 追加（放在文件顶部 import 区之后）：

```js
const { Game } = await import('../src/game.js');
const { SaveStore } = await import('../src/save-store.js');

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/classic2.test.mjs`
Expected: FAIL — `g.rulesVersion` 为 `undefined`，`specialRules` 为 `undefined`。

- [ ] **Step 3: 实现**

`src/rules.js`：`export const CLASSIC_RULES_VERSION = 'classic-1';` → `export const CLASSIC_RULES_VERSION = 'classic-2';`

`src/game.js`：
1. import 行补 `CLASSIC_RULES_VERSION, CLASSIC_RULES_VERSIONS`（来自 `./rules.js`）。
2. 构造器签名保持，options 解构中加 `rulesVersion`：

```js
constructor(canvas, events = {}, { seed, challenge = null, comfort = () => DEFAULT_EFFECTS, rulesVersion } = {}) {
```

构造器 `this.challengeDefinition = ...` 之后加：

```js
this.rulesVersion = CLASSIC_RULES_VERSIONS.includes(rulesVersion) ? rulesVersion : CLASSIC_RULES_VERSION;
```

3. `reset()` 开头加 `this.rulesVersion = CLASSIC_RULES_VERSION;`（旧局打完重开即回到最新规则）。
4. `get settling` 旁加：

```js
// classic-2 specials never leak into daily-1 challenges or restored classic-1 games.
get specialRules() {
  return !this.challengeDefinition && this.rulesVersion === 'classic-2';
}
```

5. `restore` 改签名为：

```js
restore(state, rulesVersion) {
  restoreGame(this, state, rulesVersion);
```

`src/game-state.js`：
1. import 补 `CLASSIC_RULES_VERSIONS`：在 `export { CLASSIC_RULES_VERSION as RULES_VERSION } from './rules.js';` 下加 `import { CLASSIC_RULES_VERSIONS } from './rules.js';`
2. `validateGameState` 开头对象检查后加：

```js
if (Object.hasOwn(s, 'rulesVersion')) requireValue(CLASSIC_RULES_VERSIONS.includes(s.rulesVersion));
```

3. `captureGame` 返回对象中 `...(g.challenge ? { challenge: { ...g.challenge } } : {})` 改为：

```js
...(g.challenge ? { challenge: { ...g.challenge } } : { rulesVersion: g.rulesVersion })
```

4. `restoreGame` 签名改 `restoreGame(g, state, rulesVersion)`，函数体开头 `validateGameState(state);` 后加：

```js
if (rulesVersion) requireValue(CLASSIC_RULES_VERSIONS.includes(rulesVersion));
```

`g.world = world;` 赋值行之前加：

```js
if (!state.challenge) g.rulesVersion = rulesVersion ?? state.rulesVersion ?? 'classic-1';
```

`src/save-store.js`：
1. import 行改为：

```js
import { SCHEMA_VERSION, RULES_VERSION, CLASSIC_RULES_VERSIONS, validateGameState } from './game-state.js';
```

并在 `src/game-state.js` 的导出行补上 `CLASSIC_RULES_VERSIONS`：

```js
export { CLASSIC_RULES_VERSION as RULES_VERSION, CLASSIC_RULES_VERSIONS } from './rules.js';
```

2. `validate` 中 `r.rulesVersion!==RULES_VERSION` 改为 `!CLASSIC_RULES_VERSIONS.includes(r.rulesVersion)`；下一行 `if(r.terminal)` 之前加一致性检查：

```js
if(r.game && r.game.rulesVersion!==undefined && r.game.rulesVersion!==r.rulesVersion)throw new Error('invalid_save');
```

3. `record` 中 `rulesVersion:RULES_VERSION` 改为 `rulesVersion:game.rulesVersion ?? RULES_VERSION`（此处 `game` 参数是快照对象）。`stageResult` 保持 `RULES_VERSION`（终止记录不作对局恢复）。

`src/save-flow.js` 第 147 行 `game.restore(record.game);` 改为 `game.restore(record.game, record.rulesVersion);`

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/classic2.test.mjs && npm test`
Expected: PASS。若 `save.test.mjs`/`pause.test.mjs` 有手工构造的记录失败，只按同样规则修正测试数据（不放宽校验）。

- [ ] **Step 5: 提交**

```bash
git add src/rules.js src/game.js src/game-state.js src/save-store.js src/save-flow.js test/classic2.test.mjs
git commit -m "feat: version classic rules and keep classic-1 saves playable"
```

---

### Task 3: 掉落接线与特殊快照字段

**Files:**
- Modify: `src/game.js`（drop/reset/spawnCrab/discoverSpecial/activeSpecialCount）
- Modify: `src/game-state.js`（fields/bodyFields/校验/恢复默认值）
- Test: `test/classic2.test.mjs`

- [ ] **Step 1: 写失败测试**

`test/classic2.test.mjs` 追加：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/classic2.test.mjs`
Expected: FAIL — `g.nextSpecial`/`discoverSpecial`/`seenSpecials` 未定义，`crab.special` 为 `undefined`。

- [ ] **Step 3: 实现**

`src/game.js`：
1. import 补 `SPECIALS`（rules.js）与 `chooseClassicDrop`（drop-sequence.js）；`chooseClassicLevel` import 移除。
2. 常量区加：

```js
const SEEN_SPECIALS_KEY = 'clawd-merge:seen-specials';

function loadSeenSpecials() {
  try {
    const list = JSON.parse(readPreference(SEEN_SPECIALS_KEY) || '[]');
    return new Set(list.filter((k) => SPECIAL_KINDS.includes(k)));
  } catch {
    return new Set();
  }
}
```

（SPECIAL_KINDS 一并加入 rules.js 的 import。）
3. 构造器 `this.seen = ...` 行后加 `this.seenSpecials = this.persistPreferences ? loadSeenSpecials() : new Set();`
4. `reset()` 中 `this.clawsUsed = 0;` 附近加：

```js
this.currentSpecial = null;
this.nextSpecial = null;
this.specialLastAt = {};
```

`this.current = ... / this.next = ...` 两行改为：

```js
const upcoming = this.dropSequence ? null : this.randomDrop();
this.current = this.dropSequence?.[0] ?? 1;
this.currentSpecial = null;
this.next = this.dropSequence ? this.dropSequence[1] : upcoming.level;
this.nextSpecial = this.dropSequence ? null : upcoming.special;
```

末尾 `this.events.onNext?.(this.next)` 改为 `this.events.onNext?.(this.next, this.nextSpecial);`
5. `randomLevel()` 改名为：

```js
randomDrop() {
  return chooseClassicDrop(() => this.gameplayRandom.next(), this);
}

activeSpecialCount(kind) {
  return this.world.bodies.reduce((n, b) => n + (b.special === kind && b.specialUntil > this.time ? 1 : 0), 0);
}
```

6. `drop()` 中 `this.current = this.dropSequence ? ...` 到 `this.next = ...` 三行改为：

```js
if (this.dropSequence) {
  this.current = this.dropSequence[this.drops] ?? null;
  this.currentSpecial = null;
  this.next = this.dropSequence[this.drops + 1] ?? null;
  this.nextSpecial = null;
} else {
  this.current = this.next;
  this.currentSpecial = this.nextSpecial;
  const upcoming = this.randomDrop();
  this.next = upcoming.level;
  this.nextSpecial = upcoming.special;
}
```

`const level = this.current;` 后加 `const special = this.currentSpecial;`，`crab.vy = 120;` 后加 `crab.special = special;`；`if (level === RAINBOW ...)` 行后加：

```js
if (special && !this.seenSpecials.has(special)) this.discoverSpecial(special);
```

`this.events.onNext?.(this.next)` 改为 `this.events.onNext?.(this.next, this.nextSpecial);`
7. `spawnCrab` 中 `crab.merged = false;` 行后加：

```js
crab.special = null;
crab.specialUntil = 0;
crab.magnetArmed = false;
crab.froze = false;
crab.frozenUntil = 0;
```

8. `discover` 方法后加：

```js
discoverSpecial(kind) {
  this.seenSpecials.add(kind);
  if (this.persistPreferences && !writePreference(SEEN_SPECIALS_KEY, JSON.stringify([...this.seenSpecials]))) this.persistenceWarning = true;
  sfx.discover();
  this.events.onDiscoverSpecial?.(this.seenSpecials);
}
```

`src/game-state.js`：
1. import 补 `SPECIAL_KINDS`。
2. `fields` 数组 `'clawsUsed'` 后加 `,'currentSpecial','nextSpecial'`；`bodyFields` 末尾加 `,'special'`。
3. `validateGameState` 中 `if(Object.hasOwn(s,'clawsUsed'))...` 行后加：

```js
const specialOrNull = (v) => v === null || SPECIAL_KINDS.includes(v);
if (Object.hasOwn(s, 'currentSpecial') || Object.hasOwn(s, 'nextSpecial')) {
  requireValue(specialOrNull(s.currentSpecial) && specialOrNull(s.nextSpecial));
}
```

body 循环内 `requireValue(b && number(b.level,0,11,true) && typeof b.sleeping === 'boolean');` 后加：

```js
if (Object.hasOwn(b, 'special')) requireValue(specialOrNull(b.special));
```

4. `restoreGame` 中 `g.clawsUsed = state.clawsUsed ?? 0;` 行后加：

```js
g.currentSpecial = state.currentSpecial ?? null;
g.nextSpecial = state.nextSpecial ?? null;
```

body 循环 `Object.assign(b,pick(data,bodyFields));` 后加：

```js
b.special = data.special === 'gold' ? 'gold' : null;
b.specialUntil = 0; b.magnetArmed = false; b.froze = false; b.frozenUntil = 0;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/classic2.test.mjs && npm test`
Expected: PASS（快照新字段自动进入既有 save/pause 回归，不放宽任何校验）。

- [ ] **Step 5: 提交**

```bash
git add src/game.js src/game-state.js test/classic2.test.mjs
git commit -m "feat: wire special drops through the classic queue and snapshots"
```

---

### Task 4: 金色Clawd 计分

**Files:**
- Modify: `src/game.js`（upgrade 双倍与文案）
- Test: `test/classic2.test.mjs`

- [ ] **Step 1: 写失败测试**

`test/classic2.test.mjs` 追加（含 `game`/`contact`/`merge` 辅助，风格同 gameplay.test.mjs）：

```js
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
  return [a, b];
}

test('gold doubles the merge base once, stacking with combo and fever to x8', () => {
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/classic2.test.mjs`
Expected: FAIL — 得 4 而非 8。

- [ ] **Step 3: 实现**

`src/game.js` `upgrade()` 中 `const colors = rainbow ? RAINBOW_COLORS : null;` 后加：

```js
const gold = consumed.some((b) => b.special === 'gold');
```

MAX_LEVEL 分支首行 `this.addScore(...)` 改为：

```js
this.addScore(Math.round((RULES.points(level) * (gold ? 2 : 1) + KING_BONUS) * mult), x, y);
```

普通分支 `const points = Math.round(RULES.points(level) * mult);` 改为：

```js
const points = Math.round(RULES.points(level) * (gold ? 2 : 1) * mult);
this.addScore(points, x, y);
if (gold) this.floatText('金色 ×2!', x, y - 48, 18, '#F7C948', 1.2);
```

（原 `this.addScore(points, x, y);` 保留在其后。）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/classic2.test.mjs && npm test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/game.js test/classic2.test.mjs
git commit -m "feat: gold clawd doubles one merge's base score"
```

---

### Task 5: 磁力Clawd

**Files:**
- Modify: `src/game.js`（`updateSpecials`、update 步循环、输入守卫）
- Test: `test/classic2.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
test('armed magnets pull same-level bodies inside the radius, then expire', () => {
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

test('magnet arms after landing, not at spawn', () => {
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/classic2.test.mjs`
Expected: FAIL — `updateSpecials` 不是方法。

- [ ] **Step 3: 实现**

`src/game.js`：
1. `update()` 步循环中 `this.world.step(STEP);` 前加 `this.updateSpecials(STEP);`
2. `handleImpacts` 前新增方法：

```js
// Special-carrier effects run inside the physics step: velocity nudges only,
// never solver changes, so pile stability is untouched.
updateSpecials(dt) {
  for (const b of this.world.bodies) {
    if (b.special === 'magnet' && !b.magnetArmed && (b.landedFor ?? 0) >= RULES.landedTime) {
      b.magnetArmed = true;
      b.specialUntil = this.time + SPECIALS.magnet.seconds;
    }
  }
  for (const m of this.world.bodies) {
    if (m.special !== 'magnet' || !m.magnetArmed) continue;
    if (this.time >= m.specialUntil) {
      m.special = null;
      continue;
    }
    for (const t of this.world.bodies) {
      if (t === m || t.merged || t.level !== m.level) continue;
      const dx = m.x - t.x;
      const dy = m.y - t.y;
      const d = Math.hypot(dx, dy);
      if (d > SPECIALS.magnet.radius || d < 1) continue;
      t.wake();
      t.vx += (dx / d) * SPECIALS.magnet.accel * dt;
      t.vy += (dy / d) * SPECIALS.magnet.accel * dt;
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/classic2.test.mjs && npm test`
Expected: PASS（既有 pause/save 回归不受影响：updateSpecials 对普通局是空转）。

- [ ] **Step 5: 提交**

```bash
git add src/game.js test/classic2.test.mjs
git commit -m "feat: magnet clawd pulls same-level neighbours for a short window"
```

---

### Task 6: 冰冻Clawd

**Files:**
- Modify: `src/game.js`（`freezeCluster`、updateSpecials 冻结分支）
- Test: `test/classic2.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
test('freeze sleeps the connected pile, times out, and frozen crabs still merge', () => {
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

test('frozen bodies above the line still feed the danger countdown and wake on timeout', () => {
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/classic2.test.mjs`
Expected: FAIL — 冻结分支不存在，`carrier.special` 仍为 `'freeze'`。

- [ ] **Step 3: 实现**

`src/game.js` `updateSpecials` 第一个 for 循环体内，magnet 分支后加：

```js
if (b.special === 'freeze' && !b.froze && (b.landedFor ?? 0) >= RULES.landedTime) {
  b.froze = true;
  this.freezeCluster(b);
}
if (b.frozenUntil > 0 && this.time >= b.frozenUntil && b.sleeping) {
  b.frozenUntil = 0;
  b.wake(); // 引擎会在真正静止后重新自然入睡
}
```

新增方法（放 `updateSpecials` 后）：

```js
// Force-sleep the carrier's geometrically connected pile. Sleeping bodies
// act static (island reuse); a falling partner still wakes them on contact,
// so frozen targets remain mergeable by design.
freezeCluster(carrier) {
  const pile = this.world.bodies.filter((b) => b !== carrier);
  const queue = [carrier];
  const seen = new Set(queue);
  while (queue.length) {
    const b = queue.pop();
    for (const o of pile) {
      if (seen.has(o)) continue;
      if (Math.hypot(o.x - b.x, o.y - b.y) <= o.bound + b.bound + 4) {
        seen.add(o);
        queue.push(o);
      }
    }
  }
  const until = this.time + SPECIALS.freeze.seconds;
  for (const b of seen) {
    b.frozenUntil = until;
    if (!b.sleeping) b.sleep();
  }
  carrier.special = null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/classic2.test.mjs && npm test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/game.js test/classic2.test.mjs
git commit -m "feat: freeze clawd locks a connected pile for three seconds"
```

---

### Task 7: 王冠信物与升天抉择

**Files:**
- Modify: `src/game.js`（ascend 提取、handleMerges 路由、resolveChoice、choice 守卫、reset/快照字段）
- Modify: `src/game-state.js`（fields/校验/恢复默认值）
- Modify: `src/audio.js`（`crown`、`sweep`）
- Test: `test/classic2.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
test('two kings pause for a choice; ascend pays and crowns cycle every third', () => {
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
  assert.equal(g.score, 4048 * 2 + 9048); // 第三次含 +5000
});

test('sweep spends the pair to clear levels 1-2 only, keeping rainbows and score', () => {
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

test('classic-1 and challenge games keep automatic ascension', () => {
  const old = new Game({ getContext: () => ({}) }, {}, { seed: 1, rulesVersion: 'classic-1' });
  merge(old, 11);
  assert.equal(old.choice, null);
  assert.equal(old.score, 4048);
  const c = new Game({ getContext: () => ({}) }, {}, { seed: 1, challenge: { challengeId: 't1', rulesVersion: 'daily-1', count: 100 } });
  merge(c, 11);
  assert.equal(c.choice, null);
  assert.equal(c.score, 4048);
});

test('a snapshot taken mid-choice re-presents the choice after restore', () => {
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
```

注意：`merge` 辅助里挑战局不能用 `game(t)`（那是 classic-2 默认），上面已分别显式构造。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/classic2.test.mjs`
Expected: FAIL — 双 11 直接合体（`g.choice` 为 `undefined`），`resolveChoice` 不存在。

- [ ] **Step 3: 实现**

`src/game.js`：
1. `reset()` 中 `this.clawsUsed = 0;` 附近加 `this.crowns = 0; this.crownCycles = 0; this.choice = null;`
2. `update()` 第一行 `if (this.paused) return;` 改为 `if (this.paused || this.choice) return;`
3. 输入守卫补 `this.choice`：`requestDrop`、`drop`、`setAim`、`toggleClaw`、`useClawAt` 的条件里各加 `|| this.choice`。
4. `handleMerges()` 整体替换为：

```js
handleMerges() {
  if (this.choice) return;
  const pairs = [];
  for (const c of this.world.contacts) {
    const { a, b } = c;
    if (c.ia < 0 || a.merged || b.merged || c.pen < -0.5) continue;
    const ra = a.level === RAINBOW;
    const rb = b.level === RAINBOW;
    if (ra !== rb) {
      // The rainbow Clawd upgrades whatever it touches.
      pairs.push(ra ? [a, b, true] : [b, a, true]);
    } else if (!ra && a.level === b.level) {
      if (a.level === MAX_LEVEL && this.specialRules) {
        this.beginChoice(a, b);
        return;
      }
      pairs.push([a, b, false]);
    } else {
      continue;
    }
    a.merged = true;
    b.merged = true;
  }
  for (const [a, b, rainbow] of pairs) {
    if (rainbow) this.upgrade([a, b], b.level, b.x, b.y, b, true);
    else this.upgrade([a, b], a.level, (a.x + b.x) / 2, (a.y + b.y) / 2, a, false);
  }
}

// classic-2: two proper kings freeze the board and let the player choose.
beginChoice(a, b) {
  this.choice = { a, b };
  this.events.onChoice?.();
}

resolveChoice(option) {
  if (!this.choice || (option !== 'ascend' && option !== 'sweep')) return false;
  const { a, b } = this.choice;
  this.choice = null;
  const x = (a.x + b.x) / 2;
  const y = (a.y + b.y) / 2;
  if (option === 'ascend') {
    this.combo = this.time - this.lastMergeAt <= COMBO_WINDOW ? this.combo + 1 : 1;
    this.lastMergeAt = this.time;
    const mult = Math.min(RULES.maxComboMult, 1 + RULES.comboStep * (this.combo - 1)) * (this.fever ? 2 : 1);
    this.ascend([a, b], MAX_LEVEL, x, y, mult, false, null);
    this.events.onChoiceEnd?.('ascend');
    return true;
  }
  for (const king of [a, b]) {
    this.world.remove(king);
    this.world.wakeNear(king.x, king.y, king.bound + 20);
  }
  for (const small of this.world.bodies.filter((s) => s.level >= 1 && s.level <= 2)) {
    this.world.remove(small);
    this.world.wakeNear(small.x, small.y, small.bound + 20);
    this.burst(small.x, small.y, 6, ['#F7C948', '#FFE08A', '#FFFFFF']);
  }
  this.burst(x, y, 60, ['#F7C948', '#D97757', '#FFFFFF']);
  this.ring(x, y, 40, 280, '#F7C948');
  this.shake = this.effects.shake ? 10 : 0;
  this.floatText('王冠清扫!', WORLD_W / 2, WORLD_H / 2 - 40, 30, '#F7C948', 2);
  sfx.sweep();
  this.buzz(80);
  this.events.onChoiceEnd?.('sweep');
  return true;
}
```

5. `upgrade()` 的 MAX_LEVEL 分支整体移入新方法 `ascend`（`upgrade` 里替换为一次调用）。`upgrade` 中分支处改为：

```js
// Two kings (or a king + rainbow) ascend into a big bonus.
if (level === MAX_LEVEL) {
  this.ascend(consumed, level, x, y, mult, gold, colors);
  return;
}
```

新方法（`upgrade` 之后）：

```js
// Removes the kings, pays the bonus, and advances the crown track.
ascend(consumed, level, x, y, mult, gold, colors) {
  for (const b of consumed) {
    this.world.remove(b);
    this.world.wakeNear(b.x, b.y, b.bound + 20);
  }
  this.crowns++;
  const crowned = this.crowns >= CROWN_MAX;
  if (crowned) {
    this.crowns = 0;
    this.crownCycles++;
  }
  const bonus = KING_BONUS + (crowned ? CROWN_BONUS : 0);
  this.addScore(Math.round((RULES.points(level) * (gold ? 2 : 1) + bonus) * mult), x, y);
  this.burst(x, y, crowned ? 140 : 90, colors ?? ['#F7C948', '#FFE08A', '#D97757', '#FFFFFF']);
  this.ring(x, y, 40, 260, '#F7C948');
  this.shake = this.effects.shake ? (crowned ? 16 : 12) : 0;
  this.floatText(crowned ? '王冠集满!' : 'Clawd 之王!', WORLD_W / 2, WORLD_H / 2 - 40, 30, '#F7C948', 2);
  sfx.jackpot();
  if (crowned) sfx.crown();
  this.buzz(80);
  this.addFever(20);
  this.events.onCrowns?.(this.crowns, this.crownCycles);
}
```

（import 补 `CROWN_MAX, CROWN_BONUS`；原 MAX 分支的特效逐行迁移，`colors ??` 语义保留彩虹升天路径。）
`reset()` 末尾加 `this.events.onCrowns?.(this.crowns, this.crownCycles);`

`src/game-state.js`：
1. `fields` 补 `,'crowns','crownCycles'`。
2. 校验，紧跟 currentSpecial 块后加：

```js
if (Object.hasOwn(s, 'crowns') || Object.hasOwn(s, 'crownCycles')) {
  requireValue(number(s.crowns, 0, 2, true) && number(s.crownCycles, 0, 1e9, true));
}
```

3. `restoreGame` 恢复默认值区补：

```js
g.crowns = state.crowns ?? 0;
g.crownCycles = state.crownCycles ?? 0;
g.choice = null;
```

`src/audio.js` `sfx` 对象内追加：

```js
crown() {
  [523, 659, 784, 1047, 1319].forEach((f, i) => blip(f, { at: i * 0.07, dur: 0.16, type: 'triangle', vol: 0.06 }));
},
sweep() {
  blip(880, { dur: 0.3, to: 110, type: 'sawtooth', vol: 0.06 });
  blip(440, { at: 0.1, dur: 0.25, to: 80, type: 'triangle', vol: 0.06 });
},
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/classic2.test.mjs && npm test`
Expected: PASS。注意 gameplay.test.mjs 既有「kings ascend」用例仍必须通过（默认 Game 已是 classic-2 → 走抉择路径 → 该用例需同步更新为「`resolveChoice('ascend')` 后 4048」——只改断言路径，不改 4048 语义）。

- [ ] **Step 5: 提交**

```bash
git add src/game.js src/game-state.js src/audio.js test/classic2.test.mjs test/gameplay.test.mjs
git commit -m "feat: crown track and king ascension choice for classic-2"
```

---

### Task 8: 表现层与 UI 接线

**Files:**
- Modify: `src/game.js`（drawSpecialOverlay、drawCrowns、drawAim 徽标）
- Modify: `src/audio.js`（`gold`/`magnet`/`freeze` 音效与调用点）
- Modify: `src/main.js`（onChoice/onChoiceEnd/onCrowns/onNext 徽标、图鉴特殊篇）
- Modify: `index.html`（抉择面板）、`src/style.css`（面板与徽标样式）

- [ ] **Step 1: 画布叠层与音效（先实现后浏览器验证）**

`src/game.js`：

1. 常量区加 `const SPECIAL_COLORS = { gold: '#F7C948', magnet: '#8FE3FF', freeze: '#9FD8FF' };`
2. `drawCrab` 末尾加 `this.drawSpecialOverlay(ctx, crab);`，新增方法：

```js
drawSpecialOverlay(ctx, crab) {
  if (crab.special === 'gold') {
    ctx.save();
    ctx.globalAlpha = 0.22 + (this.effects.reduced ? 0 : 0.08 * Math.sin(this.visualTime * 6));
    ctx.fillStyle = '#F7C948';
    ctx.beginPath();
    ctx.arc(crab.x, crab.y, crab.bound * 0.85, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else if (crab.special === 'magnet' && crab.magnetArmed && this.time < crab.specialUntil) {
    ctx.save();
    ctx.strokeStyle = 'rgba(143, 227, 255, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.arc(crab.x, crab.y, SPECIALS.magnet.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  if (crab.frozenUntil > this.time) {
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#9FD8FF';
    ctx.beginPath();
    ctx.arc(crab.x, crab.y, crab.bound + 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
```

3. `render()` 中 `this.drawFeverBar(ctx, now);` 后加 `if (this.specialRules) this.drawCrowns(ctx);`，新增：

```js
// Crown pips appear only after the first ascension, so new boards stay clean.
drawCrowns(ctx) {
  if (this.crowns === 0 && this.crownCycles === 0) return;
  ctx.save();
  for (let i = 0; i < CROWN_MAX; i++) {
    const x = 14 + i * 20;
    ctx.beginPath();
    ctx.moveTo(x - 6, 24);
    ctx.lineTo(x - 6, 14);
    ctx.lineTo(x - 2, 19);
    ctx.lineTo(x, 12);
    ctx.lineTo(x + 2, 19);
    ctx.lineTo(x + 6, 14);
    ctx.lineTo(x + 6, 24);
    ctx.closePath();
    if (i < this.crowns) {
      ctx.fillStyle = '#F7C948';
      ctx.fill();
    } else {
      ctx.strokeStyle = 'rgba(247, 201, 72, 0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  if (this.crownCycles > 0) {
    ctx.font = `800 11px ${FONT}`;
    ctx.fillStyle = '#F7C948';
    ctx.textAlign = 'left';
    ctx.fillText(`×${this.crownCycles}`, 14 + CROWN_MAX * 20, 24);
  }
  ctx.restore();
}
```

4. `drawAim` 末尾 `this.drawSprite(...)` 后加投放预览徽标：

```js
if (this.currentSpecial) {
  ctx.fillStyle = SPECIAL_COLORS[this.currentSpecial];
  ctx.beginPath();
  ctx.arc(x + extentOf(level).right + 10, DROP_Y + bob, 4, 0, Math.PI * 2);
  ctx.fill();
}
```

`src/audio.js` 追加（并在 Task 4/5/6 的调用点接线）：

```js
gold() {
  blip(880, { dur: 0.07 });
  blip(1320, { at: 0.07, dur: 0.09, vol: 0.06 });
},
magnet() {
  blip(220, { dur: 0.3, to: 330, type: 'triangle', vol: 0.05 });
},
freeze() {
  [1568, 1245, 988].forEach((f, i) => blip(f, { at: i * 0.05, dur: 0.1, type: 'triangle', vol: 0.05 }));
},
```

调用点：`upgrade()` 金色分支 `if (gold) { sfx.gold(); this.floatText(...); }`；`updateSpecials` magnet 起效处加 `sfx.magnet();`；`freezeCluster` 末尾加 `sfx.freeze();`。

- [ ] **Step 2: 抉择面板 DOM 与接线**

`index.html` `#board` 内、`#pause-cover` 之后加：

```html
<div class="choice-cover hidden" id="choice-cover" role="region" aria-labelledby="choice-title">
  <div class="choice-panel">
    <h2 id="choice-title">两只大Clawd 合体了</h2>
    <p class="choice-copy">这对王冠只能换一样。</p>
    <button class="btn" id="choice-ascend" type="button">升天 · +2000 分，王冠 +1</button>
    <button class="btn ghost" id="choice-sweep" type="button">王冠清扫 · 清掉全部小Clawd，不计分</button>
  </div>
</div>
```

`src/style.css`（样式跟随 `.pause-cover`/面板既有令牌，不发明新视觉）：

```css
.choice-cover { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(10, 12, 24, 0.55); z-index: 6; }
.choice-panel { display: grid; gap: 10px; text-align: center; background: #1E1B2E; border-radius: 14px; padding: 20px; max-width: 280px; }
.choice-copy { margin: 0; }
```

`src/main.js` Game events 对象内追加：

```js
onChoice() {
  $('choice-cover').classList.remove('hidden');
  $('choice-ascend').focus();
},
onChoiceEnd() {
  $('choice-cover').classList.add('hidden');
},
onCrowns(crowns) {
  if (crowns > 0) featureTip('crown', `王冠 ${crowns}/3：再升天 ${3 - crowns} 次，集满庆典 +5000。`);
},
```

（`choice-cover` 关闭兜底：按钮之外不提供关闭路径，两个按钮都必须可键盘触达。）按钮接线放在 `restart` 等既有 DOM 接线区：

```js
$('choice-ascend').onclick = () => game.resolveChoice('ascend');
$('choice-sweep').onclick = () => game.resolveChoice('sweep');
```

- [ ] **Step 3: 「下一个」徽标与图鉴特殊篇**

`src/main.js`：`onNext(level)` 改签名 `onNext(level, special)`，函数体加：

```js
nextBox.dataset.special = special || '';
if (special) featureTip(special, SPECIAL_INFO[special].tip);
```

（先在 `index.html` 给 `#next` 的父容器加 `id="next-box"`，`main.js` 顶部取 `const nextBox = $('next-box');`）：

```js
const SPECIAL_INFO = {
  gold: { name: '金色Clawd', tip: '金色 Clawd：它参与的那次合成，得分 ×2！' },
  magnet: { name: '磁力Clawd', tip: '磁力 Clawd：落地后短暂吸附同级，帮你完成差一点的合成。' },
  freeze: { name: '冰冻Clawd', tip: '冰冻 Clawd：落地冻结一堆，几秒内稳如泰山。' },
};
```

`src/style.css`：

```css
.next-box[data-special="gold"] #next { box-shadow: 0 0 0 2px #F7C948; border-radius: 6px; }
.next-box[data-special="magnet"] #next { box-shadow: 0 0 0 2px #8FE3FF; border-radius: 6px; }
.next-box[data-special="freeze"] #next { box-shadow: 0 0 0 2px #9FD8FF; border-radius: 6px; }
```

图鉴：`legend` 构建后追加特殊篇（图标复用 `drawCrabIcon` 画 3 级载体 + dataset 着色；未解锁显示剪影，同 RAINBOW 的 `hidden` 逻辑用 `game.seenSpecials`）：

```js
const specialLegend = SPECIAL_KINDS.map((kind) => {
  const item = document.createElement('div');
  item.className = 'legend-item legend-special';
  item.dataset.special = kind;
  const icon = document.createElement('canvas');
  const name = document.createElement('span');
  name.textContent = SPECIAL_INFO[kind].name;
  item.append(icon, name);
  $('legend').append(item);
  return { kind, item, icon };
});
```

`drawLegend()` 内补 `specialLegend` 的绘制与 `item.classList.toggle('hidden', !game.seenSpecials.has(kind))`；events 加 `onDiscoverSpecial() { drawLegend(); }`。`onLevel` 的 reached 循环不碰特殊篇。

- [ ] **Step 4: 回归 + 浏览器验收**

Run: `npm test`
Expected: PASS。

浏览器验收（`npm start` → http://localhost:5173）：
1. 带 `?debug` 打一局到 12 投以后，观察特殊位出现频率（金色光晕/磁力虚线圈/冰冻冰罩、下一个徽标）。
2. 合出双 11 → 棋盘暂停弹出抉择面板；分别验证「升天」（+20048 内浮字、王冠 HUD 出现）与「王冠清扫」（小Clawd 消失、无加分）。
3. 抉择打开时投放/钳子/瞄准全部无响应；`P` 仍可叠加手动暂停。
4. 刷新恢复：抉择挂起时刷新 → 恢复后重新弹抉择。
5. 320px 窄屏检查面板与图鉴不横向溢出；舒适设置「减弱动态」下金色呼吸与磁力圈不闪烁。

- [ ] **Step 5: 提交**

```bash
git add src/game.js src/audio.js src/main.js index.html src/style.css
git commit -m "feat: present specials, crowns and the ascension choice in the ui"
```

---

### Task 9: 模拟调参与平衡验收

**Files:**
- Create: `scripts/simulate-classic2.mjs`

- [ ] **Step 1: 写模拟脚本**

```js
// Headless balance probe for classic-2 specials (README's simulated-player
// tradition). Not part of npm test; run directly with node.
globalThis.localStorage = { getItem: () => 'off', setItem() {} };
const { Game, WORLD_W } = await import('../src/game.js');

const STRATEGIES = {
  sameSpot: (g) => WORLD_W / 2,
  random: (g) => Math.random() * WORLD_W,
  greedy: (g) => {
    let best = null;
    let bestD = Infinity;
    for (const b of g.world.bodies) {
      if (b.level !== g.current) continue;
      const d = Math.abs(b.x - g.aimX);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best ? best.x : WORLD_W / 2;
  },
};

function run(rulesVersion, strategy, seedBase, games = 150) {
  let total = 0;
  let max = 0;
  for (let i = 0; i < games; i++) {
    const g = new Game({ getContext: () => ({}) }, {}, { seed: seedBase + i, rulesVersion });
    let guard = 0;
    while (!g.over && g.drops < 300 && guard < 100000) {
      guard++;
      if (g.choice) g.resolveChoice('ascend');
      if (g.cooldown === 0 && !g.over) {
        g.setAim(STRATEGIES[strategy](g));
        g.drop();
      }
      g.update(1 / 60);
    }
    total += g.score;
    max = Math.max(max, g.score);
  }
  return { mean: Math.round(total / games), max };
}

const results = {};
for (const version of ['classic-1', 'classic-2']) {
  for (const strategy of Object.keys(STRATEGIES)) {
    results[`${version}/${strategy}`] = run(version, strategy, 781903, 150);
  }
}
for (const [key, r] of Object.entries(results)) {
  console.log(`${key.padEnd(22)} mean ${String(r.mean).padStart(6)}  max ${r.max}`);
}
for (const strategy of ['sameSpot', 'random', 'greedy']) {
  const a = results[`classic-1/${strategy}`].mean;
  const b = results[`classic-2/${strategy}`].mean;
  const uplift = a ? Math.round(((b - a) / a) * 100) : NaN;
  console.log(`uplift ${strategy.padEnd(8)} ${uplift >= 0 ? '+' : ''}${uplift}%`);
}
```

注意：`Game` 构造器在无 DOM 的 Node 下已可用（gameplay.test.mjs 同款隔离）；若 `rand()`/眨眼触发问题，同测试一样 stub 掉 `Math.random` 之外不做额外处理。

- [ ] **Step 2: 跑模拟**

Run: `node scripts/simulate-classic2.mjs`
Expected: 输出六行均值/最大值与三行涨幅。

- [ ] **Step 3: 平衡判定与调参**

验收线（README 口径延续）：
- `sameSpot`、`random` 涨幅 < 20%（随机惊喜不改变保底体验）；
- `greedy` 均值与 max 上限明显抬高（特殊机制奖励规划）。

不达标时的调参面（只动 `src/rules.js` 的 `SPECIALS`，一次一项，改完重跑）：`chance`（0.04–0.08）、`weights`、`magnet.seconds/radius/accel`、`freeze.seconds`。每轮调参在提交信息里记录数值与结果，不静默改。

- [ ] **Step 4: 提交**

```bash
git add scripts/simulate-classic2.mjs
git commit -m "feat: add classic-2 balance simulation probe"
```

---

### Task 10: 文档与发布检查

**Files:**
- Modify: `README.md`（特殊机制表 + Mechanics 表 + 玩法一行）
- Modify: `docs/design/classic-2-specials.md`（附实施结果行）
- 可能 Modify: `leaderboard/src/`（仅当发现硬性分数上限，见 Step 2）

- [ ] **Step 1: README 更新**

中文「特殊机制」表追加五行：

| **金色Clawd** | 稀有掉落，参与的那次合成得分 ×2（可与连击、狂热叠至 ×8） |
| **磁力Clawd** | 稀有掉落，落地后短暂吸附同级，完成差一点的合成 |
| **冰冻Clawd** | 稀有掉落，落地冻结接触的一堆几秒，稳稳搭塔瞄准 |
| **王冠信物** | 每次升天集一顶，满 3 顶触发庆典 +5000，可循环 |
| **升天抉择** | 两只大Clawd 合体前可选：升天得分，或化作冲击波清掉全场小Clawd |

「怎么玩」区加一行：`两只大Clawd 合体时会暂停让你二选一：升天得分，或王冠清扫残局。`。English `Mechanics` 表同步三行（Gold/Magnet/Freeze + Crown + Choice）。

- [ ] **Step 2: 服务端合理性复核**

Run: `grep -n "plausib\|elapsed\|max.*score\|score.*max" leaderboard/src/index.js leaderboard/src/*.js 2>/dev/null | head -30`
判定：若存在会拒绝合法 `classic-2` 高分（金 ×8 + 王冠 +5000 抬高单局上限）的硬编码分数/耗时上限，先改服务端阈值并按设计文档 §5 记录；若仅有耗时×分数的宽松合理性校验，确认不动，纯前端发布。

- [ ] **Step 3: 全量回归 + 提交**

Run: `npm test`
Expected: PASS（全部项）。

```bash
git add README.md docs/design/classic-2-specials.md
git commit -m "docs: document classic-2 specials and endgame mechanics"
```

- [ ] **Step 4: 发布清单（需另行授权，不在本计划内执行）**

- 纯前端：Pages 发布流程；若 Step 2 动了服务端，先 Worker 后前端。
- 发布后按 [M2 发布记录](verification/m2-release.md) 的口径补一份 `docs/verification/classic-2-release.md`：线上特殊掉落实测、抉择实测、classic-1 存档续玩实测、手机触控待用户真机验收清单。
- 遗留真机项（不阻塞）：手机横屏抉择面板、触控震动新档位、分享卡不受影响。

---

## 自审记录

- 规格覆盖：设计 §1 版本/兼容 → Task 2；§2 掉落总纲 → Task 1/3；§3 三只特殊 → Task 4/5/6；§4 王冠/抉择 → Task 7；§5 服务端 → Task 10 Step 2；§6 表现/图鉴 → Task 8；§7 平衡/测试/原型 → Task 9/10。原型先行一项以既有 `docs/prototypes` 惯例在 Task 8 浏览器验收替代，如需独立原型可在 Task 8 前插入。
- 命名一致性：`SPECIAL_KINDS`/`SPECIALS`/`CROWN_MAX`/`CROWN_BONUS`（rules.js）、`chooseClassicDrop`（drop-sequence.js）、`rulesVersion`/`specialRules`/`currentSpecial`/`nextSpecial`/`specialLastAt`/`seenSpecials`/`crowns`/`crownCycles`/`choice`（game.js）、`special`/`specialUntil`/`magnetArmed`/`froze`/`frozenUntil`（body）、`updateSpecials`/`freezeCluster`/`beginChoice`/`resolveChoice`/`ascend`（方法）在各任务间已对齐。
- 已知风险：Task 2 翻默认版本可能波及既有 save/pause 测试的手工记录（已在步骤内给出处理原则：修测试数据不放宽校验）；Task 7 会改变 gameplay.test.mjs 双王用例路径（步骤内已写明同步方式）。
