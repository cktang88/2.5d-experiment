// Far terrain: nested clipmap-style rings of the analytic heightfield (not voxels) out to ~2 km, so
// mountain ranges hundreds of blocks away are visible beyond the meshed voxel area. Each level is a
// fixed 128 x 128-cell grid (4, 8, 16 and 32 blocks per vertex) recentred in snapped steps as the
// player moves. Heights and colours are sampled in dedicated workers (genWorker 'far' jobs); the main
// thread only swaps the returned arrays into persistent buffers. Every level discards fragments
// inside the next finer level (with a one-cell overlap pushed back by polygon offset, so cracks
// between levels never open), and all levels discard fragments in columns whose voxel meshes are
// complete, read from a one-texel-per-column mask. The far mesh also sits a block below the voxel
// surface so columns that are still meshing never z-fight with it.
import * as THREE from 'three';
import { patchWorldMaterial, CX, CY, CZ, CHUNK, MAX_RENDER_RADIUS, WORLD_W, WORLD_D, B } from './world';
import type { VChunk } from './world';
import type { Game } from './main';
import type { SampleMsg } from './genWorker';

// ---------- worker pool for terrain-sampling jobs (far terrain, minimap, world map, shoreline) ----------
type Reply = any;
interface Job { msg: SampleMsg; pri: number; key: string | null; cb: (r: Reply) => void }

export class TerrainJobs {
  private workers: Worker[] = [];
  private busy: (Job | null)[] = [];
  private queue: Job[] = [];
  private nextId = 1;
  constructor(seed: number, n = 2, test = false) {
    for (let i = 0; i < n; i++) {
      const wk = new Worker(new URL('./genWorker.ts', import.meta.url), { type: 'module' });
      wk.postMessage({ type: 'init', seed, test });
      wk.onmessage = (e: MessageEvent<Reply>) => {
        const j = this.busy[i];
        this.busy[i] = null;
        if (j) j.cb(e.data);
        this.pump();
      };
      wk.onerror = (e) => console.error('terrain worker error', e);
      this.workers.push(wk); this.busy.push(null);
    }
  }
  /** queue a job; lower `pri` runs first, and a queued job with the same `key` is replaced (it went stale) */
  request(msg: SampleMsg, pri: number, cb: (r: Reply) => void, key: string | null = null): void {
    msg.id = this.nextId++;
    if (key) { const i = this.queue.findIndex(j => j.key === key); if (i >= 0) this.queue.splice(i, 1); }
    this.queue.push({ msg, pri, key, cb });
    this.pump();
  }
  private pump(): void {
    for (let i = 0; i < this.workers.length && this.queue.length; i++) {
      if (this.busy[i]) continue;
      let best = 0;
      for (let k = 1; k < this.queue.length; k++) if (this.queue[k].pri < this.queue[best].pri) best = k;
      const j = this.queue.splice(best, 1)[0];
      this.busy[i] = j;
      this.workers[i].postMessage(j.msg);
    }
  }
}

// ---------- far terrain ----------
const LEVELS = 4, N = 128, BASE_STEP = 4;
const MASK_R = MAX_RENDER_RADIUS + 2; // columns scanned around the view focus for voxel coverage
const SKIRT = 7; // blocks the far surface sinks under meshed voxel columns

interface Level {
  step: number; half: number; snap: number;
  cx: number; cz: number; // centre of the installed grid
  wx: number; wz: number; // centre of the newest request
  ready: boolean;
  mesh: THREE.Mesh;
  hole: THREE.Vector4; // the finer level's rect (x0, z0, x1, z1): fragments inside are discarded
}

export class FarTerrain {
  game: Game;
  jobs: TerrainJobs;
  group = new THREE.Group();
  levels: Level[] = [];
  mask: THREE.DataTexture;
  private maskData: Uint8Array<ArrayBuffer>;
  private maskOn: number[] = []; // mask texels currently set
  private cov = new Uint8Array((2 * MASK_R + 1) ** 2); // scratch: coverage in the scan window
  private settled = new WeakSet<VChunk>(); // chunks seen with a finished mesh state
  /** main-thread ms spent installing grids (last install) and in update() (last frame), for profiling */
  installMs = 0; updateMs = 0;

