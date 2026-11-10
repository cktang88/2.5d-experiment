#!/usr/bin/env python3
"""Check real dependency branches and progression controls in the browser."""
import sys
from playwright.sync_api import sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5173/'
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    page.goto(url, wait_until='domcontentloaded')
    page.locator('#newgame').wait_for(state='visible', timeout=120000)
    page.click('#newgame')
    page.wait_for_function('game.started && document.pointerLockElement===game.canvas', timeout=60000)
    page.evaluate('game.renderer.setAnimationLoop(null); game.step(.016); Object.assign(game.inv, {metal:0,iron:0,copper:0,coal:0,wood:0});')
    page.keyboard.press('Tab')
    page.click('[data-craft-tab="progression"]')
    station = page.locator('[data-node="turret"] > .progress-station')
    assert 'missing' in station.get_attribute('class')
    page.evaluate("""() => { const g=game, p=g.player.pos, x=Math.floor(p.x), z=Math.floor(p.z), y=g.world.surfaceY(x,z); g.player.pos.set(x+.5,y+1,z+.5); g.construction.benches.push({cell:[x,y,z],block:g.world.get(x,y,z)}); g.ui.refreshCraft(); }""")
    assert page.evaluate('game.construction.nearWorkbench()')
    assert 'ready' in station.get_attribute('class')
    page.locator('#progression-view .progress-picker [data-select="workbench"]').click()
    assert page.locator('[data-node="workbench"] .progress-count.missing').count() == 0
    assert 'placement is free' in page.locator('[data-node="workbench"]').inner_text()
    page.locator('#progression-view .progress-picker [data-select="upgrade-power-2"]').click()
    assert 'missing' in page.locator('.progress-prerequisite').get_attribute('class')
    page.evaluate('game.laserLevels.power=1; game.ui.refreshCraft()')
    assert 'ready' in page.locator('.progress-prerequisite').get_attribute('class')
    page.locator('#progression-view .progress-picker [data-select="turret"]').click()
    tree = page.locator('[data-node="turret"] [data-node="metal"]')
    assert tree.locator('[data-node="iron"]').count() == 1
    assert tree.locator('[data-node="coal"]').count() == 1
    assert 'need 4' in tree.locator('[data-node="iron"] > .progress-node-title').inner_text()
    assert tree.locator('[data-node="iron"] .missing').count() == 1
    tree.locator('[data-alternative="metal"][data-index="1"]').click()
    assert tree.locator('[data-node="copper"]').count() == 1
    assert tree.locator('[data-node="iron"]').count() == 0
    page.locator('[data-node="turret"] > .progress-branches > [data-node="wood"] [data-select="wood"]').click()
    assert 'Gather wood from trees' in page.locator('#progression-view').inner_text()
    page.locator('#progression-view .progress-picker [data-select="turret"]').click()
    page.locator('#progression-view [data-place-workbench]').first.click()
    page.wait_for_function('game.construction.mode===6 && !game.ui.craftOpen')
    print('Progression chain, alternatives, missing resources, source and workbench action verified')
    browser.close()
