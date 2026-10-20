//! Greedy-merge correctness: every merged mesh must cover exactly the faces of the one-quad-per-
//! face mesh (no holes, no overlaps) with identical interpolated colours and per-face attributes.
use super::*;
use std::collections::HashMap;

// distinct colours per block id; grass has a side-top colour like the game's
pub fn mesher(greedy: bool) -> Mesher {
    let mut m = Mesher::new();
    let mut table = vec![0.0f32; BLOCK_STRIDE * 12];
    for (id, b) in table.chunks_exact_mut(BLOCK_STRIDE).enumerate() {
        let c = id as f32 / 12.0;
        b[..12].copy_from_slice(&[c, 0.5, 0.2, 0.3, c, 0.6, -1.0, 0.0, 0.0, 0.7, 0.1, c]);
        b[12] = if id == 9 { 1.0 } else { 0.0 };
        b[13] = (id % 2) as f32;
        b[14..17].copy_from_slice(&[(id % 16) as f32, ((id + 1) % 16) as f32, ((id + 2) % 16) as f32]);
    }
    table[GRASS as usize * BLOCK_STRIDE + 6..][..3].copy_from_slice(&[0.4, 0.8, 0.3]);
    m.set_blocks(&table);
    m.set_greedy(greedy);
    m
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 32) as u32
    }
    fn below(&mut self, n: u32) -> u32 {
        self.next() % n
    }
}

// terrain-like padded volume: rolling heightmap of stone/dirt/grass, scattered blocks and holes,
// a few damaged/burning blocks
fn scene(seed: u64) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let mut r = Rng(seed.wrapping_mul(2654435761) + 1);
    let mut vox = vec![0u8; P * P * P];
    for z in 0..P {
        for x in 0..P {
            let h = (10.0 + (x as f32 * 0.07).sin() * 3.0 + (z as f32 * 0.05).cos() * 2.0) as usize + (r.below(40) == 0) as usize;
            for y in 0..h.min(P) {
                vox[x + z * P + y * PP] = if y + 1 == h { GRASS } else if y + 4 > h { 2 } else { 3 };
            }
        }
    }
    for _ in 0..80 {
        let i = r.below((P * P * P) as u32) as usize;
        vox[i] = if r.below(3) == 0 { 0 } else { 1 + r.below(11) as u8 };
    }
    let mut state = vec![0u8; VOL];
    for _ in 0..40 {
        state[r.below(VOL as u32) as usize] = r.below(256) as u8;
    }
    (vox, vec![0u8; VOL], state)
}

