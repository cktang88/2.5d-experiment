#!/usr/bin/env python3
"""Real Chromium regression for raised turret bases. Run against Vite, optionally with URL.

The flat test site and actor positions are controlled fixtures. Captures are unmodified
browser screenshots, rendered with the game composer and HUD.
"""
import json
import sys
import traceback
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/screenshots/turret-bases'
OUT.mkdir(parents=True, exist_ok=True)
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5173/'
checks, errors = {}, []

def check(name, value):
    checks[name] = bool(value)
    print(f'{name}: {bool(value)}', flush=True)

def capture(page, name):
    page.evaluate('game.ui.update(0); game.camera.updateMatrixWorld(); game.composer.render()')
    page.screenshot(path=str(OUT / (name + '.jpg')), type='jpeg', quality=88, timeout=90000)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width':1280, 'height':720}, device_scale_factor=1)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda msg: print(msg.text, flush=True) if msg.text.startswith('DIMENSIONS') else None)
    try:
        page.goto(URL, wait_until='domcontentloaded')
        page.locator('#newgame').wait_for(state='visible', timeout=120000)
        page.click('#newgame')
        page.wait_for_function('game.started && document.pointerLockElement === game.canvas', timeout=60000)
        page.evaluate('game.renderer.setAnimationLoop(null); game.qualityLevel=3; game.aoOn=false; game.shaftsOn=false; game.onResize(); game.ao.configuration.intensity=0; game.step(.016)')
        page.evaluate('''async () => { window.mods=await import('/src/defenses.ts'); window.ents=await import('/src/entities.ts'); window.THREE=await import('/node_modules/three/build/three.module.js'); const g=game,w=g.world,p=g.player.pos,X=Math.floor(p.x)+12,Z=Math.floor(p.z)-12; w.generateAround(X,Z,3); let Y=0; for(let x=X-16;x<=X+16;x+=3)for(let z=Z-16;z<=Z+16;z+=3)Y=Math.max(Y,w.surfaceY(x,z)); Y+=3; for(let x=X-16;x<=X+16;x++)for(let z=Z-16;z<=Z+16;z++){w.set(x,Y-1,z,1);for(let y=Y;y<=Y+12;y++)w.set(x,y,z,0)} w.rebuildAround(X,Z,2); window.site={X,Y,Z}; p.set(X-5,Y,Z+6); g.player.vel.set(0,0,0); g.entities.enemies=[]; }''')
        results = page.evaluate('''() => {
          const g=game,{X,Y,Z}=site,p=g.player, ids=['auto','cannon','twin','rocket','artillery'];
          const results={};
          function clear(){for(const t of g.entities.turrets)t.disposeModel();g.entities.turrets=[];for(const e of g.entities.enemies)e.removeSprite();g.entities.enemies=[];g.projectiles.reset()}
          function turret(id='auto',rot=0){const t=new ents.Turret(g,X+.5,Y,Z+.5,id,rot);g.entities.turrets.push(t);return t}
          function actor(a,x,y,z,vx=0,vy=0,vz=0){a.pos.set(x,y,z);a.vel.set(vx,vy,vz);a.onGround=false}
          for(const id of ids){
            clear();const t=turret(id),[w,d]=mods.footprintSize(id,0),base=t.grp.getObjectByName('base');
            if(id==='artillery'){const old=t.barrel.rotation.z;t.barrel.rotation.z=0;t.grp.updateMatrixWorld(true);const b=new THREE.Box3().setFromObject(t.grp);console.log('DIMENSIONS artillery leveled height',b.max.y-b.min.y);t.barrel.rotation.z=old}
            t.grp.updateMatrixWorld(true); const box=new THREE.Box3().setFromObject(t.grp); console.log('DIMENSIONS',id,'collider',w,t.h,d,'model',box.max.x-box.min.x,box.max.y-box.min.y,box.max.z-box.min.z,'gap',t.pos.y+t.h-box.max.y);
            results[id+' base visible and fixed'] = !!base && base.visible && base.children.length>0 && t.head.position.y>=1.1 && t.muzzle().y>Y+mods.DEFENSE_BASE_HEIGHT;
            actor(p,X+.5,Y+t.h+2,Z+.5,0,-8,0);for(let i=0;i<100&&!p.onGround;i++)p.physics(.02);
            results[id+' supports player'] = p.onGround && Math.abs(p.pos.y-(Y+t.h))<.02;
            let sides=true;for(const [x,z,vx,vz] of [[-w/2-2,0,50,0],[w/2+2,0,-50,0],[0,-d/2-2,0,50],[0,d/2+2,0,-50]]){actor(p,X+.5+x,Y+.1,Z+.5+z,vx,0,vz);p.physics(.1,0);sides &&= p.blockedH && (Math.abs(p.pos.x-(X+.5))>=w/2+p.r-.02 || Math.abs(p.pos.z-(Z+.5))>=d/2+p.r-.02)}
            results[id+' blocks high speed on four sides']=sides;
            actor(p,X+.5-w/2-1,Y,Z+.5,20,0,0);p.onGround=true;p.physics(.1);results[id+' blocks grounded auto-step']=p.pos.x<=X+.5-w/2-p.r+.02 && p.pos.y<Y+1;
            actor(p,X+.5-w/2-2,Y+.1,Z+.5-d/2-2,40,0,40);p.physics(.1,0);
            results[id+' blocks diagonal entry'] = Math.abs(p.pos.x-(X+.5))>=w/2+p.r-.02 || Math.abs(p.pos.z-(Z+.5))>=d/2+p.r-.02;
            clear();
          }
          for(const kind of ['crawler','brute','bat']){
            clear();const t=turret(),e=g.entities.spawnEnemy(kind,X-3,Y+.1,Z+.5);actor(e,X-3,Y+.1,Z+.5,55,0,0);e.physics(.1,0);
            results[kind+' blocked by base']=e.blockedH && e.pos.x<=t.pos.x-1-e.r+.02;
          }
          clear();let t=turret('auto');actor(p,t.pos.x-3,Y+.6,t.pos.z);g.jetpack.active=true;g.camYaw=-Math.PI/2;for(let i=0;i<60;i++)p.update(.02,{keys:{KeyW:true},pressed:{}});results['jetpack flight blocked at base']=p.pos.x<=t.pos.x-1-p.r+.02;g.jetpack.active=false;
          clear();t=turret('artillery');let e=g.entities.spawnEnemy('zombie',t.pos.x-2.34,Y,t.pos.z);const hp=t.hp;console.log('DIMENSIONS melee',JSON.stringify({e:e.pos.toArray(),t:t.pos.toArray(),reach:e.reaches(t),atkCd:e.atkCd,dist:e.pos.distanceTo(t.pos)}));const attacked=e.contactAttack(t,e.pos.distanceTo(t.pos));console.log('DIMENSIONS melee result',JSON.stringify({attacked,hp,after:t.hp,atk:e.atk,dead:t.dead}));results['enemy can melee base surface']=attacked && t.hp<hp;
          clear();t=turret('rocket',1);const [w,d]=mods.footprintSize('rocket',1);
          actor(p,t.pos.x-w/2-2,Y+.1,t.pos.z,40,0,0);p.physics(.1,0);const blocked=p.blockedH && p.pos.x<=t.pos.x-w/2-p.r+.02;
          actor(p,t.pos.x+w/2+.5,Y+.1,t.pos.z-d/2-.2,0,0,0);const outside=!p.overlaps();
          results['rotated rectangular footprint matches collision']=blocked&&outside;
          t.dead=true;actor(p,t.pos.x-w/2-2,Y+.1,t.pos.z,40,0,0);p.physics(.1,0);results['dead base stops blocking']=p.pos.x>t.pos.x-w/2+.5;
          clear();t=turret();actor(p,t.pos.x,Y+t.h+2,t.pos.z,0,-8,0);for(let i=0;i<100&&!p.onGround;i++)p.physics(.02);const top=p.pos.y;t.disposeModel();g.entities.turrets=[];p.physics(.1);results['removed base stops supporting player']=p.pos.y<top-.05;
          clear();t=turret('twin');const start=t.pos.clone();for(let x=X-2;x<=X+2;x++)for(let z=Z-2;z<=Z+2;z++)g.world.set(x,Y-1,z,0);for(let i=0;i<10;i++)t.update(.02);results['support loss causes vertical fall without sliding']=t.pos.y<start.y-.05 && t.pos.x===start.x && t.pos.z===start.z;for(let x=X-2;x<=X+2;x++)for(let z=Z-2;z<=Z+2;z++)g.world.set(x,Y-1,z,1);
          clear();
          for(const id of ids){const t=turret(id),e=g.entities.spawnEnemy('brute',X+.5,Y,Z+15);e.hp=e.maxHp=1000;e.vel.set(0,0,0);const initial=t.ammo;for(let i=0;i<100&&t.ammo===initial;i++)t.update(.05);const shots=g.projectiles.list.length;for(let i=0;i<400&&g.projectiles.list.length;i++)g.projectiles.update(.01);results[id+' elevated weapon fires and hits']=t.ammo<initial&&shots>0&&e.hp<1000;clear()}
          return results;
        }''')
        for name, value in results.items(): check(name, value)
        page.evaluate("""() => {const g=game,{X,Y,Z}=site;const t=new ents.Turret(g,X+.5,Y,Z+.5,'rocket',1);g.entities.turrets.push(t);g.player.pos.set(X+8,Y,Z+8);g.save('manual')}""")
        page.wait_for_function('!game.saving', timeout=60000)
        page.evaluate('game.quickLoad()')
        page.wait_for_function("game.entities.turrets.length===1 && game.entities.turrets[0].defenseId==='rocket'", timeout=60000)
        check('loaded rotated base blocks player', page.evaluate("""() => {const g=game,t=g.entities.turrets[0],p=g.player,[w]=mods.footprintSize(t.defenseId,t.rotation);p.pos.set(t.pos.x-w/2-2,t.pos.y+.1,t.pos.z);p.vel.set(40,0,0);p.onGround=false;p.physics(.1,0);return t.rotation===1 && p.blockedH && p.pos.x<=t.pos.x-w/2-p.r+.02}"""))
        page.evaluate("game.entities.reset(); game.paused=false; document.getElementById('pause').classList.add('hidden')")
        check('reset clears blocking', page.evaluate("""() => {const g=game,{X,Y,Z}=site,p=g.player;p.pos.set(X-4,Y+.1,Z+.5);p.vel.set(60,0,0);p.onGround=false;p.physics(.1,0);return p.pos.x>X+.5}"""))
        page.evaluate('''() => {const g=game,{X,Y,Z}=site,ids=['auto','cannon','twin','rocket','artillery'];for(const [i,id] of ids.entries()){const t=new ents.Turret(g,X-10+i*5,Y,Z-4,id,i%2);g.entities.turrets.push(t)}g.player.pos.set(X,Y+1,Z+11);g.player.vel.set(0,0,0);g.camYaw=g.camYawT=0;g.camPitch=-.35;g.updateCamera(0)}''')
        capture(page,'01-five-raised-defenses')
        page.evaluate('''() => {const g=game,{X,Y,Z}=site;for(const t of g.entities.turrets)t.disposeModel();g.entities.turrets=[];const t=new ents.Turret(g,X+.5,Y,Z+.5,'rocket',1);g.entities.turrets.push(t);const p=g.player;p.pos.set(X+.5,Y+.1,Z+5);p.vel.set(0,0,-40);p.onGround=false;p.physics(.1,0);g.camYaw=g.camYawT=0;g.camPitch=-.5;g.updateCamera(0);g.player.gunHolder.visible=false}''')
        capture(page,'02-player-blocked')
        page.evaluate('''() => {const g=game,{X,Y,Z}=site,p=g.player;p.pos.set(X+.5,Y+g.entities.turrets[0].h+2,Z+.5);p.vel.set(0,-8,0);p.onGround=false;for(let i=0;i<100&&!p.onGround;i++)p.physics(.02);g.camYaw=g.camYawT=0;g.camPitch=-1.35;g.updateCamera(0)}''')
        capture(page,'03-player-on-base')
        check('no browser errors', not errors)
    except Exception:
        errors.append(traceback.format_exc()); print(errors[-1], flush=True)
    finally:
        (OUT / 'results.json').write_text(json.dumps({'url': URL, 'checks': checks, 'page_errors': errors}, indent=2)+'\n')
        browser.close()
if errors or not all(checks.values()): sys.exit(1)
