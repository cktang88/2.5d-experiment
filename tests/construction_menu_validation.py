#!/usr/bin/env python3
"""Visual and browser checks for laptop construction and progression menus."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT=Path(__file__).resolve().parents[1]/'docs/screenshots/laptop'
OUT.mkdir(parents=True,exist_ok=True)
results={}; errors=[]
def check(name,value):
    results[name]=bool(value);print(name, bool(value), flush=True)
    if not value: raise AssertionError(name)
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader','--disable-dev-shm-usage'])
    wide=os.environ.get('LAPTOP_WIDE') == '1'
    page=browser.new_page(viewport={'width':1707 if wide else 1280,'height':960 if wide else 720},device_scale_factor=1.5 if wide else 2)
    page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(('http://127.0.0.1:5173/', 'data:')) else route.abort())
    page.on('pageerror',lambda e:errors.append(str(e)))
    try:
        page.goto('http://127.0.0.1:5173/',wait_until='domcontentloaded')
        page.locator('#newgame').wait_for(state='visible',timeout=180000); page.click('#newgame',timeout=90000)
        page.wait_for_function('game.started && document.pointerLockElement===game.canvas',timeout=180000)
        page.evaluate('game.renderer.setAnimationLoop(null);game.qualityLevel=3;game.aoOn=false;game.shaftsOn=false;game.onResize();game.ao.configuration.intensity=0;game.step(.016);game.ui.update(0);game.camera.updateMatrixWorld();game.composer.render()')
        page.evaluate('game.freeBuild=false;game.setSandboxMode(false);for(const k of Object.keys(game.inv))if(typeof game.inv[k]==="number")game.inv[k]=0')
        page.keyboard.press('KeyQ'); page.wait_for_function('game.construction.panelOpen')
        page.wait_for_function("[...document.querySelectorAll('#build-shapes img')].every(i=>i.complete&&i.naturalWidth>0)")
        check('all blueprint cards have loaded graphics',page.evaluate("document.querySelectorAll('#build-shapes .buildshape').length>=8 && [...document.querySelectorAll('#build-shapes .buildshape')].every(e=>{const i=e.querySelector('img');return i&&i.naturalWidth>0&&i.getBoundingClientRect().width>0})"))
        check('paid missing materials marked red',page.evaluate("document.querySelectorAll('#build-shapes .missing').length>0 && getComputedStyle(document.querySelector('#build-shapes .missing')).color==='rgb(255, 139, 128)'"))
        page.screenshot(path=str(OUT/('construction-wide.png' if wide else 'construction-paid.png')),timeout=120000)
        page.locator('#free-build').check();check('free construction clears shortage',page.locator('#build-shapes .missing').count()==0 and 'Free construction' in page.locator('#build-cost').inner_text())
        page.locator('#free-build').uncheck();page.evaluate('game.setSandboxMode(true);game.refreshBuildPanel()');check('sandbox clears construction shortage',page.locator('#build-shapes .missing').count()==0 and 'Free construction' in page.locator('#build-cost').inner_text())
        page.evaluate('game.setSandboxMode(false);game.refreshBuildPanel()')
        page.locator('#build-close').click();page.wait_for_function('!game.construction.panelOpen && document.pointerLockElement===game.canvas')
        page.keyboard.press('Tab');page.wait_for_function('game.ui.craftOpen')
        check('missing recipe costs and station marked',page.evaluate("!!document.querySelector('#craftlist .cost.missing') && !![...document.querySelectorAll('#craftlist .requirement.missing')].find(e=>e.textContent.includes('workbench'))"))
        fonts=page.evaluate("""async()=>{await document.fonts.ready;return {faces:[...document.fonts].map(f=>({family:f.family,status:f.status})),sample:[...document.querySelectorAll('body,#craft,.recipe,#craft-tabs button')].map(e=>getComputedStyle(e).fontFamily)}}""")
        results['fonts']=fonts
        check('font families avoid pixel fonts',all('VT323' not in x and 'Silkscreen' not in x for x in fonts['sample']))
        check('local font loads',any(f['status']=='loaded' and ('Bitter' in f['family'] or 'Alegreya' in f['family']) for f in fonts['faces']))
        for tab in ['craft','defenses','traps','upgrades','progression']:
            page.locator(f'[data-craft-tab="{tab}"]').click()
            check(f'{tab} tab active',page.locator(f'[data-craft-tab="{tab}"]').get_attribute('aria-selected')=='true' and page.locator(f'[data-craft-panel="{tab}"]').is_visible())
            if tab in ['craft','progression']: page.screenshot(path=str(OUT/f'{tab}-{'wide' if wide else 'tab'}.png'),timeout=120000)
        check('progression chain visible',page.evaluate("['turret','metal','iron','coal'].every(n=>document.querySelector('[data-node=\"'+n+'\"]'))"))
        check('alternative refining available',page.locator('[data-alternative="metal"]').count()>=2)
        page.locator('[data-alternative="metal"][data-index="1"]').click()
        page.locator('[data-select="wood"]').first.click()
        check('gathering hint shown','trees' in page.locator('#progression-view').inner_text().lower())
        page.locator('[data-craft-tab="craft"]').click()
        check('craft workbench action visible',page.locator('#craft-workbench').is_visible())
        page.locator('#craft-workbench').click();page.wait_for_function('!game.ui.craftOpen && game.construction.mode===6')
        check('workbench action equips placement',page.evaluate("game.hotbar[game.sel].id==='planks'"))
        page.keyboard.press('Escape');page.wait_for_function('game.paused');page.locator('#pause-help').click()
        for panel in ['help','settings']:
            if panel=='settings':page.locator('#pause-settings').click()
            card=page.locator(f'#{panel} .card')
            check(f'{panel} no horizontal overflow',card.evaluate('(e)=>e.scrollWidth<=e.clientWidth'))
            card.locator('.panel-close').click()
        check('no page errors',not errors)
    finally:
        results['errors']=errors
        (OUT/('construction-wide-results.json' if wide else 'construction-results.json')).write_text(json.dumps(results,indent=2)+'\n')
        browser.close()
