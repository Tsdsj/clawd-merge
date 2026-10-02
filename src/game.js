import { World, Body } from './physics.js';
import { captureGame, restoreGame } from './game-state.js';
import { GameplayRandom } from './random.js';
import { challengeSequence, SETTLE_SECONDS, STABLE_SECONDS } from './challenge.js';
import { chooseClassicLevel } from './drop-sequence.js';
import { RULES, DROP_COOLDOWN, COMBO_WINDOW, FEVER_MAX, FEVER_TIME, CLAW_LEVEL, MAX_CLAWS, KING_BONUS } from './rules.js';
export { RULES } from './rules.js';
import { readPreference, writePreference } from './storage.js';
import {
  MAX_LEVEL,
  RAINBOW,
  RAINBOW_FRAMES,
  ANCHOR_X,
  ANCHOR_Y,
  BODY_COLS,
  defOf,
  hitboxOf,
  getSprite,
  clearSpriteCache,
} from './crabs.js';
import { sfx } from './audio.js';

// Fixed logical world; the canvas is scaled to fit the screen.
export const WORLD_W = 400;
export const WORLD_H = 640;
export const LINE_Y = 140; // warning line
const DROP_Y = 70;
const STEP = 1 / 120;
const MAX_STEPS = 12;
const BEST_KEY = 'clawd-merge:best';
const SEEN_KEY = 'clawd-merge:seen';
const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rand = (a, b) => a + Math.random() * (b - a);
const easeOutBack = (t) => 1 + 2.9 * (t - 1) ** 3 + 1.9 * (t - 1) ** 2;
const easeOut = (t) => 1 - (1 - t) ** 3;
const RAINBOW_COLORS = ['#FF5E5B', '#FF9F43', '#FFD84D', '#5BD17A', '#4DB2FF', '#A77BFF'];

// Haptics for touch devices; browsers reject vibration before a real tap.
let hapticsReady = false;
export const enableHaptics = () => {
  hapticsReady = true;
};
const DEFAULT_EFFECTS = Object.freeze({reduced:false,shake:true,particles:true,haptics:false});

// How far each Clawd's hitbox reaches left/right of its centre (for aiming).
const extents = new Map();
function extentOf(level) {
  if (!extents.has(level)) {
    const shapes = hitboxOf(level);
    extents.set(level, {
      left: Math.max(...shapes.map((s) => s.r - s.x)),
      right: Math.max(...shapes.map((s) => s.x + s.r)),
      halfH: Math.max(...shapes.map((s) => s.y + s.r)),
    });
  }
  return extents.get(level);
}

function loadSeen() {
  try {
    return new Set([1, ...JSON.parse(readPreference(SEEN_KEY) || '[]')]);
  } catch {
    return new Set([1]);
  }
}

export class Game {
  constructor(canvas, events = {}, { seed, challenge = null, comfort = () => DEFAULT_EFFECTS } = {}) {
    this.comfort = comfort;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.events = events;
    this.gameplayRandom = new GameplayRandom(seed);
    this.challengeDefinition = challenge ? Object.freeze({ challengeId: challenge.challengeId, rulesVersion: challenge.rulesVersion, count: challenge.count }) : null;
    this.dropSequence = challenge ? challengeSequence(this.challengeDefinition) : null;
    this.persistPreferences = !challenge;
    this.world = new World({ width: WORLD_W, height: WORLD_H, gravity: 1800 });
    this.scale = 1;
    this.dpr = 1;
    this.debug = false;
    this.best = this.persistPreferences ? Number(readPreference(BEST_KEY)) || 0 : 0;
    this.seen = this.persistPreferences ? loadSeen() : new Set([1]);
    this.reset();
  }

  get effects() { return this.comfort(); }

  applyComfort() {
    const e=this.effects;
    if(!e.particles)this.particles.length=0;
    if(e.reduced)this.rings.length=0;
    if(!e.shake)this.shake=0;
  }

  buzz(pattern) {
    if(this.effects.haptics && hapticsReady && globalThis.navigator?.vibrate) {
      try { navigator.vibrate(pattern); } catch { /* Device feedback is optional. */ }
    }
  }

