#!/usr/bin/env python3
"""Browser checks for point building. Run with a local Vite server on port 5173.

The game is stopped and stepped explicitly; a flat, in-memory site and player
position are controlled fixtures as in survival_validation.py. Mouse clicks and
keyboard commands enter through the real browser input handlers. Screenshots are
unmodified browser captures.
"""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/screenshots/building'
OUT.mkdir(parents=True, exist_ok=True)
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5173/'
checks = {}
errors = []

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
        # Fixture: supported flat area in generated chunks, with empty air above.
        page.evaluate('''() => {const g=game,w=g.world,p=g.player.pos,X=Math.floor(p.x)+12,Z=Math.floor(p.z)-12;w.generateAround(X,Z,2);let Y=0;for(let x=X-12;x<=X+12;x+=3)for(let z=Z-12;z<=Z+12;z+=3)Y=Math.max(Y,w.surfaceY(x,z));Y+=2;for(let x=X-12;x<=X+12;x++)for(let z=Z-12;z<=Z+12;z++){w.set(x,Y-1,z,1);for(let y=Y;y<=Y+12;y++)w.set(x,y,z,0)}w.rebuildAround(X,Z,2);window.site={X,Y,Z};g.player.vel.set(0,0,0);g.jetpack.active=true;g.inv.planks=0;g.select(5)}''')
        def aim(x, y, z):
            page.evaluate("""([x,y,z])=>{const g=game,{X,Y,Z}=site;g.player.pos.set(X+.5,Y+1.5,Z+4.5);const p=g.player.pos,dx=X+x-p.x,dy=Y+y-(p.y+1.55),dz=Z+z-p.z;g.camYaw=g.camYawT=Math.atan2(-dx,-dz);g.camPitch=Math.atan2(dy,Math.hypot(dx,dz));g.updateCamera(0);g.updateAim();g.updateActions(.25)}""", [x,y,z])
        def click():
            page.mouse.down(); page.evaluate('game.updateActions(.25)'); page.mouse.up()
        def choose(index):
            page.keyboard.press('KeyQ'); page.wait_for_function('game.construction.panelOpen')
            page.locator(f'#build-shapes [data-index="{index}"]').click()
            page.locator('#build-use').click()
            page.wait_for_function('!game.construction.panelOpen && document.pointerLockElement===game.canvas')
        choose(7)
        aim(.5, -.01, .5)
        check('custom prompts for first corner', 'first' in page.evaluate('game.construction.validationMessage').lower())
        click()
        check('first click selects anchor without placing', page.evaluate('game.construction.gesture.stage===1 && game.world.get(site.X,site.Y,site.Z)===0'))
        aim(2.5, -.01, 2.5)
        check('custom prompts for opposite corner', 'opposite' in page.evaluate('game.construction.validationMessage').lower())
        click()
        check('second click selects base without placing', page.evaluate('game.construction.gesture.stage===2 && game.world.get(site.X,site.Y,site.Z)===0'))
        page.keyboard.press('BracketRight')
        aim(2.5, -.01, 2.5)
        check('height adjustment prompt and preview', page.evaluate("game.construction.gesture.height>=2 && game.construction.cells.length>0 && game.construction.validationMessage.toLowerCase().includes('height')"))
        capture(page, '01-custom-preview')
        click()
        check('free build succeeds with zero resources', page.evaluate('game.inv.planks===0 && game.world.get(site.X,site.Y,site.Z)===8'))
        # Reset the construction volume while retaining the supported floor.
        def clear():
            page.evaluate("""()=>{const {X,Y,Z}=site,w=game.world;for(let x=X-3;x<=X+7;x++)for(let z=Z-3;z<=Z+7;z++)for(let y=Y;y<=Y+8;y++)w.set(x,y,z,0);w.rebuildAround(X,Z,2)}""")
        clear()
        # A different material in the footprint is preserved and is not charged.
        page.evaluate('game.world.set(site.X+1,site.Y,site.Z+1,3);game.freeBuild=false;game.inv.planks=100')
        choose(7); aim(.5,-.01,.5); click(); aim(2.5,-.01,2.5); click()
        page.keyboard.press('BracketRight'); aim(2.5,-.01,2.5)
        check('intersection preview counts only air', page.evaluate('game.construction.valid && game.construction.cost===game.construction.cells.length && !game.construction.cells.some(c=>c[0]===site.X+1 && c[1]===site.Y && c[2]===site.Z+1)'))
        page.evaluate('window.charge=game.construction.cost;window.before=game.inv.planks')
        capture(page, '02-intersection-preview')
        click()
        check('paid placement preserves intersection and charges new cells', page.evaluate('game.world.get(site.X+1,site.Y,site.Z+1)===3 && game.inv.planks===before-charge && game.construction.gesture.stage===0'))
        # A repeat of the same volume is an explicit no-op with no cost.
        clear(); choose(7); aim(.5,-.01,.5); click(); aim(2.5,-.01,2.5); click(); page.keyboard.press('BracketRight'); aim(2.5,-.01,2.5)
        page.evaluate('for(const c of game.construction.cells) game.world.set(...c,3);window.before=game.inv.planks;game.updateActions(.25)')
        check('fully occupied preview is a no-op', page.evaluate('!game.construction.valid && game.construction.cost===0'))
        click()
        check('no-op spends nothing', page.evaluate('game.inv.planks===before'))
        page.keyboard.press('Escape')
        check('escape cancels point selection', page.evaluate('game.construction.gesture.stage===0 && !game.paused'))
        clear(); game_before = page.evaluate('game.inv.planks')
        aim(.5,-.01,.5); click(); page.keyboard.press('KeyQ')
        page.wait_for_function('game.construction.panelOpen')
        check('Q cancels staged selection', page.evaluate('game.construction.gesture.stage===0'))
        page.locator('#build-use').click(); page.wait_for_function('!game.construction.panelOpen && document.pointerLockElement===game.canvas')
        aim(.5,-.01,.5); click(); page.keyboard.press('Digit1')
        check('switching slot resets selection without shooting', page.evaluate('game.construction.gesture.stage===0 && game.inv.planks===%d' % game_before))
        # A solid landing provides a real raised endpoint for the stair gesture.
        clear(); page.evaluate('game.freeBuild=true;game.inv.planks=0;game.world.set(site.X+3,site.Y,site.Z,3);game.world.set(site.X+3,site.Y+1,site.Z,3);game.world.rebuildAround(site.X,site.Z,2)')
        choose(3); aim(.5,-.01,.5); click()
        aim(3.5,1.99,.5); click()
        check('stairs choose start and raised end', page.evaluate("game.construction.gesture.stage===2 && game.construction.gesture.end[1]===site.Y+2"))
        page.keyboard.press('BracketRight'); aim(3.5,1.99,.5)
        check('stairs width adjustment and one-block risers', page.evaluate("""()=>{const c=game.construction,g=c.gesture,cols=new Map();for(const [x,y,z] of c.cells){const k=x+','+z;cols.set(k,Math.max(cols.get(k)??-Infinity,y))}const a=[...cols].filter(([k])=>k.endsWith(','+site.Z)).sort((a,b)=>parseInt(a[0])-parseInt(b[0])).map(x=>x[1]);return g.width===3 && a.length>=3 && a.every((v,i)=>!i||Math.abs(v-a[i-1])<=1)}"""))
        capture(page, '03-stair-preview')
        click()
        check('point stairs build free and retain landing', page.evaluate('game.construction.gesture.stage===0 && game.inv.planks===0 && game.world.get(site.X+3,site.Y,site.Z)===3'))
        # Walk and jump up the full-block risers with normal player physics.
        page.evaluate("game.jetpack.active=false;game.player.pos.set(site.X-.6,site.Y,site.Z+.5);game.player.vel.set(0,0,0);game.camYaw=game.camYawT=-Math.PI/2;game.camPitch=0")
        page.keyboard.down('KeyW')
        page.evaluate('window.maxStairY=game.player.pos.y')
        for _ in range(2):
            page.evaluate('game.jetpack.resetTap()'); page.keyboard.down('Space'); page.evaluate('for(let i=0;i<3;i++){game.step(1/30);maxStairY=Math.max(maxStairY,game.player.pos.y)}'); page.keyboard.up('Space'); page.evaluate('for(let i=0;i<9;i++){game.step(1/30);maxStairY=Math.max(maxStairY,game.player.pos.y)}')
            check('flight stays off during stair jump %d' % _, page.evaluate('!game.jetpack.active'))
        page.keyboard.up('KeyW')
        check('player can ascend point stairs with jumps', page.evaluate('game.player.pos.x>site.X+2 && maxStairY>=site.Y+2'))
        page.keyboard.down('KeyS'); page.evaluate('game.simulate(2,1/30)'); page.keyboard.up('KeyS')
        check('player can descend point stairs', page.evaluate('!game.jetpack.active && game.player.pos.x<site.X && game.player.pos.y<site.Y+.2'))
        # An actor entering the planned volume must prevent every write.
        clear(); page.evaluate('game.freeBuild=false;game.inv.planks=100')
        choose(7); aim(.5,-.01,.5); click(); aim(2.5,-.01,2.5); click(); page.keyboard.press('BracketRight'); aim(2.5,-.01,2.5)
        page.evaluate("window.oldBlocks=game.entities.blocksCell;game.entities.blocksCell=(x,y,z)=>x===site.X+1&&y===site.Y&&z===site.Z+1;window.before=game.inv.planks;game.updateActions(.25)")
        check('actor overlap rejects preview', page.evaluate("!game.construction.valid && game.construction.validationMessage.toLowerCase().includes('actor')"))
        click()
        check('actor overlap makes no partial writes or charges', page.evaluate('game.inv.planks===before && game.world.get(site.X,site.Y,site.Z)===0'))
        page.evaluate('void (game.entities.blocksCell=oldBlocks)')
        # Force the existing support solver to report an unsupported component,
        # exercising transactional placement without relying on terrain collapse.
        page.evaluate("window.oldFloating=game.world.findFloating;game.world.findFloating=cs=>[[[...cs[0],8]]];game.updateActions(.25)")
        click()
        check('support rejection makes no partial writes or charges', page.evaluate("game.inv.planks===before && game.world.get(site.X,site.Y,site.Z)===0 && game.construction.validationMessage.toLowerCase().includes('support')"))
        page.evaluate('void (game.world.findFloating=oldFloating)')
        page.mouse.down(button='right'); page.evaluate('game.updateActions(.25)'); page.mouse.up(button='right')
        check('right click cancels without mining', page.evaluate('game.construction.gesture.stage===0 && game.world.get(site.X,site.Y-1,site.Z)===1'))
        page.keyboard.press('Escape'); page.wait_for_function('game.paused')
        page.mouse.down(); page.evaluate('game.step(.25)'); page.mouse.up()
        check('paused clicks do not place or charge', page.evaluate('game.inv.planks===before && game.world.get(site.X,site.Y,site.Z)===0'))
        page.locator('#resume').click(); page.wait_for_function('!game.paused && document.pointerLockElement===game.canvas')
        check('pause resumes with selection reset', page.evaluate('game.construction.gesture.stage===0'))
        check('no browser errors', not errors)
    finally:
        (OUT / 'results.json').write_text(json.dumps({'url': URL, 'checks': checks, 'page_errors': errors}, indent=2) + '\n')
        browser.close()