// unit face (dir, cell) -> (4 corner colours, emit, cut, tile), decoded from any quad mesh;
// panics on overlapping faces, non-planar quads or inward-facing triangles
type Faces = HashMap<(usize, [usize; 3]), ([[u16; 3]; 4], u8, u8, u8)>;
fn unit_faces(m: &Mesher) -> Faces {
    let mut out = Faces::new();
    let n = m.pos.len() / 3;
    assert_eq!(n % 4, 0);
    assert_eq!(m.ind.len(), n / 4 * 6);
    for qd in 0..n / 4 {
        let b = qd * 4;
        let a = (0..3).find(|&i| m.nor[b * 3 + i] != 0).unwrap();
        let s = m.nor[b * 3 + a] > 0;
        let f = a * 2 + !s as usize;
        let (u, v) = ((a + 1) % 3, (a + 2) % 3);
        let p = |k: usize, ax: usize| m.pos[(b + k) * 3 + ax] as usize;
        let (u0, v0) = ((0..4).map(|k| p(k, u)).min().unwrap(), (0..4).map(|k| p(k, v)).min().unwrap());
        let (w, h) = ((0..4).map(|k| p(k, u)).max().unwrap() - u0, (0..4).map(|k| p(k, v)).max().unwrap() - v0);
        assert!(w >= 1 && h >= 1);
        // corner colours by (du, dv) in {0,1}²
        let mut cc = [[[0f64; 3]; 2]; 2];
        for k in 0..4 {
            assert_eq!(p(k, a), p(0, a), "quad not planar");
            let (du, dv) = ((p(k, u) > u0) as usize, (p(k, v) > v0) as usize);
            for ch in 0..3 {
                cc[du][dv][ch] = m.col[(b + k) * 3 + ch] as f64;
            }
            assert_eq!((m.emit[b + k], m.cut[b + k], m.tile[b + k]), (m.emit[b], m.cut[b], m.tile[b]));
        }
        // both triangles face along the normal
        for t in 0..2 {
            let i = &m.ind[qd * 6 + t * 3..][..3];
            let vtx = |j: u32| [0, 1, 2].map(|ax| m.pos[j as usize * 3 + ax] as i32);
            let (p0, p1, p2) = (vtx(i[0]), vtx(i[1]), vtx(i[2]));
            let (e1, e2) = ([0, 1, 2].map(|x| p1[x] - p0[x]), [0, 1, 2].map(|x| p2[x] - p0[x]));
            let cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            assert!(cr[a] != 0 && (cr[a] > 0) == s, "bad winding");
        }
        let at = |x: usize, y: usize, ch: usize| -> u16 {
            let (x, y) = (x as f64 / w as f64, y as f64 / h as f64);
            let lo = cc[0][0][ch] * (1.0 - x) + cc[1][0][ch] * x;
            let hi = cc[0][1][ch] * (1.0 - x) + cc[1][1][ch] * x;
            (lo * (1.0 - y) + hi * y).round() as u16
        };
        for j in 0..h {
            for i in 0..w {
                let mut cell = [0usize; 3];
                cell[a] = p(0, a) - s as usize;
                cell[u] = u0 + i;
                cell[v] = v0 + j;
                let corners = [(0, 0), (1, 0), (1, 1), (0, 1)].map(|(du, dv)| [0, 1, 2].map(|ch| at(i + du, j + dv, ch)));
                let prev = out.insert((f, cell), (corners, m.emit[b], m.cut[b], m.tile[b]));
                assert!(prev.is_none(), "overlapping faces at {:?} dir {}", cell, f);
            }
        }
    }
    out
}

#[test]
fn hash_in_unit_range() {
    assert_eq!(hash3(0, 0, 0), 0.0);
    let h = hash3(12, 34, 56);
    assert!((0.0..=1.0).contains(&h));
}

#[test]
fn single_block_has_six_faces() {
    let mut m = mesher(true);
    let mut vox = vec![0u8; P * P * P];
    vox[(1 + 1) + (1 + 1) * P + 2 * P * P] = 3;
    let n = m.mesh(&vox, &[0; VOL], &[0; VOL], 0, 0, 0);
    assert_eq!(n, 24);
    assert_eq!(m.ind_len(), 36);
}

#[test]
fn flat_floor_is_one_quad() {
    let mut vox = vec![0u8; P * P * P];
    for z in 0..P {
        for x in 0..P {
            for y in 0..5 {
                vox[x + z * P + y * PP] = if y == 4 { GRASS } else { 3 };
            }
        }
    }
    let (mut g, mut n) = (mesher(true), mesher(false));
    g.mesh(&vox, &[0; VOL], &[0; VOL], 0, 0, 0);
    n.mesh(&vox, &[0; VOL], &[0; VOL], 0, 0, 0);
    // the padding ring is solid too, so there are no side faces: the whole top is one quad
    assert_eq!(g.pos.len() / 12, 1);
    assert_eq!(n.pos.len() / 12, CHUNK * CHUNK);
    assert_eq!(unit_faces(&g), unit_faces(&n));
}

#[test]
fn grass_sides_merge_only_horizontally() {
    // a 4-high wall of grass: x faces could merge in y and z, but only z is allowed
    let mut vox = vec![0u8; P * P * P];
    for z in 0..P {
        for y in 0..4 {
            vox[5 + z * P + (y + 1) * PP] = GRASS;
        }
    }
    let mut g = mesher(true);
    g.mesh(&vox, &[0; VOL], &[0; VOL], 0, 0, 0);
    let mut n = mesher(false);
    n.mesh(&vox, &[0; VOL], &[0; VOL], 0, 0, 0);
    assert_eq!(unit_faces(&g), unit_faces(&n));
    for qd in 0..g.pos.len() / 12 {
        if g.nor[qd * 12] != 0 {
            let ys: Vec<u8> = (0..4).map(|k| g.pos[(qd * 4 + k) * 3 + 1]).collect();
            assert_eq!(ys.iter().max().unwrap() - ys.iter().min().unwrap(), 1);
        }
    }
}

