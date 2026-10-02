const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
export function resultFields(value) {
  if (
    !value ||
    !['roundId', 'playerId'].every(
      (k) => typeof value[k] === 'string' && value[k].length > 0 && value[k].length <= 128,
    ) ||
    !(
      value.sessionId === null ||
      (typeof value.sessionId === 'string' && value.sessionId.length > 0 && value.sessionId.length <= 128)
    ) ||
    !integer(value.score, 1, 10_000_000) ||
    !integer(value.drops, 1, 5000) ||
    !integer(value.maxLevel, 1, 11)
  )
    throw new Error('invalid_result');
  return {
    roundId: value.roundId,
    playerId: value.playerId,
    playerName: String(value.playerName || '原身份').slice(0, 128),
    sessionId: value.sessionId,
    score: value.score,
    drops: value.drops,
    maxLevel: value.maxLevel,
  };
}
export function sameResult(a, b) {
  return ['roundId', 'playerId', 'sessionId', 'score', 'drops', 'maxLevel'].every((k) => a[k] === b[k]);
}
export function receiptFields(value) {
  if (
    !value ||
    typeof value.improved !== 'boolean' ||
    !integer(value.best, 0, 10_000_000) ||
    !(value.rank === null || integer(value.rank, 1, 1e9))
  )
    throw new Error('invalid_receipt');
  return { improved: value.improved, best: value.best, rank: value.rank };
}
