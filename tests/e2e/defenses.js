// @url /?fast=1&test=1
// @lock 1
// Defense picker, placement rules, range rings, the five turret types firing, MLRS salvos, heavy blasts,
// workbench crafting, E reloads, and save/load of typed turrets. Ported from tests/defense_validation.py.
const mods = await import('/src/defenses.ts'), place = await import('/src/defensePlacement.ts'), ents = await import('/src/entities.ts');
const g = game, w = g.world, W = innerWidth, H = innerHeight;
const V3 = g.player.pos.constructor;
const key = (code) => dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
const click = () => { mouse('mousedown', W / 2, H / 2); g.updateActions(.016); mouse('mouseup', W / 2, H / 2); };

// flat supported site
const p = g.player.pos, X = Math.floor(p.x) + 12, Z = Math.floor(p.z) - 12;
w.generateAround(X, Z, 3);
let Y = 0; for (let x = X - 14; x <= X + 14; x += 3) for (let z = Z - 14; z <= Z + 14; z += 3) Y = Math.max(Y, w.surfaceY(x, z)); Y += 3;
for (let x = X - 14; x <= X + 14; x++) for (let z = Z - 14; z <= Z + 14; z++) { w.set(x, Y - 1, z, 1); for (let y = Y; y <= Y + 12; y++) w.set(x, y, z, 0); }
w.rebuildAround(X, Z, 2);
p.set(X - 5, Y, Z + 6); g.player.vel.set(0, 0, 0); g.jetpack.active = true;
g.entities.enemies = []; g.entities.turrets = [];
Object.assign(g.inv, { metal: 100, stone: 100, wood: 100, goo: 100, turret: 5, cannonTurret: 5, twinTurret: 5, rocketTurret: 5, artilleryTurret: 5 });
check('pointer lock held', document.pointerLockElement === g.canvas);

// picker in the craft panel
g.ui.toggleCraft(true);
document.querySelector('[data-craft-tab="defenses"]').click();
check('all five defense choices visible', document.querySelectorAll('#defense-picker [data-defense]').length === 5);
document.querySelector('#defense-picker [data-defense="artillery"]').click();
check('picker selects artillery', g.defenseId === 'artillery');
g.ui.toggleCraft(false);

// placement validation
check('all footprints validate and rotate in open supported area', Object.keys(mods.DEFENSES).every(id => [0, 1].every(r => !place.validateDefensePlacement(g, id, r, X, Y, Z))));
{
  w.set(X + 2, Y - 1, Z + 2, 0); const a = place.validateDefensePlacement(g, 'artillery', 0, X, Y, Z);
  w.set(X + 2, Y - 1, Z + 2, 1); w.set(X + 2, Y + 2, Z + 2, 3); const b = place.validateDefensePlacement(g, 'artillery', 0, X, Y, Z);
  w.set(X + 2, Y + 2, Z + 2, 0);
  check('missing support and upper obstruction are rejected', !!a && !!b, [a, b]);
  const old = p.clone(); p.set(X + 2.5, Y, Z + 2.5); const r = place.validateDefensePlacement(g, 'artillery', 0, X, Y, Z); p.copy(old);
  check('actor overlap rejects full footprint', !!r);
}
g.selectDefense('artillery'); g.hover = { x: X, y: Y - 1, z: Z, nx: 0, ny: 1, nz: 0 }; g.updateActions(.016);
{
  // the max ring is the 3D range that reaches the ground under the footprint (commit 3696f41), so it is
  // exactly 90 only when the site sits on the terrain; this raised site is above it
  const ring = mods.defenseRings('artillery', 0, X, Y, Z, Math.floor(w.gen.heightAt(X, Z)) + 1);
  check('artillery preview shows both correctly scaled ranges', g.rangeRing.visible && g.minRangeRing.visible && Math.abs(g.rangeRing.scale.x - ring.range) < 1e-9 && Math.abs(ring.range - Math.sqrt(90 * 90 - ring.drop * ring.drop)) < 1e-9 && ring.range > 0 &&
    g.minRangeRing.scale.x === 18 && g.rangeRing.position.x === X + 2 && g.rangeRing.position.z === Z + 2,
    { scale: g.rangeRing.scale.x, expect: ring.range, min: g.minRangeRing.scale.x, pos: [g.rangeRing.position.x, g.rangeRing.position.z], site: [X, Z] });
}

