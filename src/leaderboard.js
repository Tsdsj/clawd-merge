// Client for the leaderboard Worker: guest names or LINUX DO login (the browser
// keeps a secret token in localStorage), per-game sessions and score submission.
import { LEADERBOARD_API } from './config.js';

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

async function request(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(apiBase + path, { method, headers, body: body && JSON.stringify(body) });
  } catch {
    throw new LeaderboardError('offline', '连不上排行榜服务器，检查一下网络');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new LeaderboardError(data.error || 'http', data.message || `服务器错误 (${res.status})`, res.status);
  return data;
}

function loadPlayer() {
  try {
    const p = JSON.parse(localStorage.getItem(PLAYER_KEY));
    return p?.token && p?.name ? p : null;
  } catch {
    return null;
  }
}

// "橙色钳子#4821" for guests, the plain username for LINUX DO accounts.
export const displayName = (p) => (p.tag ? `${p.name}#${p.tag}` : p.name);

export const leaderboard = {
  enabled: Boolean(apiBase),
  player: loadPlayer(), // { id, name, tag, linuxdo, avatar, trustLevel, token }
  session: null, // Promise<sessionId | null> for the game in progress
  round: null, // ticket and identity captured when this round starts
  onUnauthorized: null, // called when the stored token is no longer valid

  get sessionStatus() {
    return this.round?.player?.token === this.player?.token && this.round?.player
      ? this.round.status : 'local';
  },

  save(player, token = this.player?.token) {
    this.player = { ...player, token };
    localStorage.setItem(PLAYER_KEY, JSON.stringify(this.player));
    return this.player;
  },

  forget() {
    this.player = null;
    this.round = null;
    this.session = null;
    localStorage.removeItem(PLAYER_KEY);
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
      token: this.player?.token,
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
      if (this.player?.token !== token) return;
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
    this.session = round.promise = request('/api/session', { method: 'POST', token: round.player.token })
      .then((d) => {
        round.status = d.sessionId ? 'online' : 'offline';
        return d.sessionId || null;
      })
      .catch((err) => {
        round.status = 'offline';
        if (err.status === 401 && this.player?.token === round.player.token) this.onUnauthorized?.();
        return null;
      });
    return round.promise;
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
