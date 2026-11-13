// Drone (bat) model structure: shared shell texture, no per-drone lights, eye optics survive a hit flash,
// walking keeps the assembled parts (was tests/drone_visual_validation.py; its captures are dropped).
// @steps 10
const g = game, p = g.player.pos;
const d1 = g.entities.spawnEnemy('bat', p.x, p.y + 53, p.z), d2 = g.entities.spawnEnemy('bat', p.x + 2, p.y + 53, p.z);
d1.walking = false; d2.walking = false; d1.updateSprite(0); d2.updateSprite(0);
const A = d1.model3d.children, B = d2.model3d.children;
const eyes = A.filter((m) => m.material?.emissive?.getHex() === 0xff2816);
const shell = A.filter((m) => m.material?.map);
check('drone has a textured shell', shell.length >= 1, shell.length);
check('shell texture shared between two drones', shell.length >= 1 && shell[0].material === B[0].material && shell[0].material.map === B[0].material.map);
check('no per-drone point lights', A.filter((m) => m.isPointLight).length === 0);
const before = eyes.map((m) => [m.material.emissive.getHex(), m.material.emissiveIntensity]);
d1.flash = .08; d1.updateSprite(.01);
const after = eyes.map((m) => [m.material.emissive.getHex(), m.material.emissiveIntensity]);
check('four eyes, optics survive a flash update', eyes.length === 4 && JSON.stringify(before) === JSON.stringify(after), { eyes: eyes.length, before, after });
d1.walking = true; d1.animT = 0; d1.updateSprite(.1);
check('walking preserves assembled parts', A.every((m) => m.rotation.x === 0), A.map((m) => m.rotation.x));
d1.dead = d2.dead = true;
