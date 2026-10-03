import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {openDatabase} from '../../server/sqlite.mjs';
import {createPasswordAuth} from '../../server/password-auth.mjs';
import {createPasswordKdf} from '../../server/password-kdf.mjs';
import {newIntentId} from '../../src/auth-intent-id.js';
import worker from '../src/index.js';
const secret=()=>randomBytes(32).toString('base64url'),hash=s=>createHash('sha256').update(s).digest('hex');
const password='Fixture-password-with-enough-length';
function fixture(t){
 const DB=openDatabase(':memory:');t.after(()=>DB.close());
 const env={DB,ALLOWED_ORIGINS:'https://game.example.test',LINUXDO_CLIENT_ID:'fixture',LINUXDO_CLIENT_SECRET:'fixture'};
 env.PASSWORD_AUTH=createPasswordAuth({DB,keyring:{current:'v1',rate:secret(),versions:{v1:{ticket:secret(),receipt:secret(),payload:secret()}}},kdf:createPasswordKdf(),enabled:true});
 let ip=0,user={id:1001,username:'ProviderUser',active:true,silenced:false,trust_level:1,avatar_template:'/avatar/{size}.png'};
 t.mock.method(globalThis,'fetch',async(url)=>String(url).includes('/oauth2/token')?Response.json({access_token:'fixture-access-token'}):Response.json(user));
 const call=async(path,body,token)=>{const r=await worker.fetch(new Request('https://api.example.test'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.'+(++ip),...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)}),env);return {status:r.status,headers:r.headers,data:r.status===302?null:await r.json()};};
 const prepare=async(action,fields={},token)=>{const p={requestId:newIntentId(Date.now()-1000),retrySecret:secret()};const r=await call('/api/auth/operations',{action,...fields,...p},token);assert.equal(r.status,200,JSON.stringify(r.data));return {...p,operationTicket:r.data.operationTicket};};
 const register=async(name='本地账号')=>{const proof=await prepare('register',{name});const r=await call('/api/auth/password/register',{...proof,password});assert.equal(r.status,201);return r.data;};
 const oauth=async(action='login',token,options={})=>{const clientNonce=secret(),purpose=options.purpose;const proof=await prepare('exchange_login',{oauthAction:action,clientNonce,...(purpose?{purpose}:{})},token);const start=await call('/api/auth/linuxdo/start',{...proof,action,clientNonce,returnTo:'https://game.example.test/',...(purpose?{purpose}:{}),...(options.reauthProof?{reauthProof:options.reauthProof}:{})},token);return {proof,clientNonce,start,token};};
 const callback=async flow=>{assert.equal(flow.start.status,200,JSON.stringify(flow.start.data));const state=new URL(flow.start.data.url).searchParams.get('state');const path='/api/auth/linuxdo/callback?state='+state+'&code=fixture-provider-code';const r=await call(path);assert.equal(r.status,302);const params=new URLSearchParams(new URL(r.headers.get('Location')).hash.slice(1));return {code:params.get('login'),error:params.get('login_error'),path};};
 const exchange=(flow,code)=>call('/api/auth/exchange',{...flow.proof,clientNonce:flow.clientNonce,code},flow.token);
 return {DB,env,call,prepare,register,oauth,callback,exchange,setUser:v=>{user={...user,...v};}};
}

test('A05 modern OAuth binds the original browser and defers account creation until exchange',async t=>{
 const f=fixture(t),flow=await f.oauth(),back=await f.callback(flow);assert.ok(back.code,back.error);
 assert.equal(f.DB.raw.prepare('SELECT count(*) n FROM players').get().n,0);
 const wrong=await f.call('/api/auth/exchange',{...flow.proof,clientNonce:secret(),code:back.code});assert.equal(wrong.status,409);
 const result=await f.exchange(flow,back.code);assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.account.kind,'linuxdo');assert.equal(result.data.kind,'authenticated');
 const replay=await f.exchange(flow,back.code);assert.equal(replay.status,200);assert.equal(replay.data.token,result.data.token);assert.equal(f.DB.raw.prepare('SELECT count(*) n FROM players').get().n,1);
 const inspected=await f.call('/api/auth/operations/result',flow.proof);assert.equal(inspected.data.token,result.data.token);
 const legacy=await f.call('/api/auth/exchange',{code:back.code});assert.equal(legacy.status,400);
});
test('A05 password binding requires recent proof and keeps one player, handle and original game',async t=>{
 const f=fixture(t),p=await f.register();const game=await f.call('/api/session',{},p.token);
 const denied=await f.oauth('bind',p.token);assert.equal(denied.start.status,403);
 await f.call('/api/auth/operations/cancel',denied.proof);
 const grant=await f.call('/api/account/reauth',{password,purpose:'bind_linuxdo'},p.token);
 const flow=await f.oauth('bind',p.token,{reauthProof:grant.data.reauthProof}),back=await f.callback(flow);
 const r=await f.exchange(flow,back.code);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.player.id,p.player.id);assert.equal(r.data.account.kind,'linked');assert.equal(r.data.account.loginHandle,p.account.loginHandle);
 assert.equal((await f.call('/api/session/check?sessionId='+game.data.sessionId,undefined,r.data.token)).data.status,'valid');
 assert.equal((await f.call('/api/auth/password/login',{loginHandle:p.account.loginHandle,password})).data.player.id,p.player.id);
 const login=await f.oauth(),b=await f.callback(login);assert.equal((await f.exchange(login,b.code)).data.player.id,p.player.id);
});
test('A05 provider identity owned by another formal account cannot be merged into a password account',async t=>{
 const f=fixture(t),first=await f.oauth(),cb=await f.callback(first),owner=await f.exchange(first,cb.code),p=await f.register();
 const proof=await f.call('/api/account/reauth',{password,purpose:'bind_linuxdo'},p.token),flow=await f.oauth('bind',p.token,{reauthProof:proof.data.reauthProof}),back=await f.callback(flow);
 const r=await f.exchange(flow,back.code);assert.equal(r.status,409);assert.equal(r.data.error,'binding_conflict');assert.ok(!JSON.stringify(r.data).includes(owner.data.player.id));
 assert.equal(f.DB.raw.prepare('SELECT count(*) n FROM players').get().n,2);assert.equal((await f.call('/api/me',undefined,p.token)).data.account.kind,'password');
});
test('A05 OAuth reauth grants only the same provider identity and permits Linux.do to set a local password',async t=>{
 const f=fixture(t),login=await f.oauth(),cb=await f.callback(login),user=(await f.exchange(login,cb.code)).data;
 const flow=await f.oauth('reauth',user.token,{purpose:'set_password'}),back=await f.callback(flow),grant=await f.exchange(flow,back.code);assert.equal(grant.status,200);assert.equal(grant.data.kind,'reauth');assert.equal(grant.data.purpose,'set_password');
 const proof=await f.prepare('set_password',{name:'双方式账号'},user.token),set=await f.call('/api/account/password',{...proof,operation:'set',password,reauthProof:grant.data.reauthProof},user.token);
 assert.equal(set.status,201,JSON.stringify(set.data));assert.equal(set.data.player.id,user.player.id);assert.equal(set.data.account.kind,'linked');
 const wrong=await f.oauth('reauth',set.data.token,{purpose:'rotate_recovery'});f.setUser({id:2002,username:'OtherProvider'});const b=await f.callback(wrong);const r=await f.exchange(wrong,b.code);assert.equal(r.status,409);assert.equal(r.data.error,'identity_mismatch');
 assert.equal(f.DB.raw.prepare('SELECT count(*) n FROM players').get().n,1);
});

test('A05 a linked account can recover its password only with a fresh scoped OAuth grant',async t=>{
 const f=fixture(t),p=await f.register();const proof=await f.call('/api/account/reauth',{password,purpose:'bind_linuxdo'},p.token),binding=await f.oauth('bind',p.token,{reauthProof:proof.data.reauthProof}),back=await f.callback(binding),linked=(await f.exchange(binding,back.code)).data;
 const flow=await f.oauth('reauth',linked.token,{purpose:'recover_password'}),b=await f.callback(flow),reauth=await f.exchange(flow,b.code);
 const intent=await f.prepare('recover_password',{loginHandle:linked.account.loginHandle,recoveryMethod:'linuxdo'},linked.token);
 const denied=await f.call('/api/account/password',{...intent,operation:'recover',newPassword:password+' changed'},linked.token);assert.equal(denied.status,403);
 const change=await f.call('/api/account/password',{...intent,operation:'recover',newPassword:password+' changed',reauthProof:reauth.data.reauthProof},linked.token);
 assert.equal(change.status,200,JSON.stringify(change.data));assert.equal(change.data.player.id,p.player.id);assert.ok(change.data.recoveryCode);const replay=await f.call('/api/account/password',{...intent,operation:'recover',newPassword:password+' changed',reauthProof:reauth.data.reauthProof},linked.token);assert.equal(replay.status,200);assert.equal(replay.data.token,change.data.token);assert.equal((await f.call('/api/me',undefined,p.token)).status,401);
 assert.equal((await f.call('/api/auth/password/login',{loginHandle:p.account.loginHandle,password:password+' changed'})).status,200);
});

test('A05 guest merge transfers history and sums daily usage once, even after lost exchange responses',async t=>{
 const f=fixture(t),login=await f.oauth(),cb=await f.callback(login),target=(await f.exchange(login,cb.code)).data;
 const guest=(await f.call('/api/register',{name:'游客合并'})).data;
 const date='2026-10-04';
 f.DB.raw.prepare('INSERT INTO challenge_allowances(challenge_id,player_id,used) VALUES(?,?,?)').run(date,target.player.id,2);
 f.DB.raw.prepare('INSERT INTO challenge_allowances(challenge_id,player_id,used) VALUES(?,?,?)').run(date,guest.player.id,1);
 f.DB.raw.prepare('UPDATE players SET games=3,best_score=100,best_level=3,best_at=1 WHERE id=?').run(guest.player.id);
 const session=await f.call('/api/session',{},guest.token);
 const bind=await f.oauth('bind',guest.token),b=await f.callback(bind),result=await f.exchange(bind,b.code);assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.player.id,target.player.id);assert.equal(result.data.mergedFromPlayerId,guest.player.id);
 const replay=await f.exchange(bind,b.code);assert.equal(replay.data.token,result.data.token);
 assert.equal(f.DB.raw.prepare('SELECT used FROM challenge_allowances WHERE player_id=?').get(target.player.id).used,3);
 assert.equal(f.DB.raw.prepare('SELECT games FROM players WHERE id=?').get(target.player.id).games,3);
 assert.equal((await f.call('/api/session/check?sessionId='+session.data.sessionId,undefined,result.data.token)).data.status,'valid');
 assert.equal(f.DB.raw.prepare('SELECT id FROM players WHERE id=?').get(guest.player.id),undefined);
 const repeated=await f.call(b.path);assert.equal(new URLSearchParams(new URL(repeated.headers.get('Location')).hash.slice(1)).get('login'),b.code);
});
test('A05 logout, password upgrade, cancellation and changed payload each block stale OAuth writes',async t=>{
 for(const change of ['logout','upgrade','cancel']){
  const f=fixture(t),guest=(await f.call('/api/register',{name:'状态变化'})).data,flow=await f.oauth('bind',guest.token),back=await f.callback(flow);
  if(change==='logout')await f.call('/api/logout',{},guest.token);
  if(change==='upgrade'){const intent=await f.prepare('set_password',{name:'状态变化'},guest.token);assert.equal((await f.call('/api/account/password',{...intent,operation:'set',password},guest.token)).status,201);}
  if(change==='cancel')await f.call('/api/auth/operations/cancel',flow.proof);
  const r=await f.exchange(flow,back.code);assert.equal(r.status,409);assert.equal(f.DB.raw.prepare('SELECT linuxdo_id FROM players WHERE id=?').get(guest.player.id).linuxdo_id,null);
 }
});
test('A05 provider callback duplication cannot cancel an in-flight confirmation or consume quota twice',async t=>{
 const f=fixture(t),flow=await f.oauth();let release,entered;
 const waiting=new Promise(r=>entered=r);t.mock.method(globalThis,'fetch',async(url)=>{if(String(url).includes('/oauth2/token')){entered();await new Promise(r=>release=r);return Response.json({access_token:'fixture'});}return Response.json({id:1001,username:'Concurrent',active:true,silenced:false,trust_level:1});});
 const first=f.callback(flow);await waiting;const second=await f.callback(flow);assert.ok(second.error);release();const done=await first;assert.ok(done.code,done.error);assert.equal((await f.exchange(flow,done.code)).status,200);
});
test('A05 linked rename stays local after fresh OAuth, and stale guest tokens are not revived',async t=>{
 const f=fixture(t),p=await f.register();const grant=await f.call('/api/account/reauth',{password,purpose:'bind_linuxdo'},p.token),flow=await f.oauth('bind',p.token,{reauthProof:grant.data.reauthProof}),back=await f.callback(flow),linked=(await f.exchange(flow,back.code)).data;
 const renamed=await f.call('/api/rename',{name:'本地新昵称'},linked.token);assert.equal(renamed.status,200);
 const stale=secret();f.DB.raw.prepare("INSERT INTO tokens(token_hash,player_id,created_at,auth_method,auth_version,expires_at) VALUES(?,?,?,'guest',?,NULL)").run(hash(stale),p.player.id,Date.now(),linked.account.authVersion-1);
 f.setUser({username:'ChangedProvider'});const login=await f.oauth(),cb=await f.callback(login),result=await f.exchange(login,cb.code);assert.equal(result.data.player.name,'本地新昵称');assert.equal(result.data.account.loginHandle,p.account.loginHandle);
 assert.equal((await f.call('/api/me',undefined,stale)).status,401);
});

