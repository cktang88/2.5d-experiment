// @url /?fast=1&test=1
// Turret dead zones and support safety: holding fire at close/underneath/incoming targets, salvo completion,
// ballistic arcs, picker range text, and explosive impacts never eating a turret's own support.
// Ported from tests/turret_support_safety_validation.py.
const { B } = await import('/src/blocks.ts'), mods = await import('/src/defenses.ts'), ents = await import('/src/entities.ts');
const g = game, w = g.world, V3 = g.player.pos.constructor;
const ids = ['auto', 'cannon', 'twin', 'rocket', 'artillery'], heavy = ['cannon', 'twin', 'rocket', 'artillery'];

const p = g.player.pos, X = Math.floor(p.x) + 12, Z = Math.floor(p.z) - 12;
w.generateAround(X, Z, 5);
let Y = 0; for (let x = X - 30; x <= X + 30; x += 3) for (let z = Z - 30; z <= Z + 30; z += 3) Y = Math.max(Y, w.surfaceY(x, z)); Y += 3;
for (let x = X - 30; x <= X + 30; x++) for (let z = Z - 30; z <= Z + 30; z++) { w.set(x, Y - 1, z, 1); for (let y = Y; y <= Y + 12; y++) w.set(x, y, z, 0); }
w.rebuildAround(X, Z, 3); p.set(X - 15, Y, Z - 15); g.player.vel.set(0, 0, 0); g.entities.enemies = [];

const clear = () => { for (const t of g.entities.turrets) t.disposeModel(); g.entities.turrets = []; for (const e of g.entities.enemies) e.removeSprite(); g.entities.enemies = []; g.projectiles.reset(); };

// ---------------- dead zones ----------------
{
  const turret = (id, rot = 0) => { const t = new ents.Turret(g, X + .5, Y, Z + .5, id, rot); g.entities.turrets.push(t); return t; };
  const enemy = (x, y, z) => { const e = g.entities.spawnEnemy('brute', x, y, z); e.hp = e.maxHp = 10000; e.vel.set(0, 0, 0); return e; };
  const run = (t, n = 160) => { const start = t.ammo; for (let i = 0; i < n && t.ammo === start; i++) t.update(.05); return start - t.ammo; };
  const support = (t) => { const [a, b] = mods.footprintSize(t.defenseId, t.rotation), cells = []; for (let x = Math.floor(t.pos.x - a / 2 + .001); x <= Math.floor(t.pos.x + a / 2 - .001); x++) for (let z = Math.floor(t.pos.z - b / 2 + .001); z <= Math.floor(t.pos.z + b / 2 - .001); z++) cells.push([x, Y - 1, z]); return cells; };
  const restore = () => { for (let x = X - 10; x <= X + 10; x++) for (let z = Z - 10; z <= Z + 10; z++) { w.set(x, Y - 1, z, 1); for (let y = Y; y <= Y + 8; y++) w.set(x, y, z, 0); } };
  for (const id of ids) {
    clear(); restore(); const t = turret(id), spec = mods.getDefense(id), e = enemy(t.pos.x + Math.max(.5, spec.minRange - .5), Y, t.pos.z);
    const ammo = t.ammo; for (let i = 0; i < 100; i++) t.update(.05);
    check(id + ' holds fire inside minimum range', t.ammo === ammo && g.projectiles.list.length === 0);
    e.pos.set(t.pos.x, Y - 20, t.pos.z); t.target = e; t.scanT = 0; for (let i = 0; i < 40; i++) t.update(.05);
    check(id + ' holds fire directly underneath', t.ammo === ammo && g.projectiles.list.length === 0);
    clear(); restore(); const safe = turret(id); enemy(safe.pos.x, Y, safe.pos.z + Math.max(spec.minRange + 8, 16));
    check(id + ' fires at valid range', run(safe) > 0);
  }
  clear(); restore();
  for (const id of heavy) {
    const t = turret(id), spec = mods.getDefense(id), e = enemy(t.pos.x, Y, t.pos.z + spec.minRange + 1); e.vel.z = -30;
    const ammo = t.ammo; for (let i = 0; i < 100; i++) t.update(.05);
    check(id + ' incoming led target holds fire', t.ammo === ammo); clear(); restore();
  }
  {
    const t = turret('rocket'), e = enemy(t.pos.x, Y, t.pos.z + 25), start = t.ammo; run(t); e.dead = true;
    for (let i = 0; i < 100 && t.ammo > start - 4; i++) t.update(.05);
    check('rocket completes four safe rounds after target dies', t.ammo === start - 4 && g.projectiles.list.length === 4, [start - t.ammo, g.projectiles.list.length]); clear(); restore();
  }
  {
    const t = turret('rocket'), e = enemy(t.pos.x, Y, t.pos.z + 25), start = t.ammo; run(t);
    const origin = t.muzzle(t.salvoIndex), forward = new V3(1, 0, 0).transformDirection(t.muzzles[t.salvoIndex].matrixWorld), intercept = origin.clone().addScaledVector(forward, 3);
    e.pos.set(intercept.x, intercept.y - e.h / 2, intercept.z); for (let i = 0; i < 50; i++) t.update(.05);
    check('rocket moving body blocks remaining unsafe salvo rounds', t.ammo === start - 1, start - t.ammo); clear(); restore();
  }
  {
    const t = turret('artillery'), origin = t.muzzle(), near = t.pos.clone().add(new V3(0, 0, 10)), far = t.pos.clone().add(new V3(0, 0, 26));
    const a = mods.ballisticVelocity(origin, near), b = mods.ballisticVelocity(origin, far);
    check('artillery short ballistic arc is unsafe and long arc clears', !g.projectiles.defenseShotSafe(t, origin, a.velocity, a.time + .3, 5, 18) && g.projectiles.defenseShotSafe(t, origin, b.velocity, b.time + .3, 5, 18)); clear(); restore();
  }
  for (const id of ids) {
    const spec = mods.getDefense(id); g.ui.craftOpen = true; g.ui.refreshCraft();
    const button = document.querySelector(`[data-defense="${id}"]`);
    check(id + ' picker shows minimum and maximum range', !!button && button.textContent.includes(`${spec.minRange}–${spec.range} m`), button?.textContent);
  }
  g.ui.craftOpen = false;
  clear(); restore();
  for (const id of heavy) for (const rot of [0, 1]) {
    clear(); restore(); const t = turret(id, rot), cells = support(t), spec = mods.getDefense(id); enemy(t.pos.x + spec.minRange - .5, Y, t.pos.z); const ammo = t.ammo;
    for (let i = 0; i < 100; i++) { t.update(.05); g.projectiles.update(.01); }
    check(id + ' rotation ' + rot + ' close target preserves support', t.ammo === ammo && cells.every(([x, y, z]) => w.get(x, y, z) === 1));
  }
  clear(); restore();
}

