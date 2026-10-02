// Gameplay-only PRNG. Cosmetic effects must never consume this stream.
// Mulberry32 with explicit uint32 state; this is not a cryptographic generator.
export const RANDOM_ALGORITHM = 'mulberry32-1';
const uint32 = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

export function randomSeed() {
  if (globalThis.crypto?.getRandomValues) return crypto.getRandomValues(new Uint32Array(1))[0];
  // Legacy environments only. Ambient randomness is read once, at game creation.
  return Math.floor(Math.random() * 2 ** 32) >>> 0;
}

export class GameplayRandom {
  constructor(seed = randomSeed()) {
    if (!uint32(seed)) throw new Error('invalid_random_seed');
    this.state = seed;
  }

  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 2 ** 32;
  }

  snapshot() { return { algorithm: RANDOM_ALGORITHM, state: this.state }; }

  static fromSnapshot(snapshot) {
    if (!snapshot || snapshot.algorithm !== RANDOM_ALGORITHM || !uint32(snapshot.state)) {
      throw new Error('invalid_random_state');
    }
    return new GameplayRandom(snapshot.state);
  }
}

// FNV-1a over UTF-8. The caller owns canonical identity encoding and validation.
export function seedFromText(text) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash;
}
