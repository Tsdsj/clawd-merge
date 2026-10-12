import { GameplayRandom, seedFromText } from './random.js';
import { RULES, RAINBOW_CHANCE, RAINBOW_MIN_DROPS, CHALLENGE_RULES, SPECIALS, SPECIAL_KINDS } from './rules.js';

function weightedLevel(random, weights) {
  let value = random() * weights.reduce((sum, weight) => sum + weight, 0);
  for (let i = 0; i < weights.length; i++) {
    value -= weights[i];
    if (value < 0) return i + 1;
  }
  return 1;
}

export function chooseClassicLevel(random, { drops, current, maxLevel }) {
  if (drops >= RAINBOW_MIN_DROPS && current !== 0 && random() < RAINBOW_CHANCE) return 0;
  const cap = Math.max(3, Math.min(maxLevel, RULES.spawnWeights.length));
  return weightedLevel(random, RULES.spawnWeights.slice(0, cap));
}

function weightedKind(random, kinds) {
  const total = kinds.reduce((sum, kind) => sum + SPECIALS.weights[kind], 0);
  let value = random() * total;
  for (const kind of kinds) {
    value -= SPECIALS.weights[kind];
    if (value < 0) return kind;
  }
  return kinds.at(-1);
}

function eligibleKinds(game) {
  const kinds = [];
  for (const kind of ['rainbow', ...SPECIAL_KINDS]) {
    if (kind !== 'rainbow') {
      if (game.drops - (game.specialLastAt[kind] ?? -Infinity) < SPECIALS.kindCooldown) continue;
      const limit = SPECIALS.maxActive[kind];
      if (limit && game.activeSpecialCount(kind) >= limit) continue;
    }
    kinds.push(kind);
  }
  return kinds;
}

// classic-2: one special slot replaces the standalone rainbow roll.
export function chooseClassicDrop(random, game) {
  const cap = Math.max(3, Math.min(game.maxLevel, RULES.spawnWeights.length));
  if (game.rulesVersion !== 'classic-2') {
    return { level: chooseClassicLevel(random, game), special: null };
  }
  const busy = game.currentSpecial !== null || game.current === 0;
  if (!busy && game.drops >= SPECIALS.minDrops && random() < SPECIALS.chance) {
    const kind = weightedKind(random, eligibleKinds(game));
    if (kind === 'rainbow') return { level: 0, special: null };
    if (kind) {
      game.specialLastAt[kind] = game.drops;
      return { level: weightedLevel(random, RULES.spawnWeights.slice(0, cap)), special: kind };
    }
  }
  return { level: weightedLevel(random, RULES.spawnWeights.slice(0, cap)), special: null };
}

export function createChallengeSequence({ challengeId, rulesVersion, count }) {
  if (typeof challengeId !== 'string' || !/^[A-Za-z0-9_:-]{1,128}$/.test(challengeId)) {
    throw new Error('invalid_challenge_id');
  }
  if (rulesVersion !== CHALLENGE_RULES.version) throw new Error('unsupported_challenge_rules');
  // Allocation guard only, not the daily mode's drop limit (T09).
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('invalid_sequence_count');
  const seed = seedFromText(JSON.stringify([rulesVersion, challengeId]));
  const rng = new GameplayRandom(seed);
  const random = () => rng.next();
  const levels = [CHALLENGE_RULES.firstLevel];
  while (levels.length < count) {
    if (levels.length >= CHALLENGE_RULES.firstRainbowIndex && levels.at(-1) !== 0 &&
        random() < CHALLENGE_RULES.rainbowChance) {
      levels.push(0);
    } else {
      levels.push(weightedLevel(random, CHALLENGE_RULES.spawnWeights));
    }
  }
  return Object.freeze({ challengeId, rulesVersion, levels: Object.freeze(levels) });
}
