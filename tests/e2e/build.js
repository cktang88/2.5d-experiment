// @url /?fast=1&test=1
// @steps 40
// @lock 1
// Building with the architect (was tests/spatial_building_validation.py, written for the removed Q blueprint
// panel): free build with no resources, paid build charging only new cells and keeping existing blocks,
// a no-op on a filled volume, actors' cells skipped, unsupported shapes falling, undo refunds, walkable
// stairs onto a landing, architect drawbridge placement, and paused clicks doing nothing.
// npm run e2e -- build
const { B } = await import('/src/blocks.ts');
const g = game, w = g.world, a = g.architect, S = w.gen.spawn, p = g.player;
const X = S.x + 30, Z = S.z + 30, Y = w.surfaceY(X, Z);
function clear() {
  for (let x = X - 12; x <= X + 12; x++) for (let z = Z - 12; z <= Z + 12; z++) {
    w.set(x, Y - 1, z, B.GRASS); for (let y = Y; y <= Y + 14; y++) w.set(x, y, z, B.AIR);
  }
}
clear();
p.pos.set(X - 8.5, Y, Z + 8.5); p.vel.set(0, 0, 0);
a.material = { id: 'planks', name: 'Planks', block: B.PLANKS, cost: 'planks' };
Object.assign(a, { battlements: false, foundation: false, thickness: 1 });
function build(tool, from, to, opts = {}) {
  Object.assign(a, { tool }, opts);
  const base = opts.base ?? Y;
  const plan = a.makePlan([from[0], base, from[1]], [to[0], base, to[1]], base);
  a.plan = plan; a.count(plan, true);
  const counted = a.counts.add, before = a.undoStack.length;
  a.commit();
  for (let i = 0; i < 200 && a.busy; i++) step(1);
  return { plan, counted, recorded: a.undoStack.length > before };
}
const box = [[X, Z], [X + 2, Z + 2]], cellsIn = (y0, y1) => {
  let n = 0; for (let x = X; x <= X + 2; x++) for (let z = Z; z <= Z + 2; z++) for (let y = y0; y <= y1; y++) if (w.get(x, y, z) === B.PLANKS) n++; return n;
};

// free build: a 3×3×3 block of planks with none in the inventory
g.freeBuild = true; g.inv.planks = 0;
build('box', ...box, { height: 3 });
check('free build succeeds with zero resources', g.inv.planks === 0 && cellsIn(Y, Y + 2) === 27, cellsIn(Y, Y + 2));
a.undo(); for (let i = 0; i < 100 && a.busy; i++) step(1);
check('undo removes the free build', cellsIn(Y, Y + 2) === 0 && g.inv.planks === 0);

// paid: an existing cobble block in the footprint is kept and not charged
clear(); w.set(X + 1, Y, Z + 1, B.COBBLE);
g.freeBuild = false; g.inv.planks = 100;
const paid = build('box', ...box, { height: 3 });
check('preview counts only air', paid.counted === 26, paid.counted);
check('paid build keeps the existing block and charges new cells', w.get(X + 1, Y, Z + 1) === B.COBBLE && g.inv.planks === 74 && cellsIn(Y, Y + 2) === 26, { planks: g.inv.planks, n: cellsIn(Y, Y + 2) });
a.undo(); for (let i = 0; i < 100 && a.busy; i++) step(1);
check('undo refunds and restores the old block', g.inv.planks === 100 && w.get(X + 1, Y, Z + 1) === B.COBBLE && cellsIn(Y, Y + 2) === 0, g.inv.planks);

// the same volume already full is a no-op that spends nothing and records nothing
clear();
for (let x = X; x <= X + 2; x++) for (let z = Z; z <= Z + 2; z++) for (let y = Y; y <= Y + 2; y++) w.set(x, y, z, B.COBBLE);
const noop = build('box', ...box, { height: 3 });
check('fully occupied volume is a no-op', noop.counted === 0 && !noop.recorded && g.inv.planks === 100, { counted: noop.counted, planks: g.inv.planks });

// not enough planks: refused with nothing written
clear(); g.inv.planks = 5;
const short = build('box', ...box, { height: 3 });
check('short on planks: nothing built or spent', !short.recorded && cellsIn(Y, Y + 2) === 0 && g.inv.planks === 5);
g.inv.planks = 100;

// an actor standing in the volume: its cells are skipped and refunded, the rest is built
clear();
p.pos.set(X + 1.5, Y, Z + 1.5); p.vel.set(0, 0, 0);
const actor = build('box', ...box, { height: 3 });
const placed = cellsIn(Y, Y + 2);
check('actor cells are skipped', w.get(X + 1, Y, Z + 1) === B.AIR && w.get(X + 1, Y + 1, Z + 1) === B.AIR && placed > 0 && placed < 27, placed);
check('skipped cells are refunded', g.inv.planks === 100 - placed, { planks: g.inv.planks, placed, counted: actor.counted });
p.pos.set(X - 8.5, Y, Z + 8.5); p.vel.set(0, 0, 0);

// unsupported: a floating slab with no foundation falls once written (support is checked as the job finishes)
clear();
build('box', [X, Z], [X + 2, Z + 2], { height: 1, base: Y + 6, foundation: false });
step(5);
check('unsupported slab collapses', cellsIn(Y + 6, Y + 6) < 9, cellsIn(Y + 6, Y + 6));

