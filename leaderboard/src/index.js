// 合成大Clawd leaderboard API — a zero-dependency Cloudflare Worker backed by D1.
//
// Identity
//   POST /api/register          { name }                 → { player, token }   guest, name may repeat (gets #tag)
//   POST /api/rename            (Bearer) { name }        → { player }          guests only
//   POST /api/logout            (Bearer)                 → { ok }
//   GET  /api/me                (Bearer)                 → { player, best, bestLevel, rank, games }
//   POST /api/auth/linuxdo/start  (optional Bearer) { returnTo } → { url }     begin LINUX DO login
//   GET  /api/auth/linuxdo/callback ?code&state          → 302 back to the game with #login=<code>
//   POST /api/auth/exchange     { code }                 → { player, token }   one-time code → token
// Game
//   POST /api/session           (Bearer)                 → { sessionId }
//   POST /api/score             (Bearer) { sessionId, score, drops, maxLevel } → { best, rank, improved }
//   GET  /api/leaderboard       ?limit=20                → { entries: [...], total }
//
// Players are either guests (any name, disambiguated by a random 4-digit tag) or
// LINUX DO accounts (name = LINUX DO username, unique by account id). A browser
// holds a random secret token; only its SHA-256 is stored, and one account can
// hold several tokens (devices). A guest who logs in with LINUX DO has their
// scores merged into that account.
//
// Anti-cheat is best-effort (a browser game can always be scripted): every
// score needs an unused server-issued session, the real time since the session
// started must fit the number of drops, and the score must be plausible for
// that many drops. Everything is rate limited.

const NAME_MIN = 2;
const NAME_MAX = 12;
// Chinese characters, ASCII letters/digits, _ - · (no spaces or symbols).
const NAME_PATTERN = /^[\p{Script=Han}A-Za-z0-9_\-·]+$/u;
const RESERVED = ['admin', 'administrator', 'root', 'system', '管理员', '官方', '系统', 'anthropic', 'claude', 'clawd'];

const MAX_LEVEL = 11;
const MAX_DROPS = 5000;
const DROP_COOLDOWN_MS = 500; // the client can't drop faster than this
const MAX_POINTS_PER_DROP = 400; // generous: good players average < 150
const SESSION_TTL_MS = 3 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const LOGIN_CODE_TTL_MS = 2 * 60 * 1000;
const LEADERBOARD_MAX = 100;

