// Preferences may fall back to memory; durable saves must report failures.
export function getStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}
export function readPreference(key) {
  try { return getStorage()?.getItem(key) ?? null; } catch { return null; }
}
export function writePreference(key, value) {
  try {
    const storage=getStorage();
    if(!storage)return false;
    storage.setItem(key,value);
    return true;
  } catch { return false; }
}
