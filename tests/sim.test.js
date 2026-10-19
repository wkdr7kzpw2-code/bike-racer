// Headless check: a simple autopilot must finish every level on the starter bike.
// Run: node tests/sim.test.js
const path = require('path');
require(path.join(__dirname, '../app/src/main/assets/core.js'));
const { Race, LEVELS, BIKES, angleDiff } = globalThis.MotoCore;

function autopilot(race) {
  const input = { gas: true, brake: false, back: false, fwd: false };
  const air = !race.rear.g && !race.front.g;
  const c = race.com();
  const omega = race.angularVelocity(c);
  // Aim for the slope of the ground below, anticipating the current spin.
  const vx = race.velocity().x;
  const ax = c.x + Math.max(0, vx) * 0.25;
  const g0 = race.level.groundAt(ax - 30), g1 = race.level.groundAt(ax + 30);
  const target = g0 !== null && g1 !== null ? Math.atan2(g1 - g0, 60) : 0;
  const predicted = race.angle + omega * (air ? 0.25 : 0.15);
  if (air) {
    if (predicted < target - 0.08) input.fwd = true;
    else if (predicted > target + 0.08) input.back = true;
  } else if (!race.front.g && predicted < target - 0.45) {
    input.fwd = true;
  } else if (race.front.g && !race.rear.g && predicted > target + 0.3) {
    input.back = true;
  }
  return input;
}

function run(levelIndex, bikeIndex) {
  const race = new Race(levelIndex, bikeIndex);
  const maxSteps = 120 * 180;
  while (race.steps < maxSteps && !race.crashed && !race.finished) race.step(autopilot(race));
  const c = race.com();
  return { race, x: Math.round(c.x) };
}

let failed = 0;
for (let b = 0; b < BIKES.length; b += BIKES.length - 1) {
  for (let i = 0; i < LEVELS.length; i++) {
    const { race, x } = run(i, b);
    const status = race.finished ? 'FINISH' : race.crashed ? 'CRASH' : 'TIMEOUT';
    console.log(`${BIKES[b].name.padEnd(9)} L${i + 1} ${LEVELS[i].name.padEnd(15)} ${status.padEnd(7)} t=${race.time.toFixed(1)}s par=${race.level.par}s x=${x}/${Math.round(race.level.finishX)} coins=${race.coinCount}/${race.level.coins.length} tricks=${race.trickScore}`);
    if (!race.finished) failed++;
  }
}
// Flip test: launch the bike in the air, hold lean back and expect a backflip to register.
{
  const race = new Race(0, 0);
  for (const p of race.parts) { p.y -= 600; p.py = p.y + 4; p.px = p.x - 3; }
  let t = 0;
  while (!race.crashed && race.events.every((e) => e.type !== 'trick') && t++ < 120 * 6) {
    const air = !race.rear.g && !race.front.g;
    const spun = Math.abs(race.airRot);
    const input = { gas: false, back: air && spun < Math.PI * 1.6, fwd: false };
    if (air && spun >= Math.PI * 1.6) Object.assign(input, autopilot(race), { gas: false });
    race.step(input);
  }
  const trick = race.events.find((e) => e.type === 'trick');
  console.log('Flip test:', trick ? `${trick.text} +${trick.pts}` : 'no trick', race.crashed ? '(crashed)' : '');
  if (!trick || !/Бэкфлип/.test(trick.text)) failed++;
}
process.exitCode = failed ? 1 : 0;
