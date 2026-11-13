// @url /?fast=1
// @steps 40
// Survival systems end to end in the real generated world (was tests/survival_validation.py): forage and
// wildlife, E harvesting with occlusion, health regen timing, pause, jetpack toggles and collisions, food and
// refining in the craft UI, architect room in free build and its free-build toggle, hunting, laser mining
// of natural ores, workbench laser upgrades and their tier-two damage/reach, and save/load of all of it.
// npm run e2e -- survival
const { B } = await import('/src/blocks.ts');
const g = game, w = g.world, p = g.player, a = g.architect, I = g.input;
const W = innerWidth, H = innerHeight;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (code) => { dispatchEvent(new KeyboardEvent('keydown', { code })); dispatchEvent(new KeyboardEvent('keyup', { code })); };
const hold = (code, fn) => { dispatchEvent(new KeyboardEvent('keydown', { code })); fn(); dispatchEvent(new KeyboardEvent('keyup', { code })); };
const lmb = (fn) => { mouse('mousedown', W / 2, H / 2); fn(); mouse('mouseup', W / 2, H / 2); };
const locked = () => document.pointerLockElement === g.canvas;
// Pointer lock: this journey relocks the mouse many times (pause, crafting, architect). Headless Chrome only
// grants requests without a user gesture for a few seconds after a real click and rate-limits them, so a
// stand-in with the browser's contract replaces it: requests and exits take effect asynchronously and fire
// pointerlockchange, and the game's own handlers decide when to lock, unlock or pause.
let lockEl = null;
const lockChanged = () => setTimeout(() => document.dispatchEvent(new Event('pointerlockchange')), 0);
Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => lockEl });
g.canvas.requestPointerLock = () => { if (lockEl !== g.canvas) { lockEl = g.canvas; lockChanged(); } return Promise.resolve(); };
document.exitPointerLock = () => { if (lockEl) { lockEl = null; lockChanged(); } };
const relocked = async () => { for (let i = 0; i < 10 && !(locked() && !g.paused); i++) await wait(50); return locked() && !g.paused; };
const resume = async () => { await wait(150); document.getElementById('resume').click(); return relocked(); };
const press = (sel, el = document.querySelector(sel)) => (el ? el.click() : check(`missing ${sel}`, false, document.querySelector('#craft')?.className));
const text = (sel) => document.querySelector(sel)?.textContent ?? '';
const face = (x, y, z) => { const dx = x - p.pos.x, dy = y - (p.pos.y + 1.55), dz = z - p.pos.z; g.camYaw = g.camYawT = Math.atan2(-dx, -dz); g.camPitch = Math.atan2(dy, Math.hypot(dx, dz)); g.updateCamera(0); g.updateAim(); };

await g.requestLook(); await wait(20);
check('game captures the mouse', locked());
{
  const r = (s) => document.querySelector(s).getBoundingClientRect(), A = r('#topleft'), b = r('#hint');
  check(`left HUD and tutorial do not overlap at ${W}×${H}`, A.bottom <= b.top || b.bottom <= A.top || A.right <= b.left || b.right <= A.left, { hud: [A.left, A.top, A.right, A.bottom], hint: [b.left, b.top, b.right, b.bottom] });
}
check('jetpack equipped on new game', g.jetpack && !g.jetpack.active);
check('free building defaults on', g.freeBuild === true);
g.foraging.update(0.1);
const nodes = g.foraging.targets;
check('natural forage exists on real hosts', nodes.some((x) => x.food === 'apple' && w.get(...x.host) === B.LEAVES) && nodes.some((x) => x.food === 'berries' && w.decorAt(...x.host) > 0), nodes.length);
check('peaceful wildlife is not in hostile waves', g.foraging.wildlife.length > 0 && g.foraging.wildlife.every((x) => !g.entities.enemies.includes(x) && ['deer', 'boar'].includes(x.kind)), g.foraging.wildlife.map((x) => x.kind));
check('a generated apple has a clear view', (() => {
  for (const n of nodes.filter((n) => n.food === 'apple')) for (const [x, y, z] of [[0, -2, 0], [2, -1, 0], [-2, -1, 0], [0, -1, 2], [0, -1, -2], [2, 0, 0], [-2, 0, 0], [0, 0, 2], [0, 0, -2]]) {
    const q = n.position, e = q.clone().add({ x, y, z }), d = q.clone().sub(e), l = d.length(); d.normalize();
    const hit = w.raycast(e, d, l);
    if (!hit.hit || hit.t >= l - 0.15) return true;
  }
  return false;
})());

