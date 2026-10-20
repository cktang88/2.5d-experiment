// Voxel detail atlas: one smooth, painterly, seamlessly tiling greyscale tile per material. The world
// shader multiplies a face's colour by (0.55 + v * 0.9), so 128 is neutral. Tiles are painted in a float
// field with wrap-around brush dabs, periodic noise and periodic Voronoi cells, so every operation tiles.
//
// Atlas layout: 4 x 4 cells of CELL px; each holds a TILE px tile surrounded by a GUTTER of wrapped
// texels (the tile's own opposite edges), so bilinear filtering across a block edge reads the right
// neighbour. The mip chain stops at level MAX_LOD, where the gutter is still a full texel wide, so no
// level ever blends one material into the next.
import * as THREE from 'three';
import { canvas, get2d, bake } from './draw';

export const TILE = { GRASS: 0, DIRT: 1, STONE: 2, SAND: 3, BARK: 4, RINGS: 5, LEAVES: 6, PLANKS: 7, BRICK: 8, ORE: 9, CRATE: 10, TNT: 11, COBBLE: 12, ROOF: 13, METAL: 14, PLAIN: 15 } as const;

/** texels per block face */
export const DETAIL_TILE = 96;
/** wrapped border around each tile */
export const DETAIL_GUTTER = 16;
/** cell pitch in the atlas (tile + 2 gutters) */
export const DETAIL_CELL = DETAIL_TILE + DETAIL_GUTTER * 2;
/** atlas side (4 cells) */
export const DETAIL_SIZE = DETAIL_CELL * 4;
/** last mip level built (gutter 16 >> 4 = 1 texel there) */
const MAX_LOD = 4;

const T = DETAIL_TILE;
type Field = Float32Array;

// ---------------- painting primitives (all wrap around the tile) ----------------
let seed = 7;
const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const field = (v = 128): Field => new Float32Array(T * T).fill(v);
const wrap = (i: number): number => ((i % T) + T) % T;
const smooth = (t: number): number => t * t * (3 - 2 * t);
const sstep = (a: number, b: number, x: number): number => smooth(Math.min(1, Math.max(0, (x - a) / (b - a))));
/** shortest wrapped offset between two coordinates */
const wd = (a: number, b: number): number => { let d = a - b; d -= Math.round(d / T) * T; return d; };

/** periodic value noise: an nx x ny lattice of random values spanning the tile, quintic-interpolated */
function lattice(nx: number, ny: number): (x: number, y: number) => number {
  const g = new Float32Array(nx * ny);
  for (let i = 0; i < g.length; i++) g[i] = rnd() * 2 - 1;
  return (x, y) => {
    const fx = (x / T) * nx, fy = (y / T) * ny;
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const q = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
    const at = (i: number, j: number): number => g[(((j % ny) + ny) % ny) * nx + (((i % nx) + nx) % nx)];
    const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
    const u = q(tx), v = q(ty);
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
  };
}
/** fractal sum of periodic noise octaves (lattice doubles each octave so it stays periodic) */
function fbm(nx: number, ny: number, oct: number): (x: number, y: number) => number {
  const ls = Array.from({ length: oct }, (_, o) => lattice(nx << o, ny << o));
  return (x, y) => { let s = 0, a = 1, n = 0; for (const l of ls) { s += l(x, y) * a; n += a; a *= 0.5; } return s / n; };
}
function addNoise(f: Field, n: (x: number, y: number) => number, amp: number): void {
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) f[y * T + x] += n(x, y) * amp;
}
/**
 * Paint a soft elliptical brush dab: inside the ellipse the field is blended toward `val(lx, ly)`
 * (lx, ly in -1..1 along the dab's own axes), with a feathered edge. Strokes overlap like paint.
 */
