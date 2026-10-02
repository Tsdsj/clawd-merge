import { Game, WORLD_W, WORLD_H, enableHaptics } from './game.js';
import { LEVELS, RAINBOW, defOf, drawCrabIcon, drawLegendIcon } from './crabs.js';
import { sfx } from './audio.js';
import { leaderboard, displayName } from './leaderboard.js';
import { createGuide } from './onboarding.js';
import { PauseState } from './pause.js';
import { createSaveFlow } from './save-flow.js';
import { getStorage } from './storage.js';
import { Outbox } from './outbox.js';
import { createUploadUI } from './upload-ui.js';
import { createChallengeUI } from './challenge-ui.js';
import { createChallengeShareUI } from './challenge-share-ui.js';
import {ComfortSettings} from './comfort.js';
import {createComfortUI} from './comfort-ui.js';
import {avatarEl,nameEl,renderPlayerChip} from './player-identity.js';
const comfortSettings=new ComfortSettings();
let comfortPanel;

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
const guide = createGuide(getStorage(), Boolean(leaderboard.player));
let roundVersion = 0;
const pauses = new PauseState(syncPause);
let saves;
let daily, sharing;
let outbox, uploads;

function updateGuide() {
  const step = guide.step;
  $('guide').classList.toggle('hidden', !step || game.over || Boolean(saves?.blocked));
  $('first-drop').classList.toggle('hidden', !step || game.drops > 0 || game.over || Boolean(saves?.blocked));
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
}, {comfort:()=>comfortSettings.effects});
game.debug = new URLSearchParams(location.search).has('debug');

function restart() {
  if (modalOpen()) return;
  if (saves?.blocked) { saves.show();return; }
  if (!game.over && game.drops > 0) {
    showModal(restartModal, true);
    return;
  }
  restartNow();
}

function restartNow() {
  saves.newGame();
}

function resetRound() {
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
  game.setPaused(!game.over && (pauses.paused || Boolean(daily?.active)));
  last = performance.now();
  document.body.classList.toggle('game-paused', game.paused);
  const showCover = !game.over && !saves?.blocked && (pauses.has('manual') || pauses.has('background'));
  $('pause-cover').classList.toggle('hidden', !showCover);
  $('pause-btn').textContent = showCover ? '继续' : '暂停';
  $('pause-btn').disabled = game.over || Boolean(saves?.blocked);
  $('pause-title').textContent = pauses.has('background') ? '欢迎回来' : '已暂停';
  $('pause-copy').textContent = pauses.has('background')
    ? '离开时已经暂停，准备好了再继续。' : '这一局先放在这里。准备好了，再继续。';
  $('paused-score').textContent = game.score;
  $('paused-rank').classList.toggle('hidden', !leaderboard.enabled);
  clawBtn.disabled = game.paused || (game.claws === 0 && !game.clawMode);
  updateGuide();
}

function togglePause() {
  if (game.over || modalOpen() || saves?.blocked) return;
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
  saves?.flush();
}

