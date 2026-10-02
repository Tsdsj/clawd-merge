import test from "node:test";
import assert from "node:assert/strict";
import { ComfortSettings, COMFORT_KEY } from "../src/comfort.js";
function setup(
  raw = null,
  { failRead = false, failWrite = false, matches = false } = {},
) {
  let value = raw,
    writes = 0;
  const events = new EventTarget(),
    media = new EventTarget();
  media.matches = matches;
  const flags = { failRead, failWrite };
  const storage = {
    getItem() {
      if (flags.failRead) throw Error();
      return value;
    },
    setItem(k, v) {
      if (flags.failWrite) throw Error();
      value = v;
      writes++;
    },
  };
  const model = new ComfortSettings({ storage, media, target: events });
  return {
    model,
    media,
    flags,
    get raw() {
      return value;
    },
    get writes() {
      return writes;
    },
    external(v) {
      value = v;
      const e = new Event("storage");
      Object.assign(e, { key: COMFORT_KEY, newValue: v, storageArea: storage });
      events.dispatchEvent(e);
    },
  };
}
test("defaults follow system, haptics off, initialization never writes", () => {
  const t = setup();
  assert.equal(t.model.prefs.motion, "system");
  assert.equal(t.model.effects.haptics, false);
  assert.equal(t.model.effects.shake, true);
  assert.equal(t.writes, 0);
  t.media.matches = true;
  t.media.dispatchEvent(new Event("change"));
  assert.equal(t.model.effects.reduced, true);
  assert.equal(t.writes, 0);
});
test("reduced mode masks, never destroys remembered toggles; manual standard ignores system", () => {
  const t = setup();
  t.model.update({ shake: false });
  t.media.matches = true;
  t.media.dispatchEvent(new Event("change"));
  assert.equal(t.model.effects.particles, false);
  assert.equal(t.model.prefs.particles, true);
  t.model.update({ motion: "standard" });
  assert.equal(t.model.effects.shake, false);
  assert.equal(t.model.effects.particles, true);
  assert.equal(JSON.parse(t.raw).motion, "standard");
  assert.equal("systemReduced" in JSON.parse(t.raw), false);
});
test("write failure preserves live choices and retry persists; late reads never overwrite dirty choices", () => {
  const t = setup(null, { failWrite: true });
  t.model.update({ haptics: true });
  assert.equal(t.model.prefs.haptics, true);
  assert.equal(t.model.status, "write-error");
  t.flags.failWrite = false;
  t.model.retry();
  assert.equal(t.model.status, "saved");
  assert.equal(JSON.parse(t.raw).haptics, true);
  const r = setup(null, { failRead: true });
  r.model.update({ shake: false });
  r.flags.failRead = false;
  r.model.retry();
  assert.equal(r.model.prefs.shake, false);
  assert.equal(JSON.parse(r.raw).shake, false);
});
test("invalid or future schema is not overwritten until explicit reset, reset supports undo", () => {
  for (const raw of ["{bad", JSON.stringify({ schemaVersion: 9 })]) {
    const t = setup(raw);
    assert.equal(t.model.status, "invalid");
    t.model.update({ haptics: true });
    assert.equal(t.raw, raw);
    t.model.retry();
    assert.equal(t.raw, raw);
    t.model.reset();
    assert.equal(JSON.parse(t.raw).schemaVersion, 1);
    assert.equal(t.model.prefs.haptics, false);
    t.model.undoReset();
    assert.equal(t.model.prefs.haptics, true);
  }
});
test("read error uses defaults, retry rereads if clean; unsupported system detection is conservative", () => {
  const raw = JSON.stringify({
    schemaVersion: 1,
    motion: "standard",
    shake: false,
    particles: true,
    haptics: true,
  });
  const t = setup(raw, { failRead: true });
  assert.equal(t.model.status, "read-error");
  t.flags.failRead = false;
  t.model.retry();
  assert.equal(t.model.prefs.shake, false);
  const m = new ComfortSettings({ storage: null, media: null, target: null });
  assert.equal(m.effects.reduced, true);
  m.update({ motion: "standard" });
  assert.equal(m.effects.reduced, false);
});
test("external updates notify without echo writes; dirty page keeps local choices until deliberate retry", () => {
  const t = setup();
  let n = 0;
  t.model.subscribe(() => n++);
  const raw = JSON.stringify({
    schemaVersion: 1,
    motion: "reduced",
    shake: true,
    particles: true,
    haptics: false,
  });
  t.external(raw);
  assert.equal(t.model.effects.reduced, true);
  assert.equal(t.writes, 0);
  assert.equal(n, 1);
  t.flags.failWrite = true;
  t.model.update({ haptics: true });
  t.external(JSON.stringify({ ...JSON.parse(raw), haptics: false }));
  assert.equal(t.model.prefs.haptics, true);
  assert.equal(t.writes, 0);
  t.flags.failWrite = false;
  t.model.retry();
  assert.equal(JSON.parse(t.raw).haptics, true);
  t.model.destroy();
});
test("bad values are rejected and a later edit clears reset undo", () => {
  const t = setup();
  assert.throws(() => t.model.update({ motion: "fast" }));
  assert.throws(() => t.model.update({ shake: "false" }));
  t.model.reset();
  assert.equal(t.model.canUndo, true);
  t.model.update({ particles: false });
  assert.equal(t.model.canUndo, false);
});
test("an unread existing future record cannot be overwritten by editing or retry", () => {
  const raw = JSON.stringify({ schemaVersion: 8 });
  const t = setup(raw, { failRead: true });
  t.model.update({ haptics: true });
  assert.equal(t.raw, raw);
  assert.equal(t.writes, 0);
  t.flags.failRead = false;
  t.model.retry();
  assert.equal(t.raw, raw);
  assert.equal(t.model.prefs.haptics, true);
  assert.equal(t.model.status, "invalid");
});
test("retry never overwrites a newer unknown schema from another tab; failed explicit reset can retry", () => {
  const t = setup(null, { failWrite: true });
  t.model.update({ particles: false });
  const future = JSON.stringify({ schemaVersion: 9 });
  t.external(future);
  t.flags.failWrite = false;
  t.model.retry();
  assert.equal(t.raw, future);
  assert.equal(t.model.status, "invalid");
  t.flags.failWrite = true;
  t.model.reset();
  assert.equal(t.raw, future);
  t.flags.failWrite = false;
  t.model.retry();
  assert.equal(JSON.parse(t.raw).schemaVersion, 1);
  assert.equal(JSON.parse(t.raw).particles, true);
});
