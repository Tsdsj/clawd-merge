import { Game, WORLD_W, WORLD_H, enableHaptics } from './game.js';
import { LEVELS, RAINBOW, defOf, drawCrabIcon, drawLegendIcon } from './crabs.js';
import { sfx } from './audio.js';
import { leaderboard, displayName } from './leaderboard.js';
import { createGuide } from './onboarding.js';
import { AccountClient } from './account-client.js';
import { OAuthClient } from './oauth-client.js';
import { createAccountUI } from './account-ui.js';
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
let accountClient, oauthClient, accountPanel, externalIdentityChanged=false;
let oauthReturnContext=null;

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
  if(externalIdentityChanged){openAccount();return;}
  if (saves?.blocked) { saves.show();return; }
  if (!game.over && game.drops > 0) {
    showModal(restartModal, true);
    return;
  }
  restartNow();
}

function restartNow() {
  if(externalIdentityChanged){openAccount();return;}
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
  const showCover = !game.over && !saves?.blocked && (pauses.has('manual') || pauses.has('background') || pauses.has('identity'));
  $('pause-cover').classList.toggle('hidden', !showCover);
  $('pause-btn').textContent = pauses.has('identity')?'检查账号':showCover ? '继续' : '暂停';
  $('resume-btn').textContent=pauses.has('identity')?'检查账号':'继续游戏';
  $('pause-btn').disabled = game.over || Boolean(saves?.blocked);
  $('pause-title').textContent = pauses.has('identity')?'账号已变化':pauses.has('background') ? '欢迎回来' : '已暂停';
  $('pause-copy').textContent = pauses.has('identity')?'原局已保留。请刷新后检查原身份，再继续原局。':pauses.has('background')
    ? '离开时已经暂停，准备好了再继续。' : '这一局先放在这里。准备好了，再继续。';
  $('paused-score').textContent = game.score;
  $('paused-rank').classList.toggle('hidden', !leaderboard.enabled);
  clawBtn.disabled = game.paused || (game.claws === 0 && !game.clawMode);
  updateGuide();
}

