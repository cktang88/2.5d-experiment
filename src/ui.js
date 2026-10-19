// DOM HUD: health, clock, resources, hotbar, crafting panel, toasts and floating numbers.
import * as THREE from 'three';
import { icon } from './sprites.js';

const $ = (id) => document.getElementById(id);
const _p = new THREE.Vector3();

export class UI {
  constructor(game) {
    this.game = game;
    this.floats = [];
    this.cache = {};
    this.buildHotbar();
    this.buildResources();
    this.buildCraft();
  }

  buildHotbar() {
    const hb = $('hotbar');
    hb.innerHTML = '';
    this.slots = this.game.hotbar.map((s, i) => {
      const el = document.createElement('div');
      el.className = 'slot';
      el.innerHTML = `<span class="key">${(i + 1) % 10}</span><img src="${icon(s.icon)}"><span class="cnt"></span><span class="name">${s.name}</span>`;
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
      this.resEls[k] = el.querySelector('span');
    }
    const med = document.createElement('div');
    med.className = 'res';
    med.innerHTML = `<img src="${icon('medkit')}"><span>0</span><em>H</em>`;
    r.appendChild(med);
    this.resEls.medkit = med.querySelector('span');
  }

  buildCraft() {
    const list = $('craftlist');
    list.innerHTML = '';
    this.craftEls = this.game.recipes.map((rc, i) => {
      const el = document.createElement('button');
      el.className = 'recipe';
      const cost = Object.entries(rc.cost).map(([k, v]) => `<span class="cost"><img src="${icon(k)}">${v}</span>`).join('');
      el.innerHTML = `<img class="ri" src="${icon(rc.icon)}"><div class="rn">${rc.name}<div class="rd">${rc.desc}</div></div><div class="rc">${cost}</div>`;
      el.onclick = (e) => { e.stopPropagation(); this.game.craft(i); };
      list.appendChild(el);
      return el;
    });
  }

  toggleCraft(force) {
    const el = $('craft');
    const show = force ?? el.classList.contains('hidden');
    el.classList.toggle('hidden', !show);
    this.craftOpen = show;
    this.refreshCraft();
  }
  refreshCraft() {
    if (!this.craftOpen) return;
    this.game.recipes.forEach((rc, i) => this.craftEls[i].classList.toggle('off', !this.game.canAfford(rc.cost)));
  }

  set(key, val, fn) { if (this.cache[key] !== val) { this.cache[key] = val; fn(val); } }

  update(dt) {
    const g = this.game, inv = g.inv, p = g.entities.player;
    const hp = Math.max(0, Math.round(p.hp));
    this.set('hp', hp, v => { $('hpfill').style.width = (v / p.maxHp * 100) + '%'; $('hptext').textContent = v + ' / ' + p.maxHp; });
    for (const k in this.resEls) this.set('r' + k, inv[k] | 0, v => { this.resEls[k].textContent = v; });
    g.hotbar.forEach((s, i) => {
      const n = s.ammo ? (inv[s.ammo] | 0) : '∞';
      this.set('s' + i, n + (i === g.sel ? '*' : ''), () => {
        this.slots[i].querySelector('.cnt').textContent = n;
        this.slots[i].classList.toggle('sel', i === g.sel);
        this.slots[i].classList.toggle('empty', n === 0);
      });
    });
    const t = g.time;
    const hours = Math.floor(t * 24), mins = Math.floor((t * 24 - hours) * 60 / 10) * 10;
    const label = g.isNight() ? '☾ Night ' + g.nightCount : '☀ Day ' + (g.nightCount + 1);
    this.set('clock', label + hours + mins, () => { $('clock').textContent = `${label} · ${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`; });
    // objective line with a countdown to the next phase
    const secs = Math.ceil(g.timeToSwitch());
    const mm = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
    let obj;
    if (g.won) obj = 'Endless mode: survive as long as you can';
    else if (g.boss && !g.boss.dead) obj = `Kill the Brood Mother (${Math.max(0, Math.ceil(g.boss.hp))} HP)`;
    else if (g.isNight()) obj = `Survive the night: dawn in ${mm}`;
    else if (g.nightCount === 0) obj = `Gather and build walls: night falls in ${mm}`;
    else if (g.nightCount === 2) obj = `Prepare: night 3 brings something big, in ${mm}`;
    else obj = `Reinforce your base: night ${g.nightCount + 1} in ${mm}`;
    this.set('obj', obj, v => { $('objective').textContent = v; });
    const alive = g.entities.enemies.length;
    this.set('stats', g.kills + '|' + alive, () => { $('stats').textContent = `Kills ${g.kills} · Hostiles ${alive}`; });
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

  floatText(x, y, z, text, color) {
    if (this.floats.length > 60) return;
    const el = document.createElement('div');
    el.className = 'float';
    el.textContent = text;
    el.style.color = color;
    $('floats').appendChild(el);
    this.floats.push({ el, x: x + (Math.random() - 0.5) * 0.4, y, z, t: 0 });
  }

  toast(msg, cls = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + cls;
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3200);
    while ($('toasts').children.length > 5) $('toasts').firstChild.remove();
  }

  showUpgrades(list, onPick) {
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

  banner(msg) {
    const el = $('banner');
    el.textContent = msg;
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  }
}
