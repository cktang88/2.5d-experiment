// A shared, time-sliced local walking field. Unlike the broad horde field, each
// node includes a standing height, so two floors in the same column coexist.
// Edges describe actual walking/jumping transitions, not destructible walls.
export interface NavigationWorld {
  W: number; H: number; D: number;
  isGenerated(x: number, z: number): boolean;
  get(x: number, y: number, z: number): number;
}
export interface NavigationPosition { x: number; y: number; z: number }
interface Node { x: number; y: number; z: number; next: Node | null }

const RADIUS = 24, VERTICAL = 16, MAX_NODES = 8000, BUDGET = 180;
const REFRESH = 1.5, MAX_DROP = 2;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

export class CastleNavigation {
  private nodes = new Map<string, Node>();
  private queue: Node[] = [];
  private head = 0;
  private root: Node | null = null;
  private age = 0;

  private world: NavigationWorld;
  constructor(world: NavigationWorld) { this.world = world; }

  reset(): void {
    this.nodes.clear(); this.queue = []; this.head = 0; this.root = null; this.age = 0;
  }

  private air(x: number, y: number, z: number): boolean {
    const w = this.world;
    return x >= 0 && z >= 0 && x < w.W && z < w.D && y >= 0 && y < w.H
      && w.isGenerated(x, z) && w.get(x, y, z) === 0;
  }
  private stand(x: number, y: number, z: number): boolean {
    return y > 0 && this.air(x, y, z) && this.air(x, y + 1, z)
      && !this.air(x, y - 1, z);
  }
  // Check a directed edge from a to b. On a step up the jumper needs room
  // above its starting cell. On a drop the destination column must be clear
  // for the entire fall, rather than passing through an intervening floor.
  private canMove(a: Node, b: Node): boolean {
    if (Math.abs(a.x - b.x) + Math.abs(a.z - b.z) !== 1) return false;
    const dy = b.y - a.y;
    if (dy > 1 || dy < -MAX_DROP || !this.stand(a.x, a.y, a.z) || !this.stand(b.x, b.y, b.z)) return false;
    if (dy === 1 && !this.air(a.x, a.y + 2, a.z)) return false;
    for (let y = b.y; y <= Math.max(a.y, b.y); y++) {
      if (!this.air(b.x, y, b.z) || !this.air(b.x, y + 1, b.z)) return false;
    }
    return true;
  }

  private begin(p: NavigationPosition): void {
    this.reset();
    const x = Math.floor(p.x), z = Math.floor(p.z), top = Math.floor(p.y + 0.05);
    // During a jump, root at the floor below the player, within a small bound.
    for (let y = top; y >= Math.max(1, top - 6); y--) {
      if (!this.stand(x, y, z)) continue;
      this.root = { x, y, z, next: null };
      this.nodes.set(key(x, y, z), this.root); this.queue.push(this.root);
      break;
    }
  }

  /** Call once per frame, regardless of the number of enemies. */
  update(player: NavigationPosition, dt: number): void {
    if (dt <= 0) return;
    this.age += dt;
    const root = this.root;
    const moved = !root || Math.abs(Math.floor(player.x) - root.x) > 2
      || Math.abs(Math.floor(player.z) - root.z) > 2 || Math.abs(Math.floor(player.y) - root.y) > 3;
    if (moved || (this.age >= REFRESH && this.head >= this.queue.length)) this.begin(player);
    const r = this.root;
    if (!r) return;
    let work = 0;
    while (this.head < this.queue.length && work++ < BUDGET && this.nodes.size < MAX_NODES) {
      const dst = this.queue[this.head++];
      for (const [dx, dz] of DIRS) {
        const x = dst.x + dx, z = dst.z + dz;
        if (Math.abs(x - r.x) > RADIUS || Math.abs(z - r.z) > RADIUS) continue;
        // Reverse edges: a source may step up one to dst or drop up to two.
        for (let y = dst.y - 1; y <= dst.y + MAX_DROP; y++) {
          if (Math.abs(y - r.y) > VERTICAL) continue;
          const k = key(x, y, z);
          if (this.nodes.has(k)) continue;
          const src: Node = { x, y, z, next: dst };
          if (!this.canMove(src, dst)) continue;
          this.nodes.set(k, src); this.queue.push(src);
          if (this.nodes.size >= MAX_NODES) break;
        }
      }
    }
    // A capped search is complete for refresh purposes.
    if (this.nodes.size >= MAX_NODES) this.head = this.queue.length;
  }

  /** A local direction, or null when no verified walking route is known. */
  direction(p: NavigationPosition): [number, number] | null {
    const x = Math.floor(p.x), z = Math.floor(p.z), top = Math.floor(p.y + 0.05);
    let node: Node | undefined;
    for (let y = top; y >= Math.max(1, top - 2); y--) {
      node = this.nodes.get(key(x, y, z));
      if (node && this.stand(x, y, z)) break;
      node = undefined;
    }
    if (!node?.next || !this.canMove(node, node.next)) return null;
    const dx = node.next.x + 0.5 - p.x, dz = node.next.z + 0.5 - p.z;
    const length = Math.hypot(dx, dz);
    return length > 0.001 ? [dx / length, dz / length] : null;
  }
}
