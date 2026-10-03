// A06 business matrix. Provider-backed identities are seeded here; real OAuth
// acceptance is owned by the user and is not repeated by this suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {openDatabase} from '../../server/sqlite.mjs';
import {createPasswordAuth} from '../../server/password-auth.mjs';
import {createPasswordKdf} from '../../server/password-kdf.mjs';
import {newIntentId} from '../../src/auth-intent-id.js';
import worker from '../src/index.js';
const secret=()=>randomBytes(32).toString('base64url'),sha=s=>createHash('sha256').update(s).digest('hex');
for(const kind of ['guest','password','linuxdo','linked'])test(`A06 ${kind}: classic/daily ownership, mode separation, receipts and public privacy`,async t=>{
 const DB=openDatabase(':memory:');t.after(()=>DB.close());const env={DB,ALLOWED_ORIGINS:'https://game.example.test'};
 env.PASSWORD_AUTH=createPasswordAuth({DB,keyring:{current:'v1',rate:secret(),versions:{v1:{ticket:secret(),receipt:secret(),payload:secret()}}},kdf:createPasswordKdf(),enabled:true});
 let serial=0;const call=async(path,body,token)=>{const r=await worker.fetch(new Request('https://game.example.test'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.'+(++serial),...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)}),env);return {status:r.status,data:await r.json()};};
 let p;
 if(kind==='guest')p=(await call('/api/register',{name:'矩阵游客'})).data;
 else if(kind==='linuxdo'){
  const id=randomUUID(),token=secret(),now=Date.now();DB.raw.prepare("INSERT INTO players(id,name,name_key,token_hash,created_at,linuxdo_id,trust_level) VALUES(?,'矩阵外部','ld:1001',?,?,1001,1)").run(id,sha(token),now);
  DB.raw.prepare("INSERT INTO tokens(token_hash,player_id,created_at,auth_method,auth_version,authenticated_at,expires_at) VALUES(?,?,?,'linuxdo',0,?,?)").run(sha(token),id,now,now,now+86400000);p={player:{id},token};
 }else{
  const proof={requestId:newIntentId(Date.now()-1000),retrySecret:secret()},prepared=await call('/api/auth/operations',{action:'register',name:'矩阵密码',...proof});assert.equal(prepared.status,200);
  p=(await call('/api/auth/password/register',{...proof,operationTicket:prepared.data.operationTicket,password:'Acceptance-password-2026'})).data;
  if(kind==='linked')DB.raw.prepare('UPDATE players SET linuxdo_id=2002,trust_level=1 WHERE id=?').run(p.player.id);
 }
 assert.equal((await call('/api/me',undefined,p.token)).data.account.kind,kind);
 const other=(await call('/api/register',{name:'矩阵其他'})).data;
 const classic=(await call('/api/session',{},p.token)).data.sessionId;DB.raw.prepare('UPDATE sessions SET started_at=? WHERE id=?').run(Date.now()-10000,classic);
 assert.equal((await call('/api/session/check?sessionId='+classic,undefined,other.token)).data.status,'invalid');
 const classicBody={sessionId:classic,score:10,drops:2,maxLevel:2};
 assert.equal((await call('/api/score',classicBody,other.token)).status,400);
 const accepted=await call('/api/score',classicBody,p.token);assert.equal(accepted.status,200);assert.deepEqual((await call('/api/score',classicBody,p.token)).data,accepted.data);
 const today=(await call('/api/challenges/today',undefined,p.token)).data.challenge;
 const intent={mode:'formal',challengeId:today.challengeId,rulesVersion:today.rulesVersion,requestId:randomUUID()};
 assert.equal((await call('/api/challenges/session',{...intent,mode:'practice'},p.token)).status,400);
 const formal=await call('/api/challenges/session',intent,p.token);assert.equal(formal.status,200);
 assert.equal((await call('/api/challenges/session',intent,p.token)).data.session.sessionId,formal.data.session.sessionId);
 DB.raw.prepare('UPDATE challenge_sessions SET started_at=? WHERE id=?').run(Date.now()-10000,formal.data.session.sessionId);
 const dailyBody={mode:'formal',sessionId:formal.data.session.sessionId,challengeId:today.challengeId,rulesVersion:today.rulesVersion,score:80,drops:10,maxLevel:5,clawsUsed:0,settlingMs:0,reason:'danger'};
 assert.equal((await call('/api/challenges/score',{...dailyBody,mode:'practice'},p.token)).status,400);
 assert.equal((await call('/api/challenges/score',dailyBody,other.token)).status,400);
 const daily=await call('/api/challenges/score',dailyBody,p.token);assert.equal(daily.status,200);assert.deepEqual((await call('/api/challenges/score',dailyBody,p.token)).data,daily.data);
 const me=(await call('/api/me',undefined,p.token)).data;assert.equal(me.games,1);assert.equal(me.best,10);
 assert.equal((await call('/api/challenges/today',undefined,p.token)).data.allowance.used,1);
 assert.equal(DB.raw.prepare('SELECT count(*) n FROM scores WHERE player_id=?').get(p.player.id).n,1);assert.equal(DB.raw.prepare('SELECT count(*) n FROM challenge_scores WHERE player_id=?').get(p.player.id).n,1);
 const boardReplies=[await call('/api/leaderboard'),await call('/api/challenges/leaderboard?challengeId='+today.challengeId)];for(const reply of boardReplies){assert.equal(reply.status,200);assert.ok(reply.data.entries.some(entry=>entry.id===p.player.id));}const boards=boardReplies.map(reply=>reply.data);
 const privateFields=new Set(['token','token_hash','loginHandle','login_handle','recoveryCode','derived_key','salt','auth_version','authVersion','password']);
 const inspect=v=>{if(v&&typeof v==='object')for(const [key,value]of Object.entries(v)){assert.ok(!privateFields.has(key),'private credential field in public response');inspect(value);}};boards.forEach(inspect);
 assert.ok(!JSON.stringify(boards).includes(p.token));
});
