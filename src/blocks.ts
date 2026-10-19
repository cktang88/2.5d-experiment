// Block definitions and deterministic noise. Kept free of the renderer and the World class so
// world generation can run inside workers.
import * as THREE from 'three';

export const B = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, BEDROCK: 5, LOG: 6, LEAVES: 7,
  PLANKS: 8, BRICK: 9, ORE: 10, CRATE: 11, TNT: 12, LANTERN: 13, COBBLE: 14, SCORCH: 15,
  ROOF: 16, METAL: 17, BARREL: 18, SNOW: 19,
} as const;

export interface BlockDef {
  id: number;
  name: string;
  top: number;
  side: number | null;
  sideTop: number | null;
  bottom: number | null;
  hp: number;
  span: number;
  flammable: number;
  burnTime: number;
  anchored: boolean;
  drop: Record<string, number> | null;
  emit: number;
  solid: boolean;
  // cached colours (filled in below)
  cTop: THREE.Color;
  cSide: THREE.Color;
  cSideTop: THREE.Color | null;
  cBottom: THREE.Color;
}

type BlockInit = Partial<Omit<BlockDef, 'id' | 'cTop' | 'cSide' | 'cSideTop' | 'cBottom'>>;

// sparse: indexed by block id
export const BLOCKS: BlockDef[] = [];
function def(id: number, o: BlockInit): void {
  BLOCKS[id] = Object.assign({
    id, name: '', top: 0xffffff, side: null, sideTop: null, bottom: null,
    hp: 3, span: 4, flammable: 0, burnTime: 6, anchored: false, drop: null, emit: 0, solid: true,
  }, o) as BlockDef;
}
def(B.AIR, { name: 'air', solid: false, hp: 0 });
def(B.GRASS, { name: 'grass', top: 0x8fc45a, side: 0x8a6643, sideTop: 0x6fa44a, bottom: 0x7a5a3a, hp: 2, anchored: true, flammable: 0.3, burnTime: 2.5 });
def(B.DIRT, { name: 'dirt', top: 0x8f6a45, hp: 2, anchored: true });
def(B.STONE, { name: 'stone', top: 0x9c9a94, side: 0x8a8781, hp: 6, anchored: true, drop: { stone: 1 } });
def(B.SAND, { name: 'sand', top: 0xe8d39a, side: 0xdcc58a, hp: 1.5, anchored: true });
def(B.BEDROCK, { name: 'bedrock', top: 0x3a3a44, hp: Infinity, anchored: true });
def(B.LOG, { name: 'log', span: 4, top: 0xb88a55, side: 0x6e4a2c, hp: 4, flammable: 0.45, burnTime: 9, drop: { wood: 2 } });
def(B.LEAVES, { name: 'leaves', span: 4, top: 0x5fa845, side: 0x4f9440, hp: 0.6, flammable: 0.7, burnTime: 2.5 });
def(B.PLANKS, { name: 'planks', span: 3, top: 0xc9955a, side: 0xb8844c, hp: 3, flammable: 0.5, burnTime: 7, drop: { wood: 1 } });
def(B.BRICK, { name: 'brick', span: 3, top: 0xb9b2a4, side: 0xa8705a, hp: 8, drop: { stone: 1 } });
def(B.ORE, { name: 'ore', top: 0x8c8a86, side: 0x8c8a86, hp: 7, anchored: true, drop: { metal: 2, stone: 1 } });
def(B.CRATE, { name: 'crate', span: 1, top: 0xd8a860, side: 0xa8743c, hp: 2, flammable: 0.4, burnTime: 4, drop: { metal: 2, wood: 1 } });
def(B.TNT, { name: 'tnt', span: 1, top: 0xeee4d0, side: 0xd8443a, hp: 1, flammable: 1, burnTime: 0.6 });
def(B.LANTERN, { name: 'lantern', span: 1, top: 0xffd27a, side: 0xffc35a, hp: 1, emit: 1, drop: { metal: 1 } });
def(B.COBBLE, { name: 'cobble', span: 3, top: 0x8e8b84, side: 0x7d7a73, hp: 5, drop: { stone: 1 } });
def(B.SCORCH, { name: 'scorched', top: 0x4a3c30, side: 0x5a4433, hp: 2, anchored: true });
def(B.ROOF, { name: 'roof', span: 3, top: 0xb04a3a, side: 0x9a3e30, hp: 2.5, flammable: 0.35, burnTime: 6, drop: { wood: 1 } });
def(B.BARREL, { name: 'barrel', span: 1, top: 0x6a3a2a, side: 0xc23a2a, hp: 2, flammable: 1, burnTime: 0.8 });
def(B.SNOW, { name: 'snow', top: 0xf2f5fa, side: 0xdfe5ee, hp: 1.5, anchored: true });
def(B.METAL, { name: 'metal', span: 6, top: 0x7a8a96, side: 0x66747e, hp: 18, drop: { metal: 2 } });

// linear-space colours cached per block / face
const C = (hex: number) => new THREE.Color(hex);
for (const b of BLOCKS) {
  if (!b) continue;
  b.cTop = C(b.top);
  b.cSide = C(b.side ?? b.top);
  b.cSideTop = b.sideTop != null ? C(b.sideTop) : null;
  b.cBottom = C(b.bottom ?? b.side ?? b.top);
}

// sea level
export const WATER_LEVEL = 48;

// ---------- deterministic noise ----------
export function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
function vnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash3(xi, yi, seed), b = hash3(xi + 1, yi, seed);
  const c = hash3(xi, yi + 1, seed), d = hash3(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x: number, y: number, seed: number, oct = 4): number {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += vnoise(x * f, y * f, seed + i * 17) * a; n += a; a *= 0.5; f *= 2; }
  return s / n;
}
// ridged multifractal (0..1): sharp crests where the noise crosses its midpoint, for mountain ranges
export function ridged(x: number, y: number, seed: number, oct = 5): number {
  let s = 0, a = 0.5, f = 1, n = 0, wgt = 1;
  for (let i = 0; i < oct; i++) {
    let v = 1 - Math.abs(vnoise(x * f, y * f, seed + i * 31) * 2 - 1);
    v *= v * wgt;
    wgt = Math.min(1, v * 1.6);
    s += v * a; n += a; a *= 0.5; f *= 2.03;
  }
  return s / n;
}
