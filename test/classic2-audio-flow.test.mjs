import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.localStorage={getItem:key=>key.endsWith(':sound')?'off':null,setItem(){}};
const {Game}=await import('../src/game.js');
const {sfx}=await import('../src/audio.js');
const make=()=>new Game({getContext:()=>({})},{},{seed:42});
function loopProbe(t) {
  const handles=[];const original=sfx.startMagnet;
  sfx.startMagnet=()=>{const h={active:true,stop(){this.active=false;}};handles.push(h);return h;};
  t.after(()=>{if(original)sfx.startMagnet=original;else delete sfx.startMagnet;});
  return handles;
}
function arm(g) {const m=g.spawnCrab(2,200,500);m.special='magnet';m.landedFor=.2;g.update(1/60);return m;}

test('magnet ambience stops for pause, resumes once, and releases on reset and expiry',t=>{
  const handles=loopProbe(t),g=make();const m=arm(g);
  assert.equal(handles.length,1);g.update(1/60);assert.equal(handles.length,1);
  g.setPaused(true);assert.equal(handles[0].active,false);
  g.setPaused(false);g.update(1/60);assert.equal(handles.length,2);
  m.specialUntil=g.time;g.update(1/60);assert.equal(handles[1].active,false);
  g.world.clear();arm(g);assert.equal(handles.length,3);g.reset();assert.equal(handles[2].active,false);
});

test('magnet ambience ends after its carrier merges and after game over',t=>{
  const handles=loopProbe(t),g=make();const m=arm(g);const p=g.spawnCrab(2,m.x,m.y);
  g.world.contacts=[{a:m,b:p,ia:0,ib:0,nx:0,ny:1,pen:1,px:0,py:0,Pn:0,Pt:0}];g.handleMerges();g.update(1/60);
  assert.equal(handles[0].active,false);
  arm(g);g.gameOver();assert.equal(handles.at(-1).active,false);
});

test('restoring a save stops live ambience and does not revive an expired magnet',t=>{
  const handles=loopProbe(t),g=make();arm(g);const state=g.snapshot();
  g.restore(state);assert.equal(handles[0].active,false);
  g.setPaused(false);g.update(1/60);assert.equal(handles.length,1);
});

test('a frozen cluster emits one thaw cue rather than one cue per body',t=>{
  let cues=0;const original=sfx.thaw;sfx.thaw=()=>cues++;
  t.after(()=>{if(original)sfx.thaw=original;else delete sfx.thaw;});
  const g=make();const a=g.spawnCrab(2,200,600),b=g.spawnCrab(3,200,570);g.freezeCluster(a);
  assert.equal(a.frozenUntil,b.frozenUntil);g.time=a.frozenUntil;g.updateSpecials(1/120);
  assert.equal(cues,1);g.updateSpecials(1/120);assert.equal(cues,1);
});
