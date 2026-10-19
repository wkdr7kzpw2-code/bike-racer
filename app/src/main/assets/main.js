// Moto Rush — UI, rendering, input, sound and saves.
(function () {
  'use strict';

  const { Race, BIKES, LEVELS, THEMES, DT, WHEEL_R, WHEELBASE } = window.MotoCore;
  const $ = (id) => document.getElementById(id);
  const Android = window.AndroidApp || null;

  // ---------- Save data ----------

  const SAVE_KEY = 'motoRushSave.v1';
  const defaults = () => ({
    name: 'Игрок', coins: 0, owned: ['scout'], bike: 0, unlocked: 1,
    levels: {}, board: [], sound: true, vibro: true, flips: 0, runs: 0,
  });
  let save = defaults();
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) save = Object.assign(defaults(), JSON.parse(raw));
  } catch (e) { /* storage unavailable: play without saving */ }
  const persist = () => { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) { /* ignore */ } };

  const totalStars = () => Object.values(save.levels).reduce((s, l) => s + (l.stars || 0), 0);
  const RANKS = [
    { stars: 0, name: 'Новичок' }, { stars: 3, name: 'Любитель' }, { stars: 6, name: 'Райдер' },
    { stars: 10, name: 'Профи' }, { stars: 14, name: 'Мастер' }, { stars: 18, name: 'Легенда' },
  ];
  const rankOf = (stars) => { let r = 0; RANKS.forEach((k, i) => { if (stars >= k.stars) r = i; }); return r; };

  // ---------- Sound ----------

  const Sfx = {
    ctx: null, engine: null,
    ensure() {
      if (!save.sound) return null;
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    tone(freq, dur, type, vol, slide) {
      const ctx = this.ensure(); if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || 'square'; o.frequency.value = freq;
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, ctx.currentTime + dur);
      g.gain.value = vol || 0.08;
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      o.connect(g).connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + dur);
    },
    noise(dur, vol) {
      const ctx = this.ensure(); if (!ctx) return;
      const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const src = ctx.createBufferSource(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 900; g.gain.value = vol || 0.3;
      src.buffer = buf; src.connect(f).connect(g).connect(ctx.destination); src.start();
    },
    coin() { this.tone(988, 0.08, 'square', 0.05); setTimeout(() => this.tone(1319, 0.12, 'square', 0.05), 60); },
    trick() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.tone(f, 0.12, 'triangle', 0.08), i * 60)); },
    crash() { this.noise(0.5, 0.35); this.tone(120, 0.4, 'sawtooth', 0.08, 40); },
    land(p) { this.noise(0.12, Math.min(0.25, 0.06 + p * 0.1)); },
    finish() { [392, 523, 659, 784, 659, 784].forEach((f, i) => setTimeout(() => this.tone(f, 0.18, 'square', 0.06), i * 110)); },
    click() { this.tone(660, 0.05, 'square', 0.03); },
    engineStart() {
      const ctx = this.ensure(); if (!ctx || this.engine) return;
      const o = ctx.createOscillator(), o2 = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      o.type = 'sawtooth'; o2.type = 'square'; o2.detune.value = -1200;
      f.type = 'lowpass'; f.frequency.value = 500; g.gain.value = 0;
      o.connect(f); o2.connect(f); f.connect(g).connect(ctx.destination);
      o.start(); o2.start();
      this.engine = { o, o2, f, g };
    },
    engineUpdate(speed, gas) {
      if (!this.engine) return;
      const t = this.ctx.currentTime;
      const freq = 45 + Math.abs(speed) * 0.11 + (gas ? 25 : 0);
      this.engine.o.frequency.setTargetAtTime(freq, t, 0.05);
      this.engine.o2.frequency.setTargetAtTime(freq, t, 0.05);
      this.engine.f.frequency.setTargetAtTime(gas ? 900 : 450, t, 0.08);
      this.engine.g.gain.setTargetAtTime(gas ? 0.05 : 0.025, t, 0.1);
    },
    engineStop() {
      if (!this.engine) return;
      const e = this.engine; this.engine = null;
      e.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
      setTimeout(() => { e.o.stop(); e.o2.stop(); }, 300);
    },
  };

  const vibrate = (ms) => {
    if (!save.vibro) return;
    if (Android && Android.vibrate) Android.vibrate(ms);
    else if (navigator.vibrate) navigator.vibrate(ms);
  };

  // ---------- Canvas ----------

  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    $('rotate').classList.toggle('hidden', !(H > W * 1.1 && W < 700));
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------- Drawing helpers ----------

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const c = (v) => Math.max(0, Math.min(255, Math.round(v + amt * 255)));
    return 'rgb(' + c(n >> 16) + ',' + c((n >> 8) & 255) + ',' + c(n & 255) + ')';
  }

  function drawWheel(g, x, y, spin, accent) {
    g.save();
    g.translate(x, y);
    g.fillStyle = '#1b1b1f';
    g.beginPath(); g.arc(0, 0, WHEEL_R, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#3a3a44'; g.lineWidth = 2;
    g.beginPath(); g.arc(0, 0, WHEEL_R - 3, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = accent; g.lineWidth = 2.5;
    g.beginPath(); g.arc(0, 0, WHEEL_R - 6.5, 0, Math.PI * 2); g.stroke();
    g.rotate(spin);
    g.strokeStyle = '#c9ccd6'; g.lineWidth = 1.6;
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      g.moveTo(0, 0); g.lineTo(Math.cos(a) * (WHEEL_R - 7), Math.sin(a) * (WHEEL_R - 7));
    }
    g.stroke();
    g.fillStyle = '#888';
    g.beginPath(); g.arc(0, 0, 3.5, 0, Math.PI * 2); g.fill();
    g.restore();
  }

  function limb(g, pts, width, color) {
    g.strokeStyle = color; g.lineWidth = width; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.stroke();
  }

  // Bike in local coordinates: rear axle at origin, front axle at (WHEELBASE, 0), up is -y.
  function drawBike(g, bike, spinR, spinF, lean, rider) {
    const L = WHEELBASE;
    const body = bike.color, acc = bike.accent;
    // swingarm & exhaust
    limb(g, [0, 0, 26, -16], 6, '#3b3e48');
    limb(g, [40, -12, 22, -10, 2, -20], 4.5, '#b9bcc6');
    g.fillStyle = '#9ea1ab';
    g.beginPath(); g.ellipse(4, -20, 7, 4, -0.2, 0, Math.PI * 2); g.fill();
    // fork
    limb(g, [L, 0, L - 15, -40], 5, '#d0d3dc');
    drawWheel(g, 0, 0, spinR, acc);
    drawWheel(g, L, 0, spinF, acc);
    // engine
    g.fillStyle = '#4a4d57';
    g.beginPath(); g.roundRect ? g.roundRect(22, -24, 22, 16, 4) : g.rect(22, -24, 22, 16); g.fill();
    g.fillStyle = '#6c707c'; g.fillRect(26, -20, 14, 3); g.fillRect(26, -15, 14, 3);
    // body shell
    g.fillStyle = body;
    g.beginPath();
    g.moveTo(-14, -30); g.lineTo(6, -26); g.lineTo(20, -24); g.lineTo(30, -36);
    g.lineTo(54, -40); g.lineTo(L - 12, -36); g.lineTo(52, -22); g.lineTo(44, -20); g.lineTo(22, -18);
    g.lineTo(4, -20); g.closePath(); g.fill();
    g.fillStyle = shade(body, 0.18);
    g.beginPath(); g.moveTo(32, -35); g.lineTo(52, -38); g.lineTo(56, -34); g.lineTo(36, -31); g.closePath(); g.fill();
    g.fillStyle = acc;
    g.beginPath(); g.moveTo(-12, -29); g.lineTo(4, -26); g.lineTo(4, -23); g.lineTo(-10, -26); g.closePath(); g.fill();
    // front fender & number plate
    g.fillStyle = body;
    g.beginPath(); g.moveTo(L - 22, -24); g.quadraticCurveTo(L, -30, L + 14, -20); g.lineTo(L + 10, -18); g.quadraticCurveTo(L, -25, L - 18, -21); g.fill();
    g.fillStyle = acc;
    g.beginPath(); g.moveTo(L - 14, -46); g.lineTo(L - 4, -40); g.lineTo(L - 10, -30); g.lineTo(L - 18, -36); g.closePath(); g.fill();
    // seat
    g.fillStyle = '#1d1e24';
    g.beginPath(); g.moveTo(6, -27); g.quadraticCurveTo(20, -35, 32, -36); g.lineTo(30, -32); g.quadraticCurveTo(18, -30, 8, -24); g.fill();
    // handlebar
    limb(g, [L - 15, -40, L - 20, -47, L - 26, -47], 3.5, '#2a2c33');

    if (!rider) return;
    const lx = lean * 9;
    const hip = [20, -38], sh = [34 + lx, -63], hd = [38 + lx * 1.2, -76];
    const hand = [L - 24, -46], foot = [30, -14];
    const knee = [44, -32];
    const elbow = [(sh[0] + hand[0]) / 2 + 2, (sh[1] + hand[1]) / 2 + 7];
    const suit = bike.rider;
    limb(g, [hip[0], hip[1], knee[0], knee[1], foot[0], foot[1]], 9, shade(suit, -0.05));
    g.fillStyle = '#111'; g.fillRect(foot[0] - 4, foot[1] - 2, 12, 6);
    limb(g, [hip[0], hip[1], sh[0], sh[1]], 13, suit);
    limb(g, [sh[0] - 2, sh[1] + 2, hip[0] + 2, hip[1] - 3], 4, acc);
    limb(g, [sh[0], sh[1], elbow[0], elbow[1], hand[0], hand[1]], 7, shade(suit, 0.12));
    // helmet
    g.fillStyle = acc;
    g.beginPath(); g.arc(hd[0], hd[1], 12, 0, Math.PI * 2); g.fill();
    g.fillStyle = body;
    g.beginPath(); g.arc(hd[0], hd[1], 12, Math.PI * 0.9, Math.PI * 1.55); g.lineTo(hd[0], hd[1]); g.fill();
    g.fillStyle = '#1b2633';
    g.beginPath(); g.moveTo(hd[0] + 3, hd[1] - 5); g.lineTo(hd[0] + 13, hd[1] - 3); g.lineTo(hd[0] + 12, hd[1] + 5); g.lineTo(hd[0] + 4, hd[1] + 3); g.closePath(); g.fill();
    g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(hd[0] + 6, hd[1] - 4, 5, 2);
  }

  function drawRagdoll(g, r, bike) {
    const { head, hip } = r;
    const dx = head.x - hip.x, dy = head.y - hip.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
    const t = performance.now() / 120;
    const legA = [hip.x - ux * 18 + nx * 10, hip.y - uy * 18 + ny * 10];
    const legB = [hip.x - ux * 20 - nx * 6 + Math.sin(t) * 3, hip.y - uy * 20 - ny * 6];
    const sh = [hip.x + ux * 22, hip.y + uy * 22];
    limb(g, [hip.x, hip.y, legA[0], legA[1], legA[0] - ux * 14, legA[1] - uy * 14], 9, bike.rider);
    limb(g, [hip.x, hip.y, legB[0], legB[1], legB[0] - ux * 14 + nx * 8, legB[1] - uy * 14 + ny * 8], 9, bike.rider);
    limb(g, [hip.x, hip.y, sh[0], sh[1]], 13, bike.rider);
    limb(g, [sh[0], sh[1], sh[0] + nx * 18, sh[1] + ny * 18 - 4], 7, bike.rider);
    limb(g, [sh[0], sh[1], sh[0] - nx * 16 + ux * 6, sh[1] - ny * 16 + uy * 6], 7, bike.rider);
    g.fillStyle = bike.accent;
    g.beginPath(); g.arc(head.x, head.y, 12, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#1b2633';
    g.beginPath(); g.arc(head.x + nx * 4, head.y + ny * 4, 6, 0, Math.PI * 2); g.fill();
  }

  // ---------- Game state ----------

  let screen = 'menu';
  let race = null, levelIndex = 0;
  let paused = false;
  let resultShown = false;
  const input = { gas: false, brake: false, back: false, fwd: false };
  const keyInput = { gas: false, brake: false, back: false, fwd: false };
  const cam = { x: 0, y: 0, z: 1 };
  let particles = [];
  let acc = 0;
  let lastTrickPopup = 0;

  function startRace(index) {
    levelIndex = index;
    race = new Race(index, save.bike);
    paused = false; resultShown = false; acc = 0; particles = [];
    const c = race.com();
    cam.x = c.x + 200; cam.y = c.y - 60;
    $('tricks').innerHTML = '';
    show('game');
    Sfx.engineStart();
    popup('Вперёд!', '');
  }

  function show(name) {
    screen = name;
    for (const id of ['menu', 'levels', 'garage', 'rating', 'settings', 'pause', 'result']) {
      $(id).classList.toggle('hidden', id !== name && !(name === 'pause' && id === 'pause'));
    }
    const inGame = name === 'game' || name === 'pause' || name === 'result';
    $('hud').classList.toggle('hidden', !inGame);
    $('controls').classList.toggle('hidden', name !== 'game');
    if (!inGame) { race = null; Sfx.engineStop(); }
    if (name === 'menu') renderMenu();
    if (name === 'levels') renderLevels();
    if (name === 'garage') { garIndex = save.bike; renderGarage(); }
    if (name === 'rating') renderRating();
    if (name === 'settings') renderSettings();
    for (const k in touchHeld) touchHeld[k] = false;
    document.querySelectorAll('.ctrl.on').forEach((b) => b.classList.remove('on'));
  }

  function setPaused(p) {
    if (!race || resultShown) return;
    paused = p;
    if (p) { show('pause'); $('hud').classList.remove('hidden'); Sfx.engineUpdate(0, false); }
    else { $('pause').classList.add('hidden'); screen = 'game'; $('controls').classList.remove('hidden'); }
  }

  function popup(text, sub) {
    const el = document.createElement('div');
    el.className = 'trick';
    el.innerHTML = text + (sub ? '<small>' + sub + '</small>' : '');
    $('tricks').appendChild(el);
    setTimeout(() => el.remove(), 1600);
  }

  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  function emit(x, y, n, color, spread, up, life, size) {
    for (let i = 0; i < n; i++) {
      particles.push({
        x, y, vx: (Math.random() - 0.5) * spread, vy: -Math.random() * up,
        life: life * (0.6 + Math.random() * 0.4), max: life, color, size: size * (0.6 + Math.random() * 0.8),
      });
    }
  }

  function handleEvents() {
    for (const e of race.events) {
      if (e.type === 'coin') { Sfx.coin(); emit(e.x, e.y, 8, '#ffd60a', 260, 200, 0.4, 4); }
      else if (e.type === 'trick') {
        Sfx.trick(); vibrate(25);
        const now = performance.now();
        setTimeout(() => popup(e.text, '+' + e.pts), Math.max(0, lastTrickPopup + 250 - now));
        lastTrickPopup = Math.max(now, lastTrickPopup + 250);
      } else if (e.type === 'land') { Sfx.land(e.power); emit(race.rear.x, race.rear.y + WHEEL_R, 10, 'rgba(120,100,80,.8)', 300, 120, 0.5, 5); }
      else if (e.type === 'crash') {
        Sfx.crash(); vibrate(200);
        emit(race.head.x, race.head.y, 24, '#ffb703', 500, 400, 0.7, 4);
        popup(e.reason === 'fall' ? 'Пропасть!' : 'Авария!', '');
      } else if (e.type === 'finish') {
        Sfx.finish(); vibrate(60);
        for (let i = 0; i < 4; i++) emit(race.level.finishX, race.level.groundAt(race.level.finishX) - 140, 30,
          ['#ef476f', '#ffd166', '#06d6a0', '#118ab2'][i], 700, 600, 1.4, 5);
      }
    }
    race.events.length = 0;
  }

  function update(dt) {
    if (!race || paused) return;
    for (const k in input) input[k] = keyInput[k] || touchHeld[k];
    acc += Math.min(dt, 0.05);
    while (acc >= DT) { race.step(input); acc -= DT; }
    handleEvents();

    // particles
    if (race.rear.g && input.gas && !race.crashed && !race.finished && Math.random() < 0.6) {
      emit(race.rear.x - 6, race.rear.y + WHEEL_R - 4, 1, 'rgba(160,130,100,.6)', 80, 90, 0.5, 5);
    }
    for (const p of particles) { p.vy += 900 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; }
    particles = particles.filter((p) => p.life > 0);

    // camera
    const v = race.velocity();
    const look = Math.max(-150, Math.min(260, v.x * 0.35));
    const tx = v.cx + look, ty = v.cy - 40 + Math.max(-80, Math.min(120, v.y * 0.12));
    const k = 1 - Math.exp(-dt * 5);
    cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k;
    const base = Math.min(H / 520, W / 760);
    const tz = base * (1 - Math.min(0.22, Math.hypot(v.x, v.y) / 4500));
    cam.z += (tz - cam.z) * (1 - Math.exp(-dt * 2));

    Sfx.engineUpdate(race.crashed || race.finished ? 0 : race.speed, input.gas && !race.crashed);

    if (!resultShown && ((race.crashed && race.time - race.crashTime > 1.6) || (race.finished && race.time - race.finishTime > 1.4))) {
      showResult();
    }
    updateHud();
  }

  const fmtTime = (t) => {
    const m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  };

  let hudCache = '';
  function updateHud() {
    const t = race.finished ? race.finishTime : race.crashed ? race.crashTime : race.time;
    const score = race.trickScore + race.coinCount * 50;
    const key = t.toFixed(1) + '|' + score + '|' + race.coinCount;
    if (key !== hudCache) {
      hudCache = key;
      $('hudTime').textContent = fmtTime(t);
      $('hudScore').textContent = score;
      $('hudCoins').textContent = race.coinCount;
    }
    const prog = Math.max(0, Math.min(1, race.com().x / race.level.finishX));
    $('progressFill').style.width = prog * 100 + '%';
    $('progressBike').style.left = prog * 100 + '%';
  }

  // ---------- Rendering ----------

  function ridge(x, seed, amp) {
    return (Math.sin(x * 0.0021 + seed) * 0.5 + Math.sin(x * 0.0047 + seed * 2.1) * 0.3 + Math.sin(x * 0.011 + seed * 3.7) * 0.2) * amp;
  }

  function drawBackground(theme, isNight, isVolcano, isIce) {
    const g = ctx;
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, theme.skyTop); grad.addColorStop(1, theme.skyBottom);
    g.fillStyle = grad; g.fillRect(0, 0, W, H);

    if (isNight) {
      g.fillStyle = 'rgba(255,255,255,.8)';
      for (let i = 0; i < 70; i++) {
        const sx = ((i * 137.5 - cam.x * 0.02) % W + W) % W, sy = (i * 61.7) % (H * 0.6);
        g.fillRect(sx, sy, i % 3 ? 1.5 : 2.5, i % 3 ? 1.5 : 2.5);
      }
    }
    // sun / moon
    g.fillStyle = theme.sun;
    g.globalAlpha = 0.9;
    g.beginPath(); g.arc(W * 0.78, H * 0.22, Math.min(W, H) * 0.08, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 0.25;
    g.beginPath(); g.arc(W * 0.78, H * 0.22, Math.min(W, H) * 0.13, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;

    // clouds
    if (!isNight && !isVolcano) {
      g.fillStyle = 'rgba(255,255,255,.75)';
      for (let i = 0; i < 5; i++) {
        const cx = ((i * 420 - cam.x * 0.08 + performance.now() * 0.004) % (W + 400) + W + 400) % (W + 400) - 200;
        const cy = H * (0.12 + (i % 3) * 0.08);
        const s = 0.7 + (i % 2) * 0.5;
        for (const [ox, oy, rx, ry] of [[0, 0, 50, 16], [30, -10, 32, 18], [-26, -4, 26, 14]]) {
          g.beginPath(); g.ellipse(cx + ox * s, cy + oy * s, rx * s, ry * s, 0, 0, Math.PI * 2); g.fill();
        }
      }
    }

    // parallax ridges
    const layers = [
      { p: 0.12, color: theme.far, base: 0.62, amp: 0.2, seed: 1.3 },
      { p: 0.3, color: theme.near, base: 0.75, amp: 0.14, seed: 4.1 },
    ];
    for (const l of layers) {
      g.fillStyle = l.color;
      g.beginPath();
      g.moveTo(0, H);
      const yOff = -cam.y * l.p * cam.z * 0.5;
      for (let sx = 0; sx <= W + 20; sx += 16) {
        const wx = (sx - W / 2) / cam.z + cam.x * l.p / 1;
        g.lineTo(sx, H * l.base + yOff - Math.abs(ridge(wx, l.seed, H * l.amp)) - (isIce && l.p < 0.2 ? 30 : 0));
      }
      g.lineTo(W, H); g.closePath(); g.fill();
    }
    if (isVolcano) {
      g.fillStyle = 'rgba(255,90,0,.15)';
      g.fillRect(0, H * 0.6, W, H * 0.4);
    }
  }

  function lowerBound(pts, x) {
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m].x < x) lo = m + 1; else hi = m; }
    return lo;
  }

  function drawTerrain(level, theme, x0, x1, bottom) {
    const g = ctx;
    for (const pts of level.polys) {
      if (pts[pts.length - 1].x < x0 || pts[0].x > x1) continue;
      const i0 = Math.max(0, lowerBound(pts, x0) - 1);
      const i1 = Math.min(pts.length - 1, lowerBound(pts, x1) + 1);
      g.beginPath();
      g.moveTo(pts[i0].x, Math.min(pts[i0].y, bottom));
      for (let i = i0 + 1; i <= i1; i++) g.lineTo(pts[i].x, Math.min(pts[i].y, bottom));
      g.lineTo(pts[i1].x, bottom); g.lineTo(pts[i0].x, bottom); g.closePath();
      g.fillStyle = theme.ground; g.fill();

      // layered soil stripes
      g.save(); g.clip();
      g.strokeStyle = shade(theme.ground, -0.06); g.lineWidth = 26;
      g.beginPath();
      for (let i = i0; i <= i1; i++) {
        const y = pts[i].y + 60;
        if (i === i0) g.moveTo(pts[i].x, y); else g.lineTo(pts[i].x, y);
      }
      g.stroke();
      g.restore();

      g.beginPath();
      let started = false;
      for (let i = i0; i <= i1; i++) {
        const a = pts[i], b = pts[i + 1];
        // skip vertical cliff walls when drawing the grass edge
        if (b && Math.abs(b.x - a.x) < 1 && Math.abs(b.y - a.y) > 200) { started = false; continue; }
        if (!started) { g.moveTo(a.x, a.y); started = true; } else g.lineTo(a.x, a.y);
      }
      g.strokeStyle = theme.top; g.lineWidth = 9; g.lineJoin = 'round'; g.lineCap = 'round'; g.stroke();
      g.strokeStyle = shade(theme.top, -0.15); g.lineWidth = 2.5;
      g.save(); g.translate(0, 5); g.stroke(); g.restore();
    }
  }

  function drawFinish(level) {
    const g = ctx;
    const fx = level.finishX, fy = level.groundAt(fx);
    const sq = 10;
    for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) {
      g.fillStyle = (i + j) % 2 ? '#111' : '#fff';
      g.fillRect(fx - sq + j * sq, fy - 160 + i * sq, sq, sq);
    }
    g.fillStyle = '#ddd'; g.fillRect(fx - 14, fy - 175, 4, 175); g.fillRect(fx + 10, fy - 175, 4, 175);
    g.fillStyle = '#ef476f';
    g.fillRect(fx - 80, fy - 200, 160, 30);
    g.fillStyle = '#fff'; g.font = 'bold 20px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('ФИНИШ', fx, fy - 185);
    // start banner
    const sy = level.groundAt(0);
    g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(-4, sy - 120, 4, 120);
    g.fillStyle = '#06d6a0'; g.fillRect(-4, sy - 120, 60, 24);
    g.fillStyle = '#063'; g.font = 'bold 14px system-ui, sans-serif'; g.fillText('СТАРТ', 26, sy - 108);
  }

  function drawCoins(level, x0, x1) {
    const g = ctx;
    const t = performance.now() / 300;
    for (const c of level.coins) {
      if (c.taken || c.x < x0 || c.x > x1) continue;
      const w = Math.abs(Math.cos(t + c.x * 0.01)) * 10 + 2;
      g.fillStyle = '#e09f00';
      g.beginPath(); g.ellipse(c.x, c.y, w, 12, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ffd60a';
      g.beginPath(); g.ellipse(c.x, c.y, Math.max(1, w - 3), 9, 0, 0, Math.PI * 2); g.fill();
    }
  }

  function render() {
    const g = ctx;
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (!race) { drawMenuBackdrop(); return; }
    const level = race.level;
    const theme = THEMES[level.def.theme];
    drawBackground(theme, level.def.theme === 'night', level.def.theme === 'volcano', level.def.theme === 'ice');

    g.save();
    g.translate(W / 2, H / 2);
    g.scale(cam.z, cam.z);
    g.translate(-cam.x, -cam.y);
    const x0 = cam.x - W / 2 / cam.z - 60, x1 = cam.x + W / 2 / cam.z + 60;
    const bottom = cam.y + H / 2 / cam.z + 50;

    drawFinish(level);
    drawTerrain(level, theme, x0, x1, bottom);
    drawCoins(level, x0, x1);

    // bike
    const r = race.rear;
    g.save();
    g.translate(r.x, r.y);
    g.rotate(race.angle);
    drawBike(g, race.bike, race.spinR, race.spinF, race.lean, !race.crashed);
    g.restore();
    if (race.rider) drawRagdoll(g, race.rider, race.bike);

    for (const p of particles) {
      g.globalAlpha = Math.max(0, p.life / p.max);
      g.fillStyle = p.color;
      g.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    g.globalAlpha = 1;
    g.restore();

    if (race.wheelie > 0.6 && !race.crashed) {
      g.fillStyle = 'rgba(0,0,0,.45)';
      g.font = 'bold 18px system-ui, sans-serif'; g.textAlign = 'center';
      g.fillText('ВИЛЛИ ' + race.wheelie.toFixed(1) + 'с', W / 2 + 1, H * 0.2 + 1);
      g.fillStyle = '#ffd166'; g.fillText('ВИЛЛИ ' + race.wheelie.toFixed(1) + 'с', W / 2, H * 0.2);
    }
  }

  // Animated backdrop behind menus.
  let menuX = 0;
  const menuLevel = { idx: -1, level: null };
  function drawMenuBackdrop() {
    const idx = screen === 'levels' || screen === 'menu' ? 0 : screen === 'garage' ? 3 : screen === 'rating' ? 1 : 2;
    if (menuLevel.idx !== idx) {
      menuLevel.idx = idx; menuLevel.level = window.MotoCore.buildLevel(idx);
    }
    const level = menuLevel.level;
    menuX += 1.2;
    if (menuX > level.finishX - 800) menuX = 0;
    const theme = THEMES[level.def.theme];
    cam.z = Math.min(H / 520, W / 760);
    cam.x = menuX; cam.y = (level.groundAt(menuX) ?? 0) - 80;
    drawBackground(theme, idx === 3, false, false);
    const g = ctx;
    g.save();
    g.translate(W / 2, H / 2); g.scale(cam.z, cam.z); g.translate(-cam.x, -cam.y);
    drawTerrain(level, theme, cam.x - W / cam.z, cam.x + W / cam.z, cam.y + H / cam.z);
    g.restore();
  }

  // ---------- Results ----------

  function showResult() {
    resultShown = true;
    Sfx.engineUpdate(0, false);
    const finished = race.finished;
    const stars = race.stars();
    const score = race.finalScore();
    const def = LEVELS[levelIndex];
    const prev = save.levels[levelIndex] || { stars: 0, bestScore: 0, bestTime: 0 };
    let record = false;
    let earned = race.coinCount;

    save.runs++;
    if (finished) {
      earned += Math.floor(score / 100);
      record = score > prev.bestScore;
      save.levels[levelIndex] = {
        stars: Math.max(prev.stars, stars),
        bestScore: Math.max(prev.bestScore, score),
        bestTime: prev.bestTime ? Math.min(prev.bestTime, race.finishTime) : race.finishTime,
      };
      if (levelIndex + 1 >= save.unlocked && levelIndex + 1 < LEVELS.length) save.unlocked = levelIndex + 2;
      save.flips += race.flips;
      save.board.push({
        name: save.name, bike: race.bike.name, level: levelIndex, score,
        time: Math.round(race.finishTime * 10) / 10, stars, date: Date.now(),
      });
      save.board.sort((a, b) => b.score - a.score);
      save.board = save.board.slice(0, 50);
    }
    save.coins += earned;
    persist();

    $('resTitle').textContent = finished ? 'Финиш!' : 'Авария!';
    $('resStars').innerHTML = [0, 1, 2].map((i) => '<span class="' + (i < stars ? 'on' : '') + '">★</span>').join('');
    $('resStars').classList.toggle('hidden', !finished);
    $('resRecord').classList.toggle('hidden', !record);
    const rows = [['Трасса', def.name]];
    if (finished) {
      rows.push(['Время', fmtTime(race.finishTime) + ' (норма ' + fmtTime(race.level.par) + ')']);
    } else {
      rows.push(['Пройдено', Math.round(Math.min(1, race.com().x / race.level.finishX) * 100) + '%']);
    }
    rows.push(['Трюки', race.trickScore], ['Монеты', race.coinCount + ' × 50']);
    if (finished) rows.push(['Бонус за время', race.timeBonus()], ['Финиш', 1000], ['Итого', score]);
    rows.push(['Заработано', '● ' + earned]);
    $('resTable').innerHTML = rows.map((r, i) => {
      const cls = r[0] === 'Итого' ? ' class="tot"' : '';
      return '<span' + cls + '>' + r[0] + '</span><b' + cls + '>' + r[1] + '</b>';
    }).join('');
    $('resNext').classList.toggle('hidden', !(finished && levelIndex + 1 < LEVELS.length));
    $('controls').classList.add('hidden');
    $('result').classList.remove('hidden');
    screen = 'result';
  }

  // ---------- Menus ----------

  function renderWallet() { document.querySelectorAll('.coins-val').forEach((e) => { e.textContent = save.coins; }); }

  function renderMenu() {
    renderWallet();
    $('menuName').textContent = save.name;
    $('menuRank').textContent = RANKS[rankOf(totalStars())].name;
  }

  function renderLevels() {
    renderWallet();
    $('levelsBike').textContent = BIKES[save.bike].name;
    const grid = $('levelGrid');
    grid.innerHTML = '';
    LEVELS.forEach((def, i) => {
      const th = THEMES[def.theme];
      const info = save.levels[i];
      const locked = i >= save.unlocked;
      const b = document.createElement('button');
      b.className = 'level-card' + (locked ? ' locked' : '');
      b.style.background = 'linear-gradient(160deg,' + th.skyTop + ' 0%,' + th.near + ' 70%,' + th.ground + ' 100%)';
      const stars = info ? info.stars : 0;
      b.innerHTML = '<div class="ln">ТРАССА ' + (i + 1) + '</div><div class="lt">' + def.name + '</div>' +
        '<div class="ls">' + '★'.repeat(stars) + '<span style="opacity:.35">' + '★'.repeat(3 - stars) + '</span></div>' +
        '<div class="lb">' + (info ? 'Рекорд: ' + info.bestScore + ' · ' + fmtTime(info.bestTime) : locked ? 'Пройдите трассу ' + i : 'Не пройдена') + '</div>';
      b.onclick = () => {
        Sfx.click();
        if (locked) { toast('Сначала пройдите трассу ' + i); return; }
        startRace(i);
      };
      grid.appendChild(b);
    });
  }

  let garIndex = 0;
  const garCanvas = $('garageCanvas');
  const garCtx = garCanvas.getContext('2d');
  function renderGarage() {
    renderWallet();
    const b = BIKES[garIndex];
    const owned = save.owned.includes(b.id);
    $('garName').textContent = b.name;
    $('garDesc').textContent = b.desc;
    const min = (k) => Math.min(...BIKES.map((x) => x[k])), max = (k) => Math.max(...BIKES.map((x) => x[k]));
    const norm = (k) => 0.3 + 0.7 * (b[k] - min(k)) / (max(k) - min(k));
    const stats = [['Скорость', 'maxSpeed'], ['Разгон', 'power'], ['Вращение', 'maxOmega'], ['Контроль', 'air']];
    $('garStats').innerHTML = stats.map(([n, k]) => '<span>' + n + '</span><div class="stat-bar"><i style="width:' + Math.round(norm(k) * 100) + '%"></i></div>').join('');
    const btn = $('garAction');
    btn.disabled = false;
    if (save.bike === garIndex) { btn.textContent = '✓ Выбран'; btn.disabled = true; }
    else if (owned) btn.textContent = 'Выбрать';
    else { btn.textContent = 'Купить ● ' + b.price; btn.disabled = save.coins < b.price; }
    $('garDots').innerHTML = BIKES.map((_, i) => '<i class="' + (i === garIndex ? 'on' : '') + '"></i>').join('');
  }
  let garSpin = 0;
  function drawGarage() {
    const b = BIKES[garIndex];
    const owned = save.owned.includes(b.id);
    const g = garCtx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, garCanvas.width, garCanvas.height);
    const grd = g.createRadialGradient(180, 140, 10, 180, 140, 135);
    grd.addColorStop(0, 'rgba(255,183,3,.25)'); grd.addColorStop(1, 'rgba(255,183,3,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 360, 200);
    g.fillStyle = 'rgba(0,0,0,.35)';
    g.beginPath(); g.ellipse(180, 184, 110, 10, 0, 0, Math.PI * 2); g.fill();
    garSpin += 0.06;
    g.translate(180 - WHEELBASE * 1.55 / 2, 184 - WHEEL_R * 1.55);
    g.scale(1.55, 1.55);
    if (!owned) g.globalAlpha = 0.55;
    drawBike(g, b, garSpin, garSpin, Math.sin(garSpin * 0.5) * 0.4, true);
    g.globalAlpha = 1;
    if (!owned) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.font = '34px system-ui'; g.textAlign = 'center'; g.fillText('🔒', 330, 40);
    }
  }
  $('garPrev').onclick = () => { Sfx.click(); garIndex = (garIndex + BIKES.length - 1) % BIKES.length; renderGarage(); };
  $('garNext').onclick = () => { Sfx.click(); garIndex = (garIndex + 1) % BIKES.length; renderGarage(); };
  $('garAction').onclick = () => {
    const b = BIKES[garIndex];
    if (!save.owned.includes(b.id)) {
      if (save.coins < b.price) return;
      save.coins -= b.price; save.owned.push(b.id);
      Sfx.trick(); toast('Куплен: ' + b.name);
    } else Sfx.click();
    save.bike = garIndex;
    persist();
    renderGarage();
  };

  let ratingTab = 'board';
  function renderRating() {
    const stars = totalStars();
    const ri = rankOf(stars);
    $('rankTitle').textContent = RANKS[ri].name;
    $('rankName').textContent = save.name;
    const best = save.board.length ? save.board[0].score : 0;
    $('rankStats').innerHTML = 'Звёзды: <b>' + stars + ' / ' + LEVELS.length * 3 + '</b><br>Сальто всего: <b>' + save.flips +
      '</b><br>Заездов: <b>' + save.runs + '</b><br>Лучший счёт: <b>' + best + '</b><br>Мотоциклов: <b>' + save.owned.length + ' / ' + BIKES.length + '</b>';
    const next = RANKS[ri + 1];
    const cur = RANKS[ri];
    $('rankFill').style.width = (next ? ((stars - cur.stars) / (next.stars - cur.stars)) * 100 : 100) + '%';
    $('rankNext').textContent = next ? 'До звания «' + next.name + '»: ' + (next.stars - stars) + ' ★' : 'Максимальное звание!';

    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === ratingTab));
    const list = $('ratingList');
    if (ratingTab === 'board') {
      if (!save.board.length) { list.innerHTML = '<div class="empty">Пока нет заездов.<br>Пройдите трассу, чтобы попасть в рейтинг!</div>'; return; }
      list.innerHTML = save.board.slice(0, 20).map((r, i) =>
        '<div class="row"><span class="pos">' + (i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1) + '</span>' +
        '<span class="who"><b>' + escapeHtml(r.name) + '</b><small>' + LEVELS[r.level].name + ' · ' + r.bike + '</small></span>' +
        '<span class="tm">' + fmtTime(r.time) + '</span><span class="sc">' + r.score + '</span></div>').join('');
    } else {
      list.innerHTML = LEVELS.map((def, i) => {
        const info = save.levels[i];
        return '<div class="row"><span class="pos">' + (i + 1) + '</span><span class="who"><b>' + def.name + '</b><small>' +
          (info ? '★'.repeat(info.stars) + '☆'.repeat(3 - info.stars) : i < save.unlocked ? 'не пройдена' : '🔒 закрыта') + '</small></span>' +
          '<span class="tm">' + (info ? fmtTime(info.bestTime) : '—') + '</span><span class="sc">' + (info ? info.bestScore : '—') + '</span></div>';
      }).join('');
    }
  }
  document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => { Sfx.click(); ratingTab = t.dataset.tab; renderRating(); }; });

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function renderSettings() {
    $('nameInput').value = save.name;
    $('optSound').checked = save.sound;
    $('optVibro').checked = save.vibro;
  }
  $('nameInput').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    save.name = v || 'Игрок';
    persist();
  });
  $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('optSound').onchange = (e) => { save.sound = e.target.checked; persist(); if (save.sound) Sfx.click(); };
  $('optVibro').onchange = (e) => { save.vibro = e.target.checked; persist(); vibrate(40); };
  let resetArmed = 0;
  $('resetBtn').onclick = () => {
    if (Date.now() - resetArmed > 2500) { resetArmed = Date.now(); toast('Нажмите ещё раз для сброса'); return; }
    save = defaults(); persist(); renderSettings(); toast('Прогресс сброшен');
  };

  document.querySelectorAll('[data-go]').forEach((b) => {
    b.addEventListener('click', () => { Sfx.click(); show(b.dataset.go); });
  });
  $('btnPause').onclick = () => { Sfx.click(); setPaused(true); };
  $('resumeBtn').onclick = () => { Sfx.click(); setPaused(false); };
  $('restartBtn').onclick = () => { Sfx.click(); startRace(levelIndex); };
  $('quitBtn').onclick = () => { Sfx.click(); show('levels'); };
  $('resMenu').onclick = () => { Sfx.click(); show('levels'); };
  $('resRetry').onclick = () => { Sfx.click(); startRace(levelIndex); };
  $('resNext').onclick = () => { Sfx.click(); startRace(levelIndex + 1); };

  // ---------- Input ----------

  const touchHeld = { gas: false, brake: false, back: false, fwd: false };
  document.querySelectorAll('.ctrl').forEach((el) => {
    const key = el.dataset.key;
    const pointers = new Set();
    const sync = () => { touchHeld[key] = pointers.size > 0; el.classList.toggle('on', touchHeld[key]); };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); Sfx.ensure();
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* synthetic or stale pointer */ }
      pointers.add(e.pointerId); sync();
    });
    const up = (e) => { pointers.delete(e.pointerId); sync(); };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  const KEYMAP = {
    ArrowUp: 'gas', KeyW: 'gas', ArrowDown: 'brake', KeyS: 'brake',
    ArrowLeft: 'back', KeyA: 'back', ArrowRight: 'fwd', KeyD: 'fwd',
  };
  window.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    const k = KEYMAP[e.code];
    if (k) { keyInput[k] = true; e.preventDefault(); Sfx.ensure(); }
    if (e.code === 'KeyP' || e.code === 'Escape') { if (screen === 'game') setPaused(true); else if (screen === 'pause') setPaused(false); }
    if (e.code === 'KeyR' && race) startRace(levelIndex);
  });
  window.addEventListener('keyup', (e) => { const k = KEYMAP[e.code]; if (k) keyInput[k] = false; });
  window.addEventListener('blur', () => { for (const k in keyInput) keyInput[k] = false; if (screen === 'game') setPaused(true); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (screen === 'game') setPaused(true); if (Sfx.ctx) Sfx.ctx.suspend(); }
    else if (Sfx.ctx && save.sound) Sfx.ctx.resume();
  });
  document.addEventListener('pointerdown', () => Sfx.ensure(), { once: true });

  // Android back button: returns 'exit' when the app should close.
  window.handleBack = function () {
    if (screen === 'game') { setPaused(true); return 'ok'; }
    if (screen === 'pause') { setPaused(false); return 'ok'; }
    if (screen === 'result') { show('levels'); return 'ok'; }
    if (screen === 'menu') return 'exit';
    show('menu');
    return 'ok';
  };

  // ---------- Main loop ----------

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    update(dt);
    render();
    if (screen === 'garage') drawGarage();
    requestAnimationFrame(frame);
  }

  window.__moto = { get race() { return race; }, startRace, show, input, save: () => save };
  show('menu');
  requestAnimationFrame(frame);
})();
