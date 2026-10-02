import { serverDefinition } from './challenge-api.js';
import { challengeSequence } from './challenge.js';

// Snapshot ownership is shared by practice and formal play; formal requests are durable first.
export class ChallengeSession {
  constructor({
    store,
    createGame,
    onChange = () => {},
    api = null,
    getPlayer = () => null,
    onFinish = () => {},
    canReplace = () => true,
  }) {
    Object.assign(this, {
      store,
      createGame,
      onChange,
      api,
      getPlayer,
      onFinish,
      canReplace,
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
        this.inspect();
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
      try {
        this.onFinish(this);
      } catch {
        this.warning = '本局结果尚未进入补传队列，请勿刷新，先重试保存。';
      }
      this.onChange();
    });
  }
  start(definition, temporary = false) {
    if ((!temporary && !this.store.owned) || this.pendingIntent || this.status === 'intent-invalid')
      return false;
    if (!this.canReplace(this.record, this.game)) {
      this.warning = '请先保存或处理上一局正式结果，再开始新局。';
      this.onChange();
      return false;
    }
    try {
      challengeSequence(definition);
    } catch {
      this.warning = '这道题暂时无法使用，请重新获取。';
      this.onChange();
      return false;
    }
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
  resume(verified = false) {
    if (
      !this.store.owned ||
      !this.record ||
      this.status !== 'saved' ||
      (this.record.mode === 'formal' && !verified)
    )
      return false;
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
      const record = this.store.record(
        this.record.roundId,
        this.game.snapshot(),
        this.record.online,
        this.record.upload,
      );
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
      this.inspect();
      this.warning = '';
    } else {
      this.status = 'busy';
      this.warning = '另一页尚未交接，请先关闭那一页后重试。';
    }
    this.onChange();
  }
  inspect() {
    const result = this.store.read();
    this.status = result.kind;
    this.record = result.record ?? null;
    this.pendingIntent = null;
    const pending = this.store.readIntent?.();
    if (pending?.kind === 'intent') {
      if (
        this.record?.online?.requestId === pending.intent.requestId &&
        this.record.online.playerId === pending.intent.playerId
      ) {
        try {
          this.store.clearIntent();
        } catch {
          /* Durable credential supersedes the intent. */
        }
      } else {
        this.pendingIntent = pending.intent;
        this.status = 'starting';
      }
    } else if (pending?.kind === 'invalid') this.status = 'intent-invalid';
    else if (pending?.kind === 'unavailable') this.status = 'unavailable';
  }
  async startFormal(definition) {
    if (this.pendingIntent) return this.retryStart();
    if (!this.api || this.api.formalAvailable === false || !this.store.owned || this.temporary) {
      this.warning = '当前无法安全领取正式机会，请先联网并允许保存。';
      this.onChange();
      return false;
    }
    if (!this.canReplace(this.record, this.game)) {
      this.warning = '上一局结果尚未保存，请先处理。';
      this.onChange();
      return false;
    }
    const player = this.getPlayer();
    if (!player) {
      this.warning = '请先选择游客或 LINUX DO 身份。';
      this.onChange();
      return false;
    }
    try {
      serverDefinition(definition);
      if (this.status === 'active') this.flush();
      this.pendingIntent = this.store.writeIntent({
        requestId: crypto.randomUUID(),
        playerId: player.id,
        playerName: player.name,
        challengeId: definition.challengeId,
        rulesVersion: definition.rulesVersion,
        createdAt: Date.now(),
      });
    } catch {
      this.warning = '开局请求未能保存，没有领取正式机会。请重试保存。';
      this.onChange();
      return false;
    }
    this.status = 'starting';
    this.game?.setPaused(true);
    this.onChange();
    return this.retryStart();
  }
  async retryStart() {
    if (this.issuing || !this.pendingIntent || !this.store.owned || !this.api) return false;
    const intent = this.pendingIntent,
      player = this.getPlayer();
    if (!player || player.id !== intent.playerId) {
      this.warning = '这次未确认开局属于原身份，请切回原身份重试。';
      this.onChange();
      return false;
    }
    this.issuing = true;
    const revision = ++this.revision;
    this.warning = '';
    this.onChange();
    try {
      const reply = await this.api.start(intent);
      if (revision !== this.revision || !this.store.owned) return false;
      if (this.getPlayer()?.id !== intent.playerId) throw new Error('identity_changed');
      if (!['valid', 'used', 'expired'].includes(reply.status)) throw new Error('bad_start_response');
      if (reply.status === 'used' || reply.status === 'expired') {
        this.store.clearIntent();
        this.pendingIntent = null;
        this.inspect();
        this.warning =
          reply.status === 'used'
            ? '这次开局对应的正式局已经结束，请查看本题榜单。'
            : '这次开局已过正式截止，原来的本机记录仍保留。';
        this.onChange();
        return false;
      }
      const game = this.build(reply.challenge),
        online = { ...reply.session, requestId: intent.requestId, playerName: intent.playerName };
      const record = this.store.record(online.sessionId, game.snapshot(), online);
      this.store.write(record);
      try {
        this.store.clearIntent();
      } catch {
        /* The persisted credential identifies this already-issued intent. */
      }
      this.pendingIntent = null;
      this.record = record;
      this.game = game;
      this.temporary = false;
      this.handoffPaused = false;
      this.warning = '';
      this.eligibility = reply.serverNow >= online.submitUntil ? 'expired' : 'valid';
      this.status = this.eligibility === 'valid' ? 'active' : 'saved';
      game.setPaused(this.status !== 'active');
      this.lastSaved = performance.now();
      this.onChange();
      return this.status === 'active';
    } catch (error) {
      if (revision !== this.revision) return false;
      if (['attempts_exhausted', 'challenge_changed', 'rules_mismatch', 'bad_request'].includes(error.code)) {
        try {
          this.store.clearIntent();
          this.inspect();
        } catch {
          /* Keep the stable request if cleanup is blocked. */
        }
      }
      this.warning = error.message || '未收到开局确认，重试仍使用同一请求，不会重复扣次。';
      this.onChange();
      return false;
    } finally {
      this.issuing = false;
      this.onChange();
    }
  }
  discardStart() {
    if (!this.store.owned) return false;
    try {
      this.revision++;
      this.store.clearIntent();
      this.pendingIntent = null;
      this.inspect();
      this.warning = '';
      this.onChange();
      return true;
    } catch {
      this.warning = '未能移除本机开局记录，请重试；原记录仍保留。';
      this.onChange();
      return false;
    }
  }
  async resumeFormal() {
    if (!this.record?.online || !this.store.owned || this.checking) return false;
    if (this.record.game.challenge.phase === 'finished') return this.resume(true);
    this.checking = true;
    this.eligibility = 'checking';
    const revision = ++this.revision;
    this.onChange();
    try {
      const result = await this.api.check(this.record.online);
      if (revision !== this.revision || !this.store.owned) return false;
      this.eligibility = result.status;
      if (result.status !== 'valid') {
        this.onChange();
        return false;
      }
      if (this.status === 'active' && this.game) {
        this.onChange();
        return true;
      }
      return this.resume(true);
    } catch (error) {
      if (revision === this.revision) {
        this.eligibility = error.status === 401 ? 'identity' : 'network';
        this.warning = error.message;
        this.onChange();
      }
      return false;
    } finally {
      this.checking = false;
      this.onChange();
    }
  }
  toPractice() {
    if (!this.store.owned || !this.record || this.pendingIntent) return false;
    try {
      const snapshot = this.status === 'active' && this.game ? this.game.snapshot() : this.record.game;
      const game = this.build(snapshot.challenge);
      game.restore(snapshot);
      const record = this.store.record(`practice-${crypto.randomUUID()}`, game.snapshot());
      this.store.write(record);
      this.revision++;
      this.game = game;
      this.record = record;
      this.status = 'active';
      this.temporary = false;
      this.eligibility = null;
      this.warning = '';
      this.handoffPaused = false;
      this.onChange();
      return true;
    } catch {
      this.warning = '转换选择未能保存，正式原局保持不变，请重试。';
      this.onChange();
      return false;
    }
  }
  leave() {
    this.revision++;
    this.game?.setPaused(true);
    this.flush();
    this.status = 'detached';
    void this.store.release();
  }
}
