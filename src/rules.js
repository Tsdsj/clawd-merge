// Change versioned rules rather than silently changing an existing daily puzzle.
export const CLASSIC_RULES_VERSION = 'classic-1';
export const CHALLENGE_RULES_VERSION = 'daily-1';

export const RULES = Object.freeze({
  dangerGrace: 1.2, // newborns do not count toward game over yet
  gameOverTime: 3,
  landedTime: 0.15, // must be connected to the pile and no longer flying
  flyingSpeed: 250,
  spawnWeights: Object.freeze([22, 22, 22, 18, 16]), // only the five smallest drop
  points: k => 2 ** k,
  comboStep: 0.25,
  maxComboMult: 2,
});
export const DROP_COOLDOWN = 0.5;
export const COMBO_WINDOW = 1.2;
export const FEVER_MAX = 180;
export const FEVER_TIME = 8;
export const RAINBOW_CHANCE = 0.035;
export const RAINBOW_MIN_DROPS = 15;
export const CLAW_LEVEL = 7;
export const MAX_CLAWS = 3;
export const KING_BONUS = 2000;

// T08 defines the puzzle sequence; daily attempts/timing and ranked admission
// belong to T09/T10 and are deliberately not implied by this local definition.
export const CHALLENGE_RULES = Object.freeze({
  version: CHALLENGE_RULES_VERSION,
  firstLevel: 1,
  spawnWeights: RULES.spawnWeights,
  rainbowChance: RAINBOW_CHANCE,
  // Classic's look-ahead generates item index 16 after the 15th drop.
  firstRainbowIndex: RAINBOW_MIN_DROPS + 1,
  consecutiveRainbows: false,
});
