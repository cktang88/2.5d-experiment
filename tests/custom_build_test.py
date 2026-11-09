"""Browser regressions for custom construction dimensions, placement reach and support budget.

Start `npm run dev`, then run `python3 tests/custom_build_test.py`.
"""
from playwright.sync_api import sync_playwright
import os
import shutil

with sync_playwright() as pw:
    executable = os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or pw.chromium.executable_path
    browser = pw.chromium.launch(executable_path=executable, headless=True, args=['--no-sandbox'])
    page = browser.new_page()
    page.route('**/custom_build_test_runner', lambda route: route.fulfill(content_type='text/html', body='<!doctype html><title>Custom construction test</title>'))
    page.goto('http://localhost:5173/custom_build_test_runner')
    result = page.evaluate('''async () => {
      const { Construction } = await import('/src/construction.ts');
      const THREE = await import('/node_modules/.vite/deps/three.js');
      const cells = new Map(), key = (x,y,z) => [x,y,z].join(',');
      let writes = 0, supported = false, unsupported = false;
      const world = {
        inBounds: () => true, chunkAt: () => ({}),
        get: (x,y,z) => supported && y === -1 ? 3 : (cells.get(key(x,y,z)) || 0),
        solid: (x,y,z) => !!cells.get(key(x,y,z)),
        set: (x,y,z,t) => { writes++; return t ? cells.set(key(x,y,z),t) : cells.delete(key(x,y,z)); },
        findFloating: cs => unsupported ? [[[...cs[0],9]]] : [],
        raycast: () => ({hit:false}),
      };
      const game = {world, scene:new THREE.Scene(), camera:{position:new THREE.Vector3(0,10,-10)}, player:{pos:new THREE.Vector3(.5,0,-4.5),aimDir:new THREE.Vector3(0,0,1)},
        inv:{bricks:8192}, entities:{blocksCell:() => false}, checkSupport:()=>{}, audio:{deny(){},place(){}}, ui:{toast(){}}};
      const c = new Construction(game), hit = {x:0,y:-1,z:0,nx:0,ny:1,nz:0};
      if (!c.setCustomDimensions(64,2,64) || c.setCustomDimensions(2.5,2,2) || c.dimensionError === '') throw Error('dimension bounds/integer validation');
      c.selectPreset(3); c.update(hit,9,'bricks');
      if (!c.validationMessage.includes('stair start') || !c.place(9,'bricks') || c.gesture.stage !== 1 || writes) throw Error('stairs start selection');
      const end = {x:0,y:-1,z:2,nx:0,ny:1,nz:0};
      c.update(end,9,'bricks');
      if (!c.validationMessage.includes('stair end') || !c.place(9,'bricks') || c.gesture.stage !== 2 || writes) throw Error('stairs end selection');
      if (!c.adjustGesture(1) || c.gesture.width !== 3) throw Error('stairs width adjustment');
      c.update(end,9,'bricks');
      if (!c.valid || c.cells.length !== 9 || !c.validationMessage.includes('Width 3')) throw Error('stairs width preview');
      c.cancelGesture();
      if (c.gesture.stage !== 0 || writes) throw Error('stairs cancellation');
      c.selectPreset(7); c.setCustomDimensions(3,1,64); c.update(hit,9,'bricks');
      const zs = c.cells.map(v=>v[2]);
      if (Math.min(...zs) !== 0 || Math.max(...zs) !== 63) throw Error('custom depth was not anchored at the near edge');
      c.rotate(); c.update(hit,9,'bricks');
      if (new Set(c.cells.map(v=>v[0])).size !== 64 || new Set(c.cells.map(v=>v[2])).size !== 3) throw Error('quarter-turn dimensions');

      c.setCustomDimensions(2,1,2); c.rotation=0; unsupported=true; c.update(hit,9,'bricks');
      if (c.place(9,'bricks') || !c.validationMessage.includes('support')) throw Error('support failure feedback');
      c.update(hit,9,'bricks');
      if (c.valid || !c.validationMessage.includes('support')) throw Error('support failure cache');
      unsupported=false; c.update({x:1,y:-1,z:0,nx:0,ny:1,nz:0},9,'bricks');

      c.setCustomDimensions(64,2,64); c.update(hit,9,'bricks');
      if (c.cells.length !== 8192 || !c.valid || c.previewCapacity < 8192) throw Error('large preview capacity');
      const denied = !c.place(9,'bricks');
      if (!denied || game.inv.bricks !== 8192 || cells.size !== 0 || writes !== 0) throw Error('floating oversized shape bypassed support limit');

      // The same large dimensions pass when the bottom layer contacts anchored stone.
      supported = true; game.player.pos.set(40,0,-4.5); c.update({x:1,y:-1,z:0,nx:0,ny:1,nz:0},9,'bricks');
      const placedLarge = c.valid && c.place(9,'bricks');
      if (!placedLarge || game.inv.bricks !== 0 || cells.size !== 8192) throw Error(`grounded 8192-cell box rejected valid=${c.valid} message=${c.validationMessage} inv=${game.inv.bricks} cells=${cells.size}`);

      cells.clear(); c.selectPreset(8);
      if (c.dimensionError || c.gesture?.kind !== 'room' || c.gesture.stage !== 0 || c.setCustomDimensions(3,4,2) || !c.dimensionError.includes('doorway')) throw Error('room spatial selection or minimum dimensions');
      if (!c.setCustomDimensions(6,4,6)) throw Error('room dimension validation');
      if (c.validationMessage.includes('needs at least')) throw Error('valid dimensions retained stale room warning');
      game.inv.bricks=5000; c.update(hit,9,'bricks');
      const room=new Set(c.cells.map(v=>key(...v)));
      if (!c.valid || c.cost!==90 || c.cells.some(([x,y,z])=>y===4) || [1,2,3].some(y=>room.has(key(-1,y,0))||room.has(key(0,y,0)))) throw Error('open-roof room geometry/doorway');
      if (!c.setCustomDimensions(64,33,4)) throw Error('room shell should budget occupied cells rather than full volume');
      c.update(hit,9,'bricks');
      if (c.cost!==4474 || !c.valid) throw Error(`room occupied-cell budget cost=${c.cost} status=${c.validationMessage}`);
      c.setCustomDimensions(6,4,6); c.update({x:0,y:0,z:0,nx:0,ny:0,nz:-1},9,'bricks');
      if (!c.valid || c.cells.some(v=>v[2]>=0)) throw Error('side-face placement should snap its depth away from the hit block');
      return 'custom dimensions, anchoring, rotation and support budget passed';
    }''')
    print(result)
    browser.close()
