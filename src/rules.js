// Change versioned rules rather than silently changing an existing daily puzzle.
export const CLASSIC_RULES_VERSION = 'classic-2';
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

// classic-2 特殊掉落与后期目标；classic-1 行为保持在其版本内不变。
export const CLASSIC_RULES_VERSIONS = ['classic-1', 'classic-2'];
export const SPECIAL_KINDS = Object.freeze(['gold', 'magnet', 'freeze']);
export const SPECIALS = Object.freeze({
  minDrops: 12,
  chance: 0.06,
  weights: Object.freeze({ rainbow: 40, gold: 25, magnet: 20, freeze: 15 }),
  kindCooldown: 25,
  maxActive: Object.freeze({ magnet: 1, freeze: 1 }),
  magnet: Object.freeze({ seconds: 2.5, radius: 130, accel: 320 }),
  freeze: Object.freeze({ seconds: 3 }),
});
export const CROWN_MAX = 3;
export const CROWN_BONUS = 5000;
