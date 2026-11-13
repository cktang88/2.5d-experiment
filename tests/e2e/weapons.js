// @url /?fast=1&test=1
// @lock 1
// Hand weapons, projectile tuning, held fire, recoil, muzzle flashes and glowsticks.
// Ported from tests/combat_visibility_validation.py, weapon_feedback_validation.py and
// integrated_combat_validation.py. Logic only; the held mouse button is the real canvas handler.
const g = game, W = innerWidth, H = innerHeight;
const down = () => mouse('mousedown', W / 2, H / 2), up = () => mouse('mouseup', W / 2, H / 2);
const V3 = g.player.pos.constructor;
check('pointer lock held', document.pointerLockElement === g.canvas);
g.player.invuln = 999; g.inv.ammo = 100; g.inv.shells = 100;

// --- projectile tuning (combat_visibility) ---
{
  const v = g.player.pos.clone(), d = v.clone().set(1, 0, 0), end = v.clone().add(d.clone().multiplyScalar(10));
  const enemy = { kind: 'enemy' }, player = g.player, turret = { kind: 'turret' };
  const bullet = (owner, hostilesOnly = false) => g.projectiles.bullet(v, d, { dmg: 1, speed: 40, owner, hostilesOnly });
  const eb = bullet(enemy), pb = bullet(player), tb = bullet(turret), trap = bullet(enemy, true);
  const er = g.projectiles.rocket(v, d, enemy), pr = g.projectiles.rocket(v, d, player);
  const acid = g.projectiles.lob('acid', v, end, enemy), acidRef = g.projectiles.lob('acid', v, end, player);
  const grenade = g.projectiles.lob('grenade', v, end, player);
  const flight = 2, at = acid.pos.clone().addScaledVector(acid.vel, flight); at.y -= .5 * acid.g * flight * flight;
  const bl = [eb.vel.length(), eb.life, pb.vel.length(), pb.life, tb.vel.length(), trap.vel.length()];
  check('bullets: hostile half speed, double life; player, turret and trap full speed', JSON.stringify(bl) === JSON.stringify([20, 2.4, 40, 1.2, 40, 40]), bl);
  const rk = [er.vel.length(), er.life, pr.vel.length(), pr.life];
  check('rockets: hostile 13 m/s for 8 s, player 26 m/s for 4 s', JSON.stringify(rk) === JSON.stringify([13, 8, 26, 4]), rk);
  check('acid lob: half speed, g 4.5, life 10, lands on target', Math.abs(acid.vel.length() / acidRef.vel.length() - .5) < 1e-8 && acid.g === 4.5 && acid.life === 10 && at.distanceTo(end) < 1e-8, [acid.g, acid.life, at.distanceTo(end)]);
  check('grenade lob: g 22, life 2.1, vx 14', grenade.g === 22 && grenade.life === 2.1 && Math.abs(grenade.vel.x - 14) < 1e-8, [grenade.g, grenade.life, grenade.vel.x]);
  g.projectiles.reset();
}

// --- hostile vs friendly ratios and wave sizes (integrated_combat) ---
{
  const { WaveDirector } = await import('/src/waveDirector.ts');
  const p = g.projectiles, from = g.player.pos.clone().add(new V3(0, 4, 0)), dir = new V3(1, 0, 0), to = from.clone().add(new V3(12, 0, 0));
  const hostile = { kind: 'spitter' }, friendly = { kind: 'player' };
  const eb = p.bullet(from, dir, { dmg: 1, speed: 80, owner: hostile }), fb = p.bullet(from, dir, { dmg: 1, speed: 80, owner: friendly });
  const er = p.rocket(from, dir, hostile), fr = p.rocket(from, dir, friendly);
  const ea = p.lob('acid', from, to, hostile), fa = p.lob('acid', from, to, friendly);
  const near = (a, b) => Math.abs(a - b) < 1e-8;
  check('hostile bullets half speed, double life', near(eb.vel.length(), 40) && near(fb.vel.length(), 80) && near(eb.life, fb.life * 2));
  check('hostile rockets half speed, double life', near(er.vel.length(), 13) && near(fr.vel.length(), 26) && near(er.life, fr.life * 2));
  check('hostile acid half speed, quarter gravity, double life', ea.vel.distanceTo(fa.vel.clone().multiplyScalar(.5)) < 1e-8 && near(ea.g, fa.g * .25) && near(ea.life, fa.life * 2));
  const sizes = [1, 2, 3, 4].map(WaveDirector.waveSize), fronts = [1, 2, 3, 4].map(n => WaveDirector.frontsForWave(n).length);
  check('wave counts 30/42/54/66 with 1-4 fronts', JSON.stringify(sizes) === '[30,42,54,66]' && JSON.stringify(fronts) === '[1,2,3,4]', { sizes, fronts });
  p.reset();
}

