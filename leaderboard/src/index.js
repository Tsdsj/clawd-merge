// 合成大Clawd leaderboard API — a zero-dependency Cloudflare Worker backed by D1.
//
//   POST /api/register     { name }                        → { player, token }
//   GET  /api/me           (Bearer token)                  → { name, best, bestLevel, rank, games }
//   POST /api/session      (Bearer token)                  → { sessionId }
//   POST /api/score        (Bearer token) { sessionId, score, drops, maxLevel } → { best, rank, improved }
//   GET  /api/leaderboard  ?limit=50                       → { entries: [{ rank, name, score, level, at }] }
//
// Identity: registering a name returns a random secret token that the browser
// keeps; only its SHA-256 hash is stored. Names are unique case-insensitively.
// Anti-cheat is best-effort (a browser game can always be scripted): every
// score needs an unused server-issued session, the real time since the session
// started must fit the number of drops, and the score must be plausible for
// that many drops. Registration and submissions are rate limited.

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
const LEADERBOARD_MAX = 100;

const HOUR = 60 * 60 * 1000;
const LIMITS = {
  register: { limit: 5, windowMs: HOUR }, // per IP
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
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
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
    case 'GET /api/me':
      return me(request, env);
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

// ---------- handlers ----------

async function register(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  await rateLimit(env.DB, `register:${ip}`, LIMITS.register, '注册太频繁了，请一小时后再试');

  const { name: raw } = await readJson(request);
  const name = normalizeName(raw);
  validateName(name, env);
  const nameKey = name.toLowerCase();

  const taken = await env.DB.prepare('SELECT 1 FROM players WHERE name_key = ?').bind(nameKey).first();
  if (taken) throw new ApiError(409, 'name_taken', '这个名字已经被别人用了，换一个吧');

  const id = crypto.randomUUID();
  const token = randomToken();
  try {
    await env.DB.prepare(
      'INSERT INTO players (id, name, name_key, token_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(id, name, nameKey, await sha256(token), Date.now())
      .run();
  } catch (err) {
    // Lost a race against someone registering the same name at the same moment.
    if (String(err).includes('UNIQUE')) throw new ApiError(409, 'name_taken', '这个名字已经被别人用了，换一个吧');
    throw err;
  }
  return json({ player: { id, name }, token }, 201);
}

async function me(request, env) {
  const player = await authenticate(request, env);
  return json({
    name: player.name,
    best: player.best_score,
    bestLevel: player.best_level,
    games: player.games,
    rank: player.best_score > 0 ? await rankOf(env.DB, player) : null,
  });
}

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

  const improved = score > player.best_score;
  const statements = [
    env.DB.prepare(
      'INSERT INTO scores (player_id, score, max_level, drops, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(player.id, score, maxLevel, drops, elapsed, now),
    env.DB.prepare('UPDATE players SET games = games + 1 WHERE id = ?').bind(player.id),
  ];
  if (improved) {
    statements.push(
      env.DB.prepare('UPDATE players SET best_score = ?, best_level = ?, best_at = ? WHERE id = ?').bind(
        score,
        maxLevel,
        now,
        player.id,
      ),
    );
  }
  await env.DB.batch(statements);

  const best = improved ? { best_score: score, best_at: now } : player;
  return json({
    improved,
    best: best.best_score,
    rank: best.best_score > 0 ? await rankOf(env.DB, best) : null,
  });
}

async function leaderboard(url, env) {
  const limit = Math.min(LEADERBOARD_MAX, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const { results } = await env.DB.prepare(
    `SELECT name, best_score AS score, best_level AS level, best_at AS at
       FROM players WHERE best_score > 0
      ORDER BY best_score DESC, best_at ASC LIMIT ?`,
  )
    .bind(limit)
    .all();
  const entries = results.map((r, i) => ({ rank: i + 1, ...r }));
  return json({ entries }, 200, { 'Cache-Control': 'public, max-age=10' });
}

// ---------- helpers ----------

async function authenticate(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) throw new ApiError(401, 'unauthorized', '请先起一个名字');
  const player = await env.DB.prepare('SELECT * FROM players WHERE token_hash = ?').bind(await sha256(token)).first();
  if (!player) throw new ApiError(401, 'unauthorized', '身份已失效，请重新起名');
  return player;
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

function validateName(name, env) {
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
}

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