// ---------------- impacts and the preflight tracer ----------------
{
  const reset = () => { for (let x = X - 12; x <= X + 12; x++) for (let z = Z - 12; z <= Z + 12; z++) { w.set(x, Y - 1, z, B.DIRT); for (let y = Y; y <= Y + 10; y++) w.set(x, y, z, B.AIR); } };
  const turret = (id, rot = 0, raised = false) => {
    const y = Y + (raised ? 4 : 0), t = new ents.Turret(g, X + .5, y, Z + .5, id, rot); g.entities.turrets.push(t);
    const [a, b] = mods.footprintSize(id, rot), cells = [];
    for (let x = Math.floor(t.pos.x - a / 2 + .001); x <= Math.floor(t.pos.x + a / 2 - .001); x++) for (let z = Math.floor(t.pos.z - b / 2 + .001); z <= Math.floor(t.pos.z + b / 2 - .001); z++) {
      if (raised) for (let yy = Y; yy < y; yy++) w.set(x, yy, z, B.BRICK);
      cells.push([x, y - 1, z, w.get(x, y - 1, z)]);
    }
    return [t, cells];
  };
  const launch = (t) => {
    const origin = t.pos.clone().add(new V3(0, 1.5, 1.5)), dir = new V3(0, 0, 1);
    if (t.defenseId === 'rocket') return g.projectiles.defenseRocket(origin, dir, t, 100);
    if (t.defenseId === 'artillery') return g.projectiles.defenseShell(origin, dir.clone().multiplyScalar(35), 1, t, 350);
    return g.projectiles.defenseCannon(origin, dir, t, 180, 60, t.defenseId === 'cannon');
  };
  for (const id of heavy) for (const rot of [0, 1]) for (const raised of [false, true]) for (const kind of ['collision', 'fuse']) {
    clear(); reset(); const [t, cells] = turret(id, rot, raised), q = launch(t); let collided = true;
    if (kind === 'collision') {
      const e = g.entities.spawnEnemy('brute', t.pos.x, t.pos.y, t.pos.z + 15); e.hp = e.maxHp = 10000; e.pos.set(t.pos.x, t.pos.y, t.pos.z + 3.5); e.vel.set(0, 0, 0);
      for (let i = 0; i < 15 && g.projectiles.list.length; i++) g.projectiles.update(.01);
      collided = g.projectiles.list.length === 0 && e.hp === 10000;
    } else { q.life = .001; g.projectiles.update(.01); collided = g.projectiles.list.length === 0; }
    check(id + ' ' + rot + ' ' + (raised ? 'rampart' : 'floor') + ' ' + kind + ' preserves support', collided && cells.every(([x, y, z, b]) => w.get(x, y, z) === b));
  }
  {
    clear(); reset(); const [t] = turret('rocket', 1), q = launch(t);
    q.pos.set(X + 18.5, Y - .1, Z + .5); w.set(X + 18, Y - 1, Z, B.DIRT); w.set(X + 19, Y - 1, Z, B.PLANKS); q.life = .001; g.projectiles.update(.01);
    check('safe distant blast craters terrain and built blocks', w.get(X + 18, Y - 1, Z) === B.AIR && w.get(X + 19, Y - 1, Z) === B.AIR);
  }
  clear(); reset();
  // the preflight tracer is fed actual muzzle positions, spread directions and ballistic velocity
  for (const id of heavy) {
    const [t] = turret(id, 1), rad = id === 'artillery' ? 5 : id === 'rocket' ? 3.4 : id === 'cannon' ? 3.2 : 2.5;
    const origins = t.muzzles.map((_, i) => t.muzzle(i)); let ground = true, wall = true, body = true, free = true;
    for (const origin of origins) {
      const speed = id === 'rocket' ? 32 : id === 'artillery' ? 35 : 60;
      const safe = (dir, life = 1) => g.projectiles.defenseShotSafe(t, origin, dir.clone().normalize().multiplyScalar(speed), life, rad);
      free &&= safe(new V3(0, 0, 1)); ground &&= !safe(new V3(0, -1, .2));
      const bx = Math.floor(origin.x), by = Math.floor(origin.y), bz = Math.floor(origin.z + 1);
      w.set(bx, by, bz, B.BRICK); wall &&= !safe(new V3(0, 0, 1)); w.set(bx, by, bz, B.AIR);
      const e = g.entities.spawnEnemy('brute', origin.x, origin.y - 1, origin.z + 2); e.vel.set(0, 0, 0); body &&= !safe(new V3(0, 0, 1)); e.removeSprite(); g.entities.enemies = [];
    }
    check(id + ' muzzle paths reject ground wall and body intercept', ground && wall && body && free, { ground, wall, body, free });
    clear(); reset();
  }
  {
    const [t, cells] = turret('rocket', 1), origin = t.muzzle(0), rad = 3.4, velocity = new V3(0, 0, 32), bx = Math.floor(origin.x), by = Math.floor(origin.y), bz = Math.floor(t.pos.z + 7);
    w.set(bx, by, bz, B.BRICK);
    check('rocket preflight rejects wall inside minimum beyond blast zone', !g.projectiles.defenseShotSafe(t, origin, velocity, 3, rad));
    w.set(bx, by, bz, B.AIR);
    const e = g.entities.spawnEnemy('brute', origin.x, origin.y - 1, t.pos.z + 7);
    check('rocket preflight rejects body inside minimum beyond blast zone', !g.projectiles.defenseShotSafe(t, origin, velocity, 3, rad));
    e.removeSprite(); g.entities.enemies = [];
    const q = launch(t); q.pos.set(t.pos.x, t.pos.y + 1.5, t.pos.z + 7); q.life = .001; const before = w.get(X, Y - 1, Z + 7); g.projectiles.update(.01);
    check('rocket fuse inside minimum beyond blast zone is neutralized', w.get(X, Y - 1, Z + 7) === before && cells.every(([x, y, z, b]) => w.get(x, y, z) === b));
  }
  clear(); reset();
}