test('A05 cancelled provider consent is terminal for that state',async t=>{
 const f=fixture(t),flow=await f.oauth(),state=new URL(flow.start.data.url).searchParams.get('state');
 const denied=await f.call('/api/auth/linuxdo/callback?state='+state+'&error=access_denied');assert.ok(denied.headers.get('Location').includes('oauth_cancelled'));
 const repeated=await f.callback(flow);assert.equal(repeated.code,null);assert.equal(f.DB.raw.prepare('SELECT count(*) n FROM players').get().n,0);
});
test('A05 new Linux.do binding revokes source guest/password sessions and leaves game ownership intact',async t=>{
 for(const formal of [false,true]){
  const f=fixture(t),p=formal?await f.register():(await f.call('/api/register',{name:'升级撤销'})).data;
  const before=(await f.call('/api/me',undefined,p.token)).data.account.authVersion,game=await f.call('/api/session',{},p.token);
  const grant=formal?await f.call('/api/account/reauth',{password,purpose:'bind_linuxdo'},p.token):null;
  const flow=await f.oauth('bind',p.token,{reauthProof:grant?.data.reauthProof}),back=await f.callback(flow),linked=await f.exchange(flow,back.code);
  assert.equal(linked.data.account.authVersion,before+1);assert.equal((await f.call('/api/me',undefined,p.token)).status,401);
  assert.equal((await f.call('/api/session/check?sessionId='+game.data.sessionId,undefined,linked.data.token)).data.status,'valid');
  assert.equal((await f.exchange(flow,back.code)).data.token,linked.data.token);
 }
});

