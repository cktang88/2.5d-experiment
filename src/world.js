// Voxel world: block definitions, terrain generation, chunk meshing (with AO),
// voxel raycasting, structural-support checks and fire simulation.
import * as THREE from 'three';
import { makeFoliageAtlas, makeDetailAtlas, TILE } from './sprites.js';

export const B = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, BEDROCK: 5, LOG: 6, LEAVES: 7,
  PLANKS: 8, BRICK: 9, ORE: 10, CRATE: 11, TNT: 12, LANTERN: 13, COBBLE: 14, SCORCH: 15,
  ROOF: 16, METAL: 17,
};

export const BLOCKS = [];
function def(id, o) {
  BLOCKS[id] = Object.assign({
    id, name: '', top: 0xffffff, side: null, sideTop: null, bottom: null,
    hp: 3, span: 4, flammable: 0, burnTime: 6, anchored: false, drop: null, emit: 0, solid: true,
  }, o);
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
def(B.METAL, { name: 'metal', span: 6, top: 0x7a8a96, side: 0x66747e, hp: 18, drop: { metal: 2 } });

// linear-space colours cached per block / face
const C = (hex) => new THREE.Color(hex);
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
function hash3(x, y, z) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
export { hash3 };
function vnoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash3(xi, yi, seed), b = hash3(xi + 1, yi, seed);
  const c = hash3(xi, yi + 1, seed), d = hash3(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, seed, oct = 4) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += vnoise(x * f, y * f, seed + i * 17) * a; n += a; a *= 0.5; f *= 2; }
  return s / n;
}

// ---------- world material (vertex colours + emissive + roof cutaway + cloud shadows) ----------
export const sharedUniforms = {
  uPlayer: { value: new THREE.Vector3() },
  uCam: { value: new THREE.Vector3() },
  uTime: { value: 0 },
  uCloud: { value: 1 },
  uCutY: { value: 100 },
  uCapTex: { value: null },
  uWorldSize: { value: new THREE.Vector2(1, 1) },
  uCapLight: { value: 1 },
  uDetail: { value: null },
};

// which detail tile a block face uses (axis 1 = vertical)
export function tileFor(t, axis) {
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
    default: return TILE.PLAIN;
  }
}
export const CUT_RADIUS = 3.2;

const GLSL_NOISE = /* glsl */`
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),u.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),u.x), u.y); }
float cloudShadow(vec2 p){ vec2 q = p*0.035 + vec2(uTime*0.012, uTime*0.007);
  float n = vn(q)*0.6 + vn(q*2.3)*0.3 + vn(q*5.1)*0.1; return mix(1.0, 0.62, smoothstep(0.5, 0.68, n) * uCloud); }
float bayer4(vec2 p){ ivec2 i = ivec2(mod(p, 4.0)); int idx = i.x + i.y*4;
  float m[16] = float[16](0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.); return (m[idx]+0.5)/16.0; }
`;

