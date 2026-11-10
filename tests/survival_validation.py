#!/usr/bin/env python3
"""End-to-end survival checks against a local Vite server.

Run: python tests/survival_validation.py [URL]. Tests use real browser input and
active game stepping with rendering stopped for reproducibility. Controlled
fixtures set health/inventory and construct an in-memory test area; natural
forage and wildlife discovery are checked separately. Nothing is saved to disk
except screenshots, and screenshots are unmodified browser captures.
"""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/screenshots/survival'
OUT.mkdir(parents=True, exist_ok=True)
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5173/'
errors = []
checks = {}

def check(name, condition):
    checks[name] = bool(condition)
    print(f'{name}: {bool(condition)}', flush=True)
    if not condition:
        raise AssertionError(name)

def capture(page, name):
    page.evaluate('game.ui.update(0); game.camera.updateMatrixWorld(); game.composer.render()')
    page.screenshot(path=str(OUT / (name + '.jpg')), type='jpeg', quality=88, timeout=90000)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
        args=['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720}, device_scale_factor=1)
    page.on('pageerror', lambda e: errors.append(str(e)))
    try:
        page.goto(URL, wait_until='domcontentloaded')
        page.locator('#newgame').wait_for(state='visible', timeout=120000)
        page.click('#newgame')
        page.wait_for_function('game.started && document.pointerLockElement === game.canvas', timeout=60000)
        page.evaluate('game.renderer.setAnimationLoop(null); game.qualityLevel=3; game.aoOn=false; game.shaftsOn=false; game.onResize(); game.ao.configuration.intensity=0; game.step(.016)')
        for width in (1280, 1024):
            page.set_viewport_size({'width': width, 'height': 720})
            check(f'left HUD and tutorial do not overlap at {width}', page.evaluate('''() => {const a=document.querySelector('#topleft').getBoundingClientRect(), b=document.querySelector('#hint').getBoundingClientRect();return a.bottom<=b.top || b.bottom<=a.top || a.right<=b.left || b.right<=a.left}'''))
        page.set_viewport_size({'width':1280,'height':720})
        check('jetpack equipped on new game', page.evaluate('game.jetpack && !game.jetpack.active'))
        check('free building defaults on', page.evaluate('game.freeBuild === true'))
        check('natural forage exists on real hosts', page.evaluate('''() => {
          game.foraging.update(.1); const n=game.foraging.targets;
          return n.some(x=>x.food==='apple' && game.world.get(...x.host)===7) &&
                 n.some(x=>x.food==='berries' && game.world.decorAt(...x.host)>0);
        }'''))
        check('natural peaceful wildlife is not in hostile waves', page.evaluate('''() => {
          const f=game.foraging; return f.wildlife.length>0 && f.wildlife.every(a=>!game.entities.enemies.includes(a) && ['deer','boar'].includes(a.kind));
        }'''))
        # Let the ordinary Day 1 banner finish before capturing generated models.
        page.wait_for_timeout(3000)
        check('a generated apple has a clear view', page.evaluate("""() => {const g=game;for(const n of g.foraging.targets.filter(n=>n.food==='apple'))for(const [x,y,z] of [[0,-2,0],[2,-1,0],[-2,-1,0],[0,-1,2],[0,-1,-2],[2,0,0],[-2,0,0],[0,0,2],[0,0,-2]]){const q=n.position,e=q.clone().add({x,y,z}),d=q.clone().sub(e),l=d.length();d.normalize();const hit=g.world.raycast(e,d,l);if(!hit.hit||hit.t>=l-.15){const p=g.player;p.pos.copy(e);p.pos.y-=1.55;p.vel.set(0,0,0);g.camYaw=g.camYawT=Math.atan2(-d.x,-d.z);g.camPitch=Math.asin(d.y);g.updateCamera(0);g.updateAim();return true}}return false}"""))
        capture(page, '04-natural-apple')
        page.evaluate("""() => {const g=game,a=g.foraging.wildlife[0],q=a.pos,p=g.player;p.pos.set(q.x+3,q.y,q.z+4);p.vel.set(0,0,0);const dx=q.x-p.pos.x,dy=q.y+1-(p.pos.y+1.55),dz=q.z-p.pos.z;g.camYaw=g.camYawT=Math.atan2(-dx,-dz);g.camPitch=Math.atan2(dy,Math.hypot(dx,dz));g.updateCamera(0);g.updateAim()}""")
        capture(page, '05-natural-wildlife')
        # Use a naturally spawned berry node. Clear a short approach corridor in memory
        # to test occlusion and the real E input deterministically.
        page.evaluate("""() => {const g=game,n=g.foraging.targets.find(n=>n.food==='berries');window.berry=n;const q=n.position;const y=Math.floor(q.y);for(let x=Math.floor(q.x)-3;x<Math.floor(q.x);x++)for(let yy=y-1;yy<=y+2;yy++)g.world.set(x,yy,Math.floor(q.z),0);g.player.pos.set(q.x-2,q.y-1.45,q.z);g.player.vel.set(0,0,0);g.player.aimDir.set(1,0,0);g.world.set(Math.floor(q.x)-1,y,Math.floor(q.z),3);g.world.rebuildAround(q.x,q.z,1)}""")
        page.keyboard.press('KeyE')
        check('wall blocks E harvesting', page.evaluate('game.foraging.targets.includes(berry)'))
        page.evaluate("""() => {const q=berry.position;game.world.set(Math.floor(q.x)-1,Math.floor(q.y),Math.floor(q.z),0);game.player.aimDir.set(1,0,0)}""")
        check('natural berry becomes interactable without wall', page.evaluate('game.forageTarget()?.node===berry'))
        page.keyboard.press('KeyE')
        check('E harvests natural berries into inventory', page.evaluate('!game.foraging.targets.includes(berry) && game.inv.berries>=berry.amount && game.foraging.snapshot().harvested.includes(berry.id)'))
        page.evaluate('game.player.pos.copy(game.spawnPoint);game.player.pos.y=game.world.surfaceY(Math.floor(game.player.pos.x),Math.floor(game.player.pos.z))+.1;game.player.vel.set(0,0,0)')
        page.evaluate('''() => {const p=game.player; p.hp=100;p.maxHp=100;p.invuln=0;p.burn=0;p.dead=false;p.healthRegen.reset();p.damage(20);game.hitstopT=0;}''')
        check('accepted hit damages and starts eight second delay', page.evaluate('game.player.hp===80 && game.player.healthRegen.delayRemaining===8'))
        page.evaluate('game.simulate(4,1/30); game.player.invuln=1; game.player.damage(5); game.hitstopT=0')
        print('after invulnerable hit', page.evaluate('({hp:game.player.hp, delay:game.player.healthRegen.delayRemaining, slowmo:game.slowmo})'), flush=True)
        check('invulnerable hit leaves delay and health untouched', page.evaluate('game.player.hp===80 && Math.abs(game.player.healthRegen.delayRemaining-4)<.04'))
        page.evaluate('game.simulate(3.9,1/30)')
        check('no healing during delay', page.evaluate('game.player.hp===80'))
        page.evaluate('game.simulate(1.1,1/30)')
        check('passive heals one HP per second after delay', page.evaluate('Math.abs(game.player.hp-81)<.08'))
        page.evaluate('game.player.burn=10; game.simulate(1,1/30)')
        check('burning stops healing', page.evaluate('game.player.hp<=81'))
        page.evaluate('game.player.burn=0; game.player.invuln=999; game.player.hp=99.5;game.player.healthRegen.delayRemaining=0;game.player.regenerate(1)')
        check('healing caps at max HP', page.evaluate('game.player.hp===100'))
        page.evaluate('game.player.hp=80;game.player.healthRegen.delayRemaining=0')
        page.keyboard.press('Escape')
        page.wait_for_function('game.paused')
        page.evaluate('game.step(2)')
        check('pause stops healing and flight input', page.evaluate('game.player.hp===80 && !game.jetpack.active'))
        page.keyboard.press('KeyZ')
        check('paused Z does not toggle flight', page.evaluate('!game.jetpack.active'))
        page.locator('#resume').click()
        page.wait_for_function('!game.paused && document.pointerLockElement === game.canvas')
        page.keyboard.press('KeyZ')
        check('Z activates jetpack', page.evaluate('game.jetpack.active'))
        page.keyboard.down('Space')
        page.evaluate('game.simulate(1,1/30)')
        page.keyboard.up('Space')
        check('space climbs with flight', page.evaluate('game.player.vel.y > 0'))
        page.keyboard.down('Control')
        page.evaluate('game.simulate(1,1/30)')
        page.keyboard.up('Control')
        check('control descends with flight', page.evaluate('game.player.vel.y < 0'))
        page.keyboard.press('KeyZ')
        check('Z deactivates jetpack', page.evaluate('!game.jetpack.active'))
        page.evaluate("for(let i=0;i<2;i++){window.dispatchEvent(new KeyboardEvent('keydown',{code:'Space'}));window.dispatchEvent(new KeyboardEvent('keyup',{code:'Space'}))}")
        check('double space activates jetpack', page.evaluate('game.jetpack.active'))
        page.evaluate("for(let i=0;i<2;i++){window.dispatchEvent(new KeyboardEvent('keydown',{code:'Space'}));window.dispatchEvent(new KeyboardEvent('keyup',{code:'Space'}))}")
        check('double space deactivates jetpack', page.evaluate('!game.jetpack.active'))
        # UI food interaction and bench purchases use controlled inventory/bench fixtures.
        page.evaluate("game.player.hp=50;game.player.burn=0;game.world.burning.clear(); game.player.healthRegen.delayRemaining=8; game.player.healthRegen.foodHealing=0; game.inv.apple=4; game.inv.metal=100;game.inv.iron=100;game.inv.copper=100;game.inv.coal=10; game.inv.goo=100; game.inv.stone=100")
        page.keyboard.press('Tab')
        page.wait_for_function('game.ui.craftOpen')
        page.locator('[data-craft-tab="craft"]').click()
        check('food UI lists timed healing', '2 HP/s' in page.locator('#food-controls').inner_text())
        refining_visible = 'Refine Iron' in page.locator('#craftlist').inner_text()
        page.locator('[data-craft-tab="upgrades"]').click()
        ore_visible = all(x in page.locator('#ore-inventory').inner_text() for x in ['Iron 100', 'Copper 100', 'Coal 10'])
        check('ore inventory and refining recipes appear', ore_visible and refining_visible)
        page.locator('[data-craft-tab="craft"]').click()
        page.locator('#craftlist .recipe').filter(has_text='Refine Iron').click()
        page.locator('#craftlist .recipe').filter(has_text='Refine Copper').click()
        check('refining consumes ore and coal and produces metal', page.evaluate('game.inv.iron===98 && game.inv.copper===98 && game.inv.coal===8 && game.inv.metal===105'))
        page.evaluate('game.inv.coal=0')
        page.locator('#craftlist .recipe').filter(has_text='Refine Iron').click()
        check('refining without coal spends nothing', page.evaluate('game.inv.iron===98 && game.inv.coal===0 && game.inv.metal===105'))
        page.evaluate('game.inv.iron=100;game.inv.copper=100;game.inv.metal=100;game.inv.coal=8')
        capture(page, '01-food-and-upgrades')
        page.locator('#food-controls [data-food="apple"]').click()
        check('food click consumes one and queues without instant healing', page.evaluate('game.inv.apple===3 && game.player.hp===50 && game.player.healthRegen.foodHealing===10'))
        page.locator('[data-craft-tab="upgrades"]').click()
        page.locator('#laser-upgrades [data-upgrade="reach"]').click()
        check('away from bench cannot buy laser upgrade', page.evaluate('game.laserLevels.reach===0 && game.inv.metal===100'))
        page.keyboard.press('Tab')
        page.wait_for_function('!game.ui.craftOpen && document.pointerLockElement===game.canvas')
        page.evaluate('game.slowmo=1;game.simulate(1,1/30)')
        check('food heals over time', page.evaluate('game.player.hp>51.9 && game.player.hp<52.2 && game.player.healthRegen.foodHealing<8.1'))
        page.evaluate('game.player.hp=95;game.player.healthRegen.foodHealing=10')
        page.keyboard.press('KeyJ')
        check('queued healing covering need rejects food', page.evaluate('game.inv.apple===3'))
        page.keyboard.press('KeyQ')
        page.wait_for_function('game.construction.panelOpen')
        check('Q exposes free build toggle on', page.locator('#free-build').is_checked())
        page.locator('#build-shapes [data-index="8"]').click()
        page.locator('#build-width').fill('8'); page.locator('#build-height').fill('5'); page.locator('#build-depth').fill('8')
        check('room shell has floor four walls and open doorway and roof', page.evaluate("""() => {const c=game.construction.blueprint(8).cells; const has=(x,y,z)=>c.some(a=>a[0]===x&&a[1]===y&&a[2]===z); return c.length===170 && has(0,0,2) && !has(0,1,2) && !has(0,1,0) && !has(-1,3,0) && has(0,4,0) && has(-4,2,3) && has(3,2,3) && has(0,2,7) && !has(0,4,3)}"""))
        check('valid room dimensions clear old warning', 'at least' not in page.locator('#build-validation').inner_text())
        capture(page, '02-room-builder')
        page.locator('#build-use').click()
        page.wait_for_function('!game.construction.panelOpen && document.pointerLockElement===game.canvas')
        page.evaluate('''() => {const g=game,w=g.world,p=g.player.pos,X=Math.floor(p.x)+12,Z=Math.floor(p.z)-12;w.generateAround(X,Z,2);let Y=0;for(let x=X-12;x<=X+12;x+=3)for(let z=Z-12;z<=Z+12;z+=3)Y=Math.max(Y,w.surfaceY(x,z));Y+=2;for(let x=X-12;x<=X+12;x++)for(let z=Z-12;z<=Z+12;z++){w.set(x,Y-1,z,1);for(let y=Y;y<=Y+12;y++)w.set(x,y,z,0)}w.rebuildAround(X,Z,2);window.site={X,Y,Z};p.set(X+.5,Y+3,Z+3.5);g.jetpack.active=true;g.player.vel.set(0,0,0);g.inv.planks=0;g.select(5);g.construction.selectPreset(8);g.construction.setCustomDimensions(8,5,8);g.player.aimDir.set(0,-.3,-1).normalize();g.hover={x:X,y:Y-1,z:Z,nx:0,ny:1,nz:0};g.construction.update(g.hover,8,'planks')}''')
        check('zero-resource room preview is valid with free build', page.evaluate('game.construction.valid && game.construction.cost===170'))
        page.mouse.down()
        page.evaluate('game.updateActions(.016)')
        page.mouse.up()
        check('real click places free room with no planks', page.evaluate('game.inv.planks===0 && game.construction.cells.every(c=>game.world.get(...c)===8)'))
        page.evaluate("""() => {const g=game,{X,Y,Z}=site,p=g.player;p.pos.set(X+12,Y+11,Z+11);const dx=X-p.pos.x,dy=Y+2-(p.pos.y+1.55),dz=Z-4-p.pos.z;g.camYaw=g.camYawT=Math.atan2(-dx,-dz);g.camPitch=Math.atan2(dy,Math.hypot(dx,dz));g.construction.hide();g.updateCamera(0);g.world.rebuildAround(X,Z,2)}""")
        capture(page, '06-airborne-room')
        # A simple test wall and ceiling exercise the actual player physics with keyboard input.
        page.evaluate('''() => {const g=game,w=g.world,{X,Y,Z}=site;for(let x=X+7;x<=X+9;x++)for(let y=Y;y<=Y+5;y++)w.set(x,y,Z-2,3);for(let x=X+7;x<=X+9;x++)for(let z=Z-1;z<=Z+3;z++)w.set(x,Y+4,z,3);g.player.pos.set(X+8.5,Y,Z+1.5);g.player.vel.set(0,0,0);g.camYaw=g.camYawT=0;g.jetpack.active=true;}''')
        page.keyboard.down('KeyW'); page.evaluate('game.simulate(1,1/30)'); page.keyboard.up('KeyW')
        check('flight collides with solid wall', page.evaluate('game.player.pos.z>=site.Z-0.69'))
        page.keyboard.down('Space'); page.evaluate('game.simulate(1,1/30)'); page.keyboard.up('Space')
        check('flight collides with ceiling', page.evaluate('game.player.pos.y+game.player.h<=site.Y+4.001'))
        page.evaluate('''() => {const g=game,{X,Y,Z}=site;window.prey=g.foraging.wildlife.find(a=>!a.dead);prey.pos.set(X+8.5,Y,Z+5.5);prey.vel.set(0,0,0);g.player.pos.set(X+8.5,Y,Z+8.5);g.player.vel.set(0,0,0);g.camera.position.set(X+8.5,Y+1,Z+8.5);g.player.aimDir.set(0,0,-1);g.select(0);g.fireCd=0;}''')
        for _ in range(4):
            page.evaluate('game.fireCd=0; game.player.aimDir.set(0,0,-1)')
            page.mouse.down(); page.evaluate('game.updateActions(.016);game.projectiles.update(.1);game.input.lmbPressed=false'); page.mouse.up()
        check('actual pistol shots kill peaceful wildlife and drop meat', page.evaluate("prey.dead && game.entities.pickups.some(p=>p.res==='meat')"))
        page.evaluate("window.meatDrop=game.entities.pickups.find(p=>p.res==='meat'); game.player.pos.set(meatDrop.m.position.x,meatDrop.m.position.y-.8,meatDrop.m.position.z);meatDrop.t=.5;game.entities.update(.016)")
        check('dropped meat is picked up', page.evaluate('game.inv.meat>0'))
        # Find real generated underground ores, open a two-cell approach, and cut
        # each original ore block with F and a held mouse. Counts are deterministic.
        found = page.evaluate('''() => {const w=game.world,p=game.player.pos, out={};for(let x=Math.floor(p.x)-64;x<=Math.floor(p.x)+64;x++)for(let z=Math.floor(p.z)-64;z<=Math.floor(p.z)+64;z++){if(!w.isGenerated(x,z))continue;for(let y=4;y<=Math.min(35,w.surfaceY(x,z)-6);y++){const t=w.get(x,y,z);if(t>=20&&t<=22&&!out[t])out[t]=[x,y,z]}if(Object.keys(out).length===3)return out;}return out;}''')
        check('all three ores occur naturally underground', all(str(t) in found for t in (20,21,22)))
        for ore, resource in [(20,'copper'),(21,'iron'),(22,'coal')]:
            xyz=found[str(ore)]
            before=page.evaluate('(r) => ({ore:game.inv[r],stone:game.inv.stone})',resource)
            page.evaluate('''([x,y,z]) => {const g=game,w=g.world;for(let zz=z+1;zz<=z+4;zz++)for(let yy=y-2;yy<=y+2;yy++)w.set(x,yy,zz,0);g.player.pos.set(x+.5,y-1.05,z+3.5);g.player.vel.set(0,0,0);g.camYaw=g.camYawT=0;g.camPitch=0;g.updateCamera(0);g.updateAim()}''', xyz)
            page.keyboard.press('KeyF')
            page.mouse.down();page.evaluate('game.updateActions(2)');page.mouse.up()
            check(f'laser mines natural {resource} and grants ore plus stone', page.evaluate('''([xyz,r,b])=>game.world.get(...xyz)===0 && game.inv[r]===b.ore+2 && game.inv.stone===b.stone+1''',[xyz,resource,before]))
        page.evaluate('game.player.pos.set(site.X+8.5,site.Y,site.Z+8.5);game.player.vel.set(0,0,0)')
        page.keyboard.press('KeyQ')
        page.wait_for_function('game.construction.panelOpen')
        page.locator('#free-build').uncheck()
        check('free build toggle off changes state', page.evaluate('game.freeBuild===false'))
        page.locator('#build-use').click()
        page.wait_for_function('!game.construction.panelOpen && document.pointerLockElement===game.canvas')
        # The workbench is a real supported block; its registry is populated as a controlled fixture.
        page.evaluate("""() => { const p=game.player.pos,w=game.world; const c=[Math.floor(p.x)+1,Math.floor(p.y),Math.floor(p.z)]; w.set(...c, 3); game.construction.benches.push({cell:c,block:3}); }""")
        check('fixture workbench is reachable', page.evaluate('game.construction.nearWorkbench()'))
        page.evaluate('game.inv.iron=100;game.inv.copper=100;game.inv.goo=100;game.inv.stone=100')
        page.keyboard.press('Tab')
        page.wait_for_function('game.ui.craftOpen')
        page.locator('[data-craft-tab="upgrades"]').click()
        check('laser UI shows baseline and next stats and price', all(x in page.locator('#laser-upgrades').inner_text() for x in ['8 HP/s', '10 HP/s', '8 m', '12 m', 'iron', 'copper']))
        page.locator('#laser-upgrades [data-upgrade="power"]').click()
        page.locator('#laser-upgrades [data-upgrade="reach"]').click()
        check('workbench buys upgrades at displayed costs', page.evaluate('game.laserLevels.power===1 && game.laserLevels.reach===1 && game.inv.iron===96 && game.inv.copper===96 && game.inv.goo===97 && game.inv.stone===96'))
        capture(page, '03-laser-upgrades')
        page.locator('#laser-upgrades [data-upgrade="power"]').click()
        page.locator('#laser-upgrades [data-upgrade="reach"]').click()
        check('both upgrades stop at tier two', page.evaluate('game.laserLevels.power===2 && game.laserLevels.reach===2') and '16 m' in page.locator('#laser-upgrades').inner_text())
        page.keyboard.press('Tab')
        page.wait_for_function('!game.ui.craftOpen && document.pointerLockElement===game.canvas')
        page.evaluate("game.construction.benches.pop()")  # remove registry-only workbench fixture
        # Check actual tier-two beam damage and reach against a clear controlled range.
        page.evaluate("""() => {const g=game,w=g.world,{X,Y,Z}=site;for(let z=Z-10;z<=Z+11;z++)for(let y=Y;y<=Y+3;y++)w.set(X+8,y,z,0);w.set(X+8,Y+1,Z-4,3);w.set(X+8,Y+1,Z-9,3);g.player.pos.set(X+8.5,Y,Z+10.5);g.player.vel.set(0,0,0);g.camYaw=g.camYawT=0;g.camPitch=0;g.mods.mine=1;g.updateCamera(0);g.updateAim()}""")
        page.keyboard.press('KeyF')
        page.mouse.down();page.evaluate('game.updateActions(.25)');page.mouse.up()
        check('tier two power applies 12 HP per second beyond 12 meters', page.evaluate('Math.abs(game.world.damage.get(game.world.idx(site.X+8,site.Y+1,site.Z-4))-3)<.001'))
        page.mouse.down();page.evaluate('game.updateActions(2);game.updateAim();game.updateActions(2)');page.mouse.up()
        check('tier two reach cuts within 16m but not beyond', page.evaluate('game.world.get(site.X+8,site.Y+1,site.Z-4)===0 && game.world.get(site.X+8,site.Y+1,site.Z-9)===3 && !game.world.damage.get(game.world.idx(site.X+8,site.Y+1,site.Z-9))'))
        page.evaluate('game.player.pos.y=game.world.H-game.player.h-.1;game.player.vel.set(0,0,0);game.jetpack.active=true')
        page.keyboard.down('Space');page.evaluate('game.simulate(.5,1/30)');page.keyboard.up('Space')
        check('flight respects world ceiling', page.evaluate('game.player.pos.y+game.player.h<=game.world.H+.001'))
        page.keyboard.press('Escape');page.wait_for_function('game.paused')
        page.evaluate('window.pauseY=game.player.pos.y;game.step(1)')
        check('active flight freezes while paused', page.evaluate('game.jetpack.active && game.player.pos.y===pauseY'))
        page.locator('#resume').click();page.wait_for_function('!game.paused && document.pointerLockElement===game.canvas')
        page.evaluate('game.player.pos.set(site.X+8.5,site.Y,site.Z+8.5);game.player.vel.set(0,0,0)')
        page.evaluate("game.player.healthRegen.foodHealing=7;game.player.healthRegen.delayRemaining=5;game.inv.apple=2;game.jetpack.active=true;game.entities.addPickup('meat',1,game.player.pos.x+2,game.player.pos.y+1,game.player.pos.z)")
        check('killed wildlife cooldown appears in save state', page.evaluate('game.foraging.snapshot().animalCooldown.some(c=>c[0]===prey.spawnId)'))
        page.evaluate("game.save('manual')")
        page.wait_for_function('!game.saving', timeout=60000)
        page.evaluate("game.player.healthRegen.foodHealing=0;game.laserLevels.power=0;game.freeBuild=true;game.jetpack.active=false;game.inv.apple=0")
        page.evaluate("game.quickLoad()")
        page.wait_for_function('game.laserLevels.power===2', timeout=60000)
        check('save/load preserves food flight upgrades and build setting', page.evaluate('game.player.healthRegen.foodHealing===7 && game.player.healthRegen.delayRemaining===5 && game.inv.apple===2 && game.jetpack.active && !game.freeBuild && game.laserLevels.reach===2 && game.foraging.snapshot().harvested.includes(berry.id)'))
        check('save/load restores dropped food and wildlife cooldown', page.evaluate("game.entities.pickups.some(p=>p.res==='meat') && game.foraging.snapshot().animalCooldown.some(c=>c[0]===prey.spawnId)"))
        check('no browser errors', not errors)
        (OUT / 'results.json').write_text(json.dumps({'url':URL,'checks':checks,'page_errors':errors}, indent=2) + '\n')
    finally:
        if errors: print('page errors:', errors, flush=True)
        browser.close()
