// Trap UI, keyboard/mouse interaction, persistence and model integration (was tests/trap_integration_validation.py).
// @lock 1
// @steps 20
const key = (code) => { dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true })); dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 10000) => { const t = performance.now(); while (!f()) { if (performance.now() - t > ms) return false; await sleep(30); } await sleep(60); return true; };
const locked = () => document.pointerLockElement === game.canvas;
const click = () => { mouse('mousedown', innerWidth / 2, innerHeight / 2); game.updateActions(.016); mouse('mouseup', innerWidth / 2, innerHeight / 2); };

const g = game, w = g.world, p = g.player.pos;
let X = Math.floor(p.x) + 12, Z = Math.floor(p.z) - 12, Y = 0;
w.generateAround(X, Z, 3);
for (let x = X - 14; x <= X + 14; x += 3) for (let z = Z - 14; z <= Z + 14; z += 3) Y = Math.max(Y, w.surfaceY(x, z));
Y += 3;
for (let x = X - 14; x <= X + 14; x++) for (let z = Z - 14; z <= Z + 14; z++) { w.set(x, Y - 1, z, 1); for (let y = Y; y <= Y + 12; y++) w.set(x, y, z, 0); }
w.rebuildAround(X, Z, 2);
p.set(X - 5, Y, Z + 6); g.player.vel.set(0, 0, 0); g.entities.enemies = [];
Object.assign(g.inv, { metal: 100, stone: 100, wood: 100, goo: 100, spikeTrap: 3, trapdoor: 3, arrowTrap: 3, flameTrap: 3, blastMine: 3 });
check('starts with pointer lock', locked());

key('Tab'); await until(() => g.ui.craftOpen && !document.pointerLockElement);
check('five trap picker choices', document.querySelectorAll('#trap-picker [data-trap]').length === 5, document.querySelectorAll('#trap-picker [data-trap]').length);
document.querySelector('#trap-picker [data-trap="flame"]').click();
check('picker equips flame', g.trapId === 'flame', g.trapId);
key('Tab'); check('Tab closes crafting and recaptures the mouse', await until(() => !g.ui.craftOpen && locked()) && !g.paused);

g.hover = { x: X, y: Y - 1, z: Z, nx: 0, ny: 1, nz: 0 }; g.updateActions(.016);
key('KeyR'); g.updateActions(.016);
check('R rotates directional wedge', g.defenseRotation === 1 && g.trapDirection.visible && Math.abs(g.trapDirection.rotation.y - Math.PI / 2) < .001, [g.defenseRotation, g.trapDirection.visible, g.trapDirection.rotation.y]);

w.set(X, Y - 1, Z, 0); g.fireCd = 0; g.hover = { x: X, y: Y - 1, z: Z, nx: 0, ny: 1, nz: 0 };
click();
check('failed click spends nothing', g.inv.flameTrap === 3 && g.traps.traps.length === 0, [g.inv.flameTrap, g.traps.traps.length]);
w.set(X, Y - 1, Z, 1); g.fireCd = 0; g.hover = { x: X, y: Y - 1, z: Z, nx: 0, ny: 1, nz: 0 };
click();
check('successful click spends one and preserves rotation', g.inv.flameTrap === 2 && g.traps.traps.length === 1 && g.traps.traps[0].rotation === 1, [g.inv.flameTrap, g.traps.traps.length, g.traps.traps[0]?.rotation]);

