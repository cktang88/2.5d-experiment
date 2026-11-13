// @url /?fast=1&test=1
// @steps 40
// CPU-only Game.step load fixture (was tests/performance_validation.py): a walled 65×65 castle yard with 48
// pinned enemies, 30 turrets of every kind, 24 traps and 12 glowsticks. Like the old script it asserts only
// the fixture counts (only 4 glowstick lights lit at once) and no page errors. Step times (p50/p95/max) are
// returned for comparison but not asserted: they swing with this shared machine's load.
// npm run e2e -- performance
const { B } = await import('/src/blocks.ts');
const { Turret } = await import('/src/entities.ts');
const g = game, w = g.world, p = g.player.pos;
g.autosaveT = 1e4; g.player.invuln = 1e4; g.waveDirector.phase = 'safe'; g.waveDirector.remaining = 1e4;
function measure() {
  for (let i = 0; i < 60; i++) g.step(1 / 60);
  const times = [];
  for (let i = 0; i < 120; i++) { const t = performance.now(); g.step(1 / 60); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  let objects = 0, lights = 0;
  g.scene.traverse((o) => { objects++; if (o.isLight) lights++; });
  return {
    p50_ms: +((times[59] + times[60]) / 2).toFixed(2), p95_ms: +times[113].toFixed(2), max_ms: +times[119].toFixed(2),
    enemies: g.entities.enemies.filter((e) => !e.dead).length, turrets: g.entities.turrets.length, traps: g.traps.traps.length, standingNonMines: g.traps.traps.filter((t) => t.id !== 'mine').length,
    glowsticks: g.glowsticks.sticks.length, activeGlowLights: g.glowsticks.lights.filter((l) => l.intensity > 0).length,
    sceneObjects: objects, sceneLights: lights, projectiles: g.projectiles.list.length,
  };
}
const baseline = measure();

let seed = 123456789;
const random = Math.random;
Math.random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
const X = Math.floor(p.x), Z = Math.floor(p.z);
w.generateAround(X, Z, 4);
let Y = 0;
for (let x = X - 32; x <= X + 32; x += 4) for (let z = Z - 32; z <= Z + 32; z += 4) Y = Math.max(Y, w.surfaceY(x, z));
Y += 3;
let blocks = 0;
for (let x = X - 32; x <= X + 32; x++) for (let z = Z - 32; z <= Z + 32; z++) {
  w.set(x, Y - 1, z, B.GRASS); blocks++;
  for (let y = Y; y < Y + 13; y++) w.set(x, y, z, B.AIR);
  if (Math.abs(x - X) >= 31 || Math.abs(z - Z) >= 31) for (let y = Y; y < Y + 12; y++) { w.set(x, y, z, B.STONE); blocks++; }
}
w.rebuildAround(X, Z, 4);
p.set(X + 0.5, Y, Z + 0.5); g.player.vel.set(0, 0, 0); g.entities.reset();
const ids = ['auto', 'cannon', 'twin', 'rocket', 'artillery'];
for (let i = 0; i < 30; i++) { const x = X - 25 + (i % 10) * 5, z = Z - 25 + Math.floor(i / 10) * 5; g.entities.turrets.push(new Turret(g, x + 0.5, Y, z + 0.5, ids[i % 5], i % 4)); }
const traps = ['spikes', 'arrow', 'flame', 'mine'];
Object.assign(g.inv, { spikeTrap: 20, arrowTrap: 20, flameTrap: 20, blastMine: 20 });
let trapFails = 0;
for (let i = 0; i < 24; i++) { const x = X - 23 + (i % 8) * 6, z = Z + 5 + Math.floor(i / 8) * 5; if (!g.traps.place(traps[i % 4], i % 4, x, Y, z)) trapFails++; }
check('all 24 traps placed', trapFails === 0, trapFails);
for (let i = 0; i < 48; i++) {
  const x = X - 22 + (i % 8) * 6 + 0.5, z = Z - 8 + Math.floor(i / 8) * 4 + 0.5, e = g.entities.spawnEnemy(i % 2 ? 'zombie' : 'brute', x, Y, z);
  e.hp = e.maxHp = 100000; e.damage = () => {};
  const update = e.update.bind(e), pos = e.pos.clone();
  e.update = (dt) => { update(dt); e.pos.copy(pos); e.vel.set(0, 0, 0); };
}
g.glowsticks.restore(Array.from({ length: 12 }, (_, i) => ({ pos: [X - 5 + i, Y + 0.2, Z + 0.5], vel: [0, 0, 0], remaining: 180 })));
const castle = measure();
Math.random = random;
check('48 pinned enemies alive after stepping', castle.enemies === 48, castle.enemies);
check('30 turrets', castle.turrets === 30, castle.turrets);
// blast mines are single-use: the fixture's pinned enemies stand within 2.5 m of some of them, so those go off
check('every non-mine trap still standing', castle.standingNonMines === 18, castle);
check('12 glowsticks', castle.glowsticks === 12, castle.glowsticks);
check('only 4 glowstick lights lit at once', castle.activeGlowLights === 4, castle.activeGlowLights);
return { baseline, castle, placedBlocks: blocks };
