#!/usr/bin/env python3
"""Real-game regression for placed structures and support loss (Vite must be running)."""
import sys
from playwright.sync_api import sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5173/'
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width': 1280, 'height': 720})
    page.goto(url, wait_until='domcontentloaded')
    page.locator('#newgame').wait_for(state='visible', timeout=120000)
    page.click('#newgame')
    page.wait_for_function('game.started && document.pointerLockElement === game.canvas', timeout=60000)
    result = page.evaluate('''async () => {
      game.renderer.setAnimationLoop(null);
      const {B} = await import('/src/blocks.ts');
      const {Turret} = await import('/src/entities.ts');
      const THREE = await import('/node_modules/.vite/deps/three.js');
      const g=game, w=g.world, X=Math.floor(g.player.pos.x)+12, Z=Math.floor(g.player.pos.z)-12;
      w.generateAround(X,Z,3);
      let Y=0; for(let x=X-16;x<=X+16;x+=4) for(let z=Z-16;z<=Z+16;z+=4) Y=Math.max(Y,w.surfaceY(x,z)); Y+=4;
      for(let x=X-16;x<=X+16;x++) for(let z=Z-16;z<=Z+16;z++) {
        w.set(x,Y-1,z,B.GRASS); for(let y=Y;y<=Y+8;y++) w.set(x,y,z,B.AIR);
      }
      g.player.pos.set(X-10,Y,Z+10); g.player.aimDir.set(0,0,1); g.freeBuild=true;
      function build(mode,x,z) {
        const c=g.construction; c.mode=mode; c.rotation=0;
        c.update({x,y:Y-1,z,nx:0,ny:1,nz:0},B.BRICK,'stone');
        const cells=c.cells.map(a=>[...a]);
        if(!c.place(B.BRICK,'stone')) throw Error(`mode ${mode} placement: ${c.validationMessage}`);
        return cells;
      }
      const tower=build(4,X,Z), stairs=build(3,X+8,Z), battlement=build(2,X-8,Z);
      const blocks=[...tower,...stairs,...battlement];
      for(let i=0;i<180;i++) g.physics.update(1/60);
      if(blocks.some(([x,y,z])=>w.get(x,y,z)!==B.BRICK)) throw Error('supported blueprint moved');
      // Uneven terrain may replace occupied cells; the remaining blueprint must still be supported.
      w.set(X+8,Y,Z+8,B.GRASS);
      const uneven=build(4,X+8,Z+8);
      for(let i=0;i<60;i++) g.physics.update(1/60);
      if(uneven.some(([x,y,z])=>w.get(x,y,z)!==B.BRICK)) throw Error('uneven supported tower moved');
      // Remove the entire foundation below the first tower and run the same support check as a blast.
      const removed=[]; for(let x=X-2;x<=X+2;x++) for(let z=Z-2;z<=Z+2;z++) {w.set(x,Y-1,z,B.AIR);removed.push([x,Y-1,z]);}
      g.checkSupport(removed);
      if(!tower.some(([x,y,z])=>w.get(x,y,z)===B.AIR)) throw Error('unsupported tower did not collapse');
      const t=new Turret(g,X-9.5,Y,Z+8.5,'auto'); t.ammo=0;
      t.damage(1,new THREE.Vector3(5,5,3));
      const start=t.pos.clone(); for(let i=0;i<60;i++) t.update(1/60);
      if(Math.abs(t.pos.x-start.x)>1e-6 || Math.abs(t.pos.z-start.z)>1e-6 || Math.abs(t.pos.y-start.y)>1e-6) throw Error(`supported turret moved: ${t.pos.toArray()}`);
      w.set(Math.floor(t.pos.x),Y-1,Math.floor(t.pos.z),B.AIR);
      for(let i=0;i<30;i++) t.update(1/60);
      if(t.pos.y>=Y-.1) throw Error('turret did not fall after support loss');
      t.disposeModel();
      return {tower:tower.length,stairs:stairs.length,battlement:battlement.length,uneven:uneven.length};
    }''')
    print('structure stability passed:', result)
    browser.close()
