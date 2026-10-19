// Chunk meshing in WebAssembly (Rust crate `crates/voxel-core`).
//  - a pool of Web Workers meshes streamed chunks entirely off the main thread
//  - a main-thread instance remeshes chunks the player just edited, so breaks show up instantly
// The mesher merges coplanar faces greedily; output uses compact vertex formats (u8 positions,
// i8 normals, u16 colours: ~15 bytes/vertex). Per-block colour variation (hash tint, grass/leaf
// patches, ember tint) is added by the world shader (patchWorldMaterial `cells`), not baked in.
import * as THREE from 'three';
import init, { Mesher } from './wasm/voxel_core';
import { runMesher } from './meshCore';
import type { MeshData, MeshInput } from './meshCore';
export type { MeshData, MeshInput };
import { BLOCKS, tileFor } from './world';

const CHUNK = 32;
const P = CHUNK + 2;
const PP = P * P;
const BLOCK_STRIDE = 20;
const AIR = 0, BEDROCK = 5;

/** the parts of the World the gatherer reads */
export interface VoxelSource {
  W: number; H: number; D: number;
  chunk(cx: number, cy: number, cz: number): { key: number; cx: number; cy: number; cz: number; blocks: Uint8Array | null; fill: number; decor: Uint8Array | null } | undefined;
  get(x: number, y: number, z: number): number;
  damage: Map<number, number>; burning: Map<number, number>;
}
type SrcChunk = NonNullable<ReturnType<VoxelSource['chunk']>>;

// block colours/flags in the layout the Rust mesher expects
export function blockTable(): Float32Array {
  const table = new Float32Array(BLOCKS.length * BLOCK_STRIDE);
  for (const b of BLOCKS) {
    if (!b) continue;
    const o = b.id * BLOCK_STRIDE;
    table.set([b.cTop.r, b.cTop.g, b.cTop.b, b.cSide.r, b.cSide.g, b.cSide.b], o);
    if (b.cSideTop) table.set([b.cSideTop.r, b.cSideTop.g, b.cSideTop.b], o + 6); else table[o + 6] = -1;
    table.set([b.cBottom.r, b.cBottom.g, b.cBottom.b, b.emit, b.anchored ? 1 : 0, tileFor(b.id, 0), tileFor(b.id, 1), tileFor(b.id, 2)], o + 9);
  }
  return table;
}

// per axis, for neighbour offset -1 / 0 / +1: [source start, destination start, length] in the padded volume
const SPAN: [number, number, number][] = [[CHUNK - 1, 0, 1], [0, 1, CHUNK], [0, CHUNK + 1, 1]];

/** padded 34³ voxel volume + chunk-local decor and damage/fire state for one chunk */
export function gatherInput(w: VoxelSource, ch: SrcChunk): MeshInput {
  const { cx, cy, cz } = ch;
  const vox = new Uint8Array(P * P * P);
  for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const [sy, py, ny] = SPAN[dy + 1], [sz, pz, nz] = SPAN[dz + 1], [sx, px, nx] = SPAN[dx + 1];
    const n = w.chunk(cx + dx, cy + dy, cz + dz);
    // nothing below the world but bedrock; ungenerated or out-of-world neighbours are air
    const fill = n ? n.fill : (cy + dy < 0 ? BEDROCK : AIR);
    const src = n ? n.blocks : null;
    for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
      const dst = px + (pz + z) * P + (py + y) * PP;
      if (src) {
        const s0 = sx | ((sz + z) << 5) | ((sy + y) << 10);
        if (nx === 1) vox[dst] = src[s0]; else vox.set(src.subarray(s0, s0 + nx), dst);
      } else if (fill !== AIR) vox.fill(fill, dst, dst + nx);
    }
  }
  const decor = ch.decor ? ch.decor.slice() : new Uint8Array(CHUNK * CHUNK * CHUNK);
  const state = new Uint8Array(CHUNK * CHUNK * CHUNK);
  // per-block damage (bits 0..6) and burning (bit 7) for blocks in this chunk
  const x0 = cx * CHUNK, y0 = cy * CHUNK, z0 = cz * CHUNK, W = w.W, WD = w.W * w.D;
  const local = (i: number): number => {
    const x = i % W - x0, z = Math.floor(i / W) % w.D - z0, y = Math.floor(i / WD) - y0;
    return (x < 0 || y < 0 || z < 0 || x >= CHUNK || y >= CHUNK || z >= CHUNK) ? -1 : x | (z << 5) | (y << 10);
  };
  for (const [i, dmg] of w.damage) {
    const li = local(i);
    if (li < 0) continue;
    const t = w.get(i % W, Math.floor(i / WD), Math.floor(i / W) % w.D), hp = BLOCKS[t] ? BLOCKS[t].hp : Infinity;
    if (hp !== Infinity) state[li] = (state[li] & 0x80) | Math.round(Math.min(1, dmg / hp) * 127);
  }
  for (const i of w.burning.keys()) { const li = local(i); if (li >= 0) state[li] |= 0x80; }
  return { key: ch.key, vox, decor, state, x0, y0, z0 };
}

