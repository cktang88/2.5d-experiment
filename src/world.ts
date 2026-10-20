// Voxel world: sparse 32³ chunk storage for a 5120 x 512 x 5120 world, streaming
// generation (in workers) and meshing (Rust/WASM, in workers), the world material,
// voxel raycasting, structural-support checks and fire simulation.
import * as THREE from 'three';
import { makeFoliageAtlas, makeDetailAtlas, TILE } from './sprites';
import { B, BLOCKS } from './blocks';
import { WorldGen } from './worldgen';
import type { Column } from './worldgen';
import { meshJob, nextMeshSeq, solidGeometry, foliageGeometry } from './meshing';
import { ABSENT } from './core';
import type { VoxelCore } from './core';
import type { WasmMeshing, MeshData } from './meshing';
import type { Game } from './main';

export { B, BLOCKS, WATER_LEVEL, fbm, hash3 } from './blocks';
export type { BlockDef } from './blocks';

// ---------- world material (vertex colours + emissive + roof cutaway + cloud shadows) ----------
export const sharedUniforms: {
  uPlayer: THREE.IUniform<THREE.Vector3>;
  uCam: THREE.IUniform<THREE.Vector3>;
  uTime: THREE.IUniform<number>;
  uCloud: THREE.IUniform<number>;
  uCutY: THREE.IUniform<number>;
  uTerrainCut: THREE.IUniform<number>;
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
  uTerrainCut: { value: 0 },
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
    case B.SAND: case B.SNOW: return TILE.SAND;
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
// Terrain cutaway: when hills or cliffs stand between the camera and the player, everything above the
// cut plane inside a cone from the camera is hidden too. A cone (radius TERRAIN_CUT_RADIUS at the
// player, shrinking toward the camera) shows up as a fixed-size circle around the player on screen,
// the "see-through bubble" of Diablo-style cameras. Because it's a cone from the eye, a pixel is either
// cut along its whole view ray or not at all, so the slice through the rock can be drawn by a separate
// horizontal cap plane at the cut height (makeCapPlane) instead of on the hidden surfaces: that also
// works when the camera itself is buried in a mountainside and there are no surfaces in front of it.
export const TERRAIN_CUT_RADIUS = 5.5;
/** radius of the terrain cut cone at distance `t` along the camera->player line of length `L` */
export function terrainCutRadius(t: number, L: number, strength: number): number {
  return TERRAIN_CUT_RADIUS * strength * Math.min(1, Math.max(0, t / L));
}
// the roof-cap lookup texture covers this many blocks around the player
const CAP_SIZE = 128;

// Cut weights and cap shading, shared by the world material and the cap plane. Needs uPlayer, uCam,
// uCutY, uTerrainCut, uCapTex, uCapOrigin, uCapLight, h21.
const GLSL_CUT = /* glsl */`
// built blocks: a cylinder around the camera->player line (1 inside, dithered edge)
float cutBuilt(vec3 p){
  vec3 toP = uPlayer - uCam; float L = length(toP); vec3 d = toP / L;
  float t = dot(p - uCam, d);
  if (t > L + 1.5) return 0.0;
  return 1.0 - smoothstep(${(CUT_RADIUS - 1.3).toFixed(2)}, ${CUT_RADIUS.toFixed(2)}, length(p - (uCam + d * t)));
}
// terrain: a cone from the camera (a fixed circle around the player on screen), while uTerrainCut > 0
float cutTerrain(vec3 p){
  if (uTerrainCut <= 0.0) return 0.0;
  vec3 toP = uPlayer - uCam; float L = length(toP); vec3 d = toP / L;
  float t = dot(p - uCam, d);
  if (t > L + 1.5) return 0.0;
  float rt = ${TERRAIN_CUT_RADIUS.toFixed(2)} * uTerrainCut * clamp(t / L, 0.0, 1.0);
  return 1.0 - smoothstep(rt * 0.62, rt, length(p - (uCam + d * t)));
}
// cap colour at a point P on the cut plane; a < 0.5 where the block under the plane is air
vec4 capAt(vec3 P){
  vec2 cuv = (P.xz - uCapOrigin) / ${CAP_SIZE.toFixed(1)};
  if (cuv.x < 0.0 || cuv.y < 0.0 || cuv.x > 1.0 || cuv.y > 1.0) return vec4(0.0);
  vec4 cap = texture2D(uCapTex, cuv);
  if (cap.a < 0.5) return vec4(0.0);
  // a little per-block shade so a wide slice of rock still reads as voxels, and a darker rim along
  // the cap's edge (next to open air) so the section has an outline
  vec2 cell = floor(P.xz);
  float shade = 0.9 + 0.2 * h21(cell);
  vec2 f = P.xz - cell, e = vec2(1.0 / ${CAP_SIZE.toFixed(1)}, 0.0);
  float rim = 0.0;
  if (f.x < 0.16 && texture2D(uCapTex, cuv - e.xy).a < 0.5) rim = 1.0;
  if (f.x > 0.84 && texture2D(uCapTex, cuv + e.xy).a < 0.5) rim = 1.0;
  if (f.y < 0.16 && texture2D(uCapTex, cuv - e.yx).a < 0.5) rim = 1.0;
  if (f.y > 0.84 && texture2D(uCapTex, cuv + e.yx).a < 0.5) rim = 1.0;
  return vec4(cap.rgb * shade * (1.0 - 0.45 * rim), 1.0);
}
vec3 capShade(vec3 c){ return c * uCapLight * (0.34 + 0.05 * step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) * 0.125))); }
`;

const GLSL_NOISE = /* glsl */`
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),u.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),u.x), u.y); }
float cloudShadow(vec2 p){ vec2 q = p*0.035 + vec2(uTime*0.012, uTime*0.007);
  float n = vn(q)*0.6 + vn(q*2.3)*0.3 + vn(q*5.1)*0.1; return mix(1.0, 0.62, smoothstep(0.5, 0.68, n) * uCloud); }
float bayer4(vec2 p){ ivec2 i = ivec2(mod(p, 4.0)); int idx = i.x + i.y*4;
  float m[16] = float[16](0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.); return (m[idx]+0.5)/16.0; }
`;

// block-cell noise, bit-identical to hash3()/fbm(x*0.07, z*0.07, 999, 2) in blocks.ts
// pixel cracks for damaged blocks: Voronoi cell edges on the block's 16x16 texel grid, revealed
// within a radius of the face centre that grows with the crack stage (1..4)
const GLSL_CRACK = /* glsl */`
vec2 h22(vec2 p){ return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
float crackMask(vec2 uv, vec3 cell, float stage){
  vec2 p = (floor(uv * 16.0) + 0.5) / 16.0;
  vec2 g = p * 2.6 + cell.xz * 1.37 + cell.y * 0.71, i = floor(g), f = fract(g);
  float d1 = 9.0, d2 = 9.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y)), r = o + h22(i + o) - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  float edge = sqrt(d2) - sqrt(d1);
  return step(edge, 0.11) * step(length(p - 0.5), stage * 0.19);
}
`;
const GLSL_CELL = /* glsl */`
float hash3i(ivec3 p){ uvec3 q = uvec3(p);
  uint h = (q.x * 374761393u) ^ (q.y * 668265263u) ^ (q.z * 1274126177u);
  h = (h ^ (h >> 13u)) * 1274126177u; h ^= h >> 16u; return float(h) / 4294967295.0; }
float vnoiseI(vec2 p, int seed){ vec2 i = floor(p), f = p - i, u = f*f*(3.0-2.0*f); ivec2 c = ivec2(i);
  float a = hash3i(ivec3(c, seed)), b = hash3i(ivec3(c.x+1, c.y, seed));
  float d = hash3i(ivec3(c.x, c.y+1, seed)), e = hash3i(ivec3(c.x+1, c.y+1, seed));
  return a + (b-a)*u.x + (d-a)*u.y + (a-b-d+e)*u.x*u.y; }
float patchFbm(vec2 p){ return (vnoiseI(p * 0.07, 999) * 0.5 + vnoiseI(p * 0.14, 1016) * 0.25) / 0.75; }
`;

export interface WorldMaterialOptions {
  cutaway?: boolean;
  emissive?: boolean;
  clouds?: boolean;
  sway?: boolean;
  detail?: boolean;
  /** per-block colour variation computed from the block cell (greedy-meshed chunks; needs `detail`) */
  cells?: boolean;
  terrainCut?: boolean;
}

export function patchWorldMaterial<M extends THREE.Material>(
  mat: M,
  { cutaway = true, emissive = true, clouds = true, sway = false, detail = false, cells = false, terrainCut = cutaway }: WorldMaterialOptions = {},
): M {
  const v3 = (c: THREE.Color): string => `vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)})`;
  // patch colour as a multiplier of a face's base colour (vertex colour = base × AO × damage)
  const ratio = (alt: THREE.Color, base: THREE.Color): string => v3(new THREE.Color(alt.r / base.r, alt.g / base.g, alt.b / base.b));
  const grass = BLOCKS[B.GRASS], leaves = BLOCKS[B.LEAVES];
  // `cutaway` reads the mesher's per-vertex cut flag (built blocks) and draws caps; `terrainCut` alone
  // (foliage) only hides fragments inside the terrain cut cone, everything there counting as terrain
  const anyCut = cutaway || terrainCut;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sharedUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        ${emissive ? 'attribute float emit; varying float vEmit;' : ''}
        ${cutaway || cells ? 'attribute float cut; varying float vCut;' : ''}
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
        ${cutaway || cells ? 'vCut = cut;' : ''}
        ${detail ? 'vTile = tile; vWN = normal; vLPos = position;' : ''}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uPlayer; uniform vec3 uCam; uniform float uTime; uniform float uCloud;
        uniform float uCutY; uniform float uTerrainCut; uniform sampler2D uCapTex; uniform vec2 uCapOrigin; uniform float uCapLight;
        varying vec3 vWPos;
        ${emissive ? 'varying float vEmit;' : ''}
        ${cutaway || cells ? 'varying float vCut;' : ''}
        ${detail ? 'varying float vTile; varying vec3 vWN; varying vec3 vLPos; uniform sampler2D uDetail;' : ''}
        ${GLSL_NOISE}
        ${cells ? GLSL_CELL + GLSL_CRACK : ''}
        ${anyCut ? GLSL_CUT : ''}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        bool isCap = false; vec3 capCol = vec3(0.0);
        ${anyCut ? `
        // Cutaway. Built blocks (cut flag from the mesher) above a plane near the player's head are
        // hidden inside a cylinder around the camera->player line; where the view ray crosses that plane
        // inside a solid block we draw a flat cap so cut walls don't look hollow. While terrain hides the
        // player everything above the plane inside the terrain cone goes too (its cap is the cap plane).
        if (vWPos.y > uCutY + 0.01) {
          float dith = bayer4(gl_FragCoord.xy);
          ${cutaway ? `if (mod(floor(vCut + 0.5), 2.0) > 0.5 && cutBuilt(vWPos) > dith) { // (rounded: an interpolated 3.9999 is crack 2, not cut)
            vec3 rd = normalize(vWPos - cameraPosition);
            vec3 P = cameraPosition + rd * ((uCutY - cameraPosition.y) / min(rd.y, -1e-4));
            vec4 cap = capAt(P);
            if (cap.a > 0.5) { isCap = true; capCol = cap.rgb; } else discard;
          } else` : ''} if (cutTerrain(vWPos) > dith) discard;
        }` : ''}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 bCol = vec3(1.0);
        #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
          bCol = vColor.rgb;
        #endif
        ${cells ? `{
          // per-block variation (was baked into vertex colours before greedy meshing): hash tint,
          // painterly grass/leaf patches and the ember tint of burning blocks, from the block cell.
          // Tile flags: 16 grass, 32 leaves, 64 burning.
          int fl = int(floor(vTile + 0.5)) >> 4;
          ivec3 cell = ivec3(floor(vWPos - vWN * 0.5));
          float h = hash3i(cell);
          bool isGrass = (fl & 1) != 0, isLeaf = (fl & 2) != 0;
          if (isGrass || isLeaf) {
            float pa = smoothstep(0.35, 0.7, patchFbm(vec2(cell.xz))) * 0.75, w = 1.0;
            vec3 r;
            if (vWN.y > 0.5) r = isGrass ? ${ratio(GRASS_ALT, grass.cTop)} : ${ratio(LEAF_ALT, leaves.cTop)};
            else if (vWN.y < -0.5) r = isGrass ? ${ratio(GRASS_ALT, grass.cBottom)} : ${ratio(LEAF_ALT, leaves.cBottom)};
            else if (isGrass) { r = ${ratio(GRASS_ALT, grass.cSideTop ?? grass.cSide)}; w = vWPos.y - float(cell.y); } // fades in towards the top edge
            else r = ${ratio(LEAF_ALT, leaves.cSide)};
            bCol *= mix(vec3(1.0), r, pa * w);
          }
          bCol *= isLeaf ? 0.78 + h * 0.32 : 0.9 + h * 0.16;
          if ((fl & 4) != 0) bCol = mix(bCol, ${v3(EMBER)}, 0.65);
          diffuseColor.rgb = diffuse * bCol;
        }` : ''}
        ${detail ? `{
          // pixel-art detail texture in block-local space (16 texels per block)
          vec3 an = abs(vWN);
          vec2 fuv = an.y > 0.5 ? vLPos.xz : (an.x > 0.5 ? vec2(vLPos.z, -vLPos.y) : vec2(vLPos.x, -vLPos.y));
          fuv = clamp(fract(fuv), 0.001, 0.999);
          float ti = mod(floor(vTile + 0.5), 16.0);
          vec2 auv = (vec2(mod(ti, 4.0), floor(ti / 4.0)) + fuv) * 0.25;
          float dv = texture2D(uDetail, auv).r;
          diffuseColor.rgb *= 0.55 + dv * 0.9;
          ${cells ? `// damage cracks (stage 1..4 from the mesher) spreading out from the face centre
          float crack = floor(floor(vCut + 0.5) / 2.0);
          if (crack > 0.5) diffuseColor.rgb *= 1.0 - 0.7 * crackMask(fuv, floor(vWPos - vWN * 0.5), crack);` : ''}
        }` : ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        ${emissive ? 'totalEmissiveRadiance += bCol * vEmit * 2.6;' : ''}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        ${clouds ? 'reflectedLight.directDiffuse *= cloudShadow(vWPos.xz);' : ''}`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        ${anyCut ? 'if (isCap) gl_FragColor.rgb = capShade(capCol);' : ''}`);
  };
  mat.customProgramCacheKey = () => `world-${cutaway}-${terrainCut}-${emissive}-${clouds}-${sway}-${detail}-${cells}`;
  return mat;
}

