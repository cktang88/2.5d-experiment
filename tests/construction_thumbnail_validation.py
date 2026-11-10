#!/usr/bin/env python3
"""Check room thumbnail geometry and image generation in a browser."""
import sys
from playwright.sync_api import sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5173/'
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'])
    page = browser.new_page()
    page.goto(url, wait_until='domcontentloaded')
    page.locator('#newgame').wait_for(state='visible', timeout=120000)
    page.click('#newgame')
    page.wait_for_function('game.started', timeout=60000)
    result = page.evaluate('''async () => {
      const c = game.construction;
      const {thumbnailForBlueprint} = await import('/src/art/constructionPreview.ts');
      const state = () => JSON.stringify({dimensions:c.dimensions, mode:c.mode, gesture:c.gesture, cost:c.currentCost, support:c.supportFailureKey});
      const before = state(), cells = c.getPreviewCells(8);
      const has = (a,x,y,z) => a.some(v => v[0]===x && v[1]===y && v[2]===z);
      const image = thumbnailForBlueprint(c, 8, 'planks');
      const img = new Image(); img.src = image; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width=img.width; canvas.height=img.height;
      const ctx=canvas.getContext('2d'); ctx.drawImage(img,0,0);
      const pixels=ctx.getImageData(0,0,img.width,img.height).data;
      let visible=0; for(let i=3;i<pixels.length;i+=4) if(pixels[i]) visible++;
      const unchanged = before === state();
      c.selectPreset(8); c.setCustomDimensions(4,4,4);
      const actual = c.getPreviewCells(8), actualImage = thumbnailForBlueprint(c,8,'planks');
      return {count:cells.length, floor:has(cells,0,0,2), interior:!has(cells,0,1,2), door:!has(cells,0,1,0), wall:has(cells,-4,2,3), unchanged, image:img.width===160 && img.height===96 && visible>500, actual:actual.length===46 && has(actual,-2,2,2), distinct:image!==actualImage};
    }''')
    print(result)
    assert result['count'] == 170 and all(v for k,v in result.items() if k != 'count')
    browser.close()
