import test from 'node:test';
import assert from 'node:assert/strict';
const environments = new WeakSet();

async function setup(t) {
  if(!environments.has(t)) {
    environments.add(t);
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    globalThis.localStorage = { getItem: (k) => k.endsWith(':sound') ? 'off' : null, setItem() {} };
    t.after(() => previous ? Object.defineProperty(globalThis, 'localStorage', previous) : delete globalThis.localStorage);
  }
  const { Game } = await import('../src/game.js');
  return new Game({ getContext: () => ({}) });
}

test('snapshot round-trips moving bodies, next pieces, timers and rewards without input or events', async (t) => {
  const g = await setup(t);
  const b = g.spawnCrab(6, 130, 400);
  b.vx = 28; b.vy = -90; b.w = 1.2; b.angle = 0.4; b.updateTransform();
  g.score = 2480; g.maxLevel = 8; g.claws = 2; g.drops = 68;
  g.time = 30; g.visualTime = 29; g.current = 0; g.next = 3;
  g.danger = 1.8; g.feverTime = 6.2; g.cooldown = 0.3; g.pendingDrop = true;
  g.lastMergeAt = 29.5; g.combo = 3; g.seen.add(8);
  const raw = JSON.parse(JSON.stringify(g.snapshot()));
  const restored = await setup(t);
  restored.restore(raw);
  assert.deepEqual(restored.snapshot(), raw);
  assert.equal(restored.pendingDrop, false);
  assert.equal(restored.paused, true);
  assert.equal(restored.score, 2480);
  assert.equal(restored.claws, 2);
  restored.setPaused(false); restored.update(1 / 60);
  assert.equal(restored.drops, 68);
  assert.ok(Number.isFinite(restored.world.bodies[0].y));
  assert.equal(restored.score, 2480);
});

test('bad snapshots are rejected before modifying the current game', async (t) => {
  const g = await setup(t);
  g.spawnCrab(1, 100, 500); g.drops = 1;
  const before = g.snapshot();
  for (const mutate of [s => s.score = NaN, s => s.current = 99,
    s => s.bodies[0].x = Infinity, s => s.bodies[0].level = -1,
    s => s.claws = 40, s => s.bodies = Array(1001).fill(s.bodies[0]),
    s => s.next = '1']) {
    const bad = structuredClone(before); mutate(bad);
    assert.throws(() => g.restore(bad));
    assert.deepEqual(g.snapshot(), before);
  }
});

test('resting boards remain stable after restoring', async (t) => {
  const g = await setup(t);
  const a = g.spawnCrab(5, 90, 605); const b = g.spawnCrab(7, 280, 550);
  g.drops = 20;
  for (let i = 0; i < 360; i++) g.update(1 / 120);
  const restored = await setup(t); restored.restore(g.snapshot()); restored.setPaused(false);
  const score = restored.score;
  for (let i = 0; i < 120; i++) restored.update(1 / 120);
  assert.equal(restored.score, score);
  assert.equal(restored.over, false);
  for (const body of restored.world.bodies) {
    assert.ok(body.x > -1 && body.x < 401 && body.y < 641);
    assert.ok(Math.abs(body.vy) < 5);
  }
});

test('restoring immediately after a high-level merge never re-awards score or claws', async (t) => {
  const g=await setup(t);
  g.maxLevel=6;g.drops=64;
  g.spawnCrab(6,180,400);g.spawnCrab(6,190,400);
  g.update(1/120);
  assert.equal(g.maxLevel,7);
  assert.equal(g.claws,1);
  const score=g.score;
  const restored=await setup(t);restored.restore(g.snapshot());restored.setPaused(false);
  restored.update(1/60);
  assert.equal(restored.score,score);
  assert.equal(restored.claws,1);
  assert.deepEqual(restored.world.bodies.map(b=>b.level),[7]);
});

