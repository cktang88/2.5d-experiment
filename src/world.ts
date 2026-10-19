// Voxel world: block definitions, terrain generation, chunk meshing (with AO),
// voxel raycasting, structural-support checks and fire simulation.
import * as THREE from 'three';
import { makeFoliageAtlas, makeDetailAtlas, TILE } from './sprites';
import { WorldGen } from './worldgen';
import type { Game } from './main';

export const B = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, BEDROCK: 5, LOG: 6, LEAVES: 7,
  PLANKS: 8, BRICK: 9, ORE: 10, CRATE: 11, TNT: 12, LANTERN: 13, COBBLE: 14, SCORCH: 15,
  ROOF: 16, METAL: 17, BARREL: 18,
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

export const WATER_LEVEL = 6;
const CHUNK = 16;

// ---------- deterministic noise ----------
function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
export { hash3 };
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

// ---------- world material (vertex colours + emissive + roof cutaway + cloud shadows) ----------
export const sharedUniforms: {
  uPlayer: THREE.IUniform<THREE.Vector3>;
  uCam: THREE.IUniform<THREE.Vector3>;
  uTime: THREE.IUniform<number>;
  uCloud: THREE.IUniform<number>;
  uCutY: THREE.IUniform<number>;
  uCapTex: THREE.IUniform<THREE.Texture | null>;
  uCapOrigin: THREE.IUniform<THREE.Vector2>;
  uCapLight: THREE.IUniform<number>;
  uDetail: THREE.IUniform<THREE.Texture | null>;
} = {
  uPlayer: { value: new THREE.Vector3() },
  uCam: { value: new THREE.Vector3() },
  uTime: { value: 0 },
  uCloud: { value: 1 },
  uCutY: { value: 100 },
  uCapTex: { value: null },
  uCapOrigin: { value: new THREE.Vector2(0, 0) },
  uCapLight: { value: 1 },
  uDetail: { value: null },
};

// which detail tile a block face uses (axis 1 = vertical)
export function tileFor(t: number, axis: number): number {
  switch (t) {
    case B.GRASS: return axis === 1 ? TILE.GRASS : TILE.DIRT;
    case B.DIRT: case B.SCORCH: return TILE.DIRT;
    case B.STONE: case B.BEDROCK: return TILE.STONE;
    case B.SAND: return TILE.SAND;
    case B.LOG: return axis === 1 ? TILE.RINGS : TILE.BARK;
    case B.LEAVES: return TILE.LEAVES;
    case B.PLANKS: return TILE.PLANKS;
    case B.BRICK: return axis === 1 ? TILE.COBBLE : TILE.BRICK;
    case B.ORE: return TILE.ORE;
    case B.CRATE: return TILE.CRATE;
    case B.TNT: return axis === 1 ? TILE.PLAIN : TILE.TNT;
    case B.COBBLE: return TILE.COBBLE;
    case B.ROOF: return TILE.ROOF;
    case B.METAL: return TILE.METAL;
    case B.BARREL: return axis === 1 ? TILE.RINGS : TILE.METAL;
    default: return TILE.PLAIN;
  }
}
export const CUT_RADIUS = 3.2;
// the roof-cap lookup texture covers this many blocks around the player
const CAP_SIZE = 128;
// streaming radii, in chunks
export const GEN_RADIUS = 7, RENDER_RADIUS = 6;

const GLSL_NOISE = /* glsl */`
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),u.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),u.x), u.y); }
float cloudShadow(vec2 p){ vec2 q = p*0.035 + vec2(uTime*0.012, uTime*0.007);
  float n = vn(q)*0.6 + vn(q*2.3)*0.3 + vn(q*5.1)*0.1; return mix(1.0, 0.62, smoothstep(0.5, 0.68, n) * uCloud); }
float bayer4(vec2 p){ ivec2 i = ivec2(mod(p, 4.0)); int idx = i.x + i.y*4;
  float m[16] = float[16](0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.); return (m[idx]+0.5)/16.0; }
`;

export interface WorldMaterialOptions {
  cutaway?: boolean;
  emissive?: boolean;
  clouds?: boolean;
  sway?: boolean;
  detail?: boolean;
}

