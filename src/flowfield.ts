// Horde pathfinding: Dijkstra flow fields over the voxel terrain, rooted at the player.
// Fields cover a G x G window centred on the player when they were computed.
// Each column carries the level (y) an enemy would be standing at in it.
//
// The field is grown outward from the player, so every edge is evaluated in reverse: when the
// search expands from column c (level lc) into neighbour n, it asks "how does an enemy standing
// in n get INTO c?". That matters on tall terrain: an enemy at the top of a cliff can drop down
// to the player, but one at the foot of the cliff cannot walk up it (only climbers can).
// Edge costs (x10 integers): walk 10, diagonal 14, step up +4, short drops are free, longer drops
// cost more (they hurt), structures in the way cost time-to-break (so zombies dig only when it's
// worth it), climbers pay per block climbed instead of breaking.
//
// Work is time-sliced: start() begins a new search into back buffers, step() advances it within a
// per-frame budget, and the finished field is swapped in at the end. sample() always reads the last
// complete field, so a slow search over rugged terrain never stalls a frame.
import { BLOCKS, CX, CZ } from './world';
import type { World, VChunk } from './world';

const INF = 1e9;
const N8: readonly (readonly [number, number, number])[] = [[1, 0, 10], [-1, 0, 10], [0, 1, 10], [0, -1, 10], [1, 1, 14], [1, -1, 14], [-1, 1, 14], [-1, -1, 14]];
const N8X = N8.map(e => e[0]), N8Z = N8.map(e => e[1]), N8C = N8.map(e => e[2]);
const MAX_COST = 700;
const BREAK_K = 16; // cost per block hp (zombies take ~0.6s per hp)
const G = 192; // window size (MAX_COST reaches ~70 blocks)
const MAX_DROP = 12; // deepest drop an enemy will path down (falls past ~6 blocks hurt)
const MAX_CLIMB = 14; // highest wall a climber will scale in one go
const CXZ = CX * CZ;

class Heap {
  k: Float64Array;
  v: Int32Array;
  n: number;

  constructor(n: number) { this.k = new Float64Array(n * 8); this.v = new Int32Array(n * 8); this.n = 0; }
  push(key: number, val: number): void {
    if (this.n >= this.k.length) return; // cannot happen with 8 pushes per cell, but never write out of range
    let i = this.n++;
    while (i > 0) { const p = (i - 1) >> 1; if (this.k[p] <= key) break; this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p; }
    this.k[i] = key; this.v[i] = val;
  }
  pop(): number {
    const top = this.v[0], key = this.k[--this.n], val = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1; if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = key; this.v[i] = val;
    return top;
  }
}

export class FlowField {
  w: World;
  climber: boolean;
  // the last complete field (read by sample)
  dist: Float32Array;
  level: Int16Array;
  ox = 0; oz = 0; // world position of the window's corner
  ready: boolean;
  /** a search is in progress (in the back buffers) */
  running = false;
  // the search in progress
  private bdist: Float32Array;
  private blevel: Int16Array;
  private box = 0; private boz = 0;
  private loX = 0; private loZ = 0; private hiX = 0; private hiZ = 0;
  heap: Heap;
  c = 0; // scratch: extra cost set by enter()
  l = 0; // scratch: new level set by enter()
  private open = new Uint8Array(4);
  // scratch: the column enter() is looking at (chunk-array base index and in-chunk xz index)
  private colBase = 0; private colLi = 0;

  constructor(world: World, climber: boolean) {
    this.w = world; this.climber = climber;
    const n = G * G;
    this.dist = new Float32Array(n).fill(INF);
    this.level = new Int16Array(n);
    this.bdist = new Float32Array(n).fill(INF);
    this.blevel = new Int16Array(n);
    this.heap = new Heap(n);
    this.ready = false;
  }

  // block type at height y of the current column (set by enter); out of the world above is air
  private at(y: number): number {
    if (y < 0) return 5; // bedrock
    if (y >= this.w.H) return 0;
    const ch = this.w.chunks[this.colBase + (y >> 5) * CXZ] as VChunk;
    return ch.blocks ? ch.blocks[this.colLi | ((y & 31) << 10)] : ch.fill;
  }
  private air(y: number): boolean { return this.at(y) === 0; }
  // can an enemy stand with its feet at y in the current column?
  private standable(y: number): boolean { return y >= 1 && this.at(y) === 0 && this.at(y + 1) === 0 && this.at(y - 1) !== 0; }

  // How an enemy standing in column (x, z) moves into a neighbouring column whose standing level is lc.
  // Sets this.c (extra cost) and this.l (the enemy's level in (x, z)); returns false if impassable.
  enter(x: number, z: number, lc: number): boolean {
    const w = this.w;
    if (!w.isGenerated(x, z)) return false; // not streamed in yet: nothing to stand on
    this.colBase = (x >> 5) + (z >> 5) * CX; this.colLi = (x & 31) | ((z & 31) << 5);
    // nearest standing spot to lc: same level, then a little above (it drops down to us) or below (steps up)
    const up = this.climber ? MAX_CLIMB : 1;
    for (let d = 0; d <= MAX_DROP; d++) {
      const yh = lc + d;
      if (this.standable(yh)) {
        // dropping d blocks: free up to 3, then increasingly costly (falls past ~6 blocks hurt)
        this.c = d <= 3 ? 0 : 6 * (d - 3); this.l = yh; return true;
      }
      if (d > 0 && d <= up) {
        const yl = lc - d;
        if (this.standable(yl)) {
          // stepping up one block (a hop needs head room), or climbing the wall
          if (d === 1 && this.air(yl + 2)) { this.c = 4; this.l = yl; return true; }
          if (this.climber) { this.c = 8 * d; this.l = yl; return true; }
        }
      }
    }
    // a structure in the way at the level we're at: cost of breaking through it
    let cost = 0;
    for (let y = lc; y <= lc + 1; y++) {
      const t = this.at(y);
      if (t === 0) continue;
      const bd = BLOCKS[t];
      if (bd.anchored || bd.hp === Infinity) return false;
      cost += (bd.hp - (w.damage.get(w.idx(x, y, z)) || 0)) * BREAK_K;
    }
    if (cost === 0) return false; // open air over a deep drop
    // the wall has to stand on something
    if (this.at(lc - 1) === 0 && this.at(lc) === 0) return false;
    this.c = cost; this.l = lc; return true;
  }

