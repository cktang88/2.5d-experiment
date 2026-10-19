// The part of chunk meshing that runs inside workers: just the wasm module and buffer plumbing
// (kept free of three.js / world imports so worker bundles stay tiny).
import type { Mesher } from './wasm/voxel_core';

// what a worker (or the main-thread mesher) returns for one chunk
export interface MeshData {
  key: number; // chunk key

  pos: Uint8Array; nor: Int8Array; col: Uint16Array; emit: Uint8Array; cut: Uint8Array; tile: Uint8Array;
  ind: Uint32Array | Uint16Array;
  fpos: Float32Array; fuv: Float32Array; fcol: Float32Array; find: Uint32Array | Uint16Array;
}

// inputs gathered from the world for one chunk
// vox: padded 34³ volume (px + pz*34 + py*34*34); decor/state: chunk-local 32³ (x | z << 5 | y << 10)
export interface MeshInput { key: number; vox: Uint8Array; decor: Uint8Array; state: Uint8Array; x0: number; y0: number; z0: number }

// run the mesher and copy its output out of wasm memory
export function runMesher(m: Mesher, mem: WebAssembly.Memory, inp: MeshInput): MeshData {
  const n = m.mesh(inp.vox, inp.decor, inp.state, inp.x0, inp.y0, inp.z0);
  const buf = mem.buffer;
  const ni = m.ind_len(), fn = m.fvert_len(), fi = m.find_len();
  const ind32 = new Uint32Array(buf, m.ind_ptr(), ni);
  const find32 = new Uint32Array(buf, m.find_ptr(), fi);
  return {
    key: inp.key,
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

