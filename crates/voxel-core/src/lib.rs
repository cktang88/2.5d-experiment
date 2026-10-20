//! Chunk mesher for Blockfall Isle.
//!
//! Greedy meshing with per-vertex ambient occlusion (AO-aware quad flipping), damage
//! darkening and crossed-card foliage, emitting compact vertex buffers:
//!
//! | attribute | type             | notes                                          |
//! |-----------|------------------|------------------------------------------------|
//! | position  | u8 x3            | chunk-local, 0..=CHUNK                         |
//! | normal    | i8 x3            | axis-aligned unit normal                       |
//! | color     | u16 x3 (unorm)   | linear RGB: face colour × AO × damage          |
//! | emit      | u8 (unorm)       | emissive strength                              |
//! | cut       | u8               | 1 for blocks the roof cutaway may hide         |
//! | tile      | u8               | bits 0..3 detail tile, 4 grass, 5 leaves, 6 burning |
//!
//! Per-block variation (hash tint, painterly grass/leaf patches, the ember tint of burning
//! blocks) is not baked into vertex colours: the world shader (`patchWorldMaterial` in
//! `src/world.ts`) recomputes it per fragment from the block cell `floor(worldPos - normal/2)`
//! and the tile flags. That keeps neighbouring faces identical so they merge into big quads.
//!
//! Chunks are cubes of CHUNK³ blocks. `mesh_chunk` gathers the padded (CHUNK+2)³ volume
//! (so neighbours across all six chunk faces are known) and the chunk's decor straight from the
//! shared voxel store (`store.rs`); `mesh` takes them as arrays (tests, tools).

use wasm_bindgen::prelude::*;

pub mod store;
use store::TableRef;

pub const CHUNK: usize = 32;
const P: usize = CHUNK + 2; // padded width
const PP: usize = P * P;
const VOL: usize = CHUNK * CHUNK * CHUNK;
const Q: usize = P + 2; // occupancy width (padded volume plus an air ring)

const AIR: u8 = 0;
const GRASS: u8 = 1;
const LEAVES: u8 = 7;

const AO_CURVE: [f32; 4] = [0.5, 0.68, 0.84, 1.0];

// tile attribute flags read by the world shader
const TILE_GRASS: u8 = 16;
const TILE_LEAVES: u8 = 32;
const TILE_BURNING: u8 = 64;

// face key (0 = no face): block type | 4 corner AOs | state | which directions it may grow in.
// Faces merge only when their keys are equal; damaged/burning faces never grow.
const K_AO: u32 = 8;
const K_STATE: u32 = 16;
const K_GROW_U: u32 = 1 << 24;
const K_GROW_V: u32 = 1 << 25;

// ---------------------------------------------------------------- noise (bit-identical to blocks.ts)
fn hash3(x: i32, y: i32, z: i32) -> f64 {
    let mut h = x.wrapping_mul(374761393) ^ y.wrapping_mul(668265263) ^ z.wrapping_mul(1274126177);
    h = (h ^ ((h as u32) >> 13) as i32).wrapping_mul(1274126177);
    h ^= ((h as u32) >> 16) as i32;
    (h as u32) as f64 / 4294967295.0
}

// ---------------------------------------------------------------- block table
#[derive(Clone, Copy, Default)]
struct Block {
    top: [f32; 3],
    side: [f32; 3],
    side_top: Option<[f32; 3]>,
    bottom: [f32; 3],
    emit: f32,
    anchored: bool,
    tiles: [u8; 3], // detail tile per face axis (x, y, z)
}

/// Per-block-id stride of the table passed to [`Mesher::set_blocks`].
pub const BLOCK_STRIDE: usize = 20;

#[wasm_bindgen]
pub struct Mesher {
    blocks: Vec<Block>,
    greedy: bool,
    // 0/1 occupancy, Q³ (padded volume plus an air ring), indexed x + z*Q + y*Q*Q
    solid: Vec<u8>,
    // face keys per direction and cell, [dir][chunk-local cell index] (pass 1 writes in cell order)
    faces: Vec<u32>,
    // bit u of rows[dir][slice][v] set = faces[..] holds a face; the greedy pass clears every
    // bit it consumes, so this is all zero again between mesh() calls
    rows: Vec<u32>,
    // shared store tables (mesh_chunk) and the padded volume gathered from it
    table: Option<TableRef>,
    vox: Vec<u8>,
    zero: Vec<u8>,
    // solid geometry
    pos: Vec<u8>,
    nor: Vec<i8>,
    col: Vec<u16>,
    emit: Vec<u8>,
    cut: Vec<u8>,
    tile: Vec<u8>,
    ind: Vec<u32>,
    // foliage
    fpos: Vec<f32>,
    fuv: Vec<f32>,
    fcol: Vec<f32>,
    find: Vec<u32>,
}

