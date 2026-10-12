// Headless balance probe for classic-2 specials (README's simulated-player
// tradition). Not part of npm test; run directly with node.
globalThis.localStorage = { getItem: () => 'off', setItem() {} };
const { Game, WORLD_W } = await import('../src/game.js');

const STRATEGIES = {
  sameSpot: (g) => WORLD_W / 2,
  random: (g) => Math.random() * WORLD_W,
  greedy: (g) => {
    let best = null;
    let bestD = Infinity;
    for (const b of g.world.bodies) {
      if (b.level !== g.current) continue;
      const d = Math.abs(b.x - g.aimX);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best ? best.x : WORLD_W / 2;
  },
};

function run(rulesVersion, strategy, seedBase, games = 150) {
  let total = 0;
  let max = 0;
  for (let i = 0; i < games; i++) {
    const g = new Game({ getContext: () => ({}) }, {}, { seed: seedBase + i, rulesVersion });
    let guard = 0;
    while (!g.over && g.drops < 300 && guard < 100000) {
      guard++;
      if (g.choice) g.resolveChoice('ascend');
      if (g.cooldown === 0 && !g.over) {
        g.setAim(STRATEGIES[strategy](g));
        g.drop();
      }
      g.update(1 / 60);
    }
    total += g.score;
    max = Math.max(max, g.score);
  }
  return { mean: Math.round(total / games), max };
}

const results = {};
for (const version of ['classic-1', 'classic-2']) {
  for (const strategy of Object.keys(STRATEGIES)) {
    results[`${version}/${strategy}`] = run(version, strategy, 781903, 150);
  }
}
for (const [key, r] of Object.entries(results)) {
  console.log(`${key.padEnd(22)} mean ${String(r.mean).padStart(6)}  max ${r.max}`);
}
for (const strategy of ['sameSpot', 'random', 'greedy']) {
  const a = results[`classic-1/${strategy}`].mean;
  const b = results[`classic-2/${strategy}`].mean;
  const uplift = a ? Math.round(((b - a) / a) * 100) : NaN;
  console.log(`uplift ${strategy.padEnd(8)} ${uplift >= 0 ? '+' : ''}${uplift}%`);
}
