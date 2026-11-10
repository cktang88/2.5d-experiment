#!/usr/bin/env python3
"""Browser validation using a controlled flat area; screenshots are unaltered."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
out=Path('docs/screenshots/glowsticks'); checks={}; errors=[]
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader','--disable-dev-shm-usage'])
 page=b.new_page(viewport={'width':1280,'height':720})
 page.on('pageerror',lambda e:errors.append(str(e)))
 try:
  page.goto('http://127.0.0.1:5173/',wait_until='domcontentloaded');page.locator('#newgame').wait_for(state='visible',timeout=120000);page.click('#newgame');page.wait_for_function('game.started && document.pointerLockElement===game.canvas',timeout=60000)
  page.evaluate('''() => {let g=game,w=g.world,p=g.player.pos;g.renderer.setAnimationLoop(null);g.qualityLevel=3;g.aoOn=false;g.shaftsOn=false;g.onResize();g.ao.configuration.intensity=0;g.step(.016);let X=Math.floor(p.x),Z=Math.floor(p.z),Y=Math.floor(p.y)+20;w.generateAround(X,Z,3);for(let x=X-8;x<=X+8;x++)for(let z=Z-8;z<=Z+8;z++){w.set(x,Y-1,z,1);for(let y=Y;y<Y+7;y++)w.set(x,y,z,0)}w.rebuildAround(X,Z,2);p.set(X+.5,Y,Z+.5);g.player.vel.set(0,0,0);g.player.aimDir.set(0,0,-1);window.site={X,Y,Z};g.time=.9;g.updateDay(0);g.updateCamera(0)}''')
  checks['starter count']=page.evaluate('game.inv.glowstick===5')
  page.keyboard.press('KeyL');checks['L throws exactly one']=page.evaluate('game.inv.glowstick===4 && game.glowsticks.sticks.length===1')
  page.evaluate('''() => {const {X,Y,Z}=site;for(let x=X-2;x<=X+2;x++)for(let y=Y;y<Y+4;y++)game.world.set(x,y,Z-2,1);for(let i=0;i<200;i++)game.glowsticks.update(.01)}''')
  checks['wall blocks and stick lands']=page.evaluate('game.glowsticks.sticks[0].mesh.position.z > site.Z-1 && game.glowsticks.sticks[0].mesh.position.y < site.Y+.3')
  checks['actual local light']=page.evaluate('game.glowsticks.lights.filter(l=>l.intensity>0).length===1 && game.glowsticks.lights[0].distance>0')
  page.evaluate('''() => {const p=game.glowsticks.sticks[0].mesh.position;game.world.rebuildAround(site.X,site.Z,2);game.camera.position.set(p.x+4,p.y+4,p.z+6);game.camera.lookAt(p.x,p.y,p.z);game.camera.updateMatrixWorld()}''')
  page.wait_for_timeout(3000)
  import base64, io
  from PIL import Image, ImageChops, ImageStat
  def render_canvas():
   data=page.evaluate("game.composer.render();game.canvas.toDataURL('image/png')")
   return base64.b64decode(data.split(',',1)[1])
  print('fixture',page.evaluate('''() => ({p:game.glowsticks.sticks[0].mesh.position.toArray(),cam:game.camera.position.toArray(),dir:game.camera.getWorldDirection(new game.player.pos.constructor()).toArray(),visible:game.glowsticks.sticks[0].mesh.visible,scene:game.scene.children.length,light:game.glowsticks.lights[0].intensity,water:game.ocean.position.y})'''),flush=True)
  raw=render_canvas(); (out/'01-night-glowstick.png').write_bytes(raw)
  page.evaluate('game.glowsticks.sticks[0].mesh.visible=false')
  lit=render_canvas()
  page.evaluate('game.glowsticks.lights.forEach(l=>l.intensity=0)')
  dark=render_canvas()
  diff=ImageChops.difference(Image.open(io.BytesIO(lit)).convert('RGB'),Image.open(io.BytesIO(dark)).convert('RGB'))
  checks['light changes nonemissive world pixels']=sum(ImageStat.Stat(diff).mean)>.01
  page.evaluate('game.glowsticks.sticks[0].mesh.visible=true;game.glowsticks.update(0)')
  page.keyboard.press('Escape');before=page.evaluate('game.glowsticks.snapshot()');page.keyboard.press('KeyL');page.evaluate('game.step(1)');checks['pause blocks throwing and freezes sticks']=page.evaluate('(before) => game.glowsticks.sticks.length===1 && JSON.stringify(game.glowsticks.snapshot())===JSON.stringify(before)',before)
  page.evaluate('game.togglePause(false)');page.wait_for_function('document.pointerLockElement===game.canvas',timeout=10000)
  page.evaluate('game.player.dead=true');page.keyboard.press('KeyL');checks['dead blocks throw']=page.evaluate('game.glowsticks.sticks.length===1');page.evaluate('game.player.dead=false')
  page.evaluate("game.save('manual')");page.wait_for_function('!game.saving',timeout=60000)
  page.evaluate('game.glowsticks.restore([]);game.quickLoad()');page.wait_for_function('game.glowsticks.sticks.length===1',timeout=60000)
  checks['save/load restores stick']=page.evaluate('game.glowsticks.sticks.length===1 && game.glowsticks.sticks[0].remaining>170')
  checks['save snapshot restores position velocity lifetime']=page.evaluate('''() => {const s=game.glowsticks.snapshot();game.glowsticks.restore([]);game.glowsticks.restore(s);return JSON.stringify(s)===JSON.stringify(game.glowsticks.snapshot())}''')
  checks['30 stick FIFO, light cap and expiry']=page.evaluate('''() => {const g=game.glowsticks,s=g.snapshot()[0];g.restore(Array(30).fill(s));const oldest=g.sticks[0],cap=g.lights.filter(l=>l.intensity>0).length===4;const fifo=g.throw() && g.sticks.length===30 && !g.sticks.includes(oldest);g.update(181);return cap && fifo && g.sticks.length===0 && g.lights.every(l=>l.intensity===0)}''')
 except Exception as e: errors.append(str(e))
 finally:
  (out/'results.json').write_text(json.dumps({'checks':checks,'errors':errors},indent=2)+'\n');b.close()
print(checks,errors)
if errors or not all(checks.values()): raise SystemExit(1)
