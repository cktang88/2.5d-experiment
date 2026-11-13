// First-person proof journey on a flat site: architect-built castle parts, turret on a rampart, shotgun combat,
// workbench crafting, flooded moat, drawbridge, save/load of view and construction, workbench/bridge metadata
// cleanup, quick-load and pointer-lock rejection (was tests/browser_proof.py; its screenshots are dropped).
// @lock 1
// @steps 20
const key = (code) => { dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true })); dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 10000) => { const t = performance.now(); while (!f()) { if (performance.now() - t > ms) return false; await sleep(30); } await sleep(60); return true; };
const locked = () => document.pointerLockElement === game.canvas;
const g = game, w = g.world, a = g.architect, Wd = innerWidth, Hd = innerHeight;
check('started and pointer locked', locked());
const pose = (x, y, z, tx, ty, tz) => { g.player.pos.set(x, y, z); g.player.vel.set(0, 0, 0); const dx = tx - x, dy = ty - (y + 1.55), dz = tz - z; g.camYaw = g.camYawT = Math.atan2(-dx, -dz); g.camPitch = Math.atan2(dy, Math.hypot(dx, dz)); g.updateCamera(0); g.updateAim(); g.updateReticle(); g.ui.update(0); };

// ---- flat site
const p = g.player.pos, X = Math.floor(p.x) + 20, Z = Math.floor(p.z) + 10;
w.generateAround(X, Z, 2);
let Y = 0;
for (let x = X - 17; x <= X + 17; x += 4) for (let z = Z - 18; z <= Z + 18; z += 4) Y = Math.max(Y, w.surfaceY(x, z));
Y += 3;
for (let x = X - 17; x <= X + 17; x++) for (let z = Z - 18; z <= Z + 18; z++) { w.set(x, Y - 1, z, 1); for (let y = Y; y <= Y + 15; y++) w.set(x, y, z, 0); }
w.rebuildAround(X, Z, 2);
Object.assign(g.inv, { planks: 999, bricks: 999, turret: 5 });
g.sandbox = false; g.freeBuild = false;
pose(X, Y, Z + 15, X, Y, Z);

// ---- castle parts through the architect (the old blueprints: battlement, stairs, bastion, drawbridge, workbench)
a.enter(); await sleep(150); step(20); check('architect opens', a.open); // (let the pointer-lock exit event land first)
document.querySelector('#arch-opts [data-mat="planks"]')?.click();
let cur = [X, Y, Z];
a.pick = function () { this.hoverCell = cur; this.hoverSolid = [cur[0], cur[1] - 1, cur[2]]; this.hoverPoint = null; };
const build = (tool, from, to, opts = {}) => {
  a.selectTool(tool);
  Object.assign(a, { height: 3, thickness: 1, battlements: false, foundation: false, hollow: false, roof: false, door: false, pillars: false }, opts); a.refresh();
  const planks = g.inv.planks, ops = a.undoStack.length;
  cur = from; mouse('mousedown', Wd / 2, Hd / 2); step(1); cur = to; step(2);
  const add = a.counts.add, err = a.plan?.error ?? '';
  mouse('mouseup', Wd / 2, Hd / 2); step(1);
  for (let i = 0; i < 80 && a.busy; i++) step(1);
  return { add, err, spent: planks - g.inv.planks, ok: a.undoStack.length === ops + 1 };
};
const place = (id, at, rotation = 0) => {
  a.placeId = id; a.rotation = rotation; a.selectTool('place');
  cur = at; const planks = g.inv.planks, reason = a.placeReason(at);
  mouse('mousedown', Wd / 2, Hd / 2); mouse('mouseup', Wd / 2, Hd / 2); step(1);
  return { reason, spent: planks - g.inv.planks };
};
const placed = {
  battlement: build('wall', [X - 12, Y, Z - 9], [X - 8, Y, Z - 9], { battlements: true }),
  stairs: build('stairs', [X - 11, Y, Z - 6], [X - 10, Y, Z - 3]),
  bastion: build('tower', [X, Y, Z - 9], [X + 2, Y, Z - 9], { height: 5 }), // (centre, then radius)
  rampart: build('box', [X + 3, Y, Z + 9], [X + 6, Y, Z + 12]),
};
for (const [name, r] of Object.entries(placed)) check(`architect builds a ${name}`, r.ok && !r.err && r.add > 0 && r.spent === r.add, r);
const bridge = place('drawbridge', [X + 8, Y, Z - 5]);
check('drawbridge placed', !bridge.reason && bridge.spent === 6 && g.construction.snapshot().bridges.length === 1, bridge);
const bench = place('workbench', [X + 10, Y, Z + 5]);
check('workbench placed', !bench.reason && bench.spent === 1 && g.construction.snapshot().benches.length === 1, bench);
{ // a wall preview without a shortage reads as valid
  a.selectTool('wall'); a.height = 3; cur = [X - 2, Y, Z + 4]; mouse('mousedown', Wd / 2, Hd / 2); step(1); cur = [X + 2, Y, Z + 4]; step(2);
  check('wall preview valid', a.plan && !a.plan.error && a.fillMesh.visible && !document.querySelector('#arch-tip .bad'), document.getElementById('arch-tip').innerHTML);
  mouse('mousedown', Wd / 2, Hd / 2, 2); mouse('mouseup', Wd / 2, Hd / 2, 2); mouse('mouseup', Wd / 2, Hd / 2); step(1);
}
delete a.pick; a.exit(); await until(() => !a.open && locked()); step(20);

