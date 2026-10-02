import { Game } from '../src/game.js';
import { sfx } from '../src/audio.js';

// Only this separate page's audio object is muted; no preference is written.
for (const key of Object.keys(sfx)) if (typeof sfx[key] === 'function') sfx[key] = () => {};
const canvas = document.querySelector('#game');
const status = document.querySelector('#status');
const result = document.querySelector('#result');
const button = document.querySelector('#run');
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const round = n => Math.round(n * 1000) / 1000;
  return { mean: round(values.reduce((a, b) => a + b, 0) / values.length), p95: round(sorted[Math.ceil(sorted.length * 0.95) - 1]), max: round(sorted.at(-1)) };
}
function range(values) { return { min: Math.min(...values), max: Math.max(...values) }; }
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));

button.addEventListener('click', async () => {
  button.disabled = true;
  result.textContent = '';
  const random = Math.random;
  let seed = 20261002;
  Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const report = {
    capturedAt: new Date().toISOString(), userAgent: navigator.userAgent,
    viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio,
    seed, warmup: 60, samples: 300, simulationDt: 1 / 60, scenarios: [],
  };
  try {
    for (const name of ['light', 'dense', 'continuous-merges']) {
      status.textContent = `运行中：${name}`;
      const g = new Game(canvas, {}, { seed: 20261002 });
      g.best = g.bestAtStart = Number.MAX_SAFE_INTEGER;
      g.seen = new Set(Array.from({ length: 12 }, (_, i) => i));
      const width = Math.min(400, innerWidth - 40);
      g.resize(width, width * 1.6, devicePixelRatio);
      const times = { update: [], render: [], total: [], rafInterval: [], setup: [] };
      const bodies = [], contacts = [], particles = [];
      let previous = await frame();
      let merges = 0;
      for (let i = 0; i < 360; i++) {
        const now = await frame();
        if (document.hidden) throw new Error('页面不可见，本次采样作废；请保持测试页可见后重跑。');
        const setupStart = performance.now();
        if (i === 0 || (name === 'dense' && i % 30 === 0)) {
          g.world.clear();
          const count = name === 'light' ? 10 : 60;
          for (let j = 0; j < count; j++) {
            const level = 1 + j % 5;
            g.spawnCrab(level, 35 + j % 6 * 65, 610 - Math.floor(j / 6) * 45);
          }
        }
        // Force a steady stream through the real contact/merge path, with effects.
        if (name === 'continuous-merges' && i % 4 === 0) {
          if (g.world.bodies.length > 60) g.world.clear();
          const level = 1 + (i / 4) % 8;
          g.spawnCrab(level, 180, 350);
          g.spawnCrab(level, 185, 350);
        }
        g.danger = 0; // keep synthetic overloaded boards running for the full sample
        g.over = false;
        const start = performance.now();
        const oldScore = g.score;
        g.update(1 / 60);
        const rendered = performance.now();
        g.render();
        const end = performance.now();
        if (g.score > oldScore) merges++;
        if (i >= 60) {
          times.setup.push(start - setupStart);
          times.update.push(rendered - start);
          times.render.push(end - rendered);
          times.total.push(end - start);
          times.rafInterval.push(now - previous);
          bodies.push(g.world.bodies.length);
          contacts.push(g.world.contacts.length);
          particles.push(g.particles.length);
        }
        previous = now;
      }
      report.scenarios.push({ name, framesWithScoreIncrease: merges,
        milliseconds: Object.fromEntries(Object.entries(times).map(([key, values]) => [key, summary(values)])),
        bodies: range(bodies), contacts: range(contacts), particles: range(particles) });
      result.textContent = JSON.stringify(report, null, 2);
    }
    status.textContent = '完成；可复制下方 JSON。';
  } catch (error) {
    status.textContent = `失败：${error.message}`;
  } finally {
    Math.random = random;
    button.disabled = false;
  }
});