impl Default for Mesher {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl Mesher {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Mesher {
        Mesher {
            blocks: Vec::new(),
            greedy: true,
            solid: vec![0; Q * Q * Q],
            faces: vec![0; 6 * VOL],
            rows: vec![0; 6 * CHUNK * CHUNK],
            table: None,
            vox: vec![0; P * P * P],
            zero: vec![0; VOL],
            pos: Vec::new(),
            nor: Vec::new(),
            col: Vec::new(),
            emit: Vec::new(),
            cut: Vec::new(),
            tile: Vec::new(),
            ind: Vec::new(),
            fpos: Vec::new(),
            fuv: Vec::new(),
            fcol: Vec::new(),
            find: Vec::new(),
        }
    }

    /// Block table: BLOCK_STRIDE floats per block id:
    /// top rgb, side rgb, side-top rgb (r < 0 = none), bottom rgb, emit, anchored, tile x/y/z, unused x3.
    pub fn set_blocks(&mut self, table: &[f32]) {
        self.blocks = table
            .chunks_exact(BLOCK_STRIDE)
            .map(|b| Block {
                top: [b[0], b[1], b[2]],
                side: [b[3], b[4], b[5]],
                side_top: if b[6] < 0.0 { None } else { Some([b[6], b[7], b[8]]) },
                bottom: [b[9], b[10], b[11]],
                emit: b[12],
                anchored: b[13] > 0.5,
                tiles: [b[14] as u8, b[15] as u8, b[16] as u8],
            })
            .collect();
    }

    /// Merge coplanar faces into larger quads (default). Off = one quad per block face,
    /// with otherwise identical output (for comparisons and tests).
    pub fn set_greedy(&mut self, on: bool) {
        self.greedy = on;
    }

    /// Use the chunk table of a Store (by its table addresses; the Store may belong to another
    /// instance on the same shared memory).
    pub fn attach_store(&mut self, blk: usize, dec: usize, fill: usize) {
        self.table = Some(TableRef { blk: blk as *const usize, dec: dec as *const usize, fill: fill as *const u8 });
    }

    /// Mesh chunk (cx, cy, cz) from the attached store: gathers the padded volume from the chunk
    /// and its 26 neighbours and the chunk's decor. `state` is chunk-local damage/fire state as in
    /// `mesh`, or empty for none. Returns the solid vertex count.
    pub fn mesh_chunk(&mut self, cx: i32, cy: i32, cz: i32, state: &[u8]) -> usize {
        let t = self.table.expect("attach_store first");
        let mut vox = std::mem::take(&mut self.vox);
        // per axis, for neighbour offset -1 / 0 / +1: (source start, destination start, length)
        const SPAN: [(usize, usize, usize); 3] = [(CHUNK - 1, 0, 1), (0, 1, CHUNK), (0, CHUNK + 1, 1)];
        for dy in 0..3 {
            for dz in 0..3 {
                for dx in 0..3 {
                    let ((sy, py, ny), (sz, pz, nz), (sx, px, nx)) = (SPAN[dy], SPAN[dz], SPAN[dx]);
                    let (src, fill, _) = t.chunk(cx + dx as i32 - 1, cy + dy as i32 - 1, cz + dz as i32 - 1);
                    for y in 0..ny {
                        for z in 0..nz {
                            let dst = px + (pz + z) * P + (py + y) * PP;
                            if src.is_null() {
                                vox[dst..dst + nx].fill(fill);
                            } else {
                                // racing reads of bytes the main thread may be editing; see store.rs
                                let s0 = sx | ((sz + z) << 5) | ((sy + y) << 10);
                                unsafe { std::ptr::copy_nonoverlapping(src.add(s0), vox.as_mut_ptr().add(dst), nx) }
                            }
                        }
                    }
                }
            }
        }
        let (_, _, dec) = t.chunk(cx, cy, cz);
        let zero = std::mem::take(&mut self.zero);
        let decor = if dec.is_null() { &zero[..] } else { unsafe { std::slice::from_raw_parts(dec, VOL) } };
        let state = if state.is_empty() { &zero[..] } else { state };
        let n = self.mesh(&vox, decor, state, cx * CHUNK as i32, cy * CHUNK as i32, cz * CHUNK as i32);
        self.vox = vox;
        self.zero = zero;
        n
    }

