#!/usr/bin/env python3
"""Capture deterministic first-person browser proof using a local Vite server.

Run: python tests/browser_proof.py [http://127.0.0.1:5173/]
Requires Python Playwright and /usr/bin/chromium. This prepares a flat construction
site and grants resources in memory; screenshots are unmodified browser captures.
The generated JSON records explicit state assertions rather than inferring them from
images. The suite never changes the saved game on disk outside the browser profile.
"""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/screenshots/first-person'
OUT.mkdir(parents=True, exist_ok=True)
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5173/'
checks, errors = {}, []

def require(name, result):
    checks[name] = result
    print(name, result, flush=True)
    if not result:
        raise AssertionError(name)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
        args=['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width':1280, 'height':720}, device_scale_factor=1)
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        page.goto(URL, wait_until='domcontentloaded')
        page.locator('#newgame').wait_for(state='visible', timeout=120000)
        page.click('#newgame', timeout=30000)
        page.wait_for_function('window.game?.started && document.pointerLockElement === game.canvas', timeout=60000)
        page.evaluate('game.renderer.setAnimationLoop(null); game.qualityLevel=3; game.aoOn=false; game.shaftsOn=false; game.onResize(); game.ao.configuration.intensity=0; game.step(.016)')
        require('started_and_pointer_locked', page.evaluate('document.pointerLockElement === game.canvas'))
        # Camera is placed with the player; meshes, HUD and overlays remain the game's own.
        page.evaluate('''() => {
          window.pose = (x,y,z,tx,ty,tz) => {
            const g=game; g.player.pos.set(x,y,z); g.player.vel.set(0,0,0);
            const dx=tx-x, dy=ty-(y+1.55), dz=tz-z;
            g.camYaw=g.camYawT=Math.atan2(-dx,-dz); g.camPitch=Math.atan2(dy,Math.hypot(dx,dz));
            g.updateCamera(0); g.updateAim(); g.updateReticle(); g.ui.update(0);
          };
          window.captureFrame = () => { game.camera.updateMatrixWorld(); game.composer.render(); };
          document.querySelector('#hint').classList.add('faded');
        }''')
        def capture(name):
            page.evaluate('game.ui.update(0); captureFrame()')
            page.screenshot(path=str(OUT / (name + '.jpg')), type='jpeg', quality=85, timeout=90000)
            print('screenshot', name, flush=True)
        # Deliberately level a generated patch, place voxel blueprints using the game's
        # own validation and cost logic, then remesh. No screenshot is painted or edited.
        result = page.evaluate('''() => {
          const g=game,w=g.world,p=g.player.pos;const X=Math.floor(p.x)+45,Z=Math.floor(p.z)+20;
          w.generateAround(X,Z,2);let Y=0;for(let x=X-17;x<=X+17;x+=4)for(let z=Z-18;z<=Z+18;z+=4)Y=Math.max(Y,w.surfaceY(x,z));Y+=3;window.site={X,Y,Z};
          for(let x=X-17;x<=X+17;x++) for(let z=Z-18;z<=Z+18;z++) {
            w.set(x,Y-1,z,1); for(let y=Y;y<=Y+15;y++)w.set(x,y,z,0);
          }
          g.inv.planks=999;g.inv.bricks=999;g.inv.turret=5;
          g.player.pos.set(X,Y,Z+15); g.player.aimDir.set(0,0,1);
          window.placeProof=(mode,x,z,slot=6) => {g.select(slot);g.construction.mode=mode;g.player.aimDir.set(0,0,mode===3?-1:1);
            const b=g.hotbar[slot];g.construction.update({x,y:Y-1,z,nx:0,ny:1,nz:0},b.place,b.ammo);
            const valid=g.construction.valid, cost=g.construction.cost;const ok=g.construction.place(b.place,b.ammo);return {valid,cost,ok};};
          const battlement=placeProof(2,X-10,Z-9), stairs=placeProof(3,X-10,Z-4), bastion=placeProof(4,X,Z-9), bridge=placeProof(5,X+8,Z-5,5), bench=placeProof(6,X+10,Z+5,5);
          w.rebuildAround(X,Z,2);return {battlement,stairs,bastion,bridge,bench};
        }''')
        for name, data in result.items(): require('placed_' + name, data['valid'] and data['ok'] and data['cost'] > 0)
        # Add turret through the normal action handler on top of the battlement.
        turret = page.evaluate('''() => {const g=game,{X,Y,Z}=site;g.select(8);g.hover={x:X-10,y:Y+3,z:Z-9,nx:0,ny:1,nz:0,point:g.player.pos.clone()};
          const before=g.entities.turrets.length;g.fireCd=0;g.input.lmbPressed=true;g.updateActions(.016);return g.entities.turrets.length===before+1;}''')
        require('turret_deployed_on_wall', turret)
        # Real 3D hostile actors, combat input, and a game-rendered view on the prepared site.
        page.evaluate('''() => {const g=game,{X,Y,Z}=site;pose(X,Y,Z+13,X,Y+.85,Z+6);
          window.proofEnemy=g.entities.spawnEnemy('zombie',X,Y,Z+6);g.entities.spawnEnemy('crawler',X+1.5,Y,Z+4);
          g.entities.update(.016);g.player.update(.016,g.input);g.ui.update(.016);g.fireCd=0;g.updateAim();g.updateReticle();}''')
        page.keyboard.press('Digit2')
        before = page.evaluate('game.inv.shells')
        page.mouse.down(); page.evaluate('game.updateActions(.016)'); page.mouse.up()
        require('real_mouse_shot_creates_nine_pellets', page.evaluate('(n) => game.inv.shells === n-1 && game.projectiles.list.filter(p=>p.type === "bullet").length === 9', before))
        page.wait_for_timeout(4000)
        capture('01-combat')
        page.evaluate('game.projectiles.update(.2)')
        require('aimed_shot_damages_enemy', page.evaluate('proofEnemy.hp < proofEnemy.maxHp'))
        page.evaluate('game.entities.enemies.forEach(e => {e.dead=true; e.removeSprite()}); game.projectiles.reset()')
        page.evaluate('''() => {const g=game,{X,Y,Z}=site;g.select(6);g.construction.mode=1;
          pose(X-2,Y,Z+14,X-2,Y+1,Z-5);g.player.aimDir.set(0,0,-1);
          g.hover={x:X-2,y:Y-1,z:Z+4,nx:0,ny:1,nz:0,point:g.player.pos.clone()};g.updateActions(0);}''')
        require('wall_preview_valid', page.evaluate('game.construction.valid && game.construction.preview.visible'))
        capture('02-blueprints-and-wall-preview')
        # Place viewpoint on the stairs and look toward the battlement parapet.
        page.evaluate('''() => {const {X,Y,Z}=site;game.construction.hide();pose(X-10.5,Y+3,Z-5.5,X-10.5,Y+3,Z-9);game.select(0);}''')
        capture('03-stairs-and-parapet')
        # Workbench interaction and gated recipe use real keyboard and UI click.
        page.evaluate('''() => {const {X,Y,Z}=site;pose(X+10.5,Y,Z+7.5,X+10.5,Y+1,Z+5.5);game.inv.goo=10;game.inv.wood=10;}''')
        capture('04-workbench')
        page.keyboard.press('KeyE')
        page.wait_for_function('game.ui.craftOpen && !document.pointerLockElement', timeout=10000)
        before=page.evaluate('game.inv.tnt')
        page.locator('#craftlist .recipe').nth(6).click()
        require('workbench_recipe_crafted', page.evaluate('(n) => game.inv.tnt === n+1', before))
        capture('05-workbench-crafting')
        page.keyboard.press('Tab')
        page.wait_for_function('document.pointerLockElement===game.canvas',timeout=10000)
        # Cut a shallow, water-filled moat under the outer deck; the hinge remains on the bank.
        moat=page.evaluate('''() => {const g=game,w=g.world,{X,Y,Z}=site;for(let x=X+7;x<=X+10;x++)for(let z=Z-4;z<=Z-3;z++){w.set(x,Y-2,z,1);w.set(x,Y-1,z,0);g.waterSim.fill(x,Y-1,z,8);}w.rebuildAround(X,Z,2);g.waterSim.update(0);const keys=new Set();for(let x=X+7;x<=X+10;x++)for(let z=Z-4;z<=Z-3;z++)keys.add(w.chunkAt(x,Y-1,z).key);for(const key of keys)g.waterSim.buildChunk(key);return g.waterSim.levelAt(X+8,Y-1,Z-4)===8 && [...keys].every(key=>g.waterSim.meshes.get(key)?.mesh?.geometry.attributes.position.count>0);}''')
        require('water_filled_moat',moat)
        # Stand beside the deck with an unobstructed view of the entire drawbridge.
        page.evaluate('''() => {const {X,Y,Z}=site;pose(X+12,Y,Z+1,X+8.5,Y+.4,Z-4);game.select(0);}''')
        capture('06-drawbridge-lowered')
        page.evaluate('''() => {const {X,Y,Z}=site;pose(X+10,Y,Z-1,X+8.5,Y+.4,Z-4);}''')
        page.keyboard.press('KeyE')
        bridge=page.evaluate('''() => {const r=game.construction.snapshot().bridges.at(-1);return {raised:r.raised, cells:r.raisedCells?.length};}''')
        require('drawbridge_raised', bridge['raised'] and bridge['cells']==6)
        page.evaluate('''() => {const {X,Y,Z}=site;game.world.rebuildAround(X,Z,2);pose(X+12,Y,Z+1,X+8.5,Y+1.3,Z-4);}''')
        capture('07-drawbridge-raised')
        # IndexedDB restoration checks actual camera orientation and construction state.
        saved=page.evaluate('''async () => {const g=game;const state=JSON.stringify(g.construction.snapshot());g.camYaw=g.camYawT=.9;g.camPitch=.3;
          await g.save('manual');g.camYaw=0;g.camPitch=0;g.construction.restore();g.entities.walkField.ready=true;g.entities.walkField.running=true;const ok=await g.load('manual');
          return ok && g.camYaw===.9 && g.camPitch===.3 && JSON.stringify(g.construction.snapshot())===state && !g.entities.walkField.ready && !g.entities.walkField.running;}''')
        require('save_restores_view_and_construction',saved)
        # Regression: a solid wall prevents reaching a station through it.
        blocked=page.evaluate('''() => {const g=game,w=g.world,{X,Y,Z}=site;pose(X+10.5,Y,Z+7.5,X+10.5,Y+1,Z+5.5);for(let y=Y;y<=Y+2;y++)w.set(X+10,y,Z+6,1);const denied=!g.construction.nearWorkbench();for(let y=Y;y<=Y+2;y++)w.set(X+10,y,Z+6,0);return denied && g.construction.nearWorkbench();}''')
        require('workbench_wall_blocks_interaction',blocked)
        destroyed=page.evaluate('''() => {const g=game,w=g.world,b=g.construction.snapshot().benches[0];w.damageBlock(...b.cell,1000,'mine');w.set(...b.cell,b.block);return g.construction.snapshot().benches.length===0 && !g.construction.nearWorkbench();}''')
        require('mined_workbench_replacement_not_interactive',destroyed)
        destroyed=page.evaluate('''() => {const g=game,w=g.world,b=g.construction.snapshot().bridges[0],c=b.raisedCells[2];w.damageBlock(...c,1000,'explosion');w.set(...c,b.block);return g.construction.snapshot().bridges.length===0;}''')
        require('destroyed_bridge_replacement_not_interactive',destroyed)
        fallen=page.evaluate('''() => {const g=game,w=g.world,{X,Y,Z}=site;const x=X+14,z=Z+8;w.set(x,Y-1,z,1);w.set(x,Y,z,0);g.player.pos.set(x-2,Y,z);const placed=placeProof(6,x,z,5).ok;w.set(x,Y-1,z,0);g.checkSupport([[x,Y,z]]);return placed && g.construction.snapshot().benches.length===0;}''')
        require('unsupported_workbench_removes_metadata',fallen)
        page.keyboard.press('F9')
        page.wait_for_function('game.paused && !game.loading',timeout=30000)
        require('quickload_pauses',page.evaluate('game.paused && !document.pointerLockElement'))
        page.evaluate('''() => {game.canvas.requestPointerLock=()=>Promise.reject(new Error('test rejection'));}''')
        page.click('#resume')
        page.wait_for_function('game.paused',timeout=10000)
        require('pointer_lock_rejection_pauses',page.evaluate('game.paused && !document.pointerLockElement'))
        require('no_page_errors', not errors)
    finally:
        (OUT / 'results.json').write_text(json.dumps({'url':URL,'prepared_scene':True,'checks':checks,'pageErrors':errors}, indent=2)+'\n')
        browser.close()
