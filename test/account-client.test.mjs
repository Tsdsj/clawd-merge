import test from 'node:test';
import assert from 'node:assert/strict';
import {AccountClient} from '../src/account-client.js';
function fixture(request,storage=null){
 const identity={playerStorageKey:'isolated',player:null,beginAccountRequest:()=>({id:null,token:null}),accountRequestCurrent:()=>true,endAccountRequest(){},applyAuthResult:async()=>{identity.applied=true;}};
 return {identity,client:new AccountClient({identity,request,storage})};
}
const response={operationTicket:'test-ticket',expiresAt:Date.now()+600000,loginHandle:'Test#1234'};
const transport=async path=>path.endsWith('capabilities')?{serverNow:Date.now()}:response;
test('account storage failure requires explicit temporary acknowledgement before commit',async()=>{
 let writes=0;const {client}=fixture(async(path)=>{if(path.endsWith('/register'))writes++;return transport(path);},{getItem:()=>null,setItem(){throw Error('full');}});
 await client.prepare('register',{name:'Test'});assert.equal(client.intentDurable,false);
 await assert.rejects(client.commit({password:'private'}),{code:'storage_required'});assert.equal(writes,0);
});
test('prepared intent persists no password or recovery code and retries same request ID',async()=>{
 const map=new Map(),ids=[];const {client}=fixture(async(path,o)=>{if(path.endsWith('/operations'))ids.push(o.body.requestId);return transport(path);},{getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v)});
 await client.prepare('register',{name:'Test',password:'private',recoveryCode:'secret'});await client.prepare('register',{name:'Test'});
 assert.equal(ids[0],ids[1]);assert.ok(!JSON.stringify([...map]).includes('private'));assert.ok(!JSON.stringify([...map]).includes('recoveryCode'));
});
test('late prepare response cannot become current after identity changes',async()=>{
 let resolve;const {client,identity}=fixture(async(path)=>path.endsWith('capabilities')?{serverNow:Date.now()}:new Promise(r=>resolve=r));
 const p=client.prepare('register',{name:'Test'});while(!resolve)await new Promise(r=>setImmediate(r));identity.accountRequestCurrent=()=>false;resolve(response);
 await assert.rejects(p,{code:'identity_changed'});assert.equal(client.intent.operationTicket,undefined);
});
test('corrupt saved operation cannot silently create a duplicate registration',async()=>{
 const {client}=fixture(transport,{getItem:()=>'{bad'});await assert.rejects(client.prepare('register',{name:'Test'}),{code:'intent_unreadable'});
});

test('A06 a transient intent deletion failure preserves the original operation and can be retried',async()=>{
 const map=new Map();let failDelete=true;
 const storage={getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem(k){if(failDelete){failDelete=false;throw Error('temporary storage failure');}map.delete(k);}};
 const {client}=fixture(async(path)=>path.endsWith('/cancel')?{kind:'cancelled'}:transport(path),storage);
 await client.prepare('register',{name:'Test'});const original=client.intent.requestId;
 await assert.rejects(client.cancelPending(),{code:'local_cleanup_failed'});
 assert.equal(client.intent.requestId,original);assert.ok(map.has(client.key));
 assert.equal((await client.cancelPending()).kind,'cancelled');assert.equal(client.intent,null);assert.equal(map.has(client.key),false);
 await client.prepare('register',{name:'Next'});assert.notEqual(client.intent.requestId,original);
});
test('A06 a newly observed operation from another page is kept rather than replaced by a failed new intent',async()=>{
 const map=new Map(),storage={getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
 const first=fixture(transport,storage).client,second=fixture(transport,storage).client;
 await first.prepare('register',{name:'Original'});const original=first.intent.requestId;
 await assert.rejects(second.prepare('register',{name:'Another'}),{code:'identity_changed'});
 assert.equal(second.intent.requestId,original);assert.equal(JSON.parse(map.get(first.key)).requestId,original);
});
