import { Game, WORLD_W, WORLD_H, enableHaptics } from './game.js';
import { LEVELS, RAINBOW, defOf, drawCrabIcon, drawLegendIcon } from './crabs.js';
import { sfx } from './audio.js';
import { leaderboard, displayName } from './leaderboard.js';
import { createGuide } from './onboarding.js';
import { PauseState } from './pause.js';

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
const guide = createGuide(localStorage, Boolean(leaderboard.player));
let roundVersion = 0;
const pauses = new PauseState(syncPause);

function updateGuide() {
  const step = guide.step;
  $('guide').classList.toggle('hidden', !step || game.over);
  $('first-drop').classList.toggle('hidden', !step || game.drops > 0 || game.over);
  if (!step) return;
  $('guide-title').textContent = `怎么玩 · ${step} / 3`;
  $('guide-text').textContent = [
    '左右瞄准，点一下或松手，落下第一只 Clawd。',
    '相同的 Clawd 碰到一起会升级，留意“下一个”。',
    '落稳后超过危险线 3 秒就结束，尽量留出空间。',
  ][step - 1];
}

function featureTip(feature, message) {
  if (guide.discover(feature)) toast(message, 4500);
}

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
    if (level === RAINBOW) featureTip('rainbow', '彩虹 Clawd：碰到谁，就让谁升一级。');
  },
  onDrop(drops) {
    guide.advance(drops);
    updateGuide();
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
    if (count > 0) featureTip('claw', '获得钳子！点钳子，再点一只 Clawd，就能夹走它。');
  },
  onFever(active) {
    board.classList.toggle('fever', active);
    if (active) featureTip('fever', '狂热模式：接下来 8 秒，合成得分翻倍！');
  },
  onGameOver({ score, best, maxLevel, isNewBest }) {
    pauses.clear();
    $('final').textContent = score;
    $('final-best').textContent = best;
    $('final-level').textContent = defOf(maxLevel).name;
    $('new-best').classList.toggle('hidden', !isNewBest);
    updateGuide();
    overTimer = setTimeout(() => overlay.classList.remove('hidden'), 700);
    submitScore({ score, drops: game.drops, maxLevel });
  },
});
game.debug = new URLSearchParams(location.search).has('debug');

function restart() {
  if (modalOpen()) return;
  if (!game.over && game.drops > 0) {
    showModal(restartModal, true);
    return;
  }
  restartNow();
}

function restartNow() {
  if (!restartModal.classList.contains('hidden')) showModal(restartModal, false);
  clearTimeout(overTimer);
  overlay.classList.add('hidden');
  game.reset();
  pauses.clear();
  beginRound();
  updateGuide();
  board.focus({ preventScroll: true });
}

function clearInputs() {
  aiming = false;
  keys.clear();
  game.pendingDrop = false;
  if (activePointer !== null && board.hasPointerCapture(activePointer)) board.releasePointerCapture(activePointer);
  activePointer = null;
}

function syncPause() {
  clearInputs();
  game.setPaused(!game.over && pauses.paused);
  last = performance.now();
  document.body.classList.toggle('game-paused', game.paused);
  const showCover = !game.over && (pauses.has('manual') || pauses.has('background'));
  $('pause-cover').classList.toggle('hidden', !showCover);
  $('pause-btn').textContent = showCover ? '继续' : '暂停';
  $('pause-btn').disabled = game.over;
  $('pause-title').textContent = pauses.has('background') ? '欢迎回来' : '已暂停';
  $('pause-copy').textContent = pauses.has('background')
    ? '离开时已经暂停，准备好了再继续。' : '这一局先放在这里。准备好了，再继续。';
  $('paused-score').textContent = game.score;
  $('paused-rank').classList.toggle('hidden', !leaderboard.enabled);
  clawBtn.disabled = game.paused || (game.claws === 0 && !game.clawMode);
}

function togglePause() {
  if (game.over || modalOpen()) return;
  if (pauses.has('manual') || pauses.has('background')) {
    pauses.resume();
    board.focus({ preventScroll: true });
  } else {
    pauses.set('manual', true);
    $('resume-btn').focus({ preventScroll: true });
  }
}