function beginRound() {
  uploads?.setCurrent(null);
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
const restartModal = $('restart-modal');
const restoreModal = $('restore-modal');
const pendingModal = $('pending-modal');
const removeResultModal = $('remove-result-modal');
const finalRank = $('final-rank');
const modals = [nameModal, rankModal, accountModal, restartModal, restoreModal,pendingModal,removeResultModal];
const modalOpen = () => document.body.classList.contains('modal-open');
const modalFocus = new WeakMap();

function showModal(modal, open) {
  if(open && daily?.active && modal===restoreModal)return;
  if (modal === restoreModal && !open) saves?.invalidateOffer();
  if (open) modalFocus.set(modal, document.activeElement);
  modal.classList.toggle('hidden', !open);
  const anyOpen = modals.some((m) => !m.classList.contains('hidden'));
  document.body.classList.toggle('modal-open', anyOpen);
  document.querySelector('.app').inert = anyOpen;
  $('daily-app').inert = anyOpen;daily?.setExternalModal(anyOpen);
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

function showPlayer() {
  daily?.identityChanged();
  outbox?.wakeIdentity();
  const { player, enabled } = leaderboard;
  const chip = $('player-chip');
  renderPlayerChip(chip,player);
  chip.classList.toggle('hidden', !player || !enabled);
  $('join-btn').classList.toggle('hidden', Boolean(player) || !enabled);
  $('rank-btn').classList.toggle('hidden', !enabled);
  $('over-rank').classList.toggle('hidden', !enabled);
  const state = leaderboard.sessionStatus;
  $('round-status').textContent = leaderboard.sessionMessage;
  $('round-status').classList.toggle('connection-error', state === 'offline');
  if (game.over) showLocalResult();
}

function showLocalResult() {
  const local = !uploads?.hasCurrent() && !['pending', 'online'].includes(leaderboard.sessionStatus);
  $('local-result').classList.toggle('hidden', !local);
  $('local-result').textContent = game.persistenceWarning
    ? '本局为本地游玩，不参与排名；浏览器保存失败，请勿关闭页面。'
    : '本局为本地游玩，不参与排名；最佳成绩保存在本机。';
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
  $('name-round-note').textContent=daily?.active?'练习不能补交成正式成绩；选择身份本身不会扣正式机会。':'当前本地局不能补交。局中登录会离开页面，建议打完后再加入。';
  $('name-title').textContent=daily?.active?'选择身份，参加正式挑战':'让下一局，登上榜单';
  nameModal.querySelector('.sheet-sub').textContent=daily?.active?'游客与 LINUX DO 都可参加；领取正式凭证后才消耗机会。':'不加入也能继续玩。选择一个身份，让下一局成绩参与排名。';
  showModal(nameModal, true);
}

$('join-btn').addEventListener('click', () => askName());
$('result-join').addEventListener('click', () => askName());
$('name-close').addEventListener('click', () => showModal(nameModal, false));
$('help-btn').addEventListener('click', () => comfortPanel.open({mode:'classic'}));
$('cancel-restart').addEventListener('click', () => showModal(restartModal, false));
$('confirm-restart').addEventListener('click', restartNow);
$('pause-btn').addEventListener('click', togglePause);
$('resume-btn').addEventListener('click', togglePause);
$('guide-dismiss').addEventListener('click', () => { guide.dismiss(); updateGuide(); });
for (const modal of [nameModal]) modal.addEventListener('click', (e) => {
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
    toast(daily?.active?'身份已就绪，可在每日挑战入口确认正式开局。':'已加入！本局继续本地游玩，下一局参与排名。', 4500);
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
  if(daily&&!daily.canNavigateForAuth()){errorEl.textContent='每日挑战还有进度或结果未安全保存，请先重试保存或处理记录，再离开页面登录。';return;}
  if(leaderboard.player&&!leaderboard.player.linuxdo&&daily?.hasBoundWork(leaderboard.player.id)){errorEl.textContent='绑定前请先处理每日挑战中的未完成正式局、未知开局或待提交成绩。';return;}
  const unsettled=leaderboard.player&&!leaderboard.player.linuxdo&&uploads.hasUnresolved(leaderboard.player.id);
  const unsaved=outbox.list().some(e=>!e.durable&&!e.journaled&&e.state!=='accepted');
  if(unsettled||unsaved) {
    uploads.open(unsaved?'有成绩尚未保存，请先重试保存或明确移除，再离开页面登录。':'绑定前还有游客成绩待处理，请先补传或明确移除记录。');
    return;
  }
  if (game.drops > 0 && !game.over) { const saved=saves?.flush();if(!confirm(saved?'登录会离开页面，已保存的经典局可以续玩。现在去登录吗？':'当前经典局尚未保存成功，离开可能丢失进度。仍去登录吗？'))return; }
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
$('acc-reauth').addEventListener('click', (e) => goLinuxdo(e.currentTarget, $('acc-error')));

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
  $('acc-reauth').classList.toggle('hidden', !p.linuxdo);
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
  if(daily?.hasBoundWork(leaderboard.player?.id)){$('acc-error').textContent='退出前请先处理每日挑战的正式资格、未确认开局和待提交成绩。';return;}
  const guest = !leaderboard.player?.linuxdo;
  if(guest && uploads.hasUnresolved(leaderboard.player?.id)) {
    uploads.open('退出游客身份前，请先补传或明确移除待处理成绩。');return;
  }
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
  const version=roundVersion;
  finalRank.classList.add('hidden');
  showLocalResult();
  if (!saves?.canSubmit || !leaderboard.enabled || !['pending', 'online'].includes(leaderboard.sessionStatus)) {
    saves?.finish();return;
  }
  if (result.score === 0) {
    saves.finish();
    finalRank.className = 'final-rank';
    finalRank.textContent = '本局未得分，再试一次吧。';
    return;
  }
  const session=leaderboard.captureResultSession();
  if(!session) { saves.finish();return; }
  const payload={...result,roundId:saves.roundId,playerId:session.playerId,playerName:session.playerName,sessionId:session.sessionId};
  try {
    const journaled=saves.stageResult(payload);
    const entry=outbox.enqueue(payload,{journaled});
    uploads.setCurrent(entry.key);
    if(entry.durable)saves.clearFinished(payload.roundId);
    void outbox.kick();
    if(!entry.sessionId) {
      const id=await session.promise;
      outbox.setTicket(entry.key,id||null);
    }
  } catch (err) {
    if(version!==roundVersion)return;
    finalRank.className = 'final-rank error';
    finalRank.textContent = '本局结果未能安全加入待处理记录，请勿刷新页面。';
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
  if (daily?.active && !modalOpen()) return;
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
  if (daily?.active) { daily.frame(now);last=now;return; }
  const dt = (now - last) / 1000;
  last = now;
  const dir = (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('KeyA') ? 1 : 0);
  if (dir) game.setAim(game.clampAim(game.aimX, game.current) + dir * 280 * Math.min(dt, 0.05));
  game.update(dt);
  saves?.tick(now);
  game.render();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) backgroundPause();
  last = performance.now();
});
window.addEventListener('blur', backgroundPause);
window.addEventListener('pagehide', () => { backgroundPause();saves?.leave(); });
window.addEventListener('pageshow', (e) => { if(e.persisted)void saves.initialize(); });
window.addEventListener('resize', layout);
new ResizeObserver(layout).observe(stage);

layout();
updateGuide();
outbox=new Outbox({scope:leaderboard.saveScope,storage:getStorage(),locks:navigator.locks,
  isOnline:()=>navigator.onLine!==false,
  getPlayer:()=>leaderboard.uploadPlayer(),send:(body,token)=>leaderboard.sendResult(body,token),
  onDurable:entry=>{saves?.clearFinished(entry.roundId);},
  onClear:entry=>!entry.roundId||Boolean(saves?.clearFinished(entry.roundId)),
  onChange:entry=>{
    if(entry&&!entry.durable&&entry.journaled)entry.journaled=Boolean(saves?.updateJournal(entry));
    uploads?.render();
  },
});
saves = createSaveFlow({
  game,leaderboard,pauses,showModal,onNew:resetRound,isSubmitting:()=>false,
  findResult:id=>outbox.findRound(id),
  recoverResult:entry=>{const result=outbox.enqueue(entry,{journaled:true});void outbox.kick();return result;},
  hasUnsafeResults:()=>outbox.list().some(e=>!e.durable&&!['accepted','removed'].includes(e.state)),
  onRestored() {
    roundVersion++;
    clearTimeout(overTimer);overlay.classList.add('hidden');finalRank.classList.add('hidden');
    scoreEl.textContent=game.score;bestEl.textContent=game.best;
    drawCrabIcon(nextCanvas,game.next,34,24,dpr);drawLegend();
    for(const {level,item} of legend)item.classList.toggle('reached',level>=1 && level<=game.maxLevel);
    $('claw-count').textContent=game.claws;clawBtn.classList.remove('active');board.classList.remove('claw-mode');
    board.classList.toggle('fever',game.fever);
    guide.dismiss();updateGuide();showPlayer();board.focus({preventScroll:true});
  },
  onLost() { roundVersion++;uploads?.setCurrent(null);showPlayer(); },
});
uploads=createUploadUI({outbox,showModal,isGameOver:()=>game.over,openRanks,notify:toast,
  closeOthers:()=>{for(const modal of modals)if(!modal.classList.contains('hidden'))showModal(modal,false);},
  openAccount:()=>{if(leaderboard.player)openAccount();else askName();},
});
window.addEventListener('storage',event=>{
  outbox.observe(event.key,event.newValue);
  if(event.key===leaderboard.playerStorageKey)outbox.wakeIdentity();
});
window.addEventListener('online',()=>outbox.wakeOnline());
window.addEventListener('pagehide',()=>outbox.stop());
window.addEventListener('pageshow',event=>{if(event.persisted)outbox.start();});
daily=createChallengeUI({comfort:()=>comfortSettings.effects,onHelp:formal=>comfortPanel.open({mode:'daily',formal}),onShare:model=>void sharing.result(model),scope:leaderboard.saveScope,
  getPlayer:()=>leaderboard.uploadPlayer(),request:(path,options)=>leaderboard.challengeRequest(path,options),
  requestIdentity:()=>askName(),requestAccount:()=>{leaderboard.player=leaderboard.uploadPlayer();leaderboard.player?openAccount():askName();},
  classicSummary:()=>game.drops&&!game.over?`经典局仍保留 · ${game.score} 分，可随时切回继续。`:'经典模式与挑战使用独立存档。',
  onEnter(){
    if(modalOpen())return false;
    if(game.drops&&!game.over&&!saves.blocked&&!saves.flush()&&!saves.temporary){saves.show();toast('请先处理经典局保存失败，再切换模式。');return false;}
    pauses.set('mode',true);clearInputs();document.querySelector('.app').classList.add('hidden');return true;
  },
  onExit(){document.querySelector('.app').classList.remove('hidden');pauses.set('mode',false);syncPause();layout();board.focus({preventScroll:true});soundBtn.classList.toggle('muted',!sfx.enabled);if(saves.blocked)saves.show();},
});
comfortPanel=createComfortUI({settings:comfortSettings,onPause(open){pauses.set('comfort',open);daily.setExternalModal(open,'comfort');if(open)clearInputs();}});
function applyComfort(){document.body.classList.toggle('comfort-reduced',comfortSettings.effects.reduced);game.applyComfort();daily.applyComfort();}
comfortSettings.subscribe(applyComfort);applyComfort();
sharing=createChallengeShareUI({
  pause(open){pauses.set('sharing',open);daily.setExternalModal(open,'sharing');if(open)clearInputs();},
  getToday:()=>daily.invitationToday(),
  summary:()=> '打开邀请不会扣除机会或修改经典、挑战存档。',
  async enter(definition,formal){
    if(!restoreModal.classList.contains('hidden'))showModal(restoreModal,false);
    return daily.enterInvitation(definition,formal);
  },
});
$('daily-open').onclick=()=>void daily.open();
requestAnimationFrame(frame);
void Promise.all([initAccount(),saves.initialize().then(()=>outbox.start())]).then(()=>sharing.openInvitation());

async function initAccount() {
  showPlayer();
  if (!leaderboard.enabled) return;
  // Back from LINUX DO? The page URL carries a one-time login code (or an error).
  const result = await leaderboard.finishLoginRedirect();
  showPlayer();
  if (result?.player) {
    guide.dismiss();
    updateGuide();
    // The callback may finish after the player has already started a local game.
    if (!saves.blocked && game.drops === 0 && !game.over) beginRound();
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
