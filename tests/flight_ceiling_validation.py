#!/usr/bin/env python3
"""Browser checks for the jetpack's ground-relative altitude limit."""
import sys
from playwright.sync_api import sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5173/'
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
        args=['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(url, wait_until='domcontentloaded')
    page.locator('#newgame').wait_for(state='visible', timeout=120000)
    page.click('#newgame')
    page.wait_for_function('game.started && document.pointerLockElement === game.canvas', timeout=60000)
    page.evaluate('''() => {
      game.renderer.setAnimationLoop(null);
      const p=game.player, w=game.world, x=Math.floor(p.pos.x), z=Math.floor(p.pos.z);
      window.fixture={x,z};
      for(let dx=-3;dx<=3;dx++) for(let dz=-3;dz<=3;dz++) {
        w.ensureColumn((x+dx)>>5,(z+dz)>>5);
        for(let y=80;y<=150;y++) w.set(x+dx,y,z+dz,0);
        w.set(x+dx,99,z+dz,3);
      }
      p.pos.set(x+.5,100,z+.5); p.vel.set(0,0,0); game.jetpack.active=true;
    }''')
    page.keyboard.down('Space')
    page.evaluate('game.simulate(8,1/60)')
    y = page.evaluate('game.player.pos.y')
    assert abs(y-130) < .01, y
    page.keyboard.up('Space')
    # Removing the floor simulates flying from a plateau over a deep drop.
    page.evaluate('''() => { const {x,z}=fixture; game.world.set(x,99,z,0); }''')
    page.evaluate('game.simulate(1/60,1/60)')
    after = page.evaluate('({y:game.player.pos.y,vy:game.player.vel.y})')
    assert 129.8 < after['y'] < 130 and -7 <= after['vy'] < 0, after
    page.evaluate('game.simulate(2,1/60)')
    print('descent', page.evaluate('({y:game.player.pos.y, vy:game.player.vel.y, altitude:game.player.flightAltitude, dead:game.player.dead, paused:game.paused})'), flush=True)
    assert page.evaluate('game.player.pos.y') < 125
    # A ceiling above the feet is never mistaken for supporting ground.
    page.evaluate('''() => {const {x,z}=fixture,p=game.player,w=game.world;
      w.set(x,99,z,3); w.set(x,125,z,3); p.pos.set(x+.5,110,z+.5); p.vel.set(0,0,0);
      p.update(1/60,game.input);
    }''')
    assert abs(page.evaluate('game.player.flightAltitude')-10) < .01
    # A save already above the limit descends without teleporting.
    page.evaluate('''() => {const {x,z}=fixture; game.world.set(x,125,z,0);
      game.player.pos.set(x+.5,140,z+.5); game.player.vel.set(0,0,0); game.simulate(1/60,1/60);
    }''')
    y = page.evaluate('game.player.pos.y')
    assert 139.8 < y < 140, y
    assert not errors, errors
    print('Flight ceiling browser checks passed')
    browser.close()