// stairs up to an existing landing: the landing is kept, risers are one block
clear(); g.freeBuild = true; g.inv.planks = 0;
w.set(X + 3, Y, Z, B.COBBLE); w.set(X + 3, Y + 1, Z, B.COBBLE);
build('stairs', [X, Z], [X + 3, Z + 2], { height: 3 });
check('stairs keep the landing and cost nothing in free build', w.get(X + 3, Y, Z) === B.COBBLE && w.get(X + 3, Y + 1, Z) === B.COBBLE && g.inv.planks === 0);
const tops = [];
for (let x = X; x <= X + 3; x++) { let t = Y - 1; for (let y = Y; y <= Y + 4; y++) if (w.solid(x, y, Z + 1)) t = y; tops.push(t); }
check('stairs rise one block per step', tops.length === 4 && tops[3] >= Y + 2 && tops.every((v, i) => !i || (v - tops[i - 1] >= 0 && v - tops[i - 1] <= 1)), tops);

// walk and jump up the risers with normal player physics
const key = (type, code) => dispatchEvent(new KeyboardEvent(type, { code }));
g.jetpack.active = false;
p.pos.set(X - 0.6, Y, Z + 1.5); p.vel.set(0, 0, 0);
g.camYaw = g.camYawT = -Math.PI / 2; g.camPitch = 0;
check('pointer lock held for player input', document.pointerLockElement === g.canvas);
key('keydown', 'KeyW');
let maxY = p.pos.y;
for (let j = 0; j < 2; j++) {
  g.jetpack.resetTap(); key('keydown', 'Space');
  for (let i = 0; i < 3; i++) { g.step(1 / 30); maxY = Math.max(maxY, p.pos.y); }
  key('keyup', 'Space');
  for (let i = 0; i < 9; i++) { g.step(1 / 30); maxY = Math.max(maxY, p.pos.y); }
  check(`flight stays off during stair jump ${j}`, !g.jetpack.active);
}
key('keyup', 'KeyW');
check('player can ascend the stairs with jumps', p.pos.x > X + 2 && maxY >= Y + 2, { x: p.pos.x - X, maxY: maxY - Y });
key('keydown', 'KeyS'); g.simulate(2, 1 / 30); key('keyup', 'KeyS');
check('player can descend the stairs', !g.jetpack.active && p.pos.x < X && p.pos.y < Y + 0.2, { x: p.pos.x - X, y: p.pos.y - Y });

// drawbridge from the architect: needs a bank at the hinge end, costs six planks when paid
clear(); g.freeBuild = false; g.inv.planks = 10;
p.pos.set(X - 8.5, Y, Z + 8.5); p.vel.set(0, 0, 0);
for (let x = X - 4; x <= X + 4; x++) for (let z = Z - 1; z <= Z + 5; z++) for (let y = Y - 3; y < Y; y++) w.set(x, y, z, B.AIR); // a ditch
a.placeId = 'drawbridge'; a.tool = 'place'; a.rotation = 0;
a.hoverCell = [X, Y, Z];
const why = a.placeReason(a.hoverCell);
const writesBefore = w.get(X, Y, Z);
a.placeObject();
check('drawbridge over open air is refused without writes', /bank/i.test(why) && w.get(X, Y, Z) === writesBefore && g.inv.planks === 10, why);
for (let x = X - 1; x <= X + 2; x++) for (let z = Z - 1; z <= Z; z++) w.set(x, Y - 1, z, B.STONE); // the near bank (anchored ground), under the hinge
check('drawbridge with a bank at the hinge is valid', !a.placeReason(a.hoverCell), a.placeReason(a.hoverCell));
a.placeObject();
let deck = 0; for (let x = X; x <= X + 1; x++) for (let z = Z; z <= Z + 2; z++) if (w.get(x, Y, z) === B.PLANKS) deck++;
check('drawbridge placed and charged six planks', deck === 6 && g.inv.planks === 4 && g.construction.snapshot().bridges.length === 1, { deck, planks: g.inv.planks });
p.pos.set(X + 1, Y, Z - 2); p.vel.set(0, 0, 0); p.aimDir.set(0, 0, 1);
check('drawbridge raises from beside it', g.construction.interact() === 'bridge' && g.construction.snapshot().bridges[0].raised && w.get(X, Y + 2, Z) === B.PLANKS, g.construction.snapshot().bridges[0]);

// paused clicks do not place or charge
clear(); g.select(g.hotbar.findIndex((s) => s.id === 'planks'));
g.freeBuild = false; g.inv.planks = 50;
p.pos.set(X + 0.5, Y, Z + 3.5); p.vel.set(0, 0, 0); g.camYaw = g.camYawT = 0; g.camPitch = -0.6;
g.togglePause(true);
g.input.lmb = g.input.lmbPressed = true; step(5); g.input.lmb = false;
let any = 0; for (let x = X - 3; x <= X + 3; x++) for (let z = Z - 3; z <= Z + 6; z++) for (let y = Y; y <= Y + 3; y++) if (w.get(x, y, z) === B.PLANKS) any++;
check('paused clicks do not place or charge', any === 0 && g.inv.planks === 50 && !g.input.lmbPressed, { any, planks: g.inv.planks });