// placing with the real mouse button
w.set(X + 2, Y - 1, Z + 2, 0); g.fireCd = 0; g.hover = { x: X, y: Y - 1, z: Z, nx: 0, ny: 1, nz: 0 };
click();
check('failed real click consumes no item', g.inv.artilleryTurret === 5 && g.entities.turrets.length === 0);
w.set(X + 2, Y - 1, Z + 2, 1); g.fireCd = 0; g.hover = { x: X, y: Y - 1, z: Z, nx: 0, ny: 1, nz: 0 };
click();
check('successful real click places one artillery and spends one', g.inv.artilleryTurret === 4 && g.entities.turrets.length === 1 && g.entities.turrets[0].defenseId === 'artillery', [g.inv.artilleryTurret, g.entities.turrets.length]);
g.select(0); g.updateActions(.016);
check('range circles hide after leaving placement', !g.rangeRing.visible && !g.minRangeRing.visible);

for (const [i, id] of ['auto', 'cannon', 'twin', 'rocket'].entries()) g.entities.turrets.push(new ents.Turret(g, X - 10 + i * 4, Y, Z - 5, id));
check('five defense types have distinct model structures', new Set(g.entities.turrets.map(t => { let n = 0; t.grp.traverse(o => { if (o.isMesh) n += o.geometry.attributes.position.count; }); return n; })).size === 5);
for (const t of g.entities.turrets) t.disposeModel(); g.entities.turrets = [];

