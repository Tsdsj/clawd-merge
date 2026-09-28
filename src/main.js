import { Game, WORLD_W, WORLD_H, enableHaptics } from './game.js';
import { LEVELS, RAINBOW, defOf, drawCrabIcon, drawLegendIcon } from './crabs.js';
import { sfx } from './audio.js';
import { leaderboard } from './leaderboard.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const board = $('board');
const canvas = $('game');
const scoreEl = $('score');
const bestEl = $('best');
const nextCanvas = $('next');
const overlay = $('overlay');
const soundBtn = $('sound');
const clawBtn = $('claw');

// Collection: the evolution chain plus the rainbow wildcard. Clawds never
// created on this device show as dark silhouettes named "???".
const legend = [...LEVELS.map((_, i) => i + 1), RAINBOW].map((level) => {
  const item = document.createElement('div');
  item.className = 'legend-item';
  const icon = document.createElement('canvas');
  const name = document.createElement('span');
  item.append(icon, name);
  $('legend').append(item);
  return { level, item, icon, name };
});

let dpr = 1;
let overTimer = 0;

function drawLegend() {
  for (const { level, item, icon, name } of legend) {
    const seen = game.seen.has(level);
    item.classList.toggle('hidden', level === RAINBOW && !seen);
    item.classList.toggle('locked', !seen);
    name.textContent = seen ? defOf(level).name : '???';
    drawLegendIcon(icon, level, dpr, !seen);
  }
}

const game = new Game(canvas, {
  onScore(score, best) {
    if (Number(scoreEl.textContent) !== score) {
      scoreEl.classList.remove('bump');
      void scoreEl.offsetWidth; // restart the animation
      scoreEl.classList.add('bump');
    }
    scoreEl.textContent = score;
    bestEl.textContent = best;
  },
  onNext(level) {
    drawCrabIcon(nextCanvas, level, 34, 24, dpr);
  },
  onLevel(max) {
    for (const { level, item } of legend) item.classList.toggle('reached', level >= 1 && level <= max);
  },
  onDiscover() {
    drawLegend();
  },
  onClaws(count, active) {
    $('claw-count').textContent = count;
    clawBtn.disabled = count === 0 && !active;
    clawBtn.classList.toggle('active', active);
    board.classList.toggle('claw-mode', active);
  },
  onFever(active) {
    board.classList.toggle('fever', active);
  },
  onGameOver({ score, best, maxLevel, isNewBest }) {
    $('final').textContent = score;
    $('final-best').textContent = best;
    $('final-level').textContent = defOf(maxLevel).name;
    $('new-best').classList.toggle('hidden', !isNewBest);
    overTimer = setTimeout(() => overlay.classList.remove('hidden'), 700);
    submitScore({ score, drops: game.drops, maxLevel });
  },
});
game.debug = new URLSearchParams(location.search).has('debug');

function restart() {
  if (modalOpen()) return;
  clearTimeout(overTimer);
  overlay.classList.add('hidden');
  game.reset();
  leaderboard.startSession();
}

// ---------- leaderboard ----------

const nameModal = $('name-modal');
const rankModal = $('rank-modal');
const finalRank = $('final-rank');
const modalOpen = () => document.body.classList.contains('modal-open');

function showModal(modal, open) {
  modal.classList.toggle('hidden', !open);
  document.body.classList.toggle('modal-open', !nameModal.classList.contains('hidden') || !rankModal.classList.contains('hidden'));
}

function showPlayer() {
  const { player, enabled } = leaderboard;
  $('player-chip').textContent = player ? player.name : '';
  $('player-chip').classList.toggle('hidden', !player);
  $('rank-btn').classList.toggle('hidden', !enabled);
  $('over-rank').classList.toggle('hidden', !enabled);
}

function askName(message = '') {
  drawCrabIcon($('name-crab'), 1, 64, 40, dpr);
  $('name-error').textContent = message;
  $('name-offline').classList.add('hidden');
  showModal(nameModal, true);
  setTimeout(() => $('name-input').focus(), 50);
}

$('name-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('name-input').value.trim();
  const button = $('name-submit');
  button.disabled = true;
  $('name-error').textContent = '';
  try {
    await leaderboard.register(name);
    showModal(nameModal, false);
    showPlayer();
    restart();
  } catch (err) {
    $('name-error').textContent = err.message;
    // Can't reach the server: don't lock the player out of the game.
    if (err.code === 'offline') $('name-offline').classList.remove('hidden');
  } finally {
    button.disabled = false;
  }
});

$('name-offline').addEventListener('click', () => {
  leaderboard.enabled = false;
  showModal(nameModal, false);
  showPlayer();
});

leaderboard.onUnauthorized = () => {
  leaderboard.forget();
  showPlayer();
  askName('身份已失效，请重新起个名字');
};

async function submitScore(result) {
  finalRank.classList.add('hidden');
  if (!leaderboard.enabled || !leaderboard.player || result.score === 0) return;
  finalRank.className = 'final-rank';
  finalRank.textContent = '正在上传成绩…';
  try {
    const { rank, improved } = await leaderboard.submit(result);
    finalRank.textContent = improved ? `个人最佳! 全球排名 #${rank}` : `你的最佳成绩排名 #${rank}`;
  } catch (err) {
    finalRank.className = 'final-rank error';
    finalRank.textContent = err.message;
  }
}

