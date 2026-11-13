// Crafting progression tree: station state, branches, alternatives, gathering hints, Place Workbench (was tests/progression_validation.py).
// @lock 1
// @steps 20
const key = (code) => { dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true })); dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })); };
const q = (s) => document.querySelector(s), qa = (s) => [...document.querySelectorAll(s)];
const g = game;
Object.assign(g.inv, { metal: 0, iron: 0, copper: 0, coal: 0, wood: 0 });
key('Tab');
check('Tab opens crafting', g.ui.craftOpen);
q('[data-craft-tab="progression"]').click();
const station = () => q('[data-node="turret"] > .progress-station');
check('turret station missing without a workbench', station()?.classList.contains('missing'), station()?.className);
{
  const p = g.player.pos, x = Math.floor(p.x), z = Math.floor(p.z), y = g.world.surfaceY(x, z);
  g.player.pos.set(x + .5, y + 1, z + .5); g.construction.benches.push({ cell: [x, y, z], block: g.world.get(x, y, z) }); g.ui.refreshCraft();
}
check('bench registers as nearby', g.construction.nearWorkbench());
check('turret station ready next to a workbench', station()?.classList.contains('ready'), station()?.className);
q('#progression-view .progress-picker [data-select="workbench"]').click();
check('workbench node has no missing counts', qa('[data-node="workbench"] .progress-count.missing').length === 0);
check('workbench node says placement is free', (q('[data-node="workbench"]')?.innerText ?? '').includes('placement is free'), q('[data-node="workbench"]')?.innerText);
q('#progression-view .progress-picker [data-select="upgrade-power-2"]').click();
check('power 2 prerequisite missing', q('.progress-prerequisite')?.classList.contains('missing'));
g.laserLevels.power = 1; g.ui.refreshCraft();
check('power 2 prerequisite ready after power 1', q('.progress-prerequisite')?.classList.contains('ready'));
q('#progression-view .progress-picker [data-select="turret"]').click();
const tree = () => q('[data-node="turret"] [data-node="metal"]');
check('metal branch shows iron', tree()?.querySelectorAll('[data-node="iron"]').length === 1);
check('metal branch shows coal', tree()?.querySelectorAll('[data-node="coal"]').length === 1);
const ironTitle = tree()?.querySelector('[data-node="iron"] > .progress-node-title')?.innerText ?? '';
check('iron amount shown', ironTitle.includes('need 4'), ironTitle);
check('iron marked missing', tree()?.querySelectorAll('[data-node="iron"] .missing').length === 1);
tree().querySelector('[data-alternative="metal"][data-index="1"]').click();
check('alternative switches iron to copper', tree()?.querySelectorAll('[data-node="copper"]').length === 1 && tree()?.querySelectorAll('[data-node="iron"]').length === 0);
q('[data-node="turret"] > .progress-branches > [data-node="wood"] [data-select="wood"]').click();
check('wood source hint', q('#progression-view').innerText.includes('Gather wood from trees'));
q('#progression-view .progress-picker [data-select="turret"]').click();
q('#progression-view [data-place-workbench]').click();
check('Place Workbench opens architect placement', g.architect.open && g.architect.tool === 'place' && g.architect.placeId === 'workbench' && !g.ui.craftOpen,
  [g.architect.open, g.architect.tool, g.architect.placeId, g.ui.craftOpen]);
g.architect.exit(false);
