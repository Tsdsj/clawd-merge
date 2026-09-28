// Client for the leaderboard Worker: name registration (bound to this browser
// via a secret token in localStorage), per-game sessions and score submission.
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

export const leaderboard = {
  enabled: Boolean(apiBase),
  player: loadPlayer(),
  session: null, // Promise<sessionId | null> for the game in progress
  onUnauthorized: null, // called when the stored token is no longer valid

  async register(name) {
    const { player, token } = await request('/api/register', { method: 'POST', body: { name } });
    this.player = { id: player.id, name: player.name, token };
    localStorage.setItem(PLAYER_KEY, JSON.stringify(this.player));
    return this.player;
  },

  forget() {
    this.player = null;
    localStorage.removeItem(PLAYER_KEY);
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

  async top(limit = 50) {
    return (await request(`/api/leaderboard?limit=${limit}`)).entries;
  },

  async me() {
    return request('/api/me', { token: this.player.token });
  },
};