async function openRanks() {
  const list = $('rank-list');
  const meRow = $('rank-me');
  list.innerHTML = '<li class="status">加载中…</li>';
  meRow.classList.add('hidden');
  showModal(rankModal, true);
  try {
    const entries = await leaderboard.top(50);
    list.replaceChildren(...entries.map((e) => rankRow(e, e.name === leaderboard.player?.name)));
    if (!entries.length) list.innerHTML = '<li class="status">还没有人上榜，快来当第一名!</li>';
    if (leaderboard.player && !entries.some((e) => e.name === leaderboard.player.name)) {
      const me = await leaderboard.me();
      if (me.rank) {
        meRow.replaceChildren(...rankRow({ rank: me.rank, name: me.name, score: me.best, level: me.bestLevel }).children);
        meRow.classList.remove('hidden');
      }
    }
  } catch (err) {
    list.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'status';
    li.textContent = err.message;
    list.append(li);
  }
}

function rankRow({ rank, name, score, level }, isMe = false) {
  const li = document.createElement('li');
  li.classList.toggle('me', isMe);
  const no = document.createElement('span');
  no.className = 'rank-no';
  no.textContent = rank;
  const who = document.createElement('span');
  who.className = 'rank-name';
  who.textContent = name;
  const icon = document.createElement('canvas');
  drawLegendIcon(icon, Math.max(1, level), dpr);
  icon.title = defOf(Math.max(1, level)).name;
  const pts = document.createElement('span');
  pts.className = 'rank-score';
  pts.textContent = score;
  li.append(no, who, icon, pts);
  return li;
}

$('rank-btn').addEventListener('click', openRanks);
$('over-rank').addEventListener('click', openRanks);
$('rank-close').addEventListener('click', () => showModal(rankModal, false));
rankModal.addEventListener('click', (e) => {
  if (e.target === rankModal) showModal(rankModal, false);
});

// Fit the board into whatever space is left between header and legend.
function layout() {
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  // Icons first: they affect the legend's height and thus the space left for the board.
  drawLegend();
  drawCrabIcon(nextCanvas, game.next, 34, 24, dpr);
  const rect = stage.getBoundingClientRect();
  const availW = rect.width - 8;
  const availH = rect.height - 8;
  if (availW <= 0 || availH <= 0) return;
  let w = availW;
  let h = (w * WORLD_H) / WORLD_W;
  if (h > availH) {
    h = availH;
    w = (h * WORLD_W) / WORLD_H;
  }
  w = Math.floor(w);
  h = Math.floor((w * WORLD_H) / WORLD_W);
  board.style.width = `${w}px`;
  board.style.height = `${h}px`;
  game.resize(w, h, dpr);
}

// ---------- input ----------

const toWorld = (e) => {
  const r = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * WORLD_W,
    y: ((e.clientY - r.top) / r.height) * WORLD_H,
  };
};

let aiming = false;

board.addEventListener('pointerdown', (e) => {
  sfx.unlock();
  if (e.isTrusted && e.pointerType === 'touch') enableHaptics();
  if (game.over) return;
  const p = toWorld(e);
  if (game.clawMode) {
    game.useClawAt(p.x, p.y);
    return;
  }
  aiming = true;
  board.setPointerCapture(e.pointerId);
  game.setAim(p.x);
});

board.addEventListener('pointermove', (e) => {
  if (aiming || e.pointerType === 'mouse') game.setAim(toWorld(e).x);
});

board.addEventListener('pointerup', (e) => {
  if (!aiming) return;
  aiming = false;
  game.setAim(toWorld(e).x);
  game.requestDrop();
});

board.addEventListener('pointercancel', () => {
  aiming = false;
});

board.addEventListener('contextmenu', (e) => e.preventDefault());
// iOS Safari ignores user-scalable=no; block pinch-zoom gestures explicitly.
document.addEventListener('gesturestart', (e) => e.preventDefault());

const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (modalOpen()) {
    if (e.code === 'Escape' && !rankModal.classList.contains('hidden')) showModal(rankModal, false);
    return; // let the name input receive keys
  }
  if (e.code === 'ArrowLeft' || e.code === 'KeyA' || e.code === 'ArrowRight' || e.code === 'KeyD') {
    keys.add(e.code);
  } else if (e.code === 'Space' || e.code === 'ArrowDown' || e.code === 'Enter') {
    e.preventDefault();
    sfx.unlock();
    if (game.over) restart();
    else if (!e.repeat) game.requestDrop();
  } else if (e.code === 'KeyR') {
    restart();
  } else if (e.code === 'KeyC') {
    game.toggleClaw();
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

$('restart').addEventListener('click', restart);
$('again').addEventListener('click', restart);
clawBtn.addEventListener('click', () => {
  sfx.unlock();
  game.toggleClaw();
});

soundBtn.classList.toggle('muted', !sfx.enabled);
soundBtn.addEventListener('click', () => soundBtn.classList.toggle('muted', !sfx.toggle()));

// ---------- loop ----------

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = (now - last) / 1000;
  last = now;
  const dir = (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('KeyA') ? 1 : 0);
  if (dir) game.setAim(game.clampAim(game.aimX, game.current) + dir * 280 * Math.min(dt, 0.05));
  game.update(dt);
  game.render();
}

document.addEventListener('visibilitychange', () => {
  last = performance.now();
});
window.addEventListener('resize', layout);
new ResizeObserver(layout).observe(stage);

layout();
requestAnimationFrame(frame);
showPlayer();
if (leaderboard.enabled && !leaderboard.player) askName();
else leaderboard.startSession();

// Handy for debugging from the console.
window.clawd = game;