function backgroundPause() {
  clearInputs();
  if (!game.over && (game.drops > 0 || pauses.paused || modalOpen())) pauses.set('background', true);
  last = performance.now();
}

function beginRound() {
  const version = ++roundVersion;
  leaderboard.startSession().then(() => {
    if (version === roundVersion) showPlayer();
  });
  $('local-result').classList.add('hidden');
  $('result-join').classList.add('hidden');
  $('next-round-note').classList.add('hidden');
  finalRank.classList.add('hidden');
  showPlayer();
}

// ---------- leaderboard & account ----------

const nameModal = $('name-modal');
const rankModal = $('rank-modal');
const accountModal = $('account-modal');
const helpModal = $('help-modal');
const restartModal = $('restart-modal');
const finalRank = $('final-rank');
const modals = [nameModal, rankModal, accountModal, helpModal, restartModal];
const modalOpen = () => document.body.classList.contains('modal-open');
const modalFocus = new WeakMap();

function showModal(modal, open) {
  if (open) modalFocus.set(modal, document.activeElement);
  modal.classList.toggle('hidden', !open);
  const anyOpen = modals.some((m) => !m.classList.contains('hidden'));
  document.body.classList.toggle('modal-open', anyOpen);
  document.querySelector('.app').inert = anyOpen;
  clearInputs();
  pauses.set('modal', anyOpen);
  if (open) modal.querySelector('button:not(:disabled), input')?.focus();
  else if (!anyOpen) {
    const previous = modalFocus.get(modal);
    const target = !game.over && pauses.has('background') ? $('resume-btn')
      : previous?.getClientRects().length ? previous : board;
    target.focus({ preventScroll: true });
  }
}

let toastTimer = 0;
function toast(text, duration = 2600) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), duration);
}

// LINUX DO avatar, or an orange dot for guests.
function avatarEl(p) {
  if (p.linuxdo && p.avatar) {
    const img = document.createElement('img');
    img.className = 'avatar';
    img.src = p.avatar;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    return img;
  }
  const dot = document.createElement('span');
  dot.className = 'chip-dot';
  return dot;
}

// Name with a muted #tag for guests and a small "L" badge for LINUX DO accounts.
function nameEl(p, className) {
  const span = document.createElement('span');
  span.className = className;
  span.append(p.name);
  if (p.tag) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = `#${p.tag}`;
    span.append(tag);
  }
  if (p.linuxdo) {
    const badge = document.createElement('span');
    badge.className = 'ld-badge';
    badge.textContent = 'L';
    badge.title = `LINUX DO · 信任等级 ${p.trustLevel ?? 0}`;
    span.append(badge);
  }
  return span;
}

function showPlayer() {
  const { player, enabled } = leaderboard;
  const chip = $('player-chip');
  chip.replaceChildren();
  if (player) chip.append(avatarEl(player), nameEl(player, 'chip-name'));
  chip.classList.toggle('hidden', !player || !enabled);
  $('join-btn').classList.toggle('hidden', Boolean(player) || !enabled);
  $('rank-btn').classList.toggle('hidden', !enabled);
  $('over-rank').classList.toggle('hidden', !enabled);
  const state = leaderboard.sessionStatus;
  $('round-status').textContent = {
    pending: '正在连接排行榜，本局可继续玩…',
    online: '本局参与排名',
    offline: '暂时连不上排行榜，本局为本地游玩。',
    local: player ? '本局为本地局，下一局再参与排名' : '本地游玩 · 成绩仅保存在本机',
  }[state];
  $('round-status').classList.toggle('connection-error', state === 'offline');
  if (game.over) showLocalResult();
}

function showLocalResult() {
  const local = !['pending', 'online'].includes(leaderboard.sessionStatus);
  $('local-result').classList.toggle('hidden', !local);
  $('local-result').textContent = '本局为本地游玩，不参与排名；最佳成绩保存在本机。';
  const canJoin = local && leaderboard.enabled && !leaderboard.player;
  $('result-join').classList.toggle('hidden', !canJoin);
  $('next-round-note').classList.toggle('hidden', !local || !leaderboard.enabled);
  $('next-round-note').textContent = leaderboard.player
    ? '下一局连接成功后参与排名，本局无法补交。'
    : '加入后从下一局开始上榜，本局无法补交。';
}

