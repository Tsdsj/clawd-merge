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
