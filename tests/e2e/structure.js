// @url /?fast=1&test=1
// @steps 40
// Structure stability (was tests/structure_stability_validation.py): supported architect shapes stay put,
// an undermined tower collapses through game.checkSupport, and a turret holds still until its support goes.
// npm run e2e -- structure
const { B } = await import('/src/blocks.ts');
const { Turret } = await import('/src/entities.ts');
const g = game, w = g.world, a = g.architect, S = w.gen.spawn;
const X = S.x + 30, Z = S.z + 30, Y = w.surfaceY(X, Z);
for (let x = X - 16; x <= X + 16; x++) for (let z = Z - 16; z <= Z + 16; z++) {
  w.set(x, Y - 1, z, B.GRASS); for (let y = Y; y <= Y + 12; y++) w.set(x, y, z, B.AIR);
}
g.freeBuild = true;
a.material = { id: 'bricks', name: 'Brick', block: B.BRICK, cost: 'bricks' };
// plan + commit exactly like a drag in the overhead view, then let the job write its cells
function build(tool, from, to, opts = {}) {
  Object.assign(a, { tool, height: 4, thickness: 1, battlements: true, foundation: true, hollow: true }, opts);
  const plan = a.makePlan([from[0], Y, from[1]], [to[0], Y, to[1]], Y);
  if (plan.error) throw Error(`${tool}: ${plan.error}`);
  const before = a.undoStack.length;
  a.plan = plan; a.count(plan, true); a.commit();
  for (let i = 0; i < 200 && a.busy; i++) step(1);
  const op = a.undoStack.length > before ? a.undoStack.at(-1) : null;
  const cells = [];
  if (op) for (let i = 0; i < op.next.length; i++) if (op.next[i] !== B.AIR) cells.push([op.cells[i * 3], op.cells[i * 3 + 1], op.cells[i * 3 + 2]]);
  return cells;
}
const tower = build('tower', [X, Z], [X + 2, Z]);
const stairs = build('stairs', [X + 7, Z - 1], [X + 11, Z]);
const battlement = build('wall', [X - 10, Z], [X - 6, Z]);
check('tower, stairs and battlement placed', tower.length && stairs.length && battlement.length, { tower: tower.length, stairs: stairs.length, battlement: battlement.length });
for (let i = 0; i < 180; i++) g.physics.update(1 / 60);
step(20);
const moved = [...tower, ...stairs, ...battlement].filter(([x, y, z]) => w.get(x, y, z) !== B.BRICK);
check('supported shapes stay put', moved.length === 0, moved.slice(0, 5));

// uneven site: a block already in the footprint is kept and the rest still stands
w.set(X + 8, Y, Z + 8, B.COBBLE);
const uneven = build('tower', [X + 8, Z + 8], [X + 10, Z + 8]);
for (let i = 0; i < 60; i++) g.physics.update(1 / 60);
check('existing block inside a new tower is preserved', w.get(X + 8, Y, Z + 8) === B.COBBLE && !uneven.some(([x, y, z]) => x === X + 8 && y === Y && z === Z + 8));
check('uneven supported tower stands', uneven.length > 0 && uneven.every(([x, y, z]) => w.get(x, y, z) === B.BRICK));

// remove the whole foundation under the first tower and run the same support check as a blast
const removed = [];
for (let x = X - 3; x <= X + 3; x++) for (let z = Z - 3; z <= Z + 3; z++) { w.set(x, Y - 1, z, B.AIR); removed.push([x, Y - 1, z]); }
g.checkSupport(removed);
check('undermined tower collapses', tower.some(([x, y, z]) => w.get(x, y, z) === B.AIR));

// a damaged turret on solid ground stays put; it falls once the ground under it goes
const t = new Turret(g, X - 9.5, Y, Z + 8.5, 'auto'); t.ammo = 0;
g.entities.turrets.push(t);
t.damage(1, t.pos.clone().set(5, 5, 3));
const start = t.pos.clone();
for (let i = 0; i < 60; i++) t.update(1 / 60);
check('supported turret does not move', t.pos.distanceTo(start) < 1e-6, t.pos.toArray());
// the auto turret stands on a 2×2 footprint now: take all of it away
for (let x = Math.floor(t.pos.x - 1); x <= Math.floor(t.pos.x + 0.999); x++) for (let z = Math.floor(t.pos.z - 1); z <= Math.floor(t.pos.z + 0.999); z++) w.set(x, Y - 1, z, B.AIR);
for (let i = 0; i < 30; i++) t.update(1 / 60);
check('turret falls after support loss', t.pos.y < Y - 0.1, t.pos.y);
return { tower: tower.length, stairs: stairs.length, battlement: battlement.length, uneven: uneven.length };
