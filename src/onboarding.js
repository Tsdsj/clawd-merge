const KEY = 'clawd-merge:guide:v1';

export function createGuide(storage, returningPlayer = false) {
  let saved;
  try { saved = JSON.parse(storage.getItem(KEY) || '{}'); } catch { /* Optional persistence. */ }
  let completed = returningPlayer || saved?.completed === true;
  let step = 1;
  const seen = new Set(Array.isArray(saved?.seen) ? saved.seen : []);
  const persist = () => {
    try { storage.setItem(KEY, JSON.stringify({ completed, seen: [...seen] })); } catch { /* Keep the game playable. */ }
  };
  if (returningPlayer) persist();
  return {
    get step() { return completed ? null : step; },
    advance(drops) {
      if (completed) return;
      step = Math.min(3, drops + 1);
      if (drops >= 3) this.dismiss();
    },
    dismiss() { completed = true; persist(); },
    discover(feature) {
      if (seen.has(feature)) return false;
      seen.add(feature);
      persist();
      return true;
    },
  };
}
