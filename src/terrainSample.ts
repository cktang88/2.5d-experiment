// Worker-side terrain sampling from the analytic heightfield: far-terrain LOD grids, minimap and
// world-map images and the ocean's shoreline texture. Pure functions of the WorldGen (no renderer,
// no World), so they run inside the generation worker and never cost the main thread anything.
import { B, BLOCKS, WATER_LEVEL, fbm } from './blocks';
import type { WorldGen, Site } from './worldgen';

const SEA = WATER_LEVEL;
const smooth = (x: number, a: number, b: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const GRASS_ALT = [0xc8 / 255, 0xc4 / 255, 0x5a / 255]; // the mesher's painterly grass patches (sRGB)
const LEAF = [0x5f / 255, 0xa8 / 255, 0x45 / 255], LEAF_DARK = [0x2f / 255, 0x7a / 255, 0x48 / 255];
const srgb = (hex: number, k: number) => ((hex >> (16 - 8 * k)) & 255) / 255;

/** heights on an (n + 2) x (n + 2) lattice: the n x n requested samples plus a one-sample margin for slopes */
function lattice(gen: WorldGen, x0: number, z0: number, step: number, nx: number, nz: number): Float32Array {
  const P = nx + 2, h = new Float32Array(P * (nz + 2));
  for (let j = 0; j < nz + 2; j++) for (let i = 0; i < P; i++) h[i + j * P] = gen.heightAt(x0 + (i - 1) * step, z0 + (j - 1) * step);
  return h;
}

// surface colour (sRGB 0..1 into out[0..2]) for a sample of height h whose steepest per-block rise is `slope`.
// Where the voxel rule is a hard switch (grass turns to stone at a rise of 3 per block) this blends, since a
// coarse sample stands for many columns.
function surface(gen: WorldGen, x: number, z: number, h: number, slope: number, out: number[]): number {
  let top = gen.topBlock(x, z, Math.floor(h), 0);
  const b = BLOCKS[top];
  for (let k = 0; k < 3; k++) out[k] = srgb(b.top, k);
  if (top === B.GRASS) {
    // dry-grass patches like the voxel mesher's, and forests (trees cover much of the ground there)
    const pa = smooth(fbm(x * 0.07, z * 0.07, 999, 2), 0.35, 0.7) * 0.6;
    for (let k = 0; k < 3; k++) out[k] += (GRASS_ALT[k] - out[k]) * pa;
    const forest = fbm(x * 0.05 + 100, z * 0.05, gen.seed + 3, 2);
    const fk = smooth(forest, 0.5, 0.62) * 0.75 * (1 - smooth(h, 170, 190)) + 0.08;
    const lc = forest > 0.6 ? LEAF_DARK : LEAF;
    for (let k = 0; k < 3; k++) out[k] += (lc[k] - out[k]) * fk;
    // terraced grass slopes show their brown sides from above
    const sk = smooth(slope, 0.5, 2.2) * 0.55;
    for (let k = 0; k < 3; k++) out[k] += (srgb(b.sideTop!, k) - out[k]) * sk;
    // steep ground is bare stone
    const st = smooth(slope, 2.1, 3.3);
    if (st > 0.5) top = B.STONE;
    const sb = BLOCKS[B.STONE];
    for (let k = 0; k < 3; k++) out[k] += (srgb(sb.top, k) * 0.5 + srgb(sb.side!, k) * 0.5 - out[k]) * st;
  } else if (top === B.STONE) {
    for (let k = 0; k < 3; k++) out[k] += (srgb(b.side!, k) - out[k]) * smooth(slope, 1, 4) * 0.6;
  }
  return top;
}

/** steepest per-block rise at (x, z), from samples one block away (what the voxel surface rule sees) */
function slopeAt(gen: WorldGen, x: number, z: number, h: number): number {
  return Math.max(Math.abs(gen.heightAt(x + 1, z) - h), Math.abs(gen.heightAt(x - 1, z) - h),
    Math.abs(gen.heightAt(x, z + 1) - h), Math.abs(gen.heightAt(x, z - 1) - h)) + 0.5; // + flooring to whole blocks
}

export interface FarResult { pos: Float32Array; col: Uint8Array }
/**
 * Far-terrain grid of (n + 1)² vertices `step` blocks apart, starting at (x0, z0): positions relative
 * to (x0, 0, z0) and linear-space RGBA vertex colours (the renderer expects linear vertex colours).
 */
export function farGrid(gen: WorldGen, x0: number, z0: number, step: number, n: number): FarResult {
  const V = n + 1, P = V + 2, h = lattice(gen, x0, z0, step, V, V);
  const pos = new Float32Array(V * V * 3), col = new Uint8Array(V * V * 4), c = [0, 0, 0];
  const lin = (v: number) => Math.round(Math.pow(Math.min(1, Math.max(0, v)), 2.2) * 255);
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
    const k = (i + 1) + (j + 1) * P, y = h[k], x = x0 + i * step, z = z0 + j * step;
    // local slope from one-block neighbours, but never below the grid's own (coarser) gradient
    const slope = Math.max(slopeAt(gen, x, z, y), Math.max(Math.abs(h[k + 1] - h[k - 1]), Math.abs(h[k + P] - h[k - P])) / (2 * step));
    const top = surface(gen, x, z, y, slope, c);
    // a little per-vertex value noise keeps big faces from looking flat-filled; the base is darker than
    // the block colour to stand in for the voxels' AO, detail texture and tree shadows
    const v = 0.85 + 0.12 * fbm(x * 0.013, z * 0.013, 4242, 2) - (top === B.SAND && y < SEA ? smooth(SEA - y, 0, 20) * 0.35 : 0);
    const o = i + j * V;
    pos[o * 3] = i * step; pos[o * 3 + 1] = y + 0.5; pos[o * 3 + 2] = j * step; // voxel tops sit at floor(h) + 1
    col[o * 4] = lin(c[0] * v); col[o * 4 + 1] = lin(c[1] * v); col[o * 4 + 2] = lin(c[2] * v); col[o * 4 + 3] = 255;
  }
  return { pos, col };
}