    /// Mesh one chunk. `vox` is the padded volume indexed `px + pz*P + py*P*P` where each
    /// padded coordinate runs from -1..=CHUNK relative to the chunk origin (x0, y0, z0);
    /// `decor` and `state` are chunk-local (`lx + lz*CHUNK + ly*CHUNK*CHUNK`).
    /// `state` bit 7 = burning, bits 0..6 = damage ratio * 127. Returns the solid vertex count.
    pub fn mesh(&mut self, vox: &[u8], decor: &[u8], state: &[u8], x0: i32, y0: i32, z0: i32) -> usize {
        self.pos.clear();
        self.nor.clear();
        self.col.clear();
        self.emit.clear();
        self.cut.clear();
        self.tile.clear();
        self.ind.clear();
        self.fpos.clear();
        self.fuv.clear();
        self.fcol.clear();
        self.find.clear();
        // all coordinates below are padded-local (0..P); the padding ring comes from neighbours.
        // Occupancy gets one more ring of air so neighbour lookups (-1..=P) need no range checks.
        // first[x + z*P]: height of the lowest air cell of each padded column
        let mut solid = std::mem::take(&mut self.solid);
        let mut first = [0u8; PP];
        for y in 0..P {
            for z in 0..P {
                let (src, dst) = ((y * P + z) * P, ((y + 1) * Q + z + 1) * Q + 1);
                let fr = &mut first[z * P..z * P + P];
                for ((d, &v), f) in solid[dst..dst + P].iter_mut().zip(&vox[src..src + P]).zip(fr) {
                    *d = (v != AIR) as u8;
                    *f += (*f as usize == y && v != AIR) as u8;
                }
            }
        }
        let occ = |x: i32, y: i32, z: i32| -> bool { solid[(((y + 1) * Q as i32 + z + 1) * Q as i32 + x + 1) as usize] != 0 };
        // ---- pass 1: visible faces and their AO into the per-direction face masks, column by
        // column; cells below the lowest air of the column and its 4 neighbours are buried
        for lz in 0..CHUNK {
            for lx in 0..CHUNK {
                let c = (lx + 1) + (lz + 1) * P;
                let buried = first[c].min(first[c - 1]).min(first[c + 1]).min(first[c - P]).min(first[c + P]) as usize;
                for ly in buried.saturating_sub(2)..CHUNK {
                    let y = ly + 1; // padded
                    let (px, py, pz) = (lx as i32 + 1, y as i32, lz as i32 + 1);
                    let t = vox[c + y * PP];
                    let li = lx + lz * CHUNK + ly * CHUNK * CHUNK;
                    if t == AIR {
                        let d = decor[li];
                        if d != 0 && occ(px, py - 1, pz) {
                            self.foliage(lx as f32, ly as f32, lz as f32, x0 + lx as i32, y0 + ly as i32, z0 + lz as i32, d);
                        }
                        continue;
                    }
                    let st = state[li];
                    let side_top = self.blocks.get(t as usize).is_some_and(|b| b.side_top.is_some());
                    let l = [lx, ly, lz];
                    for f in 0..6 {
                        let a = f / 2;
                        let s: i32 = if f % 2 == 0 { 1 } else { -1 };
                        let mut n3 = [px, py, pz];
                        n3[a] += s;
                        if occ(n3[0], n3[1], n3[2]) {
                            continue;
                        }
                        let u = (a + 1) % 3;
                        let v = (a + 2) % 3;
                        // occupancy of the 3x3 neighbourhood in the layer outside the face
                        let mut nb = [false; 9];
                        for j in -1i32..=1 {
                            for k in -1i32..=1 {
                                if j == 0 && k == 0 {
                                    continue;
                                }
                                let mut q = n3;
                                q[u] += j;
                                q[v] += k;
                                nb[((j + 1) * 3 + k + 1) as usize] = occ(q[0], q[1], q[2]);
                            }
                        }
                        // corner k at (du, dv) = (0,0) (1,0) (1,1) (0,1)
                        let mut aos = [0u32; 4];
                        for (k, ao) in aos.iter_mut().enumerate() {
                            let su = if k == 1 || k == 2 { 2 } else { 0 };
                            let sv = if k >= 2 { 2 } else { 0 };
                            let s1 = nb[su * 3 + 1] as u32;
                            let s2 = nb[3 + sv] as u32;
                            let cc = nb[su * 3 + sv] as u32;
                            *ao = if s1 == 1 && s2 == 1 { 0 } else { 3 - (s1 + s2 + cc) };
                        }
                        // a quad may grow along an axis only if its AO doesn't change along it (so
                        // interpolation over the big quad equals the per-block one), not at all when
                        // damaged/burning, and grass-like sides (side-top gradient) never vertically
                        let mut key = t as u32 | (aos[0] | aos[1] << 2 | aos[2] << 4 | aos[3] << 6) << K_AO | (st as u32) << K_STATE;
                        if st == 0 {
                            if aos[0] == aos[1] && aos[3] == aos[2] && !(side_top && u == 1) {
                                key |= K_GROW_U;
                            }
                            if aos[0] == aos[3] && aos[1] == aos[2] && !(side_top && v == 1) {
                                key |= K_GROW_V;
                            }
                        }
                        self.faces[f * VOL + li] = key;
                        self.rows[(f * CHUNK + l[a]) * CHUNK + l[v]] |= 1 << l[u];
                    }
                }
            }
        }
        // ---- pass 2: greedy merge per direction and slice, row by row
        const STRIDE: [usize; 3] = [1, CHUNK * CHUNK, CHUNK]; // cell index step per axis
        for f in 0..6 {
            let a = f / 2;
            let (su, sv) = (STRIDE[(a + 1) % 3], STRIDE[(a + 2) % 3]);
            for sl in 0..CHUNK {
                let base = (f * CHUNK + sl) * CHUNK; // row index of v = 0
                let fb = f * VOL + sl * STRIDE[a]; // face index of (u, v) = (0, 0)
                for v in 0..CHUNK {
                    while self.rows[base + v] != 0 {
                        let bits = self.rows[base + v];
                        let u = bits.trailing_zeros() as usize;
                        let key = self.faces[fb + u * su + v * sv];
                        let mut w = 1;
                        if self.greedy && key & K_GROW_U != 0 {
                            while u + w < CHUNK && bits & (1 << (u + w)) != 0 && self.faces[fb + (u + w) * su + v * sv] == key {
                                w += 1;
                            }
                        }
                        let span = (u32::MAX >> (32 - w)) << u; // bits u..u+w
                        let mut h = 1;
                        if self.greedy && key & K_GROW_V != 0 {
                            while v + h < CHUNK
                                && self.rows[base + v + h] & span == span
                                && (u..u + w).all(|i| self.faces[fb + i * su + (v + h) * sv] == key)
                            {
                                h += 1;
                            }
                        }
                        for r in v..v + h {
                            self.rows[base + r] &= !span;
                        }
                        self.quad(f, sl, u, v, w, h, key);
                    }
                }
            }
        }
        self.solid = solid;
        self.pos.len() / 3
    }

