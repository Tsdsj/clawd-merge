// Client for the leaderboard Worker: guest names or LINUX DO login (the browser
// keeps a secret token in localStorage), per-game sessions and score submission.
import { LEADERBOARD_API } from './config.js';
import { readPreference, writePreference, getStorage } from './storage.js';
import { receiptFields } from './score-result.js';

const isLoopback = (hostname) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
const localDevelopment = ['http:', 'https:'].includes(location.protocol) && isLoopback(location.hostname);

function resolveApiBase() {
  // Never let a shared production link redirect credentials or login codes.
  if (localDevelopment) {
    try {
      const override = new URL(new URLSearchParams(location.search).get('api'));
      if (
        ['http:', 'https:'].includes(override.protocol) && isLoopback(override.hostname) &&
        !override.username && !override.password && override.pathname === '/' &&
        !override.search && !override.hash
      ) return override.origin;
    } catch {
      // Missing or invalid override: use the configured API.
    }
  }
  return LEADERBOARD_API.replace(/\/+$/, '');
}

const apiBase = resolveApiBase();
// Keep deployed players signed in. Local identities are API-specific and never
// adopt the old unscoped key, whose original API cannot be established safely.
const PLAYER_KEY = localDevelopment ? `clawd-merge:player:dev:${apiBase}` : 'clawd-merge:player';
const OAUTH_SOURCE_KEY=PLAYER_KEY+':oauth-source';
async function oauthSource(snapshot){
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(snapshot.token||''));
  return JSON.stringify({id:snapshot.id||null,hash:[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('')});
}

export class LeaderboardError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, token, signal, timeoutMs = 0 } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  let data;
  const controller=timeoutMs && !signal ? new AbortController() : null;
  const timer=controller?setTimeout(()=>controller.abort(),timeoutMs):null;
  try {
    res = await fetch(apiBase + path, { method, headers, body: body && JSON.stringify(body), signal:signal||controller?.signal });
    data = await res.json().catch(err=>{if(controller?.signal.aborted||signal?.aborted)throw err;return {};});
  } catch {
    if(controller?.signal.aborted||signal?.aborted)throw new LeaderboardError('timeout','请求超时，尚未收到服务器确认');
    throw new LeaderboardError('offline', '连不上排行榜服务器，检查一下网络');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const error=new LeaderboardError(data.error || 'http', data.message || `服务器错误 (${res.status})`, res.status);
    const retry=res.headers.get('Retry-After');
    error.retryAfterMs=retry ? (Number.isFinite(Number(retry)) ? Number(retry)*1000 : Math.max(0,Date.parse(retry)-Date.now())) : 0;
    throw error;
  }
  return data;
}

function loadPlayer() {
  try {
    const p = JSON.parse(readPreference(PLAYER_KEY));
    return p?.token && p?.name ? p : null;
  } catch {
    return null;
  }
}

let identityRevision = 0;
let observedStorage = readPreference(PLAYER_KEY);
let pendingMutation = null;
let pendingRename = null;
const identityChanged = () => new LeaderboardError('identity_changed', '账号或资料已变化，请刷新页面后再试');

function captureIdentity(client, mutation = false) {
  const stored = readPreference(PLAYER_KEY);
  const persisted = loadPlayer();
  if (client.memoryOnly) {
    if (stored !== observedStorage) throw identityChanged();
  } else if (persisted?.id !== client.player?.id || persisted?.token !== client.player?.token) {
    throw identityChanged();
  }
  if (stored !== observedStorage) { identityRevision++; observedStorage = stored; }
  if (mutation) identityRevision++;
  const snapshot = { revision: identityRevision, stored, id: client.player?.id, token: client.player?.token };
  if (mutation) pendingMutation = snapshot;
  return snapshot;
}
function identityMatches(client, snapshot) {
  return identityRevision === snapshot.revision && client.player?.id === snapshot.id &&
    client.player?.token === snapshot.token && readPreference(PLAYER_KEY) === snapshot.stored;
}
function finishMutation(snapshot) { if (pendingMutation === snapshot) pendingMutation = null; }
globalThis.addEventListener?.('storage', event => {
  if (event.key === PLAYER_KEY || event.key === null) identityRevision++;
});

// "橙色钳子#4821" for guests, the plain username for LINUX DO accounts.
export const displayName = (p) => (p.tag ? `${p.name}#${p.tag}` : p.name);

