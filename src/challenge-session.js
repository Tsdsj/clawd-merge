// Practice-only orchestration; no leaderboard identity, credential or upload API.
export class ChallengeSession {
  constructor({ store, createGame, onChange = () => {} }) {
    Object.assign(this, {
      store,
      createGame,
      onChange,
      status: 'initializing',
      game: null,
      record: null,
      temporary: false,
      warning: '',
      revision: 0,
      lastSaved: 0,
    });
    store.onYield = () => {
      this.handoffPaused = true;
      this.game?.setPaused(true);
      if (this.status === 'active' && (!this.flush() || this.temporary)) {
        this.onChange();
        return false;
      }
      return true;
    };
    store.onLost = () => {
      this.revision++;
      this.game?.setPaused(true);
      this.status = 'busy';
      this.record = null;
      this.warning = '挑战已在另一页继续，本页已停止写入。';
      this.onChange();
    };
  }
  async initialize() {
    if (this.status === 'active' && (this.store.owned || this.temporary)) return;
    if (this.initializing) return this.initializing;
    const revision = ++this.revision;
    this.initializing = (async () => {
      this.status = 'initializing';
      this.onChange();
      const acquired = await this.store.acquire();
      if (revision !== this.revision) {
        if (acquired) await this.store.release();
        return;
      }
      if (!acquired) this.status = this.store.supported ? 'busy' : 'unavailable';
      else {
        const result = this.store.read();
        this.status = result.kind;
        this.record = result.record ?? null;
      }
      this.onChange();
    })().finally(() => {
      this.initializing = null;
    });
    return this.initializing;
  }
  build(definition) {
    return this.createGame(definition, () => {
      this.flush();
      this.onChange();
    });
  }
  start(definition, temporary = false) {
    if (!temporary && !this.store.owned) return false;
    const game = this.build(definition);
    const id = globalThis.crypto?.randomUUID?.() ?? `practice-${Date.now()}-${Math.random()}`;
    const record = this.store.record(id, game.snapshot());
    if (!temporary) {
      try {
        this.store.write(record);
      } catch {
        this.warning = '无法保存新局，原来的记录未被替换。请重试或保留原局。';
        this.onChange();
        return false;
      }
    }
    this.handoffPaused = false;
    this.game = game;
    this.record = record;
    this.temporary = temporary;
    this.status = 'active';
    this.lastSaved = performance.now();
    this.warning = temporary ? '临时练习只保留在本页，关闭后无法恢复。' : '';
    this.onChange();
    return true;
  }
  resume() {
    if (!this.store.owned || !this.record || this.status !== 'saved') return false;
    try {
      const game = this.build(this.record.game.challenge);
      game.restore(this.record.game);
      this.handoffPaused = false;
      this.game = game;
      this.status = 'active';
      this.temporary = false;
      this.warning = '';
      this.lastSaved = performance.now();
      this.onChange();
      return true;
    } catch {
      this.status = 'invalid';
      this.onChange();
      return false;
    }
  }
  flush() {
    if (this.status !== 'active' || !this.game) return false;
    if (this.temporary) return true;
    if (!this.store.owned) return false;
    try {
      const record = this.store.record(this.record.roundId, this.game.snapshot());
      this.store.write(record);
      this.record = record;
      this.lastSaved = performance.now();
      this.warning = '';
      return true;
    } catch {
      this.warning = '挑战尚未保存成功，请勿刷新或关闭；可重试保存。';
      return false;
    }
  }
  tick(now) {
    if (
      this.status === 'active' &&
      this.game &&
      !this.game.over &&
      !this.game.paused &&
      !this.warning &&
      now - this.lastSaved >= 1000
    ) {
      this.flush();
      this.onChange();
    }
  }
  async takeover() {
    const revision = ++this.revision;
    this.status = 'initializing';
    this.onChange();
    const acquired = await this.store.takeover();
    if (revision !== this.revision) {
      if (acquired) await this.store.release();
      return;
    }
    if (acquired) {
      this.game = null;
      const result = this.store.read();
      this.record = result.record ?? null;
      this.status = result.kind;
      this.warning = '';
    } else {
      this.status = 'busy';
      this.warning = '另一页尚未交接，请先关闭那一页后重试。';
    }
    this.onChange();
  }
  leave() {
    this.revision++;
    this.game?.setPaused(true);
    this.flush();
    this.status = 'detached';
    void this.store.release();
  }
}
