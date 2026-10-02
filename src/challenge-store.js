import { SaveStore } from './save-store.js';
import { validateGameState } from './game-state.js';
import { CHALLENGE_RULES_VERSION } from './rules.js';

// Reuse the tested single-writer handoff, but never the classic save schema/key.
export class ChallengeStore extends SaveStore {
  constructor(options) {
    super({ ...options, scope: `daily:${options.scope}` });
  }
  validate(record) {
    if (
      !record ||
      record.schemaVersion !== 1 ||
      record.rulesVersion !== CHALLENGE_RULES_VERSION ||
      record.mode !== 'practice' ||
      record.scope !== this.scope ||
      Object.hasOwn(record, 'online') ||
      Object.hasOwn(record, 'terminal') ||
      typeof record.roundId !== 'string' ||
      !record.roundId.length ||
      record.roundId.length > 100 ||
      !Number.isSafeInteger(record.savedAt) ||
      record.savedAt < 0 ||
      !record.game?.challenge ||
      record.game.challenge.rulesVersion !== record.rulesVersion
    ) {
      throw new Error('invalid_challenge_save');
    }
    validateGameState(record.game);
    return record;
  }
  record(roundId, game) {
    return {
      schemaVersion: 1,
      rulesVersion: CHALLENGE_RULES_VERSION,
      mode: 'practice',
      scope: this.scope,
      roundId,
      savedAt: Date.now(),
      game,
    };
  }
}
