// Rapier-backed rigid body physics for destruction.
//  - the voxel terrain near the player and around every dynamic body is mirrored into one Rapier `voxels`
//    collider per 32³ chunk, holding only the shell of solid cells next to air (buried rock is
//    never collided with). Colliders are massless (density 0): a fixed body's mass properties are otherwise
//    recomputed over every voxel on the first step after an insert or edit, which was the 50-100 ms stall.
//    Builds are budgeted per frame, nearest-to-need first; chunks a falling body is about to enter are built
//    ahead of it, and kept in sync on every edit with seams coupled between neighbours
//  - structures that lose support become dynamic voxel bodies with real mass & inertia,
//    so they pivot over their remaining contact edge and topple instead of dropping straight down
//  - on a hard impact they shatter into individual rigid bricks (Angry Birds style)
//  - bricks that come to rest are written back into the voxel world as rubble
//  - bodies in water (the voxel water levels, which include the sea's source cells) get buoyancy per block at
//    the block's submerged part, so wood floats, rights itself and bobs while stone sinks slowly; floating
//    bodies stay alive (never written into the grid mid-water) until they wash ashore or get waterlogged
import * as THREE from 'three';
import type { RigidBody, World as RapierWorld, Collider, EventQueue } from '@dimforge/rapier3d-compat';
import { B, BLOCKS, patchWorldMaterial, tileFor, CHUNK } from './world';
import type { VChunk, World } from './world';
import type { Game } from './main';
import type { Entity } from './entities';

export type RapierModule = typeof import('@dimforge/rapier3d-compat');
/** [x, y, z, blockType] */
export type ChunkBlock = [number, number, number, number];
interface RigidChunk {
  body: RigidBody; mesh: THREE.Mesh; blocks: ChunkBlock[]; ox: number; oy: number; oz: number;
  /** block centres in body-local space, xyz triplets (for the crush test) */
  local: Float32Array;
  /** half the diagonal of its bounding box */
  radius: number;
  /** size of its bounding box (body-local, from the origin corner) */
  size: THREE.Vector3;
  prevV: THREE.Vector3; t: number; still: number; hit: Set<Entity>;
  /** material density of each block (water = 1) */
  dens: Float32Array;
  /** buoyancy scale: the collider gives every block mass 1, the real mass is the sum of densities, so a fully
   *  submerged block lifts N / sum(dens) instead of 1 (exactly the right waterline for the whole body) */
  kb: number;
  /** average density < 1: floats; mixed: blocks of different densities (gets the ballast torque, see waterChunk) */
  light: boolean; mixed: boolean;
  /** water state, see Wet */
  w: Wet;
  /** seconds since it was last in water (a hard hit right after entering water doesn't shatter it) */
  dryT: number;
}
/** what a body knows about the water it's in */
interface Wet {
  /** submerged fraction of the body last step (0 when dry) */
  f: number;
  /** seconds spent floating (wet and lighter than water): drives washing out / waterlogging */
  floatT: number;
  /** the body's mass (constant; read once, every wasm call counts at 60 Hz × hundreds of bodies) */
  mass: number;
  /** angular damping when dry, and the value currently set */
  damp0: number; damp: number;
  /** there's water in a chunk around the body this frame (cheap gate before any per-block lookup) */
  gate: boolean;
}
interface Brick { body: RigidBody; type: number; t: number; still: number; color: THREE.Color; slot: number; w: Wet }
interface RigidTnt { grp: THREE.Group; mat: THREE.MeshLambertMaterial; band: THREE.MeshLambertMaterial; body: RigidBody; fuse: number; t: number; total: number; w: Wet }

/** a mirrored terrain chunk: its collider and which cells it holds (bit x of word (y << 5) | z) */
interface TerrainCol { col: Collider; bits: Int32Array }
/** a chunk's shell, computed but not yet turned into a collider; n = number of cells */
interface PendingShell { bits: Int32Array; n: number }

const STEP = 1 / 60;
// terrain colliders exist for chunks within this many 32-block chunks of the player (and one chunk up/down)
const PHYS_RADIUS = 1;
// main-thread time per frame for building terrain colliders (chunks a body is touching ignore it)
const BUILD_MS = 2.5;
// falling bodies are capped at this speed (blocks/s): a 0.96 cube moving < 1.96 cells per 1/60 s step always
// overlaps a 1-cell-thick shell on some step, so it can't tunnel through. Roughly a tumbling brick's terminal
// velocity anyway. (Measured: Rapier still pushes cubes back out the top of a 1-thick voxel shell at 2.3 cells
// per step; the cap keeps a margin.)
const MAX_SPEED = 40;
// seconds of travel ahead of a moving body whose terrain is built in advance
const LOOKAHEAD = 0.4;
// bodies further than this from the player (blocks, horizontally) are frozen into rubble
const KEEP_DIST = 160;
const MAX_BRICKS = 240;
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _s = new THREE.Vector3(1, 1, 1);
const _qi = new THREE.Quaternion(), _c = new THREE.Vector3(), _o = new THREE.Vector3();
const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;
const TRI_FRONT = [0, 1, 2, 0, 2, 3], TRI_BACK = [0, 2, 1, 0, 3, 2];
// chunk offsets mirrored around the player, nearest first
const PLAYER_AREA: [number, number, number][] = [];
for (let dy = -1; dy <= 1; dy++) for (let dz = -PHYS_RADIUS; dz <= PHYS_RADIUS; dz++) for (let dx = -PHYS_RADIUS; dx <= PHYS_RADIUS; dx++) PLAYER_AREA.push([dx, dy, dz]);
PLAYER_AREA.sort((a, b) => (a[0] ** 2 + a[1] ** 2 * 2 + a[2] ** 2) - (b[0] ** 2 + b[1] ** 2 * 2 + b[2] ** 2));
// scratch: padded occupancy rows of the chunk being mirrored
const _rows = new Int32Array(34 * 34);

// ---------- water ----------
// Buoyancy uses the voxel water levels (world.waterAt & 15 = 1..8 eighths of a cell; the sea is source cells of
// level 8 below WATER_LEVEL, so it needs no special case). Gravity is 25 blocks/s², water density 1.
export const GRAV = 25;
/** material density per block type (water = 1): wood floats, TNT floats low, stone and metal sink */
export const DENSITY = new Float32Array(256).fill(2);
for (const [t, d] of [
  [B.LOG, 0.6], [B.PLANKS, 0.5], [B.CRATE, 0.55], [B.BARREL, 0.5], [B.ROOF, 0.65], [B.LEAVES, 0.3], [B.TNT, 0.85],
  [B.SNOW, 0.9], [B.LANTERN, 1.3], [B.GRASS, 1.4], [B.DIRT, 1.5], [B.SAND, 1.8], [B.SCORCH, 1.6], [B.BRICK, 1.9],
  [B.COBBLE, 2.2], [B.STONE, 2.4], [B.BEDROCK, 3], [B.ORE, 3.2], [B.METAL, 4.5],
] as [number, number][]) DENSITY[t] = d;
// drag in water, per unit of submerged mass: linear (1/s) plus quadratic (per block/s) on the velocity relative to
// the current, so stone sinks at ~3.5 blocks/s and a brick flung in at 40 stops within a block or two
const DRAG_LIN = 1.2, DRAG_QUAD = 0.8;
// extra angular damping while fully wet
const DRAG_ANG = 0.8;
// floating bodies drift with a current of this speed (blocks/s) and bob on a swell of this height (blocks)
const CURRENT = 0.35, SWELL = 0.06;
// seconds a light body floats before it gets waterlogged (buoyancy fades to WATERLOGGED over SINK_S seconds) and
// sinks out of sight, unless it washed ashore first
const FLOAT_LIFE_BRICK = 40, FLOAT_LIFE_CHUNK = 60, SINK_S = 4, WATERLOGGED = 0.3;

/** height of the water surface in column (x, z), scanning cells y1 down to y0 (-Infinity: none in range) */
export function waterTop(w: World, x: number, z: number, y0: number, y1: number): number {
  for (let y = y1; y >= y0; y--) {
    const L = w.waterAt(x, y, z) & 15;
    if (L) return (w.waterAt(x, y + 1, z) & 15) ? y + 1 : y + L / 8;
  }
  return -Infinity;
}
/** a gentle swell on the surface height (so floating things bob and rock a little) */
export function swell(x: number, z: number, t: number): number {
  return SWELL * (Math.sin(x * 0.7 + t * 1.7) + Math.cos(z * 0.6 - t * 1.3) * 0.8) * 0.5;
}
/** the slow surface current at a point: a direction that wanders with place and time */
export function current(x: number, z: number, t: number): [number, number] {
  const a = Math.sin(x * 0.021 + t * 0.03) * 1.6 + Math.cos(z * 0.017 - t * 0.02) * 1.6 + t * 0.01;
  return [Math.cos(a) * CURRENT, Math.sin(a) * CURRENT];
}
/** buoyancy multiplier of a floating body: 1, fading to WATERLOGGED once it has floated for `life` seconds */
export function waterlog(floatT: number, life: number): number {
  return floatT < life ? 1 : Math.max(WATERLOGGED, 1 - (floatT - life) / SINK_S);
}
/** whether any loaded chunk overlapping a world box holds water */
export function boxWet(w: World, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
  for (let cy = Math.max(0, Math.floor(y0 / CHUNK)); cy <= Math.floor(y1 / CHUNK); cy++)
    for (let cz = Math.floor(z0 / CHUNK); cz <= Math.floor(z1 / CHUNK); cz++)
      for (let cx = Math.floor(x0 / CHUNK); cx <= Math.floor(x1 / CHUNK); cx++) {
        const ch = w.chunk(cx, cy, cz);
        if (ch && ch.water) return true;
      }
  return false;
}
/** splash where something hit the water: droplets thrown up and out, a little mist, and a sploosh scaled by
 *  size and speed (s in 0..1) and the distance to the player */
