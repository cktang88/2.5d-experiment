#!/usr/bin/env python3
"""Exercise glowstick recovery, capacity and IndexedDB persistence in Chromium."""
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'])
    page = browser.new_page()
    page.goto('http://127.0.0.1:5173/', wait_until='domcontentloaded')
    page.locator('#newgame').wait_for(state='visible', timeout=120000)
    page.click('#newgame')
    page.wait_for_function('game.started && document.pointerLockElement===game.canvas', timeout=60000)
    page.evaluate('''() => {
      const g=game,w=g.world,p=g.player.pos; g.renderer.setAnimationLoop(null);
      let X=Math.floor(p.x)+12,Z=Math.floor(p.z)-12,Y=0; w.generateAround(X,Z,3);
      for(let x=X-5;x<=X+5;x++) for(let z=Z-5;z<=Z+5;z++) Y=Math.max(Y,w.surfaceY(x,z)); Y+=3;
      for(let x=X-5;x<=X+5;x++) for(let z=Z-5;z<=Z+5;z++) {w.set(x,Y-1,z,1);for(let y=Y;y<Y+5;y++)w.set(x,y,z,0)}
      window.site={X,Y,Z}; p.set(X+.5,Y,Z+.5);g.player.vel.set(0,0,0);g.player.aimDir.set(0,0,1);g.inv.glowstick=40;
      for(let i=0;i<30;i++){g.glowsticks.throw();g.glowsticks.sticks[i].remaining=100+i}
    }''')
    assert page.evaluate('game.glowsticks.sticks.length===30 && game.inv.glowstick===10 && game.glowsticks.lights.filter(l=>l.intensity>0).length===4')
    assert page.evaluate('''() => {const s=game.glowsticks.sticks[0];game.inv.glowstick=0;const ok=game.glowsticks.throw();game.inv.glowstick=10;return !ok && game.glowsticks.sticks[0]===s}''')
    assert page.evaluate('''() => {const {X,Y,Z}=site,s=game.glowsticks.sticks[0];game.world.set(X,Y+1,Z,1);const ok=game.glowsticks.throw();game.world.set(X,Y+1,Z,0);return !ok && game.glowsticks.sticks[0]===s}''')
    assert page.evaluate('''() => {const first=game.glowsticks.sticks[0],second=game.glowsticks.sticks[1];return game.glowsticks.throw() && game.glowsticks.sticks.length===30 && game.glowsticks.sticks[0]===second && !game.scene.children.includes(first.mesh)}''')
    page.evaluate('''() => {const g=game,{X,Y,Z}=site;g.glowsticks.sticks.forEach((s,i)=>s.mesh.position.set(X+3,Y+1.45,Z+3));g.glowsticks.sticks[0].mesh.position.set(X+.5,Y+1.45,Z+2.5);g.glowsticks.sticks[0].remaining=42;g.updateActions(0)}''')
    assert page.locator('#interaction').inner_text() == 'E · Pick up glowstick'
    page.evaluate('game.paused=true')
    page.keyboard.press('KeyE')
    assert page.evaluate('game.glowsticks.sticks.length===30')
    page.evaluate('''() => {game.paused=false;const {X,Y,Z}=site;game.world.set(X,Y+1,Z+1,1)}''')
    page.keyboard.press('KeyE')
    assert page.evaluate('game.glowsticks.sticks.length===30')
    page.evaluate('''() => {const {X,Y,Z}=site;game.world.set(X,Y+1,Z+1,0);game.glowsticks.sticks[0].mesh.position.z=Z+5.5}''')
    page.keyboard.press('KeyE')
    assert page.evaluate('game.glowsticks.sticks.length===30')
    page.evaluate('game.glowsticks.sticks[0].mesh.position.z=site.Z+2.5')
    page.keyboard.press('KeyE')
    assert page.evaluate('game.glowsticks.sticks.length===29 && game.inv.glowstick===10 && game.glowsticks.lights.length===4')
    page.keyboard.press('KeyE')
    assert page.evaluate('game.inv.glowstick===10')
    page.keyboard.press('KeyL')
    assert page.evaluate('game.glowsticks.sticks.length===30 && game.inv.glowstick===9 && game.glowsticks.sticks[29].remaining===42')
    page.evaluate('''() => {game.glowsticks.sticks[0].mesh.position.set(site.X+.5,site.Y+1.45,site.Z+2.5);game.glowsticks.sticks[0].remaining=37}''')
    page.keyboard.press('KeyE')
    page.evaluate('''async () => {window.savedOrder=game.glowsticks.snapshot();const save=await import('/src/save.ts');await save.saveGame(game,'manual');game.glowsticks.restore([]);game.inv.glowstick=0;await save.loadGame(game,'manual')}''')
    assert page.evaluate('JSON.stringify(game.glowsticks.snapshot())===JSON.stringify(savedOrder) && game.inv.glowstick===10')
    assert page.evaluate('game.glowsticks.throw() && game.glowsticks.sticks.at(-1).remaining===37')
    print('Glowstick recovery browser checks passed')
    browser.close()
