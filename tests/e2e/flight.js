// @url /?fast=1&test=1
// @steps 40
// @lock 1
// Jetpack ground-relative altitude limit (was tests/flight_ceiling_validation.py). The flight rules themselves
// are unit-tested in tests/jetpack.test.mjs; this checks them through the real player physics and Space key.
// npm run e2e -- flight
const { B } = await import('/src/blocks.ts');
const g = game, p = g.player, w = g.world, x = Math.floor(p.pos.x), z = Math.floor(p.pos.z);
const key = (type, code) => dispatchEvent(new KeyboardEvent(type, { code }));
check('pointer lock held for player input', document.pointerLockElement === g.canvas);
for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
  w.ensureColumn((x + dx) >> 5, (z + dz) >> 5);
  for (let y = 80; y <= 150; y++) w.set(x + dx, y, z + dz, B.AIR);
  w.set(x + dx, 99, z + dz, B.STONE);
}
p.pos.set(x + 0.5, 100, z + 0.5); p.vel.set(0, 0, 0); g.jetpack.active = true;
key('keydown', 'Space');
g.simulate(8, 1 / 60);
check('holding Space levels off 30 above the ground', Math.abs(p.pos.y - 130) < 0.01, p.pos.y);
key('keyup', 'Space');
// flying off a plateau over a deep drop: no snap down, a gentle descent instead
w.set(x, 99, z, B.AIR);
g.simulate(1 / 60, 1 / 60);
check('losing the ground below does not teleport', p.pos.y > 129.8 && p.pos.y < 130 && p.vel.y >= -7 && p.vel.y < 0, { y: p.pos.y, vy: p.vel.y });
g.simulate(2, 1 / 60);
check('then descends toward the new limit', p.pos.y < 125, { y: p.pos.y, vy: p.vel.y, altitude: p.flightAltitude, dead: p.dead, paused: g.paused });
// a ceiling above the feet is never mistaken for the ground
w.set(x, 99, z, B.STONE); w.set(x, 125, z, B.STONE);
p.pos.set(x + 0.5, 110, z + 0.5); p.vel.set(0, 0, 0);
p.update(1 / 60, g.input);
check('altitude is measured to the ground, not a ceiling', Math.abs(p.flightAltitude - 10) < 0.01, p.flightAltitude);
// a save already above the limit descends without teleporting
w.set(x, 125, z, B.AIR);
p.pos.set(x + 0.5, 140, z + 0.5); p.vel.set(0, 0, 0);
g.simulate(1 / 60, 1 / 60);
check('above the limit it descends smoothly', p.pos.y > 139.8 && p.pos.y < 140, p.pos.y);