// real turret updates and projectile flight against stationary brutes
for (const id of ['auto', 'cannon', 'twin', 'rocket', 'artillery']) {
  g.projectiles.reset(); g.entities.enemies = [];
  for (let x = X - 4; x <= X + 4; x++) for (let z = Z + 7; z <= Z + 14; z++) w.set(x, Y - 1, z, 1);
  const t = new ents.Turret(g, X + .5, Y, Z - 8, id);
  const e = g.entities.spawnEnemy('brute', X + .5, Y, Z + (id === 'auto' ? 5 : 12)); e.vel.set(0, 0, 0); e.hp = e.maxHp = 1000;
  t.yaw = 0; const before = t.ammo;
  for (let i = 0; i < 100 && (t.ammo === before || (id === 'rocket' && t.salvoAim)); i++) t.update(.05);
  const shot = g.projectiles.list.map(q => q.type), after = t.ammo, cd = t.cd;
  for (let i = 0; i < 300 && g.projectiles.list.length; i++) g.projectiles.update(.01);
  const hp = e.hp; t.disposeModel(); e.dead = true;
  const expected = id === 'artillery' ? 'shell' : id === 'rocket' ? 'rocket' : id === 'cannon' || id === 'twin' ? 'cannon' : 'bullet';
  check(`${id} fires and damages hostile`, after === before - (id === 'rocket' ? 4 : 1) && shot.includes(expected) && hp < 1000, { shot, before, after, hp });
  check(`${id} starts reload after firing`, cd > 0, cd);
}
{
  const t = new ents.Turret(g, X + .5, Y, Z - 8, 'artillery'), e = g.entities.spawnEnemy('brute', X + .5, Y, Z - 3);
  const near = !t.canSee(e, 90 * 90); e.pos.z = Z + 12; const clear = t.canSee(e, 90 * 90);
  for (let x = X - 2; x <= X + 2; x++) for (let z = Z - 10; z <= Z - 3; z++) w.set(x, Y + 3, z, 3);
  const roof = !t.canSee(e, 90 * 90);
  for (let x = X - 2; x <= X + 2; x++) for (let z = Z - 10; z <= Z - 3; z++) w.set(x, Y + 3, z, 0);
  e.pos.z = Z + 100; const far = !t.canSee(e, 90 * 90); t.disposeModel(); e.dead = true;
  check('range limits and voxel obstruction gate targeting', near && clear && roof && far, { near, clear, roof, far });
}
{
  const t = new ents.Turret(g, X + .5, Y, Z - 8, 'cannon'), e = g.entities.spawnEnemy('brute', X + .5, Y, Z + 5);
  for (let x = X - 2; x <= X + 2; x++) for (let y = Y; y <= Y + 4; y++) w.set(x, y, Z - 1, 3);
  const blocked = !t.canSee(e, 32 * 32);
  for (let x = X - 2; x <= X + 2; x++) for (let y = Y; y <= Y + 4; y++) w.set(x, y, Z - 1, 0);
  const clear = t.canSee(e, 32 * 32); t.disposeModel(); e.dead = true;
  check('direct cannon cannot target through wall', blocked && clear, { blocked, clear });
}
{
  g.projectiles.reset(); g.entities.enemies = [];
  const t = new ents.Turret(g, X + .5, Y, Z - 8, 'rocket'), e = g.entities.spawnEnemy('brute', X + .5, Y, Z + 12); e.vel.set(0, 0, 0);
  const start = t.ammo, shots = []; let time = 0;
  for (let i = 0; i < 100; i++) {
    t.update(.02); time += .02;
    while (shots.length < g.projectiles.list.length) { const q = g.projectiles.list[shots.length]; shots.push({ time, pos: q.pos.toArray(), dir: q.vel.clone().normalize().toArray() }); if (shots.length === 1) e.dead = true; }
  }
  const spent = start - t.ammo, cd = t.cd; t.disposeModel(); g.projectiles.reset();
  check('MLRS fires four staggered rounds after target dies and waits for reload', shots.length === 4 && spent === 4 && cd > 0 && shots.slice(1).every((b, i) => b.time - shots[i].time >= .17), { n: shots.length, spent, cd, times: shots.map(s => s.time) });
  const key3 = (a) => a.map(x => x.toFixed(3)).join();
  check('MLRS rounds use four distinct muzzles and spread directions', new Set(shots.map(s => key3(s.pos))).size === 4 && new Set(shots.map(s => key3(s.dir))).size === 4);
}
{
  g.projectiles.reset(); g.entities.enemies = [];
  for (let x = X - 4; x <= X + 4; x++) for (let z = Z + 7; z <= Z + 14; z++) w.set(x, Y - 1, z, 1);
  const t = new ents.Turret(g, X + .5, Y, Z - 8, 'rocket'), e = g.entities.spawnEnemy('crawler', X + .5, Y, Z + 12); e.vel.set(0, 0, 0);
  let nearHits = 0; const ray = w.raycast;
  w.raycast = function (o, d, l, ...rest) { const r = ray.call(this, o, d, l, ...rest); if (r.hit && r.point.y <= Y + .05 && r.point.distanceTo(e.center(new V3())) < 5) nearHits++; return r; };
  let shots = 0;
  try { for (let i = 0; i < 150; i++) t.update(.02); shots = g.projectiles.list.length; for (let i = 0; i < 300 && g.projectiles.list.length; i++) g.projectiles.update(.01); } finally { w.raycast = ray; }
  const spent = 60 - t.ammo; t.disposeModel(); e.dead = true; g.projectiles.reset();
  check('MLRS launches full ground-target salvo when spread strikes nearby ground', shots === 4 && spent === 4 && nearHits > 0, { shots, spent, nearHits });
}
{
  g.projectiles.reset(); g.entities.enemies = [];
  const t = new ents.Turret(g, X + .5, Y, Z - 8, 'rocket'), e = g.entities.spawnEnemy('brute', X + .5, Y, Z + 12);
  for (let i = 0; i < 80 && t.ammo === 60; i++) t.update(.02);
  const first = t.ammo;
  for (let x = X - 2; x <= X + 2; x++) for (let y = Y; y <= Y + 4; y++) w.set(x, y, Z - 5, 3);
  for (let i = 0; i < 40; i++) t.update(.02);
  const ok = first === 59 && t.ammo === 59;
  for (let x = X - 2; x <= X + 2; x++) for (let y = Y; y <= Y + 4; y++) w.set(x, y, Z - 5, 0);
  check('MLRS nearby wall stops remaining rockets without spending ammunition', ok, [first, t.ammo]);
  t.disposeModel(); e.dead = true; g.projectiles.reset();
}
{
  const t = new ents.Turret(g, X + .5, Y, Z - 8, 'rocket');
  t.salvoAim = t.pos.clone().add({ x: 0, y: 1, z: 15 }); t.salvoIndex = 1; t.ammo = 0; t.update(.02); const dry = !t.salvoAim;
  t.salvoAim = t.pos.clone(); t.dead = true; t.update(.02); const dead = !t.salvoAim; t.disposeModel();
  check('dry or destroyed battery cancels pending salvo', dry && dead, { dry, dead });
}
{
  for (let x = X - 3; x <= X + 3; x++) for (let z = Z - 3; z <= Z + 3; z++) { w.set(x, Y - 1, z, 1); w.set(x, Y - 2, z, 3); }
  w.set(X, Y, Z, 8); w.set(X, Y - 3, Z, 5);
  let calls = 0; const original = g.checkSupport;
  g.checkSupport = function (c) { calls++; return original.call(this, c); };
  try { g.projectiles.defenseBlast(new V3(X + .5, Y + .5, Z + .5), 350, 5); } finally { g.checkSupport = original; }
  const got = [w.get(X, Y, Z), w.get(X, Y - 1, Z), w.get(X, Y - 2, Z), w.get(X, Y - 3, Z), calls];
  check('heavy blast craters grass and stone, breaks wall, and leaves bedrock', got[0] !== 8 && got[1] !== 1 && got[2] !== 3 && got[3] === 5 && calls === 1, got);
  // restore the site floor for the rest of the journey
  for (let x = X - 6; x <= X + 6; x++) for (let z = Z - 6; z <= Z + 6; z++) { w.set(x, Y - 1, z, 1); for (let y = Y; y <= Y + 8; y++) w.set(x, y, z, 0); }
}

