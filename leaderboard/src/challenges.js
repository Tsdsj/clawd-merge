import { CHALLENGE_RULES_VERSION } from '../../src/rules.js';
const LIMIT = 3;
const DAY = 86400000;
const dayId = (now) => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
const rankSql = `SELECT COUNT(*) + 1 AS rank FROM challenge_bests b WHERE b.challenge_id = ? AND
  (b.score > ? OR (b.score = ? AND (b.best_at < ? OR (b.best_at = ? AND b.player_id < ?))))`;
function definition(row) {
  return {
    challengeId: row.id,
    rulesVersion: row.rules_version,
    count: row.drop_limit,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    submitUntil: row.submit_until,
    attemptLimit: LIMIT,
    settleSeconds: 8,
    stableSeconds: 0.75,
  };
}
function session(row) {
  return {
    sessionId: row.id,
    challengeId: row.challenge_id,
    rulesVersion: row.rules_version,
    playerId: row.player_id,
    attempt: row.attempt_no,
    startedAt: row.started_at,
    submitUntil: row.submit_until,
  };
}
async function ensureToday(db, now) {
  const id = dayId(now);
  let row = await db.prepare('SELECT * FROM challenge_definitions WHERE id = ?').bind(id).first();
  if (!row) {
    const start = Date.parse(`${id}T00:00:00+08:00`);
    await db
      .prepare(
        `INSERT OR IGNORE INTO challenge_definitions
      (id,rules_version,starts_at,ends_at,submit_until,drop_limit,created_at) VALUES (?,?,?,?,?,100,?)`,
      )
      .bind(id, CHALLENGE_RULES_VERSION, start, start + DAY, start + DAY + 600000, now)
      .run();
    row = await db.prepare('SELECT * FROM challenge_definitions WHERE id = ?').bind(id).first();
  }
  return row;
}
async function allowance(db, id, playerId) {
  const row = await db
    .prepare('SELECT used FROM challenge_allowances WHERE challenge_id=? AND player_id=?')
    .bind(id, playerId)
    .first();
  const used = row?.used || 0;
  return { playerId, limit: LIMIT, used, remaining: Math.max(0, LIMIT - used) };
}
async function personal(db, id, p, publicPlayer) {
  if (!p) return null;
  const best = await db
    .prepare('SELECT * FROM challenge_bests WHERE challenge_id=? AND player_id=?')
    .bind(id, p.id)
    .first();
  const rank = best
    ? (await db.prepare(rankSql).bind(id, best.score, best.score, best.best_at, best.best_at, p.id).first())
        .rank
    : null;
  return { player: publicPlayer(p), best: best?.score || 0, bestLevel: best?.max_level || 0, rank };
}
export async function challengeRoute(request, env, url, h) {
  const { ApiError, authenticate, int, readJson, rateLimit, publicPlayer } = h,
    db = env.DB;
  const respond = (data) => h.json(data, 200, { 'Cache-Control': 'no-store' });
  const fail = (status, code, message) => {
    throw new ApiError(status, code, message);
  };
  const bodyOf = async () => {
    const b = await readJson(request);
    if (!b || typeof b !== 'object' || Array.isArray(b)) fail(400, 'bad_request', '请求格式不对');
    return b;
  };
  const playerIfPresent = () => (request.headers.has('Authorization') ? authenticate(request, env) : null);
  const load = async (id) => {
    if (typeof id !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(id)) fail(400, 'bad_request', '题目标识不合法');
    if (id === dayId(Date.now())) await ensureToday(db, Date.now());
    const d = await db.prepare('SELECT * FROM challenge_definitions WHERE id=?').bind(id).first();
    if (!d) fail(404, 'challenge_not_found', '找不到这道挑战题目');
    return d;
  };
  switch (`${request.method} ${url.pathname.replace(/\/+$/, '')}`) {
    case 'GET /api/challenges/today': {
      const player = await playerIfPresent(),
        now = Date.now(),
        d = await ensureToday(db, now);
      return respond({
        challenge: definition(d),
        serverNow: now,
        allowance: player ? await allowance(db, d.id, player.id) : null,
        me: await personal(db, d.id, player, publicPlayer),
      });
    }
    case 'POST /api/challenges/session': {
      const p = await authenticate(request, env);
      await rateLimit(
        db,
        `challenge-session:${p.id}`,
        { limit: 120, windowMs: 3600000 },
        '开局请求太频繁，请稍后重试',
      );
      const body = await bodyOf();
      if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(body.requestId))
        fail(400, 'bad_request', '开局请求标识不合法');
      if (body.mode !== undefined && body.mode !== 'formal')
        fail(400, 'wrong_mode', '这个接口仅用于正式挑战');
      const find = () =>
        db.prepare('SELECT * FROM challenge_sessions WHERE request_id=?').bind(body.requestId).first();
      const response = async (row) => {
        if (
          row.player_id !== p.id ||
          row.challenge_id !== body.challengeId ||
          row.rules_version !== body.rulesVersion
        )
          fail(409, 'start_conflict', '这个开局请求已用于另一场对局');
        const d = await load(row.challenge_id);
        return respond({
          status: row.used ? 'used' : Date.now() >= row.submit_until ? 'expired' : 'valid',
          session: session(row),
          challenge: definition(d),
          serverNow: Date.now(),
          allowance: await allowance(db, d.id, p.id),
        });
      };
      const previous = await find();
      if (previous) return response(previous);
      const now = Date.now(),
        d = await ensureToday(db, now);
      if (body.challengeId !== d.id || now >= d.ends_at)
        fail(409, 'challenge_changed', '题目已更新，请重新获取今日挑战');
      if (body.rulesVersion !== d.rules_version) fail(409, 'rules_mismatch', '题目规则不匹配，请刷新后重试');
      const id = crypto.randomUUID();
      await db.batch([
        db
          .prepare(
            'INSERT OR IGNORE INTO challenge_allowances (challenge_id,player_id,used) SELECT ?,?,0 WHERE EXISTS(SELECT 1 FROM players WHERE id=?)',
          )
          .bind(d.id, p.id, p.id),
        db
          .prepare(
            `INSERT INTO challenge_sessions (id,request_id,challenge_id,rules_version,player_id,attempt_no,started_at,submit_until)
          SELECT ?,?,?,?,?,a.used+1,?,? FROM challenge_allowances a JOIN players owner ON owner.id=a.player_id WHERE a.challenge_id=? AND a.player_id=? AND a.used<?
          ON CONFLICT(request_id) DO NOTHING`,
          )
          .bind(id, body.requestId, d.id, d.rules_version, p.id, now, d.submit_until, d.id, p.id, LIMIT),
        db
          .prepare(
            `UPDATE challenge_allowances SET used=used+1 WHERE challenge_id=? AND player_id=?
          AND EXISTS(SELECT 1 FROM challenge_sessions WHERE id=?)`,
          )
          .bind(d.id, p.id, id),
      ]);
      const accepted = await find();
      if (!accepted && !(await db.prepare('SELECT id FROM players WHERE id=?').bind(p.id).first()))
        fail(401, 'unauthorized', '身份已变化，请重新登录');
      if (!accepted) fail(409, 'attempts_exhausted', '今日正式机会已经用完，仍可不限次练习');
      return response(accepted);
    }
    case 'GET /api/challenges/session/check': {
      const p = await authenticate(request, env),
        now = Date.now();
      const row = await db
        .prepare('SELECT * FROM challenge_sessions WHERE id=? AND player_id=?')
        .bind(url.searchParams.get('sessionId') || '', p.id)
        .first();
      if (!row) return respond({ status: 'invalid', serverNow: now, session: null, challenge: null });
      const d = await load(row.challenge_id);
      return respond({
        status: row.used ? 'used' : now >= row.submit_until ? 'expired' : 'valid',
        serverNow: now,
        session: session(row),
        challenge: definition(d),
      });
    }
    case 'POST /api/challenges/score': {
      const p = await authenticate(request, env);
      await rateLimit(
        db,
        `challenge-score:${p.id}`,
        { limit: 60, windowMs: 3600000 },
        '提交太频繁，请稍后重试',
      );
      const b = await bodyOf();
      if (b.mode !== 'formal') fail(400, 'wrong_mode', '练习成绩不能提交到正式挑战');
      const score = int(b.score, 0, 10000000, 'score'),
        drops = int(b.drops, 1, 100, 'drops'),
        level = int(b.maxLevel, 1, 11, 'maxLevel');
      const claws = int(b.clawsUsed, 0, 5, 'clawsUsed'),
        settling = int(b.settlingMs, 0, 8000, 'settlingMs');
      if (
        !['danger', 'limit'].includes(b.reason) ||
        (b.reason === 'limit' && (drops !== 100 || settling < 750)) ||
        (drops < 100 && settling !== 0) ||
        claws > Math.max(0, level - 6)
      )
        fail(422, 'implausible', '挑战结束状态或道具次数不合理');
      const read = () =>
        db
          .prepare('SELECT * FROM challenge_scores WHERE session_id=? AND player_id=?')
          .bind(b.sessionId || '', p.id)
          .first();
      const receipt = (row) => {
        if (
          row.challenge_id !== b.challengeId ||
          row.rules_version !== b.rulesVersion ||
          row.score !== score ||
          row.drops !== drops ||
          row.max_level !== level ||
          row.claws_used !== claws ||
          row.settling_ms !== settling ||
          row.reason !== b.reason
        )
          fail(409, 'score_conflict', '这局已接受了不同的结果，不能覆盖');
        return respond({
          sessionId: row.session_id,
          challengeId: row.challenge_id,
          rulesVersion: row.rules_version,
          improved: Boolean(row.improved),
          best: row.best,
          rank: row.rank,
        });
      };
      const previous = await read();
      if (previous) return receipt(previous);
      const s = await db
        .prepare('SELECT * FROM challenge_sessions WHERE id=? AND player_id=?')
        .bind(b.sessionId || '', p.id)
        .first();
      if (!s || s.used) {
        const raced = await read();
        if (raced) return receipt(raced);
        fail(400, 'bad_session', '正式挑战凭证无效');
      }
      if (s.challenge_id !== b.challengeId || s.rules_version !== b.rulesVersion)
        fail(409, 'rules_mismatch', '成绩与原题目或规则不匹配');
      const now = Date.now();
      if (now >= s.submit_until) fail(400, 'challenge_expired', '已超过这道题的正式提交截止时间');
      const minimum = drops * 500 * 0.9 - 3000;
      if (now - s.started_at < minimum || settling > now - s.started_at)
        fail(422, 'too_fast', '投放或结算耗时不合理');
      if (score > drops * 400 + 5000) fail(422, 'implausible', '分数与投放次数不合理');
      const attempt = crypto.randomUUID();
      await db.batch([
        db
          .prepare(
            `INSERT INTO challenge_scores (session_id,attempt_id,challenge_id,rules_version,player_id,score,drops,max_level,claws_used,settling_ms,reason,duration_ms,accepted_at,improved)
          SELECT s.id,?,s.challenge_id,s.rules_version,s.player_id,?,?,?,?,?,?,?-s.started_at,?,
          CASE WHEN ?>COALESCE((SELECT score FROM challenge_bests WHERE challenge_id=s.challenge_id AND player_id=s.player_id),0) THEN 1 ELSE 0 END
          FROM challenge_sessions s JOIN players owner ON owner.id=s.player_id WHERE s.id=? AND s.player_id=? AND s.used=0 AND s.submit_until>? AND s.started_at<=?
          ON CONFLICT(session_id) DO NOTHING`,
          )
          .bind(
            attempt,
            score,
            drops,
            level,
            claws,
            settling,
            b.reason,
            now,
            now,
            score,
            s.id,
            p.id,
            now,
            now - minimum,
          ),
        db
          .prepare(
            `UPDATE challenge_sessions SET used=1 WHERE id=? AND EXISTS(SELECT 1 FROM challenge_scores WHERE attempt_id=?)`,
          )
          .bind(s.id, attempt),
        db
          .prepare(
            `INSERT INTO challenge_bests (challenge_id,player_id,score,max_level,best_at)
          SELECT challenge_id,player_id,score,max_level,accepted_at FROM challenge_scores WHERE attempt_id=? AND score>0
          ON CONFLICT(challenge_id,player_id) DO UPDATE SET score=excluded.score,max_level=excluded.max_level,best_at=excluded.best_at
          WHERE excluded.score>challenge_bests.score`,
          )
          .bind(attempt),
        db
          .prepare(
            `UPDATE challenge_scores SET best=COALESCE((SELECT score FROM challenge_bests WHERE challenge_id=challenge_scores.challenge_id AND player_id=challenge_scores.player_id),0),
          rank=(SELECT CASE WHEN p.score>0 THEN 1+(SELECT COUNT(*) FROM challenge_bests q WHERE q.challenge_id=p.challenge_id AND
          (q.score>p.score OR (q.score=p.score AND (q.best_at<p.best_at OR (q.best_at=p.best_at AND q.player_id<p.player_id))))) ELSE NULL END
          FROM challenge_bests p WHERE p.challenge_id=challenge_scores.challenge_id AND p.player_id=challenge_scores.player_id)
          WHERE attempt_id=?`,
          )
          .bind(attempt),
      ]);
      const accepted = await read();
      if (!accepted && !(await db.prepare('SELECT id FROM players WHERE id=?').bind(p.id).first()))
        fail(401, 'unauthorized', '身份已变化，请重新登录');
      if (!accepted) fail(409, 'submission_race', '未确认本局结果，请用相同请求重试');
      return receipt(accepted);
    }
    case 'GET /api/challenges/leaderboard': {
      const p = await playerIfPresent(),
        d = await load(url.searchParams.get('challengeId'));
      const limit = Math.min(
        100,
        Math.max(1, Number.parseInt(url.searchParams.get('limit') || '20', 10) || 20),
      );
      const rows = await db
        .prepare(
          `SELECT p.*, b.score,b.max_level,b.best_at FROM challenge_bests b JOIN players p ON p.id=b.player_id
        WHERE b.challenge_id=? AND b.score>0 ORDER BY b.score DESC,b.best_at ASC,b.player_id ASC LIMIT ?`,
        )
        .bind(d.id, limit)
        .all();
      const total = (
        await db
          .prepare('SELECT COUNT(*) n FROM challenge_bests WHERE challenge_id=? AND score>0')
          .bind(d.id)
          .first()
      ).n;
      const me = await personal(db, d.id, p, publicPlayer);
      return respond({
        challenge: definition(d),
        entries: rows.results.map((row, i) => ({
          ...publicPlayer(row),
          score: row.score,
          level: row.max_level,
          rank: i + 1,
        })),
        total,
        me,
        serverNow: Date.now(),
      });
    }
    default:
      fail(404, 'not_found', '接口不存在');
  }
}

