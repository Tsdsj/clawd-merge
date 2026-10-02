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

test('joining midway leaves the current local round ineligible until restart', async (t) => {
  const { leaderboard, calls } = await client(t, 'http://localhost:5173/?api=http://localhost:8787');
  await leaderboard.startSession();
  leaderboard.save({ id: 'joined', name: 'Joined' }, 'joined-token');
  assert.equal(leaderboard.sessionStatus, 'local');
  await assert.rejects(leaderboard.submit({ score: 20, drops: 2, maxLevel: 2 }), { code: 'no_session' });
  assert.equal(calls.length, 0);
});

test('new round reports pending then online only after receiving its ticket', async (t) => {
  const { leaderboard } = await client(t, 'http://localhost:5173/');
  leaderboard.save({ id: 'joined', name: 'Joined' }, 'joined-token');
  let resolve;
  t.mock.method(globalThis, 'fetch', () => new Promise((r) => { resolve = r; }));
  const pending = leaderboard.startSession();
  assert.equal(leaderboard.sessionStatus, 'pending');
  resolve(Response.json({ sessionId: 'test-session' }));
  await pending;
  assert.equal(leaderboard.sessionStatus, 'online');
});

test('a failed ticket allows a local round without losing the account', async (t) => {
  const { leaderboard } = await client(t, 'http://localhost:5173/');
  leaderboard.save({ id: 'joined', name: 'Joined' }, 'joined-token');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network unavailable'); });
  await leaderboard.startSession();
  assert.equal(leaderboard.sessionStatus, 'offline');
  assert.equal(leaderboard.player.id, 'joined');
});

test('a ticket from an earlier identity cannot be submitted as a new identity', async (t) => {
  const { leaderboard } = await client(t, 'http://localhost:5173/');
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return Response.json({ sessionId: 'old-ticket' });
  });
  leaderboard.save({ id: 'old', name: 'Old' }, 'old-token');
  await leaderboard.startSession();
  leaderboard.save({ id: 'new', name: 'New' }, 'new-token');
  assert.equal(leaderboard.sessionStatus, 'local');
  await assert.rejects(leaderboard.submit({ score: 20, drops: 2, maxLevel: 2 }), { code: 'no_session' });
  assert.equal(requests.length, 1);
});

test('a late failed session cannot replace the new round or sign out a new identity', async (t) => {
  const { leaderboard } = await client(t, 'http://localhost:5173/');
  let resolveOld;
  let unauthorized = 0;
  leaderboard.onUnauthorized = () => { unauthorized++; };
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => { resolveOld = resolve; }));
  leaderboard.save({ id: 'old', name: 'Old' }, 'old-token');
  const old = leaderboard.startSession();
  leaderboard.save({ id: 'new', name: 'New' }, 'new-token');
  t.mock.method(globalThis, 'fetch', async () => Response.json({ sessionId: 'new-ticket' }));
  await leaderboard.startSession();
  resolveOld(Response.json({ message: 'expired' }, { status: 401 }));
  await old;
  assert.equal(leaderboard.sessionStatus, 'online');
  assert.equal(unauthorized, 0);
});

test('score submission retains its own ticket and token while a new round starts', async (t) => {
  const { leaderboard } = await client(t, 'http://localhost:5173/');
  leaderboard.save({ id: 'player', name: 'Player' }, 'player-token');
  let resolveOld;
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => { resolveOld = resolve; }));
  leaderboard.startSession();
  const submitted = leaderboard.submit({ score: 20, drops: 2, maxLevel: 2 });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return Response.json(url.endsWith('/api/session') ? { sessionId: 'new-ticket' } : { rank: 1 });
  });
  await leaderboard.startSession();
  resolveOld(Response.json({ sessionId: 'old-ticket' }));
  await submitted;
  assert.equal(leaderboard.sessionStatus, 'online');
  assert.equal(await leaderboard.session, 'new-ticket');
  const request = requests.find((r) => r.url.endsWith('/api/score'));
  assert.equal(JSON.parse(request.options.body).sessionId, 'old-ticket');
  assert.equal(request.options.headers.Authorization, 'Bearer player-token');
});

test('expired login is invalidated without making the round eligible', async (t) => {
  const { leaderboard } = await client(t, 'http://localhost:5173/');
  leaderboard.save({ id: 'expired', name: 'Expired' }, 'expired-token');
  leaderboard.onUnauthorized = () => leaderboard.forget();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: 'expired' }, { status: 401 }));
  await leaderboard.startSession();
  assert.equal(leaderboard.player, null);
  assert.equal(leaderboard.sessionStatus, 'local');
});

test('a delayed profile refresh cannot restore a logged-out identity', async (t) => {
  const { leaderboard } = await client(t, 'http://localhost:5173/');
  leaderboard.save({ id: 'old', name: 'Old' }, 'old-token');
  let resolve;
  t.mock.method(globalThis, 'fetch', () => new Promise((r) => { resolve = r; }));
  const pending = leaderboard.refresh();
  leaderboard.forget();
  resolve(Response.json({ player: { id: 'old', name: 'Old' } }));
  await pending;
  assert.equal(leaderboard.player, null);
});

test('restoration validates and adopts the original session without a new ticket or storing token', async (t) => {
  const { leaderboard } = await client(t, 'http://localhost:5173/');
  leaderboard.save({ id:'player',name:'Player' },'private-test-token');
  const calls=[];
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    calls.push({url,options});return Response.json({status:'valid',serverNow:100,expiresAt:200});
  });
  const ticket={playerId:'player',sessionId:'original-ticket'};
  assert.equal((await leaderboard.checkSavedSession(ticket)).status,'valid');
  leaderboard.restoreSession(ticket);
  assert.equal(await leaderboard.session,'original-ticket');
  assert.equal(leaderboard.sessionStatus,'online');
  assert.deepEqual(leaderboard.exportSession(),ticket);
  assert.equal(JSON.stringify(leaderboard.exportSession()).includes('private-test-token'),false);
  assert.equal(calls.length,1);
  assert.ok(calls[0].url.includes('/api/session/check?'));
  leaderboard.restoreSession(null);
  assert.equal(leaderboard.sessionStatus,'local');
});

test('restoration rejects a different account before accessing another players ticket', async (t) => {
  const { leaderboard,calls } = await client(t,'http://localhost:5173/');
  leaderboard.save({ id:'other',name:'Other' },'other-token');
  const ticket={playerId:'original',sessionId:'old-ticket'};
  assert.equal((await leaderboard.checkSavedSession(ticket)).status,'identity');
  assert.throws(()=>leaderboard.restoreSession(ticket));
  assert.equal(calls.length,0);
});

test('a stale tab cannot overwrite or remove a newer identity saved by another tab', async (t) => {
  const {leaderboard,storage}=await client(t,'https://tsdsj.github.io/clawd-merge/');
  leaderboard.save({id:'old',name:'Old'},'old-token');
  let resolve;
  t.mock.method(globalThis,'fetch',()=>new Promise(r=>{resolve=r;}));
  const pending=leaderboard.refresh();
  const newer=JSON.stringify({id:'new',name:'New',token:'new-token'});
  storage.set(legacyKey,newer);
  resolve(Response.json({player:{id:'old',name:'Old'}}));
  await pending;
  assert.equal(storage.get(legacyKey),newer);
  leaderboard.forget();
  assert.equal(storage.get(legacyKey),newer);
});
