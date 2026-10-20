// Foliage atlas: 8 crossed-card decor tiles (3 grass tufts, 3 flowers, a mushroom, a fern) as smooth
// vector drawings. The mesher maps tile t to u in [t/8, (t+1)/8], v 0 (ground) .. 1 (top), so the atlas
// is one row of square tiles; every tile keeps a transparent margin at its sides so trilinear sampling
// never pulls colour from the neighbouring tile.
import * as THREE from 'three';
import { Pen, canvas, get2d, bake, ellipse, blob, curve, mix, shade } from './draw';

const T = 128;          // px per tile
const K = T / 16;       // drawn in a 16-unit space (ground at y = 16)
const LEAF_INK = '#3e6a32'; // a deep green rather than black: ground cover should not out-shout the characters

/** a tapered, curving grass blade from a base point to a tip, filled with a base-to-tip gradient */
function blade(pen: Pen, x: number, h: number, lean: number, w: number, dark: string, lit: string): void {
  const c = pen.ctx, tipX = x + lean, tipY = 16 - h;
  const p = new Path2D();
  p.moveTo(x - w / 2, 16.4);
  p.quadraticCurveTo(x - w * 0.4 + lean * 0.25, 16 - h * 0.55, tipX, tipY);
  p.quadraticCurveTo(x + w * 0.4 + lean * 0.45, 16 - h * 0.5, x + w / 2, 16.4);
  p.closePath();
  const g = c.createLinearGradient(0, 16, 0, tipY);
  g.addColorStop(0, dark); g.addColorStop(1, lit);
  c.fillStyle = g; c.fill(p);
  c.lineWidth = 0.24; c.strokeStyle = LEAF_INK; c.lineJoin = 'round'; c.stroke(p);
  // a lit midrib on the sunny side
  pen.line(curve([[x - w * 0.1, 15.6], [x + lean * 0.3 - w * 0.12, 16 - h * 0.5], [tipX - lean * 0.08, tipY + h * 0.12]]), w * 0.18, mix(lit, '#fffbd8', 0.35));
}

function tuft(pen: Pen, n: number, seed: number, hMin: number, hMax: number): void {
  let s = seed;
  const r = (): number => ((s = (s * 16807) % 2147483647) / 2147483647);
  // (bright: the cards sit in their own and their neighbours' shadow, and in SSAO, so they render a good
  // deal darker than drawn; these keep tufts reading as light strokes over the ground's grass colour)
  const greens: [string, string][] = [['#6aac48', '#c8f088'], ['#76b852', '#d6f89a'], ['#62a440', '#bce67c'], ['#7cc058', '#e2fca8']];
  // back blades darker, front blades brighter: drawn back to front
  const blades: { x: number; h: number; l: number; w: number; k: number }[] = [];
  for (let i = 0; i < n; i++) {
    const x = 3.2 + r() * 9.6;
    blades.push({ x, h: hMin + r() * (hMax - hMin), l: (x - 8) * 0.45 + (r() - 0.5) * 3, w: 1.5 + r() * 0.8, k: i });
  }
  blades.sort((a, b) => b.h - a.h);
  for (const b of blades) {
    const [d, l] = greens[b.k % 4], f = b.k / n;
    blade(pen, b.x, b.h, b.l, b.w, mix(d, '#2a4a20', 0.18 * (1 - f)), l);
  }
}

function flower(pen: Pen, petal: string, centre: string, seed: number): void {
  // leaves and stems
  blade(pen, 5.0, 5.5, -2.2, 1.6, '#4a8a34', '#9ad064');
  blade(pen, 11.2, 4.8, 2.2, 1.6, '#4a8a34', '#9ad064');
  const heads: [number, number, number][] = [[8.2, 3.6, 1.0], [4.0, 8.2, 0.7], [12.4, 9.0, 0.66]];
  for (const [hx, hy] of heads) { // inked stems
    const stem = curve([[8 + (hx - 8) * 0.2, 16.2], [hx + (8 - hx) * 0.2, (hy + 16) / 2], [hx, hy + 0.6]]);
    pen.line(stem, 0.62, LEAF_INK); pen.line(stem, 0.36, '#5a9a3a');
  }
  heads.forEach(([hx, hy, s], i) => {
    const n = 5, R = 1.55 * s, rot = seed + i * 0.7;
    for (let k = 0; k < n; k++) {
      const a = rot + (k / n) * Math.PI * 2, px = hx + Math.cos(a) * R, py = hy + Math.sin(a) * R * 0.85;
      pen.shape(ellipse(px, py, 1.25 * s, 0.95 * s, a), petal, { shade: shade(petal, 0.22), light: mix(petal, '#ffffff', 0.45), sd: 0.45 * s, ld: 0.3 * s, lw: 0.26, ink: mix(petal, '#2a1420', 0.7) });
    }
    pen.shape(ellipse(hx, hy, 0.95 * s, 0.85 * s), centre, { shade: shade(centre, 0.35), sd: 0.4, lw: 0.24, ink: '#5a3a10' });
  });
}

