// Glowstick pickup, capacity and IndexedDB persistence of recovered lifetimes (was tests/glowstick_recovery_validation.py).
// @lock 1
// @steps 20
const key = (code) => { dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true })); dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })); };
const g = game, w = g.world, p = g.player.pos, G = g.glowsticks;
let X = Math.floor(p.x) + 12, Z = Math.floor(p.z) - 12, Y = 0;
w.generateAround(X, Z, 3);
for (let x = X - 5; x <= X + 5; x++) for (let z = Z - 5; z <= Z + 5; z++) Y = Math.max(Y, w.surfaceY(x, z));
Y += 3;
for (let x = X - 5; x <= X + 5; x++) for (let z = Z - 5; z <= Z + 5; z++) { w.set(x, Y - 1, z, 1); for (let y = Y; y < Y + 5; y++) w.set(x, y, z, 0); }
p.set(X + .5, Y, Z + .5); g.player.vel.set(0, 0, 0); g.player.aimDir.set(0, 0, 1); g.inv.glowstick = 40;
for (let i = 0; i < 30; i++) { G.throw(); G.sticks[i].remaining = 100 + i; }

check('30 sticks out, 10 left, 4 lights', G.sticks.length === 30 && g.inv.glowstick === 10 && G.lights.filter((l) => l.intensity > 0).length === 4, [G.sticks.length, g.inv.glowstick]);
{ const s = G.sticks[0]; g.inv.glowstick = 0; const ok = G.throw(); g.inv.glowstick = 10; check('empty inventory cannot throw', !ok && G.sticks[0] === s); }
{ const s = G.sticks[0]; w.set(X, Y + 1, Z, 1); const ok = G.throw(); w.set(X, Y + 1, Z, 0); check('no room to throw keeps sticks', !ok && G.sticks[0] === s); }
{ const first = G.sticks[0], second = G.sticks[1]; check('throw at cap replaces the oldest', G.throw() && G.sticks.length === 30 && G.sticks[0] === second && !g.scene.children.includes(first.mesh)); }

G.sticks.forEach((s) => s.mesh.position.set(X + 3, Y + 1.45, Z + 3));
G.sticks[0].mesh.position.set(X + .5, Y + 1.45, Z + 2.5); G.sticks[0].remaining = 42; g.updateActions(0);
check('pickup prompt', document.querySelector('#interaction').innerText === 'E · Pick up glowstick', document.querySelector('#interaction').innerText);
g.paused = true; key('KeyE'); check('paused blocks pickup', G.sticks.length === 30);
g.paused = false; w.set(X, Y + 1, Z + 1, 1); key('KeyE'); check('wall blocks pickup', G.sticks.length === 30);
w.set(X, Y + 1, Z + 1, 0); G.sticks[0].mesh.position.z = Z + 5.5; key('KeyE'); check('too far to pick up', G.sticks.length === 30);
G.sticks[0].mesh.position.z = Z + 2.5; key('KeyE');
check('E picks up one stick', G.sticks.length === 29 && g.inv.glowstick === 10 && G.lights.length === 4, [G.sticks.length, g.inv.glowstick]);
key('KeyE'); check('nothing aimed at: no extra pickup', g.inv.glowstick === 10);
key('KeyL'); check('rethrown stick keeps its remaining lifetime', G.sticks.length === 30 && g.inv.glowstick === 9 && G.sticks[29].remaining === 42, [G.sticks.length, g.inv.glowstick, G.sticks[29]?.remaining]);
G.sticks[0].mesh.position.set(X + .5, Y + 1.45, Z + 2.5); G.sticks[0].remaining = 37; key('KeyE');
const savedOrder = G.snapshot();
const save = await import('/src/save.ts');
await save.saveGame(g, 'manual'); G.restore([]); g.inv.glowstick = 0; await save.loadGame(g, 'manual');
check('save/load keeps stick order and inventory', JSON.stringify(G.snapshot()) === JSON.stringify(savedOrder) && g.inv.glowstick === 10, g.inv.glowstick);
check('recovered lifetime survives save/load', G.throw() && G.sticks.at(-1).remaining === 37, G.sticks.at(-1)?.remaining);