    /// Emit one quad of `w` x `h` block faces in direction `f`, slice `sl`, starting at (u, v).
    #[allow(clippy::too_many_arguments)]
    fn quad(&mut self, f: usize, sl: usize, u0: usize, v0: usize, w: usize, h: usize, key: u32) {
        let a = f / 2;
        let s: i32 = if f % 2 == 0 { 1 } else { -1 };
        let u = (a + 1) % 3;
        let v = (a + 2) % 3;
        let t = (key & 0xff) as u8;
        let st = (key >> K_STATE & 0xff) as u8;
        let bd = self.blocks.get(t as usize).copied().unwrap_or_default();
        let dmg_k = 1.0 - 0.45 * ((st & 0x7f) as f32 / 127.0);
        let burning = st & 0x80 != 0;
        let emit = if bd.emit != 0.0 { bd.emit } else if burning { 0.6 } else { 0.0 };
        let emit = (emit.clamp(0.0, 1.0) * 255.0).round() as u8;
        let cut = if bd.anchored { 0 } else { 1 };
        let tile = bd.tiles[a]
            | if t == GRASS { TILE_GRASS } else { 0 }
            | if t == LEAVES { TILE_LEAVES } else { 0 }
            | if burning { TILE_BURNING } else { 0 };
        let mut nrm = [0i8; 3];
        nrm[a] = (s * 127) as i8; // normalised int8 attribute: 127 decodes to 1.0
        let mut c0 = [0usize; 3];
        c0[a] = sl + (s > 0) as usize;
        c0[u] = u0;
        c0[v] = v0;
        let base = (self.pos.len() / 3) as u32;
        let mut aos = [0usize; 4];
        for (k, ao) in aos.iter_mut().enumerate() {
            let du = (k == 1 || k == 2) as usize;
            let dv = (k >= 2) as usize;
            let mut q = c0;
            q[u] += du * w;
            q[v] += dv * h;
            self.pos.extend_from_slice(&[q[0] as u8, q[1] as u8, q[2] as u8]);
            self.nor.extend_from_slice(&nrm);
            *ao = (key >> (K_AO + 2 * k as u32) & 3) as usize;
            // side faces with a side-top colour (grass) are one block tall: top edge gets it
            let fc = if a == 1 {
                if s > 0 { bd.top } else { bd.bottom }
            } else {
                match bd.side_top {
                    Some(stc) if q[1] > c0[1] => stc,
                    _ => bd.side,
                }
            };
            let m = AO_CURVE[*ao] * dmg_k;
            let q16 = |c: f32| ((c * m).clamp(0.0, 1.0) * 65535.0 + 0.5) as u16;
            self.col.extend_from_slice(&[q16(fc[0]), q16(fc[1]), q16(fc[2])]);
            self.emit.push(emit);
            self.cut.push(cut);
            self.tile.push(tile);
        }
        // winding: cyclic (u,v) gives CCW for positive faces; flip the diagonal by AO
        let tri: [u32; 6] = if aos[0] + aos[2] < aos[1] + aos[3] {
            if s > 0 { [1, 2, 3, 1, 3, 0] } else { [1, 3, 2, 1, 0, 3] }
        } else if s > 0 {
            [0, 1, 2, 0, 2, 3]
        } else {
            [0, 2, 1, 0, 3, 2]
        };
        self.ind.extend(tri.iter().map(|o| base + o));
    }