// E harvesting: a wall in between blocks it, then the natural berry bush is gathered
const berry = nodes.find((n) => n.food === 'berries');
{
  const q = berry.position, y = Math.floor(q.y);
  for (let x = Math.floor(q.x) - 3; x < Math.floor(q.x); x++) for (let yy = y - 1; yy <= y + 2; yy++) w.set(x, yy, Math.floor(q.z), B.AIR);
  p.pos.set(q.x - 2, q.y - 1.45, q.z); p.vel.set(0, 0, 0); p.aimDir.set(1, 0, 0);
  w.set(Math.floor(q.x) - 1, y, Math.floor(q.z), B.COBBLE);
  key('KeyE');
  check('wall blocks E harvesting', g.foraging.targets.includes(berry));
  w.set(Math.floor(q.x) - 1, y, Math.floor(q.z), B.AIR); p.aimDir.set(1, 0, 0);
  check('berry is interactable without the wall', g.forageTarget()?.node === berry);
  key('KeyE');
  check('E harvests natural berries into inventory', !g.foraging.targets.includes(berry) && g.inv.berries >= berry.amount && g.foraging.snapshot().harvested.includes(berry.id));
}

// health regeneration
g.entities.enemies.forEach((e) => e.removeSprite?.()); g.entities.enemies = [];
p.pos.copy(g.spawnPoint); p.pos.y = w.surfaceY(Math.floor(p.pos.x), Math.floor(p.pos.z)) + 0.1; p.vel.set(0, 0, 0);
p.hp = 100; p.maxHp = 100; p.invuln = 0; p.burn = 0; p.dead = false; p.healthRegen.reset(); p.damage(20); g.hitstopT = 0;
check('accepted hit damages and starts eight second delay', p.hp === 80 && p.healthRegen.delayRemaining === 8, [p.hp, p.healthRegen.delayRemaining]);
g.simulate(4, 1 / 30); p.invuln = 1; p.damage(5); g.hitstopT = 0;
check('invulnerable hit leaves delay and health untouched', p.hp === 80 && Math.abs(p.healthRegen.delayRemaining - 4) < 0.04, [p.hp, p.healthRegen.delayRemaining]);
g.simulate(3.9, 1 / 30);
check('no healing during delay', p.hp === 80, p.hp);
g.simulate(1.1, 1 / 30);
check('passive heals one HP per second after delay', Math.abs(p.hp - 81) < 0.08, p.hp);
p.burn = 10; g.simulate(1, 1 / 30);
check('burning stops healing', p.hp <= 81, p.hp);
p.burn = 0; p.invuln = 999; p.hp = 99.5; p.healthRegen.delayRemaining = 0; p.regenerate(1);
check('healing caps at max HP', p.hp === 100, p.hp);

// pause and the jetpack
p.hp = 80; p.healthRegen.delayRemaining = 0;
key('Escape');
check('Escape pauses', g.paused);
g.step(2);
check('pause stops healing and flight input', p.hp === 80 && !g.jetpack.active);
key('KeyZ');
check('paused Z does not toggle flight', !g.jetpack.active);
check('resume relocks the mouse', await resume());
key('KeyZ');
check('Z activates jetpack', g.jetpack.active);
hold('Space', () => g.simulate(1, 1 / 30));
check('space climbs with flight', p.vel.y > 0, p.vel.y);
hold('ControlLeft', () => g.simulate(1, 1 / 30));
check('control descends with flight', p.vel.y < 0, p.vel.y);
key('KeyZ');
check('Z deactivates jetpack', !g.jetpack.active);
key('Space'); key('Space');
check('double space activates jetpack', g.jetpack.active);
key('Space'); key('Space');
check('double space deactivates jetpack', !g.jetpack.active);

