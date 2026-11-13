// @url /?fast=1&test=1
// @steps 40
// Sandbox construction and save compatibility (was tests/sandbox_validation.py): with sandbox on, blocks,
// explosives, lanterns, defenses, traps, architect shapes and an architect workbench cost nothing; the
// setting survives save/load, and an old save without the field loads with sandbox off.
// npm run e2e -- sandbox
const { B } = await import('/src/blocks.ts');
const g = game, w = g.world, a = g.architect, S = w.gen.spawn, p = g.player.pos;
const x = S.x + 30, z = S.z + 30, y = w.surfaceY(x, z);
for (let i = x - 10; i <= x + 10; i++) for (let k = z - 10; k <= z + 10; k++) { w.set(i, y - 1, k, B.GRASS); for (let c = y; c < y + 8; c++) w.set(i, c, k, B.AIR); }
p.set(x - 5.5, y, z + 8.5); g.player.vel.set(0, 0, 0);
g.entities.enemies = []; g.freeBuild = false;
Object.assign(g.inv, { planks: 0, bricks: 0, tnt: 0, lantern: 0, turret: 0, spikeTrap: 0 });
localStorage.setItem('sandbox-test-other', 'preserved');
g.setSandboxMode(true);
check('sandbox preference stored', localStorage.getItem('blockfall.sandbox') === 'true');
check('other preferences untouched', localStorage.getItem('sandbox-test-other') === 'preserved');

// first-person hotbar placement with an empty inventory (the real updateActions click path)
function click(slot, xx, zz = z) {
  if (slot) g.select(g.hotbar.findIndex((s) => s.id === slot));
  g.hover = { x: xx, y: y - 1, z: zz, nx: 0, ny: 1, nz: 0 }; g.fireCd = 0;
  g.input.lmbPressed = true; g.updateActions(0.016); g.input.lmbPressed = false;
}
click('planks', x); check('planks block placed for free', w.get(x, y, z) === B.PLANKS && g.inv.planks === 0, [w.get(x, y, z), g.inv.planks]);
click('tnt', x + 1); check('tnt placed for free', w.get(x + 1, y, z) !== B.AIR && g.inv.tnt === 0);
click('lantern', x + 2); check('lantern placed for free', w.get(x + 2, y, z) !== B.AIR && g.inv.lantern === 0);
g.selectDefense('auto'); click(null, x + 4);
check('defense deployed for free', g.entities.turrets.length > 0 && g.inv.turret === 0, g.entities.turrets.length);
check('trap placed for free', g.traps.place('spikes', 0, x, y, z + 4) && g.inv.spikeTrap === 0);

// architect: a brick wall and a workbench with no bricks or planks
a.material = { id: 'bricks', name: 'Brick', block: B.BRICK, cost: 'bricks' };
Object.assign(a, { tool: 'wall', height: 3, thickness: 1, battlements: false, foundation: true });
const plan = a.makePlan([x - 6, y, z - 6], [x - 2, y, z - 6], y);
a.plan = plan; a.count(plan, true); a.commit();
for (let i = 0; i < 100 && a.busy; i++) step(1);
check('architect wall built for free', w.get(x - 4, y + 2, z - 6) === B.BRICK && g.inv.bricks === 0, [w.get(x - 4, y + 2, z - 6), g.inv.bricks]);
a.placeId = 'workbench'; a.tool = 'place'; a.hoverCell = [x + 2, y, z + 4];
check('workbench spot is valid', !a.placeReason(a.hoverCell), a.placeReason(a.hoverCell));
a.placeObject();
check('architect workbench placed for free', g.construction.benches.length > 0 && g.inv.planks === 0 && w.get(x + 2, y, z + 4) === B.PLANKS);

// save keeps sandbox; a legacy save without the field loads with sandbox off
await g.save('manual'); g.setSandboxMode(false); await g.quickLoad(); g.togglePause(false);
check('save/load restores sandbox', g.sandbox === true);
check('save/load restores the workbench', g.construction.benches.some((b) => b.cell[0] === x + 2 && b.cell[2] === z + 4));
const db = await new Promise((ok) => { const r = indexedDB.open('blockfall-isle', 1); r.onsuccess = () => ok(r.result); });
const data = await new Promise((ok) => { const r = db.transaction('saves').objectStore('saves').get('manual'); r.onsuccess = () => ok(r.result); });
delete data.sandbox;
await new Promise((ok) => { const tx = db.transaction('saves', 'readwrite'); tx.objectStore('saves').put(data, 'manual'); tx.oncomplete = ok; });
db.close();
await g.quickLoad(); g.togglePause(false);
check('legacy save loads with sandbox off', !g.sandbox);
check('without sandbox a trap needs inventory', !g.traps.place('spikes', 0, x + 6, y, z + 4) && g.inv.spikeTrap === 0);
