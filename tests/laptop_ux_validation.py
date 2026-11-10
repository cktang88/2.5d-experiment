#!/usr/bin/env python3
"""Laptop viewport browser review. Run with Vite on 127.0.0.1:5173."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parents[1] / 'docs/screenshots/laptop'
OUT.mkdir(parents=True, exist_ok=True)
results = {}
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader','--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width':1280,'height':720}, device_scale_factor=2)
    errors=[]
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://127.0.0.1:5173/', wait_until='domcontentloaded')
    page.locator('#newgame').wait_for(state='visible', timeout=180000)
    page.click('#newgame', timeout=90000)
    page.wait_for_function('game.started && document.pointerLockElement===game.canvas', timeout=180000)
    page.evaluate('game.renderer.setAnimationLoop(null);game.qualityLevel=3;game.aoOn=false;game.shaftsOn=false;game.onResize();game.ao.configuration.intensity=0;game.step(.016);game.ui.update(0);game.camera.updateMatrixWorld();game.composer.render()')
    page.screenshot(path=str(OUT/'default.png'), timeout=120000)
    for width,height in [(1280,720),(1707,960),(2560,1440),(1440,900),(1024,640)]:
        page.set_viewport_size({'width':width,'height':height})
        page.evaluate('game.onResize();game.ui.update(0)')
        info=page.evaluate('''() => {const ids=['stats','minimap','hotbar','toolcontext'];return Object.fromEntries(ids.map(id=>{const e=document.getElementById(id);if(!e)return [id,null];const r=e.getBoundingClientRect();return [id,{x:r.x,y:r.y,w:r.width,h:r.height,display:getComputedStyle(e).display}]}))}''')
        results[f'{width}x{height}']=info
        print(width,height,info,flush=True)
    page.set_viewport_size({'width':1280,'height':720})
    page.keyboard.press('Escape')
    page.wait_for_function('game.paused')
    for panel in ['help','settings']:
        page.locator('#pause-'+panel).click()
        page.locator('#'+panel).wait_for(state='visible')
        info=page.evaluate('''id=>{const card=document.querySelector('#'+id+' .card'),r=card.getBoundingClientRect();return {rect:[r.x,r.y,r.width,r.height],scrollWidth:card.scrollWidth,clientWidth:card.clientWidth,scrollHeight:card.scrollHeight,clientHeight:card.clientHeight}}''',panel)
        results[panel]=info
        page.screenshot(path=str(OUT/(panel+'.png')),timeout=120000)
        page.locator('#'+panel+' .panel-close').click()
    page.locator('#pause-settings').click()
    page.locator('#sandbox-mode').check()
    results['sandboxEnabled']=page.evaluate('game.sandbox')
    assert results['sandboxEnabled'], 'Settings checkbox did not enable sandbox'
    page.locator('#settings .panel-close').click()
    page.locator('#resume').click()
    page.wait_for_function('!game.paused && document.pointerLockElement===game.canvas')
    page.keyboard.press('Tab')
    page.wait_for_function('game.ui.craftOpen')
    results['workbenchCTA']=page.locator('#craft-workbench').is_visible()
    assert results['workbenchCTA'], 'Workbench action missing from crafting'
    page.evaluate('game.camera.updateMatrixWorld();game.composer.render()')
    page.screenshot(path=str(OUT/'craft.png'),timeout=120000)
    page.locator('#craft-workbench').click()
    results['equipped']=page.evaluate('({selected:game.hotbar[game.sel].id,mode:game.construction.mode,craftOpen:game.ui.craftOpen})')
    assert results['equipped'] == {'selected':'planks','mode':6,'craftOpen':False}, 'Workbench action did not equip placement'
    assert not errors, errors
    results['errors']=errors
    (OUT/'results.json').write_text(json.dumps(results,indent=2)+'\n')
    print(json.dumps(results,indent=2),flush=True)
    browser.close()