/**
 * The cross-section drawn where the terrain cutaway slices through rock: a horizontal plane at the cut
 * height covering the cap window, drawn only inside the terrain cut cone and over solid blocks. Move it
 * with placeCapPlane() whenever the cut height or cap window changes.
 */
export function makeCapPlane(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(CAP_SIZE, CAP_SIZE);
  geo.rotateX(-Math.PI / 2);
  geo.translate(CAP_SIZE / 2, 0, CAP_SIZE / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
    fog: true,
    vertexShader: /* glsl */`
      #include <common>
      #include <fog_pars_vertex>
      varying vec3 vWPos;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWPos = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <fog_pars_fragment>
      uniform vec3 uPlayer; uniform vec3 uCam; uniform float uTime; uniform float uCutY; uniform float uTerrainCut;
      uniform sampler2D uCapTex; uniform vec2 uCapOrigin; uniform float uCapLight;
      varying vec3 vWPos;
      ${GLSL_NOISE.replace(/float cloudShadow[^\n]*\n[^\n]*\n/, '')}
      ${GLSL_CUT}
      void main(){
        if (cutTerrain(vWPos) <= bayer4(gl_FragCoord.xy)) discard;
        vec4 cap = capAt(vWPos);
        if (cap.a < 0.5) discard;
        gl_FragColor = vec4(capShade(cap.rgb), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  Object.assign(mat.uniforms, sharedUniforms);
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.matrixAutoUpdate = false;
  m.visible = false;
  return m;
}
export function placeCapPlane(m: THREE.Mesh, cutY: number): void {
  const o = sharedUniforms.uCapOrigin.value;
  // a hair below the cut height, so uncut block tops lying exactly at it win the depth test
  m.position.set(o.x, cutY - 0.004, o.y);
  m.updateMatrix();
  m.visible = sharedUniforms.uTerrainCut.value > 0;
}

export const EMBER = new THREE.Color(0.9, 0.3, 0.06);
export const GRASS_ALT = new THREE.Color(0xc8c45a), LEAF_ALT = new THREE.Color(0x2f7a48);

// ---------- chunk layout ----------
export const CHUNK = 32;
export const WORLD_W = 5120, WORLD_H = 512, WORLD_D = 5120;
/** chunks along x, y and z */
export const CX = WORLD_W / CHUNK, CY = WORLD_H / CHUNK, CZ = WORLD_D / CHUNK;
const CXZ = CX * CZ;
export const CHUNK_VOL = CHUNK * CHUNK * CHUNK;
/** chunk key: cx + cz * CX + cy * CX * CZ */
export const chunkKey = (cx: number, cy: number, cz: number): number => cx + cz * CX + cy * CXZ;
/** index of a block inside its chunk's arrays */
export const localIndex = (x: number, y: number, z: number): number => (x & 31) | ((z & 31) << 5) | ((y & 31) << 10);

/**
 * One 32³ chunk. A uniform chunk (every block the same, e.g. deep rock or open sky) stores
 * no block array, just `fill`. Arrays are indexed by localIndex().
 */
export interface VChunk {
  key: number;
  cx: number; cy: number; cz: number;
  blocks: Uint8Array | null;
  fill: number;
  decor: Uint8Array | null; // foliage decor id per air cell (0 = none)
  water: Uint8Array | null; // water level per cell (levels 1..8, 0x80 = infinite source)
  mesh: THREE.Mesh | null;
  fol: THREE.Mesh | null;
  dirty: boolean; // needs (re)meshing
  // sequence number of the installed mesh, or of the moment the chunk's arrays were (re)created:
  // a mesh result with a lower one is stale (a worker job overtaken by a main-thread remesh, or a
  // job that read the slabs of a column that was dropped or overwritten meanwhile) and is ignored
  seq: number;
  modified: boolean; // changed since generation (saved in save games)
}

// streaming radii, in 32-block columns: meshes within renderRadius of the view focus (5 at play
// zoom, growing to MAX_RENDER_RADIUS when the camera zooms far out), generation one column further,
// and unmodified columns beyond renderRadius + 4 are dropped from memory (they regenerate from the seed)
export const RENDER_RADIUS = 5, MAX_RENDER_RADIUS = 10;
export const GEN_RADIUS = RENDER_RADIUS + 1;
const MAX_UNLOAD = MAX_RENDER_RADIUS + 4;

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

const NB6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const NO_COST = 255, TAKEN = 254;

// 8-bit cap colour per block type
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

// column offsets within the generation radius, nearest first
const RINGS: [number, number, number][] = (() => {
  const out: [number, number, number][] = [];
  for (let z = -MAX_UNLOAD; z <= MAX_UNLOAD; z++) for (let x = -MAX_UNLOAD; x <= MAX_UNLOAD; x++) {
    const d = Math.hypot(x, z);
    if (d <= MAX_RENDER_RADIUS + 1.5) out.push([x, z, d]);
  }
  return out.sort((a, b) => a[2] - b[2]);
})();

export class World {
  game: Game;
  readonly W = WORLD_W;
  readonly H = WORLD_H;
  readonly D = WORLD_D;
  seed: number;
  /** every chunk of every generated column, by chunkKey (undefined: not generated / unloaded) */
  chunks: (VChunk | undefined)[] = new Array(CX * CY * CZ);
  /** per column (cx + cz * CX): 0 = not generated, 1 = generating in a worker, 2 = generated */
  colState = new Uint8Array(CX * CZ);
  damage = new Map<number, number>(); // block idx -> damage taken
  burning = new Map<number, number>(); // block idx -> time left
  lanterns = new Set<number>(); // block idx of every lantern in loaded columns
  group = new THREE.Group();
  material: THREE.MeshLambertMaterial;
  capData: Uint8Array<ArrayBuffer>;
  capTex: THREE.DataTexture;
  capLayer = -1;
  capDirty = true;
  foliageMat: THREE.MeshLambertMaterial;
  foliageDepth: THREE.MeshDepthMaterial;
  fireTick = 0;
  private buckets: number[][] = [[], [], [], [], [], [], [], []];
  // scratch grids for unsupported()
  private sup: { visit: Int32Array; inComp: Int32Array; cost: Uint8Array; type: Uint8Array; comp: Int32Array; stamp: number } | undefined;
  onSolidChange?: (x: number, y: number, z: number, solid: boolean) => void;
  gen: WorldGen;
  meshing!: WasmMeshing;
  /** the shared-memory voxel core: chunk arrays are its slabs, and the chunk table mirrors `chunks` */
  core: VoxelCore;
  private tab: { blk: Uint32Array; dec: Uint32Array; fill: Uint8Array };
  private genWorkers: Worker[] = [];
  private genBusy: number[] = [];
  private genQueue: number[] = []; // column indices waiting for a worker
  private capOX = 0; private capOZ = 0;
  private unloadT = 0;
  /** columns meshed around the view focus (raised with camera zoom, see MAX_RENDER_RADIUS) */
  renderRadius = RENDER_RADIUS;
  get genRadius(): number { return this.renderRadius + 1; }
  private get unloadRadius(): number { return this.renderRadius + 4; }
  /** chunks currently holding meshes (so unloading doesn't scan all 400k chunk slots) */
  private meshed = new Set<VChunk>();

  constructor(game: Game, core: VoxelCore, seed = 1337) {
    this.game = game;
    this.seed = seed;
    this.core = core;
    this.tab = core.tables(CX * CY * CZ);
    sharedUniforms.uDetail.value = makeDetailAtlas();
    this.material = patchWorldMaterial(new THREE.MeshLambertMaterial({ vertexColors: true }), { detail: true, cells: true });
    // one texel per column (in a window around the player) holding the block just below the cut plane
    this.capData = new Uint8Array(CAP_SIZE * CAP_SIZE * 4);
    this.capTex = new THREE.DataTexture(this.capData, CAP_SIZE, CAP_SIZE);
    this.capTex.magFilter = this.capTex.minFilter = THREE.NearestFilter;
    sharedUniforms.uCapTex.value = this.capTex;
    // ?test in the URL: a small flat test area instead of the full world (fast iteration on game logic)
    this.gen = new WorldGen(this.W, this.H, this.D, seed, new URLSearchParams(location.search).has('test'));
    this.gen.slabs = core; // columns generated on the main thread also go straight into shared slabs
    const atlas = makeFoliageAtlas();
    this.foliageMat = patchWorldMaterial(new THREE.MeshLambertMaterial({
      map: atlas, alphaTest: 0.5, side: THREE.FrontSide, vertexColors: true,
    }), { cutaway: false, terrainCut: true, emissive: false, clouds: true, sway: true });
    this.foliageDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: atlas, alphaTest: 0.5 });
    // column generation runs in workers; anything urgent is generated on the main thread instead
    const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2));
    for (let i = 0; i < n; i++) {
      const wk = new Worker(new URL('./genWorker.ts', import.meta.url), { type: 'module' });
      wk.postMessage({ type: 'init', seed, test: this.gen.test, core: core.handle });
      wk.onmessage = (e: MessageEvent<Column>) => {
        this.genBusy[i]--;
        const col = e.data, ci = col.cx + col.cz * CX;
        if (this.colState[ci] === 1) this.installColumn(col);
        else this.freeColumn(col); // generated on the main thread meanwhile, or abandoned
        this.pumpGen();
      };
      wk.onerror = (e) => console.error('worldgen worker error', e);
      this.genWorkers.push(wk); this.genBusy.push(0);
    }
  }

  // ---------------- block access ----------------
  /** global block index (numbers up to ~1.3e10; exact as doubles, but never use `| 0` on them) */
  idx(x: number, y: number, z: number): number { return x + z * this.W + y * this.W * this.D; }
  ix(i: number): number { return i % this.W; }
  iy(i: number): number { return Math.floor(i / (this.W * this.D)); }
  iz(i: number): number { return Math.floor(i / this.W) % this.D; }
  inBounds(x: number, y: number, z: number): boolean { return x >= 0 && y >= 0 && z >= 0 && x < this.W && y < this.H && z < this.D; }

  chunk(cx: number, cy: number, cz: number): VChunk | undefined {
    if (cx < 0 || cy < 0 || cz < 0 || cx >= CX || cy >= CY || cz >= CZ) return undefined;
    return this.chunks[cx + cz * CX + cy * CXZ];
  }
  /** chunk holding block (x, y, z) (integer coordinates) */
  chunkAt(x: number, y: number, z: number): VChunk | undefined {
    if (x < 0 || y < 0 || z < 0 || x >= this.W || y >= this.H || z >= this.D) return undefined;
    return this.chunks[(x >> 5) + (z >> 5) * CX + (y >> 5) * CXZ];
  }

  get(x: number, y: number, z: number): number {
    x |= 0; y |= 0; z |= 0;
    if (y < 0) return B.BEDROCK;
    if (x < 0 || z < 0 || x >= this.W || y >= this.H || z >= this.D) return B.AIR;
    const ch = this.chunks[(x >> 5) + (z >> 5) * CX + (y >> 5) * CXZ];
    if (!ch) return B.AIR;
    return ch.blocks ? ch.blocks[(x & 31) | ((z & 31) << 5) | ((y & 31) << 10)] : ch.fill;
  }
  solid(x: number, y: number, z: number): boolean { return this.get(x, y, z) !== B.AIR; }
  // get(...) !== AIR for integer coordinates, without the truncation
  occ(x: number, y: number, z: number): boolean {
    if (y < 0) return true;
    if (x < 0 || z < 0 || x >= this.W || y >= this.H || z >= this.D) return false;
    const ch = this.chunks[(x >> 5) + (z >> 5) * CX + (y >> 5) * CXZ];
    if (!ch) return false;
    return (ch.blocks ? ch.blocks[(x & 31) | ((z & 31) << 5) | ((y & 31) << 10)] : ch.fill) !== B.AIR;
  }
  solidAt(px: number, py: number, pz: number): boolean { return this.get(Math.floor(px), Math.floor(py), Math.floor(pz)) !== B.AIR; }

  decorAt(x: number, y: number, z: number): number {
    const ch = this.chunkAt(x, y, z);
    return ch && ch.decor ? ch.decor[localIndex(x, y, z)] : 0;
  }
  /** water level byte at a cell (0 when dry or not loaded) */
  waterAt(x: number, y: number, z: number): number {
    const ch = this.chunkAt(x, y, z);
    return ch && ch.water ? ch.water[localIndex(x, y, z)] : 0;
  }
  /** set a cell's water byte; returns false when the chunk isn't loaded */
  setWater(x: number, y: number, z: number, v: number): boolean {
    const ch = this.chunkAt(x, y, z);
    if (!ch) return false;
    if (!ch.water) { if (!v) return true; ch.water = this.core.alloc(); }
    ch.water[localIndex(x, y, z)] = v;
    return true;
  }

  /** a uniform chunk gets a real block array before its first edit */
  private materialize(ch: VChunk): Uint8Array {
    if (!ch.blocks) { ch.blocks = this.core.alloc(); if (ch.fill) ch.blocks.fill(ch.fill); this.syncTable(ch); }
    return ch.blocks;
  }

  // mirror a chunk's arrays into the shared chunk table (array views' byteOffset is their slab address)
  private syncTable(ch: VChunk): void {
    const k = ch.key;
    this.tab.blk[k] = ch.blocks ? ch.blocks.byteOffset : 0;
    this.tab.dec[k] = ch.decor ? ch.decor.byteOffset : 0;
    this.tab.fill[k] = ch.fill;
  }

  private freeColumn(col: Column): void {
    for (const list of [col.blocks, col.decor, col.water]) for (const a of list) this.core.free(a);
  }

  // every chunk whose padded mesher input contains (x, y, z) needs remeshing
  markDirty(x: number, y: number, z: number): void {
    const cx = x >> 5, cy = y >> 5, cz = z >> 5, lx = x & 31, ly = y & 31, lz = z & 31;
    const x0 = lx === 0 ? -1 : 0, x1 = lx === 31 ? 1 : 0;
    const y0 = ly === 0 ? -1 : 0, y1 = ly === 31 ? 1 : 0;
    const z0 = lz === 0 ? -1 : 0, z1 = lz === 31 ? 1 : 0;
    for (let dy = y0; dy <= y1; dy++) for (let dz = z0; dz <= z1; dz++) for (let dx = x0; dx <= x1; dx++) {
      const ch = this.chunk(cx + dx, cy + dy, cz + dz);
      if (ch) ch.dirty = true;
    }
  }

  set(x: number, y: number, z: number, t: number, silent = false): void {
    if (!this.inBounds(x, y, z)) return;
    const ch = this.chunks[(x >> 5) + (z >> 5) * CX + (y >> 5) * CXZ];
    if (!ch) return; // not generated: nothing to edit
    const li = localIndex(x, y, z);
    const prev = ch.blocks ? ch.blocks[li] : ch.fill;
    if (prev === t) return;
    this.materialize(ch)[li] = t;
    const i = this.idx(x, y, z);
    this.damage.delete(i);
    if ((prev !== B.AIR) !== (t !== B.AIR)) {
      if (this.onSolidChange) this.onSolidChange(x, y, z, t !== B.AIR);
      if (this.game.waterSim) this.game.waterSim.onBlockChanged(x, y, z, t !== B.AIR);
    }
    if (prev === B.LANTERN) this.lanterns.delete(i);
    if (t === B.LANTERN) this.lanterns.add(i);
    if (t !== B.AIR) { if (ch.decor) ch.decor[li] = 0; }
    else if (this.burning.has(i)) this.burning.delete(i);
    if (t === B.AIR && y + 1 < this.H) {
      // decor sitting on top of a removed block disappears
      const up = this.chunkAt(x, y + 1, z);
      if (up && up.decor) {
        const ui = localIndex(x, y + 1, z);
        if (up.decor[ui]) { up.decor[ui] = 0; up.modified = true; if (!silent) this.markDirty(x, y + 1, z); }
      }
    }
    ch.modified = true;
    if (!silent) this.markDirty(x, y, z);
    if (y === this.capLayer) this.capDirty = true;
  }

  // ---------------- generation & streaming ----------------
  isGenerated(x: number, z: number): boolean {
    return x >= 0 && z >= 0 && x < this.W && z < this.D && this.colState[(x >> 5) + (z >> 5) * CX] === 2;
  }
  columnReady(cx: number, cz: number): boolean {
    return cx >= 0 && cz >= 0 && cx < CX && cz < CZ && this.colState[cx + cz * CX] === 2;
  }

  /** generate a column on the main thread right now (no-op if it's already generated) */
  ensureColumn(cx: number, cz: number): boolean {
    if (cx < 0 || cz < 0 || cx >= CX || cz >= CZ) return false;
    if (this.colState[cx + cz * CX] === 2) return false;
    this.installColumn(this.gen.generateColumn(cx, cz)); // a worker result for it, if any, is ignored
    return true;
  }

  /** queue a column for the generation workers */
  requestColumn(cx: number, cz: number): void {
    if (cx < 0 || cz < 0 || cx >= CX || cz >= CZ) return;
    const ci = cx + cz * CX;
    if (this.colState[ci]) return;
    this.colState[ci] = 1;
    this.genQueue.push(ci);
    this.pumpGen();
  }
  private pumpGen(): void {
    while (this.genQueue.length) {
      let best = -1;
      for (let i = 0; i < this.genWorkers.length; i++) if (this.genBusy[i] < 2 && (best < 0 || this.genBusy[i] < this.genBusy[best])) best = i;
      if (best < 0) return;
      // nearest column first; columns the player has moved away from are forgotten
      const p = this.game.focus();
      const pcx = p.x / CHUNK - 0.5, pcz = p.z / CHUNK - 0.5;
      let pick = -1, pd = Infinity;
      for (let i = 0; i < this.genQueue.length; i++) {
        const c = this.genQueue[i], d = Math.hypot((c % CX) - pcx, Math.floor(c / CX) - pcz);
        if (d > this.genRadius + 1.5 || this.colState[c] !== 1) { if (this.colState[c] === 1) this.colState[c] = 0; this.genQueue.splice(i--, 1); continue; }
        if (d < pd) { pd = d; pick = i; }
      }
      if (pick < 0) return;
      const ci = this.genQueue.splice(pick, 1)[0];
      this.genBusy[best]++;
      this.genWorkers[best].postMessage({ type: 'gen', cx: ci % CX, cz: Math.floor(ci / CX) });
    }
  }

  private installColumn(col: Column): void {
    const { cx, cz } = col, ci = cx + cz * CX;
    for (let cy = 0; cy < CY; cy++) {
      const key = chunkKey(cx, cy, cz);
      const ch: VChunk = {
        key, cx, cy, cz, blocks: col.blocks[cy], fill: col.fill[cy], decor: col.decor[cy], water: col.water[cy],
        mesh: null, fol: null, dirty: true, modified: false, seq: nextMeshSeq(),
      };
      this.chunks[key] = ch;
      this.syncTable(ch);
      const b = ch.blocks;
      if (b) for (let i = b.indexOf(B.LANTERN); i >= 0; i = b.indexOf(B.LANTERN, i + 1))
        this.lanterns.add(this.idx(cx * CHUNK + (i & 31), cy * CHUNK + (i >> 10), cz * CHUNK + ((i >> 5) & 31)));
    }
    this.colState[ci] = 2;
    this.capDirty = true; // new terrain may fall inside the roof-cap window
    if (this.game.waterSim) this.game.waterSim.activateColumn(cx, cz);
    // neighbouring columns need remeshing for correct borders and AO
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      if (!this.columnReady(cx + dx, cz + dz)) continue;
      for (let cy = 0; cy < CY; cy++) this.chunks[chunkKey(cx + dx, cy, cz + dz)]!.dirty = true;
    }
  }

  // generate everything within `radius` columns right now (used at start-up and after loading)
  generateAround(px: number, pz: number, radius = this.genRadius): void {
    const pcx = Math.floor(px / CHUNK), pcz = Math.floor(pz / CHUNK);
    for (const [dx, dz, d] of RINGS) if (d <= radius) this.ensureColumn(pcx + dx, pcz + dz);
  }

  /** drop a column (meshes, voxels, lanterns, damage, fire) so it regenerates from the seed */
  dropColumn(cx: number, cz: number): void {
    const ci = cx + cz * CX;
    if (!this.colState[ci]) return;
    for (let cy = 0; cy < CY; cy++) {
      const key = chunkKey(cx, cy, cz), ch = this.chunks[key];
      // out of the table first, then the slabs go back to the allocator
      this.tab.fill[key] = ABSENT; this.tab.blk[key] = 0; this.tab.dec[key] = 0;
      if (ch) { this.disposeMeshes(ch); this.core.free(ch.blocks); this.core.free(ch.decor); this.core.free(ch.water); }
      this.chunks[key] = undefined;
    }
    this.colState[ci] = 0;
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const inCol = (i: number) => { const x = this.ix(i), z = this.iz(i); return x >= x0 && x < x0 + CHUNK && z >= z0 && z < z0 + CHUNK; };
    for (const i of this.lanterns) if (inCol(i)) this.lanterns.delete(i);
    for (const i of this.damage.keys()) if (inCol(i)) this.damage.delete(i);
    for (const i of this.burning.keys()) if (inCol(i)) this.burning.delete(i);
    if (this.game.waterSim) this.game.waterSim.dropColumn(cx, cz);
    this.capDirty = true;
  }

  /** wipe a column and generate it again from the seed (used when loading a save) */
  regenColumn(cx: number, cz: number): void {
    this.dropColumn(cx, cz);
    this.ensureColumn(cx, cz);
  }

  /** whether a column has player-made changes (so it must stay in memory) */
  columnModified(cx: number, cz: number): boolean {
    for (let cy = 0; cy < CY; cy++) { const ch = this.chunks[chunkKey(cx, cy, cz)]; if (ch && ch.modified) return true; }
    return false;
  }

  /** every loaded chunk that changed since generation (save games) */
  *modifiedChunks(): Generator<VChunk> {
    for (let ci = 0; ci < CX * CZ; ci++) {
      if (this.colState[ci] !== 2) continue;
      for (let cy = 0; cy < CY; cy++) { const ch = this.chunks[(ci % CX) + Math.floor(ci / CX) * CX + cy * CXZ]; if (ch && ch.modified) yield ch; }
    }
  }

  /** overwrite one chunk from a save (its column must already be generated); arrays are copied into slabs */
  loadChunk(cx: number, cy: number, cz: number, blocks: Uint8Array | null, fill: number, decor: Uint8Array | null, water: Uint8Array | null): void {
    const ch = this.chunk(cx, cy, cz);
    if (!ch) return;
    const x0 = cx * CHUNK, y0 = cy * CHUNK, z0 = cz * CHUNK;
    const lanternAt = (i: number) => this.idx(x0 + (i & 31), y0 + (i >> 10), z0 + ((i >> 5) & 31));
    if (ch.blocks) for (let i = ch.blocks.indexOf(B.LANTERN); i >= 0; i = ch.blocks.indexOf(B.LANTERN, i + 1)) this.lanterns.delete(lanternAt(i));
    else if (ch.fill === B.LANTERN) for (let i = 0; i < CHUNK_VOL; i++) this.lanterns.delete(lanternAt(i));
    const slab = (a: Uint8Array | null) => { if (!a) return null; const s = this.core.alloc(); s.set(a); return s; };
    const old = [ch.blocks, ch.decor, ch.water];
    ch.blocks = slab(blocks); ch.fill = fill; ch.decor = slab(decor); ch.water = slab(water);
    this.syncTable(ch);
    for (const a of old) this.core.free(a);
    ch.seq = nextMeshSeq(); // in-flight jobs may have read the freed slabs
    blocks = ch.blocks;
    if (blocks) for (let i = blocks.indexOf(B.LANTERN); i >= 0; i = blocks.indexOf(B.LANTERN, i + 1)) this.lanterns.add(lanternAt(i));
    ch.modified = true;
    for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const n = this.chunk(cx + dx, cy + dy, cz + dz);
      if (n) n.dirty = true;
    }
    this.capDirty = true;
  }

  // does this chunk produce any geometry? (skips open sky and rock buried on all six sides)
  private needsMesh(ch: VChunk): boolean {
    if (ch.blocks || ch.decor) return true;
    if (ch.fill === B.AIR) return false;
    for (const [dx, dy, dz] of NB6) {
      if (ch.cy + dy < 0) continue; // bedrock below the world
      const n = this.chunk(ch.cx + dx, ch.cy + dy, ch.cz + dz);
      if (!n || n.blocks || n.fill === B.AIR) return true;
    }
    return false;
  }

  private columnNeighboursReady(cx: number, cz: number): boolean {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const a = cx + dx, b = cz + dz;
      if (a >= 0 && b >= 0 && a < CX && b < CZ && this.colState[a + b * CX] !== 2) return false;
    }
    return true;
  }

  // per frame: request nearby columns and (re)mesh visible chunks, nearest first, within a time budget
  stream(px: number, pz: number, dt: number, budgetMs = 4): void {
    const t0 = performance.now();
    const pcx = Math.floor(px / CHUNK), pcz = Math.floor(pz / CHUNK);
    let queued = 0, syncGen = 0;
    const genR = this.genRadius + 0.5, renderR = this.renderRadius;
    for (const [dx, dz, d] of RINGS) {
      if (performance.now() - t0 > budgetMs || d > genR) break;
      const cx = pcx + dx, cz = pcz + dz;
      if (cx < 0 || cz < 0 || cx >= CX || cz >= CZ) continue;
      const ci = cx + cz * CX;
      if (this.colState[ci] !== 2) {
        // the player is about to walk into it: don't wait for a worker
        if (d <= 1.5 && syncGen < 1) { this.ensureColumn(cx, cz); syncGen++; }
        else this.requestColumn(cx, cz);
        continue;
      }
      if (d > renderR || !this.columnNeighboursReady(cx, cz)) continue;
      for (let cy = 0; cy < CY; cy++) {
        const ch = this.chunks[ci + cy * CXZ]!;
        if (!ch.dirty) continue;
        if (!this.needsMesh(ch)) { ch.dirty = false; this.disposeMeshes(ch); ch.seq = nextMeshSeq(); continue; } // (a job in flight is stale)
        // edits right next to the player remesh immediately; everything else goes to the workers
        if ((ch.mesh || ch.fol) && d <= 1.5) { ch.dirty = false; this.applyMesh(this.meshing.meshNow(meshJob(this, ch))); }
        else if (queued < 24 && !this.meshing.pending.has(ch.key)) { ch.dirty = false; this.meshing.request(meshJob(this, ch)); queued++; }
      }
    }
    this.unloadT -= dt;
    if (this.unloadT <= 0) {
      this.unloadT = 0.5;
      // drop meshes that are well outside the view; they rebuild when we come back
      for (const ch of this.meshed) {
        if (Math.hypot(ch.cx - pcx, ch.cz - pcz) <= renderR + 1.5) continue;
        this.disposeMeshes(ch); ch.dirty = true;
      }
      // forget far columns the player never touched
      let dropped = 0;
      for (let ci = 0; ci < CX * CZ && dropped < 8; ci++) {
        if (this.colState[ci] !== 2) continue;
        const cx = ci % CX, cz = Math.floor(ci / CX);
        if (Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz)) <= this.unloadRadius || this.columnModified(cx, cz)) continue;
        if (this.game.physics && this.game.physics.columnInUse(cx, cz)) continue;
        this.dropColumn(cx, cz); dropped++;
      }
    }
  }

  /** mesh-queue priority: distance (in chunks) from the player, Infinity once out of view */
  meshRank(key: number): number {
    const ch = this.chunks[key];
    if (!ch) return Infinity;
    const p = this.game.focus();
    const dx = ch.cx + 0.5 - p.x / CHUNK, dz = ch.cz + 0.5 - p.z / CHUNK, dy = (ch.cy + 0.5 - p.y / CHUNK) * 0.5;
    const d = Math.hypot(dx, dz);
    return d > this.renderRadius + 1.5 ? Infinity : Math.hypot(d, dy);
  }

  private disposeMeshes(ch: VChunk): void {
    for (const m of [ch.mesh, ch.fol]) if (m) { this.group.remove(m); m.geometry.dispose(); }
    ch.mesh = ch.fol = null;
    this.meshed.delete(ch);
  }

  // install a mesh produced by the WASM mesher (main thread or worker)
  applyMesh(d: MeshData, force = false): void {
    const ch = this.chunks[d.key];
    if (!ch) return; // column unloaded while the job was in flight
    if (d.seq < ch.seq) return; // overtaken by a newer mesh, or read voxels that were replaced since
    const p = this.game.focus();
    if (!force && Math.hypot(ch.cx - Math.floor(p.x / CHUNK), ch.cz - Math.floor(p.z / CHUNK)) > this.renderRadius + 1.5) {
      ch.dirty = true; // left the view while in flight; mesh again when it comes back
      return;
    }
    this.disposeMeshes(ch);
    ch.seq = d.seq;
    const sg = solidGeometry(d), fg = foliageGeometry(d);
    const x0 = ch.cx * CHUNK, y0 = ch.cy * CHUNK, z0 = ch.cz * CHUNK;
    if (sg) {
      const m = new THREE.Mesh(sg, this.material);
      m.position.set(x0, y0, z0);
      m.castShadow = m.receiveShadow = true;
      m.matrixAutoUpdate = false; m.updateMatrix();
      this.group.add(m); ch.mesh = m;
    }
    if (fg) {
      const m = new THREE.Mesh(fg, this.foliageMat);
      m.position.set(x0, y0, z0);
      m.castShadow = m.receiveShadow = true;
      m.customDepthMaterial = this.foliageDepth;
      m.matrixAutoUpdate = false; m.updateMatrix();
      this.group.add(m); ch.fol = m;
    }
    if (ch.mesh || ch.fol) this.meshed.add(ch);
  }

  /** mesh every dirty chunk within `radius` columns on the main thread right now (start-up, loading) */
  rebuildAround(px: number, pz: number, radius = 2): void {
    const pcx = Math.floor(px / CHUNK), pcz = Math.floor(pz / CHUNK);
    for (const [dx, dz, d] of RINGS) {
      if (d > radius) continue;
      const cx = pcx + dx, cz = pcz + dz;
      if (!this.columnReady(cx, cz) || !this.columnNeighboursReady(cx, cz)) continue;
      for (let cy = 0; cy < CY; cy++) {
        const ch = this.chunk(cx, cy, cz)!;
        if (!ch.dirty) continue;
        ch.dirty = false;
        if (this.needsMesh(ch)) this.applyMesh(this.meshing.meshNow(meshJob(this, ch)), true);
        else { this.disposeMeshes(ch); ch.seq = nextMeshSeq(); }
      }
    }
  }

  // roof-cap lookup for a window around the player (rewritten when the window moves or the layer changes)
  updateCap(cutY: number, px: number, pz: number): void {
    const layer = cutY - 1;
    const ox = Math.floor(px / 16) * 16 - CAP_SIZE / 2, oz = Math.floor(pz / 16) * 16 - CAP_SIZE / 2;
    if (layer === this.capLayer && !this.capDirty && ox === this.capOX && oz === this.capOZ) return;
    this.capLayer = layer; this.capDirty = false; this.capOX = ox; this.capOZ = oz;
    sharedUniforms.uCapOrigin.value.set(ox, oz);
    const d = this.capData;
    const colors = capColors();
    for (let z = 0, k = 0; z < CAP_SIZE; z++) for (let x = 0; x < CAP_SIZE; x++, k += 4) {
      // below the world is bedrock, above it (or outside it) is air
      const t = this.get(ox + x, layer, oz + z);
      if (t === B.AIR) { d[k + 3] = 0; continue; }
      const c = t * 4;
      d[k] = colors[c]; d[k + 1] = colors[c + 1]; d[k + 2] = colors[c + 2]; d[k + 3] = 255;
    }
    this.capTex.needsUpdate = true;
  }

  /** y of the first air block above the highest solid block in a column (analytic height if not generated) */
  surfaceY(x: number, z: number): number {
    x = Math.floor(x); z = Math.floor(z);
    if (!this.isGenerated(x, z)) return Math.floor(this.gen.heightAt(x, z)) + 1;
    const base = (x >> 5) + (z >> 5) * CX, li = (x & 31) | ((z & 31) << 5);
    for (let cy = CY - 1; cy >= 0; cy--) {
      const ch = this.chunks[base + cy * CXZ]!;
      if (!ch.blocks) { if (ch.fill !== B.AIR) return cy * CHUNK + CHUNK; continue; }
      for (let ly = 31; ly >= 0; ly--) if (ch.blocks[li | (ly << 10)] !== B.AIR) return cy * CHUNK + ly + 1;
    }
    return 0;
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
    // a ray that starts inside a block reports the face it would have entered through
    const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
    let t = 0, nx = 0, ny = 0, nz = 0;
    if (ax >= ay && ax >= az) nx = -sx; else if (ay >= az) ny = -sy; else nz = -sz;
    const maxSteps = Math.min(4096, Math.max(512, Math.ceil(maxDist * 2)));
    for (let i = 0; i < maxSteps; i++) {
      // the bedrock floor only exists under the world, not out in the void around it
      const bt = y < 0 && (x < 0 || z < 0 || x >= this.W || z >= this.D) ? B.AIR : this.get(x, y, z);
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
    if (t === B.AIR || !this.inBounds(x, y, z) || y === 0) return 1; // y = 0 is the bedrock floor
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
    this.markDirty(x, y, z);
    return 1 - dmg / bd.hp;
  }

  // Structural integrity. Every non-terrain block needs a load path to the
  // ground: stacking on a supported block is free, while each horizontal or
  // hanging link costs 1. A block whose cheapest path exceeds its material's
  // span breaks off. Returns the unsupported blocks grouped into clusters.
  // `cells` are edited cells: their neighbours are checked, and the cells themselves when solid (a block just
  // placed or written back as rubble can itself be the one hanging in mid-air)
  findFloating(cells: Iterable<readonly number[]>): FloatingCell[][] {
    const seeds: number[] = [];
    for (const c of cells) for (let n = -1; n < 6; n++) {
      const sx = c[0] + (n < 0 ? 0 : NB6[n][0]), sy = c[1] + (n < 0 ? 0 : NB6[n][1]), sz = c[2] + (n < 0 ? 0 : NB6[n][2]);
      if (!this.inBounds(sx, sy, sz)) continue;
      const t = this.get(sx, sy, sz);
      if (t !== B.AIR && !BLOCKS[t].anchored) seeds.push(this.idx(sx, sy, sz));
    }
    return this.unsupported(seeds);
  }

  unsupported(seeds: number[]): FloatingCell[][] {
    const LIMIT = 6000;
    const out: FloatingCell[][] = [];
    // Dense scratch grids over a 128 x 64 x 128 window around the seeds (local index lx | lz << 7 | ly << 14),
    // with stamps instead of clearing: visit[i] === visitStamp (seen in an earlier component),
    // inComp[i] === compStamp (member of the current component). A component that runs into the window's
    // edge is gathered again with the window centred on what was found so far (a 45-block tower cut at its
    // foot reaches far above a window centred on the cut); only one that can't fit at all is left standing.
    const S = this.sup ??= { visit: new Int32Array(1 << 20), inComp: new Int32Array(1 << 20), cost: new Uint8Array(1 << 20), type: new Uint8Array(1 << 20), comp: new Int32Array(LIMIT + 8), stamp: 0 };
    const { visit, inComp, cost, type, comp } = S;
    const buckets = this.buckets;
    let ox = 0, oy = 0, oz = 0, haveWindow = false, visitStamp = 0;
    const processed: number[] = []; // global idx of every block in a finished component (for window changes)
    const done = new Set<number>();
    const NB = [1, -1, 1 << 14, -(1 << 14), 1 << 7, -(1 << 7)]; // local index offsets, NB6 order
    // move the window so its corner is (x0, y0, z0); blocks seen under the old window are remembered by global index
    const recentre = (x0: number, y0: number, z0: number) => {
      if (haveWindow) for (const g of processed) done.add(g);
      ox = x0; oy = y0; oz = z0; haveWindow = true;
      visitStamp = ++S.stamp;
    };
    for (const si of seeds) {
      const sx = this.ix(si), sy = this.iy(si), sz = this.iz(si);
      if (!haveWindow || sx - ox < 8 || sx - ox >= 120 || sy - oy < 8 || sy - oy >= 56 || sz - oz < 8 || sz - oz >= 120) recentre(sx - 64, sy - 32, sz - 64);
      if (done.size && done.has(si)) continue;
      if (visit[(sx - ox) | ((sz - oz) << 7) | ((sy - oy) << 14)] === visitStamp) continue;
      const t0 = this.get(sx, sy, sz);
      if (t0 === B.AIR || BLOCKS[t0].anchored) continue;
      // 1. gather the connected component of non-anchored blocks
      let compStamp = 0, len = 0, big = false;
      for (let attempt = 0; ; attempt++) {
        const s0 = (sx - ox) | ((sz - oz) << 7) | ((sy - oy) << 14);
        compStamp = ++S.stamp; len = 0; big = false;
        comp[len++] = s0; inComp[s0] = compStamp; type[s0] = t0; cost[s0] = NO_COST;
        let edge = false;
        for (let h = 0; h < len && !big; h++) {
          const ci = comp[h];
          const lx = ci & 127, lz = (ci >> 7) & 127, ly = ci >> 14;
          for (let n = 0; n < 6; n++) {
            const nx = lx + NB6[n][0], ny = ly + NB6[n][1], nz = lz + NB6[n][2];
            const t = this.get(nx + ox, ny + oy, nz + oz);
            if (t === B.AIR || BLOCKS[t].anchored) continue;
            // members stay off the window's outer layer, so the index offsets below never wrap
            if (nx < 1 || ny < 1 || nz < 1 || nx > 126 || ny > 62 || nz > 126) { big = edge = true; break; }
            const ni = ci + NB[n];
            if (inComp[ni] === compStamp) continue;
            if (len >= LIMIT) { big = true; break; }
            inComp[ni] = compStamp; type[ni] = t; cost[ni] = NO_COST; comp[len++] = ni;
          }
        }
        if (!edge || attempt >= 3) break;
        // re-centre on the bounding box gathered so far (it always holds the seed), unless it can't fit anyway
        let x0 = 127, y0 = 63, z0 = 127, x1 = 0, y1 = 0, z1 = 0;
        for (let h = 0; h < len; h++) {
          const ci = comp[h], lx = ci & 127, lz = (ci >> 7) & 127, ly = ci >> 14;
          if (lx < x0) x0 = lx; if (lx > x1) x1 = lx; if (ly < y0) y0 = ly; if (ly > y1) y1 = ly; if (lz < z0) z0 = lz; if (lz > z1) z1 = lz;
        }
        if (x1 - x0 > 120 || y1 - y0 > 56 || z1 - z0 > 120) break;
        recentre(ox + ((x0 + x1) >> 1) - 64, oy + ((y0 + y1) >> 1) - 32, oz + ((z0 + z1) >> 1) - 64);
      }
      for (let h = 0; h < len; h++) { visit[comp[h]] = visitStamp; processed.push(this.idx((comp[h] & 127) + ox, (comp[h] >> 14) + oy, ((comp[h] >> 7) & 127) + oz)); }
      if (big) continue;
      // 2. bucketed 0-1 shortest path from blocks touching terrain
      for (const bk of buckets) bk.length = 0;
      let supported = 0;
      for (let h = 0; h < len; h++) {
        const ci = comp[h];
        const x = (ci & 127) + ox, z = ((ci >> 7) & 127) + oz, y = (ci >> 14) + oy;
        const below = this.get(x, y - 1, z);
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
          for (let n = 0; n < 6; n++) {
            const ni = ci + NB[n];
            if (inComp[ni] !== compStamp) continue;
            // stacking is free and always holds: a block resting on a supported one is supported whatever its own
            // span (a lantern or crate on top of a wall 2 links from the ground used to count as over its span of
            // 1, fell, came to rest on the same wall, was written back and fell again, forever)
            const up = NB6[n][1] > 0, nc = c + (up ? 0 : 1);
            if (!up && nc > BLOCKS[type[ni]].span) continue;
            const old = cost[ni];
            if (old !== NO_COST && old <= nc) continue;
            if (old === NO_COST) supported++;
            cost[ni] = nc;
            buckets[nc].push(ni);
          }
        }
      }
      if (supported === len) continue;
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
          cl.push([(ci & 127) + ox, (ci >> 14) + oy, ((ci >> 7) & 127) + oz, type[ci]]);
          for (let n = 0; n < 6; n++) {
            const ni = ci + NB[n];
            if (inComp[ni] === compStamp && cost[ni] === NO_COST) { cost[ni] = TAKEN; queue.push(ni); }
          }
        }
        out.push(cl);
      }
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
    this.markDirty(x, y, z);
    return true;
  }

  updateFire(dt: number): void {
    this.fireTick += dt;
    const burning = this.burning;
    if (!burning.size) { if (this.fireTick >= 0.2) this.fireTick = 0; return; }
    const g = this.game;
    // visual emission every frame
    let n = 0;
    const emitP = Math.min(1, 140 / Math.max(1, burning.size));
    for (const i of burning.keys()) {
      if (Math.random() > emitP * dt * 30) continue;
      const x = this.ix(i), z = this.iz(i), y = this.iy(i);
      g.particles.fire(x + 0.2 + Math.random() * 0.6, y + 0.9 + Math.random() * 0.3, z + 0.2 + Math.random() * 0.6);
      if (++n > 200) break;
    }
    if (this.fireTick < 0.2) return;
    const step = this.fireTick; this.fireTick = 0;
    const done: number[] = []; // block indices that finished burning
    const spread: number[] = []; // flat x, y, z triples
    for (const [i, tl] of burning) {
      const x = this.ix(i), z = this.iz(i), y = this.iy(i);
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
      const x = this.ix(i), z = this.iz(i), y = this.iy(i);
      burning.delete(i);
      const t = this.get(x, y, z);
      if (!BLOCKS[t].flammable) continue; // replaced by something that cannot burn while it was alight
      if (t === B.GRASS) { this.set(x, y, z, B.SCORCH); continue; }
      if (t === B.TNT || t === B.BARREL) { this.set(x, y, z, B.AIR); g.onBlockDestroyed(x, y, z, t, 'fire'); continue; }
      this.set(x, y, z, B.AIR);
      g.particles.smokePuff(x + 0.5, y + 0.5, z + 0.5, 3);
      removed.push([x, y, z]);
    }
    if (removed.length) g.checkSupport(removed);
  }
}
