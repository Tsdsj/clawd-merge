// Self-hosted Node service. Native scrypt stays outside short SQLite transactions.
// All response receipt encryption/HMAC operations below are synchronous native crypto.
import {randomBytes,randomUUID,createHash,createHmac,createCipheriv,createDecipheriv,timingSafeEqual} from 'node:crypto';
import {intentTime} from '../src/auth-intent-id.js';
import {checkName,loginHandleKey,NAME_POLICY_VERSION} from '../leaderboard/src/name-policy.js';
import {AUTH_QUERY,sessionCurrent,accountState} from '../leaderboard/src/account-state.js';
import {oauthAccountRoute} from './oauth-account.mjs';
const HOUR=3600000,SESSION_TTL=30*24*HOUR,OP_TTL=10*60000,GRANT_TTL=5*60000;
const random=()=>randomBytes(32).toString('base64url');
const sha=value=>createHash('sha256').update(value).digest('hex');
const mac=(key,value)=>createHmac('sha256',key).update(value).digest('hex');
const same=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const secret=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value)&&Buffer.from(value,'base64url').length===32&&Buffer.from(value,'base64url').toString('base64url')===value;
const passwordValid=value=>typeof value==='string'&&[...value].length>=15&&[...value].length<=128&&!/[\p{Cs}]/u.test(value);
const bearer=request=>{const value=request.headers.get('Authorization')||'';return value.startsWith('Bearer ')?value.slice(7).trim():null;};
const actions=new Set(['register','set_password','change_password','recover_password','rotate_recovery','exchange_login']);

function parseKeyring(input) {
  try {
    if(!input||!secret(input.rate)||!input.versions||!Object.hasOwn(input.versions,input.current))return null;
    const versions=new Map(),seen=new Set([input.rate]);
    for(const [id,value]of Object.entries(input.versions)){
      if(!/^[A-Za-z0-9_-]{1,24}$/.test(id)||!value)return null;
      const keys={};for(const purpose of ['ticket','receipt','payload']){const v=value[purpose];if(!secret(v)||seen.has(v))return null;seen.add(v);keys[purpose]=Buffer.from(v,'base64url');}
      versions.set(id,keys);
    }
    if(versions.size>4)return null;
    return {current:input.current,rate:Buffer.from(input.rate,'base64url'),versions};
  }catch{return null;}
}

async function bodyOf(request,fail) {
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')||''))fail(400,'bad_request','请使用 JSON 请求');
  const reader=request.body?.getReader();let size=0;const chunks=[];
  if(reader){try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>8192){await reader.cancel();fail(400,'bad_request','请求内容过长');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}}
  let text,body;
  try {text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));body=JSON.parse(text);}catch{fail(400,'bad_request','请求格式不正确');}
  if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'bad_request','请求格式不正确');
  // Fields are flat primitives. Detect escaped duplicates before JSON.parse can hide them.
  const names=new Set();let depth=0,expectKey=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];if(c==='"'){let end=i+1;for(;end<text.length;end++){if(text[end]==='\\'){end++;continue;}if(text[end]==='"')break;}
      if(depth===1&&expectKey){const key=JSON.parse(text.slice(i,end+1));if(names.has(key))fail(400,'bad_request','请求字段重复');names.add(key);expectKey=false;}i=end;continue;}
    if(c==='{'||c==='['){depth++;if(depth===1)expectKey=true;}else if(c==='}'||c===']')depth--;else if(c===','&&depth===1)expectKey=true;
  }
  return body;
}

