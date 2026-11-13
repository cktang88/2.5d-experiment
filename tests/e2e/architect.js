// Architect mode journey, logic only (no rendering): npm run probe -- --eval-file tests/e2e/architect.js
// Helpers from scripts/probe.mjs: step, render, check, mouse, drag.
const a = game.architect, W = innerWidth, H = innerHeight;
a.enter(); step(30);
check('Q view opens with a free cursor', a.open && a.cameraActive && !document.pointerLockElement);
check('camera rose above the player', game.camera.position.y - game.player.pos.y > 25, game.camera.position.y - game.player.pos.y);
check('first-person tool hidden', !game.player.gunHolder.visible);
a.timePaused = true;

a.selectTool('wall');
const tip = drag(W * 0.35, H * 0.4, W * 0.65, H * 0.65);
step(20);
check('wall drag reports size and block count', /×/.test(tip) && /blocks/.test(tip), tip);
check('wall recorded for undo', a.undoStack.length === 1, a.undoStack.length);
const placed = a.undoStack[0]?.cells.length / 3;
a.undo(); step(20);
check('undo clears it', a.undoStack.length === 0 && a.redoStack.length === 1);
a.redo(); step(20);
check('redo restores it', a.undoStack.length === 1 && a.undoStack[0].cells.length / 3 === placed);

// right-click cancels a drag in progress
a.selectTool('box');
mouse('mousemove', W * 0.4, H * 0.4); step(1); mouse('mousedown', W * 0.4, H * 0.4); step(1);
mouse('mousemove', W * 0.6, H * 0.6); step(1);
mouse('mousedown', W * 0.6, H * 0.6, 2); mouse('mouseup', W * 0.6, H * 0.6, 2); mouse('mouseup', W * 0.6, H * 0.6); step(2);
check('right-click cancels the drag', a.undoStack.length === 1);

// a placed turret stands exactly where its range ring was drawn
game.sandbox = true; a.placeId = 'twin'; a.selectTool('place');
let spot = null;
const p = game.player.pos;
for (let dx = -30; dx < 30 && !spot; dx++) for (let dz = -30; dz < 30; dz++) {
  const x = Math.floor(p.x) + dx, z = Math.floor(p.z) + dz, c = [x, game.world.surfaceY(x, z), z];
  if (!a.placeReason(c)) { spot = c; break; }
}
check('found a clear turret spot', !!spot);
if (spot) {
  a.pick = function () { this.hoverCell = spot; this.hoverSolid = [spot[0], spot[1] - 1, spot[2]]; this.hoverPoint = null; };
  step(1);
  const ring = game.rangeRing.position.clone();
  a.placeObject();
  const t = game.entities.turrets.at(-1);
  check('turret spawns at its ring centre', t && Math.abs(t.pos.x - ring.x) < 1e-6 && Math.abs(t.pos.z - ring.z) < 1e-6, { ring: [ring.x, ring.z], turret: t && [t.pos.x, t.pos.z] });
  delete a.pick;
}

a.exit(false); step(20);
check('exit returns to first person', !a.open && !a.cameraActive && game.player.gunHolder.visible && game.shared.uSlice.value === 0);
return { placed };
