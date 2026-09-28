import { World, Body } from './physics.js';
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
const DROP_COOLDOWN = 0.5;
// Gameplay rules (exported so balance can be tuned/tested in one place).
// Balance was tuned with simulated players (always-same-spot spammer vs. a
// lookahead player): exponential points make high-level merges — which need
// planning — worth far more than lucky low-level cascades.
export const RULES = {
  dangerGrace: 1.2, // a freshly spawned Clawd doesn't count toward game over yet
  gameOverTime: 2.5, // seconds above the line before game over
  spawnWeights: [22, 22, 22, 18, 16], // only the 5 smallest Clawds are ever dropped
  points: (k) => 2 ** k, // merging a pair of level-k Clawds
  comboStep: 0.25, // each chained merge adds +25%…
  maxComboMult: 2, // …up to ×2
};
const COMBO_WINDOW = 1.2; // merges closer than this chain into a combo
const FEVER_MAX = 180; // meter needed for fever
const FEVER_TIME = 8;
const RAINBOW_CHANCE = 0.035;
const RAINBOW_MIN_DROPS = 15;
const CLAW_LEVEL = 7; // first time per game you create each level ≥ this, you earn a claw
const MAX_CLAWS = 3;
const KING_BONUS = 2000;
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
const buzz = (pattern) => {
  if (hapticsReady && navigator.vibrate) navigator.vibrate(pattern);
};

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
    return new Set([1, ...JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')]);
  } catch {
    return new Set([1]);
  }
}

export class Game {
  constructor(canvas, events = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.events = events;
    this.world = new World({ width: WORLD_W, height: WORLD_H, gravity: 1800 });
    this.scale = 1;
    this.dpr = 1;
    this.debug = false;
    this.best = Number(localStorage.getItem(BEST_KEY)) || 0;
    this.seen = loadSeen();
    this.reset();
  }

  reset() {
    this.world.clear();
    this.score = 0;
    this.bestAtStart = this.best;
    this.recordShown = false;
    this.time = 0;
    this.acc = 0;
    this.drops = 0;
    this.maxLevel = 1;
    this.current = 1;
    this.next = this.randomLevel();
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

  // Early on only the tiniest Clawds drop; bigger ones unlock as you progress.
  randomLevel() {
    if (
      this.drops >= RAINBOW_MIN_DROPS &&
      this.current !== RAINBOW &&
      Math.random() < RAINBOW_CHANCE
    ) {
      return RAINBOW;
    }
    const cap = clamp(this.maxLevel, 3, RULES.spawnWeights.length);
    const weights = RULES.spawnWeights.slice(0, cap);
    let r = Math.random() * weights.reduce((s, w) => s + w, 0);
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i + 1;
    }
    return 1;
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
    this.aimX = clamp(x, 0, WORLD_W);
  }

  clampAim(x, level) {
    const { left, right } = extentOf(level);
    return clamp(x, left + 1, WORLD_W - right - 1);
  }

  // Taps during the cooldown are queued so fast players don't lose inputs.
  requestDrop() {
    if (this.over || this.clawMode) return;
    if (this.cooldown > 0) this.pendingDrop = true;
    else this.drop();
  }

  drop() {
    const level = this.current;
    const crab = this.spawnCrab(level, this.clampAim(this.aimX, level), DROP_Y);
    crab.vy = 120;
    this.drops++;
    this.current = this.next;
    this.next = this.randomLevel();
    this.cooldown = DROP_COOLDOWN;
    this.pendingDrop = false;
    sfx.drop();
    if (level === RAINBOW && !this.seen.has(RAINBOW)) this.discover(RAINBOW);
    this.events.onNext?.(this.next);
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

  update(dt) {
    dt = Math.min(dt, 0.1);
    this.updateEffects(dt);
    if (this.over) return;

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
      this.shake = 12;
      this.floatText('Clawd 之王!', WORLD_W / 2, WORLD_H / 2 - 40, 30, '#F7C948', 2);
      sfx.jackpot();
      buzz(80);
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
    if (nl >= 7) this.shake = Math.max(this.shake, 2 + (nl - 7) * 1.5);

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
    if (nl >= 6) buzz(nl >= 9 ? 40 : 15);
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
      buzz([20, 40, 20]);
      this.events.onFever?.(true);
    }
  }