function dab(f: Field, cx: number, cy: number, rx: number, ry: number, ang: number, val: (lx: number, ly: number, cur: number) => number, soft = 0.35, alpha = 1): void {
  const R = Math.ceil(Math.max(rx, ry)) + 1, ca = Math.cos(ang), sa = Math.sin(ang);
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const px = Math.round(cx) + dx, py = Math.round(cy) + dy;
    const ox = px - cx, oy = py - cy;
    const lx = (ox * ca + oy * sa) / rx, ly = (-ox * sa + oy * ca) / ry;
    const r = Math.hypot(lx, ly);
    if (r >= 1) continue;
    const a = alpha * sstep(1, 1 - soft, r);
    const k = wrap(py) * T + wrap(px);
    f[k] += (val(lx, ly, f[k]) - f[k]) * a;
  }
}
/** periodic Voronoi: for each texel the nearest / second-nearest site distances and the nearest site */
function voronoi(n: number, jitter = 0.8): { d1: Float32Array; d2: Float32Array; id: Int16Array; sx: number[]; sy: number[] } {
  const g = Math.ceil(Math.sqrt(n)), sx: number[] = [], sy: number[] = [];
  for (let j = 0; j < g; j++) for (let i = 0; i < g; i++) {
    sx.push(((i + 0.5 + (rnd() - 0.5) * jitter) / g) * T); sy.push(((j + 0.5 + (rnd() - 0.5) * jitter) / g) * T);
  }
  const d1 = new Float32Array(T * T), d2 = new Float32Array(T * T), id = new Int16Array(T * T);
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    let a = 1e9, b = 1e9, ai = 0;
    for (let s = 0; s < sx.length; s++) {
      const d = Math.hypot(wd(x, sx[s]), wd(y, sy[s]));
      if (d < a) { b = a; a = d; ai = s; } else if (d < b) b = d;
    }
    d1[y * T + x] = a; d2[y * T + x] = b; id[y * T + x] = ai;
  }
  return { d1, d2, id, sx, sy };
}
function normalize(f: Field, mean = 128): void {
  let s = 0; for (let i = 0; i < f.length; i++) s += f[i];
  const d = mean - s / f.length; for (let i = 0; i < f.length; i++) f[i] += d;
}
/** a small 3x3 blur pass (wrapping), to melt hard edges into a painted look */
function soften(f: Field, k = 1): void {
  for (let it = 0; it < k; it++) {
    const s = new Float32Array(f);
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      let a = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) a += s[wrap(y + j) * T + wrap(x + i)] * (i === 0 && j === 0 ? 4 : (i === 0 || j === 0) ? 2 : 1);
      f[y * T + x] = a / 16;
    }
  }
}
const each = (f: Field, fn: (x: number, y: number, v: number) => number): void => { for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) f[y * T + x] = fn(x, y, f[y * T + x]); };

/** dome-shaded pebble: lit top-left, shadowed bottom-right, with a soft cast shadow */
function pebble(f: Field, cx: number, cy: number, r: number, base: number, amp: number): void {
  dab(f, cx + r * 0.25, cy + r * 0.3, r * 1.05, r * 0.95, 0, (_x, _y, cur) => cur - amp * 0.9, 0.6, 0.7);
  dab(f, cx, cy, r, r * 0.85, rnd() * Math.PI, (lx, ly) => base + (-lx - ly) * amp * 0.5 + (1 - lx * lx - ly * ly) * amp * 0.3, 0.3);
}

