import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.localStorage = {getItem: key => key.endsWith(':sound') ? 'off' : null, setItem() {}};
const {Game} = await import('../src/game.js');
const {sfx} = await import('../src/audio.js');
const make = (options = {}) => new Game({getContext: () => ({})}, {}, {seed: 42, ...options});
function advance(g, seconds) { for (let i=0; i<Math.round(seconds*120); i++) g.update(1/120); }
function frozenCarrier() {
  const g = make();
  const ice = g.spawnCrab(2, 200, 570); ice.special = 'freeze';
  for (let i=0; i<360 && !ice.froze; i++) g.update(1/120);
  assert.ok(ice.frozenUntil > g.time);
  return {g, ice};
}

test('freeze holds its transform through a real falling nonmatching impact until expiry', () => {
  const {g, ice} = frozenCarrier();
  const initial = [ice.x, ice.y, ice.angle];
  const falling = g.spawnCrab(1, 213, 70); falling.vy = 120;
  advance(g, 2);
  assert.ok(ice.frozenUntil > g.time);
  assert.deepEqual([ice.x, ice.y, ice.angle], initial);
  assert.equal(ice.sleeping, true);
  advance(g, 1.1);
  assert.equal(ice.frozenUntil, 0);
  assert.equal(ice.frozen, false);
});

test('freeze resists magnet and wakeNear; merging with a falling same-level still works', () => {
  const {g, ice} = frozenCarrier();
  const initial = [ice.x, ice.y];
  const magnet = g.spawnCrab(2, 300, ice.y); magnet.special = 'magnet'; magnet.magnetArmed = true; magnet.specialUntil = g.time + 2.5;
  g.world.wakeNear(ice.x, ice.y, 100);
  g.updateSpecials(1/120);
  assert.equal(ice.sleeping, true);
  assert.equal(ice.vx, 0);
  assert.deepEqual([ice.x, ice.y], initial);
  g.world.remove(magnet);
  const partner = g.spawnCrab(2, 200, 70); partner.vy = 120;
  advance(g, 1.5);
  assert.equal(ice.merged, true);
  assert.equal(g.score, 4);
});

test('freeze follows actual compound contact, not separated bounding circles', () => {
  const g = make();
  const a = g.spawnCrab(1, 180, 580), b = g.spawnCrab(1, 217, 580);
  g.world.collide();
  assert.equal(g.world.contacts.filter(c => c.ia >= 0).length, 0);
  g.freezeCluster(a);
  assert.equal(b.frozenUntil, 0);
});

test('freeze marks a genuinely touching sleeping pile as active', () => {
  const g = make();
  const a = g.spawnCrab(2, 200, 600), b = g.spawnCrab(3, 200, 570);
  a.sleep(); b.sleep(); g.freezeCluster(a);
  assert.ok(b.frozenUntil > g.time);
  assert.equal(g.activeSpecialCount('freeze'), 1);
});

test('restoring an unsupported frozen body expires the freeze and lets gravity resume', () => {
  const g = make();
  const b = g.spawnCrab(2, 200, 300); g.freezeCluster(b);
  const h = make();h.restore(JSON.parse(JSON.stringify(g.snapshot())));h.setPaused(false);
  advance(h, 0.2);
  assert.ok(h.world.bodies[0].y > 310);
  assert.equal(h.world.bodies[0].frozenUntil, 0);
});

for (const level of [1,2,3,4,5]) test(`magnet merges grounded level ${level} across a 120-unit centre gap via real physics`, () => {
  const g = make(); const m=g.spawnCrab(level,100,580), target=g.spawnCrab(level,220,580);
  advance(g,2); assert.equal(g.score,0); assert.ok(m.sleeping && target.sleeping);
  m.special='magnet';advance(g,2.6);
  assert.equal(target.merged,true);
  assert.ok(g.score > 0);
  for(const b of g.world.bodies) assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
});

test('a grounded obstacle blocks a magnet without pulling the target through it', () => {
  const g=make();const m=g.spawnCrab(1,120,590), blocker=g.spawnCrab(4,180,590), target=g.spawnCrab(1,240,590);
  advance(g,2);m.special='magnet';
  for(let i=0;i<312;i++) {
    g.update(1/120);
    assert.ok(target.x > blocker.x);
    assert.ok(blocker.x > m.x);
  }
  assert.equal(target.merged,false);
});

test('old classic and daily never accumulate crowns or play the new crown cue', (t) => {
  let crownCues=0;t.mock.method(sfx,'crown',()=>crownCues++);
  for(const options of [{rulesVersion:'classic-1'}, {challenge:{challengeId:'audit',rulesVersion:'daily-1',count:100}}]) {
    const g=make(options);
    for(let i=0;i<3;i++) {
      g.time+=2; const a=g.spawnCrab(11,180,400),b=g.spawnCrab(11,200,400);
      g.world.contacts=[{a,b,ia:0,ib:0,nx:0,ny:1,pen:1,px:0,py:0,Pn:0,Pt:0}];g.handleMerges();
    }
    assert.equal(g.score,12144);assert.equal(g.crowns,0);assert.equal(g.crownCycles,0);
  }
  assert.equal(crownCues,0);
});

test('freeze survives a removed support and pause, then resumes gravity on expiry', () => {
  const g=make(); const b=g.spawnCrab(2,200,300);g.freezeCluster(b);
  const initialTime=g.time;
  g.setPaused(true);advance(g,4);assert.equal(g.time,initialTime);assert.equal(b.y,300);
  g.setPaused(false);advance(g,2.8);assert.equal(b.y,300);
  advance(g,.5);assert.ok(b.y>310);assert.equal(b.frozen,false);
});

test('magnetic acceleration caps approach speed and never attracts a frozen target', () => {
  const g=make();const m=g.spawnCrab(2,100,400),target=g.spawnCrab(2,220,400);
  m.special='magnet';m.magnetArmed=true;m.specialUntil=2.5;
  for(let i=0;i<120;i++)g.updateSpecials(1/120);
  assert.ok(Math.abs(target.vx)<=100);assert.ok(target.vx<0);
  target.frozen=true;target.sleep();g.updateSpecials(1/120);assert.equal(target.vx,0);
});

test('legacy restore discards crowns left by the previous cross-version bug', () => {
  for(const options of [{rulesVersion:'classic-1'},{challenge:{challengeId:'legacy',rulesVersion:'daily-1',count:100}}]){
    const source=make(options);const state=source.snapshot();state.crowns=2;state.crownCycles=1;
    const restored=make(options);restored.restore(state);
    assert.equal(restored.crowns,0);assert.equal(restored.crownCycles,0);
  }
});
