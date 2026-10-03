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
    this.player = { ...player, token };
    this.memoryOnly=!writePreference(PLAYER_KEY, JSON.stringify(this.player));
    return this.player;
  },

  forget() {
    const token=this.player?.token;
    this.player = null;
    this.memoryOnly=false;
    this.round = null;
    this.session = null;
    try {
      const stored=loadPlayer();
      if(!stored || stored.token===token)getStorage()?.removeItem(PLAYER_KEY);
    } catch { /* In-memory logout still takes effect. */ }
  },

  async register(name) {
    const { player, token } = await request('/api/register', { method: 'POST', body: { name } });
    return this.save(player, token);
  },

  async rename(name) {
    const { player } = await request('/api/rename', { method: 'POST', token: this.player.token, body: { name } });
    return this.save(player);
  },

  async logout() {
    const token = this.player?.token;
    this.forget();
    if (token) await request('/api/logout', { method: 'POST', token }).catch(() => {});
  },

  // Leaves for LINUX DO; a signed-in guest's scores get merged into the account.
  async loginWithLinuxdo() {
    const returnTo = location.origin + location.pathname + location.search;
    const { url } = await request('/api/auth/linuxdo/start', {
      method: 'POST',
      // Existing LINUX DO users reauthenticate through OAuth itself. An expired
      // app token must not prevent that; guests still prove ownership to merge.
      token: this.player?.linuxdo ? undefined : this.player?.token,
      body: { returnTo },
    });
    location.assign(url);
  },

  // Coming back from LINUX DO the page URL ends in #login=<code> or #login_error=<msg>.
  async finishLoginRedirect() {
    const params = new URLSearchParams(location.hash.slice(1));
    const code = params.get('login');
    const error = params.get('login_error');
    if (!code && !error) return null;
    history.replaceState(null, '', location.pathname + location.search);
    if (error) return { error };
    try {
      const { player, token } = await request('/api/auth/exchange', { method: 'POST', body: { code } });
      return { player: this.save(player, token) };
    } catch (err) {
      return { error: err.message };
    }
  },

  // Refreshes the cached profile (e.g. a guest who logged in on another device).
  async refresh() {
    if (!this.player) return;
    const token = this.player.token;
    try {
      const me = await request('/api/me', { token });
      if (this.player?.token !== token || loadPlayer()?.token !== token) return;
      this.save(me.player);
    } catch (err) {
      if (err.status === 401 && this.player?.token === token) this.onUnauthorized?.();
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

  uploadPlayer() { return loadPlayer() || (this.memoryOnly ? this.player : null); },

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
