#!/usr/bin/env python3
"""Browser defense checks. Run against Vite: python tests/defense_validation.py [URL].

Fixtures create a flat supported area, grant inventory and spawn stationary hostiles.
Screenshots are unmodified browser captures; no fixture is presented as natural play.
"""
import json, sys, traceback
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/screenshots/defenses'
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
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader','--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width':1280,'height':720}, device_scale_factor=1)
    page.on('pageerror', lambda e: errors.append(str(e)))
    try:
        page.goto(URL, wait_until='domcontentloaded')
        page.locator('#newgame').wait_for(state='visible', timeout=120000)
        page.click('#newgame')
        page.wait_for_function('game.started && document.pointerLockElement === game.canvas', timeout=60000)
        page.evaluate('game.renderer.setAnimationLoop(null); game.qualityLevel=3; game.aoOn=false; game.shaftsOn=false; game.onResize(); game.ao.configuration.intensity=0; game.step(.016)')
        page.evaluate('''async () => { window.mods=await import('/src/defenses.ts'); window.place=await import('/src/defensePlacement.ts'); window.ents=await import('/src/entities.ts'); const g=game,w=g.world,p=g.player.pos,X=Math.floor(p.x)+12,Z=Math.floor(p.z)-12;w.generateAround(X,Z,3); let Y=0;for(let x=X-14;x<=X+14;x+=3)for(let z=Z-14;z<=Z+14;z+=3)Y=Math.max(Y,w.surfaceY(x,z));Y+=3;for(let x=X-14;x<=X+14;x++)for(let z=Z-14;z<=Z+14;z++){w.set(x,Y-1,z,1);for(let y=Y;y<=Y+12;y++)w.set(x,y,z,0)}w.rebuildAround(X,Z,2);window.site={X,Y,Z};p.set(X-5,Y,Z+6);g.player.vel.set(0,0,0);g.jetpack.active=true;Object.assign(g.inv,{metal:100,stone:100,wood:100,goo:100,turret:5,cannonTurret:5,twinTurret:5,rocketTurret:5,artilleryTurret:5}); }''')
        page.keyboard.press('Tab'); page.wait_for_function('game.ui.craftOpen')
        check('all five defense choices visible', page.locator('#defense-picker [data-defense]').count()==5)
        page.locator('#defense-picker [data-defense="artillery"]').click()
        check('picker selects artillery', page.evaluate('game.defenseId === "artillery"'))
        capture(page,'01-defense-picker')
        page.keyboard.press('Tab'); page.wait_for_function('!game.ui.craftOpen && document.pointerLockElement===game.canvas')
        check('all footprints validate and rotate in open supported area', page.evaluate('''() => {const {X,Y,Z}=site;return Object.keys(mods.DEFENSES).every(id=>[0,1].every(r=>!place.validateDefensePlacement(game,id,r,X,Y,Z)))}'''))
        check('missing support and upper obstruction are rejected', page.evaluate('''() => {const {X,Y,Z}=site,w=game.world;w.set(X+2,Y-1,Z+2,0);const a=place.validateDefensePlacement(game,'artillery',0,X,Y,Z);w.set(X+2,Y-1,Z+2,1);w.set(X+2,Y+2,Z+2,3);const b=place.validateDefensePlacement(game,'artillery',0,X,Y,Z);w.set(X+2,Y+2,Z+2,0);return !!a && !!b}'''))
        check('actor overlap rejects full footprint', page.evaluate('''() => {const {X,Y,Z}=site,p=game.player.pos,old=p.clone();p.set(X+2.5,Y,Z+2.5);const r=place.validateDefensePlacement(game,'artillery',0,X,Y,Z);p.copy(old);return !!r}'''))
        page.evaluate('''() => {const g=game,{X,Y,Z}=site;g.selectDefense('artillery');g.hover={x:X,y:Y-1,z:Z,nx:0,ny:1,nz:0};g.updateActions(.016)}''')
        check('artillery preview shows both correctly scaled ranges', page.evaluate('game.rangeRing.visible && game.minRangeRing.visible && game.rangeRing.scale.x===90 && game.minRangeRing.scale.x===12 && game.rangeRing.position.x===site.X+1.5 && game.rangeRing.position.z===site.Z+1.5'))
        page.evaluate('''() => {const g=game,{X,Y,Z}=site,p=g.player;p.pos.set(X+9,Y+8,Z+10);const dx=X+1.5-p.pos.x,dy=Y-(p.pos.y+1.55),dz=Z+1.5-p.pos.z;g.camYaw=g.camYawT=Math.atan2(-dx,-dz);g.camPitch=Math.atan2(dy,Math.hypot(dx,dz));g.updateCamera(0)}''')
        capture(page,'02-artillery-range')
        page.evaluate('''() => {const {X,Y,Z}=site;game.world.set(X+2,Y-1,Z+2,0);game.fireCd=0;game.hover={x:X,y:Y-1,z:Z,nx:0,ny:1,nz:0}}''')
        page.mouse.down();page.evaluate('game.updateActions(.016)');page.mouse.up()
        check('failed real click consumes no item', page.evaluate('game.inv.artilleryTurret===5 && game.entities.turrets.length===0'))
        page.evaluate('''() => {const {X,Y,Z}=site;game.world.set(X+2,Y-1,Z+2,1);game.fireCd=0;game.hover={x:X,y:Y-1,z:Z,nx:0,ny:1,nz:0}}''')
        page.mouse.down();page.evaluate('game.updateActions(.016)');page.mouse.up()
        check('successful real click places one artillery and spends one', page.evaluate('game.inv.artilleryTurret===4 && game.entities.turrets.length===1 && game.entities.turrets[0].defenseId==="artillery"'))
        page.evaluate('game.select(0);game.updateActions(.016)')
        check('range circles hide after leaving placement', page.evaluate('!game.rangeRing.visible && !game.minRangeRing.visible'))
        page.evaluate('''() => {const {X,Y,Z}=site;for(const [i,id] of ['auto','cannon','twin','rocket'].entries())game.entities.turrets.push(new ents.Turret(game,X-10+i*4,Y,Z-5,id));game.entities.turrets[0].pos.set(X+6,Y,Z-5);game.entities.turrets[0].grp.position.copy(game.entities.turrets[0].pos);game.player.pos.set(X-2,Y+8,Z+12);const p=game.player.pos,dx=X-3-p.x,dy=Y+1-(p.y+1.55),dz=Z-5-p.z;game.camYaw=game.camYawT=Math.atan2(-dx,-dz);game.camPitch=Math.atan2(dy,Math.hypot(dx,dz));game.updateCamera(0)}''')
        check('five defense types have distinct model structures', page.evaluate('''() => new Set(game.entities.turrets.map(t=>JSON.stringify(t.grp.toJSON().geometries.map(g=>g.width+'x'+g.height+'x'+g.depth)))).size===5'''))
        capture(page,'03-defense-lineup')
        # Real turret updates and projectile movement against stationary spawned brutes.
        for defense in ('auto', 'cannon', 'twin', 'rocket', 'artillery'):
            result = page.evaluate("""(id) => {const g=game,{X,Y,Z}=site;g.projectiles.reset();g.entities.enemies=[];const t=new ents.Turret(g,X+.5,Y,Z-8,id);const e=g.entities.spawnEnemy('brute',X+.5,Y,Z+5);e.vel.set(0,0,0);e.hp=e.maxHp=1000;t.yaw=0;const before=t.ammo;for(let i=0;i<10 && t.ammo===before;i++)t.update(.05);const shot=g.projectiles.list.map(p=>p.type);const after=t.ammo, cd=t.cd;for(let i=0;i<300 && g.projectiles.list.length;i++)g.projectiles.update(.01);const hp=e.hp;t.disposeModel();e.dead=true;return {shot, before, after, cd, hp}}""", defense)
            expected = 'shell' if defense == 'artillery' else 'rocket' if defense == 'rocket' else 'cannon' if defense in ('cannon', 'twin') else 'bullet'
            check(f'{defense} fires and damages hostile', result['after']==result['before']-1 and expected in result['shot'] and result['hp']<1000)
            check(f'{defense} starts reload after firing', result['cd']>0)
        check('range limits and voxel obstruction gate targeting', page.evaluate("""() => {const g=game,{X,Y,Z}=site,t=new ents.Turret(g,X+.5,Y,Z-8,'artillery'),e=g.entities.spawnEnemy('brute',X+.5,Y,Z-3);const near=!t.canSee(e,90*90);e.pos.z=Z+5;const clear=t.canSee(e,90*90);for(let x=X-2;x<=X+2;x++)for(let z=Z-10;z<=Z-6;z++)g.world.set(x,Y+3,z,3);const roof=!t.canSee(e,90*90);for(let x=X-2;x<=X+2;x++)for(let z=Z-10;z<=Z-6;z++)g.world.set(x,Y+3,z,0);e.pos.z=Z+100;const far=!t.canSee(e,90*90);t.disposeModel();e.dead=true;return near&&clear&&roof&&far}"""))
        check('direct cannon cannot target through wall', page.evaluate("""() => {const g=game,{X,Y,Z}=site,t=new ents.Turret(g,X+.5,Y,Z-8,'cannon'),e=g.entities.spawnEnemy('brute',X+.5,Y,Z+5);for(let x=X-2;x<=X+2;x++)for(let y=Y;y<=Y+4;y++)g.world.set(x,y,Z-1,3);const blocked=!t.canSee(e,32*32);for(let x=X-2;x<=X+2;x++)for(let y=Y;y<=Y+4;y++)g.world.set(x,y,Z-1,0);const clear=t.canSee(e,32*32);t.disposeModel();e.dead=true;return blocked&&clear}"""))
        # Craft through the actual UI using a nearby controlled workbench.
        page.evaluate("""() => {const g=game,p=g.player.pos,w=g.world,c=[Math.floor(p.x)+1,Math.floor(p.y),Math.floor(p.z)];w.set(...c,3);g.construction.benches.push({cell:c,block:3});Object.assign(g.inv,{metal:100,stone:100,wood:100,goo:100})}""")
        page.keyboard.press('Tab');page.wait_for_function('game.ui.craftOpen')
        page.locator('#craftlist .recipe').filter(has_text='Rocket battery').click()
        check('workbench recipe spends exact materials and selects rocket', page.evaluate("game.defenseId==='rocket' && game.inv.rocketTurret===6 && game.inv.metal===90 && game.inv.stone===95 && game.inv.goo===97"))
        page.keyboard.press('Tab');page.wait_for_function('!game.ui.craftOpen && document.pointerLockElement===game.canvas')
        # Aim at a dry cannon and exercise E and the inventory transfer itself.
        page.evaluate("""() => {const g=game,{X,Y,Z}=site;for(const t of g.entities.turrets)t.disposeModel();g.entities.turrets=[];const t=new ents.Turret(g,X+.5,Y,Z+.5,'cannon');g.entities.turrets.push(t);window.reloadFixture=t;t.ammo=0;g.inv.shells=13;g.player.pos.set(X+.5,Y,Z+3.5);g.player.aimDir.set(0,0,-1);t.update(.016)}""")
        check('empty turret survives update', page.evaluate('!reloadFixture.dead && reloadFixture.ammo===0'))
        page.keyboard.press('KeyE')
        check('E reloads empty turret with exact available shells', page.evaluate('reloadFixture.ammo===13 && game.inv.shells===0'))
        page.keyboard.press('KeyE')
        check('E with no ammunition changes nothing', page.evaluate('reloadFixture.ammo===13 && game.inv.shells===0'))
        page.evaluate('reloadFixture.ammo=100;game.inv.shells=9')
        page.keyboard.press('KeyE')
        check('E on a full turret spends nothing', page.evaluate('reloadFixture.ammo===100 && game.inv.shells===9'))
        page.evaluate("""() => {const {X,Y,Z}=site;reloadFixture.ammo=0;for(let y=Y;y<=Y+2;y++)game.world.set(X,y,Z+2,3)}""")
        page.keyboard.press('KeyE')
        check('wall blocks E reload', page.evaluate('reloadFixture.ammo===0 && game.inv.shells===9'))
        page.evaluate("""() => {const {X,Y,Z}=site;for(let y=Y;y<=Y+2;y++)game.world.set(X,y,Z+2,0)}""")
        check('defense blast damages only visible hostile and preserves allies, wildlife and blocks', page.evaluate("""() => {const g=game,{X,Y,Z}=site,p=g.player,t=reloadFixture;g.entities.enemies=[];p.pos.set(X+.5,Y,Z+.5);p.hp=100;t.pos.set(X+1.5,Y,Z+.5);t.hp=100;const wildlife=g.foraging.wildlife.find(a=>!a.dead);wildlife.pos.set(X-1.5,Y,Z+.5);const wildHP=wildlife.hp;const a=g.entities.spawnEnemy('brute',X+.5,Y,Z-1.5),b=g.entities.spawnEnemy('brute',X+.5,Y,Z+3.5);a.hp=b.hp=1000;g.world.set(X,Y+1,Z+2,3);const at=p.pos.clone().add({x:0,y:1,z:0});g.projectiles.defenseBlast(at,100,6);const ok=a.hp<1000 && b.hp===1000 && p.hp===100 && t.hp===100 && wildlife.hp===wildHP && g.world.get(X,Y+1,Z+2)===3;g.world.set(X,Y+1,Z+2,0);a.dead=b.dead=true;return ok}"""))
        # Round-trip five typed models; then strip fields in IndexedDB to simulate old saves.
        page.evaluate("""() => {const g=game,{X,Y,Z}=site;for(const t of g.entities.turrets)t.disposeModel();g.entities.turrets=[];for(const [i,id] of ['auto','cannon','twin','rocket','artillery'].entries()){const t=new ents.Turret(g,X-10+i*4,Y,Z-5,id,i%4);t.ammo=i+1;g.entities.turrets.push(t)}g.entities.enemies=[];g.save('manual')}""")
        page.wait_for_function('!game.saving',timeout=60000)
        page.evaluate('game.quickLoad()');page.wait_for_function("game.entities.turrets.length===5 && game.entities.turrets[4].defenseId==='artillery'",timeout=60000)
        check('save restores five typed turrets, rotations and ammo', page.evaluate("game.entities.turrets.every((t,i)=>t.defenseId===['auto','cannon','twin','rocket','artillery'][i] && t.rotation===i%4 && t.ammo===i+1)"))
        page.evaluate("""async () => {const db=await new Promise((ok,no)=>{const r=indexedDB.open('blockfall-isle',1);r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)});const data=await new Promise(ok=>{const r=db.transaction('saves').objectStore('saves').get('manual');r.onsuccess=()=>ok(r.result)});for(const t of data.turrets){delete t.defenseId;delete t.rotation;delete t.ammo}await new Promise(ok=>{const tx=db.transaction('saves','readwrite');tx.objectStore('saves').put(data,'manual');tx.oncomplete=ok});db.close();game.quickLoad()}""")
        page.wait_for_function("game.entities.turrets.length===5 && game.entities.turrets.every(t=>t.defenseId==='auto')",timeout=60000)
        check('legacy saves default to full auto turrets and rotation zero', page.evaluate('game.entities.turrets.every(t=>t.rotation===0 && t.ammo===250)'))
        check('no browser errors', not errors)
    except Exception:
        errors.append(traceback.format_exc()); print(errors[-1], flush=True)
    finally:
        (OUT / 'results.json').write_text(json.dumps({'url':URL,'checks':checks,'page_errors':errors},indent=2)+'\n')
        browser.close()
if errors or not all(checks.values()): sys.exit(1)
