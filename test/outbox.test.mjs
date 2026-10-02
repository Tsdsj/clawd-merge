import test from 'node:test';
import assert from 'node:assert/strict';

function storage() {
  const data = new Map();
  return {
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
}
function locks() {
  const held = new Set();
  return {
    async request(name, options, fn) {
      if (held.has(name)) return fn(null);
      held.add(name);
      try {
        return await fn({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}
const payload = () => ({
  roundId: 'round-1',
  playerId: 'player-1',
  playerName: '测试身份',
  sessionId: 'ticket-1',
  score: 123,
  drops: 3,
  maxLevel: 3,
});
const receipt = { improved: true, best: 123, rank: 1 };
async function setup(extra = {}) {
  const { Outbox } = await import('../src/outbox.js');
  return new Outbox({
    scope: 'test',
    storage: storage(),
    locks: locks(),
    getPlayer: () => ({ id: 'player-1', token: 'private-test-token' }),
    send: async () => receipt,
    ...extra,
  });
}

test('durable result survives refresh, uploads original body, and never stores a token', async () => {
  const store = storage();
  const a = await setup({ storage: store });
  const item = a.enqueue(payload());
  assert.equal(item.durable, true);
  assert.equal(store.getItem(item.key).includes('private-test-token'), false);
  const calls = [];
  const b = await setup({
    storage: store,
    send: async (body, token) => {
      calls.push({ body, token });
      return receipt;
    },
  });
  await b.process(item.key);
  assert.deepEqual(calls, [
    { body: { sessionId: 'ticket-1', score: 123, drops: 3, maxLevel: 3 }, token: 'private-test-token' },
  ]);
  assert.equal(b.get(item.key).state, 'accepted');
  assert.equal(store.length, 0);
});

test('lost response retries keep the same payload and stop after a finite burst', async () => {
  let now = 1000,
    count = 0;
  const q = await setup({
    now: () => now,
    send: async () => {
      count++;
      throw Object.assign(new Error('offline'), { status: 0 });
    },
  });
  const entry = q.enqueue(payload());
  for (let i = 0; i < 6; i++) {
    await q.process(entry.key);
    now += 100000;
  }
  assert.equal(count, 4);
  assert.equal(q.get(entry.key).state, 'retry');
  assert.equal(q.get(entry.key).attempts, 4);
  await q.retry(entry.key);
  assert.equal(count, 5);
});

test('401 and identity mismatch keep the record without sending as another account', async () => {
  let player = { id: 'other', token: 'other-token' },
    count = 0;
  const q = await setup({
    getPlayer: () => player,
    send: async () => {
      count++;
      throw Object.assign(new Error('expired'), { status: 401 });
    },
  });
  const item = q.enqueue(payload());
  await q.process(item.key);
  assert.equal(count, 0);
  assert.equal(q.get(item.key).state, 'identity');
  player = { id: 'player-1', token: 'old-token' };
  await q.retry(item.key);
  assert.equal(count, 1);
  assert.equal(q.get(item.key).state, 'identity');
  await q.process(item.key);
  assert.equal(count, 1);
});

test('429 respects retry-after while rule rejection never auto retries', async () => {
  let now = 1000,
    count = 0;
  const q = await setup({
    now: () => now,
    send: async () => {
      count++;
      throw Object.assign(new Error('limited'), { status: 429, retryAfterMs: 60000 });
    },
  });
  const item = q.enqueue(payload());
  await q.process(item.key);
  now += 59000;
  await q.process(item.key);
  assert.equal(count, 1);
  now += 1001;
  await q.process(item.key);
  assert.equal(count, 2);
  const rejected = await setup({
    send: async () => {
      throw Object.assign(new Error('invalid'), { status: 422, code: 'implausible' });
    },
  });
  const r = rejected.enqueue(payload());
  await rejected.process(r.key);
  assert.equal(rejected.get(r.key).state, 'rejected');
  assert.equal(await rejected.retry(r.key), false);
});

test('one tab uploads at a time; a removed record is not recreated by an old callback', async () => {
  const store = storage(),
    mutex = locks();
  let finish,
    count = 0;
  const send = () => {
    count++;
    return new Promise((r) => {
      finish = r;
    });
  };
  const a = await setup({ storage: store, locks: mutex, send }),
    b = await setup({ storage: store, locks: mutex, send });
  const item = a.enqueue(payload());
  const pending = a.process(item.key);
  await new Promise((r) => setImmediate(r));
  await b.process(item.key);
  assert.equal(count, 1);
  assert.equal(await b.remove(item.key), false);
  finish(receipt);
  await pending;
  assert.equal(store.length, 0);
});

test('storage write and cleanup failures remain truthful and do not resend an accepted result', async (t) => {
  const store = storage();
  let count = 0;
  t.mock.method(store, 'setItem', () => {
    throw new Error('quota');
  });
  const q = await setup({
    storage: store,
    send: async () => {
      count++;
      return receipt;
    },
  });
  const item = q.enqueue(payload());
  assert.equal(item.durable, false);
  await q.process(item.key);
  assert.equal(q.get(item.key).state, 'accepted');
  assert.equal(count, 1);
  const other = storage();
  const cleanup = await setup({ storage: other });
  const e = cleanup.enqueue(payload());
  t.mock.method(other, 'removeItem', () => {
    throw new Error('denied');
  });
  await cleanup.process(e.key);
  assert.equal(cleanup.get(e.key).state, 'accepted');
  assert.equal(cleanup.get(e.key).cleanupPending, true);
});

test('payload conflicts and queue capacity never overwrite or evict old results', async () => {
  const q = await setup({ limit: 1 });
  const first = q.enqueue(payload());
  assert.throws(() => q.enqueue({ ...payload(), score: 456 }), /conflict/);
  const second = q.enqueue({ ...payload(), roundId: 'round-2', sessionId: 'ticket-2' });
  assert.equal(second.durable, false);
  assert.equal(second.error, 'queue_full');
  assert.equal(q.get(first.key).score, 123);
});

test('late ticket arrival is bound to the original result; missing tickets are not replaced', async () => {
  let now = 1000;
  const q = await setup({ now: () => now });
  const item = q.enqueue({ ...payload(), sessionId: null });
  await q.process(item.key);
  assert.equal(q.get(item.key).state, 'ticket');
  now += 11000;
  await q.process(item.key);
  assert.equal(q.get(item.key).state, 'rejected');
  q.setTicket(item.key, 'ticket-1');
  await q.process(item.key);
  assert.equal(q.get(item.key).state, 'accepted');
});

test('offline device waits without spending attempts, then uploads after reconnecting', async () => {
  let online = false,
    count = 0;
  const q = await setup({
    isOnline: () => online,
    send: async () => {
      count++;
      return receipt;
    },
  });
  const entry = q.enqueue(payload());
  await q.process(entry.key);
  assert.equal(count, 0);
  assert.equal(q.get(entry.key).attempts, 0);
  online = true;
  q.wakeOnline();
  await q.process(entry.key);
  assert.equal(count, 1);
  assert.equal(q.get(entry.key).state, 'accepted');
});

test('accepted cleanup waits for the finished journal, never posts the score twice', async () => {
  let safe = false,
    count = 0;
  const q = await setup({
    onClear: () => safe,
    send: async () => {
      count++;
      return receipt;
    },
  });
  const e = q.enqueue(payload());
  await q.process(e.key);
  assert.equal(q.get(e.key).state, 'accepted');
  assert.equal(q.get(e.key).cleanupPending, true);
  safe = true;
  await q.retry(e.key);
  assert.equal(count, 1);
  assert.equal(q.list().length, 0);
});

test('UI is notified after the upload lock is released so retry buttons can re-enable', async () => {
  let q, lastBusy;
  q = await setup({
    send: async () => {
      throw new Error('network');
    },
    onChange: (e) => {
      if (e) lastBusy = q.inflight.has(e.key);
    },
  });
  const entry = q.enqueue(payload());
  await q.process(entry.key);
  assert.equal(lastBusy, false);
});