// food and refining through the craft UI
p.hp = 50; p.burn = 0; w.burning.clear(); p.healthRegen.delayRemaining = 8; p.healthRegen.foodHealing = 0;
Object.assign(g.inv, { apple: 4, metal: 100, iron: 100, copper: 100, coal: 10, goo: 100, stone: 100 });
key('Tab'); await wait(150);
check('Tab opens crafting', g.ui.craftOpen && !locked());
const tab = (id) => press(`[data-craft-tab="${id}"]`);
const recipe = (name) => press(`recipe ${name}`, [...document.querySelectorAll('#craftlist .recipe')].find((e) => e.textContent.includes(name)));
tab('craft');
check('food UI lists timed healing', text('#food-controls').includes('2 HP/s'), text('#food-controls'));
const refining = text('#craftlist').includes('Refine Iron');
tab('upgrades');
check('ore inventory and refining recipes appear', refining && ['Iron 100', 'Copper 100', 'Coal 10'].every((x) => text('#ore-inventory').includes(x)), text('#ore-inventory'));
tab('craft');
recipe('Refine Iron'); recipe('Refine Copper');
check('refining consumes ore and coal and produces metal', g.inv.iron === 98 && g.inv.copper === 98 && g.inv.coal === 8 && g.inv.metal === 105, [g.inv.iron, g.inv.copper, g.inv.coal, g.inv.metal]);
g.inv.coal = 0; recipe('Refine Iron');
check('refining without coal spends nothing', g.inv.iron === 98 && g.inv.coal === 0 && g.inv.metal === 105);
Object.assign(g.inv, { iron: 100, copper: 100, metal: 100, coal: 8 });
g.ui.refreshCraft?.();
press('#food-controls [data-food="apple"]');
check('food click consumes one and queues without instant healing', g.inv.apple === 3 && p.hp === 50 && p.healthRegen.foodHealing === 10, [g.inv.apple, p.hp, p.healthRegen.foodHealing]);
tab('upgrades');
press('#laser-upgrades [data-upgrade="reach"]');
check('away from a bench a laser upgrade cannot be bought', g.laserLevels.reach === 0 && g.inv.metal === 100);
key('Tab');
check('Tab closes crafting and relocks', !g.ui.craftOpen && await relocked());
g.slowmo = 1; g.simulate(1, 1 / 30);
check('food heals over time', p.hp > 51.9 && p.hp < 52.2 && p.healthRegen.foodHealing < 8.1, { hp: p.hp, food: p.healthRegen.foodHealing, burn: p.burn, paused: g.paused, dead: p.dead, slowmo: g.slowmo, craft: g.ui.craftOpen, explore: g.explore, big: g.minimap.bigOpen, hit: g.hitstopT });
p.hp = 95; p.healthRegen.foodHealing = 10;
key('KeyJ');
check('queued healing covering need rejects food', g.inv.apple === 3);

// a flat in-memory site next to the player for building, collisions and the laser
const X = Math.floor(p.pos.x) + 12, Z = Math.floor(p.pos.z) - 12;
let Y = 0;
for (let x = X - 12; x <= X + 12; x += 3) for (let z = Z - 12; z <= Z + 12; z += 3) Y = Math.max(Y, w.surfaceY(x, z));
Y += 2;
for (let x = X - 12; x <= X + 12; x++) for (let z = Z - 12; z <= Z + 12; z++) { w.set(x, Y - 1, z, B.STONE); for (let y = Y; y <= Y + 12; y++) w.set(x, y, z, B.AIR); }

// architect room in free build with no planks (Q opens the architect; its top bar holds the free-build toggle)
p.pos.set(X + 0.5, Y, Z + 8.5); p.vel.set(0, 0, 0); g.inv.planks = 0; // outside the room, or its cells are skipped
key('KeyQ'); await wait(150); step(2);
check('Q opens the architect with free build on', a.open && document.querySelector('#arch [data-act="free"]').checked);
a.material = { id: 'planks', name: 'Planks', block: B.PLANKS, cost: 'planks' };
Object.assign(a, { tool: 'room', height: 5, roof: true, door: true, foundation: false });
const room = a.makePlan([X - 4, Y, Z - 4], [X + 3, Y, Z + 3], Y);
a.plan = room; a.count(room, true);
const roomCells = a.counts.add;
check('zero-resource room plan is valid with free build', !room.error && roomCells > 100, { error: room.error, roomCells });
a.commit(); for (let i = 0; i < 100 && a.busy; i++) step(1);
const op = a.undoStack.at(-1);
check('free room placed with no planks', g.inv.planks === 0 && op && op.next.length === roomCells && op.next.every((v) => v === B.PLANKS), { planks: g.inv.planks, placed: op?.next.length, roomCells, kinds: [...new Set(op?.next ?? [])] });
a.undo(); for (let i = 0; i < 100 && a.busy; i++) step(1);
press('#arch [data-act="free"]');
check('architect free-build toggle turns it off', g.freeBuild === false);
a.exit();
check('leaving the architect relocks the mouse', !a.open && await relocked());
step(2);