export function createPasswordAuth({DB,keyring,kdf,enabled=false,registrationEnabled=true,bindingEnabled=true}) {
 const ring=parseKeyring(keyring),available=Boolean(enabled&&ring&&typeof kdf==='function'&&typeof DB.transaction==='function');
 const dummySalt=Buffer.alloc(16,79).toString('base64url');
 return {available,registrationEnabled:Boolean(available&&registrationEnabled),bindingEnabled:Boolean(available&&bindingEnabled),async handle(request,env,h){
  const fail=(status,code,message)=>{throw new h.ApiError(status,code,message);};
  const invalid=()=>fail(401,'invalid_credentials','账号或凭据不正确，请检查后再试');
  const enrollmentGate=action=>{if(['register','set_password'].includes(action)&&!registrationEnabled)fail(503,'registration_disabled','新注册和设置密码暂时关闭；已有账号仍可登录和找回');};
  if(!available)fail(503,'password_auth_disabled','密码服务暂不可用，请稍后再试');
  const path=new URL(request.url).pathname;
  const body=request.method==='GET'?{}:await bodyOf(request,fail),now=()=>Date.now(),ip=request.headers.get('CF-Connecting-IP')||'unknown';
  const json=(value,status=200)=>h.json(value,status,{'Cache-Control':'no-store'});
  const raw=DB.raw,tx=fn=>DB.transaction(fn),readOp=id=>raw.prepare('SELECT * FROM auth_operations WHERE request_id=?').get(id);
  const requireString=(value)=>{if(typeof value!=='string')fail(400,'bad_request','请求字段不正确');return value;};
  const requirePassword=value=>{if(!passwordValid(value))fail(400,'bad_password','密码需为 15—128 个字符，且不能包含无效字符');return value;};
  const token=bearer(request),tokenHash=token?sha(token):null;
  function actor(db=raw,required=true){const p=tokenHash?db.prepare(AUTH_QUERY).get(tokenHash):null;if(!sessionCurrent(p,now())){if(required)fail(401,'unauthorized','登录已失效，请重新登录');return null;}return {...p,tokenHash};}
  function rate(db,key,limit,windowMs){
    const start=now(),old=db.prepare('SELECT * FROM rate_limits WHERE key=?').get(key);
    if(old&&old.window_start>start-windowMs&&old.count>=limit){const err=new h.ApiError(429,'rate_limited','尝试过于频繁，请稍后再试');err.retryAfter=Math.max(1,Math.ceil((old.window_start+windowMs-start)/1000));throw err;}
    db.prepare(`INSERT INTO rate_limits(key,window_start,count) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET
      window_start=CASE WHEN rate_limits.window_start<=? THEN excluded.window_start ELSE rate_limits.window_start END,
      count=CASE WHEN rate_limits.window_start<=? THEN 1 ELSE rate_limits.count+1 END`).run(key,start,start-windowMs,start-windowMs);
  }
  const accountBucket=handle=>mac(ring.rate,handle);
  const verificationRate=handle=>tx(db=>{rate(db,'password-ip:'+mac(ring.rate,ip),30,15*60000);rate(db,'password-account:'+accountBucket(handle),10,15*60000);});
  async function derive(password,salt){try{return await kdf(password,salt);}catch(error){if(error.code==='auth_busy'){const e=new h.ApiError(503,'auth_busy','正在处理其他登录，请稍后重试');e.retryAfter=1;throw e;}fail(503,'password_auth_disabled','密码服务暂不可用，请稍后再试');}}
  function credential(db,handle){return db.prepare(`SELECT c.*,p.auth_version FROM password_credentials c JOIN players p ON p.id=c.player_id WHERE c.login_handle_key=?`).get(handle);}
  const supportedCredential=c=>c?.algorithm==='scrypt'&&c.params_version===1;
  function currentCredential(db,old){const c=credential(db,old.login_handle_key);return c&&c.player_id===old.player_id&&c.auth_version===old.auth_version&&c.algorithm===old.algorithm&&c.params_version===old.params_version&&c.derived_key===old.derived_key&&c.salt===old.salt;}
  function view(db,id){const p=db.prepare(`SELECT p.*, c.player_id AS credential_player_id,c.login_handle FROM players p LEFT JOIN password_credentials c ON c.player_id=p.id WHERE p.id=?`).get(id);if(!p)fail(409,'identity_changed','账号已变化，请重新登录');const recovery=db.prepare('SELECT 1 FROM recovery_codes WHERE player_id=?').get(id);return {kind:'authenticated',player:h.publicPlayer(p),...accountState(p,recovery,{passwordEnabled:available,registrationEnabled:available&&registrationEnabled,bindingEnabled:bindingEnabled&&env.ACCOUNT_BINDING_ENABLED!=='0',linuxdoEnabled:Boolean(env.LINUXDO_CLIENT_ID&&env.LINUXDO_CLIENT_SECRET),namingEnabled:Boolean(NAME_POLICY_VERSION)})};}
  function issueToken(db,id,method){const p=db.prepare('SELECT auth_version FROM players WHERE id=?').get(id);const value=random(),expiresAt=now()+SESSION_TTL;db.prepare('INSERT INTO tokens(token_hash,player_id,created_at,auth_method,auth_version,authenticated_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(sha(value),id,now(),method,p.auth_version,now(),expiresAt);const data=view(db,id);delete data.sessionExpiresAt;return {...data,token:value,expiresAt};}
  function recoveryCode(db,id){const code=random();db.prepare('INSERT INTO recovery_codes(player_id,code_hash,version,created_at) VALUES(?,?,1,?) ON CONFLICT(player_id) DO UPDATE SET code_hash=excluded.code_hash,version=recovery_codes.version+1,created_at=excluded.created_at').run(id,sha(code),now());return code;}
  function revoke(db,id){db.prepare('UPDATE players SET auth_version=auth_version+1 WHERE id=?').run(id);db.prepare('DELETE FROM tokens WHERE player_id=?').run(id);db.prepare('DELETE FROM reauth_grants WHERE player_id=?').run(id);db.prepare("UPDATE auth_operations SET status='stale' WHERE actor_player_id=? AND status!='complete'").run(id);db.prepare('DELETE FROM oauth_states WHERE source_player_id=? OR merge_player_id=?').run(id,id);db.prepare('DELETE FROM login_codes WHERE player_id=?').run(id);}
  function fullHandle(value){const handle=loginHandleKey(value);if(!handle)fail(400,'login_handle_required','请输入包含 # 和四位编号的完整账号');return handle;}
  function freeTag(db,name,preferred,login,ownerId){
    const prefix=name.toLowerCase()+'#',end=name.toLowerCase()+'$';
    const used=new Set();
    const queries=login?['SELECT login_handle_key AS key FROM password_credentials WHERE login_handle_key>=? AND login_handle_key<?','SELECT login_handle_key AS key FROM login_handle_reservations WHERE login_handle_key>=? AND login_handle_key<? AND expires_at>?']:['SELECT name_key AS key FROM players WHERE name_key>=? AND name_key<? AND id!=?'];
    for(const [i,q]of queries.entries()){const args=login?(i?[prefix,end,now()]:[prefix,end]):[prefix,end,ownerId||''];for(const row of db.prepare(q).all(...args))used.add(row.key);}
    const first=/^\d{4}$/.test(preferred||'')?Number(preferred):randomBytes(2).readUInt16BE()%10000;
    for(let offset=0;offset<10000;offset++){const tag=String((first+offset)%10000).padStart(4,'0');if(!used.has(prefix+tag))return tag;}
    fail(409,'name_crowded','这个名字的编号已用完，请换一个名字');
  }
  function ticketFor(op){const payload=Buffer.from(JSON.stringify({requestId:op.request_id,action:op.action,actor:op.actor_scope,tokenHash:op.actor_token_hash,authVersion:op.actor_auth_version,retryHash:op.retry_secret_hash,expiresAt:op.expires_at})).toString('base64url');const prefix=op.key_version+'.'+payload;return prefix+'.'+mac(ring.versions.get(op.key_version).ticket,prefix);}
  function proof(){
    if(!uuid(body.requestId)||!secret(body.retrySecret)||typeof body.operationTicket!=='string'||body.operationTicket.length>4096)fail(400,'bad_request','操作凭据不完整');
    const parts=body.operationTicket.split('.'),key=ring.versions.get(parts[0]);if(parts.length===3&&!key)fail(410,'operation_expired','这次操作已过期，请使用完整账号登录或恢复');if(parts.length!==3||!key||!same(mac(key.ticket,parts[0]+'.'+parts[1]),parts[2]))fail(409,'operation_conflict','操作凭据不匹配，请重新开始');
    let claim;try{claim=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));}catch{fail(409,'operation_conflict','操作凭据不匹配');}
    if(!Number.isSafeInteger(claim.expiresAt)||claim.expiresAt<=now())fail(410,'operation_expired','这次操作已过期，请使用完整账号登录或恢复');
    const op=readOp(body.requestId);
    if(!op)fail(410,'operation_expired','这次操作已过期，请使用完整账号登录或恢复');
    if(op.operation_ticket!==body.operationTicket||op.request_id!==claim.requestId||!same(op.retry_secret_hash,sha(body.retrySecret))||op.expires_at!==claim.expiresAt)fail(409,'operation_conflict','操作凭据不匹配');
    return op;
  }
  const aad=op=>Buffer.from(JSON.stringify([op.request_id,op.actor_scope,op.action,op.result_player_id,op.result_auth_version,op.result_token_hash,op.result_resource_version]));
  function resultOf(db,op){
    if(op.status==='stale')fail(409,'operation_stale','这次操作的结果已失效，请重新登录');
    if(op.status!=='complete')return null;
    const p=db.prepare('SELECT auth_version FROM players WHERE id=?').get(op.result_player_id),t=db.prepare('SELECT auth_version,expires_at FROM tokens WHERE token_hash=? AND player_id=?').get(op.result_token_hash,op.result_player_id);
    const recovery=op.result_resource_version==null?null:db.prepare('SELECT version FROM recovery_codes WHERE player_id=?').get(op.result_player_id);
    if(!p||p.auth_version!==op.result_auth_version||!t||t.auth_version!==p.auth_version||(t.expires_at!==null&&t.expires_at<=now())||(op.result_resource_version!=null&&recovery?.version!==op.result_resource_version))fail(409,'operation_stale','这次操作的结果已失效，请重新登录');
    try{const packed=Buffer.from(op.response_ciphertext,'base64url'),dec=createDecipheriv('aes-256-gcm',ring.versions.get(op.key_version).receipt,Buffer.from(op.nonce,'base64url'));dec.setAAD(aad(op));dec.setAuthTag(packed.subarray(0,16));const response=JSON.parse(Buffer.concat([dec.update(packed.subarray(16)),dec.final()]).toString('utf8'));if(response.kind==='reauth'){const g=db.prepare('SELECT * FROM reauth_grants WHERE grant_hash=?').get(sha(response.reauthProof));if(!g||g.expires_at<=now()||g.token_hash!==op.result_token_hash||g.player_id!==op.result_player_id||g.purpose!==response.purpose)throw Error('stale grant');}if(response.player){const fresh=view(db,op.result_player_id);response.player=fresh.player;response.account=fresh.account;response.capabilities=fresh.capabilities;}return response;}catch{fail(409,'operation_stale','这次操作的结果已失效，请重新登录');}
  }
  function complete(db,op,data,status){
    const id=data.player?.id||op.actor_player_id,p=db.prepare('SELECT auth_version FROM players WHERE id=?').get(id);
    const next={...op,result_player_id:id,result_auth_version:p.auth_version,result_token_hash:data.token?sha(data.token):op.actor_token_hash,result_resource_version:data.recoveryCode?db.prepare('SELECT version FROM recovery_codes WHERE player_id=?').get(id).version:null};
    const nonce=randomBytes(12),enc=createCipheriv('aes-256-gcm',ring.versions.get(op.key_version).receipt,nonce);enc.setAAD(aad(next));const bytes=Buffer.concat([enc.update(JSON.stringify(data),'utf8'),enc.final()]);const cipher=Buffer.concat([enc.getAuthTag(),bytes]).toString('base64url');
    db.prepare("UPDATE auth_operations SET status='complete',response_ciphertext=?,nonce=?,result_player_id=?,result_auth_version=?,result_token_hash=?,result_resource_version=?,result_status=? WHERE request_id=?").run(cipher,nonce.toString('base64url'),id,next.result_auth_version,next.result_token_hash,next.result_resource_version,status,op.request_id);
    return {data,status};
  }
  function actorOf(db,op){
    if(!op.actor_player_id)return null;
    const p=db.prepare(AUTH_QUERY).get(op.actor_token_hash);
    if(!sessionCurrent(p,now())||p.id!==op.actor_player_id||p.auth_version!==op.actor_auth_version||tokenHash!==op.actor_token_hash)fail(409,'identity_changed','账号已变化，请重新登录后再试');
    return p;
  }
  function grant(db,op,purpose,consume=false){if(!secret(body.reauthProof))fail(403,'reauth_required','请先重新验证当前账号');const row=db.prepare('SELECT * FROM reauth_grants WHERE grant_hash=?').get(sha(body.reauthProof));if(!row||row.player_id!==op.actor_player_id||row.token_hash!==op.actor_token_hash||row.auth_version!==op.actor_auth_version||row.purpose!==purpose||row.expires_at<=now())fail(403,'invalid_reauth','验证已失效，请重新验证');if(consume)db.prepare('DELETE FROM reauth_grants WHERE grant_hash=?').run(row.grant_hash);}
  if(['/api/auth/linuxdo/start','/api/auth/linuxdo/callback','/api/auth/exchange'].includes(path))return oauthAccountRoute({request,env,h,path,body,DB,raw,tx,ring,now,ip,fail,json,actor,actorOf,proof,resultOf,complete,issueToken,grant,rate,readOp,sha,mac,same,secret,random,revoke,bindingEnabled});
  const proofFields=['requestId','retrySecret','operationTicket'];
  const fields={
    '/api/auth/operations':['action','requestId','retrySecret',...(['register','set_password'].includes(body.action)?['name']:body.action==='recover_password'?['loginHandle','recoveryMethod']:body.action==='exchange_login'?['oauthAction','purpose','clientNonce']:[])],
    '/api/auth/operations/result':proofFields,
    '/api/auth/operations/cancel':proofFields,
    '/api/auth/password/login':['loginHandle','password'],
    '/api/account/reauth':['password','purpose'],
    '/api/auth/password/register':[...proofFields,'password'],
    '/api/auth/password/recover':[...proofFields,'loginHandle','recoveryCode','newPassword'],
    '/api/account/recovery-code':[...proofFields,'reauthProof'],
    '/api/account/password':[...proofFields,'operation',...(body.operation==='set'?['password','reauthProof']:body.operation==='change'?['oldPassword','newPassword']:body.operation==='recover'?['newPassword','reauthProof']:[])],
  }[path];
  if(!fields||Object.keys(body).some(key=>!fields.includes(key)))fail(400,'bad_request','请求字段不正确');

  if(path==='/api/auth/operations'){
    if(!actions.has(body.action)||intentTime(body.requestId)===null||!secret(body.retrySecret))fail(400,'bad_request','操作标识无效，请重新打开账号面板');
    const issuedAt=intentTime(body.requestId);
    if(issuedAt>now())fail(400,'bad_request','时间暂不同步，请重新打开账号面板再试');
    if(issuedAt+OP_TTL<=now())fail(410,'operation_expired','这次操作已过期，请使用完整账号登录或恢复');
    let name=null,handle=null;
    if(['register','set_password'].includes(body.action)){const check=checkName(body.name,{blockedWords:env.BLOCKED_WORDS});if(!check.ok)fail(check.status,check.error,'名字格式不符合要求或暂不可用，请换一个名字');name=check.name;}
    if(body.action==='recover_password')handle=fullHandle(body.loginHandle);
    const oauth=body.action==='exchange_login',oauthRecovery=body.action==='recover_password'&&body.recoveryMethod==='linuxdo';
    if(body.action==='recover_password'&&body.recoveryMethod!==undefined&&!oauthRecovery)fail(400,'bad_request','恢复方式不正确');
    if(oauth&&(!env.LINUXDO_CLIENT_ID||!env.LINUXDO_CLIENT_SECRET))fail(503,'login_disabled','LINUX DO 登录还没配置好');
    if(oauth&&(!['login','bind','reauth'].includes(body.oauthAction)||!secret(body.clientNonce)||(body.oauthAction==='reauth'?!['set_password','rotate_recovery','recover_password'].includes(body.purpose):body.purpose!==undefined)))fail(400,'bad_request','授权用途不正确');
    const prep=JSON.stringify(oauth?[body.action,body.oauthAction,body.purpose||null,sha(body.clientNonce)]:oauthRecovery?[body.action,'linuxdo',handle]:[body.action,name,handle]);
    const value=tx(db=>{
      const old=db.prepare('SELECT * FROM auth_operations WHERE request_id=?').get(body.requestId);
      if(old){if(old.expires_at<=now())fail(410,'operation_expired','操作已过期，请重新开始');const key=ring.versions.get(old.key_version);if(!key||old.action!==body.action||!same(old.retry_secret_hash,sha(body.retrySecret))||old.actor_token_hash!==tokenHash||!same(old.preparation_hmac,mac(key.payload,prep)))fail(409,'operation_conflict','这个操作记录已用于其他请求');if(old.status==='stale')fail(409,'operation_stale','操作已失效');return {operationTicket:old.operation_ticket,expiresAt:old.expires_at,...(old.login_handle?{loginHandle:old.login_handle}:{})};}
      enrollmentGate(body.action);
      if(oauth&&body.oauthAction==='bind'&&(!bindingEnabled||env.ACCOUNT_BINDING_ENABLED==='0'))fail(503,'binding_disabled','新绑定暂时关闭；已有登录方式仍可使用');
      const p=(body.action==='register'||(body.action==='recover_password'&&!oauthRecovery)||(oauth&&body.oauthAction==='login'))?null:actor(db);
      if(oauthRecovery&&(!p.credential_player_id||p.linuxdo_id==null||loginHandleKey(p.login_handle)!==handle))fail(403,'reauth_required','请先登录已绑定的账号再验证恢复');
      if(oauth&&body.oauthAction==='login'&&tokenHash)fail(409,'identity_changed','请先退出当前账号再登录其他账号');
      if(oauth&&body.oauthAction==='reauth'&&(p.linuxdo_id==null||(body.purpose==='set_password'&&p.credential_player_id)||(body.purpose==='recover_password'&&!p.credential_player_id)))fail(403,'reauth_required','当前账号不支持这项验证');
      if(body.action==='register'&&tokenHash)fail(409,'identity_changed','请先退出当前账号，或为当前游客设置密码');
      if(body.action==='recover_password'&&!oauthRecovery&&tokenHash)fail(409,'identity_changed','请先退出当前账号再找回账号');
      if(body.action==='set_password'&&p.credential_player_id)fail(409,'credentials_exist','当前账号已有密码');
      if(body.action==='change_password'&&!p.credential_player_id)fail(403,'reauth_required','当前账号尚未设置密码');
      if(body.action==='rotate_recovery'&&!p.credential_player_id&&p.linuxdo_id==null)fail(403,'reauth_required','请先创建正式账号');
      if(body.action==='register')rate(db,'register:'+ip,5,HOUR);
      if(body.action==='recover_password'){rate(db,'recovery-ip:'+mac(ring.rate,ip),10,HOUR);rate(db,'recovery-account:'+accountBucket(handle),5,HOUR);}
      if(oauth)rate(db,'login:'+ip,30,HOUR);
      else if(p)rate(db,'password-mutation:'+p.id,5,HOUR);
      const op={request_id:body.requestId,actor_scope:p?'player:'+p.id:'anonymous',action:body.action,retry_secret_hash:sha(body.retrySecret),key_version:ring.current,created_at:now(),expires_at:issuedAt+OP_TTL,actor_player_id:p?.id??null,actor_token_hash:p?tokenHash:null,actor_auth_version:p?.auth_version??null,login_name:name,login_handle:handle,login_handle_key:handle};
      if(name){const tag=freeTag(db,name,p?.tag,true,p?.id);op.login_handle=name+'#'+tag;op.login_handle_key=loginHandleKey(op.login_handle);}
      op.operation_ticket=ticketFor(op);
      db.prepare(`INSERT INTO auth_operations(request_id,actor_scope,action,retry_secret_hash,created_at,expires_at,key_version,preparation_hmac,operation_ticket,actor_player_id,actor_token_hash,actor_auth_version,login_name,login_handle,login_handle_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(op.request_id,op.actor_scope,op.action,op.retry_secret_hash,op.created_at,op.expires_at,op.key_version,mac(ring.versions.get(op.key_version).payload,prep),op.operation_ticket,op.actor_player_id,op.actor_token_hash,op.actor_auth_version,op.login_name,op.login_handle,op.login_handle_key);
      if(oauthRecovery)db.prepare("UPDATE auth_operations SET recovery_method='linuxdo' WHERE request_id=?").run(op.request_id);
      if(oauth)db.prepare('UPDATE auth_operations SET oauth_action=?,oauth_purpose=?,client_nonce_hash=? WHERE request_id=?').run(body.oauthAction,body.purpose||null,sha(body.clientNonce),op.request_id);
      if(name){db.prepare('DELETE FROM login_handle_reservations WHERE login_handle_key=? AND expires_at<=?').run(op.login_handle_key,now());db.prepare('INSERT INTO login_handle_reservations VALUES(?,?,?,?)').run(op.request_id,op.login_handle,op.login_handle_key,op.expires_at);}
      return {operationTicket:op.operation_ticket,expiresAt:op.expires_at,...(op.login_handle?{loginHandle:op.login_handle}:{})};
    });return json(value);
  }
  if(path==='/api/auth/operations/cancel'){
    const op=proof();const result=tx(db=>{const current=db.prepare('SELECT * FROM auth_operations WHERE request_id=?').get(op.request_id);
      if(current.status==='complete')return {kind:'completed',result:resultOf(db,current)};
      db.prepare("UPDATE auth_operations SET status='stale' WHERE request_id=?").run(op.request_id);
      db.prepare('DELETE FROM login_handle_reservations WHERE operation_id=?').run(op.request_id);
      return {kind:'cancelled'};
    });return json(result);
  }
  if(path==='/api/auth/operations/result'){const op=proof(),result=resultOf(raw,op);return json(result||{kind:'pending',expiresAt:op.expires_at},result?200:202);}
  if(path==='/api/auth/password/login'||path==='/api/account/reauth'){
    const reauth=path==='/api/account/reauth',p=reauth?actor():null,handle=reauth?(p.login_handle?loginHandleKey(p.login_handle):null):fullHandle(body.loginHandle);
    if(!handle)invalid();requirePassword(body.password);
    if(reauth&&!['bind_linuxdo','change_password','rotate_recovery'].includes(body.purpose))fail(400,'bad_request','验证用途不正确');
    verificationRate(handle);const saved=credential(raw,handle);const derived=await derive(body.password,saved?.salt||dummySalt);
    if(!supportedCredential(saved)||!same(saved.derived_key,derived))invalid();
    const result=tx(db=>{if(!currentCredential(db,saved))invalid();if(reauth){const current=actor(db);if(current.id!==p.id||current.auth_version!==p.auth_version)invalid();const value=random();db.prepare('INSERT INTO reauth_grants VALUES(?,?,?,?,?,?)').run(sha(value),p.id,tokenHash,p.auth_version,body.purpose,now()+GRANT_TTL);return {kind:'reauth',reauthProof:value,expiresAt:now()+GRANT_TTL};}return issueToken(db,saved.player_id,'password');});return json(result);
  }
  const op=proof();let action;
  if(path==='/api/auth/password/register')action='register';
  else if(path==='/api/account/recovery-code')action='rotate_recovery';
  else if(path==='/api/auth/password/recover')action='recover_password';
  else if(path==='/api/account/password')action={set:'set_password',change:'change_password',recover:'recover_password'}[body.operation];
  if(!action||op.action!==action)fail(409,'operation_conflict','操作类型不匹配');
  let payload;
  if(['register','set_password'].includes(action)){requirePassword(body.password);payload=[action,body.password,body.reauthProof??null];}
  else if(action==='change_password'){requirePassword(body.oldPassword);requirePassword(body.newPassword);payload=[action,body.oldPassword,body.newPassword];}
  else if(action==='recover_password'){requirePassword(body.newPassword);if(path==='/api/account/password'){if(op.recovery_method!=='linuxdo')fail(403,'reauth_required','请通过已绑定的 Linux.do 重新验证');if(!secret(body.reauthProof))fail(403,'reauth_required','请通过已绑定的 Linux.do 重新验证');payload=[action,'linuxdo',body.reauthProof,body.newPassword];}else{if(op.recovery_method==='linuxdo')fail(409,'operation_conflict','恢复方式不匹配');fullHandle(body.loginHandle);if(!secret(body.recoveryCode))invalid();payload=[action,fullHandle(body.loginHandle),body.recoveryCode,body.newPassword];}}
  else payload=[action,body.reauthProof??null];
  const digest=mac(ring.versions.get(op.key_version).payload,JSON.stringify(payload));
  const cached=tx(db=>{const current=db.prepare('SELECT * FROM auth_operations WHERE request_id=?').get(op.request_id);if(current.payload_hmac&&!same(current.payload_hmac,digest))fail(409,'operation_conflict','这次操作的内容已变化，请重新开始');const ready=resultOf(db,current);if(ready)return {data:ready,status:current.result_status};actorOf(db,current);enrollmentGate(action);db.prepare('UPDATE auth_operations SET payload_hmac=? WHERE request_id=?').run(digest,current.request_id);return null;});if(cached)return json(cached.data,cached.status);
  const recheckName=()=>{if(['register','set_password'].includes(action)){const policy=checkName(op.login_name,{blockedWords:env.BLOCKED_WORDS});if(!policy.ok)fail(policy.status,policy.error,'名字已不符合当前规则，请取消这次登记后重新选择名字');}};
  recheckName();
  let saved=null,rec=null,salt=null,derived=null;
  if(action==='change_password'){
    const p=actorOf(raw,op);saved=credential(raw,loginHandleKey(p.login_handle));if(!supportedCredential(saved))invalid();verificationRate(saved.login_handle_key);const value=await derive(body.oldPassword,saved.salt);if(!same(value,saved.derived_key))invalid();
  }
  if(action==='recover_password'){
    if(op.recovery_method==='linuxdo'){const p=actorOf(raw,op);if(p.linuxdo_id==null||!p.credential_player_id)fail(403,'reauth_required','请重新验证当前账号');saved=credential(raw,op.login_handle_key);grant(raw,op,'recover_password');}
    else {if(fullHandle(body.loginHandle)!==op.login_handle_key)fail(409,'operation_conflict','账号与恢复操作不匹配');
    saved=credential(raw,op.login_handle_key);rec=saved?raw.prepare('SELECT * FROM recovery_codes WHERE player_id=?').get(saved.player_id):null;if(!saved||!rec||!same(rec.code_hash,sha(body.recoveryCode)))invalid();}
  }
  if(action==='set_password'){const p=actorOf(raw,op);if(p.credential_player_id)fail(409,'credentials_exist','当前账号已有密码');if(p.linuxdo_id!=null)grant(raw,op,'set_password');}
  if(action==='rotate_recovery')grant(raw,op,'rotate_recovery');
  else{salt=randomBytes(16).toString('base64url');derived=await derive(['register','set_password'].includes(action)?body.password:body.newPassword,salt);}
  const completed=tx(db=>{
    const current=db.prepare('SELECT * FROM auth_operations WHERE request_id=?').get(op.request_id);if(current.expires_at<=now())fail(410,'operation_expired','操作已过期，请重新开始');const ready=resultOf(db,current);if(ready)return {data:ready,status:current.result_status};
    if(!same(current.payload_hmac,digest))fail(409,'operation_conflict','操作内容不匹配');enrollmentGate(action);recheckName();let p=actorOf(db,current),id=p?.id;
    if(['change_password','recover_password'].includes(action)){if(!currentCredential(db,saved))fail(409,'operation_stale','账号凭据已变化，请重新登录');id=saved.player_id;}
    if(action==='recover_password'&&current.recovery_method==='linuxdo')grant(db,current,'recover_password',true);
    if(action==='recover_password'&&current.recovery_method!=='linuxdo'){const latest=db.prepare('SELECT * FROM recovery_codes WHERE player_id=?').get(id);if(!latest||latest.version!==rec.version||!same(latest.code_hash,rec.code_hash))fail(409,'operation_stale','恢复码已变化，请使用新的恢复方式');}
    if(action==='rotate_recovery'){grant(db,current,'rotate_recovery',true);const code=recoveryCode(db,id);return complete(db,current,{recoveryCode:code,createdAt:now()},200);}
    if(action==='register'||action==='set_password'){
      const reservation=db.prepare('SELECT * FROM login_handle_reservations WHERE operation_id=?').get(current.request_id);if(!reservation||reservation.expires_at<=now())fail(410,'operation_expired','账号预留已过期，请重新开始');
      if(p?.credential_player_id)fail(409,'credentials_exist','当前账号已有密码');if(p?.linuxdo_id!=null)grant(db,current,'set_password',true);
      const tag=freeTag(db,current.login_name,current.login_handle.slice(-4),false,id);const nameKey=current.login_name.toLowerCase()+'#'+tag;
      if(action==='register'){id=randomUUID();db.prepare(`INSERT INTO players(id,name,name_key,tag,token_hash,created_at,display_name_source,name_policy_version,name_policy_status) VALUES(?,?,?,?,?,?,'local',?,'allowed')`).run(id,current.login_name,nameKey,tag,sha(random()),now(),NAME_POLICY_VERSION);}
      else db.prepare("UPDATE players SET name=?,name_key=?,tag=?,display_name_source='local',name_policy_version=?,name_policy_status='allowed' WHERE id=?").run(current.login_name,nameKey,tag,NAME_POLICY_VERSION,id);
      db.prepare('DELETE FROM login_handle_reservations WHERE operation_id=?').run(current.request_id);
      db.prepare("INSERT INTO password_credentials VALUES(?,?,?,'scrypt',?,?,1,?)").run(id,current.login_handle,current.login_handle_key,salt,derived,now());
    }else db.prepare('UPDATE password_credentials SET salt=?,derived_key=?,params_version=1,updated_at=? WHERE player_id=?').run(salt,derived,now(),id);
    revoke(db,id);const code=action!=='change_password'?recoveryCode(db,id):null;const response=issueToken(db,id,action==='recover_password'?'recovery':'password');if(code)response.recoveryCode=code;
    return complete(db,current,response,['register','set_password'].includes(action)?201:200);
  });return json(completed.data,completed.status);
 }};
}
