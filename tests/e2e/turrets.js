// @url /?fast=1&test=1
// Turret aiming (yaw/pitch gates, muzzle origins, barrel axis, real voxel obstruction) and raised turret
// bases (actor collision, support, melee, falls, elevated fire, save/load).
// Ported from tests/turret_aim_validation.py and tests/turret_base_validation.py.
const mods = await import('/src/defenses.ts'), ents = await import('/src/entities.ts');
const { Turret } = ents, g = game, w = g.world, V3 = g.player.pos.constructor;
// fake targets carry h and hitRadius() because the support-safety preflight (2bef079) ray-tests them
const ids = ['auto', 'cannon', 'twin', 'rocket', 'artillery'];
const shooters = ['bullet', 'defenseCannon', 'defenseRocket', 'defenseShell'];

// ---------------- aim (turret_aim_validation) ----------------
{
  const oldEnemies = g.entities.enemies, oldRay = w.raycast, oldBounds = w.inBounds;
  const oldParticle = g.particles.muzzle, oldShot = g.audio.shot;
  w.raycast = () => ({ hit: false }); w.inBounds = () => true; g.particles.muzzle = () => {}; g.audio.shot = () => {};
  let fired = [];
  for (const name of shooters) g.projectiles[name] = (origin, velocity) => fired.push({ origin: origin.clone(), velocity: velocity.clone() });
  try {
    for (const id of ids) for (const heading of [0, Math.PI / 2]) {
      const origin = g.player.pos.clone().add(new V3(0, 15, 0));
      const t = new Turret(g, origin.x, origin.y, origin.z, id); t.physics = () => {};
      const distance = id === 'artillery' ? 24 : 14;
      const e = { dead: false, r: .6, pos: origin.clone().add(new V3(Math.sin(heading) * distance, 5, Math.cos(heading) * distance)), vel: new V3(), h: 1.8, hitRadius() { return .81; }, center(v) { return v.copy(this.pos); } };
      g.entities.enemies = [e]; t.yaw = heading; t.head.rotation.y = heading;
      fired = []; const ammo = t.ammo; t.update(.01);
      const pitchGate = fired.length === 0 && t.ammo === ammo;
      t.yaw = heading + Math.PI; t.head.rotation.y = t.yaw; t.pitch = 0; t.barrel.rotation.z = 0;
      t.update(.01); const yawGate = fired.length === 0 && t.ammo === ammo;
      for (let i = 0; i < 500 && !fired.length; i++) t.update(.01);
      const tips = t.muzzles.map(m => m.getWorldPosition(new V3()));
      // imported models (504928c) point each muzzle along its local +x; the rocket's first salvo round
      // carries the battery's fixed spread offset (-0.045 rad yaw, -0.025 rise)
      const forward = new V3(1, 0, 0).transformDirection(t.muzzles[0].matrixWorld);
      if (id === 'rocket') { forward.applyAxisAngle(new V3(0, 1, 0), -.045); forward.y -= .025; forward.normalize(); }
      const valid = fired.length === (id === 'twin' ? 2 : 1) && fired.every(s => tips.some(tip => tip.distanceTo(s.origin) < 1e-6) && s.velocity.normalize().dot(forward) > 0.999999);
      const h = heading ? 'side' : 'ahead';
      check(`${id} ${h}: holds fire until pitched`, pitchGate);
      check(`${id} ${h}: holds fire while facing away`, yawGate);
      check(`${id} ${h}: fires from its muzzles along the barrel`, valid, { count: fired.length, pitch: t.pitch });
      t.disposeModel();
    }
    {
      const origin = g.player.pos.clone().add(new V3(0, 15, 0));
      const t = new Turret(g, origin.x, origin.y, origin.z, 'twin'); t.physics = () => {};
      // just outside the twin's 8 m dead zone (2bef079); it used to sit at 4 m
      const e = { dead: false, r: .6, pos: origin.clone().add(new V3(0, 1.5, mods.getDefense('twin').minRange + 1)), vel: new V3(), h: 1.8, hitRadius() { return .81; }, center(v) { return v.copy(this.pos); } };
      g.entities.enemies = [e]; fired = []; t.yaw = Math.PI; t.update(.01);
      const yawGate = fired.length === 0;
      for (let i = 0; i < 500 && !fired.length; i++) t.update(.01);
      const forward = new V3(1, 0, 0).transformDirection(t.muzzles[0].matrixWorld);
      check('close twin: holds fire while facing away', yawGate);
      check('close twin: fires both barrels along the barrel', fired.length === 2 && fired.every(s => s.velocity.normalize().dot(forward) > 0.999999), fired.length);
      t.disposeModel();
    }
  } finally {
    g.entities.enemies = oldEnemies; w.raycast = oldRay; w.inBounds = oldBounds;
    for (const name of shooters) delete g.projectiles[name]; // drop the stubs, back to the prototype methods
    g.particles.muzzle = oldParticle; g.audio.shot = oldShot;
  }
  // real voxel raycasts: a clear elevated target, then a parapet placed in the launch path after acquisition
  const p = g.player.pos, X = Math.floor(p.x) + 12, Z = Math.floor(p.z) - 12;
  w.generateAround(X, Z, 3); let Y = 0;
  for (let x = X - 8; x <= X + 8; x += 4) for (let z = Z - 8; z <= Z + 20; z += 4) Y = Math.max(Y, w.surfaceY(x, z));
  Y += 3;
  for (let x = X - 8; x <= X + 8; x++) for (let z = Z - 8; z <= Z + 20; z++) { w.set(x, Y - 1, z, 1); for (let y = Y; y < Y + 15; y++) w.set(x, y, z, 0); }
  const t = new Turret(g, X + .5, Y, Z + .5, 'cannon'); t.physics = () => {};
  const e = { dead: false, pos: new V3(X + .5, Y + 6, Z + 15.5), vel: new V3(), h: 1.8, hitRadius() { return .81; }, center(v) { return v.copy(this.pos); } };
  g.entities.enemies = [e]; fired = [];
  for (const name of shooters) g.projectiles[name] = (o, v) => fired.push({ origin: o.clone(), velocity: v.clone() });
  g.particles.muzzle = () => {}; g.audio.shot = () => {};
  try {
    for (let i = 0; i < 300 && !fired.length; i++) t.update(.01);
    check('real terrain: cannon fires up at a clear elevated target', fired.length === 1 && t.pitch > 0, { count: fired.length, pitch: t.pitch });
    fired = []; t.cd = 0; t.scanT = 100; t.target = e;
    for (let x = X - 2; x <= X + 2; x++) for (let y = Y; y <= Y + 10; y++) w.set(x, y, Z + 4, 3);
    const ammo = t.ammo; for (let i = 0; i < 30; i++) t.update(.01);
    check('real terrain: wall across the elevated barrel axis blocks the shot', fired.length === 0 && t.ammo === ammo, fired.length);
  } finally {
    for (const name of shooters) delete g.projectiles[name]; // drop the stubs, back to the prototype methods
    g.particles.muzzle = oldParticle; g.audio.shot = oldShot; g.entities.enemies = oldEnemies;
    t.disposeModel();
  }
}

