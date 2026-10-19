/* tslint:disable */
/* eslint-disable */
export class Mesher {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Block table: BLOCK_STRIDE floats per block id:
   * top rgb, side rgb, side-top rgb (r < 0 = none), bottom rgb, emit, anchored, tile x/y/z, unused x2.
   * `extra` holds grass-alt rgb, leaf-alt rgb and ember rgb.
   */
  set_blocks(table: Float32Array, extra: Float32Array): void;
  constructor();
  /**
   * Mesh one chunk. `vox` is the padded volume indexed `lx + lz*18 + y*18*18` where lx/lz
   * run from -1..=16 relative to the chunk origin; `decor` and `state` are chunk-local
   * (`lx + lz*16 + y*256`). `state` bit 7 = burning, bits 0..6 = damage ratio * 127.
   * Returns the number of solid vertices.
   */
  mesh(vox: Uint8Array, decor: Uint8Array, state: Uint8Array, x0: number, z0: number, h: number): number;
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

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_mesher_free: (a: number, b: number) => void;
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
  readonly mesher_new: () => number;
  readonly mesher_nor_ptr: (a: number) => number;
  readonly mesher_pos_ptr: (a: number) => number;
  readonly mesher_set_blocks: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly mesher_tile_ptr: (a: number) => number;
  readonly __wbindgen_export_0: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
