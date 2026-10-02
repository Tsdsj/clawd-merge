import { resultFields, sameResult, receiptFields } from './score-result.js';

const classicCodec={fields:resultFields,same:sameResult,receipt:receiptFields,body:e=>({sessionId:e.sessionId,score:e.score,drops:e.drops,maxLevel:e.maxLevel})};

const STATES = new Set([
  'ticket',
  'pending',
  'uploading',
  'retry',
  'identity',
  'rejected',
  'accepted',
  'removed',
]);
const BACKOFF = [2000, 5000, 15000];

export class Outbox {
  constructor({
    scope,
    storage,
    locks,
    getPlayer,
    send,
    now = Date.now,
    limit = 50,
    isOnline = () => true,
    onChange = () => {},
    onDurable = () => {},
    onClear = () => true,
    codec = classicCodec,
  }) {
    Object.assign(this, {
      scope,
      storage,
      locks,
      getPlayer,
      send,
      now,
      limit,
      isOnline,
      onChange,
      onDurable,
      onClear,
      codec,
    });
    this.prefix = `clawd-merge:outbox:${encodeURIComponent(scope)}:`;
    this.memory = new Map();
    this.inflight = new Set();
    this.readError = false;
    this.running = false;
  }
  keyOf(value) {
    return `${this.prefix}${encodeURIComponent(value.playerId)}:${encodeURIComponent(value.roundId)}`;
  }
  parse(raw, key) {
    if (raw.length > 65536) throw new Error('invalid_record');
    const v = JSON.parse(raw),
      fields = this.codec.fields(v);
    if (
      v.version !== 1 ||
      !STATES.has(v.state) ||
      !Number.isSafeInteger(v.attempts) ||
      v.attempts < 0 ||
      v.attempts > 100 ||
      !Number.isFinite(v.createdAt) ||
      !Number.isFinite(v.nextAt) ||
      this.keyOf(v) !== key
    )
      throw new Error('invalid_record');
    return {
      ...fields,
      version: 1,
      state: v.state,
      attempts: v.attempts,
      createdAt: v.createdAt,
      nextAt: v.nextAt,
      error: String(v.error || '').slice(0, 100),
      receipt: v.receipt ? this.codec.receipt(v.receipt,fields) : null,
      cleanupPending: Boolean(v.cleanupPending),
      key,
      durable: true,
    };
  }
  diskKeys() {
    const keys = [];
    try {
      if (!this.storage) throw new Error();
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (key?.startsWith(this.prefix)) keys.push(key);
      }
      this.readError = false;
    } catch {
      this.readError = true;
    }
    return keys;
  }
  get(key) {
    if (!key?.startsWith(this.prefix)) return null;
    const memory = this.memory.get(key);
    if (memory && (!memory.durable || ['accepted', 'removed'].includes(memory.state))) return memory;
    try {
      const raw = this.storage?.getItem(key);
      if (raw == null) return null;
      try {
        return this.parse(raw, key);
      } catch {
        let roundId, playerId;
        try {
          [playerId, roundId] = key.slice(this.prefix.length).split(':').map(decodeURIComponent);
        } catch {
          /* Keep raw record. */
        }
        return { key, roundId, playerId, state: 'corrupt', durable: true, error: 'invalid_record' };
      }
    } catch {
      this.readError = true;
      return memory || null;
    }
  }
  list() {
    const keys = new Set([...this.diskKeys(), ...this.memory.keys()]);
    return [...keys]
      .map((key) => this.get(key))
      .filter((e) => e && e.state !== 'removed' && (e.state !== 'accepted' || e.cleanupPending));
  }
  findRound(id) {
    return [...this.list(), ...this.memory.values()].find((e) => e.roundId === id) || null;
  }
  emit(entry) {
    this.onChange(entry);
  }
  persist(entry) {
    this.memory.set(entry.key, entry);
    try {
      if (!this.storage) throw new Error('storage');
      if (this.storage.getItem(entry.key) === null && this.diskKeys().length >= this.limit)
        throw new Error('queue_full');
      const { key, durable, journaled, ...data } = entry;
      this.storage.setItem(key, JSON.stringify(data));
      entry.durable = true;
    } catch (err) {
      entry.durable = false;
      if (err.message === 'queue_full') entry.error = 'queue_full';
    }
    if (entry.durable) {
      try {
        this.onDurable(entry);
      } catch {
        /* The durable queue remains authoritative. */
      }
    }
    this.emit(entry);
    return entry;
  }
  enqueue(value, { journaled = false } = {}) {
    const fields = this.codec.fields(value),
      key = this.keyOf(fields),
      existing = this.get(key);
    if (existing) {
      const completedTicket = fields.sessionId === null && existing.sessionId;
      if (
        existing.state === 'corrupt' ||
        !this.codec.same(existing, completedTicket ? { ...fields, sessionId: existing.sessionId } : fields)
      )
        throw new Error('result_conflict');
      return existing;
    }
    return this.persist({
      ...fields,
      version: 1,
      key,
      createdAt: this.now(),
      nextAt: 0,
      attempts: 0,
      state: fields.sessionId ? 'pending' : 'ticket',
      error: '',
      durable: false,
      journaled,
      receipt: null,
      cleanupPending: false,
    });
  }
  setTicket(key, sessionId) {
    const entry = this.get(key);
    if (!entry || entry.state === 'removed' || entry.state === 'accepted') return;
    if (entry.sessionId && entry.sessionId !== sessionId) throw new Error('result_conflict');
    if (!sessionId) {
      entry.state = 'rejected';
      entry.error = 'no_session';
    } else {
      entry.sessionId = sessionId;
      this.codec.fields(entry);
      entry.state = 'pending';
      entry.error = '';
      entry.attempts = 0;
      entry.nextAt = 0;
    }
    this.persist(entry);
    if (this.running) void this.kick();
  }
  async locked(key, action) {
    if (this.inflight.has(key)) return false;
    this.inflight.add(key);
    try {
      if (this.locks?.request)
        return await this.locks.request(`${key}:upload`, { ifAvailable: true }, (lock) =>
          lock ? action() : false,
        );
      // Server receipts still prevent duplicate acceptance without Web Locks.
      return await action();
    } finally {
      this.inflight.delete(key);
      this.emit(this.get(key));
    }
  }
  async cleanup(entry) {
    try {
      if (!(await this.onClear(entry))) throw new Error('journal_busy');
      this.storage?.removeItem(entry.key);
      entry.cleanupPending = false;
    } catch {
      entry.cleanupPending = true;
    }
    this.memory.set(entry.key, entry);
    this.emit(entry);
  }
  async process(key) {
    return this.locked(key, async () => {
      const entry = this.get(key);
      if (!entry || ['corrupt', 'rejected', 'identity', 'removed'].includes(entry.state)) return false;
      if (entry.state === 'accepted') {
        await this.cleanup(entry);
        return true;
      }
      if (!entry.sessionId) {
        if (this.now() - entry.createdAt >= 10000) {
          entry.state = 'rejected';
          entry.error = 'no_session';
          this.persist(entry);
        }
        return false;
      }
      if (entry.nextAt > this.now() || entry.attempts >= 4) return false;
      const player = this.getPlayer();
      if (!player || player.id !== entry.playerId) {
        entry.state = 'identity';
        entry.error = 'identity';
        this.persist(entry);
        return false;
      }
      if (!this.isOnline()) {
        entry.state = 'retry';
        entry.error = 'offline';
        this.persist(entry);
        return false;
      }
      entry.state = 'uploading';
      entry.attempts++;
      this.persist(entry);
      try {
        const result = await this.send(
          this.codec.body(entry),
          player.token,
        );
        if (entry.durable && !this.get(key)) return false;
        entry.receipt = this.codec.receipt(result,entry);
        entry.state = 'accepted';
        entry.cleanupPending = true;
        entry.error = '';
        this.persist(entry);
        await this.cleanup(entry);
      } catch (err) {
        if (entry.durable && !this.get(key)) return false;
        const status = err.status || 0;
        entry.error = String(err.code || (status ? `http_${status}` : 'offline')).slice(0, 100);
        if (status === 401) entry.state = 'identity';
        else if (status >= 400 && status < 500 && status !== 429) entry.state = 'rejected';
        else {
          entry.state = 'retry';
          entry.nextAt =
            this.now() +
            (status === 429
              ? Math.max(err.retryAfterMs || 60000, 1000)
              : BACKOFF[Math.min(entry.attempts - 1, 2)]);
        }
        this.persist(entry);
      }
      return true;
    });
  }
  async retry(key) {
    if (this.inflight.has(key)) return false;
    const entry = this.get(key);
    if (!entry || ['corrupt', 'removed'].includes(entry.state)) return false;
    if (entry.state === 'uploading') return false;
    if (entry.state === 'rejected') {
      if (!entry.durable) {
        this.persist(entry);
        return true;
      }
      return false;
    }
    if (entry.state === 'accepted') return this.process(key);
    if (!entry.sessionId) return false;
    if (entry.error !== 'rate_limited' && entry.error !== 'http_429') entry.nextAt = 0;
    entry.attempts = 0;
    entry.state = 'pending';
    this.persist(entry);
    const result = await this.process(key);
    if (this.running) this.schedule();
    return result;
  }
  async remove(key) {
    return this.locked(key, async () => {
      const entry = this.get(key);
      if (!entry) return true;
      if (entry.state === 'uploading') return false;
      if (!(await this.onClear(entry))) return false;
      try {
        this.storage?.removeItem(key);
      } catch {
        return false;
      }
      this.memory.set(key, {
        ...entry,
        state: entry.state === 'accepted' ? 'accepted' : 'removed',
        cleanupPending: false,
        durable: false,
      });
      this.emit(this.memory.get(key));
      return true;
    });
  }
  observe(key, raw) {
    if (!key?.startsWith(this.prefix)) return;
    if (raw) {
      try {
        const entry = this.parse(raw, key);
        if (entry.state === 'accepted') {
          entry.cleanupPending = Boolean(this.storage?.getItem(key));
          this.memory.set(key, entry);
        }
      } catch {
        /* A corrupt record is shown by list(), not discarded. */
      }
    } else {
      const entry = this.memory.get(key);
      if (entry)
        this.memory.set(
          key,
          entry.state === 'accepted'
            ? { ...entry, cleanupPending: false }
            : { ...entry, state: 'removed', durable: false },
        );
    }
    this.emit(null);
    if (this.running) void this.kick();
  }
  wakeIdentity() {
    const player = this.getPlayer(),
      identity = player ? `${player.id}:${player.token}` : '';
    if (identity === this.lastIdentity) return;
    this.lastIdentity = identity;
    if (player)
      for (const entry of this.list())
        if (entry.state === 'identity' && entry.playerId === player.id) {
          entry.state = 'pending';
          entry.attempts = 0;
          entry.nextAt = 0;
          this.persist(entry);
        }
    if (this.running) void this.kick();
  }
  wakeOnline() {
    if (this.now() - (this.lastOnline || 0) < 15000) return;
    this.lastOnline = this.now();
    for (const entry of this.list())
      if (entry.state === 'retry' && ['offline', 'timeout'].includes(entry.error)) {
        entry.state = 'pending';
        entry.attempts = 0;
        entry.nextAt = 0;
        this.persist(entry);
      }
    if (this.running) void this.kick();
  }
  async kick() {
    if (!this.running || this.draining) return;
    this.draining = true;
    try {
      for (const entry of this.list()) await this.process(entry.key);
    } finally {
      this.draining = false;
      this.schedule();
    }
  }
  schedule() {
    clearTimeout(this.timer);
    if (!this.running || !this.isOnline()) return;
    const due = this.list()
      .filter((e) => ['ticket', 'pending', 'uploading', 'retry'].includes(e.state) && e.attempts < 4)
      .map((e) => (e.state === 'ticket' ? e.createdAt + 10000 : e.nextAt));
    if (due.length)
      this.timer = setTimeout(
        () => void this.kick(),
        Math.min(60000, Math.max(1000, Math.min(...due) - this.now())),
      );
  }
  start() {
    this.running = true;
    this.wakeIdentity();
    void this.kick();
  }
  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }
}