// ---------------- the materials ----------------
function grass(): Field {
  const f = field(); addNoise(f, fbm(3, 3, 3), 18);
  // short painterly blade strokes, lights over darks, loosely combed in one direction
  for (let i = 0; i < 380; i++) {
    const amp = rnd() < 0.55 ? 26 + rnd() * 10 : -28, a = 0.5 + (rnd() - 0.5) * 1.2;
    dab(f, rnd() * T, rnd() * T, 1.0 + rnd() * 0.6, 3 + rnd() * 3.5, a, (_x, ly, cur) => cur + amp * (1 - ly * 0.4), 0.5, 0.8);
  }
  normalize(f); return f;
}
function dirt(): Field {
  const f = field(); addNoise(f, fbm(4, 4, 4), 26);
  for (let i = 0; i < 40; i++) dab(f, rnd() * T, rnd() * T, 1 + rnd() * 2, 0.8 + rnd() * 1.2, rnd() * 3, (_x, _y, cur) => cur - 14, 0.5, 0.8);
  for (let i = 0; i < 16; i++) pebble(f, rnd() * T, rnd() * T, 2.2 + rnd() * 3.2, 128 + (rnd() - 0.5) * 20, 26);
  normalize(f); return f;
}
function stone(): Field {
  const f = field(), v = voronoi(5, 0.95), n = fbm(4, 4, 4), m = fbm(3, 3, 2), cell = v.sx.map(() => (rnd() - 0.5) * 22);
  each(f, (x, y) => {
    const k = y * T + x, e = v.d2[k] - v.d1[k];
    // rough rock faces with a broken crack network: a noise mask fades parts of the cracks out, so it
    // reads as weathered stone rather than a flagstone grid repeating on every block
    const crack = (1 - sstep(0, 2.4, e)) * sstep(-0.15, 0.25, m(x, y));
    return 130 + cell[v.id[k]] * 0.7 + n(x, y) * 20 - 44 * crack + 8 * sstep(2.4, 5, e) * (1 - sstep(5, 9, e));
  });
  for (let i = 0; i < 26; i++) dab(f, rnd() * T, rnd() * T, 2 + rnd() * 5, 1 + rnd() * 2, rnd() * 3, (_x, _y, cur) => cur + (rnd() < 0.5 ? 9 : -9), 0.8, 0.6);
  soften(f); normalize(f); return f;
}
function sand(): Field {
  const f = field(), w = lattice(2, 2);
  addNoise(f, fbm(6, 6, 3), 9);
  // wind ripples: whole numbers of waves across the tile so they wrap
  each(f, (x, y, v) => v + Math.sin(((y / T) * 4 + w(x, y) * 0.25 + Math.sin((x / T) * Math.PI * 2) * 0.12) * Math.PI * 2) * 8);
  for (let i = 0; i < 70; i++) dab(f, rnd() * T, rnd() * T, 0.7 + rnd() * 0.6, 0.7 + rnd() * 0.6, 0, (_x, _y, cur) => cur + (rnd() < 0.5 ? 18 : -16), 0.5, 0.8);
  normalize(f); return f;
}
function bark(): Field {
  const f = field(), streak = fbm(10, 2, 3), wob = lattice(4, 3);
  // vertical fibres and deep wandering furrows
  each(f, (x, y) => {
    const u = x / T + wob(x, y) * 0.05;
    const fur = Math.abs(Math.sin(u * Math.PI * 5));
    return 132 + streak(x, y) * 26 - 54 * (1 - sstep(0.0, 0.32, fur)) + 10 * sstep(0.6, 1, fur);
  });
  for (let i = 0; i < 30; i++) dab(f, rnd() * T, rnd() * T, 0.8 + rnd(), 4 + rnd() * 6, (rnd() - 0.5) * 0.15, (_x, _y, cur) => cur + (rnd() < 0.5 ? 12 : -14), 0.6, 0.8);
  soften(f); return f;
}
function rings(): Field {
  const f = field(), n = fbm(3, 3, 3);
  each(f, (x, y) => {
    const r = Math.hypot(x - T / 2 + 0.5, y - T / 2 + 0.5) + n(x, y) * 3.5;
    const R = T * 0.47;
    if (r > R) return 92 + n(x * 3 % T, y) * 14; // bark rim
    return 138 + Math.sin(r * 0.62) * 13 * (0.6 + 0.4 * r / R) - (r > R - 3 ? 26 : 0) - 10 * (1 - sstep(0, 4, r));
  });
  // a couple of radial drying cracks
  for (let k = 0; k < 3; k++) {
    const a = rnd() * Math.PI * 2;
    for (let s = 6; s < T * 0.4; s += 0.8) dab(f, T / 2 + Math.cos(a + s * 0.01) * s, T / 2 + Math.sin(a + s * 0.01) * s, 0.9, 0.9, 0, (_x, _y, cur) => cur - 20, 0.5, 0.6);
  }
  soften(f); return f;
}
function leaves(): Field {
  const f = field(84); addNoise(f, fbm(3, 3, 3), 14);
  // clumps of overlapping pointed leaves over deep shadowy gaps: each leaf drops a soft shadow down and
  // to the right, then is painted lit on its upper half with a darker midrib; back to front, so later
  // leaves overlap earlier ones like brush strokes
  for (let i = 0; i < 120; i++) {
    const base = 138 + (rnd() - 0.5) * 40, a = rnd() * Math.PI, x = rnd() * T, y = rnd() * T;
    const rx = 4.5 + rnd() * 3.5, ry = 2.2 + rnd() * 1.4;
    dab(f, x + 1.6, y + 2.0, rx * 1.05, ry * 1.2, a, (_x, _y, cur) => cur - 26, 0.7, 0.6);
    dab(f, x, y, rx, ry, a, (lx, ly) => base - ly * 24 - lx * lx * 14 + (Math.abs(ly) < 0.1 ? -14 : 0), 0.25);
  }
  normalize(f); return f;
}
function planks(): Field {
  const f = field(), grain = fbm(2, 12, 3), wav = lattice(3, 4);
  const BH = T / 4;
  const joint = [0.62, 0.15, 0.85, 0.4].map(j => j * T), tone = [0, 8, -6, 4];
  each(f, (x, y) => {
    const b = Math.floor(y / BH), ly = y - b * BH;
    let v = 130 + tone[b] + grain(x, y) * 12 + Math.sin((ly / BH) * Math.PI * 3 + wav(x, y) * 3 + x * 0.02) * 6;
    v += 12 * (1 - sstep(1.5, 4, ly)) - 16 * sstep(BH - 5, BH - 1.5, ly); // bevelled board edges
    v -= 52 * (1 - sstep(0, 1.6, Math.min(ly, BH - ly))); // seam
    const jd = Math.abs(wd(x, joint[b]));
    v -= 46 * (1 - sstep(0.5, 1.8, jd)); v += 10 * sstep(1.8, 3, jd) * (1 - sstep(3, 5, jd)) * (wd(x, joint[b]) > 0 ? 1 : -1);
    return v;
  });
  for (let b = 0; b < 4; b++) for (const s of [-1, 1]) { // nails either side of each end joint
    const nx = joint[b] + s * 4.5, ny = b * BH + BH / 2 + (s > 0 ? -4 : 4);
    dab(f, nx + 0.6, ny + 0.6, 2.0, 2.0, 0, (_x, _y, cur) => cur - 30, 0.5);
    dab(f, nx, ny, 1.5, 1.5, 0, (lx, ly) => 150 - (lx + ly) * 30, 0.3);
  }
  // a knot or two
  for (let k = 0; k < 2; k++) { const kx = rnd() * T, ky = (Math.floor(rnd() * 4) + 0.5) * BH; dab(f, kx, ky, 4.5, 2.6, 0, (lx, ly) => 100 + Math.sin(Math.hypot(lx, ly) * 9) * 12, 0.5); }
  soften(f); return f;
}
function bricks(): Field {
  const f = field(), n = fbm(4, 4, 3), CH = T / 4, BW = T / 2, M = 2.2;
  const tone = Array.from({ length: 16 }, () => (rnd() - 0.5) * 22);
  each(f, (x, y) => {
    const row = Math.floor(y / CH), off = row % 2 ? BW / 2 : 0;
    const bx = wrap(x + off), col = Math.floor(bx / BW), lx = bx - col * BW, ly = y - row * CH;
    // signed distance to the rounded brick face (negative inside)
    const hx = BW / 2 - M, hy = CH / 2 - M, rr = 2.5;
    const qx = Math.abs(lx - BW / 2) - hx + rr, qy = Math.abs(ly - CH / 2) - hy + rr;
    const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr;
    const face = 122 + tone[(row * 2 + col) % 16] + n(x, y) * 12 + 12 * (1 - sstep(0, 4, ly - M)) - 14 * sstep(CH - M - 4, CH - M, ly) + 6 * (1 - sstep(0, 4, lx - M));
    const mortar = 170 + n(y, x) * 10 - 22 * (1 - sstep(0, 2, -sd + 2)); // mortar darkens into the joint
    return face + (mortar - face) * sstep(-0.8, 0.8, sd);
  });
  for (let i = 0; i < 30; i++) dab(f, rnd() * T, rnd() * T, 1 + rnd() * 2.5, 0.8 + rnd(), rnd() * 3, (_x, _y, cur) => cur + (rnd() < 0.5 ? 10 : -12), 0.7, 0.7);
  return f;
}
function ore(st: Field): Field {
  const f = new Float32Array(st);
  // glinting crystal clusters: faceted shards, bright faces with a dark rim
  for (let k = 0; k < 5; k++) {
    const cx = rnd() * T, cy = rnd() * T;
    dab(f, cx + 1.5, cy + 2, 10, 8, 0, (_x, _y, cur) => cur - 30, 0.8);          // the pocket in the rock
    dab(f, cx, cy, 9, 8, 0, (_x, _y, cur) => cur + 22, 0.9, 0.6);                // soft glow around it
    for (let s = 0; s < 5; s++) {                                                 // crystals, radiating out
      const a = -Math.PI / 2 + (s - 2) * 0.5 + (rnd() - 0.5) * 0.3, l = 4.2 + rnd() * 2.4;
      dab(f, cx + Math.cos(a) * l * 0.6, cy + Math.sin(a) * l * 0.6, l, 1.6 + rnd() * 0.6, a, (lx, ly) => (ly < 0 ? 248 : 200) - Math.abs(lx) * 30, 0.2);
    }
  }
  return f;
}
function crate(): Field {
  const f = field(), grain = fbm(2, 10, 3), F = 12;
  each(f, (x, y) => {
    const inner = x >= F && x < T - F && y >= F && y < T - F;
    const g = grain(inner ? x : y, inner ? y : x) * 10;
    let v: number;
    if (!inner) { // frame boards, bevelled
      const e = Math.min(x, y, T - 1 - x, T - 1 - y);
      v = 152 + g + 10 * (1 - sstep(0, 3, e)) - 12 * sstep(F - 4, F, e);
    } else { // horizontal slats behind the brace
      const ly = (y - F) % 18;
      v = 118 + g - 40 * (1 - sstep(0, 1.6, Math.min(ly, 18 - ly))) - 18 * (1 - sstep(0, 6, Math.min(x - F, y - F)));
      const db = Math.abs((x - F) - (T - F - 1 - y)) / Math.SQRT2; // diagonal brace
      if (db < 7) v = 150 + g - 18 * sstep(4.5, 7, db) * (x - F > T - F - 1 - y ? 1 : -0.4);
    }
    return v;
  });
  for (const [nx, ny] of [[6, 6], [T - 6, 6], [6, T - 6], [T - 6, T - 6]]) {
    dab(f, nx + 0.8, ny + 0.8, 2.6, 2.6, 0, (_x, _y, cur) => cur - 34, 0.5);
    dab(f, nx, ny, 2.0, 2.0, 0, (lx, ly) => 175 - (lx + ly) * 35, 0.3);
  }
  soften(f); return f;
}
function tnt(): Field {
  const f = field(), n = fbm(3, 6, 3), SW = T / 4;
  each(f, (x, y) => {
    const lx = (x % SW) / SW; // dynamite sticks: cylinders with a highlight and dark seams
    let v = 120 + Math.cos((lx - 0.38) * Math.PI) * 26 - 50 * (1 - sstep(0, 0.07, Math.min(lx, 1 - lx))) + n(x, y) * 6;
    if (y > T * 0.36 && y < T * 0.64) { // paper band
      const by = (y - T * 0.36) / (T * 0.28);
      v = 205 + n(x, y) * 8 - 46 * (1 - sstep(0, 0.08, Math.min(by, 1 - by)));
    }
    return v;
  });
  // stencilled lettering hint inside the band
  const L = (pts: number[][]): void => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], d = Math.hypot(x1 - x0, y1 - y0);
      for (let s = 0; s <= d; s += 0.7) dab(f, x0 + (x1 - x0) * s / d, y0 + (y1 - y0) * s / d, 1.9, 1.9, 0, () => 60, 0.5);
    }
  };
  const m = T / 2, yt = T * 0.43, yb = T * 0.57;
  L([[m - 34, yt], [m - 20, yt]]); L([[m - 27, yt], [m - 27, yb]]);
  L([[m - 8, yb], [m - 8, yt], [m + 8, yb], [m + 8, yt]]);
  L([[m + 20, yt], [m + 34, yt]]); L([[m + 27, yt], [m + 27, yb]]);
  return f;
}
function cobble(): Field {
  const f = field(), v = voronoi(9, 0.85), n = fbm(4, 4, 3), tone = v.sx.map(() => (rnd() - 0.5) * 24);
  each(f, (x, y) => {
    const k = y * T + x, s = v.id[k], e = v.d2[k] - v.d1[k];
    const dx = wd(x, v.sx[s]), dy = wd(y, v.sy[s]), R = T / 3;
    // rounded stones: dome shading toward the top-left, dark mortar gaps
    const dome = (-dx - dy) / R * 16 + (1 - Math.min(1, Math.hypot(dx, dy) / R)) * 10;
    return 128 + tone[s] + dome + n(x, y) * 10 - 58 * (1 - sstep(0.5, 4.5, e));
  });
  soften(f); normalize(f); return f;
}
function roof(): Field {
  const f = field(), n = fbm(3, 6, 3), RH = T / 4, SW = T / 4;
  each(f, (x, y) => {
    const row = Math.floor(y / RH), ly = y - row * RH, off = row % 2 ? SW / 2 : 0;
    const lx = wrap(x + off) % SW, cxo = lx - SW / 2;
    // shingles get lighter toward their exposed lower edge, which is rounded and casts a shadow below
    const edge = RH - 3 - (cxo * cxo) / (SW * 1.6);
    let v = 112 + (ly / RH) * 34 + n(x, y) * 10;
    v -= 48 * (1 - sstep(0, 1.4, Math.min(lx, SW - lx)));       // gaps between shingles
    if (ly > edge) v = 86 - (ly - edge) * 4 + n(x, y) * 6;      // shadow of the row's rounded edge
    v -= 26 * (1 - sstep(0, 4, ly));                              // tucked under the row above
    return v;
  });
  soften(f); return f;
}
function metal(): Field {
  const f = field(), brush = fbm(1, 24, 3);
  each(f, (x, y) => {
    const e = Math.min(x, y, T - 1 - x, T - 1 - y);
    let v = 136 - y * 0.12 + brush(x, y) * 8;
    // bevelled panel edge: lit along the top and left, shadowed along the bottom and right
    v += (1 - sstep(0, 5, e)) * (e === x || e === y ? 34 : -40);
    return v;
  });
  for (const [rx, ry] of [[10, 10], [T - 10, 10], [10, T - 10], [T - 10, T - 10], [T / 2, 10], [T / 2, T - 10]]) {
    dab(f, rx + 1, ry + 1.2, 3.6, 3.6, 0, (_x, _y, cur) => cur - 30, 0.5);
    dab(f, rx, ry, 3.0, 3.0, 0, (lx, ly) => 180 - (lx + ly) * 40, 0.25);
  }
  for (let i = 0; i < 6; i++) { // scratches
    const x0 = rnd() * T, y0 = rnd() * T, a = rnd() * Math.PI, l = 6 + rnd() * 14;
    for (let s = 0; s < l; s += 0.6) dab(f, x0 + Math.cos(a) * s, y0 + Math.sin(a) * s, 0.6, 0.6, 0, (_x, _y, cur) => cur + 22, 0.4, 0.6);
  }
  return f;
}
function plain(): Field { const f = field(); addNoise(f, fbm(3, 3, 3), 8); addNoise(f, fbm(12, 12, 2), 4); normalize(f); return f; }

