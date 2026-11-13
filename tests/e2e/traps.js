// Trap placement, combat and persistence in a controlled flat arena (was tests/trap_validation.py).
// @steps 20
const g = game, w = g.world, p = g.player.pos;
let X = Math.floor(p.x), Z = Math.floor(p.z), Y = Math.floor(p.y) + 6;
w.generateAround(X, Z, 3);
for (let x = X - 10; x <= X + 10; x++) for (let z = Z - 10; z <= Z + 10; z++) { w.set(x, Y - 1, z, 1); for (let y = Y; y < Y + 6; y++) w.set(x, y, z, 0); }
w.rebuildAround(X, Z, 2); p.set(X + .5, Y, Z - 4.5); g.player.vel.set(0, 0, 0);
g.entities.enemies.forEach((e) => (e.dead = true)); g.entities.enemies = [];
Object.assign(g.inv, { spikeTrap: 3, trapdoor: 3, arrowTrap: 4, flameTrap: 4, blastMine: 2, ammo: 50, goo: 50 });
const x = X, y = Y, z = Z;

{ // spikes
  const before = g.inv.spikeTrap;
  check('no charge on invalid placement', !g.traps.place('spikes', 0, x, y + 1, z) && g.inv.spikeTrap === before);
  check('spike trap placed', g.traps.place('spikes', 0, x, y, z));
  const e = g.entities.spawnEnemy('zombie', x + .5, y, z + .5), hp = e.hp, php = g.player.hp;
  g.traps.update(0); check('paused (dt 0) does no damage', e.hp === hp, [e.hp, hp]);
  g.traps.update(.01); check('spikes damage enemy, not player', e.hp < hp && g.player.hp === php, [e.hp, hp, g.player.hp, php]);
  e.dead = true; g.traps.restore([]);
}
{ // trapdoor
  w.set(x, y - 1, z, 0); w.set(x + 1, y, z, 1);
  check('trapdoor placed over a hole', g.traps.place('trapdoor', 0, x, y, z));
  g.player.pos.set(x + .5, y, z - 2); g.player.aimDir.set(0, -.2, 1).normalize();
  const t = g.traps.traps[0];
  check('closed trapdoor is solid', w.get(x, y, z) === 8, w.get(x, y, z));
  g.traps.interact(); check('opened trapdoor is air', t.open && w.get(x, y, z) === 0);
  const e = g.entities.spawnEnemy('zombie', x + .5, y + 1, z + .5); e.vel.set(0, 0, 0);
  for (let i = 0; i < 20; i++) e.physics(.05);
  check('enemy falls through open trapdoor', e.pos.y < y + .5, e.pos.y - y);
  e.pos.set(x + .5, y, z + .5); g.traps.interact(); check('actor blocks closing', t.open);
  e.dead = true; g.traps.interact(); check('closes solid once clear', !t.open && w.get(x, y, z) === 8);
  const s = g.traps.snapshot(); g.traps.restore(s);
  check('restore keeps closed trapdoor', g.traps.traps.length === 1 && !g.traps.traps[0].open);
  g.traps.restore([]); w.set(x, y, z, 0); w.set(x, y - 1, z, 1); w.set(x + 1, y, z, 0);
}
{ // flame
  g.entities.enemies = []; g.traps.place('flame', 0, x, y, z);
  const t = g.traps.traps[0], e = g.entities.spawnEnemy('zombie', x + .5, y, z - 3.5), hp = e.hp;
  g.traps.update(.1); check('flame: enemy behind is safe', e.hp === hp && t.ammo === 30, [e.hp, hp, t.ammo]);
  e.pos.set(x + 4.5, y, z + .5); g.traps.update(.1); check('flame: enemy at side is safe', e.hp === hp);
  e.pos.set(x + .5, y, z + 4.5); w.set(x, y, z + 2, 1); g.traps.update(.1); check('flame: wall blocks', e.hp === hp);
  w.set(x, y, z + 2, 0); g.traps.update(.1);
  check('flame hits in front and is visible', e.hp < hp && t.ammo === 29 && g.traps.flames.length > 0, [e.hp, hp, t.ammo, g.traps.flames.length]);
  const s = g.traps.snapshot(); g.traps.restore(s); check('flame ammo persists', g.traps.traps[0].ammo === 29);
  e.dead = true; g.traps.restore([]);
}
{ // arrow
  g.entities.enemies = []; g.traps.place('arrow', 0, x, y, z);
  const t = g.traps.traps[0], e = g.entities.spawnEnemy('zombie', x + .5, y, z + 4.5), hp = e.hp;
  g.traps.update(.1); check('arrow trap fires a hostiles-only arrow', t.ammo === 19 && g.projectiles.list.some((q) => q.hostilesOnly), t.ammo);
  for (let i = 0; i < 20; i++) g.projectiles.update(.01);
  check('arrow hits enemy', e.hp < hp); e.dead = true; g.traps.restore([]);
}
{ // hostile-only projectiles spare wildlife and TNT
  g.entities.enemies = [];
  const animal = g.entities.spawnEnemy('zombie', x + .5, y, z + 2.5); g.entities.enemies = []; g.foraging.wildlife.push(animal);
  const hp = animal.hp; w.set(x, y, z + 4, 12);
  const origin = g.player.pos.clone().set(x + .5, y + .7, z + .5), dir = origin.clone().set(0, 0, 1);
  g.projectiles.bullet(origin, dir, { dmg: 50, blockDmg: 0, owner: g.player, hostilesOnly: true });
  for (let i = 0; i < 20; i++) g.projectiles.update(.01);
  check('hostile-only shot spares wildlife', animal.hp === hp);
  check('hostile-only shot spares TNT', w.get(x, y, z + 4) === 12);
  g.foraging.wildlife.pop(); animal.dead = true; w.set(x, y, z + 4, 0);
}