function askName(message = '') {
  drawCrabIcon($('name-crab'), 1, 64, 40, dpr);
  $('name-error').textContent = message;
  showModal(nameModal, true);
}

$('join-btn').addEventListener('click', () => askName());
$('result-join').addEventListener('click', () => askName());
$('name-close').addEventListener('click', () => showModal(nameModal, false));
$('help-btn').addEventListener('click', () => showModal(helpModal, true));
$('help-close').addEventListener('click', () => showModal(helpModal, false));
$('cancel-restart').addEventListener('click', () => showModal(restartModal, false));
$('confirm-restart').addEventListener('click', restartNow);
$('pause-btn').addEventListener('click', togglePause);
$('resume-btn').addEventListener('click', togglePause);
$('guide-dismiss').addEventListener('click', () => { guide.dismiss(); updateGuide(); });
for (const modal of [nameModal, helpModal]) modal.addEventListener('click', (e) => {
  if (e.target === modal) showModal(modal, false);
});

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
    guide.dismiss();
    updateGuide();
    board.focus();
    toast('已加入！本局继续本地游玩，下一局参与排名。', 4500);
  } catch (err) {
    $('name-error').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$('name-offline').addEventListener('click', () => {
  showModal(nameModal, false);
});

// Leaves the page for LINUX DO; comes back with #login=<code>.
async function goLinuxdo(button, errorEl) {
  if (game.drops > 0 && !game.over && !confirm('登录将离开当前页面，本局进度不会保存。现在去登录吗？')) return;
  button.disabled = true;
  errorEl.textContent = '';
  try {
    await leaderboard.loginWithLinuxdo();
  } catch (err) {
    errorEl.textContent = err.message;
    button.disabled = false;
  }
}
$('ld-login').addEventListener('click', (e) => goLinuxdo(e.currentTarget, $('name-error')));
$('acc-ld').addEventListener('click', (e) => goLinuxdo(e.currentTarget, $('acc-error')));

function openAccount(message = '') {
  const p = leaderboard.player;
  if (!p) return;
  const hasAvatar = Boolean(p.linuxdo && p.avatar);
  $('acc-avatar').classList.toggle('hidden', !hasAvatar);
  if (hasAvatar) $('acc-avatar').src = p.avatar;
  $('acc-crab').classList.toggle('hidden', hasAvatar);
  drawCrabIcon($('acc-crab'), 1, 64, 40, dpr);
  $('acc-name').replaceChildren(nameEl(p, ''));
  $('acc-sub').textContent = p.linuxdo
    ? `LINUX DO 账号 · 信任等级 ${p.trustLevel ?? 0}`
    : '游客 · 身份只保存在这个浏览器';
  $('acc-guest').classList.toggle('hidden', p.linuxdo);
  $('rename-input').value = '';
  $('acc-error').textContent = message;
  showModal(accountModal, true);
}

$('player-chip').addEventListener('click', () => openAccount());
$('acc-close').addEventListener('click', () => showModal(accountModal, false));
accountModal.addEventListener('click', (e) => {
  if (e.target === accountModal) showModal(accountModal, false);
});

$('rename-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await leaderboard.rename($('rename-input').value.trim());
    showPlayer();
    openAccount();
    toast('改好名字了');
  } catch (err) {
    $('acc-error').textContent = err.message;
  }
});

$('acc-logout').addEventListener('click', async () => {
  const guest = !leaderboard.player?.linuxdo;
  if (guest && !confirm('游客身份只存在这个浏览器里，退出后这个名字和成绩就找不回来了。确定退出吗？')) return;
  const pending = leaderboard.logout();
  showModal(accountModal, false);
  showPlayer();
  toast('已退出，本局可继续本地游玩。');
  await pending;
});

