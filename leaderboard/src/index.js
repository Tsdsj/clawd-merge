import { challengeRoute, mergeChallengeStatements } from './challenges.js';
import { AUTH_QUERY, sessionCurrent, accountState } from './account-state.js';
import { checkName, displayName, NAME_POLICY_VERSION } from './name-policy.js';
export { normalizeName } from './name-policy.js';
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
      return json(body, status, { ...cors, ...(err.retryAfter ? { 'Retry-After':String(err.retryAfter) } : {}) });
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname.replace(/\/+$/, '')}`;
  if(url.pathname.startsWith('/api/challenges/'))return challengeRoute(request,env,url,{ApiError,json,int,readJson,authenticate,rateLimit,publicPlayer:p=>publicPlayer(p,env)});
  const passwordPaths = new Set(['/api/auth/operations','/api/auth/operations/result','/api/auth/operations/cancel','/api/auth/password/register','/api/auth/password/login','/api/auth/password/recover','/api/account/password','/api/account/reauth','/api/account/recovery-code']);
  if (request.method === 'POST' && passwordPaths.has(url.pathname)) {
    if (!env.PASSWORD_AUTH?.available) throw new ApiError(503,'password_auth_disabled','密码服务暂不可用，请稍后再试');
    return env.PASSWORD_AUTH.handle(request,env,{ApiError,json,publicPlayer:p=>publicPlayer(p,env)});
  }
  switch (key) {
    case 'GET /api/auth/capabilities':
      return json({passwordEnabled:Boolean(env.PASSWORD_AUTH?.available),registrationEnabled:Boolean(env.PASSWORD_AUTH?.available&&NAME_POLICY_VERSION),linuxdoEnabled:Boolean(env.LINUXDO_CLIENT_ID&&env.LINUXDO_CLIENT_SECRET),oauthAccountActions:false,serverNow:Date.now()},200,{'Cache-Control':'no-store'});
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
    case 'GET /api/session/check':
      return checkSession(request, env, url);
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
      `INSERT INTO players (id, name, name_key, tag, token_hash, created_at, name_policy_version, name_policy_status) VALUES (?, ?, ?, ?, ?, ?, ?, 'allowed')`,
    ).bind(id, name, guestKey(name, tag), tag, tokenHash, now, NAME_POLICY_VERSION),
    env.DB.prepare('INSERT INTO tokens (token_hash, player_id, created_at) VALUES (?, ?, ?)').bind(tokenHash, id, now),
  ]);
  return json({ player: publicPlayer({ id, name, tag }, env), token }, 201);
}

async function rename(request, env) {
  const player = await authenticate(request, env);
  if (player.linuxdo_id != null) throw new ApiError(400, 'linuxdo_name', 'LINUX DO 账号的名字跟随 L 站用户名，不能在这里改');
  await rateLimit(env.DB, `rename:${player.id}`, LIMITS.rename, '今天改名次数用完了，明天再来');
  const name = checkGuestName((await readJson(request)).name, env);
  const tag = await insertWithFreeTag(env.DB, name, (tag) => [
    env.DB.prepare(`UPDATE players SET name = ?, name_key = ?, tag = ?, name_policy_version = ?, name_policy_status = 'allowed' WHERE id = ? AND linuxdo_id IS NULL`).bind(
      name,
      guestKey(name, tag),
      tag,
      NAME_POLICY_VERSION,
      player.id,
    ),
  ], { requireChange: true });
  return json({ player: publicPlayer({ ...player, name, tag }, env) });
}

// Runs `statements(tag)` with a random free 4-digit tag, retrying on collisions.
async function insertWithFreeTag(db, name, statements, { requireChange = false } = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const tag = String(crypto.getRandomValues(new Uint16Array(1))[0] % 10000).padStart(4, '0');
    try {
      const result = await db.batch(statements(tag));
      if (requireChange && result[0]?.meta?.changes !== 1) throw new ApiError(409, 'identity_changed', '账号已变化，请刷新账号资料后重试');
      return tag;
    } catch (err) {
      if (!String(err).includes('UNIQUE')) throw err;
    }
  }
  throw new ApiError(409, 'name_crowded', '这个名字用的人太多了，换一个吧');
}

async function logout(request, env) {
  const { tokenHash } = await authenticate(request, env);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tokens WHERE token_hash=?').bind(tokenHash),
    env.DB.prepare('DELETE FROM oauth_states WHERE source_token_hash=?').bind(tokenHash),
    env.DB.prepare('DELETE FROM login_codes WHERE source_token_hash=?').bind(tokenHash),
    env.DB.prepare("UPDATE auth_operations SET status='stale' WHERE actor_token_hash=? AND status!='complete'").bind(tokenHash),
  ]);
  return json({ ok: true });
}

async function me(request, env) {
  const player = await authenticate(request, env);
  const hasRecovery=await env.DB.prepare('SELECT 1 FROM recovery_codes WHERE player_id=?').bind(player.id).first();
  return json({
    ...accountState(player,hasRecovery,{passwordEnabled:Boolean(env.PASSWORD_AUTH?.available),linuxdoEnabled:Boolean(env.LINUXDO_CLIENT_ID&&env.LINUXDO_CLIENT_SECRET),namingEnabled:Boolean(NAME_POLICY_VERSION)}),
    player: publicPlayer(player, env),
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
  if(guest?.credential_player_id)throw new ApiError(409,'credentials_exist','请使用账号面板的绑定入口；切换账号请先退出');

  const state = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE created_at < ?').bind(now - OAUTH_STATE_TTL_MS),
    env.DB.prepare(
      'INSERT INTO oauth_states (state_hash, merge_player_id, return_to, created_at, source_player_id, source_token_hash, auth_version, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(await sha256(state), guest && guest.linuxdo_id == null ? guest.id : null, safeReturn, now, guest?.id??null, guest?.tokenHash??null, guest?.auth_version??null, now+OAUTH_STATE_TTL_MS),
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
    const sourceValid=async(targetId=null)=>{
      if(!row.source_player_id&&!row.merge_player_id)return true;
      if(!row.source_token_hash)return false;
      const source=await env.DB.prepare(AUTH_QUERY).bind(row.source_token_hash).first();
      if(!sessionCurrent(source))return false;
      if(targetId)return source.id===targetId&&source.linuxdo_id===Number(user.id);
      if(source.id===row.source_player_id)return source.auth_version===row.auth_version&&!source.credential_player_id&&(source.linuxdo_id==null||source.linuxdo_id===Number(user.id));
      return source.linuxdo_id===Number(user.id)&&!await env.DB.prepare('SELECT id FROM players WHERE id=?').bind(row.source_player_id).first();
    };
    if(!await sourceValid())throw new ApiError(409,'identity_changed','账号已变化，请重新发起登录');
    const playerId = await upsertLinuxdoPlayer(env.DB, user, row.merge_player_id, row);
    if(!await sourceValid(playerId))throw new ApiError(409,'identity_changed','账号已变化，请重新发起登录');
    const version=(await env.DB.prepare('SELECT auth_version FROM players WHERE id=?').bind(playerId).first()).auth_version;
    const loginCode = randomToken(), codeHash=await sha256(loginCode), now=Date.now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM login_codes WHERE created_at < ?').bind(now-LOGIN_CODE_TTL_MS),
      env.DB.prepare(`INSERT INTO login_codes(code_hash,player_id,created_at,auth_version,source_token_hash,expires_at)
        SELECT ?,id,?,auth_version,?,? FROM players WHERE id=? AND auth_version=?
        AND (? IS NULL OR EXISTS(SELECT 1 FROM tokens t WHERE t.token_hash=? AND t.player_id=players.id AND t.auth_version=players.auth_version AND (t.expires_at IS NULL OR t.expires_at>?)))`)
        .bind(codeHash,now,row.source_token_hash,now+LOGIN_CODE_TTL_MS,playerId,version,row.source_token_hash,row.source_token_hash,now),
    ]);
    if(!await env.DB.prepare('SELECT code_hash FROM login_codes WHERE code_hash=?').bind(codeHash).first())throw new ApiError(409,'identity_changed','账号已变化，请重新登录');
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
async function upsertLinuxdoPlayer(db, user, mergeGuestId, source) {
  const linuxdoId=Number(user.id),guestId=mergeGuestId||null,claimId=crypto.randomUUID();
  const fields=[String(user.username).slice(0,40),avatarUrl(user.avatar_template),Number(user.trust_level)||0];
  const tokenHash=await sha256(randomToken()),now=Date.now();
  const target='(SELECT id FROM players WHERE linuxdo_id = ?)';
  const permitted='EXISTS(SELECT 1 FROM oauth_operation_claims WHERE claim_id=?)';
  const stillGuest='EXISTS(SELECT 1 FROM players g WHERE g.id=? AND g.linuxdo_id IS NULL AND NOT EXISTS(SELECT 1 FROM password_credentials c WHERE c.player_id=g.id)) AND '+permitted;
  // Admission and every mutation are in one transaction. Rechecking the source
  // token after moving it would break the rest of the batch, so keep a short-lived
  // claim until all transfers have finished. Failed batches roll the claim back.
  const results=await db.batch([
    db.prepare(`INSERT INTO oauth_operation_claims(claim_id) SELECT ? WHERE ? IS NULL OR EXISTS(
      SELECT 1 FROM tokens t JOIN players p ON p.id=t.player_id WHERE t.token_hash=?
      AND t.auth_version=p.auth_version AND (t.expires_at IS NULL OR t.expires_at>?)
      AND (p.linuxdo_id IS NULL OR p.linuxdo_id=?) AND (
        (p.id=? AND p.auth_version=? AND NOT EXISTS(SELECT 1 FROM password_credentials c WHERE c.player_id=p.id)) OR
        (p.id!=? AND p.linuxdo_id=? AND NOT EXISTS(SELECT 1 FROM players original WHERE original.id=?))))`)
      .bind(claimId,source.source_token_hash,source.source_token_hash,now,linuxdoId,source.source_player_id,source.auth_version,source.source_player_id,linuxdoId,source.source_player_id),
    db.prepare(`UPDATE players SET linuxdo_id = ?, name_key = ?, tag = NULL WHERE id=? AND linuxdo_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM password_credentials c WHERE c.player_id=players.id)
      AND NOT EXISTS(SELECT 1 FROM players WHERE linuxdo_id=?) AND ${permitted}`)
      .bind(linuxdoId,`ld:${linuxdoId}`,guestId,linuxdoId,claimId),
    db.prepare(`INSERT INTO players(id,name,name_key,token_hash,avatar,trust_level,linuxdo_id,created_at)
      SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM players WHERE linuxdo_id=?) AND ${permitted}`)
      .bind(crypto.randomUUID(),fields[0],`ld:${linuxdoId}`,tokenHash,fields[1],fields[2],linuxdoId,now,linuxdoId,claimId),
    db.prepare(`UPDATE players SET name=CASE WHEN EXISTS(SELECT 1 FROM password_credentials c WHERE c.player_id=players.id) THEN name ELSE ? END,
      avatar=?,trust_level=?,display_name_source=CASE WHEN EXISTS(SELECT 1 FROM password_credentials c WHERE c.player_id=players.id) THEN 'local' ELSE 'linuxdo' END,
      name_policy_status='unreviewed' WHERE linuxdo_id=? AND ${permitted}`).bind(...fields,linuxdoId,claimId),
    db.prepare(`UPDATE players SET (best_score,best_level,best_at)=(SELECT best_score,best_level,best_at FROM players WHERE id=?)
      WHERE linuxdo_id=? AND EXISTS(SELECT 1 FROM players g WHERE g.id=? AND
        (g.best_score>players.best_score OR (g.best_score=players.best_score AND g.best_score>0 AND g.best_at<players.best_at))) AND ${stillGuest}`)
      .bind(guestId,linuxdoId,guestId,guestId,claimId),
    db.prepare(`UPDATE players SET games=games+(SELECT games FROM players WHERE id=?) WHERE linuxdo_id=? AND ${stillGuest}`).bind(guestId,linuxdoId,guestId,claimId),
    ...['scores','score_receipts','tokens','sessions'].map(table=>db.prepare(`UPDATE ${table} SET player_id=${target} WHERE player_id=? AND ${stillGuest}`).bind(linuxdoId,guestId,guestId,claimId)),
    ...mergeChallengeStatements(db,{linuxdoId,claimId},guestId),
    db.prepare(`DELETE FROM players WHERE id=? AND linuxdo_id IS NULL AND NOT EXISTS(SELECT 1 FROM password_credentials c WHERE c.player_id=players.id) AND ${permitted}`).bind(guestId,claimId),
    db.prepare(`UPDATE tokens SET auth_method='linuxdo',auth_version=(SELECT auth_version FROM players WHERE id=tokens.player_id),expires_at=COALESCE(expires_at,?) WHERE player_id=${target} AND auth_method IN ('guest','legacy') AND ${permitted}`).bind(now+30*DAY,linuxdoId,claimId),
    db.prepare('DELETE FROM oauth_operation_claims WHERE claim_id=?').bind(claimId),
  ]);
  if(results[0]?.meta?.changes!==1)throw new ApiError(409,'identity_changed','账号已变化，请重新登录');
  return (await db.prepare('SELECT id FROM players WHERE linuxdo_id=?').bind(linuxdoId).first()).id;
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
  const token = randomToken(), tokenHash=await sha256(token), now=Date.now();
  await env.DB.prepare(`INSERT INTO tokens(token_hash,player_id,created_at,auth_method,auth_version,authenticated_at,expires_at)
    SELECT ?,id,?,'linuxdo',auth_version,?,? FROM players WHERE id=? AND auth_version=?
    AND (? IS NULL OR EXISTS(SELECT 1 FROM tokens old WHERE old.token_hash=? AND old.player_id=players.id AND old.auth_version=players.auth_version AND (old.expires_at IS NULL OR old.expires_at>?)))`)
    .bind(tokenHash,now,now,now+30*DAY,row.player_id,row.auth_version??0,row.source_token_hash,row.source_token_hash,now).run();
  const player=await env.DB.prepare(AUTH_QUERY).bind(tokenHash).first();
  if(!sessionCurrent(player))throw new ApiError(400,'bad_login_code','登录已过期，请重新登录');
  const hasRecovery=await env.DB.prepare('SELECT 1 FROM recovery_codes WHERE player_id=?').bind(player.id).first();
  return json({player:publicPlayer(player,env),token,...accountState(player,hasRecovery,{passwordEnabled:Boolean(env.PASSWORD_AUTH?.available),linuxdoEnabled:true,namingEnabled:Boolean(NAME_POLICY_VERSION)})});
}

// ---------- game ----------

async function startSession(request, env) {
  // Older clients send an empty POST; Cloudflare may expose it as a non-null stream.
  const raw = await request.text();
  if (raw.trim()) {
    let body;
    try { body = JSON.parse(raw); } catch { throw new ApiError(400,'bad_request','请求格式不对'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400,'bad_request','请求格式不对');
    if ((body.mode !== undefined && body.mode !== 'classic') || body.challengeId !== undefined)
      throw new ApiError(400,'wrong_mode','挑战需使用独立开局接口');
  }
  const player = await authenticate(request, env);
  await rateLimit(env.DB, `session:${player.id}`, LIMITS.session, '操作太频繁了，请稍后再试');
  const now = Date.now();
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE player_id = ? AND (used = 1 OR started_at < ?)').bind(
      player.id,
      now - SESSION_TTL_MS,
    ),
    env.DB.prepare('INSERT INTO sessions (id, player_id, started_at) SELECT ?, id, ? FROM players WHERE id = ?').bind(id, now, player.id),
  ]);
  if (!await env.DB.prepare('SELECT id FROM sessions WHERE id = ? AND player_id = ?').bind(id, player.id).first()) {
    throw new ApiError(409, 'identity_changed', '账号已变化，请刷新账号资料后重新开局');
  }
  return json({ sessionId: id });
}

async function checkSession(request, env, url) {
  const player = await authenticate(request, env);
  const id = url.searchParams.get('sessionId');
  const session = await env.DB.prepare('SELECT started_at, used FROM sessions WHERE id = ? AND player_id = ?')
    .bind(id || '', player.id).first();
  const serverNow = Date.now();
  const expiresAt = session ? session.started_at + SESSION_TTL_MS : null;
  const status = !session ? 'invalid' : session.used ? 'used' : serverNow >= expiresAt ? 'expired' : 'valid';
  return json({ status, serverNow, expiresAt }, 200, { 'Cache-Control':'no-store' });
}

async function submitScore(request, env) {
  const player = await authenticate(request, env);
  await rateLimit(env.DB, `score:${player.id}`, LIMITS.score, '提交太频繁了，请稍后再试');
  const body = await readJson(request);
  if(body?.mode!==undefined&&body.mode!=='classic'||body?.challengeId!==undefined)throw new ApiError(400,'wrong_mode','挑战需使用独立成绩接口');
  const score = int(body.score, 0, 10_000_000, 'score');
  const drops = int(body.drops, 1, MAX_DROPS, 'drops');
  const maxLevel = int(body.maxLevel, 1, MAX_LEVEL, 'maxLevel');
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  const readReceipt = () => env.DB.prepare('SELECT * FROM score_receipts WHERE session_id = ? AND player_id = ?')
    .bind(sessionId, player.id).first();
  const respond = (receipt) => {
    if (receipt.score !== score || receipt.drops !== drops || receipt.max_level !== maxLevel) {
      throw new ApiError(409, 'score_conflict', '这局已经接受了不同的成绩，不能覆盖');
    }
    return json({ improved: Boolean(receipt.improved), best: receipt.best, rank: receipt.rank });
  };
  // A replay is valid even after session cleanup/expiry. Never count it again.
  const previous = await readReceipt();
  if (previous) return respond(previous);

  const now = Date.now();
  const session = await env.DB.prepare('SELECT started_at, used FROM sessions WHERE id = ? AND player_id = ?')
    .bind(sessionId, player.id).first();
  if (!session || session.used) {
    // Another request may have committed between the two reads.
    const raced = await readReceipt();
    if (raced) return respond(raced);
    throw new ApiError(400, 'bad_session', '这局的成绩凭证无效，请重新开一局');
  }
  const elapsed = now - session.started_at;
  if (elapsed > SESSION_TTL_MS) throw new ApiError(400, 'session_expired', '这局太久了，成绩凭证已过期');
  const minimumDuration = drops * DROP_COOLDOWN_MS * 0.9 - 3000;
  if (elapsed < minimumDuration) throw new ApiError(422, 'too_fast', '成绩异常：投放速度超出了游戏允许的范围');
  if (score > drops * MAX_POINTS_PER_DROP + 5000) throw new ApiError(422, 'implausible', '成绩异常：分数和投放次数对不上');

  // Only the request that inserted this attempt can perform dependent writes.
  // Unique session_id plus a single D1 transaction handles concurrent retries.
  const attempt = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO score_receipts
      (session_id, player_id, attempt_id, score, drops, max_level, duration_ms, accepted_at, improved)
      SELECT s.id, p.id, ?, ?, ?, ?, ? - s.started_at, ?, CASE WHEN ? > p.best_score THEN 1 ELSE 0 END
      FROM sessions s JOIN players p ON p.id = s.player_id
      WHERE s.id = ? AND p.id = ? AND s.used = 0 AND s.started_at >= ? AND s.started_at <= ?
      ON CONFLICT(session_id) DO NOTHING`)
      .bind(attempt, score, drops, maxLevel, now, now, score, sessionId, player.id, now - SESSION_TTL_MS, now - minimumDuration),
    env.DB.prepare(`UPDATE sessions SET used = 1 WHERE id = ?
      AND EXISTS (SELECT 1 FROM score_receipts WHERE attempt_id = ?)`)
      .bind(sessionId, attempt),
    env.DB.prepare(`INSERT INTO scores (player_id, score, max_level, drops, duration_ms, created_at)
      SELECT player_id, score, max_level, drops, duration_ms, accepted_at FROM score_receipts WHERE attempt_id = ?`)
      .bind(attempt),
    env.DB.prepare(`UPDATE players SET games = games + 1 WHERE id = ?
      AND EXISTS (SELECT 1 FROM score_receipts WHERE attempt_id = ?)`)
      .bind(player.id, attempt),
    env.DB.prepare(`UPDATE players SET best_score = ?, best_level = ?, best_at = ? WHERE id = ? AND best_score < ?
      AND EXISTS (SELECT 1 FROM score_receipts WHERE attempt_id = ?)`)
      .bind(score, maxLevel, now, player.id, score, attempt),
    env.DB.prepare(`UPDATE score_receipts SET
      best = (SELECT best_score FROM players WHERE id = score_receipts.player_id),
      rank = (SELECT CASE WHEN p.best_score > 0 THEN 1 +
        (SELECT COUNT(*) FROM players q WHERE q.best_score > p.best_score OR (q.best_score = p.best_score
          AND (q.best_at < p.best_at OR (q.best_at = p.best_at AND q.id < p.id))))
        ELSE NULL END FROM players p WHERE p.id = score_receipts.player_id)
      WHERE attempt_id = ?`).bind(attempt),
  ]);
  const accepted = await readReceipt();
  if (!accepted) throw new ApiError(400, 'bad_session', '这局的成绩凭证无效，请重新开一局');
  return respond(accepted);
}