    #[allow(clippy::too_many_arguments)]
    fn foliage(&mut self, lx: f32, y: f32, lz: f32, wx: i32, wy: i32, wz: i32, d: u8) {
        let tile = (d - 1) as f32;
        let r = hash3(wx, wy, wz.wrapping_mul(3));
        let cxp = lx as f64 + 0.5 + (r - 0.5) * 0.4;
        let czp = lz as f64 + 0.5 + (hash3(wz, wx, wy) - 0.5) * 0.4;
        let h = if d <= 3 { 0.55 } else { 0.75 } + r * 0.3;
        let w = 0.5 + r * 0.15;
        let (u0, u1) = (tile / 8.0, (tile + 1.0) / 8.0);
        let shade = (0.85 + r * 0.25) as f32;
        for k in 0..2 {
            let ang = r * std::f64::consts::PI + k as f64 * std::f64::consts::FRAC_PI_2;
            let (dx, dz) = (ang.cos() * w, ang.sin() * w);
            let b = (self.fpos.len() / 3) as u32;
            let (yb, yt) = (y, (y as f64 + h) as f32);
            self.fpos.extend_from_slice(&[
                (cxp - dx) as f32, yb, (czp - dz) as f32,
                (cxp + dx) as f32, yb, (czp + dz) as f32,
                (cxp + dx) as f32, yt, (czp + dz) as f32,
                (cxp - dx) as f32, yt, (czp - dz) as f32,
            ]);
            for _ in 0..4 {
                self.fcol.extend_from_slice(&[shade, shade, shade]);
            }
            self.fuv.extend_from_slice(&[u0, 0.0, u1, 0.0, u1, 1.0, u0, 1.0]);
            // both windings with an upward normal so the cards are lit like the ground
            self.find.extend_from_slice(&[b, b + 1, b + 2, b, b + 2, b + 3, b, b + 2, b + 1, b, b + 3, b + 2]);
        }
    }

    // ---- output views (pointers into wasm memory; copy them out before the next mesh() call)
    pub fn pos_ptr(&self) -> *const u8 { self.pos.as_ptr() }
    pub fn nor_ptr(&self) -> *const i8 { self.nor.as_ptr() }
    pub fn col_ptr(&self) -> *const u16 { self.col.as_ptr() }
    pub fn emit_ptr(&self) -> *const u8 { self.emit.as_ptr() }
    pub fn cut_ptr(&self) -> *const u8 { self.cut.as_ptr() }
    pub fn tile_ptr(&self) -> *const u8 { self.tile.as_ptr() }
    pub fn ind_ptr(&self) -> *const u32 { self.ind.as_ptr() }
    pub fn ind_len(&self) -> usize { self.ind.len() }
    pub fn fpos_ptr(&self) -> *const f32 { self.fpos.as_ptr() }
    pub fn fuv_ptr(&self) -> *const f32 { self.fuv.as_ptr() }
    pub fn fcol_ptr(&self) -> *const f32 { self.fcol.as_ptr() }
    pub fn find_ptr(&self) -> *const u32 { self.find.as_ptr() }
    pub fn fvert_len(&self) -> usize { self.fpos.len() / 3 }
    pub fn find_len(&self) -> usize { self.find.len() }
}

#[cfg(test)]
mod tests;