{ // workbench recipe
  const c = [Math.floor(p.x) + 1, Math.floor(p.y), Math.floor(p.z)]; w.set(...c, 3); g.construction.benches.push({ cell: c, block: 3 });
  key('Tab'); await until(() => g.ui.craftOpen);
  const r = [...document.querySelectorAll('#craftlist .recipe')].find((e) => e.textContent.includes('Flame trap'));
  check('flame trap recipe listed', !!r);
  r?.click();
  check('workbench recipe spends exact resources and equips', g.inv.metal === 94 && g.inv.stone === 98 && g.inv.flameTrap === 3 && g.trapId === 'flame', [g.inv.metal, g.inv.stone, g.inv.flameTrap, g.trapId]);
  key('Tab'); await until(() => !g.ui.craftOpen && locked());
  g.construction.benches.pop(); w.set(...c, 0);
}
{ // trapdoor via E
  const x = X, y = Y, z = Z;
  g.traps.restore([]); w.set(x, y - 1, z, 0); w.set(x + 1, y, z, 1); g.traps.place('trapdoor', 0, x, y, z);
  g.player.pos.set(x + .5, y, z - 2); g.player.aimDir.set(0, -.9, 2.5).normalize();
  key('KeyE'); check('E opens trapdoor', g.traps.traps[0].open && w.get(x, y, z) === 0);
  key('KeyE'); check('E closes trapdoor', !g.traps.traps[0].open && w.get(x, y, z) === 8);
  key('KeyE'); const blocker = g.entities.spawnEnemy('zombie', x + .5, y, z + .5);
  key('KeyE'); check('actor blocks closing', g.traps.traps[0].open);
  blocker.dead = true; key('KeyE'); check('closing succeeds after actor leaves', !g.traps.traps[0].open);
  for (let y0 = y; y0 <= y + 2; y0++) w.set(x, y0, z - 1, 3);
  key('KeyE'); check('wall blocks E', !g.traps.traps[0].open);
  for (let y0 = y; y0 <= y + 2; y0++) w.set(x, y0, z - 1, 0);
}
{ // reload picks the nearest aligned trap
  const x = X, y = Y, z = Z;
  g.traps.restore([]); w.set(x, y, z, 0); w.set(x, y - 1, z, 1); w.set(x + 1, y, z, 0);
  g.traps.place('arrow', 0, x, y, z); g.traps.place('arrow', 0, x, y, z + 1);
  g.traps.traps.forEach((t) => (t.ammo = 0)); g.inv.ammo = 10;
  g.player.pos.set(x + .5, y - .9, z - 1.5); g.player.aimDir.set(0, 0, 1);
  key('KeyE'); check('E selects nearest aligned trap', g.traps.traps[0].ammo === 10 && g.traps.traps[1].ammo === 0, g.traps.traps.map((t) => t.ammo));
}
{ // flame fires with its model shown
  const x = X, y = Y, z = Z;
  g.traps.restore([]); w.set(x, y, z, 0); w.set(x, y - 1, z, 1); w.set(x + 1, y, z, 0);
  g.traps.place('flame', 0, x, y, z); g.entities.enemies = []; g.entities.spawnEnemy('zombie', x + .5, y, z + 4.5); g.traps.update(.1);
  check('flame fires visible model', g.traps.flames.length > 0 && g.traps.traps[0].model.visible);
}
{ // IndexedDB save/load
  const x = X, y = Y, z = Z;
  g.traps.restore([]); g.entities.enemies = []; w.set(x, y - 1, z, 0); w.set(x + 1, y, z, 1);
  g.traps.place('trapdoor', 2, x, y, z); g.player.pos.set(x + .5, y, z - 2); g.player.aimDir.set(0, -.9, 2.5).normalize(); g.traps.interact();
  g.traps.place('arrow', 1, x + 3, y, z); g.traps.traps[1].ammo = 7;
  g.save('manual'); await until(() => !g.saving, 60000);
  g.quickLoad(); await until(() => g.traps.traps.length === 2 && g.traps.traps[1].id === 'arrow' && !g.loading, 60000);
  const t = g.traps.traps;
  check('IndexedDB save restores mixed traps and state', t[0]?.id === 'trapdoor' && t[0].rotation === 2 && t[0].open && t[1]?.rotation === 1 && t[1].ammo === 7, t.map((q) => [q.id, q.rotation, q.open, q.ammo]));
  const db = await new Promise((ok, no) => { const r = indexedDB.open('blockfall-isle', 1); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const data = await new Promise((ok) => { const r = db.transaction('saves').objectStore('saves').get('manual'); r.onsuccess = () => ok(r.result); });
  delete data.traps; delete data.glowsticks;
  await new Promise((ok) => { const tx = db.transaction('saves', 'readwrite'); tx.objectStore('saves').put(data, 'manual'); tx.oncomplete = ok; });
  db.close(); g.quickLoad();
  await until(() => g.traps.traps.length === 0 && !g.loading, 60000);
  check('legacy save missing traps and glowsticks loads empty', g.traps.traps.length === 0 && g.glowsticks.sticks.length === 0);
}
