// Deterministic, column-by-column world generation for a 5120 x 512 x 5120 world.
// Everything is a pure function of the seed: terrain height comes from noise, structure
// sites are chosen per 192-block region by hashing, and every builder writes through a
// writer clipped to the column being generated. A castle that spans four columns is
// therefore built identically no matter which column happens to be generated first.
// Output is plain typed arrays (one entry per 32³ chunk; uniform chunks store no array),
// so a column can be generated inside a worker and transferred.
import { B, WATER_LEVEL, hash3, fbm, ridged } from './blocks';

export const CHUNK = 32;
const CV = CHUNK * CHUNK * CHUNK;
const REGION = 192;

export type SiteKind = 'castle' | 'ruin' | 'hut' | 'tower' | 'reservoir';
export interface Site {
  kind: SiteKind;
  x: number; z: number;
  g: number; // ground level (y of the first air block) at the site
  r: number; // footprint radius used for terrain flattening and keep-out
}

/** One generated 32-wide column of 32³ chunks, bottom (cy = 0) to top. */
export interface Column {
  cx: number; cz: number;
  blocks: (Uint8Array | null)[]; // null: every block in the chunk is fill[cy]
  fill: Uint8Array;
  decor: (Uint8Array | null)[]; // null: no decor
  water: (Uint8Array | null)[]; // water levels (FULL = 8, 0x80 = infinite source); null: dry
}

