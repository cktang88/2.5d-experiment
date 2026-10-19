// Procedural pixel art: character sprite sheets, foliage atlas and UI icons.
// Everything is drawn into canvases at runtime, so there are no image assets.
import * as THREE from 'three';

type Ctx = CanvasRenderingContext2D;
type RGB = [number, number, number];
type PxFn = (x: number, y: number, w: number, h: number, col: string) => void;

export interface Palette {
  skin: string; skinDark: string; eye: string; hair: string;
  shirt: string; shirtLight: string; shirtDark: string; belt: string;
  pants: string; pantsDark: string; boots: string;
  cape?: string; capeDark?: string; accent?: string;
  hat?: string; hatBand?: string;
}

function canvas(w: number, h: number): HTMLCanvasElement { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

function get2d(c: HTMLCanvasElement): Ctx {
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  return ctx;
}

function px(ctx: Ctx, x: number, y: number, w: number, h: number, col: string): void { ctx.fillStyle = col; ctx.fillRect(x | 0, y | 0, w | 0, h | 0); }

function ellipse(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, col: string): void {
  ctx.fillStyle = col;
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) ctx.fillRect(x, y, 1, 1);
    }
}

// add a 1px dark outline around opaque pixels inside a region
function outline(ctx: Ctx, x0: number, y0: number, w: number, h: number, col: RGB = [24, 18, 28]): void {
  const img = ctx.getImageData(x0, y0, w, h);
  const d = img.data, src = new Uint8ClampedArray(d);
  const A = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : src[(y * w + x) * 4 + 3];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = (y * w + x) * 4;
    if (src[k + 3] > 0) continue;
    if (A(x + 1, y) || A(x - 1, y) || A(x, y + 1) || A(x, y - 1)) {
      d[k] = col[0]; d[k + 1] = col[1]; d[k + 2] = col[2]; d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, x0, y0);
}

function toTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------- humanoids ----------------
// view: 0 front, 1 back, 2 side (facing right). frame 0..3 walk cycle.
function drawHumanoid(ctx: Ctx, ox: number, oy: number, view: number, frame: number, pal: Palette, kind: string): void {
  const bob = (frame === 1 || frame === 3) ? 1 : 0;
  const P = (x: number, y: number, w: number, h: number, c: string): void => px(ctx, ox + x, oy + y + (y < 23 ? bob : 0), w, h, c);
  const zombie = kind === 'zombie';
  const hunch = zombie && view === 2 ? 1 : 0;
  // legs
  const legY = 23, legH = 7;
  if (view === 2) {
    const sw = [0, 2, 0, -2][frame];
    px(ctx, ox + 14 - sw, oy + legY, 3, legH, pal.pantsDark);
    px(ctx, ox + 14 - sw, oy + legY + legH - 2, 4, 2, pal.boots);
    px(ctx, ox + 15 + sw, oy + legY, 3, legH, pal.pants);
    px(ctx, ox + 15 + sw, oy + legY + legH - 2, 4, 2, pal.boots);
  } else {
    const l = frame === 1 ? -1 : 0, r = frame === 3 ? -1 : 0;
    px(ctx, ox + 12, oy + legY, 3, legH + l, pal.pants);
    px(ctx, ox + 12, oy + legY + legH - 2 + l, 3, 2, pal.boots);
    px(ctx, ox + 17, oy + legY, 3, legH + r, pal.pants);
    px(ctx, ox + 17, oy + legY + legH - 2 + r, 3, 2, pal.boots);
  }
  // cape behind (player)
  if (pal.cape && view !== 0) {
    if (view === 1) P(10, 14, 12, 11, pal.cape);
    else P(10, 14, 4, 10, pal.capeDark!);
  }
  // torso
  P(11 + hunch, 14, 10, 10, pal.shirt);
  P(11 + hunch, 14, 10, 2, pal.shirtLight);
  P(11 + hunch, 21, 10, 1, pal.belt);
  if (zombie) { P(13, 18, 2, 2, pal.skin); P(18, 16, 1, 3, pal.skinDark); P(12, 22, 3, 2, pal.skinDark); }
  if (pal.cape && view === 0) { P(10, 14, 2, 9, pal.cape); P(20, 14, 2, 9, pal.cape); P(14, 14, 4, 2, pal.accent!); }
  if (pal.cape && view === 1) P(10, 14, 12, 10, pal.cape);
  // arms
  const sw = [0, 1, 0, -1][frame];
  if (view === 2) {
    if (zombie) { P(16 + hunch, 15, 8, 3, pal.skin); P(23 + hunch, 15, 1, 3, pal.skinDark); }
    else { P(15 + sw, 15, 3, 7, pal.shirtDark); P(15 + sw, 21, 3, 2, pal.skin); }
  } else if (zombie && view === 0) {
    P(9, 14, 2, 4, pal.skin); P(21, 14, 2, 4, pal.skin);
  } else {
    P(9, 15 + sw, 2, 7, pal.shirtDark); P(9, 21 + sw, 2, 2, pal.skin);
    P(21, 15 - sw, 2, 7, pal.shirtDark); P(21, 21 - sw, 2, 2, pal.skin);
  }
  // head
  const hx = 11 + hunch * 2;
  P(hx, 5, 10, 9, pal.skin);
  P(hx, 12, 10, 2, pal.skinDark);
  if (view === 0) {
    P(hx + 2, 9, 2, 2, pal.eye); P(hx + 6, 9, 2, 2, pal.eye);
    if (!zombie) P(hx + 4, 12, 2, 1, pal.skinDark);
    else P(hx + 3, 12, 4, 1, '#3a1a1a');
  } else if (view === 2) {
    P(hx + 7, 9, 2, 2, pal.eye);
    P(hx + 9, 10, 1, 2, pal.skinDark);
  }
  // hair / hat
  if (pal.hat) {
    if (view === 1) { P(hx - 1, 4, 12, 7, pal.hair); }
    else if (view === 2) { P(hx - 1, 5, 6, 5, pal.hair); }
    else { P(hx, 5, 10, 3, pal.hair); }
    P(hx - 3, 4, 16, 2, pal.hat);
    P(hx, 0, 10, 4, pal.hat);
    P(hx, 3, 10, 1, pal.hatBand!);
  } else {
    if (view === 1) P(hx, 4, 10, 8, pal.hair);
    else if (view === 2) P(hx, 4, 6, 5, pal.hair);
    else { P(hx, 4, 10, 3, pal.hair); P(hx, 4, 2, 5, pal.hair); }
    if (zombie) { P(hx + 1, 3, 2, 1, pal.hair); P(hx + 6, 3, 3, 1, pal.hair); }
  }
}

const PLAYER_PAL: Palette = {
  skin: '#f2c9a0', skinDark: '#d39c78', eye: '#2a2440', hair: '#5a3826',
  shirt: '#e8e0c8', shirtLight: '#fffbe8', shirtDark: '#c4b898', belt: '#6a4024',
  pants: '#3e4a6a', pantsDark: '#2c3550', boots: '#4a2e1e',
  cape: '#2f8f8a', capeDark: '#21706c', accent: '#f0c040',
  hat: '#8a5a32', hatBand: '#c04838',
};
const ZOMBIE_PALS: Palette[] = [
  { skin: '#8fb07a', skinDark: '#6a8a5a', eye: '#ff4a3a', hair: '#3a3428', shirt: '#5a6e8a', shirtLight: '#6a80a0', shirtDark: '#465670', belt: '#3a2a20', pants: '#5a4a3a', pantsDark: '#463a2e', boots: '#2e2420' },
  { skin: '#a0b884', skinDark: '#7a9064', eye: '#ffaa20', hair: '#6a2a1a', shirt: '#8a4a3a', shirtLight: '#a05a48', shirtDark: '#6a382c', belt: '#2a2a2a', pants: '#3a4a3a', pantsDark: '#2e3a2e', boots: '#242424' },
  { skin: '#7a9a8a', skinDark: '#5a7a6a', eye: '#ff3aa0', hair: '#c8c0a8', shirt: '#6a6a5a', shirtLight: '#808070', shirtDark: '#505044', belt: '#4a3020', pants: '#4a3a5a', pantsDark: '#3a2e48', boots: '#2a2030' },
];

function humanoidSheet(pal: Palette, kind: string): THREE.CanvasTexture {
  const c = canvas(128, 96), ctx = get2d(c);
  for (let v = 0; v < 3; v++) for (let f = 0; f < 4; f++) {
    drawHumanoid(ctx, f * 32, v * 32, v, f, pal, kind);
    outline(ctx, f * 32, v * 32, 32, 32);
  }
  return toTexture(c);
}

