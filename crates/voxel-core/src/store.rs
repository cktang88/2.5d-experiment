//! Shared voxel store.
//!
//! In the browser build the WebAssembly memory is a shared `WebAssembly.Memory`: the main
//! thread and every worker instantiate this module on the same memory, so chunk data lives in
//! one place. Each 32³ chunk array (blocks, decor, water) is a 32 KB "slab" from this module's
//! allocator; JS reads and writes slabs through typed-array views, workers generate columns
//! straight into them, and the mesher gathers a chunk's neighbourhood from them without any copy
//! or transfer.
//!
//! The chunk table (one entry per chunk of the 160 x 16 x 160 chunk world, indexed
//! `cx + cz*CX + cy*CX*CZ`) records each chunk's block and decor slab and its fill value.
//! Only the main thread writes the table; workers only read it.
//!
//! Concurrency: a worker may read a slab while the main thread edits it. Byte reads can see a
//! mix of old and new blocks; the main thread marks every edited chunk dirty and remeshes it, so
//! such a mesh is replaced. Slabs are only freed for columns far outside the meshed area.
use wasm_bindgen::prelude::*;
use std::alloc::{alloc_zeroed, dealloc, Layout};

pub const CX: usize = 160;
pub const CY: usize = 16;
pub const CZ: usize = 160;
pub const NCHUNK: usize = CX * CY * CZ;
pub const SLAB: usize = 32 * 32 * 32;
/// fill value of a chunk that isn't loaded (read as air)
pub const ABSENT: u8 = 0xff;

fn slab_layout() -> Layout {
    Layout::from_size_align(SLAB, 64).unwrap()
}

/// A zeroed 32 KB slab; returns its address in linear memory.
#[wasm_bindgen]
pub fn slab_alloc() -> usize {
    unsafe { alloc_zeroed(slab_layout()) as usize }
}

/// Return a slab from slab_alloc().
#[wasm_bindgen]
pub fn slab_free(ptr: usize) {
    if ptr != 0 {
        unsafe { dealloc(ptr as *mut u8, slab_layout()) }
    }
}

/// Chunk table. JS gets the three array addresses and writes them through views.
#[wasm_bindgen]
pub struct Store {
    // addresses are usize (u32 in wasm, which is what the JS Uint32Array views see)
    #[wasm_bindgen(skip)]
    pub blk: Vec<usize>,
    #[wasm_bindgen(skip)]
    pub dec: Vec<usize>,
    #[wasm_bindgen(skip)]
    pub fill: Vec<u8>,
}

#[wasm_bindgen]
impl Store {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Store {
        Store { blk: vec![0; NCHUNK], dec: vec![0; NCHUNK], fill: vec![ABSENT; NCHUNK] }
    }
    /// u32 per chunk: block slab address (0 = uniform, see fill)
    pub fn blk_ptr(&self) -> usize { self.blk.as_ptr() as usize }
    /// u32 per chunk: decor slab address (0 = no decor)
    pub fn dec_ptr(&self) -> usize { self.dec.as_ptr() as usize }
    /// u8 per chunk: block of a uniform chunk, ABSENT when not loaded
    pub fn fill_ptr(&self) -> usize { self.fill.as_ptr() as usize }
    pub fn chunks(&self) -> usize { NCHUNK }
}

impl Default for Store {
    fn default() -> Self { Self::new() }
}

/// Read-only access to a store's tables (by address, so other instances on the same memory can use it).
#[derive(Clone, Copy)]
pub struct TableRef {
    pub blk: *const usize,
    pub dec: *const usize,
    pub fill: *const u8,
}

impl TableRef {
    /// (block slab or null, fill, decor slab or null) of a chunk; out of the world: bedrock below, air elsewhere
    pub fn chunk(&self, cx: i32, cy: i32, cz: i32) -> (*const u8, u8, *const u8) {
        if cy < 0 { return (std::ptr::null(), 5, std::ptr::null()); }
        if cx < 0 || cz < 0 || cx >= CX as i32 || cy >= CY as i32 || cz >= CZ as i32 { return (std::ptr::null(), 0, std::ptr::null()); }
        let k = cx as usize + cz as usize * CX + cy as usize * CX * CZ;
        unsafe {
            let f = *self.fill.add(k);
            if f == ABSENT { return (std::ptr::null(), 0, std::ptr::null()); }
            (*self.blk.add(k) as *const u8, f, *self.dec.add(k) as *const u8)
        }
    }
}