// flight collides with walls and ceilings
for (let x = X + 7; x <= X + 9; x++) for (let y = Y; y <= Y + 5; y++) w.set(x, y, Z - 2, B.COBBLE);
for (let x = X + 7; x <= X + 9; x++) for (let z = Z - 1; z <= Z + 3; z++) w.set(x, Y + 4, z, B.COBBLE);
p.pos.set(X + 8.5, Y, Z + 1.5); p.vel.set(0, 0, 0); g.camYaw = g.camYawT = 0; g.camPitch = 0; g.jetpack.active = true;
hold('KeyW', () => g.simulate(1, 1 / 30));
check('flight collides with solid wall', p.pos.z >= Z - 0.69, p.pos.z - Z);
hold('Space', () => g.simulate(1, 1 / 30));
check('flight collides with ceiling', p.pos.y + p.h <= Y + 4.001, p.pos.y + p.h - Y);

// hunting with the pistol
const prey = g.foraging.wildlife.find((x) => !x.dead);
prey.pos.set(X + 8.5, Y, Z + 5.5); prey.vel.set(0, 0, 0);
g.jetpack.active = false;
p.pos.set(X + 8.5, Y, Z + 8.5); p.vel.set(0, 0, 0); g.camera.position.set(X + 8.5, Y + 1, Z + 8.5); p.aimDir.set(0, 0, -1);
g.select(0); g.fireCd = 0;
for (let i = 0; i < 4; i++) { g.fireCd = 0; p.aimDir.set(0, 0, -1); I.lmbPressed = true; g.updateActions(0.016); g.projectiles.update(0.1); I.lmbPressed = false; }
check('pistol shots kill peaceful wildlife and drop meat', prey.dead && g.entities.pickups.some((k) => k.res === 'meat'), { dead: prey.dead, hp: prey.hp });
const meat = g.entities.pickups.find((k) => k.res === 'meat');
if (meat) { p.pos.set(meat.m.position.x, meat.m.position.y - 0.8, meat.m.position.z); meat.t = 0.5; g.entities.update(0.016); }
check('dropped meat is picked up', g.inv.meat > 0, g.inv.meat);

// the laser cuts each natural ore and grants ore plus stone
const found = {};
{
  const px = Math.floor(p.pos.x), pz = Math.floor(p.pos.z);
  outer: for (let x = px - 64; x <= px + 64; x++) for (let z = pz - 64; z <= pz + 64; z++) {
    if (!w.isGenerated(x, z)) continue;
    for (let y = 4; y <= Math.min(35, w.surfaceY(x, z) - 6); y++) { const t = w.get(x, y, z); if (t >= 20 && t <= 22 && !found[t]) found[t] = [x, y, z]; }
    if (Object.keys(found).length === 3) break outer;
  }
}
check('all three ores occur naturally underground', [20, 21, 22].every((t) => found[t]), Object.keys(found));
for (const [ore, res] of [[20, 'copper'], [21, 'iron'], [22, 'coal']]) {
  const xyz = found[ore];
  if (!xyz) continue;
  const [x, y, z] = xyz, before = { ore: g.inv[res] | 0, stone: g.inv.stone | 0 };
  for (let zz = z + 1; zz <= z + 4; zz++) for (let yy = y - 2; yy <= y + 2; yy++) w.set(x, yy, zz, B.AIR);
  p.pos.set(x + 0.5, y - 1.05, z + 3.5); p.vel.set(0, 0, 0); g.camYaw = g.camYawT = 0; g.camPitch = 0; g.updateCamera(0); g.updateAim();
  key('KeyF');
  lmb(() => g.updateActions(2));
  check(`laser mines natural ${res} and grants ore plus stone`, w.get(x, y, z) === B.AIR && g.inv[res] === before.ore + 2 && g.inv.stone === before.stone + 1, { block: w.get(x, y, z), ore: g.inv[res] - before.ore, stone: g.inv.stone - before.stone });
}

p.pos.set(X + 8.5, Y, Z + 8.5); p.vel.set(0, 0, 0);

// a workbench (registered like an architect-placed one) enables laser upgrades
const benchCell = [Math.floor(p.pos.x) + 1, Math.floor(p.pos.y), Math.floor(p.pos.z)];
w.set(...benchCell, B.COBBLE); g.construction.registerBench(benchCell, B.COBBLE);
check('workbench is reachable', g.construction.nearWorkbench());
Object.assign(g.inv, { iron: 100, copper: 100, goo: 100, stone: 100 });
key('Tab'); await wait(150); tab('upgrades');
check('laser UI shows baseline, next stats and price', ['8 HP/s', '10 HP/s', '8 m', '12 m', 'iron', 'copper'].every((x) => text('#laser-upgrades').includes(x)), text('#laser-upgrades'));
press('#laser-upgrades [data-upgrade="power"]');
press('#laser-upgrades [data-upgrade="reach"]');
check('workbench buys upgrades at displayed costs', g.laserLevels.power === 1 && g.laserLevels.reach === 1 && g.inv.iron === 96 && g.inv.copper === 96 && g.inv.goo === 97 && g.inv.stone === 96, { ...g.laserLevels, iron: g.inv.iron, copper: g.inv.copper, goo: g.inv.goo, stone: g.inv.stone });
press('#laser-upgrades [data-upgrade="power"]');
press('#laser-upgrades [data-upgrade="reach"]');
check('both upgrades stop at tier two', g.laserLevels.power === 2 && g.laserLevels.reach === 2 && text('#laser-upgrades').includes('16 m'), text('#laser-upgrades'));
key('Tab');
check('crafting closed and mouse relocked', !g.ui.craftOpen && await relocked());
g.construction.onBlockRemoved(...benchCell);