// ---------------- bugs ----------------
function drawBug(ctx: Ctx, ox: number, oy: number, frame: number, kind: string): void {
  const spitter = kind === 'spitter';
  const body = spitter ? '#5a3a6a' : '#3a2a48';
  const shell = spitter ? '#7a4a8a' : '#6a3a5a';
  const legC = '#2a1e30';
  const legPh = frame % 2;
  // legs
  for (let i = 0; i < 4; i++) {
    const lx = ox + 9 + i * 4;
    const up = (i + legPh) % 2 ? 1 : 0;
    px(ctx, lx, oy + 22 - up, 1, 4, legC);
    px(ctx, lx - 1, oy + 25 - up, 1, 4 + up, legC);
    px(ctx, lx + 1, oy + 20, 1, 2, legC);
  }
  if (spitter) {
    ellipse(ctx, ox + 12, oy + 16, 8, 7, '#4fbf3a');
    ellipse(ctx, ox + 11, oy + 14, 5, 4, '#8aff5a');
    ellipse(ctx, ox + 10, oy + 13, 2, 1.5, '#d8ffb0');
    ellipse(ctx, ox + 21, oy + 20, 5, 4, body);
    ellipse(ctx, ox + 25, oy + 19, 3, 3, shell);
    px(ctx, ox + 26, oy + 18, 2, 1, '#ffe040');
    px(ctx, ox + 28, oy + 20, 2, 1, '#ff8a20');
  } else {
    ellipse(ctx, ox + 14, oy + 19, 8, 5, body);
    ellipse(ctx, ox + 13, oy + 17, 7, 3.5, shell);
    px(ctx, ox + 9, oy + 16, 6, 1, '#9a5a7a');
    ellipse(ctx, ox + 23, oy + 20, 3.5, 3, body);
    px(ctx, ox + 24, oy + 19, 2, 1, '#ff3a3a');
    px(ctx, ox + 26, oy + 18, 1, 1, '#ff3a3a');
    // mandibles
    px(ctx, ox + 26, oy + 22, 2, 1, '#c8b090');
  }
}
function bugSheet(kind: string): THREE.CanvasTexture {
  const c = canvas(128, 96), ctx = get2d(c);
  for (let v = 0; v < 3; v++) for (let f = 0; f < 4; f++) {
    drawBug(ctx, f * 32, v * 32, f, kind);
    outline(ctx, f * 32, v * 32, 32, 32);
  }
  return toTexture(c);
}

function drawBat(ctx: Ctx, ox: number, oy: number, frame: number): void {
  const body = '#3a2440', wing = '#5a3a6a', wingD = '#2a1830';
  const up = [0, -4, -6, -3][frame];
  // wings
  for (let i = 0; i < 9; i++) {
    const h = Math.round(up * (i / 9));
    px(ctx, ox + 6 + i, oy + 15 + h - (i % 3 === 0 ? 1 : 0), 1, 3 + (i % 3), i % 3 === 0 ? wingD : wing);
    px(ctx, ox + 26 - i, oy + 15 + h - (i % 3 === 0 ? 1 : 0), 1, 3 + (i % 3), i % 3 === 0 ? wingD : wing);
  }
  ellipse(ctx, ox + 16, oy + 17, 3.5, 4, body);
  px(ctx, ox + 14, oy + 12, 1, 2, body); px(ctx, ox + 18, oy + 12, 1, 2, body);
  px(ctx, ox + 14, oy + 16, 1, 1, '#ff4a4a'); px(ctx, ox + 17, oy + 16, 1, 1, '#ff4a4a');
  px(ctx, ox + 15, oy + 19, 2, 1, '#e8e0d0');
}
function batSheet(): THREE.CanvasTexture {
  const c = canvas(128, 96), ctx = get2d(c);
  for (let v = 0; v < 3; v++) for (let f = 0; f < 4; f++) { drawBat(ctx, f * 32, v * 32, f); outline(ctx, f * 32, v * 32, 32, 32); }
  return toTexture(c);
}

