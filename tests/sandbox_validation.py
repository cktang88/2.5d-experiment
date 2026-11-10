#!/usr/bin/env python3
"""Browser checks for sandbox construction and save compatibility."""
import os
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'])
    page = browser.new_page()
    page.goto(os.environ.get('GAME_URL', 'http://127.0.0.1:5173/'), wait_until='domcontentloaded')
    page.locator('#newgame').wait_for(state='visible', timeout=120000)
    page.click('#newgame')
    page.wait_for_function('game.started', timeout=60000)
    result = page.evaluate('''async () => {
      const g=game,w=g.world,p=g.player.pos; g.renderer.setAnimationLoop(null);
      let x=Math.floor(p.x)+12,z=Math.floor(p.z)-12; w.generateAround(x,z,3);
      let y=w.surfaceY(x,z)+4;
      for(let a=x-8;a<=x+8;a++) for(let b=z-8;b<=z+8;b++) {w.set(a,y-1,b,1); for(let c=y;c<y+8;c++) w.set(a,c,b,0)}
      p.set(x-5,y,z+5); g.entities.enemies=[]; g.freeBuild=false;
      Object.assign(g.inv,{planks:0,bricks:0,tnt:0,lantern:0,turret:0,spikeTrap:0});
      localStorage.setItem('sandbox-test-other','preserved'); g.setSandboxMode(true);
      const checks={preference:localStorage.getItem('blockfall.sandbox')==='true', otherPreference:localStorage.getItem('sandbox-test-other')==='preserved'};
      function click(slot,xx) {g.select(g.hotbar.findIndex(s=>s.id===slot));g.hover={x:xx,y:y-1,z,nx:0,ny:1,nz:0};g.fireCd=0;g.input.lmbPressed=true;g.updateActions(.016);g.input.lmbPressed=false}
      g.construction.selectPreset(0); click('planks',x); checks.block=w.get(x,y,z)!==0 && g.inv.planks===0;
      click('tnt',x+1); checks.tnt=w.get(x+1,y,z)!==0 && g.inv.tnt===0;
      click('lantern',x+2); checks.lantern=w.get(x+2,y,z)!==0 && g.inv.lantern===0;
      g.selectDefense('auto'); g.hover={x:x+3,y:y-1,z,nx:0,ny:1,nz:0};g.fireCd=0;g.input.lmbPressed=true;g.updateActions(.016);g.input.lmbPressed=false;checks.defense=g.entities.turrets.length>0 && g.inv.turret===0;
      checks.trap=g.traps.place('spikes',0,x+4,y,z) && g.inv.spikeTrap===0;
      g.construction.selectPreset(6);click('planks',x+5);checks.bench=g.construction.benches.length>0 && g.inv.planks===0;
      await g.save('manual');g.setSandboxMode(false);await g.quickLoad();checks.saveRestore=g.sandbox===true;
      const db=await new Promise(ok=>{let r=indexedDB.open('blockfall-isle',1);r.onsuccess=()=>ok(r.result)});
      const data=await new Promise(ok=>{let r=db.transaction('saves').objectStore('saves').get('manual');r.onsuccess=()=>ok(r.result)});delete data.sandbox;
      await new Promise(ok=>{let tx=db.transaction('saves','readwrite');tx.objectStore('saves').put(data,'manual');tx.oncomplete=ok});db.close();await g.quickLoad();checks.legacyOff=!g.sandbox;
      checks.trapOff=!g.traps.place('spikes',0,x+6,y,z) && g.inv.spikeTrap===0;
      return checks;
    }''')
    print(result)
    browser.close()
    assert all(result.values()), result