export function makeDetailAtlas(): THREE.DataTexture {
  seed = 7;
  const tiles: Field[] = [];
  tiles[TILE.GRASS] = grass(); tiles[TILE.DIRT] = dirt(); tiles[TILE.STONE] = stone(); tiles[TILE.SAND] = sand();
  tiles[TILE.BARK] = bark(); tiles[TILE.RINGS] = rings(); tiles[TILE.LEAVES] = leaves(); tiles[TILE.PLANKS] = planks();
  tiles[TILE.BRICK] = bricks(); tiles[TILE.ORE] = ore(tiles[TILE.STONE]); tiles[TILE.CRATE] = crate(); tiles[TILE.TNT] = tnt();
  tiles[TILE.COBBLE] = cobble(); tiles[TILE.ROOF] = roof(); tiles[TILE.METAL] = metal(); tiles[TILE.PLAIN] = plain();
  // per-material contrast around neutral: a block face is only ~40 px on screen at the default zoom,
  // so the big shapes (courses, boards, shingles) need to be bold to survive; fine dabs need less
  const CONTRAST = [1.25, 1.3, 1.2, 1.2, 1.2, 1.2, 1.0, 1.35, 1.6, 1.1, 1.2, 1.0, 1.15, 1.35, 1.1, 1.0];
  tiles.forEach((f, t) => { for (let i = 0; i < f.length; i++) f[i] = 128 + (f[i] - 128) * CONTRAST[t]; });
  const S = DETAIL_SIZE, c = canvas(S, S), ctx = get2d(c), img = ctx.createImageData(S, S), d = img.data;
  for (let t = 0; t < 16; t++) {
    const ox = (t % 4) * DETAIL_CELL, oy = Math.floor(t / 4) * DETAIL_CELL, f = tiles[t];
    // the tile plus its wrapped gutter
    for (let y = 0; y < DETAIL_CELL; y++) for (let x = 0; x < DETAIL_CELL; x++) {
      const v = Math.max(0, Math.min(255, f[wrap(y - DETAIL_GUTTER) * T + wrap(x - DETAIL_GUTTER)]));
      const k = ((oy + y) * S + ox + x) * 4;
      d[k] = d[k + 1] = d[k + 2] = v; d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // raw data (not sRGB), canvas row 0 at v = 0 like before; the short chain caps the blur at MAX_LOD
  const tex = bake(c, { srgb: false, bleed: 0, levels: MAX_LOD + 1, anisotropy: 8 });
  return tex;
}
