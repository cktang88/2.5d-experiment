// The part of chunk meshing that runs inside workers: just the wasm module and buffer plumbing
// (kept free of three.js / world imports so worker bundles stay tiny).
import type { Mesher } from './wasm/voxel_core';

// what a worker (or the main-thread mesher) returns for one chunk
export interface MeshData {
  key: number; // chunk key
  seq: number; // the job's sequence number (results older than a chunk's current mesh are stale)

  pos: Uint8Array; nor: Int8Array; col: Uint16Array; emit: Uint8Array; cut: Uint8Array; tile: Uint8Array;
  ind: Uint32Array | Uint16Array;
  fpos: Float32Array; fuv: Float32Array; fcol: Float32Array; find: Uint32Array | Uint16Array;
}

// one meshing job: the mesher reads the chunk, its 26 neighbours and its decor from the shared
// voxel store itself; only per-block damage/fire state (chunk-local, x | z << 5 | y << 10) is
// passed along, and only when the chunk has any. `seq` grows with every job, so a result that
// comes back after a newer mesh of the same chunk was installed can be told apart and dropped
export interface MeshInput { key: number; seq: number; cx: number; cy: number; cz: number; state: Uint8Array | null }
const NO_STATE = new Uint8Array(0);

// run the mesher and copy its output out of wasm memory
export function runMesher(m: Mesher, mem: WebAssembly.Memory, inp: MeshInput): MeshData {
  const n = m.mesh_chunk(inp.cx, inp.cy, inp.cz, inp.state ?? NO_STATE);
  const buf = mem.buffer;
  const ni = m.ind_len(), fn = m.fvert_len(), fi = m.find_len();
  const ind32 = new Uint32Array(buf, m.ind_ptr(), ni);
  const find32 = new Uint32Array(buf, m.find_ptr(), fi);
  return {
    key: inp.key, seq: inp.seq,
    pos: new Uint8Array(buf, m.pos_ptr(), n * 3).slice(),
    nor: new Int8Array(buf, m.nor_ptr(), n * 3).slice(),
    col: new Uint16Array(buf, m.col_ptr(), n * 3).slice(),
    emit: new Uint8Array(buf, m.emit_ptr(), n).slice(),
    cut: new Uint8Array(buf, m.cut_ptr(), n).slice(),
    tile: new Uint8Array(buf, m.tile_ptr(), n).slice(),
    ind: n > 65535 ? ind32.slice() : Uint16Array.from(ind32),
    fpos: new Float32Array(buf, m.fpos_ptr(), fn * 3).slice(),
    fuv: new Float32Array(buf, m.fuv_ptr(), fn * 2).slice(),
    fcol: new Float32Array(buf, m.fcol_ptr(), fn * 3).slice(),
    find: fn > 65535 ? find32.slice() : Uint16Array.from(find32),
  };
}

export function transferables(d: MeshData): ArrayBuffer[] {
  return [d.pos, d.nor, d.col, d.emit, d.cut, d.tile, d.ind, d.fpos, d.fuv, d.fcol, d.find].map(a => a.buffer as ArrayBuffer);
}