#[test]
fn damaged_and_burning_blocks_never_merge() {
    let mut vox = vec![0u8; P * P * P];
    for x in 0..P {
        vox[x + 5 * P + 5 * PP] = 3;
    }
    let mut state = vec![0u8; VOL];
    // two neighbours with the same damage still don't merge with each other
    state[10 + 4 * CHUNK + 4 * CHUNK * CHUNK] = 40;
    state[11 + 4 * CHUNK + 4 * CHUNK * CHUNK] = 40;
    state[20 + 4 * CHUNK + 4 * CHUNK * CHUNK] = 0x80;
    let (mut g, mut n) = (mesher(true), mesher(false));
    g.mesh(&vox, &[0; VOL], &state, 0, 0, 0);
    n.mesh(&vox, &[0; VOL], &state, 0, 0, 0);
    // 4 long sides of a 32-long bar, each split into [0,10) 10 11 [12,20) 20 [21,32)
    assert_eq!(g.pos.len() / 12, 4 * 6);
    assert_eq!(unit_faces(&g), unit_faces(&n));
    let burning = (0..g.tile.len()).filter(|&i| g.tile[i] & TILE_BURNING != 0).count();
    assert_eq!(burning, 4 * 4);
}

#[test]
fn greedy_covers_exactly_the_naive_faces() {
    let (mut gv, mut nv) = (0, 0);
    for seed in 0..32 {
        let (vox, decor, state) = scene(seed);
        let (mut g, mut n) = (mesher(true), mesher(false));
        g.mesh(&vox, &decor, &state, 64, 32, 96);
        n.mesh(&vox, &decor, &state, 64, 32, 96);
        let (gf, nf) = (unit_faces(&g), unit_faces(&n));
        assert_eq!(gf.len(), nf.len(), "seed {seed}: face count");
        for (k, val) in &nf {
            assert_eq!(gf.get(k), Some(val), "seed {seed}: face {k:?}");
        }
        (gv, nv) = (gv + g.pos.len(), nv + n.pos.len());
        // the mesher is reusable: a second run gives the same result (the row masks were cleared)
        let before = g.pos.clone();
        g.mesh(&vox, &decor, &state, 64, 32, 96);
        assert_eq!(before, g.pos);
    }
    assert!(gv * 3 < nv * 2, "merging ineffective: {gv} vs {nv}");
}

type Input = (Vec<u8>, Vec<u8>, Vec<u8>, [i32; 3]);

// chunk inputs dumped from the game (per chunk: vox | decor | state | x0 y0 z0 as i32 LE)
fn load_dump(path: &str) -> Vec<Input> {
    let b = std::fs::read(path).unwrap();
    let per = P * P * P + 2 * VOL + 12;
    b.chunks_exact(per)
        .map(|c| {
            let (vox, rest) = c.split_at(P * P * P);
            let (decor, rest) = rest.split_at(VOL);
            let (state, o) = rest.split_at(VOL);
            let i = |k: usize| i32::from_le_bytes(o[k * 4..k * 4 + 4].try_into().unwrap());
            (vox.to_vec(), decor.to_vec(), state.to_vec(), [i(0), i(1), i(2)])
        })
        .collect()
}