test('A05 an expired one-time OAuth code cannot mutate an account before exchange',async t=>{
 const f=fixture(t),flow=await f.oauth(),back=await f.callback(flow);
 f.DB.raw.prepare('UPDATE oauth_account_flows SET login_code_expires_at=?').run(Date.now()-1);
 const r=await f.exchange(flow,back.code);assert.equal(r.status,400);assert.equal(f.DB.raw.prepare('SELECT count(*) n FROM players').get().n,0);
});
test('A05 an exchange failure rolls back guest ownership and daily allowances before a safe retry',async t=>{
 const f=fixture(t),login=await f.oauth(),cb=await f.callback(login),target=(await f.exchange(login,cb.code)).data,guest=(await f.call('/api/register',{name:'原子合并'})).data;
 f.DB.raw.prepare('INSERT INTO challenge_allowances(challenge_id,player_id,used) VALUES(?,?,?)').run('2026-10-04',guest.player.id,2);
 const flow=await f.oauth('bind',guest.token),back=await f.callback(flow);
 f.DB.raw.exec("CREATE TRIGGER fixture_reject_token BEFORE INSERT ON tokens WHEN NEW.auth_method='linuxdo' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;");
 t.mock.method(console,'error',()=>{});const failed=await f.exchange(flow,back.code);assert.equal(failed.status,500);
 assert.ok(f.DB.raw.prepare('SELECT id FROM players WHERE id=?').get(guest.player.id));assert.equal((await f.call('/api/me',undefined,guest.token)).status,200);
 assert.equal(f.DB.raw.prepare('SELECT used FROM challenge_allowances WHERE player_id=?').get(guest.player.id).used,2);assert.equal(f.DB.raw.prepare('SELECT used FROM challenge_allowances WHERE player_id=?').get(target.player.id),undefined);
 f.DB.raw.exec('DROP TRIGGER fixture_reject_token');const retried=await f.exchange(flow,back.code);assert.equal(retried.status,200);assert.equal((await f.call('/api/me',undefined,guest.token)).status,401);
 assert.equal(f.DB.raw.prepare('SELECT used FROM challenge_allowances WHERE player_id=?').get(target.player.id).used,2);
});