export function mergeChallengeStatements(db, to, from) {
  // OAuth resolves the canonical player in the same transaction that creates
  // or promotes it. Only a still-existing guest may contribute data; promotion
  // in place and a second callback must not add the same allowance twice.
  const canonical = typeof to === 'object' && to !== null;
  const target = canonical ? '(SELECT id FROM players WHERE linuxdo_id = ?)' : '?';
  const destination = canonical ? to.linuxdoId : to;
  const guard = canonical ? ' AND EXISTS (SELECT 1 FROM players WHERE id = ? AND linuxdo_id IS NULL)' : '';
  const source = canonical ? [from, from] : [from];
  return [
    db
      .prepare(
        `INSERT INTO challenge_allowances (challenge_id,player_id,used) SELECT challenge_id,${target},used FROM challenge_allowances WHERE player_id=?${guard}
      ON CONFLICT(challenge_id,player_id) DO UPDATE SET used=challenge_allowances.used+excluded.used`,
      )
      .bind(destination, ...source),
    db.prepare(`DELETE FROM challenge_allowances WHERE player_id=?${guard}`).bind(...source),
    db.prepare(`UPDATE challenge_sessions SET player_id=${target} WHERE player_id=?${guard}`).bind(destination, ...source),
    db.prepare(`UPDATE challenge_scores SET player_id=${target} WHERE player_id=?${guard}`).bind(destination, ...source),
    db
      .prepare(
        `INSERT INTO challenge_bests (challenge_id,player_id,score,max_level,best_at)
      SELECT challenge_id,${target},score,max_level,best_at FROM challenge_bests WHERE player_id=?${guard}
      ON CONFLICT(challenge_id,player_id) DO UPDATE SET score=excluded.score,max_level=excluded.max_level,best_at=excluded.best_at
      WHERE excluded.score>challenge_bests.score OR (excluded.score=challenge_bests.score AND excluded.best_at<challenge_bests.best_at)`,
      )
      .bind(destination, ...source),
    db.prepare(`DELETE FROM challenge_bests WHERE player_id=?${guard}`).bind(...source),
  ];
}
