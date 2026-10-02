import { SaveStore } from './save-store.js';
import { getStorage } from './storage.js';
import { defOf, drawCrabIcon } from './crabs.js';

// Coordinates ownership, recovery choices and persistence. Physics stays in Game.
export function createSaveFlow({ game, leaderboard, pauses, showModal, onNew, onRestored, onLost, isSubmitting,
  findResult=()=>null,recoverResult=()=>null,hasUnsafeResults=()=>false }) {
  const $ = id => document.getElementById(id);
  const modal = $('restore-modal');
  const store = new SaveStore({
    scope:leaderboard.saveScope, storage:getStorage(), locks:navigator.locks,
    channelFactory:typeof BroadcastChannel === 'function' ? name=>new BroadcastChannel(name) : null,
  });
  let state='initializing', record=null, roundId=null, temporary=false, failure=false;
  let operation=0, lastSave=0, offer='saved';
  let initialization=null;
  let protectedResult=null,temporaryForResult=false;

  function status(text, warning=false) {
    $('save-status').setAttribute('aria-live',warning?'polite':'off');
    $('save-status').textContent=text;
    $('save-status').classList.toggle('warning',warning);
    $('restore-open').classList.toggle('hidden',state==='active' && (!failure || temporary));
    $('restore-open').textContent=state==='active'?'重试保存':state==='busy'?'接管对局':'继续上局';
  }
  function freeze() { pauses.set('restore',true); }
  function dismiss() { operation++; showModal(modal,false); }
  function display(kind, detail='') {
    offer=kind;
    const definitions={
      saved:['继续上一局？','棋盘还在，接着合成吧。','继续游戏','新开一局'],
      checking:['正在确认原对局','正在核验原账号与成绩凭证。','正在核验…','暂不恢复'],
      expired:['棋盘还在，可以继续','凭证已过期或失效。本地继续后，这局不能再上榜。','继续本地游玩','新开一局'],
      identity:['这局属于另一个身份','可以暂不恢复，先切回原身份；或将旧局转为本地游玩。','继续本地游玩','暂不恢复'],
      network:['暂时无法确认上榜资格','原存档保持不变。也可以选择本地继续，之后不再补交这局。','重试核验','继续本地游玩'],
      busy:['这局正在另一页进行','接管需先让另一页暂停并保存。无响应时请关闭另一页后重试。','接管并继续','暂不接管'],
      waiting:['正在等待另一页交接','完成交接前，本页不修改存档。','等待交接…','暂不接管'],
      invalid:['这份存档暂时打不开','存档损坏或版本不兼容；新开一局前不会覆盖原记录。','新开一局','暂不处理'],
      unavailable:['当前无法自动保存','浏览器存储或安全互斥不可用。临时游玩不会写入旧存档。','临时游玩','重试'],
      confirm:['放弃上一局，重新开始？','确认后才替换旧对局。本机最高分和图鉴保留。','保留上一局','放弃旧局，新开一局'],
      write:['本局暂时没有保存成功','内存中的棋盘仍在；刷新或关闭页面可能丢失当前进度。','继续当前局','重试保存'],
      restoreWrite:['暂时无法保存恢复选择','原记录未改变。恢复前必须成功保存本局的资格选择。','重试恢复','暂不恢复'],
    };
    const [title,description,primary,secondary]=definitions[kind];
    $('restore-title').textContent=title;
    $('restore-description').textContent=detail || description;
    $('restore-primary').textContent=primary;
    $('restore-secondary').textContent=secondary;
    $('restore-primary').disabled=['checking','waiting'].includes(kind);
    $('restore-secondary').classList.toggle('danger-btn',kind==='confirm');
    const hasCard=record && !['confirm','unavailable','invalid','write'].includes(kind);
    $('restore-card').classList.toggle('hidden',!hasCard);
    if(hasCard) {
      $('restore-score').textContent=record.game.score.toLocaleString('zh-CN');
      $('restore-summary').textContent=`最高合成：${defOf(record.game.maxLevel).name} · 投放 ${record.game.drops} 次`;
      $('restore-time').textContent=`钳子 ×${record.game.claws} · ${new Date(record.savedAt).toLocaleString('zh-CN')} 保存`;
      drawCrabIcon($('restore-current'),record.game.current,34,26,2);
      drawCrabIcon($('restore-next'),record.game.next,34,26,2);
    }
    $('restore-detail').textContent=record?.online
      ? '继续在线局需核验原凭证；恢复不会续签或新建上榜机会。'
      : '存档仅在当前浏览器；本地局不参与排名。';
    showModal(modal,true);
    if(kind==='confirm') $('restore-primary').focus();
  }

  function flush() {
    if(state!=='active' || temporary || !store.owned) return false;
    try {
      if(game.over) {
        if(protectedResult)return store.read().kind==='terminal';
        store.remove();record=null;failure=false;status('本局已结束，未完成存档已清理');return true;
      }
      if(!game.drops)return true;
      record=store.record(roundId,game.snapshot(),leaderboard.exportSession());
      store.write(record); lastSave=performance.now(); failure=false;
      status(`已保存 · ${new Date(record.savedAt).toLocaleTimeString('zh-CN')}`);
      return true;
    } catch {
      failure=true; status('自动保存失败 · 当前进度仅在这一页，关闭前请重试',true);
      return false;
    }
  }

  function activateNew(temp=false) {
    temporary=temp;failure=temp;state='active';record=null;
    roundId=globalThis.crypto?.randomUUID?.() || `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dismiss(); onNew(); pauses.set('restore',false);
    status(temp?'临时游玩 · 当前对局不会自动保存':'开始投放后自动保存',temp);
  }
  function newGame() {
    if(state==='busy' || (!store.owned && !temporary)) { display('busy');return false; }
    if(hasUnsafeResults()) {
      temporaryForResult=true;activateNew(true);
      status('上一局结果尚未进入队列 · 新局暂不自动保存，请勿刷新',true);
      return true;
    }
    if(temporaryForResult && store.owned) { temporary=false;temporaryForResult=false; }
    if(!temporary) {
      try { store.remove(); } catch { display('unavailable','无法替换旧存档。可以重试，或开始不覆盖旧档的临时新局。');return false; }
    }
    activateNew(temporary); return true;
  }

  function inspect() {
    const result=store.read();
    if(result.kind==='empty') { activateNew();return; }
    if(result.kind==='terminal' || (result.kind==='saved' && findResult(result.record.roundId))) {
      try {
        const pending=result.kind==='terminal'?recoverResult(result.record.terminal):findResult(result.record.roundId);
        if(!pending || pending.state==='corrupt')throw new Error('invalid_result');
        const safe=pending.durable || pending.state==='accepted' || pending.state==='removed';
        if(safe) { store.remove();protectedResult=null; }
        else { protectedResult=result.record.roundId;temporaryForResult=true; }
        activateNew(!safe);
        status(safe?'上一局成绩已转入待处理记录':'上一局结果已保留 · 新局暂不自动保存',!safe);
      } catch {
        state='invalid';record=null;freeze();display('invalid','上一局结果需要处理，原记录未改动。请先查看待处理成绩。');
      }
      return;
    }
    state=result.kind;record=result.record || null;freeze();
    status(result.kind==='saved'?'发现未完成对局，选择后继续':'存档需要处理，原记录未改动',result.kind!=='saved');
    display(result.kind);
  }
  function initialize() {
    if(initialization)return initialization;
    initialization=(async()=>{
      const current=++operation;
      freeze();
      const acquired=await store.acquire();
      if(current!==operation) { if(acquired)await store.release();return; }
      if(!acquired) {
        state=store.supported?'busy':'unavailable';record=null;
        status(state==='busy'?'另一标签页正在使用对局':'自动保存不可用',true);display(state);return;
      }
      inspect();
    })().finally(()=>{initialization=null;});
    return initialization;
  }

  let restoreLocal=false;
  function applyRestore(local) {
    if(!record || !store.owned)return;
    restoreLocal=local;
    try {
      game.restore(record.game);
    } catch {
      state='invalid';display('invalid');return;
    }
    const ticket=local?null:record.online;
    try {
      leaderboard.restoreSession(ticket);
      const next={...record,online:ticket,savedAt:Date.now()};
      store.write(next);record=next;
    } catch {
      freeze();display('restoreWrite');return;
    }
    roundId=record.roundId;state='active';temporary=false;failure=false;
    dismiss();onRestored();pauses.clear();
    if(document.hidden)pauses.set('background',true);
    lastSave=performance.now();status(ticket?'已恢复原局 · 原凭证仍需通过最终提交校验':'已恢复原局 · 本地游玩，不参与排名');
  }
  async function restore() {
    if(!record || !store.owned)return;
    const current=++operation;
    display('checking');
    const result=await leaderboard.checkSavedSession(record.online);
    if(current!==operation || !store.owned)return;
    if(result.status==='local' || result.status==='valid') applyRestore(result.status==='local');
    else display(['identity','network'].includes(result.status)?result.status:'expired');
  }
  async function takeover() {
    const current=++operation;display('waiting');
    const acquired=await store.takeover();
    if(current!==operation) { if(acquired)await store.release();return; }
    if(acquired) { inspect();if(state==='saved')await restore(); }
    else display('busy','另一页尚未完成交接。请先关闭另一页，再重试；本页没有改写存档。');
  }

  store.onYield=()=>{
    if(isSubmitting())return false;
    pauses.set('handoff',true);
    if(state==='active' && (!flush() || temporary)) {
      pauses.set('handoff',false);display('write','保存没有成功，已取消交接。本页仍保留棋盘，请先重试保存。');return false;
    }
    return true;
  };
  store.onLost=()=>{
    operation++;state='busy';record=null;freeze();pauses.set('handoff',false);
    leaderboard.restoreSession(null);onLost();
    status('已在另一页继续 · 本页已停止写入和提交',true);
    display('busy','这局已交到另一页；本页棋盘仅供查看。需要时可再次请求接管。');
  };

  $('restore-primary').onclick=()=>{
    if(offer==='saved' || offer==='network')void restore();
    else if(offer==='expired' || offer==='identity')applyRestore(true);
    else if(offer==='busy')void takeover();
    else if(offer==='invalid')display('confirm');
    else if(offer==='confirm')display(record?'saved':'invalid');
    else if(offer==='unavailable')activateNew(true);
    else if(offer==='write')dismiss();
    else if(offer==='restoreWrite')restoreLocal?applyRestore(true):void restore();
  };
  $('restore-secondary').onclick=()=>{
    if(offer==='saved' || offer==='expired')display('confirm');
    else if(offer==='confirm')newGame();
    else if(offer==='network')applyRestore(true);
    else if(offer==='unavailable')void initialize();
    else if(offer==='write') { failure=false;if(flush())dismiss(); }
    else dismiss();
  };
  $('restore-close').onclick=dismiss;
  $('restore-open').onclick=()=>{
    if(state==='active') { if(!temporary) { failure=false;if(!flush())display('write'); } }
    else display(state==='saved'?'saved':state==='busy'?'busy':state==='invalid'?'invalid':'unavailable');
  };

  return {
    store, initialize, flush, newGame,
    get roundId() { return roundId; },
    get temporary() { return temporary; },
    get blocked() { return state!=='active'; },
    get canSubmit() { return state==='active' && (store.owned || temporary); },
    get restored() { return Boolean(record && roundId===record.roundId); },
    show() { if(state==='active') { if(failure)display('write'); } else display(state==='saved'?'saved':state==='busy'?'busy':state==='invalid'?'invalid':'unavailable'); },
    invalidateOffer() { operation++; },
    tick(now) { if(state==='active' && !game.over && !game.paused && !failure && now-lastSave>=1000)flush(); },
    stageResult(entry) {
      protectedResult=entry.roundId;
      if(!store.owned || temporary)return false;
      try { store.stageResult(entry);status('本局结果已保留，准备上传');return true; }
      catch { status('本局结果尚未保存，请勿刷新',true);return false; }
    },
    updateJournal(entry) {
      if(!store.owned)return false;
      const existing=store.read();
      if(existing.record?.roundId!==entry.roundId)return false;
      try { store.stageResult(entry);return true; } catch { return false; }
    },
    clearFinished(id) {
      const existing=store.read();
      if(existing.kind==='empty') { if(protectedResult===id)protectedResult=null;return true; }
      if(!existing.record)return false;
      if(existing.record.roundId!==id)return true;
      if(!store.owned)return false;
      try {
        store.remove();record=null;if(protectedResult===id)protectedResult=null;
        if(roundId===id && game.over)status('本局棋盘已清理，成绩由待处理记录跟踪');
        return true;
      } catch { return false; }
    },
    finish() {
      if(store.owned && !temporary) {
        try { store.remove();record=null;status('本局已结束，未完成存档已清理'); }
        catch { status('本局已结束，但旧存档清理失败；请在关闭前重试',true);failure=true; }
      }
    },
    leave() { operation++;flush();state='detached';void store.release(); },
  };
}
