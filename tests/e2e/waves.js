// @url /?fast=1
// @steps 40
// Wave queues, cardinal spawn fronts and blocked terrain in the running game (was tests/wave_fronts_validation.py).
// Pure wave sizing / front choice lives in tests/waveDirector.test.mjs; this checks the entity side.
// npm run e2e -- waves
const { WaveDirector } = await import('/src/waveDirector.ts');
const { saveGame, loadGame } = await import('/src/save.ts');
const e = game.entities;
game.world.generateAround(game.spawnPoint.x, game.spawnPoint.z, 3);
const castle = game.world.gen.spawn;
for (let wave = 1; wave <= 4; wave++) {
  const fronts = WaveDirector.frontsForWave(wave), count = WaveDirector.waveSize(wave);
  e.spawnWave(count, fronts);
  const center = e.waveSpawnQueue.center.slice();
  for (let i = 0; i < 2000 && e.pendingWaveSpawns; i++) e.updateWaveSpawns(0.016);
  const enemies = e.enemies.slice(-count), directions = new Set();
  const inside = enemies.filter((x) => Math.abs(x.pos.x - castle.x) < 16 && Math.abs(x.pos.z - castle.z) < 16).length;
  for (const x of enemies) {
    const dx = x.pos.x - center[0], dz = x.pos.z - center[2];
    directions.add(Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north'));
  }
  check(`wave ${wave}: all ${count} spawned, none pending`, e.pendingWaveSpawns === 0 && enemies.length === count, { pending: e.pendingWaveSpawns, spawned: enemies.length });
  check(`wave ${wave}: nobody spawns inside the castle`, inside === 0, inside);
  check(`wave ${wave}: enemies come from exactly its fronts`, directions.size === fronts.length && fronts.every((f) => directions.has(f)), { fronts, directions: [...directions] });
  for (const x of e.enemies) x.removeSprite(); e.enemies = [];
}

// no spawn point at all: the queue waits instead of dropping enemies, and the wave can't be cleared
const original = e.randomSpawnPoint;
e.randomSpawnPoint = () => null;
e.spawnWave(30, ['north']);
for (let i = 0; i < 20; i++) e.updateWaveSpawns(0.016);
const blocked = e.pendingWaveSpawns;
e.randomSpawnPoint = original;
check('blocked terrain keeps all 30 queued', blocked === 30, blocked);
game.waveDirector.restore({ phase: 'wave', wave: 1, remaining: 0, rewardBonus: 0 });
check('a wave with queued spawns cannot clear', game.waveDirector.update(0.1, e.pendingWaveSpawns).length === 0);

// the queue survives save / load
const queueBefore = JSON.stringify(e.waveSpawnQueue);
await saveGame(game, 'manual');
e.waveSpawnQueue = null;
await loadGame(game, 'manual');
check('spawn queue restored by save/load', JSON.stringify(e.waveSpawnQueue) === queueBefore);

// a player high above the ground (jetpack) or on a tower still gets spawn points
const highY = game.player.pos.y;
game.player.pos.y += 60;
check('spawn point found while the player flies high', !!e.randomSpawnPoint(22, 42, 'zombie', 'north', e.waveSpawnQueue.center));
const field = e.walkField, ready = field.ready, reach = field.reachLevel;
const surface = game.world.surfaceY, px = Math.floor(game.player.pos.x), pz = Math.floor(game.player.pos.z);
field.ready = true; field.reachLevel = () => -1;
game.world.surfaceY = function (x, z) { return x === px && z === pz ? Math.floor(game.player.pos.y) : surface.call(this, x, z); };
const towerSpot = e.randomSpawnPoint(32, 48, 'zombie', 'north', e.waveSpawnQueue.center);
field.ready = ready; field.reachLevel = reach; game.world.surfaceY = surface;
game.player.pos.y = highY;
check('spawn point found while the player stands on an unreachable tower', !!towerSpot);

// enemy speeds are 65% of their design speeds
for (const [kind, base] of [['crawler', 5.4], ['spitter', 2.8], ['brute', 1.9], ['bat', 7], ['boss', 1.6]]) {
  const x = e.spawnEnemy(kind, game.spawnPoint.x, game.spawnPoint.y, game.spawnPoint.z);
  check(`${kind} speed is 65% of ${base}`, Math.abs(x.speed - base * 0.65) < 1e-8, x.speed);
  x.removeSprite(); e.enemies.pop();
}
