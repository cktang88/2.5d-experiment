#!/usr/bin/env python3
"""Exercise paused combat through Game.step against a running Vite server."""
import sys
from playwright.sync_api import sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5173/'
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'])
    page = browser.new_page()
    page.goto(url, wait_until='domcontentloaded')
    page.locator('#newgame').wait_for(state='visible', timeout=120000)
    page.click('#newgame')
    page.wait_for_function('game.started', timeout=60000)
    result = page.evaluate('''async () => {
      const ents = await import('/src/entities.ts'), g = game, w = g.world;
      g.renderer.setAnimationLoop(null);
      const X = Math.floor(g.player.pos.x)+12, Z = Math.floor(g.player.pos.z)-12;
      w.generateAround(X,Z,3);
      const Y = w.surfaceY(X,Z)+3;
      for (let x=X-4;x<=X+4;x++) for (let z=Z-10;z<=Z+10;z++) {
        w.set(x,Y-1,z,1); for (let y=Y;y<=Y+5;y++) w.set(x,y,z,0);
      }
      g.player.pos.set(X,Y,Z+8); g.entities.enemies=[]; g.entities.turrets=[];
      const turret = new ents.Turret(g,X+.5,Y,Z-8,'auto');
      g.entities.turrets.push(turret);
      const enemy = g.entities.spawnEnemy('brute',X+.5,Y,Z+5);
      turret.yaw=0; turret.cd=0; g.paused=true;
      const ammo=turret.ammo;
      g.step(.016);
      const pausedTurret=turret.ammo===ammo && g.projectiles.list.length===0;
      g.paused=false; g.step(.016);
      const resumedTurret=turret.ammo===ammo-1 && g.projectiles.list.length>0;
      g.projectiles.reset(); turret.dead=true;
      enemy.pos.copy(g.player.pos); enemy.atkCd=0; g.player.hp=100; g.player.invuln=0;
      g.paused=true; g.step(.016);
      const pausedMelee=g.player.hp===100 && enemy.atkCd===0;
      const grenade=g.projectiles.lob('grenade',g.player.pos.clone(),g.player.pos.clone(),g.player);
      grenade.life=0; const hp=g.player.hp;
      g.step(.016);
      const pausedProjectile=g.projectiles.list.includes(grenade) && g.player.hp===hp;
      g.paused=false; g.step(.016);
      const resumedProjectile=!g.projectiles.list.includes(grenade);
      return {pausedTurret,resumedTurret,pausedMelee,pausedProjectile,resumedProjectile};
    }''')
    loaded = page.evaluate('''async () => {
      const ents=await import('/src/entities.ts'), g=game, p=g.player.pos;
      g.projectiles.reset(); g.entities.enemies=[]; g.entities.turrets=[];
      const e=g.entities.spawnEnemy('brute',p.x+4,p.y,p.z);
      const t=new ents.Turret(g,p.x-8,p.y,p.z,'auto');
      g.entities.turrets.push(t); t.cd=0;
      await g.save('manual'); await g.quickLoad();
      const loaded=g.entities.enemies[0], turret=g.entities.turrets[0];
      const ammo=turret.ammo, hp=g.player.hp, enemyHp=loaded.hp;
      g.step(.016);
      return g.paused && loaded.model3d.position.distanceTo(loaded.pos)<.001 &&
        Math.abs(loaded.farModel.position.x-loaded.pos.x)<.001 &&
        Math.abs(loaded.farModel.position.y-loaded.pos.y-loaded.h/2)<.001 &&
        Math.abs(loaded.farModel.position.z-loaded.pos.z)<.001 &&
        turret.ammo===ammo && g.player.hp===hp && loaded.hp===enemyHp;
    }''')
    result['pausedLoadVisuals'] = loaded
    print(result, flush=True)
    browser.close()
    assert all(result.values()), result
