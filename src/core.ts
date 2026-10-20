// The voxel core in shared memory. The Rust crate (crates/voxel-core) is compiled with threads, so
// its linear memory is a shared WebAssembly.Memory. The main thread creates the memory and the
// chunk table (Store); every worker instantiates the same module on the same memory. Chunk arrays
// (blocks, decor, water) are 32 KB slabs from the Rust allocator, used from JS as Uint8Array views,
// so workers generate columns straight into them and the mesher gathers neighbourhoods from them:
// no voxel data is copied or transferred between threads.
// Kept free of three.js / world imports so worker bundles stay small.
import init, { Store, slab_alloc, slab_free } from './wasm/voxel_core';

export const SLAB = 32 * 32 * 32;
/** chunk-table fill value of a chunk that isn't loaded */
export const ABSENT = 0xff;
const PAGES_INITIAL = 1024, PAGES_MAX = 32768; // 64 MB, growing on demand up to 2 GB

/** what a worker needs to join the core (structured-cloneable; the memory is shared, not copied) */
export interface CoreHandle {
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
  blk: number; dec: number; fill: number; // chunk table addresses
}

export class VoxelCore {
  readonly handle: CoreHandle;
  // the main thread's chunk table; held for the whole session, because wasm-bindgen frees a Rust
  // object once its JS wrapper is garbage-collected (and the table is written through raw views)
  store: Store | null = null;
  private constructor(handle: CoreHandle) { this.handle = handle; }

  /** main thread: create the shared memory, instantiate the module and allocate the chunk table */
  static async create(): Promise<VoxelCore> {
    const memory = new WebAssembly.Memory({ initial: PAGES_INITIAL, maximum: PAGES_MAX, shared: true });
    await init({ memory });
    const module = (init as unknown as { __wbindgen_wasm_module: WebAssembly.Module }).__wbindgen_wasm_module;
    const store = new Store();
    const core = new VoxelCore({ module, memory, blk: store.blk_ptr(), dec: store.dec_ptr(), fill: store.fill_ptr() });
    core.store = store;
    return core;
  }

  /** worker: instantiate the module on the main thread's memory */
  static async attach(handle: CoreHandle): Promise<VoxelCore> {
    await init({ module_or_path: handle.module, memory: handle.memory });
    return new VoxelCore(handle);
  }

  get memory(): WebAssembly.Memory { return this.handle.memory; }

  /** a zeroed slab as a view (its byteOffset is its address in the shared memory) */
  alloc(): Uint8Array {
    const ptr = slab_alloc();
    // out of memory (the 2 GB maximum is reached): a view at address 0 would silently scribble over
    // the module's own static data, so fail loudly instead
    if (!ptr) throw new Error('voxel core: out of slab memory');
    // memory.buffer is re-read every time: the allocation may just have grown the memory
    return new Uint8Array(this.handle.memory.buffer, ptr, SLAB);
  }
  free(a: Uint8Array | null): void { if (a) slab_free(a.byteOffset); }

  /** views of the chunk table (main thread writes them; workers and the mesher only read) */
  tables(n: number): { blk: Uint32Array; dec: Uint32Array; fill: Uint8Array } {
    const buf = this.handle.memory.buffer, h = this.handle;
    return { blk: new Uint32Array(buf, h.blk, n), dec: new Uint32Array(buf, h.dec, n), fill: new Uint8Array(buf, h.fill, n) };
  }
}
