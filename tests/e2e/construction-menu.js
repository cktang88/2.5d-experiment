// Building costs (architect mode), crafting menu marks, fonts, tabs, progression and pause panels (was tests/construction_menu_validation.py).
// @lock 1
// @steps 20
const key = (code) => { dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true })); dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 10000) => { const t = performance.now(); while (!f()) { if (performance.now() - t > ms) return false; await sleep(30); } await sleep(60); return true; };
const visible = (s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(), c = getComputedStyle(e); return c.display !== 'none' && c.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
const g = game, a = g.architect, W = innerWidth, H = innerHeight;
g.freeBuild = false; g.setSandboxMode(false);
for (const k of Object.keys(g.inv)) if (typeof g.inv[k] === 'number') g.inv[k] = 0;

// Q building UI: paid shortage, free build and sandbox
key('KeyQ'); await until(() => a.open);
check('Q opens the building UI', a.open && visible('#arch-tools') && visible('#arch-opts'));
step(20); a.timePaused = true; a.selectTool('wall');
const peek = () => { // start a drag, read the tooltip, right-click to cancel (nothing is built)
  const [x0, y0, x1, y1] = [W * .35, H * .4, W * .6, H * .6];
  mouse('mousemove', x0, y0); step(1); mouse('mousedown', x0, y0); step(1); mouse('mousemove', x1, y1); step(2);
  const tip = document.getElementById('arch-tip'), html = tip.innerHTML, bad = tip.querySelector('.bad');
  const out = { html, bad: bad?.innerText ?? '', color: bad ? getComputedStyle(bad).color : '' };
  mouse('mousedown', x1, y1, 2); mouse('mouseup', x1, y1, 2); mouse('mouseup', x1, y1); step(2);
  return out;
};
const optsMissing = () => [...document.querySelectorAll('#arch-opts [data-mat] small')].map((e) => e.innerText);
check('material buttons show owned counts when paying', optsMissing().length >= 3 && optsMissing().every((t) => t === '0'), optsMissing());
let tip = peek();
check('paid missing materials shown as a shortage', /Need \d+ \w+; you have 0/.test(tip.bad), tip.html);
check('shortage is highlighted (not plain text colour)', tip.color && tip.color !== getComputedStyle(document.getElementById('arch-tip')).color, tip.color);
const free = document.querySelector('#arch [data-act="free"]');
free.click(); tip = peek();
check('free construction clears shortage', g.freeBuild && !tip.bad && optsMissing().length === 0, tip.html);
free.click(); check('free construction toggles back off', !g.freeBuild);
g.setSandboxMode(true); tip = peek();
check('sandbox clears construction shortage', !tip.bad && free.checked && free.disabled, tip.html);
g.setSandboxMode(false);
check('leaving sandbox re-enables the free build box', !free.checked && !free.disabled);
a.exit(); await until(() => !a.open && document.pointerLockElement === g.canvas);

// crafting panel
key('Tab'); await until(() => g.ui.craftOpen);
check('missing recipe costs marked', !!document.querySelector('#craftlist .cost.missing'));
check('missing workbench station marked', [...document.querySelectorAll('#craftlist .requirement.missing')].some((e) => e.textContent.includes('workbench')));
await document.fonts.ready;
const families = [...document.querySelectorAll('body,#craft,.recipe,#craft-tabs button')].map((e) => getComputedStyle(e).fontFamily);
check('font families avoid pixel fonts', families.every((f) => !f.includes('VT323') && !f.includes('Silkscreen')), families);
const faces = [...document.fonts].map((f) => [f.family, f.status]);
check('local font loads', faces.some(([f, s]) => s === 'loaded' && (f.includes('Bitter') || f.includes('Alegreya'))), faces);
for (const tab of ['craft', 'defenses', 'traps', 'upgrades', 'progression']) {
  document.querySelector(`[data-craft-tab="${tab}"]`).click();
  check(`${tab} tab active`, document.querySelector(`[data-craft-tab="${tab}"]`).getAttribute('aria-selected') === 'true' && visible(`[data-craft-panel="${tab}"]`));
}
check('progression chain visible', ['turret', 'metal', 'iron', 'coal'].every((n) => document.querySelector(`[data-node="${n}"]`)));
check('alternative refining available', document.querySelectorAll('[data-alternative="metal"]').length >= 2);
document.querySelector('[data-alternative="metal"][data-index="1"]').click();
document.querySelector('[data-select="wood"]').click();
check('gathering hint shown', document.getElementById('progression-view').innerText.toLowerCase().includes('trees'));
document.querySelector('[data-craft-tab="craft"]').click();
check('craft workbench action visible', visible('#craft-workbench'));
document.getElementById('craft-workbench').click();
check('workbench action opens placement', !g.ui.craftOpen && a.open && a.tool === 'place' && a.placeId === 'workbench');
a.exit(false); step(20);

// pause panels fit their cards
key('Escape'); await until(() => g.paused);
for (const panel of ['help', 'settings']) {
  document.getElementById(`pause-${panel}`).click();
  const card = document.querySelector(`#${panel} .card`);
  check(`${panel} opens`, visible(`#${panel}`));
  check(`${panel} no horizontal overflow`, card.scrollWidth <= card.clientWidth, [card.scrollWidth, card.clientWidth]);
  card.querySelector('.panel-close').click();
}