leaderboard.onUnauthorized = () => {
  leaderboard.forget();
  showPlayer();
  toast('登录已失效，本局继续本地游玩。可随时重新加入。', 4500);
};

async function submitScore(result) {
  const version = roundVersion;
  finalRank.classList.add('hidden');
  showLocalResult();
  if (!leaderboard.enabled || !['pending', 'online'].includes(leaderboard.sessionStatus)) return;
  if (result.score === 0) {
    finalRank.className = 'final-rank';
    finalRank.textContent = '本局未得分，再试一次吧。';
    return;
  }
  finalRank.className = 'final-rank';
  finalRank.textContent = '正在上传成绩…';
  try {
    const { rank, improved } = await leaderboard.submit(result);
    if (version !== roundVersion) return;
    finalRank.textContent = improved ? `个人最佳! 全球排名 #${rank}` : `你的最佳成绩排名 #${rank}`;
  } catch (err) {
    if (version !== roundVersion) return;
    finalRank.className = 'final-rank error';
    finalRank.textContent = err.message;
  }
}

const RANK_PAGE = 20;
const RANK_MAX = 100; // the API returns at most this many
let rankLimit = RANK_PAGE;

function rankStatus(text) {
  const li = document.createElement('li');
  li.className = 'status';
  li.textContent = text;
  return li;
}

async function openRanks() {
  rankLimit = RANK_PAGE;
  $('rank-list').replaceChildren(rankStatus('加载中…'));
  $('rank-count').textContent = '';
  $('rank-me').classList.add('hidden');
  showModal(rankModal, true);
  await loadRanks();
}

async function loadRanks() {
  const list = $('rank-list');
  const meRow = $('rank-me');
  try {
    const myId = leaderboard.player?.id;
    const [{ entries, total }, me] = await Promise.all([
      leaderboard.top(rankLimit),
      myId ? leaderboard.me().catch(() => null) : null,
    ]);
    $('rank-count').textContent = total ? `共 ${total} 人上榜` : '';
    if (!entries.length) {
      list.replaceChildren(rankStatus('还没有人上榜，快来当第一名!'));
    } else {
      list.replaceChildren(...entries.map((e) => rankRow(e, e.id === myId)));
      // More players than shown (and the API can serve more): offer the next page.
      if (total > entries.length && rankLimit < RANK_MAX) {
        const li = document.createElement('li');
        li.className = 'more';
        const btn = document.createElement('button');
        btn.className = 'link-btn';
        btn.textContent = `查看更多（第 ${entries.length + 1} ~ ${Math.min(total, rankLimit + RANK_PAGE, RANK_MAX)} 名）`;
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = '加载中…';
          const scroll = list.scrollTop;
          rankLimit = Math.min(RANK_MAX, rankLimit + RANK_PAGE);
          await loadRanks();
          list.scrollTop = scroll;
        });
        li.append(btn);
        list.append(li);
      }
    }

    // Always pin "my rank" at the bottom so players can find themselves.
    meRow.classList.toggle('hidden', !me);
    if (me) {
      const shown = me.rank && me.rank <= entries.length;
      const card = me.rank
        ? rankRow({ ...me.player, rank: me.rank, score: me.best, level: me.bestLevel }, true)
        : null;
      const label = document.createElement('span');
      label.className = 'rank-me-label';
      label.textContent = me.rank ? (shown ? '我的名次 · 点击定位' : '我的名次') : '我还没有上榜成绩，打完一局就有了';
      meRow.replaceChildren(label, ...(card ? card.children : []));
      meRow.classList.toggle('clickable', Boolean(shown));
      meRow.onclick = shown
        ? () => {
            const row = list.querySelector('li.me');
            row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            row?.classList.remove('flash');
            void row?.offsetWidth;
            row?.classList.add('flash');
          }
        : null;
    }
  } catch (err) {
    list.replaceChildren(rankStatus(err.message));
  }
}

