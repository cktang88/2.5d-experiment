import type { Game, Recipe } from './main';
import { LASER_UPGRADE_RECIPES, type LaserUpgradeId } from './laserUpgrade';

type Callbacks = { placeWorkbench: () => void; selectRecipe?: (index: number) => void };
type Entry = { key: string; name: string; cost: Readonly<Record<string, number>>; yield: number; station?: boolean; recipeIndex?: number; previous?: string };
const sources: Record<string, string> = {
  wood: 'Gather wood from trees.', stone: 'Mine stone from the ground.', goo: 'Collect goo from monsters.',
  iron: 'Mine iron ore underground.', copper: 'Mine copper ore underground.', coal: 'Mine coal ore underground.',
};
const label = (s: string) => ({ ammo: 'SMG Rounds', turret: 'Auto Turret', cannonTurret: 'Heavy cannon', twinTurret: 'Twin cannon', rocketTurret: 'Rocket battery', artilleryTurret: 'Artillery' } as Record<string, string>)[s] ?? s.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** A cached, interactive guide to the actual recipes and their upstream ingredients. */
export function createProgression(container: HTMLElement, game: Game, callbacks: Callbacks): { refresh: () => void } {
  const recipes: Entry[] = game.recipes.flatMap((r: Recipe, i: number) => Object.entries(r.give).map(([key, n]) => ({ key, name: r.name, cost: r.cost, yield: n, station: r.station, recipeIndex: i })));
  for (const id of ['power', 'reach'] as LaserUpgradeId[]) for (const u of LASER_UPGRADE_RECIPES[id]) recipes.push({ key: `upgrade-${id}-${u.level}`, name: u.name, cost: u.cost, yield: 1, station: true, previous: u.level > 1 ? `upgrade-${id}-${u.level - 1}` : undefined });
  recipes.push({ key: 'workbench', name: 'Workbench', cost: { planks: 1 }, yield: 1 });
  const options = [...new Set(recipes.map(r => r.key))];
  const alternatives: Record<string, number> = {};
  let selected = 'turret';
  let path = [selected];
  let last = '';
  const byKey = (key: string) => recipes.filter(r => r.key === key);
  const recipe = (key: string) => byKey(key)[alternatives[key] ?? 0];
  const heading = (key: string) => key === 'workbench' ? 'Workbench' : key.startsWith('upgrade-') ? byKey(key)[0].name : label(key);
  const renderNode = (key: string, amount: number, depth: number, guideOnly = false): string => {
    const r = recipe(key), available = game.inv[key] || 0, missing = Math.max(0, amount - available);
    const count = guideOnly ? `<span class="progress-count">Recipe guide · not required for free placement</span>` : key.startsWith('upgrade-') || key === 'workbench' ? '' : `<span class="progress-count ${missing ? 'missing' : 'ready'}">${available} / ${amount} available${missing ? ` · missing ${missing}` : ''}</span>`;
    let detail = sources[key] ? `<p class="progress-source">${sources[key]}</p>` : '';
    if (r && depth < 5) {
      const batches = Math.ceil(amount / r.yield);
      const choices = byKey(key);
      const alternative = choices.length > 1 ? `<div class="progress-alternatives">Choose a recipe: ${choices.map((choice, i) => `<button type="button" data-alternative="${esc(key)}" data-index="${i}" aria-pressed="${(alternatives[key] ?? 0) === i}">${esc(choice.name)}</button>`).join('')}</div>` : '';
      const inputs = Object.entries(r.cost).map(([ingredient, cost]) => renderNode(ingredient, cost * batches, depth + 1, guideOnly || (key === 'workbench' && (game.sandbox || game.freeBuild)))).join('');
      const previousId = r.previous?.split('-')[1] as LaserUpgradeId | undefined;
      const previousMet = previousId ? game.laserLevels[previousId] >= 1 : false;
      const previous = r.previous ? `<div class="progress-prerequisite ${previousMet ? 'ready' : 'missing'}">${previousMet ? '✓ Installed' : '✕ Required'}: <button type="button" data-select="${r.previous}">${esc(heading(r.previous))}</button></div>` : '';
      const nearWorkbench = game.construction.nearWorkbench();
      const station = r.station ? `<div class="progress-station ${nearWorkbench ? 'ready' : 'missing'}">${nearWorkbench ? '✓ Workbench nearby' : '✕ Workbench required nearby'} <button type="button" data-place-workbench>Place Workbench</button> <button type="button" data-select="workbench">See how to build</button></div>` : '';
      const workbench = key === 'workbench' ? `<p class="progress-source">${game.sandbox || game.freeBuild ? 'Workbench placement is free. The branch below is a recipe guide. ' : ''}The workbench normally uses one selected building block: 1 plank or 1 brick. Place Workbench selects planks.</p><button type="button" data-place-workbench>Place Workbench</button>` : '';
      detail += `${alternative}<p class="progress-formula">${esc(r.name)} · ${batches} ${batches === 1 ? 'craft' : 'crafts'} produces ${batches * r.yield}</p>${previous}${station}${workbench}<div class="progress-branches">${inputs}</div>`;
    }
    return `<div class="progress-node" data-node="${esc(key)}"><div class="progress-node-title"><button type="button" data-select="${esc(key)}">${esc(heading(key))}</button><span>need ${amount}</span>${count}</div>${detail}</div>`;
  };
  const refresh = () => {
    const r = recipe(selected);
    const free = game.sandbox || game.freeBuild ? `<p class="progress-banner">${game.sandbox ? 'Sandbox: placement is free. ' : ''}${game.freeBuild ? 'Free construction is on. ' : ''}Crafting and laser upgrades still use their listed ingredients.</p>` : '';
    const html = `<style>
      .progression { color:#e6e0d2; font-size:16px; line-height:1.4 } .progression h2,.progression p { margin:0 0 8px } .progression button { cursor:pointer; color:inherit; background:#28313a; border:1px solid #62717b; border-radius:4px; padding:6px 10px; font:inherit } .progression button:hover,.progression button[aria-pressed=true] { border-color:#efb35e; color:#ffe3ae } .progress-picker { display:flex; flex-wrap:wrap; gap:5px; margin:8px 0 12px } .progress-banner,.progress-station { background:#333226; border-left:3px solid #e1af61; padding:7px; margin:7px 0 } .progress-path { color:#aeb8b8; margin:8px 0 } .progress-node { border:1px solid #52616a; border-radius:5px; background:#18212a; padding:8px; margin:6px 0 } .progress-node-title { display:flex; flex-wrap:wrap; align-items:center; gap:7px; font-weight:bold } .progress-node-title button { font-weight:bold } .progress-count { margin-left:auto; font-weight:normal } .progress-count.missing,.progress-station.missing,.progress-prerequisite.missing { color:#ff8585; border-color:#ff8585 } .progress-count.ready,.progress-station.ready,.progress-prerequisite.ready { color:#9de0a4; border-color:#9de0a4 } .progress-formula,.progress-source { color:#b9c5c8; margin:7px 0 0!important } .progress-branches { border-left:2px solid #72808a; margin:7px 0 0 7px; padding-left:12px } .progress-alternatives { margin-top:7px } .progress-alternatives button { margin:2px } .progress-prerequisite { margin-top:7px }
    </style><div class="progression"><h2>Progression</h2><p>Choose an item to follow its ingredients back to their sources. Select any ingredient to explore it.</p>${free}<div class="progress-picker">${options.map(k => `<button type="button" data-select="${esc(k)}" aria-pressed="${k === selected}">${esc(heading(k))}</button>`).join('')}</div><div class="progress-path">${path.map(k => esc(heading(k))).join(' → ')}</div>${renderNode(selected, 1, 0)}${r?.recipeIndex !== undefined && callbacks.selectRecipe ? `<button type="button" data-craft-recipe="${r.recipeIndex}">Open crafting recipe</button>` : ''}</div>`;
    if (html !== last) { last = html; container.innerHTML = html; }
  };
  container.addEventListener('click', e => {
    const target = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!target) return;
    if (target.dataset.select) { selected = target.dataset.select; path = [...path, selected].slice(-5); last = ''; refresh(); }
    else if (target.dataset.alternative) { alternatives[target.dataset.alternative] = Number(target.dataset.index); last = ''; refresh(); }
    else if (target.hasAttribute('data-place-workbench')) callbacks.placeWorkbench();
    else if (target.dataset.craftRecipe !== undefined) callbacks.selectRecipe?.(Number(target.dataset.craftRecipe));
  });
  refresh();
  return { refresh };
}