// craft at a controlled workbench through the real recipe button
{
  const c = [Math.floor(p.x) + 1, Math.floor(p.y), Math.floor(p.z)];
  w.set(...c, 3); g.construction.registerBench(c, 3);
  Object.assign(g.inv, { metal: 100, stone: 100, wood: 100, goo: 100 });
  g.ui.toggleCraft(true);
  document.querySelector('[data-craft-tab="craft"]').click();
  const btn = [...document.querySelectorAll('#craftlist .recipe')].find(b => b.textContent.includes('Rocket battery'));
  check('workbench is in reach', g.construction.nearWorkbench());
  btn?.click();
  check('workbench recipe spends exact materials and selects rocket', g.defenseId === 'rocket' && g.inv.rocketTurret === 6 && g.inv.metal === 90 && g.inv.stone === 95 && g.inv.goo === 97,
    { id: g.defenseId, rocket: g.inv.rocketTurret, metal: g.inv.metal, stone: g.inv.stone, goo: g.inv.goo });
  g.ui.toggleCraft(false);
  w.set(...c, 0); g.construction.onBlockRemoved(...c);
}

// aim at a dry cannon and press E
let reloadFixture;
{
  for (const t of g.entities.turrets) t.disposeModel(); g.entities.turrets = [];
  const t = new ents.Turret(g, X + .5, Y, Z + .5, 'cannon'); g.entities.turrets.push(t); reloadFixture = t;
  t.ammo = 0; g.inv.shells = 13; g.player.pos.set(X + .5, Y, Z + 3.5); g.player.aimDir.set(0, 0, -1); t.update(.016);
}
check('empty turret survives update', !reloadFixture.dead && reloadFixture.ammo === 0);
key('KeyE');
check('E reloads empty turret with exact available shells', reloadFixture.ammo === 13 && g.inv.shells === 0, [reloadFixture.ammo, g.inv.shells]);
key('KeyE');
check('E with no ammunition changes nothing', reloadFixture.ammo === 13 && g.inv.shells === 0);
reloadFixture.ammo = 100; g.inv.shells = 9;
key('KeyE');
check('E on a full turret spends nothing', reloadFixture.ammo === 100 && g.inv.shells === 9);
reloadFixture.ammo = 0; for (let y = Y; y <= Y + 2; y++) w.set(X, y, Z + 2, 3);
key('KeyE');
check('wall blocks E reload', reloadFixture.ammo === 0 && g.inv.shells === 9);
for (let y = Y; y <= Y + 2; y++) w.set(X, y, Z + 2, 0);

