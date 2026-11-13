#!/usr/bin/env python3
"""Browser checks for the overhead architect mode (Q): camera hand-off, drag tools, bulk builds, undo."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parents[1] / 'docs/screenshots/architect'
OUT.mkdir(parents=True, exist_ok=True)
errors = []

def check(name, value):
    print(name, bool(value), flush=True)
    if not value: raise AssertionError(name)

STEP = 'n=>{for(let i=0;i<n;i++)game.step(.05);game.camera.updateMatrixWorld();game.composer.render()}'
WHEEL = "d=>game.canvas.dispatchEvent(new WheelEvent('wheel',{deltaY:d,clientX:innerWidth/2,clientY:innerHeight/2,bubbles:true,cancelable:true}))"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM') or None, args=['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    frames = lambda n=1: page.evaluate(STEP, n)
    def drag(x0, y0, x1, y1):
        page.mouse.move(x0, y0); frames(2); page.mouse.down()
        page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, steps=3); frames(1)
        page.mouse.move(x1, y1, steps=3); frames(3)
        tip = page.locator('#arch-tip').inner_text()
        page.mouse.up(); frames(30)
        return tip
    try:
        page.goto('http://127.0.0.1:5173/', wait_until='domcontentloaded')
        page.locator('#newgame').wait_for(state='visible', timeout=180000); page.click('#newgame')
        page.wait_for_function('game.started', timeout=180000)
        page.evaluate('game.renderer.setAnimationLoop(null);game.qualityLevel=3;game.aoOn=false;game.shaftsOn=false;game.onResize();game.ao.configuration.intensity=0')
        frames(60)
        page.keyboard.press('KeyQ'); frames(30)
        check('Q opens architect with a free cursor', page.evaluate('game.architect.open && game.architect.cameraActive && document.pointerLockElement === null'))
        check('camera rose above the player', page.evaluate('game.camera.position.y - game.player.pos.y > 25'))
        check('first-person tool hidden', page.evaluate('!game.player.gunHolder.visible'))
        page.keyboard.press('Space'); check('space pauses time', page.evaluate('game.architect.timePaused'))
        for _ in range(3): page.evaluate(WHEEL, 120); frames(2)
        frames(20)
        page.keyboard.press('Digit1')
        tip = drag(560, 380, 860, 560)
        check('wall drag reports size and blocks', '×' in tip and 'blocks' in tip)
        check('wall recorded for undo', page.evaluate('game.architect.undoStack.length === 1'))
        page.screenshot(path=str(OUT / 'wall.png'), timeout=120000)
        page.keyboard.press('Control+KeyZ'); frames(30)
        check('undo removes the wall', page.evaluate('game.architect.undoStack.length === 0 && game.architect.redoStack.length === 1'))
        page.keyboard.press('Control+KeyY'); frames(30)
        check('redo restores it', page.evaluate('game.architect.undoStack.length === 1'))
        page.keyboard.press('Digit8')
        tip = drag(470, 330, 1000, 650)
        check('moat drag reports removal', 'flooded' in tip)
        big = page.evaluate('''() => { const a = game.architect; a.selectTool('box'); a.height = 5; a.foundation = false;
          const p = game.player.pos, x = Math.floor(p.x) + 40, z = Math.floor(p.z) - 100, base = 200;
          const plan = a.makePlan([x, base, z], [x + 99, base, z + 199], base); a.plan = plan; a.count(plan, true); a.commit();
          return { err: plan.error, add: a.counts.add, x, z, base }; }''')
        check('100 x 200 x 5 block accepted', not big['err'] and big['add'] == 100000)
        for _ in range(400):
            if not page.evaluate('game.architect.busy'): break
            page.evaluate('game.step(.016)')
        check('100 x 200 x 5 block finished', page.evaluate(f"!game.architect.busy && game.world.get({big['x'] + 50}, {big['base'] + 4}, {big['z'] + 100}) !== 0"))
        page.keyboard.press('KeyQ'); frames(20)
        check('Q returns to first person', page.evaluate('!game.architect.open && !game.architect.cameraActive && game.player.gunHolder.visible && game.shared.uSlice.value === 0'))
        check('no page errors', not errors)
    finally:
        print('errors', errors)
        browser.close()
