import { Game } from '../src/game.js';
import { sfx } from '../src/audio.js';
import { createChallengeSequence } from '../src/drop-sequence.js';
for (const key of Object.keys(sfx)) if (typeof sfx[key] === 'function') sfx[key] = () => {};
const status = document.querySelector('#status');
const result = document.querySelector('#result');
const button = document.querySelector('#run');
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function game(selector, seed) {
  const g = new Game(document.querySelector(selector), {}, { seed });
  g.best = g.bestAtStart = 999_999_999;
  g.seen = new Set(Array.from({ length: 12 }, (_, i) => i));
  g.resize(280, 448, devicePixelRatio);
  return g;
}
button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = '验证中…';
  try {
    const response = await fetch('./fixtures/daily-1.json');
    if (!response.ok) throw new Error('无法读取版本向量');
    const vectors = await response.json();
    for (const expected of vectors) {
      if (!equal(createChallengeSequence({ ...expected, count: 100 }), expected)) {
        throw new Error('浏览器挑战序列不匹配版本向量');
      }
    }
    const quiet = game('#quiet', 78), busy = game('#busy', 78);
    const left = [], right = [];
    for (let i = 0; i < 100; i++) {
      await frame();
      left.push(quiet.current); right.push(busy.current);
      quiet.drop(); busy.drop();
      busy.burst(140, 200, 40); busy.confetti();
      busy.world.bodies[0].blinkAt = -1;
      quiet.update(1 / 60); quiet.render();
      for (let j = 0; j < 4; j++) { busy.update(1 / 240); busy.render(); }
      quiet.world.clear(); busy.world.clear();
    }
    if (!equal(left, right)) throw new Error('额外特效改变了玩法序列');
    const saved = JSON.parse(JSON.stringify(quiet.snapshot()));
    busy.restore(saved); busy.setPaused(false);
    const future = [], resumed = [];
    for (let i = 0; i < 30; i++) {
      future.push(quiet.current); resumed.push(busy.current);
      quiet.drop(); busy.drop(); quiet.world.clear(); busy.world.clear();
    }
    if (!equal(future, resumed)) throw new Error('存档恢复后的序列改变');
    quiet.render(); busy.render();
    result.textContent = JSON.stringify({
      userAgent: navigator.userAgent, vectors: 2, vectorLevels: 100,
      visualIsolationDrops: 100, resumeDrops: 30,
      challenge: createChallengeSequence({ challengeId: '2026-10-02', rulesVersion: 'daily-1', count: 100 }),
      conclusion: '全部通过；仅证明序列，不证明跨设备物理回放。',
    }, null, 2);
    status.textContent = '全部通过：版本向量、绘制隔离、续玩序列';
  } catch (error) {
    status.textContent = `失败：${error.message}`;
  } finally { button.disabled = false; }
});