// ---- turret on top of the rampart through the normal action handler
{
  let top = Y; while (w.get(X + 4, top, Z + 10) !== 0) top++;
  g.select(g.hotbar.findIndex((s) => s.id === 'turret')); g.trapId = null;
  g.hover = { x: X + 4, y: top - 1, z: Z + 10, nx: 0, ny: 1, nz: 0, point: g.player.pos.clone() };
  const before = g.entities.turrets.length; g.fireCd = 0; g.input.lmbPressed = true; g.updateActions(.016);
  check('turret deployed on the rampart', g.entities.turrets.length === before + 1 && g.entities.turrets.at(-1).pos.y > Y + 2, g.entities.turrets.length);
}

// ---- shotgun combat
{
  pose(X, Y, Z + 13, X, Y + .85, Z + 6);
  const enemy = g.entities.spawnEnemy('zombie', X, Y, Z + 6); g.entities.spawnEnemy('crawler', X + 1.5, Y, Z + 4);
  g.entities.update(.016); g.player.update(.016, g.input); g.ui.update(.016); g.fireCd = 0; g.updateAim(); g.updateReticle();
  key('Digit2'); const shells = g.inv.shells, bullets = g.projectiles.list.length;
  mouse('mousedown', Wd / 2, Hd / 2); g.updateActions(.016); mouse('mouseup', Wd / 2, Hd / 2);
  check('real mouse shot spends one shell and fires nine pellets', g.inv.shells === shells - 1 && g.projectiles.list.filter((q) => q.type === 'bullet').length - bullets === 9, [g.inv.shells, shells, g.projectiles.list.length]);
  g.projectiles.update(.2);
  check('aimed shot damages the enemy', enemy.hp < enemy.maxHp, [enemy.hp, enemy.maxHp]);
  g.entities.enemies.forEach((e) => { e.dead = true; e.removeSprite(); }); g.projectiles.reset();
}

// ---- workbench: E opens crafting, a station recipe crafts
{
  pose(X + 10.5, Y, Z + 7.5, X + 10.5, Y + 1, Z + 5.5); g.inv.goo = 10; g.inv.wood = 10;
  check('near the workbench', g.construction.nearWorkbench());
  key('KeyE'); await until(() => g.ui.craftOpen && !document.pointerLockElement);
  check('E opens crafting at the workbench', g.ui.craftOpen);
  const tnt = g.inv.tnt, r = [...document.querySelectorAll('#craftlist .recipe')].find((e) => e.textContent.trim().startsWith('TNT'));
  r?.click();
  check('workbench recipe crafted', g.inv.tnt === tnt + 1, [r?.textContent, g.inv.tnt, tnt]);
  key('Tab'); await until(() => !g.ui.craftOpen && locked());
}

