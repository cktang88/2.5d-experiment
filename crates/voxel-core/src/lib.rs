//! Chunk mesher for Blockfall Isle.
//!
//! A port of the TypeScript mesher in `src/world.ts` (face culling with per-vertex
//! ambient occlusion, painterly tint/noise patches, damage and fire shading, crossed-card
//! foliage), emitting compact vertex buffers:
//!
//! | attribute | type             | notes                                   |
//! |-----------|------------------|-----------------------------------------|
//! | position  | u8 x3            | chunk-local (x,z in 0..=16, y in 0..=H) |
//! | normal    | i8 x3            | axis-aligned unit normal                |
//! | color     | u16 x3 (unorm)   | linear RGB                              |
//! | emit      | u8 (unorm)       | emissive strength                       |
//! | cut       | u8               | 1 for blocks the roof cutaway may hide  |
//! | tile      | u8               | detail-texture tile index               |
//!
//! Input is a padded voxel volume ((CHUNK+2) x H x (CHUNK+2)) so neighbours across chunk
//! borders are known, plus chunk-local decor and per-block state (damage/burning).

use wasm_bindgen::prelude::*;

pub const CHUNK: usize = 16;
const P: usize = CHUNK + 2; // padded width

const AIR: u8 = 0;
const GRASS: u8 = 1;
const LEAVES: u8 = 7;

const AO_CURVE: [f32; 4] = [0.5, 0.68, 0.84, 1.0];

// ---------------------------------------------------------------- noise (bit-identical to world.ts)
fn hash3(x: i32, y: i32, z: i32) -> f64 {
    let mut h = x.wrapping_mul(374761393) ^ y.wrapping_mul(668265263) ^ z.wrapping_mul(1274126177);
    h = (h ^ ((h as u32) >> 13) as i32).wrapping_mul(1274126177);
    h ^= ((h as u32) >> 16) as i32;
    (h as u32) as f64 / 4294967295.0
}