  addScore(points, x, y) {
    this.score += points;
    if (this.score > this.best) {
      this.best = this.score;
      localStorage.setItem(BEST_KEY, String(this.best));
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
    localStorage.setItem(SEEN_KEY, JSON.stringify([...this.seen]));
    this.card = { level, t: 0, dur: 2.2 };
    sfx.discover();
    this.events.onDiscover?.(this.seen);
  }

  // ---------- claw power-up ----------

  toggleClaw() {
    if (this.over || (this.claws === 0 && !this.clawMode)) return;
    this.clawMode = !this.clawMode;
    this.events.onClaws?.(this.claws, this.clawMode);
  }

  // Removes the Clawd under (x, y). Returns false if nothing was hit.
  useClawAt(x, y) {
    if (!this.clawMode) return false;
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
    this.clawMode = false;
    sfx.claw();
    buzz(25);
    this.events.onClaws?.(this.claws, this.clawMode);
    return true;
  }

  checkDanger(dt) {
    let above = false;
    let near = false;
    for (const b of this.world.bodies) {
      if (this.time - b.born < RULES.dangerGrace) continue;
      let top = Infinity;
      for (const s of b.shapes) top = Math.min(top, b.y + s.oy - s.r);
      if (top < LINE_Y) above = true;
      else if (top < LINE_Y + 50) near = true;
    }
    this.warning = above ? 2 : near ? 1 : 0;
    this.danger = above ? this.danger + dt : Math.max(0, this.danger - dt * 2);
    if (this.danger >= RULES.gameOverTime) this.gameOver();
  }

  gameOver() {
    this.over = true;
    this.warning = 0;
    this.clawMode = false;
    if (this.feverTime > 0) {
      this.feverTime = 0;
      this.events.onFever?.(false);
    }
    sfx.over();
    buzz([40, 60, 40]);
    this.events.onGameOver?.({
      score: this.score,
      best: this.best,
      maxLevel: this.maxLevel,
      isNewBest: this.score > this.bestAtStart && this.score > 0,
    });
  }

  // ---------- effects ----------

  burst(x, y, count, colors) {
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
    this.rings.push({ x, y, r0, r1, color, life: 0.45, max: 0.45 });
  }

  floatText(text, x, y, size, color, life = 1) {
    this.texts.push({ text, x: clamp(x, 60, WORLD_W - 60), y, size, color, life, max: life });
  }

  updateEffects(dt) {
    for (const p of this.particles) {
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const t of this.texts) {
      t.y -= 40 * dt;
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
    const ctx = this.ctx;
    const k = this.scale * this.dpr;
    const now = performance.now() / 1000;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.bg?.width) ctx.drawImage(this.bg, 0, 0);

    const sx = this.shake ? rand(-this.shake, this.shake) : 0;
    const sy = this.shake ? rand(-this.shake, this.shake) : 0;
    ctx.setTransform(k, 0, 0, k, sx * k, sy * k);

    if (this.fever) {
      ctx.fillStyle = `rgba(255, 190, 80, ${0.07 + 0.04 * Math.sin(now * 8)})`;
      ctx.fillRect(-20, -20, WORLD_W + 40, WORLD_H + 40);
    }
    this.drawDangerLine(ctx);
    if (!this.over && !this.clawMode) this.drawAim(ctx);
    for (const crab of this.world.bodies) this.drawCrab(ctx, crab);
    if (this.debug) this.drawHitboxes(ctx);
    this.drawRings(ctx);
    this.drawParticles(ctx);
    this.drawTexts(ctx);
    this.drawFeverBar(ctx, now);
    if (this.clawMode) this.drawClawHint(ctx, now);
    if (this.drops === 0 && !this.over) this.drawHint(ctx, now);
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
    return Math.floor(performance.now() / 90) % RAINBOW_FRAMES;
  }

  drawCrab(ctx, crab) {
    if (this.time > crab.blinkAt + 0.15) crab.blinkAt = this.time + rand(2, 6);
    const blink = this.time >= crab.blinkAt;
    const age = this.time - crab.born;
    const pop = crab.pop && age < 0.25 ? 0.55 + 0.45 * easeOutBack(age / 0.25) : 1;
    const s = crab.squash;
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

    const bob = Math.sin(performance.now() / 250) * 1.5;
    const s = 0.6 + 0.4 * easeOutBack((t - 0.5) / 0.5);
    this.drawSprite(ctx, level, x, DROP_Y + bob, { sx: s, sy: s, frame: this.rainbowFrame() });
  }

  drawDangerLine(ctx) {
    let color = 'rgba(217, 119, 87, 0.3)';
    if (this.warning === 1) color = 'rgba(255, 130, 100, 0.65)';
    if (this.warning === 2) {
      const on = Math.sin(performance.now() / 70) > 0;
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

  drawFeverBar(ctx, now) {
    const h = 5;
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.fillRect(0, 0, WORLD_W, h);
    if (this.fever) {
      const on = Math.sin(now * 12) > 0;
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
    ctx.fillStyle = `rgba(143, 227, 255, ${0.75 + 0.25 * Math.sin(now * 6)})`;
    ctx.fillText('点一只 Clawd 把它夹走', WORLD_W / 2, 60);
    ctx.restore();
  }

  drawHint(ctx, now) {
    const a = 0.6 + 0.25 * Math.sin(now * 3.3);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = `rgba(243, 233, 226, ${a})`;
    ctx.font = `700 18px ${FONT}`;
    ctx.fillText('点击或拖动来投放小Clawd', WORLD_W / 2, 320);
    ctx.font = `14px ${FONT}`;
    ctx.fillStyle = `rgba(157, 151, 176, ${a})`;
    ctx.fillText('相同的 Clawd 碰到一起会合成升级', WORLD_W / 2, 348);
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
    ctx.rotate(now * 0.8);
    ctx.fillStyle = 'rgba(255, 216, 77, 0.12)';
    for (let i = 0; i < 12; i++) {
      ctx.rotate((Math.PI * 2) / 12);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-14, -120);
      ctx.lineTo(14, -120);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    const size = (Math.min(110, def.width * 1.6) / def.width) * (0.4 + 0.6 * easeOutBack(Math.min(1, t / 0.4)));
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