const LINUXDO = {
  authorize: 'https://connect.linux.do/oauth2/authorize',
  token: 'https://connect.linux.do/oauth2/token',
  user: 'https://connect.linux.do/api/user',
  site: 'https://linux.do',
};
const CALLBACK_PATH = '/api/auth/linuxdo/callback';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const LIMITS = {
  register: { limit: 5, windowMs: HOUR }, // per IP
  login: { limit: 30, windowMs: HOUR }, // per IP (start + exchange)
  rename: { limit: 10, windowMs: DAY }, // per player
  session: { limit: 120, windowMs: HOUR }, // per player
  score: { limit: 60, windowMs: HOUR }, // per player
};

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(request, env);
      if (res.status < 300 || res.status >= 400) {
        for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      }
      return res;
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      const body =
        err instanceof ApiError
          ? { error: err.code, message: err.message }
          : { error: 'internal', message: '服务器开小差了，请稍后再试' };
      if (!(err instanceof ApiError)) console.error(err);
      return json(body, status, cors);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname.replace(/\/+$/, '')}`;
  switch (key) {
    case 'GET /api/health':
      return json({ ok: true });
    case 'POST /api/register':
      return register(request, env);
    case 'POST /api/rename':
      return rename(request, env);
    case 'POST /api/logout':
      return logout(request, env);
    case 'GET /api/me':
      return me(request, env);
    case 'POST /api/auth/linuxdo/start':
      return linuxdoStart(request, env);
    case `GET ${CALLBACK_PATH}`:
      return linuxdoCallback(request, env);
    case 'POST /api/auth/exchange':
      return exchangeLoginCode(request, env);
    case 'POST /api/session':
      return startSession(request, env);
    case 'POST /api/score':
      return submitScore(request, env);
    case 'GET /api/leaderboard':
      return leaderboard(url, env);
    default:
      throw new ApiError(404, 'not_found', '接口不存在');
  }
}

// ---------- guests ----------

async function register(request, env) {
  await rateLimit(env.DB, `register:${clientIp(request)}`, LIMITS.register, '注册太频繁了，请一小时后再试');
  const name = checkGuestName((await readJson(request)).name, env);
  const id = crypto.randomUUID();
  const token = randomToken();
  const tokenHash = await sha256(token);
  const now = Date.now();
  const tag = await insertWithFreeTag(env.DB, name, (tag) => [
    env.DB.prepare(
      'INSERT INTO players (id, name, name_key, tag, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(id, name, guestKey(name, tag), tag, tokenHash, now),
    env.DB.prepare('INSERT INTO tokens (token_hash, player_id, created_at) VALUES (?, ?, ?)').bind(tokenHash, id, now),
  ]);
  return json({ player: publicPlayer({ id, name, tag }), token }, 201);
}

async function rename(request, env) {
  const player = await authenticate(request, env);
  if (player.linuxdo_id != null) throw new ApiError(400, 'linuxdo_name', 'LINUX DO 账号的名字跟随 L 站用户名，不能在这里改');
  await rateLimit(env.DB, `rename:${player.id}`, LIMITS.rename, '今天改名次数用完了，明天再来');
  const name = checkGuestName((await readJson(request)).name, env);
  const tag = await insertWithFreeTag(env.DB, name, (tag) => [
    env.DB.prepare('UPDATE players SET name = ?, name_key = ?, tag = ? WHERE id = ?').bind(
      name,
      guestKey(name, tag),
      tag,
      player.id,
    ),
  ]);
  return json({ player: publicPlayer({ ...player, name, tag }) });
}

// Runs `statements(tag)` with a random free 4-digit tag, retrying on collisions.
async function insertWithFreeTag(db, name, statements) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const tag = String(crypto.getRandomValues(new Uint16Array(1))[0] % 10000).padStart(4, '0');
    try {
      await db.batch(statements(tag));
      return tag;
    } catch (err) {
      if (!String(err).includes('UNIQUE')) throw err;
    }
  }
  throw new ApiError(409, 'name_crowded', '这个名字用的人太多了，换一个吧');
}

async function logout(request, env) {
  const { tokenHash } = await authenticate(request, env);
  await env.DB.prepare('DELETE FROM tokens WHERE token_hash = ?').bind(tokenHash).run();
  return json({ ok: true });
}

async function me(request, env) {
  const player = await authenticate(request, env);
  return json({
    player: publicPlayer(player),
    best: player.best_score,
    bestLevel: player.best_level,
    games: player.games,
    rank: player.best_score > 0 ? await rankOf(env.DB, player) : null,
  });
}

// ---------- LINUX DO login (OAuth2 authorization code flow) ----------

async function linuxdoStart(request, env) {
  if (!env.LINUXDO_CLIENT_ID || !env.LINUXDO_CLIENT_SECRET) {
    throw new ApiError(503, 'login_disabled', 'LINUX DO 登录还没配置好');
  }
  await rateLimit(env.DB, `login:${clientIp(request)}`, LIMITS.login, '登录太频繁了，请稍后再试');
  const { returnTo } = await readJson(request);
  const safeReturn = checkReturnTo(returnTo, env);
  // A signed-in guest carries their token so their scores can be merged.
  const guest = request.headers.get('Authorization') ? await authenticate(request, env) : null;

  const state = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE created_at < ?').bind(now - OAUTH_STATE_TTL_MS),
    env.DB.prepare(
      'INSERT INTO oauth_states (state_hash, merge_player_id, return_to, created_at) VALUES (?, ?, ?, ?)',
    ).bind(await sha256(state), guest && guest.linuxdo_id == null ? guest.id : null, safeReturn, now),
  ]);

  const url = new URL(env.LINUXDO_AUTHORIZE_URL || LINUXDO.authorize);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: env.LINUXDO_CLIENT_ID,
    redirect_uri: callbackUrl(request),
    state,
  });
  return json({ url: url.toString() });
}

async function linuxdoCallback(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state') || '';
  const row = await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ? RETURNING *')
    .bind(await sha256(state))
    .first();
  // Without a valid state we don't know where the player came from.
  if (!row || Date.now() - row.created_at > OAUTH_STATE_TTL_MS) {
    const home = checkReturnTo(null, env);
    return redirectWith(home, { login_error: '登录已过期，请重新登录' });
  }
  const back = (params) => redirectWith(row.return_to, params);

  const code = url.searchParams.get('code');
  if (!code) return back({ login_error: '你取消了 LINUX DO 授权' });

  try {
    const accessToken = await fetchAccessToken(code, request, env);
    const user = await fetchLinuxdoUser(accessToken, env);
    const minLevel = Number(env.LINUXDO_MIN_TRUST_LEVEL) || 0;
    if (!user.active || user.silenced) throw new ApiError(403, 'linuxdo_blocked', '这个 LINUX DO 账号未激活或被禁言');
    if (user.trust_level < minLevel) {
      throw new ApiError(403, 'linuxdo_level', `需要 LINUX DO 信任等级 ${minLevel} 级以上才能上榜`);
    }
    const playerId = await upsertLinuxdoPlayer(env.DB, user, row.merge_player_id);
    const loginCode = randomToken();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM login_codes WHERE created_at < ?').bind(Date.now() - LOGIN_CODE_TTL_MS),
      env.DB.prepare('INSERT INTO login_codes (code_hash, player_id, created_at) VALUES (?, ?, ?)').bind(
        await sha256(loginCode),
        playerId,
        Date.now(),
      ),
    ]);
    return back({ login: loginCode });
  } catch (err) {
    if (!(err instanceof ApiError)) console.error(err);
    return back({ login_error: err instanceof ApiError ? err.message : 'LINUX DO 登录失败，请稍后再试' });
  }
}

async function fetchAccessToken(code, request, env) {
  const res = await fetch(env.LINUXDO_TOKEN_URL || LINUXDO.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl(request),
      client_id: env.LINUXDO_CLIENT_ID,
      client_secret: env.LINUXDO_CLIENT_SECRET,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    console.error('linuxdo token exchange failed', res.status, data.error);
    throw new ApiError(502, 'linuxdo_token', 'LINUX DO 授权失败，请重新登录');
  }
  return data.access_token;
}

async function fetchLinuxdoUser(accessToken, env) {
  const res = await fetch(env.LINUXDO_USER_URL || LINUXDO.user, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const user = await res.json().catch(() => null);
  if (!res.ok || !user || user.id == null || !user.username) {
    throw new ApiError(502, 'linuxdo_user', '读取 LINUX DO 用户信息失败');
  }
  return user;
}

// Creates or refreshes the account for a LINUX DO user; merges a guest into it.
async function upsertLinuxdoPlayer(db, user, mergeGuestId) {
  const linuxdoId = Number(user.id);
  const fields = [String(user.username).slice(0, 40), avatarUrl(user.avatar_template), Number(user.trust_level) || 0];
  const existing = await db.prepare('SELECT * FROM players WHERE linuxdo_id = ?').bind(linuxdoId).first();
  const guest = mergeGuestId
    ? await db.prepare('SELECT * FROM players WHERE id = ? AND linuxdo_id IS NULL').bind(mergeGuestId).first()
    : null;

  if (!existing && guest) {
    // First LINUX DO login from a guest: the guest row simply becomes the account.
    await db
      .prepare(
        'UPDATE players SET name = ?, avatar = ?, trust_level = ?, linuxdo_id = ?, name_key = ?, tag = NULL WHERE id = ?',
      )
      .bind(...fields, linuxdoId, `ld:${linuxdoId}`, guest.id)
      .run();
    return guest.id;
  }

  let id = existing?.id;
  if (existing) {
    await db.prepare('UPDATE players SET name = ?, avatar = ?, trust_level = ? WHERE id = ?').bind(...fields, id).run();
  } else {
    id = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO players (id, name, name_key, token_hash, avatar, trust_level, linuxdo_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, fields[0], `ld:${linuxdoId}`, await sha256(randomToken()), fields[1], fields[2], linuxdoId, Date.now())
      .run();
  }

  if (guest) {
    // The account already existed: fold the guest's history into it.
    const better = guest.best_score > (existing?.best_score ?? 0);
    await db.batch([
      db.prepare('UPDATE scores SET player_id = ? WHERE player_id = ?').bind(id, guest.id),
      db.prepare('UPDATE tokens SET player_id = ? WHERE player_id = ?').bind(id, guest.id),
      db.prepare('UPDATE sessions SET player_id = ? WHERE player_id = ?').bind(id, guest.id),
      better
        ? db
            .prepare('UPDATE players SET best_score = ?, best_level = ?, best_at = ?, games = games + ? WHERE id = ?')
            .bind(guest.best_score, guest.best_level, guest.best_at, guest.games, id)
        : db.prepare('UPDATE players SET games = games + ? WHERE id = ?').bind(guest.games, id),
      db.prepare('DELETE FROM players WHERE id = ?').bind(guest.id),
    ]);
  }
  return id;
}

async function exchangeLoginCode(request, env) {
  await rateLimit(env.DB, `login:${clientIp(request)}`, LIMITS.login, '登录太频繁了，请稍后再试');
  const { code } = await readJson(request);
  const row = await env.DB.prepare('DELETE FROM login_codes WHERE code_hash = ? RETURNING *')
    .bind(await sha256(String(code || '')))
    .first();
  if (!row || Date.now() - row.created_at > LOGIN_CODE_TTL_MS) {
    throw new ApiError(400, 'bad_login_code', '登录已过期，请重新登录');
  }
  const player = await env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(row.player_id).first();
  if (!player) throw new ApiError(400, 'bad_login_code', '登录已过期，请重新登录');
  const token = randomToken();
  await env.DB.prepare('INSERT INTO tokens (token_hash, player_id, created_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), player.id, Date.now())
    .run();
  return json({ player: publicPlayer(player), token });
}

// ---------- game ----------

async function startSession(request, env) {
  const player = await authenticate(request, env);
  await rateLimit(env.DB, `session:${player.id}`, LIMITS.session, '操作太频繁了，请稍后再试');
  const now = Date.now();
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE player_id = ? AND (used = 1 OR started_at < ?)').bind(
      player.id,
      now - SESSION_TTL_MS,
    ),
    env.DB.prepare('INSERT INTO sessions (id, player_id, started_at) VALUES (?, ?, ?)').bind(id, player.id, now),
  ]);
  return json({ sessionId: id });
}

async function submitScore(request, env) {
  const player = await authenticate(request, env);
  await rateLimit(env.DB, `score:${player.id}`, LIMITS.score, '提交太频繁了，请稍后再试');

  const body = await readJson(request);
  const score = int(body.score, 0, 10_000_000, 'score');
  const drops = int(body.drops, 1, MAX_DROPS, 'drops');
  const maxLevel = int(body.maxLevel, 1, MAX_LEVEL, 'maxLevel');
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';

  const now = Date.now();
  // Consume the session atomically so it can't be submitted twice.
  const session = await env.DB.prepare(
    'UPDATE sessions SET used = 1 WHERE id = ? AND player_id = ? AND used = 0 RETURNING started_at',
  )
    .bind(sessionId, player.id)
    .first();
  if (!session) throw new ApiError(400, 'bad_session', '这局的成绩凭证无效，请重新开一局');
  const elapsed = now - session.started_at;
  if (elapsed > SESSION_TTL_MS) throw new ApiError(400, 'session_expired', '这局太久了，成绩凭证已过期');
  if (elapsed < drops * DROP_COOLDOWN_MS * 0.9 - 3000) {
    throw new ApiError(422, 'too_fast', '成绩异常：投放速度超出了游戏允许的范围');
  }
  if (score > drops * MAX_POINTS_PER_DROP + 5000) {
    throw new ApiError(422, 'implausible', '成绩异常：分数和投放次数对不上');
  }

  const statements = [
    env.DB.prepare(
      'INSERT INTO scores (player_id, score, max_level, drops, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(player.id, score, maxLevel, drops, elapsed, now),
    env.DB.prepare('UPDATE players SET games = games + 1 WHERE id = ?').bind(player.id),
    // Authentication read a snapshot: another device may have improved it since.
    // Compare against the stored value in the transaction, preserving ties.
    env.DB.prepare(
      'UPDATE players SET best_score = ?, best_level = ?, best_at = ? WHERE id = ? AND best_score < ?',
    ).bind(score, maxLevel, now, player.id, score),
  ];
  const results = await env.DB.batch(statements);
  const improved = results[2].meta.changes > 0;

  // Return the current authoritative best, including when this score lost a race.
  const best = await env.DB.prepare('SELECT best_score, best_at FROM players WHERE id = ?').bind(player.id).first();
  return json({
    improved,
    best: best.best_score,
    rank: best.best_score > 0 ? await rankOf(env.DB, best) : null,
  });
}

async function leaderboard(url, env) {
  const limit = Math.min(LEADERBOARD_MAX, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const [{ results }, count] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, tag, avatar, trust_level, linuxdo_id, best_score AS score, best_level AS level, best_at AS at
         FROM players WHERE best_score > 0
        ORDER BY best_score DESC, best_at ASC LIMIT ?`,
    )
      .bind(limit)
      .all(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM players WHERE best_score > 0').first(),
  ]);
  const entries = results.map((r, i) => ({
    rank: i + 1,
    ...publicPlayer(r),
    score: r.score,
    level: r.level,
    at: r.at,
  }));
  return json({ entries, total: count.n }, 200, { 'Cache-Control': 'public, max-age=10' });
}

