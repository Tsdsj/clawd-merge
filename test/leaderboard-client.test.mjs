import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.CLAWD_CONFIG = { apiBase: 'https://api.example.test' };
const { LEADERBOARD_API } = await import('../src/config.js');

const legacyKey = 'clawd-merge:player';
const oldPlayer = { id: 'test-player', name: 'Test', token: 'isolated-test-token' };
let imports = 0;
const environments = new WeakSet();

for(const action of ['switch','logout','aba','other-tab'])test(`A01: a late rename cannot overwrite ${action}`,async t=>{
  const {leaderboard,storage}=await client(t,'https://game.example.test/');
  const original={id:'A',name:'Old'};leaderboard.save(original,'token-A');
  let resolve;t.mock.method(globalThis,'fetch',()=>new Promise(r=>{resolve=r;}));
  const pending=leaderboard.rename('New');
  const rejection=assert.rejects(pending,{code:'identity_changed'});
  if(action==='switch')leaderboard.save({id:'B',name:'Other'},'token-B');
  if(action==='logout')leaderboard.forget();
  if(action==='aba'){leaderboard.forget();leaderboard.save(original,'token-A');}
  if(action==='other-tab')storage.set(legacyKey,JSON.stringify({id:'B',name:'Other',token:'token-B'}));
  const before=storage.get(legacyKey);
  resolve(Response.json({player:{id:'A',name:'New'}}));await rejection;
  assert.equal(storage.get(legacyKey),before);
  if(action==='logout')assert.equal(leaderboard.player,null);
  if(action==='switch')assert.equal(leaderboard.player.id,'B');
});

test('A01: only one rename per active identity is sent and a stale refresh cannot revert it',{timeout:2000},async t=>{
  const {leaderboard}=await client(t,'https://game.example.test/');leaderboard.save({id:'A',name:'Old'},'token-A');
  const calls=[];t.mock.method(globalThis,'fetch',(url)=>new Promise(resolve=>calls.push({url,resolve})));
  const refresh=leaderboard.refresh();const rename=leaderboard.rename('New');
  await assert.rejects(leaderboard.rename('Another'),{code:'operation_in_progress'});
  assert.equal(calls.length,2);
  calls[1].resolve(Response.json({player:{id:'A',name:'New'}}));await rename;
  calls[0].resolve(Response.json({player:{id:'A',name:'Old'}}));await refresh;
  assert.equal(leaderboard.player.name,'New');
});

test('A01: pending registration and OAuth exchange cannot resurrect a cancelled identity',async t=>{
  const {leaderboard}=await client(t,'https://game.example.test/#login=fixture-code');
  let resolve;t.mock.method(globalThis,'fetch',()=>new Promise(r=>{resolve=r;}));
  const registering=leaderboard.register('Test');const rejected=assert.rejects(registering,{code:'identity_changed'});
  leaderboard.forget();resolve(Response.json({player:{id:'A',name:'Test'},token:'token-A'}));await rejected;
  const login=leaderboard.finishLoginRedirect();leaderboard.save({id:'B',name:'Other'},'token-B');
  resolve(Response.json({player:{id:'A',name:'Test'},token:'token-A'}));
  const result=await login;assert.equal(result.player,undefined);assert.equal(leaderboard.player.id,'B');
});

test('A01: a stale OAuth start cannot navigate away after account switching',async t=>{
  const {leaderboard}=await client(t,'https://game.example.test/');leaderboard.save({id:'A',name:'First'},'token-A');
  let navigated=false;location.assign=()=>{navigated=true;};
  let resolve;t.mock.method(globalThis,'fetch',()=>new Promise(r=>{resolve=r;}));
  const pending=leaderboard.loginWithLinuxdo();const rejected=assert.rejects(pending,{code:'identity_changed'});
  leaderboard.save({id:'B',name:'Second'},'token-B');
  resolve(Response.json({url:'https://provider.example.test/authorize'}));await rejected;
  assert.equal(navigated,false);
});

test('A01: a memory-only identity can still rename when storage remains unavailable',async t=>{
  const {leaderboard}=await client(t,'https://game.example.test/');
  t.mock.method(localStorage,'setItem',()=>{throw new Error('blocked');});
  leaderboard.save({id:'A',name:'Before'},'token-A');
  t.mock.method(globalThis,'fetch',async()=>Response.json({player:{id:'A',name:'After'}}));
  await leaderboard.rename('After');
  assert.equal(leaderboard.player.name,'After');assert.equal(leaderboard.player.token,'token-A');assert.equal(leaderboard.memoryOnly,true);
});