export type Sheets = ReturnType<typeof makeSheets>;
export function makeSheets() {
  return {
    brute: humanoidSheet({ skin: '#8a9a6a', skinDark: '#5a6a48', eye: '#ffdd30', hair: '#2a2420', shirt: '#4a3a30', shirtLight: '#5a4a3a', shirtDark: '#3a2c24', belt: '#7a6a5a', pants: '#3a3a44', pantsDark: '#2a2a32', boots: '#1e1e22' }, 'zombie'),
    bat: batSheet(),
    player: humanoidSheet(PLAYER_PAL, 'player'),
    zombies: ZOMBIE_PALS.map(p => humanoidSheet(p, 'zombie')),
    crawler: bugSheet('crawler'),
    spitter: bugSheet('spitter'),
  };
}

// ---------------- foliage atlas: 8 tiles of 16x16 ----------------
export function makeFoliageAtlas(): THREE.CanvasTexture {
  const c = canvas(128, 16), ctx = get2d(c);
  const blade = (ox: number, x: number, h: number, col: string, lean = 0): void => {
    for (let i = 0; i < h; i++) px(ctx, ox + x + Math.round(lean * i / h), 15 - i, 1, 1, col);
  };
  const greens = ['#5f9e3a', '#79b64a', '#9ad25e', '#4a8a30'];
  // 0-2 grass tufts
  for (let t = 0; t < 3; t++) {
    const ox = t * 16;
    for (let i = 0; i < 7 + t * 2; i++) {
      const x = 2 + ((i * 7 + t * 3) % 12);
      blade(ox, x, 5 + ((i * 5 + t) % (6 + t * 3)), greens[(i + t) % 4], ((i % 3) - 1) * 2);
    }
  }
  // 3-5 flowers
  const fc = [['#ff5a6a', '#ffd0d8'], ['#ffd23a', '#fff4b0'], ['#6aa8ff', '#d0e4ff']];
  for (let t = 0; t < 3; t++) {
    const ox = (3 + t) * 16;
    blade(ox, 4, 6, greens[0], -1); blade(ox, 11, 5, greens[1], 1);
    blade(ox, 8, 10, greens[3]);
    px(ctx, ox + 6, 3, 5, 3, fc[t][0]); px(ctx, ox + 7, 2, 3, 5, fc[t][0]); px(ctx, ox + 8, 4, 1, 1, fc[t][1]);
    px(ctx, ox + 3, 8, 3, 2, fc[t][0]); px(ctx, ox + 11, 9, 3, 2, fc[t][0]);
  }
  // 6 mushroom
  {
    const ox = 96;
    px(ctx, ox + 7, 9, 2, 7, '#efe4d0');
    px(ctx, ox + 3, 6, 10, 3, '#d0402e'); px(ctx, ox + 5, 4, 6, 2, '#d0402e');
    px(ctx, ox + 5, 6, 1, 1, '#fff'); px(ctx, ox + 9, 5, 1, 1, '#fff'); px(ctx, ox + 11, 7, 1, 1, '#fff');
    px(ctx, ox + 11, 12, 1, 4, '#efe4d0'); px(ctx, ox + 10, 11, 3, 1, '#c8a060');
  }
  // 7 fern
  {
    const ox = 112;
    for (let i = 0; i < 5; i++) {
      blade(ox, 8, 12 - i, greens[i % 4]);
      px(ctx, ox + 3 + i, 15 - (10 - i * 2), 4, 1, greens[(i + 1) % 4]);
      px(ctx, ox + 9, 15 - (11 - i * 2), 4, 1, greens[(i + 2) % 4]);
    }
  }
  for (const t of [3, 4, 5, 6]) outline(ctx, t * 16, 0, 16, 16, [52, 74, 40]);
  return toTexture(c);
}