{
  const pl = g.player, t = reloadFixture;
  g.entities.enemies = []; pl.pos.set(X + .5, Y, Z + .5); pl.hp = 100; t.pos.set(X + 1.5, Y, Z + .5); t.hp = 100;
  let wildlife = g.foraging.wildlife.find(a => !a.dead);
  check('wildlife exists for the ally check', !!wildlife, g.foraging.wildlife.length);
  if (wildlife) wildlife.pos.set(X - 1.5, Y, Z + .5);
  const wildHP = wildlife?.hp;
  const a = g.entities.spawnEnemy('brute', X + .5, Y, Z - 1.5), b = g.entities.spawnEnemy('brute', X + .5, Y, Z + 3.5); a.hp = b.hp = 1000;
  w.set(X, Y + 1, Z + 2, 3);
  g.projectiles.defenseBlast(pl.pos.clone().add({ x: 0, y: 1, z: 0 }), 100, 6);
  const got = { a: a.hp, b: b.hp, p: pl.hp, t: t.hp, wild: wildlife?.hp, wildHP, wall: w.get(X, Y + 1, Z + 2) };
  check('defense blast damages visible hostiles and blocks while preserving allies and wildlife', a.hp < 1000 && b.hp === 1000 && pl.hp === 100 && t.hp === 100 && (!wildlife || wildlife.hp === wildHP) && w.get(X, Y + 1, Z + 2) !== 3, got);
  w.set(X, Y + 1, Z + 2, 0); a.dead = b.dead = true;
}

// save/load of five typed turrets, then a legacy save without the typed fields
{
  for (const t of g.entities.turrets) t.disposeModel(); g.entities.turrets = [];
  for (const [i, id] of ['auto', 'cannon', 'twin', 'rocket', 'artillery'].entries()) { const t = new ents.Turret(g, X - 10 + i * 4, Y, Z - 5, id, i % 4); t.ammo = i + 1; g.entities.turrets.push(t); }
  g.entities.enemies = [];
  const r = g.entities.turrets[3]; r.salvoAim = r.pos.clone(); r.salvoIndex = 1; r.cd = 3.7;
  await g.save('manual'); await g.quickLoad();
  const ts = g.entities.turrets;
  check('save restores five typed turrets, rotations and ammo', ts.length === 5 && ts.every((t, i) => t.defenseId === ['auto', 'cannon', 'twin', 'rocket', 'artillery'][i] && t.rotation === i % 4 && t.ammo === i + 1), ts.map(t => [t.defenseId, t.rotation, t.ammo]));
  check('save cancels pending rockets while retaining ammo and cooldown', !ts[3]?.salvoAim && ts[3]?.ammo === 4 && Math.abs(ts[3]?.cd - 3.7) < .001);
  const db = await new Promise((ok, no) => { const r = indexedDB.open('blockfall-isle', 1); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const data = await new Promise(ok => { const r = db.transaction('saves').objectStore('saves').get('manual'); r.onsuccess = () => ok(r.result); });
  for (const t of data.turrets) { delete t.defenseId; delete t.rotation; delete t.ammo; }
  await new Promise(ok => { const tx = db.transaction('saves', 'readwrite'); tx.objectStore('saves').put(data, 'manual'); tx.oncomplete = ok; });
  db.close();
  await g.quickLoad();
  const ls = g.entities.turrets;
  check('legacy saves default to full auto turrets and rotation zero', ls.length === 5 && ls.every(t => t.defenseId === 'auto' && t.rotation === 0 && t.ammo === 250), ls.map(t => [t.defenseId, t.rotation, t.ammo]));
}