/** map image (sRGB RGBA, w x hgt pixels, `step` blocks per pixel): sea by depth, beaches, grass, forest, rock, snow, hill shading */
export function mapImage(gen: WorldGen, x0: number, z0: number, step: number, w: number, hgt: number): Uint8ClampedArray<ArrayBuffer> {
  const P = w + 2, h = lattice(gen, x0, z0, step, w, hgt);
  const img = new Uint8ClampedArray(w * hgt * 4), c = [0, 0, 0];
  for (let j = 0; j < hgt; j++) for (let i = 0; i < w; i++) {
    const k = (i + 1) + (j + 1) * P, y = h[k], x = x0 + i * step, z = z0 + j * step;
    const gx = (h[k + 1] - h[k - 1]) / (2 * step), gz = (h[k + P] - h[k - P]) / (2 * step);
    let r: number, g: number, b: number;
    if (y < SEA - 0.5) {
      const d = smooth(SEA - y, 0, 22);
      r = 70 - d * 46; g = 150 - d * 82; b = 170 - d * 48;
      if (SEA - y < 2.5) { r += 30; g += 30; b += 20; } // shallows
    } else {
      surface(gen, x, z, y, step === 1 ? Math.max(Math.abs(h[k + 1] - y), Math.abs(h[k - 1] - y), Math.abs(h[k + P] - y), Math.abs(h[k - P] - y)) + 0.5 : Math.max(Math.abs(gx), Math.abs(gz)) + 0.5, c);
      // hill shading: light from the north-west, stronger on the map than in 3D so relief reads at a glance
      const shade = Math.max(0.55, Math.min(1.3, 1 + (gx + gz) * -0.35 * Math.min(1, step / 2 + 0.5)));
      // faint contour every 32 blocks of height
      const band = Math.floor(y / 32) !== Math.floor(h[k - 1] / 32) || Math.floor(y / 32) !== Math.floor(h[k - P] / 32) ? 0.88 : 1;
      r = c[0] * 255 * shade * band; g = c[1] * 255 * shade * band; b = c[2] * 255 * shade * band;
    }
    const o = (i + j * w) * 4;
    img[o] = r; img[o + 1] = g; img[o + 2] = b; img[o + 3] = 255;
  }
  return img;
}

/** every structure site in the world (for the world map) */
export function allSites(gen: WorldGen): Site[] {
  const out = new Set<Site>();
  // sitesNear covers the 3 x 3 regions around a point, so sample every third region
  for (let z = 192 + 96; z < gen.D + 192 * 3; z += 192 * 3) for (let x = 192 + 96; x < gen.W + 192 * 3; x += 192 * 3)
    for (const s of gen.sitesNear(x, z)) out.add(s);
  return [...out];
}

/** shoreline texture for the ocean shader: 1 on land, fading to 0 about 3.5 blocks deep (one byte per sample) */
export function shoreData(gen: WorldGen, x0: number, z0: number, step: number, n: number): Uint8Array {
  const d = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const h = Math.floor(gen.heightAt(x0 + i * step + 1, z0 + j * step + 1)) + 1;
    const sh = h > SEA ? 1 : Math.min(1, Math.max(0, 1 - (SEA - h) / 3.5));
    d[i + j * n] = sh * 255;
  }
  return d;
}