// tier-two beam damage and reach on a clear range
for (let z = Z - 10; z <= Z + 11; z++) for (let y = Y; y <= Y + 3; y++) w.set(X + 8, y, z, B.AIR);
w.set(X + 8, Y + 1, Z - 4, B.COBBLE); w.set(X + 8, Y + 1, Z - 9, B.COBBLE);
p.pos.set(X + 8.5, Y, Z + 10.5); p.vel.set(0, 0, 0); g.camYaw = g.camYawT = 0; g.camPitch = 0; g.mods.mine = 1; g.updateCamera(0); g.updateAim();
key('KeyF');
lmb(() => g.updateActions(0.25));
const dmg = (z) => w.damage.get(w.idx(X + 8, Y + 1, z));
check('tier two power applies 12 HP per second beyond 12 m', Math.abs(dmg(Z - 4) - 3) < 0.001, { dmg: dmg(Z - 4), sel: g.hotbar[g.sel].id, t: g.laserTarget && [g.laserTarget.x - X, g.laserTarget.y - Y, g.laserTarget.z - Z], lock: locked(), paused: g.paused, craft: g.ui.craftOpen });
lmb(() => { g.updateActions(2); g.updateAim(); g.updateActions(2); });
check('tier two reach cuts within 16 m but not beyond', w.get(X + 8, Y + 1, Z - 4) === B.AIR && w.get(X + 8, Y + 1, Z - 9) === B.COBBLE && !dmg(Z - 9), { near: w.get(X + 8, Y + 1, Z - 4), far: w.get(X + 8, Y + 1, Z - 9) });

// flight at the top of the world, and pausing mid-flight
p.pos.y = w.H - p.h - 0.1; p.vel.set(0, 0, 0); g.jetpack.active = true;
hold('Space', () => g.simulate(0.5, 1 / 30));
check('flight respects the world ceiling', p.pos.y + p.h <= w.H + 0.001, p.pos.y + p.h - w.H);
key('Escape');
const pauseY = p.pos.y; g.step(1);
check('active flight freezes while paused', g.paused && g.jetpack.active && p.pos.y === pauseY);
check('resume relocks after flight pause', await resume(), { paused: g.paused, lock: locked(), dead: p.dead, hp: p.hp });

// save / load keeps food, flight, upgrades, the build setting, harvests, dropped food and wildlife cooldowns
p.pos.set(X + 8.5, Y, Z + 8.5); p.vel.set(0, 0, 0);
p.healthRegen.foodHealing = 7; p.healthRegen.delayRemaining = 5; g.inv.apple = 2; g.jetpack.active = true;
g.entities.addPickup('meat', 1, p.pos.x + 2, p.pos.y + 1, p.pos.z);
check('killed wildlife cooldown appears in save state', g.foraging.snapshot().animalCooldown.some((c) => c[0] === prey.spawnId));
await g.save('manual');
p.healthRegen.foodHealing = 0; g.laserLevels.power = 0; g.freeBuild = true; g.jetpack.active = false; g.inv.apple = 0;
await g.quickLoad();
check('save/load preserves food, flight, upgrades, build setting and harvests', p.healthRegen.foodHealing === 7 && p.healthRegen.delayRemaining === 5 && g.inv.apple === 2 && g.jetpack.active && !g.freeBuild && g.laserLevels.power === 2 && g.laserLevels.reach === 2 && g.foraging.snapshot().harvested.includes(berry.id),
  { food: p.healthRegen.foodHealing, delay: p.healthRegen.delayRemaining, apple: g.inv.apple, jet: g.jetpack.active, free: g.freeBuild, laser: g.laserLevels });
check('save/load restores dropped food and wildlife cooldown', g.entities.pickups.some((k) => k.res === 'meat') && g.foraging.snapshot().animalCooldown.some((c) => c[0] === prey.spawnId));