const WATER_FULL = 8, WATER_SOURCE = 0x80;
const SEA = WATER_LEVEL;
const smooth = (x: number, a: number, b: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const NO_SITES: Site[] = [];

export class WorldGen {
  W: number; H: number; D: number; seed: number;
  CY: number;
  /** small flat test area (see testHeight) instead of the full world */
  test: boolean;
  spawn: Site; // the starting castle in the middle of the map
  private regions = new Map<number, Site[]>(); // sites per region
  private near = new Map<number, Site[]>(); // sites per region, including the 8 neighbouring regions
  // the column being generated
  private col!: Column;
  private x0 = 0; private x1 = 0; private z0 = 0; private z1 = 0;

  constructor(W: number, H: number, D: number, seed: number, test = false) {
    this.W = W; this.H = H; this.D = D; this.seed = seed; this.test = test;
    this.CY = Math.ceil(H / CHUNK);
    const sx = W >> 1, sz = D >> 1;
    this.spawn = { kind: 'castle', x: sx, z: sz, g: Math.max(SEA + 3, Math.floor(this.rawHeight(sx, sz)) + 1), r: 16 };
  }

  // ---------- terrain ----------
  /** 0 = open sea, 1 = land */
  landAt(x: number, z: number): number {
    const { W, D, seed } = this;
    const ex = Math.max(Math.abs(x / W - 0.5), Math.abs(z / D - 0.5)) * 2; // 0 at the centre, 1 at the world edge
    const ds = Math.hypot(x - (W >> 1), z - (D >> 1));
    let c = (fbm(x * 0.0011, z * 0.0011, seed + 5, 5) - 0.5) * 2.6 + 0.3;
    c += (fbm(x * 0.006, z * 0.006, seed + 21, 3) - 0.5) * 0.35; // ragged coastline
    c -= smooth(ex, 0.72, 0.97) * 1.4; // ocean all around the edge of the world
    c += (1 - smooth(ds, 140, 460)) * 0.9; // always land around the spawn castle
    return smooth(c, -0.08, 0.2);
  }

  /** mountain-belt strength 0..1 (no mountains close to spawn) */
  beltAt(x: number, z: number): number {
    const ds = Math.hypot(x - (this.W >> 1), z - (this.D >> 1));
    return smooth(fbm(x * 0.0016 + 7, z * 0.0016, this.seed + 60, 3), 0.47, 0.64) * smooth(ds, 240, 650);
  }

  // Test world: a flat 224-block square around spawn in an open sea, with a 20-block cliff
  // plateau (falls, climbing, collapses off edges) and a pond below sea level (water).
  private testHeight(x: number, z: number): number {
    const dx = x - (this.W >> 1), dz = z - (this.D >> 1);
    if (Math.max(Math.abs(dx), Math.abs(dz)) > 112) return SEA - 8;
    if (dx >= 44 && dx < 84 && dz >= 20 && dz < 60) return SEA + 26;
    if (Math.hypot(dx + 30, dz + 30) < 6) return SEA - 3;
    return SEA + 6;
  }

  rawHeight(x: number, z: number): number {
    if (this.test) return this.testHeight(x, z);
    const seed = this.seed;
    const land = this.landAt(x, z);
    let h = SEA - 26 + land * 29; // sea floor ~22, coast ~51
    if (land > 0) {
      const plains = fbm(x * 0.03, z * 0.03, seed, 4) * 7;
      const hills = Math.pow(fbm(x * 0.008 + 50, z * 0.008 + 50, seed + 9, 4), 2.2) * 50;
      const belt = this.beltAt(x, z);
      let mtn = 0;
      if (belt > 0) mtn = (Math.pow(ridged(x * 0.0032, z * 0.0032, seed + 40, 5), 1.7) * 560 + 24) * belt;
      const lakes = smooth(fbm(x * 0.01 + 300, z * 0.01, seed + 31, 3), 0.64, 0.72) * (1 - belt);
      h += land * (plains + hills + mtn - lakes * 13);
    }
    return Math.max(2, Math.min(this.H - 26, h));
  }

  // width of the ramp from a structure's flat pad back to natural terrain (the spawn castle sits in a hill)
  private blend(s: Site): number { return s.kind === 'castle' ? 24 : 8; }

  private heightWith(x: number, z: number, sites: Site[]): number {
    let h = this.rawHeight(x, z);
    for (const s of sites) {
      if (s.kind === 'reservoir') continue;
      const d = Math.hypot(x - s.x, z - s.z);
      const k = 1 - smooth(d, s.r, s.r + this.blend(s));
      if (k > 0) h = h + (s.g - 0.8 - h) * k;
    }
    return h;
  }
  /** terrain height with flattened pads under structures */
  heightAt(x: number, z: number): number { return this.heightWith(x, z, this.sitesNear(x, z)); }

  /** surface block for a column of height h whose steepest neighbour differs by `slope` */
  topBlock(x: number, z: number, h: number, slope: number): number {
    if (h <= SEA + 1) return B.SAND;
    const n = fbm(x * 0.02, z * 0.02, this.seed + 70, 2);
    if (h > 290 + n * 60) return B.SNOW;
    if (slope >= 3 || h > 200 + n * 50) return B.STONE;
    return B.GRASS;
  }
  private slopeAt(x: number, z: number, h: number): number {
    return Math.max(Math.abs(Math.floor(this.heightAt(x + 1, z)) - h), Math.abs(Math.floor(this.heightAt(x - 1, z)) - h),
      Math.abs(Math.floor(this.heightAt(x, z + 1)) - h), Math.abs(Math.floor(this.heightAt(x, z - 1)) - h));
  }

  // ---------- structure sites ----------
  // flat land at a sensible height (structures need a level pad, not a cliff)
  private flatLand(x: number, z: number, min: number, max: number, r: number): boolean {
    const h = this.rawHeight(x, z);
    if (h <= min || h >= max) return false;
    for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) if (Math.abs(this.rawHeight(x + dx, z + dz) - h) > 5) return false;
    return true;
  }

  private regionSites(rx: number, rz: number): Site[] {
    const key = rx + rz * 4096;
    let out = this.regions.get(key);
    if (out) return out;
    out = [];
    this.regions.set(key, out);
    const { seed } = this;
    const sp = this.spawn;
    if (rx < 0 || rz < 0 || rx * REGION >= this.W || rz * REGION >= this.D) return out;
    // the spawn castle belongs to the region it stands in
    if (Math.floor(sp.x / REGION) === rx && Math.floor(sp.z / REGION) === rz) out.push(sp);
    if (this.test) {
      // one of each structure at fixed spots around the castle
      const sx = sp.x, sz = sp.z;
      for (const [kind, x, z, r] of [['tower', sx + 34, sz - 12, 4], ['hut', sx - 36, sz + 8, 6], ['ruin', sx - 4, sz - 60, 13], ['reservoir', sx + 64, sz + 40, 6]] as [SiteKind, number, number, number][])
        if (Math.floor(x / REGION) === rx && Math.floor(z / REGION) === rz) out.push({ kind, x, z, g: Math.floor(this.rawHeight(x, z)) + 1, r });
      return out;
    }
    // at most one group per region: a ruined fort, a hut village, a watchtower or a dammed reservoir
    const r = hash3(rx, rz, seed + 101);
    const kind: SiteKind | null = r < 0.12 ? 'ruin' : r < 0.4 ? 'hut' : r < 0.55 ? 'tower' : r < 0.68 ? 'reservoir' : null;
    if (!kind) return out;
    const rad = kind === 'ruin' ? 13 : kind === 'hut' ? 6 : kind === 'tower' ? 4 : 6;
    const minDist = kind === 'ruin' ? 140 : kind === 'hut' ? 60 : kind === 'tower' ? 50 : 60;
    const margin = kind === 'hut' ? 44 : rad + 26;
    for (let attempt = 0; attempt < 6; attempt++) {
      const x = rx * REGION + margin + Math.floor(hash3(rx * 8 + attempt, rz, seed + 102) * (REGION - 2 * margin));
      const z = rz * REGION + margin + Math.floor(hash3(rx, rz * 8 + attempt, seed + 103) * (REGION - 2 * margin));
      if (Math.hypot(x - sp.x, z - sp.z) < minDist + sp.r) continue;
      if (x < 40 || z < 40 || x > this.W - 40 || z > this.D - 40) continue;
      const ok = kind === 'reservoir' ? this.flatLand(x, z, SEA + 14, SEA + 60, 5) : this.flatLand(x, z, SEA + 2, SEA + 30, rad);
      if (!ok) continue;
      const add = (k: SiteKind, sx: number, sz: number) => out!.push({ kind: k, x: sx, z: sz, g: Math.floor(this.rawHeight(sx, sz)) + 1, r: rad });
      add(kind, x, z);
      // huts come in small villages: a few more around the first one
      if (kind === 'hut') for (let k = 0; k < 3; k++) {
        const a = hash3(rx * 4 + k, rz, seed + 7) * Math.PI * 2, hx = Math.round(x + Math.cos(a) * 16), hz = Math.round(z + Math.sin(a) * 16);
        if (this.flatLand(hx, hz, SEA + 2, SEA + 30, rad) && out.every(s => Math.hypot(s.x - hx, s.z - hz) > s.r + rad + 2)) add('hut', hx, hz);
      }
      break;
    }
    return out;
  }

  /** every site whose footprint (plus its terrain blend) can reach (x, z) */
  sitesNear(x: number, z: number): Site[] {
    const rx = Math.floor(x / REGION), rz = Math.floor(z / REGION);
    const key = rx + rz * 4096;
    let s = this.near.get(key);
    if (s) return s;
    s = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) s.push(...this.regionSites(rx + dx, rz + dz));
    if (!s.length) s = NO_SITES;
    this.near.set(key, s);
    return s;
  }

  private nearSite(x: number, z: number, pad: number): boolean {
    for (const s of this.sitesNear(x, z)) if (Math.hypot(x - s.x, z - s.z) < s.r + pad) return true;
    return false;
  }

  // ---------- clipped writes into the current column ----------
  private chunkFor(y: number): Uint8Array {
    const c = this.col, cy = y >> 5;
    let b = c.blocks[cy];
    if (!b) { b = c.blocks[cy] = new Uint8Array(CV); if (c.fill[cy]) b.fill(c.fill[cy]); }
    return b;
  }
  private put(x: number, y: number, z: number, t: number): void {
    if (x < this.x0 || x >= this.x1 || z < this.z0 || z >= this.z1 || y < 0 || y >= this.H) return;
    const c = this.col, cy = y >> 5, li = (x - this.x0) | ((z - this.z0) << 5) | ((y & 31) << 10);
    if (!c.blocks[cy] && c.fill[cy] === t) return;
    this.chunkFor(y)[li] = t;
    if (t !== B.AIR) {
      const d = c.decor[cy]; if (d) d[li] = 0;
      const wv = c.water[cy]; if (wv) wv[li] = 0;
    }
  }
  private get(x: number, y: number, z: number): number {
    if (x < this.x0 || x >= this.x1 || z < this.z0 || z >= this.z1 || y < 0 || y >= this.H) return B.AIR;
    const c = this.col, cy = y >> 5, b = c.blocks[cy];
    return b ? b[(x - this.x0) | ((z - this.z0) << 5) | ((y & 31) << 10)] : c.fill[cy];
  }
  private putWater(x: number, y: number, z: number, v = WATER_FULL): void {
    if (x < this.x0 || x >= this.x1 || z < this.z0 || z >= this.z1 || y < 1 || y >= this.H) return;
    if (this.get(x, y, z) !== B.AIR) return;
    const c = this.col, cy = y >> 5;
    (c.water[cy] ??= new Uint8Array(CV))[(x - this.x0) | ((z - this.z0) << 5) | ((y & 31) << 10)] = v;
  }
  private putDecor(x: number, y: number, z: number, d: number): void {
    const c = this.col, cy = y >> 5;
    (c.decor[cy] ??= new Uint8Array(CV))[(x - this.x0) | ((z - this.z0) << 5) | ((y & 31) << 10)] = d;
  }
  private box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, t: number): void {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.put(x, y, z, t);
  }

  // ---------- column generation ----------
  generateColumn(cx: number, cz: number): Column {
    const { H, CY, seed } = this;
    const col: Column = { cx, cz, blocks: new Array(CY).fill(null), fill: new Uint8Array(CY), decor: new Array(CY).fill(null), water: new Array(CY).fill(null) };
    this.col = col;
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    this.x0 = x0; this.z0 = z0; this.x1 = Math.min(x0 + CHUNK, this.W); this.z1 = Math.min(z0 + CHUNK, this.D);
    // 1. heights, with a one-block margin for slopes
    const P = CHUNK + 2, hh = new Int16Array(P * P);
    const sites = this.sitesNear(x0 + 16, z0 + 16);
    for (let lz = 0; lz < P; lz++) for (let lx = 0; lx < P; lx++)
      hh[lx + lz * P] = Math.min(H - 26, Math.floor(this.heightWith(x0 + lx - 1, z0 + lz - 1, sites)));
    let minH = H, maxH = 0;
    for (let lz = 1; lz <= CHUNK; lz++) for (let lx = 1; lx <= CHUNK; lx++) { const h = hh[lx + lz * P]; if (h < minH) minH = h; if (h > maxH) maxH = h; }
    // 2. chunks entirely inside the rock are uniform stone; chunks above everything start as uniform air
    for (let cy = 0; cy < CY; cy++) {
      const ya = cy * CHUNK, yb = ya + CHUNK - 1;
      if (cy > 0 && yb < minH - 4) col.fill[cy] = B.STONE;
      else if (ya > maxH) col.fill[cy] = B.AIR;
      else col.blocks[cy] = new Uint8Array(CV);
    }
    for (let lz = 0; lz < CHUNK; lz++) for (let lx = 0; lx < CHUNK; lx++) {
      const x = x0 + lx, z = z0 + lz, c = (lx + 1) + (lz + 1) * P;
      const h = hh[c];
      const slope = Math.max(Math.abs(hh[c + 1] - h), Math.abs(hh[c - 1] - h), Math.abs(hh[c + P] - h), Math.abs(hh[c - P] - h));
      const top = this.topBlock(x, z, h, slope);
      const under = top === B.GRASS ? B.DIRT : top === B.SNOW ? B.STONE : top;
      const colIdx = lx | (lz << 5);
      for (let cy = 0; cy < CY; cy++) {
        const b = col.blocks[cy];
        if (!b) continue;
        const ya = cy * CHUNK, yb = Math.min(h, ya + CHUNK - 1);
        for (let y = ya; y <= yb; y++) {
          let t: number;
          if (y === 0) t = B.BEDROCK;
          else if (y === h) t = top;
          else if (y > h - 3) t = under;
          else t = (y > 3 && hash3(x, y, z + seed) < 0.035) ? B.ORE : B.STONE;
          b[colIdx | ((y & 31) << 10)] = t;
        }
      }
      // ore poking out of rocky hilltops
      if (top === B.STONE && hash3(x, 7, z + seed) < 0.03) this.put(x, h, z, B.ORE);
      // the sea is an infinite water source
      for (let y = h + 1; y < SEA; y++) this.putWater(x, y, z, WATER_FULL | WATER_SOURCE);
    }
    // 3. structures overlapping this column
    for (const s of sites) {
      const reach = s.r + 6;
      if (s.x + reach < x0 || s.x - reach >= this.x1 || s.z + reach < z0 || s.z - reach >= this.z1) continue;
      if (s.kind === 'castle') this.castle(s.x, s.z, s.g, false);
      else if (s.kind === 'ruin') this.castle(s.x, s.z, s.g, true);
      else if (s.kind === 'hut') this.hut(s.x, s.z, s.g);
      else if (s.kind === 'tower') this.tower(s.x, s.z, s.g);
      else this.reservoir(s.x, s.z);
    }
    // 4. trees (a canopy can reach 3 blocks into neighbouring columns)
    for (let z = z0 - 3; z < this.z1 + 3; z++) for (let x = x0 - 3; x < this.x1 + 3; x++) {
      const y = this.treeAt(x, z);
      if (y > 0) this.tree(x, y, z);
    }
    // 5. ground decoration and scattered barrels
    const scanTop = Math.min(H - 2, maxH + 24);
    for (let z = z0; z < this.z1; z++) for (let x = x0; x < this.x1; x++) {
      let y = scanTop;
      while (y > 0 && this.get(x, y, z) === B.AIR) y--;
      const top = this.get(x, y, z), ya = y + 1;
      if (ya >= H || this.get(x, ya, z) !== B.AIR) continue;
      const wv = col.water[ya >> 5];
      if (wv && wv[(x - x0) | ((z - z0) << 5) | ((ya & 31) << 10)]) continue;
      if ((top === B.GRASS || top === B.SAND || top === B.STONE) && ya > SEA + 1 && hash3(x, z, seed + 90) < 0.0016) { this.put(x, ya, z, B.BARREL); continue; }
      if (top !== B.GRASS) continue;
      const forest = fbm(x * 0.05 + 100, z * 0.05, seed + 3, 2);
      if (hash3(x, z, seed + 78) < 0.38) {
        const r3 = hash3(x, z, seed + 79);
        let d = 1 + ((r3 * 3) | 0); // grass tufts 1..3
        if (r3 > 0.86) d = 4 + ((hash3(x, z, 5) * 3) | 0); // flowers
        else if (r3 > 0.83 && forest > 0.5) d = 7; // mushroom
        else if (r3 > 0.8) d = 8; // fern
        this.putDecor(x, ya, z, d);
      }
    }
    // 6. chunks that ended up holding a single block type go back to uniform storage
    for (let cy = 0; cy < CY; cy++) {
      const b = col.blocks[cy];
      if (!b || col.decor[cy]) continue;
      const t = b[0];
      let same = true;
      for (let i = 1; i < CV; i++) if (b[i] !== t) { same = false; break; }
      if (same) { col.blocks[cy] = null; col.fill[cy] = t; }
    }
    return col;
  }

  // tree base height at (x,z), or 0 for none
  treeAt(x: number, z: number): number {
    if (x < 3 || z < 3 || x >= this.W - 3 || z >= this.D - 3) return 0;
    const r = hash3(x, z, this.seed + 77);
    if (r > 0.04) return 0;
    const forest = fbm(x * 0.05 + 100, z * 0.05, this.seed + 3, 2);
    if (r >= (forest > 0.56 ? 0.035 : 0.004)) return 0;
    const h = Math.min(this.H - 26, Math.floor(this.heightAt(x, z)));
    if (h > 190 || this.topBlock(x, z, h, this.slopeAt(x, z, h)) !== B.GRASS || this.nearSite(x, z, 4)) return 0;
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
    // (a column only keeps a block if every block below it survived, so no bricks float)
    const keep = (x: number, y: number, z: number) => {
      if (!ruined) return true;
      for (let yy = g + 1; yy <= y; yy++) if (hash3(x, yy, z + 991) <= 0.18 + (yy - g) * 0.06) return false;
      return true;
    };
    const wall = (x: number, y: number, z: number, t: number) => { if (keep(x, y, z)) this.put(x, y, z, t); };
    this.box(cx - R, g - 1, cz - R, cx + R, g - 1, cz + R, B.COBBLE);
    this.box(cx - R, g, cz - R, cx + R, g + 10, cz + R, B.AIR);
    for (let i = -R; i <= R; i++) {
      for (const [x, z] of [[cx + i, cz - R], [cx + i, cz + R], [cx - R, cz + i], [cx + R, cz + i]]) {
        const gate = (z === cz + R && Math.abs(x - cx) <= 1) || (x === cx - R && Math.abs(z - cz) <= 1);
        for (let y = g; y < g + 5; y++) if (!gate || (y >= g + 3 && !ruined)) wall(x, y, z, B.BRICK); // ruined gates are open to the sky
        if ((i & 1) === 0 && !(gate && ruined)) wall(x, g + 5, z, B.BRICK);
      }
    }
    for (const [tx, tz] of [[cx - R, cz - R], [cx + R, cz - R], [cx - R, cz + R], [cx + R, cz + R]]) {
      for (let y = g; y < g + 9; y++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2;
        if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
        if (edge) wall(tx + dx, y, tz + dz, B.BRICK);
        else if (y === g + 5 && !ruined) this.put(tx + dx, y, tz + dz, B.PLANKS);
        else this.put(tx + dx, y, tz + dz, B.AIR);
      }
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++)
        if ((dx + dz) % 2 === 0 && (Math.abs(dx) === 2) !== (Math.abs(dz) === 2)) wall(tx + dx, g + 9, tz + dz, B.BRICK);
      if (!ruined) this.put(tx, g + 6, tz, B.LANTERN);
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
