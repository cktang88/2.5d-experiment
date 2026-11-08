// Reusable voxel blueprints. Every occupied cell costs one of the selected building blocks,
// so a blueprint obeys the same materials, collisions and structural rules as manual building.
import * as THREE from 'three';
import { B } from './blocks';
import type { Game, VoxelHit } from './main';

type Cell = [number, number, number];
type Blueprint = { name: string; cells: Cell[] };
interface Bridge { cells: Cell[]; block: number; raised: boolean; raisedCells?: Cell[] }
interface Bench { cell: Cell; block: number }
export interface ConstructionSave { bridges: Bridge[]; benches: Bench[] }

function parapet(width: number): Cell[] {
  const cells: Cell[] = [], half = (width - 1) / 2;
  for (let x = -half; x <= half; x++) {
    for (let y = 0; y < 3; y++) cells.push([x, y, 0]);
    for (let z = 1; z <= 2; z++) cells.push([x, 2, z]);
    if ((x + half) % 2 === 0) cells.push([x, 3, 0]);
  }
  return cells;
}
// Full-block steps can be climbed with the existing jump and reach a three-block-high wall.
const stairs: Cell[] = [];
for (let z = 0; z < 3; z++) for (let y = 0; y <= z; y++) for (let x = 0; x < 2; x++) stairs.push([x, y, z]);
// Entrance on the near side and an interior stair lead to the roof through its opening.
const bastion: Cell[] = [];
for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) {
  const edge = Math.abs(x) === 2 || Math.abs(z) === 2;
  if (edge) for (let y = 0; y < 3; y++) {
    if (!(x === 0 && z === -2 && y < 2)) bastion.push([x, y, z]);
  }
  else if (!(x === 0 && (z === -1 || z === 0))) bastion.push([x, 2, z]);
  if (edge && (x + z) % 2 === 0) bastion.push([x, 3, z]);
}
bastion.push([0, 0, -1], [0, 0, 0], [0, 1, 0]);
// Three blocks long so one bank can support the span with ordinary plank/brick span rules.
const bridge: Cell[] = [];
for (let x = 0; x < 2; x++) for (let z = 0; z < 3; z++) bridge.push([x, 0, z]);
const BLUEPRINTS: Blueprint[] = [
  { name: 'Single block', cells: [[0, 0, 0]] },
  { name: 'Wall', cells: parapet(3) },
  { name: 'Battlement', cells: parapet(5) },
  { name: 'Stairs', cells: stairs },
  { name: 'Bastion', cells: bastion },
  { name: 'Drawbridge', cells: bridge },
  { name: 'Workbench', cells: [[0, 0, 0]] },
];

