#!/usr/bin/env python3
"""Real mouse weapon feedback checks; run against a local Vite server."""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parents[1] / 'docs/screenshots/weapons'
OUT.mkdir(parents=True, exist_ok=True)
url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5173/'

def check(name, value):
    print(f'{name}: {bool(value)}', flush=True)
    assert value, name

def capture(page, name):
    page.evaluate('game.ui.update(0); game.updateCamera(0); game.composer.render()')
    page.screenshot(path=str(OUT / (name + '.jpg')), type='jpeg', quality=88, timeout=90000)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
        args=['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width':1280,'height':720}, device_scale_factor=1)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(url, wait_until='domcontentloaded')
    page.locator('#newgame').wait_for(state='visible', timeout=120000)
    page.click('#newgame')
    page.wait_for_function('game.started && document.pointerLockElement === game.canvas', timeout=60000)
    page.evaluate('game.renderer.setAnimationLoop(null);game.qualityLevel=3;game.aoOn=false;game.shaftsOn=false;game.onResize();game.step(.016);game.player.invuln=999;game.inv.ammo=100;game.inv.shells=100')
    for slot, name, ammo in [(0,'pistol',None),(1,'shotgun','shells'),(2,'smg','ammo')]:
        page.evaluate('''slot => {game.select(slot);game.fireCd=0;game.camPitch=0;game.camYaw=1.5;game.updateCamera(0);game.updateAim();game.updateActions(0);game.player.update(.016,game.input);window.baseZ=game.player.gunHolder.position.z;window.beforeAmmo=game.inv[game.hotbar[slot].ammo]}''',slot)
        capture(page, name + '-rest')
        page.mouse.down()
        page.evaluate('game.updateActions(.016);game.player.update(.001,game.input);game.updateCamera(0);game.updateAim()')
        state = page.evaluate('''() => {let p=game.player, d=p.aimDir.clone();game.camera.getWorldDirection(d);return {kick:p.cameraKick,z:p.gunHolder.position.z,base:baseZ,pitch:game.camPitch,shown:game.camera.rotation.x,aim:p.aimDir.distanceTo(d),ammo:game.inv[game.hotbar[game.sel].ammo]}}''')
        print(name, state, flush=True)
        check(name + ' ammunition behavior', state['ammo'] is None if ammo is None else state['ammo'] == page.evaluate('beforeAmmo-1'))
        check(name + ' model and camera kick', state['z'] > state['base']+.02 and 0 < state['kick'] <= .045 and state['shown'] > 0)
        check(name + ' preserves mouse pitch and crosshair aim', state['pitch'] == 0 and state['aim'] < 1e-6)
        capture(page, name + '-firing')
        page.mouse.up()
        page.evaluate('game.input.lmbPressed=false; for(let i=0;i<90;i++)game.player.update(1/60,game.input);game.updateCamera(0);game.updateAim()')
        check(name + ' returns to rest', page.evaluate('game.player.cameraKick<.00001 && Math.abs(game.player.gunHolder.position.z-baseZ)<.001 && game.camPitch===0'))
    # Real held mouse; ten deterministic ticks each exceed the SMG interval.
    page.evaluate('game.select(2);game.inv.ammo=100;game.fireCd=0')
    page.mouse.down()
    page.evaluate('for(let i=0;i<10;i++){game.updateActions(.08);game.player.update(.08,game.input);game.input.lmbPressed=false}')
    page.mouse.up()
    check('held SMG fires ten rounds', page.evaluate('game.inv.ammo===90'))
    page.evaluate('game.select(1);game.updateCamera(0)')
    check('selection clears recoil', page.evaluate('game.player.cameraKick===0 && game.player.recoil===0 && game.player.recoilRise===0'))
    page.evaluate('game.input.lmbPressed=false;game.updateActions(1)')
    check('release and selection do not fire extra rounds', page.evaluate('game.inv.ammo===90 && game.inv.shells===99'))
    check('no browser errors', not errors)
    browser.close()