// ---------- helpers ----------

// What other players may see about a player. `id` is an opaque handle used by
// the client to highlight its own row; it grants nothing without a token.
function publicPlayer(p) {
  const linuxdo = p.linuxdo_id != null;
  return {
    id: p.id,
    name: p.name,
    tag: linuxdo ? null : p.tag ?? null,
    linuxdo,
    avatar: linuxdo ? p.avatar ?? null : null,
    trustLevel: linuxdo ? p.trust_level ?? 0 : null,
  };
}

async function authenticate(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) throw new ApiError(401, 'unauthorized', '请先起个名字或登录');
  const tokenHash = await sha256(token);
  const player = await env.DB.prepare(
    'SELECT p.* FROM tokens t JOIN players p ON p.id = t.player_id WHERE t.token_hash = ?',
  )
    .bind(tokenHash)
    .first();
  if (!player) throw new ApiError(401, 'unauthorized', '登录已失效，请重新登录');
  return { ...player, tokenHash };
}

// 1-based rank; ties are broken by who reached the score first.
async function rankOf(db, { best_score, best_at }) {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM players WHERE best_score > ? OR (best_score = ? AND best_at < ?)')
    .bind(best_score, best_score, best_at)
    .first();
  return row.n + 1;
}

async function rateLimit(db, key, { limit, windowMs }, message) {
  const now = Date.now();
  const row = await db.prepare('SELECT window_start, count FROM rate_limits WHERE key = ?').bind(key).first();
  if (!row || now - row.window_start >= windowMs) {
    await db
      .prepare(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1`,
      )
      .bind(key, now)
      .run();
    return;
  }
  if (row.count >= limit) throw new ApiError(429, 'rate_limited', message);
  await db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').bind(key).run();
}

export function normalizeName(raw) {
  return typeof raw === 'string' ? raw.normalize('NFKC').trim() : '';
}

const guestKey = (name, tag) => `${name.toLowerCase()}#${tag}`;

function checkGuestName(raw, env) {
  const name = normalizeName(raw);
  const length = [...name].length;
  if (length < NAME_MIN || length > NAME_MAX) {
    throw new ApiError(400, 'bad_name', `名字需要 ${NAME_MIN}~${NAME_MAX} 个字`);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new ApiError(400, 'bad_name', '名字只能包含中文、英文字母、数字和 _ - ·');
  }
  // Reserved names only block exact matches (no impersonating "官方"); the
  // configurable BLOCKED_WORDS block any name that contains them.
  const lower = name.toLowerCase();
  const blocked = (env.BLOCKED_WORDS || '').split(',').map((w) => w.trim().toLowerCase());
  if (RESERVED.includes(lower) || blocked.some((w) => w && lower.includes(w))) {
    throw new ApiError(400, 'bad_name', '这个名字不能用，换一个吧');
  }
  return name;
}

// Only send players back to pages on an allowed origin (no open redirects).
function checkReturnTo(returnTo, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
  try {
    const url = new URL(returnTo);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && (allowed.includes(url.origin) || allowed.includes('*'))) {
      url.hash = '';
      return url.toString();
    }
  } catch {
    // fall through
  }
  const home = allowed.find((o) => o !== '*');
  if (!returnTo && home) return env.GAME_URL || `${home}/`;
  throw new ApiError(400, 'bad_return', '跳转地址不合法');
}

function redirectWith(target, params) {
  const url = new URL(target);
  url.hash = new URLSearchParams(params).toString();
  return new Response(null, { status: 302, headers: { Location: url.toString(), 'Cache-Control': 'no-store' } });
}

const callbackUrl = (request) => new URL(CALLBACK_PATH, request.url).toString();

function avatarUrl(template) {
  if (typeof template !== 'string' || !template) return null;
  const url = template.replace('{size}', '64');
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `${LINUXDO.site}${url}`;
  return url.startsWith('https://') ? url : null;
}

const clientIp = (request) => request.headers.get('CF-Connecting-IP') || 'unknown';

function int(value, min, max, field) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(400, 'bad_request', `参数 ${field} 不合法`);
  }
  return value;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, 'bad_request', '请求格式不对');
  }
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim());
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && (allowed.includes(origin) || allowed.includes('*'))) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}