// ---------------- UI icons (returned as data URLs) ----------------
const ICONS: Record<string, (P: PxFn) => void> = {
  pistol: (P) => { P(3, 6, 9, 3, '#5a5f6a'); P(3, 6, 9, 1, '#8a909c'); P(4, 9, 3, 4, '#6a4024'); P(11, 6, 2, 2, '#2a2a30'); },
  shotgun: (P) => { P(1, 6, 14, 2, '#4a4f58'); P(1, 8, 9, 1, '#3a3f48'); P(1, 9, 5, 3, '#8a5a32'); P(7, 8, 3, 2, '#6a4024'); },
  smg: (P) => { P(2, 5, 11, 4, '#4a505c'); P(2, 5, 11, 1, '#7a8090'); P(6, 9, 2, 5, '#2a2e36'); P(3, 9, 2, 3, '#4a505c'); P(13, 6, 2, 2, '#222'); },
  rocket: (P) => { P(1, 5, 14, 5, '#5a7a4a'); P(1, 5, 14, 1, '#7a9a6a'); P(13, 4, 2, 7, '#3a4a30'); P(5, 10, 2, 3, '#3a3a3a'); P(0, 6, 2, 3, '#e05a3a'); },
  grenade: (P) => { P(4, 5, 8, 9, '#5a7a3a'); P(5, 4, 6, 11, '#5a7a3a'); P(5, 6, 2, 2, '#8aaa5a'); P(6, 2, 4, 2, '#888'); P(10, 1, 3, 2, '#bbb'); },
  planks: (P) => { P(2, 2, 12, 12, '#c9955a'); P(2, 6, 12, 1, '#8a5a32'); P(2, 10, 12, 1, '#8a5a32'); P(6, 2, 1, 4, '#8a5a32'); P(10, 7, 1, 3, '#8a5a32'); },
  bricks: (P) => { P(2, 2, 12, 12, '#a8705a'); for (let y = 5; y < 14; y += 4) P(2, y, 12, 1, '#d0c8b8'); P(7, 2, 1, 3, '#d0c8b8'); P(4, 6, 1, 3, '#d0c8b8'); P(10, 6, 1, 3, '#d0c8b8'); P(7, 10, 1, 4, '#d0c8b8'); },
  tnt: (P) => { P(2, 3, 12, 11, '#d8443a'); P(2, 7, 12, 3, '#eee4d0'); P(4, 8, 1, 1, '#222'); P(7, 8, 2, 1, '#222'); P(11, 8, 1, 1, '#222'); P(7, 1, 1, 2, '#888'); P(8, 0, 1, 1, '#ffd23a'); },
  turret: (P) => { P(4, 10, 8, 4, '#5a6470'); P(5, 6, 6, 4, '#7a8a96'); P(10, 7, 5, 2, '#3a4048'); P(6, 7, 2, 1, '#ff5a3a'); },
  lantern: (P) => { P(5, 4, 6, 9, '#ffd27a'); P(6, 5, 4, 7, '#fff2c0'); P(4, 3, 8, 1, '#5a4030'); P(4, 13, 8, 1, '#5a4030'); P(7, 1, 2, 2, '#5a4030'); },
  wood: (P) => { P(2, 5, 12, 6, '#8a5a32'); P(2, 5, 12, 1, '#b88a55'); P(12, 5, 2, 6, '#d8b080'); P(13, 7, 1, 2, '#8a5a32'); },
  stone: (P) => { P(3, 5, 10, 8, '#9c9a94'); P(4, 4, 7, 1, '#b8b6b0'); P(5, 7, 2, 2, '#7a7872'); P(9, 10, 2, 1, '#7a7872'); },
  metal: (P) => { P(3, 6, 10, 6, '#8aa0b0'); P(3, 6, 10, 1, '#c8dce8'); P(4, 8, 8, 1, '#6a7a88'); P(11, 7, 1, 4, '#5a6a78'); },
  goo: (P) => { P(4, 6, 8, 8, '#5adf3a'); P(5, 4, 6, 2, '#5adf3a'); P(6, 3, 3, 1, '#5adf3a'); P(5, 6, 2, 2, '#d8ffb0'); },
  medkit: (P) => { P(2, 4, 12, 9, '#eee'); P(7, 5, 2, 7, '#e03a3a'); P(5, 7, 6, 3, '#e03a3a'); P(6, 2, 4, 2, '#888'); },
  ammo: (P) => { for (let i = 0; i < 3; i++) { P(3 + i * 4, 5, 3, 8, '#c8a040'); P(3 + i * 4, 3, 3, 2, '#b06a3a'); } },
  shells: (P) => { for (let i = 0; i < 3; i++) { P(3 + i * 4, 4, 3, 7, '#d04030'); P(3 + i * 4, 11, 3, 2, '#d8b040'); } },
  pick: (P) => { P(7, 4, 2, 11, '#8a5a32'); P(2, 2, 12, 2, '#9aa4ac'); P(1, 3, 2, 2, '#9aa4ac'); P(13, 3, 2, 2, '#9aa4ac'); },
};
const iconCache: Record<string, string> = {};
export function icon(name: string): string {
  if (iconCache[name]) return iconCache[name];
  const c = canvas(16, 16), ctx = get2d(c);
  (ICONS[name] || ICONS.stone)((x, y, w, h, col) => px(ctx, x, y, w, h, col));
  outline(ctx, 0, 0, 16, 16);
  return (iconCache[name] = c.toDataURL());
}