  constructor(game: Game) {
    this.game = game;
    this.jobs = new TerrainJobs(game.world.seed, 2, game.world.gen.test);
    this.maskData = new Uint8Array(CX * CZ);
    this.mask = new THREE.DataTexture(this.maskData, CX, CZ, THREE.RedFormat, THREE.UnsignedByteType);
    this.mask.magFilter = this.mask.minFilter = THREE.NearestFilter;
    this.mask.needsUpdate = true;
    const V = N + 1;
    for (let l = 0; l < LEVELS; l++) {
      const step = BASE_STEP << l, half = N * step / 2, snap = step * 8;
      // cells that the finer level always covers (allowing for both levels lagging behind the player) get no triangles
      let skip = 0;
      if (l > 0) { const f = this.levels[l - 1]; skip = Math.floor((f.half - 1.5 * (f.snap + snap) - step) / step); }
      const idx: number[] = [];
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        if (skip > 0 && Math.max(Math.abs(i + 0.5 - N / 2), Math.abs(j + 0.5 - N / 2)) < skip) continue;
        const a = i + j * V, b = a + V, c = a + 1, d = b + 1;
        // alternate the diagonal so flat-shaded facets don't all lean one way
        if ((i + j) & 1) idx.push(a, b, c, c, b, d); else idx.push(a, b, d, a, d, c);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(V * V * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(V * V * 4), 4, true));
      geo.setIndex(idx);
      const hole = new THREE.Vector4(1, 1, 0, 0);
      const mesh = new THREE.Mesh(geo, this.makeMaterial(l, hole));
      mesh.frustumCulled = false; mesh.visible = false;
      mesh.receiveShadow = true; mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = -1 + l * 0.01;
      this.group.add(mesh);
      this.levels.push({ step, half, snap, cx: NaN, cz: NaN, wx: NaN, wz: NaN, ready: false, mesh, hole });
    }
  }

  private makeMaterial(l: number, hole: THREE.Vector4): THREE.MeshLambertMaterial {
    const mat = patchWorldMaterial(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), { cutaway: false, emissive: false, clouds: true });
    // coarser levels lose depth ties against the finer level they overlap
    if (l > 0) { mat.polygonOffset = true; mat.polygonOffsetFactor = 1 + l; mat.polygonOffsetUnits = 2 + 2 * l; }
    const base = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, r) => {
      base.call(mat, shader, r);
      shader.uniforms.uFarMask = { value: this.mask };
      shader.uniforms.uHole = { value: hole };
      // vertices inside meshed voxel columns sink SKIRT blocks: along the edge of the voxel area the far
      // surface then slopes down under the voxels, so a view ray slipping in between the two (voxel
      // chunks have no faces on their column sides) still lands on terrain instead of the sky
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D uFarMask;
          float farMask(vec2 p) { return texture2D(uFarMask, p / vec2(${WORLD_W.toFixed(1)}, ${WORLD_D.toFixed(1)})).r; }`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          { vec2 wp = (modelMatrix * vec4(transformed, 1.0)).xz;
            float m = min(min(farMask(wp + vec2(0.5, 0.5)), farMask(wp + vec2(-0.5, 0.5))), min(farMask(wp + vec2(0.5, -0.5)), farMask(wp - 0.5)));
            transformed.y -= step(0.25, m) * ${SKIRT.toFixed(1)}; }`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D uFarMask; uniform vec4 uHole;`)
        .replace('bool isCap = false;', `
          if (vWPos.x > uHole.x && vWPos.z > uHole.y && vWPos.x < uHole.z && vWPos.z < uHole.w) discard;
          if (texture2D(uFarMask, vWPos.xz / vec2(${WORLD_W.toFixed(1)}, ${WORLD_D.toFixed(1)})).r > 0.75) discard; // 0.5: edge column, kept (sunk)
          bool isCap = false;`);
    };
    mat.customProgramCacheKey = () => 'far-terrain';
    return mat;
  }

  /** per frame: refresh the voxel-coverage mask and recentre levels the player has moved away from */
  update(px: number, pz: number): void {
    const t0 = performance.now();
    this.updateMask(px, pz);
    for (let l = 0; l < LEVELS; l++) {
      const lv = this.levels[l];
      if (Math.max(Math.abs(px - lv.wx), Math.abs(pz - lv.wz)) <= lv.snap && !Number.isNaN(lv.wx)) continue;
      const cx = Math.round(px / lv.snap) * lv.snap, cz = Math.round(pz / lv.snap) * lv.snap;
      lv.wx = cx; lv.wz = cz;
      const x0 = cx - lv.half, z0 = cz - lv.half;
      this.jobs.request({ type: 'far', id: 0, x0, z0, step: lv.step, n: N }, l, (r: { pos: Float32Array; col: Uint8Array }) => this.install(l, cx, cz, r), 'far' + l);
    }
    this.updateMs = performance.now() - t0;
  }

  private install(l: number, cx: number, cz: number, r: { pos: Float32Array; col: Uint8Array }): void {
    const t0 = performance.now();
    const lv = this.levels[l], geo = lv.mesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute, col = geo.attributes.color as THREE.BufferAttribute;
    pos.array = r.pos; pos.needsUpdate = true;
    col.array = r.col; col.needsUpdate = true;
    lv.cx = cx; lv.cz = cz; lv.ready = true;
    lv.mesh.position.set(cx - lv.half, -1.5, cz - lv.half); // h + 0.5 - 1.5: a block below the voxel tops
    lv.mesh.updateMatrix();
    lv.mesh.visible = true;
    // the next coarser level discards what this one now covers (minus one coarse cell of overlap)
    const up = this.levels[l + 1];
    if (up) { const m = lv.half - up.step; up.hole.set(cx - m, cz - m, cx + m, cz + m); }
    this.installMs = performance.now() - t0;
  }

  // a column is "covered" once its voxel chunks are all meshed: the far terrain is discarded there
  private updateMask(px: number, pz: number): void {
    const w = this.game.world, pending = w.meshing.pending, d = this.maskData;
    const pcx = Math.floor(px / CHUNK), pcz = Math.floor(pz / CHUNK), CXZ = CX * CZ;
    let changed = false;
    const on: number[] = [], cov = this.cov, MW = 2 * MASK_R + 1;
    cov.fill(0);
    for (let cz = pcz - MASK_R; cz <= pcz + MASK_R; cz++) for (let cx = pcx - MASK_R; cx <= pcx + MASK_R; cx++) {
      if (cx < 0 || cz < 0 || cx >= CX || cz >= CZ) continue;
      const ci = cx + cz * CX;
      let covered = false;
      if (w.colState[ci] === 2) {
        let meshes = 0, missing = 0;
        for (let cy = 0; cy < CY; cy++) {
          const ch = w.chunks[ci + cy * CXZ];
          if (!ch) continue;
          if (ch.mesh || ch.fol) meshes++;
          const busy = ch.dirty || pending.has(ch.key);
          if (!busy) this.settled.add(ch);
          else if ((ch.blocks || ch.fill !== B.AIR) && !ch.mesh && !this.settled.has(ch)) missing++;
        }
        covered = meshes > 0 && missing === 0;
        // meshes unloaded: forget what we knew so the column must fully re-mesh before it counts again
        if (!meshes) for (let cy = 0; cy < CY; cy++) { const ch = w.chunks[ci + cy * CXZ]; if (ch) this.settled.delete(ch); }
      }
      cov[(cx - pcx + MASK_R) + (cz - pcz + MASK_R) * MW] = covered ? 1 : 0;
    }
    // covered columns next to an uncovered one keep a sunken far surface (128); the rest discard it (255)
    for (let cz = pcz - MASK_R; cz <= pcz + MASK_R; cz++) for (let cx = pcx - MASK_R; cx <= pcx + MASK_R; cx++) {
      if (cx < 0 || cz < 0 || cx >= CX || cz >= CZ) continue;
      const ci = cx + cz * CX, k = (cx - pcx + MASK_R) + (cz - pcz + MASK_R) * MW;
      let v = 0;
      if (cov[k]) {
        on.push(ci);
        v = 255;
        const lx = cx - pcx + MASK_R, lz = cz - pcz + MASK_R;
        for (let dz = -1; dz <= 1 && v === 255; dz++) for (let dx = -1; dx <= 1; dx++) {
          const ax = lx + dx, az = lz + dz;
          if (ax < 0 || az < 0 || ax >= MW || az >= MW || !cov[ax + az * MW]) { v = 128; break; }
        }
      }
      if (d[ci] !== v) { d[ci] = v; changed = true; }
    }
    // texels left behind outside the scan window
    for (const ci of this.maskOn) {
      const cx = ci % CX, cz = Math.floor(ci / CX);
      if (Math.abs(cx - pcx) > MASK_R || Math.abs(cz - pcz) > MASK_R) { d[ci] = 0; changed = true; }
    }
    this.maskOn = on;
    if (changed) this.mask.needsUpdate = true;
  }
}
