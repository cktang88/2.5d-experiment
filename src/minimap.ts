// Minimap: a 1-block-per-pixel terrain image around the player, rendered in a terrain worker from the
// analytic heightfield (sea by depth, beaches, grass and forest, rock, snow, hill shading and contours)
// and re-requested whenever the player strays far from its centre. Landmarks, turrets, enemies and
// the player are drawn on top. Clicking the minimap opens a world map of the whole island
// (rendered once, lazily, at 10 blocks per pixel) with every landmark; click again to close it.
import type { Game } from './main';

const SIZE = 168;      // css pixels
const VIEW = 192;      // blocks shown across the minimap
const RES = 512;       // terrain image size in pixels (= blocks)
const SNAP = 64;       // image origin snaps to this many blocks
const WORLD_STEP = 10; // blocks per world-map pixel
const MARK: Record<string, string> = { castle: '#ffd25a', ruin: '#c8a27a', hut: '#e8e0c8', tower: '#a8d0ff', reservoir: '#5ac8ff' };
type Img = ImageBitmap | HTMLCanvasElement;
interface MapReply { bmp?: ImageBitmap; img?: Uint8ClampedArray<ArrayBuffer>; sites?: { kind: string; x: number; z: number }[] }

// a worker reply as something drawImage accepts (ImageBitmap, or raw pixels where OffscreenCanvas is missing)
function toImage(r: MapReply, w: number, h: number): Img {
  if (r.bmp) return r.bmp;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d')!.putImageData(new ImageData(r.img!, w, h), 0, 0);
  return c;
}

export class Minimap {
  game: Game;
  el: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  terrain: Img | null = null;
  tx = 0; tz = 0; // world position of the terrain image's top-left pixel
  private want: [number, number] | null = null; // origin of the image being rendered
  t = 0;
  visible = true;
  // world map overlay
  big: HTMLCanvasElement;
  bigOpen = false;
  private world: Img | null = null;
  private worldSites: { kind: string; x: number; z: number }[] = [];
  private worldAsked = false;

  constructor(game: Game) {
    this.game = game;
    this.el = document.getElementById('minimap') as HTMLCanvasElement;
    this.el.width = this.el.height = SIZE * 2;
    this.ctx = this.el.getContext('2d')!;
    this.el.style.pointerEvents = 'auto'; this.el.style.cursor = 'pointer';
    this.el.title = 'World map';
    this.el.addEventListener('mousedown', (e) => { e.stopPropagation(); this.toggleWorld(); });
    this.big = document.createElement('canvas');
    this.big.width = this.big.height = 1024;
    Object.assign(this.big.style, {
      position: 'fixed', left: '50%', top: '50%', width: 'min(86vmin, 900px)', height: 'min(86vmin, 900px)', transform: 'translate(-50%, -50%)',
      border: '3px solid var(--edge-dim, #6a5a40)', borderRadius: '6px', background: '#14202e', pointerEvents: 'auto', cursor: 'pointer',
      boxShadow: '0 4px 0 rgba(0,0,0,0.4)', display: 'none', zIndex: '20', imageRendering: 'pixelated',
    });
    this.big.addEventListener('mousedown', (e) => { e.stopPropagation(); this.toggleWorld(false); });
    (document.getElementById('hud') ?? document.body).appendChild(this.big);
    const sp = game.world.gen.spawn;
    this.requestTerrain(sp.x, sp.z);
  }

  private requestTerrain(px: number, pz: number): void {
    const ox = Math.round((px - RES / 2) / SNAP) * SNAP, oz = Math.round((pz - RES / 2) / SNAP) * SNAP;
    if (this.want && this.want[0] === ox && this.want[1] === oz) return;
    this.want = [ox, oz];
    this.game.far.jobs.request({ type: 'map', id: 0, x0: ox, z0: oz, step: 1, w: RES, h: RES }, 5, (r: MapReply) => {
      if (this.terrain instanceof ImageBitmap) this.terrain.close();
      this.terrain = toImage(r, RES, RES); this.tx = ox; this.tz = oz;
      this.t = 0;
    }, 'minimap');
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.classList.toggle('hidden', !this.visible);
    if (!this.visible) this.toggleWorld(false);
  }

