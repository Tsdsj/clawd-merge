// Tiny 2D rigid-body engine tailored for this game.
// Bodies are compounds of circles (a Clawd = rounded box + circles for its props),
// which gives believable rolling/tumbling while keeping collision math trivial.
// Solver: sequential impulses with warm starting + a separate position-correction
// pass (no velocity bias), so deep overlaps after a merge resolve without explosions.
// Island sleeping (like Box2D): bodies connected by contacts form an island; an
// island sleeps only when all its bodies are still, and wakes as a whole when any
// member is touched by something awake. Sleeping bodies act as static.

export const config = {
  velocityIters: 12,
  positionIters: 3,
  slop: 0.8, // allowed penetration (world units)
  margin: 1.5, // speculative contact distance
  correction: 0.25, // fraction of penetration fixed per position iteration
  maxCorrection: 4, // per position iteration, keeps merge overlaps gentle
  maxSpeed: 1400,
  restitutionThreshold: 80,
  linearDamping: 0.05,
  angularDamping: 1.2,
  // A body counts as still once it stays within sleepDrift units / sleepTurn
  // radians of where it was for sleepDelay seconds. Measured on displacement
  // rather than velocity because resting contacts buzz by ~one step of gravity.
  sleepDrift: 1,
  sleepTurn: 0.03,
  sleepDelay: 0.6,
};

let nextId = 1;

export class Body {
  constructor({ x, y, angle = 0, shapes, mass, inertia, friction = 0.4, restitution = 0.1 }) {
    this.id = nextId++;
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.vx = 0;
    this.vy = 0;
    this.w = 0;
    this.invMass = 1 / mass;
    this.invI = 1 / inertia;
    // Effective inverse mass/inertia used by the solver (0 while asleep).
    this.im = this.invMass;
    this.ii = this.invI;
    this.sleeping = false;
    this.stillTime = 0;
    this.restX = x;
    this.restY = y;
    this.restAngle = angle;
    this.friction = friction;
    this.restitution = restitution;
    this.shapes = shapes.map((s) => ({ lx: s.x, ly: s.y, r: s.r, ox: 0, oy: 0 }));
    this.bound = Math.max(...this.shapes.map((s) => Math.hypot(s.lx, s.ly) + s.r));
    this.updateTransform();
  }

  sleep() {
    this.sleeping = true;
    this.vx = 0;
    this.vy = 0;
    this.w = 0;
    this.im = 0;
    this.ii = 0;
  }

  wake() {
    if (!this.sleeping) return;
    this.sleeping = false;
    this.stillTime = 0;
    this.im = this.invMass;
    this.ii = this.invI;
  }

  updateTransform() {
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    for (const sh of this.shapes) {
      sh.ox = sh.lx * c - sh.ly * s;
      sh.oy = sh.lx * s + sh.ly * c;
    }
  }
}

// Indices of `body`'s shapes that come within reach of `other`'s bounding circle.
function nearShapes(body, other, out) {
  out.length = 0;
  for (let i = 0; i < body.shapes.length; i++) {
    const s = body.shapes[i];
    const r = s.r + other.bound + config.margin;
    if ((body.x + s.ox - other.x) ** 2 + (body.y + s.oy - other.y) ** 2 <= r * r) out.push(i);
  }
  return out;
}

// Wall contacts use a static pseudo-body; `ia` encodes which wall.
const LEFT = -1;
const RIGHT = -2;
const FLOOR = -3;

export class World {
  constructor({ width, height, gravity }) {
    this.width = width;
    this.height = height;
    this.gravity = gravity;
    this.bodies = [];
    this.contacts = [];
    this.cache = new Map();
    this._nearB = [];
    this.wall = { id: 0, x: 0, y: 0, vx: 0, vy: 0, w: 0, im: 0, ii: 0, friction: 0.5, restitution: 0.1 };
  }

  add(body) {
    this.bodies.push(body);
    return body;
  }

  remove(body) {
    const i = this.bodies.indexOf(body);
    if (i >= 0) this.bodies.splice(i, 1);
  }

  // Wake everything that could have been resting on/against a body at (x, y).
  wakeNear(x, y, radius) {
    for (const b of this.bodies) {
      const r = radius + b.bound;
      if ((b.x - x) ** 2 + (b.y - y) ** 2 < r * r) b.wake();
    }
  }

  clear() {
    this.bodies.length = 0;
    this.contacts.length = 0;
    this.cache.clear();
  }

