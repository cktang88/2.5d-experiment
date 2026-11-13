// Laptop UX: HUD layout, sandbox setting and the crafting panel's workbench action (was tests/laptop_ux_validation.py).
// The HUD layout rules hold at any size; run at a laptop size too:
//   npm run probe -- --eval-file tests/e2e/laptop-ux.js --w 1280 --h 720
// @lock 1
// @steps 20
const key = (code) => { dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true })); dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 10000) => { const t = performance.now(); while (!f()) { if (performance.now() - t > ms) return false; await sleep(30); } await sleep(60); return true; };
const visible = (s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(), c = getComputedStyle(e); return c.display !== 'none' && c.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
const g = game, W = innerWidth, H = innerHeight;
g.ui.update(0);

// HUD layout: minimap top-right, hotbar along the bottom, neither overlapping
const box = (s) => document.querySelector(s).getBoundingClientRect();
const mm = box('#minimap'), hb = box('#hotbar');
check('minimap visible in the top-right corner', visible('#minimap') && mm.right <= W + 1 && mm.right > W * .75 && mm.top < H * .25, [mm.left, mm.top, mm.right]);
check('hotbar visible along the bottom', visible('#hotbar') && hb.bottom <= H + 1 && hb.top > H * .6 && hb.left >= -1 && hb.right <= W + 1, [hb.left, hb.top, hb.right, hb.bottom]);
check('hotbar does not overlap the minimap', hb.top >= mm.bottom);

// sandbox from the pause menu's settings
key('Escape'); await until(() => g.paused);
document.getElementById('pause-settings').click();
const sb = document.getElementById('sandbox-mode');
sb.checked = true; sb.dispatchEvent(new Event('change', { bubbles: true }));
check('settings checkbox enables sandbox', g.sandbox === true);
document.querySelector('#settings .panel-close').click();
document.getElementById('resume').click();
check('resume recaptures the mouse', await until(() => !g.paused && document.pointerLockElement === g.canvas));

key('Tab'); await until(() => g.ui.craftOpen);
check('workbench action shown in crafting', visible('#craft-workbench'));
document.getElementById('craft-workbench').click();
check('workbench action opens workbench placement', g.architect.open && g.architect.tool === 'place' && g.architect.placeId === 'workbench' && !g.ui.craftOpen,
  { open: g.architect.open, tool: g.architect.tool, place: g.architect.placeId, craftOpen: g.ui.craftOpen });
g.architect.exit(false);
