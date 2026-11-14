// Level tool and level foundations in the running game: npm run e2e -- level
// @url /?fast=1&test=1
const { B } = await import('/src/blocks.ts');
const g = game, w = g.world, a = g.architect, p = g.player.pos;
a.enter(); step(10); a.timePaused = true;
const X = Math.floor(p.x) - 30, Z = Math.floor(p.z) - 30, base = 60;
// rough site: flat ground at y 59, a pit and a mound, plus a tree trunk
for (let x = X - 2; x <= X + 16; x++) for (let z = Z - 2; z <= Z + 16; z++) for (let y = base - 8; y < base + 10; y++) w.set(x, y, z, y < base ? B.DIRT : B.AIR);
for (let x = X + 3; x <= X + 5; x++) for (let z = Z + 3; z <= Z + 5; z++) for (let y = base - 4; y < base; y++) w.set(x, y, z, B.AIR);
for (let x = X + 9; x <= X + 11; x++) for (let z = Z + 9; z <= Z + 11; z++) for (let y = base; y < base + 3; y++) w.set(x, y, z, B.STONE);
for (let y = base; y < base + 4; y++) w.set(X + 7, y, Z + 2, B.LOG);
const run = () => { for (let i = 0; i < 300 && a.busy; i++) step(1, 0.016); };

// 1. the level tool on its own
a.selectTool('level');
let plan = a.makePlan([X, base, Z], [X + 14, base, Z + 14], base);
a.plan = plan; a.count(plan, true); a.commit(); run();
let flat = true;
for (let x = X; x <= X + 14; x++) for (let z = Z; z <= Z + 14; z++) if (w.surfaceY(x, z) !== base) flat = false;
check('level tool: every column ends at the start height', flat);
check('pit filled with earth, grass on top', w.get(X + 4, base - 2, Z + 4) === B.DIRT && w.get(X + 4, base - 1, Z + 4) === B.GRASS);
check('mound and tree cut away', w.get(X + 10, base + 1, Z + 10) === B.AIR && w.get(X + 7, base + 2, Z + 2) === B.AIR);
a.undo(); run();
check('undo restores the pit, mound and tree', w.get(X + 4, base - 2, Z + 4) === B.AIR && w.get(X + 10, base + 1, Z + 10) === B.STONE && w.get(X + 7, base + 2, Z + 2) === B.LOG);

// 2. a wall enclosure with level foundations: levelling and the walls are one undo step
a.selectTool('wall'); a.foundation = 'level'; a.height = 4; a.thickness = 1; a.battlements = false;
const before = a.undoStack.length;
plan = a.makePlan([X, base, Z], [X + 14, base, Z + 14], base);
check('preview shows earth fill and the cut', plan.earth.length > 0 && plan.cut.length > 0 && plan.fallCount === 0, { earth: plan.earth.length, cut: plan.cut.length, falls: plan.fallCount });
a.plan = plan; a.count(plan, true); a.commit(); run(); step(30, 1 / 30);
check('walls stand on the levelled ground', w.get(X, base + 3, Z) === B.BRICK && w.get(X + 14, base + 3, Z + 14) === B.BRICK);
check('courtyard levelled too', w.surfaceY(X + 4, Z + 4) === base && w.get(X + 10, base + 1, Z + 10) === B.AIR);
const grouped = a.undoStack.length - before;
a.undo(); run();
check('one undo removes walls and levelling together', a.undoStack.length === before && w.get(X, base + 3, Z) === B.AIR && w.get(X + 10, base + 1, Z + 10) === B.STONE, { opsCommitted: grouped });
a.redo(); run();
check('redo brings both back', w.get(X, base + 3, Z) === B.BRICK && w.get(X + 10, base + 1, Z + 10) === B.AIR);

// 3. without foundations, a wall over a wide gap warns which blocks will fall
a.foundation = 'off';
// flat ground with a 12-wide, 6-deep gap across the wall line
for (let x = X + 15; x <= X + 40; x++) for (let z = Z - 1; z <= Z + 1; z++) for (let y = base - 6; y < base + 6; y++) {
  const gap = x >= X + 20 && x < X + 32;
  w.set(x, y, z, y < base && !gap ? B.DIRT : B.AIR);
}
plan = a.makePlan([X + 15, base, Z], [X + 36, base, Z], base);
check('wide-gap wall predicts its falling middle', plan.fallCount === 6 * 4, plan.fallCount);
a.exit(false); step(10);
return { grouped };
