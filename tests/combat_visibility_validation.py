#!/usr/bin/env python3
"""Exercise projectile timing and held-fire visibility in the running browser."""
import io, sys
from pathlib import Path
from PIL import Image, ImageChops, ImageStat
from playwright.sync_api import sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5173/'
out = Path('/tmp/combat-visibility')
out.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader','--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width':1280,'height':720})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(url, wait_until='domcontentloaded')
    page.locator('#newgame').wait_for(state='visible', timeout=120000)
    page.click('#newgame')
    page.wait_for_function('game.started && document.pointerLockElement === game.canvas', timeout=60000)
    result = page.evaluate('''() => {
      game.renderer.setAnimationLoop(null); game.step(.016); game.player.invuln=999; game.inv.ammo=100; game.inv.shells=100;
      const v=game.player.pos.clone(), d=v.clone().set(1,0,0), end=v.clone().add(d.clone().multiplyScalar(10));
      const enemy={kind:'enemy'}, player=game.player, turret={kind:'turret'};
      const bullet=(owner,hostilesOnly=false)=>game.projectiles.bullet(v,d,{dmg:1,speed:40,owner,hostilesOnly});
      const eb=bullet(enemy), pb=bullet(player), tb=bullet(turret), trap=bullet(enemy,true);
      const er=game.projectiles.rocket(v,d,enemy), pr=game.projectiles.rocket(v,d,player);
      const acid=game.projectiles.lob('acid',v,end,enemy), acidRef=game.projectiles.lob('acid',v,end,player);
      const grenade=game.projectiles.lob('grenade',v,end,player);
      const flight=2, at=acid.pos.clone().addScaledVector(acid.vel,flight); at.y-=.5*acid.g*flight*flight;
      const result={bullet:[eb.vel.length(),eb.life,pb.vel.length(),pb.life,tb.vel.length(),trap.vel.length()],rocket:[er.vel.length(),er.life,pr.vel.length(),pr.life],acid:[acid.vel.length()/acidRef.vel.length(),acid.g,acid.life,at.distanceTo(end)],grenade:[grenade.g,grenade.life,grenade.vel.x]};
      game.projectiles.reset(); return result;
    }''')
    print('projectiles', result, flush=True)
    assert result['bullet'] == [20,2.4,40,1.2,40,40]
    assert result['rocket'] == [13,8,26,4]
    assert abs(result['acid'][0]-.5)<1e-8 and result['acid'][1:3]==[4.5,10] and result['acid'][3]<1e-8
    assert result['grenade'][0:2] == [22,2.1] and abs(result['grenade'][2]-14)<1e-8
    page.evaluate('''() => {game.qualityLevel=3;game.aoOn=false;game.shaftsOn=false;game.onResize();game.select(2);game.camPitch=0;game.camYaw=1.5;game.updateCamera(0);game.updateAim();game.updateActions(0);game.particles.update(.1);game.composer.render()}''')
    def capture(name):
        page.evaluate('game.composer.render()')
        data=page.screenshot(path=str(out / (name+'.png')))
        return Image.open(io.BytesIO(data)).convert('RGB')
    rest=capture('rest')
    count=page.evaluate("game.scene.children.filter(x=>x.isPointLight).length")
    page.mouse.down()
    for i in range(10):
        page.evaluate('''() => {game.projectiles.update(.0674);game.particles.update(.0674);for(const f of game.flashLights){f.t-=.0674;f.l.intensity=f.t>0?f.power*f.t/f.max:0}game.fireCd=0;game.updateActions(.0834);game.projectiles.update(.016);game.particles.update(.016);for(const f of game.flashLights){f.t-=.016;f.l.intensity=f.t>0?f.power*f.t/f.max:0}game.input.lmbPressed=false}''')
    state=page.evaluate('''() => ({ammo:game.inv.ammo,active:game.flashLights.filter(f=>f.t>0).length,lights:game.scene.children.filter(x=>x.isPointLight).length,flashes:game.flashLights.filter(f=>f.t>0).map(f=>[f.power,f.max])})''')
    held=capture('smg-held')
    page.mouse.up()
    print('held fire',state,flush=True)
    assert state['ammo']==90 and state['lights']==count and state['active']<=1 and state['flashes']==[[4,.02]]
    # Compare the world above the weapon/HUD. A small fraction of changed pixels may be the flash.
    box=(0,0,1280,500)
    diff=ImageChops.difference(rest.crop(box),held.crop(box)).convert('L')
    changed=sum(n for value,n in enumerate(diff.histogram()) if value>35)/(1280*500)
    print('world pixel fraction changed > 35:',changed,flush=True)
    assert changed < .20
    page.evaluate('''() => {for(const f of game.flashLights){f.t=0;f.l.intensity=0}game.select(1);game.fireCd=0;game.input.lmbPressed=true;game.updateActions(.016)}''')
    shotgun=page.evaluate('''() => ({lights:game.scene.children.filter(x=>x.isPointLight).length, flash:game.flashLights.filter(f=>f.t>0).map(f=>[f.power,f.max])})''')
    print('shotgun',shotgun,flush=True)
    assert shotgun['lights']==count and shotgun['flash']==[[25,.06]]
    assert not errors, errors
    browser.close()