async function leaderboard(url, env) {
  const limit = Math.min(LEADERBOARD_MAX, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const [{ results }, count] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, tag, avatar, trust_level, linuxdo_id, public_alias, best_score AS score, best_level AS level, best_at AS at
         FROM players WHERE best_score > 0
        ORDER BY best_score DESC, best_at ASC, id ASC LIMIT ?`,
    )
      .bind(limit)
      .all(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM players WHERE best_score > 0').first(),
  ]);
  const entries = results.map((r, i) => ({
    rank: i + 1,
    ...publicPlayer(r, env),
    score: r.score,
    level: r.level,
    at: r.at,
  }));
  return json({ entries, total: count.n }, 200, { 'Cache-Control': 'public, max-age=10' });
}

// ---------- helpers ----------

// What other players may see about a player. `id` is an opaque handle used by
// the client to highlight its own row; it grants nothing without a token.
function publicPlayer(p, env = {}) {
  const linuxdo = p.linuxdo_id != null;
  return {
    id: p.id,
    name: displayName(p, { blockedWords: env.BLOCKED_WORDS }),
    tag: p.tag ?? null,
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
    AUTH_QUERY,
  )
    .bind(tokenHash)
    .first();
  if (!sessionCurrent(player)) throw new ApiError(401, 'unauthorized', '登录已失效，请重新登录');
  return { ...player, tokenHash };
}

// 1-based rank; ties use first achievement time, then stable player ID.
async function rankOf(db, { best_score, best_at, id }) {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM players WHERE best_score > ? OR (best_score = ? AND (best_at < ? OR (best_at = ? AND id < ?)))')
    .bind(best_score, best_score, best_at, best_at, id)
    .first();
  return row.n + 1;
}

async function rateLimit(db, key, { limit, windowMs }, message) {
  const now = Date.now();
  const expiresBefore = now - windowMs;
  const accepted = await db.prepare(`INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET
      window_start = CASE WHEN rate_limits.window_start <= ? THEN excluded.window_start ELSE rate_limits.window_start END,
      count = CASE WHEN rate_limits.window_start <= ? THEN 1 ELSE rate_limits.count + 1 END
    WHERE rate_limits.window_start <= ? OR rate_limits.count < ?
    RETURNING window_start, count`).bind(key, now, expiresBefore, expiresBefore, expiresBefore, limit).first();
  if (accepted) return;
  // This read affects only the retry hint; admission above is already atomic.
  const row = await db.prepare('SELECT window_start FROM rate_limits WHERE key = ?').bind(key).first();
  const error = new ApiError(429, 'rate_limited', message);
  error.retryAfter = row ? Math.max(1, Math.ceil((row.window_start + windowMs - now) / 1000)) : 1;
  throw error;
}

const guestKey = (name, tag) => `${name.toLowerCase()}#${tag}`;

function checkGuestName(raw, env) {
  const result = checkName(raw, { blockedWords: env.BLOCKED_WORDS });
  if (!result.ok) throw new ApiError(result.status, result.error,
    result.error === 'name_policy_unavailable' ? '名称校验暂不可用，请稍后再试' : '名字格式不符合要求或暂不可用，请换一个名字');
  return result.name;
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
    'Access-Control-Expose-Headers': 'Retry-After',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && (allowed.includes(origin) || allowed.includes('*'))) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers },
  });
}