  reset() {
    this.paused = false;
    this.visualTime = 0;
    this.world.clear();
    this.score = 0;
    this.bestAtStart = this.best;
    this.recordShown = false;
    this.time = 0;
    this.acc = 0;
    this.drops = 0;
    this.maxLevel = 1;
    this.challenge = this.challengeDefinition ? { ...this.challengeDefinition, phase: 'playing', settlingTime: 0, stableTime: 0, reason: null } : null;
    this.current = this.dropSequence?.[0] ?? 1;
    this.next = this.dropSequence ? this.dropSequence[1] : this.randomLevel();
    this.aimX = WORLD_W / 2;
    this.cooldown = 0;
    this.pendingDrop = false;
    this.danger = 0;
    this.warning = 0;
    this.over = false;
    this.combo = 0;
    this.lastMergeAt = -Infinity;
    this.feverMeter = 0;
    this.feverTime = 0;
    this.claws = 0;
    this.clawsUsed = 0;
    this.clawMode = false;
    this.particles = [];
    this.texts = [];
    this.rings = [];
    this.card = null;
    this.shake = 0;
    this.events.onScore?.(this.score, this.best);
    this.events.onNext?.(this.next);
    this.events.onLevel?.(this.maxLevel);
    this.events.onClaws?.(this.claws, this.clawMode);
    this.events.onFever?.(false);
  }

  get fever() {
    return this.feverTime > 0;
  }

  snapshot() { return captureGame(this); }
  restore(state) {
    restoreGame(this,state);
    if (!this.persistPreferences) return;
    if(!writePreference(BEST_KEY,String(this.best)))this.persistenceWarning=true;
    if(!writePreference(SEEN_KEY,JSON.stringify([...this.seen])))this.persistenceWarning=true;
  }

  get settling() { return this.challenge?.phase === 'settling'; }

  // Early on only the tiniest Clawds drop; bigger ones unlock as you progress.
  randomLevel() {
    return chooseClassicLevel(() => this.gameplayRandom.next(), this);
  }

  resize(cssW, cssH, dpr) {
    this.dpr = dpr;
    this.scale = cssW / WORLD_W;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    clearSpriteCache();
    this.buildBackground();
  }

  setAim(x) {
    if (this.paused) return;
    this.aimX = clamp(x, 0, WORLD_W);
  }

  clampAim(x, level) {
    const { left, right } = extentOf(level);
    return clamp(x, left + 1, WORLD_W - right - 1);
  }

  // Taps during the cooldown are queued so fast players don't lose inputs.
  requestDrop() {
    if (this.paused || this.over || this.clawMode || this.settling) return;
    if (this.cooldown > 0) this.pendingDrop = true;
    else this.drop();
  }

  drop() {
    if (this.paused || this.over || this.settling) return;
    const level = this.current;
    const crab = this.spawnCrab(level, this.clampAim(this.aimX, level), DROP_Y);
    crab.vy = 120;
    this.drops++;
    this.current = this.dropSequence ? this.dropSequence[this.drops] ?? null : this.next;
    this.next = this.dropSequence ? this.dropSequence[this.drops + 1] ?? null : this.randomLevel();
    if (this.challenge && this.drops === this.challenge.count) { this.challenge.phase = 'settling'; this.clawMode = false; }
    this.cooldown = DROP_COOLDOWN;
    this.pendingDrop = false;
    sfx.drop();
    if (level === RAINBOW && !this.seen.has(RAINBOW)) this.discover(RAINBOW);
    this.events.onNext?.(this.next);
    this.events.onDrop?.(this.drops);
  }

  spawnCrab(level, x, y) {
    const w = defOf(level).width;
    const h = (w * 10) / BODY_COLS;
    const mass = Math.pow(w, 1.6) / 100;
    const crab = new Body({
      x,
      y,
      shapes: hitboxOf(level),
      mass,
      inertia: (mass * (w * w + h * h)) / 12,
      friction: 0.35,
      restitution: 0.12,
    });
    crab.level = level;
    crab.born = this.time;
    crab.merged = false;
    crab.pop = false;
    crab.squash = 0;
    crab.dustAt = 0;
    crab.blinkAt = this.time + rand(1, 5);
    this.world.add(crab);
    return crab;
  }

  setPaused(paused) {
    this.paused = paused;
    this.pendingDrop = false;
    this.acc = 0;
  }

