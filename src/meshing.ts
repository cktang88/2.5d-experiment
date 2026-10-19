// Chunk meshing in WebAssembly (Rust crate `crates/voxel-core`).
//  - a pool of Web Workers meshes streamed chunks entirely off the main thread
//  - a main-thread instance remeshes chunks the player just edited, so breaks show up instantly
// Output uses compact vertex formats (u8 positions, i8 normals, u16 colours: ~20 bytes/vertex
// instead of 64), which the existing world shader reads unchanged.
import * as THREE from 'three';
import init, { Mesher } from './wasm/voxel_core';
import { runMesher } from './meshCore';
import type { MeshData, MeshInput } from './meshCore';
export type { MeshData, MeshInput };
import { BLOCKS, tileFor } from './world';

export const CHUNK = 16;
const P = CHUNK + 2;
const BLOCK_STRIDE = 20;

export interface VoxelSource {
  W: number; H: number; D: number;
  data: Uint8Array; decor: Uint8Array;
  damage: Map<number, number>; burning: Map<number, number>;
}

// block colours/flags in the layout the Rust mesher expects
export function blockTable(grassAlt: THREE.Color, leafAlt: THREE.Color, ember: THREE.Color): { table: Float32Array; extra: Float32Array } {
  const table = new Float32Array(BLOCKS.length * BLOCK_STRIDE);
  for (const b of BLOCKS) {
    if (!b) continue;
    const o = b.id * BLOCK_STRIDE;
    table.set([b.cTop.r, b.cTop.g, b.cTop.b, b.cSide.r, b.cSide.g, b.cSide.b], o);
    if (b.cSideTop) table.set([b.cSideTop.r, b.cSideTop.g, b.cSideTop.b], o + 6); else table[o + 6] = -1;
    table.set([b.cBottom.r, b.cBottom.g, b.cBottom.b, b.emit, b.anchored ? 1 : 0, tileFor(b.id, 0), tileFor(b.id, 1), tileFor(b.id, 2)], o + 9);
  }
  const extra = new Float32Array([grassAlt.r, grassAlt.g, grassAlt.b, leafAlt.r, leafAlt.g, leafAlt.b, ember.r, ember.g, ember.b]);
  return { table, extra };
}

export function gatherInput(w: VoxelSource, cx: number, cz: number): MeshInput {
  const { W, H, D } = w, WD = W * D, x0 = cx * CHUNK, z0 = cz * CHUNK;
  const vox = new Uint8Array(P * P * H), decor = new Uint8Array(CHUNK * CHUNK * H), state = new Uint8Array(CHUNK * CHUNK * H);
  for (let y = 0; y < H; y++) {
    for (let lz = 0; lz < P; lz++) {
      const z = z0 + lz - 1;
      if (z < 0 || z >= D) continue;
      const rowSrc = z * W + y * WD, rowDst = lz * P + y * P * P;
      const xa = Math.max(0, x0 - 1), xb = Math.min(W, x0 + CHUNK + 1);
      vox.set(w.data.subarray(rowSrc + xa, rowSrc + xb), rowDst + (xa - (x0 - 1)));
    }
    for (let lz = 0; lz < CHUNK; lz++) {
      const src = x0 + (z0 + lz) * W + y * WD;
      decor.set(w.decor.subarray(src, src + CHUNK), lz * CHUNK + y * CHUNK * CHUNK);
    }
  }
  // per-block damage (bits 0..6) and burning (bit 7) for blocks in this chunk
  const put = (i: number, f: (old: number) => number) => {
    const x = i % W, z = Math.floor(i / W) % D, y = Math.floor(i / WD);
    if (x < x0 || x >= x0 + CHUNK || z < z0 || z >= z0 + CHUNK) return;
    const li = (x - x0) + (z - z0) * CHUNK + y * CHUNK * CHUNK;
    state[li] = f(state[li]);
  };
  for (const [i, dmg] of w.damage) {
    const t = w.data[i], hp = BLOCKS[t] ? BLOCKS[t].hp : Infinity;
    if (hp !== Infinity) put(i, (o) => (o & 0x80) | Math.round(Math.min(1, dmg / hp) * 127));
  }
  for (const i of w.burning.keys()) put(i, (o) => o | 0x80);
  return { cx, cz, vox, decor, state, x0, z0, h: H };
}