export function patchWorldMaterial<M extends THREE.Material>(
  mat: M,
  { cutaway = true, emissive = true, clouds = true, sway = false, detail = false }: WorldMaterialOptions = {},
): M {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sharedUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        ${emissive ? 'attribute float emit; varying float vEmit;' : ''}
        ${cutaway ? 'attribute float cut; varying float vCut;' : ''}
        ${detail ? 'attribute float tile; varying float vTile; varying vec3 vWN; varying vec3 vLPos;' : ''}
        varying vec3 vWPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        ${sway ? `{ vec4 wp0 = modelMatrix * vec4(transformed,1.0);
          float s = uv.y > 0.5 ? 1.0 : 0.0;
          transformed.x += sin(uTime*2.0 + wp0.x*0.7 + wp0.z*0.4) * 0.09 * s;
          transformed.z += cos(uTime*1.7 + wp0.z*0.6) * 0.06 * s; }` : ''}`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        ${emissive ? 'vEmit = emit;' : ''}
        ${cutaway ? 'vCut = cut;' : ''}
        ${detail ? 'vTile = tile; vWN = normal; vLPos = position;' : ''}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uPlayer; uniform vec3 uCam; uniform float uTime; uniform float uCloud;
        uniform float uCutY; uniform sampler2D uCapTex; uniform vec2 uCapOrigin; uniform float uCapLight;
        varying vec3 vWPos;
        ${emissive ? 'varying float vEmit;' : ''}
        ${cutaway ? 'varying float vCut;' : ''}
        ${detail ? 'varying float vTile; varying vec3 vWN; varying vec3 vLPos; uniform sampler2D uDetail;' : ''}
        ${GLSL_NOISE}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        bool isCap = false; vec3 capCol = vec3(0.0);
        ${cutaway ? `
        // roof/wall cutaway: blocks above a plane near the player's head are hidden inside a
        // cylinder around the camera->player line. Where the view ray crosses that plane
        // inside a solid block we draw a flat cap so cut walls don't look hollow.
        if (vCut > 0.5 && vWPos.y > uCutY + 0.01) {
          vec3 toP = uPlayer - uCam; float L = length(toP); vec3 d = toP / L;
          float t = dot(vWPos - uCam, d);
          float r = length(vWPos - (uCam + d * t));
          float k = t < L + 1.5 ? 1.0 - smoothstep(${(CUT_RADIUS - 1.3).toFixed(2)}, ${CUT_RADIUS.toFixed(2)}, r) : 0.0;
          if (k > bayer4(gl_FragCoord.xy)) {
            vec3 rd = normalize(vWPos - cameraPosition);
            float tt = (uCutY - cameraPosition.y) / min(rd.y, -1e-4);
            vec3 P = cameraPosition + rd * tt;
            vec2 cuv = (P.xz - uCapOrigin) / ${CAP_SIZE.toFixed(1)};
            vec4 cap = (cuv.x < 0.0 || cuv.y < 0.0 || cuv.x > 1.0 || cuv.y > 1.0) ? vec4(0.0) : texture2D(uCapTex, cuv);
            if (cap.a > 0.5) { isCap = true; capCol = cap.rgb; } else discard;
          }
        }` : ''}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        ${detail ? `{
          // pixel-art detail texture in block-local space (16 texels per block)
          vec3 an = abs(vWN);
          vec2 fuv = an.y > 0.5 ? vLPos.xz : (an.x > 0.5 ? vec2(vLPos.z, -vLPos.y) : vec2(vLPos.x, -vLPos.y));
          fuv = clamp(fract(fuv), 0.001, 0.999);
          float ti = floor(vTile + 0.5);
          vec2 auv = (vec2(mod(ti, 4.0), floor(ti / 4.0)) + fuv) * 0.25;
          float dv = texture2D(uDetail, auv).r;
          diffuseColor.rgb *= 0.55 + dv * 0.9;
        }` : ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        ${emissive ? 'totalEmissiveRadiance += vColor.rgb * vEmit * 2.6;' : ''}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        ${clouds ? 'reflectedLight.directDiffuse *= cloudShadow(vWPos.xz);' : ''}`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        if (isCap) gl_FragColor.rgb = capCol * uCapLight * (0.42 + 0.06 * step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) * 0.125)));`);
  };
  mat.customProgramCacheKey = () => `world-${cutaway}-${emissive}-${clouds}-${sway}-${detail}`;
  return mat;
}

// face table: axis, sign
const FACE_AXIS = [0, 0, 1, 1, 2, 2];
const FACE_SIGN = [1, -1, 1, -1, 1, -1];
const U3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const NB6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const AO_CURVE = [0.5, 0.68, 0.84, 1.0];
const EMBER = new THREE.Color(0.9, 0.3, 0.06);
const GRASS_ALT = new THREE.Color(0xc8c45a), LEAF_ALT = new THREE.Color(0x2f7a48);

// detail tile per (block type, face axis)
const TILE_OF = new Uint8Array(BLOCKS.length * 3);
for (let t = 0; t < BLOCKS.length; t++) for (let a = 0; a < 3; a++) TILE_OF[t * 3 + a] = tileFor(t, a);

// Growable typed-array buffers shared by every buildChunk call (no per-vertex allocation).
class MeshScratch {
  capV = 0; capFV = 0;
  vn = 0; in = 0; fvn = 0; fin = 0;
  pos = new Float32Array(0); nor = new Float32Array(0); col = new Float32Array(0);
  emit = new Float32Array(0); cut = new Float32Array(0); tile = new Float32Array(0);
  ind = new Uint32Array(0);
  fpos = new Float32Array(0); fnor = new Float32Array(0); fuv = new Float32Array(0); fcol = new Float32Array(0);
  find = new Uint32Array(0);
  constructor() { this.grow(); this.growFoliage(); }
  grow(): void {
    const n = Math.max(8192, this.capV * 2);
    const f = <T extends Float32Array | Uint32Array>(old: T, len: number, C: new (n: number) => T): T => { const a = new C(len); a.set(old); return a; };
    this.pos = f(this.pos, n * 3, Float32Array); this.nor = f(this.nor, n * 3, Float32Array); this.col = f(this.col, n * 3, Float32Array);
    this.emit = f(this.emit, n, Float32Array); this.cut = f(this.cut, n, Float32Array); this.tile = f(this.tile, n, Float32Array);
    this.ind = f(this.ind, n * 1.5, Uint32Array);
    this.capV = n;
  }
  growFoliage(): void {
    const n = Math.max(2048, this.capFV * 2);
    const f = <T extends Float32Array | Uint32Array>(old: T, len: number, C: new (n: number) => T): T => { const a = new C(len); a.set(old); return a; };
    this.fpos = f(this.fpos, n * 3, Float32Array); this.fnor = f(this.fnor, n * 3, Float32Array); this.fcol = f(this.fcol, n * 3, Float32Array);
    this.fuv = f(this.fuv, n * 2, Float32Array);
    this.find = f(this.find, n * 3, Uint32Array);
    this.capFV = n;
  }
}
const scratch = new MeshScratch();
// 8-bit cap colour per block type (same truncation as assigning the scaled float to a Uint8Array)
let capColorTab: Uint8Array | null = null;
function capColors(): Uint8Array {
  if (capColorTab) return capColorTab;
  capColorTab = new Uint8Array(BLOCKS.length * 4);
  for (const b of BLOCKS) {
    if (!b) continue;
    capColorTab[b.id * 4] = Math.min(255, b.cTop.r * 255);
    capColorTab[b.id * 4 + 1] = Math.min(255, b.cTop.g * 255);
    capColorTab[b.id * 4 + 2] = Math.min(255, b.cTop.b * 255);
  }
  return capColorTab;
}
const NO_COST = 255, TAKEN = 254;
const firstAir = new Int16Array((CHUNK + 2) * (CHUNK + 2));
const buriedBelow = new Int16Array(CHUNK * CHUNK);
const nbGrid = new Uint8Array(9);
const qv = new Int32Array(3);
const patchCache = new Float64Array(CHUNK * CHUNK);

export interface Chunk {
  mesh: THREE.Mesh | null;
  fol: THREE.Mesh | null;
  dirty: boolean;
}

export interface VoxelHit {
  hit: true;
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number; // hit face normal
  t: number; // distance along the ray
  point: THREE.Vector3;
}
export interface VoxelMiss {
  hit: false;
  t: number;
}
export type RayResult = VoxelHit | VoxelMiss;
export type RaySkip = (x: number, y: number, z: number, t: number) => boolean;

/** A block in an unsupported cluster: [x, y, z, blockType]. */
export type FloatingCell = [number, number, number, number];

export class World {
  game: Game;
  W: number;
  H: number;
  D: number;
  seed: number;
  data: Uint8Array;
  decor: Uint8Array;
  damage: Map<number, number>; // idx -> damage taken
  burning: Map<number, number>; // idx -> time left
  cx: number;
  cz: number;
  chunks: Chunk[];
  group: THREE.Group;
  material: THREE.MeshLambertMaterial;
  capData: Uint8Array<ArrayBuffer>;
  capTex: THREE.DataTexture;
  capLayer: number;
  capDirty: boolean;
  foliageMat: THREE.MeshLambertMaterial;
  foliageDepth: THREE.MeshDepthMaterial;
  lanterns: Set<number>;
  fireTick: number;
  // scratch for unsupported(): stamp arrays, costs, component queue and 0-1 BFS buckets
  private visit: Int32Array | undefined;
  private inComp: Int32Array | undefined;
  private cost: Uint8Array | undefined;
  private stamp = 0;
  private compBuf = new Int32Array(6016);
  private buckets: number[][] = [[], [], [], [], [], [], [], []];
  onSolidChange?: (x: number, y: number, z: number, solid: boolean) => void;
  gen: WorldGen;
  genState: Uint8Array; // per chunk: 1 once generated
  modified: Uint8Array; // per chunk: 1 once the player (or physics) changed it, for saves
  private capOX = 0; private capOZ = 0;
  private unloadT = 0;
  // chunk offsets within the generation radius, nearest first
  private static rings: [number, number, number][] = (() => {
    const out: [number, number, number][] = [];
    for (let z = -GEN_RADIUS; z <= GEN_RADIUS; z++) for (let x = -GEN_RADIUS; x <= GEN_RADIUS; x++) {
      const d = Math.hypot(x, z);
      if (d <= GEN_RADIUS + 0.5) out.push([x, z, d]);
    }
    return out.sort((a, b) => a[2] - b[2]);
  })();

  constructor(game: Game, W = 512, H = 40, D = 512, seed = 1337) {
    this.game = game;
    this.W = W; this.H = H; this.D = D; this.seed = seed;
    this.data = new Uint8Array(W * H * D);
    this.decor = new Uint8Array(W * H * D);
    this.damage = new Map(); // idx -> damage taken
    this.burning = new Map(); // idx -> time left
    this.cx = Math.ceil(W / CHUNK); this.cz = Math.ceil(D / CHUNK);
    this.chunks = [];
    this.group = new THREE.Group();
    sharedUniforms.uDetail.value = makeDetailAtlas();
    this.material = patchWorldMaterial(new THREE.MeshLambertMaterial({ vertexColors: true }), { detail: true });
    // one texel per column (in a window around the player) holding the block just below the cut plane
    this.capData = new Uint8Array(CAP_SIZE * CAP_SIZE * 4);
    this.capTex = new THREE.DataTexture(this.capData, CAP_SIZE, CAP_SIZE);
    this.capTex.magFilter = this.capTex.minFilter = THREE.NearestFilter;
    sharedUniforms.uCapTex.value = this.capTex;
    this.gen = new WorldGen(W, H, D, seed);
    this.genState = new Uint8Array(this.cx * this.cz);
    this.modified = new Uint8Array(this.cx * this.cz);
    this.capLayer = -1; this.capDirty = true;
    const atlas = makeFoliageAtlas();
    this.foliageMat = patchWorldMaterial(new THREE.MeshLambertMaterial({
      map: atlas, alphaTest: 0.5, side: THREE.FrontSide, vertexColors: true,
    }), { cutaway: false, emissive: false, clouds: true, sway: true });
    this.foliageDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: atlas, alphaTest: 0.5 });
    for (let i = 0; i < this.cx * this.cz; i++) this.chunks.push({ mesh: null, fol: null, dirty: true });
    this.lanterns = new Set();
    this.fireTick = 0;
  }

  idx(x: number, y: number, z: number): number { return x + z * this.W + y * this.W * this.D; }
  inBounds(x: number, y: number, z: number): boolean { return x >= 0 && y >= 0 && z >= 0 && x < this.W && y < this.H && z < this.D; }
  get(x: number, y: number, z: number): number {
    x |= 0; y |= 0; z |= 0;
    if (y < 0) return B.BEDROCK;
    if (!this.inBounds(x, y, z)) return B.AIR;
    return this.data[this.idx(x, y, z)];
  }
  solid(x: number, y: number, z: number): boolean { return this.get(x, y, z) !== B.AIR; }
  // get(...) !== AIR for integer coordinates, without the truncation
  occ(x: number, y: number, z: number): boolean {
    if (y < 0) return true;
    if (x < 0 || z < 0 || x >= this.W || y >= this.H || z >= this.D) return false;
    return this.data[x + z * this.W + y * this.W * this.D] !== B.AIR;
  }
  solidAt(px: number, py: number, pz: number): boolean { return this.get(Math.floor(px), Math.floor(py), Math.floor(pz)) !== B.AIR; }

  markDirty(x: number, z: number): void {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const mark = (a: number, b: number) => { if (a >= 0 && b >= 0 && a < this.cx && b < this.cz) this.chunks[a + b * this.cx].dirty = true; };
    mark(cx, cz);
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    if (lx === 0) mark(cx - 1, cz); if (lx === CHUNK - 1) mark(cx + 1, cz);
    if (lz === 0) mark(cx, cz - 1); if (lz === CHUNK - 1) mark(cx, cz + 1);
  }

  set(x: number, y: number, z: number, t: number, silent = false): void {
    if (!this.inBounds(x, y, z)) return;
    const i = this.idx(x, y, z);
    const prev = this.data[i];
    this.data[i] = t;
    this.damage.delete(i);
    if ((prev !== B.AIR) !== (t !== B.AIR)) {
      if (this.onSolidChange) this.onSolidChange(x, y, z, t !== B.AIR);
      if (this.game.waterSim) this.game.waterSim.onBlockChanged(x, y, z, t !== B.AIR);
    }
    if (prev === B.LANTERN) this.lanterns.delete(i);
    if (t === B.LANTERN) this.lanterns.add(i);
    if (t !== B.AIR) this.decor[i] = 0;
    else if (this.burning.has(i)) this.burning.delete(i);
    if (t === B.AIR && y + 1 < this.H) {
      // decor sitting on top of a removed block disappears
      const above = this.idx(x, y + 1, z);
      if (this.decor[above]) this.decor[above] = 0;
    }
    if (!silent) { this.markDirty(x, z); this.modified[(x >> 4) + (z >> 4) * this.cx] = 1; }
    if (y === this.capLayer) this.capDirty = true;
  }

  // ---------------- streaming ----------------
  chunkIndex(x: number, z: number): number { return (x >> 4) + (z >> 4) * this.cx; }
  isGenerated(x: number, z: number): boolean {
    return x >= 0 && z >= 0 && x < this.W && z < this.D && this.genState[(x >> 4) + (z >> 4) * this.cx] === 1;
  }

  ensureChunk(cx: number, cz: number): boolean {
    if (cx < 0 || cz < 0 || cx >= this.cx || cz >= this.cz) return false;
    const ci = cx + cz * this.cx;
    if (this.genState[ci]) return false;
    const water = this.game.waterSim;
    this.gen.generateChunk({ W: this.W, H: this.H, D: this.D, data: this.data, decor: this.decor, lanterns: this.lanterns, water: water ? water.lv : null }, cx, cz);
    this.genState[ci] = 1;
    if (water) water.activateChunk(cx, cz);
    // neighbours need remeshing for correct borders and AO
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const a = cx + dx, b = cz + dz;
      if (a >= 0 && b >= 0 && a < this.cx && b < this.cz) this.chunks[a + b * this.cx].dirty = true;
    }
    return true;
  }

  // generate everything within `radius` chunks right now (used at start-up and after loading)
  generateAround(px: number, pz: number, radius = GEN_RADIUS): void {
    const pcx = Math.floor(px / CHUNK), pcz = Math.floor(pz / CHUNK);
    for (const [dx, dz, d] of World.rings) if (d <= radius) this.ensureChunk(pcx + dx, pcz + dz);
  }

  // per frame: generate nearby chunks and (re)mesh visible ones, nearest first, within a time budget
  stream(px: number, pz: number, dt: number, budgetMs = 5): void {
    const t0 = performance.now();
    const pcx = Math.floor(px / CHUNK), pcz = Math.floor(pz / CHUNK);
    let meshed = 0;
    for (const [dx, dz, d] of World.rings) {
      if (performance.now() - t0 > budgetMs) break;
      const cx = pcx + dx, cz = pcz + dz;
      if (cx < 0 || cz < 0 || cx >= this.cx || cz >= this.cz) continue;
      this.ensureChunk(cx, cz);
      if (d > RENDER_RADIUS || meshed >= 6) continue;
      const ch = this.chunks[cx + cz * this.cx];
      if (ch.dirty && this.neighboursGenerated(cx, cz)) { this.buildChunk(cx, cz); meshed++; }
    }
    // drop meshes that are well outside the view; they rebuild when we come back
    this.unloadT -= dt;
    if (this.unloadT <= 0) {
      this.unloadT = 0.5;
      for (let i = 0; i < this.chunks.length; i++) {
        const ch = this.chunks[i];
        if (!ch.mesh && !ch.fol) continue;
        const cx = i % this.cx, cz = Math.floor(i / this.cx);
        if (Math.hypot(cx - pcx, cz - pcz) <= RENDER_RADIUS + 2) continue;
        for (const m of [ch.mesh, ch.fol]) if (m) { this.group.remove(m); m.geometry.dispose(); }
        ch.mesh = ch.fol = null; ch.dirty = true;
      }
    }
  }

  private neighboursGenerated(cx: number, cz: number): boolean {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const a = cx + dx, b = cz + dz;
      if (a >= 0 && b >= 0 && a < this.cx && b < this.cz && !this.genState[a + b * this.cx]) return false;
    }
    return true;
  }

  // overwrite one chunk's voxels from a save (the chunk is generated first so the rest of the world is consistent)
  loadChunk(ci: number, data: Uint8Array, decor: Uint8Array, offset: number): void {
    const cx = ci % this.cx, cz = Math.floor(ci / this.cx);
    this.ensureChunk(cx, cz);
    const x0 = cx * CHUNK, z0 = cz * CHUNK, WD = this.W * this.D;
    let k = offset;
    for (let y = 0; y < this.H; y++) for (let z = z0; z < z0 + CHUNK; z++) for (let x = x0; x < x0 + CHUNK; x++, k++) {
      const i = x + z * this.W + y * WD;
      if (this.data[i] === B.LANTERN) this.lanterns.delete(i);
      this.data[i] = data[k]; this.decor[i] = decor[k];
      if (data[k] === B.LANTERN) this.lanterns.add(i);
    }
    this.modified[ci] = 1;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const a = cx + dx, b = cz + dz;
      if (a >= 0 && b >= 0 && a < this.cx && b < this.cz) this.chunks[a + b * this.cx].dirty = true;
    }
    this.capDirty = true;
  }

  // wipe a chunk and generate it again from the seed (used when loading a save)
  regenChunk(ci: number): void {
    const cx = ci % this.cx, cz = Math.floor(ci / this.cx), x0 = cx * CHUNK, z0 = cz * CHUNK, WD = this.W * this.D;
    const water = this.game.waterSim ? this.game.waterSim.lv : null;
    for (let y = 0; y < this.H; y++) for (let z = z0; z < z0 + CHUNK; z++) for (let x = x0; x < x0 + CHUNK; x++) {
      const i = x + z * this.W + y * WD;
      if (this.data[i] === B.LANTERN) this.lanterns.delete(i);
      this.data[i] = 0; this.decor[i] = 0;
      if (water) water[i] = 0;
      this.damage.delete(i); this.burning.delete(i);
    }
    this.genState[ci] = 0; this.modified[ci] = 0;
    this.ensureChunk(cx, cz);
  }

  // copy one chunk's voxels out (save games)
  readChunk(ci: number, data: Uint8Array, decor: Uint8Array, offset: number): void {
    const cx = ci % this.cx, cz = Math.floor(ci / this.cx);
    const x0 = cx * CHUNK, z0 = cz * CHUNK, WD = this.W * this.D;
    let k = offset;
    for (let y = 0; y < this.H; y++) for (let z = z0; z < z0 + CHUNK; z++) for (let x = x0; x < x0 + CHUNK; x++, k++) {
      const i = x + z * this.W + y * WD;
      data[k] = this.data[i]; decor[k] = this.decor[i];
    }
  }

  // roof-cap lookup for a window around the player (rewritten when the window moves or the layer changes)
  updateCap(cutY: number, px: number, pz: number): void {
    const layer = cutY - 1;
    const ox = Math.floor(px / 16) * 16 - CAP_SIZE / 2, oz = Math.floor(pz / 16) * 16 - CAP_SIZE / 2;
    if (layer === this.capLayer && !this.capDirty && ox === this.capOX && oz === this.capOZ) return;
    this.capLayer = layer; this.capDirty = false; this.capOX = ox; this.capOZ = oz;
    sharedUniforms.uCapOrigin.value.set(ox, oz);
    const d = this.capData, data = this.data;
    const colors = capColors();
    const off = layer * this.W * this.D;
    for (let z = 0, k = 0; z < CAP_SIZE; z++) for (let x = 0; x < CAP_SIZE; x++, k += 4) {
      const wx = ox + x, wz = oz + z;
      // below the world is bedrock, above it (or outside it) is air
      const t = layer < 0 ? B.BEDROCK : (layer >= this.H || wx < 0 || wz < 0 || wx >= this.W || wz >= this.D) ? B.AIR : data[off + wx + wz * this.W];
      if (t === B.AIR) { d[k + 3] = 0; continue; }
      const c = t * 4;
      d[k] = colors[c]; d[k + 1] = colors[c + 1]; d[k + 2] = colors[c + 2]; d[k + 3] = 255;
    }
    this.capTex.needsUpdate = true;
  }

  surfaceY(x: number, z: number): number {
    for (let y = this.H - 1; y >= 0; y--) if (this.solid(x, y, z)) return y + 1;
    return 0;
  }

  // ---------------- meshing ----------------
  rebuildDirty(maxPerFrame = 3): void {
    let n = 0;
    for (let i = 0; i < this.chunks.length && n < maxPerFrame; i++) {
      if (this.chunks[i].dirty) { this.buildChunk(i % this.cx, Math.floor(i / this.cx)); n++; }
    }
  }
  rebuildAll(): void { for (let i = 0; i < this.chunks.length; i++) if (this.genState[i]) this.buildChunk(i % this.cx, Math.floor(i / this.cx)); }

  buildChunk(cx: number, cz: number): void {
    const ch = this.chunks[cx + cz * this.cx];
    ch.dirty = false;
    const S = scratch;
    S.vn = 0; S.in = 0; S.fvn = 0; S.fin = 0;
    const W = this.W, H = this.H, WD = W * this.D, data = this.data;
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const x1 = Math.min(x0 + CHUNK, W), z1 = Math.min(z0 + CHUNK, this.D);
    const dmgMap = this.damage.size ? this.damage : null;
    const burnMap = this.burning.size ? this.burning : null;
    patchCache.fill(-2);
    const nb = nbGrid, q = qv;
    // cells below this height in a column are buried (solid on all six sides): skip them
    const first = firstAir, buried = buriedBelow;
    for (let lz = 0; lz < CHUNK + 2; lz++) for (let lx = 0; lx < CHUNK + 2; lx++) {
      const x = x0 + lx - 1, z = z0 + lz - 1;
      let y = 0;
      if (x >= 0 && z >= 0 && x < W && z < this.D) { const c = x + z * W; while (y < H && data[c + y * WD] !== B.AIR) y++; }
      first[lx + lz * (CHUNK + 2)] = y;
    }
    for (let lz = 0; lz < CHUNK; lz++) for (let lx = 0; lx < CHUNK; lx++) {
      const c = (lx + 1) + (lz + 1) * (CHUNK + 2), st = CHUNK + 2;
      buried[lx + lz * CHUNK] = Math.min(first[c], first[c - 1], first[c + 1], first[c - st], first[c + st]) - 1;
    }
    for (let y = 0; y < H; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      if (y < buried[(x - x0) + (z - z0) * CHUNK]) continue;
      const i = x + z * W + y * WD;
      const t = data[i];
      if (t === B.AIR) {
        const d = this.decor[i];
        if (d) this.emitFoliage(x, y, z, d);
        continue;
      }
      const bd = BLOCKS[t];
      let setup = false;
      let dmgK = 1, tint = 1, patchA = 0, burning = false, emit = 0;
      for (let f = 0; f < 6; f++) {
        const a = FACE_AXIS[f], s = FACE_SIGN[f];
        const px = a === 0 ? x + s : x, py = a === 1 ? y + s : y, pz = a === 2 ? z + s : z;
        if (this.occ(px, py, pz)) continue;
        if (!setup) {
          // per-block shading inputs, only computed once a face is visible
          setup = true;
          const dmg = dmgMap ? dmgMap.get(i) || 0 : 0;
          dmgK = bd.hp === Infinity ? 1 : 1 - 0.45 * Math.min(1, dmg / bd.hp);
          tint = t === B.LEAVES ? 0.78 + hash3(x, y, z) * 0.32 : 0.9 + hash3(x, y, z) * 0.16;
          if (t === B.GRASS || t === B.LEAVES) {
            // low-frequency painterly patches on grass and leaves
            const pi = (x - x0) + (z - z0) * CHUNK;
            let patch = patchCache[pi];
            if (patch === -2) patch = patchCache[pi] = fbm(x * 0.07, z * 0.07, 999, 2);
            patchA = THREE.MathUtils.smoothstep(patch, 0.35, 0.7) * 0.75;
          } else patchA = -1;
          burning = burnMap !== null && burnMap.has(i);
          emit = bd.emit || (burning ? 0.6 : 0);
        }
        const u = (a + 1) % 3, v = (a + 2) % 3;
        const ux = U3[u][0], uy = U3[u][1], uz = U3[u][2], vx = U3[v][0], vy = U3[v][1], vz = U3[v][2];
        // occupancy of the 3x3 neighbourhood in the layer outside the face (index (du+1)*3 + dv+1)
        for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
          if (j === 0 && k === 0) continue;
          nb[(j + 1) * 3 + k + 1] = this.occ(px + j * ux + k * vx, py + j * uy + k * vy, pz + j * uz + k * vz) ? 1 : 0;
        }
        if (S.vn + 4 > S.capV) S.grow();
        const base = S.vn;
        const tile = TILE_OF[t * 3 + a];
        const nx = a === 0 ? s : 0, ny = a === 1 ? s : 0, nz = a === 2 ? s : 0;
        let ao0 = 0, ao1 = 0, ao2 = 0, ao3 = 0;
        for (let k = 0; k < 4; k++) {
          const du = (k === 1 || k === 2) ? 1 : 0;
          const dv = (k >= 2) ? 1 : 0;
          q[0] = x; q[1] = y; q[2] = z;
          q[a] += s > 0 ? 1 : 0; q[u] += du; q[v] += dv;
          const vi = base + k, o3 = vi * 3;
          S.pos[o3] = q[0]; S.pos[o3 + 1] = q[1]; S.pos[o3 + 2] = q[2];
          S.nor[o3] = nx; S.nor[o3 + 1] = ny; S.nor[o3 + 2] = nz;
          // AO sampling in the layer outside the face
          const su = du ? 2 : 0, sv = dv ? 2 : 0;
          const s1 = nb[su * 3 + 1], s2 = nb[3 + sv], c = nb[su * 3 + sv];
          const ao = (s1 && s2) ? 0 : 3 - (s1 + s2 + c);
          if (k === 0) ao0 = ao; else if (k === 1) ao1 = ao; else if (k === 2) ao2 = ao; else ao3 = ao;
          // colour
          const upper = q[1] > y;
          let fc: THREE.Color;
          if (a === 1) fc = s > 0 ? bd.cTop : bd.cBottom;
          else fc = (bd.cSideTop && upper) ? bd.cSideTop : bd.cSide;
          let r = fc.r, g = fc.g, b = fc.b;
          if (patchA >= 0 && (a === 1 || t === B.LEAVES || upper)) {
            const alt = t === B.LEAVES ? LEAF_ALT : GRASS_ALT;
            r += (alt.r - r) * patchA; g += (alt.g - g) * patchA; b += (alt.b - b) * patchA;
          }
          const m = tint * AO_CURVE[ao] * dmgK;
          r *= m; g *= m; b *= m;
          if (burning) { r += (EMBER.r - r) * 0.65; g += (EMBER.g - g) * 0.65; b += (EMBER.b - b) * 0.65; }
          S.col[o3] = r; S.col[o3 + 1] = g; S.col[o3 + 2] = b;
          S.emit[vi] = emit;
          S.cut[vi] = bd.anchored ? 0 : 1;
          S.tile[vi] = tile;
        }
        S.vn += 4;
        // winding: cyclic (u,v) gives CCW for positive faces
        const ind = S.ind, o = S.in;
        if (ao0 + ao2 < ao1 + ao3) {
          if (s > 0) { ind[o] = base + 1; ind[o + 1] = base + 2; ind[o + 2] = base + 3; ind[o + 3] = base + 1; ind[o + 4] = base + 3; ind[o + 5] = base; }
          else { ind[o] = base + 1; ind[o + 1] = base + 3; ind[o + 2] = base + 2; ind[o + 3] = base + 1; ind[o + 4] = base; ind[o + 5] = base + 3; }
        } else if (s > 0) { ind[o] = base; ind[o + 1] = base + 1; ind[o + 2] = base + 2; ind[o + 3] = base; ind[o + 4] = base + 2; ind[o + 5] = base + 3; }
        else { ind[o] = base; ind[o + 1] = base + 2; ind[o + 2] = base + 1; ind[o + 3] = base; ind[o + 4] = base + 3; ind[o + 5] = base + 2; }
        S.in += 6;
      }
    }
    const replace = (old: THREE.Mesh | null, geo: THREE.BufferGeometry | null, mat: THREE.Material, isFol: boolean): THREE.Mesh | null => {
      if (old) { this.group.remove(old); old.geometry.dispose(); }
      if (!geo) return null;
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true; m.receiveShadow = true;
      if (isFol) { m.customDepthMaterial = this.foliageDepth; }
      this.group.add(m);
      return m;
    };
    let geo: THREE.BufferGeometry | null = null;
    if (S.in) {
      const n = S.vn;
      geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(S.pos.slice(0, n * 3), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(S.nor.slice(0, n * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(S.col.slice(0, n * 3), 3));
      geo.setAttribute('emit', new THREE.BufferAttribute(S.emit.slice(0, n), 1));
      geo.setAttribute('cut', new THREE.BufferAttribute(S.cut.slice(0, n), 1));
      geo.setAttribute('tile', new THREE.BufferAttribute(S.tile.slice(0, n), 1));
      geo.setIndex(new THREE.BufferAttribute(n > 65535 ? S.ind.slice(0, S.in) : new Uint16Array(S.ind.subarray(0, S.in)), 1));
      geo.computeBoundingSphere();
    }
    ch.mesh = replace(ch.mesh, geo, this.material, false);
    let fgeo: THREE.BufferGeometry | null = null;
    if (S.fin) {
      const n = S.fvn;
      fgeo = new THREE.BufferGeometry();
      fgeo.setAttribute('position', new THREE.BufferAttribute(S.fpos.slice(0, n * 3), 3));
      fgeo.setAttribute('normal', new THREE.BufferAttribute(S.fnor.slice(0, n * 3), 3));
      fgeo.setAttribute('uv', new THREE.BufferAttribute(S.fuv.slice(0, n * 2), 2));
      fgeo.setAttribute('color', new THREE.BufferAttribute(S.fcol.slice(0, n * 3), 3));
      fgeo.setIndex(new THREE.BufferAttribute(n > 65535 ? S.find.slice(0, S.fin) : new Uint16Array(S.find.subarray(0, S.fin)), 1));
      fgeo.computeBoundingSphere();
    }
    ch.fol = replace(ch.fol, fgeo, this.foliageMat, true);
  }

  // crossed-card foliage for a decor tile standing on a solid block
  emitFoliage(x: number, y: number, z: number, d: number): void {
    if (this.get(x, y - 1, z) === B.AIR) return;
    const S = scratch;
    const tile = d - 1; // 0..7
    const r = hash3(x, y, z * 3);
    const cxp = x + 0.5 + (r - 0.5) * 0.4, czp = z + 0.5 + (hash3(z, x, y) - 0.5) * 0.4;
    const h = (d <= 3 ? 0.55 : 0.75) + r * 0.3;
    const w = 0.5 + r * 0.15;
    const u0 = tile / 8, u1 = (tile + 1) / 8;
    const shade = 0.85 + r * 0.25;
    for (let k = 0; k < 2; k++) {
      if (S.fvn + 4 > S.capFV) S.growFoliage();
      const ang = r * Math.PI + k * Math.PI / 2;
      const dx = Math.cos(ang) * w, dz = Math.sin(ang) * w;
      const b = S.fvn, P = S.fpos, o = b * 3;
      P[o] = cxp - dx; P[o + 1] = y; P[o + 2] = czp - dz;
      P[o + 3] = cxp + dx; P[o + 4] = y; P[o + 5] = czp + dz;
      P[o + 6] = cxp + dx; P[o + 7] = y + h; P[o + 8] = czp + dz;
      P[o + 9] = cxp - dx; P[o + 10] = y + h; P[o + 11] = czp - dz;
      for (let j = 0; j < 4; j++) {
        const p = o + j * 3;
        S.fnor[p] = 0; S.fnor[p + 1] = 1; S.fnor[p + 2] = 0;
        S.fcol[p] = shade; S.fcol[p + 1] = shade; S.fcol[p + 2] = shade;
      }
      const U = S.fuv, ou = b * 2;
      U[ou] = u0; U[ou + 1] = 0; U[ou + 2] = u1; U[ou + 3] = 0; U[ou + 4] = u1; U[ou + 5] = 1; U[ou + 6] = u0; U[ou + 7] = 1;
      // both windings with an upward normal so the cards are lit like the ground
      const I = S.find, oi = S.fin;
      I[oi] = b; I[oi + 1] = b + 1; I[oi + 2] = b + 2; I[oi + 3] = b; I[oi + 4] = b + 2; I[oi + 5] = b + 3;
      I[oi + 6] = b; I[oi + 7] = b + 2; I[oi + 8] = b + 1; I[oi + 9] = b; I[oi + 10] = b + 3; I[oi + 11] = b + 2;
      S.fvn += 4; S.fin += 12;
    }
  }

  // ---------------- queries ----------------
  // Amanatides & Woo voxel traversal
  raycast(o: THREE.Vector3, d: THREE.Vector3, maxDist = 100, skip: RaySkip | null = null): RayResult {
    let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z);
    const sx = Math.sign(d.x), sy = Math.sign(d.y), sz = Math.sign(d.z);
    const tdx = sx ? Math.abs(1 / d.x) : Infinity, tdy = sy ? Math.abs(1 / d.y) : Infinity, tdz = sz ? Math.abs(1 / d.z) : Infinity;
    let tmx = sx ? ((sx > 0 ? x + 1 - o.x : o.x - x) * tdx) : Infinity;
    let tmy = sy ? ((sy > 0 ? y + 1 - o.y : o.y - y) * tdy) : Infinity;
    let tmz = sz ? ((sz > 0 ? z + 1 - o.z : o.z - z) * tdz) : Infinity;
    let t = 0, nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < 512; i++) {
      const bt = this.get(x, y, z);
      if (bt !== B.AIR && !(y >= this.H) && !(skip && skip(x, y, z, bt))) {
        return { hit: true, x, y, z, nx, ny, nz, t, point: new THREE.Vector3(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t) };
      }
      if (tmx < tmy && tmx < tmz) { x += sx; t = tmx; tmx += tdx; nx = -sx; ny = 0; nz = 0; }
      else if (tmy < tmz) { y += sy; t = tmy; tmy += tdy; nx = 0; ny = -sy; nz = 0; }
      else { z += sz; t = tmz; tmz += tdz; nx = 0; ny = 0; nz = -sz; }
      if (t > maxDist) break;
    }
    return { hit: false, t: maxDist };
  }

  // returns remaining-hp ratio or -1 when destroyed
  damageBlock(x: number, y: number, z: number, amount: number, cause = 'hit'): number {
    const t = this.get(x, y, z);
    if (t === B.AIR || !this.inBounds(x, y, z)) return 1;
    const bd = BLOCKS[t];
    if (bd.hp === Infinity) return 1;
    const i = this.idx(x, y, z);
    const dmg = (this.damage.get(i) || 0) + amount;
    (this.game.lastDamagePos ||= new THREE.Vector3()).set(x + 0.5, y + 0.5, z + 0.5);
    if (dmg >= bd.hp) {
      this.set(x, y, z, B.AIR);
      this.game.onBlockDestroyed(x, y, z, t, cause);
      return -1;
    }
    this.damage.set(i, dmg);
    this.markDirty(x, z);
    return 1 - dmg / bd.hp;
  }

  // Structural integrity. Every non-terrain block needs a load path to the
  // ground: stacking on a supported block is free, while each horizontal or
  // hanging link costs 1. A block whose cheapest path exceeds its material's
  // span breaks off. Returns the unsupported blocks grouped into clusters.
  findFloating(cells: Iterable<readonly number[]>): FloatingCell[][] {
    const seeds: number[] = [];
    for (const c of cells) for (let n = 0; n < 6; n++) {
      const sx = c[0] + NB6[n][0], sy = c[1] + NB6[n][1], sz = c[2] + NB6[n][2];
      if (!this.inBounds(sx, sy, sz)) continue;
      const si = this.idx(sx, sy, sz), t = this.data[si];
      if (t !== B.AIR && !BLOCKS[t].anchored) seeds.push(si);
    }
    return this.unsupported(seeds);
  }

  unsupported(seeds: number[]): FloatingCell[][] {
    const W = this.W, D = this.D, H = this.H, WD = W * D, data = this.data;
    const LIMIT = 6000;
    const out: FloatingCell[][] = [];
    // stamp arrays instead of Sets: visit[i] === visitStamp (seen in an earlier component),
    // inComp[i] === compStamp (member of the current component)
    if (!this.visit) { this.visit = new Int32Array(data.length); this.inComp = new Int32Array(data.length); this.cost = new Uint8Array(data.length).fill(NO_COST); }
    const visit = this.visit, inComp = this.inComp!, cost = this.cost!;
    const visitStamp = ++this.stamp;
    const comp = this.compBuf;
    const buckets = this.buckets;
    for (const si of seeds) {
      if (visit[si] === visitStamp) continue;
      // 1. gather the connected component of non-anchored blocks
      const compStamp = ++this.stamp;
      let len = 0;
      comp[len++] = si; inComp[si] = compStamp;
      let big = false;
      for (let h = 0; h < len; h++) {
        if (len > LIMIT) { big = true; break; }
        const ci = comp[h];
        const x = ci % W, y = (ci / WD) | 0, z = ((ci - y * WD - x) / W) | 0;
        for (let n = 0; n < 6; n++) {
          const nx = x + NB6[n][0], ny = y + NB6[n][1], nz = z + NB6[n][2];
          if (nx < 0 || ny < 0 || nz < 0 || nx >= W || ny >= H || nz >= D) continue;
          const ni = nx + nz * W + ny * WD, t = data[ni];
          if (t === B.AIR || BLOCKS[t].anchored || inComp[ni] === compStamp) continue;
          inComp[ni] = compStamp; comp[len++] = ni;
        }
      }
      for (let h = 0; h < len; h++) visit[comp[h]] = visitStamp;
      if (big) continue;
      // 2. bucketed 0-1 shortest path from blocks touching terrain
      for (const bk of buckets) bk.length = 0;
      let supported = 0;
      for (let h = 0; h < len; h++) {
        const ci = comp[h];
        const x = ci % W, y = (ci / WD) | 0, z = ((ci - y * WD - x) / W) | 0;
        const below = y === 0 ? B.BEDROCK : this.get(x, y - 1, z);
        if (below !== B.AIR && BLOCKS[below].anchored) { cost[ci] = 0; supported++; buckets[0].push(ci); continue; }
        for (let n = 0; n < 6; n++) {
          if (NB6[n][1] < 0) continue;
          const t = this.get(x + NB6[n][0], y + NB6[n][1], z + NB6[n][2]);
          if (t !== B.AIR && BLOCKS[t].anchored) { cost[ci] = 1; supported++; buckets[1].push(ci); break; }
        }
      }
      for (let c = 0; c < buckets.length; c++) {
        const bucket = buckets[c];
        for (let k = 0; k < bucket.length; k++) {
          const ci = bucket[k];
          if (cost[ci] !== c) continue;
          const x = ci % W, y = (ci / WD) | 0, z = ((ci - y * WD - x) / W) | 0;
          for (let n = 0; n < 6; n++) {
            const dy = NB6[n][1];
            const nx = x + NB6[n][0], ny = y + dy, nz = z + NB6[n][2];
            if (nx < 0 || ny < 0 || nz < 0 || nx >= W || ny >= H || nz >= D) continue;
            const ni = nx + nz * W + ny * WD;
            if (inComp[ni] !== compStamp) continue;
            const nc = c + (dy > 0 ? 0 : 1);
            if (nc > BLOCKS[data[ni]].span) continue;
            const old = cost[ni];
            if (old !== NO_COST && old <= nc) continue;
            if (old === NO_COST) supported++;
            cost[ni] = nc;
            buckets[nc].push(ni);
          }
        }
      }
      if (supported !== len) {
        // 3. split unsupported blocks into connected falling clusters
        // (cost === NO_COST: loose and not yet taken; TAKEN: already in a cluster)
        for (let h = 0; h < len; h++) {
          const start = comp[h];
          if (cost[start] !== NO_COST) continue;
          cost[start] = TAKEN;
          const cl: FloatingCell[] = [];
          const queue = [start];
          for (let qi = 0; qi < queue.length; qi++) {
            const ci = queue[qi];
            const x = ci % W, y = (ci / WD) | 0, z = ((ci - y * WD - x) / W) | 0;
            cl.push([x, y, z, data[ci]]);
            for (let n = 0; n < 6; n++) {
              const nx = x + NB6[n][0], ny = y + NB6[n][1], nz = z + NB6[n][2];
              if (nx < 0 || ny < 0 || nz < 0 || nx >= W || ny >= H || nz >= D) continue;
              const ni = nx + nz * W + ny * WD;
              if (inComp[ni] === compStamp && cost[ni] === NO_COST) { cost[ni] = TAKEN; queue.push(ni); }
            }
          }
          out.push(cl);
        }
      }
      for (let h = 0; h < len; h++) cost[comp[h]] = NO_COST;
    }
    return out;
  }

  // ---------------- fire ----------------
  ignite(x: number, y: number, z: number, force = false): boolean {
    const t = this.get(x, y, z);
    if (t === B.AIR) return false;
    const bd = BLOCKS[t];
    if (!bd.flammable) return false;
    const i = this.idx(x, y, z);
    if (this.burning.has(i) || this.burning.size > 450) return false;
    if (!force && Math.random() > bd.flammable) return false;
    this.burning.set(i, bd.burnTime * (0.7 + Math.random() * 0.6));
    this.markDirty(x, z);
    return true;
  }

  updateFire(dt: number): void {
    this.fireTick += dt;
    const burning = this.burning;
    if (!burning.size) { if (this.fireTick >= 0.2) this.fireTick = 0; return; }
    const g = this.game, W = this.W, D = this.D, WD = W * D;
    // visual emission every frame
    let n = 0;
    const emitP = Math.min(1, 140 / Math.max(1, burning.size));
    for (const i of burning.keys()) {
      if (Math.random() > emitP * dt * 30) continue;
      const x = i % W, z = Math.floor(i / W) % D, y = Math.floor(i / WD);
      g.particles.fire(x + 0.2 + Math.random() * 0.6, y + 0.9 + Math.random() * 0.3, z + 0.2 + Math.random() * 0.6);
      if (++n > 200) break;
    }
    if (this.fireTick < 0.2) return;
    const step = this.fireTick; this.fireTick = 0;
    const done: number[] = []; // block indices that finished burning
    const spread: number[] = []; // flat x, y, z triples
    for (const [i, tl] of burning) {
      const x = i % W, z = Math.floor(i / W) % D, y = Math.floor(i / WD);
      const left = tl - step;
      if (left <= 0) { done.push(i); continue; }
      burning.set(i, left);
      for (let k = 0; k < 2; k++) {
        if (Math.random() > 0.6) continue;
        // fire climbs: bias spreading upward
        const dx = ((Math.random() * 3) | 0) - 1, dy = ((Math.random() * 3) | 0) - 1 + (Math.random() < 0.35 ? 1 : 0), dz = ((Math.random() * 3) | 0) - 1;
        spread.push(x + dx, y + dy, z + dz);
      }
      // grass fire also lights decor-covered neighbours
      g.burnEntitiesNear(x + 0.5, y + 1, z + 0.5, step);
    }
    for (let k = 0; k < spread.length; k += 3) this.ignite(spread[k], spread[k + 1], spread[k + 2]);
    const removed: number[][] = [];
    for (const i of done) {
      const x = i % W, z = Math.floor(i / W) % D, y = Math.floor(i / WD);
      burning.delete(i);
      const t = this.get(x, y, z);
      if (t === B.GRASS) { this.set(x, y, z, B.SCORCH); continue; }
      if (t === B.TNT || t === B.BARREL) { this.set(x, y, z, B.AIR); g.onBlockDestroyed(x, y, z, t, 'fire'); continue; }
      this.set(x, y, z, B.AIR);
      g.particles.smokePuff(x + 0.5, y + 0.5, z + 0.5, 3);
      removed.push([x, y, z]);
    }
    if (removed.length) g.checkSupport(removed);
  }
}