/// Per-chunk mesh time and vertex counts, greedy vs naive:
/// `MESH_DUMPS=a.bin,b.bin cargo test --release -- --ignored --nocapture bench` (real chunks dumped by
/// the browser harness, also checked for exact coverage), or synthetic terrain without MESH_DUMPS.
#[test]
#[ignore]
fn bench() {
    let sets: Vec<(String, Vec<Input>)> = match std::env::var("MESH_DUMPS") {
        Ok(v) => v.split(',').map(|p| (p.rsplit('/').next().unwrap().to_string(), load_dump(p))).collect(),
        Err(_) => vec![("synthetic".into(), (0..64).map(|s| { let (a, b, c) = scene(s); (a, b, c, [0; 3]) }).collect())],
    };
    for (name, chunks) in &sets {
        let (mut g, mut n) = (mesher(true), mesher(false));
        for (vox, decor, state, o) in chunks {
            g.mesh(vox, decor, state, o[0], o[1], o[2]);
            n.mesh(vox, decor, state, o[0], o[1], o[2]);
            assert_eq!(unit_faces(&g), unit_faces(&n), "{name}: coverage");
        }
        for (label, m) in [("naive", &mut n), ("greedy", &mut g)] {
            // best of MESH_REPS (default 20) passes, as the machine may be busy
            let reps = std::env::var("MESH_REPS").map_or(20, |r| r.parse().unwrap());
            let (mut verts, mut tris, mut best) = (0, 0, f64::MAX);
            for _ in 0..reps {
                let t = std::time::Instant::now();
                (verts, tris) = (0, 0);
                for (vox, decor, state, o) in chunks {
                    verts += m.mesh(vox, decor, state, o[0], o[1], o[2]);
                    tris += m.ind_len() / 3;
                }
                best = best.min(t.elapsed().as_secs_f64());
            }
            let us = best * 1e6 / chunks.len() as f64;
            println!("{name:>28} {label:>6}: {} chunks, {verts:>7} verts, {tris:>7} tris, {us:.0} us/chunk", chunks.len());
        }
    }
}

// mesh_chunk (gathering from the store) must give exactly what mesh gives on the same padded volume
#[test]
fn mesh_chunk_matches_mesh() {
    use crate::store::*;
    let mut st = Store::new();
    let mut rng = Rng(0x9e3779b97f4a7c15);
    // a 3x3x3 block of chunks around (5, 1, 7): random terrain, one uniform rock chunk, one absent
    let mut slabs = Vec::new();
    for cy in 0..3i32 { for cz in 6..9i32 { for cx in 4..7i32 {
        let k = cx as usize + cz as usize * CX + cy as usize * CX * CZ;
        if (cx, cy, cz) == (4, 0, 6) { st.fill[k] = 3; continue; }
        if (cx, cy, cz) == (6, 2, 8) { continue; }
        let p = slab_alloc();
        let b = unsafe { std::slice::from_raw_parts_mut(p as *mut u8, SLAB) };
        for (i, v) in b.iter_mut().enumerate() { let y = (i >> 10) as i32 + cy * 32; *v = if y < 40 + (rng.next() % 6) as i32 { 1 + (rng.next() % 9) as u8 } else { 0 }; }
        st.blk[k] = p; st.fill[k] = 0; slabs.push(p);
    }}}
    let dec = slab_alloc();
    let kc = 5 + 7 * CX + CX * CZ;
    st.dec[kc] = dec;
    unsafe { *(dec as *mut u8).add(3 | (4 << 5) | (20 << 10)) = 2; }
    let mut a = mesher(true);
    a.attach_store(st.blk_ptr(), st.dec_ptr(), st.fill_ptr());
    let n1 = a.mesh_chunk(5, 1, 7, &[]);
    let (pos1, ind1, fpos1) = (a.pos.clone(), a.ind.clone(), a.fpos.clone());
    // the same volume gathered by hand
    let t = TableRef { blk: st.blk.as_ptr(), dec: st.dec.as_ptr(), fill: st.fill.as_ptr() };
    let mut vox = vec![0u8; P * P * P];
    for py in 0..P { for pz in 0..P { for px in 0..P {
        let (wx, wy, wz) = (5 * 32 + px as i32 - 1, 32 + py as i32 - 1, 7 * 32 + pz as i32 - 1);
        let (b, f, _) = t.chunk(wx >> 5, wy >> 5, wz >> 5);
        vox[px + pz * P + py * PP] = if b.is_null() { f } else { unsafe { *b.add(((wx & 31) | ((wz & 31) << 5) | ((wy & 31) << 10)) as usize) } };
    }}}
    let decor = unsafe { std::slice::from_raw_parts(dec as *const u8, VOL) }.to_vec();
    let mut b2 = mesher(true);
    let n2 = b2.mesh(&vox, &decor, &vec![0; VOL], 160, 32, 224);
    assert!(n1 > 0);
    assert_eq!(n1, n2);
    assert_eq!(pos1, b2.pos);
    assert_eq!(ind1, b2.ind);
    assert_eq!(fpos1, b2.fpos);
    for p in slabs { slab_free(p); }
    slab_free(dec);
}
