import { World } from './physics.js';

export const SCHEMA_VERSION = 1;
export const RULES_VERSION = 'classic-1';
const fields = ['score','bestAtStart','recordShown','time','visualTime','drops','maxLevel','current','next',
  'aimX','cooldown','danger','warning','combo','feverMeter','feverTime','claws'];
const bodyFields = ['level','x','y','angle','vx','vy','w','sleeping','stillTime','restX','restY','restAngle','born','landedFor'];
const pick = (object, keys) => Object.fromEntries(keys.map(k => [k, object[k] ?? (k === 'landedFor' ? 0 : undefined)]));
const number = (n, lo, hi, integer = false) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi && (!integer || Number.isInteger(n));
function requireValue(ok) { if (!ok) throw new Error('invalid_snapshot'); }

export function validateGameState(s) {
  requireValue(s && typeof s === 'object');
  for (const key of ['score','bestAtStart','drops','combo']) requireValue(number(s[key],0,1e9,true));
  for (const key of ['time','visualTime']) requireValue(number(s[key],0,1e9));
  requireValue(typeof s.recordShown === 'boolean');
  for (const key of ['current','next']) requireValue(number(s[key],0,5,true));
  requireValue(number(s.maxLevel,1,11,true) && number(s.claws,0,3,true));
  requireValue(number(s.aimX,0,400) && number(s.cooldown,0,0.5));
  requireValue(number(s.danger,0,3) && number(s.warning,0,2,true));
  requireValue(number(s.feverMeter,0,180) && number(s.feverTime,0,8));
  requireValue(s.lastMergeAt === null || number(s.lastMergeAt,0,s.time));
  requireValue(Array.isArray(s.seen) && s.seen.length <= 12 && s.seen.every(n => number(n,0,11,true)));
  requireValue(Array.isArray(s.bodies) && s.bodies.length <= 1000);
  for (const b of s.bodies) {
    requireValue(b && number(b.level,0,11,true) && typeof b.sleeping === 'boolean');
    for (const key of ['x','y','restX','restY']) requireValue(number(b[key],-10000,10000));
    for (const key of ['vx','vy','w','angle','restAngle']) requireValue(number(b[key],-1e8,1e8));
    for (const key of ['stillTime','born','landedFor']) requireValue(number(b[key],0,1e9));
    requireValue(b.born<=s.time);
  }
  requireValue(Array.isArray(s.contacts) && s.contacts.length <= 20000);
  for (const c of s.contacts) {
    requireValue(number(c.a,-1,s.bodies.length-1,true) && number(c.b,0,s.bodies.length-1,true));
    requireValue(number(c.ia,-3,300,true) && number(c.ib,0,300,true));
    for (const k of ['nx','ny','pen','px','py','Pn','Pt']) requireValue(number(c[k],-1e9,1e9));
  }
  return s;
}

export function captureGame(g) {
  const indexes = new Map(g.world.bodies.map((b,i) => [b,i]));
  const contacts = g.world.contacts.filter(c => (c.a === g.world.wall || indexes.has(c.a)) && indexes.has(c.b))
    .map(c => ({ a: c.a === g.world.wall ? -1 : indexes.get(c.a), b:indexes.get(c.b),
      ...pick(c,['ia','ib','nx','ny','pen','px','py','Pn','Pt']) }));
  return validateGameState({ ...pick(g,fields), lastMergeAt: Number.isFinite(g.lastMergeAt) ? g.lastMergeAt : null,
    seen:[...g.seen], bodies:g.world.bodies.map(b => pick(b,bodyFields)), contacts });
}

export function restoreGame(g, state) {
  validateGameState(state);
  const world = new World({ width:400,height:640,gravity:1800 });
  const builder = Object.create(g); builder.world = world; builder.time = state.time;
  for (const data of state.bodies) {
    const b = builder.spawnCrab(data.level,data.x,data.y);
    Object.assign(b,pick(data,bodyFields));
    if (data.sleeping) { b.im=0; b.ii=0; }
    b.updateTransform();
  }
  for (const data of state.contacts) {
    const a = data.a === -1 ? world.wall : world.bodies[data.a], b = world.bodies[data.b];
    requireValue(b.shapes[data.ib] && (data.a === -1 ? data.ia < 0 : a.shapes[data.ia]));
    const c = world.contact(a,b,data.ia,data.ib,data.nx,data.ny,data.pen,data.px,data.py);
    c.Pn=data.Pn; c.Pt=data.Pt; world.contacts.push(c); world.cache.set(c.key,c);
  }
  // No callbacks or durable writes before validation and reconstruction succeed.
  g.world = world; Object.assign(g,pick(state,fields));
  g.lastMergeAt = state.lastMergeAt ?? -Infinity;
  g.best = Math.max(g.best,state.score,state.bestAtStart);
  for (const level of state.seen) g.seen.add(level);
  g.acc=0; g.pendingDrop=false; g.paused=true; g.over=false; g.clawMode=false;
  g.particles=[];g.texts=[];g.rings=[];g.card=null;g.shake=0;
}
