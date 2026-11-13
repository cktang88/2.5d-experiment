// @url /?fast=1&test=1
// Paused combat is frozen through Game.step, and a quick-loaded game stays paused with models in place.
// Ported from tests/pause_combat_validation.py.
const ents = await import('/src/entities.ts'), g = game, w = g.world;
const X = Math.floor(g.player.pos.x) + 12, Z = Math.floor(g.player.pos.z) - 12;
const Y = w.surfaceY(X, Z) + 3;
for (let x = X - 4; x <= X + 4; x++) for (let z = Z - 10; z <= Z + 10; z++) { w.set(x, Y - 1, z, 1); for (let y = Y; y <= Y + 5; y++) w.set(x, y, z, 0); }
g.player.pos.set(X, Y, Z + 8); g.entities.enemies = []; g.entities.turrets = [];
const turret = new ents.Turret(g, X + .5, Y, Z - 8, 'auto');
g.entities.turrets.push(turret);
const enemy = g.entities.spawnEnemy('brute', X + .5, Y, Z + 5);
turret.yaw = 0; turret.cd = 0; g.paused = true;
let ammo = turret.ammo;
g.step(.016);
check('paused turret holds fire', turret.ammo === ammo && g.projectiles.list.length === 0, [turret.ammo, ammo, g.projectiles.list.length]);
g.paused = false; g.step(.016);
check('resumed turret fires', turret.ammo === ammo - 1 && g.projectiles.list.length > 0, [turret.ammo, ammo, g.projectiles.list.length]);
g.projectiles.reset(); turret.dead = true;
enemy.pos.copy(g.player.pos); enemy.atkCd = 0; g.player.hp = 100; g.player.invuln = 0;
g.paused = true; g.step(.016);
check('paused melee does nothing', g.player.hp === 100 && enemy.atkCd === 0, [g.player.hp, enemy.atkCd]);
const grenade = g.projectiles.lob('grenade', g.player.pos.clone(), g.player.pos.clone(), g.player);
grenade.life = 0; let hp = g.player.hp;
g.step(.016);
check('paused projectile does not detonate', g.projectiles.list.includes(grenade) && g.player.hp === hp);
g.paused = false; g.step(.016);
check('resumed projectile detonates', !g.projectiles.list.includes(grenade));

// quick-load lands paused, with models at their actors and nothing advancing
{
  const p = g.player.pos;
  g.projectiles.reset(); g.entities.enemies = []; g.entities.turrets = [];
  g.player.hp = 100;
  g.entities.spawnEnemy('brute', p.x + 4, p.y, p.z);
  const t = new ents.Turret(g, p.x - 8, p.y, p.z, 'auto');
  g.entities.turrets.push(t); t.cd = 0;
  await g.save('manual'); await g.quickLoad();
  const loaded = g.entities.enemies[0], tl = g.entities.turrets[0];
  check('quick-load restored one enemy and one turret', !!loaded && !!tl, [g.entities.enemies.length, g.entities.turrets.length]);
  if (loaded && tl) {
    const a = tl.ammo; hp = g.player.hp; const enemyHp = loaded.hp;
    g.step(.016);
    check('quick-load leaves the game paused', g.paused);
    check('loaded enemy models sit at the enemy', loaded.model3d.position.distanceTo(loaded.pos) < .001 &&
      Math.abs(loaded.farModel.position.x - loaded.pos.x) < .001 && Math.abs(loaded.farModel.position.y - loaded.pos.y - loaded.h / 2) < .001 &&
      Math.abs(loaded.farModel.position.z - loaded.pos.z) < .001);
    check('nothing advances after a paused load', tl.ammo === a && g.player.hp === hp && loaded.hp === enemyHp);
  }
}