  toggleWorld(open = !this.bigOpen): void {
    this.bigOpen = open;
    this.big.style.display = open ? 'block' : 'none';
    if (open && !this.worldAsked) {
      this.worldAsked = true;
      const w = this.game.world, n = Math.ceil(w.W / WORLD_STEP);
      this.game.far.jobs.request({ type: 'map', id: 0, x0: 0, z0: 0, step: WORLD_STEP, w: n, h: n, sites: true }, 6, (r: MapReply) => {
        this.world = toImage(r, n, n); this.worldSites = r.sites ?? [];
        this.drawWorld();
      });
    }
    if (open) this.drawWorld();
  }

  private marker(ctx: CanvasRenderingContext2D, kind: string, mx: number, my: number, scale: number): void {
    ctx.fillStyle = MARK[kind] ?? '#fff'; ctx.strokeStyle = '#1c1622'; ctx.lineWidth = 3 * scale;
    const r = (kind === 'castle' ? 9 : kind === 'ruin' ? 7 : 5) * scale;
    ctx.beginPath();
    if (kind === 'reservoir') ctx.arc(mx, my, r, 0, Math.PI * 2); else ctx.rect(mx - r, my - r, r * 2, r * 2);
    ctx.stroke(); ctx.fill();
  }

  private arrow(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(-this.game.camYaw); ctx.scale(s, s);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#1c1622'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, -12); ctx.lineTo(8, 9); ctx.lineTo(0, 4); ctx.lineTo(-8, 9); ctx.closePath();
    ctx.stroke(); ctx.fill();
    ctx.restore();
  }

  private drawWorld(): void {
    const ctx = this.big.getContext('2d')!, S = this.big.width, w = this.game.world, k = S / w.W, p = this.game.player.pos;
    ctx.fillStyle = '#14202e'; ctx.fillRect(0, 0, S, S);
    if (!this.world) {
      ctx.fillStyle = '#e8e0c8'; ctx.font = '28px Silkscreen, monospace'; ctx.textAlign = 'center';
      ctx.fillText('charting the island...', S / 2, S / 2);
      return;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.world, 0, 0, S, S);
    for (const s of this.worldSites) this.marker(ctx, s.kind, s.x * k, s.z * k, s.kind === 'castle' ? 1 : 0.55);
    // the area the minimap shows, and the player
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 2;
    ctx.strokeRect((p.x - VIEW / 2) * k, (p.z - VIEW / 2) * k, VIEW * k, VIEW * k);
    this.arrow(ctx, p.x * k, p.z * k, 1.4);
    ctx.fillStyle = 'rgba(232,224,200,0.85)'; ctx.font = '20px Silkscreen, monospace'; ctx.textAlign = 'right';
    ctx.fillText('click to close', S - 14, S - 14);
  }

  update(dt: number): void {
    this.t -= dt;
    if (this.t > 0 || !this.visible) return;
    this.t = 0.2;
    const g = this.game, w = g.world, p = g.player.pos, ctx = this.ctx, S = SIZE * 2;
    // keep a full view's margin of rendered terrain around the player
    if (Math.max(Math.abs(p.x - (this.tx + RES / 2)), Math.abs(p.z - (this.tz + RES / 2))) > RES / 2 - VIEW || !this.terrain) this.requestTerrain(p.x, p.z);
    if (this.bigOpen) this.drawWorld();
    const scale = S / VIEW; // canvas px per block
    const ox = p.x - VIEW / 2, oz = p.z - VIEW / 2;
    ctx.save();
    ctx.fillStyle = '#1c2a3a'; ctx.fillRect(0, 0, S, S);
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); ctx.clip();
    ctx.imageSmoothingEnabled = false;
    // terrain window (source rect in image pixels = blocks)
    if (this.terrain) ctx.drawImage(this.terrain, ox - this.tx, oz - this.tz, VIEW, VIEW, 0, 0, S, S);
    const toMap = (x: number, z: number): [number, number] => [(x - ox) * scale, (z - oz) * scale];
    // landmarks
    for (const s of w.gen.sitesNear(p.x, p.z)) {
      const [mx, my] = toMap(s.x, s.z);
      if (mx < -10 || my < -10 || mx > S + 10 || my > S + 10) continue;
      this.marker(ctx, s.kind, mx, my, 1);
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
    this.arrow(ctx, S / 2, S / 2, 1);
  }
}