function rankRow(entry, isMe = false) {
  const li = document.createElement('li');
  li.classList.toggle('me', isMe);
  const no = document.createElement('span');
  no.className = 'rank-no';
  no.textContent = entry.rank;
  const level = Math.max(1, entry.level);
  const icon = document.createElement('canvas');
  drawLegendIcon(icon, level, dpr);
  icon.title = defOf(level).name;
  const pts = document.createElement('span');
  pts.className = 'rank-score';
  pts.textContent = entry.score;
  li.append(no, avatarEl(entry), nameEl(entry, 'rank-name'), icon, pts);
  return li;
}

$('rank-btn').addEventListener('click', openRanks);
$('over-rank').addEventListener('click', openRanks);
$('paused-rank').addEventListener('click', openRanks);
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
let activePointer = null;

board.addEventListener('pointerdown', (e) => {
  sfx.unlock();
  if (e.isTrusted && e.pointerType === 'touch') enableHaptics();
  if (game.over || game.paused || modalOpen()) return;
  const p = toWorld(e);
  if (game.clawMode) {
    game.useClawAt(p.x, p.y);
    return;
  }
  aiming = true;
  activePointer = e.pointerId;
  board.setPointerCapture(e.pointerId);
  game.setAim(p.x);
});

board.addEventListener('pointermove', (e) => {
  if (game.paused || game.over || modalOpen()) return;
  if (aiming || e.pointerType === 'mouse') game.setAim(toWorld(e).x);
});

board.addEventListener('pointerup', (e) => {
  if (!aiming || e.pointerId !== activePointer || game.paused || modalOpen()) return;
  aiming = false;
  activePointer = null;
  game.setAim(toWorld(e).x);
  game.requestDrop();
});

board.addEventListener('pointercancel', () => {
  clearInputs();
});

board.addEventListener('contextmenu', (e) => e.preventDefault());
// iOS Safari ignores user-scalable=no; block pinch-zoom gestures explicitly.
document.addEventListener('gesturestart', (e) => e.preventDefault());

const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (modalOpen()) {
    const active = modals.find((m) => !m.classList.contains('hidden'));
    if (e.code === 'Escape') showModal(active, false);
    if (e.code === 'Tab') {
      const items = [...active.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')]
        .filter((el) => el.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
    return; // let the name input receive keys
  }
  if (e.target.closest('input, textarea') ||
      (e.target.closest('button, a') && ['Space', 'Enter'].includes(e.code))) return;
  if (e.code === 'KeyP') {
    e.preventDefault();
    if (!e.repeat) togglePause();
    return;
  }
  if (e.code === 'KeyR') {
    e.preventDefault();
    if (!e.repeat) restart();
    return;
  }
  if (game.paused) return;
  if (e.code === 'ArrowLeft' || e.code === 'KeyA' || e.code === 'ArrowRight' || e.code === 'KeyD') {
    e.preventDefault();
    keys.add(e.code);
  } else if (e.code === 'Space' || e.code === 'ArrowDown' || e.code === 'Enter') {
    e.preventDefault();
    sfx.unlock();
    if (game.over) restart();
    else if (!e.repeat) game.requestDrop();
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
  if (document.hidden) backgroundPause();
  last = performance.now();
});
window.addEventListener('blur', backgroundPause);
window.addEventListener('pagehide', backgroundPause);
window.addEventListener('resize', layout);
new ResizeObserver(layout).observe(stage);

layout();
updateGuide();
requestAnimationFrame(frame);
initAccount();

async function initAccount() {
  beginRound();
  if (!leaderboard.enabled) return;
  // Back from LINUX DO? The page URL carries a one-time login code (or an error).
  const result = await leaderboard.finishLoginRedirect();
  showPlayer();
  if (result?.player) {
    guide.dismiss();
    updateGuide();
    // The callback may finish after the player has already started a local game.
    if (game.drops === 0 && !game.over) beginRound();
    toast(`欢迎, ${displayName(result.player)}!`);
  }
  if (!leaderboard.player) {
    if (result?.error) toast(result.error, 4500);
    return;
  }
  if (result?.error) toast(result.error, 4500);
  leaderboard.refresh().then(showPlayer);
}

// Handy for debugging from the console.
window.clawd = game;
