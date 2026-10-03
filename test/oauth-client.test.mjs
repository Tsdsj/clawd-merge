import test from 'node:test';
import assert from 'node:assert/strict';
import {AccountClient} from '../src/account-client.js';
let OAuthClient;try{({OAuthClient}=await import('../src/oauth-client.js'));}catch{}
function fixture(transport,storage){
 const map=new Map();storage||={getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
 const identity={playerStorageKey:'isolated',player:null,beginAccountRequest(){return {id:this.player?.id,token:this.player?.token};},accountRequestCurrent(s){return s.id===this.player?.id&&s.token===this.player?.token;},endAccountRequest(){},async applyAuthResult(data){this.player={...data.player,token:data.token,account:data.account};}};
 const request=async(path,o)=>path.endsWith('capabilities')?{oauthAccountActions:true,serverNow:Date.now()}:transport(path,o);
 const client=new AccountClient({identity,request});const location={origin:'https://game.example.test',pathname:'/',search:'',hash:'',assign(url){this.assigned=url;}},history={replaceState(){location.hash='';}};
 assert.ok(OAuthClient,'A05 OAuth client must exist');const oauth=new OAuthClient({client,storage,location,history});return {client,oauth,identity,location,map,storage};
}
const auth={kind:'authenticated',player:{id:'LD',name:'Linuxdo'},token:'x'.repeat(43),expiresAt:Date.now()+100000,account:{kind:'linuxdo',authVersion:0}};
const replies=(path)=>path.endsWith('/operations')?{operationTicket:'ticket',expiresAt:Date.now()+600000}:path.endsWith('/start')?{url:'https://connect.example.test/authorize?state=fixture'}:auth;
test('A05 OAuth persists browser proof before navigation and can replay an exchange after response loss',async()=>{
 let fail=true;const f=fixture(async(path,o)=>{if(path.endsWith('/exchange')&&fail){fail=false;throw Object.assign(Error('timeout'),{code:'timeout'});}return replies(path,o);});
 await f.oauth.start('login');assert.ok(f.location.assigned);assert.ok(f.oauth.pending.clientNonce);assert.equal(f.oauth.pending.operationTicket,'ticket');
 f.location.hash='#login='+'c'.repeat(43);await assert.rejects(f.oauth.finishRedirect(),{code:'timeout'});assert.equal(f.location.hash,'');
 const reloaded=new OAuthClient({client:f.client,storage:f.storage,location:f.location,history:{replaceState(){}}});
 const result=await reloaded.inspect();assert.equal(result.player.id,'LD');assert.equal(f.identity.player.id,'LD');
});
test('A05 unavailable session storage blocks redirect before any OAuth writes',async()=>{
 let calls=0;const f=fixture(()=>{calls++;},{getItem:()=>null,setItem(){throw Error('blocked');},removeItem(){}});
 await assert.rejects(f.oauth.start('login'),{code:'oauth_storage_required'});assert.equal(calls,0);assert.equal(f.location.assigned,undefined);
});
test('A05 another account active after redirect cannot be replaced by the old browser proof',async()=>{
 let exchanges=0;const f=fixture(path=>{if(path.endsWith('/exchange'))exchanges++;return replies(path);});await f.oauth.start('login');
 f.identity.player={id:'other',token:'different'};f.location.hash='#login='+'c'.repeat(43);
 await assert.rejects(f.oauth.finishRedirect(),{code:'identity_changed'});assert.equal(f.identity.player.id,'other');assert.equal(exchanges,0);
});
test('A05 reauth proof stays in memory and wrong provider/player result is rejected',async()=>{
 const f=fixture(path=>path.endsWith('/exchange')?{kind:'reauth',reauthProof:'g'.repeat(43),purpose:'rotate_recovery',playerId:'A',authVersion:2,expiresAt:Date.now()+300000}:replies(path));
 f.identity.player={id:'A',token:'source-token',account:{kind:'linked',authVersion:2}};
 await f.oauth.start('reauth',{purpose:'rotate_recovery'});f.location.hash='#login='+'c'.repeat(43);const grant=await f.oauth.finishRedirect();assert.equal(grant.kind,'reauth');assert.ok(!JSON.stringify([...f.map]).includes(grant.reauthProof));
});

test('A05 an expired local identity can re-login only as the same player, without sending its expired bearer',async()=>{
 const sent=[];const f=fixture((path,o)=>{sent.push({path,token:o?.token});return path.endsWith('/exchange')?{...auth,player:{id:'A',name:'Original'}}:replies(path);});
 f.identity.player={id:'A',token:'expired',account:{kind:'linuxdo',authVersion:0}};
 await f.oauth.start('login',{samePlayerOnly:true});f.location.hash='#login='+'c'.repeat(43);const data=await f.oauth.finishRedirect();assert.equal(data.player.id,'A');assert.ok(sent.every(r=>!r.token));
});

test('A05 discarding a completed login for another player keeps the current identity and explains non-adoption',async()=>{
 const f=fixture(path=>path.endsWith('/cancel')?{kind:'completed',result:auth}:replies(path));
 f.identity.player={id:'A',token:'expired',account:{kind:'linuxdo',authVersion:0}};await f.oauth.start('login',{samePlayerOnly:true});
 const discarded=await f.oauth.discard();assert.equal(discarded.kind,'not_adopted');assert.equal(f.identity.player.id,'A');assert.equal(f.oauth.pending,null);
});
