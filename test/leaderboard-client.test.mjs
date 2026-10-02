import test from 'node:test';
import assert from 'node:assert/strict';
import { LEADERBOARD_API } from '../src/config.js';

const legacyKey = 'clawd-merge:player';
const oldPlayer = { id: 'test-player', name: 'Test', token: 'isolated-test-token' };
let imports = 0;
const environments = new WeakSet();

// Exercise the actual client; replace only browser storage/location and transport.
// No request in this suite reaches a network or uses a real credential.
async function client(t, url, storage = new Map()) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, ...options });
    return new Response(JSON.stringify({ player: { id: 'test-player', name: 'Test' }, entries: [] }));
  });
  if (!environments.has(t)) {
    environments.add(t);
    const previous = ['location', 'localStorage', 'history'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    t.after(() => {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    });
  }
  globalThis.location = new URL(url);
  globalThis.history = { replaceState() {} };
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  const { leaderboard } = await import(`../src/leaderboard.js?test=${++imports}`);
  return { leaderboard, calls, storage };
}

test('production ignores API overrides and preserves existing login', async (t) => {
  const { leaderboard, calls } = await client(t,
    'https://tsdsj.github.io/clawd-merge/?api=https://untrusted.invalid',
    new Map([[legacyKey, JSON.stringify(oldPlayer)]]));
  assert.equal(leaderboard.player.token, oldPlayer.token);
  await leaderboard.me();
  assert.equal(calls[0].url, `${LEADERBOARD_API}/api/me`);
  assert.equal(calls[0].headers.Authorization, `Bearer ${oldPlayer.token}`);
});

test('production login exchange cannot be redirected by API parameter', async (t) => {
  const { leaderboard, calls } = await client(t,
    'https://tsdsj.github.io/clawd-merge/?api=http://localhost:8787#login=test-code');
  await leaderboard.finishLoginRedirect();
  assert.equal(calls[0].url, `${LEADERBOARD_API}/api/auth/exchange`);
});

for (const host of ['localhost', '127.0.0.1', '[::1]']) {
  test(`local development at ${host} can use a loopback API without loading legacy identity`, async (t) => {
    const { leaderboard, calls, storage } = await client(t,
      `http://${host}:5173/?api=http://${host}:8787/`,
      new Map([[legacyKey, JSON.stringify(oldPlayer)]]));
    assert.equal(leaderboard.player, null);
    leaderboard.save({ id: 'dev-player', name: 'Dev' }, 'dev-test-token');
    await leaderboard.me();
    assert.equal(calls[0].url, `http://${host}:8787/api/me`);
    assert.equal(calls[0].headers.Authorization, 'Bearer dev-test-token');
    leaderboard.forget();
    assert.equal(storage.get(legacyKey), JSON.stringify(oldPlayer));
  });
}

test('local identities are retained per API and not reused after changing API', async (t) => {
  const storage = new Map([[legacyKey, JSON.stringify(oldPlayer)]]);
  const a = await client(t, 'http://localhost:5173/?api=http://localhost:8787', storage);
  a.leaderboard.save({ id: 'dev', name: 'Dev' }, 'dev-test-token');
  const b = await client(t, 'http://localhost:5173/?api=http://localhost:8788', storage);
  assert.equal(b.leaderboard.player, null);
  const production = await client(t, 'http://localhost:5173/', storage);
  assert.equal(production.leaderboard.player, null);
  const again = await client(t, 'http://localhost:5173/?api=http://localhost:8787/', storage);
  assert.equal(again.leaderboard.player.token, 'dev-test-token');
});

for (const api of [
  'https://untrusted.invalid', 'http://localhost.untrusted.invalid:8787',
  'http://localhost@untrusted.invalid', 'http://user:pass@localhost:8787',
  '//localhost:8787', 'file:///tmp/api', 'not-a-url',
  'http://localhost:8787/path', 'http://localhost:8787/?redirect=1',
  'http://localhost:8787/#fragment',
]) {
  test(`local development ignores invalid or non-loopback API: ${api}`, async (t) => {
    const { leaderboard, calls } = await client(t,
      `http://localhost:5173/?api=${encodeURIComponent(api)}`);
    await leaderboard.top();
    assert.equal(calls[0].url, `${LEADERBOARD_API}/api/leaderboard?limit=20`);
  });
}

test('a LAN page cannot opt into API override', async (t) => {
  const { leaderboard, calls } = await client(t,
    'http://192.168.1.10:5173/?api=http://localhost:8787');
  await leaderboard.top();
  assert.equal(calls[0].url, `${LEADERBOARD_API}/api/leaderboard?limit=20`);
});