test('A05 disabled native service sends an existing OAuth flow safely back to the game without writes',async t=>{
 const f=fixture(t),flow=await f.oauth();f.env.PASSWORD_AUTH={available:false};
 const back=await f.callback(flow);assert.equal(back.code,null);assert.ok(back.error.includes('暂不可用'));assert.equal(f.DB.raw.prepare('SELECT count(*) n FROM players').get().n,0);
 for(const path of ['/api/auth/linuxdo/start','/api/auth/exchange'])assert.equal((await f.call(path,[])).status,400);
});

test('A05 provider cancellation after authorization stops an unexchanged flow but never pretends to undo a completed login',async t=>{
 const f=fixture(t),flow=await f.oauth(),back=await f.callback(flow),state=new URL(flow.start.data.url).searchParams.get('state');
 await f.call('/api/auth/linuxdo/callback?state='+state+'&error=access_denied');assert.equal((await f.exchange(flow,back.code)).status,409);
 const second=await f.oauth(),b=await f.callback(second),signed=await f.exchange(second,b.code),state2=new URL(second.start.data.url).searchParams.get('state');
 const repeat=await f.call('/api/auth/linuxdo/callback?state='+state2+'&error=access_denied');assert.equal(new URLSearchParams(new URL(repeat.headers.get('Location')).hash.slice(1)).get('login'),b.code);
 assert.equal((await f.exchange(second,b.code)).data.token,signed.data.token);
});
