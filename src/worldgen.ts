// Deterministic, chunk-by-chunk world generation.
// Everything is a pure function of the seed: terrain height comes from noise,
// structure sites are chosen once up front, and every builder writes through a
// clipped writer. A castle that spans four chunks is therefore built identically
// no matter which of those chunks happens to be generated first.
import { B, BLOCKS, WATER_LEVEL, hash3, fbm } from './world';

export const CHUNK = 16;

export type SiteKind = 'castle' | 'ruin' | 'hut' | 'tower' | 'reservoir';
export interface Site {
  kind: SiteKind;
  x: number; z: number;
  g: number; // ground level (y of the first air block) at the site
  r: number; // footprint radius used for terrain flattening and keep-out
}

// What a chunk generator writes into. The world implements this.
export interface GenTarget {
  W: number; H: number; D: number;
  data: Uint8Array; decor: Uint8Array;
  lanterns: Set<number>;
  water: Uint8Array | null; // water levels (FULL = 8, 0x80 = infinite source)
}

const WATER_FULL = 8, WATER_SOURCE = 0x80;
const smooth = (x: number, a: number, b: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class WorldGen {
  W: number; H: number; D: number; seed: number;
  sites: Site[] = [];
  private siteGrid = new Map<number, Site[]>(); // 64x64 buckets for fast lookups
  // clip rectangle of the chunk currently being generated
  private x0 = 0; private x1 = 0; private z0 = 0; private z1 = 0;
  private t!: GenTarget;

  constructor(W: number, H: number, D: number, seed: number) {
    this.W = W; this.H = H; this.D = D; this.seed = seed;
    this.placeSites();
  }

  // ---------- terrain ----------
  rawHeight(x: number, z: number): number {
    const { W, D, seed } = this;
    const nx = x / W - 0.5, nz = z / D - 0.5;
    // one big island with a ragged coastline and a few inland lakes
    const dist = Math.sqrt(nx * nx + nz * nz) * 2 + (fbm(x * 0.006, z * 0.006, seed + 21, 3) - 0.5) * 0.35;
    const island = 1 - smooth(dist, 0.7, 0.97);
    const h = fbm(x * 0.03, z * 0.03, seed, 4);
    const hills = Math.pow(fbm(x * 0.012 + 50, z * 0.012 + 50, seed + 9, 4), 2.4);
    const lakes = smooth(fbm(x * 0.01 + 300, z * 0.01, seed + 31, 3), 0.62, 0.72);
    return 3 + island * (5 + h * 5 + hills * 30) * (1 - lakes * 0.8);
  }

  // terrain height with flattened pads under structures
  heightAt(x: number, z: number): number {
    let h = this.rawHeight(x, z);
    for (const s of this.sitesNear(x, z)) {
      if (s.kind === 'reservoir') continue;
      const d = Math.hypot(x - s.x, z - s.z);
      const k = 1 - smooth(d, s.r, s.r + 8);
      if (k > 0) h = h + (s.g - 0.8 - h) * k;
    }
    return h;
  }

  topBlock(h: number): number { return h <= WATER_LEVEL ? B.SAND : h > 19 ? B.STONE : B.GRASS; }

  // ---------- structure sites ----------
  private placeSites(): void {
    const { W, D, seed } = this;
    const cx = W >> 1, cz = D >> 1;
    const add = (kind: SiteKind, x: number, z: number, r: number, gOverride?: number) => {
      const g = gOverride ?? Math.floor(this.rawHeight(x, z)) + 1;
      const s: Site = { kind, x, z, g, r };
      this.sites.push(s);
      const reach = r + 12;
      for (let bz = Math.floor((z - reach) / 64); bz <= Math.floor((z + reach) / 64); bz++)
        for (let bx = Math.floor((x - reach) / 64); bx <= Math.floor((x + reach) / 64); bx++) {
          const key = bx + bz * 1024;
          (this.siteGrid.get(key) ?? this.siteGrid.set(key, []).get(key)!).push(s);
        }
    };
    const clear = (x: number, z: number, r: number) => this.sites.every(s => Math.hypot(s.x - x, s.z - z) > s.r + r + 10);
    const land = (x: number, z: number, min = WATER_LEVEL + 2, max = 17) => { const h = this.rawHeight(x, z); return h > min && h < max; };
    add('castle', cx, cz, 16, 10);
    let n = 0;
    // ruined forts, villages of huts, watchtowers and dammed reservoirs, scattered by seed
    const plan: [SiteKind, number, number, number][] = [['ruin', 3, 13, 140], ['hut', 26, 6, 60], ['tower', 14, 4, 50], ['reservoir', 5, 6, 60]];
    for (const [kind, count, r, minDist] of plan) {
      let placed = 0;
      for (let i = 0; placed < count && i < 4000; i++, n++) {
        const x = 24 + Math.floor(hash3(n, 1, seed + 101) * (W - 48)), z = 24 + Math.floor(hash3(n, 2, seed + 101) * (D - 48));
        if (Math.hypot(x - cx, z - cz) < minDist) continue;
        if (kind === 'reservoir' ? !land(x, z, 16, 40) : !land(x, z)) continue;
        if (!clear(x, z, r)) continue;
        // huts come in small villages: place a few more around the first one
        add(kind, x, z, r);
        placed++;
        if (kind === 'hut') for (let k = 0; k < 3 && placed < count; k++) {
          const a = hash3(n, k, seed + 7) * Math.PI * 2, hx = Math.round(x + Math.cos(a) * 16), hz = Math.round(z + Math.sin(a) * 16);
          if (land(hx, hz) && clear(hx, hz, r)) { add('hut', hx, hz, r); placed++; }
        }
      }
    }
  }

  sitesNear(x: number, z: number): Site[] {
    return this.siteGrid.get(Math.floor(x / 64) + Math.floor(z / 64) * 1024) ?? [];
  }

  private nearSite(x: number, z: number, pad: number): boolean {
    for (const s of this.sitesNear(x, z)) if (Math.hypot(x - s.x, z - s.z) < s.r + pad) return true;
    return false;
  }

  // ---------- clipped writes ----------
  private inClip(x: number, z: number): boolean { return x >= this.x0 && x < this.x1 && z >= this.z0 && z < this.z1; }
  private put(x: number, y: number, z: number, t: number): void {
    if (!this.inClip(x, z) || y < 0 || y >= this.H) return;
    const T = this.t, i = x + z * T.W + y * T.W * T.D;
    T.data[i] = t;
    if (t !== B.AIR) T.decor[i] = 0;
    if (t === B.LANTERN) T.lanterns.add(i);
    if (t !== B.AIR && T.water) T.water[i] = 0;
  }
  private get(x: number, y: number, z: number): number {
    if (!this.inClip(x, z) || y < 0 || y >= this.H) return B.AIR;
    const T = this.t;
    return T.data[x + z * T.W + y * T.W * T.D];
  }
  private putWater(x: number, y: number, z: number): void {
    const T = this.t;
    if (!T.water || !this.inClip(x, z) || y < 1 || y >= this.H) return;
    const i = x + z * T.W + y * T.W * T.D;
    if (T.data[i] === B.AIR) T.water[i] = WATER_FULL;
  }
  private box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, t: number): void {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.put(x, y, z, t);
  }

  // ---------- chunk generation ----------
  generateChunk(target: GenTarget, cx: number, cz: number): void {
    this.t = target;
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    this.x0 = x0; this.z0 = z0; this.x1 = Math.min(x0 + CHUNK, this.W); this.z1 = Math.min(z0 + CHUNK, this.D);
    const { H, seed } = this, W = target.W, WD = target.W * target.D;
    // 1. terrain columns
    for (let z = z0; z < this.z1; z++) for (let x = x0; x < this.x1; x++) {
      const h = Math.min(H - 2, Math.floor(this.heightAt(x, z)));
      const top = this.topBlock(h);
      for (let y = 0; y <= h; y++) {
        let t: number;
        if (y === 0) t = B.BEDROCK;
        else if (y === h) t = top;
        else if (y > h - 3) t = top === B.GRASS ? B.DIRT : top;
        else t = B.STONE;
        if (t === B.STONE && y > 3 && hash3(x, y, z + seed) < 0.035) t = B.ORE;
        target.data[x + z * W + y * WD] = t;
      }
      // ore poking out of rocky hilltops
      if (top === B.STONE && hash3(x, 7, z + seed) < 0.03) target.data[x + z * W + h * WD] = B.ORE;
      // the sea is an infinite water source
      if (target.water && h < WATER_LEVEL) for (let y = h + 1; y < WATER_LEVEL; y++) target.water[x + z * W + y * WD] = WATER_FULL | WATER_SOURCE;
    }
    // 2. structures overlapping this chunk
    for (const s of this.sites) {
      const reach = s.r + 6;
      if (s.x + reach < x0 || s.x - reach >= this.x1 || s.z + reach < z0 || s.z - reach >= this.z1) continue;
      if (s.kind === 'castle') this.castle(s.x, s.z, s.g, false);
      else if (s.kind === 'ruin') this.castle(s.x, s.z, s.g, true);
      else if (s.kind === 'hut') this.hut(s.x, s.z, s.g);
      else if (s.kind === 'tower') this.tower(s.x, s.z, s.g);
      else this.reservoir(s.x, s.z);
    }
    // 3. trees (a canopy can reach 3 blocks into neighbouring chunks)
    for (let z = z0 - 3; z < this.z1 + 3; z++) for (let x = x0 - 3; x < this.x1 + 3; x++) {
      const y = this.treeAt(x, z);
      if (y > 0) this.tree(x, y, z);
    }
    // 4. ground decoration and scattered barrels
    for (let z = z0; z < this.z1; z++) for (let x = x0; x < this.x1; x++) {
      let y = H - 1;
      while (y > 0 && target.data[x + z * W + y * WD] === B.AIR) y--;
      const top = target.data[x + z * W + y * WD], i = x + z * W + (y + 1) * WD;
      if (y + 1 >= H || target.data[i] !== B.AIR || (target.water && target.water[i])) continue;
      if ((top === B.GRASS || top === B.SAND || top === B.STONE) && y + 1 > WATER_LEVEL + 1 && hash3(x, z, seed + 90) < 0.0016) { target.data[i] = B.BARREL; continue; }
      if (top !== B.GRASS) continue;
      const forest = fbm(x * 0.05 + 100, z * 0.05, seed + 3, 2);
      if (hash3(x, z, seed + 78) < 0.38) {
        const r3 = hash3(x, z, seed + 79);
        let d = 1 + ((r3 * 3) | 0); // grass tufts 1..3
        if (r3 > 0.86) d = 4 + ((hash3(x, z, 5) * 3) | 0); // flowers
        else if (r3 > 0.83 && forest > 0.5) d = 7; // mushroom
        else if (r3 > 0.8) d = 8; // fern
        target.decor[i] = d;
      }
    }
  }

  // tree base height at (x,z), or 0 for none
  treeAt(x: number, z: number): number {
    if (x < 3 || z < 3 || x >= this.W - 3 || z >= this.D - 3) return 0;
    const r = hash3(x, z, this.seed + 77);
    if (r > 0.04) return 0;
    const forest = fbm(x * 0.05 + 100, z * 0.05, this.seed + 3, 2);
    if (r >= (forest > 0.56 ? 0.035 : 0.004)) return 0;
    const h = Math.floor(this.heightAt(x, z));
    if (this.topBlock(h) !== B.GRASS || this.nearSite(x, z, 4)) return 0;
    return h + 1;
  }

  // ---------- builders ----------
  private tree(x: number, y: number, z: number): void {
    const h = 4 + ((hash3(x, z, 3) * 3) | 0);
    for (let i = 0; i < h; i++) this.put(x, y + i, z, B.LOG);
    const top = y + h;
    for (let dy = -2; dy <= 1; dy++) {
      const rad = dy === 1 ? 1 : (dy === -2 ? 1.6 : 2.4);
      for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
        if (dx * dx + dz * dz > rad * rad + hash3(x + dx, top + dy, z + dz) * 1.2) continue;
        if (this.get(x + dx, top + dy, z + dz) === B.AIR) this.put(x + dx, top + dy, z + dz, B.LEAVES);
      }
    }
  }

  // stepped gable roof; each row overlaps the one below so it stays connected
  private gableRoof(cx: number, cz: number, y0: number, halfX: number, halfZ: number): void {
    for (let st = 0; st <= halfZ; st++) for (let dx = -halfX; dx <= halfX; dx++) {
      for (const z of [cz - halfZ + st, cz + halfZ - st]) {
        this.put(cx + dx, y0 + st, z, B.ROOF);
        if (st > 0) this.put(cx + dx, y0 + st - 1, z, B.ROOF);
      }
    }
  }

  private castle(cx: number, cz: number, g: number, ruined: boolean): void {
    const R = ruined ? 7 : 9;
    // a ruin has bites taken out of it (deterministic per block)
    const keep = (x: number, y: number, z: number) => !ruined || y < g + 1 || hash3(x, y, z + 991) > 0.18 + (y - g) * 0.06;
    const wall = (x: number, y: number, z: number, t: number) => { if (keep(x, y, z)) this.put(x, y, z, t); };
    this.box(cx - R, g - 1, cz - R, cx + R, g - 1, cz + R, B.COBBLE);
    this.box(cx - R, g, cz - R, cx + R, g + 10, cz + R, B.AIR);
    for (let i = -R; i <= R; i++) {
      for (const [x, z] of [[cx + i, cz - R], [cx + i, cz + R], [cx - R, cz + i], [cx + R, cz + i]]) {
        const gate = (z === cz + R && Math.abs(x - cx) <= 1) || (x === cx - R && Math.abs(z - cz) <= 1);
        for (let y = g; y < g + 5; y++) if (!gate || y >= g + 3) wall(x, y, z, B.BRICK);
        if ((i & 1) === 0) wall(x, g + 5, z, B.BRICK);
      }
    }
    for (const [tx, tz] of [[cx - R, cz - R], [cx + R, cz - R], [cx - R, cz + R], [cx + R, cz + R]]) {
      for (let y = g; y < g + 9; y++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2;
        if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
        if (edge) wall(tx + dx, y, tz + dz, B.BRICK);
        else if (y === g + 5) this.put(tx + dx, y, tz + dz, B.PLANKS);
        else this.put(tx + dx, y, tz + dz, B.AIR);
      }
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++)
        if ((dx + dz) % 2 === 0 && (Math.abs(dx) === 2) !== (Math.abs(dz) === 2)) wall(tx + dx, g + 9, tz + dz, B.BRICK);
      this.put(tx, g + 6, tz, B.LANTERN);
    }
    // moat ring just outside the walls, with land bridges at both gates
    for (let z = cz - R - 5; z <= cz + R + 5; z++) for (let x = cx - R - 5; x <= cx + R + 5; x++) {
      const d = Math.max(Math.abs(x - cx), Math.abs(z - cz));
      if (d < R + 3 || d > R + 4) continue;
      if ((Math.abs(x - cx) <= 1 && z > cz) || (Math.abs(z - cz) <= 1 && x < cx)) continue;
      for (let y = g - 1; y >= g - 2; y--) { this.put(x, y, z, B.AIR); this.putWater(x, y, z); }
    }
    if (ruined) {
      // overgrown courtyard with a loot stash
      for (const [dx, dz] of [[-3, -3], [3, 2], [-2, 4]]) this.put(cx + dx, g, cz + dz, B.CRATE);
      this.put(cx + 1, g, cz - 3, B.TNT); this.put(cx + 4, g, cz - 3, B.BARREL);
      return;
    }
    // central keep with a pitched roof
    const k = 3;
    for (let y = g; y < g + 6; y++) for (let dz = -k; dz <= k; dz++) for (let dx = -k; dx <= k; dx++) {
      const edge = Math.abs(dx) === k || Math.abs(dz) === k;
      const door = dz === k && dx === 0 && y < g + 2;
      const window = edge && y === g + 3 && (dx === 0 || dz === 0) && !door;
      if (edge && !door && !window) this.put(cx + dx, y, cz + dz, (y === g || y === g + 5) ? B.COBBLE : B.PLANKS);
    }
    this.box(cx - k, g + 6, cz - k, cx + k, g + 6, cz + k, B.PLANKS);
    this.gableRoof(cx, cz, g + 7, k + 1, k + 1);
    this.put(cx, g, cz, B.LANTERN);
    const stash = [[-6, -6], [-5, -6], [-6, -5], [6, 6], [5, 6], [6, -6], [-6, 6]];
    stash.forEach(([dx, dz], i) => {
      this.put(cx + dx, g, cz + dz, i % 3 === 2 ? B.TNT : B.CRATE);
      if (i % 2 === 0) this.put(cx + dx, g + 1, cz + dz, B.CRATE);
    });
    this.put(cx + 6, g, cz - 5, B.TNT);
    for (const [dx, dz] of [[-6, 2], [-6, 3], [6, 2], [2, -6], [-2, 6], [3, 6]]) this.put(cx + dx, g, cz + dz, B.BARREL);
    this.put(cx + 6, g + 1, cz - 6, B.TNT);
  }

  private hut(x: number, z: number, g: number): void {
    const s = 3;
    this.box(x - s, g - 1, z - s, x + s, g - 1, z + s, B.PLANKS);
    this.box(x - s - 1, g, z - s - 1, x + s + 1, g + 9, z + s + 1, B.AIR);
    for (let y = g; y < g + 4; y++) for (let dz = -s; dz <= s; dz++) for (let dx = -s; dx <= s; dx++) {
      const edge = Math.abs(dx) === s || Math.abs(dz) === s;
      const corner = Math.abs(dx) === s && Math.abs(dz) === s;
      const door = dz === s && dx === 0 && y < g + 2;
      const win = edge && !corner && y === g + 2 && (dx === 0 || dz === 0) && dz !== s;
      if (edge && !door && !win) this.put(x + dx, y, z + dz, corner ? B.LOG : B.PLANKS);
    }
    this.gableRoof(x, z, g + 4, s + 1, s + 1);
    this.put(x - 2, g, z - 2, B.CRATE);
    this.put(x + 2, g, z - 2, B.CRATE);
    this.put(x + 2, g + 1, z - 2, B.TNT);
    this.put(x - s - 1, g, z + 1, B.BARREL); this.put(x - s - 1, g, z + 2, B.BARREL);
    this.put(x + 2, g, z + 2, B.LANTERN);
  }

  private tower(x: number, z: number, g: number): void {
    for (let y = g; y < g + 8; y++) for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) this.put(x + dx, y, z + dz, B.LOG);
    this.box(x - 2, g + 8, z - 2, x + 2, g + 8, z + 2, B.PLANKS);
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++)
      if (Math.abs(dx) === 2 || Math.abs(dz) === 2) this.put(x + dx, g + 9, z + dz, B.PLANKS);
    this.put(x, g + 9, z, B.CRATE);
    this.put(x + 1, g + 9, z, B.TNT);
    this.put(x - 2, g + 10, z - 2, B.LANTERN);
    // solid staircase up the east side, with a gap in the railing at the top
    for (let i = 0; i <= 8; i++) {
      const sz = z - 6 + i;
      this.put(x + 3, g + i, sz, B.PLANKS);
      const ground = Math.floor(this.heightAt(x + 3, sz));
      for (let y = g + i - 1; y > ground; y--) this.put(x + 3, y, sz, B.COBBLE);
    }
    this.put(x + 2, g + 9, z + 2, B.AIR);
  }

  // a pond dug into a hilltop and held in by a cobblestone dam; blow the dam to flood the slope
  private reservoir(bx: number, bz: number): void {
    const by = Math.floor(this.rawHeight(bx, bz)) + 1;
    for (let dz = -5; dz <= 5; dz++) for (let dx = -5; dx <= 5; dx++) {
      const r = Math.hypot(dx, dz), x = bx + dx, z = bz + dz;
      if (r <= 3.4) {
        const depth = r < 2 ? 3 : 2;
        for (let y = by + 3; y >= by - depth; y--) this.put(x, y, z, B.AIR);
        for (let k = 0; k < depth; k++) this.putWater(x, by - 1 - k, z);
      } else if (r <= 4.6) {
        const ground = Math.floor(this.rawHeight(x, z));
        for (let y = Math.min(ground, by - 3); y <= by; y++) this.put(x, y, z, B.COBBLE);
      }
    }
  }
}

// lookup used by the minimap: block colour of each block id
export function blockColor(t: number): number { return BLOCKS[t] ? BLOCKS[t].top : 0; }