  /** begin a new search rooted at (px, py, pz); the previous field stays readable until it finishes */
  start(px: number, py: number, pz: number): void {
    const w = this.w;
    const fx = Math.floor(px), fz = Math.floor(pz);
    this.heap.n = 0; this.running = false;
    if (fx < 0 || fz < 0 || fx >= w.W || fz >= w.D) return;
    this.bdist.fill(INF);
    const ox = this.box = fx - (G >> 1), oz = this.boz = fz - (G >> 1);
    // the outermost ring of the window (and of the world) is never expanded
    const lo = (o: number) => Math.max(1, 1 - o);
    this.loX = lo(ox); this.loZ = lo(oz);
    this.hiX = Math.min(G - 1, w.W - 1 - ox); this.hiZ = Math.min(G - 1, w.D - 1 - oz);
    const s = (fx - ox) + (fz - oz) * G;
    // root at the ground under the player: rooted mid-jump or mid-fall, every edge was judged from a level
    // the player isn't standing on (one jump made the step below unreachable; a fall left the field empty)
    let ly = Math.max(1, Math.floor(py + 0.05));
    if (w.isGenerated(fx, fz)) {
      this.colBase = (fx >> 5) + (fz >> 5) * CX; this.colLi = (fx & 31) | ((fz & 31) << 5);
      for (let k = 0; k < 64 && ly > 1 && this.air(ly - 1); k++) ly--;
    }
    this.bdist[s] = 0; this.blevel[s] = ly;
    this.heap.push(0, s);
    this.running = true;
  }

  /** advance the running search for up to `budgetMs`; returns true when it finished (and was swapped in) */
  step(budgetMs: number): boolean {
    if (!this.running) return false;
    const dist = this.bdist, level = this.blevel, heap = this.heap, open = this.open;
    const ox = this.box, oz = this.boz, loX = this.loX, loZ = this.loZ, hiX = this.hiX, hiZ = this.hiZ;
    const t0 = performance.now();
    let pops = 0;
    while (heap.n) {
      if ((++pops & 31) === 0 && performance.now() - t0 > budgetMs) return false;
      const dk = heap.k[0];
      const c = heap.pop();
      const dc = dist[c];
      if (dk > dc) continue; // stale heap entry
      if (dc > MAX_COST) break; // enemies spawn within ~45 blocks; beyond that they steer directly
      const cz = (c / G) | 0, cx = c - cz * G, cl = level[c];
      for (let k = 0; k < 8; k++) {
        const dx = N8X[k], dz = N8Z[k];
        const nx = cx + dx, nz = cz + dz;
        if (nx < loX || nz < loZ || nx >= hiX || nz >= hiZ) { if (k < 4) open[k] = 0; continue; }
        if (k >= 4) {
          // no diagonal corner-cutting: both orthogonal neighbours must be cheaply passable
          if (!open[dx > 0 ? 0 : 1] || !open[dz > 0 ? 2 : 3]) continue;
          if (dist[nx + nz * G] <= dc + 14) continue; // cannot improve: skip the cost lookup
        }
        if (!this.enter(nx + ox, nz + oz, cl)) { if (k < 4) open[k] = 0; continue; }
        if (k < 4) open[k] = this.c < 30 ? 1 : 0;
        const nd = dc + N8C[k] + this.c;
        const ni = nx + nz * G;
        if (nd < dist[ni]) { dist[ni] = nd; level[ni] = this.l; heap.push(nd, ni); }
      }
    }
    // done: swap the finished field in
    this.bdist = this.dist; this.dist = dist;
    this.blevel = this.level; this.level = level;
    this.ox = ox; this.oz = oz;
    this.running = false; this.ready = true;
    return true;
  }

  /** compute a whole field right now */
  compute(px: number, py: number, pz: number): void {
    this.start(px, py, pz);
    this.step(Infinity);
  }

  /** standing level of an enemy in column (x, z) that can reach the player, or -1 (unreachable / outside the field) */
  reachLevel(x: number, z: number): number {
    if (!this.ready) return -1;
    const cx = Math.floor(x) - this.ox, cz = Math.floor(z) - this.oz;
    if (cx < 0 || cz < 0 || cx >= G || cz >= G) return -1;
    const i = cx + cz * G;
    return this.dist[i] < INF ? this.level[i] : -1;
  }

  // direction (dx, dz) toward the player from a world position, or null if unknown
  sample(x: number, z: number): [number, number] | null {
    if (!this.ready) return null;
    const cx = Math.floor(x) - this.ox, cz = Math.floor(z) - this.oz;
    if (cx < 0 || cz < 0 || cx >= G || cz >= G) return null;
    const here = this.dist[cx + cz * G];
    let best = here, bx = 0, bz = 0;
    for (const [dx, dz] of N8) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= G || nz >= G) continue;
      const d = this.dist[nx + nz * G];
      if (d < best) { best = d; bx = nx + this.ox + 0.5 - x; bz = nz + this.oz + 0.5 - z; }
    }
    if (best >= INF || (bx === 0 && bz === 0)) return null;
    const l = Math.hypot(bx, bz);
    return [bx / l, bz / l];
  }
}
