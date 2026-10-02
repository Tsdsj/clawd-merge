import { Outbox } from './outbox.js';
import { challengeResultCodec, challengeResultFields } from './challenge-result.js';
import { createChallengeSequence } from './drop-sequence.js';

export function formalResult(record, game = record?.game) {
  if (record?.mode !== 'formal' || game?.challenge.phase !== 'finished')
    throw new Error('not_finished_formal');
  return challengeResultFields({
    roundId: record.roundId,
    playerId: record.online.playerId,
    playerName: record.online.playerName,
    sessionId: record.online.sessionId,
    mode: 'formal',
    challengeId: game.challenge.challengeId,
    rulesVersion: game.challenge.rulesVersion,
    submitUntil: record.online.submitUntil,
    score: game.score,
    drops: game.drops,
    maxLevel: game.maxLevel,
    clawsUsed: game.clawsUsed,
    settlingMs: Math.min(8000, Math.round(game.challenge.settlingTime * 1000)),
    reason: game.challenge.reason,
  });
}
export class ChallengeUploads {
  constructor({
    scope,
    store,
    api,
    getPlayer,
    locks,
    onChange = () => {},
    onRecord = () => {},
    isOnline = () => navigator.onLine !== false,
  }) {
    Object.assign(this, { store, onRecord, onChange });
    this.queue = new Outbox({
      scope: `daily:${scope}`,
      storage: store.storage,
      locks,
      getPlayer,
      codec: challengeResultCodec,
      send: (body, token) => api.send(body, token),
      isOnline,
      onChange,
      onClear: (entry) => this.recordDisposition(entry),
    });
  }
  stage(record, game = record?.game) {
    if (record?.mode !== 'formal' || record.upload || game?.challenge.phase !== 'finished') return null;
    const result = formalResult(record, game),
      saved = this.store.read();
    let journaled = false;
    try {
      journaled =
        saved.kind === 'saved' &&
        saved.record.roundId === record.roundId &&
        challengeResultCodec.same(formalResult(saved.record), result);
    } catch {
      /* An older playing snapshot is not a finished journal. */
    }
    const entry = this.queue.enqueue(result, { journaled });
    if (journaled) entry.journaled = true;
    void this.queue.kick();
    return entry;
  }
  recover() {
    const read = this.store.read();
    if (read.kind === 'saved') return this.stage(read.record);
    return null;
  }
  canReplace(record, game) {
    if (
      record?.mode !== 'formal' ||
      record.upload ||
      (game ? game.challenge.phase : record.game.challenge.phase) !== 'finished'
    )
      return true;
    const entry = this.queue.findRound(record.roundId);
    return Boolean(entry && (entry.durable || ['accepted', 'removed'].includes(entry.state)));
  }
  recordDisposition(entry) {
    const read = this.store.read();
    if (['invalid', 'unavailable'].includes(read.kind)) return false;
    if (read.kind === 'empty' || read.record?.roundId !== entry.roundId) return true;
    if (!this.store.owned || read.record.mode !== 'formal') return false;
    // A completed queue item can repair a last snapshot that failed before finish.
    // The saved world is only a result backdrop; it is never resumed as gameplay.
    const record = read.record,
      game = structuredClone(record.game);
    const levels = createChallengeSequence({ ...game.challenge, count: 100 }).levels;
    Object.assign(game, {
      score: entry.score,
      drops: entry.drops,
      maxLevel: entry.maxLevel,
      clawsUsed: entry.clawsUsed,
      current: levels[entry.drops] ?? null,
      next: levels[entry.drops + 1] ?? null,
      feverTime: 0,
      danger: Math.min(3, game.danger),
      warning: 0,
    });
    Object.assign(game.challenge, {
      phase: 'finished',
      reason: entry.reason,
      settlingTime: entry.settlingMs / 1000,
      stableTime: 0,
    });
    const upload =
      entry.state === 'accepted' ? { state: 'accepted', receipt: entry.receipt } : { state: 'removed' };
    const next = { ...record, game, upload, savedAt: Date.now() };
    try {
      this.store.write(next);
      this.onRecord(next);
      return true;
    } catch {
      return false;
    }
  }
  hasBoundWork(playerId) {
    if (!playerId) return false;
    const saved = this.store.read(),
      pending = this.store.readIntent();
    const known =
      pending.kind === 'intent' &&
      saved.record?.online?.requestId === pending.intent.requestId &&
      saved.record.online.playerId === pending.intent.playerId;
    if (pending.kind === 'intent' && pending.intent.playerId === playerId && !known) return true;
    if (
      saved.kind === 'saved' &&
      saved.record.mode === 'formal' &&
      saved.record.online.playerId === playerId
    ) {
      if (saved.record.game.challenge.phase !== 'finished') return true;
      const entry = this.queue.findRound(saved.record.roundId);
      if (!saved.record.upload && (!entry || !['accepted', 'removed'].includes(entry.state))) return true;
    }
    return this.queue
      .list()
      .some((e) => e.playerId === playerId && !['accepted', 'removed'].includes(e.state));
  }
}
