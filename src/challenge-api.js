import { challengeSequence } from './challenge.js';
import { challengeReceiptFields } from './challenge-result.js';
const id = (v) => typeof v === 'string' && v.length > 0 && v.length <= 128;
const integer = (v, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(v) && v >= min && v <= max;
export class ChallengeClientError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const invalid = () => {
  throw new ChallengeClientError('bad_response', '服务器返回的挑战信息不完整，请重试');
};
export function serverDefinition(v) {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v.challengeId)) invalid();
  try {
    challengeSequence(v);
  } catch {
    invalid();
  }
  const start = Date.parse(`${v.challengeId}T00:00:00+08:00`);
  if (
    !Number.isFinite(start) ||
    new Date(start + 28800000).toISOString().slice(0, 10) !== v.challengeId ||
    !integer(v.startsAt) ||
    v.startsAt !== start ||
    v.endsAt !== start + 86400000 ||
    v.submitUntil !== v.endsAt + 600000 ||
    v.attemptLimit !== 3 ||
    v.settleSeconds !== 8 ||
    v.stableSeconds !== 0.75
  )
    invalid();
  return Object.freeze({
    challengeId: v.challengeId,
    rulesVersion: v.rulesVersion,
    count: v.count,
    startsAt: v.startsAt,
    endsAt: v.endsAt,
    submitUntil: v.submitUntil,
    attemptLimit: 3,
    settleSeconds: 8,
    stableSeconds: 0.75,
  });
}
export function serverTicket(v, definition) {
  if (
    !v ||
    !id(v.sessionId) ||
    !id(v.playerId) ||
    !integer(v.attempt, 1, 3) ||
    !integer(v.startedAt) ||
    !integer(v.submitUntil) ||
    v.challengeId !== definition.challengeId ||
    v.rulesVersion !== definition.rulesVersion ||
    v.startedAt < definition.startsAt ||
    v.startedAt >= definition.endsAt ||
    v.submitUntil !== definition.submitUntil
  )
    invalid();
  return {
    sessionId: v.sessionId,
    playerId: v.playerId,
    challengeId: v.challengeId,
    rulesVersion: v.rulesVersion,
    attempt: v.attempt,
    startedAt: v.startedAt,
    submitUntil: v.submitUntil,
  };
}
function allowance(v, player) {
  if (!player) {
    if (v !== null) invalid();
    return null;
  }
  if (
    !v ||
    v.playerId !== player.id ||
    v.limit !== 3 ||
    !integer(v.used) ||
    v.remaining !== Math.max(0, 3 - v.used)
  )
    invalid();
  return { playerId: v.playerId, limit: 3, used: v.used, remaining: v.remaining };
}
export class ChallengeApi {
  constructor({ request, getPlayer, storage = null, scope = '', monotonic = () => performance.now() }) {
    Object.assign(this, { request, getPlayer, storage, monotonic });
    this.cacheKey = `clawd-merge:challenge-cache:${scope}`;
    this.data = null;
  }
  get formalAvailable() {
    return Boolean(this.data && this.now() < this.data.challenge.endsAt);
  }
  now() {
    return this.clock ? this.clock.serverNow + Math.max(0, this.monotonic() - this.clock.at) : null;
  }
  observe(now) {
    if (!integer(now)) invalid();
    this.clock = { serverNow: now, at: this.monotonic() };
  }
  unchanged(player) {
    if ((this.getPlayer()?.id || null) !== (player?.id || null))
      throw new ChallengeClientError('identity_changed', '身份已变化，请切回原身份继续', 409);
  }
  cached() {
    try {
      return serverDefinition(JSON.parse(this.storage?.getItem(this.cacheKey) || 'null'));
    } catch {
      return null;
    }
  }
  async today() {
    const player = this.getPlayer(),
      data = await this.request('/api/challenges/today', { token: player?.token });
    this.unchanged(player);
    const challenge = serverDefinition(data.challenge),
      budget = allowance(data.allowance, player);
    this.observe(data.serverNow);
    if (player && data.me && data.me.player?.id !== player.id) invalid();
    this.data = { challenge, allowance: budget, serverNow: data.serverNow, me: data.me || null };
    try {
      const old = this.cached();
      if (!old || old.challengeId <= challenge.challengeId)
        this.storage?.setItem(this.cacheKey, JSON.stringify(challenge));
    } catch {
      /* Practice can continue without a cache. */
    }
    return this.data;
  }
  async start(intent) {
    const player = this.getPlayer();
    if (!player || player.id !== intent.playerId)
      throw new ChallengeClientError('identity', '请先切回领取这次机会的原身份', 401);
    const data = await this.request('/api/challenges/session', {
      method: 'POST',
      token: player.token,
      body: {
        mode: 'formal',
        challengeId: intent.challengeId,
        rulesVersion: intent.rulesVersion,
        requestId: intent.requestId,
      },
    });
    this.unchanged(player);
    if (!['valid', 'used', 'expired'].includes(data.status)) invalid();
    const challenge = serverDefinition(data.challenge),
      session = serverTicket(data.session, challenge);
    if (
      session.playerId !== player.id ||
      session.challengeId !== intent.challengeId ||
      session.rulesVersion !== intent.rulesVersion
    )
      invalid();
    this.observe(data.serverNow);
    return {
      status: data.status,
      challenge,
      session,
      serverNow: data.serverNow,
      allowance: allowance(data.allowance, player),
    };
  }
  async check(ticket) {
    const player = this.getPlayer();
    if (!player || player.id !== ticket.playerId) return { status: 'identity' };
    const data = await this.request(
      `/api/challenges/session/check?sessionId=${encodeURIComponent(ticket.sessionId)}`,
      { token: player.token },
    );
    this.unchanged(player);
    if (!['valid', 'expired', 'used', 'invalid'].includes(data.status)) invalid();
    this.observe(data.serverNow);
    if (data.status === 'invalid') return data;
    const challenge = serverDefinition(data.challenge),
      session = serverTicket(data.session, challenge);
    if (
      ['sessionId', 'playerId', 'challengeId', 'rulesVersion', 'attempt', 'startedAt', 'submitUntil'].some(
        (k) => session[k] !== ticket[k],
      )
    )
      invalid();
    return { ...data, challenge, session };
  }
  async send(body, token) {
    const data = await this.request('/api/challenges/score', { method: 'POST', token, body });
    return challengeReceiptFields(data, body);
  }
  async board(challengeId, limit = 20) {
    const player = this.getPlayer(),
      data = await this.request(
        `/api/challenges/leaderboard?challengeId=${encodeURIComponent(challengeId)}&limit=${limit}`,
        { token: player?.token },
      );
    this.unchanged(player);
    const challenge = serverDefinition(data.challenge);
    if (
      challenge.challengeId !== challengeId ||
      !Array.isArray(data.entries) ||
      data.entries.length > limit ||
      !integer(data.total) ||
      data.total < data.entries.length
    )
      invalid();
    for (const [i, e] of data.entries.entries())
      if (
        !id(e.id) ||
        typeof e.name !== 'string' ||
        !integer(e.score, 1, 10000000) ||
        !integer(e.level, 1, 11) ||
        e.rank !== i + 1
      )
        invalid();
    if (
      player &&
      (!data.me ||
        data.me.player?.id !== player.id ||
        !integer(data.me.best, 0, 10000000) ||
        !(data.me.rank === null || integer(data.me.rank, 1)))
    )
      invalid();
    this.observe(data.serverNow);
    return { ...data, challenge };
  }
}