  step(dt) {
    const linDamp = 1 / (1 + dt * config.linearDamping);
    const angDamp = 1 / (1 + dt * config.angularDamping);
    for (const b of this.bodies) {
      if (b.sleeping) continue;
      b.vy += this.gravity * dt;
      b.vx *= linDamp;
      b.vy *= linDamp;
      b.w *= angDamp;
    }

    this.collide();
    const contacts = this.contacts;
    for (const c of contacts) this.prestep(c, dt);
    for (let i = 0; i < config.velocityIters; i++) {
      for (const c of contacts) this.solve(c);
    }

    for (const b of this.bodies) {
      if (b.sleeping) continue;
      const speed = Math.hypot(b.vx, b.vy);
      if (speed > config.maxSpeed) {
        b.vx *= config.maxSpeed / speed;
        b.vy *= config.maxSpeed / speed;
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.angle += b.w * dt;
      b.updateTransform();

      const drift = Math.hypot(b.x - b.restX, b.y - b.restY);
      if (drift < config.sleepDrift && Math.abs(b.angle - b.restAngle) < config.sleepTurn) {
        b.stillTime += dt;
      } else {
        b.stillTime = 0;
        b.restX = b.x;
        b.restY = b.y;
        b.restAngle = b.angle;
      }
    }

    for (let i = 0; i < config.positionIters; i++) {
      for (const c of contacts) this.correct(c);
    }
    this.keepInside();

    this.cache.clear();
    for (const c of contacts) this.cache.set(c.key, c);
    this.updateSleep();
  }

  // Safety net: never let a squeezed body get pushed through the walls/floor.
  keepInside() {
    for (const b of this.bodies) {
      if (b.sleeping) continue;
      let minX = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const s of b.shapes) {
        minX = Math.min(minX, b.x + s.ox - s.r);
        maxX = Math.max(maxX, b.x + s.ox + s.r);
        maxY = Math.max(maxY, b.y + s.oy + s.r);
      }
      // Only real escapes: normal resting contact is allowed `slop` penetration.
      const lim = config.slop * 2;
      if (minX < -lim) b.x -= minX + lim;
      else if (maxX > this.width + lim) b.x -= maxX - this.width - lim;
      if (maxY > this.height + lim) b.y -= maxY - this.height - lim;
    }
  }

  updateSleep() {
    const bodies = this.bodies;
    const parent = bodies.map((_, i) => i);
    const find = (i) => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
    bodies.forEach((b, i) => (b._island = i));
    for (const c of this.contacts) {
      if (c.ia < 0) continue; // walls don't connect islands
      parent[find(c.a._island)] = find(c.b._island);
    }

    const islands = new Map();
    bodies.forEach((b, i) => {
      const root = find(i);
      let island = islands.get(root);
      if (!island) islands.set(root, (island = { bodies: [], sleeping: false, still: true }));
      island.bodies.push(b);
      if (b.sleeping) island.sleeping = true;
      else if (b.stillTime < config.sleepDelay) island.still = false;
    });

    for (const island of islands.values()) {
      if (island.sleeping && !island.still) {
        // Something awake is touching a sleeper: wake the whole island.
        for (const b of island.bodies) b.wake();
      } else if (!island.sleeping && island.still) {
        for (const b of island.bodies) b.sleep();
      } else if (island.sleeping && island.still) {
        // Still bodies that came to rest on a sleeping island just join it.
        for (const b of island.bodies) if (!b.sleeping) b.sleep();
      }
    }
  }