// --- glowsticks (integrated_combat) ---
{
  const w = g.world, X = Math.floor(g.player.pos.x), Z = Math.floor(g.player.pos.z), Y = Math.floor(g.player.pos.y) + 20;
  for (let x = X - 4; x <= X + 4; x++) for (let z = Z - 4; z <= Z + 4; z++) { w.set(x, Y - 1, z, 1); for (let y = Y; y < Y + 9; y++) w.set(x, y, z, 0); }
  g.player.pos.set(X + .5, Y, Z + .5); g.player.vel.set(0, 0, 0);
  const s = g.glowsticks, player = g.player; player.aimDir.set(0, 0, -1); g.inv.glowstick = 40;
  const sample = { pos: [X + .5, Y + 1.45, Z - 1.5], vel: [0, 0, 0], remaining: 42 };
  s.restore(Array.from({ length: 30 }, (_, i) => ({ ...sample, remaining: 40 + i })));
  check('glowstick lights capped at four', s.lights.filter(l => l.intensity > 0).length === 4, s.lights.filter(l => l.intensity > 0).length);
  let old = s.sticks[0];
  check('throw at the cap recycles the oldest stick', s.throw() && s.sticks.length === 30 && !s.sticks.includes(old));
  s.restore([sample]); let n = g.inv.glowstick;
  check('glowstick pickup', s.interact() && g.inv.glowstick === n + 1 && s.sticks.length === 0);
  check('rethrow keeps remaining life', s.throw() && s.sticks[s.sticks.length - 1].remaining === 42);
  s.restore([sample]); w.set(X, Y + 1, Z - 1, 1);
  check('wall blocks glowstick pickup', !s.interact()); w.set(X, Y + 1, Z - 1, 0);
  s.restore(Array.from({ length: 30 }, (_, i) => ({ ...sample, remaining: 40 + i }))); old = s.sticks[0]; n = g.inv.glowstick; g.inv.glowstick = 0;
  check('failed throw preserves sticks', s.throw() === false && s.sticks.length === 30 && s.sticks[0] === old); g.inv.glowstick = n; s.restore([]);
}

// --- recoil and kick per weapon (weapon_feedback) ---
for (const [slot, name, ammo] of [[0, 'pistol', null], [1, 'shotgun', 'shells'], [2, 'smg', 'ammo']]) {
  g.select(slot); g.fireCd = 0; g.camPitch = 0; g.camYaw = 1.5; g.updateCamera(0); g.updateAim(); g.updateActions(0); g.player.update(.016, g.input);
  const baseZ = g.player.gunHolder.position.z, beforeAmmo = g.inv[g.hotbar[slot].ammo];
  down();
  g.updateActions(.016); g.player.update(.001, g.input); g.updateCamera(0); g.updateAim();
  const p = g.player, d = p.aimDir.clone(); g.camera.getWorldDirection(d);
  const st = { kick: p.cameraKick, z: p.gunHolder.position.z, base: baseZ, pitch: g.camPitch, shown: g.camera.rotation.x, aim: p.aimDir.distanceTo(d), ammo: g.inv[g.hotbar[g.sel].ammo] };
  check(name + ' ammunition behavior', ammo === null ? st.ammo === undefined : st.ammo === beforeAmmo - 1, st);
  check(name + ' model and camera kick', st.z > st.base + .02 && 0 < st.kick && st.kick <= .045 && st.shown > 0, st);
  check(name + ' preserves mouse pitch and crosshair aim', st.pitch === 0 && st.aim < 1e-6, st);
  up();
  g.input.lmbPressed = false; for (let i = 0; i < 90; i++) g.player.update(1 / 60, g.input); g.updateCamera(0); g.updateAim();
  check(name + ' returns to rest', g.player.cameraKick < .00001 && Math.abs(g.player.gunHolder.position.z - baseZ) < .001 && g.camPitch === 0);
}
// Real held button; ten deterministic ticks each exceed the SMG interval.
g.select(2); g.inv.ammo = 100; g.fireCd = 0;
down();
for (let i = 0; i < 10; i++) { g.updateActions(.08); g.player.update(.08, g.input); g.input.lmbPressed = false; }
up();
check('held SMG fires ten rounds', g.inv.ammo === 90, g.inv.ammo);
g.select(1); g.updateCamera(0);
check('selection clears recoil', g.player.cameraKick === 0 && g.player.recoil === 0 && g.player.recoilRise === 0);
const shellsAfter = g.inv.shells;
g.input.lmbPressed = false; g.updateActions(1);
check('release and selection do not fire extra rounds', g.inv.ammo === 90 && g.inv.shells === shellsAfter && shellsAfter === 99, [g.inv.ammo, g.inv.shells]);

// --- muzzle flashes under held fire (combat_visibility) ---
g.projectiles.reset();
for (const f of g.flashLights) { f.t = 0; f.l.intensity = 0; }
g.select(2); g.inv.ammo = 100; g.camPitch = 0; g.camYaw = 1.5; g.updateCamera(0); g.updateAim(); g.updateActions(0); g.particles.update(.1);
const lightCount = g.scene.children.filter(x => x.isPointLight).length;
const decay = (dt) => { for (const f of g.flashLights) { f.t -= dt; f.l.intensity = f.t > 0 ? f.power * f.t / f.max : 0; } };
down();
for (let i = 0; i < 10; i++) {
  g.projectiles.update(.0674); g.particles.update(.0674); decay(.0674);
  g.fireCd = 0; g.updateActions(.0834); g.projectiles.update(.016); g.particles.update(.016); decay(.016); g.input.lmbPressed = false;
}
const st = { ammo: g.inv.ammo, active: g.flashLights.filter(f => f.t > 0).length, lights: g.scene.children.filter(x => x.isPointLight).length, flashes: g.flashLights.filter(f => f.t > 0).map(f => [f.power, f.max]) };
up();
check('held SMG: ten rounds, no new lights, at most one small flash', st.ammo === 90 && st.lights === lightCount && st.active <= 1 && JSON.stringify(st.flashes) === '[[4,0.02]]', st);
for (const f of g.flashLights) { f.t = 0; f.l.intensity = 0; }
g.select(1); g.fireCd = 0; g.input.lmbPressed = true; g.updateActions(.016);
const sg = { lights: g.scene.children.filter(x => x.isPointLight).length, flash: g.flashLights.filter(f => f.t > 0).map(f => [f.power, f.max]) };
check('shotgun: reuses lights, one big short flash', sg.lights === lightCount && JSON.stringify(sg.flash) === '[[25,0.06]]', sg);
g.input.lmbPressed = false; g.projectiles.reset();
