// Browser-bound OAuth for the self-hosted account service. Provider I/O happens
// outside transactions; binding/merging happens only during proved exchange.
import {randomUUID,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {AUTH_QUERY,sessionCurrent} from '../leaderboard/src/account-state.js';
import {mergeChallengeStatements} from '../leaderboard/src/challenges.js';
const DAY=86400000,CODE_TTL=120000,GRANT_TTL=300000;
export async function oauthAccountRoute(c){
 const {request,env,h,path,body,DB,raw,tx,ring,now,fail,json,actorOf,proof,resultOf,complete,issueToken,grant,readOp,sha,mac,same,secret,random,revoke}=c;
 const fields=path.endsWith('/start')?['requestId','retrySecret','operationTicket','action','purpose','clientNonce','returnTo','reauthProof']:['requestId','retrySecret','operationTicket','code','clientNonce'];
 if(request.method!=='GET'&&Object.keys(body).some(key=>!fields.includes(key)))fail(400,'bad_request','授权请求字段不正确');
 function source(db,op){
  if(!op.actor_player_id)return null;
  const p=db.prepare(AUTH_QUERY).get(op.actor_token_hash);
  if(!sessionCurrent(p,now())||p.id!==op.actor_player_id||p.auth_version!==op.actor_auth_version)fail(409,'identity_changed','账号已变化，请重新发起授权');
  return p;
 }
 function currentOp(id){const op=readOp(id);if(!op||op.expires_at<=now()||!ring.versions.has(op.key_version))fail(410,'operation_expired','授权已过期，请重新发起');if(op.status==='stale')fail(409,'operation_stale','这次授权已取消或失效');return op;}
 function seal(op,purpose,value){const nonce=randomBytes(12),enc=createCipheriv('aes-256-gcm',ring.versions.get(op.key_version).receipt,nonce);enc.setAAD(Buffer.from(op.request_id+':'+purpose));const bytes=Buffer.concat([enc.update(JSON.stringify(value),'utf8'),enc.final()]);return {cipher:Buffer.concat([enc.getAuthTag(),bytes]).toString('base64url'),nonce:nonce.toString('base64url')};}
 function open(op,purpose,cipher,nonce){try{const bytes=Buffer.from(cipher,'base64url'),dec=createDecipheriv('aes-256-gcm',ring.versions.get(op.key_version).receipt,Buffer.from(nonce,'base64url'));dec.setAAD(Buffer.from(op.request_id+':'+purpose));dec.setAuthTag(bytes.subarray(0,16));return JSON.parse(Buffer.concat([dec.update(bytes.subarray(16)),dec.final()]).toString('utf8'));}catch{fail(409,'operation_stale','授权信息已失效，请重新发起');}}
 function flowFor(op){return raw.prepare('SELECT * FROM oauth_account_flows WHERE operation_id=?').get(op.request_id);}
 function matchNonce(op){if(!secret(body.clientNonce)||!same(op.client_nonce_hash,sha(body.clientNonce)))fail(409,'oauth_browser_mismatch','请在发起授权的原页面完成登录');}
 function validUser(user){
  const id=Number(user?.id);
  if(!Number.isSafeInteger(id)||id<=0||typeof user?.username!=='string'||!user.username)fail(502,'linuxdo_user','读取 LINUX DO 用户信息失败');
  if(!user.active||user.silenced)fail(403,'linuxdo_blocked','这个 LINUX DO 账号未激活或被禁言');
  if(!Number.isFinite(Number(user.trust_level))||Number(user.trust_level)<(Number(env.LINUXDO_MIN_TRUST_LEVEL)||0))fail(403,'linuxdo_level','LINUX DO 信任等级暂不符合要求');
  return {id,name:user.username.slice(0,40),avatar:h.avatarUrl(user.avatar_template),trustLevel:Number(user.trust_level)};
 }
 if(path.endsWith('/start')){
  const op=proof();if(op.action!=='exchange_login'||op.oauth_action!==body.action||(op.oauth_purpose||null)!==(body.purpose||null))fail(409,'operation_conflict','授权用途与准备信息不一致');matchNonce(op);
  const returnTo=h.checkReturnTo(body.returnTo);
  const data=tx(db=>{
   const current=currentOp(op.request_id);const p=actorOf(db,current);if(current.status==='complete')fail(409,'operation_stale','这次授权已经完成，请查看原结果');
   const previous=flowFor(current);
   if(previous){if(previous.return_to!==returnTo)fail(409,'operation_conflict','授权返回地址已变化');if(previous.status==='failed')fail(409,'operation_stale','授权失败，请重新开始');return open(current,'start',previous.start_cipher,previous.start_nonce);}
   if(current.oauth_action==='bind'&&p.credential_player_id)grant(db,current,'bind_linuxdo',true);
   if(current.oauth_action==='bind'&&p.linuxdo_id!=null&&!p.credential_player_id)fail(409,'already_bound','当前账号已经绑定 Linux.do');
   if(current.oauth_action==='reauth'&&p.linuxdo_id==null)fail(403,'reauth_required','请先绑定 Linux.do');
   const state=random(),url=new URL(h.authorizeUrl);url.search=new URLSearchParams({response_type:'code',client_id:env.LINUXDO_CLIENT_ID,redirect_uri:h.callbackUrl(request),state});
   const value={url:url.toString()},protectedStart=seal(current,'start',value);
   db.prepare('INSERT INTO oauth_account_flows(state_hash,operation_id,return_to,expires_at,start_cipher,start_nonce) VALUES(?,?,?,?,?,?)').run(sha(state),current.request_id,returnTo,current.expires_at,protectedStart.cipher,protectedStart.nonce);
   return value;
  });return json(data);
 }
 if(path.endsWith('/callback')){
  const url=new URL(request.url),stateHash=sha(url.searchParams.get('state')||''),flow=raw.prepare('SELECT * FROM oauth_account_flows WHERE state_hash=?').get(stateHash);
  if(!flow)return h.redirectWith(h.checkReturnTo(null),{login_error:'登录已过期，请重新登录'});
  const back=params=>h.redirectWith(flow.return_to,{...params,oauth:'1'}),code=url.searchParams.get('code');
  if(!code){
   try{const completed=tx(db=>{const op=currentOp(flow.operation_id);if(op.status==='complete'){resultOf(db,op);return open(op,'authorization',flow.authorization_cipher,flow.authorization_nonce).loginCode;}
     db.prepare("UPDATE oauth_account_flows SET status='failed' WHERE state_hash=?").run(stateHash);db.prepare("UPDATE auth_operations SET status='stale' WHERE request_id=?").run(op.request_id);return null;});
    return completed?back({login:completed}):back({login_error:'你取消了 LINUX DO 授权',login_error_code:'oauth_cancelled'});
   }catch(error){return back({login_error:error instanceof h.ApiError?error.message:'授权已失效，请重新开始',login_error_code:error instanceof h.ApiError?error.code:'oauth_failed'});}
  }
  let ownsFetch=false;
  try{
   let cached=null;const op=tx(db=>{
    const current=currentOp(flow.operation_id),fresh=db.prepare('SELECT * FROM oauth_account_flows WHERE state_hash=?').get(stateHash);if(current.status==='complete')resultOf(db,current);else source(db,current);
    if(code.length>4096)fail(400,'bad_request','授权码格式不正确');
    if(fresh.status==='authorized'){
     if(fresh.provider_code_hash!==sha(code)||fresh.login_code_expires_at<=now())fail(410,'operation_expired','登录已过期，请检查原结果或重新发起');
     cached=open(current,'authorization',fresh.authorization_cipher,fresh.authorization_nonce);return current;
    }
    if(fresh.status!=='pending')fail(409,'oauth_in_progress',fresh.status==='fetching'?'授权正在确认，请稍后检查原结果':'授权已失效，请重新开始');
    db.prepare("UPDATE oauth_account_flows SET status='fetching',provider_code_hash=? WHERE state_hash=?").run(sha(code),stateHash);return current;
   });
   if(cached)return back({login:cached.loginCode});
   ownsFetch=true;
   const access=await h.fetchAccessToken(code,request,env),user=validUser(await h.fetchLinuxdoUser(access,env));
   const loginCode=random();tx(db=>{
    const current=currentOp(op.request_id);source(db,current);
    const fresh=db.prepare('SELECT status FROM oauth_account_flows WHERE state_hash=?').get(stateHash);if(fresh?.status!=='fetching')fail(409,'operation_stale','授权已失效');
    const sealed=seal(current,'authorization',{loginCode,user});
    db.prepare("UPDATE oauth_account_flows SET status='authorized',login_code_hash=?,login_code_expires_at=?,authorization_cipher=?,authorization_nonce=? WHERE state_hash=?").run(sha(loginCode),Math.min(now()+CODE_TTL,current.expires_at),sealed.cipher,sealed.nonce,stateHash);
   });return back({login:loginCode});
  }catch(error){
   // No upstream payloads, codes, nonces, or credentials enter logs/redirects.
   if(ownsFetch)tx(db=>db.prepare("UPDATE oauth_account_flows SET status='failed' WHERE state_hash=? AND status='fetching'").run(stateHash));
   return back({login_error:error instanceof h.ApiError?error.message:'LINUX DO 授权失败，请重新开始',login_error_code:error instanceof h.ApiError?error.code:'oauth_failed'});
  }
 }
 // A complete result can be replayed after the one-time code has expired, but
 // only with the original nonce/payload and the protected, unexpired intent.
 const op=proof();if(op.action!=='exchange_login')fail(409,'operation_conflict','操作类型不匹配');matchNonce(op);
 if(!secret(body.code))fail(400,'bad_login_code','登录已过期，请重新登录');
 const digest=mac(ring.versions.get(op.key_version).payload,JSON.stringify([body.code,body.clientNonce]));
 const result=tx(db=>{
  const current=currentOp(op.request_id);
  if(current.payload_hmac&&!same(current.payload_hmac,digest))fail(409,'operation_conflict','兑换凭据与原请求不一致');
  const cached=resultOf(db,current);if(cached)return {data:cached,status:current.result_status};
  const p=actorOf(db,current),flow=flowFor(current);
  if(!flow||flow.status!=='authorized'||flow.login_code_expires_at<=now()||!same(flow.login_code_hash,sha(body.code)))fail(400,'bad_login_code','登录已过期或尚未完成授权');
  const {user}=open(current,'authorization',flow.authorization_cipher,flow.authorization_nonce);
  db.prepare('UPDATE auth_operations SET payload_hmac=? WHERE request_id=?').run(digest,current.request_id);
  const target=db.prepare('SELECT * FROM players WHERE linuxdo_id=?').get(user.id);
  let id=p?.id,mergedFrom=null;
  if(current.oauth_action==='reauth'){
   if(p.linuxdo_id!==user.id)fail(409,'identity_mismatch','这不是当前账号已绑定的 Linux.do，请选择原账号重新验证');
   if((current.oauth_purpose==='set_password'&&p.credential_player_id)||(current.oauth_purpose==='recover_password'&&!p.credential_player_id))fail(409,'identity_changed','当前账号能力已变化，请重新开始');
   const value=random(),expiresAt=now()+GRANT_TTL;db.prepare('INSERT INTO reauth_grants VALUES(?,?,?,?,?,?)').run(sha(value),p.id,current.actor_token_hash,p.auth_version,current.oauth_purpose,expiresAt);
   return complete(db,current,{kind:'reauth',reauthProof:value,purpose:current.oauth_purpose,playerId:p.id,authVersion:p.auth_version,expiresAt},200);
  }
  if(current.oauth_action==='bind'){
   if(p.linuxdo_id!=null&&p.linuxdo_id!==user.id)fail(409,'binding_conflict','当前账号已绑定其他 Linux.do，不支持更换或解绑');
   if(target&&target.id!==p.id){
    if(p.credential_player_id||p.linuxdo_id!=null)fail(409,'binding_conflict','此 Linux.do 已属于另一个账号。原账号保持不变，请退出后使用对应方式登录。');
    // Only a still-pure guest reaches this branch. Every transfer and receipt
    // completes in this same transaction; no partially merged identity escapes.
    id=target.id;mergedFrom=p.id;
    if(p.best_score>target.best_score||(p.best_score===target.best_score&&p.best_score>0&&p.best_at<target.best_at))db.prepare('UPDATE players SET best_score=?,best_level=?,best_at=? WHERE id=?').run(p.best_score,p.best_level,p.best_at,id);
    db.prepare('UPDATE players SET games=games+? WHERE id=?').run(p.games,id);
    // Guest grants are absent by policy; deleting any stale rows also preserves
    // their compound token foreign key before token ownership moves.
    revoke(db,p.id);
    for(const table of ['scores','score_receipts','sessions'])db.prepare(`UPDATE ${table} SET player_id=? WHERE player_id=?`).run(id,p.id);
    for(const statement of mergeChallengeStatements(DB,id,p.id))statement.execute();
    db.prepare("UPDATE auth_operations SET status='stale' WHERE actor_player_id=? AND request_id!=? AND status!='complete'").run(p.id,current.request_id);
    db.prepare('DELETE FROM players WHERE id=?').run(p.id);
   }else if(!target){
    const formal=Boolean(p.credential_player_id);
    db.prepare(`UPDATE players SET linuxdo_id=?,name=CASE WHEN ? THEN name ELSE ? END,name_key=CASE WHEN ? THEN name_key ELSE ? END,
      tag=CASE WHEN ? THEN tag ELSE NULL END,display_name_source=CASE WHEN ? THEN 'local' ELSE 'linuxdo' END WHERE id=?`)
      .run(user.id,formal?1:0,user.name,formal?1:0,'ld:'+user.id,formal?1:0,formal?1:0,p.id);
    revoke(db,p.id);
   }
  }else{
   if(target)id=target.id;
   else{id=randomUUID();db.prepare('INSERT INTO players(id,name,name_key,token_hash,avatar,trust_level,linuxdo_id,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,user.name,'ld:'+user.id,sha(random()),user.avatar,user.trustLevel,user.id,now());}
  }
  db.prepare(`UPDATE players SET name=CASE WHEN display_name_source='local' THEN name ELSE ? END,avatar=?,trust_level=?,name_policy_status='unreviewed' WHERE id=?`).run(user.name,user.avatar,user.trustLevel,id);
  db.prepare(`UPDATE tokens SET auth_method='linuxdo',expires_at=COALESCE(expires_at,?) WHERE player_id=? AND auth_method IN ('guest','legacy') AND auth_version=(SELECT auth_version FROM players WHERE id=?) AND (expires_at IS NULL OR expires_at>?)`).run(now()+30*DAY,id,id,now());
  const data=issueToken(db,id,'linuxdo');if(mergedFrom)data.mergedFromPlayerId=mergedFrom;
  return complete(db,current,data,200);
 });return json(result.data,result.status);
}
