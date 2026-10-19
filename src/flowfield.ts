// Horde pathfinding: Dijkstra flow fields over the voxel terrain, rooted at the player.
// Fields cover a G x G window centred on the player when they were computed.
// Each column carries the level (y) an enemy would be standing at when it enters it.
// Edge costs (x10 integers): walk 10, diagonal 14, step up +4, drops are cheap,
// structures in the way cost time-to-break (so zombies dig only when it's worth it),
// climbers pay per block climbed instead of breaking.
import { BLOCKS } from './world';
import type { World } from './world';

const INF = 1e9;
const N8: readonly (readonly [number, number, number])[] = [[1, 0, 10], [-1, 0, 10], [0, 1, 10], [0, -1, 10], [1, 1, 14], [1, -1, 14], [-1, 1, 14], [-1, -1, 14]];
const N8X = N8.map(e => e[0]), N8Z = N8.map(e => e[1]), N8C = N8.map(e => e[2]);
const MAX_COST = 700;
const BREAK_K = 16; // cost per block hp (zombies take ~0.6s per hp)
const G = 192; // window size (MAX_COST reaches ~70 blocks)

class Heap {
  k: Float64Array;
  v: Int32Array;
  n: number;

  constructor(n: number) { this.k = new Float64Array(n * 8); this.v = new Int32Array(n * 8); this.n = 0; }
  push(key: number, val: number): void {
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
  dist: Float32Array;
  level: Int16Array;
  heap: Heap;
  ready: boolean;
  c = 0; // scratch: extra cost set by enter()
  l = 0; // scratch: new level set by enter()
  open: Uint8Array | undefined;
  ox = 0; oz = 0; // world position of the window's corner

  constructor(world: World, climber: boolean) {
    this.w = world; this.climber = climber;
    const n = G * G;
    this.dist = new Float32Array(n).fill(INF);
    this.level = new Int16Array(n);
    this.heap = new Heap(n);
    this.ready = false;
  }

  // how an enemy standing at level `la` moves into column (x,z).
  // Sets this.c (extra cost) and this.l (new level); returns false if impassable.
  enter(x: number, z: number, la: number): boolean {
    const w = this.w, H = w.H;
    if (la < 1) la = 1;
    const air = (y: number) => y >= H || !w.occ(x, y, z); // y is always >= 0 here
    const air1 = air(la + 1);
    if (air1 && air(la)) {
      let y = la;
      while (y > 1 && air(y - 1)) y--;
      this.c = la - y > 3 ? 20 : 0; this.l = y; return true;
    }
    if (air1 && air(la + 2)) { this.c = 4; this.l = la + 1; return true; }
    if (this.climber) {
      let y = la;
      while (y < H - 2 && !(air(y) && air(y + 1))) y++;
      if (y - la < 14) { this.c = 8 * (y - la); this.l = y; return true; }
    }
    let cost = 0;
    for (let y = la; y <= la + 1; y++) {
      const t = y < H ? w.get(x, y, z) : 0;
      if (t === 0) continue;
      const bd = BLOCKS[t];
      if (bd.anchored || bd.hp === Infinity) return false;
      cost += (bd.hp - (w.damage.get(w.idx(x, y, z)) || 0)) * BREAK_K;
    }
    this.c = cost; this.l = la; return true;
  }

  compute(px: number, py: number, pz: number): void {
    const w = this.w;
    const dist = this.dist, level = this.level, heap = this.heap;
    dist.fill(INF); heap.n = 0;
    const fx = Math.floor(px), fz = Math.floor(pz);
    if (fx < 0 || fz < 0 || fx >= w.W || fz >= w.D) return;
    const ox = this.ox = fx - (G >> 1), oz = this.oz = fz - (G >> 1);
    // the outermost ring of the window (and of the world) is never expanded
    const lo = (o: number) => Math.max(1, 1 - o), hiX = Math.min(G - 1, w.W - 1 - ox), hiZ = Math.min(G - 1, w.D - 1 - oz);
    const loX = lo(ox), loZ = lo(oz);
    const s = (fx - ox) + (fz - oz) * G;
    dist[s] = 0; level[s] = Math.floor(py + 0.05);
    heap.push(0, s);
    // grown outward from the player; costs use the reverse edge, which is fine for this terrain
    const open = this.open || (this.open = new Uint8Array(4));
    while (heap.n) {
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
    this.ready = true;
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
