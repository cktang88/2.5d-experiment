#!/usr/bin/env python3
"""Integrated combat checks and unaltered browser captures; run with Vite available."""
import base64, json, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

out = Path('docs/screenshots/combat-rebalance')
out.mkdir(parents=True, exist_ok=True)
url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5173/'
checks, errors = {}, []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
        args=['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width':1280,'height':720})
    page.on('pageerror', lambda e: errors.append(str(e)))
    try:
        page.goto(url, wait_until='domcontentloaded')
        page.locator('#newgame').wait_for(state='visible', timeout=120000)
        page.click('#newgame')
        page.wait_for_function('game.started && document.pointerLockElement===game.canvas', timeout=60000)
        page.evaluate('''() => {
          let g=game,w=g.world,p=g.player.pos; g.renderer.setAnimationLoop(null);
          g.qualityLevel=3; g.aoOn=false; g.shaftsOn=false; g.onResize(); g.ao.configuration.intensity=0; g.step(.016);
          let X=Math.floor(p.x), Z=Math.floor(p.z), Y=Math.floor(p.y)+20;
          w.generateAround(X,Z,3);
          for(let x=X-20;x<=X+20;x++) for(let z=Z-15;z<=Z+15;z++) {
            w.set(x,Y-1,z,1); for(let y=Y;y<Y+9;y++) w.set(x,y,z,0);
          }
          w.rebuildAround(X,Z,3); p.set(X+.5,Y,Z+.5); g.player.vel.set(0,0,0);
          g.time=.4; g.updateDay(0); g.camYaw=0; g.camPitch=0; g.updateCamera(0); window.site={X,Y,Z};
        }''')
        results = page.evaluate('''async () => {
          const THREE=await import('/node_modules/three/build/three.module.js');
          const {WaveDirector}=await import('/src/waveDirector.ts');
          const p=game.projectiles, from=new THREE.Vector3(site.X,site.Y+4,site.Z), dir=new THREE.Vector3(1,0,0), to=from.clone().add(new THREE.Vector3(12,0,0));
          const hostile={kind:'spitter'}, friendly={kind:'player'};
          let eb=p.bullet(from,dir,{dmg:1,speed:80,owner:hostile}), fb=p.bullet(from,dir,{dmg:1,speed:80,owner:friendly});
          let er=p.rocket(from,dir,hostile), fr=p.rocket(from,dir,friendly);
          let ea=p.lob('acid',from,to,hostile), fa=p.lob('acid',from,to,friendly);
          const near=(a,b)=>Math.abs(a-b)<1e-8;
          let result={waveSizes:[1,2,3,4].map(WaveDirector.waveSize),frontCounts:[1,2,3,4].map(n=>WaveDirector.frontsForWave(n).length),
            bullets:near(eb.vel.length(),40)&&near(fb.vel.length(),80)&&near(eb.life,fb.life*2),
            rockets:near(er.vel.length(),13)&&near(fr.vel.length(),26)&&near(er.life,fr.life*2),
            acid:ea.vel.distanceTo(fa.vel.clone().multiplyScalar(.5))<1e-8&&near(ea.g,fa.g*.25)&&near(ea.life,fa.life*2)};
          p.reset();
          let s=game.glowsticks, player=game.player; player.aimDir.set(0,0,-1); game.inv.glowstick=40;
          let sample={pos:[site.X+.5,site.Y+1.45,site.Z-1.5],vel:[0,0,0],remaining:42};
          s.restore(Array.from({length:30},(_,i)=>({...sample,remaining:40+i})));
          result.lightCap=s.lights.filter(l=>l.intensity>0).length===4;
          let old=s.sticks[0]; result.throwSuccess=s.throw()&&s.sticks.length===30&&!s.sticks.includes(old);
          s.restore([sample]); let n=game.inv.glowstick; result.pickup=s.interact()&&game.inv.glowstick===n+1&&s.sticks.length===0;
          result.rethrow=s.throw()&&s.sticks[s.sticks.length-1].remaining===42;
          s.restore([sample]); game.world.set(site.X,site.Y+1,site.Z-1,1); result.wallBlocks=!s.interact(); game.world.set(site.X,site.Y+1,site.Z-1,0);
          s.restore(Array.from({length:30},(_,i)=>({...sample,remaining:40+i}))); old=s.sticks[0]; n=game.inv.glowstick; game.inv.glowstick=0;
          result.failedThrowPreserves=s.throw()===false&&s.sticks.length===30&&s.sticks[0]===old; game.inv.glowstick=n; s.restore([]);
          return result;
        }''')
        checks.update({k: v for k,v in results.items() if isinstance(v,bool)})
        checks['wave counts'] = results['waveSizes']==[30,42,54,66] and results['frontCounts']==[1,2,3,4]
        page.evaluate('''async () => {
          const {Turret}=await import('/src/entities.ts'); const {X,Y,Z}=site;
          window.lineup=['auto','cannon','twin','rocket','artillery'].map((id,i)=>new Turret(game,X+(i-2)*3.4,Y,Z-5,id));
          for(const t of lineup){ t.head.rotation.y=.35; t.barrel.rotation.z=.25; t.grp.updateMatrixWorld(true); }
          game.player.gunHolder.visible=false; game.camera.position.set(X+1,Y+5,Z+5); game.camera.lookAt(X+1,Y+.8,Z-5); game.camera.updateMatrixWorld(); game.composer.render();
        }''')
        def capture(name):
            data=page.evaluate("game.composer.render();game.canvas.toDataURL('image/png')")
            (out/name).write_bytes(base64.b64decode(data.split(',',1)[1]))
        capture('defense-lineup.png')
        page.evaluate('''() => {for(const t of lineup)t.disposeModel(); game.player.gunHolder.visible=true; game.player.pos.set(site.X+.5,site.Y,site.Z+.5);game.camYaw=0;game.camPitch=0;game.select(2);game.inv.ammo=100;game.fireCd=0;game.updateCamera(0);game.updateAim();}''')
        page.mouse.down()
        page.evaluate('''() => {for(let i=0;i<10;i++){game.updateActions(.08);game.player.update(.08,game.input);game.input.lmbPressed=false;} game.updateCamera(0);game.updateAim();}''')
        checks['held SMG fires'] = page.evaluate('game.inv.ammo===90')
        capture('smg-held-fire.png')
        page.mouse.up()
    except Exception as e:
        errors.append(str(e))
    finally:
        browser.close()
        (out/'results.json').write_text(json.dumps({'checks':checks,'errors':errors},indent=2)+'\n')
print(json.dumps({'checks':checks,'errors':errors},indent=2), flush=True)
if errors or not checks or not all(checks.values()): raise SystemExit(1)