export function patchWorldMaterial(mat, { cutaway = true, emissive = true, clouds = true, sway = false, detail = false } = {}) {
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
        uniform float uCutY; uniform sampler2D uCapTex; uniform vec2 uWorldSize; uniform float uCapLight;
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
            vec4 cap = texture2D(uCapTex, P.xz / uWorldSize);
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
const FACES = [
  [0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1],
];
const U3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const NB6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const AO_CURVE = [0.5, 0.68, 0.84, 1.0];
const EMBER = new THREE.Color(0.9, 0.3, 0.06);
const GRASS_ALT = new THREE.Color(0xc8c45a), LEAF_ALT = new THREE.Color(0x2f7a48);

export class World {
  constructor(game, W = 128, H = 40, D = 128, seed = 1337) {
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
    // one texel per column holding the block just below the cut plane (for caps)
    this.capData = new Uint8Array(W * D * 4);
    this.capTex = new THREE.DataTexture(this.capData, W, D);
    this.capTex.magFilter = this.capTex.minFilter = THREE.NearestFilter;
    sharedUniforms.uCapTex.value = this.capTex;
    sharedUniforms.uWorldSize.value.set(W, D);
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

  idx(x, y, z) { return x + z * this.W + y * this.W * this.D; }
  inBounds(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < this.W && y < this.H && z < this.D; }
  get(x, y, z) {
    x |= 0; y |= 0; z |= 0;
    if (y < 0) return B.BEDROCK;
    if (!this.inBounds(x, y, z)) return B.AIR;
    return this.data[this.idx(x, y, z)];
  }
  solid(x, y, z) { return this.get(x, y, z) !== B.AIR; }
  solidAt(px, py, pz) { return this.get(Math.floor(px), Math.floor(py), Math.floor(pz)) !== B.AIR; }

  markDirty(x, z) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const mark = (a, b) => { if (a >= 0 && b >= 0 && a < this.cx && b < this.cz) this.chunks[a + b * this.cx].dirty = true; };
    mark(cx, cz);
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    if (lx === 0) mark(cx - 1, cz); if (lx === CHUNK - 1) mark(cx + 1, cz);
    if (lz === 0) mark(cx, cz - 1); if (lz === CHUNK - 1) mark(cx, cz + 1);
  }

  set(x, y, z, t, silent = false) {
    if (!this.inBounds(x, y, z)) return;
    const i = this.idx(x, y, z);
    const prev = this.data[i];
    this.data[i] = t;
    this.damage.delete(i);
    if ((prev !== B.AIR) !== (t !== B.AIR) && this.onSolidChange) this.onSolidChange(x, y, z, t !== B.AIR);
    if (prev === B.LANTERN) this.lanterns.delete(i);
    if (t === B.LANTERN) this.lanterns.add(i);
    if (t !== B.AIR) this.decor[i] = 0;
    else if (this.burning.has(i)) this.burning.delete(i);
    if (t === B.AIR && y + 1 < this.H) {
      // decor sitting on top of a removed block disappears
      const above = this.idx(x, y + 1, z);
      if (this.decor[above]) this.decor[above] = 0;
    }
    if (!silent) this.markDirty(x, z);
    if (y === this.capLayer) this.capDirty = true;
  }

  updateCap(cutY) {
    const layer = cutY - 1;
    if (layer === this.capLayer && !this.capDirty) return;
    this.capLayer = layer; this.capDirty = false;
    const d = this.capData;
    for (let z = 0; z < this.D; z++) for (let x = 0; x < this.W; x++) {
      const t = this.get(x, layer, z), k = (x + z * this.W) * 4;
      if (t === B.AIR) { d[k + 3] = 0; continue; }
      const c = BLOCKS[t].cTop;
      d[k] = Math.min(255, c.r * 255); d[k + 1] = Math.min(255, c.g * 255); d[k + 2] = Math.min(255, c.b * 255); d[k + 3] = 255;
    }
    this.capTex.needsUpdate = true;
  }

  surfaceY(x, z) {
    for (let y = this.H - 1; y >= 0; y--) if (this.solid(x, y, z)) return y + 1;
    return 0;
  }

  // ---------------- generation ----------------
  generate() {
    const { W, D, H, seed } = this;
    const heights = new Float32Array(W * D);
    for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
      const nx = x / W - 0.5, nz = z / D - 0.5;
      const dist = Math.sqrt(nx * nx + nz * nz) * 2;
      const island = 1 - THREE.MathUtils.smoothstep(dist, 0.62, 0.98);
      let h = fbm(x * 0.03, z * 0.03, seed, 4);
      const hills = Math.pow(fbm(x * 0.022 + 50, z * 0.022 + 50, seed + 9, 3), 2.2);
      let height = 3 + island * (5 + h * 5 + hills * 22);
      heights[x + z * W] = height;
    }
    // flatten a plaza in the centre for the castle
    const cxm = W / 2, czm = D / 2;
    for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cxm, z - czm);
      const k = 1 - THREE.MathUtils.smoothstep(d, 14, 24);
      heights[x + z * W] = THREE.MathUtils.lerp(heights[x + z * W], 9.2, k);
    }
    for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
      const h = Math.floor(heights[x + z * W]);
      for (let y = 0; y <= Math.min(h, H - 1); y++) {
        let t;
        if (y === 0) t = B.BEDROCK;
        else if (y === h) {
          if (h <= WATER_LEVEL) t = B.SAND;
          else if (h > 17) t = B.STONE;
          else t = B.GRASS;
        } else if (y > h - 3) t = (h <= WATER_LEVEL) ? B.SAND : (h > 17 ? B.STONE : B.DIRT);
        else t = B.STONE;
        if (t === B.STONE && y > 3 && hash3(x, y, z + seed) < 0.035) t = B.ORE;
        this.data[this.idx(x, y, z)] = t;
      }
    }
    // ore veins sticking out on hills
    for (let i = 0; i < 260; i++) {
      const x = (hash3(i, 1, seed) * W) | 0, z = (hash3(i, 2, seed) * D) | 0;
      const y = this.surfaceY(x, z) - 1;
      if (this.get(x, y, z) === B.STONE) this.data[this.idx(x, y, z)] = B.ORE;
    }
    this.buildCastle(cxm | 0, czm | 0);
    this.buildHut(cxm - 30 | 0, czm + 12 | 0);
    this.buildHut(cxm + 26 | 0, czm - 22 | 0);
    this.buildWatchtower(cxm + 20 | 0, czm + 26 | 0);
    this.buildWatchtower(cxm - 24 | 0, czm - 24 | 0);

    // trees + foliage
    for (let z = 2; z < D - 2; z++) for (let x = 2; x < W - 2; x++) {
      const y = this.surfaceY(x, z);
      if (this.get(x, y - 1, z) !== B.GRASS) continue;
      const forest = fbm(x * 0.05 + 100, z * 0.05, seed + 3, 2);
      const r = hash3(x, z, seed + 77);
      const dc = Math.hypot(x - cxm, z - czm);
      if (dc > 27 && r < (forest > 0.56 ? 0.035 : 0.004)) { this.buildTree(x, y, z); continue; }
      const r2 = hash3(x, z, seed + 78);
      if (r2 < 0.38 && this.get(x, y, z) === B.AIR) {
        const r3 = hash3(x, z, seed + 79);
        let d = 1 + ((r3 * 3) | 0); // grass tufts 1..3
        if (r3 > 0.86) d = 4 + ((hash3(x, z, 5) * 3) | 0); // flowers
        else if (r3 > 0.83 && forest > 0.5) d = 7; // mushroom
        else if (r3 > 0.8) d = 8; // fern
        this.decor[this.idx(x, y, z)] = d;
      }
    }
    this.settle();
  }

  fillBox(x0, y0, z0, x1, y1, z1, t) {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++)
      if (this.inBounds(x, y, z)) { const i = this.idx(x, y, z); this.data[i] = t; if (t === B.LANTERN) this.lanterns.add(i); if (t) this.decor[i] = 0; }
  }

  buildTree(x, y, z) {
    const h = 4 + ((hash3(x, z, 3) * 3) | 0);
    for (let i = 0; i < h; i++) this.data[this.idx(x, y + i, z)] = B.LOG;
    const top = y + h;
    for (let dy = -2; dy <= 1; dy++) {
      const rad = dy === 1 ? 1 : (dy === -2 ? 1.6 : 2.4);
      for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
        if (dx * dx + dz * dz > rad * rad + hash3(x + dx, top + dy, z + dz) * 1.2) continue;
        const xx = x + dx, yy = top + dy, zz = z + dz;
        if (this.inBounds(xx, yy, zz) && this.get(xx, yy, zz) === B.AIR) this.data[this.idx(xx, yy, zz)] = B.LEAVES;
      }
    }
  }

  buildCastle(cx, cz) {
    const g = 10; // ground surface top (y index of first air)
    const R = 9;
    // courtyard floor
    this.fillBox(cx - R, g - 1, cz - R, cx + R, g - 1, cz + R, B.COBBLE);
    // outer walls with crenellations and a gate
    for (let i = -R; i <= R; i++) {
      for (const [x, z] of [[cx + i, cz - R], [cx + i, cz + R], [cx - R, cz + i], [cx + R, cz + i]]) {
        const gate = (z === cz + R && Math.abs(x - cx) <= 1) || (x === cx - R && Math.abs(z - cz) <= 1);
        for (let y = g; y < g + 5; y++) if (!gate || y >= g + 3) this.data[this.idx(x, y, z)] = B.BRICK;
        if ((i & 1) === 0) this.data[this.idx(x, g + 5, z)] = B.BRICK;
      }
    }
    // corner towers
    for (const [tx, tz] of [[cx - R, cz - R], [cx + R, cz - R], [cx - R, cz + R], [cx + R, cz + R]]) {
      for (let y = g; y < g + 9; y++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2;
        if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
        if (edge) this.data[this.idx(tx + dx, y, tz + dz)] = B.BRICK;
        else if (y === g + 5) this.data[this.idx(tx + dx, y, tz + dz)] = B.PLANKS;
      }
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++)
        if ((dx + dz) % 2 === 0 && (Math.abs(dx) === 2) !== (Math.abs(dz) === 2)) this.data[this.idx(tx + dx, g + 9, tz + dz)] = B.BRICK;
      this.data[this.idx(tx, g + 6, tz)] = B.LANTERN; this.lanterns.add(this.idx(tx, g + 6, tz));
    }
    // central keep with a pitched roof
    const k = 3;
    for (let y = g; y < g + 6; y++) for (let dz = -k; dz <= k; dz++) for (let dx = -k; dx <= k; dx++) {
      const edge = Math.abs(dx) === k || Math.abs(dz) === k;
      const door = dz === k && dx === 0 && y < g + 2;
      const window = edge && y === g + 3 && (dx === 0 || dz === 0) && !door;
      if (edge && !door && !window) this.data[this.idx(cx + dx, y, cz + dz)] = (y === g || y === g + 5) ? B.COBBLE : B.PLANKS;
    }
    this.fillBox(cx - k, g + 6, cz - k, cx + k, g + 6, cz + k, B.PLANKS);
    this.gableRoof(cx, cz, g + 7, k + 1, k + 1);
    this.data[this.idx(cx, g, cz)] = B.LANTERN; this.lanterns.add(this.idx(cx, g, cz));
    // crates and TNT stashes in the courtyard
    const stash = [[-6, -6], [-5, -6], [-6, -5], [6, 6], [5, 6], [6, -6], [-6, 6]];
    stash.forEach(([dx, dz], i) => {
      this.data[this.idx(cx + dx, g, cz + dz)] = i % 3 === 2 ? B.TNT : B.CRATE;
      if (i % 2 === 0) this.data[this.idx(cx + dx, g + 1, cz + dz)] = B.CRATE;
    });
    this.data[this.idx(cx + 6, g, cz - 5)] = B.TNT;
    this.data[this.idx(cx + 6, g + 1, cz - 6)] = B.TNT;
  }

  buildHut(x, z) {
    const g = this.surfaceY(x, z);
    const s = 3;
    this.fillBox(x - s, g - 1, z - s, x + s, g - 1, z + s, B.PLANKS);
    for (let y = g; y < g + 4; y++) for (let dz = -s; dz <= s; dz++) for (let dx = -s; dx <= s; dx++) {
      const edge = Math.abs(dx) === s || Math.abs(dz) === s;
      const corner = Math.abs(dx) === s && Math.abs(dz) === s;
      const door = dz === s && dx === 0 && y < g + 2;
      const win = edge && !corner && y === g + 2 && (dx === 0 || dz === 0) && dz !== s;
      if (edge && !door && !win) this.data[this.idx(x + dx, y, z + dz)] = corner ? B.LOG : B.PLANKS;
    }
    this.gableRoof(x, z, g + 4, s + 1, s + 1);
    this.data[this.idx(x - 2, g, z - 2)] = B.CRATE;
    this.data[this.idx(x + 2, g, z - 2)] = B.CRATE;
    this.data[this.idx(x + 2, g + 1, z - 2)] = B.TNT;
    this.data[this.idx(x + 2, g, z + 2)] = B.LANTERN; this.lanterns.add(this.idx(x + 2, g, z + 2));
  }

  // stepped gable roof; each row overlaps the one below so it stays connected
  gableRoof(cx, cz, y0, halfX, halfZ) {
    for (let st = 0; st <= halfZ; st++) for (let dx = -halfX; dx <= halfX; dx++) {
      for (const z of [cz - halfZ + st, cz + halfZ - st]) {
        this.data[this.idx(cx + dx, y0 + st, z)] = B.ROOF;
        if (st > 0) this.data[this.idx(cx + dx, y0 + st - 1, z)] = B.ROOF;
      }
    }
  }

  buildWatchtower(x, z) {
    const g = this.surfaceY(x, z);
    for (let y = g; y < g + 8; y++) for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) this.data[this.idx(x + dx, y, z + dz)] = B.LOG;
    this.fillBox(x - 2, g + 8, z - 2, x + 2, g + 8, z + 2, B.PLANKS);
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++)
      if (Math.abs(dx) === 2 || Math.abs(dz) === 2) this.data[this.idx(x + dx, g + 9, z + dz)] = B.PLANKS;
    this.data[this.idx(x, g + 9, z)] = B.CRATE;
    this.data[this.idx(x + 1, g + 9, z)] = B.TNT;
    this.data[this.idx(x - 2, g + 10, z - 2)] = B.LANTERN; this.lanterns.add(this.idx(x - 2, g + 10, z - 2));
    // solid staircase up the east side, with a gap in the railing at the top
    for (let i = 0; i <= 8; i++) {
      const sz = z - 6 + i;
      this.data[this.idx(x + 3, g + i, sz)] = B.PLANKS;
      for (let y = g + i - 1; y > 0 && this.data[this.idx(x + 3, y, sz)] === B.AIR; y--) this.data[this.idx(x + 3, y, sz)] = B.COBBLE;
    }
    this.data[this.idx(x + 2, g + 9, z + 2)] = B.AIR;
  }

  // ---------------- meshing ----------------
  rebuildDirty(maxPerFrame = 3) {
    let n = 0;
    for (let i = 0; i < this.chunks.length && n < maxPerFrame; i++) {
      if (this.chunks[i].dirty) { this.buildChunk(i % this.cx, Math.floor(i / this.cx)); n++; }
    }
  }
  rebuildAll() { for (let i = 0; i < this.chunks.length; i++) this.buildChunk(i % this.cx, Math.floor(i / this.cx)); }

  buildChunk(cx, cz) {
    const ch = this.chunks[cx + cz * this.cx];
    ch.dirty = false;
    const pos = [], nor = [], col = [], emit = [], cut = [], tiles = [], ind = [];
    const fpos = [], fnor = [], fuv = [], fcol = [], find = [];
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const x1 = Math.min(x0 + CHUNK, this.W), z1 = Math.min(z0 + CHUNK, this.D);
    const tmp = new THREE.Color();
    const p = [0, 0, 0], q = [0, 0, 0];
    for (let y = 0; y < this.H; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      const i = this.idx(x, y, z);
      const t = this.data[i];
      if (t === B.AIR) {
        const d = this.decor[i];
        if (d) this.emitFoliage(x, y, z, d, fpos, fnor, fuv, fcol, find);
        continue;
      }
      const bd = BLOCKS[t];
      const dmg = this.damage.get(i) || 0;
      const dmgK = bd.hp === Infinity ? 1 : 1 - 0.45 * Math.min(1, dmg / bd.hp);
      const tint = t === B.LEAVES ? 0.78 + hash3(x, y, z) * 0.32 : 0.9 + hash3(x, y, z) * 0.16;
      // low-frequency painterly patches on grass and leaves
      const patch = (t === B.GRASS || t === B.LEAVES) ? fbm(x * 0.07, z * 0.07, 999, 2) : -1;
      const burning = this.burning.has(i);
      for (let f = 0; f < 6; f++) {
        const [a, s] = FACES[f];
        p[0] = x; p[1] = y; p[2] = z; p[a] += s;
        if (this.get(p[0], p[1], p[2]) !== B.AIR) continue;
        const u = (a + 1) % 3, v = (a + 2) % 3;
        const base = pos.length / 3;
        const aos = [0, 0, 0, 0];
        for (let k = 0; k < 4; k++) {
          const du = (k === 1 || k === 2) ? 1 : 0;
          const dv = (k >= 2) ? 1 : 0;
          q[0] = x; q[1] = y; q[2] = z;
          q[a] += s > 0 ? 1 : 0; q[u] += du; q[v] += dv;
          pos.push(q[0], q[1], q[2]);
          nor.push(a === 0 ? s : 0, a === 1 ? s : 0, a === 2 ? s : 0);
          // AO sampling in the layer outside the face
          const su = du ? 1 : -1, sv = dv ? 1 : -1;
          const s1 = this.get(p[0] + su * U3[u][0], p[1] + su * U3[u][1], p[2] + su * U3[u][2]) !== B.AIR ? 1 : 0;
          const s2 = this.get(p[0] + sv * U3[v][0], p[1] + sv * U3[v][1], p[2] + sv * U3[v][2]) !== B.AIR ? 1 : 0;
          const c = this.get(p[0] + su * U3[u][0] + sv * U3[v][0], p[1] + su * U3[u][1] + sv * U3[v][1], p[2] + su * U3[u][2] + sv * U3[v][2]) !== B.AIR ? 1 : 0;
          const ao = (s1 && s2) ? 0 : 3 - (s1 + s2 + c);
          aos[k] = ao;
          // colour
          let fc;
          if (a === 1) fc = s > 0 ? bd.cTop : bd.cBottom;
          else fc = (bd.cSideTop && q[1] > y) ? bd.cSideTop : bd.cSide;
          tmp.copy(fc);
          if (patch >= 0 && (a === 1 || t === B.LEAVES || q[1] > y)) tmp.lerp(t === B.LEAVES ? LEAF_ALT : GRASS_ALT, THREE.MathUtils.smoothstep(patch, 0.35, 0.7) * 0.75);
          tmp.multiplyScalar(tint * AO_CURVE[ao] * dmgK);
          if (burning) tmp.lerp(EMBER, 0.65);
          col.push(tmp.r, tmp.g, tmp.b);
          emit.push(bd.emit || (burning ? 0.6 : 0));
          cut.push(bd.anchored ? 0 : 1);
          tiles.push(tileFor(t, a));
        }
        // winding: cyclic (u,v) gives CCW for positive faces
        const flip = aos[0] + aos[2] < aos[1] + aos[3];
        let tris = flip ? [1, 2, 3, 1, 3, 0] : [0, 1, 2, 0, 2, 3];
        if (s < 0) tris = [tris[0], tris[2], tris[1], tris[3], tris[5], tris[4]];
        for (const tIdx of tris) ind.push(base + tIdx);
      }
    }
    const replace = (old, geo, mat, isFol) => {
      if (old) { this.group.remove(old); old.geometry.dispose(); }
      if (!geo) return null;
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true; m.receiveShadow = true;
      if (isFol) { m.customDepthMaterial = this.foliageDepth; }
      this.group.add(m);
      return m;
    };
    let geo = null;
    if (ind.length) {
      geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.setAttribute('emit', new THREE.Float32BufferAttribute(emit, 1));
      geo.setAttribute('cut', new THREE.Float32BufferAttribute(cut, 1));
      geo.setAttribute('tile', new THREE.Float32BufferAttribute(tiles, 1));
      geo.setIndex(ind);
      geo.computeBoundingSphere();
    }
    ch.mesh = replace(ch.mesh, geo, this.material, false);
    let fgeo = null;
    if (find.length) {
      fgeo = new THREE.BufferGeometry();
      fgeo.setAttribute('position', new THREE.Float32BufferAttribute(fpos, 3));
      fgeo.setAttribute('normal', new THREE.Float32BufferAttribute(fnor, 3));
      fgeo.setAttribute('uv', new THREE.Float32BufferAttribute(fuv, 2));
      fgeo.setAttribute('color', new THREE.Float32BufferAttribute(fcol, 3));
      fgeo.setIndex(find);
      fgeo.computeBoundingSphere();
    }
    ch.fol = replace(ch.fol, fgeo, this.foliageMat, true);
  }

  emitFoliage(x, y, z, d, P, N, U, Cc, I) {
    if (this.get(x, y - 1, z) === B.AIR) return;
    const tile = d - 1; // 0..7
    const r = hash3(x, y, z * 3);
    const cxp = x + 0.5 + (r - 0.5) * 0.4, czp = z + 0.5 + (hash3(z, x, y) - 0.5) * 0.4;
    const h = (d <= 3 ? 0.55 : 0.75) + r * 0.3;
    const w = 0.5 + r * 0.15;
    const u0 = tile / 8, u1 = (tile + 1) / 8;
    const shade = 0.85 + r * 0.25;
    for (let k = 0; k < 2; k++) {
      const ang = r * Math.PI + k * Math.PI / 2;
      const dx = Math.cos(ang) * w, dz = Math.sin(ang) * w;
      const b = P.length / 3;
      P.push(cxp - dx, y, czp - dz, cxp + dx, y, czp + dz, cxp + dx, y + h, czp + dz, cxp - dx, y + h, czp - dz);
      for (let j = 0; j < 4; j++) { N.push(0, 1, 0); Cc.push(shade, shade, shade); }
      U.push(u0, 0, u1, 0, u1, 1, u0, 1);
      // both windings with an upward normal so the cards are lit like the ground
      I.push(b, b + 1, b + 2, b, b + 2, b + 3, b, b + 2, b + 1, b, b + 3, b + 2);
    }
  }

  // ---------------- queries ----------------
  // Amanatides & Woo voxel traversal
  raycast(o, d, maxDist = 100, skip = null) {
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
  damageBlock(x, y, z, amount, cause = 'hit') {
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
  findFloating(cells) {
    const seeds = [];
    for (const [x, y, z] of cells) for (const [dx, dy, dz] of NB6) {
      const sx = x + dx, sy = y + dy, sz = z + dz;
      if (!this.inBounds(sx, sy, sz)) continue;
      const t = this.data[this.idx(sx, sy, sz)];
      if (t !== B.AIR && !BLOCKS[t].anchored) seeds.push(this.idx(sx, sy, sz));
    }
    return this.unsupported(seeds);
  }

  unsupported(seeds) {
    const W = this.W, WD = this.W * this.D, D = this.D;
    const LIMIT = 6000;
    const out = [];
    const visited = new Set();
    const xyz = (i) => [i % W, Math.floor(i / W) % D, Math.floor(i / WD)];
    for (const si of seeds) {
      if (visited.has(si)) continue;
      // 1. gather the connected component of non-anchored blocks
      const comp = [si];
      const inComp = new Set(comp);
      let big = false;
      for (let h = 0; h < comp.length; h++) {
        if (comp.length > LIMIT) { big = true; break; }
        const [x, z, y] = xyz(comp[h]);
        for (const [dx, dy, dz] of NB6) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (!this.inBounds(nx, ny, nz)) continue;
          const ni = this.idx(nx, ny, nz), t = this.data[ni];
          if (t === B.AIR || BLOCKS[t].anchored || inComp.has(ni)) continue;
          inComp.add(ni); comp.push(ni);
        }
      }
      for (const v of inComp) visited.add(v);
      if (big) continue;
      // 2. bucketed 0-1 shortest path from blocks touching terrain
      const cost = new Map();
      const buckets = [[], []];
      for (const ci of comp) {
        const [x, z, y] = xyz(ci);
        const below = y === 0 ? B.BEDROCK : this.get(x, y - 1, z);
        if (below !== B.AIR && BLOCKS[below].anchored) { cost.set(ci, 0); buckets[0].push(ci); continue; }
        for (const [dx, dy, dz] of NB6) {
          if (dy < 0) continue;
          const t = this.get(x + dx, y + dy, z + dz);
          if (t !== B.AIR && BLOCKS[t].anchored) { cost.set(ci, 1); buckets[1].push(ci); break; }
        }
      }
      for (let c = 0; c < buckets.length; c++) {
        const bucket = buckets[c];
        for (let k = 0; k < bucket.length; k++) {
          const ci = bucket[k];
          if (cost.get(ci) !== c) continue;
          const [x, z, y] = xyz(ci);
          for (const [dx, dy, dz] of NB6) {
            const nx = x + dx, ny = y + dy, nz = z + dz;
            if (!this.inBounds(nx, ny, nz)) continue;
            const ni = this.idx(nx, ny, nz);
            if (!inComp.has(ni)) continue;
            const nc = c + (dy > 0 ? 0 : 1);
            if (nc > BLOCKS[this.data[ni]].span) continue;
            const old = cost.get(ni);
            if (old !== undefined && old <= nc) continue;
            cost.set(ni, nc);
            while (buckets.length <= nc) buckets.push([]);
            buckets[nc].push(ni);
          }
        }
      }
      if (cost.size === comp.length) continue;
      // 3. split unsupported blocks into connected falling clusters
      const loose = new Set(comp.filter(ci => !cost.has(ci)));
      for (const start of loose) {
        if (!loose.has(start)) continue;
        loose.delete(start);
        const cl = [start];
        for (let h = 0; h < cl.length; h++) {
          const [x, z, y] = xyz(cl[h]);
          for (const [dx, dy, dz] of NB6) {
            const nx = x + dx, ny = y + dy, nz = z + dz;
            if (!this.inBounds(nx, ny, nz)) continue;
            const ni = this.idx(nx, ny, nz);
            if (loose.has(ni)) { loose.delete(ni); cl.push(ni); }
          }
        }
        out.push(cl.map(ci => { const [x, z, y] = xyz(ci); return [x, y, z, this.data[ci]]; }));
      }
    }
    return out;
  }

  // remove anything generation left without support
  settle() {
    const seeds = [];
    for (let i = 0; i < this.data.length; i++) { const t = this.data[i]; if (t !== B.AIR && !BLOCKS[t].anchored) seeds.push(i); }
    let n = 0;
    for (const cl of this.unsupported(seeds)) for (const [x, y, z] of cl) { this.data[this.idx(x, y, z)] = B.AIR; n++; }
    return n;
  }

  // ---------------- fire ----------------
  ignite(x, y, z, force = false) {
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

  updateFire(dt) {
    this.fireTick += dt;
    const g = this.game;
    // visual emission every frame
    let n = 0;
    const emitP = Math.min(1, 140 / Math.max(1, this.burning.size));
    for (const [i] of this.burning) {
      if (Math.random() > emitP * dt * 30) continue;
      const x = i % this.W, z = Math.floor(i / this.W) % this.D, y = Math.floor(i / (this.W * this.D));
      g.particles.fire(x + 0.2 + Math.random() * 0.6, y + 0.9 + Math.random() * 0.3, z + 0.2 + Math.random() * 0.6);
      if (++n > 200) break;
    }
    if (this.fireTick < 0.2) return;
    const step = this.fireTick; this.fireTick = 0;
    const done = [];
    const spread = [];
    for (const [i, tl] of this.burning) {
      const x = i % this.W, z = Math.floor(i / this.W) % this.D, y = Math.floor(i / (this.W * this.D));
      const left = tl - step;
      if (left <= 0) { done.push([x, y, z, i]); continue; }
      this.burning.set(i, left);
      for (let k = 0; k < 2; k++) {
        if (Math.random() > 0.6) continue;
        // fire climbs: bias spreading upward
        const dx = ((Math.random() * 3) | 0) - 1, dy = ((Math.random() * 3) | 0) - 1 + (Math.random() < 0.35 ? 1 : 0), dz = ((Math.random() * 3) | 0) - 1;
        spread.push([x + dx, y + dy, z + dz]);
      }
      // grass fire also lights decor-covered neighbours
      g.burnEntitiesNear(x + 0.5, y + 1, z + 0.5, step);
    }
    for (const [x, y, z] of spread) this.ignite(x, y, z);
    const removed = [];
    for (const [x, y, z, i] of done) {
      this.burning.delete(i);
      const t = this.get(x, y, z);
      if (t === B.GRASS) { this.set(x, y, z, B.SCORCH); continue; }
      if (t === B.TNT) { this.set(x, y, z, B.AIR); g.onBlockDestroyed(x, y, z, t, 'fire'); continue; }
      this.set(x, y, z, B.AIR);
      g.particles.smokePuff(x + 0.5, y + 0.5, z + 0.5, 3);
      removed.push([x, y, z]);
    }
    if (removed.length) g.checkSupport(removed);
  }
}