// ---------------- raised bases (turret_base_validation) ----------------
const p = g.player.pos, X = Math.floor(p.x) + 12, Z = Math.floor(p.z) - 12;
w.generateAround(X, Z, 3);
let Y = 0; for (let x = X - 16; x <= X + 16; x += 3) for (let z = Z - 16; z <= Z + 26; z += 3) Y = Math.max(Y, w.surfaceY(x, z)); Y += 3;
for (let x = X - 16; x <= X + 16; x++) for (let z = Z - 16; z <= Z + 26; z++) { w.set(x, Y - 1, z, 1); for (let y = Y; y <= Y + 12; y++) w.set(x, y, z, 0); }
w.rebuildAround(X, Z, 2);
p.set(X - 5, Y, Z + 6); g.player.vel.set(0, 0, 0); g.entities.enemies = [];
{
  const pl = g.player;
  const clear = () => { for (const t of g.entities.turrets) t.disposeModel(); g.entities.turrets = []; for (const e of g.entities.enemies) e.removeSprite(); g.entities.enemies = []; g.projectiles.reset(); };
  const turret = (id = 'auto', rot = 0) => { const t = new Turret(g, X + .5, Y, Z + .5, id, rot); g.entities.turrets.push(t); return t; };
  const actor = (a, x, y, z, vx = 0, vy = 0, vz = 0) => { a.pos.set(x, y, z); a.vel.set(vx, vy, vz); a.onGround = false; };
  for (const id of ids) {
    clear(); const t = turret(id), [wd, d] = mods.footprintSize(id, 0), base = t.grp.getObjectByName('base');
    t.grp.updateMatrixWorld(true);
    check(id + ' base visible and fixed', !!base && base.visible && base.children.length > 0 && t.head.position.y >= 1.1 && t.muzzle().y > Y + mods.DEFENSE_BASE_HEIGHT);
    actor(pl, X + .5, Y + t.h + 2, Z + .5, 0, -8, 0); for (let i = 0; i < 100 && !pl.onGround; i++) pl.physics(.02);
    check(id + ' supports player', pl.onGround && Math.abs(pl.pos.y - (Y + t.h)) < .02, pl.pos.y - (Y + t.h));
    let sides = true;
    for (const [x, z, vx, vz] of [[-wd / 2 - 2, 0, 50, 0], [wd / 2 + 2, 0, -50, 0], [0, -d / 2 - 2, 0, 50], [0, d / 2 + 2, 0, -50]]) {
      actor(pl, X + .5 + x, Y + .1, Z + .5 + z, vx, 0, vz); pl.physics(.1, 0);
      sides &&= pl.blockedH && (Math.abs(pl.pos.x - (X + .5)) >= wd / 2 + pl.r - .02 || Math.abs(pl.pos.z - (Z + .5)) >= d / 2 + pl.r - .02);
    }
    check(id + ' blocks high speed on four sides', sides);
    actor(pl, X + .5 - wd / 2 - 1, Y, Z + .5, 20, 0, 0); pl.onGround = true; pl.physics(.1);
    check(id + ' blocks grounded auto-step', pl.pos.x <= X + .5 - wd / 2 - pl.r + .02 && pl.pos.y < Y + 1);
    actor(pl, X + .5 - wd / 2 - 2, Y + .1, Z + .5 - d / 2 - 2, 40, 0, 40); pl.physics(.1, 0);
    check(id + ' blocks diagonal entry', Math.abs(pl.pos.x - (X + .5)) >= wd / 2 + pl.r - .02 || Math.abs(pl.pos.z - (Z + .5)) >= d / 2 + pl.r - .02);
    clear();
  }
  for (const kind of ['crawler', 'brute', 'bat']) {
    clear(); const t = turret(), e = g.entities.spawnEnemy(kind, X - 3, Y + .1, Z + .5); actor(e, X - 3, Y + .1, Z + .5, 55, 0, 0); e.physics(.1, 0);
    check(kind + ' blocked by base', e.blockedH && e.pos.x <= t.pos.x - 1 - e.r + .02, e.pos.x - t.pos.x);
  }
  clear(); let t = turret('auto'); actor(pl, t.pos.x - 3, Y + .6, t.pos.z); g.jetpack.active = true; g.camYaw = -Math.PI / 2;
  for (let i = 0; i < 60; i++) pl.update(.02, { keys: { KeyW: true }, pressed: {} });
  check('jetpack flight blocked at base', pl.pos.x <= t.pos.x - 1 - pl.r + .02, pl.pos.x - t.pos.x); g.jetpack.active = false;
  clear(); t = turret('artillery'); let e = g.entities.spawnEnemy('zombie', t.pos.x - 2.34, Y, t.pos.z); const hp = t.hp;
  const attacked = e.contactAttack(t, e.pos.distanceTo(t.pos));
  check('enemy can melee base surface', attacked && t.hp < hp, { attacked, hp, after: t.hp, reach: e.reaches(t) });
  clear(); t = turret('rocket', 1); const [rw, rd] = mods.footprintSize('rocket', 1);
  actor(pl, t.pos.x - rw / 2 - 2, Y + .1, t.pos.z, 40, 0, 0); pl.physics(.1, 0); const blocked = pl.blockedH && pl.pos.x <= t.pos.x - rw / 2 - pl.r + .02;
  actor(pl, t.pos.x + rw / 2 + .5, Y + .1, t.pos.z - rd / 2 - .2, 0, 0, 0); const outside = !pl.overlaps();
  check('rotated rectangular footprint matches collision', blocked && outside, { blocked, outside });
  t.dead = true; actor(pl, t.pos.x - rw / 2 - 2, Y + .1, t.pos.z, 40, 0, 0); pl.physics(.1, 0);
  check('dead base stops blocking', pl.pos.x > t.pos.x - rw / 2 + .5);
  clear(); t = turret(); actor(pl, t.pos.x, Y + t.h + 2, t.pos.z, 0, -8, 0); for (let i = 0; i < 100 && !pl.onGround; i++) pl.physics(.02);
  const top = pl.pos.y; t.disposeModel(); g.entities.turrets = []; pl.physics(.1);
  check('removed base stops supporting player', pl.pos.y < top - .05);
  clear(); t = turret('twin'); const start = t.pos.clone();
  for (let x = X - 2; x <= X + 2; x++) for (let z = Z - 2; z <= Z + 2; z++) w.set(x, Y - 1, z, 0);
  for (let i = 0; i < 10; i++) t.update(.02);
  check('support loss causes vertical fall without sliding', t.pos.y < start.y - .05 && t.pos.x === start.x && t.pos.z === start.z, [t.pos.toArray(), start.toArray()]);
  for (let x = X - 2; x <= X + 2; x++) for (let z = Z - 2; z <= Z + 2; z++) w.set(x, Y - 1, z, 1);
  clear();
  for (const id of ids) {
    // 15 m out, or 4 m beyond the dead zone (artillery's is 18 m since 2bef079)
    const t = turret(id), e = g.entities.spawnEnemy('brute', X + .5, Y, Z + Math.max(15, mods.getDefense(id).minRange + 4)); e.hp = e.maxHp = 1000; e.vel.set(0, 0, 0);
    const initial = t.ammo; for (let i = 0; i < 100 && t.ammo === initial; i++) t.update(.05);
    const shots = g.projectiles.list.length; for (let i = 0; i < 400 && g.projectiles.list.length; i++) g.projectiles.update(.01);
    check(id + ' elevated weapon fires and hits', t.ammo < initial && shots > 0 && e.hp < 1000, { spent: initial - t.ammo, shots, hp: e.hp });
    clear();
  }
}
{
  const t = new Turret(g, X + .5, Y, Z + .5, 'rocket', 1); g.entities.turrets.push(t); g.player.pos.set(X + 8, Y, Z + 8);
  await g.save('manual'); await g.quickLoad();
  const lt = g.entities.turrets[0], pl = g.player;
  check('quick-load restores the rotated rocket base', g.entities.turrets.length === 1 && lt?.defenseId === 'rocket');
  if (lt) {
    const [lw] = mods.footprintSize(lt.defenseId, lt.rotation);
    pl.pos.set(lt.pos.x - lw / 2 - 2, lt.pos.y + .1, lt.pos.z); pl.vel.set(40, 0, 0); pl.onGround = false; pl.physics(.1, 0);
    check('loaded rotated base blocks player', lt.rotation === 1 && pl.blockedH && pl.pos.x <= lt.pos.x - lw / 2 - pl.r + .02);
  }
  g.entities.reset(); g.paused = false; document.getElementById('pause').classList.add('hidden');
  pl.pos.set(X - 4, Y + .1, Z + .5); pl.vel.set(60, 0, 0); pl.onGround = false; pl.physics(.1, 0);
  check('reset clears blocking', pl.pos.x > X + .5, pl.pos.x - X);
}