test('A01: storage events invalidate a pending response even after another tab restores the same identity',async t=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'addEventListener');let storageEvent;
  globalThis.addEventListener=(type,fn)=>{if(type==='storage')storageEvent=fn;};
  t.after(()=>previous?Object.defineProperty(globalThis,'addEventListener',previous):delete globalThis.addEventListener);
  const {leaderboard,storage}=await client(t,'https://game.example.test/');leaderboard.save({id:'A',name:'Before'},'token-A');
  const original=storage.get(legacyKey);
  let resolve;t.mock.method(globalThis,'fetch',()=>new Promise(r=>{resolve=r;}));
  const pending=leaderboard.rename('After');const rejected=assert.rejects(pending,{code:'identity_changed'});
  storage.set(legacyKey,JSON.stringify({id:'B',name:'Other',token:'token-B'}));storageEvent({key:legacyKey});
  storage.set(legacyKey,original);storageEvent({key:legacyKey});
  resolve(Response.json({player:{id:'A',name:'After'}}));await rejected;
  assert.equal(storage.get(legacyKey),original);
});

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

test('upload responses must contain a consistent receipt and expose retry-after',async(t)=>{
  const {leaderboard}=await client(t,'http://localhost:5173/');
  const body={sessionId:'ticket',score:30,drops:1,maxLevel:3};
  t.mock.method(globalThis,'fetch',async()=>Response.json({improved:true,best:10,rank:1}));
  await assert.rejects(leaderboard.sendResult(body,'test-token'),{code:'bad_response',status:502});
  t.mock.method(globalThis,'fetch',async()=>Response.json({error:'rate_limited',message:'wait'},{status:429,headers:{'Retry-After':'60'}}));
  await assert.rejects(leaderboard.sendResult(body,'test-token'),err=>err.status===429&&err.retryAfterMs===60000);
});

test('disabled challenge service never sends a stored credential', async (t) => {
  const { leaderboard, calls } = await client(t,'https://tsdsj.github.io/clawd-merge/',new Map([[legacyKey,JSON.stringify(oldPlayer)]]));
  leaderboard.enabled=false;
  await assert.rejects(async()=>leaderboard.challengeRequest('/api/challenges/today'),{code:'offline'});
  assert.equal(calls.length,0);
});

test('LINUX DO reauthentication omits an expired token, while guest binding still carries it',async(t)=>{
 const account=await client(t,'https://tsdsj.github.io/clawd-merge/',new Map([[legacyKey,JSON.stringify({...oldPlayer,linuxdo:true})]]));
 globalThis.location.assign=()=>{};await account.leaderboard.loginWithLinuxdo();
 assert.equal(account.calls[0].headers.Authorization,undefined);
 const guest=await client(t,'https://tsdsj.github.io/clawd-merge/',new Map([[legacyKey,JSON.stringify({...oldPlayer,linuxdo:false})]]));
 globalThis.location.assign=()=>{};await guest.leaderboard.loginWithLinuxdo();
 assert.equal(guest.calls[0].headers.Authorization,`Bearer ${oldPlayer.token}`);
});

test('classic start sends an explicit JSON mode and preserves failure cause separately from public rank access',async(t)=>{
 const {leaderboard,calls}=await client(t,'http://localhost:5173/');leaderboard.save({id:'a',name:'A'},'token');
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,...options});return Response.json({error:'rate_limited',message:'限流'},{status:429});});
 await leaderboard.startSession();assert.deepEqual(JSON.parse(calls[0].body),{mode:'classic'});assert.equal(leaderboard.sessionFailure,'rate_limited');
 t.mock.method(globalThis,'fetch',async()=>Response.json({entries:[],total:0}));await leaderboard.top();assert.equal(leaderboard.sessionStatus,'offline');assert.equal(leaderboard.sessionFailure,'rate_limited');assert.match(leaderboard.sessionMessage,/开局请求过于频繁/);assert.equal(leaderboard.sessionMessage.includes('连不上排行榜'),false);
});

