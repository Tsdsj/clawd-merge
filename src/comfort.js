import { getStorage } from "./storage.js";
export const COMFORT_KEY = "clawd-merge:comfort";
export const comfortDefaults = () => ({
  schemaVersion: 1,
  motion: "system",
  shake: true,
  particles: true,
  haptics: false,
});
export function validateComfort(p) {
  if (
    !p ||
    p.schemaVersion !== 1 ||
    !["system", "reduced", "standard"].includes(p.motion) ||
    !["shake", "particles", "haptics"].every((k) => typeof p[k] === "boolean")
  )
    throw Error("invalid_comfort");
  return {
    schemaVersion: 1,
    motion: p.motion,
    shake: p.shake,
    particles: p.particles,
    haptics: p.haptics,
  };
}
export function comfortEffects(p, systemReduced = true) {
  const reduced =
    p.motion === "reduced" || (p.motion === "system" && systemReduced);
  return Object.freeze({
    reduced,
    shake: p.shake && !reduced,
    particles: p.particles && !reduced,
    haptics: p.haptics,
  });
}
function systemMedia() {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
  } catch {
    return null;
  }
}
export class ComfortSettings {
  constructor({
    storage = getStorage(),
    media = systemMedia(),
    target = globalThis.window ?? null,
  } = {}) {
    Object.assign(this, {
      storage,
      media,
      target,
      prefs: Object.freeze(comfortDefaults()),
      status: "default",
      dirty: false,
      blocked: false,
      replacePending: false,
      unread: true,
      undo: null,
      listeners: new Set(),
    });
    this.read();
    this.mediaChanged = () => this.emit();
    this.storageChanged = (e) => {
      if (
        (e.key !== COMFORT_KEY && e.key !== null) ||
        (e.storageArea && e.storageArea !== this.storage)
      )
        return;
      if (this.dirty) return;
      this.undo = null;
      this.read();
      this.emit();
    };
    if (media?.addEventListener)
      media.addEventListener("change", this.mediaChanged);
    else media?.addListener?.(this.mediaChanged);
    target?.addEventListener("storage", this.storageChanged);
  }
  get systemReduced() {
    return this.media ? Boolean(this.media.matches) : true;
  }
  get systemKnown() {
    return Boolean(this.media);
  }
  get effects() {
    return comfortEffects(this.prefs, this.systemReduced);
  }
  get canUndo() {
    return Boolean(this.undo);
  }
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit() {
    for (const fn of this.listeners) fn(this);
  }
  read() {
    try {
      if (!this.storage) throw Error();
      const raw = this.storage.getItem(COMFORT_KEY);
      this.unread = false;
      let p;
      try {
        p =
          raw === null
            ? comfortDefaults()
            : validateComfort(JSON.parse(raw.length <= 2048 ? raw : "invalid"));
      } catch {
        this.blocked = true;
        this.status = "invalid";
        return;
      }
      this.prefs = Object.freeze(p);
      this.blocked = false;
      this.status = raw === null ? "default" : "saved";
    } catch {
      this.unread = true;
      this.status = "read-error";
    }
  }
  save() {
    if (this.unread && !this.replacePending) {
      this.status = "read-error";
      return false;
    }
    if (this.blocked && !this.replacePending) {
      this.status = "invalid";
      return false;
    }
    if (!this.replacePending) {
      let raw;
      try {
        if (!this.storage) throw Error();
        raw = this.storage.getItem(COMFORT_KEY);
      } catch {
        this.unread = true;
        this.status = "read-error";
        return false;
      }
      try {
        if (raw !== null)
          validateComfort(JSON.parse(raw.length <= 2048 ? raw : "invalid"));
      } catch {
        this.blocked = true;
        this.status = "invalid";
        return false;
      }
    }
    try {
      if (!this.storage) throw Error();
      this.storage.setItem(COMFORT_KEY, JSON.stringify(this.prefs));
      this.replacePending = false;
      this.blocked = false;
      this.unread = false;
      this.dirty = false;
      this.status = "saved";
      return true;
    } catch {
      this.status = "write-error";
      return false;
    }
  }
  update(patch) {
    if (
      Object.keys(patch).some(
        (k) => !["motion", "shake", "particles", "haptics"].includes(k),
      )
    )
      throw Error("invalid_comfort_patch");
    this.prefs = Object.freeze(validateComfort({ ...this.prefs, ...patch }));
    this.undo = null;
    this.dirty = true;
    this.save();
    this.emit();
  }
  retry() {
    if (this.dirty) {
      if ((this.unread || this.blocked) && !this.replacePending) {
        const live = this.prefs;
        this.read();
        this.prefs = live;
      }
      this.save();
    } else this.read();
    this.emit();
  }
  reset() {
    this.replacePending = true;
    this.undo = this.prefs;
    this.prefs = Object.freeze(comfortDefaults());
    this.blocked = false;
    this.unread = false;
    this.dirty = true;
    this.save();
    this.emit();
  }
  undoReset() {
    if (!this.undo) return;
    this.prefs = this.undo;
    this.replacePending = false;
    this.undo = null;
    this.dirty = true;
    this.save();
    this.emit();
  }
  destroy() {
    if (this.media?.removeEventListener)
      this.media.removeEventListener("change", this.mediaChanged);
    else this.media?.removeListener?.(this.mediaChanged);
    this.target?.removeEventListener("storage", this.storageChanged);
    this.listeners.clear();
  }
}
