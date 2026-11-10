import { TRAPS, type TrapId } from './traps';
import { createProgression } from './progression';
import { JETPACK_MAX_ALTITUDE } from './jetpack';
import { DEFENSES, getDefense, type DefenseId } from './defenses';
// DOM HUD: health, clock, resources, hotbar, crafting panel, toasts and floating numbers.
import * as THREE from 'three';
import { icon } from './sprites';
import type { Game } from './main';
import { getNextLaserUpgradeRecipe, laserUpgradeStats, type LaserUpgradeId } from './laserUpgrade';
import type { ForageFood } from './foraging';

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const _p = new THREE.Vector3();

export interface UpgradeInfo { name: string; desc: string; icon: string; apply?: (...args: never[]) => unknown; }

interface FloatEntry { el: HTMLElement; x: number; y: number; z: number; t: number; }


export class UI {
  game: Game;
  floats: FloatEntry[];
  cache: Record<string, unknown>;
  slots!: HTMLElement[];
  resEls!: Record<string, HTMLElement>;
  craftEls!: HTMLElement[];
  craftOpen = false;
  private defensePickerHTML = '';
  private foodHTML = '';
  private laserHTML = '';
  private progression?: ReturnType<typeof createProgression>;
  constructor(game: Game) {
    this.game = game;
    this.floats = [];
    this.cache = {};
    this.buildHotbar();
    this.buildResources();
    this.buildCraft();
    document.querySelectorAll<HTMLButtonElement>('[data-craft-tab]').forEach(button => button.addEventListener('click', () => {
      const tab = button.dataset.craftTab;
      document.querySelectorAll<HTMLButtonElement>('[data-craft-tab]').forEach(b => b.setAttribute('aria-selected', String(b === button)));
      document.querySelectorAll<HTMLElement>('[data-craft-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.craftPanel !== tab));
      if (tab === 'progression' && !this.progression) this.progression = createProgression($('progression-view'), this.game, {
        placeWorkbench: () => $('craft-workbench').click(),
        selectRecipe: index => { document.querySelector<HTMLButtonElement>('[data-craft-tab="craft"]')!.click(); this.craftEls[index]?.scrollIntoView({ block: 'nearest' }); },
      });
      this.refreshCraft();
    }));
  }

  buildHotbar() {
    const hb = $('hotbar');
    hb.innerHTML = '';
    this.slots = this.game.hotbar.map((s, i) => {
      const el = document.createElement('div');
      el.className = 'slot'; el.id = `tool-${s.id}`;
      const label = s.tool === 'cutter' ? 'F' : String((i + 1) % 10);
      el.innerHTML = `<span class="key">${label}</span><img src="${icon(s.icon)}"><span class="cnt"></span><span class="name">${s.name}</span>`;
      el.onclick = () => this.game.select(i);
      hb.appendChild(el);
      return el;
    });
  }

  buildResources() {
    const r = $('res');
    r.innerHTML = '';
    this.resEls = {};
    for (const k of ['wood', 'stone', 'metal', 'goo']) {
      const el = document.createElement('div');
      el.className = 'res';
      el.innerHTML = `<img src="${icon(k)}"><span>0</span>`;
      r.appendChild(el);
      this.resEls[k] = el.querySelector('span') as HTMLElement;
    }
    const med = document.createElement('div');
    med.className = 'res';
    med.innerHTML = `<img src="${icon('medkit')}"><span>0</span><em>H</em>`;
    r.appendChild(med);
    this.resEls.medkit = med.querySelector('span') as HTMLElement;
  }

  buildCraft() {
    const list = $('craftlist');
    list.innerHTML = '';
    this.craftEls = this.game.recipes.map((rc, i) => {
      const el = document.createElement('button');
      el.className = 'recipe';
      el.innerHTML = `<img class="ri" src="${icon(rc.icon)}" alt=""><div class="rn"><strong>${rc.name}</strong><div class="rd">${rc.desc}</div><div class="rc"></div><span class="requirement"></span></div>`;
      el.onclick = (e) => { e.stopPropagation(); this.game.craft(i); };
      list.appendChild(el);
      return el;
    });
  }

  toggleCraft(force?: boolean): void {
    const el = $('craft');
    const show = force ?? el.classList.contains('hidden');
    el.classList.toggle('hidden', !show);
    this.craftOpen = show;
    if (show) this.game.hideAiming();
    this.refreshCraft();
  }
  refreshCraft() {
    if (!this.craftOpen) return;
    const g = this.game;
    if (!$('progression-view').parentElement!.classList.contains('hidden')) this.progression?.refresh();
    const picker = $('defense-picker');
    const pickerHTML = Object.values(DEFENSES).map(entry => {
      const d = getDefense(entry.id);
      const shots = d.id === 'rocket' ? 4 : d.id === 'twin' ? 2 : 1;
      const strength = shots > 1 ? `${shots}×${d.damage} salvo` : `${d.damage} damage`;
      const range = `${d.minRange ? `${d.minRange}–` : ''}${d.range} m`;
      return `<button class="btn" data-defense="${d.id}" ${!g.trapId && g.defenseId === d.id ? 'aria-pressed="true"' : ''}>${d.name} · ${g.inv[d.inventoryKey] | 0} owned<br>${d.footprint[0]}×${d.footprint[1]} · ${range} · ${d.reload}s · ${strength}</button>`;
    }).join(' ');
    const trapHTML = Object.values(TRAPS).map(t => `<button class="btn" data-trap="${t.id}" ${g.trapId === t.id ? 'aria-pressed="true"' : ''}>${t.name} · ${g.inv[t.inventoryKey] | 0} owned</button>`).join(' ');
    if ($('trap-picker').innerHTML !== trapHTML) { $('trap-picker').innerHTML=trapHTML; $('trap-picker').querySelectorAll<HTMLButtonElement>('[data-trap]').forEach(b => b.onclick=()=>{g.selectTrap(b.dataset.trap as TrapId); this.refreshCraft();}); }
    if (this.defensePickerHTML !== pickerHTML) {
      this.defensePickerHTML = pickerHTML;
      picker.innerHTML = pickerHTML;
      picker.querySelectorAll<HTMLButtonElement>('[data-defense]').forEach(b => b.onclick = () => { g.selectDefense(b.dataset.defense as DefenseId); this.refreshCraft(); });
    }
    const foods: ForageFood[] = ['apple', 'berries', 'meat'];
    const foodHTML = `<h2>Food · J quick eat</h2><p>Heals over time at 2 HP/s</p>` + foods.map(food => `<button class="btn" data-food="${food}">Eat ${food} · ${g.inv[food] | 0}</button>`).join(' ');
    if (this.foodHTML !== foodHTML) {
      this.foodHTML = foodHTML;
      $('food-controls').innerHTML = foodHTML;
      $('food-controls').querySelectorAll<HTMLButtonElement>('[data-food]').forEach(b => b.onclick = () => { g.eatFood(b.dataset.food as ForageFood); this.refreshCraft(); });
    }
    const minerals = `Underground: Iron ${g.inv.iron | 0} · Copper ${g.inv.copper | 0} · Coal ${g.inv.coal | 0}`;
    if ($('ore-inventory').textContent !== minerals) $('ore-inventory').textContent = minerals;
    const stats = laserUpgradeStats(g.laserLevels);
    const laserHTML = (['power', 'reach'] as LaserUpgradeId[]).map(id => {
      const recipe = getNextLaserUpgradeRecipe(id, g.laserLevels);
      const current = id === 'power' ? `${8 * stats.damageMultiplier} HP/s` : `${stats.range} m`;
      const next = id === 'power' ? `${8 * (stats.damageMultiplier + .25)} HP/s` : `${stats.range + 4} m`;
      const cost = recipe ? Object.entries(recipe.cost).map(([k,v]) => {
        const owned = g.inv[k] | 0;
        return `<span class="cost ${owned < v ? 'missing' : ''}"><img src="${icon(k)}" alt="">${k} ${owned}/${v}${owned < v ? ` · need ${v - owned}` : ''}</span>`;
      }).join(' ') : 'Max level';
      const station = !g.construction.nearWorkbench();
      return `<button class="btn" data-upgrade="${id}" ${recipe ? '' : 'disabled'}>${id === 'power' ? 'Power' : 'Range'} ${g.laserLevels[id]}/2 · ${current}${recipe ? ` → ${next}<span class="upgrade-costs">${cost}</span><span class="requirement ${station ? 'missing' : ''}">${station ? 'Requires nearby workbench' : 'Workbench nearby'}</span>` : ' · MAX'}</button>`;
    }).join(' ');
    if (this.laserHTML !== laserHTML) {
      this.laserHTML = laserHTML;
      $('laser-upgrades').innerHTML = laserHTML;
      $('laser-upgrades').querySelectorAll<HTMLButtonElement>('[data-upgrade]').forEach(b => b.onclick = () => g.upgradeLaser(b.dataset.upgrade as LaserUpgradeId));
    }
    const nearBench = g.construction.nearWorkbench();
    this.game.recipes.forEach((rc, i) => {
      const el = this.craftEls[i];
      el.classList.toggle('off', !g.canAfford(rc.cost) || (!!rc.station && !nearBench));
      const costs = Object.entries(rc.cost).map(([k, v]) => {
        const owned = g.inv[k] | 0, missing = owned < v;
        return `<span class="cost ${missing ? 'missing' : ''}"><img src="${icon(k)}" alt="">${k} ${owned}/${v}${missing ? ` · need ${v - owned}` : ''}</span>`;
      }).join('');
      const costEl = el.querySelector('.rc')!;
      if (costEl.innerHTML !== costs) costEl.innerHTML = costs;
      const requirement = el.querySelector('.requirement')!;
      requirement.textContent = rc.station ? (nearBench ? 'Workbench nearby' : 'Requires nearby workbench · use Place Workbench above') : '';
      requirement.classList.toggle('missing', !!rc.station && !nearBench);
    });
  }

  set<T>(key: string, val: T, fn: (v: T) => void): void { if (this.cache[key] !== val) { this.cache[key] = val; fn(val); } }

  // last values written to the DOM, so unchanged HUD elements are never touched
  private lastHp = -1; private lastMaxHp = -1;
  private lastRegen = '';
  private lastFlight = '';
  private lastRes: Record<string, number> = {};
  private lastSlot: string[] = [];
  private lastClock = -1; private lastObj = ''; private lastKills = -1; private lastAlive = -1;
  private lastSecs = -1; private lastPhase = '';

  update(dt: number): void {
    const g = this.game, inv = g.inv, p = g.entities.player;
    const hp = Math.max(0, Math.round(p.hp));
    if (hp !== this.lastHp || p.maxHp !== this.lastMaxHp) {
      this.lastHp = hp; this.lastMaxHp = p.maxHp;
      $('hpfill').style.width = (hp / p.maxHp * 100) + '%'; $('hptext').textContent = hp + ' / ' + p.maxHp;
    }
    const regen = p.regenerationStatus;
    if (regen !== this.lastRegen) { this.lastRegen = regen; $('regen-status').textContent = regen; }
    const foodStatus = `Food · Apple ${inv.apple | 0} · Berries ${inv.berries | 0} · Meat ${inv.meat | 0} · J eat`;
    if ($('food-status').textContent !== foodStatus) $('food-status').textContent = foodStatus;
    const glow = `Glowsticks ${inv.glowstick | 0} · L throw`;
    if ($('glowstick-status').textContent !== glow) $('glowstick-status').textContent = glow;
    const flight = g.jetpack.active ? `Flight · ${p.flightAltitude === null ? 'on' : `${Math.floor(p.flightAltitude)} / ${JETPACK_MAX_ALTITUDE} m`}` : 'Flight · ready';
    if (flight !== this.lastFlight) { this.lastFlight = flight; $('flight-status').textContent = flight; }
    for (const k in this.resEls) {
      const v = inv[k] | 0;
      if (this.lastRes[k] !== v) { this.lastRes[k] = v; this.resEls[k].textContent = String(v); }
    }
    for (let i = 0; i < g.hotbar.length; i++) {
      const s = g.hotbar[i];
      const n = s.ammo ? (inv[s.ammo] | 0) : -1;
      const key = (i === g.sel ? n + '*' : String(n)) + s.name;
      if (this.lastSlot[i] === key) continue;
      this.lastSlot[i] = key;
      (this.slots[i].querySelector('.name') as HTMLElement).textContent = s.name;
      (this.slots[i].querySelector('.cnt') as HTMLElement).textContent = n < 0 ? '∞' : String(n);
      this.slots[i].classList.toggle('sel', i === g.sel);
      this.slots[i].classList.toggle('empty', n === 0);
    }
    const t = g.time, night = g.isNight();
    const hours = Math.floor(t * 24), mins = Math.floor((t * 24 - hours) * 60 / 10) * 10;
    const clockKey = ((g.nightCount * 2 + (night ? 1 : 0)) * 24 + hours) * 60 + mins;
    if (clockKey !== this.lastClock) {
      this.lastClock = clockKey;
      const label = night ? '☾ Night' : '☀ Day';
      $('clock').textContent = `${label} · ${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
    }
    // objective line with a countdown to the next phase
    const wave = g.waveDirector;
    const secs = Math.ceil(wave.remaining);
    let phase: string;
    if (g.won) phase = 'Endless mode: survive as long as you can';
    else if (g.boss && !g.boss.dead) phase = `Kill the Brood Mother (${Math.max(0, Math.ceil(g.boss.hp))} HP)`;
    else if (wave.phase === 'safe') phase = 'safe';
    else if (wave.phase === 'rest') phase = 'rest';
    else phase = `wave:${wave.wave}:${g.entities.enemies.reduce((n, e) => n + (!e.dead ? 1 : 0), 0)}`;
    if (secs !== this.lastSecs || phase !== this.lastPhase) {
      this.lastSecs = secs; this.lastPhase = phase;
      const mm = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
      let obj = phase;
      if (phase === 'safe') obj = `Wave 1 in ${mm}`;
      else if (phase.startsWith('wave:')) obj = `Wave ${wave.wave} · ${phase.split(':')[2]} remaining · ${wave.fronts.map(front => front[0].toUpperCase()).join('/')}`;
      else if (phase === 'rest') obj = `Wave ${wave.wave + 1} in ${mm}`;
      if (obj !== this.lastObj) { this.lastObj = obj; $('objective').textContent = obj; }
    }
    const early = $('start-wave-early') as HTMLButtonElement;
    const canStartEarly = (wave.phase === 'safe' || wave.phase === 'rest') && !g.paused && !p.dead && !g.construction.panelOpen && !g.ui.craftOpen && !g.minimap.bigOpen && !g.explore && !g.modalOpen();
    early.classList.toggle('hidden', wave.phase !== 'safe' && wave.phase !== 'rest');
    early.disabled = !canStartEarly;
    if (canStartEarly) {
      const bonus = Math.round(Math.min(0.5, Math.max(0, wave.remaining / 120) * 0.5) * 100);
      const next = wave.wave + 1;
      early.textContent = `T · Start early +${bonus}%`;
      const extra = [6, 6, 4, 2].map(n => Math.round(n * next * bonus / 100));
      early.title = `On wave ${next} clear: ${6 * next + extra[0]} wood, ${6 * next + extra[1]} stone, ${4 * next + extra[2]} metal and ${2 * next + extra[3]} goo.`;
    }
    const alive = g.entities.enemies.length;
    if (g.kills !== this.lastKills || alive !== this.lastAlive) {
      this.lastKills = g.kills; this.lastAlive = alive;
      $('stats').textContent = `Kills ${g.kills} · Hostiles ${alive}`;
    }
    if (this.craftOpen) this.refreshCraft();
    // floating numbers
    const cam = g.camera, W = innerWidth, H = innerHeight;
    for (let i = 0; i < this.floats.length; i++) {
      const f = this.floats[i];
      f.t += dt;
      f.y += dt * 1.4;
      _p.set(f.x, f.y, f.z).project(cam);
      if (f.t > 0.9 || _p.z > 1) { f.el.remove(); this.floats.splice(i, 1); i--; continue; }
      f.el.style.transform = `translate(${(_p.x * 0.5 + 0.5) * W}px, ${(-_p.y * 0.5 + 0.5) * H}px) translate(-50%,-50%) scale(${1 + Math.max(0, 0.15 - f.t) * 4})`;
      f.el.style.opacity = String(Math.min(1, (0.9 - f.t) * 4));
    }
  }

  floatText(x: number, y: number, z: number, text: string, color: string): void {
    if (this.floats.length > 60) return;
    const el = document.createElement('div');
    el.className = 'float';
    el.textContent = text;
    el.style.color = color;
    $('floats').appendChild(el);
    this.floats.push({ el, x: x + (Math.random() - 0.5) * 0.4, y, z, t: 0 });
  }

  toast(msg: string, cls = ''): void {
    const el = document.createElement('div');
    el.className = 'toast ' + cls;
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3200);
    while ($('toasts').children.length > 2) ($('toasts').firstChild as ChildNode).remove();
  }

  showUpgrades<U extends UpgradeInfo>(list: U[], onPick: (u: U) => void): void {
    const el = $('upgrade'), box = $('uplist');
    box.innerHTML = '';
    list.forEach((u) => {
      const b = document.createElement('button');
      b.className = 'recipe up';
      b.innerHTML = `<img class="ri" src="${icon(u.icon)}"><div class="rn">${u.name}<div class="rd">${u.desc}</div></div>`;
      b.onclick = (e) => { e.stopPropagation(); el.classList.add('hidden'); onPick(u); };
      box.appendChild(b);
    });
    el.classList.remove('hidden');
  }

  banner(msg: string): void {
    const el = $('banner');
    el.textContent = msg;
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  }
}
