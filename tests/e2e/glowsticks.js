// Glowstick throwing, lighting, pause/death gating, persistence and the 30-stick cap (was tests/glowstick_validation.py).
// @lock 1
// @steps 20
const key = (code) => { dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true })); dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 10000) => { const t = performance.now(); while (!f()) { if (performance.now() - t > ms) return false; await sleep(30); } await sleep(60); return true; };
const locked = () => document.pointerLockElement === game.canvas;

const g = game, w = g.world, p = g.player.pos, G = g.glowsticks;
const X = Math.floor(p.x), Z = Math.floor(p.z), Y = Math.floor(p.y) + 20;
w.generateAround(X, Z, 3);
for (let x = X - 8; x <= X + 8; x++) for (let z = Z - 8; z <= Z + 8; z++) { w.set(x, Y - 1, z, 1); for (let y = Y; y < Y + 7; y++) w.set(x, y, z, 0); }
w.rebuildAround(X, Z, 2);
p.set(X + .5, Y, Z + .5); g.player.vel.set(0, 0, 0); g.player.aimDir.set(0, 0, -1);
g.time = .9; g.updateDay(0); g.updateCamera(0);

check('starter count is 5', g.inv.glowstick === 5, g.inv.glowstick);
key('KeyL'); check('L throws exactly one', g.inv.glowstick === 4 && G.sticks.length === 1, [g.inv.glowstick, G.sticks.length]);
for (let x = X - 2; x <= X + 2; x++) for (let y = Y; y < Y + 4; y++) w.set(x, y, Z - 2, 1);
for (let i = 0; i < 200; i++) G.update(.01);
const sp = G.sticks[0].mesh.position;
check('wall blocks and stick lands', sp.z > Z - 1 && sp.y < Y + .3, sp.toArray());
check('lit by a real local light', G.lights.filter((l) => l.intensity > 0).length === 1 && G.lights[0].distance > 0 && G.lights[0].position.distanceTo(sp) < 1, G.lights.map((l) => [l.intensity, l.position.distanceTo(sp)]));

key('Escape'); await until(() => g.paused && !document.pointerLockElement);
const before = JSON.stringify(G.snapshot());
key('KeyL'); g.step(1);
check('pause blocks throwing and freezes sticks', G.sticks.length === 1 && JSON.stringify(G.snapshot()) === before);
g.togglePause(false); check('resume recaptures the mouse', await until(locked));
g.player.dead = true; key('KeyL'); check('dead blocks throw', G.sticks.length === 1); g.player.dead = false;

g.save('manual'); await until(() => !g.saving, 60000);
G.restore([]); g.quickLoad(); await until(() => G.sticks.length === 1 && !g.loading, 60000);
check('save/load restores stick', G.sticks.length === 1 && G.sticks[0].remaining > 170, G.sticks[0]?.remaining);
{
  const s = G.snapshot(); G.restore([]); G.restore(s);
  check('snapshot restores position, velocity and lifetime', JSON.stringify(s) === JSON.stringify(G.snapshot()));
}
{
  const s = G.snapshot()[0]; G.restore(Array(30).fill(s));
  const oldest = G.sticks[0], cap = G.lights.filter((l) => l.intensity > 0).length === 4;
  // throwing needs free space at the player's hands and a stick in the inventory
  g.inv.glowstick = Math.max(1, g.inv.glowstick);
  const fifo = G.throw() && G.sticks.length === 30 && !G.sticks.includes(oldest);
  G.update(181);
  check('light pool capped at 4', cap);
  check('31st throw drops the oldest stick', fifo, G.sticks.length);
  check('sticks expire and lights go dark', G.sticks.length === 0 && G.lights.every((l) => l.intensity === 0));
}
