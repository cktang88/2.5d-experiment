"""Browser regression for construction transactions. Start `npm run dev`, then run this
with Python Playwright and Chromium installed: python3 tests/construction_test.py.
"""
from playwright.sync_api import sync_playwright
import os
import shutil

with sync_playwright() as pw:
    executable = os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or pw.chromium.executable_path
    browser = pw.chromium.launch(executable_path=executable, headless=True, args=['--no-sandbox'])
    page = browser.new_page()
    page.route('**/construction_test_runner', lambda route: route.fulfill(content_type='text/html', body='<!doctype html><title>Construction test</title>'))
    page.goto('http://localhost:5173/construction_test_runner')
    result = page.evaluate('''async () => {
      const { Construction } = await import('/src/construction.ts');
      const THREE = await import('/node_modules/.vite/deps/three.js');
      const cells = new Map(), key = (x,y,z) => [x,y,z].join(',');
      let unsupported = false, blocked = false, writes = 0;
      const world = {
        inBounds: () => true, chunkAt: () => ({}),
        get: (x,y,z) => cells.get(key(x,y,z)) || 0,
        solid: (x,y,z) => !!cells.get(key(x,y,z)),
        set: (x,y,z,t) => { writes++; return t ? cells.set(key(x,y,z),t) : cells.delete(key(x,y,z)); },
        findFloating: cs => unsupported ? [[[...cs[0], 9]]] : [],
        raycast: () => blocked ? {hit:true,x:100,y:100,z:100} : {hit:false},
      };
      const game = {world, scene:new THREE.Scene(), player:{pos:new THREE.Vector3(.5,0,-2),aimDir:new THREE.Vector3(0,0,1)},
        inv:{bricks:100}, entities:{blocksCell:() => false}, checkSupport:()=>{}, audio:{deny(){},place(){}}, ui:{toast(){}}};
      const c = new Construction(game); c.mode = 5;
      const hit = {x:0,y:-1,z:0,nx:0,ny:1,nz:0};
      c.update(hit,9,'bricks'); unsupported=true;
      if (c.place(9,'bricks') || game.inv.bricks !== 100 || cells.size || writes) throw Error('unsupported validation mutated the world');
      unsupported=false; c.update(hit,9,'bricks');
      if (!c.place(9,'bricks') || cells.size !== 6 || game.inv.bricks !== 94) throw Error('drawbridge placement');
      if (c.interact() !== 'bridge' || cells.size !== 6 || world.get(0,2,0) !== 9 || world.get(0,0,2)) throw Error('raising');
      const saved = c.snapshot();
      const other = new Construction(game); other.restore(saved);
      blocked=true; if (other.interact() !== null) throw Error('interaction through wall');
      blocked=false; if (other.interact() !== 'bridge' || world.get(0,2,0) || world.get(0,0,2) !== 9) throw Error('restored lowering');
      other.onBlockRemoved(0,0,0); world.set(0,0,0,0); world.set(0,0,0,9);
      if (other.interact() !== null) throw Error('destroyed bridge control revived');
      return 'construction transactions and interaction passed';
    }''')
    print(result)
    browser.close()
