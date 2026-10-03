import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {openDatabase} from '../../server/sqlite.mjs';
import worker from '../src/index.js';
import {newIntentId} from '../../src/auth-intent-id.js';
const authModule=import('../../server/password-auth.mjs').catch(()=>null);
const kdfModule=import('../../server/password-kdf.mjs').catch(()=>null);
const PASSWORD='海边的小螃蟹每天认真玩游戏 123';
const keys=()=>({current:'v1',rate:randomBytes(32).toString('base64url'),versions:{v1:{ticket:randomBytes(32).toString('base64url'),receipt:randomBytes(32).toString('base64url'),payload:randomBytes(32).toString('base64url')}}});
async function fixture(t,options={}){
 const m=await authModule,k=await kdfModule;assert.ok(m?.createPasswordAuth&&k?.createPasswordKdf,'A04 native password service must exist');
 const DB=openDatabase(':memory:');t.after(()=>DB.close());const env={DB,ALLOWED_ORIGINS:'*',LINUXDO_CLIENT_ID:'fixture',LINUXDO_CLIENT_SECRET:'fixture'};
 const config=options.keyring||keys();const kdf=options.kdf||k.createPasswordKdf({maxConcurrent:2});env.PASSWORD_AUTH=m.createPasswordAuth({DB,keyring:config,kdf,enabled:true});let serial=0;
 const call=async(path,body,token,extra={})=>{const r=await worker.fetch(new Request('https://game.example.test'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':extra.ip||'192.0.2.'+(++serial),...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)}),env);return {status:r.status,headers:r.headers,data:r.status===302?null:await r.json()};};
 const prepare=async(action,body={},token)=>{const proof={requestId:newIntentId(Date.now()-1000),retrySecret:randomBytes(32).toString('base64url')};const r=await call('/api/auth/operations',{action,...proof,...body},token);assert.equal(r.status,200,JSON.stringify(r.data));return {...proof,operationTicket:r.data.operationTicket};};
 const register=async(name='小螃蟹',password=PASSWORD)=>{const proof=await prepare('register',{name});const r=await call('/api/auth/password/register',{...proof,password});assert.equal(r.status,201,JSON.stringify(r.data));return {...r.data,proof};};
 return {DB,env,config,kdf,call,prepare,register};
}
test('A04 registration stores only derived credentials and an encrypted replay, then logs in on another device',async t=>{
 const f=await fixture(t);const r=await f.register();assert.equal(r.account.kind,'password');assert.match(r.account.loginHandle,/^小螃蟹#\d{4}$/);assert.equal(r.player.id,r.account.playerId||r.player.id);assert.ok(r.recoveryCode);
 const dump=JSON.stringify(f.DB.raw.prepare('SELECT * FROM password_credentials').all())+JSON.stringify(f.DB.raw.prepare('SELECT * FROM auth_operations').all())+JSON.stringify(f.DB.raw.prepare('SELECT * FROM recovery_codes').all())+JSON.stringify(f.DB.raw.prepare('SELECT * FROM tokens').all());
 for(const secret of [PASSWORD,r.token,r.recoveryCode,r.proof.retrySecret])assert.ok(!dump.includes(secret),'database must not contain bearer/password/recovery/retry plaintext');
 const login=await f.call('/api/auth/password/login',{loginHandle:r.account.loginHandle,password:PASSWORD});assert.equal(login.status,200);assert.equal(login.data.player.id,r.player.id);assert.notEqual(login.data.token,r.token);assert.equal(login.data.recoveryCode,undefined);
 assert.equal((await f.call('/api/me',undefined,r.token)).status,200);assert.equal(login.headers.get('Cache-Control'),'no-store');
});
test('A04 same registration intent replays one account and complete credentials; conflicting password is rejected',async t=>{
 const f=await fixture(t),r=await f.register();
 const again=await f.call('/api/auth/password/register',{...r.proof,password:PASSWORD});assert.equal(again.status,201);const {proof,...original}=r;assert.deepEqual(again.data,original);
 const conflict=await f.call('/api/auth/password/register',{...r.proof,password: "a different password length"});assert.equal(conflict.status,409);
});
test('A04 guest upgrade keeps the player and game ticket, revokes guest tokens and reports password capabilities',async t=>{
 const f=await fixture(t),guest=await f.call('/api/register',{name:'升级玩家'});const old=guest.data;
 const session=await f.call('/api/session',{},old.token);const proof=await f.prepare('set_password',{name:'升级玩家'},old.token);
 const result=await f.call('/api/account/password',{operation:'set',password:PASSWORD,...proof},old.token);assert.equal(result.status,201,JSON.stringify(result.data));assert.equal(result.data.player.id,old.player.id);
 assert.equal((await f.call('/api/me',undefined,old.token)).status,401);
 const same=await f.call('/api/session/check?sessionId='+session.data.sessionId,undefined,result.data.token);assert.equal(same.data.status,'valid');
 const me=await f.call('/api/me',undefined,result.data.token);assert.equal(me.data.account.kind,'password');assert.equal(me.data.capabilities.canChangePassword,true);
});
test('A04 changing a password revokes all old sessions but keeps the original recovery code',async t=>{
 const f=await fixture(t),r=await f.register();const other=await f.call('/api/auth/password/login',{loginHandle:r.account.loginHandle,password:PASSWORD});
 const proof=await f.prepare('change_password',{},r.token),fresh='another long password, unchanged spaces';
 const change=await f.call('/api/account/password',{operation:'change',oldPassword:PASSWORD,newPassword:fresh,...proof},r.token);assert.equal(change.status,200,JSON.stringify(change.data));assert.equal(change.data.recoveryCode,undefined);
 for(const token of [r.token,other.data.token])assert.equal((await f.call('/api/me',undefined,token)).status,401);
 const recovery=await f.prepare('recover_password',{loginHandle:r.account.loginHandle});const recovered=await f.call('/api/auth/password/recover',{loginHandle:r.account.loginHandle,recoveryCode:r.recoveryCode,newPassword:PASSWORD,...recovery});assert.equal(recovered.status,200,JSON.stringify(recovered.data));assert.notEqual(recovered.data.recoveryCode,r.recoveryCode);
});
test('A04 unknown/wrong login errors agree and login never applies new-name policy',async t=>{
 const f=await fixture(t),r=await f.register();f.env.BLOCKED_WORDS='小螃蟹';
 const good=await f.call('/api/auth/password/login',{loginHandle:r.account.loginHandle,password:PASSWORD});assert.equal(good.status,200);
 const wrong=await f.call('/api/auth/password/login',{loginHandle:r.account.loginHandle,password:'wrong but sufficiently long'}),missing=await f.call('/api/auth/password/login',{loginHandle:'不存在#9999',password:'wrong but sufficiently long'});
 assert.equal(wrong.status,401);assert.deepEqual(wrong.data,missing.data);
});
test('A04 payload parsing rejects arrays, duplicate keys, invalid Unicode passwords and oversized bodies',async t=>{
 const f=await fixture(t);
 for(const body of ['[]','{"loginHandle":"a#1234","loginHandle":"b#1234","password":"abcdefghijklmnop"}',' '.repeat(8200)])assert.equal((await f.call('/api/auth/password/login',body)).status,400);
 const p=await f.prepare('register',{name:'字符测试'});const invalid=await f.call('/api/auth/password/register',{...p,password:'123456789012345\ud800'});assert.equal(invalid.status,400);
});

test('A04 repeated prepare consumes one shared registration budget; guest and password registration share the limit',async t=>{
 const f=await fixture(t),proof={requestId:newIntentId(Date.now()-1000),retrySecret:randomBytes(32).toString('base64url')},body={action:'register',name:'共享额度',...proof},ip='198.51.100.40';
 const results=await Promise.all(Array.from({length:4},()=>f.call('/api/auth/operations',body,undefined,{ip})));assert.ok(results.every(r=>r.status===200));assert.deepEqual(results[0].data,results[3].data);
 assert.equal(f.DB.raw.prepare('SELECT count FROM rate_limits WHERE key=?').get('register:'+ip).count,1);
 for(let i=0;i<4;i++)assert.equal((await f.call('/api/register',{name:'游客'+i},undefined,{ip})).status,201);
 const refused=await f.call('/api/auth/operations',{...body,requestId:newIntentId(Date.now()-1000),retrySecret:randomBytes(32).toString('base64url')},undefined,{ip});assert.equal(refused.status,429);assert.ok(Number(refused.headers.get('Retry-After'))>0);
});
test('A04 recovery prepare cannot create unlimited unauthenticated operation rows',async t=>{
 const f=await fixture(t);const ip='198.51.100.50';
 for(let i=0;i<5;i++)assert.equal((await f.call('/api/auth/operations',{action:'recover_password',loginHandle:'某个账号#0001',requestId:newIntentId(Date.now()-1000),retrySecret:randomBytes(32).toString('base64url')},undefined,{ip})).status,200);
 assert.equal((await f.call('/api/auth/operations',{action:'recover_password',loginHandle:'某个账号#0001',requestId:newIntentId(Date.now()-1000),retrySecret:randomBytes(32).toString('base64url')},undefined,{ip})).status,429);
});
test('A04 concurrent same-intent registration returns one player, token and recovery code',async t=>{
 const f=await fixture(t),proof=await f.prepare('register',{name:'并发账号'});const replies=await Promise.all([1,2].map(()=>f.call('/api/auth/password/register',{...proof,password:PASSWORD})));
 assert.ok(replies.every(r=>r.status===201));assert.deepEqual(replies[0].data,replies[1].data);assert.equal(f.DB.raw.prepare('SELECT count(*) n FROM players').get().n,1);assert.equal(f.DB.raw.prepare('SELECT count(*) n FROM tokens').get().n,1);
});
test('A04 recovery code wins once across distinct concurrent intents and invalidates older replies',async t=>{
 const f=await fixture(t),r=await f.register();const a=await f.prepare('recover_password',{loginHandle:r.account.loginHandle}),b=await f.prepare('recover_password',{loginHandle:r.account.loginHandle});
 const results=await Promise.all([a,b].map(proof=>f.call('/api/auth/password/recover',{...proof,loginHandle:r.account.loginHandle,recoveryCode:r.recoveryCode,newPassword:'brand new password with enough characters'})));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(f.DB.raw.prepare('SELECT count(*) n FROM tokens').get().n,1);
 assert.equal((await f.call('/api/auth/operations/result',r.proof)).status,409);
});
test('A04 a lost upgrade response can be read without the revoked bearer; logout invalidates the receipt',async t=>{
 const f=await fixture(t),g=(await f.call('/api/register',{name:'丢包升级'})).data,p=await f.prepare('set_password',{name:'丢包升级'},g.token);
 const r=await f.call('/api/account/password',{...p,operation:'set',password:PASSWORD},g.token);assert.equal(r.status,201);
 const receipt=await f.call('/api/auth/operations/result',p);assert.equal(receipt.status,200);assert.equal(receipt.data.token,r.data.token);
 await f.call('/api/logout',{},r.data.token);assert.equal((await f.call('/api/auth/operations/result',p)).status,409);
});
test('A04 a consumed recovery grant cannot be reused and older code receipts go stale after rotation',async t=>{
 const f=await fixture(t),r=await f.register();
 const first=await f.call('/api/account/reauth',{password:PASSWORD,purpose:'rotate_recovery'},r.token);const a=await f.prepare('rotate_recovery',{},r.token),b=await f.prepare('rotate_recovery',{},r.token);
 const rotated=await f.call('/api/account/recovery-code',{...a,reauthProof:first.data.reauthProof},r.token);assert.equal(rotated.status,200);assert.ok(rotated.data.recoveryCode);assert.notEqual(rotated.data.recoveryCode,r.recoveryCode);
 assert.equal((await f.call('/api/account/recovery-code',{...b,reauthProof:first.data.reauthProof},r.token)).status,403);
 const second=await f.call('/api/account/reauth',{password:PASSWORD,purpose:'rotate_recovery'},r.token),c=await f.prepare('rotate_recovery',{},r.token);
 assert.equal((await f.call('/api/account/recovery-code',{...c,reauthProof:second.data.reauthProof},r.token)).status,200);
 assert.equal((await f.call('/api/auth/operations/result',a)).status,409);assert.equal((await f.call('/api/me',undefined,r.token)).status,200);
});
test('A04 signed expiration cannot be bypassed by cleaning the database receipt',async t=>{
 const f=await fixture(t),r=await f.register();const base=Date.now();t.mock.method(Date,'now',()=>base+11*60000);f.DB.raw.prepare('DELETE FROM auth_operations WHERE request_id=?').run(r.proof.requestId);
 assert.equal((await f.call('/api/auth/password/register',{...r.proof,password:PASSWORD})).status,410);assert.equal(f.DB.raw.prepare('SELECT count(*) n FROM players').get().n,1);
});
test('A04 password login rechecks credentials after KDF and cannot race past a password change',async t=>{
 const {createPasswordKdf}=await kdfModule;const native=createPasswordKdf();let armed=false,started,release;const began=new Promise(r=>started=r),held=new Promise(r=>release=r);
 const f=await fixture(t,{kdf:async(...args)=>{if(armed){armed=false;started();await held;}return native(...args);}}),r=await f.register();armed=true;
 const stale=f.call('/api/auth/password/login',{loginHandle:r.account.loginHandle,password:PASSWORD});await began;
 const op=await f.prepare('change_password',{},r.token);const change=await f.call('/api/account/password',{...op,operation:'change',oldPassword:PASSWORD,newPassword:'a new long and strong password'},r.token);assert.equal(change.status,200);release();assert.equal((await stale).status,401);
 assert.equal(f.DB.raw.prepare('SELECT count(*) n FROM tokens').get().n,1);
});
test('A04 token expiration is enforced and password bytes keep spaces and normalization distinctions',async t=>{
 const f=await fixture(t),password='  Ｆｕｌｌwidth password 123  ',r=await f.register('原样密码',password);
 for(const wrong of [password.trim(),password.normalize('NFKC')])assert.equal((await f.call('/api/auth/password/login',{loginHandle:r.account.loginHandle,password:wrong})).status,401);
 t.mock.method(Date,'now',()=>r.expiresAt+1);assert.equal((await f.call('/api/me',undefined,r.token)).status,401);
});
test('A04 a reserved handle searches the complete suffix space instead of failing after random collisions',async t=>{
 const f=await fixture(t);f.DB.transaction(db=>{const op=db.prepare("INSERT INTO auth_operations(request_id,actor_scope,action,retry_secret_hash,created_at,expires_at) VALUES (?,'fixture','register',?,1,?)"),res=db.prepare('INSERT INTO login_handle_reservations VALUES(?,?,?,?)');for(let i=0;i<9999;i++){const id='fixture-'+i,handle='编号满#'+String(i).padStart(4,'0');op.run(id,'a'.repeat(64),Date.now()+600000);res.run(id,handle,handle,Date.now()+600000);}});
 const prepare=()=>f.call('/api/auth/operations',{action:'register',name:'编号满',requestId:newIntentId(Date.now()-1000),retrySecret:randomBytes(32).toString('base64url')});const last=await prepare();assert.equal(last.status,200);assert.equal(last.data.loginHandle,'编号满#9999');assert.equal((await prepare()).data.error,'name_crowded');
});

test('A04 an unused password field cannot change the effective password outside the receipt HMAC',async t=>{
 const f=await fixture(t),r=await f.register(),proof=await f.prepare('change_password',{},r.token);
 const result=await f.call('/api/account/password',{...proof,operation:'change',oldPassword:PASSWORD,newPassword:'intended new password value',password:'unbound injected password value'},r.token);assert.equal(result.status,400);
});

async function fakeOAuth(t,f){
 f.env.LINUXDO_TOKEN_URL='https://provider.example.test/token';f.env.LINUXDO_USER_URL='https://provider.example.test/user';
 t.mock.method(globalThis,'fetch',async url=>url===f.env.LINUXDO_TOKEN_URL?Response.json({access_token:'fixture-provider-token'}):url===f.env.LINUXDO_USER_URL?Response.json({id:777,username:'provider_user',active:true,silenced:false,trust_level:1}):Promise.reject(Error('Unexpected fixture network')));
 const start=async token=>{const r=await f.call('/api/auth/linuxdo/start',{returnTo:'https://game.example.test/'},token);assert.equal(r.status,200,JSON.stringify(r.data));return new URL(r.data.url).searchParams.get('state');};
 const callback=async state=>f.call('/api/auth/linuxdo/callback?code=fixture&state='+state);
 return {start,callback};
}
test('A04 legacy OAuth cannot treat a password account as a mergeable guest',async t=>{
 const f=await fixture(t),r=await f.register();assert.equal((await f.call('/api/auth/linuxdo/start',{returnTo:'https://game.example.test/'},r.token)).status,409);
});
test('A04 a held guest callback cannot merge an account upgraded to password immediately before the transaction',async t=>{
 const f=await fixture(t),oauth=await fakeOAuth(t,f);
 const targetCallback=await oauth.callback(await oauth.start());const targetCode=new URLSearchParams(new URL(targetCallback.headers.get('Location')).hash.slice(1)).get('login');const target=(await f.call('/api/auth/exchange',{code:targetCode})).data;
 const guest=(await f.call('/api/register',{name:'竞态游客'})).data;f.DB.raw.prepare('UPDATE players SET best_score=500,games=2 WHERE id=?').run(guest.player.id);const state=await oauth.start(guest.token);
 const proof=await f.prepare('set_password',{name:'竞态游客'},guest.token);let upgraded;const batch=f.DB.batch.bind(f.DB);let once=true;
 f.DB.batch=async statements=>{if(once&&statements.some(s=>s.sql.startsWith('UPDATE players SET linuxdo_id'))){once=false;upgraded=await f.call('/api/account/password',{...proof,operation:'set',password:PASSWORD},guest.token);assert.equal(upgraded.status,201);}return batch(statements);};
 const response=await oauth.callback(state);const fragment=new URLSearchParams(new URL(response.headers.get('Location')).hash.slice(1));assert.ok(fragment.get('login_error'));assert.equal(fragment.get('login'),null);
 assert.equal((await f.call('/api/me',undefined,upgraded.data.token)).data.player.id,guest.player.id);assert.equal(f.DB.raw.prepare('SELECT linuxdo_id FROM players WHERE id=?').get(guest.player.id).linuxdo_id,null);
 assert.equal(f.DB.raw.prepare('SELECT best_score FROM players WHERE id=?').get(target.player.id).best_score,0);
});
test('A04 logout revokes pending sensitive intents and an old OAuth code cannot survive a password change',async t=>{
 const f=await fixture(t),r=await f.register();const pending=await f.prepare('change_password',{},r.token);await f.call('/api/logout',{},r.token);assert.equal((await f.call('/api/auth/operations/result',pending)).status,409);
 const fresh=(await f.call('/api/auth/password/login',{loginHandle:r.account.loginHandle,password:PASSWORD})).data;
 const code=randomBytes(32).toString('hex');const {createHash}=await import('node:crypto');const hash=createHash('sha256').update(code).digest('hex');
 f.DB.raw.prepare('INSERT INTO login_codes(code_hash,player_id,created_at,auth_version) VALUES(?,?,?,?)').run(hash,r.player.id,Date.now(),fresh.account.authVersion);
 const p=await f.prepare('change_password',{},fresh.token);assert.equal((await f.call('/api/account/password',{...p,operation:'change',oldPassword:PASSWORD,newPassword:'changed once more password'},fresh.token)).status,200);
 assert.equal((await f.call('/api/auth/exchange',{code})).status,400);
});

test('A04 logout immediately before an OAuth merge transaction prevents every source-data mutation',async t=>{
 const f=await fixture(t),oauth=await fakeOAuth(t,f);const targetCallback=await oauth.callback(await oauth.start());const targetCode=new URLSearchParams(new URL(targetCallback.headers.get('Location')).hash.slice(1)).get('login');const target=(await f.call('/api/auth/exchange',{code:targetCode})).data;
 const guest=(await f.call('/api/register',{name:'取消绑定'})).data;f.DB.raw.prepare('UPDATE players SET best_score=900,games=3 WHERE id=?').run(guest.player.id);const state=await oauth.start(guest.token);const batch=f.DB.batch.bind(f.DB);let once=true;
 f.DB.batch=async statements=>{if(once&&statements.some(s=>s.sql.startsWith('UPDATE players SET linuxdo_id'))){once=false;assert.equal((await f.call('/api/logout',{},guest.token)).status,200);}return batch(statements);};
 const response=await oauth.callback(state);assert.ok(new URLSearchParams(new URL(response.headers.get('Location')).hash.slice(1)).get('login_error'));
 assert.ok(f.DB.raw.prepare('SELECT id FROM players WHERE id=?').get(guest.player.id));assert.equal(f.DB.raw.prepare('SELECT best_score FROM players WHERE id=?').get(target.player.id).best_score,0);
});

test('A04 a fresh OAuth login cannot revive an older token whose auth version is already invalid',async t=>{
 const f=await fixture(t),oauth=await fakeOAuth(t,f);const login=async()=>{const cb=await oauth.callback(await oauth.start());const code=new URLSearchParams(new URL(cb.headers.get('Location')).hash.slice(1)).get('login');return f.call('/api/auth/exchange',{code});};
 const old=(await login()).data;f.DB.raw.prepare('UPDATE players SET auth_version=auth_version+1 WHERE id=?').run(old.player.id);assert.equal((await f.call('/api/me',undefined,old.token)).status,401);
 const fresh=await login();assert.equal(fresh.status,200);assert.equal((await f.call('/api/me',undefined,old.token)).status,401);
});

test('A04 malformed non-ASCII ticket signatures are rejected without an internal error',async t=>{
 const f=await fixture(t),p=await f.prepare('register',{name:'票据校验'});const parts=p.operationTicket.split('.');parts[2]='é'.repeat(64);const r=await f.call('/api/auth/operations/result',{...p,operationTicket:parts.join('.')});assert.equal(r.status,409);
});

test('A04 a guest merging into an existing linked identity receives success without losing the fixed login handle',async t=>{
 const f=await fixture(t),oauth=await fakeOAuth(t,f);const cb=await oauth.callback(await oauth.start()),code=new URLSearchParams(new URL(cb.headers.get('Location')).hash.slice(1)).get('login'),ld=(await f.call('/api/auth/exchange',{code})).data;
 const {createHash}=await import('node:crypto');const sha=v=>createHash('sha256').update(v).digest('hex'),grant=randomBytes(32).toString('base64url');
 f.DB.raw.prepare('INSERT INTO reauth_grants VALUES(?,?,?,?,?,?)').run(sha(grant),ld.player.id,sha(ld.token),0,'set_password',Date.now()+300000);
 const proof=await f.prepare('set_password',{name:'本地账号'},ld.token),linked=(await f.call('/api/account/password',{...proof,operation:'set',password:PASSWORD,reauthProof:grant},ld.token)).data;
 assert.equal(linked.account.kind,'linked');const guest=(await f.call('/api/register',{name:'合并游客'})).data;
 f.DB.raw.prepare('UPDATE players SET best_score=250,games=2 WHERE id=?').run(guest.player.id);
 const state=await oauth.start(guest.token),merged=await oauth.callback(state),fragment=new URLSearchParams(new URL(merged.headers.get('Location')).hash.slice(1));assert.equal(fragment.get('login_error'),null);assert.ok(fragment.get('login'));
 const result=await f.call('/api/auth/exchange',{code:fragment.get('login')});assert.equal(result.status,200);assert.equal(result.data.player.id,linked.player.id);assert.equal(result.data.account.loginHandle,linked.account.loginHandle);assert.equal(result.data.player.name,'本地账号');
});

test('A04 cancelling a prepared intent prevents a late KDF commit; cancellation never pretends a completed write was undone',async t=>{
 const {createPasswordKdf}=await kdfModule,native=createPasswordKdf();let started,release;const began=new Promise(r=>started=r),held=new Promise(r=>release=r);let arm=true;
 const f=await fixture(t,{kdf:async(...args)=>{if(arm){arm=false;started();await held;}return native(...args);}}),proof=await f.prepare('register',{name:'取消登记'});
 const pending=f.call('/api/auth/password/register',{...proof,password:PASSWORD});await began;
 const cancelled=await f.call('/api/auth/operations/cancel',proof);release();const late=await pending;assert.equal(cancelled.status,200);assert.equal(cancelled.data.kind,'cancelled');assert.equal(late.status,409);assert.equal(f.DB.raw.prepare('SELECT count(*) n FROM players').get().n,0);
 const r=await f.register();const complete=await f.call('/api/auth/operations/cancel',r.proof);assert.equal(complete.data.kind,'completed');assert.equal(complete.data.result.token,r.token);
});

test('A04 replay refreshes public safe names while keeping the immutable token and recovery code',async t=>{
 const f=await fixture(t),r=await f.register('回执姓名');f.env.BLOCKED_WORDS='回执姓名';const read=await f.call('/api/auth/operations/result',r.proof);
 assert.equal(read.status,200);assert.match(read.data.player.name,/^玩家·\d+$/u);assert.equal(read.data.token,r.token);assert.equal(read.data.recoveryCode,r.recoveryCode);assert.equal(read.data.account.loginHandle,r.account.loginHandle);
});
test('A04 new names prepared under an older policy are rechecked before credential creation',async t=>{
 const f=await fixture(t),p=await f.prepare('register',{name:'政策调整'});f.env.BLOCKED_WORDS='政策调整';const r=await f.call('/api/auth/password/register',{...p,password:PASSWORD});assert.equal(r.status,400);assert.equal(f.DB.raw.prepare('SELECT count(*) n FROM players').get().n,0);
});

test('A04 an expired preparation cannot become a new registration after its receipt has been purged',async t=>{
 const f=await fixture(t),r=await f.register('过期登记');const base=Date.now();t.mock.method(Date,'now',()=>base+25*3600000);f.DB.raw.prepare('DELETE FROM auth_operations WHERE request_id=?').run(r.proof.requestId);
 const again=await f.call('/api/auth/operations',{action:'register',name:'过期登记',requestId:r.proof.requestId,retrySecret:r.proof.retrySecret});assert.equal(again.status,410);assert.equal(f.DB.raw.prepare('SELECT count(*) n FROM players').get().n,1);
});

test('A04 key rotation retains old protected receipts during TTL and signs new intents with the active key',async t=>{
 const f=await fixture(t),registered=await f.register();const next=keys();
 const rotated={...f.config,current:'v2',versions:{...f.config.versions,v2:next.versions.v1}};
 const {createPasswordAuth}=await authModule;
 f.env.PASSWORD_AUTH=createPasswordAuth({DB:f.DB,keyring:rotated,kdf:f.kdf,enabled:true});
 const replay=await f.call('/api/auth/operations/result',registered.proof);assert.equal(replay.status,200);assert.equal(replay.data.token,registered.token);
 const second=await f.register('新密钥测试');assert.notEqual(second.player.id,registered.player.id);
 assert.equal(f.DB.raw.prepare('SELECT key_version FROM auth_operations WHERE request_id=?').get(second.proof.requestId).key_version,'v2');
});

test('A06 unsupported credential parameter versions cannot be overwritten through old-password change',async t=>{
 const f=await fixture(t),registered=await f.register();
 f.DB.raw.prepare('UPDATE password_credentials SET params_version=2 WHERE player_id=?').run(registered.player.id);
 assert.equal((await f.call('/api/auth/password/login',{loginHandle:registered.account.loginHandle,password:PASSWORD})).status,401);
 const op=await f.prepare('change_password',{},registered.token);
 const response=await f.call('/api/account/password',{...op,operation:'change',oldPassword:PASSWORD,newPassword:PASSWORD+' changed'},registered.token);
 assert.equal(response.status,401,'unsupported credential version must fail closed');assert.equal(response.data.error,'invalid_credentials');
 assert.equal(f.DB.raw.prepare('SELECT params_version FROM password_credentials WHERE player_id=?').get(registered.player.id).params_version,2);
});

test('A06 a credential parameter change during KDF prevents an old-format login result',async t=>{
 const {createPasswordKdf}=await kdfModule,native=createPasswordKdf();let armed=false,release,started;
 const began=new Promise(r=>started=r),hold=new Promise(r=>release=r);
 const f=await fixture(t,{kdf:async(...args)=>{if(armed){armed=false;started();await hold;}return native(...args);}}),registered=await f.register();
 armed=true;const login=f.call('/api/auth/password/login',{loginHandle:registered.account.loginHandle,password:PASSWORD});await began;
 f.DB.raw.prepare('UPDATE password_credentials SET params_version=2 WHERE player_id=?').run(registered.player.id);release();
 assert.equal((await login).status,401);assert.equal(f.DB.raw.prepare('SELECT count(*) n FROM tokens').get().n,1);
});

test('A07 closing new password enrollment preserves existing login, recovery and completed receipts',async t=>{
 const f=await fixture(t),registered=await f.register(),pending=await f.prepare('register',{name:'发布暂停'});
 const {createPasswordAuth}=await authModule;f.env.PASSWORD_AUTH=createPasswordAuth({DB:f.DB,keyring:f.config,kdf:f.kdf,enabled:true,registrationEnabled:false,bindingEnabled:false});
 const caps=(await f.call('/api/auth/capabilities')).data;assert.equal(caps.passwordEnabled,true);assert.equal(caps.registrationEnabled,false);
 assert.equal((await f.call('/api/auth/password/register',{...pending,password:PASSWORD})).data.error,'registration_disabled');
 assert.equal((await f.call('/api/auth/password/register',{...registered.proof,password:PASSWORD})).status,201);
 assert.equal((await f.call('/api/auth/password/login',{loginHandle:registered.account.loginHandle,password:PASSWORD})).status,200);
 const guest=(await f.call('/api/register',{name:'仍可游客'})).data;
 assert.equal((await f.call('/api/me',undefined,guest.token)).data.capabilities.canSetPassword,false);
 const recovery=await f.prepare('recover_password',{loginHandle:registered.account.loginHandle});
 assert.equal((await f.call('/api/auth/password/recover',{...recovery,loginHandle:registered.account.loginHandle,recoveryCode:registered.recoveryCode,newPassword:PASSWORD+' restored'})).status,200);
});
