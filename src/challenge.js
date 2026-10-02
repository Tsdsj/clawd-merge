import { createChallengeSequence } from './drop-sequence.js';
import { CHALLENGE_RULES_VERSION } from './rules.js';
export const CHALLENGE_LIMIT = 100;
export const SETTLE_SECONDS = 8;
export const STABLE_SECONDS = 0.75;

export function practiceDefinition(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (kind) => parts.find((p) => p.type === kind).value;
  return Object.freeze({
    challengeId: `${value('year')}-${value('month')}-${value('day')}`,
    rulesVersion: CHALLENGE_RULES_VERSION,
    count: CHALLENGE_LIMIT,
  });
}

export function challengeSequence(definition) {
  if (!definition || definition.count !== CHALLENGE_LIMIT) throw new Error('invalid_challenge_definition');
  return createChallengeSequence(definition).levels;
}
export function validateChallenge(state, drops, current, next) {
  const levels = challengeSequence(state);
  const finite = (n, max) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max;
  if (
    !['playing', 'settling', 'finished'].includes(state.phase) ||
    !Number.isInteger(drops) ||
    drops < 0 ||
    drops > CHALLENGE_LIMIT ||
    !finite(state.settlingTime, SETTLE_SECONDS) ||
    !finite(state.stableTime, STABLE_SECONDS) ||
    current !== (levels[drops] ?? null) ||
    next !== (levels[drops + 1] ?? null) ||
    (state.phase === 'playing' &&
      (drops === CHALLENGE_LIMIT || state.settlingTime !== 0 || state.stableTime !== 0)) ||
    (state.phase === 'settling' && drops !== CHALLENGE_LIMIT) ||
    (state.phase === 'finished' ? !['danger', 'limit'].includes(state.reason) : state.reason !== null) ||
    (state.reason === 'limit' && drops !== CHALLENGE_LIMIT)
  )
    throw new Error('invalid_challenge_state');
  return levels;
}

// T10 supplies the authoritative server adapter. No local formal counter or
// device-date fallback can silently become a ranked definition.
export const challengeService = Object.freeze({
  formalAvailable: false,
  practice: practiceDefinition,
  async startFormal() {
    throw new Error('formal_unavailable');
  },
});
