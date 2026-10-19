// Moto Rush — game core: bikes, levels, terrain generation and physics.
// No DOM access here, so the same file runs in the browser and in Node tests.
(function (global) {
  'use strict';

  const DT = 1 / 120;
  const GRAVITY = 1500;
  const WHEEL_R = 20;
  const WHEELBASE = 74;
  const HEAD_LOCAL = { x: 36, y: -74 };
  const HEAD_R = 12;
  const TAU = Math.PI * 2;

  const BIKES = [
    { id: 'scout', name: 'Скаут', price: 0, color: '#e63946', accent: '#ffd166', rider: '#264653',
      power: 1150, maxSpeed: 720, air: 17, ground: 11, maxOmega: 6.5,
      desc: 'Надёжный старт для новичка' },
    { id: 'ranger', name: 'Рейнджер', price: 400, color: '#2a9d8f', accent: '#e9c46a', rider: '#3d405b',
      power: 1350, maxSpeed: 810, air: 19, ground: 12, maxOmega: 7.2,
      desc: 'Быстрее и послушнее в воздухе' },
    { id: 'storm', name: 'Шторм', price: 1200, color: '#3a86ff', accent: '#ffffff', rider: '#1d3557',
      power: 1600, maxSpeed: 900, air: 21, ground: 13, maxOmega: 8.2,
      desc: 'Мощный разгон для длинных прыжков' },
    { id: 'phantom', name: 'Фантом', price: 2500, color: '#2b2d42', accent: '#ff006e', rider: '#111111',
      power: 1850, maxSpeed: 990, air: 24, ground: 14, maxOmega: 9.2,
      desc: 'Создан для сальто' },
    { id: 'dragon', name: 'Дракон', price: 4500, color: '#ff9f1c', accent: '#d00000', rider: '#370617',
      power: 2100, maxSpeed: 1080, air: 26, ground: 15, maxOmega: 10,
      desc: 'Легенда трассы' },
  ];

  const THEMES = {
    meadow: { skyTop: '#5fb3f9', skyBottom: '#c9ecff', far: '#8fb8d8', near: '#6bab5c', ground: '#7a4e2d', top: '#4caf50', sun: '#fff4b0' },
    desert: { skyTop: '#f6a35c', skyBottom: '#ffe0a8', far: '#e8b77d', near: '#d9984f', ground: '#c98b4a', top: '#f2c46d', sun: '#fff7d6' },
    canyon: { skyTop: '#ff7b54', skyBottom: '#ffd4a3', far: '#c8553d', near: '#a63d2a', ground: '#7f2f1f', top: '#d9663b', sun: '#ffe9b0' },
    night:  { skyTop: '#0b1026', skyBottom: '#2b3a67', far: '#232c52', near: '#1a2140', ground: '#2d2a3e', top: '#7b5cff', sun: '#e8ecff' },
    ice:    { skyTop: '#7fb2e5', skyBottom: '#eaf6ff', far: '#b8d4ec', near: '#d8e8f5', ground: '#6b8fb3', top: '#ffffff', sun: '#ffffff' },
    volcano:{ skyTop: '#1a0505', skyBottom: '#6b1d0e', far: '#3b0d0d', near: '#2a0a0a', ground: '#1f1414', top: '#ff4d00', sun: '#ff9a3c' },
  };

  const LEVELS = [
    { name: 'Зелёные холмы', theme: 'meadow', seed: 11, length: 9000, diff: 0.1,
      features: { hills: 4, bumps: 2, ramp: 2 } },
    { name: 'Песчаные дюны', theme: 'desert', seed: 27, length: 11000, diff: 0.25,
      features: { hills: 3, ramp: 3, bumps: 1, gap: 1, valley: 1 } },
    { name: 'Красный каньон', theme: 'canyon', seed: 43, length: 13000, diff: 0.4,
      features: { ramp: 2, gap: 3, steps: 2, valley: 1, hills: 1 } },
    { name: 'Ночная трасса', theme: 'night', seed: 58, length: 15000, diff: 0.55,
      features: { ramp: 3, gap: 3, bumps: 2, steps: 1, hills: 1 } },
    { name: 'Ледник', theme: 'ice', seed: 71, length: 17000, diff: 0.7,
      features: { gap: 3, valley: 2, ramp: 2, steps: 2, hills: 1 } },
    { name: 'Вулкан', theme: 'volcano', seed: 96, length: 20000, diff: 0.85,
      features: { gap: 4, ramp: 2, steps: 2, valley: 2, bumps: 1 } },
  ];

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pickWeighted(rng, weights) {
    const keys = Object.keys(weights);
    let total = 0;
    for (const k of keys) total += weights[k];
    let r = rng() * total;
    for (const k of keys) { r -= weights[k]; if (r <= 0) return k; }
    return keys[keys.length - 1];
  }

  // ---------- Level generation ----------

  function buildLevel(index) {
    const def = LEVELS[index];
    const rng = mulberry32(def.seed);
    const d = def.diff;
    const polys = [];
    const coins = [];
    let pts = [];
    let x = -700, y = 0;

    const add = (nx, ny) => { pts.push({ x: nx, y: ny }); x = nx; y = ny; };
    const curve = (len, fn, step) => {
      const x0 = x, y0 = y, n = Math.max(2, Math.ceil(len / (step || 18)));
      for (let i = 1; i <= n; i++) { const t = i / n; add(x0 + len * t, y0 + fn(t)); }
    };
    const coinRow = (x0, x1, lift, baseY) => {
      for (let cx = x0; cx <= x1; cx += 55) coins.push({ x: cx, lift: lift || 55, baseY });
    };
    const clampDrift = () => (y > 500 ? -1 : y < -500 ? 1 : (rng() - 0.5) * 2);

    pts.push({ x: -700, y: -900 });
    add(-700, 0);
    add(600, 0);

    const features = {
      hills() {
        const count = 1 + Math.floor(rng() * 3);
        for (let i = 0; i < count; i++) {
          const A = 30 + rng() * 70 * (0.6 + d);
          const W = 420 + rng() * 380;
          const drift = clampDrift() * 60;
          const sx = x;
          curve(W, (t) => -A * (1 - Math.cos(TAU * t)) / 2 + drift * t);
          if (rng() < 0.6) coinRow(sx + W * 0.3, sx + W * 0.7, 55 + A * 0.3);
        }
      },
      bumps() {
        const count = 4 + Math.floor(rng() * 5);
        const A = 10 + rng() * 14 * (0.5 + d);
        const W = 60 + rng() * 40;
        curve(W * count, (t) => -A * (1 - Math.cos(TAU * t * count)) / 2, 10);
      },
      ramp() {
        const h = 60 + d * 70 + rng() * 40;
        const up = h * 3;
        curve(up, (t) => -h * (0.4 * t + 0.6 * t * t));
        add(x + 30, y);
        coinRow(x + 80, x + 260, 110 + h * 0.4);
        const down = up * (1.6 + rng() * 0.6);
        const drop = h * (0.7 + rng() * 0.6);
        curve(down, (t) => drop * (t * t * (3 - 2 * t)));
      },
      gap() {
        add(x + 160, y);
        const h = 40 + rng() * 30;
        curve(260, (t) => -h * (0.5 * t + 0.5 * t * t));
        const lipX = x, lipY = y;
        add(lipX, lipY + 700);
        polys.push(pts);
        const width = 80 + d * 120 + rng() * 30;
        const landY = lipY + 30 + rng() * 70;
        pts = [];
        x = lipX + width; y = landY + 700;
        pts.push({ x, y });
        add(x, landY);
        coinRow(lipX + width * 0.2, lipX + width * 0.8, 0, lipY - 110);
        curve(260, (t) => 45 * t);
        add(x + 120, y);
      },
      steps() {
        const n = 3 + Math.floor(rng() * 3);
        for (let i = 0; i < n; i++) {
          add(x + 130 + rng() * 80, y);
          const drop = 25 + rng() * 25 * (0.5 + d);
          add(x + 2, y + drop);
        }
        add(x + 160, y);
      },
      valley() {
        const A = 90 + rng() * 100 * (0.5 + d);
        const W = 820 + rng() * 380;
        const sx = x;
        curve(W, (t) => A * (1 - Math.cos(TAU * t)) / 2);
        coinRow(sx + W * 0.35, sx + W * 0.65, 50);
      },
    };

    while (x < def.length) {
      features[pickWeighted(rng, def.features)]();
      const flat = 90 + rng() * 140;
      if (rng() < 0.4) coinRow(x + 20, x + flat - 20, 50);
      add(x + flat, y);
    }

    add(x + 300, y);
    const finishX = x;
    add(x + 1300, y);
    add(x, y - 900);
    polys.push(pts);

    const level = createTerrain(polys);
    level.def = def;
    level.index = index;
    level.finishX = finishX;
    level.startX = 0;
    level.par = Math.round(finishX / 470);
    level.coins = [];
    for (const c of coins) {
      const gy = c.baseY !== undefined ? c.baseY + c.lift : level.groundAt(c.x);
      if (gy !== null) level.coins.push({ x: c.x, y: gy - c.lift, taken: false });
    }
    return level;
  }

  function createTerrain(polys) {
    const CELL = 200;
    const segs = [];
    const grid = new Map();
    let minY = Infinity, maxY = -Infinity;
    for (const p of polys) {
      for (let i = 0; i < p.length - 1; i++) {
        const a = p[i], b = p[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len < 0.01) continue;
        const s = { ax: a.x, ay: a.y, bx: b.x, by: b.y, dx, dy, len2: dx * dx + dy * dy };
        segs.push(s);
        const c0 = Math.floor(Math.min(a.x, b.x) / CELL), c1 = Math.floor(Math.max(a.x, b.x) / CELL);
        for (let c = c0; c <= c1; c++) {
          if (!grid.has(c)) grid.set(c, []);
          grid.get(c).push(s);
        }
      }
      for (const pt of p) {
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY && pt.y < 1e5) maxY = pt.y;
      }
    }

    const query = (x0, x1, out) => {
      out.length = 0;
      const c0 = Math.floor(x0 / CELL), c1 = Math.floor(x1 / CELL);
      for (let c = c0; c <= c1; c++) {
        const list = grid.get(c);
        if (!list) continue;
        for (const s of list) if (out.indexOf(s) < 0) out.push(s);
      }
      return out;
    };

    const tmp = [];
    return {
      polys, segs, minY, maxY, query,
      // Highest surface point (smallest y) at x, or null over a gap.
      groundAt(x) {
        let best = null;
        for (const s of query(x, x, tmp)) {
          const lo = Math.min(s.ax, s.bx), hi = Math.max(s.ax, s.bx);
          if (x < lo || x > hi || s.dx === 0) continue;
          const yy = s.ay + ((x - s.ax) / s.dx) * s.dy;
          if (best === null || yy < best) best = yy;
        }
        return best;
      },
    };
  }

  // ---------- Physics ----------

  function particle(x, y, m) { return { x, y, px: x, py: y, m, im: 1 / m, ax: 0, ay: 0, g: false, nx: 0, ny: -1 }; }

  function constraint(a, b, k) { return { a, b, len: Math.hypot(a.x - b.x, a.y - b.y), k }; }

  function solve(c) {
    const dx = c.b.x - c.a.x, dy = c.b.y - c.a.y;
    const dist = Math.hypot(dx, dy) || 0.0001;
    const diff = ((dist - c.len) / dist / (c.a.im + c.b.im)) * c.k;
    c.a.x += dx * diff * c.a.im; c.a.y += dy * diff * c.a.im;
    c.b.x -= dx * diff * c.b.im; c.b.y -= dy * diff * c.b.im;
  }

  const segTmp = [];
  // Pushes a round particle out of the terrain. Returns deepest contact normal or null.
  function collide(p, r, terrain) {
    let hit = false;
    for (const s of terrain.query(p.x - r, p.x + r, segTmp)) {
      let t = ((p.x - s.ax) * s.dx + (p.y - s.ay) * s.dy) / s.len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = s.ax + s.dx * t, cy = s.ay + s.dy * t;
      const ex = p.x - cx, ey = p.y - cy;
      const d2 = ex * ex + ey * ey;
      if (d2 >= r * r) continue;
      const d = Math.sqrt(d2) || 0.0001;
      let nx = ex / d, ny = ey / d;
      // Particle centre crossed the surface line: push it back to the outer side.
      const cross = s.dx * ey - s.dy * ex;
      if (d < 0.5 || cross > 0 && t > 0 && t < 1) {
        const l = Math.sqrt(s.len2);
        nx = s.dy / l; ny = -s.dx / l;
        const pen = r - ((p.x - cx) * nx + (p.y - cy) * ny);
        p.x += nx * pen; p.y += ny * pen;
      } else {
        const pen = r - d;
        p.x += nx * pen; p.y += ny * pen;
      }
      if (!hit || ny < p.ny) { p.nx = nx; p.ny = ny; }
      hit = true;
    }
    return hit;
  }

  function distToTerrain(x, y, r, terrain) {
    let best = Infinity;
    for (const s of terrain.query(x - r, x + r, segTmp)) {
      let t = ((x - s.ax) * s.dx + (y - s.ay) * s.dy) / s.len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - (s.ax + s.dx * t), y - (s.ay + s.dy * t));
      if (d < best) best = d;
    }
    return best;
  }

  function angleDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    return d;
  }

  class Race {
    constructor(levelIndex, bikeIndex) {
      this.level = buildLevel(levelIndex);
      this.bike = BIKES[bikeIndex];
      const gy = this.level.groundAt(60);
      const rx = 60, ry = gy - WHEEL_R;
      this.rear = particle(rx, ry, 1);
      this.front = particle(rx + WHEELBASE, ry, 1);
      this.head = particle(rx + HEAD_LOCAL.x, ry + HEAD_LOCAL.y, 1.4);
      this.parts = [this.rear, this.front, this.head];
      this.cons = [
        constraint(this.rear, this.front, 1),
        constraint(this.rear, this.head, 0.6),
        constraint(this.front, this.head, 0.6),
      ];
      this.time = 0;
      this.steps = 0;
      this.angle = 0;
      this.spinR = 0; this.spinF = 0;
      this.crashed = false; this.finished = false; this.crashTime = 0; this.finishTime = 0;
      this.airSteps = 0; this.airRot = 0; this.airTime = 0;
      this.wheelie = 0;
      this.trickScore = 0;
      this.coinCount = 0;
      this.flips = 0;
      this.events = [];
      this.rider = null;
      this.lean = 0;
      this.speed = 0;
    }

    com() {
      let m = 0, x = 0, y = 0;
      for (const p of this.parts) { m += p.m; x += p.x * p.m; y += p.y * p.m; }
      return { x: x / m, y: y / m };
    }

    velocity() {
      const c = this.com();
      let m = 0, vx = 0, vy = 0;
      for (const p of this.parts) { m += p.m; vx += (p.x - p.px) * p.m; vy += (p.y - p.py) * p.m; }
      return { x: vx / m / DT, y: vy / m / DT, cx: c.x, cy: c.y };
    }

    angularVelocity(c) {
      let num = 0, den = 0;
      for (const p of this.parts) {
        const rx = p.x - c.x, ry = p.y - c.y;
        const vx = (p.x - p.px) / DT, vy = (p.y - p.py) / DT;
        num += p.m * (rx * vy - ry * vx);
        den += p.m * (rx * rx + ry * ry);
      }
      return den ? num / den : 0;
    }

    step(input) {
      const bike = this.bike;
      const controlled = !this.crashed && !this.finished;
      const gas = controlled && input.gas;
      const brake = (controlled && input.brake) || this.finished;
      const leanDir = controlled ? (input.fwd ? 1 : 0) - (input.back ? 1 : 0) : 0;
      this.lean += (leanDir - this.lean) * 0.15;
      const grounded = this.rear.g || this.front.g;

      for (const p of this.parts) { p.ax = 0; p.ay = GRAVITY; }

      // Drive / reverse along the rear wheel's ground tangent.
      if (this.rear.g) {
        const tx = -this.rear.ny, ty = this.rear.nx;
        const vt = ((this.rear.x - this.rear.px) * tx + (this.rear.y - this.rear.py) * ty) / DT;
        let a = 0;
        if (gas) a = bike.power * Math.max(0, 1 - (vt / bike.maxSpeed) ** 2);
        else if (brake && !this.finished && vt < 25) a = -450 * Math.max(0, 1 + vt / 220);
        for (const p of this.parts) { p.ax += tx * a; p.ay += ty * a; }
      }

      // Lean torque around the centre of mass, capped by max angular speed.
      if (leanDir !== 0) {
        const c = this.com();
        const omega = this.angularVelocity(c);
        if (omega * leanDir < bike.maxOmega) {
          const alpha = (grounded ? bike.ground : bike.air) * leanDir;
          for (const p of this.parts) {
            p.ax += -(p.y - c.y) * alpha;
            p.ay += (p.x - c.x) * alpha;
          }
        }
      }

      const dt2 = DT * DT;
      for (const p of this.parts) {
        const vx = (p.x - p.px) * 0.9995, vy = (p.y - p.py) * 0.9995;
        p.px = p.x; p.py = p.y;
        p.x += vx + p.ax * dt2; p.y += vy + p.ay * dt2;
        p.g = false;
      }

      const T = this.level;
      for (let it = 0; it < 6; it++) {
        for (const c of this.cons) solve(c);
        if (collide(this.rear, WHEEL_R, T)) this.rear.g = true;
        if (collide(this.front, WHEEL_R, T)) this.front.g = true;
        if (this.crashed) collide(this.head, 10, T);
      }

      // Rolling resistance and brakes act on the tangential velocity of grounded wheels.
      for (const w of [this.rear, this.front]) {
        if (!w.g) continue;
        const tx = -w.ny, ty = w.nx;
        const vx = w.x - w.px, vy = w.y - w.py;
        const vt = vx * tx + vy * ty;
        const k = brake ? (this.finished ? 0.03 : 0.045) : this.crashed ? 0.02 : 0.0012;
        const dv = vt * k;
        w.px += tx * dv; w.py += ty * dv;
      }

      this.time += DT;
      this.steps++;
      this.updateState(gas);
      if (this.rider) this.stepRider();
    }

    updateState(gas) {
      const r = this.rear, f = this.front, h = this.head;
      const ang = Math.atan2(f.y - r.y, f.x - r.x);
      const dAng = angleDiff(ang, this.angle);
      this.angle = ang;
      const tx = Math.cos(ang), ty = Math.sin(ang);
      const vr = ((r.x - r.px) * tx + (r.y - r.py) * ty) / DT;
      const vf = ((f.x - f.px) * tx + (f.y - f.py) * ty) / DT;
      this.speed = (vr + vf) / 2;
      this.spinR += r.g ? (vr * DT) / WHEEL_R : gas ? 0.35 : 0;
      this.spinF += f.g ? (vf * DT) / WHEEL_R : 0;

      const grounded = r.g || f.g;
      if (!this.crashed && !this.finished) {
        if (!grounded) {
          this.airSteps++;
          this.airRot += dAng;
          this.airTime += DT;
        } else {
          if (this.airTime > 0.3) this.events.push({ type: 'land', power: this.airTime });
          if (this.airTime > 0.3) this.pending = { t: this.time, rot: this.airRot, air: this.airTime };
          this.airSteps = 0; this.airRot = 0; this.airTime = 0;
        }

        if (this.pending && this.time - this.pending.t > 0.25) { this.land(this.pending); this.pending = null; }

        if (r.g && !f.g && this.speed > 80) this.wheelie += DT;
        else {
          if (this.wheelie > 1) {
            const pts = Math.floor(this.wheelie * 150);
            this.award('Вилли ' + this.wheelie.toFixed(1) + 'с', pts);
          }
          this.wheelie = 0;
        }

        // Crash: head or torso touching the ground.
        const cx = (r.x + f.x) / 2, cy = (r.y + f.y) / 2;
        const tox = cx + (h.x - cx) * 0.55, toy = cy + (h.y - cy) * 0.55;
        if (distToTerrain(h.x, h.y, HEAD_R, this.level) < HEAD_R ||
            distToTerrain(tox, toy, 11, this.level) < 11) this.crash('head');
        if (h.y > this.level.maxY + 700) this.crash('fall');

        for (const c of this.level.coins) {
          if (c.taken || Math.abs(c.x - cx) > 90) continue;
          if (Math.hypot(c.x - cx, c.y - cy) < 45 || Math.hypot(c.x - h.x, c.y - h.y) < 35) {
            c.taken = true;
            this.coinCount++;
            this.events.push({ type: 'coin', x: c.x, y: c.y });
          }
        }

        if (cx >= this.level.finishX) {
          this.finished = true;
          this.finishTime = this.time;
          this.events.push({ type: 'finish' });
        }
      } else if (this.crashed && h.y > this.level.maxY + 2000) {
        for (const p of this.parts) { p.px = p.x; p.py = p.y; }
      }
    }

    land(info) {
      const flips = Math.floor((Math.abs(info.rot) + 0.9) / TAU);
      if (flips > 0) {
        const back = info.rot < 0;
        const per = back ? 500 : 650;
        const name = (back ? 'Бэкфлип' : 'Фронтфлип') + (flips > 1 ? ' x' + flips : '');
        this.flips += flips;
        this.award(name, per * flips * (flips > 1 ? 1.5 : 1) | 0);
      }
      if (info.air > 1.1) this.award('Полёт ' + info.air.toFixed(1) + 'с', Math.floor(info.air * 120));
      const gAng = Math.atan2(this.rear.nx, -this.rear.ny);
      if (flips > 0 && Math.abs(angleDiff(this.angle, gAng)) < 0.3 && this.rear.g && this.front.g) {
        this.award('Чистое приземление', 200);
      }
    }

    award(text, pts) {
      this.trickScore += pts;
      this.events.push({ type: 'trick', text, pts });
    }

    crash(reason) {
      if (this.crashed) return;
      this.crashed = true;
      this.crashTime = this.time;
      this.events.push({ type: 'crash', reason });
      const r = this.rear, h = this.head;
      const hip = { x: r.x + (h.x - r.x) * 0.45, y: r.y + (h.y - r.y) * 0.62 };
      const mk = (x, y, src) => {
        const p = particle(x, y, 1);
        p.px = x - (src.x - src.px) * 1.1; p.py = y - (src.y - src.py) * 1.1 + 1.5;
        return p;
      };
      const rh = mk(h.x, h.y, h), rp = mk(hip.x, hip.y, h);
      this.rider = { head: rh, hip: rp, link: constraint(rh, rp, 1) };
    }

    stepRider() {
      const { head, hip, link } = this.rider;
      const dt2 = DT * DT;
      for (const p of [head, hip]) {
        const vx = (p.x - p.px) * 0.998, vy = (p.y - p.py) * 0.998;
        p.px = p.x; p.py = p.y;
        p.x += vx; p.y += vy + GRAVITY * dt2;
      }
      for (let i = 0; i < 4; i++) {
        solve(link);
        for (const p of [head, hip]) {
          if (collide(p, 9, this.level)) {
            const tx = -p.ny, ty = p.nx;
            const vt = (p.x - p.px) * tx + (p.y - p.py) * ty;
            p.px += tx * vt * 0.06; p.py += ty * vt * 0.06;
          }
        }
      }
    }

    timeBonus() {
      return Math.max(0, Math.round((this.level.par - this.finishTime) * 60));
    }

    finalScore() {
      return this.trickScore + this.coinCount * 50 + (this.finished ? this.timeBonus() + 1000 : 0);
    }

    stars() {
      if (!this.finished) return 0;
      const t = this.finishTime, par = this.level.par;
      if (t <= par * 0.8 || this.trickScore >= 3000) return 3;
      if (t <= par || this.trickScore >= 1200) return 2;
      return 1;
    }
  }

  global.MotoCore = {
    DT, WHEEL_R, WHEELBASE, HEAD_LOCAL, HEAD_R, BIKES, LEVELS, THEMES,
    Race, buildLevel, angleDiff,
  };
})(typeof window !== 'undefined' ? window : globalThis);
