#!/usr/bin/env python3
"""Browser verification of compact HUD, panels and workbench placement."""
import sys
from playwright.sync_api import sync_playwright
url=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:5173/'
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader','--disable-dev-shm-usage'])
 page=b.new_page(viewport={'width':1280,'height':720}, device_scale_factor=2)
 page.goto(url,wait_until='domcontentloaded'); page.locator('#newgame').wait_for(state='visible',timeout=120000); page.click('#newgame')
 page.wait_for_function('game.started && document.pointerLockElement===game.canvas',timeout=60000)
 page.evaluate('game.renderer.setAnimationLoop(null);game.step(.016)')
 for width,height in [(1280,720),(1707,960),(2560,1440),(1440,900),(1024,640)]:
  page.set_viewport_size({'width':width,'height':height}); page.evaluate('game.onResize();game.ui.update(0)')
  area=page.evaluate('''() => ['#topleft','#minimap','#hotbar','#toolcontext','#buildpalette','#interaction','#toasts'].reduce((n,s)=>{const e=document.querySelector(s),r=e.getBoundingClientRect(),c=getComputedStyle(e);return n+(c.display==='none'||c.visibility==='hidden'?0:r.width*r.height)},0)/(innerWidth*innerHeight)''')
  print(width,height,'HUD area',round(area,3),flush=True); assert area < .15
 page.set_viewport_size({'width':1280,'height':720}); page.keyboard.press('Escape'); page.click('#pause-help'); assert page.locator('#help').is_visible(); page.click('#help .panel-close')
 page.click('#pause-settings'); assert page.locator('#settings').is_visible(); page.click('#settings .panel-close'); page.click('#resume'); page.wait_for_function('document.pointerLockElement===game.canvas')
 page.evaluate('''() => {const g=game,w=g.world,p=g.player.pos,X=Math.floor(p.x)+12,Z=Math.floor(p.z)-12;w.generateAround(X,Z,2);let Y=0;for(let x=X-12;x<=X+12;x+=3)for(let z=Z-12;z<=Z+12;z+=3)Y=Math.max(Y,w.surfaceY(x,z));Y+=2;for(let x=X-12;x<=X+12;x++)for(let z=Z-12;z<=Z+12;z++){w.set(x,Y-1,z,1);for(let y=Y;y<=Y+12;y++)w.set(x,y,z,0)}w.rebuildAround(X,Z,2);window.site={X,Y,Z};g.player.vel.set(0,0,0);g.jetpack.active=true;g.freeBuild=true}''')
 page.keyboard.press('KeyQ'); page.wait_for_function('game.construction.panelOpen')
 assert page.locator('#build-shapes .buildshape img').count() == page.evaluate('game.construction.options.length')
 assert page.locator('#build-shapes img').first.evaluate('(e)=>e.complete && e.naturalWidth>0')
 page.evaluate("game.freeBuild=false;game.sandbox=false;game.inv.planks=0;document.querySelector('#free-build').checked=false;document.querySelector('#free-build').dispatchEvent(new Event('change'))")
 assert page.locator('#build-cost .missing').is_visible()
 assert page.locator('#build-cost .missing').inner_text().find('need') >= 0
 for index in [3,7,8]:
  card=page.locator(f'#build-shapes [data-index="{index}"] small')
  assert 'need' not in card.inner_text() and not card.evaluate("e => e.classList.contains('missing')")
 page.locator('#build-shapes [data-index="8"]').click()
 assert 'cost depends on placement' in page.locator('#build-cost').inner_text()
 for field in ['build-width','build-height','build-depth']: page.locator('#'+field).fill('4')
 assert page.locator('#build-cost .missing').is_visible()
 assert '4 × 4 × 4' in page.locator('#build-shapes [data-index="8"] small').inner_text()
 page.locator('#build-close').click();page.wait_for_function('document.pointerLockElement===game.canvas')
 page.evaluate('game.freeBuild=true')
 page.keyboard.press('Tab');
 assert page.locator('.recipe .missing').count() > 0
 assert page.locator('.recipe .requirement.missing').count() > 0
 for tab in ['defenses','traps','upgrades','progression','craft']:
  page.locator(f'[data-craft-tab="{tab}"]').click()
  assert page.locator(f'[data-craft-panel="{tab}"]').is_visible()
  assert page.evaluate("document.querySelector('#craft').scrollWidth <= document.querySelector('#craft').clientWidth")
 page.locator('#craft-workbench').click(); page.wait_for_function('document.pointerLockElement===game.canvas && game.construction.mode===6')
 page.evaluate('''()=>{const g=game,{X,Y,Z}=site;g.player.pos.set(X+.5,Y+1.5,Z+4.5);const p=g.player.pos,dx=X+.5-p.x,dy=Y-.01-(p.y+1.55),dz=Z+.5-p.z;g.camYaw=g.camYawT=Math.atan2(-dx,-dz);g.camPitch=Math.atan2(dy,Math.hypot(dx,dz));g.updateCamera(0);g.updateAim();g.updateActions(.25)}''')
 assert page.evaluate('game.construction.valid'), page.evaluate('game.construction.validationMessage')
 page.mouse.down();page.evaluate('game.updateActions(.25)');page.mouse.up()
 assert page.evaluate('game.construction.benches.length > 0')
 page.evaluate('game.player.pos.set(site.X+.5,site.Y,site.Z+2.5);game.updateCamera(0);game.updateAim();game.updateActions(.016)')
 assert page.evaluate('game.construction.nearWorkbench()')
 page.keyboard.press('KeyE'); assert page.locator('#craft').is_visible()
 print('Workbench placed by click and opened with E',flush=True)
 b.close()
