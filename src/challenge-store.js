import { SaveStore } from './save-store.js';
import { validateGameState } from './game-state.js';
import { CHALLENGE_RULES_VERSION } from './rules.js';
import { serverTicket } from './challenge-api.js';
import { challengeReceiptFields } from './challenge-result.js';

export class ChallengeStore extends SaveStore {
  constructor(options) {
    super({ ...options, scope: `daily:${options.scope}` });
    this.intentKey = `${this.key}:start`;
  }
  validate(record) {
    if (
      !record ||
      record.schemaVersion !== 1 ||
      record.rulesVersion !== CHALLENGE_RULES_VERSION ||
      !['practice', 'formal'].includes(record.mode) ||
      record.scope !== this.scope ||
      Object.hasOwn(record, 'terminal') ||
      typeof record.roundId !== 'string' ||
      !record.roundId.length ||
      record.roundId.length > 100 ||
      !Number.isSafeInteger(record.savedAt) ||
      record.savedAt < 0 ||
      !record.game?.challenge ||
      record.game.challenge.rulesVersion !== record.rulesVersion
    )
      throw new Error('invalid_challenge_save');
    validateGameState(record.game);
    if (record.mode === 'practice') {
      if (Object.hasOwn(record, 'online') || Object.hasOwn(record, 'upload'))
        throw new Error('invalid_practice_save');
    } else {
      const d = record.game.challenge,
        start = Date.parse(`${d.challengeId}T00:00:00+08:00`);
      serverTicket(record.online, {
        ...d,
        startsAt: start,
        endsAt: start + 86400000,
        submitUntil: start + 87000000,
      });
      if (
        record.roundId !== record.online.sessionId ||
        !Number.isInteger(record.game.clawsUsed) ||
        typeof record.online.requestId !== 'string' ||
        !/^[A-Za-z0-9_-]{16,100}$/.test(record.online.requestId)
      )
        throw new Error('invalid_formal_save');
      if (record.upload) {
        if (
          record.game.challenge.phase !== 'finished' ||
          !['accepted', 'removed'].includes(record.upload.state)
        )
          throw new Error('invalid_upload_state');
        if (record.upload.state === 'accepted')
          challengeReceiptFields(record.upload.receipt, {
            sessionId: record.online.sessionId,
            challengeId: d.challengeId,
            rulesVersion: d.rulesVersion,
            score: record.game.score,
          });
      }
    }
    return record;
  }
  record(roundId, game, online = null, upload = null) {
    return {
      schemaVersion: 1,
      rulesVersion: CHALLENGE_RULES_VERSION,
      mode: online ? 'formal' : 'practice',
      scope: this.scope,
      roundId,
      savedAt: Date.now(),
      game,
      ...(online ? { online, ...(upload ? { upload } : {}) } : {}),
    };
  }
  validateIntent(v) {
    if (
      !v ||
      v.schemaVersion !== 1 ||
      v.scope !== this.scope ||
      typeof v.requestId !== 'string' ||
      !/^[A-Za-z0-9_-]{16,100}$/.test(v.requestId) ||
      typeof v.playerId !== 'string' ||
      !v.playerId.length ||
      v.playerId.length > 128 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(v.challengeId) ||
      v.rulesVersion !== CHALLENGE_RULES_VERSION ||
      !Number.isSafeInteger(v.createdAt) ||
      v.createdAt < 0
    )
      throw new Error('invalid_start_intent');
    return {
      schemaVersion: 1,
      scope: this.scope,
      requestId: v.requestId,
      playerId: v.playerId,
      playerName: String(v.playerName || '原身份').slice(0, 128),
      challengeId: v.challengeId,
      rulesVersion: v.rulesVersion,
      createdAt: v.createdAt,
    };
  }
  readIntent() {
    let raw;
    try {
      raw = this.storage?.getItem(this.intentKey);
      if (!this.storage) throw new Error();
    } catch {
      return { kind: 'unavailable' };
    }
    if (raw == null) return { kind: 'empty' };
    try {
      if (raw.length > 32768) throw new Error();
      return { kind: 'intent', intent: this.validateIntent(JSON.parse(raw)) };
    } catch {
      return { kind: 'invalid' };
    }
  }
  writeIntent(intent) {
    if (!this.owned) throw new Error('not_owner');
    const v = this.validateIntent({ ...intent, schemaVersion: 1, scope: this.scope });
    this.storage.setItem(this.intentKey, JSON.stringify(v));
    return v;
  }
  clearIntent() {
    if (!this.owned) throw new Error('not_owner');
    this.storage.removeItem(this.intentKey);
  }
}
