// Client for the leaderboard Worker: guest names or LINUX DO login (the browser
// keeps a secret token in localStorage), per-game sessions and score submission.
import { LEADERBOARD_API } from './config.js';

const PLAYER_KEY = 'clawd-merge:player';
const apiBase = (new URLSearchParams(location.search).get('api') || LEADERBOARD_API).replace(/\/+$/, '');

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
  onUnauthorized: null, // called when the stored token is no longer valid

  save(player, token = this.player?.token) {
    this.player = { ...player, token };
    localStorage.setItem(PLAYER_KEY, JSON.stringify(this.player));
    return this.player;
  },

  forget() {
    this.player = null;
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
    try {
      const me = await request('/api/me', { token: this.player.token });
      this.save(me.player);
    } catch (err) {
      if (err.status === 401) this.onUnauthorized?.();
    }
  },

  // Asks the server for a ticket for the game that is starting now.
  startSession() {
    if (!this.enabled || !this.player) {
      this.session = null;
      return;
    }
    this.session = request('/api/session', { method: 'POST', token: this.player.token })
      .then((d) => d.sessionId)
      .catch((err) => {
        if (err.status === 401) this.onUnauthorized?.();
        return null;
      });
  },

  async submit({ score, drops, maxLevel }) {
    const sessionId = await this.session;
    this.session = null;
    if (!sessionId) throw new LeaderboardError('no_session', '这局没拿到成绩凭证（可能离线了），成绩未上传');
    return request('/api/score', {
      method: 'POST',
      token: this.player.token,
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