export const leaderboard = {
  playerStorageKey: PLAYER_KEY,
  saveScope: !localDevelopment && globalThis.CLAWD_CONFIG?.saveScope || `${localDevelopment ? 'dev' : 'production'}:${apiBase || 'offline'}`,
  enabled: Boolean(apiBase),
  player: loadPlayer(), // { id, name, tag, linuxdo, avatar, trustLevel, token }
  session: null, // Promise<sessionId | null> for the game in progress
  round: null, // ticket and identity captured when this round starts
  onUnauthorized: null, // called when the stored token is no longer valid
  memoryOnly: false,

  get sessionStatus() {
    return this.round?.player?.token === this.player?.token && this.round?.player
      ? this.round.status : 'local';
  },

  get sessionFailure() { return this.sessionStatus === 'offline' ? this.round?.errorCode || 'unknown' : null; },
  get sessionMessage() {
    const status=this.sessionStatus;
    if(status==='pending')return '正在确认本局上榜资格，可继续玩…';
    if(status==='online')return '本局参与排名';
    if(status==='local')return this.player?'本局为本地局，下一局再参与排名':'本地游玩 · 成绩仅保存在本机';
    const reason={offline:'开局时连接失败',timeout:'开局确认超时',rate_limited:'开局请求过于频繁',unauthorized:'开局时登录已失效'}[this.sessionFailure];
    return reason?`${reason}，本局为本地局；新开一局可重试上榜。`:'本局未取得上榜资格，仅保存在本机；新开一局可重试上榜。';
  },

  save(player, token = this.player?.token) {
    identityRevision++;
    this.player = { ...player, token };
    this.signedOut=false;this.logoutStorageFailed=false;
    this.memoryOnly=!writePreference(PLAYER_KEY, JSON.stringify(this.player));
    observedStorage=readPreference(PLAYER_KEY);
    return this.player;
  },

  cancelIdentityRequests() { identityRevision++; },
  beginAccountRequest() { return captureIdentity(this,true); },
  accountRequestCurrent(snapshot) { return identityMatches(this,snapshot); },
  endAccountRequest(snapshot) { finishMutation(snapshot); },
  accountRequest(path,options={}) {
    if(!this.enabled)throw new LeaderboardError('offline','账号服务尚未配置');
    if(!path.startsWith('/api/auth/')&&!path.startsWith('/api/account/')&&path!=='/api/me')throw new Error('invalid_account_path');
    return request(path,{timeoutMs:8000,...options});
  },
  async applyAuthResult(data,snapshot,{expectedPlayerId=null,beforeApply=null}={}) {
    if(!data||data.kind!=='authenticated'||typeof data.player?.id!=='string'||typeof data.player.name!=='string'||
      typeof data.token!=='string'||data.token.length<32||!['password','linked','linuxdo'].includes(data.account?.kind)||
      !Number.isSafeInteger(data.account.authVersion)||data.account.authVersion<0||!Number.isSafeInteger(data.expiresAt))
      throw new LeaderboardError('bad_response','服务器返回的账号信息不完整，请检查本次结果');
    if(!identityMatches(this,snapshot)||(expectedPlayerId&&data.player.id!==expectedPlayerId))throw identityChanged();
    if(beforeApply)await beforeApply(data,snapshot);
    if(!identityMatches(this,snapshot))throw identityChanged();
    const round=this.round,samePlayer=data.player.id===snapshot.id;
    this.save({...data.player,account:data.account,capabilities:data.capabilities,sessionExpiresAt:data.expiresAt},data.token);
    if(!samePlayer){this.round=null;this.session=null;return this.player;}
    if(round&&round.player?.token===snapshot.token){
      round.player=this.player;
      if(round.sessionId){
        round.status='pending';
        round.promise=request(`/api/session/check?sessionId=${encodeURIComponent(round.sessionId)}`,{token:data.token,timeoutMs:8000})
          .then(check=>{if(this.round===round&&this.player?.token===data.token){round.status=['valid','used'].includes(check.status)?'online':'offline';if(round.status==='offline')round.errorCode='session_expired';}return round.sessionId;})
          .catch(()=>{if(this.round===round&&this.player?.token===data.token){round.status='pending';round.errorCode='verification_pending';}return round.sessionId;});
        this.session=round.promise;
        await round.promise;
      }
    }
    return this.player;
  },
  async retryAccountStorage() {
    if(!this.player)return false;
    captureIdentity(this);
    this.save(this.player,this.player.token);return !this.memoryOnly;
  },

  get renaming() { return Boolean(pendingRename && pendingRename.id===this.player?.id && pendingRename.token===this.player?.token); },

  forget() {
    identityRevision++;
    const token=this.player?.token;
    this.player = null;
    this.signedOut=true;this.logoutStorageFailed=false;
    this.memoryOnly=false;
    this.round = null;
    this.session = null;
    try {
      const stored=loadPlayer();
      if(!stored || stored.token===token){const storage=getStorage();if(storage)storage.removeItem(PLAYER_KEY);else if(observedStorage)this.logoutStorageFailed=true;}
    } catch { this.logoutStorageFailed=true; }
    this.memoryOnly=this.logoutStorageFailed;
    observedStorage=readPreference(PLAYER_KEY);
  },

  async register(name) {
    const snapshot=captureIdentity(this,true);
    try {
      const { player, token } = await request('/api/register', { method: 'POST', body: { name }, timeoutMs:8000 });
      if(!identityMatches(this,snapshot))throw identityChanged();
      return this.save(player, token);
    } finally { finishMutation(snapshot); }
  },

  async rename(name) {
    if(this.renaming)throw new LeaderboardError('operation_in_progress','正在改名，请等待这次操作完成');
    const snapshot=captureIdentity(this,true);
    if(!snapshot.token){finishMutation(snapshot);throw identityChanged();}
    pendingRename=snapshot;
    try {
      const { player } = await request('/api/rename', { method: 'POST', token: snapshot.token, body: { name }, timeoutMs:8000 });
      if(!identityMatches(this,snapshot)||player?.id!==snapshot.id)throw identityChanged();
      return this.save({...this.player,...player},snapshot.token);
    } finally {
      if(pendingRename===snapshot)pendingRename=null;
      finishMutation(snapshot);
    }
  },

  async logout() {
    const token = this.player?.token;
    this.forget();
    let remoteConfirmed=true;
    if(token)try{await request('/api/logout',{method:'POST',token,timeoutMs:8000});}catch(err){remoteConfirmed=err.status===401;}
    return {remoteConfirmed,storageCleared:!this.logoutStorageFailed};
  },

  // Leaves for LINUX DO; a signed-in guest's scores get merged into the account.
  async loginWithLinuxdo() {
    const snapshot=captureIdentity(this,true);
    try {
      const returnTo = location.origin + location.pathname + location.search;
      const { url } = await request('/api/auth/linuxdo/start', {
        method: 'POST',
        // Existing LINUX DO users reauthenticate through OAuth itself. An expired
        // app token must not prevent that; guests still prove ownership to merge.
        token: this.player?.linuxdo ? undefined : snapshot.token,
        body: { returnTo },
        timeoutMs:8000,
      });
      if(!identityMatches(this,snapshot))throw identityChanged();
      try{sessionStorage.setItem(OAUTH_SOURCE_KEY,await oauthSource(snapshot));}catch{}
      if(!identityMatches(this,snapshot))throw identityChanged();
      location.assign(url);
    } finally { finishMutation(snapshot); }
  },

  // Coming back from LINUX DO the page URL ends in #login=<code> or #login_error=<msg>.
  async finishLoginRedirect() {
    const params = new URLSearchParams(location.hash.slice(1));
    const code = params.get('login');
    const error = params.get('login_error');
    if (!code && !error) return null;
    history.replaceState(null, '', location.pathname + location.search);
    if (error) return { error };
    let snapshot;
    try {
      snapshot=captureIdentity(this,true);
      let source=null;try{source=sessionStorage.getItem(OAUTH_SOURCE_KEY);sessionStorage.removeItem(OAUTH_SOURCE_KEY);}catch{}
      if(source&&source!==await oauthSource(snapshot))throw identityChanged();
      const { player, token } = await request('/api/auth/exchange', { method: 'POST', body: { code }, timeoutMs:8000 });
      if(!identityMatches(this,snapshot))throw identityChanged();
      if(snapshot.id&&player?.id!==snapshot.id&&(this.player?.linuxdo||['password','linked','linuxdo'].includes(this.player?.account?.kind)))throw identityChanged();
      return { player: this.save(player, token) };
    } catch (err) {
      return { error: err.message };
    } finally { finishMutation(snapshot); }
  },

  // Refreshes the cached profile (e.g. a guest who logged in on another device).
  async refresh() {
    if (!this.player || pendingMutation?.revision===identityRevision) return;
    let snapshot;
    try {
      snapshot=captureIdentity(this);
      const me = await request('/api/me', { token:snapshot.token,timeoutMs:8000 });
      if (!identityMatches(this,snapshot)) return;
      this.save({...me.player,...(me.account?{account:me.account}:{}),...(me.capabilities?{capabilities:me.capabilities}:{}),...(me.sessionExpiresAt!==undefined?{sessionExpiresAt:me.sessionExpiresAt}:{})},snapshot.token);
    } catch (err) {
      if (err.status === 401 && snapshot && identityMatches(this,snapshot)) this.onUnauthorized?.();
    }
  },

  // Asks the server for a ticket for the game that is starting now.
  startSession() {
    const round = this.round = { player: this.player, status: 'local', promise: null };
    if (!this.enabled || !this.player) {
      this.session = null;
      return Promise.resolve(null);
    }
    round.status = 'pending';
    this.session = round.promise = request('/api/session', { method: 'POST', token: round.player.token,body:{mode:'classic'},timeoutMs:8000 })
      .then((d) => {
        round.sessionId = typeof d.sessionId==='string'&&d.sessionId.length>0&&d.sessionId.length<=128 ? d.sessionId : null;
        round.status = round.sessionId ? 'online' : 'offline';
        if(!round.sessionId)round.errorCode='bad_response';
        return round.sessionId;
      })
      .catch((err) => {
        round.status = 'offline';
        round.errorCode=err.code || 'unknown';
        if (err.status === 401 && this.player?.token === round.player.token) this.onUnauthorized?.();
        return null;
      });
    return round.promise;
  },

  exportSession() {
    if (!this.round?.player || this.round.player.token !== this.player?.token) return null;
    return { playerId:this.round.player.id, sessionId:this.round.sessionId || null };
  },

  uploadPlayer() { if(this.signedOut)return null;return this.memoryOnly&&readPreference(PLAYER_KEY)===observedStorage?this.player:loadPlayer(); },

  captureResultSession() {
    const round=this.round;
    if(!round?.player || round.player.token!==this.player?.token)return null;
    return {playerId:round.player.id,playerName:round.player.name,sessionId:round.sessionId||null,promise:round.promise};
  },

  challengeRequest(path,options={}) {
    if(!this.enabled)throw new LeaderboardError('offline','尚未配置挑战服务');
    if(!path.startsWith('/api/challenges/'))throw new Error('invalid_challenge_path');
    return request(path,{timeoutMs:8000,token:this.uploadPlayer()?.token,...options});
  },

  async sendResult(body,token) {
    const response=await request('/api/score',{method:'POST',body,token,timeoutMs:8000});
    try {
      const receipt=receiptFields(response);
      if(receipt.best<body.score || (body.score>0&&receipt.rank===null))throw new Error('invalid_receipt');
      return receipt;
    }
    catch { throw new LeaderboardError('bad_response','服务器没有返回有效的成绩回执',502); }
  },

  async checkSavedSession(ticket) {
    // A different tab may have signed in since this tab first loaded.
    this.player = loadPlayer();
    if (!ticket) return { status:'local' };
    if (!this.player || this.player.id !== ticket.playerId) return { status:'identity' };
    if (!ticket.sessionId) return { status:'invalid' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const token = this.player.token;
    try {
      const result = await request(`/api/session/check?sessionId=${encodeURIComponent(ticket.sessionId)}`, {token,signal:controller.signal});
      if (this.player?.token !== token) return { status:'identity' };
      return result;
    } catch (err) {
      return { status:err.status===401 ? 'identity' : 'network' };
    } finally { clearTimeout(timer); }
  },

  restoreSession(ticket) {
    if (!ticket) { this.round=null;this.session=null;return; }
    if (!this.player || this.player.id!==ticket.playerId || !ticket.sessionId) throw new Error('identity_changed');
    this.session=Promise.resolve(ticket.sessionId);
    this.round={player:this.player,status:'online',sessionId:ticket.sessionId,promise:this.session};
  },

  async submit({ score, drops, maxLevel }) {
    const round = this.round;
    if (!round?.player || round.player.token !== this.player?.token || round.submitted) {
      throw new LeaderboardError('no_session', '本局为本地游玩，加入后从下一局开始参与排名');
    }
    round.submitted = true;
    const sessionId = await round.promise;
    if (this.round === round) this.session = null;
    if (!sessionId) throw new LeaderboardError('no_session', '这局没拿到成绩凭证（可能离线了），成绩未上传');
    if (round.player.token !== this.player?.token) {
      throw new LeaderboardError('no_session', '本局身份已改变，成绩未上传');
    }
    return request('/api/score', {
      method: 'POST',
      token: round.player.token,
      body: { sessionId, score, drops, maxLevel },
    });
  },

  // → { entries, total } — the top `limit` players and how many are ranked overall.
  async top(limit = 20) {
    const data = await request(`/api/leaderboard?limit=${limit}`);
    return { entries: data.entries, total: data.total ?? data.entries.length };
  },

  async me() {
    return request('/api/me', { token: this.player.token });
  },
};
