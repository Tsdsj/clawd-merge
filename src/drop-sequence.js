import { GameplayRandom, seedFromText } from './random.js';
import { RULES, RAINBOW_CHANCE, RAINBOW_MIN_DROPS, CHALLENGE_RULES } from './rules.js';

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
