#!/usr/bin/env python3
"""Bounded CPU-only Game.step benchmark; run with a Vite server already running."""
import json
import os
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5173/'
CHROMIUM = os.environ.get('CHROMIUM', '/usr/bin/chromium')

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROMIUM, headless=True, args=['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(URL, wait_until='domcontentloaded')
    page.locator('#newgame').wait_for(state='visible', timeout=120000)
    page.click('#newgame')
    page.wait_for_function('game.started && document.pointerLockElement === game.canvas', timeout=60000)
    page.evaluate('''() => {game.renderer.setAnimationLoop(null);game.qualityLevel=3;game.aoOn=false;game.shaftsOn=false;game.onResize();game.ao.configuration.intensity=0;game.step(.016);game.autosaveT=10000;game.player.invuln=10000;game.waveDirector.phase="safe";game.waveDirector.remaining=10000}''')
    renderer = page.evaluate('''() => {const gl=game.renderer.getContext(), ext=gl.getExtension('WEBGL_debug_renderer_info');return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)}''')
    # Same bounded stepping for both scenarios: 60 warm-up, then 120 recorded updates.
    measure = '''() => {const g=game;for(let i=0;i<60;i++)g.step(1/60);const times=[];for(let i=0;i<120;i++){const start=performance.now();g.step(1/60);times.push(performance.now()-start)}times.sort((a,b)=>a-b);let objects=0,lights=0,pointLights=0;g.scene.traverse(o=>{objects++;if(o.isLight)lights++;if(o.isPointLight)pointLights++});return {samples:times.length,p50_ms:(times[59]+times[60])/2,p95_ms:times[113],max_ms:times[119],enemies:g.entities.enemies.filter(e=>!e.dead).length,turrets:g.entities.turrets.length,traps:g.traps.traps.length,glowsticks:g.glowsticks.sticks.length,activeGlowLights:g.glowsticks.lights.filter(l=>l.intensity>0).length,sceneObjects:objects,sceneLights:lights,scenePointLights:pointLights,projectiles:g.projectiles.list.length}}'''
    baseline = page.evaluate(measure)
    fixture = page.evaluate('''async () => {
      const {Turret}=await import('/src/entities.ts'),g=game,w=g.world,p=g.player.pos;
      let seed=123456789;Math.random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296};
      const X=Math.floor(p.x),Z=Math.floor(p.z);w.generateAround(X,Z,4);
      let Y=0;for(let x=X-32;x<=X+32;x+=4)for(let z=Z-32;z<=Z+32;z+=4)Y=Math.max(Y,w.surfaceY(x,z));Y+=3;
      let blocks=0;
      for(let x=X-32;x<=X+32;x++)for(let z=Z-32;z<=Z+32;z++){
        w.set(x,Y-1,z,1);blocks++;
        for(let y=Y;y<Y+13;y++)w.set(x,y,z,0);
        if(Math.abs(x-X)>=31||Math.abs(z-Z)>=31)for(let y=Y;y<Y+12;y++){w.set(x,y,z,3);blocks++}
      }
      w.rebuildAround(X,Z,4);p.set(X+.5,Y,Z+.5);g.player.vel.set(0,0,0);g.entities.reset();
      const ids=['auto','cannon','twin','rocket','artillery'];
      for(let i=0;i<30;i++){const x=X-25+(i%10)*5,z=Z-25+Math.floor(i/10)*5;g.entities.turrets.push(new Turret(g,x+.5,Y,z+.5,ids[i%5],i%4))}
      const traps=['spikes','arrow','flame','mine'];Object.assign(g.inv,{spikeTrap:20,arrowTrap:20,flameTrap:20,blastMine:20});
      for(let i=0;i<24;i++){const x=X-23+(i%8)*6,z=Z+5+Math.floor(i/8)*5;if(!g.traps.place(traps[i%4],i%4,x,Y,z))throw Error('trap placement '+i)}
      for(let i=0;i<48;i++){const x=X-22+(i%8)*6+.5,z=Z-8+Math.floor(i/8)*4+.5,e=g.entities.spawnEnemy(i%2?'zombie':'brute',x,Y,z);e.hp=e.maxHp=100000;e.damage=()=>{};const update=e.update.bind(e),pos=e.pos.clone();e.update=dt=>{update(dt);e.pos.copy(pos);e.vel.set(0,0,0)}}
      g.glowsticks.restore(Array.from({length:12},(_,i)=>({pos:[X-5+i,Y+.2,Z+.5],vel:[0,0,0],remaining:180})));
      return {placedBlocks:blocks,site:[X,Y,Z]};
    }''')
    stress = page.evaluate(measure)
    result = {'browser': browser.version, 'renderer': renderer, 'baseline': baseline, 'fixture': fixture, 'castle': stress, 'errors': errors}
    print(json.dumps(result, indent=2))
    browser.close()
    if errors or stress['enemies'] != 48 or stress['turrets'] != 30 or stress['traps'] != 24 or stress['glowsticks'] != 12 or stress['activeGlowLights'] != 4:
        raise SystemExit('Benchmark fixture changed or browser errors occurred')