export function splash(g: Game, x: number, y: number, z: number, s: number): void {
  const P = g.particles.smoke, rs = (k: number) => (Math.random() - 0.5) * 2 * k;
  const n = Math.round(5 + s * 22);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, r = (0.6 + Math.random()) * (1 + s * 2);
    const k = 0.85 + Math.random() * 0.15;
    P.spawn(x + Math.cos(a) * 0.3, y + 0.05, z + Math.sin(a) * 0.3, Math.cos(a) * r, 3 + Math.random() * (3 + s * 7), Math.sin(a) * r,
      0.5 + Math.random() * 0.5, 0.26 + s * 0.2, 0.12, 0.8 * k, 0.92 * k, 1, 0.9, 18, 0.4);
  }
  for (let i = 0; i < 3 + s * 8; i++) P.spawn(x + rs(0.5 + s), y + 0.1, z + rs(0.5 + s), rs(1), 0.6 + Math.random(), rs(1), 0.6 + Math.random() * 0.5, 0.5 + s * 0.6, 1.4 + s * 2, 0.92, 0.97, 1, 0.6, 0, 1.5);
  const d = Math.hypot(x - g.player.pos.x, y - g.player.pos.y, z - g.player.pos.z), v = Math.max(0, 1 - d / 48) * (0.3 + s * 0.7);
  if (v > 0.03 && g.audio.gate('splash', 90)) {
    g.audio.noise(0.25 + s * 0.4, { freq: 2200 - s * 900, to: 250, vol: 0.35 * v, attack: 0.004 });
    g.audio.tone(320 - s * 140, 0.14 + s * 0.12, { to: 90, vol: 0.12 * v, type: 'sine' });
  }
}
/** bubbles where a waterlogged body sinks away */
export function bubbles(g: Game, x: number, y: number, z: number, n: number): void {
  for (let i = 0; i < n; i++) g.particles.smoke.spawn(x + (Math.random() - 0.5) * 1.2, y, z + (Math.random() - 0.5) * 1.2, 0, 1 + Math.random(), 0, 0.6 + Math.random() * 0.6, 0.12, 0.25, 0.8, 0.92, 1, 0.7, -2, 1);
}
const newWet = (damp0: number, mass: number): Wet => ({ f: 0, floatT: 0, mass, damp0, damp: damp0, gate: false });

/** which Rapier build loaded ('SIMD', 'scalar' or 'none') */
export let rapierBuild = 'none';

// the SIMD build first (every current browser has wasm SIMD), then the scalar build, then the built-in
// fallback physics in physics.ts. `?rapier=scalar` / `?rapier=off` force the later ones (for testing).
export async function loadRapier(): Promise<RapierModule | null> {
  const want = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('rapier') : null;
  if (want === 'off') { console.info('physics: built-in fallback (forced)'); return null; }
  const builds: [string, () => Promise<unknown>][] = [
    ['SIMD', () => import('@dimforge/rapier3d-simd-compat')],
    ['scalar', () => import('@dimforge/rapier3d-compat')],
  ];
  for (const [name, load] of builds) {
    if (want === 'scalar' && name === 'SIMD') continue;
    try {
      const mod = await load() as { default?: RapierModule } & RapierModule;
      // both packages expose the same API; the SIMD one's classes are just distinct types to TypeScript
      const R = (mod.default || mod) as RapierModule;
      await R.init();
      new R.World({ x: 0, y: 0, z: 0 }).free(); // instantiating actually exercises the module
      console.info(`physics: Rapier ${R.version()} (${name} build)`);
      rapierBuild = name;
      return R;
    } catch (e) {
      console.warn(`Rapier ${name} build failed to load:`, e);
    }
  }
  console.warn('Rapier unavailable, using built-in physics fallback');
  return null;
}

export class RigidPhysics {
  game: Game;
  R: RapierModule;
  rw: RapierWorld;
  eq: EventQueue;
  terrain = new Map<number, TerrainCol | null>(); // chunk key -> voxels collider (null: none needed)
  private terrainT = 0;
  private urgent = new Set<number>(); // chunks touched by a dynamic body
  private ahead = new Set<number>(); // chunks along a moving body's path
  private bodyCols = new Set<number>(); // columns (cx + cz * 65536) holding either
  private queue: number[] = [];
  private shells = new Map<number, PendingShell>(); // stage-1 results waiting for the next frame's budget
  private perVoxel = 0.0008; // ms per shell cell to create and couple a collider (running average)
  /** running counters for profiling (reset by whoever reads them) */
  stats = { builds: 0, buildMs: 0, buildMax: 0, shellMs: 0, createMs: 0, combineMs: 0, voxels: 0, editMs: 0, deferred: 0, aheadBuilt: 0, frozen: 0, waterMs: 0 };
  ground: RigidBody;
  acc: number;
  chunks: RigidChunk[];
  bricks: Brick[];
  tnts: RigidTnt[];
  chunkMat: THREE.MeshLambertMaterial;
  brickMesh: THREE.InstancedMesh;
  tntGeo: THREE.BoxGeometry;
  bandGeo: THREE.BoxGeometry;