export class Construction {
  mode = 0;
  private preview: THREE.InstancedMesh;
  private matrix = new THREE.Matrix4();
  private cells: Cell[] = [];
  private valid = false;
  private cost = 0;
  private bridges: Bridge[] = [];
  private benches: Bench[] = [];
  private benchModels: THREE.Group[] = [];
  private widths = [3, 5, 9];
  private wallWidth = 0;
  private battlementWidth = 1;
  private blueprint(index = this.mode): Blueprint {
    const bp = BLUEPRINTS[index];
    if (index === 1 || index === 2) {
      const width = this.widths[index === 1 ? this.wallWidth : this.battlementWidth];
      return { name: bp.name, cells: parapet(width) };
    }
    return bp;
  }
  get options(): { name: string; cost: number; width?: number }[] {
    return BLUEPRINTS.map((_, i) => {
      const b = this.blueprint(i);
      const width = i === 1 ? this.widths[this.wallWidth] : i === 2 ? this.widths[this.battlementWidth] : undefined;
      return { name: b.name, cost: b.cells.length, width };
    });
  }
  resize(direction: number): void {
    if (this.mode !== 1 && this.mode !== 2) return;
    const old = this.mode === 1 ? this.wallWidth : this.battlementWidth;
    const next = Math.max(0, Math.min(this.widths.length - 1, old + Math.sign(direction)));
    if (this.mode === 1) this.wallWidth = next; else this.battlementWidth = next;
    const bp = this.blueprint();
    this.game.ui.toast(`${bp.name}: ${this.widths[next]} wide (${bp.cells.length} blocks)`);
  }
  constructor(private game: Game) {
    const geometry = new THREE.BoxGeometry(1.01, 1.01, 1.01);
    const material = new THREE.MeshBasicMaterial({ color: 0x6ce1a0, transparent: true, opacity: 0.35, depthWrite: false });
    this.preview = new THREE.InstancedMesh(geometry, material, 128);
    this.preview.count = 0;
    this.preview.frustumCulled = false;
    this.game.scene.add(this.preview);
  }
  cycle(): void {
    this.mode = (this.mode + 1) % BLUEPRINTS.length;
    const bp = this.blueprint();
    this.game.ui.toast(`Build: ${bp.name}${this.mode ? ` (${bp.cells.length} blocks)` : ''}`);
  }
  hide(): void { this.preview.visible = false; this.valid = false; }
  update(hit: VoxelHit | null, block: number | undefined, material: string | undefined): void {
    this.benches.forEach((b, i) => { this.benchModels[i].visible = this.game.world.get(...b.cell) === b.block; });
    if (!hit || block === undefined || !material || this.mode === 0) { this.hide(); return; }
    const { world, entities, player, inv } = this.game;
    const x0 = hit.x + hit.nx, y0 = hit.y + hit.ny, z0 = hit.z + hit.nz;
    // Local +Z follows the player's view; local +X is to its right.
    const aim = player.aimDir;
    const fx = Math.abs(aim.x) > Math.abs(aim.z) ? Math.sign(aim.x) : 0;
    const fz = fx ? 0 : (Math.sign(aim.z) || 1);
    const rx = fz, rz = -fx;
    this.cells = this.blueprint().cells.map(([x, y, z]) => [x0 + x * rx + z * fx, y0 + y, z0 + x * rz + z * fz]);
    this.cost = this.cells.length;
    this.valid = (inv[material] | 0) >= this.cost && this.cells.every(([x, y, z]) =>
      world.inBounds(x, y, z) && !!world.chunkAt(x, y, z) && !world.solid(x, y, z) && !entities.blocksCell(x, y, z));
    (this.preview.material as THREE.MeshBasicMaterial).color.setHex(this.valid ? 0x6ce1a0 : 0xff5555);
    this.preview.count = this.cells.length;
    this.cells.forEach(([x, y, z], i) => {
      this.matrix.makeTranslation(x + 0.5, y + 0.5, z + 0.5);
      this.preview.setMatrixAt(i, this.matrix);
    });
    this.preview.instanceMatrix.needsUpdate = true;
    this.preview.visible = true;
  }
  place(block: number, material: string): boolean {
    if (!this.valid) {
      this.game.audio.deny();
      this.game.ui.toast(`Cannot build: need ${this.cost} ${material} and clear space`);
      return false;
    }
    if (this.hasUnsupported(this.cells, [], block)) {
      this.game.audio.deny(); this.game.ui.toast('Needs more support underneath');
      this.hide(); return false;
    }
    for (const [x, y, z] of this.cells) this.game.world.set(x, y, z, block);
    this.game.inv[material] -= this.cost;
    this.game.checkSupport(this.cells);
    if (BLUEPRINTS[this.mode].name === 'Drawbridge') this.bridges.push({ cells: this.cells.map(c => [...c]), block, raised: false });
    if (BLUEPRINTS[this.mode].name === 'Workbench') {
      const bench: Bench = { cell: [...this.cells[0]], block };
      this.benches.push(bench); this.addBenchModel(bench);
    }
    this.game.audio.place();
    this.game.ui.toast(`${BLUEPRINTS[this.mode].name} built`, 'good');
    this.hide();
    return true;
  }
  private addBenchModel(bench: Bench): void {
    const group = new THREE.Group();
    const [x, y, z] = bench.cell;
    group.position.set(x + 0.5, y + 1, z + 0.5);
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.08, 0.12, 1.08), new THREE.MeshLambertMaterial({ color: 0x79512e }));
    top.position.y = 0.06; group.add(top);
    const tool = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.08, 0.1), new THREE.MeshLambertMaterial({ color: 0xb5bec5 }));
    tool.position.set(0, 0.16, 0); tool.rotation.y = 0.5; group.add(tool);
    this.game.scene.add(group); this.benchModels.push(group);
  }
  private hasUnsupported(cells: Cell[], removed: Cell[], block: number): boolean {
    // Overlay prospective edits on reads only. findFloating is synchronous and uses
    // World.get, so validation never touches chunks, water, decor, or physics.
    const w = this.game.world, get = w.get;
    const overlay = new Map<string, number>();
    for (const c of removed) overlay.set(c.join(','), B.AIR);
    for (const c of cells) overlay.set(c.join(','), block);
    const keys = new Set(cells.map(c => c.join(',')));
    w.get = (x, y, z) => overlay.get([x, y, z].join(',')) ?? get.call(w, x, y, z);
    try {
      return w.findFloating([...cells, ...removed]).some(cluster => cluster.some(([x, y, z]) => keys.has([x, y, z].join(','))));
    } finally { w.get = get; }
  }
  private canReach(cell: Cell): boolean {
    const p = this.game.player.pos, [x, y, z] = cell;
    if (Math.hypot(p.x - x - .5, p.y - y, p.z - z - .5) >= 3.5) return false;
    const origin = new THREE.Vector3(p.x, p.y + 1.4, p.z);
    const direction = new THREE.Vector3(x + .5, y + .5, z + .5).sub(origin);
    const distance = direction.length();
    if (distance < .001) return true;
    const hit = this.game.world.raycast(origin, direction.multiplyScalar(1 / distance), distance);
    return !hit.hit || (hit.x === x && hit.y === y && hit.z === z);
  }
  /** Forget controls attached to a block that was destroyed or fell away. */
  onBlockRemoved(x: number, y: number, z: number): void {
    const same = ([cx, cy, cz]: Cell) => cx === x && cy === y && cz === z;
    this.bridges = this.bridges.filter(b => !(b.raised ? b.raisedCells ?? [] : b.cells).some(same));
    for (let i = this.benches.length - 1; i >= 0; i--) if (same(this.benches[i].cell)) {
      const model = this.benchModels[i]; this.game.scene.remove(model);
      model.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
      this.benches.splice(i, 1); this.benchModels.splice(i, 1);
    }
  }
  nearWorkbench(): boolean {
    const w = this.game.world;
    return this.benches.some(b => w.get(...b.cell) === b.block && this.canReach(b.cell));
  }
  private target(): { kind: 'craft' } | { kind: 'bridge'; bridge: Bridge } | null {
    const p = this.game.player, w = this.game.world;
    let best: { kind: 'craft' } | { kind: 'bridge'; bridge: Bridge } | null = null;
    let bestScore = -Infinity;
    const consider = (cell: Cell, target: { kind: 'craft' } | { kind: 'bridge'; bridge: Bridge }) => {
      if (!this.canReach(cell)) return;
      const d = new THREE.Vector3(cell[0] + .5 - p.pos.x, cell[1] + .5 - (p.pos.y + 1.4), cell[2] + .5 - p.pos.z);
      const distance = d.length();
      const score = distance ? d.multiplyScalar(1 / distance).dot(p.aimDir) - distance * .02 : 1;
      if (score > bestScore) { bestScore = score; best = target; }
    };
    for (const b of this.benches) if (w.get(...b.cell) === b.block) consider(b.cell, { kind: 'craft' });
    for (const b of this.bridges) for (const cell of b.raisedCells ?? b.cells) consider(cell, { kind: 'bridge', bridge: b });
    return best;
  }
  interactionHint(): string {
    const target = this.target();
    if (!target) return '';
    return target.kind === 'craft' ? 'E · Workbench' : `E · ${target.bridge.raised ? 'Lower' : 'Raise'} drawbridge`;
  }
  /** E near a bench opens crafting; E near a drawbridge raises or lowers it. */
  interact(): 'craft' | 'bridge' | null {
    const w = this.game.world;
    const target = this.target();
    if (target?.kind === 'craft') return 'craft';
    if (target?.kind === 'bridge') {
      const b = target.bridge;
      // Blueprint order is three cells along the span for each side; the first cell
      // on each side is the hinge and remains in place through the rotation.
      const upright: Cell[] = [b.cells[0], b.cells[3]].flatMap(([x, y, z]) =>
        [[x, y, z], [x, y + 1, z], [x, y + 2, z]] as Cell[]);
      // Old saves represented a raised bridge by removing its deck entirely.
      const from = b.raised ? (b.raisedCells ?? []) : b.cells;
      const to = b.raised ? b.cells : upright;
      const key = (c: Cell) => c.join(',');
      const fromKeys = new Set(from.map(key)), toKeys = new Set(to.map(key));
      const removing = from.filter(c => !toKeys.has(key(c)));
      const adding = to.filter(c => !fromKeys.has(key(c)));
      const occupied = ([x, y, z]: Cell) => this.game.entities.blocksCell(x, y, z);
      if (from.some(c => w.get(...c) !== b.block || occupied(c)) ||
          (!b.raised && b.cells.some(([x, y, z]) => this.game.entities.blocksCell(x, y + 1, z))) ||
          adding.some(c => !w.chunkAt(...c) || w.solid(...c) || occupied(c)) ||
          (b.raised && adding.some(([x, y, z]) => this.game.entities.blocksCell(x, y + 1, z)))) {
        this.game.audio.deny(); this.game.ui.toast('Drawbridge damaged or path obstructed'); return 'bridge';
      }
      if (this.hasUnsupported(to, removing, b.block)) {
        this.game.audio.deny(); this.game.ui.toast('Drawbridge needs more support'); return 'bridge';
      }
      for (const c of removing) w.set(...c, B.AIR);
      for (const c of adding) w.set(...c, b.block);
      b.raised = !b.raised;
      b.raisedCells = b.raised ? upright : undefined;
      this.game.checkSupport([...removing, ...adding]);
      this.game.ui.toast(b.raised ? 'Drawbridge raised' : 'Drawbridge lowered', 'good');
      this.game.audio.place(); return 'bridge';
    }
    return null;
  }
  snapshot(): ConstructionSave {
    return { bridges: this.bridges.map(b => ({ ...b, cells: b.cells.map(c => [...c]), raisedCells: b.raisedCells?.map(c => [...c]) })), benches: this.benches.map(b => ({ ...b, cell: [...b.cell] })) };
  }
  restore(data?: ConstructionSave): void {
    for (const m of this.benchModels) { this.game.scene.remove(m); m.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } }); }
    this.benchModels = [];
    this.bridges = data?.bridges?.map(b => ({ ...b, cells: b.cells.map(c => [...c]), raisedCells: b.raisedCells?.map(c => [...c]) })) ?? [];
    this.benches = data?.benches?.map(b => ({ ...b, cell: [...b.cell] })) ?? [];
    for (const b of this.benches) this.addBenchModel(b);
  }
}
