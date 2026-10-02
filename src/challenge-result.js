import { CHALLENGE_RULES_VERSION } from './rules.js';
import { receiptFields } from './score-result.js';
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
const id = (v) => typeof v === 'string' && v.length > 0 && v.length <= 128;
const payloadKeys = [
  'mode',
  'sessionId',
  'challengeId',
  'rulesVersion',
  'score',
  'drops',
  'maxLevel',
  'clawsUsed',
  'settlingMs',
  'reason',
];
export function challengeResultFields(v) {
  if (
    !v ||
    v.mode !== 'formal' ||
    !['roundId', 'playerId', 'sessionId'].every((k) => id(v[k])) ||
    typeof v.challengeId !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(v.challengeId) ||
    v.rulesVersion !== CHALLENGE_RULES_VERSION ||
    !integer(v.submitUntil, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(v.score, 0, 10000000) ||
    !integer(v.drops, 1, 100) ||
    !integer(v.maxLevel, 1, 11) ||
    !integer(v.clawsUsed, 0, 5) ||
    !integer(v.settlingMs, 0, 8000) ||
    !['danger', 'limit'].includes(v.reason) ||
    (v.reason === 'limit' && (v.drops !== 100 || v.settlingMs < 750))
  )
    throw new Error('invalid_challenge_result');
  return {
    roundId: v.roundId,
    playerId: v.playerId,
    playerName: String(v.playerName || '原身份').slice(0, 128),
    submitUntil: v.submitUntil,
    ...Object.fromEntries(payloadKeys.map((k) => [k, v[k]])),
  };
}
export function challengeReceiptFields(v, expected) {
  const receipt = receiptFields(v);
  if (
    !id(v.sessionId) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(v.challengeId) ||
    v.rulesVersion !== CHALLENGE_RULES_VERSION ||
    (expected && ['sessionId', 'challengeId', 'rulesVersion'].some((k) => v[k] !== expected[k])) ||
    (expected && receipt.best < expected.score) ||
    (receipt.best > 0 && receipt.rank === null)
  )
    throw new Error('invalid_challenge_receipt');
  return { ...receipt, sessionId: v.sessionId, challengeId: v.challengeId, rulesVersion: v.rulesVersion };
}
export const challengeResultCodec = Object.freeze({
  fields: challengeResultFields,
  same: (a, b) => ['roundId', 'playerId', 'submitUntil', ...payloadKeys].every((k) => a[k] === b[k]),
  receipt: challengeReceiptFields,
  body: (entry) => Object.fromEntries(payloadKeys.map((k) => [k, entry[k]])),
});