// chunk-local geometry; the mesh is positioned at the chunk origin
export function solidGeometry(d: MeshData, h: number): THREE.BufferGeometry | null {
  if (!d.ind.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(d.nor, 3, true));
  g.setAttribute('color', new THREE.BufferAttribute(d.col, 3, true));
  g.setAttribute('emit', new THREE.BufferAttribute(d.emit, 1, true));
  g.setAttribute('cut', new THREE.BufferAttribute(d.cut, 1));
  g.setAttribute('tile', new THREE.BufferAttribute(d.tile, 1));
  g.setIndex(new THREE.BufferAttribute(d.ind, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(CHUNK / 2, h / 2, CHUNK / 2), Math.hypot(CHUNK / 2, h / 2, CHUNK / 2));
  return g;
}

const UP = new Int8Array([0, 127, 0]);
export function foliageGeometry(d: MeshData, h: number): THREE.BufferGeometry | null {
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
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(CHUNK / 2, h / 2, CHUNK / 2), Math.hypot(CHUNK / 2, h / 2, CHUNK / 2));
  return g;
}

// ---------------------------------------------------------------- main thread + worker pool
export class WasmMeshing {
  private mesher: Mesher;
  private mem: WebAssembly.Memory;
  private workers: Worker[] = [];
  private busy: number[] = [];
  private queue: MeshInput[] = [];
  pending = new Set<number>(); // chunk keys (cx + cz * 4096) in flight or queued
  onResult: (d: MeshData) => void = () => {};

  private constructor(mesher: Mesher, mem: WebAssembly.Memory) { this.mesher = mesher; this.mem = mem; }

  static async create(table: Float32Array, extra: Float32Array): Promise<WasmMeshing | null> {
    try {
      const wasm = await init();
      const m = new Mesher();
      m.set_blocks(table, extra);
      const meshing = new WasmMeshing(m, wasm.memory);
      const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
      for (let i = 0; i < n; i++) {
        const wk = new Worker(new URL('./meshWorker.ts', import.meta.url), { type: 'module' });
        wk.postMessage({ type: 'init', table, extra });
        wk.onmessage = (e: MessageEvent<MeshData>) => {
          meshing.busy[i]--;
          meshing.pending.delete(e.data.cx + e.data.cz * 4096);
          meshing.onResult(e.data);
          meshing.pump();
        };
        wk.onerror = (e) => console.error('mesh worker error', e);
        meshing.workers.push(wk);
        meshing.busy.push(0);
      }
      return meshing;
    } catch (e) {
      console.warn('WASM mesher unavailable, using the TypeScript mesher:', e);
      return null;
    }
  }

  // synchronous mesh on the main thread (edits near the player)
  meshNow(inp: MeshInput): MeshData { return runMesher(this.mesher, this.mem, inp); }

  // queue a chunk for the workers; nearest-first ordering is up to the caller
  request(inp: MeshInput): void {
    const key = inp.cx + inp.cz * 4096;
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
      const inp = this.queue.shift()!;
      this.busy[best]++;
      this.workers[best].postMessage({ type: 'mesh', inp }, [inp.vox.buffer, inp.decor.buffer, inp.state.buffer]);
    }
  }

  // drop queued (not yet dispatched) jobs, e.g. after teleporting
  clearQueue(): void { for (const q of this.queue) this.pending.delete(q.cx + q.cz * 4096); this.queue = []; }
  get queued(): number { return this.queue.length; }
}

