// Horde pathfinding: Dijkstra flow fields over the voxel island, rooted at the player.
// Each column carries the level (y) an enemy would be standing at when it enters it.
// Edge costs (x10 integers): walk 10, diagonal 14, step up +4, drops are cheap,
// structures in the way cost time-to-break (so zombies dig only when it's worth it),
// climbers pay per block climbed instead of breaking.
import { B, BLOCKS } from './world.js';

const INF = 1e9;
const N8 = [[1, 0, 10], [-1, 0, 10], [0, 1, 10], [0, -1, 10], [1, 1, 14], [1, -1, 14], [-1, 1, 14], [-1, -1, 14]];
const MAX_COST = 700;
const BREAK_K = 16; // cost per block hp (zombies take ~0.6s per hp)

class Heap {
  constructor(n) { this.k = new Float64Array(n * 8); this.v = new Int32Array(n * 8); this.n = 0; }
  push(key, val) {
    let i = this.n++;
    while (i > 0) { const p = (i - 1) >> 1; if (this.k[p] <= key) break; this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p; }
    this.k[i] = key; this.v[i] = val;
  }
  pop() {
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
  constructor(world, climber) {
    this.w = world; this.climber = climber;
    const n = world.W * world.D;
    this.dist = new Float32Array(n).fill(INF);
    this.level = new Int16Array(n);
    this.heap = new Heap(n);
    this.ready = false;
  }

  // how an enemy standing at level `la` moves into column (x,z).
  // Sets this.c (extra cost) and this.l (new level); returns false if impassable.
  enter(x, z, la) {
    const w = this.w, data = w.data, WD = w.W * w.D, H = w.H, col = x + z * w.W;
    const air = (y) => y >= H || (y >= 0 && data[col + y * WD] === 0);
    if (la < 1) la = 1;
    if (air(la) && air(la + 1)) {
      let y = la;
      while (y > 1 && air(y - 1)) y--;
      this.c = la - y > 3 ? 20 : 0; this.l = y; return true;
    }
    if (air(la + 1) && air(la + 2)) { this.c = 4; this.l = la + 1; return true; }
    if (this.climber) {
      let y = la;
      while (y < H - 2 && !(air(y) && air(y + 1))) y++;
      if (y - la < 14) { this.c = 8 * (y - la); this.l = y; return true; }
    }
    let cost = 0;
    for (let y = la; y <= la + 1; y++) {
      const t = y < H ? data[col + y * WD] : 0;
      if (t === 0) continue;
      const bd = BLOCKS[t];
      if (bd.anchored || bd.hp === Infinity) return false;
      cost += (bd.hp - (w.damage.get(col + y * WD) || 0)) * BREAK_K;
    }
    this.c = cost; this.l = la; return true;
  }

  compute(px, py, pz) {
    const w = this.w, W = w.W, D = w.D;
    const dist = this.dist, level = this.level, heap = this.heap;
    dist.fill(INF); heap.n = 0;
    const sx = Math.floor(px), sz = Math.floor(pz);
    if (sx < 0 || sz < 0 || sx >= W || sz >= D) return;
    const s = sx + sz * W;
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
      const cx = c % W, cz = (c / W) | 0, cl = level[c];
      for (let k = 0; k < 8; k++) {
        const dx = N8[k][0], dz = N8[k][1];
        const nx = cx + dx, nz = cz + dz;
        if (nx < 1 || nz < 1 || nx >= W - 1 || nz >= D - 1) { if (k < 4) open[k] = 0; continue; }
        if (k >= 4) {
          // no diagonal corner-cutting: both orthogonal neighbours must be cheaply passable
          if (!open[dx > 0 ? 0 : 1] || !open[dz > 0 ? 2 : 3]) continue;
        }
        if (!this.enter(nx, nz, cl)) { if (k < 4) open[k] = 0; continue; }
        if (k < 4) open[k] = this.c < 30 ? 1 : 0;
        const nd = dc + N8[k][2] + this.c;
        const ni = nx + nz * W;
        if (nd < dist[ni]) { dist[ni] = nd; level[ni] = this.l; heap.push(nd, ni); }
      }
    }
    this.ready = true;
  }

  // direction (dx, dz) toward the player from a world position, or null if unknown
  sample(x, z) {
    if (!this.ready) return null;
    const W = this.w.W, cx = Math.floor(x), cz = Math.floor(z);
    const here = this.dist[cx + cz * W];
    let best = here, bx = 0, bz = 0;
    for (const [dx, dz] of N8) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= W || nz >= this.w.D) continue;
      const d = this.dist[nx + nz * W];
      if (d < best) { best = d; bx = nx + 0.5 - x; bz = nz + 0.5 - z; }
    }
    if (best >= INF || (bx === 0 && bz === 0)) return null;
    const l = Math.hypot(bx, bz);
    return [bx / l, bz / l];
  }
}