function mushroom(pen: Pen): void {
  // a small one behind, a big toadstool in front
  pen.shape(blob([[11.4, 16.3], [11.5, 12.6], [12.6, 12.5], [12.7, 16.3]], 0.6), '#efe4d0', { sd: 0.4, lw: 0.3 });
  pen.shape(blob([[9.8, 12.9], [12.0, 10.6], [14.4, 12.9], [12.1, 13.5]], 0.9), '#c8904a', { sd: 0.5, lw: 0.3 });
  const stem = blob([[6.6, 16.4], [6.9, 10.0], [8.9, 9.8], [9.5, 16.4]], 0.6);
  pen.shape(stem, '#f2e8d4', { shade: '#cbb898', sd: 0.7, lw: 0.34 });
  pen.fill(ellipse(8.0, 11.0, 2.2, 0.6), 'rgba(80,40,30,0.35)'); // shadow under the cap
  const cap = blob([[2.6, 10.4], [4.0, 6.2], [8.0, 4.4], [12.2, 6.2], [13.4, 10.4], [8.0, 11.4]], 0.95);
  pen.shape(cap, '#d8402e', { shade: '#9a2a2a', light: '#ff7a5a', sd: 1.1, ld: 0.5, lw: 0.36 });
  for (const [x, y, r] of [[5.4, 7.6, 0.8], [8.6, 6.0, 0.95], [11.2, 8.4, 0.7], [7.2, 9.4, 0.5], [10.0, 9.8, 0.45]]) pen.shape(ellipse(x, y, r, r * 0.85), '#fff6ea', { shade: '#e0cdbc', light: null, sd: 0.25, lw: 0.2 });
}

function fern(pen: Pen): void {
  const fronds: [number, number, number][] = [[8.0, 13.2, 0.1], [7.6, 10.4, -1.1], [8.4, 10.8, 1.1]];
  fronds.sort((a, b) => a[1] - b[1]);
  for (const [bx, len, bend] of fronds) {
    // the rachis curves outward and droops; leaflets taper toward the tip, alternating sides
    const pts: [number, number][] = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      pts.push([bx + bend * len * 0.55 * t * t + Math.sign(bend) * t * 0.6, 16.2 - len * t + (Math.abs(bend) > 0.5 ? t * t * len * 0.28 : 0)]);
    }
    for (let i = 1; i < 10; i++) {
      const [x, y] = pts[i], t = i / 10, L = 2.6 * (1 - t * 0.75), [nx, ny] = pts[i + 1];
      const dx = nx - x, dy = ny - y, d = Math.hypot(dx, dy) || 1, ax = dx / d, ay = dy / d;
      for (const s of [-1, 1]) {
        const ex = x + (-ay * s) * L + ax * L * 0.45, ey = y + (ax * s) * L + ay * L * 0.45;
        const leaf = blob([[x, y], [(x + ex) / 2 - ay * s * 0.1 + ax * 0.5, (y + ey) / 2 + ax * s * 0.1 + ay * 0.5], [ex, ey], [(x + ex) / 2 - ax * 0.3, (y + ey) / 2 - ay * 0.3]], 0.9);
        pen.shape(leaf, s > 0 ? '#5a9c3c' : '#4a8a32', { shade: '#2e6224', light: '#9ed266', sd: 0.4, ld: 0.2, lw: 0.24, ink: LEAF_INK });
      }
    }
    pen.line(curve(pts), 0.42, LEAF_INK);
    pen.line(curve(pts), 0.22, '#7ab84a');
  }
}

export function makeFoliageAtlas(): THREE.DataTexture {
  const c = canvas(T * 8, T), ctx = get2d(c);
  const tile = (t: number, draw: (pen: Pen) => void): void => {
    ctx.save(); ctx.setTransform(K, 0, 0, K, t * T, 0);
    ctx.beginPath(); ctx.rect(0.35, -1, 15.3, 18); ctx.clip(); // side margins: no bleed between tiles
    draw(new Pen(ctx, 0.3));
    ctx.restore();
  };
  tile(0, p => tuft(p, 7, 11, 4.0, 8.0));
  tile(1, p => tuft(p, 9, 23, 5.0, 10.5));
  tile(2, p => tuft(p, 11, 37, 6.0, 13.0));
  tile(3, p => flower(p, '#ff5a6e', '#ffe08a', 0.3));
  tile(4, p => flower(p, '#ffd23a', '#c86a20', 1.1));
  tile(5, p => flower(p, '#7ab8ff', '#fff4c0', 0.7));
  tile(6, mushroom);
  tile(7, fern);
  return bake(c, { flipY: true, alphaTest: true, levels: 6 });
}