function authResult(id='A',token='N'.repeat(43)) {
 return {kind:'authenticated',player:{id,name:'新账号',tag:'1234',linuxdo:false},account:{kind:'password',loginHandle:'新账号#1234',authMethods:['password'],authVersion:1,hasRecoveryCode:true},capabilities:{canRename:true,canChangePassword:true},token,expiresAt:Date.now()+86400000};
}
test('A04 same-player token rotation validates and keeps the original classic ticket',async t=>{
 const {leaderboard}=await client(t,'https://game.example.test/');leaderboard.save({id:'A',name:'游客'},'O'.repeat(43));leaderboard.restoreSession({playerId:'A',sessionId:'original-game'});const round=leaderboard.round,calls=[];
 assert.equal(typeof leaderboard.beginAccountRequest,'function');
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return Response.json({status:'valid'});});
 const snapshot=leaderboard.beginAccountRequest();await leaderboard.applyAuthResult(authResult(),snapshot,{expectedPlayerId:'A'});leaderboard.endAccountRequest(snapshot);
 assert.equal(leaderboard.round,round);assert.equal(leaderboard.round.sessionId,'original-game');assert.equal(leaderboard.sessionStatus,'online');assert.equal(calls.length,1);assert.ok(calls[0].url.includes('/api/session/check?'));assert.equal(calls[0].options.headers.Authorization,'Bearer '+'N'.repeat(43));
});
test('A04 memory-only rotated credentials take precedence over stale persisted tokens',async t=>{
 const {leaderboard}=await client(t,'https://game.example.test/');leaderboard.save({id:'A',name:'游客'},'O'.repeat(43));assert.equal(typeof leaderboard.beginAccountRequest,'function');
 const snapshot=leaderboard.beginAccountRequest();t.mock.method(localStorage,'setItem',()=>{throw Error('quota');});await leaderboard.applyAuthResult(authResult(),snapshot,{expectedPlayerId:'A'});leaderboard.endAccountRequest(snapshot);
 assert.equal(leaderboard.memoryOnly,true);assert.equal(leaderboard.uploadPlayer().token,'N'.repeat(43));
});
test('A04 a password login response cannot replace a newer identity',async t=>{
 const module=await import('../src/account-client.js').catch(()=>null);assert.ok(module?.AccountClient,'A04 account client must exist');const {leaderboard}=await client(t,'https://game.example.test/');
 const accounts=new module.AccountClient({identity:leaderboard,request:(...args)=>leaderboard.accountRequest(...args),storage:localStorage});let done,started;const began=new Promise(r=>started=r);
 t.mock.method(globalThis,'fetch',()=>{started();return new Promise(r=>done=r);});const pending=accounts.login('新账号#1234','a sufficiently long password');const rejected=assert.rejects(pending,{code:'identity_changed'});await began;leaderboard.save({id:'B',name:'其他账号'},'B'.repeat(43));done(Response.json(authResult()));await rejected;assert.equal(leaderboard.player.id,'B');
});
test('A04 operation intent survives an uncertain response without storing password or recovery code',async t=>{
 const module=await import('../src/account-client.js').catch(()=>null);assert.ok(module?.AccountClient);const {leaderboard,storage}=await client(t,'https://game.example.test/');
 const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{const body=JSON.parse(options.body||'{}');calls.push({url,body});if(url.endsWith('/api/auth/capabilities'))return Response.json({serverNow:Date.now(),passwordEnabled:true});if(url.endsWith('/api/auth/operations'))return Response.json({operationTicket:'fixture.ticket.signature',expiresAt:Date.now()+600000,loginHandle:'新账号#1234'});throw Error('lost response');});
 const accounts=new module.AccountClient({identity:leaderboard,request:(...args)=>leaderboard.accountRequest(...args),storage:localStorage});await accounts.prepare('register',{name:'新账号'});const id=accounts.intent.requestId;
 await assert.rejects(accounts.commit({password:'never persist this long password'}));assert.ok(!JSON.stringify([...storage]).includes('never persist this long password'));
 const resumed=new module.AccountClient({identity:leaderboard,request:(...args)=>leaderboard.accountRequest(...args),storage:localStorage});assert.equal(resumed.intent.requestId,id);assert.equal(resumed.intent.submitted,true);
});

test('A04 local logout cannot keep using a credential whose storage removal failed',async t=>{
 const {leaderboard}=await client(t,'https://game.example.test/');leaderboard.save({id:'A',name:'玩家'},'A'.repeat(43));t.mock.method(localStorage,'removeItem',()=>{throw Error('storage blocked');});
 await leaderboard.logout();assert.equal(leaderboard.player,null);assert.equal(leaderboard.uploadPlayer(),null);assert.equal(leaderboard.logoutStorageFailed,true);
});

test('A04: OAuth callback cannot replace a pre-existing formal account',async t=>{
 const {leaderboard}=await client(t,'https://game.example.test/#login=fixture-code');
 leaderboard.save({id:'formal',name:'Formal',account:{kind:'password'}},'formal-token');
 t.mock.method(globalThis,'fetch',async()=>Response.json({player:{id:'other',name:'Other'},token:'other-token'}));
 const result=await leaderboard.finishLoginRedirect();assert.ok(result.error);assert.equal(leaderboard.player.id,'formal');
});

test('A04: retrying account storage cannot overwrite another tab before its event arrives',async t=>{
 const {leaderboard,storage}=await client(t,'https://game.example.test/');
 leaderboard.save({id:'A',name:'Memory'},'token-A');leaderboard.memoryOnly=true;
 storage.set(legacyKey,JSON.stringify({id:'B',name:'Other',token:'token-B'}));
 await assert.rejects(leaderboard.retryAccountStorage(),{code:'identity_changed'});
 assert.equal(JSON.parse(storage.get(legacyKey)).id,'B');
});
