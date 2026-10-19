// Minimap: the terrain is pre-rendered once from the analytic world generator (so it covers
// chunks that haven't been generated yet), then landmarks, enemies and the player are drawn on top.
import { WATER_LEVEL } from './world';
import type { Game } from './main';

const SIZE = 168;      // css pixels
const RES = 256;       // terrain samples per side
const VIEW = 160;      // blocks shown across the map
const MARK: Record<string, string> = { castle: '#ffd25a', ruin: '#c8a27a', hut: '#e8e0c8', tower: '#a8d0ff', reservoir: '#5ac8ff' };

export class Minimap {
  game: Game;
  el: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  terrain: HTMLCanvasElement;
  t = 0;
  visible = true;

  constructor(game: Game) {
    this.game = game;
    this.el = document.getElementById('minimap') as HTMLCanvasElement;
    this.el.width = this.el.height = SIZE * 2;
    this.ctx = this.el.getContext('2d')!;
    this.terrain = document.createElement('canvas');
    this.terrain.width = this.terrain.height = RES;
    this.paintTerrain();
  }

  private paintTerrain(): void {
    const w = this.game.world, gen = w.gen;
    const ctx = this.terrain.getContext('2d')!;
    const img = ctx.createImageData(RES, RES);
    const sx = w.W / RES, sz = w.D / RES;
    for (let z = 0; z < RES; z++) for (let x = 0; x < RES; x++) {
      const h = gen.heightAt((x + 0.5) * sx, (z + 0.5) * sz);
      let r: number, g: number, b: number;
      if (h < WATER_LEVEL) { const d = Math.min(1, (WATER_LEVEL - h) / 4); r = 40 - d * 20; g = 110 - d * 40; b = 150 - d * 30; }
      else if (h < WATER_LEVEL + 1.2) { r = 222; g = 205; b = 150; }
      else if (h > 19) { const k = Math.min(1, (h - 19) / 12); r = 140 + k * 60; g = 138 + k * 60; b = 130 + k * 60; }
      else { const k = (h - WATER_LEVEL) / 14; r = 110 + k * 30; g = 170 - k * 25; b = 80 - k * 20; }
      // hill shading from the slope toward the light
      const s = gen.heightAt((x + 0.5) * sx - 2, (z + 0.5) * sz - 2) - h;
      const shade = Math.max(0.7, Math.min(1.25, 1 - s * 0.08));
      const k = (x + z * RES) * 4;
      img.data[k] = r * shade; img.data[k + 1] = g * shade; img.data[k + 2] = b * shade; img.data[k + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.classList.toggle('hidden', !this.visible);
  }

  update(dt: number): void {
    this.t -= dt;
    if (this.t > 0 || !this.visible) return;
    this.t = 0.2;
    const g = this.game, w = g.world, p = g.player.pos, ctx = this.ctx, S = SIZE * 2;
    const scale = S / VIEW; // canvas px per block
    const ox = p.x - VIEW / 2, oz = p.z - VIEW / 2;
    ctx.save();
    ctx.clearRect(0, 0, S, S);
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); ctx.clip();
    ctx.imageSmoothingEnabled = false;
    // terrain window (source rect in terrain-texture pixels)
    const k = RES / w.W;
    ctx.drawImage(this.terrain, ox * k, oz * k, VIEW * k, VIEW * k, 0, 0, S, S);
    const toMap = (x: number, z: number): [number, number] => [(x - ox) * scale, (z - oz) * scale];
    // landmarks
    for (const s of w.gen.sites) {
      const [mx, my] = toMap(s.x, s.z);
      if (mx < -10 || my < -10 || mx > S + 10 || my > S + 10) continue;
      ctx.fillStyle = MARK[s.kind]; ctx.strokeStyle = '#1c1622'; ctx.lineWidth = 3;
      const r = s.kind === 'castle' ? 9 : s.kind === 'ruin' ? 7 : 5;
      ctx.beginPath();
      if (s.kind === 'reservoir') ctx.arc(mx, my, r, 0, Math.PI * 2); else ctx.rect(mx - r, my - r, r * 2, r * 2);
      ctx.stroke(); ctx.fill();
    }
    // turrets and enemies
    for (const t of g.entities.turrets) { if (t.dead) continue; const [mx, my] = toMap(t.pos.x, t.pos.z); ctx.fillStyle = '#8af'; ctx.fillRect(mx - 3, my - 3, 6, 6); }
    for (const e of g.entities.enemies) {
      if (e.dead) continue;
      const [mx, my] = toMap(e.pos.x, e.pos.z);
      ctx.fillStyle = e.kind === 'boss' ? '#ff3aa0' : '#ff5a4a';
      const r = e.kind === 'boss' ? 7 : e.kind === 'brute' ? 4 : 3;
      ctx.beginPath(); ctx.arc(mx, my, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    // player arrow pointing where the camera faces (map stays north-up)
    const yaw = g.camYaw;
    ctx.save();
    ctx.translate(S / 2, S / 2); ctx.rotate(-yaw);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#1c1622'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, -12); ctx.lineTo(8, 9); ctx.lineTo(0, 4); ctx.lineTo(-8, 9); ctx.closePath();
    ctx.stroke(); ctx.fill();
    ctx.restore();
  }
}
