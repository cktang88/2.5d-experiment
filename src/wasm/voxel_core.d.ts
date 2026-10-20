/* tslint:disable */
/* eslint-disable */
/**
 * A zeroed 32 KB slab; returns its address in linear memory.
 */
export function slab_alloc(): number;
/**
 * Return a slab from slab_alloc().
 */
export function slab_free(ptr: number): void;
export class Mesher {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Mesh chunk (cx, cy, cz) from the attached store: gathers the padded volume from the chunk
   * and its 26 neighbours and the chunk's decor. `state` is chunk-local damage/fire state as in
   * `mesh`, or empty for none. Returns the solid vertex count.
   */
  mesh_chunk(cx: number, cy: number, cz: number, state: Uint8Array): number;
  /**
   * Block table: BLOCK_STRIDE floats per block id:
   * top rgb, side rgb, side-top rgb (r < 0 = none), bottom rgb, emit, anchored, tile x/y/z, unused x3.
   */
  set_blocks(table: Float32Array): void;
  /**
   * Merge coplanar faces into larger quads (default). Off = one quad per block face,
   * with otherwise identical output (for comparisons and tests).
   */
  set_greedy(on: boolean): void;
  /**
   * Use the chunk table of a Store (by its table addresses; the Store may belong to another
   * instance on the same shared memory).
   */
  attach_store(blk: number, dec: number, fill: number): void;
  constructor();
  /**
   * Mesh one chunk. `vox` is the padded volume indexed `px + pz*P + py*P*P` where each
   * padded coordinate runs from -1..=CHUNK relative to the chunk origin (x0, y0, z0);
   * `decor` and `state` are chunk-local (`lx + lz*CHUNK + ly*CHUNK*CHUNK`).
   * `state` bit 7 = burning, bits 0..6 = damage ratio * 127. Returns the solid vertex count.
   */
  mesh(vox: Uint8Array, decor: Uint8Array, state: Uint8Array, x0: number, y0: number, z0: number): number;
  col_ptr(): number;
  cut_ptr(): number;
  fuv_ptr(): number;
  ind_len(): number;
  ind_ptr(): number;
  nor_ptr(): number;
  pos_ptr(): number;
  emit_ptr(): number;
  fcol_ptr(): number;
  find_len(): number;
  find_ptr(): number;
  fpos_ptr(): number;
  tile_ptr(): number;
  fvert_len(): number;
}
/**
 * Chunk table. JS gets the three array addresses and writes them through views.
 */
export class Store {
  free(): void;
  [Symbol.dispose](): void;
  constructor();
  chunks(): number;
  /**
   * u32 per chunk: block slab address (0 = uniform, see fill)
   */
  blk_ptr(): number;
  /**
   * u32 per chunk: decor slab address (0 = no decor)
   */
  dec_ptr(): number;
  /**
   * u8 per chunk: block of a uniform chunk, ABSENT when not loaded
   */
  fill_ptr(): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly __wbg_mesher_free: (a: number, b: number) => void;
  readonly __wbg_store_free: (a: number, b: number) => void;
  readonly mesher_attach_store: (a: number, b: number, c: number, d: number) => void;
  readonly mesher_col_ptr: (a: number) => number;
  readonly mesher_cut_ptr: (a: number) => number;
  readonly mesher_emit_ptr: (a: number) => number;
  readonly mesher_fcol_ptr: (a: number) => number;
  readonly mesher_find_len: (a: number) => number;
  readonly mesher_find_ptr: (a: number) => number;
  readonly mesher_fpos_ptr: (a: number) => number;
  readonly mesher_fuv_ptr: (a: number) => number;
  readonly mesher_fvert_len: (a: number) => number;
  readonly mesher_ind_len: (a: number) => number;
  readonly mesher_ind_ptr: (a: number) => number;
  readonly mesher_mesh: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => number;
  readonly mesher_mesh_chunk: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
  readonly mesher_new: () => number;
  readonly mesher_nor_ptr: (a: number) => number;
  readonly mesher_pos_ptr: (a: number) => number;
  readonly mesher_set_blocks: (a: number, b: number, c: number) => void;
  readonly mesher_set_greedy: (a: number, b: number) => void;
  readonly mesher_tile_ptr: (a: number) => number;
  readonly store_blk_ptr: (a: number) => number;
  readonly store_chunks: (a: number) => number;
  readonly store_dec_ptr: (a: number) => number;
  readonly store_fill_ptr: (a: number) => number;
  readonly store_new: () => number;
  readonly slab_alloc: () => number;
  readonly slab_free: (a: number) => void;
  readonly memory: WebAssembly.Memory;
  readonly __wbindgen_export_1: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_thread_destroy: (a?: number, b?: number, c?: number) => void;
  readonly __wbindgen_start: (a: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number }} module - Passing `SyncInitInput` directly is deprecated.
* @param {WebAssembly.Memory} memory - Deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number } | SyncInitInput, memory?: WebAssembly.Memory): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number }} module_or_path - Passing `InitInput` directly is deprecated.
* @param {WebAssembly.Memory} memory - Deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number } | InitInput | Promise<InitInput>, memory?: WebAssembly.Memory): Promise<InitOutput>;