// ---- water-filled moat under the drawbridge's outer end
{
  for (let x = X + 7; x <= X + 10; x++) for (let z = Z - 4; z <= Z - 3; z++) { w.set(x, Y - 2, z, 1); w.set(x, Y - 1, z, 0); g.waterSim.fill(x, Y - 1, z, 8); }
  w.rebuildAround(X, Z, 2); g.waterSim.update(0);
  const keys = new Set(); for (let x = X + 7; x <= X + 10; x++) for (let z = Z - 4; z <= Z - 3; z++) keys.add(w.chunkAt(x, Y - 1, z).key);
  for (const k of keys) g.waterSim.buildChunk(k);
  check('water-filled moat', g.waterSim.levelAt(X + 8, Y - 1, Z - 4) === 8 && [...keys].every((k) => g.waterSim.meshes.get(k)?.mesh?.geometry.attributes.position.count > 0));
}

// ---- drawbridge raised with E
{
  pose(X + 10, Y, Z - 1, X + 8.5, Y + .4, Z - 4);
  key('KeyE');
  const r = g.construction.snapshot().bridges.at(-1);
  check('drawbridge raised', r?.raised && r.raisedCells?.length === 6, r && { raised: r.raised, cells: r.raisedCells?.length });
}

// ---- save/load restores view and construction
{
  const state = JSON.stringify(g.construction.snapshot());
  g.camYaw = g.camYawT = .9; g.camPitch = .3;
  await g.save('manual'); g.camYaw = 0; g.camPitch = 0; g.construction.restore();
  g.entities.walkField.ready = true; g.entities.walkField.running = true;
  const ok = await g.load('manual');
  check('save restores view and construction', ok && g.camYaw === .9 && g.camPitch === .3 && JSON.stringify(g.construction.snapshot()) === state && !g.entities.walkField.ready && !g.entities.walkField.running,
    { ok, yaw: g.camYaw, pitch: g.camPitch, same: JSON.stringify(g.construction.snapshot()) === state, ready: g.entities.walkField.ready, running: g.entities.walkField.running });
}

// ---- metadata cleanup
{
  pose(X + 10.5, Y, Z + 7.5, X + 10.5, Y + 1, Z + 5.5);
  for (let y = Y; y <= Y + 2; y++) w.set(X + 10, y, Z + 6, 1);
  const denied = !g.construction.nearWorkbench();
  for (let y = Y; y <= Y + 2; y++) w.set(X + 10, y, Z + 6, 0);
  check('a wall blocks reaching the workbench', denied && g.construction.nearWorkbench());
}
{
  const b = g.construction.snapshot().benches[0];
  w.damageBlock(...b.cell, 1000, 'mine'); w.set(...b.cell, b.block);
  check('a mined workbench rebuilt by hand is not a workbench', g.construction.snapshot().benches.length === 0 && !g.construction.nearWorkbench());
}
{
  const b = g.construction.snapshot().bridges[0], c = b?.raisedCells?.[2];
  check('raised drawbridge survives in the snapshot', !!c, b);
  if (c) {
    w.damageBlock(...c, 1000, 'explosion'); w.set(...c, b.block);
    check('a destroyed drawbridge rebuilt by hand is not a drawbridge', g.construction.snapshot().bridges.length === 0);
  }
}
{
  const x = X + 14, z = Z + 8;
  w.set(x, Y - 1, z, 1); w.set(x, Y, z, 0); g.player.pos.set(x - 2, Y, z);
  g.construction.registerBench([x, Y, z], 8); w.set(x, Y, z, 8);
  const registered = g.construction.snapshot().benches.length === 1;
  w.set(x, Y - 1, z, 0); g.checkSupport([[x, Y, z]]);
  check('an unsupported workbench drops its metadata', registered && g.construction.snapshot().benches.length === 0);
}

// ---- quick-load pauses; a rejected pointer lock pauses instead of leaving the game running
key('F9'); await until(() => g.paused && !g.loading, 30000);
check('quick-load pauses', g.paused && !document.pointerLockElement);
g.canvas.requestPointerLock = () => Promise.reject(new Error('test rejection'));
document.getElementById('resume').click(); await sleep(200);
check('pointer lock rejection pauses', g.paused && !document.pointerLockElement);
