// Compact HUD, pause panels, Q building UI costs, crafting tabs and workbench placement (was tests/ui_compact_validation.py).
// The HUD-area budget (< 15% of the screen) is a laptop rule and only checked at >= 1024 px wide:
//   npm run probe -- --eval-file tests/e2e/ui-compact.js --w 1280 --h 720   (and --w 1024 --h 640, ...)
// @lock 1
// @steps 20
const key = (code) => { dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true })); dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 10000) => { const t = performance.now(); while (!f()) { if (performance.now() - t > ms) return false; await sleep(30); } await sleep(60); return true; };
const locked = () => document.pointerLockElement === game.canvas;
const visible = (s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(), c = getComputedStyle(e); return c.display !== 'none' && c.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
const g = game, a = g.architect, W = innerWidth, H = innerHeight;
g.ui.update(0);

// HUD footprint
const hud = ['#topleft', '#minimap', '#hotbar', '#toolcontext', '#interaction', '#toasts'];
const area = hud.reduce((n, s) => { const e = document.querySelector(s); if (!e) return n; const r = e.getBoundingClientRect(), c = getComputedStyle(e); return n + (c.display === 'none' || c.visibility === 'hidden' ? 0 : r.width * r.height); }, 0) / (W * H);
if (W >= 1024) check(`HUD covers < 15% of a ${W}x${H} screen`, area < .15, area);
const outside = hud.filter((s) => { const e = document.querySelector(s); if (!e || !visible(s)) return false; const r = e.getBoundingClientRect(); return r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1; });
check('HUD panels stay inside the viewport', outside.length === 0, outside);

// pause menu panels
key('Escape'); await until(() => g.paused);
document.getElementById('pause-help').click(); check('help opens from pause', visible('#help'));
document.querySelector('#help .panel-close').click(); check('help closes', !visible('#help'));
document.getElementById('pause-settings').click(); check('settings opens from pause', visible('#settings'));
document.querySelector('#settings .panel-close').click(); check('settings closes', !visible('#settings'));
document.getElementById('resume').click(); check('resume recaptures the mouse', await until(() => !g.paused && locked()));

// Q building UI (architect mode) shows a shortage unless building is free
g.sandbox = false; g.freeBuild = false; g.inv.planks = 0; g.inv.bricks = 0; g.inv.stone = 0;
key('KeyQ'); await until(() => a.open);
check('Q opens the building UI', a.open && visible('#arch') && visible('#arch-tools'));
step(20); a.timePaused = true;
a.selectTool('wall');
const peek = (x0, y0, x1, y1) => { // start a drag, read the tooltip, right-click to cancel (nothing is built)
  mouse('mousemove', x0, y0); step(1); mouse('mousedown', x0, y0); step(1); mouse('mousemove', x1, y1); step(2);
  const tip = document.getElementById('arch-tip'), html = tip.innerHTML, bad = tip.querySelector('.bad')?.innerText ?? '';
  mouse('mousedown', x1, y1, 2); mouse('mouseup', x1, y1, 2); mouse('mouseup', x1, y1); step(2);
  return { html, bad };
};
const free = document.querySelector('#arch [data-act="free"]');
check('free build checkbox off when paying', free && !free.checked);
let tip = peek(W * .35, H * .4, W * .6, H * .6);
check('paid build shows the shortage', /Need \d+/.test(tip.bad), tip.html);
check('no blocks spent by a cancelled drag', a.undoStack.length === 0 && g.inv.planks === 0);
free.click();
check('free build checkbox turns free build on', g.freeBuild && free.checked);
tip = peek(W * .35, H * .4, W * .6, H * .6);
check('free build shows no shortage', !tip.bad && /blocks/.test(tip.html), tip.html);
g.freeBuild = false; a.refresh();
a.exit(); check('leaving the building UI recaptures the mouse', await until(() => !a.open && locked()));

// crafting panel
g.freeBuild = true;
key('Tab'); await until(() => g.ui.craftOpen);
check('missing recipe costs marked', document.querySelectorAll('.recipe .missing').length > 0);
check('missing station requirements marked', document.querySelectorAll('.recipe .requirement.missing').length > 0);
for (const tab of ['defenses', 'traps', 'upgrades', 'progression', 'craft']) {
  document.querySelector(`[data-craft-tab="${tab}"]`).click();
  check(`${tab} tab shows its panel`, visible(`[data-craft-panel="${tab}"]`));
  const c = document.querySelector('#craft');
  check(`${tab} tab has no horizontal overflow`, c.scrollWidth <= c.clientWidth, [c.scrollWidth, c.clientWidth]);
}

// workbench: crafting button -> architect placement -> click supported ground -> E opens crafting
document.getElementById('craft-workbench').click();
check('workbench button opens placement', a.open && a.tool === 'place' && a.placeId === 'workbench' && !g.ui.craftOpen);
step(20);
const p = g.player.pos;
let spot = null;
for (let d = 2; d < 6 && !spot; d++) for (const [dx, dz] of [[0, -d], [d, 0], [0, d], [-d, 0]]) {
  const x = Math.floor(p.x) + dx, z = Math.floor(p.z) + dz, c = [x, g.world.surfaceY(x, z), z];
  if (!a.placeReason(c) && Math.abs(c[1] - Math.floor(p.y)) <= 1) { spot = c; break; }
}
check('found supported ground for the workbench', !!spot);
if (spot) {
  a.pick = function () { this.hoverCell = spot; this.hoverSolid = [spot[0], spot[1] - 1, spot[2]]; this.hoverPoint = null; };
  const before = g.construction.benches.length;
  mouse('mousedown', W / 2, H / 2); mouse('mouseup', W / 2, H / 2); step(1);
  delete a.pick;
  check('click places a workbench', g.construction.benches.length === before + 1, g.construction.benches.length);
  a.exit(); await until(() => !a.open && locked());
  // stand beside it, facing it
  g.player.pos.set(spot[0] + .5, spot[1], spot[2] + 2.5); g.player.vel.set(0, 0, 0);
  const dx = spot[0] + .5 - p.x, dy = spot[1] + .5 - (p.y + 1.55), dz = spot[2] + .5 - p.z;
  g.camYaw = g.camYawT = Math.atan2(-dx, -dz); g.camPitch = Math.atan2(dy, Math.hypot(dx, dz));
  g.updateCamera(0); g.updateAim(); g.updateActions(.016);
  check('standing next to the workbench', g.construction.nearWorkbench());
  key('KeyE'); check('E beside the workbench opens crafting', g.ui.craftOpen && visible('#craft'));
}