  collide() {
    const out = [];
    const bodies = this.bodies;
    const W = this.width;
    const H = this.height;

    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const reach = a.bound + b.bound + config.margin;
        if (dx * dx + dy * dy > reach * reach) continue;
        if (a.sleeping && b.sleeping) continue;
        // Something moving touches a sleeper: wake it now, before solving, so it
        // doesn't act as an immovable wall this step (updateSleep then wakes the rest
        // of its island).
        if (a.sleeping && b.stillTime < config.sleepDelay) a.wake();
        else if (b.sleeping && a.stillTime < config.sleepDelay) b.wake();

        // Only shapes that can reach the other body's bounding circle take part.
        const nearB = nearShapes(b, a, this._nearB);
        for (let ia = 0; ia < a.shapes.length; ia++) {
          const sa = a.shapes[ia];
          const ax = a.x + sa.ox;
          const ay = a.y + sa.oy;
          const ra = sa.r + b.bound + config.margin;
          if ((ax - b.x) ** 2 + (ay - b.y) ** 2 > ra * ra) continue;
          for (const ib of nearB) {
            const sb = b.shapes[ib];
            const ddx = b.x + sb.ox - ax;
            const ddy = b.y + sb.oy - ay;
            const rs = sa.r + sb.r;
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 > (rs + config.margin) * (rs + config.margin)) continue;
            const d = Math.sqrt(d2);
            const nx = d > 1e-6 ? ddx / d : 0;
            const ny = d > 1e-6 ? ddy / d : 1;
            const pen = rs - d;
            const k = sa.r - pen / 2;
            out.push(this.contact(a, b, ia, ib, nx, ny, pen, ax + nx * k, ay + ny * k));
          }
        }
      }

      if (a.sleeping) continue;
      for (let ib = 0; ib < a.shapes.length; ib++) {
        const s = a.shapes[ib];
        const x = a.x + s.ox;
        const y = a.y + s.oy;
        if (x - s.r < config.margin) out.push(this.contact(this.wall, a, LEFT, ib, 1, 0, s.r - x, x - s.r, y));
        if (x + s.r > W - config.margin) out.push(this.contact(this.wall, a, RIGHT, ib, -1, 0, x + s.r - W, x + s.r, y));
        if (y + s.r > H - config.margin) out.push(this.contact(this.wall, a, FLOOR, ib, 0, -1, y + s.r - H, x, y + s.r));
      }
    }
    this.contacts = out;
  }

  contact(a, b, ia, ib, nx, ny, pen, px, py) {
    return { a, b, ia, ib, nx, ny, pen, px, py, key: `${a.id}|${b.id}|${ia}|${ib}`, Pn: 0, Pt: 0 };
  }

  prestep(c, dt) {
    const { a, b, nx, ny } = c;
    c.rax = c.px - a.x;
    c.ray = c.py - a.y;
    c.rbx = c.px - b.x;
    c.rby = c.py - b.y;

    const rnA = c.rax * ny - c.ray * nx;
    const rnB = c.rbx * ny - c.rby * nx;
    const kN = a.im + b.im + a.ii * rnA * rnA + b.ii * rnB * rnB;
    c.massN = kN > 0 ? 1 / kN : 0;

    const tx = -ny;
    const ty = nx;
    const rtA = c.rax * ty - c.ray * tx;
    const rtB = c.rbx * ty - c.rby * tx;
    const kT = a.im + b.im + a.ii * rtA * rtA + b.ii * rtB * rtB;
    c.massT = kT > 0 ? 1 / kT : 0;
    c.friction = Math.sqrt(a.friction * b.friction);

    const vn = this.relNormal(c);
    if (c.pen < 0) {
      // Speculative: allow closing the gap this step, but no more.
      c.target = c.pen / dt;
    } else {
      c.target = vn < -config.restitutionThreshold ? -Math.max(a.restitution, b.restitution) * vn : 0;
    }

    const old = this.cache.get(c.key);
    if (old) {
      c.Pn = old.Pn;
      c.Pt = old.Pt;
      this.apply(c, c.Pn * nx + c.Pt * tx, c.Pn * ny + c.Pt * ty);
    }
  }

  relVel(c) {
    const { a, b } = c;
    this._dvx = b.vx - b.w * c.rby - (a.vx - a.w * c.ray);
    this._dvy = b.vy + b.w * c.rbx - (a.vy + a.w * c.rax);
  }

  relNormal(c) {
    this.relVel(c);
    return this._dvx * c.nx + this._dvy * c.ny;
  }

  apply(c, px, py) {
    const { a, b } = c;
    a.vx -= a.im * px;
    a.vy -= a.im * py;
    a.w -= a.ii * (c.rax * py - c.ray * px);
    b.vx += b.im * px;
    b.vy += b.im * py;
    b.w += b.ii * (c.rbx * py - c.rby * px);
  }

  solve(c) {
    const { nx, ny } = c;
    const tx = -ny;
    const ty = nx;

    this.relVel(c);
    const vt = this._dvx * tx + this._dvy * ty;
    const maxPt = c.friction * c.Pn;
    const newPt = Math.max(-maxPt, Math.min(maxPt, c.Pt - c.massT * vt));
    const dPt = newPt - c.Pt;
    c.Pt = newPt;
    this.apply(c, dPt * tx, dPt * ty);

    const vn = this.relNormal(c);
    const newPn = Math.max(0, c.Pn + c.massN * (c.target - vn));
    const dPn = newPn - c.Pn;
    c.Pn = newPn;
    this.apply(c, dPn * nx, dPn * ny);
  }

  correct(c) {
    const { a, b } = c;
    const sb = b.shapes[c.ib];
    const bx = b.x + sb.ox;
    const by = b.y + sb.oy;
    let nx;
    let ny;
    let pen;

    if (c.ia === LEFT) {
      nx = 1; ny = 0; pen = sb.r - bx;
    } else if (c.ia === RIGHT) {
      nx = -1; ny = 0; pen = bx + sb.r - this.width;
    } else if (c.ia === FLOOR) {
      nx = 0; ny = -1; pen = by + sb.r - this.height;
    } else {
      const sa = a.shapes[c.ia];
      const dx = bx - (a.x + sa.ox);
      const dy = by - (a.y + sa.oy);
      const d = Math.hypot(dx, dy);
      if (d < 1e-6) return;
      nx = dx / d;
      ny = dy / d;
      pen = sa.r + sb.r - d;
    }
    if (pen <= config.slop) return;

    const total = a.im + b.im;
    if (total === 0) return;
    const corr = Math.min((pen - config.slop) * config.correction, config.maxCorrection) / total;
    a.x -= nx * corr * a.im;
    a.y -= ny * corr * a.im;
    b.x += nx * corr * b.im;
    b.y += ny * corr * b.im;
  }
}
