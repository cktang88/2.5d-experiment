// Wave timing and early start, Q building costs (architect mode), laser cutter feedback, pause gating (was tests/ux_validation.py).
// @lock 1
// @steps 0
const key = (code) => { dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true })); dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 10000) => { const t = performance.now(); while (!f()) { if (performance.now() - t > ms) return false; await sleep(30); } await sleep(60); return true; };
const locked = () => document.pointerLockElement === game.canvas;
const visible = (s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(), c = getComputedStyle(e); return !e.classList.contains('hidden') && c.display !== 'none' && c.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
const g = game, wd = g.waveDirector, a = g.architect, W = innerWidth, H = innerHeight;
const alive = () => g.entities.enemies.filter((e) => !e.dead).length;
const res = () => ({ wood: g.inv.wood, stone: g.inv.stone, metal: g.inv.metal, goo: g.inv.goo });
const pickUpgrade = async () => {
  await until(() => !document.getElementById('upgrade').classList.contains('hidden'));
  const up = document.querySelector('#uplist .up'); if (!up) return false; up.click();
  return until(() => document.getElementById('upgrade').classList.contains('hidden') && locked());
};

// ---- opening peace and early start
g.step(.016);
check('new game starts in peace with the cutter selected', wd.phase === 'safe' && wd.wave === 0 && wd.remaining >= 119.5 && wd.remaining <= 120 && alive() === 0
  && document.querySelector('#objective').textContent.includes('2:00') && document.querySelector('#tool-cutter')?.classList.contains('sel'),
  { phase: wd.phase, wave: wd.wave, remaining: wd.remaining, alive: alive(), objective: document.querySelector('#objective').textContent });
wd.remaining = 120; // drop the real frames the page ran before the probe stopped its loop
g.simulate(1.0, 1 / 30);
check('first active second has no enemies', wd.phase === 'safe' && alive() === 0);
g.step(.016);
const early = document.getElementById('start-wave-early');
check('early wave offer is shown with its bonus', visible('#start-wave-early') && !early.disabled && /T · Start/.test(early.innerText) && /early/.test(early.innerText) && early.innerText.includes('+50%'), early.innerText);
const beforeEarly = res();
key('KeyT'); g.step(.016);
check('T starts wave 1', wd.phase === 'wave' && wd.wave === 1);
// wave members arrive a few per frame (Entities.updateWaveSpawns)
const { WaveDirector } = await import('/src/waveDirector.ts');
const size1 = WaveDirector.waveSize(1), size2 = WaveDirector.waveSize(2);
check('wave 1 queues its full size', alive() + g.entities.pendingWaveSpawns === size1, [alive(), g.entities.pendingWaveSpawns, size1]);
for (let i = 0; i < 20 && g.entities.pendingWaveSpawns; i++) g.step(.016);
const started = res();
check('early start begins the wave without an upfront reward', wd.rewardBonus > 0 && alive() === size1 && Object.keys(beforeEarly).every((k) => started[k] === beforeEarly[k]), { bonus: wd.rewardBonus, alive: alive(), started, beforeEarly });
key('KeyT');
check('T does not duplicate an active wave', wd.wave === 1 && alive() === size1 && !g.entities.pendingWaveSpawns);
g.ui.update(0);
check('early start offer hides during the wave', !visible('#start-wave-early'));
g.entities.enemies.forEach((e) => { e.dead = true; e.removeSprite(); }); g.step(.016);
const payout = res();
check('early reward is granted once on clear', wd.phase === 'rest' && wd.remaining === 120 && wd.rewardBonus > 0 && Object.keys(beforeEarly).every((k) => payout[k] > beforeEarly[k]), { phase: wd.phase, remaining: wd.remaining, payout, beforeEarly });
{ const s = wd.snapshot(); wd.restore(s); check('cleared wave bonus survives restore', wd.snapshot().rewardBonus === s.rewardBonus); }
check('upgrade picker resumes play', await pickUpgrade());

// ---- flat work site (in memory only)
const w = g.world, P = g.player.pos;
const X = Math.floor(P.x) + 7, Z = Math.floor(P.z) - 8;
w.generateAround(X, Z, 2);
let Y = 0;
for (let x = X - 12; x <= X + 12; x += 3) for (let z = Z - 12; z <= Z + 12; z += 3) Y = Math.max(Y, w.surfaceY(x, z));
Y += 2;
for (let x = X - 12; x <= X + 12; x++) for (let z = Z - 12; z <= Z + 12; z++) { w.set(x, Y - 1, z, 1); for (let y = Y; y <= Y + 18; y++) w.set(x, y, z, 0); }
w.set(X, Y - 1, Z - 3, 3);
for (const zz of [Z - 6, Z - 8]) for (let yy = Y; yy <= Y + 2; yy++) w.set(X + 9, yy, zz, 6); // two logs in a line
w.set(X + 9, Y + 2, Z - 4, 5); // bedrock
w.rebuildAround(X, Z, 2);
const pose = (x, y, z, tx, ty, tz) => { g.player.pos.set(x, y, z); g.player.vel.set(0, 0, 0); const dx = tx - x, dy = ty - (y + 1.55), dz = tz - z; g.camYaw = g.camYawT = Math.atan2(-dx, -dz); g.camPitch = Math.atan2(dy, Math.hypot(dx, dz)); g.updateCamera(0); g.updateAim(); g.updateReticle(); };
pose(X + .5, Y, Z + 2.5, X + .5, Y + 1.55, Z - 3);

// ---- Q building UI: a 7 x 2 block, 4 high, costs 56 planks
g.sandbox = false; g.freeBuild = false; g.inv.planks = 24;
key('KeyQ'); await until(() => a.open);
check('Q opens the building UI', a.open && visible('#arch') && !document.pointerLockElement);
step(20);
a.selectTool('box'); document.querySelector('#arch-opts [data-mat="planks"]').click();
a.height = 4; a.foundation = false; a.refresh();
let cur = [X - 3, Y, Z - 10];
a.pick = function () { this.hoverCell = cur; this.hoverSolid = [cur[0], cur[1] - 1, cur[2]]; this.hoverPoint = null; };
const dragBox = (from, to, commit) => {
  cur = from; mouse('mousedown', W / 2, H / 2); step(1); cur = to; step(2);
  const tip = document.getElementById('arch-tip').innerText, add = a.counts.add;
  if (commit) mouse('mouseup', W / 2, H / 2); else { mouse('mousedown', W / 2, H / 2, 2); mouse('mouseup', W / 2, H / 2, 2); mouse('mouseup', W / 2, H / 2); }
  step(1);
  return { tip, add };
};
const rem = wd.remaining;
let d = dragBox([X - 3, Y, Z - 10], [X + 3, Y, Z - 9], true);
check('7 x 2 x 4 block counts 56 planks and shows the shortage', d.add === 56 && /Need 56 planks; you have 24/.test(d.tip), d);
check('rejected build spends no materials', g.inv.planks === 24 && a.undoStack.length === 0, g.inv.planks);
a.timePaused = true; wd.remaining = .5; step(20);
check('paused building UI freezes the wave timer', wd.phase === 'rest' && wd.remaining === .5 && alive() === 0, wd.remaining);
a.timePaused = false; wd.remaining = rem;
key('KeyR'); check('R rotates in the building UI', a.rotation === 1, a.rotation);
g.inv.planks = 999; g.inv.bricks = 999;
d = dragBox([X - 3, Y, Z - 10], [X + 3, Y, Z - 9], true);
for (let i = 0; i < 40 && a.busy; i++) step(1);
let built = 0; for (let x = X - 3; x <= X + 3; x++) for (let z = Z - 10; z <= Z - 9; z++) for (let y = Y; y < Y + 4; y++) built += w.get(x, y, z) === 8 ? 1 : 0;
check('affordable 7 x 2 x 4 block spends 56 planks and builds 56 cells', g.inv.planks === 943 && built === 56 && a.undoStack.length === 1, { planks: g.inv.planks, built });
a.undo(); for (let i = 0; i < 40 && a.busy; i++) step(1);
check('undo refunds the planks', g.inv.planks === 999, g.inv.planks);
a.height = 3; d = dragBox([X - 4, Y, Z - 11], [X + 3, Y, Z - 4], false);
check('large 8 x 8 x 3 preview counts 192 blocks', d.add === 192 && a.undoStack.length === 0, d);
delete a.pick; a.rotation = 0;
a.exit(); await until(() => !a.open && locked());
step(20); // camera flies back to first person
g.inv.planks = 943;

// ---- laser cutter
key('KeyF'); pose(X + 9.5, Y, Z + .5, X + 9.5, Y + 1.55, Z - 6); g.updateAim(); g.updateActions(0); g.ui.update(0);
const ctx = () => document.getElementById('toolcontext').textContent; // (small screens hide the title and hint lines)
check('cutter context names the tool, range and hold action', visible('#toolcontext') && ctx().includes('LASER CUTTER') && ctx().includes('Hold LMB to cut') && ctx().includes('8 m range'), ctx());
check('cutter targets the nearest occluding log', g.laserTarget?.x === X + 9 && g.laserTarget?.z === Z - 6 && g.camera.position.distanceTo(g.laserTarget.point) <= 8, g.laserTarget && [g.laserTarget.x, g.laserTarget.z]);
mouse('mousedown', W / 2, H / 2); g.updateActions(.12); g.updateActions(0); g.ui.update(0);
const bar = document.querySelector('#toolcontext .toolprogress i');
check('held cut shows the beam and progress', g.laserBeam.visible && g.laserImpact.visible && Number(bar?.style.width.replace('%', '')) > 0, [g.laserBeam.visible, g.laserImpact.visible, bar?.style.width]);
mouse('mouseup', W / 2, H / 2);
const woodBefore = g.inv.wood;
g.input.lmb = true; g.simulate(.3, .05); g.input.lmb = false;
check('cutter damages the near log and not the far one', w.get(X + 9, Y + 1, Z - 6) === 6 && w.get(X + 9, Y + 1, Z - 8) === 6 && w.damage.get(w.idx(X + 9, Y + 1, Z - 6)) > 0 && !w.damage.get(w.idx(X + 9, Y + 1, Z - 8)));
g.updateAim(); g.input.lmb = true; g.updateActions(.12); g.input.lmb = false;
check('cutter collects wood when the target breaks', w.get(X + 9, Y + 1, Z - 6) === 0 && w.get(X + 9, Y + 1, Z - 8) === 6 && g.inv.wood > woodBefore, [w.get(X + 9, Y + 1, Z - 6), g.inv.wood, woodBefore]);
pose(X + 9.5, Y, Z + 4, X + 9.5, Y + 1.55, Z - 6); g.updateAim(); g.updateActions(0); g.ui.update(0);
check('cutter rejects targets past eight metres', ctx().includes('Out of range') && !g.laserBeam.visible, ctx());
pose(X + 9.5, Y + 2, Z - 1, X + 9.5, Y + 2.5, Z - 4); g.updateAim(); g.updateActions(0); g.ui.update(0);
check('cutter explains bedrock', ctx().includes('Bedrock cannot be cut'), ctx());

// ---- a finite wave through the game loop, then the intermission
g.player.pos.set(X + .5, Y, Z + 2); wd.remaining = .1; g.updateCamera(0); g.step(.2);
for (let i = 0; i < 40 && g.entities.pendingWaveSpawns; i++) g.step(.016);
check('expired rest spawns the next finite wave', wd.phase === 'wave' && wd.wave === 2 && alive() === size2, { phase: wd.phase, wave: wd.wave, alive: alive() });
g.entities.enemies.forEach((e) => { e.dead = true; e.removeSprite(); }); g.step(.016); g.ui.update(0);
check('clearing the last enemy starts a two minute intermission', wd.phase === 'rest' && wd.remaining === 120 && document.querySelector('#objective').textContent.includes('2:00'), [wd.phase, wd.remaining, document.querySelector('#objective').textContent]);
{
  const e = g.entities.enemies.length, t = g.timers.length; g.spawnBoss();
  check('a delayed boss retry cannot interrupt the intermission', wd.phase === 'rest' && g.entities.enemies.length === e && g.timers.length === t);
}
await pickUpgrade();
const shells = g.inv.shells, planks = g.inv.planks;
key('Escape'); await until(() => g.paused && !document.pointerLockElement);
wd.remaining = .5; g.step(1);
check('pause menu freezes the wave timer', wd.phase === 'rest' && wd.remaining === .5);
document.querySelector('#pause h1').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); document.querySelector('#pause h1').click(); g.step(.05);
check('menu clicks do not fire or spend', g.inv.planks === planks && g.inv.shells === shells && g.paused && g.input.lmb === false);
