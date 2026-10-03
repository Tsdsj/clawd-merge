import { collectTransfer, importTransfer } from './domain-migration.js';
const config=globalThis.CLAWD_MIGRATION;
const status=document.getElementById('migration-status');
const action=document.getElementById('migration-action');
const skip=document.getElementById('migration-skip');
const title=document.getElementById('migration-title');
const say=text=>{status.textContent=text;};
const pending=new Map();
let sourceWindow=null;
let nonce=null;
let received=false;

async function withSaveLocks(fn) {
  if(!navigator.locks)throw new Error('locks_unavailable');
  const keys=[`clawd-merge:save:${config.scope}`,`clawd-merge:save:daily:${config.scope}`];
  return navigator.locks.request(keys[0],{ifAvailable:true},async a=>{
    if(!a)throw new Error('game_open');
    return navigator.locks.request(keys[1],{ifAvailable:true},async b=>{
      if(!b)throw new Error('game_open');
      return fn();
    });
  });
}
function errorText(error) {
  if(error.message==='game_open')return '请先关闭这个地址下其他正在游玩的标签页，再重试。原数据没有删除。';
  if(error.message==='transfer_conflict')return '新地址已有不同的账号、存档或待处理成绩，已停止搬家，避免覆盖。两边数据均保留。';
  if(error.message==='transfer_rollback_failed')return '新地址存储异常，未能完整回退。请保留旧地址数据，暂时不要开始新游戏。';
  return '搬家未完成，请确认允许本机存储和弹出窗口后重试。旧地址数据仍保留。';
}

if(!config?.sourceOrigin||!config?.targetOrigin||!config?.scope) {
  say('未配置搬家地址，请从游戏原入口进入。');
  action.disabled=true;
} else if(location.origin===config.sourceOrigin) {
  title.textContent='合成大Clawd 搬新家啦';
  action.textContent='带上账号与进度，前往新地址';
  skip.href=config.targetOrigin+'/';
  skip.textContent='直接进入新地址';
  say('可搬走这个浏览器的游客身份、本机纪录、存档和待上传成绩。数据只传给新地址，旧数据仍会保留。请先关闭其他正在游玩的旧标签页。');
  action.addEventListener('click',()=>{
    const session=crypto.randomUUID();
    const target=new URL('/migration.html',config.targetOrigin);
    target.hash=new URLSearchParams({transfer:session});
    const popup=window.open(target.toString(),'clawd-migration-'+session);
    if(!popup){say('请允许打开新地址的窗口，然后再点一次。');return;}
    pending.set(session,popup);
    setTimeout(()=>pending.delete(session),5*60_000);
    say('已打开新地址。请在新页面确认接收；等待期间不要关闭此页。');
  });
  window.addEventListener('message',async event=>{
    if(event.origin!==config.targetOrigin||event.data?.type!=='clawd-transfer-request'||pending.get(event.data.nonce)!==event.source)return;
    const popup=event.source,session=event.data.nonce;
    try {
      const packet=await withSaveLocks(()=>collectTransfer(localStorage,config.scope));
      popup.postMessage({type:'clawd-transfer-data',nonce:session,packet},config.targetOrigin);
    } catch(error) {
      popup.postMessage({type:'clawd-transfer-error',nonce:session,message:errorText(error)},config.targetOrigin);
      say(errorText(error));
    }
  });
} else if(location.origin===config.targetOrigin) {
  sourceWindow=window.opener;
  nonce=new URLSearchParams(location.hash.slice(1)).get('transfer');
  history.replaceState(null,'',location.pathname);
  title.textContent='把原来的进度带过来';
  action.textContent='接收账号与进度';
  skip.href='/';skip.textContent='返回游戏';
  if(!sourceWindow||!nonce) {
    action.disabled=true;
    const link=document.createElement('a');link.href=config.sourceOrigin+config.sourcePath;link.textContent='打开旧入口，开始搬家';link.className='btn';
    status.replaceChildren(document.createTextNode('请从原来的游戏入口发起搬家。'),document.createElement('br'),link);
  } else {
    say('点击接收，将原地址的本机数据保存到此地址。若新地址已有不同进度，系统会停止，避免覆盖。');
    action.addEventListener('click',()=>{
      action.disabled=true;
      sourceWindow.postMessage({type:'clawd-transfer-request',nonce},config.sourceOrigin);
      say('正在读取原地址数据，请保留两个页面…');
      setTimeout(()=>{if(!received){action.disabled=false;say('尚未收到数据，请确认原入口仍然打开后重试。');}},8000);
    });
    window.addEventListener('message',async event=>{
      if(received||event.origin!==config.sourceOrigin||event.source!==sourceWindow||event.data?.nonce!==nonce)return;
      if(event.data.type==='clawd-transfer-error'){say(event.data.message);action.disabled=false;return;}
      if(event.data.type!=='clawd-transfer-data')return;
      received=true;
      try {
        const count=await withSaveLocks(()=>importTransfer(localStorage,event.data.packet,config.scope));
        say(count?'搬家完成！原账号与本机记录已经保存。现在可以进入游戏。':'已核对，本机记录已同步，或旧地址没有可迁移数据。');
        action.classList.add('hidden');skip.className='btn big';skip.textContent='进入游戏';
      } catch(error){received=false;action.disabled=false;say(errorText(error));}
    });
  }
} else {say('此地址不允许进行数据搬家。');action.disabled=true;}
