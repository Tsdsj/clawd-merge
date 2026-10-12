import {Game} from '../src/game.js';
import {drawCrabIcon,drawLegendIcon,clawdLabel} from '../src/crabs.js';
import {prepareStack,STACK_SCENES} from './classic2-stack-scenes.js';
import {sfx} from '../src/audio.js';
const $=id=>document.getElementById(id), canvas=$('board');
const descriptions={
 'pile-pull':'同一堆九只 Clawd。1级磁力小 Clawd 从右侧落下，启动后吸引边缘同级；与「普通对照」比较。',
 'pile-control':'与磁力有效场景完全相同的堆叠、基础等级和落点，去掉磁力能力。观察 5 秒内是否发生合成。',
 'pile-blocked':'2级磁力爱心落在右侧，找到埋在堆里的同级。目标被夹住后，连线转为橙色虚线，并显示受阻。',
 'pile-consumed':'2级磁力爱心直接落到同级上，在磁场启动前就合成。提示会明确说明能力提前消耗。',
 'pile-empty':'2级磁力爱心落在左侧，附近没有可吸的同级；显示无同级，不把空转当作吸附成功。',
 gold:'一只金色爱心 Clawd 落向同级：基础合成从 4 分变成 8 分，金色属性消耗。',
 magnet:'两只爱心 Clawd 先落稳，相距 120。带磁铁配件的爱心吸来同级，合成后磁场与持续音一起结束。',
 freeze:'冰冻载体落地后锁定 3 秒。普通落物撞上它时保持位置；进度耗尽后冰壳碎开。',
 'freeze-merge':'锁定不阻止合成。冰冻后再落下一只同级，应正常升级并获得 4 分。',
 barrier:'磁体与目标之间有一只不同级的眼镜 Clawd。吸力仍经过碰撞求解，目标不能穿过障碍。',
 expiry:'附近没有同级可吸附。磁场保持 2.5 秒，耗尽后载体恢复普通外观，持续音停止。',
};
let selected='pile-pull',game,refs={},start=0,task=null,anchor=null,maxDrift=0,lastUI=0;
const comfort=()=>({reduced:$('reduced').checked,shake:!$('reduced').checked,particles:!$('reduced').checked,haptics:false});
function newGame(){
 game?.setPaused(true);
 game=new Game(canvas,{onScore:score=>$('score').textContent=score,onNext:(level,special)=>{drawCrabIcon($('next'),level,40,32,2,special);$('next').setAttribute('aria-label',clawdLabel(level,special));}},{seed:42,comfort});
 game.persistPreferences=false;game.seen=new Set(Array.from({length:12},(_,i)=>i));game.seenSpecials=new Set(['gold','magnet','freeze']);
 fit();
 window.classic2Lab={get game(){return game;},get refs(){return refs;},get selected(){return selected;}};
}
function fit(){const w=document.querySelector('.stage').clientWidth;game.resize(w,w*1.6,Math.min(devicePixelRatio||1,2));}
function settle(){for(let i=0;i<240;i++)game.update(1/120);}
function choose(scene,playing=true){
 selected=scene;newGame();refs={};task=null;anchor=null;maxDrift=0;
 for(const b of document.querySelectorAll('[data-scene]'))b.setAttribute('aria-pressed',String(b.dataset.scene===scene));
 $('description').textContent=descriptions[scene];
 if(STACK_SCENES[scene]){
  refs=prepareStack(game,scene);task={at:game.time+.35,run:()=>{game.drop();refs.carrier=game.world.bodies.at(-1);}};
 }else if(scene==='gold'){
  refs.target=game.spawnCrab(2,200,580);settle();game.current=2;game.currentSpecial='gold';task={at:game.time+.35,run:()=>game.drop()};
 }else if(scene==='magnet'||scene==='expiry'||scene==='barrier'){
  const level=scene==='barrier'?1:2;
  refs.carrier=game.spawnCrab(level,scene==='barrier'?120:140,580);
  if(scene==='magnet')refs.target=game.spawnCrab(level,260,580);
  if(scene==='barrier'){refs.blocker=game.spawnCrab(4,180,580);refs.target=game.spawnCrab(1,240,580);}
  settle();refs.carrier.special='magnet';
 }else{
  game.current=2;game.currentSpecial='freeze';task={at:.35,run:()=>{game.drop();refs.carrier=game.world.bodies.at(-1);}};
 }
 start=game.time;game.setPaused(!playing);syncPause();updateStatus();game.render();
}
function syncPause(){const paused=game.paused;$('pause').textContent=paused?'开始 / 继续':'暂停';$('pause').setAttribute('aria-pressed',String(paused));}
function updateStatus(){
 let message='等待场景开始。';const carrier=refs.carrier;
 if(STACK_SCENES[selected]){
  if(selected==='pile-control')message=carrier?.merged?'普通对照也发生合成。':game.time-start>=5?'普通对照：5 秒后仍未合成。':'普通对照进行中，观察同一落点。';
  else message=game.specialNotice?.message??game.specialFeedbackText();
 }else if(selected==='gold')message=game.score===8?'✓ 金色合成完成：4 × 2 = 8 分。新载体恢复普通状态。':'金色载体正在落下；留意菱形标记、保留的粉色身体和合成声音。';
 else if(selected==='magnet')message=refs.target.merged?'✓ 落稳的目标被吸来合成。持续音已随磁体消耗停止。':carrier.magnetArmed?'正在吸附：光点流向磁体，进度条显示剩余作用时间。':'等待磁场启动。';
 else if(selected==='barrier')message=carrier.special==='magnet'?'目标正被拉向障碍，不能穿过不同级载体。':'✓ 磁力已耗尽，目标仍在障碍另一侧，没有穿越。';
 else if(selected==='expiry')message=carrier.special==='magnet'?'没有同级目标；对照进度条与持续嗡鸣，等待自然结束。':'✓ 2.5 秒已到，磁极标记、磁场和持续声均已结束。';
 else if(carrier){
  if(carrier.merged)message='✓ 冻结中正常合成：获得 4 分，没有把同级弹开。';
  else if(carrier.frozenUntil>game.time)message=`冻结剩余 ${(carrier.frozenUntil-game.time).toFixed(1)} 秒 · 锁定期间最大位移 ${maxDrift.toFixed(3)}。${refs.partner?'落物已投下。':'等待第二只落物。'}`;
  else if(anchor)message=`✓ 冻结已自然结束，锁定期间最大位移 ${maxDrift.toFixed(3)}。冰壳与冻结状态同时解除。`;
  else message='冰冻载体正在落地；落稳后才开始计时。';
 }
 if(game.paused&&game.time===start)message='点击「开始」或选择上方场景，即可播放。';
 $('status').textContent=message;$('elapsed').value=(game.time-start).toFixed(1);
}
function tick(now){
 const dt=Math.min((now-(tick.last??now))/1000,.05);tick.last=now;
 if(!game.paused){
  if(task&&game.time>=task.at){const run=task.run;task=null;run();}
  game.update(dt);
  const c=refs.carrier;
  if(c?.magnetFeedback)refs.observed?.add(c.magnetFeedback.state);
  if((selected==='freeze'||selected==='freeze-merge')&&c?.froze&&!anchor){
   anchor={x:c.x,y:c.y};task={at:game.time+.4,run:()=>{refs.partner=game.spawnCrab(selected==='freeze'?1:2,selected==='freeze'?213:200,70);refs.partner.vy=120;}};
  }
  if(anchor&&c?.frozenUntil>game.time&&!c.merged)maxDrift=Math.max(maxDrift,Math.hypot(c.x-anchor.x,c.y-anchor.y));
 }
 game.render();if(now-lastUI>100){updateStatus();lastUI=now;}requestAnimationFrame(tick);
}
for(const b of document.querySelectorAll('[data-scene]'))b.addEventListener('click',()=>{sfx.unlock();choose(b.dataset.scene);});
$('replay').addEventListener('click',()=>{sfx.unlock();choose(selected);});
$('pause').addEventListener('click',()=>{sfx.unlock();game.setPaused(!game.paused);syncPause();});
function soundLabel(){$('sound').textContent=`音效：${sfx.enabled?'开':'关'}`;}
$('sound').addEventListener('click',()=>{sfx.toggle();soundLabel();});
for(const c of document.querySelectorAll('[data-icon]')){
 drawLegendIcon(c,3,3,false,c.dataset.icon);c.style.width=`${c.width/1.5}px`;c.style.height=`${c.height/1.5}px`;
}
const background=()=>{game.setPaused(true);syncPause();};
document.addEventListener('visibilitychange',()=>{if(document.hidden)background();});window.addEventListener('blur',background);window.addEventListener('pagehide',background);
window.addEventListener('resize',fit);
choose('pile-pull',false);soundLabel();requestAnimationFrame(tick);
