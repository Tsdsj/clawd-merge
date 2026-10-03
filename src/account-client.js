import {newIntentId} from './auth-intent-id.js';
// Only operation proofs and account names are persisted here. Never passwords,
// recovery codes or reauthentication grants. The existing player store owns tokens.
export class AccountClientError extends Error {
  constructor(code,message){super(message);this.code=code;}
}
const error=(code,message)=>{throw new AccountClientError(code,message);};
const normalize=value=>typeof value==='string'?value.normalize('NFKC').trim().toLowerCase():'';
const fingerprint=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value||'')))].map(x=>x.toString(16).padStart(2,'0')).join('');
const secret=()=>{const bytes=crypto.getRandomValues(new Uint8Array(32));return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
const ACTIONS=['register','set_password','change_password','recover_password','rotate_recovery'];
const proof=intent=>({requestId:intent.requestId,retrySecret:intent.retrySecret,operationTicket:intent.operationTicket});
export class AccountClient {
  constructor({identity,request,storage=null,beforeApply=null}){
    this.identity=identity;this.request=request;this.storageSource=storage;this.beforeApply=beforeApply;
    this.key=identity.playerStorageKey+':account-intent';this.intent=null;this.intentDurable=false;this.intentError=false;this.generation=0;
    this.load();
  }
  get storage(){try{return typeof this.storageSource==='function'?this.storageSource():this.storageSource;}catch{return null;}}
  load(){
    try{const raw=this.storage?.getItem(this.key);if(!raw)return null;if(raw.length>16384)throw Error('invalid');const i=JSON.parse(raw);
      if(i.schemaVersion!==1||!ACTIONS.includes(i.action)||typeof i.requestId!=='string'||typeof i.retrySecret!=='string'||i.retrySecret.length!==43||typeof i.actorHash!=='string'||!i.fields||typeof i.fields!=='object')throw Error('invalid');
      this.intent=i;this.intentDurable=true;this.intentError=false;return i;
    }catch{this.intentError=true;return null;}
  }
  storedIntent(){try{return JSON.parse(this.storage?.getItem(this.key)||'null');}catch{return null;}}
  persist(intent){
    const existing=this.storedIntent();
    if(existing&&existing.requestId!==intent.requestId)error('identity_changed','其他页面已有新的账号操作，请重新打开账号面板');
    const data={schemaVersion:1,action:intent.action,fields:intent.fields,requestId:intent.requestId,retrySecret:intent.retrySecret,
      operationTicket:intent.operationTicket??null,expiresAt:intent.expiresAt??null,loginHandle:intent.loginHandle??null,
      actorId:intent.actorId,actorHash:intent.actorHash,submitted:Boolean(intent.submitted)};
    try{if(!this.storage)throw Error('unavailable');this.storage.setItem(this.key,JSON.stringify(data));this.intentDurable=true;}
    catch{const saved=this.storedIntent();this.intentDurable=Boolean(saved&&saved.requestId===intent.requestId&&saved.retrySecret===intent.retrySecret&&saved.operationTicket===intent.operationTicket&&saved.loginHandle===intent.loginHandle);}
    return this.intentDurable;
  }
  async guarded(work){
    const snapshot=this.identity.beginAccountRequest(),generation=this.generation;
    try{const result=await work(snapshot);if(generation!==this.generation||!this.identity.accountRequestCurrent(snapshot))error('identity_changed','账号已变化，请检查本次操作结果');return {result,snapshot};}
    catch(err){this.identity.endAccountRequest(snapshot);throw err;}
  }
  async prepare(action,fields={}){
    if(!ACTIONS.includes(action))error('bad_request','操作类型不正确');
    if(action==='register'&&this.identity.player)error('credentials_exist','请先退出当前账号；游客请使用设置密码入口');
    if(this.intentError)error('intent_unreadable','无法读取之前的账号操作记录，请先使用完整账号登录');
    const selected=['register','set_password'].includes(action)?{name:fields.name}:action==='recover_password'?{loginHandle:fields.loginHandle,...(fields.recoveryMethod?{recoveryMethod:fields.recoveryMethod}:{})}:{};
    if(this.intent&&(this.intent.action!==action||JSON.stringify(this.intent.fields)!==JSON.stringify(selected)))error('operation_in_progress','请先处理上一份账号操作，避免重复创建');
    if(!this.serverClock)await this.features();
    if(!this.serverClock)error('offline','暂时无法确认账号服务时间，请重新打开账号面板');
    const {result,snapshot}=await this.guarded(async snapshot=>{
      const hash=await fingerprint(snapshot.token);
      if(!this.intent){this.intent={schemaVersion:1,action,fields:selected,requestId:newIntentId(Math.floor(this.serverClock.now+performance.now()-this.serverClock.at-1000)),retrySecret:secret(),actorId:snapshot.id??null,actorHash:hash,submitted:false,loginHandle:this.identity.player?.account?.loginHandle||selected.loginHandle||null};this.persist(this.intent);}
      const i=this.intent;
      if(i.actorId!==(snapshot.id??null)||i.actorHash!==hash)error('identity_changed','账号已变化，请先处理原操作');
      const data=await this.request('/api/auth/operations',{method:'POST',token:action==='register'||(action==='recover_password'&&selected.recoveryMethod!=='linuxdo')?undefined:snapshot.token,body:{action,...selected,requestId:i.requestId,retrySecret:i.retrySecret}});
      if(!this.identity.accountRequestCurrent(snapshot))error('identity_changed','账号已变化，请重新打开账号面板');
      if(typeof data.operationTicket!=='string'||!Number.isSafeInteger(data.expiresAt))error('bad_response','未收到完整的账号操作信息');
      Object.assign(i,{operationTicket:data.operationTicket,expiresAt:data.expiresAt,loginHandle:data.loginHandle||i.loginHandle});this.persist(i);return i;
    });this.identity.endAccountRequest(snapshot);return result;
  }
  async commit(payload,{temporaryConfirmed=false}={}){
    const i=this.intent;if(!i?.operationTicket)error('operation_expired','请先确认完整账号');
    if(!this.intentDurable&&!temporaryConfirmed)error('storage_required','请先另行保存完整账号，再确认临时继续');
    const routes={register:'/api/auth/password/register',set_password:'/api/account/password',change_password:'/api/account/password',recover_password:'/api/auth/password/recover',rotate_recovery:'/api/account/recovery-code'};
    const {result,snapshot}=await this.guarded(async snapshot=>{
      if(i.actorId!==(snapshot.id??null)||i.actorHash!==await fingerprint(snapshot.token))error('identity_changed','账号已变化，请检查原操作结果');
      i.submitted=true;this.persist(i);
      const body={...proof(i),...payload};if(i.action==='set_password')body.operation='set';if(i.action==='change_password')body.operation='change';if(i.action==='recover_password'){if(i.fields.recoveryMethod==='linuxdo')body.operation='recover';else body.loginHandle=i.fields.loginHandle;}
      return this.request(i.action==='recover_password'&&i.fields.recoveryMethod==='linuxdo'?'/api/account/password':routes[i.action],{method:'POST',token:i.action==='register'||(i.action==='recover_password'&&i.fields.recoveryMethod!=='linuxdo')?undefined:snapshot.token,body});
    });
    try{await this.adopt(result,snapshot,i);return result;}finally{this.identity.endAccountRequest(snapshot);}
  }
  async adopt(result,snapshot,intent){
    if(['register','set_password','recover_password','rotate_recovery'].includes(intent?.action)&&!(/^[A-Za-z0-9_-]{43}$/.test(result.recoveryCode||'')))error('bad_response','没有收到完整恢复信息，请检查本次结果');
    if(result.kind==='authenticated'){
      const expected=['set_password','change_password','recover_password'].includes(intent?.action)?intent.actorId:null;
      if(intent?.action==='recover_password'&&normalize(result.account?.loginHandle)!==normalize(intent.fields.loginHandle))error('bad_response','返回的账号与恢复请求不一致');
      await this.identity.applyAuthResult(result,snapshot,{expectedPlayerId:expected,beforeApply:this.beforeApply});
    }else if(typeof result.recoveryCode!=='string')error('bad_response','尚未收到有效的恢复信息');
    this.lastResult=result;
  }
  async inspect(){
    const i=this.intent;if(!i)error('operation_expired','没有可恢复的操作');
    if(!i.operationTicket)await this.prepare(i.action,i.fields);
    const {result,snapshot}=await this.guarded(snapshot=>this.request('/api/auth/operations/result',{method:'POST',body:proof(i)}));
    try{
      if(result.kind==='pending')return result;
      const sameOrigin=i.actorId===(snapshot.id??null)&&i.actorHash===await fingerprint(snapshot.token);
      const alreadyApplied=result.token&&result.token===snapshot.token&&result.player?.id===snapshot.id;
      if(!sameOrigin&&snapshot.id&&!alreadyApplied)error('identity_changed','当前已是另一个登录状态，请保留当前账号并重新登录原账号');
      if(!this.identity.accountRequestCurrent(snapshot))error('identity_changed','账号已变化');
      await this.adopt(result,snapshot,i);return result;
    }finally{this.identity.endAccountRequest(snapshot);}
  }
  async cancelPending(){
    const i=this.intent;if(!i)return {kind:'cancelled'};if(!i.operationTicket)await this.prepare(i.action,i.fields);
    const {result,snapshot}=await this.guarded(()=>this.request('/api/auth/operations/cancel',{method:'POST',body:proof(i)}));
    try{if(result.kind==='completed'){if(snapshot.id&&i.actorId!==snapshot.id)error('identity_changed','原操作已经完成，请用完整账号登录');await this.adopt(result.result,snapshot,i);return result;}
      if(result.kind!=='cancelled')error('bad_response','未确认取消结果');this.clear();return result;
    }finally{this.identity.endAccountRequest(snapshot);}
  }
  async login(loginHandle,password){
    const {result,snapshot}=await this.guarded(()=>this.request('/api/auth/password/login',{method:'POST',body:{loginHandle,password}}));
    try{if(normalize(result.account?.loginHandle)!==normalize(loginHandle))error('bad_response','返回的账号与登录请求不一致');if(snapshot.id&&result.player?.id!==snapshot.id)error('different_account','这是另一个账号，请先退出当前账号再登录');await this.identity.applyAuthResult(result,snapshot,{expectedPlayerId:snapshot.id||null,beforeApply:this.beforeApply});return result;}
    finally{this.identity.endAccountRequest(snapshot);}
  }
  async profile(){
    const {result,snapshot}=await this.guarded(snapshot=>this.request('/api/me',{token:snapshot.token}));
    try{if(result.player?.id!==snapshot.id||!this.identity.accountRequestCurrent(snapshot))error('identity_changed','账号已变化，请刷新后检查原身份');
      this.identity.save({...result.player,...(result.account?{account:result.account}:{}),...(result.capabilities?{capabilities:result.capabilities}:{}),sessionExpiresAt:result.sessionExpiresAt},snapshot.token);return result;
    }finally{this.identity.endAccountRequest(snapshot);}
  }
  async reauth(password,purpose){
    const {result,snapshot}=await this.guarded(snapshot=>this.request('/api/account/reauth',{method:'POST',token:snapshot.token,body:{password,purpose}}));this.identity.endAccountRequest(snapshot);return result;
  }
  async features(){try{const result=await this.request('/api/auth/capabilities');if(Number.isSafeInteger(result.serverNow))this.serverClock={now:result.serverNow,at:performance.now()};if(!globalThis.crypto?.subtle||!crypto.randomUUID){result.passwordEnabled=false;result.registrationEnabled=false;result.oauthAccountActions=false;}return result;}catch{return {passwordEnabled:false,registrationEnabled:false,linuxdoEnabled:true};}}
  cancel(){this.generation++;this.identity.cancelIdentityRequests();}
  clear(){const id=this.intent?.requestId;try{const stored=this.storedIntent();if(!stored||stored.requestId===id)this.storage?.removeItem(this.key);}catch{}this.intent=null;this.intentDurable=false;this.intentError=false;this.lastResult=null;}
}