function memoryStorage() {
  const values = new Map();
  return { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
}
function lockManager() {
  const held = new Set();
  return { async request(name, options, callback) {
    if (held.has(name)) return callback(null);
    held.add(name);
    try { return await callback({ name }); } finally { held.delete(name); }
  } };
}
function channels() {
  const all = new Set();
  return () => {
    const c = { onmessage: null, postMessage(data) {
      for (const other of all) if (other !== c) queueMicrotask(() => other.onmessage?.({ data }));
    }, close() { all.delete(c); } };
    all.add(c); return c;
  };
}

test('only one tab writes; takeover saves then releases; old tab cannot overwrite', async (t) => {
  const { SaveStore } = await import('../src/save-store.js');
  const g = await setup(t); g.drops = 1; g.spawnCrab(1, 100, 500);
  const options = { scope:'test', storage:memoryStorage(), locks:lockManager(), channelFactory:channels() };
  const a = new SaveStore(options), b = new SaveStore(options);
  t.after(() => { a.close(); b.close(); });
  assert.equal(await a.acquire(), true);
  assert.equal(await b.acquire(), false);
  const record = a.record('round-test', g.snapshot(), null);
  a.write(record);
  assert.throws(() => b.write(record), /owner/);
  a.onYield = () => { const latest = structuredClone(record); latest.game.score = 42; a.write(latest); return true; };
  assert.equal(await b.takeover(100), true);
  assert.equal(b.read().record.game.score, 42);
  assert.equal(a.owned, false);
  assert.throws(() => a.write(record), /owner/);
});

test('unresponsive or failed owner never gets forcibly replaced', async (t) => {
  const { SaveStore } = await import('../src/save-store.js');
  const options = { scope:'test', storage:memoryStorage(), locks:lockManager(), channelFactory:channels() };
  const a = new SaveStore(options), b = new SaveStore(options);
  t.after(() => { a.close(); b.close(); });
  await a.acquire(); a.onYield = () => false;
  assert.equal(await b.takeover(20), false);
  assert.equal(a.owned, true);
  await a.release();
  assert.equal(await b.takeover(20), true);
});

test('invalid version, corrupt storage, and write failure preserve the previous save', async (t) => {
  const { SaveStore } = await import('../src/save-store.js');
  const g = await setup(t); g.drops = 1;
  const storage = memoryStorage();
  const s = new SaveStore({ scope:'test', storage, locks:lockManager(), channelFactory:channels() });
  t.after(() => s.close()); await s.acquire();
  const record = s.record('round-test', g.snapshot(), null);
  s.write(record); const before = storage.getItem(s.key);
  assert.throws(() => s.write({ ...record, schemaVersion: 99 }));
  assert.equal(storage.getItem(s.key), before);
  t.mock.method(storage, 'setItem', () => { throw new Error('quota'); });
  assert.throws(() => s.write(record), /quota/);
  assert.equal(storage.getItem(s.key), before);
  assert.equal(s.read().kind, 'saved');
});

test('unsupported locking and blocked reads never claim autosave is available', async () => {
  const { SaveStore } = await import('../src/save-store.js');
  const s = new SaveStore({ scope:'test', storage:null, locks:null, channelFactory:null });
  assert.equal(s.supported, false);
  assert.equal(await s.acquire(), false);
  assert.equal(s.read().kind, 'unavailable');
  assert.throws(() => s.write({}), /owner/);
  s.close();
});

test('completed save removal and API namespaces do not affect other environments', async (t) => {
  const { SaveStore } = await import('../src/save-store.js');
  const g = await setup(t);g.drops=1;
  const options={storage:memoryStorage(),locks:lockManager(),channelFactory:channels()};
  const a=new SaveStore({...options,scope:'api-a'}), b=new SaveStore({...options,scope:'api-b'});
  t.after(()=>{a.close();b.close();});
  await a.acquire();await b.acquire();
  a.write(a.record('round-a',g.snapshot(),null));b.write(b.record('round-b',g.snapshot(),null));
  a.remove();
  assert.equal(a.read().kind,'empty');
  assert.equal(b.read().record.roundId,'round-b');
});

test('corrupt JSON, incompatible versions and blocked storage are distinct recoverable read states', async (t) => {
  const { SaveStore } = await import('../src/save-store.js');
  const storage=memoryStorage();
  const store=new SaveStore({scope:'test',storage,locks:lockManager(),channelFactory:channels()});
  t.after(()=>store.close());
  storage.setItem(store.key,'{');assert.equal(store.read().kind,'invalid');
  assert.equal(storage.getItem(store.key),'{');
  const oldVersion=JSON.stringify({schemaVersion:0,rulesVersion:'old'});
  storage.setItem(store.key,oldVersion);assert.equal(store.read().kind,'invalid');
  assert.equal(storage.getItem(store.key),oldVersion);
  t.mock.method(storage,'getItem',()=>{throw new Error('denied');});
  assert.equal(store.read().kind,'unavailable');
});

test('score still progresses when preference writes fail, and reports persistence failure', async (t) => {
  const g=await setup(t);
  t.mock.method(globalThis.localStorage,'setItem',()=>{throw new Error('quota');});
  g.addScore(10,100,100);
  assert.equal(g.score,10);
  assert.equal(g.best,10);
  assert.equal(g.persistenceWarning,true);
});

test('finished journal replaces the board atomically and never becomes a resumable game', async (t) => {
  const {SaveStore}=await import('../src/save-store.js');
  const store=new SaveStore({scope:'test',storage:memoryStorage(),locks:lockManager(),channelFactory:channels()});
  t.after(()=>store.close());await store.acquire();
  const g=await setup(t);g.drops=3;
  store.write(store.record('round-final',g.snapshot(),null));
  const result={roundId:'round-final',playerId:'player',playerName:'Test',sessionId:'ticket',score:123,drops:3,maxLevel:3};
  store.stageResult(result);
  assert.equal(store.read().kind,'terminal');
  assert.deepEqual(store.read().record.terminal,result);
  assert.equal(store.read().record.game,undefined);
  assert.throws(()=>store.stageResult({...result,score:NaN}));
  assert.deepEqual(store.read().record.terminal,result);
});