// soft round texture for smoke & blob shadows
export function makeBlobTexture(): THREE.CanvasTexture {
  const c = canvas(64, 64), ctx = get2d(c);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(0.6, 'rgba(0,0,0,0.3)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------- voxel detail atlas: 4x4 tiles of 16x16 greyscale multipliers ----------------
// 128 = neutral; the world shader multiplies block colours by these to give pixel-art texture.
export const TILE = { GRASS: 0, DIRT: 1, STONE: 2, SAND: 3, BARK: 4, RINGS: 5, LEAVES: 6, PLANKS: 7, BRICK: 8, ORE: 9, CRATE: 10, TNT: 11, COBBLE: 12, ROOF: 13, METAL: 14, PLAIN: 15 } as const;
export function makeDetailAtlas(): THREE.CanvasTexture {
  const S = 16, c = canvas(S * 4, S * 4), ctx = get2d(c);
  const img = ctx.createImageData(S * 4, S * 4), d = img.data;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const tiles: Float32Array[] = [];
  const put = (t: number, x: number, y: number, v: number): void => { tiles[t][((y % S + S) % S) * S + ((x % S + S) % S)] = v; };
  for (let t = 0; t < 16; t++) tiles.push(new Float32Array(S * S).fill(128));
  const noise = (t: number, amp: number): void => { for (let i = 0; i < S * S; i++) tiles[t][i] += (rnd() - 0.5) * amp; };
  // grass: speckle + little blade marks
  noise(TILE.GRASS, 26);
  for (let i = 0; i < 22; i++) { const x = rnd() * S | 0, y = rnd() * S | 0; put(TILE.GRASS, x, y, 170); put(TILE.GRASS, x, y + 1, 150); }
  for (let i = 0; i < 10; i++) put(TILE.GRASS, rnd() * S | 0, rnd() * S | 0, 92);
  // dirt: pebbles
  noise(TILE.DIRT, 30);
  for (let i = 0; i < 9; i++) { const x = rnd() * S | 0, y = rnd() * S | 0; put(TILE.DIRT, x, y, 88); put(TILE.DIRT, x + 1, y, 96); put(TILE.DIRT, x, y - 1, 158); }
  // stone: blotches + cracks
  noise(TILE.STONE, 18);
  for (let i = 0; i < 5; i++) { const x0 = rnd() * S | 0, y0 = rnd() * S | 0, r = 2 + rnd() * 3; for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) if (x * x + y * y < r * r) put(TILE.STONE, x0 + x, y0 + y, tiles[TILE.STONE][((y0 + y + S) % S) * S + (x0 + x + S) % S] + 14); }
  for (let k = 0; k < 3; k++) { let x = rnd() * S | 0, y = rnd() * S | 0; for (let i = 0; i < 7; i++) { put(TILE.STONE, x, y, 78); x += rnd() < 0.5 ? 1 : 0; y += rnd() < 0.6 ? 1 : -1; } }
  // sand: fine speckle + ripples
  noise(TILE.SAND, 22);
  for (let x = 0; x < S; x++) { put(TILE.SAND, x, 4 + Math.round(Math.sin(x * 0.8)), 146); put(TILE.SAND, x, 11 + Math.round(Math.sin(x * 0.8 + 2)), 146); }
  // bark: vertical streaks
  for (let x = 0; x < S; x++) { const base = 128 + (rnd() - 0.5) * 50; for (let y = 0; y < S; y++) put(TILE.BARK, x, y, base + (rnd() - 0.5) * 16); }
  for (let x = 0; x < S; x += 4) for (let y = 0; y < S; y++) put(TILE.BARK, x + (rnd() < 0.2 ? 1 : 0), y, 86);
  // rings
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const r = Math.hypot(x - 7.5, y - 7.5); put(TILE.RINGS, x, y, r > 7 ? 90 : 128 + Math.sin(r * 2.2) * 18); }
  // leaves: clustered blobs
  noise(TILE.LEAVES, 20);
  for (let i = 0; i < 14; i++) { const x0 = rnd() * S | 0, y0 = rnd() * S | 0, v = rnd() < 0.5 ? 160 : 90; for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1], [-1, 0]]) put(TILE.LEAVES, x0 + dx, y0 + dy, v); }
  // planks: boards every 4px with seams and nails
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const board = y >> 2, off = (board * 5) % S;
    let v = 128 + Math.sin((x + off) * 0.9 + board) * 8 + (rnd() - 0.5) * 10;
    if (y % 4 === 3) v = 84;
    if ((x + off) % 16 === 0) v = 96;
    if ((x + off) % 16 === 2 && y % 4 === 1) v = 70;
    put(TILE.PLANKS, x, y, v);
  }
  // bricks: running bond with light mortar
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const row = y >> 2, off = row % 2 ? 4 : 0;
    const mortar = y % 4 === 3 || (x + off) % 8 === 7;
    put(TILE.BRICK, x, y, mortar ? 172 : 122 + (rnd() - 0.5) * 18 + (((x + off) >> 3) % 2) * 8);
  }
  // ore: stone + bright flecks
  tiles[TILE.ORE].set(tiles[TILE.STONE]);
  for (let i = 0; i < 7; i++) { const x = rnd() * S | 0, y = rnd() * S | 0; put(TILE.ORE, x, y, 250); put(TILE.ORE, x + 1, y, 210); put(TILE.ORE, x, y + 1, 190); }
  // crate: frame + diagonal brace
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let v = 124 + (rnd() - 0.5) * 12 + (y % 5 === 4 ? -22 : 0);
    if (x < 2 || y < 2 || x > 13 || y > 13) v = 150;
    if (Math.abs(x - y) < 1.5 && x > 1 && x < 14) v = 152;
    if ((x === 2 || x === 13 || y === 2 || y === 13) && x > 1 && y > 1 && x < 14 && y < 14) v = 90;
    put(TILE.CRATE, x, y, v);
  }
  // tnt: paper wrap with fuse-band + lettering hint
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) put(TILE.TNT, x, y, (y > 5 && y < 10) ? 200 + (x % 3 === 0 && y > 6 && y < 9 ? -120 : 0) : 120 + (x % 4 === 0 ? -16 : 0));
  // cobble: rounded stones
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) put(TILE.COBBLE, x, y, 90);
  for (const [cx, cy, r] of [[3, 3, 3], [10, 2, 3.2], [7, 8, 3.4], [2, 11, 2.8], [13, 9, 2.8], [11, 14, 2.5], [5, 15, 2]]) {
    for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) { const dd = Math.hypot(x, y); if (dd < r) put(TILE.COBBLE, cx + x, cy + y, 132 + (r - dd) * 6 - (y > 0 ? 8 : 0) + (rnd() - 0.5) * 10); }
  }
  // roof shingles
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const row = y >> 2, off = row % 2 ? 2 : 0, yy = y % 4;
    put(TILE.ROOF, x, y, (yy === 3 ? 82 : 128 + (2 - yy) * 10) + ((x + off) % 4 === 0 ? -26 : 0) + (rnd() - 0.5) * 8);
  }
  // metal panels with rivets
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let v = 132 - y * 1.2 + (rnd() - 0.5) * 6;
    if (x === 0 || y === 0) v = 165; if (x === 15 || y === 15) v = 92;
    if ((x === 2 || x === 13) && (y === 2 || y === 13)) v = 185;
    put(TILE.METAL, x, y, v);
  }
  noise(TILE.PLAIN, 14);
  for (let t = 0; t < 16; t++) {
    const ox = (t % 4) * S, oy = Math.floor(t / 4) * S;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const v = Math.max(0, Math.min(255, tiles[t][y * S + x])), k = ((oy + y) * S * 4 + ox + x) * 4;
      d[k] = d[k + 1] = d[k + 2] = v; d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false; tex.flipY = false;
  return tex;
}
