#!/usr/bin/env python3
"""Validate wave queues, cardinal spawn positions and blocked terrain in Chromium."""
import sys
from playwright.sync_api import sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5173/'
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'])
    page = browser.new_page()
    page.goto(url, wait_until='domcontentloaded')
    page.locator('#newgame').wait_for(state='visible', timeout=120000)
    page.click('#newgame')
    page.wait_for_function('game.started', timeout=60000)
    results = page.evaluate('''async () => {
      game.renderer.setAnimationLoop(null);
      const {WaveDirector} = await import('/src/waveDirector.ts');
      const e = game.entities, results = [];
      game.world.generateAround(game.spawnPoint.x, game.spawnPoint.z, 3);
      for (let wave=1; wave<=4; wave++) {
        const fronts=WaveDirector.frontsForWave(wave), count=WaveDirector.waveSize(wave);
        e.spawnWave(count, fronts);
        const center=e.waveSpawnQueue.center.slice();
        for (let i=0; i<2000 && e.pendingWaveSpawns; i++) e.updateWaveSpawns(.016);
        const enemies=e.enemies.slice(-count), directions=new Set();
        const castle=game.world.gen.spawn;
        const insideCastle=enemies.some(enemy=>Math.abs(enemy.pos.x-castle.x)<16 && Math.abs(enemy.pos.z-castle.z)<16);
        for (const enemy of enemies) {
          const dx=enemy.pos.x-center[0], dz=enemy.pos.z-center[2];
          directions.add(Math.abs(dx)>Math.abs(dz) ? (dx>0?'east':'west') : (dz>0?'south':'north'));
        }
        results.push({wave,count,spawned:enemies.length,pending:e.pendingWaveSpawns,fronts,directions:[...directions],insideCastle});
        for (const enemy of e.enemies) enemy.removeSprite(); e.enemies=[];
      }
      const original=e.randomSpawnPoint;
      e.randomSpawnPoint=()=>null;
      e.spawnWave(30, ['north']);
      for (let i=0; i<20; i++) e.updateWaveSpawns(.016);
      const blocked=e.pendingWaveSpawns;
      e.randomSpawnPoint=original;
      game.waveDirector.restore({phase:'wave', wave:1, remaining:0, rewardBonus:0});
      const cannotClear=game.waveDirector.update(.1, e.pendingWaveSpawns).length===0;
      const queueBefore=JSON.stringify(e.waveSpawnQueue);
      const {saveGame,loadGame}=await import('/src/save.ts');
      await saveGame(game,'manual');
      e.waveSpawnQueue=null;
      await loadGame(game,'manual');
      const queueRestored=JSON.stringify(e.waveSpawnQueue)===queueBefore;
      const highY=game.player.pos.y;
      game.player.pos.y+=60;
      const highSpot=e.randomSpawnPoint(22,42,'zombie','north',e.waveSpawnQueue.center);
      const field=e.walkField, ready=field.ready, reach=field.reachLevel;
      const surface=game.world.surfaceY, px=Math.floor(game.player.pos.x), pz=Math.floor(game.player.pos.z);
      field.ready=true; field.reachLevel=()=>-1;
      game.world.surfaceY=function(x,z) { return x===px && z===pz ? Math.floor(game.player.pos.y) : surface.call(this,x,z); };
      const towerSpot=e.randomSpawnPoint(32,48,'zombie','north',e.waveSpawnQueue.center);
      field.ready=ready; field.reachLevel=reach; game.world.surfaceY=surface;
      game.player.pos.y=highY;
      const speeds={};
      for (const kind of ['crawler','spitter','brute','bat','boss']) {
        const enemy=e.spawnEnemy(kind,game.spawnPoint.x,game.spawnPoint.y,game.spawnPoint.z);
        speeds[kind]=enemy.speed;
        enemy.removeSprite(); e.enemies.pop();
      }
      return {results,blocked,cannotClear,queueRestored,highSpot,towerSpot,speeds};
    }''')
    print(results, flush=True)
    browser.close()
    assert results['blocked'] == 30
    assert results['cannotClear'] and results['queueRestored'] and results['highSpot'] and results['towerSpot'], results
    for kind, original in [('crawler',5.4),('spitter',2.8),('brute',1.9),('bat',7),('boss',1.6)]:
        assert abs(results['speeds'][kind]-original*.65)<1e-8, results
    for r in results['results']:
        assert r['pending'] == 0 and r['spawned'] == r['count'], r
        assert not r['insideCastle'], r
        assert set(r['directions']) == set(r['fronts']), r