  update(dt) {
    if (this.paused) return;
    dt = Math.min(dt, 0.1);
    this.visualTime += dt;
    this.updateEffects(dt);
    if (this.over) return;

    const settlingAtStart = this.settling;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= STEP && steps < MAX_STEPS) {
      this.world.step(STEP);
      this.time += STEP;
      this.handleImpacts();
      this.handleMerges();
      this.acc -= STEP;
      steps++;
    }
    if (steps === MAX_STEPS) this.acc = 0;

    if (this.cooldown > 0) {
      this.cooldown = Math.max(0, this.cooldown - dt);
      if (this.cooldown === 0 && this.pendingDrop) this.drop();
    }
    if (this.feverTime > 0) {
      this.feverTime = Math.max(0, this.feverTime - dt);
      if (this.feverTime === 0) this.events.onFever?.(false);
    }
    this.checkDanger(dt);
    if (settlingAtStart && this.settling && !this.over) {
      this.pendingDrop = false;
      this.challenge.settlingTime = Math.min(SETTLE_SECONDS, this.challenge.settlingTime + dt);
      const stable = this.world.bodies.every(b => b.sleeping) && this.time - this.lastMergeAt >= dt;
      this.challenge.stableTime = stable ? Math.min(STABLE_SECONDS, this.challenge.stableTime + dt) : 0;
      if (this.challenge.stableTime >= STABLE_SECONDS || this.challenge.settlingTime >= SETTLE_SECONDS) this.gameOver('limit');
    }
  }

  // Squash & dust when a Clawd lands hard.
  handleImpacts() {
    for (const c of this.world.contacts) {
      for (const body of c.ia < 0 ? [c.b] : [c.a, c.b]) {
        const dv = c.Pn * body.invMass;
        if (dv < 140) continue;
        body.squash = Math.max(body.squash, Math.min(0.28, dv / 1600));
        if (dv > 260 && this.time - body.dustAt > 0.25) {
          body.dustAt = this.time;
          this.dust(c.px, c.py, Math.min(10, 3 + dv / 80));
        }
      }
    }
  }

  handleMerges() {
    const pairs = [];
    for (const c of this.world.contacts) {
      const { a, b } = c;
      if (c.ia < 0 || a.merged || b.merged || c.pen < -0.5) continue;
      const ra = a.level === RAINBOW;
      const rb = b.level === RAINBOW;
      if (ra !== rb) {
        // The rainbow Clawd upgrades whatever it touches.
        pairs.push(ra ? [a, b, true] : [b, a, true]);
      } else if (!ra && a.level === b.level) {
        pairs.push([a, b, false]);
      } else {
        continue;
      }
      a.merged = true;
      b.merged = true;
    }
    for (const [a, b, rainbow] of pairs) {
      if (rainbow) this.upgrade([a, b], b.level, b.x, b.y, b, true);
      else this.upgrade([a, b], a.level, (a.x + b.x) / 2, (a.y + b.y) / 2, a, false);
    }
  }

  // Removes `consumed` and creates a Clawd of `level + 1` at (x, y).
  upgrade(consumed, level, x, y, ref, rainbow) {
    for (const b of consumed) {
      this.world.remove(b);
      // Clawds leaning on the removed ones must react (fall in / get pushed away).
      this.world.wakeNear(b.x, b.y, b.bound + 20);
    }

    this.combo = this.time - this.lastMergeAt <= COMBO_WINDOW ? this.combo + 1 : 1;
    this.lastMergeAt = this.time;
    const mult =
      Math.min(RULES.maxComboMult, 1 + RULES.comboStep * (this.combo - 1)) * (this.fever ? 2 : 1);
    const colors = rainbow ? RAINBOW_COLORS : null;

    // Two kings (or a king + rainbow) ascend into a big bonus.
    if (level === MAX_LEVEL) {
      this.addScore(Math.round((RULES.points(level) + KING_BONUS) * mult), x, y);
      this.burst(x, y, 90, colors ?? ['#F7C948', '#FFE08A', '#D97757', '#FFFFFF']);
      this.ring(x, y, 40, 260, '#F7C948');
      this.shake = this.effects.shake ? 12 : 0;
      this.floatText('Clawd 之王!', WORLD_W / 2, WORLD_H / 2 - 40, 30, '#F7C948', 2);
      sfx.jackpot();
      this.buzz(80);
      this.addFever(20);
      return;
    }

    const nl = level + 1;
    const { left, right } = extentOf(nl);
    const crab = this.spawnCrab(nl, clamp(x, left, WORLD_W - right), Math.min(y, WORLD_H - extentOf(nl).halfH));
    crab.angle = ref.angle;
    crab.updateTransform();
    crab.vx = ref.vx;
    crab.vy = Math.min(0, ref.vy) - 80;
    crab.pop = true;

    const points = Math.round(RULES.points(level) * mult);
    this.addScore(points, x, y);
    if (this.combo >= 2) {
      const size = Math.min(26, 14 + this.combo * 2);
      this.floatText(`连击 ×${this.combo}`, x, y - 34, size, '#FFD84D', 1.1);
    }
    // Debris in the new Clawd's colour, so you see what you just made.
    const tint = defOf(nl).color;
    this.burst(x, y, 10 + nl * 3, colors ?? (nl === MAX_LEVEL ? ['#F7C948', '#FFE08A', tint, '#FFFFFF'] : [tint, tint, '#FFFFFF', defOf(level).color]));
    this.ring(x, y, defOf(nl).width * 0.3, defOf(nl).width * 0.9, rainbow ? '#FFFFFF' : tint);
    if (nl >= 7 && this.effects.shake) this.shake = Math.max(this.shake, 2 + (nl - 7) * 1.5);

    if (nl > this.maxLevel) {
      this.maxLevel = nl;
      this.events.onLevel?.(nl);
      if (nl >= CLAW_LEVEL && this.claws < MAX_CLAWS) {
        this.claws++;
        this.floatText('获得钳子 +1', x, y - 60, 16, '#8FE3FF', 1.4);
        this.events.onClaws?.(this.claws, this.clawMode);
      }
    }
    if (!this.seen.has(nl)) this.discover(nl);
    this.addFever(nl + Math.min(this.combo - 1, 4));
    if (rainbow) sfx.rainbow();
    sfx.merge(nl, this.combo);
    if (nl >= 6) this.buzz(nl >= 9 ? 40 : 15);
  }

  addFever(amount) {
    if (this.fever) return;
    this.feverMeter += amount;
    if (this.feverMeter >= FEVER_MAX) {
      this.feverMeter = 0;
      this.feverTime = FEVER_TIME;
      this.floatText('狂热模式! 得分 ×2', WORLD_W / 2, 200, 24, '#FFD84D', 1.8);
      this.burst(WORLD_W / 2, 160, 40, ['#FFD84D', '#FF9F43', '#FFFFFF']);
      sfx.fever();
      this.buzz([20, 40, 20]);
      this.events.onFever?.(true);
    }
  }

  addScore(points, x, y) {
    this.score += points;
    if (this.score > this.best) {
      this.best = this.score;
      if(this.persistPreferences && !writePreference(BEST_KEY, String(this.best)))this.persistenceWarning=true;
    }
    this.floatText(`+${points}`, x, y - 10, 16, this.fever ? '#FFD84D' : '#FFFFFF', 0.9);
    if (!this.recordShown && this.bestAtStart > 0 && this.score > this.bestAtStart) {
      this.recordShown = true;
      this.floatText('新纪录!', WORLD_W / 2, 150, 28, '#FFD84D', 1.8);
      this.confetti();
      sfx.record();
    }
    this.events.onScore?.(this.score, this.best);
  }

  discover(level) {
    this.seen.add(level);
    if(this.persistPreferences && !writePreference(SEEN_KEY, JSON.stringify([...this.seen])))this.persistenceWarning=true;
    this.card = { level, t: 0, dur: 2.2 };
    sfx.discover();
    this.events.onDiscover?.(this.seen);
  }

  // ---------- claw power-up ----------

  toggleClaw() {
    if (this.paused || this.over || this.settling || (this.claws === 0 && !this.clawMode)) return;
    this.clawMode = !this.clawMode;
    this.events.onClaws?.(this.claws, this.clawMode);
  }

  // Removes the Clawd under (x, y). Returns false if nothing was hit.
  useClawAt(x, y) {
    if (this.paused || this.over || this.settling || !this.clawMode) return false;
    let target = null;
    let best = Infinity;
    for (const b of this.world.bodies) {
      for (const s of b.shapes) {
        const d = Math.hypot(b.x + s.ox - x, b.y + s.oy - y) - s.r;
        if (d < 6 && d < best) {
          best = d;
          target = b;
        }
      }
    }
    if (!target) return false;
    this.world.remove(target);
    this.world.wakeNear(target.x, target.y, target.bound + 20);
    this.burst(target.x, target.y, 24, ['#8FE3FF', '#FFFFFF', '#D97757']);
    this.ring(target.x, target.y, 10, target.bound * 1.4, '#8FE3FF');
    this.floatText('夹走!', target.x, target.y - 20, 20, '#8FE3FF', 1);
    this.claws--;
    this.clawsUsed++;
    this.clawMode = false;
    sfx.claw();
    this.buzz(25);
    this.events.onClaws?.(this.claws, this.clawMode);
    return true;
  }

  checkDanger(dt) {
    let above = false;
    let near = false;
    const supported = this.supportedBodies();
    for (const b of this.world.bodies) {
      const flying = Math.hypot(b.vx, b.vy) > RULES.flyingSpeed;
      b.landedFor = supported.has(b) && !flying ? (b.landedFor ?? 0) + dt : 0;
      if (this.time - b.born < RULES.dangerGrace || b.landedFor < RULES.landedTime) continue;
      let top = Infinity;
      for (const s of b.shapes) top = Math.min(top, b.y + s.oy - s.r);
      if (top < LINE_Y) above = true;
      else if (top < LINE_Y + 50) near = true;
    }
    this.warning = above ? 2 : near ? 1 : 0;
    this.danger = above ? this.danger + dt : Math.max(0, this.danger - dt * 2);
    if (this.danger >= RULES.gameOverTime) this.gameOver();
  }

  // Bodies connected to the floor/walls through a chain of contacts. A cluster
  // of Clawds flying together after a big merge touches each other but not the
  // ground, so it isn't "on the pile" yet.
  supportedBodies() {
    const neighbours = new Map();
    const supported = new Set();
    const queue = [];
    const mark = (b) => {
      if (!supported.has(b)) {
        supported.add(b);
        queue.push(b);
      }
    };
    for (const b of this.world.bodies) if (b.sleeping) mark(b); // resting (their contacts aren't listed)
    for (const c of this.world.contacts) {
      if (c.ia < 0) {
        mark(c.b); // touching a wall or the floor
        continue;
      }
      if (!neighbours.has(c.a)) neighbours.set(c.a, []);
      if (!neighbours.has(c.b)) neighbours.set(c.b, []);
      neighbours.get(c.a).push(c.b);
      neighbours.get(c.b).push(c.a);
    }
    while (queue.length) for (const n of neighbours.get(queue.pop()) ?? []) mark(n);
    return supported;
  }

  gameOver(reason = 'danger') {
    if (this.over) return;
    if (this.challenge) { this.challenge.phase = 'finished'; this.challenge.reason = reason; this.danger = Math.min(this.danger, RULES.gameOverTime); }
    this.over = true;
    this.warning = 0;
    this.clawMode = false;
    if (this.feverTime > 0) {
      this.feverTime = 0;
      this.events.onFever?.(false);
    }
    sfx.over();
    this.buzz([40, 60, 40]);
    this.events.onGameOver?.({
      score: this.score,
      best: this.best,
      maxLevel: this.maxLevel,
      isNewBest: this.score > this.bestAtStart && this.score > 0,
    });
  }

  // ---------- effects ----------

  burst(x, y, count, colors) {
    if(!this.effects.particles)return;
    colors ??= ['#D97757', '#F0A07F', '#FFE3C2', '#FFFFFF'];
    for (let i = 0; i < count; i++) {
      const angle = rand(0, Math.PI * 2);
      const speed = rand(80, 320);
      const life = rand(0.4, 0.9);
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 120,
        g: 900,
        life,
        max: life,
        size: rand(2, 5),
        color: colors[i % colors.length],
      });
    }
  }

  dust(x, y, count) {
    if(!this.effects.particles)return;
    for (let i = 0; i < count; i++) {
      const life = rand(0.25, 0.5);
      this.particles.push({
        x: x + rand(-6, 6),
        y,
        vx: rand(-90, 90),
        vy: rand(-70, -20),
        g: 200,
        life,
        max: life,
        size: rand(2, 4),
        color: 'rgba(200, 190, 215, 0.7)',
      });
    }
  }

  confetti() {
    if(!this.effects.particles)return;
    for (let i = 0; i < 70; i++) {
      const life = rand(1.2, 2.2);
      this.particles.push({
        x: rand(0, WORLD_W),
        y: rand(-40, 0),
        vx: rand(-40, 40),
        vy: rand(40, 160),
        g: 120,
        life,
        max: life,
        size: rand(3, 6),
        color: RAINBOW_COLORS[i % RAINBOW_COLORS.length],
      });
    }
  }

  ring(x, y, r0, r1, color) {
    if(this.effects.reduced)return;
    this.rings.push({ x, y, r0, r1, color, life: 0.45, max: 0.45 });
  }

  floatText(text, x, y, size, color, life = 1) {
    this.texts.push({ text, x: clamp(x, 60, WORLD_W - 60), y, size, color, life, max: life });
  }

  updateEffects(dt) {
    this.applyComfort();
    for (const p of this.particles) {
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const t of this.texts) {
      if(!this.effects.reduced)t.y -= 40 * dt;
      t.life -= dt;
    }
    this.texts = this.texts.filter((t) => t.life > 0);
    for (const r of this.rings) r.life -= dt;
    this.rings = this.rings.filter((r) => r.life > 0);
    const decay = Math.exp(-dt * 10);
    for (const b of this.world.bodies) b.squash *= decay;
    if (this.card) {
      this.card.t += dt;
      if (this.card.t > this.card.dur) this.card = null;
    }
    this.shake = Math.max(0, this.shake - dt * 20);
  }

  // ---------- rendering ----------

  buildBackground() {
    const bg = document.createElement('canvas');
    bg.width = this.canvas.width;
    bg.height = this.canvas.height;
    const g = bg.getContext('2d');
    const k = this.scale * this.dpr;
    g.setTransform(k, 0, 0, k, 0, 0);
    g.fillStyle = '#151A2E';
    g.fillRect(0, 0, WORLD_W, WORLD_H);
    g.fillStyle = 'rgba(0, 0, 0, 0.18)';
    g.fillRect(0, 0, WORLD_W, LINE_Y);
    g.fillStyle = 'rgba(255, 255, 255, 0.04)';
    for (let x = 10; x < WORLD_W; x += 20) {
      for (let y = 10; y < WORLD_H; y += 20) g.fillRect(x - 1, y - 1, 2, 2);
    }
    const floor = g.createLinearGradient(0, WORLD_H - 90, 0, WORLD_H);
    floor.addColorStop(0, 'rgba(217, 119, 87, 0)');
    floor.addColorStop(1, 'rgba(217, 119, 87, 0.1)');
    g.fillStyle = floor;
    g.fillRect(0, WORLD_H - 90, WORLD_W, 90);
    this.bg = bg;
  }

  render() {
    this.applyComfort();
    const ctx = this.ctx;
    const k = this.scale * this.dpr;
    const now = this.visualTime;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.bg?.width) ctx.drawImage(this.bg, 0, 0);

    const sx = this.shake ? rand(-this.shake, this.shake) : 0;
    const sy = this.shake ? rand(-this.shake, this.shake) : 0;
    ctx.setTransform(k, 0, 0, k, sx * k, sy * k);

    if (this.fever) {
      ctx.fillStyle = `rgba(255, 190, 80, ${this.effects.reduced ? 0.07 : 0.07 + 0.04 * Math.sin(now * 8)})`;
      ctx.fillRect(-20, -20, WORLD_W + 40, WORLD_H + 40);
    }
    this.drawDangerLine(ctx);
    if (!this.over && !this.clawMode && !this.settling) this.drawAim(ctx);
    for (const crab of this.world.bodies) this.drawCrab(ctx, crab);
    if (this.debug) this.drawHitboxes(ctx);
    this.drawRings(ctx);
    this.drawParticles(ctx);
    this.drawTexts(ctx);
    this.drawFeverBar(ctx, now);
    if (this.danger > 0 && !this.over) this.drawCountdown(ctx, now);
    if (this.clawMode) this.drawClawHint(ctx, now);
    if (this.card) this.drawCard(ctx, now);

    if (this.over) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'rgba(10, 12, 24, 0.55)';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  // `size` scales the sprite; the pixel cache is rebuilt at that size so it stays crisp.
  drawSprite(ctx, level, x, y, { angle = 0, size = 1, sx = 1, sy = 1, blink = false, frame = 0 } = {}) {
    const cell = (defOf(level).width / BODY_COLS) * size;
    const sprite = getSprite(level, cell * this.scale * this.dpr, {
      blink,
      frame: level === RAINBOW ? frame : 0,
    });
    ctx.save();
    ctx.translate(x, y);
    if (angle) ctx.rotate(angle);
    if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);
    ctx.drawImage(
      sprite.canvas,
      (sprite.minX - ANCHOR_X) * cell,
      (sprite.minY - ANCHOR_Y) * cell,
      sprite.cols * cell,
      sprite.rows * cell,
    );
    ctx.restore();
  }

  rainbowFrame() {
    return this.effects.reduced ? 0 : Math.floor(this.visualTime / 0.09) % RAINBOW_FRAMES;
  }

  drawCrab(ctx, crab) {
    if (this.time > crab.blinkAt + 0.15) crab.blinkAt = this.time + rand(2, 6);
    const blink = !this.effects.reduced && this.time >= crab.blinkAt;
    const age = this.time - crab.born;
    const pop = !this.effects.reduced && crab.pop && age < 0.25 ? 0.55 + 0.45 * easeOutBack(age / 0.25) : 1;
    const s = this.effects.reduced ? 0 : crab.squash;
    this.drawSprite(ctx, crab.level, crab.x, crab.y, {
      angle: crab.angle,
      sx: pop * (1 + s * 0.7),
      sy: pop * (1 - s),
      blink,
      frame: crab.level === RAINBOW ? this.rainbowFrame() : 0,
    });
  }

  drawHitboxes(ctx) {
    ctx.save();
    ctx.lineWidth = 1;
    for (const b of this.world.bodies) {
      ctx.strokeStyle = b.sleeping ? 'rgba(120, 200, 255, 0.8)' : 'rgba(120, 255, 140, 0.9)';
      for (const s of b.shapes) {
        ctx.beginPath();
        ctx.arc(b.x + s.ox, b.y + s.oy, s.r, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawAim(ctx) {
    const t = 1 - this.cooldown / DROP_COOLDOWN;
    if (t < 0.5) return;
    const level = this.current;
    const x = this.clampAim(this.aimX, level);

    ctx.save();
    ctx.strokeStyle = level === RAINBOW ? 'rgba(255, 255, 255, 0.3)' : 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 7]);
    ctx.beginPath();
    ctx.moveTo(x, DROP_Y + extentOf(level).halfH + 4);
    ctx.lineTo(x, WORLD_H);
    ctx.stroke();
    ctx.restore();

    const bob = this.effects.reduced ? 0 : Math.sin(this.visualTime / 0.25) * 1.5;
    const s = this.effects.reduced ? 1 : 0.6 + 0.4 * easeOutBack((t - 0.5) / 0.5);
    this.drawSprite(ctx, level, x, DROP_Y + bob, { sx: s, sy: s, frame: this.rainbowFrame() });
  }

  drawDangerLine(ctx) {
    let color = 'rgba(217, 119, 87, 0.3)';
    if (this.warning === 1) color = 'rgba(255, 130, 100, 0.65)';
    if (this.warning === 2) {
      const on = this.effects.reduced || Math.sin(this.visualTime / 0.07) > 0;
      color = `rgba(255, 72, 72, ${on ? 0.95 : 0.35})`;
    }
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.moveTo(0, LINE_Y);
    ctx.lineTo(WORLD_W, LINE_Y);
    ctx.stroke();
    if (this.danger > 0) {
      ctx.fillStyle = 'rgba(255, 72, 72, 0.85)';
      ctx.fillRect(0, LINE_Y - 2, WORLD_W * Math.min(1, this.danger / RULES.gameOverTime), 4);
    }
    ctx.restore();
  }

  // Seconds left before game over, drawn on top of everything so it's never hidden.
  drawCountdown(ctx, now) {
    const left = Math.max(0, RULES.gameOverTime - this.danger);
    const pulse = this.effects.reduced ? 1 : 1 + 0.08 * Math.sin(now * 14);
    ctx.save();
    ctx.translate(WORLD_W / 2, LINE_Y + 26);
    ctx.scale(pulse, pulse);
    ctx.globalAlpha = Math.min(1, this.danger * 4);
    ctx.font = `900 24px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(20, 18, 34, 0.9)';
    const text = `危险 ${left.toFixed(1)}`;
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = '#FF6B6B';
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  drawFeverBar(ctx, now) {
    const h = 5;
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.fillRect(0, 0, WORLD_W, h);
    if (this.fever) {
      const on = this.effects.reduced || Math.sin(now * 12) > 0;
      ctx.fillStyle = on ? '#FFD84D' : '#FF9F43';
      ctx.fillRect(0, 0, (WORLD_W * this.feverTime) / FEVER_TIME, h);
      ctx.font = `900 13px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = '#FFD84D';
      ctx.fillText(`狂热 ×2  ${this.feverTime.toFixed(1)}s`, WORLD_W - 8, 20);
    } else {
      ctx.fillStyle = '#D97757';
      ctx.fillRect(0, 0, (WORLD_W * this.feverMeter) / FEVER_MAX, h);
    }
    ctx.restore();
  }

  drawRings(ctx) {
    ctx.save();
    for (const r of this.rings) {
      const t = 1 - r.life / r.max;
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 6 * (1 - t) + 1;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * easeOut(t), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawParticles(ctx) {
    for (const p of this.particles) {
      ctx.globalAlpha = Math.min(1, (p.life / p.max) * 1.5);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  drawTexts(ctx) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const t of this.texts) {
      ctx.globalAlpha = Math.min(1, (t.life / t.max) * 2);
      ctx.font = `900 ${t.size}px ${FONT}`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(20, 18, 34, 0.85)';
      ctx.strokeText(t.text, t.x, t.y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.restore();
  }

  drawClawHint(ctx, now) {
    ctx.save();
    ctx.fillStyle = 'rgba(10, 12, 24, 0.25)';
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    ctx.textAlign = 'center';
    ctx.font = `800 17px ${FONT}`;
    ctx.fillStyle = `rgba(143, 227, 255, ${this.effects.reduced ? 1 : 0.75 + 0.25 * Math.sin(now * 6)})`;
    ctx.fillText('点一只 Clawd 把它夹走', WORLD_W / 2, 60);
    ctx.restore();
  }

  // "New Clawd unlocked" card: rays + the Clawd popping in, then fading out.
  drawCard(ctx, now) {
    const { level, t, dur } = this.card;
    const alpha = Math.min(1, t / 0.2, (dur - t) / 0.35);
    const cy = WORLD_H / 2 - 30;
    const def = defOf(level);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(10, 12, 24, 0.78)';
    ctx.fillRect(0, cy - 110, WORLD_W, 220);

    ctx.save();
    ctx.translate(WORLD_W / 2, cy - 10);
    ctx.rotate(this.effects.reduced ? 0 : now * 0.8);
    ctx.fillStyle = 'rgba(255, 216, 77, 0.12)';
    for (let i = 0; !this.effects.reduced && i < 12; i++) {
      ctx.rotate((Math.PI * 2) / 12);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-14, -120);
      ctx.lineTo(14, -120);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    const size = (Math.min(110, def.width * 1.6) / def.width) * (this.effects.reduced ? 1 : 0.4 + 0.6 * easeOutBack(Math.min(1, t / 0.4)));
    this.drawSprite(ctx, level, WORLD_W / 2, cy - 10, { size, frame: this.rainbowFrame() });

    ctx.textAlign = 'center';
    ctx.font = `900 15px ${FONT}`;
    ctx.fillStyle = '#FFD84D';
    ctx.fillText(level === RAINBOW ? '稀有 Clawd 出现!' : '新 Clawd 解锁!', WORLD_W / 2, cy - 82);
    ctx.font = `900 22px ${FONT}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(def.name, WORLD_W / 2, cy + 72);
    ctx.font = `13px ${FONT}`;
    ctx.fillStyle = '#B9B2CC';
    const sub = level === RAINBOW ? '万能! 碰到谁, 谁就升一级' : `第 ${level} 级 / 共 ${MAX_LEVEL} 级`;
    ctx.fillText(sub, WORLD_W / 2, cy + 96);
    ctx.restore();
  }
}