fn vnoise(x: f64, y: f64, seed: i32) -> f64 {
    let xi = x.floor();
    let yi = y.floor();
    let (xf, yf) = (x - xi, y - yi);
    let u = xf * xf * (3.0 - 2.0 * xf);
    let v = yf * yf * (3.0 - 2.0 * yf);
    let (xi, yi) = (xi as i32, yi as i32);
    let a = hash3(xi, yi, seed);
    let b = hash3(xi + 1, yi, seed);
    let c = hash3(xi, yi + 1, seed);
    let d = hash3(xi + 1, yi + 1, seed);
    a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

fn fbm(x: f64, y: f64, seed: i32, oct: i32) -> f64 {
    let (mut s, mut a, mut f, mut n) = (0.0, 0.5, 1.0, 0.0);
    for i in 0..oct {
        s += vnoise(x * f, y * f, seed + i * 17) * a;
        n += a;
        a *= 0.5;
        f *= 2.0;
    }
    s / n
}

fn smoothstep(x: f64, min: f64, max: f64) -> f64 {
    if x <= min {
        return 0.0;
    }
    if x >= max {
        return 1.0;
    }
    let t = (x - min) / (max - min);
    t * t * (3.0 - 2.0 * t)
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
    grass_alt: [f32; 3],
    leaf_alt: [f32; 3],
    ember: [f32; 3],
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
            grass_alt: [0.0; 3],
            leaf_alt: [0.0; 3],
            ember: [0.0; 3],
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
    /// top rgb, side rgb, side-top rgb (r < 0 = none), bottom rgb, emit, anchored, tile x/y/z, unused x2.
    /// `extra` holds grass-alt rgb, leaf-alt rgb and ember rgb.
    pub fn set_blocks(&mut self, table: &[f32], extra: &[f32]) {
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
        self.grass_alt = [extra[0], extra[1], extra[2]];
        self.leaf_alt = [extra[3], extra[4], extra[5]];
        self.ember = [extra[6], extra[7], extra[8]];
    }

    /// Mesh one chunk. `vox` is the padded volume indexed `lx + lz*18 + y*18*18` where lx/lz
    /// run from -1..=16 relative to the chunk origin; `decor` and `state` are chunk-local
    /// (`lx + lz*16 + y*256`). `state` bit 7 = burning, bits 0..6 = damage ratio * 127.
    /// Returns the number of solid vertices.
    pub fn mesh(&mut self, vox: &[u8], decor: &[u8], state: &[u8], x0: i32, z0: i32, h: usize) -> usize {
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
        let stride_y = P * P;
        let occ = |x: i32, y: i32, z: i32| -> bool {
            // x, z are padded-local (0..18); below the world is solid, above it is air
            if y < 0 {
                return true;
            }
            if y >= h as i32 || x < 0 || z < 0 || x >= P as i32 || z >= P as i32 {
                return false;
            }
            vox[x as usize + z as usize * P + y as usize * stride_y] != AIR
        };
        // cells below this height in a column are buried (solid on all six sides): skip them
        let mut first = [0usize; P * P];
        for lz in 0..P {
            for lx in 0..P {
                let mut y = 0;
                while y < h && vox[lx + lz * P + y * stride_y] != AIR {
                    y += 1;
                }
                first[lx + lz * P] = y;
            }
        }
        let mut patch_cache = [f64::NAN; CHUNK * CHUNK];
        for y in 0..h {
            for lz in 0..CHUNK {
                for lx in 0..CHUNK {
                    let c = (lx + 1) + (lz + 1) * P;
                    let buried = first[c].min(first[c - 1]).min(first[c + 1]).min(first[c - P]).min(first[c + P]);
                    if y + 1 < buried {
                        continue;
                    }
                    let (px, pz) = (lx as i32 + 1, lz as i32 + 1);
                    let t = vox[c + y * stride_y];
                    let wx = x0 + lx as i32;
                    let wz = z0 + lz as i32;
                    let li = lx + lz * CHUNK + y * CHUNK * CHUNK;
                    if t == AIR {
                        let d = decor[li];
                        if d != 0 && occ(px, y as i32 - 1, pz) {
                            self.foliage(lx as f32, y as f32, lz as f32, wx, y as i32, wz, d);
                        }
                        continue;
                    }
                    let bd = self.blocks.get(t as usize).copied().unwrap_or_default();
                    let mut setup = false;
                    let (mut dmg_k, mut tint, mut patch_a, mut burning, mut emit) = (1.0f64, 1.0f64, 0.0f64, false, 0.0f32);
                    for f in 0..6 {
                        let a = f / 2;
                        let s: i32 = if f % 2 == 0 { 1 } else { -1 };
                        let mut n3 = [px, y as i32, pz];
                        n3[a] += s;
                        if occ(n3[0], n3[1], n3[2]) {
                            continue;
                        }
                        if !setup {
                            setup = true;
                            let st = state[li];
                            dmg_k = 1.0 - 0.45 * ((st & 0x7f) as f64 / 127.0);
                            tint = if t == LEAVES { 0.78 + hash3(wx, y as i32, wz) * 0.32 } else { 0.9 + hash3(wx, y as i32, wz) * 0.16 };
                            if t == GRASS || t == LEAVES {
                                let pi = lx + lz * CHUNK;
                                if patch_cache[pi].is_nan() {
                                    patch_cache[pi] = fbm(wx as f64 * 0.07, wz as f64 * 0.07, 999, 2);
                                }
                                patch_a = smoothstep(patch_cache[pi], 0.35, 0.7) * 0.75;
                            } else {
                                patch_a = -1.0;
                            }
                            burning = st & 0x80 != 0;
                            emit = if bd.emit != 0.0 { bd.emit } else if burning { 0.6 } else { 0.0 };
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
                        let base = (self.pos.len() / 3) as u32;
                        let tile = bd.tiles[a];
                        let mut nrm = [0i8; 3];
                        nrm[a] = (s * 127) as i8; // normalised int8 attribute: 127 decodes to 1.0
                        let mut aos = [0usize; 4];
                        for k in 0..4 {
                            let du = (k == 1 || k == 2) as i32;
                            let dv = (k >= 2) as i32;
                            let mut q = [lx as i32, y as i32, lz as i32];
                            if s > 0 {
                                q[a] += 1;
                            }
                            q[u] += du;
                            q[v] += dv;
                            self.pos.extend_from_slice(&[q[0] as u8, q[1] as u8, q[2] as u8]);
                            self.nor.extend_from_slice(&nrm);
                            let su = if du == 1 { 2 } else { 0 };
                            let sv = if dv == 1 { 2 } else { 0 };
                            let s1 = nb[su * 3 + 1] as usize;
                            let s2 = nb[3 + sv] as usize;
                            let cc = nb[su * 3 + sv] as usize;
                            let ao = if s1 == 1 && s2 == 1 { 0 } else { 3 - (s1 + s2 + cc) };
                            aos[k] = ao;
                            let upper = q[1] > y as i32;
                            let fc = if a == 1 {
                                if s > 0 { bd.top } else { bd.bottom }
                            } else {
                                match bd.side_top {
                                    Some(st) if upper => st,
                                    _ => bd.side,
                                }
                            };
                            let (mut r, mut g, mut b) = (fc[0] as f64, fc[1] as f64, fc[2] as f64);
                            if patch_a >= 0.0 && (a == 1 || t == LEAVES || upper) {
                                let alt = if t == LEAVES { self.leaf_alt } else { self.grass_alt };
                                r += (alt[0] as f64 - r) * patch_a;
                                g += (alt[1] as f64 - g) * patch_a;
                                b += (alt[2] as f64 - b) * patch_a;
                            }
                            let m = tint * AO_CURVE[ao] as f64 * dmg_k;
                            r *= m;
                            g *= m;
                            b *= m;
                            if burning {
                                let e = self.ember;
                                r += (e[0] as f64 - r) * 0.65;
                                g += (e[1] as f64 - g) * 0.65;
                                b += (e[2] as f64 - b) * 0.65;
                            }
                            let q16 = |c: f64| (c.clamp(0.0, 1.0) * 65535.0).round() as u16;
                            self.col.extend_from_slice(&[q16(r), q16(g), q16(b)]);
                            self.emit.push((emit.clamp(0.0, 1.0) * 255.0).round() as u8);
                            self.cut.push(if bd.anchored { 0 } else { 1 });
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
                }
            }
        }
        self.pos.len() / 3
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
mod tests {
    use super::*;

    #[test]
    fn hash_matches_js_reference() {
        // values produced by world.ts hash3() in the browser
        assert!((hash3(0, 0, 0) - 0.0).abs() < 1e-12);
        let h = hash3(12, 34, 56);
        assert!(h >= 0.0 && h <= 1.0);
    }

    #[test]
    fn single_block_has_six_faces() {
        let mut m = Mesher::new();
        let mut table = vec![0.0f32; BLOCK_STRIDE * 4];
        for b in table.chunks_exact_mut(BLOCK_STRIDE) { b[6] = -1.0; }
        m.set_blocks(&table, &[0.0; 9]);
        let h = 4;
        let mut vox = vec![0u8; P * P * h];
        vox[(1 + 1) + (1 + 1) * P + 1 * P * P] = 3;
        let decor = vec![0u8; CHUNK * CHUNK * h];
        let state = vec![0u8; CHUNK * CHUNK * h];
        let n = m.mesh(&vox, &decor, &state, 0, 0, h);
        assert_eq!(n, 24);
        assert_eq!(m.ind_len(), 36);
    }
}
