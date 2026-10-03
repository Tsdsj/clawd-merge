import {AccountClientError} from './account-client.js';
import {newIntentId} from './auth-intent-id.js';
const fail=(code,message)=>{throw new AccountClientError(code,message);};
const secret=()=>{const b=crypto.getRandomValues(new Uint8Array(32));return btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
const fingerprint=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value||'')))].map(n=>n.toString(16).padStart(2,'0')).join('');
const proof=p=>({requestId:p.requestId,retrySecret:p.retrySecret,operationTicket:p.operationTicket});
const kind=p=>p?.account?.kind||(p?.linuxdo?'linuxdo':p?'guest':'anonymous');
// Only this tab retains the OAuth nonce, code and receipt proof. Passwords and
// scoped reauth grants never enter storage. The server controls their lifetime.
export class OAuthClient {
 constructor({client,storage=()=>globalThis.sessionStorage,location=globalThis.location,history=globalThis.history,beforeNavigate=null,beforeApply=null}){
  this.client=client;this.identity=client.identity;this.storageSource=storage;this.location=location;this.history=history;this.beforeNavigate=beforeNavigate;this.beforeApply=beforeApply;
  this.key=this.identity.playerStorageKey+':oauth-intent';this.pending=null;this.unreadable=false;this.result=null;
  try{const raw=this.storage?.getItem(this.key);if(raw){if(raw.length>16384)throw Error('invalid');const p=JSON.parse(raw);if(p.schemaVersion!==1||!['login','bind','reauth'].includes(p.action)||typeof p.requestId!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(p.clientNonce||'')||!/^[A-Za-z0-9_-]{43}$/.test(p.retrySecret||'')||typeof p.actorHash!=='string')throw Error('invalid');this.pending=p;}}
  catch{this.unreadable=true;}
 }
 get storage(){try{return typeof this.storageSource==='function'?this.storageSource():this.storageSource;}catch{return null;}}
 save(){try{const storage=this.storage;if(!storage)throw Error('blocked');storage.setItem(this.key,JSON.stringify(this.pending));if(storage.getItem(this.key)!==JSON.stringify(this.pending))throw Error('not saved');}catch{fail('oauth_storage_required','无法保存本页授权信息。请允许浏览器会话存储后重试，或使用密码登录。');}}
 async sourceMatches(snapshot,p=this.pending){return p&&p.actorId===(snapshot.id??null)&&p.actorHash===await fingerprint(snapshot.token);}
 async start(action,{purpose,reauthProof,samePlayerOnly=false}={}){
  if(this.pending||this.unreadable||this.client.intent)fail('operation_in_progress','请先处理上一份账号操作，再开始授权');
  if(!['login','bind','reauth'].includes(action))fail('bad_request','授权用途不正确');
  if(this.identity.memoryOnly)fail('oauth_storage_required','当前登录仅保存在内存。请先保存登录状态，再离开本页授权。');
  const features=await this.client.features();if(!features.oauthAccountActions||!this.client.serverClock)fail('login_disabled','此账号授权功能暂不可用');
  const {snapshot}=await this.client.guarded(async snapshot=>{
   if(action==='login'&&snapshot.id&&!samePlayerOnly)fail('different_account','请先退出当前账号，再登录其他账号');
   if(samePlayerOnly&&(!snapshot.id||!['linuxdo','linked'].includes(kind(this.identity.player))))fail('different_account','请使用当前账号已有的登录方式');
   this.pending={schemaVersion:1,action,purpose:purpose||null,samePlayerOnly:Boolean(samePlayerOnly),requestId:newIntentId(Math.floor(this.client.serverClock.now+performance.now()-this.client.serverClock.at-1000)),retrySecret:secret(),clientNonce:secret(),actorId:snapshot.id??null,actorHash:await fingerprint(snapshot.token),actorKind:kind(this.identity.player),returnTo:this.location.origin+this.location.pathname+this.location.search};
   this.save();
   await this.prepare(snapshot);
   await this.navigate(snapshot,reauthProof);
  });this.identity.endAccountRequest(snapshot);
 }
 async prepare(snapshot){
  const p=this.pending;if(p.operationTicket)return;
  const data=await this.client.request('/api/auth/operations',{method:'POST',token:p.action==='login'?undefined:snapshot.token,body:{action:'exchange_login',oauthAction:p.action,...(p.purpose?{purpose:p.purpose}:{}),clientNonce:p.clientNonce,requestId:p.requestId,retrySecret:p.retrySecret}});
  if(!this.identity.accountRequestCurrent(snapshot))fail('identity_changed','账号已变化，请检查原授权');
  if(typeof data.operationTicket!=='string'||!Number.isSafeInteger(data.expiresAt))fail('bad_response','没有收到完整的授权准备信息');
  Object.assign(p,{operationTicket:data.operationTicket,expiresAt:data.expiresAt});this.save();
 }
 async navigate(snapshot,reauthProof){
  const p=this.pending;if(!await this.sourceMatches(snapshot))fail('identity_changed','账号已变化，请在原页面检查授权');
  const data=await this.client.request('/api/auth/linuxdo/start',{method:'POST',token:p.action==='login'?undefined:snapshot.token,body:{...proof(p),action:p.action,clientNonce:p.clientNonce,returnTo:p.returnTo,...(p.purpose?{purpose:p.purpose}:{}),...(reauthProof?{reauthProof}:{})}});
  if(!this.identity.accountRequestCurrent(snapshot))fail('identity_changed','账号已变化，请检查原授权');
  let url;try{url=new URL(data.url);}catch{fail('bad_response','没有收到有效授权地址');}
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))fail('bad_response','授权地址不安全');
  p.started=true;this.save();const context=await this.beforeNavigate?.(p);if(context){p.returnContext=context;this.save();}
  if(!this.identity.accountRequestCurrent(snapshot))fail('identity_changed','账号已变化，请检查原授权');
  this.location.assign(url.toString());
 }
 async resume(){
  if(!this.pending)fail('operation_expired','没有可继续的授权');
  this.save();
  const {snapshot}=await this.client.guarded(async snapshot=>{if(!await this.sourceMatches(snapshot))fail('identity_changed','账号已变化，请重新开始');await this.prepare(snapshot);await this.navigate(snapshot);});this.identity.endAccountRequest(snapshot);
 }
 async adopt(data,snapshot){
  const p=this.pending;
  if(data.kind==='reauth'){
   if(p.action!=='reauth'||data.playerId!==snapshot.id||data.purpose!==p.purpose||data.authVersion!==this.identity.player?.account?.authVersion||!/^[A-Za-z0-9_-]{43}$/.test(data.reauthProof||'')||!Number.isSafeInteger(data.expiresAt))fail('bad_response','重新验证结果与当前账号不一致');
  }else{
   if(p.action==='reauth')fail('bad_response','授权返回了错误的操作结果');
   const same=data.player?.id===p.actorId,merge=p.action==='bind'&&p.actorKind==='guest'&&data.mergedFromPlayerId===p.actorId;
   if(p.actorId&&!same&&!merge)fail('different_account','授权返回了另一个账号，当前身份保持不变');
   await this.identity.applyAuthResult(data,snapshot,{expectedPlayerId:p.actorId&&!merge?p.actorId:null,beforeApply:this.beforeApply});
  }
  this.result=data;return data;
 }
 async finishRedirect(){
  const params=new URLSearchParams(this.location.hash.slice(1)),code=params.get('login'),message=params.get('login_error');
  if(!code&&!message)return null;
  if(!this.pending){if(this.unreadable||params.get('oauth')==='1')fail('oauth_storage_required','无法读取原页面的授权信息，请重新发起授权');return null;}
  if(message){this.history.replaceState(null,'',this.location.pathname+this.location.search);fail(params.get('login_error_code')||'oauth_failed',message);}
  if(this.pending.code&&this.pending.code!==code)fail('operation_conflict','回跳与原授权不一致，请先检查原结果');
  this.pending.code=code;this.save();this.history.replaceState(null,'',this.location.pathname+this.location.search);
  return this.exchange();
 }
 async exchange(){
  const p=this.pending;if(!p?.code)fail('bad_login_code','还没有收到授权回跳，请先完成 Linux.do 授权');
  const {result,snapshot}=await this.client.guarded(async snapshot=>{
   if(!await this.sourceMatches(snapshot)){
    // Result inspection handles a previously applied token; exchanging a fresh
    // code from an unrelated active identity is never allowed.
    fail('identity_changed','账号已变化，原授权不会覆盖当前账号');
   }
   return this.client.request('/api/auth/exchange',{method:'POST',token:p.action==='login'?undefined:snapshot.token,body:{...proof(p),clientNonce:p.clientNonce,code:p.code}});
  });try{return await this.adopt(result,snapshot);}finally{this.identity.endAccountRequest(snapshot);}
 }
 async inspect(){
  const p=this.pending;if(!p)fail('operation_expired','没有可检查的授权');
  const {result,snapshot}=await this.client.guarded(async snapshot=>{
   if(!p.operationTicket){if(!await this.sourceMatches(snapshot))fail('identity_changed','账号已变化');await this.prepare(snapshot);}
   return this.client.request('/api/auth/operations/result',{method:'POST',body:proof(p)});
  });
  try{
   if(result.kind==='pending'){if(p.code){this.identity.endAccountRequest(snapshot);return this.exchange();}return result;}
   const same=await this.sourceMatches(snapshot),applied=result.token&&result.token===snapshot.token&&result.player?.id===snapshot.id;
   if(!same&&!applied)fail('identity_changed','账号已变化，原授权不会覆盖当前账号');
   return await this.adopt(result,snapshot);
  }finally{this.identity.endAccountRequest(snapshot);}
 }
 async discard(){
  const p=this.pending;if(!p?.operationTicket){this.clear();return {kind:'cancelled'};}
  let received;try{received=await this.client.guarded(()=>this.client.request('/api/auth/operations/cancel',{method:'POST',body:proof(p)}));}
  catch(error){if(['operation_expired','operation_stale'].includes(error.code)){this.clear();return {kind:'expired'};}throw error;}
  const {result,snapshot}=received;
  try{if(result.kind==='completed'){
    const applied=result.result.token===snapshot.token&&result.result.player?.id===snapshot.id;
    if(!await this.sourceMatches(snapshot)&&!applied){this.clear();return {kind:'not_adopted'};}
    try{await this.adopt(result.result,snapshot);}catch(error){if(['different_account','identity_changed'].includes(error.code)){this.clear();return {kind:'not_adopted'};}throw error;}return result;
   }if(result.kind!=='cancelled')fail('bad_response','未能确认取消结果');this.clear();return result;
  }finally{this.identity.endAccountRequest(snapshot);}
 }
 clear(){try{this.storage?.removeItem(this.key);}catch{}const params=new URLSearchParams(this.location.hash.slice(1));if(params.has('login')||params.has('login_error'))this.history.replaceState(null,'',this.location.pathname+this.location.search);this.pending=null;this.unreadable=false;this.result=null;this.lastError=null;}
}
