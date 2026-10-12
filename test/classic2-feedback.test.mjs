import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.localStorage={getItem:k=>k.endsWith(':sound')?'off':null,setItem(){}};
const {Game}=await import('../src/game.js');
const {getSprite,defOf}=await import('../src/crabs.js');
const make=()=>new Game({getContext:()=>({})},{},{seed:42});
const advance=(g,s)=>{for(let i=0;i<Math.round(s*120);i++)g.update(1/120);};

test('all fifteen special carriers retain their ordinary base body colour',t=>{
 const original=globalThis.document;
 globalThis.document={createElement(){const ops=[];const ctx={fillStyle:'',fillRect(x,y,w,h){ops.push({x,y,w,h,color:this.fillStyle});}};return{getContext:()=>ctx,ops};}};
 t.after(()=>{globalThis.document=original;});
 for(let level=1;level<=5;level++)for(const special of ['gold','magnet','freeze']){
  const sprite=getSprite(level,1,{special});
  const x=6-sprite.minX,y=6-sprite.minY;
  const pixel=sprite.canvas.ops.findLast(p=>x>=p.x&&x<p.x+p.w&&y>=p.y&&y<p.y+p.h);
  assert.equal(pixel.color,defOf(level).color,`${level}/${special}`);
 }
});

test('magnet feedback distinguishes no target, eligible target, and a frozen neighbour',()=>{
 const g=make(),m=g.spawnCrab(2,100,500);m.special='magnet';m.landedFor=.2;g.update(1/120);
 assert.equal(m.magnetFeedback?.state,'empty');
 g.spawnCrab(3,100,580);g.update(1/120);assert.equal(m.magnetFeedback.state,'empty');
 const target=g.spawnCrab(2,210,500);g.update(1/120);
 assert.equal(m.magnetFeedback.state,'pulling');assert.deepEqual(m.magnetFeedback.targets.map(x=>x.body.id),[target.id]);
 target.frozen=true;target.frozenUntil=g.time+3;target.sleep();g.update(1/120);
 assert.equal(m.magnetFeedback.state,'frozen');assert.equal(m.magnetFeedback.targets.length,0);
});

test('blocked feedback requires sustained lack of approach under actual contact',()=>{
 const g=make(),m=g.spawnCrab(1,120,580),blocker=g.spawnCrab(4,180,580),target=g.spawnCrab(1,240,580);
 advance(g,2);m.special='magnet';advance(g,.1);
 assert.equal(m.magnetFeedback?.state,'pulling');
 advance(g,1);assert.equal(m.magnetFeedback.state,'blocked');
 assert.equal(m.magnetFeedback.targets[0].body,target);assert.equal(target.merged,false);assert.ok(target.x>blocker.x);
 g.world.remove(blocker);g.world.wakeNear(blocker.x,blocker.y,blocker.bound+20);
 advance(g,.2);assert.equal(m.magnetFeedback.state,'pulling');
});

test('merge before arming explains that the magnetic ability was consumed without starting',()=>{
 const g=make();g.spawnCrab(2,200,580);advance(g,2);
 g.current=2;g.currentSpecial='magnet';g.drop();const m=g.world.bodies.at(-1);advance(g,1.2);
 assert.equal(m.merged,true);assert.equal(m.magnetArmed,false);
 assert.match(g.specialNotice?.message??'',/启动前.*合成/);
 assert.match(g.specialFeedbackText(),/2级爱心/);
});

test('expiry, reset and restored saves never retain stale magnetic feedback',()=>{
 const g=make(),m=g.spawnCrab(2,200,500);m.special='magnet';m.landedFor=.2;g.update(1/120);
 m.specialUntil=g.time;g.update(1/120);assert.match(g.specialNotice?.message??'',/耗尽/);
 g.restore(g.snapshot());assert.equal(g.specialNotice,null);
 g.reset();assert.equal(g.specialNotice,null);
});

test('same real pile and release point: magnet adds a merge that the ordinary control does not',async()=>{
 const {prepareStack}=await import('./classic2-stack-scenes.js');
 for(const scene of ['pile-control','pile-pull']){
  const g=make(),refs=prepareStack(g,scene);assert.equal(refs.initialBodies,9);
  g.drop();const carrier=g.world.bodies.at(-1);advance(g,5);
  assert.equal(carrier.merged,scene==='pile-pull');assert.equal(g.score,scene==='pile-pull'?2:0);
  if(scene==='pile-pull')assert.equal(carrier.magnetArmed,true);
 }
});

test('real pile exposes blocked, consumed-before-start and empty cases without claiming attraction success',async()=>{
 const {prepareStack}=await import('./classic2-stack-scenes.js');
 for(const scene of ['pile-blocked','pile-consumed','pile-empty']){
  const g=make();prepareStack(g,scene);g.drop();const carrier=g.world.bodies.at(-1),states=new Set();
  for(let i=0;i<600;i++){g.update(1/120);if(carrier.magnetFeedback)states.add(carrier.magnetFeedback.state);}
  if(scene==='pile-consumed'){
   assert.equal(carrier.magnetArmed,false);assert.equal(carrier.merged,true);assert.match(g.specialNotice.message,/启动前已合成/);
  }else{
   assert.equal(carrier.merged,false);
   assert.ok(states.has(scene==='pile-blocked'?'blocked':'empty'));
  }
 }
});

test('magnetic feedback is observational and does not change solved gameplay',async()=>{
 const {prepareStack}=await import('./classic2-stack-scenes.js');const a=make(),b=make();
 b.updateMagnetFeedback=()=>{};
 for(const g of [a,b]){prepareStack(g,'pile-blocked');g.drop();advance(g,4);}
 assert.deepEqual(a.snapshot(),b.snapshot());
});

test('visible labels include the base level independently of the ability',async()=>{
 const {clawdLabel}=await import('../src/crabs.js');
 assert.equal(clawdLabel(2,'magnet'),'磁力 · 2级爱心');
 assert.equal(clawdLabel(3,'freeze'),'冰冻 · 3级咖啡');
 assert.equal(clawdLabel(1,'gold'),'金色 · 1级小Clawd');
});

test('claw removal reports magnetic consumption and game over stops the live status',()=>{
 const g=make(),m=g.spawnCrab(2,200,500);m.special='magnet';m.landedFor=.2;g.update(1/120);
 g.claws=1;g.clawMode=true;assert.equal(g.useClawAt(m.x,m.y),true);
 assert.match(g.specialNotice.message,/夹走/);
 g.gameOver();assert.match(g.specialFeedbackText(),/对局结束/);
});