  constructor(game: Game, R: RapierModule) {
    this.game = game; this.R = R;
    const w = game.world;
    this.rw = new R.World({ x: 0, y: -25, z: 0 });
    this.rw.timestep = STEP;
    this.rw.numSolverIterations = 4;
    this.eq = new R.EventQueue(true);
    this.ground = this.rw.createRigidBody(R.RigidBodyDesc.fixed());
    w.onSolidChange = (x, y, z, solid) => this.onVoxel(x, y, z, solid);
    this.acc = 0;
    this.chunks = [];
    this.bricks = [];
    this.tnts = [];
    this.chunkMat = patchWorldMaterial(new THREE.MeshLambertMaterial({ vertexColors: true }), { cutaway: false, emissive: true, clouds: false, detail: true });
    // bricks: one instanced cube with baked face shading (top bright, sides mid, bottom dark)
    const geo = new THREE.BoxGeometry(0.96, 0.96, 0.96);
    const shade: number[] = [], n = geo.attributes.normal;
    for (let i = 0; i < n.count; i++) { const k = n.getY(i) > 0.5 ? 1.08 : n.getY(i) < -0.5 ? 0.6 : 0.86; shade.push(k, k, k); }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(shade, 3));
    this.brickMesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }), MAX_BRICKS);
    this.brickMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.brickMesh.castShadow = this.brickMesh.receiveShadow = true;
    this.brickMesh.frustumCulled = false;
    for (let i = 0; i < MAX_BRICKS; i++) this.brickMesh.setColorAt(i, new THREE.Color(1, 1, 1));
    this.brickMesh.count = 0;
    game.scene.add(this.brickMesh);
    this.tntGeo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
    this.bandGeo = new THREE.BoxGeometry(0.94, 0.3, 0.94);
    // mirror the start area now, while the title screen loads, instead of on the first frames of play
    const s = w.gen.spawn;
    this.prebuild(s.x, w.surfaceY(s.x, s.z + 16), s.z + 16);
  }

  // ---------- streamed terrain colliders ----------
  // Occupancy is handled as 32-bit rows: bit x of row (y, z) is the cell (x, y, z) of a chunk. The shell of a
  // chunk is every solid cell with an air face neighbour (bodies can't reach the rest, see MAX_SPEED). Rows
  // outside the chunk come from its neighbours: unloaded ones count as air (extra collision, never a hole),
  // below the world as solid.
  private nbRow(cx: number, cy: number, cz: number, ly: number, lz: number): number {
    if (cy < 0) return -1;
    const ch = this.game.world.chunk(cx, cy, cz);
    if (!ch) return 0;
    if (!ch.blocks) return ch.fill !== B.AIR ? -1 : 0;
    const b = ch.blocks, base = (lz << 5) | (ly << 10);
    let m = 0;
    for (let x = 0; x < 32; x++) if (b[base + x]) m |= 1 << x;
    return m;
  }
  private nbCell(cx: number, cy: number, cz: number, i: number): number {
    const ch = this.game.world.chunk(cx, cy, cz);
    if (!ch) return 0;
    return (ch.blocks ? ch.blocks[i] : ch.fill) !== B.AIR ? 1 : 0;
  }

  /** shell rows of a chunk (null when there is nothing to collide with: open sky, or rock buried on all sides) */
  private shell(ch: VChunk): Int32Array | null {
    const { cx, cy, cz } = ch, w = this.game.world;
    if (!ch.blocks) {
      if (ch.fill === B.AIR) return null;
      let open = false; // uniform rock: only the sides that face something other than rock matter
      for (const [dx, dy, dz] of DIRS) {
        if (cy + dy < 0) continue;
        const n = w.chunk(cx + dx, cy + dy, cz + dz);
        if (!n || n.blocks || n.fill === B.AIR) { open = true; break; }
      }
      if (!open) return null;
    }
    // padded solid rows over y, z in [-1, 33)
    const rows = _rows, b = ch.blocks, PW = 34;
    for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) {
      let m = 0;
      if (!b) m = -1;
      else { const base = (z << 5) | (y << 10); for (let x = 0; x < 32; x++) if (b[base + x]) m |= 1 << x; }
      rows[(y + 1) * PW + z + 1] = m;
    }
    for (let i = 0; i < 32; i++) {
      rows[i + 1] = this.nbRow(cx, cy - 1, cz, 31, i); // y = -1
      rows[33 * PW + i + 1] = this.nbRow(cx, cy + 1, cz, 0, i); // y = 32
      rows[(i + 1) * PW] = this.nbRow(cx, cy, cz - 1, i, 31); // z = -1
      rows[(i + 1) * PW + 33] = this.nbRow(cx, cy, cz + 1, i, 0); // z = 32
    }
    const out = new Int32Array(1024);
    let any = 0;
    for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) {
      const r = (y + 1) * PW + z + 1, s = rows[r];
      if (!s) continue;
      const e = ~rows[r - PW] | ~rows[r + PW] | ~rows[r - 1] | ~rows[r + 1];
      // y / z neighbours are whole rows; x neighbours are the row shifted, its two end cells look next door
      const li = (y << 10) | (z << 5), a = ~s;
      let m = s & (e | (a << 1) | (a >>> 1));
      if ((s & 1) && !(m & 1) && !this.nbCell(cx - 1, cy, cz, li | 31)) m |= 1; // air at x = -1
      if ((s >>> 31) && !(m >>> 31) && !this.nbCell(cx + 1, cy, cz, li)) m |= 1 << 31; // air at x = 32
      any |= out[(y << 5) | z] = m;
    }
    return any ? out : null;
  }

  // Building is two stages, so the frame budget can stop between them: the shell (JS, ~0.3 ms) and the
  // collider itself (Rapier, cost proportional to the shell's voxel count, which the first stage tells us).
  private prepare(key: number): PendingShell | null {
    const t0 = performance.now();
    const ch = this.game.world.chunks[key];
    const bits = ch ? this.shell(ch) : null;
    this.stats.shellMs += performance.now() - t0;
    if (!bits) { if (ch) this.terrain.set(key, null); return null; }
    let n = 0;
    for (let i = 0; i < 1024; i++) { let v = bits[i]; while (v) { v &= v - 1; n++; } }
    const sh = { bits, n };
    this.shells.set(key, sh);
    return sh;
  }

  // one massless voxels collider per chunk, on its own fixed body (attaching to one shared body makes every
  // insertion re-process all of that body's colliders on the next step)
  private commit(key: number, sh: PendingShell): void {
    const t0 = performance.now();
    const w = this.game.world, R = this.R, ch = w.chunks[key]!, { bits, n } = sh;
    this.shells.delete(key);
    const pts = new Int32Array(n * 3);
    for (let i = 0, k = 0; i < 1024; i++) {
      let v = bits[i];
      while (v) { const x = 31 - Math.clz32(v & -v); v &= v - 1; pts[k++] = x; pts[k++] = i >> 5; pts[k++] = i & 31; }
    }
    const body = this.rw.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(ch.cx * CHUNK, ch.cy * CHUNK, ch.cz * CHUNK));
    const col = this.rw.createCollider(R.ColliderDesc.voxels(pts, { x: 1, y: 1, z: 1 })
      .setDensity(0).setFriction(0.9).setRestitution(0.05), body);
    const t1 = performance.now();
    // couple with loaded neighbours so bodies don't snag on the internal edges between chunks
    for (const [dx, dy, dz] of DIRS) {
      const nb = w.chunk(ch.cx + dx, ch.cy + dy, ch.cz + dz);
      const nc = nb && this.terrain.get(nb.key);
      if (nc) col.combineVoxelStates(nc.col, dx * CHUNK, dy * CHUNK, dz * CHUNK);
    }
    this.terrain.set(key, { col, bits });
    const t2 = performance.now(), dt = t2 - t0;
    if (n > 200) this.perVoxel = Math.min(0.005, Math.max(0.0002, this.perVoxel * 0.8 + dt / n * 0.2));
    const S = this.stats;
    S.createMs += t1 - t0; S.combineMs += t2 - t1; S.builds++; S.buildMs += dt; S.buildMax = Math.max(S.buildMax, dt); S.voxels += n;
  }

  private buildChunkCollider(key: number): void {
    const sh = this.shells.get(key) || this.prepare(key);
    if (sh) this.commit(key, sh);
  }

  private dropCollider(key: number): void {
    const tc = this.terrain.get(key);
    if (tc) this.rw.removeRigidBody(tc.col.parent()!);
    this.terrain.delete(key);
  }

  // add / remove one cell of a mirrored chunk, keeping the seam coupling with its neighbours up to date
  private setCell(ch: VChunk, tc: TerrainCol, lx: number, ly: number, lz: number, solid: boolean): void {
    const wi = (ly << 5) | lz, bit = 1 << lx;
    if (((tc.bits[wi] & bit) !== 0) === solid) return;
    tc.bits[wi] ^= bit;
    tc.col.setVoxel(lx, ly, lz, solid);
    for (const [dx, dy, dz] of DIRS) {
      if ((dx === 1 && lx !== 31) || (dx === -1 && lx !== 0) || (dy === 1 && ly !== 31) || (dy === -1 && ly !== 0) || (dz === 1 && lz !== 31) || (dz === -1 && lz !== 0)) continue;
      const n = this.game.world.chunk(ch.cx + dx, ch.cy + dy, ch.cz + dz);
      const nc = n && this.terrain.get(n.key);
      if (nc) tc.col.propagateVoxelChange(nc.col, lx, ly, lz, dx * CHUNK, dy * CHUNK, dz * CHUNK);
    }
  }

  // make sure a solid cell is in its chunk's collider (it just got an air neighbour)
  private expose(x: number, y: number, z: number): void {
    const w = this.game.world;
    if (!w.occ(x, y, z)) return;
    const ch = w.chunkAt(x, y, z);
    if (ch) this.shells.delete(ch.key);
    if (!ch || !this.terrain.has(ch.key)) return;
    const tc = this.terrain.get(ch.key);
    if (tc) this.setCell(ch, tc, x & 31, y & 31, z & 31, true);
    else this.terrain.delete(ch.key); // buried / empty until now: rebuild it (bodies' chunks first)
  }

  private onVoxel(x: number, y: number, z: number, solid: boolean): void {
    const t0 = performance.now();
    const w = this.game.world, ch = w.chunkAt(x, y, z);
    if (ch) this.shells.delete(ch.key);
    if (ch && this.terrain.has(ch.key)) {
      const tc = this.terrain.get(ch.key);
      if (!tc) { if (solid) this.terrain.delete(ch.key); } // a block placed in an empty chunk: rebuild it
      else this.setCell(ch, tc, x & 31, y & 31, z & 31, solid);
    }
    // a removed cell exposes its solid neighbours (a placed one may bury some: they simply stay in the collider)
    if (!solid) {
      this.expose(x + 1, y, z); this.expose(x - 1, y, z); this.expose(x, y + 1, z);
      this.expose(x, y - 1, z); this.expose(x, y, z + 1); this.expose(x, y, z - 1);
    }
    this.stats.editMs += performance.now() - t0;
  }

  // chunks a dynamic body needs: the ones it touches (urgent: built regardless of the frame budget) and the
  // ones along its velocity for the next LOOKAHEAD seconds (built ahead of it, first in the budgeted queue)
  private bodyChunks(): void {
    const w = this.game.world, urgent = this.urgent, ahead = this.ahead, cols = this.bodyCols;
    urgent.clear(); ahead.clear(); cols.clear();
    // every chunk overlapping a world box (a box is never wider than a few chunks, see below)
    const cover = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, into: Set<number>) => {
      for (let cy = Math.floor(y0 / CHUNK); cy <= Math.floor(y1 / CHUNK); cy++)
        for (let cz = Math.floor(z0 / CHUNK); cz <= Math.floor(z1 / CHUNK); cz++)
          for (let cx = Math.floor(x0 / CHUNK); cx <= Math.floor(x1 / CHUNK); cx++) {
            const ch = w.chunk(cx, cy, cz);
            if (!ch || (into === ahead && urgent.has(ch.key))) continue;
            into.add(ch.key); cols.add(ch.cx + ch.cz * 65536);
          }
    };
    // a body's world box is its centre c ± h (plus a 2-block margin): the chunks it touches are urgent, and the
    // box swept along its velocity for the next LOOKAHEAD seconds is built ahead of it. Spinning bodies sweep
    // further: a toppling tower's tip moves at |ω| times its length, far faster than its origin.
    const add = (b: RigidBody, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, reach: number) => {
      cover(cx - hx - 2, cy - hy - 2, cz - hz - 2, cx + hx + 2, cy + hy + 2, cz + hz + 2, urgent);
      if (b.isSleeping()) return;
      const v = b.linvel(), a = b.angvel();
      const spin = Math.min(16, Math.hypot(a.x, a.y, a.z) * reach * LOOKAHEAD);
      if (v.x * v.x + v.y * v.y + v.z * v.z < 4 && spin < 1) return;
      // sample the path every half chunk, so no chunk along it is skipped
      const L = Math.hypot(v.x, v.y, v.z) * LOOKAHEAD, n = Math.max(1, Math.ceil(L / 16));
      const ex = hx + 2 + spin, ey = hy + 2 + spin, ez = hz + 2 + spin;
      for (let s = 1; s <= n; s++) {
        const f = LOOKAHEAD * s / n, px = cx + v.x * f, py = cy + v.y * f, pz = cz + v.z * f;
        cover(px - ex, py - ey, pz - ez, px + ex, py + ey, pz + ez, ahead);
      }
    };
    // (and per body, whether any chunk within reach of it this frame holds water: the gate before buoyancy lookups)
    for (const b of this.bricks) { const t = b.body.translation(); add(b.body, t.x, t.y, t.z, 0.5, 0.5, 0.5, 1); b.w.gate = boxWet(w, t.x - 3, t.y - 3, t.z - 3, t.x + 3, t.y + 3, t.z + 3); }
    for (const T of this.tnts) { const t = T.body.translation(); add(T.body, t.x, t.y, t.z, 0.5, 0.5, 0.5, 1); T.w.gate = boxWet(w, t.x - 3, t.y - 3, t.z - 3, t.x + 3, t.y + 3, t.z + 3); }
    // a structure's world box: its local bounding box (origin corner + size) under the body's current pose
    for (const ch of this.chunks) {
      const t = ch.body.translation(), r = ch.body.rotation();
      _q.set(r.x, r.y, r.z, r.w);
      _c.set(ch.size.x / 2, ch.size.y / 2, ch.size.z / 2).applyQuaternion(_q).add(_v.set(t.x, t.y, t.z));
      _m.makeRotationFromQuaternion(_q);
      const e = _m.elements; // half extents of the rotated box: sum of |R_ij| * h_j
      const sx = ch.size.x / 2, sy = ch.size.y / 2, sz = ch.size.z / 2;
      const hx = Math.abs(e[0]) * sx + Math.abs(e[4]) * sy + Math.abs(e[8]) * sz;
      const hy = Math.abs(e[1]) * sx + Math.abs(e[5]) * sy + Math.abs(e[9]) * sz;
      const hz = Math.abs(e[2]) * sx + Math.abs(e[6]) * sy + Math.abs(e[10]) * sz;
      add(ch.body, _c.x, _c.y, _c.z, hx, hy, hz, ch.radius * 2);
      ch.w.gate = boxWet(w, _c.x - hx - 3, _c.y - hy - 3, _c.z - hz - 3, _c.x + hx + 3, _c.y + hy + 3, _c.z + hz + 3);
    }
  }

  /** whether any dynamic body is inside or next to this column (so it must not be unloaded) */
  columnInUse(cx: number, cz: number): boolean {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (this.bodyCols.has(cx + dx + (cz + dz) * 65536)) return true;
    return false;
  }

  // keep colliders for chunks near the player and around bodies, built nearest-to-need first within BUILD_MS
  private streamTerrain(dt: number): void {
    const t0 = performance.now();
    const w = this.game.world, p = this.game.player.pos;
    this.bodyChunks();
    // urgent chunks first, whatever it costs (a body is touching them)
    for (const key of this.urgent) if (!this.terrain.has(key) && this.ready(key)) this.buildChunkCollider(key);
    const pcx = Math.floor(p.x / CHUNK), pcy = Math.floor(p.y / CHUNK), pcz = Math.floor(p.z / CHUNK);
    const q = this.queue; // (still last frame's queue here)
    this.terrainT -= dt;
    if (this.terrainT <= 0) {
      this.terrainT = 0.25;
      for (const key of this.shells.keys()) if (!q.includes(key)) this.shells.delete(key); // stale stage-1 work
      let dropped = 0;
      for (const [key] of this.terrain) {
        const ch = w.chunks[key];
        if (!ch) { this.dropCollider(key); continue; } // column unloaded
        if (this.urgent.has(key) || this.ahead.has(key)) continue;
        if (Math.max(Math.abs(ch.cx - pcx), Math.abs(ch.cz - pcz)) <= PHYS_RADIUS + 1 && Math.abs(ch.cy - pcy) <= 2) continue;
        this.dropCollider(key);
        if (++dropped >= 16) break;
      }
    }
    // then what falling bodies are heading into, then the player's surroundings nearest first
    q.length = 0;
    for (const key of this.ahead) if (!this.terrain.has(key) && this.ready(key)) q.push(key);
    const nAhead = q.length;
    for (const [dx, dy, dz] of PLAYER_AREA) {
      const ch = w.chunk(pcx + dx, pcy + dy, pcz + dz);
      if (ch && !this.terrain.has(ch.key) && w.columnReady(ch.cx, ch.cz)) q.push(ch.key);
    }
    for (let i = 0; i < q.length; i++) {
      const key = q[i];
      // (a chunk can be queued twice, ahead of a body and in the player's area: building it twice leaked a body)
      if (this.terrain.has(key)) continue;
      if (performance.now() - t0 > BUILD_MS) { this.stats.deferred += q.length - i; break; }
      const sh = this.shells.get(key) || this.prepare(key);
      if (!sh) continue;
      // start the Rapier stage only if it fits (or nothing else ran this frame: progress is guaranteed)
      const el = performance.now() - t0;
      if (el > 0.5 && el + sh.n * this.perVoxel > BUILD_MS) { this.stats.deferred += q.length - i; break; }
      this.commit(key, sh);
      if (i < nAhead) this.stats.aheadBuilt++;
    }
  }

  private ready(key: number): boolean {
    const ch = this.game.world.chunks[key];
    return !!ch && this.game.world.columnReady(ch.cx, ch.cz);
  }

  /** mirror everything around a point right away (loading screens: start-up, loading a save) */
  prebuild(x: number, y: number, z: number): void {
    const w = this.game.world, pcx = Math.floor(x / CHUNK), pcy = Math.floor(y / CHUNK), pcz = Math.floor(z / CHUNK);
    for (const [dx, dy, dz] of PLAYER_AREA) {
      const ch = w.chunk(pcx + dx, pcy + dy, pcz + dz);
      if (ch && !this.terrain.has(ch.key) && w.columnReady(ch.cx, ch.cz)) this.buildChunkCollider(ch.key);
    }
  }

  // drop every dynamic body and re-mirror the terrain (used when loading a save, which passes the loaded player
  // position: the player object still stands where it was before the load when this runs)
  reset(at?: ArrayLike<number>): void {
    for (const ch of this.chunks) this.removeChunk(ch);
    for (const b of this.bricks) this.rw.removeRigidBody(b.body);
    for (const T of this.tnts) { this.game.scene.remove(T.grp); this.rw.removeRigidBody(T.body); }
    this.chunks = []; this.bricks = []; this.tnts = [];
    this.brickMesh.count = 0;
    for (const tc of this.terrain.values()) if (tc) this.rw.removeRigidBody(tc.col.parent()!);
    this.terrain.clear();
    this.shells.clear();
    const p = this.game.player.pos;
    if (at) this.prebuild(at[0], at[1], at[2]); else this.prebuild(p.x, p.y, p.z);
  }

  // ---------- falling structures ----------
  addChunk(blocks: ChunkBlock[]): void {
    const R = this.R, g = this.game;
    let ox = Infinity, oy = Infinity, oz = Infinity;
    for (const [x, y, z] of blocks) { ox = Math.min(ox, x); oy = Math.min(oy, y); oz = Math.min(oz, z); }
    const coords = new Int32Array(blocks.length * 3);
    blocks.forEach(([x, y, z], i) => { coords[i * 3] = x - ox; coords[i * 3 + 1] = y - oy; coords[i * 3 + 2] = z - oz; });
    const body = this.rw.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(ox, oy, oz).setLinearDamping(0.02).setAngularDamping(0.05));
    this.rw.createCollider(R.ColliderDesc.voxels(coords, { x: 1, y: 1, z: 1 }).setDensity(1).setFriction(0.85).setRestitution(0.05), body);
    // nudge it away from where the damage happened so it tips over its remaining support edge
    const com = body.worldCom();
    const hit = g.lastDamagePos || new THREE.Vector3(com.x, com.y, com.z);
    _v.set(com.x - hit.x, 0, com.z - hit.z);
    if (_v.lengthSq() < 0.01) _v.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    _v.normalize().multiplyScalar(body.mass() * (0.6 + Math.random() * 0.6));
    body.applyImpulseAtPoint({ x: _v.x, y: 0, z: _v.z }, { x: com.x, y: com.y + 1.5, z: com.z }, true);
    const mesh = this.buildMesh(blocks, ox, oy, oz);
    mesh.position.set(ox, oy, oz); // posed like the body from the start (blockCenter() reads the mesh)
    g.scene.add(mesh);
    const local = new Float32Array(blocks.length * 3);
    for (let i = 0; i < blocks.length; i++) { local[i * 3] = blocks[i][0] - ox + 0.5; local[i * 3 + 1] = blocks[i][1] - oy + 0.5; local[i * 3 + 2] = blocks[i][2] - oz + 0.5; }
    let sx = 0, sy = 0, sz = 0;
    for (const [x, y, z] of blocks) { sx = Math.max(sx, x - ox); sy = Math.max(sy, y - oy); sz = Math.max(sz, z - oz); }
    const radius = Math.hypot(sx + 1, sy + 1, sz + 1) / 2;
    // material densities: the collider keeps mass 1 per block (falling and toppling stay as tuned), buoyancy and
    // the in-water ballast torque account for the real masses (see waterChunk)
    const dens = new Float32Array(blocks.length);
    let sum = 0, mixed = false;
    for (let i = 0; i < blocks.length; i++) { sum += dens[i] = DENSITY[blocks[i][3]]; if (dens[i] !== dens[0]) mixed = true; }
    this.chunks.push({
      body, mesh, blocks, local, radius, size: new THREE.Vector3(sx + 1, sy + 1, sz + 1), ox, oy, oz, prevV: new THREE.Vector3(), t: 0, still: 0, hit: new Set(),
      dens, kb: blocks.length / sum, light: sum < blocks.length, mixed, w: newWet(0.05, body.mass()), dryT: 9,
    });
    g.audio.creak(Math.min(1, blocks.length / 60));
  }

  buildMesh(blocks: ChunkBlock[], ox: number, oy: number, oz: number): THREE.Mesh {
    // occupancy grid over the chunk's bounding box (with a 1-cell margin so neighbour lookups never leave it)
    let sx = 0, sy = 0, sz = 0;
    for (const [x, y, z] of blocks) { sx = Math.max(sx, x - ox); sy = Math.max(sy, y - oy); sz = Math.max(sz, z - oz); }
    sx += 3; sy += 3; sz += 3;
    const grid = new Uint8Array(sx * sy * sz);
    const gi = (x: number, y: number, z: number) => (x - ox + 1) + (z - oz + 1) * sx + (y - oy + 1) * sx * sz;
    for (const [x, y, z] of blocks) grid[gi(x, y, z)] = 1;
    const pos: number[] = [], nor: number[] = [], col: number[] = [], emit: number[] = [], tiles: number[] = [], ind: number[] = [];
    const q = [0, 0, 0];
    for (const [x, y, z, t] of blocks) {
      const bd = BLOCKS[t];
      const lx = x - ox, ly = y - oy, lz = z - oz;
      for (const [dx, dy, dz] of DIRS) {
        if (grid[gi(x + dx, y + dy, z + dz)]) continue;
        const a = dx ? 0 : dy ? 1 : 2, s = dx + dy + dz;
        const u = (a + 1) % 3, v = (a + 2) % 3;
        const base = pos.length / 3;
        const fc = a === 1 ? (s > 0 ? bd.cTop : bd.cBottom) : bd.cSide;
        const tint = 0.85 + Math.random() * 0.15;
        const tile = tileFor(t, a);
        for (let k = 0; k < 4; k++) {
          q[0] = lx; q[1] = ly; q[2] = lz;
          q[a] += s > 0 ? 1 : 0; q[u] += (k === 1 || k === 2) ? 1 : 0; q[v] += k >= 2 ? 1 : 0;
          pos.push(q[0], q[1], q[2]); nor.push(dx, dy, dz);
          col.push(fc.r * tint, fc.g * tint, fc.b * tint); emit.push(bd.emit); tiles.push(tile);
        }
        for (const ti of (s > 0 ? TRI_FRONT : TRI_BACK)) ind.push(base + ti);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('emit', new THREE.Float32BufferAttribute(emit, 1));
    geo.setAttribute('tile', new THREE.Float32BufferAttribute(tiles, 1));
    geo.setIndex(ind);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.chunkMat);
    mesh.castShadow = mesh.receiveShadow = true;
    return mesh;
  }

  // world-space centre of block i of a chunk
  blockCenter(ch: RigidChunk, i: number, out: THREE.Vector3): THREE.Vector3 {
    const [x, y, z] = ch.blocks[i];
    out.set(x - ch.ox + 0.5, y - ch.oy + 0.5, z - ch.oz + 0.5).applyQuaternion(ch.mesh.quaternion).add(ch.mesh.position);
    return out;
  }

  updateChunks(dt: number): void {
    for (let i = 0; i < this.chunks.length; i++) {
      const ch = this.chunks[i];
      ch.t += dt;
      const t = ch.body.translation(), r = ch.body.rotation(), lv = ch.body.linvel();
      ch.mesh.position.set(t.x, t.y, t.z);
      ch.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      const v = _w.set(lv.x, lv.y, lv.z);
      const speed = v.length();
      const dv = v.distanceTo(ch.prevV);
      const impactSpeed = ch.prevV.length();
      ch.prevV.copy(v);
      // in water: floating (light, and carried by the water rather than resting on a bank with a corner wet) bodies
      // are never written into the grid; they drift until they wash ashore or get waterlogged and sink away
      const W = ch.w, wet = W.f > 0.01, floating = ch.light && W.f > 0.25 / ch.kb;
      ch.dryT = wet ? 0 : ch.dryT + dt;
      if (floating) W.floatT += dt;
      // crush entities in the way
      if (speed > 3) this.crush(ch, speed);
      let done = false;
      if (ch.light && W.floatT > FLOAT_LIFE_CHUNK && (W.f > 0.97 || W.floatT > FLOAT_LIFE_CHUNK + SINK_S * 2)) {
        const c = ch.body.worldCom();
        bubbles(this.game, c.x, c.y + 0.5, c.z, Math.min(30, 4 + ch.blocks.length));
        done = true;
      }
      // (water stops a falling body hard, which is no reason to shatter it)
      else if (dv > 7 && ch.t > 0.12 && impactSpeed > 6 && ch.dryT > 0.25) { this.shatter(ch, impactSpeed); done = true; }
      else {
        ch.still = speed < 0.4 && ch.body.angvel().x ** 2 + ch.body.angvel().z ** 2 < 0.2 ? ch.still + dt : 0;
        if (!floating && (ch.body.isSleeping() || ch.still > 0.6)) { this.settle(ch); done = true; }
        else if (t.y < -10 || ch.t > 150 || (!wet && ch.t > 15 && (speed < 8 || ch.t > 60))) { this.shatter(ch, 0); done = true; }
      }
      if (done) { this.removeChunk(ch); this.chunks.splice(i, 1); i--; }
    }
  }

  crush(ch: RigidChunk, speed: number): void {
    const g = this.game, c = _c;
    const ents = g.entities.all();
    const n = ch.blocks.length, stride = n > 300 ? 3 : 1, local = ch.local;
    // entity centres are tested in the chunk's local frame, so blocks need no per-entity transform
    _qi.copy(ch.mesh.quaternion).invert();
    const reach = n + 6;
    for (const e of ents) {
      if (ch.hit.has(e)) continue;
      e.center(c);
      if (c.distanceTo(ch.mesh.position) > reach) continue;
      c.sub(ch.mesh.position).applyQuaternion(_qi);
      for (let i = 0; i < n; i += stride) {
        const dx = local[i * 3] - c.x, dy = local[i * 3 + 1] - c.y, dz = local[i * 3 + 2] - c.z;
        if (dx * dx + dy * dy + dz * dz < 0.85) {
          ch.hit.add(e);
          e.damage(15 + speed * 4, new THREE.Vector3(0, -1, 0), 'crush');
          break;
        }
      }
    }
  }

  removeChunk(ch: RigidChunk): void {
    this.rw.removeRigidBody(ch.body);
    this.game.scene.remove(ch.mesh);
    ch.mesh.geometry.dispose();
  }

  // snap a resting chunk back into the voxel grid (only if it ended up nearly axis-aligned)
  settle(ch: RigidChunk): void {
    const q = ch.mesh.quaternion;
    const snap = new THREE.Quaternion();
    // nearest 90-degree orientation about Y
    const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    snap.setFromEuler(new THREE.Euler(0, Math.round(e.y / (Math.PI / 2)) * (Math.PI / 2), 0, 'YXZ'));
    if (q.angleTo(snap) > 0.3) { this.shatter(ch, 4); return; }
    // use the snapped orientation and a whole-cell origin, so every block lands in exactly one cell
    // (rounding each rotated block centre separately tears holes and overlaps when the body rests off-grid)
    const g = this.game, w = g.world, p = new THREE.Vector3(), placed: [number, number, number][] = [];
    const o = ch.mesh.position, ox = Math.round(o.x), oz = Math.round(o.z);
    let oy = Math.round(o.y);
    // snapped block centres relative to the origin (world offsets added below)
    const rel = ch.blocks.map(([bx, by, bz]) => p.set(bx - ch.ox + 0.5, by - ch.oy + 0.5, bz - ch.oz + 0.5).applyQuaternion(snap).clone());
    // A body resting tilted across uneven ground (pond banks, rubble) snaps level with some blocks a cell
    // above the ground; written back like that they'd be unsupported and fall again, landing in the same
    // spot forever. Lower the snapped origin while every cell below is still free (at most 2 cells).
    const free = (dy: number) => rel.every(r => !w.solid(Math.floor(r.x + ox), Math.floor(r.y + oy + dy), Math.floor(r.z + oz)));
    for (let k = 0; k < 2 && free(-1); k++) oy--;
    for (let i = 0; i < ch.blocks.length; i++) {
      const bt = ch.blocks[i][3], r = rel[i];
      const px = r.x + ox, py = r.y + oy, pz = r.z + oz;
      const x = Math.floor(px), y = Math.floor(py), z = Math.floor(pz);
      if (w.inBounds(x, y, z) && w.isGenerated(x, z) && !w.solid(x, y, z) && !g.entities.blocksCell(x, y, z)) { w.set(x, y, z, bt); placed.push([x, y, z]); }
      else g.particles.chips(px, py, pz, BLOCKS[bt].cSide, 2);
    }
    g.audio.thud();
    g.particles.dust(ch.mesh.position.x, ch.mesh.position.y, ch.mesh.position.z, 8);
    if (!placed.length) return;
    // whatever is still unsupported right after landing would just fall into the same spot again: break it
    // up into loose bricks and rubble instead of starting another fall
    for (const cl of w.findFloating(placed)) for (const [x, y, z, t] of cl) {
      w.set(x, y, z, B.AIR);
      if (this.bricks.length < MAX_BRICKS) this.addBrick(x + 0.5, y + 0.5, z + 0.5, t, (Math.random() - 0.5) * 1.5, 0.5, (Math.random() - 0.5) * 1.5);
      else this.rubble(x, y, z, t);
    }
  }

  // break a chunk into rigid bricks + small debris
  shatter(ch: RigidChunk, impactSpeed: number): void {
    const g = this.game, w = g.world, p = new THREE.Vector3();
    const n = ch.blocks.length;
    const lv = ch.body.linvel(), av = ch.body.angvel();
    const com = ch.body.worldCom();
    const room = MAX_BRICKS - this.bricks.length;
    const brickChance = Math.min(1, Math.max(0.15, room / n));
    for (let i = 0; i < n; i++) {
      const t = ch.blocks[i][3];
      this.blockCenter(ch, i, p);
      if (t === B.TNT) { this.primeTNT(p.x, p.y, p.z, 0.1 + Math.random() * 0.3); continue; }
      // velocity of this point on the rotating body
      const rx = p.x - com.x, ry = p.y - com.y, rz = p.z - com.z;
      const vx = lv.x + av.y * rz - av.z * ry, vy = lv.y + av.z * rx - av.x * rz, vz = lv.z + av.x * ry - av.y * rx;
      const k = impactSpeed * 0.25;
      if (t !== B.LEAVES && Math.random() < brickChance) {
        this.addBrick(p.x, p.y, p.z, t, vx * 0.5 + (Math.random() - 0.5) * k, Math.abs(vy) * 0.2 + Math.random() * k, vz * 0.5 + (Math.random() - 0.5) * k, ch.mesh.quaternion);
      } else {
        const bd = BLOCKS[t];
        g.physics.addDebris(p.x, p.y, p.z, bd.cSide.clone().multiplyScalar(0.9), 0.3 + Math.random() * 0.3, vx * 0.4 + (Math.random() - 0.5) * 5, Math.random() * 5 + 2, vz * 0.4 + (Math.random() - 0.5) * 5, undefined, DENSITY[t]);
      }
      if (impactSpeed > 8 && Math.random() < 0.25) w.damageBlock(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z), impactSpeed * 0.25, 'crush');
    }
    if (impactSpeed > 0) {
      g.particles.dust(com.x, com.y - 0.5, com.z, Math.min(40, 6 + n));
      const pd = g.player.pos.distanceTo(_v.set(com.x, com.y, com.z));
      g.shake(Math.min(0.9, 0.12 + n * 0.01) * Math.max(0, 1 - pd / 40));
      g.audio.crash(Math.min(1, n / 50));
    }
  }

  // ---------- rigid bricks ----------
  addBrick(x: number, y: number, z: number, type: number, vx: number, vy: number, vz: number, quat?: THREE.Quaternion): void {
    const R = this.R;
    if (this.bricks.length >= MAX_BRICKS) this.retireBrick(this.bricks[0], false);
    const desc = R.RigidBodyDesc.dynamic().setTranslation(x, y, z).setLinvel(vx, vy, vz)
      .setAngvel({ x: (Math.random() - 0.5) * 4, y: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 4 }).setAngularDamping(0.3);
    if (quat) desc.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w });
    const body = this.rw.createRigidBody(desc);
    this.rw.createCollider(R.ColliderDesc.cuboid(0.48, 0.48, 0.48).setDensity(1).setFriction(0.8).setRestitution(0.1), body);
    this.bricks.push({ body, type, t: 0, still: 0, color: BLOCKS[type].cSide, slot: -1, w: newWet(0.3, body.mass()) });
  }

  // true while another brick is resting directly underneath: the lower one has to be written back to the
  // grid first, otherwise the upper brick finds no support below its cell and bursts into debris
  private onBrick(b: Brick, t: { x: number; y: number; z: number }): boolean {
    if (this.game.world.solid(Math.floor(t.x), Math.floor(t.y) - 1, Math.floor(t.z))) return false;
    for (const o of this.bricks) {
      if (o === b) continue;
      const u = o.body.translation();
      if (Math.abs(u.x - t.x) < 0.9 && Math.abs(u.z - t.z) < 0.9 && t.y - u.y > 0.5 && t.y - u.y < 1.5) return true;
    }
    return false;
  }

  retireBrick(b: Brick, toWorld: boolean): void {
    const g = this.game, w = g.world;
    const t = b.body.translation();
    const idx = this.bricks.indexOf(b);
    if (idx >= 0) this.bricks.splice(idx, 1);
    this.rw.removeRigidBody(b.body);
    if (toWorld) {
      // the cell it rests in, else the nearest free supported cell (neighbouring bricks often claim the same one)
      const bx = Math.floor(t.x), bz = Math.floor(t.z), sx = t.x - bx < 0.5 ? -1 : 1, sz = t.z - bz < 0.5 ? -1 : 1;
      for (const [dx, dz] of [[0, 0], [sx, 0], [0, sz], [sx, sz], [-sx, 0], [0, -sz]]) {
        const x = bx + dx, z = bz + dz;
        let y = Math.floor(t.y);
        for (let k = 0; k < 3 && w.solid(x, y, z); k++) y++;
        for (let k = 0; k < 3 && y > 0 && !w.solid(x, y - 1, z); k++) y--;
        if (w.inBounds(x, y, z) && w.isGenerated(x, z) && !w.solid(x, y, z) && w.solid(x, y - 1, z) && !g.entities.blocksCell(x, y, z)) {
          w.set(x, y, z, b.type);
          g.checkSupport([[x, y, z]]);
          return;
        }
      }
    }
    g.physics.burstBlock(t.x - 0.5, t.y - 0.5, t.z - 0.5, b.type, 3, 2);
  }

  updateBricks(dt: number): void {
    const g = this.game, enemies = g.entities.enemies;
    const mesh = this.brickMesh, mat = mesh.instanceMatrix.array as Float32Array;
    let n = 0, recoloured = false;
    for (let i = 0; i < this.bricks.length; i++) {
      const b = this.bricks[i];
      b.t += dt;
      const lv = b.body.linvel();
      const sp2 = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z;
      b.still = sp2 < 0.15 ? b.still + dt : 0;
      const t = b.body.translation();
      // a floating brick (lighter than water and carried by it) is never written into the grid: it drifts until it
      // washes ashore (then it settles like any other) or gets waterlogged and sinks away. A sinking one settles on
      // the bottom as rubble.
      const W = b.w, rho = DENSITY[b.type], wet = W.f > 0.01, floating = rho < 1 && W.f > rho * 0.25;
      if (floating) W.floatT += dt;
      if (rho < 1 && W.floatT > FLOAT_LIFE_BRICK && (W.f > 0.97 || W.floatT > FLOAT_LIFE_BRICK + SINK_S * 2)) {
        bubbles(g, t.x, t.y + 0.3, t.z, 4);
        this.bricks.splice(i--, 1); this.rw.removeRigidBody(b.body);
        continue;
      }
      // (a brick still falling down a mountainside keeps going: it only times out once it slows down)
      if (t.y < -5 || (!wet && b.t > 9 && (sp2 < 64 || b.t > 60)) || b.t > 150
        || (!floating && (b.body.isSleeping() || b.still > 0.5) && !this.onBrick(b, t))) { this.retireBrick(b, t.y > -5); i--; continue; }
      // flying bricks hurt enemies
      if (sp2 > 40) {
        for (const e of enemies) {
          if (e.dead) continue;
          const dx = e.pos.x - t.x, dz = e.pos.z - t.z, dy = e.pos.y + e.h * 0.5 - t.y;
          if (dx * dx + dz * dz < 0.7 && Math.abs(dy) < e.h * 0.6 + 0.5) {
            e.damage(Math.sqrt(sp2) * 2.2, new THREE.Vector3(lv.x * 0.3, 2, lv.z * 0.3), 'crush');
            b.body.setLinvel({ x: lv.x * 0.3, y: lv.y, z: lv.z * 0.3 }, true);
          }
        }
      }
      const r = b.body.rotation();
      _m.compose(_v.set(t.x, t.y, t.z), _q.set(r.x, r.y, r.z, r.w), _s).toArray(mat, n * 16);
      // colour is per-slot: only rewrite it when this brick lands in a different instance
      if (b.slot !== n) { mesh.setColorAt(n, b.color); b.slot = n; recoloured = true; }
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (recoloured && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  // ---------- primed TNT ----------
  primeTNT(x: number, y: number, z: number, fuse = 1.6): void {
    const R = this.R, g = this.game;
    const grp = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0xd8443a, emissive: 0x000000 });
    const band = new THREE.MeshLambertMaterial({ color: 0xeee4d0, emissive: 0x000000 });
    grp.add(new THREE.Mesh(this.tntGeo, mat), new THREE.Mesh(this.bandGeo, band));
    grp.children.forEach(c => { c.castShadow = true; });
    g.scene.add(grp);
    const body = this.rw.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x, y, z)
      .setLinvel((Math.random() - 0.5) * 2, 3, (Math.random() - 0.5) * 2).setAngvel({ x: Math.random() * 4 - 2, y: Math.random() * 4 - 2, z: Math.random() * 4 - 2 }));
    this.rw.createCollider(R.ColliderDesc.cuboid(0.45, 0.45, 0.45).setDensity(1.5).setFriction(0.7).setRestitution(0.2), body);
    this.tnts.push({ grp, mat, band, body, fuse, t: 0, total: fuse, w: newWet(0, body.mass()) });
    g.audio.fuse();
  }

  updateTNT(dt: number): void {
    const g = this.game;
    for (let i = 0; i < this.tnts.length; i++) {
      const T = this.tnts[i];
      T.t += dt; T.fuse -= dt;
      const t = T.body.translation(), r = T.body.rotation();
      T.grp.position.set(t.x, t.y, t.z); T.grp.quaternion.set(r.x, r.y, r.z, r.w);
      const flash = Math.sin(T.t * (8 + (1 - T.fuse / Math.max(0.2, T.total)) * 22)) > 0 ? 0.9 : 0;
      T.mat.emissive.setRGB(flash, flash, flash); T.band.emissive.setRGB(flash, flash, flash);
      T.grp.scale.setScalar(1 + Math.max(0, 0.3 - T.fuse));
      if (Math.random() < 0.5) g.particles.sparks(t.x, t.y + 0.5, t.z, 1);
      if (T.fuse <= 0) {
        g.scene.remove(T.grp);
        this.rw.removeRigidBody(T.body);
        this.tnts.splice(i, 1); i--;
        g.explode(new THREE.Vector3(t.x, t.y, t.z), 4.2, 17, 'tnt');
      }
    }
  }

  impulse(center: THREE.Vector3, radius: number, force: number): void {
    const apply = (body: RigidBody) => {
      const t = body.translation();
      _v.set(t.x - center.x, t.y - center.y, t.z - center.z);
      const d = _v.length();
      if (d > radius) return;
      const k = (1 - d / radius) * force * body.mass();
      _v.normalize();
      body.applyImpulse({ x: _v.x * k, y: (_v.y + 0.6) * k, z: _v.z * k }, true);
    };
    for (const b of this.bricks) apply(b.body);
    for (const T of this.tnts) apply(T.body);
    // structures are pushed block by block, at each block inside the blast (unit mass each). Measured from the
    // body's translation (its origin corner), a blast right against the far end of a long piece missed it
    // entirely or shoved it the wrong way; per block it also gets the torque of an off-centre hit
    for (const ch of this.chunks) {
      const r = ch.body.rotation(), t = ch.body.translation(); // (not the mesh: it lags a frame, and a new one is at 0)
      const q = _q.set(r.x, r.y, r.z, r.w), o = _o.set(t.x, t.y, t.z);
      _qi.copy(q).invert();
      _c.copy(center).sub(o).applyQuaternion(_qi); // blast centre in the body's local frame
      if (_c.x < -radius || _c.y < -radius || _c.z < -radius || _c.x > ch.size.x + radius || _c.y > ch.size.y + radius || _c.z > ch.size.z + radius) continue;
      const L = ch.local;
      for (let i = 0; i < ch.blocks.length; i++) {
        const dx = L[i * 3] - _c.x, dy = L[i * 3 + 1] - _c.y, dz = L[i * 3 + 2] - _c.z, d = Math.hypot(dx, dy, dz);
        if (d > radius) continue;
        const k = (1 - d / radius) * force / Math.max(d, 0.3);
        _v.set(dx * k, dy * k + (1 - d / radius) * force * 0.6, dz * k).applyQuaternion(q);
        _w.set(L[i * 3], L[i * 3 + 1], L[i * 3 + 2]).applyQuaternion(q).add(o);
        ch.body.applyImpulseAtPoint({ x: _v.x, y: _v.y, z: _v.z }, { x: _w.x, y: _w.y, z: _w.z }, true);
      }
    }
  }

  // ---------- buoyancy ----------
  // Forces are recomputed before every world step from the water around each body: per block (structures) or per
  // octant (bricks, TNT), the submerged fraction of its vertical extent gives an upward force at that point, so a
  // body tilts toward its waterline and rights itself, and a drag on the point's velocity relative to the current
  // damps both its motion and its spin. Bodies with no water in any chunk around them (wet gate, set once per frame
  // in bodyChunks) cost nothing. The forces go in as impulses (force × step) right before the step: same effect,
  // half the wasm calls of Rapier's persistent forces, and nothing to reset when the body leaves the water.
  private waterT = 0; // clock for the swell and the current
  private _wp = new Float32Array(1024); // scratch: world block centres and submerged fractions of a structure

  private waterStep(): void {
    for (const b of this.bricks) this.waterSmall(b.body, b.w, 0.48, DENSITY[b.type], FLOAT_LIFE_BRICK);
    for (const T of this.tnts) this.waterSmall(T.body, T.w, 0.45, DENSITY[B.TNT], Infinity);
    for (const ch of this.chunks) this.waterChunk(ch);
  }

  /** a body out of the water: drop its water forces and extra damping */
  private dryOut(b: RigidBody, W: Wet): void {
    W.f = 0;
    if (W.damp !== W.damp0) { b.setAngularDamping(W.damp0); W.damp = W.damp0; }
  }

  private applyWater(b: RigidBody, W: Wet, f: number, fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): void {
    b.applyImpulse({ x: fx * STEP, y: fy * STEP, z: fz * STEP }, true);
    b.applyTorqueImpulse({ x: tx * STEP, y: ty * STEP, z: tz * STEP }, true);
    W.f = f;
    const d = W.damp0 + DRAG_ANG * Math.min(1, f * 2);
    if (Math.abs(d - W.damp) > 0.1) { b.setAngularDamping(d); W.damp = d; }
  }

  // a structure: one sample per block. The collider gives every block mass 1; the real mass of block i is dens[i],
  // so buoyancy is scaled by kb = N / sum(dens) (the body floats exactly when its average density is below water's)
  // and, in water, a force pair sum((kb * dens[i] - 1) * g) = 0 moves its centre of gravity to where the real mass
  // is: no net force, just the torque that turns a hut's stone footing down and its wooden roof up. (Only in
  // water: in free fall that torque would spin it, which a real body doesn't.)
  private waterChunk(ch: RigidChunk): void {
    const b = ch.body, W = ch.w, w = this.game.world;
    if (!W.gate || b.isSleeping()) { if (W.f) this.dryOut(b, W); return; }
    const t = b.translation(), r = b.rotation();
    const x2 = r.x * 2, y2 = r.y * 2, z2 = r.z * 2;
    const m00 = 1 - r.y * y2 - r.z * z2, m01 = r.x * y2 - r.w * z2, m02 = r.x * z2 + r.w * y2;
    const m10 = r.x * y2 + r.w * z2, m11 = 1 - r.x * x2 - r.z * z2, m12 = r.y * z2 - r.w * x2;
    const m20 = r.x * z2 - r.w * y2, m21 = r.y * z2 + r.w * x2, m22 = 1 - r.x * x2 - r.y * y2;
    const h = 0.5 * (Math.abs(m10) + Math.abs(m11) + Math.abs(m12)); // vertical half extent of a rotated unit cube
    const n = ch.blocks.length, L = ch.local, T = this.waterT;
    if (this._wp.length < n * 4) this._wp = new Float32Array(n * 8);
    const P = this._wp;
    let sub = 0, top0 = -Infinity, ex = 0, ez = 0;
    for (let i = 0; i < n; i++) {
      const lx = L[i * 3], ly = L[i * 3 + 1], lz = L[i * 3 + 2];
      const px = t.x + m00 * lx + m01 * ly + m02 * lz, py = t.y + m10 * lx + m11 * ly + m12 * lz, pz = t.z + m20 * lx + m21 * ly + m22 * lz;
      const top = waterTop(w, Math.floor(px), Math.floor(pz), Math.floor(py - h), Math.floor(py + h));
      let f = 0;
      if (top > -Infinity) {
        f = (top + swell(px, pz, T) - py + h) / (2 * h);
        f = f < 0 ? 0 : f > 1 ? 1 : f;
        if (f > 0 && top > top0) { top0 = top; ex = px; ez = pz; }
      }
      P[i * 4] = px; P[i * 4 + 1] = py; P[i * 4 + 2] = pz; P[i * 4 + 3] = f;
      sub += f;
    }
    if (sub === 0) { if (W.f) this.dryOut(b, W); return; }
    const com = b.worldCom(), v = b.linvel(), a = b.angvel();
    const wet = Math.min(1, 2 * sub / n), lift = GRAV * ch.kb * (ch.light ? waterlog(W.floatT, FLOAT_LIFE_CHUNK) : 1);
    const [ux, uz] = current(com.x, com.z, T);
    let Fx = 0, Fy = 0, Fz = 0, Tx = 0, Ty = 0, Tz = 0;
    for (let i = 0; i < n; i++) {
      const f = P[i * 4 + 3];
      if (!f && !ch.mixed) continue;
      const rx = P[i * 4] - com.x, ry = P[i * 4 + 1] - com.y, rz = P[i * 4 + 2] - com.z;
      let fx = 0, fy = ch.mixed ? -GRAV * (ch.kb * ch.dens[i] - 1) * wet : 0, fz = 0;
      if (f > 0) {
        fy += lift * f;
        // the block's velocity relative to the water; drag of a unit mass, in the unconditionally stable form
        // (it can at most cancel that velocity within one step)
        const vx = v.x + a.y * rz - a.z * ry - ux, vy = v.y + a.z * rx - a.x * rz, vz = v.z + a.x * ry - a.y * rx - uz;
        const k = (1 - Math.exp(-f * (DRAG_LIN + DRAG_QUAD * Math.sqrt(vx * vx + vy * vy + vz * vz)) * STEP)) / STEP;
        fx -= vx * k; fy -= vy * k; fz -= vz * k;
      }
      Fx += fx; Fy += fy; Fz += fz;
      Tx += ry * fz - rz * fy; Ty += rz * fx - rx * fz; Tz += rx * fy - ry * fx;
    }
    if (!W.f && v.y < -3) splash(this.game, ex, top0, ez, Math.min(1, -v.y / 20 * Math.min(1, 0.35 + n / 25)));
    this.applyWater(b, W, sub / n, Fx, Fy, Fz, Tx, Ty, Tz);
  }

  // a brick or TNT: a cube of half size `half` sampled as 8 octants, all against the surface found in its own
  // column (3 lookups); the swell differs per octant, so cubes rock as well as bob
  private waterSmall(b: RigidBody, W: Wet, half: number, rho: number, life: number): void {
    if (!W.gate || b.isSleeping()) { if (W.f) this.dryOut(b, W); return; }
    const t = b.translation();
    const top = waterTop(this.game.world, Math.floor(t.x), Math.floor(t.z), Math.floor(t.y - 0.9), Math.floor(t.y + 0.9));
    if (top === -Infinity) { if (W.f) this.dryOut(b, W); return; }
    const r = b.rotation();
    const x2 = r.x * 2, y2 = r.y * 2, z2 = r.z * 2;
    const m00 = 1 - r.y * y2 - r.z * z2, m01 = r.x * y2 - r.w * z2, m02 = r.x * z2 + r.w * y2;
    const m10 = r.x * y2 + r.w * z2, m11 = 1 - r.x * x2 - r.z * z2, m12 = r.y * z2 - r.w * x2;
    const m20 = r.x * z2 - r.w * y2, m21 = r.y * z2 + r.w * x2, m22 = 1 - r.x * x2 - r.y * y2;
    const q = half / 2, hs = q * (Math.abs(m10) + Math.abs(m11) + Math.abs(m12));
    const m8 = W.mass / 8, v = b.linvel(), a = b.angvel(), T = this.waterT;
    const lift = GRAV * m8 / rho * (rho < 1 ? waterlog(W.floatT, life) : 1);
    const [ux, uz] = current(t.x, t.z, T);
    let sub = 0, Fx = 0, Fy = 0, Fz = 0, Tx = 0, Ty = 0, Tz = 0;
    for (let c = 0; c < 8; c++) {
      const lx = c & 1 ? q : -q, ly = c & 2 ? q : -q, lz = c & 4 ? q : -q;
      const rx = m00 * lx + m01 * ly + m02 * lz, ry = m10 * lx + m11 * ly + m12 * lz, rz = m20 * lx + m21 * ly + m22 * lz;
      let f = (top + swell(t.x + rx, t.z + rz, T) - t.y - ry + hs) / (2 * hs);
      if (f <= 0) continue;
      if (f > 1) f = 1;
      sub += f;
      const vx = v.x + a.y * rz - a.z * ry - ux, vy = v.y + a.z * rx - a.x * rz, vz = v.z + a.x * ry - a.y * rx - uz;
      const k = m8 * (1 - Math.exp(-f * (DRAG_LIN + DRAG_QUAD * Math.sqrt(vx * vx + vy * vy + vz * vz)) * STEP)) / STEP;
      const fx = -vx * k, fy = lift * f - vy * k, fz = -vz * k;
      Fx += fx; Fy += fy; Fz += fz;
      Tx += ry * fz - rz * fy; Ty += rz * fx - rx * fz; Tz += rx * fy - ry * fx;
    }
    if (!sub) { if (W.f) this.dryOut(b, W); return; }
    if (!W.f && v.y < -3) splash(this.game, t.x, top, t.z, Math.min(0.6, -v.y / 40));
    this.applyWater(b, W, sub / 8, Fx, Fy, Fz, Tx, Ty, Tz);
  }

  // cap a body's speed (see MAX_SPEED)
  private clampSpeed(b: RigidBody): void {
    if (b.isSleeping()) return;
    const v = b.linvel(), s2 = v.x * v.x + v.y * v.y + v.z * v.z;
    if (s2 <= MAX_SPEED * MAX_SPEED) return;
    const k = MAX_SPEED / Math.sqrt(s2);
    b.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, false);
  }

  // whether a body is somewhere its terrain can't be mirrored: its column isn't generated, or it's far
  // outside the area the world keeps around the player
  private stranded(b: RigidBody): boolean {
    const t = b.translation(), p = this.game.player.pos, w = this.game.world;
    if ((t.x - p.x) ** 2 + (t.z - p.z) ** 2 > KEEP_DIST * KEEP_DIST) return true;
    return t.y >= 0 && t.y < w.H && !w.isGenerated(Math.floor(t.x), Math.floor(t.z));
  }

  /** drop a block straight down its column onto whatever is below (a frozen body becoming rubble) */
  rubble(x: number, y: number, z: number, type: number): void {
    const g = this.game, w = g.world;
    const bx = Math.floor(x), bz = Math.floor(z);
    let by = Math.min(w.H - 1, Math.floor(y));
    if (!w.isGenerated(bx, bz) || type === B.TNT) return;
    while (by > 0 && w.solid(bx, by, bz)) by++;
    while (by > 0 && !w.solid(bx, by - 1, bz)) by--;
    if (by < w.H && !w.solid(bx, by, bz) && !g.entities.blocksCell(bx, by, bz)) { w.set(bx, by, bz, type); g.checkSupport([[bx, by, bz]]); }
  }

  // bodies that left the mirrored world are frozen into rubble where they are (dropped down their columns)
  private freezeStranded(): void {
    const p = new THREE.Vector3();
    for (let i = 0; i < this.bricks.length; i++) {
      const b = this.bricks[i];
      if (!this.stranded(b.body)) continue;
      const t = b.body.translation();
      this.bricks.splice(i--, 1); this.rw.removeRigidBody(b.body);
      if (!b.w.f) this.rubble(t.x, t.y, t.z, b.type); // (drifting out to sea: just gone)
      this.stats.frozen++;
    }
    for (let i = 0; i < this.tnts.length; i++) {
      const T = this.tnts[i];
      if (!this.stranded(T.body)) continue;
      this.game.scene.remove(T.grp); this.rw.removeRigidBody(T.body); // fizzles out
      this.tnts.splice(i--, 1); this.stats.frozen++;
    }
    for (let i = 0; i < this.chunks.length; i++) {
      const ch = this.chunks[i];
      if (!this.stranded(ch.body)) continue;
      if (!ch.w.f) for (let k = 0; k < ch.blocks.length; k++) { this.blockCenter(ch, k, p); this.rubble(p.x, p.y, p.z, ch.blocks[k][3]); }
      this.removeChunk(ch); this.chunks.splice(i--, 1); this.stats.frozen++;
    }
  }

  update(dt: number): void {
    this.freezeStranded();
    this.streamTerrain(dt);
    this.acc = Math.min(this.acc + dt, STEP * 3);
    while (this.acc >= STEP) {
      const tw = performance.now(); this.waterStep(); this.stats.waterMs += performance.now() - tw;
      this.rw.step(this.eq); this.acc -= STEP; this.waterT += STEP;
      for (const b of this.bricks) this.clampSpeed(b.body);
      for (const T of this.tnts) this.clampSpeed(T.body);
      for (const ch of this.chunks) this.clampSpeed(ch.body);
    }
    this.updateChunks(dt);
    this.updateBricks(dt);
    this.updateTNT(dt);
  }
}
