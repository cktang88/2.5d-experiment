// Reusable voxel blueprints. Every occupied cell costs one of the selected building blocks,
// so a blueprint obeys the same materials, collisions and structural rules as manual building.
import * as THREE from 'three';
import { B, BLOCKS } from './blocks';
import type { Game, VoxelHit } from './main';

type Cell = [number, number, number];
export type PreviewCell = readonly [number, number, number];
type Gesture = { kind: 'custom' | 'room' | 'stairs'; stage: 0 | 1 | 2; start?: Cell; end?: Cell; height: number; width: number; heightAdjusted: boolean };
type Blueprint = { name: string; cells: Cell[]; special?: 'drawbridge' | 'workbench' | 'custom' | 'room' };
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
  { name: 'Drawbridge', cells: bridge, special: 'drawbridge' },
  { name: 'Workbench', cells: [[0, 0, 0]], special: 'workbench' },
  { name: 'Custom wall / platform', cells: [], special: 'custom' },
  { name: 'Room shell', cells: [], special: 'room' },
];

const MAX_DIMENSION = 64;
const MAX_BUILD_CELLS = 8192;

export class Construction {
  mode = 0;
  panelOpen = false;
  rotation = 0;
  customWidth = 6;
  customHeight = 3;
  customDepth = 1;
  dimensionError = '';
  validationMessage = 'Select a building block and aim at a supporting surface.';
  private preview: THREE.InstancedMesh;
  private matrix = new THREE.Matrix4();
  private cells: Cell[] = [];
  private plannedCells: Cell[] = [];
  private valid = false;
  private geometryValid = false;
  private cost = 0;
  private bridges: Bridge[] = [];
  private benches: Bench[] = [];
  private benchModels: THREE.Group[] = [];
  private widths = [3, 5, 9];
  private wallWidth = 0;
  private battlementWidth = 1;
  private customCells: Cell[] = [];
  private customKey = '';
  private roomCells: Cell[] = [];
  private roomKey = '';
  private previewCapacity = 128;
  private supportFailureKey = '';
  private gesture: Gesture | null = null;
  private hover: Cell | null = null;
  private gestureError = '';
  get gestureActive(): boolean { return !!this.gesture && this.gesture.stage > 0; }
  get pointSelectionEnabled(): boolean { return this.gesture !== null; }
  get currentCost(): number { return this.cost; }
  private blueprint(index = this.mode): Blueprint {
    const bp = BLUEPRINTS[index];
    if (index === 1 || index === 2) {
      const width = this.widths[index === 1 ? this.wallWidth : this.battlementWidth];
      return { name: bp.name, cells: parapet(width) };
    }
    if (bp.special === 'custom') return { ...bp, cells: this.getCustomCells() };
    if (bp.special === 'room') return { ...bp, cells: this.getRoomCells() };
    return bp;
  }
  get options(): { name: string; cost: number; width?: number; dimensions?: [number, number, number]; special?: string }[] {
    return BLUEPRINTS.map((_, i) => {
      const b = this.blueprint(i);
      const width = i === 1 ? this.widths[this.wallWidth] : i === 2 ? this.widths[this.battlementWidth] : undefined;
      return { name: b.name, cost: b.cells.length, width, dimensions: b.special === 'custom' || b.special === 'room' ? [this.customWidth, this.customHeight, this.customDepth] : undefined, special: b.special };
    });
  }
  get dimensions(): [number, number, number] { return [this.customWidth, this.customHeight, this.customDepth]; }
  /** Blueprint geometry without placement, support, cost, or gesture state. */
  getPreviewCells(index: number): readonly PreviewCell[] {
    if (!Number.isInteger(index) || index < 0 || index >= BLUEPRINTS.length) return [];
    if (index === 8 && this.dimensionsError(this.customWidth, this.customHeight, this.customDepth, 'room')) {
      return this.makeRoomCells(8, 5, 8);
    }
    return this.blueprint(index).cells.map(cell => [...cell] as Cell);
  }
  openPanel(): void { this.panelOpen = true; }
  closePanel(): void { this.panelOpen = false; }
  selectPreset(index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= BLUEPRINTS.length) return false;
    this.mode = index;
    const kind = BLUEPRINTS[index].special;
    this.gesture = kind === 'custom' || kind === 'room' ? { kind, stage: 0, height: kind === 'room' ? 4 : 3, width: 2, heightAdjusted: false } : BLUEPRINTS[index].name === 'Stairs' ? { kind: 'stairs', stage: 0, height: 3, width: 2, heightAdjusted: false } : null;
    this.rotation = 0;
    this.supportFailureKey = '';
    const special = BLUEPRINTS[index].special;
    if (special === 'custom' || special === 'room') this.dimensionError = '';
    this.validationMessage = (special === 'custom' || special === 'room') && this.dimensionError
      ? this.dimensionError : 'Select a building block and aim at a supporting surface.';
    this.hide();
    return true;
  }
  setCustomDimensions(width: number, height: number, depth: number): boolean {
    const special = BLUEPRINTS[this.mode]?.special;
    this.dimensionError = this.dimensionsError(width, height, depth, special === 'room' ? 'room' : 'custom');
    if (this.dimensionError) return false;
    this.gesture = null;
    this.customWidth = width; this.customHeight = height; this.customDepth = depth;
    this.customKey = ''; this.roomKey = '';
    this.validationMessage = 'Select a building block and aim at a supporting surface.';
    return true;
  }
  private dimensionsError(width: number, height: number, depth: number, special: 'custom' | 'room'): string {
    if (![width, height, depth].every(v => Number.isInteger(v) && v >= 1 && v <= MAX_DIMENSION)) return `Each dimension must be a whole number from 1 to ${MAX_DIMENSION}.`;
    if (special === 'room' && (width < 4 || height < 4 || depth < 4)) return 'Room shell needs at least 4 wide × 4 tall × 4 deep for its 2 × 3 doorway.';
    const count = this.occupiedCustomCount(width, height, depth, special === 'room');
    return count > MAX_BUILD_CELLS ? `A build can use at most ${MAX_BUILD_CELLS} blocks.` : '';
  }
  cancelGesture(): void {
    if (this.gesture) { this.gesture.stage = 0; this.gesture.start = undefined; this.gesture.end = undefined; this.gesture.heightAdjusted = false; }
    this.hover = null; this.hide();
  }
  adjustGesture(direction: number): boolean {
    const g = this.gesture;
    if (!g || g.stage !== 2 || !direction) return false;
    if (g.kind === 'stairs') g.width = Math.max(1, Math.min(MAX_DIMENSION, g.width + Math.sign(direction)));
    else { g.height = Math.max(1, Math.min(MAX_DIMENSION, g.height + Math.sign(direction))); g.heightAdjusted = true; }
    return true;
  }
  rotate(): void {
    this.rotation = (this.rotation + 1) & 3;
    this.hide();
    this.game.ui.toast(`Build rotated ${this.rotation * 90}°`);
  }
  private getCustomCells(): Cell[] {
    const key = `${this.customWidth},${this.customHeight},${this.customDepth}`;
    if (this.customKey === key) return this.customCells;
    const cells: Cell[] = [];
    const x0 = -Math.floor(this.customWidth / 2);
    // Anchor the near face at the hit cell and extend depth away from the player.
    // Centering depth made long custom walls overlap the builder and fail reach checks.
    for (let y = 0; y < this.customHeight; y++) for (let z = 0; z < this.customDepth; z++) for (let x = 0; x < this.customWidth; x++) cells.push([x0 + x, y, z]);
    this.customKey = key; this.customCells = cells;
    return cells;
  }
  private occupiedCustomCount(width: number, height: number, depth: number, room: boolean): number {
    if (!room) return width * height * depth;
    if (width < 4 || height < 4 || depth < 4) return 0;
    // Floor plus four non-overlapping walls, less the centered 2-wide × 3-high doorway.
    const wallCells = width * 2 + Math.max(0, depth - 2) * 2;
    return width * depth + wallCells * (height - 1) - 6;
  }
  private getRoomCells(): Cell[] {
    const key = `${this.customWidth},${this.customHeight},${this.customDepth}`;
    if (this.roomKey === key) return this.roomCells;
    const cells = this.makeRoomCells(this.customWidth, this.customHeight, this.customDepth);
    this.roomKey = key; this.roomCells = cells;
    return cells;
  }
  private makeRoomCells(width: number, height: number, depth: number): Cell[] {
    const cells: Cell[] = [], half = Math.floor(width / 2), doorX0 = -1;
    for (let z = 0; z < depth; z++) for (let x = -half; x < -half + width; x++) cells.push([x, 0, z]);
    for (let y = 1; y < height; y++) for (let x = -half; x < -half + width; x++) for (let z = 0; z < depth; z++) {
      const wall = x === -half || x === -half + width - 1 || z === 0 || z === depth - 1;
      if (!wall) continue;
      const doorway = z === 0 && x >= doorX0 && x < doorX0 + 2 && y <= 3;
      if (!doorway) cells.push([x, y, z]);
    }
    return cells;
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
    this.selectPreset((this.mode + 1) % BLUEPRINTS.length);
    this.rotation = 0;
    const bp = this.blueprint();
    this.game.ui.toast(`Build: ${bp.name}${this.mode ? ` (${bp.cells.length} blocks)` : ''}`);
  }
  hide(): void { this.preview.visible = false; this.valid = false; this.geometryValid = false; }
  private ensurePreviewCapacity(required: number): void {
    if (required <= this.previewCapacity) return;
    let capacity = this.previewCapacity;
    while (capacity < required && capacity < MAX_BUILD_CELLS) capacity = Math.min(MAX_BUILD_CELLS, capacity * 2);
    const old = this.preview;
    const replacement = new THREE.InstancedMesh(old.geometry, old.material, capacity);
    replacement.count = 0; replacement.frustumCulled = false;
    replacement.renderOrder = old.renderOrder;
    this.game.scene.remove(old); this.game.scene.add(replacement);
    old.dispose();
    this.preview = replacement; this.previewCapacity = capacity;
  }
  update(hit: VoxelHit | null, block: number | undefined, material: string | undefined): void {
    this.benches.forEach((b, i) => { this.benchModels[i].visible = this.game.world.get(...b.cell) === b.block; });
    const special = BLUEPRINTS[this.mode]?.special;
    if (!this.gesture && (special === 'custom' || special === 'room') && this.dimensionError) { this.validationMessage = this.dimensionError; this.hide(); return; }
    if ((!hit && (!this.gesture || this.gesture.stage === 0)) || block === undefined || !material || this.mode === 0) { this.hover = null; this.validationMessage = 'Select planks or bricks and aim at a supporting surface.'; this.hide(); return; }
    const { world, entities, player, inv } = this.game;
    const projected = this.gesture && this.gesture.stage > 0 ? this.gesturePoint(this.gesture, hit) : null;
    if (!hit && !projected) { this.hover = null; this.validationMessage = 'Aim toward the build area.'; this.hide(); return; }
    const x0 = projected?.[0] ?? hit!.x + hit!.nx, y0 = projected?.[1] ?? hit!.y + hit!.ny, z0 = projected?.[2] ?? hit!.z + hit!.nz;
    // A side-face hit defines the run axis directly: the face normal points into
    // the free adjacent cell, so a depth-bearing blueprint extends away from the
    // obstructing block. On top-face hits use the cardinal player view instead.
    const aim = player.aimDir;
    const sideFace = !!hit && (hit.nx !== 0 || hit.nz !== 0);
    const fx = sideFace ? hit!.nx : Math.abs(aim.x) > Math.abs(aim.z) ? Math.sign(aim.x) : 0;
    const fz = sideFace ? hit!.nz : fx ? 0 : (Math.sign(aim.z) || 1);
    const rx = fz, rz = -fx;
    const turn = this.rotation === 0 ? 0 : this.rotation === 1 ? 1 : this.rotation === 2 ? 2 : 3;
    this.hover = [x0, y0, z0];
    if (this.gesture) {
      const g = this.gesture;
      if (g.stage === 0) { this.validationMessage = `Click the ${g.kind === 'stairs' ? 'stair start' : 'first ground corner'}.`; this.hide(); return; }
      if (g.stage === 1) { this.validationMessage = `Click the ${g.kind === 'stairs' ? 'stair end' : 'opposite ground corner'}.`; }
      if (g.stage === 2 && g.kind !== 'stairs' && !g.heightAdjusted) g.height = Math.max(1, Math.min(MAX_DIMENSION, y0 - g.start![1] + 1));
      const end = g.stage === 1 ? this.hover : g.end!;
      const result = this.gestureCells(g, end);
      this.cells = result.cells;
      this.gestureError = result.error ?? '';
      if (result.error) { this.validationMessage = result.error; this.hide(); return; }
    } else {
    this.cells = this.blueprint().cells.map(([x, y, z]) => {
      const tx = turn === 0 ? x : turn === 1 ? -z : turn === 2 ? -x : z;
      const tz = turn === 0 ? z : turn === 1 ? x : turn === 2 ? -z : -x;
      return [x0 + tx * rx + tz * fx, y0 + y, z0 + tx * rz + tz * fz];
    });
    }
    const unique = new Map(this.cells.map(c => [c.join(','), c]));
    this.cells = [...unique.values()];
    const allCells = this.cells;
    this.plannedCells = allCells;
    const placementKey = this.placementKey(block, material);
    this.validationMessage = '';
    if (allCells.length <= 0) this.validationMessage = 'This blueprint has no blocks.';
    else if (allCells.length > MAX_BUILD_CELLS) this.validationMessage = `A build can use at most ${MAX_BUILD_CELLS} blocks.`;
    else for (const [x, y, z] of allCells) {
      if (!world.inBounds(x, y, z)) { this.validationMessage = 'Build would be outside the world.'; break; }
      if (!world.chunkAt(x, y, z)) { this.validationMessage = 'Build area is still loading.'; break; }
      if (entities.blocksCell(x, y, z)) { this.validationMessage = 'An actor is in the build space.'; break; }
    }
    this.cells = allCells.filter(([x, y, z]) => !world.solid(x, y, z));
    this.cost = this.cells.length;
    if (!this.validationMessage && !this.cost) this.validationMessage = 'Already built; no new blocks needed.';
    if (!this.validationMessage && !this.game.sandbox && !this.game.freeBuild && (inv[material] | 0) < this.cost) this.validationMessage = `Need ${this.cost} ${material}; you have ${inv[material] | 0}.`;
    this.geometryValid = this.validationMessage === '';
    this.valid = this.geometryValid;
    if (this.valid && this.supportFailureKey === placementKey) {
      this.valid = false;
      this.validationMessage = 'Needs foundation or support; aim at a supported anchor or change the shape.';
    }
    if (this.valid) this.validationMessage = this.gesture ? (this.gesture.stage === 1 ? `Click the ${this.gesture.kind === 'stairs' ? 'stair end' : 'opposite ground corner'}.` : this.gesture.kind === 'stairs' ? `Width ${this.gesture.width}: scroll or use brackets, then click to build.` : `Height ${this.gesture.height}: aim higher or scroll, then click to build.`) : 'Clear space and materials; support is checked when placing.';
    (this.preview.material as THREE.MeshBasicMaterial).color.setHex(this.valid ? 0x6ce1a0 : 0xff5555);
    this.ensurePreviewCapacity(this.cells.length);
    this.preview.count = this.cells.length;
    this.cells.forEach(([x, y, z], i) => {
      this.matrix.makeTranslation(x + 0.5, y + 0.5, z + 0.5);
      this.preview.setMatrixAt(i, this.matrix);
    });
    this.preview.instanceMatrix.needsUpdate = true;
    this.preview.visible = true;
  }
  place(block: number, material: string): boolean {
    const g = this.gesture;
    if (g && g.stage < 2) {
      if (!this.hover || !this.game.world.inBounds(...this.hover) || !this.game.world.chunkAt(...this.hover)) { this.game.audio.deny(); return false; }
      if (g.stage === 0) { g.start = [...this.hover]; g.stage = 1; }
      else { if (this.gestureError) { this.game.audio.deny(); this.game.ui.toast(this.gestureError); return false; } g.end = [...this.hover]; g.stage = 2; }
      this.hide(); return true;
    }
    const world = this.game.world;
    for (const [x, y, z] of this.plannedCells) {
      if (!world.inBounds(x, y, z) || !world.chunkAt(x, y, z) || this.game.entities.blocksCell(x, y, z)) {
        this.validationMessage = 'Build area is unavailable or occupied by an actor.';
        this.game.audio.deny(); this.game.ui.toast(this.validationMessage); return false;
      }
    }
    this.cells = this.plannedCells.filter(([x, y, z]) => !world.solid(x, y, z));
    this.cost = this.cells.length;
    if (!this.cost) { this.validationMessage = 'Already built; no new blocks needed.'; this.game.ui.toast(this.validationMessage); return false; }
    const failureKey = this.placementKey(block, material);
    const retryingSupportFailure = this.geometryValid && this.supportFailureKey === failureKey;
    if ((!this.valid && !retryingSupportFailure) || this.cost <= 0 || this.cost > MAX_BUILD_CELLS || !Number.isFinite(this.cost) || (!this.game.sandbox && !this.game.freeBuild && (!this.game.inv[material] || this.game.inv[material] < this.cost))) {
      this.game.audio.deny();
      this.game.ui.toast(`Cannot build: ${this.validationMessage || `need ${this.cost} ${material} and clear space`}`);
      return false;
    }
    // A support-only cached red preview must remain actionable: recheck the
    // structure when clicked so the player can add a foundation and retry at
    // the same location without moving their aim.
    if (retryingSupportFailure) {
      if (this.hasUnsupported(this.cells, [], block)) {
        this.validationMessage = 'Needs foundation or support; add support, then click to retry.';
        (this.preview.material as THREE.MeshBasicMaterial).color.setHex(0xff5555);
        this.game.audio.deny(); this.game.ui.toast(this.validationMessage);
        return false;
      }
      this.supportFailureKey = '';
      this.valid = true;
      this.validationMessage = 'Clear space and materials; support is checked when placing.';
    }
    if (this.hasUnsupported(this.cells, [], block)) {
      this.supportFailureKey = failureKey;
      this.validationMessage = 'Needs foundation or support; add support, then click to retry.';
      (this.preview.material as THREE.MeshBasicMaterial).color.setHex(0xff5555);
      this.game.audio.deny(); this.game.ui.toast(this.validationMessage);
      return false;
    }
    for (const [x, y, z] of this.cells) this.game.world.set(x, y, z, block);
    if (!this.game.sandbox && !this.game.freeBuild) this.game.inv[material] -= this.cost;
    this.game.checkSupport(this.cells);
    if (BLUEPRINTS[this.mode].special === 'drawbridge' && this.cells.length === this.plannedCells.length) this.bridges.push({ cells: this.cells.map(c => [...c]), block, raised: false });
    if (BLUEPRINTS[this.mode].special === 'workbench') {
      const bench: Bench = { cell: [...this.cells[0]], block };
      this.benches.push(bench); this.addBenchModel(bench);
    }
    this.game.audio.place();
    this.game.ui.toast(`${BLUEPRINTS[this.mode].name} built`, 'good');
    this.cancelGesture();
    return true;
  }
  private gesturePoint(g: Gesture, hit: VoxelHit | null): Cell | null {
    const origin = this.game.camera.position, dir = this.game.player.aimDir;
    if (g.kind === 'stairs' && g.stage === 1 && hit) return [hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz];
    let t: number;
    if (g.stage === 1 || g.kind === 'stairs') {
      if (Math.abs(dir.y) < 0.0001) return null;
      t = (g.start![1] + 0.5 - origin.y) / dir.y;
    } else {
      const end = g.end!;
      const nx = origin.x - (end[0] + .5), nz = origin.z - (end[2] + .5);
      const denom = dir.x * nx + dir.z * nz;
      if (Math.abs(denom) < 0.0001) return null;
      t = ((end[0] + .5 - origin.x) * nx + (end[2] + .5 - origin.z) * nz) / denom;
    }
    if (t < 0 || !Number.isFinite(t)) return null;
    return [Math.floor(origin.x + dir.x * t), Math.floor(origin.y + dir.y * t), Math.floor(origin.z + dir.z * t)];
  }
  private gestureCells(g: Gesture, end: Cell): { cells: Cell[]; error?: string } {
    const [sx, sy, sz] = g.start!;
    const cells: Cell[] = [];
    if (g.kind === 'stairs') {
      const dx = end[0] - sx, dz = end[2] - sz;
      const alongX = Math.abs(dx) >= Math.abs(dz);
      const delta = alongX ? dx : dz, length = Math.abs(delta) + 1;
      const rise = end[1] - sy;
      if (Math.abs(rise) >= length) return { cells, error: 'Stairs need at least one block of run per block of rise.' };
      if (length > MAX_DIMENSION || g.width > MAX_DIMENSION || length * g.width * (Math.abs(rise) + 1) > MAX_BUILD_CELLS) return { cells, error: `A build can use at most ${MAX_BUILD_CELLS} blocks and ${MAX_DIMENSION} blocks per dimension.` };
      const sign = Math.sign(delta) || 1, bottom = Math.min(sy, end[1]);
      for (let i = 0; i < length; i++) {
        const top = sy + Math.round(rise * i / Math.max(1, length - 1));
        for (let w = 0; w < g.width; w++) for (let y = bottom; y <= top; y++) cells.push(alongX ? [sx + i * sign, y, sz + w] : [sx + w, y, sz + i * sign]);
      }
    } else {
      const minX = Math.min(sx, end[0]), minZ = Math.min(sz, end[2]);
      const width = Math.abs(end[0] - sx) + 1, depth = Math.abs(end[2] - sz) + 1, height = g.height;
      const error = this.dimensionsError(width, height, depth, g.kind);
      if (error) return { cells, error };
      for (let y = 0; y < height; y++) for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) {
        if (g.kind === 'room' && y > 0) {
          if (x !== 0 && x !== width - 1 && z !== 0 && z !== depth - 1) continue;
          if (z === 0 && x >= Math.floor(width / 2) - 1 && x < Math.floor(width / 2) + 1 && y <= 3) continue;
        }
        cells.push([minX + x, sy + y, minZ + z]);
      }
    }
    return { cells };
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
    const cellKeys = new Set(cells.map(c => c.join(',')));
    // World.unsupported intentionally leaves any component over its 6,000-cell
    // budget standing. For larger blueprints, reject a wholly floating shape
    // before calling that conservative solver; supported 8,192-cell boxes remain
    // placeable. This cheap boundary scan is O(cells), bounded by MAX_BUILD_CELLS.
    let anchoredContact = false;
    if (cells.length > 6000) for (const [x, y, z] of cells) {
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (cellKeys.has(`${nx},${ny},${nz}`)) continue;
        const t = overlay.get(`${nx},${ny},${nz}`) ?? get.call(w, nx, ny, nz);
        if (t !== B.AIR && BLOCKS[t]?.anchored) { anchoredContact = true; break; }
      }
      if (anchoredContact) break;
    }
    if (cells.length > 6000 && !anchoredContact) return true;
    const keys = new Set(cells.map(c => c.join(',')));
    w.get = (x, y, z) => overlay.get([x, y, z].join(',')) ?? get.call(w, x, y, z);
    try {
      return w.findFloating([...cells, ...removed]).some(cluster => cluster.some(([x, y, z]) => keys.has([x, y, z].join(','))));
    } finally { w.get = get; }
  }
  private placementKey(block: number, material: string): string {
    const first = this.cells[0];
    return `${this.mode}:${this.rotation}:${block}:${material}:${this.customWidth},${this.customHeight},${this.customDepth}:${first?.join(',') ?? 'none'}:${this.cells.length}`;
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