// chunk-local geometry; the mesh is positioned at the chunk origin
export function solidGeometry(d: MeshData): THREE.BufferGeometry | null {
  if (!d.ind.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(d.nor, 3, true));
  g.setAttribute('color', new THREE.BufferAttribute(d.col, 3, true));
  g.setAttribute('emit', new THREE.BufferAttribute(d.emit, 1, true));
  g.setAttribute('cut', new THREE.BufferAttribute(d.cut, 1));
  g.setAttribute('tile', new THREE.BufferAttribute(d.tile, 1));
  g.setIndex(new THREE.BufferAttribute(d.ind, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(CHUNK / 2, CHUNK / 2, CHUNK / 2), CHUNK * 0.87);
  return g;
}

const UP = new Int8Array([0, 127, 0]);
export function foliageGeometry(d: MeshData): THREE.BufferGeometry | null {
  if (!d.find.length) return null;
  const n = d.fpos.length / 3;
  const nor = new Int8Array(n * 3);
  for (let i = 0; i < n; i++) nor.set(UP, i * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.fpos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3, true));
  g.setAttribute('uv', new THREE.BufferAttribute(d.fuv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(d.fcol, 3));
  g.setIndex(new THREE.BufferAttribute(d.find, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(CHUNK / 2, CHUNK / 2, CHUNK / 2), CHUNK * 0.87);
  return g;
}

// ---------------------------------------------------------------- main thread + worker pool
export class WasmMeshing {
  private mesher: Mesher;
  private mem: WebAssembly.Memory;
  private workers: Worker[] = [];
  private busy: number[] = [];
  private queue: MeshInput[] = [];
  pending = new Set<number>(); // chunk keys in flight or queued
  onResult: (d: MeshData) => void = () => {};
  /** priority of a queued chunk (lower first); Infinity drops the job and `onDrop` is called */
  rank: (key: number) => number = () => 0;
  onDrop: (key: number) => void = () => {};

  private constructor(mesher: Mesher, mem: WebAssembly.Memory) { this.mesher = mesher; this.mem = mem; }

  static async create(table: Float32Array): Promise<WasmMeshing | null> {
    try {
      const wasm = await init();
      const m = new Mesher();
      m.set_blocks(table);
      const meshing = new WasmMeshing(m, wasm.memory);
      const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
      for (let i = 0; i < n; i++) {
        const wk = new Worker(new URL('./meshWorker.ts', import.meta.url), { type: 'module' });
        wk.postMessage({ type: 'init', table });
        wk.onmessage = (e: MessageEvent<MeshData>) => {
          meshing.busy[i]--;
          meshing.pending.delete(e.data.key);
          meshing.onResult(e.data);
          meshing.pump();
        };
        wk.onerror = (e) => console.error('mesh worker error', e);
        meshing.workers.push(wk);
        meshing.busy.push(0);
      }
      return meshing;
    } catch (e) {
      console.error('WASM mesher unavailable:', e);
      return null;
    }
  }

  // synchronous mesh on the main thread (edits near the player)
  meshNow(inp: MeshInput): MeshData { return runMesher(this.mesher, this.mem, inp); }

  /** greedy face merging on (default) / off, in every mesher (for A/B comparisons; remesh after) */
  setGreedy(on: boolean): void {
    this.mesher.set_greedy(on);
    for (const wk of this.workers) wk.postMessage({ type: 'greedy', on });
  }

  // queue a chunk for the workers; nearest-first ordering is up to the caller
  request(inp: MeshInput): void {
    const key = inp.key;
    if (this.pending.has(key)) return;
    this.pending.add(key);
    this.queue.push(inp);
    this.pump();
  }

  private pump(): void {
    while (this.queue.length) {
      // least busy worker, at most two jobs each so new nearby requests don't wait behind a long queue
      let best = -1;
      for (let i = 0; i < this.workers.length; i++) if (this.busy[i] < 2 && (best < 0 || this.busy[i] < this.busy[best])) best = i;
      if (best < 0) return;
      // nearest job first; jobs for chunks that left the view are dropped
      let pick = -1, pr = Infinity;
      for (let i = 0; i < this.queue.length; i++) {
        const r = this.rank(this.queue[i].key);
        if (r === Infinity) { this.pending.delete(this.queue[i].key); this.onDrop(this.queue[i].key); this.queue.splice(i--, 1); continue; }
        if (r < pr) { pr = r; pick = i; }
      }
      if (pick < 0) return;
      const inp = this.queue.splice(pick, 1)[0];
      this.busy[best]++;
      this.workers[best].postMessage({ type: 'mesh', inp }, [inp.vox.buffer, inp.decor.buffer, inp.state.buffer]);
    }
  }

  // drop queued (not yet dispatched) jobs, e.g. after teleporting
  clearQueue(): void { for (const q of this.queue) this.pending.delete(q.key); this.queue = []; }
  get queued(): number { return this.queue.length; }
}