function togglePause() {
  if (game.over || modalOpen() || saves?.blocked) return;
  if(pauses.has('identity')){openAccount();return;}
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

const rankModal = $('rank-modal');
const restartModal = $('restart-modal');
const restoreModal = $('restore-modal');
const pendingModal = $('pending-modal');
const removeResultModal = $('remove-result-modal');
const finalRank = $('final-rank');
const modals = [rankModal, restartModal, restoreModal,pendingModal,removeResultModal];
const modalOpen = () => document.body.classList.contains('modal-open');
const modalFocus = new WeakMap();

function showModal(modal, open) {
  if (!open && modal === accountPanel?.element) accountPanel.hostClosed();
  if(open && modal===restoreModal && (daily?.active || accountPanel&&!accountPanel.element.classList.contains('hidden')))return;
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

function accountGuard(action,{confirmed=false}={}) {
  if(externalIdentityChanged)return {message:'账号已在其他页面变化，请刷新后检查原存档。'};
  const entries=outbox?.list()||[],p=leaderboard.player;
  if(!p&&(daily?.boundPlayerId||saves?.boundPlayerId)&&['join','mutation'].includes(action))return {message:'本机仍有原账号的在线局。请先登录原账号，或明确将原局转为本地／练习后再创建新身份。'};
  if(entries.some(e=>!e.durable&&!e.journaled&&!['accepted','removed'].includes(e.state))||daily&&!daily.canNavigateForAuth())
    return {message:'有进度或成绩尚未安全保存，请先重试保存或处理记录。'};
  const navigating=['navigate','oauth-same','oauth-switch'].includes(action);
  if(navigating&&game.drops>0&&!game.over&&!saves?.blocked&&(saves?.temporary||!saves.flush()))return {message:'当前经典局未能安全保存，暂时不能离开本页授权。请先保存或结束本局。'};
  const sameIdentity=['mutation','login','oauth-same'].includes(action)||(action==='navigate'&&p?.linuxdo);
  if(sameIdentity){
    if(leaderboard.sessionStatus==='pending'||entries.some(e=>e.state==='uploading')||daily?.credentialRotationBlocked())
      return {message:'正在核对开局或上传成绩，请等待完成后再更新登录状态。'};
    return null;
  }
  if(daily?.hasBoundWork(p?.id)||p&&uploads?.hasUnresolved(p.id))return {message:'请先处理原账号的未完成正式局、未知开局或待提交记录。'};
  if(game.drops>0&&!game.over&&!saves?.blocked&&!saves?.temporary&&!saves.flush())return {message:'当前经典局未能保存，请先处理保存问题。'};
  if(action==='navigate'&&p?.account?.kind==='password')return {message:'请先退出当前账号，再用 Linux.do 登录。账号绑定会在后续阶段开放。'};
  const messages=[];
  if(p&&(!p.account||p.account.kind==='guest')&&!p.linuxdo&&action==='logout')messages.push('游客身份没有密码。退出后可能无法找回该身份与历史，请确认已处理成绩。');
  if(['logout','navigate','oauth-switch'].includes(action)&&game.drops>0&&!game.over&&leaderboard.sessionStatus==='online')messages.push('当前经典在线局将转为本地继续，不再上传本局排名。');
  if(messages.length&&!confirmed)return {confirm:true,message:messages.join(' ')};
  return null;
}
function requireSavedOwner(data,snapshot){if(!snapshot.id||data.player.id!==snapshot.id){const owner=daily?.boundPlayerId||saves?.boundPlayerId;if(owner&&owner!==data.player.id)throw new Error('本机仍有原账号的在线局，请使用原账号登录或先处理原局。');}}
accountClient=new AccountClient({identity:leaderboard,request:(...args)=>leaderboard.accountRequest(...args),storage:getStorage,
  beforeApply(data,snapshot){requireSavedOwner(data,snapshot);if(snapshot.id&&data.player.id!==snapshot.id)throw new Error('这是另一个账号，请先退出当前账号再登录。');},
});
oauthClient=new OAuthClient({client:accountClient,
  beforeNavigate(intent){
    const switching=intent.actorKind==='guest'||(intent.action==='login'&&!intent.samePlayerOnly),check=accountGuard(switching?'oauth-switch':'oauth-same',{confirmed:true});
    if(check)throw new Error(check.message);
    if(!switching&&!saves.blocked&&!game.over&&leaderboard.round?.sessionId&&!saves.flush({includeEmpty:true}))throw new Error('未能保存原局凭证，暂时不能离开本页授权。');
    if(switching&&game.drops>0&&!game.over&&leaderboard.sessionStatus==='online'){
      const oldRound=leaderboard.round,oldSession=leaderboard.session;leaderboard.round=null;leaderboard.session=null;
      if(!saves.flush()){leaderboard.round=oldRound;leaderboard.session=oldSession;throw new Error('未能保存本地继续的选择，授权尚未跳转。');}
    }
    return {mode:daily?.active?'daily':'classic',roundId:saves?.roundId||null,manualPause:pauses.has('manual')};
  },
  beforeApply(data,snapshot){
    requireSavedOwner(data,snapshot);
    if(snapshot.id&&data.player.id!==snapshot.id){
      if(oauthClient.pending?.actorKind!=='guest'||data.mergedFromPlayerId!==snapshot.id)throw new Error('账号不匹配，原身份保持不变。');
      if(daily?.hasBoundWork(snapshot.id)||uploads?.hasUnresolved(snapshot.id))throw new Error('原游客还有未处理记录，请先核对原对局。');
    }
  },
});
accountPanel=createAccountUI({client:accountClient,oauth:oauthClient,identity:leaderboard,
  setOpen(open){
    if(open)for(const m of modals)if(m!==accountPanel.element&&!m.classList.contains('hidden'))showModal(m,false);
    showModal(accountPanel.element,open);
    if(!open){showPlayer();if(oauthReturnContext?.mode==='daily'){oauthReturnContext={...oauthReturnContext,mode:'classic'};void daily.open();}else if(saves?.blocked&&!daily?.active)void saves.initialize();}
  },
  onChanged(){showPlayer();if(leaderboard.player){guide.dismiss();updateGuide();if(!daily?.active&&!saves?.blocked&&!game.over&&game.drops===0&&!leaderboard.round)beginRound();}},
  guard:accountGuard,
  async onLinuxdo(){
    if(!leaderboard.player?.linuxdo&&game.drops>0&&!game.over&&leaderboard.sessionStatus==='online'){leaderboard.round=null;leaderboard.session=null;saves?.flush();}
    return leaderboard.loginWithLinuxdo();
  },
  onPending(){uploads?.open('请先处理原账号的待提交记录。');},
  onReload(){if(daily&&!daily.canNavigateForAuth()){toast('每日进度尚未安全保存，请先处理记录再刷新。',6000);return;}if(outbox?.list().some(e=>!e.durable&&!e.journaled&&!['accepted','removed'].includes(e.state))){uploads.open('有成绩尚未安全保存，请先处理，再刷新页面。');return;}if(!saves?.blocked)saves?.flush();location.reload();},
  notify:toast,
});
modals.push(accountPanel.element);
function askName(message=''){void accountPanel.open('entry',message);if(externalIdentityChanged)accountPanel.externalIdentityChanged();}
function openAccount(message=''){void accountPanel.open(leaderboard.player?'account':'entry',message);if(externalIdentityChanged)accountPanel.externalIdentityChanged();}
$('join-btn').addEventListener('click',event=>{event.currentTarget.focus({preventScroll:true});askName();});
$('result-join').addEventListener('click',event=>{event.currentTarget.focus({preventScroll:true});askName();});
$('player-chip').addEventListener('click',event=>{event.currentTarget.focus({preventScroll:true});openAccount();});
$('help-btn').addEventListener('click',()=>comfortPanel.open({mode:'classic'}));
$('cancel-restart').addEventListener('click',()=>showModal(restartModal,false));
$('confirm-restart').addEventListener('click',restartNow);
$('pause-btn').addEventListener('click',togglePause);
$('resume-btn').addEventListener('click',togglePause);
$('guide-dismiss').addEventListener('click',()=>{guide.dismiss();updateGuide();});

leaderboard.onUnauthorized = () => {
  leaderboard.sessionExpired=true;
  showPlayer();
  toast('登录已失效，原局和待提交记录保留。请打开账号重新登录。', 5000);
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
    if (e.code === 'Escape') { e.preventDefault();if(active===accountPanel.element)accountPanel.close();else showModal(active, false); }
    if (e.code === 'Tab') {
      const items = [...active.querySelectorAll('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]')]
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
    const restorePause=oauthReturnContext?.manualPause&&oauthReturnContext.roundId===saves.roundId;
    oauthReturnContext=null;if(restorePause)queueMicrotask(()=>pauses.set('manual',true));
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
  if(event.key===leaderboard.playerStorageKey||event.key===null){
    let persisted=null;try{persisted=event.newValue?JSON.parse(event.newValue):null;}catch{}
    const current=leaderboard.player;
    if(persisted?.id!==current?.id||persisted?.token!==current?.token){
      if(!saves?.blocked)saves?.flush();externalIdentityChanged=true;
      pauses.set('identity',true);daily?.setExternalModal(true,'identity');void accountPanel.open('entry');accountPanel.externalIdentityChanged();
      toast('账号已在其他页面变化。本页已暂停，请刷新后检查原存档。',7000);
    }
    outbox.wakeIdentity();
  }
});
window.addEventListener('online',()=>outbox.wakeOnline());
window.addEventListener('pagehide',()=>outbox.stop());
window.addEventListener('pageshow',event=>{if(event.persisted)outbox.start();});
daily=createChallengeUI({comfort:()=>comfortSettings.effects,onHelp:formal=>comfortPanel.open({mode:'daily',formal}),onShare:model=>void sharing.result(model),scope:leaderboard.saveScope,
  getPlayer:()=>leaderboard.uploadPlayer(),request:(path,options)=>leaderboard.challengeRequest(path,options),
  requestIdentity:()=>askName(),requestAccount:()=>{leaderboard.player?openAccount():askName();},
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
// Complete OAuth identity adoption before restoring a saved round or issuing a
// new empty-board ticket. Returning from same-player reauth never starts a game.
void (async()=>{pauses.set('auth-init',true);try{await initAccount();await saves.initialize();outbox.start();await sharing.openInvitation();}finally{pauses.set('auth-init',false);}})();

async function initAccount() {
  showPlayer();
  if (!leaderboard.enabled) return;
  // Back from LINUX DO? The page URL carries a one-time login code (or an error).
  const params=new URLSearchParams(location.hash.slice(1));
  if(oauthClient.pending&&(params.has('login')||params.has('login_error')||oauthClient.pending.code)||params.get('oauth')==='1'){
    oauthReturnContext=oauthClient.pending?.returnContext||null;
    try{const result=params.has('login')||params.has('login_error')?await oauthClient.finishRedirect():await oauthClient.inspect();if(result&&result.kind!=='pending')await accountPanel.receiveOAuth(result);}
    catch(error){await accountPanel.receiveOAuth(null,error);}
    showPlayer();return;
  }
  const result = await leaderboard.finishLoginRedirect();
  showPlayer();
  if (result?.player) {
    guide.dismiss();
    updateGuide();
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
