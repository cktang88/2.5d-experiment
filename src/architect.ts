// Architect mode: an overhead, RimWorld-style planning view for building at castle scale.
//
// Q leaves first person and eases the camera up into a free orbit view (WASD / middle-drag pan,
// right-drag orbit, wheel zoom toward the cursor). The mouse is free; drag on the world to draw
// walls, free-angle walls, solid blocks, rooms, round towers, stairs, dug areas, flooded moats and
// erase volumes, or click to deploy defenses. Every shape is a list of axis-aligned boxes, so the
// preview is a handful of instanced boxes even for a 100 × 200 × 5 wall, and committing a shape
// queues a job that writes its cells bottom-up across frames (with a progress readout) instead of
// stalling the game. Every job is recorded for undo / redo.
import * as THREE from 'three';
import { B, BLOCKS } from './blocks';
import { sharedUniforms } from './world';
import { DEFENSES, getDefense, footprintSize, type DefenseId } from './defenses';
import { validateDefensePlacement } from './defensePlacement';
import { TRAPS, type TrapId } from './traps';
import { Turret } from './entities';
import type { Game } from './main';

type Box = [number, number, number, number, number, number]; // x0 y0 z0 x1 y1 z1, inclusive
type Cell = [number, number, number];
export type ToolId = 'wall' | 'line' | 'box' | 'room' | 'tower' | 'stairs' | 'dig' | 'moat' | 'erase' | 'place';
type PlaceId = DefenseId | TrapId | 'workbench' | 'drawbridge';

interface ToolDef { id: ToolId; name: string; key: string; tip: string; kind: 'build' | 'dig' | 'erase' | 'place' }
const TOOLS: ToolDef[] = [
  { id: 'wall', name: 'Wall', key: '1', kind: 'build', tip: 'Drag a rectangle for a walled enclosure, or a thin strip for a straight wall.' },
  { id: 'line', name: 'Line wall', key: '2', kind: 'build', tip: 'Drag a wall at any angle (diagonals, star forts).' },
  { id: 'box', name: 'Block', key: '3', kind: 'build', tip: 'Drag a solid block: floors, platforms, ramparts, giant walls.' },
  { id: 'room', name: 'Room', key: '4', kind: 'build', tip: 'Drag a room: floor, walls, door facing the camera, optional roof. Build on its roof for the next storey.' },
  { id: 'tower', name: 'Tower', key: '5', kind: 'build', tip: 'Drag out from the centre for a round tower.' },
  { id: 'stairs', name: 'Stairs', key: '6', kind: 'build', tip: 'Drag along the run; they climb toward where you release, up to the height setting.' },
  { id: 'dig', name: 'Dig', key: '7', kind: 'dig', tip: 'Drag to excavate an area to the set depth (cuts through hills too).' },
  { id: 'moat', name: 'Moat', key: '8', kind: 'dig', tip: 'Drag a rectangle to dig a ring trench and flood it with water.' },
  { id: 'erase', name: 'Erase', key: '9', kind: 'erase', tip: 'Drag to remove built blocks from the clicked height upward. Cut gates, windows, mistakes.' },
  { id: 'place', name: 'Defenses', key: '0', kind: 'place', tip: 'Click to deploy turrets, traps, workbenches and drawbridges. R rotates.' },
];

interface Material { id: string; name: string; block: number; cost: string }
const MATERIALS: Material[] = [
  { id: 'bricks', name: 'Brick', block: B.BRICK, cost: 'bricks' },
  { id: 'cobble', name: 'Cobble', block: B.COBBLE, cost: 'stone' },
  { id: 'planks', name: 'Planks', block: B.PLANKS, cost: 'planks' },
  { id: 'metal', name: 'Metal', block: B.METAL, cost: 'metal' },
  { id: 'roof', name: 'Roof tile', block: B.ROOF, cost: 'planks' },
];
// what removing a built block gives back when construction isn't free
const REFUND: Record<number, string> = { [B.BRICK]: 'bricks', [B.COBBLE]: 'stone', [B.PLANKS]: 'planks', [B.METAL]: 'metal', [B.ROOF]: 'planks' };

const PLACEABLES: { id: PlaceId; name: string; inv?: string }[] = [
  ...Object.values(DEFENSES).map(d => ({ id: d.id as PlaceId, name: d.name, inv: d.inventoryKey })),
  ...Object.values(TRAPS).map(t => ({ id: t.id as PlaceId, name: t.name, inv: t.inventoryKey })),
  { id: 'workbench', name: 'Workbench' },
  { id: 'drawbridge', name: 'Drawbridge' },
];

export const MAX_SPAN = 512;          // per horizontal axis
export const MAX_HEIGHT = 160;
export const MAX_CELLS = 1_000_000;   // per operation
const COUNT_LIMIT = 600_000;           // above this an erase/dig volume is estimated while dragging
const FOUNDATION_DEPTH = 48;
const FOUNDATION_COLUMNS = 80_000;
const UNDO_BUDGET = 24_000_000;        // bytes of undo history kept
const FOCUS_RANGE = 230;               // how far the planning camera may roam from the player

// `cut` is excavation above the dig level that only takes natural ground and trees (hills in the way), never buildings
interface Plan { fill: Box[]; clear: Box[]; cut: Box[]; flood: Box[]; dims: string; error: string; volume: number; note: string; base: number }
interface Op { label: string; cells: Int32Array; prev: Uint8Array; next: Uint8Array; spent: Record<string, number> }
interface Job {
  label: string; mode: 'fill' | 'clear' | 'restore';
  cells: Int32Array; n: number; i: number; block: number; values: Uint8Array | null; builtOnly: boolean;
  flood: Int32Array | null; record: 'new' | 'undo' | 'redo'; op?: Op; naturalAbove: number;
  appliedCells: number[]; appliedPrev: number[]; appliedNext: number[];
  paidKey: string; paid: number; refunds: Record<string, number>;
}

const SVG: Record<ToolId, string> = {
  wall: '<rect x="4" y="6" width="16" height="12" fill="none" stroke="currentColor" stroke-width="3"/>',
  line: '<path d="M4 19 L20 5" stroke="currentColor" stroke-width="4" stroke-linecap="square"/>',
  box: '<path d="M4 8 L12 4 L20 8 L20 16 L12 20 L4 16 Z M4 8 L12 12 L20 8 M12 12 L12 20" fill="currentColor" fill-opacity=".35" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  room: '<path d="M4 20 V8 H20 V20 M10 20 V14 H14 V20" fill="none" stroke="currentColor" stroke-width="2.6"/>',
  tower: '<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="3"/>',
  stairs: '<path d="M4 20 V16 H8 V12 H12 V8 H16 V4 H20 V20 Z" fill="currentColor" fill-opacity=".45" stroke="currentColor" stroke-width="1.6"/>',
  dig: '<path d="M4 7 H9 V15 H15 V7 H20" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M9 15 H15" stroke="currentColor" stroke-width="2.6"/>',
  moat: '<path d="M3 9 H8 V16 H16 V9 H21" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M8.5 12.5 q1.9 -1.6 3.6 0 t3.6 0" fill="none" stroke="#6fc8ff" stroke-width="2"/>',
  erase: '<path d="M5 15 L13 7 L19 13 L13 19 H8 Z" fill="currentColor" fill-opacity=".35" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 11 L15 17" stroke="currentColor" stroke-width="1.6"/>',
  place: '<path d="M6 20 H18 V16 H6 Z M9 16 V11 H15 V16 M12 11 V4 M10 6 H14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
};

const GHOST_VERT = /* glsl */`
  varying vec3 vW; varying vec3 vN;
  void main() {
    mat4 m = modelMatrix * instanceMatrix;
    vec4 w = m * vec4(position, 1.0);
    vW = w.xyz; vN = normalize(mat3(m) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;
// translucent fill with the voxel grid drawn on every face (lines fade out when they get too dense)
const GHOST_FRAG = /* glsl */`
  uniform vec3 uColor; uniform float uOpacity; uniform float uLine;
  varying vec3 vW; varying vec3 vN;
  void main() {
    vec3 n = abs(vN);
    vec2 uv = n.x > 0.5 ? vW.yz : n.y > 0.5 ? vW.xz : vW.xy;
    vec2 g = abs(fract(uv + 0.5) - 0.5);
    vec2 fw = max(fwidth(uv), vec2(1e-4));
    float line = 1.0 - min(min(g.x / fw.x, g.y / fw.y), 1.0);
    line *= uLine * (1.0 - smoothstep(0.12, 0.45, max(fw.x, fw.y)));
    float shade = n.y > 0.5 ? 1.0 : n.x > 0.5 ? 0.82 : 0.7;
    gl_FragColor = vec4(uColor * shade + line * 0.35, uOpacity + line * 0.5);
  }`;
// the working plane when a level is locked: a grid that fades out around the cursor
const PLANE_FRAG = /* glsl */`
  uniform vec3 uCenter; uniform float uRadius;
  varying vec3 vW; varying vec3 vN;
  void main() {
    vec2 g = abs(fract(vW.xz + 0.5) - 0.5);
    vec2 fw = max(fwidth(vW.xz), vec2(1e-4));
    float line = 1.0 - min(min(g.x / fw.x, g.y / fw.y), 1.0);
    float major = 1.0 - min(min(abs(fract(vW.x / 8.0 + 0.5) - 0.5) * 8.0 / fw.x, abs(fract(vW.z / 8.0 + 0.5) - 0.5) * 8.0 / fw.y), 1.0);
    float fade = 1.0 - smoothstep(uRadius * 0.4, uRadius, length(vW.xz - uCenter.xz));
    float a = (line * 0.28 + major * 0.35) * fade;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vec3(0.75, 0.92, 1.0), a);
  }`;

function ghostMaterial(color: number, opacity: number, line = 1): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: GHOST_VERT, fragmentShader: GHOST_FRAG, transparent: true, depthWrite: false,
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uLine: { value: line } },
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
}

const ease = (t: number) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const natural = (t: number) => BLOCKS[t]?.anchored || t === B.LOG || t === B.LEAVES;
const boxVolume = (b: Box) => (b[3] - b[0] + 1) * (b[4] - b[1] + 1) * (b[5] - b[2] + 1);

export class Architect {
  open = false;            // planning UI and input active
  cameraActive = false;    // camera overridden (also while easing back to first person)
  timePaused = false;
  tool: ToolId = 'wall';
  material = MATERIALS[0];
  height = 6;
  thickness = 2;
  depth = 3;
  eraseHeight = 48;
  battlements = true;
  foundation = true;
  roof = true;
  door = true;
  pillars = true;
  hollow = true;
  flood = true;
  builtOnly = true;
  placeId: PlaceId = 'auto';
  rotation = 0;
  levelLocked = false;
  level = 64;
  slice = true;

  // orbit camera
  readonly target = new THREE.Vector3();
  private targetGoal = new THREE.Vector3();
  private yaw = 0; private yawGoal = 0;
  private pitch = 0.95; private pitchGoal = 0.95;
  private dist = 60; private distGoal = 60;
  private trans = 1; private leaving = false;
  private fromPos = new THREE.Vector3(); private fromQuat = new THREE.Quaternion(); private fromFov = 75;

  // pointer
  private mx = innerWidth / 2; private my = innerHeight / 2; private overCanvas = true;
  private keys: Record<string, boolean> = {};
  private drag: { start: Cell; base: number; button: number } | null = null;
  private orbitDrag: { x: number; y: number; moved: number; button: number } | null = null;
  private hoverCell: Cell | null = null; private hoverSolid: Cell | null = null; private hoverPoint: THREE.Vector3 | null = null;
  private raycaster = new THREE.Raycaster();

  // plan + preview
  private plan: Plan | null = null;
  private planKey = '';
  private counts = { add: 0, remove: 0, exact: true };
  private fillMesh: THREE.InstancedMesh; private clearMesh: THREE.InstancedMesh; private floodMesh: THREE.InstancedMesh;
  private cursorMesh: THREE.Mesh; private planeMesh: THREE.Mesh; private marker: THREE.Group;
  private fillMat = ghostMaterial(0x6ce1a0, 0.32); private clearMat = ghostMaterial(0xff6a4a, 0.22); private floodMat = ghostMaterial(0x4aa8ff, 0.3, 0.4);
  private m4 = new THREE.Matrix4(); private v3 = new THREE.Vector3(); private q = new THREE.Quaternion(); private s3 = new THREE.Vector3();

  // jobs + history
  private jobs: Job[] = [];
  private undoStack: Op[] = [];
  private redoStack: Op[] = [];
  private occupied = new Set<number>();

  // DOM
  private root!: HTMLElement; private tip!: HTMLElement; private opts!: HTMLElement; private status!: HTMLElement; private toolsEl!: HTMLElement;
  private optsHTML = ''; private statusHTML = ''; private tipHTML = '';

  constructor(private game: Game) {
    const unit = new THREE.BoxGeometry(1, 1, 1);
    const mk = (mat: THREE.Material, order: number) => { const m = new THREE.InstancedMesh(unit, mat, 64); m.count = 0; m.frustumCulled = false; m.renderOrder = order; m.visible = false; game.scene.add(m); return m; };
    this.fillMesh = mk(this.fillMat, 20); this.clearMesh = mk(this.clearMat, 21); this.floodMesh = mk(this.floodMat, 22);
    this.cursorMesh = new THREE.Mesh(unit, ghostMaterial(0xffffff, 0.12));
    (this.cursorMesh.material as THREE.ShaderMaterial).vertexShader = GHOST_VERT.replace('modelMatrix * instanceMatrix', 'modelMatrix');
    this.cursorMesh.renderOrder = 23; this.cursorMesh.visible = false; this.cursorMesh.frustumCulled = false;
    this.planeMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
      vertexShader: GHOST_VERT.replace('modelMatrix * instanceMatrix', 'modelMatrix'), fragmentShader: PLANE_FRAG, transparent: true, depthWrite: false,
      uniforms: { uCenter: { value: new THREE.Vector3() }, uRadius: { value: 40 } },
    }));
    this.planeMesh.renderOrder = 19; this.planeMesh.visible = false; this.planeMesh.frustumCulled = false;
    // where your character stands (first person has no visible body), seen from above
    this.marker = new THREE.Group();
    const glow = { transparent: true, depthWrite: false, depthTest: false };
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 1.0, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x62f5ff, opacity: 0.9, ...glow }));
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 6, 8).translate(0, 3, 0), new THREE.MeshBasicMaterial({ color: 0x62f5ff, opacity: 0.45, ...glow }));
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.1, 4).rotateX(Math.PI).translate(0, 2.6, 0), new THREE.MeshBasicMaterial({ color: 0xbffbff, opacity: 0.95, ...glow }));
    this.marker.add(ring, beam, head);
    this.marker.renderOrder = 30; this.marker.traverse(o => { o.renderOrder = 30; });
    this.marker.visible = false;
    game.scene.add(this.cursorMesh, this.planeMesh, this.marker);
    try { const m = localStorage.getItem('blockfall.architect.material'); const found = MATERIALS.find(x => x.id === m); if (found) this.material = found; } catch { /* storage unavailable */ }
    this.buildDom();
    this.bindInput();
  }

  // ---------------------------------------------------------------- enter / exit
  enter(tool?: ToolId, place?: PlaceId): void {
    const g = this.game;
    if (tool) this.tool = tool;
    if (place) { this.placeId = place; this.tool = 'place'; }
    if (this.open) { this.refresh(); return; }
    if (!g.started || g.paused || g.player.dead) return;
    this.open = true; this.cameraActive = true; this.leaving = false;
    this.drag = null; this.orbitDrag = null; this.keys = {};
    this.fromPos.copy(g.camera.position); this.fromQuat.copy(g.camera.quaternion); this.fromFov = g.camera.fov; this.trans = 0;
    const p = g.player.pos;
    this.yaw = this.yawGoal = g.camYaw;
    this.pitch = this.pitchGoal = 0.98;
    this.dist = this.distGoal = 58;
    const fx = -Math.sin(g.camYaw), fz = -Math.cos(g.camYaw);
    this.targetGoal.set(p.x + fx * 14, 0, p.z + fz * 14);
    this.targetGoal.y = this.groundY(this.targetGoal.x, this.targetGoal.z);
    this.target.copy(this.targetGoal);
    if (!this.levelLocked) this.level = Math.floor(p.y);
    g.hideAiming();
    if (document.pointerLockElement) document.exitPointerLock();
    document.body.classList.add('architect');
    this.root.classList.remove('hidden');
    g.audio.click();
    this.refresh();
  }
  exit(relock = true): void {
    if (!this.open) return;
    const g = this.game;
    this.open = false; this.leaving = true; this.trans = 0;
    this.fromPos.copy(g.camera.position); this.fromQuat.copy(g.camera.quaternion); this.fromFov = g.camera.fov;
    this.drag = null; this.orbitDrag = null; this.keys = {};
    this.hidePreview();
    this.timePaused = false;
    sharedUniforms.uSlice.value = 0;
    document.body.classList.remove('architect');
    this.root.classList.add('hidden');
    this.tip.classList.add('hidden');
    if (relock && g.started && !g.paused && !g.player.dead) void g.requestLook();
  }

  // ---------------------------------------------------------------- camera
  private groundY(x: number, z: number): number {
    return this.levelLocked ? this.level : Math.max(this.game.world.gen.heightAt(x, z) + 1, 1);
  }
  private orbitPose(pos: THREE.Vector3): void {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    pos.set(this.target.x + Math.sin(this.yaw) * cp * this.dist, this.target.y + sp * this.dist, this.target.z + Math.cos(this.yaw) * cp * this.dist);
  }
  /** Positions the camera; returns the distance used for streaming / fog scaling. */
  updateCamera(dt: number): number {
    const g = this.game, c = g.camera;
    const k = 1 - Math.exp(-dt * 10);
    if (this.open) this.pan(dt);
    // keep the plan within reach of the streamed world around the player
    const p = g.player.pos, dx = this.targetGoal.x - p.x, dz = this.targetGoal.z - p.z, d = Math.hypot(dx, dz);
    if (d > FOCUS_RANGE) { this.targetGoal.x = p.x + dx / d * FOCUS_RANGE; this.targetGoal.z = p.z + dz / d * FOCUS_RANGE; }
    this.targetGoal.y = this.groundY(this.targetGoal.x, this.targetGoal.z);
    this.target.lerp(this.targetGoal, k);
    this.yaw += (this.yawGoal - this.yaw) * k;
    this.pitch += (this.pitchGoal - this.pitch) * k;
    this.dist += (this.distGoal - this.dist) * (1 - Math.exp(-dt * 9));
    this.trans = Math.min(1, this.trans + dt / (this.leaving ? 0.45 : 0.6));
    const t = ease(this.trans);
    const goalPos = this.v3, goalQuat = this.q;
    let goalFov = 50;
    if (this.leaving) {
      goalPos.set(p.x, p.y + 1.55, p.z);
      const e = new THREE.Euler(THREE.MathUtils.clamp(g.camPitch, -1.5, 1.5), g.camYaw, 0, 'YXZ');
      goalQuat.setFromEuler(e); goalFov = 75;
    } else {
      this.orbitPose(goalPos);
      c.position.copy(goalPos); c.lookAt(this.target); goalQuat.copy(c.quaternion);
    }
    c.position.lerpVectors(this.fromPos, goalPos, t);
    c.quaternion.slerpQuaternions(this.fromQuat, goalQuat, t);
    const fov = this.fromFov + (goalFov - this.fromFov) * t;
    if (Math.abs(c.fov - fov) > 0.01) { c.fov = fov; c.updateProjectionMatrix(); }
    c.updateMatrixWorld();
    if (this.leaving && this.trans >= 1) { this.leaving = false; this.cameraActive = false; }
    g.player.gunHolder.visible = !this.cameraActive || (this.leaving && this.trans > 0.85);
    this.marker.visible = this.cameraActive && !this.leaving;
    if (this.marker.visible) { this.marker.position.copy(p).setY(p.y + 0.05); this.marker.scale.setScalar(Math.max(1, this.dist / 45)); }
    // level slicing: hide built blocks above the working level so lower storeys can be seen and edited
    const slicing = this.open && this.levelLocked && this.slice;
    sharedUniforms.uSlice.value = slicing ? 1 : 0;
    sharedUniforms.uCutY.value = slicing ? this.level + 1 : 10000;
    sharedUniforms.uTerrainCut.value = 0;
    sharedUniforms.uCam.value.copy(c.position);
    sharedUniforms.uPlayer.value.copy(this.target);
    g.world.updateCap(slicing ? this.level + 1 : 10000, this.target.x, this.target.z);
    return this.leaving ? 36 : Math.max(36, this.dist);
  }
  private pan(dt: number): void {
    const k = this.keys;
    const f = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0);
    const r = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0);
    if (f || r) {
      const sp = (this.dist * 0.9 + 12) * dt * (k.ShiftLeft || k.ShiftRight ? 2.5 : 1);
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      this.targetGoal.x += (fx * f + -fz * r) * sp;
      this.targetGoal.z += (fz * f + fx * r) * sp;
    }
    const rot = (k.KeyE ? 1 : 0) - (k.KeyC ? 1 : 0);
    if (rot) this.yawGoal += rot * dt * 1.8;
  }
  focus(): THREE.Vector3 { return this.target; }

  // ---------------------------------------------------------------- input
  private bindInput(): void {
    const canvas = this.game.canvas;
    addEventListener('keyup', (e) => { this.keys[e.code] = false; });
    addEventListener('blur', () => { this.keys = {}; this.drag = null; this.orbitDrag = null; });
    addEventListener('mousemove', (e) => {
      if (!this.open) return;
      if (this.orbitDrag) {
        const dx = e.clientX - this.orbitDrag.x, dy = e.clientY - this.orbitDrag.y;
        this.orbitDrag.moved += Math.abs(dx) + Math.abs(dy);
        this.orbitDrag.x = e.clientX; this.orbitDrag.y = e.clientY;
        if (this.orbitDrag.button === 2) {
          this.yawGoal -= dx * 0.006;
          this.pitchGoal = THREE.MathUtils.clamp(this.pitchGoal + dy * 0.005, 0.22, 1.53);
        } else {
          const s = this.dist * 0.0021, fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
          this.targetGoal.x += (fz * dx + fx * dy) * s * 1;
          this.targetGoal.z += (-fx * dx + fz * dy) * s * 1;
        }
      }
      this.mx = e.clientX; this.my = e.clientY;
      this.overCanvas = e.target === canvas;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.open) return;
      e.preventDefault();
      if (e.button === 1 || e.button === 2) { this.orbitDrag = { x: e.clientX, y: e.clientY, moved: 0, button: e.button }; return; }
      if (e.button !== 0) return;
      this.mx = e.clientX; this.my = e.clientY;
      this.pick();
      if (this.tool === 'place') { this.placeObject(); return; }
      const start = TOOLS.find(t => t.id === this.tool)!.kind === 'build' ? this.hoverCell : this.hoverSolid;
      if (!start) { this.game.audio.deny(); return; }
      const base = this.tool === 'erase' ? (this.levelLocked ? this.level : start[1])
        : TOOLS.find(t => t.id === this.tool)!.kind === 'dig' ? (this.levelLocked ? this.level - 1 : start[1]) : start[1];
      this.drag = { start: [start[0], base, start[2]], base, button: 0 };
    });
    addEventListener('mouseup', (e) => {
      if (!this.open) return;
      if ((e.button === 1 || e.button === 2) && this.orbitDrag) {
        const quick = this.orbitDrag.moved < 6;
        this.orbitDrag = null;
        if (quick && e.button === 2 && this.drag) { this.drag = null; this.hidePreview(); this.game.audio.click(); }
        return;
      }
      if (e.button === 0 && this.drag) { this.commit(); this.drag = null; }
    });
    canvas.addEventListener('wheel', (e) => {
      if (!this.open) return;
      e.preventDefault();
      const dir = Math.sign(e.deltaY || e.deltaX);
      if (!dir) return;
      if (e.shiftKey) { this.nudgeLevel(-dir); return; }
      if (e.ctrlKey || e.metaKey) { this.setParam('height', this.height - dir); return; }
      if (e.altKey) { this.setParam('thickness', this.thickness - dir); return; }
      const before = this.distGoal;
      this.distGoal = THREE.MathUtils.clamp(this.distGoal * (dir > 0 ? 1.14 : 1 / 1.14), 8, 420);
      const f = this.distGoal / before;
      if (this.hoverPoint) {
        this.targetGoal.x += (this.hoverPoint.x - this.targetGoal.x) * (1 - f);
        this.targetGoal.z += (this.hoverPoint.z - this.targetGoal.z) * (1 - f);
      }
    }, { passive: false });
  }
  /** Keys while the planner is open. Returns true when handled. */
  onKeyDown(e: KeyboardEvent): boolean {
    const typing = e.target instanceof HTMLElement && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.isContentEditable);
    if (typing && e.code !== 'Escape') return true;
    if (typing) { (e.target as HTMLElement).blur(); return true; }
    this.keys[e.code] = true;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return true; }
    if (ctrl && e.code === 'KeyY') { e.preventDefault(); this.redo(); return true; }
    if (e.repeat && !['PageUp', 'PageDown', 'BracketLeft', 'BracketRight', 'Minus', 'Equal'].includes(e.code)) return true;
    switch (e.code) {
      case 'Escape':
        if (this.drag) { this.drag = null; this.hidePreview(); } else this.exit();
        return true;
      case 'KeyQ': this.exit(); return true;
      case 'Space': e.preventDefault(); this.timePaused = !this.timePaused; this.refresh(); return true;
      case 'KeyR': this.rotation = (this.rotation + 1) & 3; this.planKey = ''; this.refresh(); return true;
      case 'KeyZ': this.yawGoal += Math.PI / 4; return true;
      case 'KeyX': this.yawGoal -= Math.PI / 4; return true;
      case 'BracketLeft': this.setParam('height', this.height - 1); return true;
      case 'BracketRight': this.setParam('height', this.height + 1); return true;
      case 'Minus': this.setParam('thickness', this.thickness - 1); return true;
      case 'Equal': this.setParam('thickness', this.thickness + 1); return true;
      case 'PageUp': e.preventDefault(); this.nudgeLevel(1); return true;
      case 'PageDown': e.preventDefault(); this.nudgeLevel(-1); return true;
      case 'Home': this.levelLocked = false; this.planKey = ''; this.refresh(); return true;
      case 'KeyL': this.slice = !this.slice; this.refresh(); return true;
      case 'KeyF': this.foundation = !this.foundation; this.planKey = ''; this.refresh(); return true;
      case 'KeyT': this.game.startWaveEarly(); return true;
    }
    if (e.code.startsWith('Digit')) {
      const t = TOOLS.find(x => x.key === e.code.slice(5));
      if (t) this.selectTool(t.id);
      return true;
    }
    return true;
  }
  private nudgeLevel(d: number): void {
    if (!this.levelLocked) {
      this.levelLocked = true;
      this.level = this.hoverCell ? this.hoverCell[1] : Math.floor(this.target.y);
    }
    this.level = THREE.MathUtils.clamp(this.level + d, 1, this.game.world.H - 2);
    this.planKey = '';
    this.refresh();
  }
  selectTool(id: ToolId): void {
    this.tool = id; this.drag = null; this.planKey = ''; this.hidePreview();
    this.game.audio.click();
    this.refresh();
  }
  private setParam(name: 'height' | 'thickness' | 'depth' | 'eraseHeight', v: number): void {
    const max = name === 'thickness' ? 32 : name === 'depth' ? 64 : MAX_HEIGHT;
    this[name] = THREE.MathUtils.clamp(Math.round(v) || 1, 1, max);
    this.planKey = '';
    this.refresh();
  }

  // ---------------------------------------------------------------- picking
  private pick(): void {
    this.hoverCell = this.hoverSolid = null; this.hoverPoint = null;
    if (!this.overCanvas && !this.drag) return;
    const g = this.game, w = g.world;
    const ndc = new THREE.Vector2(this.mx / innerWidth * 2 - 1, -(this.my / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, g.camera);
    const o = this.raycaster.ray.origin, d = this.raycaster.ray.direction;
    if (this.drag) {
      // while dragging, the end point slides on the horizontal plane of the shape's base
      const planeY = this.drag.base + (this.toolKind() === 'build' ? 0 : 1);
      if (Math.abs(d.y) > 1e-5) {
        const t = (planeY - o.y) / d.y;
        if (t > 0) {
          const px = o.x + d.x * t, pz = o.z + d.z * t;
          this.hoverPoint = new THREE.Vector3(px, planeY, pz);
          this.hoverCell = [Math.floor(px), this.drag.base, Math.floor(pz)];
          this.hoverSolid = this.hoverCell;
        }
      }
      return;
    }
    if (this.levelLocked) {
      if (Math.abs(d.y) < 1e-5) return;
      const t = (this.level - o.y) / d.y;
      if (t <= 0) return;
      const px = o.x + d.x * t, pz = o.z + d.z * t;
      this.hoverPoint = new THREE.Vector3(px, this.level, pz);
      this.hoverCell = [Math.floor(px), this.level, Math.floor(pz)];
      this.hoverSolid = [this.hoverCell[0], this.level - 1, this.hoverCell[2]];
      return;
    }
    const hit = w.raycast(o, d, 1600);
    if (!hit.hit) return;
    this.hoverPoint = hit.point!;
    this.hoverSolid = [hit.x!, hit.y!, hit.z!];
    this.hoverCell = [hit.x! + hit.nx!, hit.y! + hit.ny!, hit.z! + hit.nz!];
  }
  private toolKind(): ToolDef['kind'] { return TOOLS.find(t => t.id === this.tool)!.kind; }

  // ---------------------------------------------------------------- plans
  private makePlan(a: Cell, b: Cell, base: number): Plan {
    const plan: Plan = { fill: [], clear: [], cut: [], flood: [], dims: '', error: '', volume: 0, note: '', base };
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), z0 = Math.min(a[2], b[2]), z1 = Math.max(a[2], b[2]);
    const W = x1 - x0 + 1, D = z1 - z0 + 1, H = this.height, T = this.thickness;
    const top = base + H - 1;
    const fill = (bx0: number, by0: number, bz0: number, bx1: number, by1: number, bz1: number) => {
      if (bx1 < bx0 || by1 < by0 || bz1 < bz0) return;
      plan.fill.push([bx0, by0, bz0, bx1, by1, bz1]);
    };
    const merlonRing = (cells: Iterable<[number, number]>, y: number) => {
      for (const [x, z] of cells) if (((x + z) & 1) === 0) fill(x, y, z, x, y, z);
    };
    if (W > MAX_SPAN || D > MAX_SPAN) { plan.error = `Keep each side within ${MAX_SPAN} blocks.`; return plan; }
    switch (this.tool) {
      case 'wall': {
        if (W === 1 || D === 1 || W <= T * 2 || D <= T * 2) {
          // a straight wall (or a footprint too small to hollow): thickness grows across the run
          let bx0 = x0, bx1 = x1, bz0 = z0, bz1 = z1;
          if (D === 1 && W > 1) { bz0 = z0 - Math.floor((T - 1) / 2); bz1 = bz0 + T - 1; }
          else if (W === 1 && D > 1) { bx0 = x0 - Math.floor((T - 1) / 2); bx1 = bx0 + T - 1; }
          fill(bx0, base, bz0, bx1, top, bz1);
          if (this.battlements) {
            const ring: [number, number][] = [];
            if (bz1 - bz0 >= bx1 - bx0) for (let z = bz0; z <= bz1; z++) { ring.push([bx0, z]); if (bx1 !== bx0) ring.push([bx1, z]); }
            else for (let x = bx0; x <= bx1; x++) { ring.push([x, bz0]); if (bz1 !== bz0) ring.push([x, bz1]); }
            merlonRing(ring, top + 1);
          }
          plan.dims = `${bx1 - bx0 + 1} × ${bz1 - bz0 + 1} × ${H}`;
        } else {
          fill(x0, base, z0, x1, top, z0 + T - 1);
          fill(x0, base, z1 - T + 1, x1, top, z1);
          fill(x0, base, z0 + T, x0 + T - 1, top, z1 - T);
          fill(x1 - T + 1, base, z0 + T, x1, top, z1 - T);
          if (this.battlements) merlonRing(this.perimeter(x0, z0, x1, z1), top + 1);
          plan.dims = `${W} × ${D} × ${H} · walls ${T} thick`;
        }
        break;
      }
      case 'line': {
        const ax = a[0] + 0.5, az = a[2] + 0.5, bx = b[0] + 0.5, bz = b[2] + 0.5;
        const len = Math.hypot(bx - ax, bz - az), R = T / 2 + 0.25;
        const pad = Math.ceil(R);
        const cols: [number, number][] = [], edge: [number, number][] = [];
        for (let z = z0 - pad; z <= z1 + pad; z++) for (let x = x0 - pad; x <= x1 + pad; x++) {
          const px = x + 0.5, pz = z + 0.5;
          let t = len > 0 ? ((px - ax) * (bx - ax) + (pz - az) * (bz - az)) / (len * len) : 0;
          t = Math.max(0, Math.min(1, t));
          const dd = Math.hypot(px - (ax + (bx - ax) * t), pz - (az + (bz - az) * t));
          if (dd <= R) { cols.push([x, z]); if (dd > R - 1) edge.push([x, z]); }
        }
        if (cols.length > 200_000) { plan.error = 'That line is too long.'; return plan; }
        this.columns(cols, base, top, plan.fill);
        if (this.battlements) merlonRing(edge, top + 1);
        plan.dims = `${Math.round(len) + 1} long × ${H} high · ${T} thick`;
        break;
      }
      case 'box':
        fill(x0, base, z0, x1, top, z1);
        plan.dims = `${W} × ${D} × ${H}`;
        break;
      case 'room': {
        const RH = Math.max(3, H);
        if (W < 3 || D < 3) { plan.error = 'Rooms need at least 3 × 3.'; plan.dims = `${W} × ${D}`; return plan; }
        const wt = Math.min(T, Math.floor((Math.min(W, D) - 1) / 2));
        fill(x0, base, z0, x1, base, z1); // floor
        const wy0 = base + 1, wy1 = base + RH - 1;
        // the door goes in the side facing the camera
        const cx = (x0 + x1 + 1) / 2, cz = (z0 + z1 + 1) / 2, cam = this.game.camera.position;
        const vx = cam.x - cx, vz = cam.z - cz;
        const side = Math.abs(vx) / W > Math.abs(vz) / D ? (vx > 0 ? 'E' : 'W') : (vz > 0 ? 'S' : 'N');
        const doorH = Math.min(3, RH - 2 >= 1 ? RH - 2 : 1), door = this.door && RH >= 3;
        const along = (s: string) => s === 'N' || s === 'S';
        const sideBox = (s: string): Box => s === 'N' ? [x0, wy0, z0, x1, wy1, z0 + wt - 1] : s === 'S' ? [x0, wy0, z1 - wt + 1, x1, wy1, z1]
          : s === 'W' ? [x0, wy0, z0 + wt, x0 + wt - 1, wy1, z1 - wt] : [x1 - wt + 1, wy0, z0 + wt, x1, wy1, z1 - wt];
        for (const s of ['N', 'S', 'W', 'E']) {
          const bx = sideBox(s);
          if (!(door && s === side)) { fill(...bx); continue; }
          // split this side around a 2-wide doorway (1-wide when the side is short) and add a lintel
          const run0 = along(s) ? bx[0] : bx[2], run1 = along(s) ? bx[3] : bx[5];
          const mid = Math.floor((run0 + run1) / 2), dw = run1 - run0 + 1 >= 6 ? 2 : 1;
          const d0 = mid - (dw - 1), d1 = mid;
          const part = (r0: number, r1: number, y0: number, y1: number) => along(s) ? fill(r0, y0, bx[2], r1, y1, bx[5]) : fill(bx[0], y0, r0, bx[3], y1, r1);
          part(run0, d0 - 1, wy0, wy1); part(d1 + 1, run1, wy0, wy1); part(d0, d1, wy0 + doorH, wy1);
        }
        if (this.roof) {
          fill(x0, base + RH, z0, x1, base + RH, z1);
          if (this.battlements) merlonRing(this.perimeter(x0, z0, x1, z1), base + RH + 1);
          // roofs only reach `span` blocks from a support: stand pillars on a lattice that keeps every
          // roof cell within reach (a perfect Lee-sphere tiling: 1 pillar per 2r² + 2r + 1 cells)
          const span = BLOCKS[this.material.block].span, ix0 = x0 + wt, ix1 = x1 - wt, iz0 = z0 + wt, iz1 = z1 - wt;
          const needs = Math.min(ix1 - ix0 + 1, iz1 - iz0 + 1) > span * 2;
          if (this.pillars && needs) {
            const m = 2 * span * span + 2 * span + 1;
            for (let z = iz0; z <= iz1; z++) for (let x = ix0; x <= ix1; x++) {
              if ((((x + (2 * span + 1) * z) % m) + m) % m !== 0) continue;
              if (Math.abs(x - Math.floor((x0 + x1) / 2)) <= 1 && (z - iz0 <= 1 || iz1 - z <= 1)) continue; // keep doorways clear
              if (Math.abs(z - Math.floor((z0 + z1) / 2)) <= 1 && (x - ix0 <= 1 || ix1 - x <= 1)) continue;
              fill(x, wy0, z, x, wy1, z);
            }
          } else if (needs) plan.note = `Roof spans over ${span * 2} need pillars or they sag and fall.`;
        } else if (this.battlements) merlonRing(this.perimeter(x0, z0, x1, z1), base + RH);
        plan.dims = `${W} × ${D} × ${RH}${this.roof ? ' + roof' : ''}`;
        break;
      }
      case 'tower': {
        const r = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[2] - a[2])));
        if (r > 96) { plan.error = 'Tower radius is limited to 96.'; return plan; }
        const ring: [number, number][] = [], edge: [number, number][] = [];
        for (let z = a[2] - r; z <= a[2] + r; z++) for (let x = a[0] - r; x <= a[0] + r; x++) {
          const dd = Math.hypot(x - a[0], z - a[2]);
          if (dd > r + 0.5) continue;
          if (this.hollow && dd <= r + 0.5 - T) continue;
          ring.push([x, z]); if (dd > r - 0.5) edge.push([x, z]);
        }
        this.columns(ring, base, top, plan.fill);
        if (this.hollow && r - T <= BLOCKS[this.material.block].span * 2) {
          // a floor at the top of a hollow tower so it can be manned
          const inner: [number, number][] = [];
          for (let z = a[2] - r; z <= a[2] + r; z++) for (let x = a[0] - r; x <= a[0] + r; x++) if (Math.hypot(x - a[0], z - a[2]) <= r + 0.5 - T) inner.push([x, z]);
          this.columns(inner, top, top, plan.fill);
        }
        if (this.battlements) merlonRing(edge, top + 1);
        plan.dims = `radius ${r} (${r * 2 + 1} across) × ${H}`;
        break;
      }
      case 'stairs': {
        const alongX = Math.abs(b[0] - a[0]) >= Math.abs(b[2] - a[2]);
        const len = (alongX ? W : D), sign = (alongX ? b[0] - a[0] : b[2] - a[2]) >= 0 ? 1 : -1;
        const start = alongX ? a[0] : a[2];
        const rise = Math.min(H, len);
        for (let i = 0; i < len; i++) {
          const yTop = base + Math.min(i, H - 1), at = start + i * sign;
          if (alongX) fill(at, base, z0, at, yTop, z1); else fill(x0, base, at, x1, yTop, at);
        }
        plan.dims = `${len} run × ${alongX ? D : W} wide · rises ${rise}`;
        break;
      }
      case 'dig': case 'moat': {
        const yb = Math.max(1, base - this.depth + 1), yt = base, hill = Math.min(this.game.world.H - 1, base + 40);
        const rects: Box[] = [];
        if (this.tool === 'dig' || W <= T * 2 || D <= T * 2) rects.push([x0, yb, z0, x1, yt, z1]);
        else {
          rects.push([x0, yb, z0, x1, yt, z0 + T - 1], [x0, yb, z1 - T + 1, x1, yt, z1]);
          rects.push([x0, yb, z0 + T, x0 + T - 1, yt, z1 - T], [x1 - T + 1, yb, z0 + T, x1, yt, z1 - T]);
        }
        plan.clear.push(...rects);
        for (const r of rects) plan.cut.push([r[0], base + 1, r[2], r[3], hill, r[5]]);
        if ((this.tool === 'moat' ? this.flood : this.floodDig) && base - 1 >= yb) {
          for (const r of rects) plan.flood.push([r[0], yb, r[2], r[3], base - 1, r[5]]);
        }
        plan.dims = this.tool === 'dig' ? `${W} × ${D} · ${this.depth} deep` : `${W} × ${D} · ${T} wide · ${this.depth} deep`;
        break;
      }
      case 'erase':
        plan.clear.push([x0, base, z0, x1, Math.min(this.game.world.H - 1, base + this.eraseHeight - 1), z1]);
        plan.dims = `${W} × ${D} · ${this.eraseHeight} up`;
        break;
    }
    if (this.foundation && this.toolKind() === 'build') this.addFoundation(plan, base);
    plan.volume = [...plan.fill, ...plan.clear, ...plan.cut].reduce((n, b) => n + boxVolume(b), 0);
    const w = this.game.world;
    for (const b of [...plan.fill, ...plan.clear]) {
      if (b[1] < 1 && plan.clear.includes(b) === false) { plan.error = 'Cannot build below the bedrock.'; break; }
      if (b[4] >= w.H) { plan.error = 'Too tall: that would poke out of the world.'; break; }
      if (b[0] < 0 || b[2] < 0 || b[3] >= w.W || b[5] >= w.D) { plan.error = 'Outside the world.'; break; }
    }
    if (!plan.error && plan.volume > MAX_CELLS * (plan.clear.length ? 4 : 1)) plan.error = `Too big for one operation (over ${fmt(plan.clear.length ? MAX_CELLS * 4 : MAX_CELLS)} blocks): split it up.`;
    if (!plan.error && !this.loaded(plan)) plan.error = 'Part of that area is still loading.';
    return plan;
  }
  floodDig = false;
  private perimeter(x0: number, z0: number, x1: number, z1: number): [number, number][] {
    const out: [number, number][] = [];
    for (let x = x0; x <= x1; x++) { out.push([x, z0]); if (z1 !== z0) out.push([x, z1]); }
    for (let z = z0 + 1; z < z1; z++) { out.push([x0, z]); if (x1 !== x0) out.push([x1, z]); }
    return out;
  }
  /** columns (x, z) from y0 to y1, merged into x-runs */
  private columns(cols: [number, number][], y0: number, y1: number, out: Box[]): void {
    cols.sort((p, q) => p[1] - q[1] || p[0] - q[0]);
    for (let i = 0; i < cols.length;) {
      const [sx, z] = cols[i]; let ex = sx; i++;
      while (i < cols.length && cols[i][1] === z && cols[i][0] === ex + 1) { ex++; i++; }
      out.push([sx, y0, z, ex, y1, z]);
    }
  }
  /** extend every column standing on the base down to solid ground, so walls follow uneven terrain */
  private addFoundation(plan: Plan, base: number): void {
    const w = this.game.world, seen = new Set<number>(), extra: Box[] = [];
    let columns = 0;
    for (const b of plan.fill) {
      if (b[1] !== base) continue;
      columns += (b[3] - b[0] + 1) * (b[5] - b[2] + 1);
      if (columns > FOUNDATION_COLUMNS) { plan.note = 'Footprint too large for automatic foundations.'; return; }
      for (let z = b[2]; z <= b[5]; z++) {
        let runStart = -1, runDepth = 0;
        const flush = (endX: number) => { if (runStart >= 0 && runDepth > 0) extra.push([runStart, base - runDepth, z, endX, base - 1, z]); };
        for (let x = b[0]; x <= b[3]; x++) {
          const key = x * 8192 + z;
          let depth = 0;
          if (!seen.has(key)) {
            seen.add(key);
            while (depth < FOUNDATION_DEPTH && base - depth - 1 >= 1 && !w.solid(x, base - depth - 1, z)) depth++;
            if (depth === FOUNDATION_DEPTH) depth = 0; // a cliff edge or a hole: don't build a 48-block stilt
          }
          if (depth !== runDepth || runStart < 0) { flush(x - 1); runStart = x; runDepth = depth; }
        }
        flush(b[3]);
      }
    }
    plan.fill.push(...extra);
  }
  private loaded(plan: Plan): boolean {
    const w = this.game.world;
    for (const b of [...plan.fill, ...plan.clear]) {
      for (let cz = b[2] >> 5; cz <= b[5] >> 5; cz++) for (let cx = b[0] >> 5; cx <= b[3] >> 5; cx++) {
        if (!w.isGenerated(cx * 32, cz * 32)) return false;
      }
    }
    return true;
  }
  /** exact counts of blocks to add and remove (estimated for huge erase volumes while dragging) */
  private count(plan: Plan, exact: boolean): void {
    const w = this.game.world;
    let add = 0, remove = 0;
    for (const b of plan.fill) for (let y = b[1]; y <= b[4]; y++) for (let z = b[2]; z <= b[5]; z++) for (let x = b[0]; x <= b[3]; x++) if (!w.occ(x, y, z)) add++;
    const clearVol = [...plan.clear, ...plan.cut].reduce((n, b) => n + boxVolume(b), 0);
    if (clearVol <= COUNT_LIMIT || exact) {
      for (const b of plan.clear) for (let y = b[1]; y <= b[4]; y++) for (let z = b[2]; z <= b[5]; z++) for (let x = b[0]; x <= b[3]; x++) {
        const t = w.get(x, y, z);
        if (t !== B.AIR && this.removable(t, y, this.tool === 'erase')) remove++;
      }
      for (const b of plan.cut) for (let y = b[1]; y <= b[4]; y++) for (let z = b[2]; z <= b[5]; z++) for (let x = b[0]; x <= b[3]; x++) {
        const t = w.get(x, y, z);
        if (t !== B.AIR && natural(t) && this.removable(t, y, false)) remove++;
      }
      this.counts = { add, remove, exact: true };
    } else this.counts = { add, remove: clearVol, exact: false };
  }
  private removable(t: number, y: number, builtOnlyTool: boolean): boolean {
    if (y <= 0) return false;
    const def = BLOCKS[t];
    if (!def || def.hp === Infinity) return false;
    return !(builtOnlyTool && this.builtOnly && def.anchored);
  }

  // ---------------------------------------------------------------- per frame
  update(rdt: number): void {
    this.runJobs();
    if (!this.open) return;
    const g = this.game;
    if (g.player.dead || g.paused) { this.exit(false); return; }
    this.pick();
    let key = '';
    let a: Cell | null = null, b: Cell | null = null, base = 0;
    if (this.drag && this.hoverCell) { a = this.drag.start; b = [this.hoverCell[0], this.drag.base, this.hoverCell[2]]; base = this.drag.base; }
    if (this.tool !== 'place' && a && b) {
      key = [this.tool, a, b, base, this.height, this.thickness, this.depth, this.eraseHeight, this.battlements, this.foundation, this.roof, this.door, this.pillars, this.hollow, this.flood, this.floodDig, this.builtOnly, this.material.id,
        this.tool === 'room' ? Math.round(Math.atan2(g.camera.position.x - (a[0] + b[0]) / 2, g.camera.position.z - (a[2] + b[2]) / 2) / (Math.PI / 2)) : 0].join('|');
      if (key !== this.planKey) {
        this.planKey = key;
        this.plan = this.makePlan(a, b, base);
        if (!this.plan.error) this.count(this.plan, false);
        this.showPlan(this.plan);
      }
    } else if (this.plan) { this.plan = null; this.planKey = ''; this.hidePreview(); }
    this.updateCursor();
    this.updateTip();
    if (rdt > 0) this.refreshStatus();
  }
  private updateCursor(): void {
    const g = this.game;
    g.rangeRing.visible = g.minRangeRing.visible = false;
    this.planeMesh.visible = this.levelLocked && !!this.hoverPoint;
    if (this.planeMesh.visible) {
      const r = Math.max(24, this.dist * 0.7);
      this.planeMesh.position.set(this.hoverPoint!.x, this.level + 0.002, this.hoverPoint!.z);
      this.planeMesh.scale.set(r * 2, 1, r * 2);
      const u = (this.planeMesh.material as THREE.ShaderMaterial).uniforms;
      u.uCenter.value.copy(this.hoverPoint!); u.uRadius.value = r;
    }
    if (this.drag || !this.hoverCell) { this.cursorMesh.visible = false; return; }
    const kind = this.toolKind();
    const c = kind === 'build' ? this.hoverCell : this.hoverSolid!;
    let w = 1, h = 1, d = 1, ok = true;
    if (this.tool === 'place') {
      const r = this.placeFootprint(); w = r[0]; d = r[1]; h = r[2];
      const reason = this.placeReason(this.hoverCell);
      ok = !reason;
      const spec = this.placeId in DEFENSES ? getDefense(this.placeId) : null;
      if (spec) {
        g.rangeRing.position.set(c[0] + w / 2, c[1] + 0.08, c[2] + d / 2); g.rangeRing.scale.setScalar(spec.range); g.rangeRing.visible = true;
        g.minRangeRing.position.copy(g.rangeRing.position); g.minRangeRing.scale.setScalar(spec.minRange); g.minRangeRing.visible = spec.minRange > 0;
      }
    }
    const mat = this.cursorMesh.material as THREE.ShaderMaterial;
    mat.uniforms.uColor.value.setHex(kind === 'build' || kind === 'place' ? (ok ? 0x9cffc0 : 0xff6a5a) : 0xffa060);
    mat.uniforms.uOpacity.value = kind === 'place' ? 0.35 : 0.18;
    this.cursorMesh.position.set(c[0] + w / 2, c[1] + h / 2, c[2] + d / 2);
    this.cursorMesh.scale.set(w + 0.04, h + 0.04, d + 0.04);
    this.cursorMesh.visible = true;
  }
  private showPlan(plan: Plan): void {
    const valid = !plan.error && this.affordable() === '';
    (this.fillMat.uniforms.uColor.value as THREE.Color).setHex(valid ? 0x6ce1a0 : 0xff5555);
    (this.clearMat.uniforms.uColor.value as THREE.Color).setHex(plan.error ? 0xff2020 : 0xff8a4a);
    this.setBoxes(this.fillMesh, plan.fill, 0.02);
    this.setBoxes(this.clearMesh, plan.clear, 0.03);
    this.setBoxes(this.floodMesh, plan.flood, -0.08);
  }
  private setBoxes(mesh: THREE.InstancedMesh, boxes: Box[], grow: number): THREE.InstancedMesh {
    let m = mesh;
    if (boxes.length > m.instanceMatrix.count) {
      let cap = m.instanceMatrix.count;
      while (cap < boxes.length) cap *= 2;
      const next = new THREE.InstancedMesh(m.geometry, m.material, cap);
      next.frustumCulled = false; next.renderOrder = m.renderOrder;
      this.game.scene.remove(m); this.game.scene.add(next); m.dispose();
      if (m === this.fillMesh) this.fillMesh = next; else if (m === this.clearMesh) this.clearMesh = next; else this.floodMesh = next;
      m = next;
    }
    boxes.forEach((b, i) => {
      this.v3.set((b[0] + b[3] + 1) / 2, (b[1] + b[4] + 1) / 2, (b[2] + b[5] + 1) / 2);
      this.s3.set(b[3] - b[0] + 1 + grow, b[4] - b[1] + 1 + grow, b[5] - b[2] + 1 + grow);
      this.m4.compose(this.v3, this.q.identity(), this.s3);
      m.setMatrixAt(i, this.m4);
    });
    m.count = boxes.length; m.instanceMatrix.needsUpdate = true; m.visible = boxes.length > 0;
    return m;
  }
  private hidePreview(): void {
    this.fillMesh.visible = this.clearMesh.visible = this.floodMesh.visible = false;
    this.cursorMesh.visible = false; this.planeMesh.visible = false;
    this.plan = null; this.planKey = '';
    this.game.rangeRing.visible = this.game.minRangeRing.visible = false;
  }
  private free(): boolean { return this.game.sandbox || this.game.freeBuild; }
  private affordable(): string {
    if (this.free() || !this.plan || !this.plan.fill.length) return '';
    const have = this.game.inv[this.material.cost] | 0;
    return have < this.counts.add ? `Need ${fmt(this.counts.add)} ${this.material.cost}; you have ${fmt(have)}.` : '';
  }

  // ---------------------------------------------------------------- commit
  private commit(): void {
    const plan = this.plan, g = this.game;
    if (!plan) return;
    if (plan.error) { g.audio.deny(); g.ui.toast(plan.error, 'bad'); this.hidePreview(); return; }
    if (!this.counts.exact) this.count(plan, true);
    const short = this.affordable();
    if (short) { g.audio.deny(); g.ui.toast(short, 'bad'); this.hidePreview(); return; }
    if (!plan.fill.length && !plan.clear.length) { this.hidePreview(); return; }
    const label = `${TOOLS.find(t => t.id === this.tool)!.name} ${plan.dims}`;
    if (plan.clear.length) {
      const cells = this.expand([...plan.clear, ...plan.cut], true);
      this.queue({ label, mode: 'clear', cells, block: B.AIR, naturalAbove: plan.cut.length ? plan.base : Infinity, builtOnly: this.tool === 'erase' && this.builtOnly, flood: plan.flood.length ? this.expand(plan.flood, false) : null });
    }
    if (plan.fill.length) {
      const cells = this.expand(plan.fill, false);
      const paid = this.free() ? 0 : this.counts.add;
      if (paid) g.inv[this.material.cost] -= paid;
      this.queue({ label, mode: 'fill', cells, block: this.material.block, builtOnly: false, flood: null, paidKey: this.material.cost, paid });
    }
    g.audio.place();
    this.hidePreview();
  }
  /** cells of boxes as xyz triples, bottom-up (top-down for removals) */
  private expand(boxes: Box[], topDown: boolean): Int32Array {
    let n = 0;
    for (const b of boxes) n += boxVolume(b);
    const out = new Int32Array(n * 3);
    let minY = Infinity, maxY = -Infinity;
    for (const b of boxes) { minY = Math.min(minY, b[1]); maxY = Math.max(maxY, b[4]); }
    let k = 0;
    for (let i = 0; i <= maxY - minY; i++) {
      const y = topDown ? maxY - i : minY + i;
      for (const b of boxes) {
        if (y < b[1] || y > b[4]) continue;
        for (let z = b[2]; z <= b[5]; z++) for (let x = b[0]; x <= b[3]; x++) { out[k++] = x; out[k++] = y; out[k++] = z; }
      }
    }
    return out;
  }
  private queue(j: { label: string; mode: Job['mode']; cells: Int32Array; block: number; builtOnly: boolean; flood: Int32Array | null; values?: Uint8Array; record?: Job['record']; op?: Op; paidKey?: string; paid?: number; naturalAbove?: number }): void {
    this.jobs.push({
      label: j.label, mode: j.mode, cells: j.cells, n: j.cells.length / 3, i: 0, block: j.block, values: j.values ?? null, builtOnly: j.builtOnly,
      flood: j.flood, record: j.record ?? 'new', op: j.op, naturalAbove: j.naturalAbove ?? Infinity, appliedCells: [], appliedPrev: [], appliedNext: [],
      paidKey: j.paidKey ?? '', paid: j.paid ?? 0, refunds: {},
    });
  }
  private refreshOccupied(): void {
    const g = this.game, occ = this.occupied;
    occ.clear();
    const add = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) for (let z = Math.floor(z0); z < Math.ceil(z1); z++) for (let x = Math.floor(x0); x < Math.ceil(x1); x++) occ.add((x * 8192 + z) * 512 + y);
    };
    const ents = [g.player, ...g.entities.enemies, ...g.foraging.wildlife];
    for (const e of ents) if (e && !e.dead) add(e.pos.x - e.r, e.pos.y, e.pos.z - e.r, e.pos.x + e.r, e.pos.y + e.h, e.pos.z + e.r);
    for (const t of g.entities.turrets) {
      if (t.dead) continue;
      const [w, d] = footprintSize(t.defenseId, t.rotation);
      add(t.pos.x - w / 2, t.pos.y, t.pos.z - d / 2, t.pos.x + w / 2, t.pos.y + t.h, t.pos.z + d / 2);
    }
    for (const t of g.traps.traps) occ.add((t.x * 8192 + t.z) * 512 + t.y);
  }
  private runJobs(): void {
    const job = this.jobs[0];
    if (!job) return;
    const g = this.game, w = g.world, t0 = performance.now();
    this.refreshOccupied();
    const c = job.cells;
    while (job.i < job.n) {
      if ((job.i & 255) === 0 && performance.now() - t0 > 7) break;
      const i = job.i++, x = c[i * 3], y = c[i * 3 + 1], z = c[i * 3 + 2];
      const cur = w.get(x, y, z);
      let next: number;
      if (job.mode === 'fill') {
        if (cur !== B.AIR) continue;
        if (this.occupied.has((x * 8192 + z) * 512 + y)) continue;
        next = job.block;
      } else if (job.mode === 'clear') {
        if (cur === B.AIR || !this.removable(cur, y, job.builtOnly)) continue;
        if (y > job.naturalAbove && !natural(cur)) continue;
        next = B.AIR;
        if (!this.free() && REFUND[cur]) job.refunds[REFUND[cur]] = (job.refunds[REFUND[cur]] | 0) + 1;
      } else {
        next = job.values![i];
        if (cur === next) continue;
        if (next !== B.AIR && this.occupied.has((x * 8192 + z) * 512 + y)) continue;
      }
      if (!w.chunkAt(x, y, z)) continue;
      w.set(x, y, z, next);
      if (next === B.AIR) { g.construction.onBlockRemoved(x, y, z); g.traps.onBlockRemoved(x, y, z); }
      job.appliedCells.push(x, y, z); job.appliedPrev.push(cur); job.appliedNext.push(next);
    }
    if (job.i < job.n) return;
    this.jobs.shift();
    this.finish(job);
  }
  private finish(job: Job): void {
    const g = this.game, w = g.world, n = job.appliedPrev.length;
    // water for flooded trenches
    if (job.flood) {
      const f = job.flood;
      for (let i = 0; i < f.length; i += 3) if (w.get(f[i], f[i + 1], f[i + 2]) === B.AIR) g.waterSim.fill(f[i], f[i + 1], f[i + 2]);
    }
    // structural check: only cells that can actually hang (no block under them) or that lost a neighbour
    const seeds: number[][] = [], cells = job.appliedCells, stride = Math.max(1, Math.ceil(n / 4000));
    for (let i = 0; i < n; i += stride) {
      const x = cells[i * 3], y = cells[i * 3 + 1], z = cells[i * 3 + 2];
      if (job.appliedNext[i] !== B.AIR ? !w.solid(x, y - 1, z) : true) seeds.push([x, y, z]);
    }
    if (seeds.length) g.checkSupport(seeds);
    // inventory
    const spent: Record<string, number> = {};
    if (job.record === 'new') {
      if (job.paidKey) {
        const placed = job.appliedNext.reduce((s, v) => s + (v !== B.AIR ? 1 : 0), 0);
        const refund = job.paid - Math.min(job.paid, placed);
        if (refund) g.inv[job.paidKey] += refund;
        if (job.paid) spent[job.paidKey] = job.paid - refund;
      }
      for (const [k, v] of Object.entries(job.refunds)) { g.inv[k] = (g.inv[k] | 0) + v; spent[k] = (spent[k] | 0) - v; }
    }
    if (n) {
      const op: Op = job.op ?? { label: job.label, cells: Int32Array.from(cells), prev: Uint8Array.from(job.appliedPrev), next: Uint8Array.from(job.appliedNext), spent };
      if (job.record === 'new') { this.undoStack.push(op); this.redoStack = []; this.trimHistory(); }
      else if (job.record === 'undo') this.redoStack.push(op);
      else this.undoStack.push(op);
    }
    if (job.record === 'new' && n) g.ui.toast(`${job.label}: ${fmt(n)} blocks ${job.mode === 'clear' ? 'removed' : 'placed'}`, 'good');
    if (job.record === 'new' && !n && !job.flood) g.ui.toast('Nothing to change there', 'bad');
    this.refresh();
  }
  private trimHistory(): void {
    let bytes = 0;
    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      bytes += this.undoStack[i].cells.byteLength + this.undoStack[i].prev.byteLength * 2;
      if (bytes > UNDO_BUDGET || this.undoStack.length - i > 60) { this.undoStack.splice(0, i + 1); break; }
    }
  }
  undo(): void {
    const g = this.game;
    if (this.jobs.length) { g.ui.toast('Wait for the current build to finish'); return; }
    const op = this.undoStack.pop();
    if (!op) { g.audio.deny(); g.ui.toast('Nothing to undo'); return; }
    // undoing an erase puts refunded blocks back, so they must be paid for again
    for (const [k, v] of Object.entries(op.spent)) if (v < 0 && (g.inv[k] | 0) < -v) { this.undoStack.push(op); g.audio.deny(); g.ui.toast(`Need ${-v} ${k} to undo that`, 'bad'); return; }
    for (const [k, v] of Object.entries(op.spent)) g.inv[k] = (g.inv[k] | 0) + v;
    const n = op.prev.length, cells = new Int32Array(n * 3), values = new Uint8Array(n);
    for (let i = 0; i < n; i++) { const j = n - 1 - i; cells.set(op.cells.subarray(j * 3, j * 3 + 3), i * 3); values[i] = op.prev[j]; }
    this.queue({ label: `Undo ${op.label}`, mode: 'restore', cells, values, block: 0, builtOnly: false, flood: null, record: 'undo', op });
    g.ui.toast(`Undo: ${op.label}`); g.audio.click();
  }
  redo(): void {
    const g = this.game;
    if (this.jobs.length) { g.ui.toast('Wait for the current build to finish'); return; }
    const op = this.redoStack.pop();
    if (!op) { g.audio.deny(); g.ui.toast('Nothing to redo'); return; }
    for (const [k, v] of Object.entries(op.spent)) if (v > 0 && (g.inv[k] | 0) < v) { this.redoStack.push(op); g.audio.deny(); g.ui.toast(`Need ${v} ${k} to redo that`, 'bad'); return; }
    for (const [k, v] of Object.entries(op.spent)) g.inv[k] = (g.inv[k] | 0) - v;
    this.queue({ label: `Redo ${op.label}`, mode: 'restore', cells: op.cells, values: op.next, block: 0, builtOnly: false, flood: null, record: 'redo', op });
    g.ui.toast(`Redo: ${op.label}`); g.audio.click();
  }
  get busy(): boolean { return this.jobs.length > 0; }

  // ---------------------------------------------------------------- defenses & objects
  private placeFootprint(): [number, number, number] {
    if (this.placeId in DEFENSES) { const [w, d] = footprintSize(this.placeId, this.rotation); return [w, d, Math.ceil(getDefense(this.placeId).height)]; }
    if (this.placeId === 'drawbridge') { const along = this.bridgeDir(); return along[0] ? [3, 2, 1] : [2, 3, 1]; }
    return [1, 1, 1];
  }
  private bridgeDir(): [number, number] { return ([[0, 1], [1, 0], [0, -1], [-1, 0]] as [number, number][])[this.rotation]; }
  private bridgeCells(c: Cell): Cell[] {
    const [dx, dz] = this.bridgeDir(), sx = dz !== 0 ? 1 : 0, sz = dx !== 0 ? 1 : 0;
    // cells are listed span-first per side; the first cell of each side is the hinge (see Construction.interact)
    const ox = dx < 0 ? 2 : 0, oz = dz < 0 ? 2 : 0;
    const out: Cell[] = [];
    for (let s = 0; s < 2; s++) for (let i = 0; i < 3; i++) out.push([c[0] + ox + dx * i + sx * s, c[1], c[2] + oz + dz * i + sz * s]);
    return out;
  }
  private placeReason(c: Cell): string {
    const g = this.game, id = this.placeId, w = g.world;
    if (id in DEFENSES) {
      const spec = getDefense(id);
      return validateDefensePlacement(g, id as DefenseId, this.rotation, c[0], c[1], c[2]) || (!g.sandbox && (g.inv[spec.inventoryKey] | 0) <= 0 ? `No ${spec.name} owned · craft one at a workbench` : '');
    }
    if (id in TRAPS) {
      const spec = TRAPS[id as TrapId];
      return g.traps.validate(id as TrapId, this.rotation, c[0], c[1], c[2]) || (!g.sandbox && (g.inv[spec.inventoryKey] | 0) <= 0 ? `No ${spec.name} owned · craft one at a workbench` : '');
    }
    const cells = id === 'drawbridge' ? this.bridgeCells(c) : [c];
    for (const [x, y, z] of cells) {
      if (!w.inBounds(x, y, z) || !w.chunkAt(x, y, z)) return 'Outside the loaded world';
      if (w.solid(x, y, z) || g.entities.blocksCell(x, y, z)) return 'Space is occupied';
    }
    if (id === 'workbench' && !w.solid(c[0], c[1] - 1, c[2])) return 'Needs solid ground';
    if (id === 'drawbridge' && !cells.slice(0, 1).concat(cells.slice(3, 4)).every(([x, y, z]) => w.solid(x, y - 1, z) || w.solid(x - this.bridgeDir()[0], y, z - this.bridgeDir()[1]))) return 'The hinge end needs a bank to rest on';
    if (!this.free() && (g.inv.planks | 0) < cells.length) return `Need ${cells.length} planks`;
    return '';
  }
  private placeObject(): void {
    const g = this.game, c = this.hoverCell, id = this.placeId;
    if (!c) { g.audio.deny(); return; }
    const reason = this.placeReason(c);
    if (reason) { g.audio.deny(); g.ui.toast(reason, 'bad'); return; }
    if (id in DEFENSES) {
      const [w, d] = footprintSize(id, this.rotation), spec = getDefense(id);
      g.entities.turrets.push(new Turret(g, c[0] + w / 2, c[1] + 0.01, c[2] + d / 2, id as DefenseId, this.rotation));
      if (!g.sandbox) g.inv[spec.inventoryKey]--;
      g.ui.toast(`${spec.name} deployed`, 'good');
    } else if (id in TRAPS) {
      if (!g.traps.place(id as TrapId, this.rotation, c[0], c[1], c[2])) { g.audio.deny(); return; }
      g.ui.toast(`${TRAPS[id as TrapId].name} placed`, 'good');
    } else {
      const cells = id === 'drawbridge' ? this.bridgeCells(c) : [c];
      for (const [x, y, z] of cells) g.world.set(x, y, z, B.PLANKS);
      if (!this.free()) g.inv.planks -= cells.length;
      if (id === 'workbench') g.construction.registerBench(c, B.PLANKS);
      else g.construction.registerBridge(cells, B.PLANKS);
      g.checkSupport(cells);
      g.ui.toast(id === 'workbench' ? 'Workbench placed · press E beside it to craft' : 'Drawbridge built · press E beside it to raise or lower', 'good');
    }
    g.audio.place();
    g.particles.dust(c[0] + 0.5, c[1], c[2] + 0.5, 6);
    this.refresh();
  }

  // ---------------------------------------------------------------- DOM
  private buildDom(): void {
    const root = this.root = document.createElement('div');
    root.id = 'arch'; root.className = 'hidden';
    root.innerHTML = `
      <div id="arch-top" class="box"><b>ARCHITECT</b><span id="arch-status"></span>
        <button type="button" data-act="time" title="Space">Pause</button>
        <button type="button" data-act="undo" title="Ctrl+Z">Undo</button>
        <button type="button" data-act="redo" title="Ctrl+Y">Redo</button>
        <label title="Build without spending blocks"><input type="checkbox" data-act="free"> Free build</label>
        <button type="button" data-act="exit" class="primary" title="Q or Esc">Done · Q</button></div>
      <div id="arch-tools" class="box"></div>
      <div id="arch-opts" class="box"></div>
      <div id="arch-keys" class="box"><b>Camera</b> WASD pan · wheel zoom · right-drag orbit · middle-drag pan · Z/X turn 45°<br><b>Build</b> drag to draw · right-click cancels · [ ] height · − = thickness · Shift+wheel or PgUp/PgDn level · Home ground level · L slice · F foundations · Ctrl+Z undo · Space pause</div>`;
    document.body.appendChild(root);
    this.tip = document.createElement('div'); this.tip.id = 'arch-tip'; this.tip.className = 'hidden';
    document.body.appendChild(this.tip);
    this.toolsEl = root.querySelector('#arch-tools')!;
    this.toolsEl.innerHTML = TOOLS.map(t => `<button type="button" data-tool="${t.id}" title="${t.tip}"><svg viewBox="0 0 24 24" width="26" height="26">${SVG[t.id]}</svg><span>${t.name}</span><i>${t.key}</i></button>`).join('');
    this.opts = root.querySelector('#arch-opts')!;
    this.status = root.querySelector('#arch-status')!;
    root.addEventListener('mousedown', e => e.stopPropagation());
    root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tool],[data-act],[data-mat],[data-step],[data-toggle],[data-place]');
      if (!el) return;
      if (el.dataset.tool) this.selectTool(el.dataset.tool as ToolId);
      else if (el.dataset.mat) { this.material = MATERIALS.find(m => m.id === el.dataset.mat)!; try { localStorage.setItem('blockfall.architect.material', this.material.id); } catch { /* storage unavailable */ } this.planKey = ''; this.refresh(); }
      else if (el.dataset.place) { this.placeId = el.dataset.place as PlaceId; this.refresh(); }
      else if (el.dataset.step) {
        const [name, d] = el.dataset.step.split(':');
        if (name === 'level') this.nudgeLevel(Number(d));
        else this.setParam(name as 'height', (this as unknown as Record<string, number>)[name] + Number(d));
      } else if (el.dataset.toggle) {
        const k = el.dataset.toggle as 'battlements';
        if (k === ('levelLocked' as string)) { this.levelLocked = !this.levelLocked; if (this.levelLocked) this.level = this.hoverCell ? this.hoverCell[1] : Math.floor(this.target.y); }
        else (this as unknown as Record<string, boolean>)[k] = !(this as unknown as Record<string, boolean>)[k];
        this.planKey = ''; this.refresh();
      } else if (el.dataset.act) {
        const a = el.dataset.act;
        if (a === 'time') this.timePaused = !this.timePaused;
        else if (a === 'undo') this.undo();
        else if (a === 'redo') this.redo();
        else if (a === 'exit') this.exit();
        else if (a === 'free') { this.game.freeBuild = (el as HTMLInputElement).checked; }
        this.refresh();
      }
    });
    root.addEventListener('change', (e) => {
      const el = e.target as HTMLInputElement;
      if (el.dataset.input) this.setParam(el.dataset.input as 'height', Number(el.value));
    });
  }
  /** rebuild the option bar and status (cheap; only touches the DOM when the markup changes) */
  refresh(): void {
    if (!this.root) return;
    this.toolsEl.querySelectorAll<HTMLElement>('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === this.tool));
    const free = this.root.querySelector<HTMLInputElement>('[data-act="free"]')!;
    free.checked = this.game.freeBuild || this.game.sandbox; free.disabled = this.game.sandbox;
    const kind = this.toolKind(), inv = this.game.inv;
    const stepper = (label: string, name: string, value: number, unit = '') => `<span class="arch-step"><em>${label}</em><button type="button" data-step="${name}:-1">−</button><input data-input="${name}" type="number" value="${value}" min="1"><button type="button" data-step="${name}:1">+</button>${unit}</span>`;
    const toggle = (label: string, name: string, on: boolean, title = '') => `<button type="button" class="arch-tog ${on ? 'on' : ''}" data-toggle="${name}" title="${title}">${label}</button>`;
    let html = `<div class="arch-row"><b>${TOOLS.find(t => t.id === this.tool)!.name}</b><small>${TOOLS.find(t => t.id === this.tool)!.tip}</small></div><div class="arch-row">`;
    if (kind === 'build') {
      html += `<span class="arch-mats">${MATERIALS.map(m => {
        const c = BLOCKS[m.block], col = `#${c.cSide.getHexString()}`, top = `#${c.cTop.getHexString()}`;
        return `<button type="button" data-mat="${m.id}" class="${m.id === this.material.id ? 'on' : ''}" title="${m.name} · uses ${m.cost}"><i style="background:linear-gradient(${top} 0 35%, ${col} 35%)"></i>${m.name}${this.free() ? '' : `<small>${fmt(inv[m.cost] | 0)}</small>`}</button>`;
      }).join('')}</span>`;
      html += stepper(this.tool === 'stairs' ? 'Rise' : 'Height', 'height', this.height);
      if (this.tool === 'wall' || this.tool === 'line' || this.tool === 'room' || this.tool === 'tower') html += stepper('Thick', 'thickness', this.thickness);
      if (this.tool !== 'stairs' && this.tool !== 'box') html += toggle('Battlements', 'battlements', this.battlements, 'Crenellations on top');
      if (this.tool === 'room') html += toggle('Roof', 'roof', this.roof) + toggle('Door', 'door', this.door, 'Doorway on the side facing the camera') + toggle('Pillars', 'pillars', this.pillars, 'Hold up wide roofs');
      if (this.tool === 'tower') html += toggle('Hollow', 'hollow', this.hollow);
      html += toggle('Foundations', 'foundation', this.foundation, 'Extend down to the ground over dips (F)');
    } else if (kind === 'dig') {
      html += stepper('Depth', 'depth', this.depth);
      if (this.tool === 'moat') html += stepper('Width', 'thickness', this.thickness) + toggle('Flood', 'flood', this.flood, 'Fill with water');
      else html += toggle('Flood', 'floodDig', this.floodDig, 'Fill with water');
    } else if (kind === 'erase') {
      html += stepper('Up', 'eraseHeight', this.eraseHeight) + toggle('Built only', 'builtOnly', this.builtOnly, 'Leave terrain alone');
    } else {
      html += `<span class="arch-place">${PLACEABLES.map(p => {
        const owned = p.inv ? (this.game.sandbox ? '∞' : fmt(inv[p.inv] | 0)) : (this.free() ? '' : 'planks');
        return `<button type="button" data-place="${p.id}" class="${p.id === this.placeId ? 'on' : ''} ${p.inv && !this.game.sandbox && !(inv[p.inv] | 0) ? 'none' : ''}">${p.name}<small>${owned}</small></button>`;
      }).join('')}</span><span class="arch-note">R rotate · ${['south', 'east', 'north', 'west'][this.rotation]}</span>`;
    }
    html += `</div><div class="arch-row">${toggle(this.levelLocked ? `Level Y ${this.level}` : 'Level: follow ground', 'levelLocked', this.levelLocked, 'Lock a working level to build upper storeys (PgUp/PgDn)')}`;
    if (this.levelLocked) html += `<button type="button" data-step="level:-1">▼</button><button type="button" data-step="level:1">▲</button>${toggle('Slice above', 'slice', this.slice, 'Hide built blocks above the working level (L)')}`;
    html += `</div>`;
    if (html !== this.optsHTML) {
      const focused = document.activeElement instanceof HTMLInputElement && this.opts.contains(document.activeElement) ? document.activeElement.dataset.input : null;
      this.optsHTML = html; this.opts.innerHTML = html;
      if (focused) this.opts.querySelector<HTMLInputElement>(`[data-input="${focused}"]`)?.focus();
    }
    this.refreshStatus();
  }
  private refreshStatus(): void {
    const job = this.jobs[0];
    const queued = this.jobs.reduce((n, j) => n + j.n - j.i, 0);
    const wave = this.game.waveDirector;
    const html = `${this.timePaused ? '<em class="paused">⏸ PAUSED</em>' : '▶ live'}${job ? ` · building ${fmt(queued)} left <span class="arch-bar"><i style="width:${(100 * job.i / Math.max(1, job.n)).toFixed(0)}%"></i></span>` : ''}${this.game.entities.enemies.some(e => !e.dead) ? ' · <em class="danger">enemies attacking</em>' : wave ? '' : ''}`;
    if (html !== this.statusHTML) { this.statusHTML = html; this.status.innerHTML = html; }
    const t = this.root.querySelector<HTMLElement>('[data-act="time"]')!;
    t.textContent = this.timePaused ? 'Resume' : 'Pause';
    this.root.querySelector<HTMLButtonElement>('[data-act="undo"]')!.disabled = !this.undoStack.length;
    this.root.querySelector<HTMLButtonElement>('[data-act="redo"]')!.disabled = !this.redoStack.length;
  }
  private updateTip(): void {
    let html = '';
    if (this.plan) {
      const p = this.plan, short = this.affordable();
      const counts = p.error ? '' : [this.counts.add ? `+${fmt(this.counts.add)} blocks` : '', this.counts.remove ? `−${this.counts.exact ? '' : 'up to '}${fmt(this.counts.remove)}` : '', p.flood.length ? 'flooded' : ''].filter(Boolean).join(' · ');
      html = `<b>${p.dims}</b>${counts ? `<span>${counts}${!this.free() && this.counts.add ? ` · ${this.material.cost}` : ''}</span>` : ''}${p.error || short ? `<span class="bad">${p.error || short}</span>` : ''}${p.note ? `<span class="warn">${p.note}</span>` : ''}`;
    } else if (this.tool === 'place' && this.hoverCell) {
      const reason = this.placeReason(this.hoverCell);
      html = `<b>${PLACEABLES.find(p => p.id === this.placeId)!.name}</b><span class="${reason ? 'bad' : ''}">${reason || 'Click to place'}</span>`;
    } else if (this.hoverCell && this.overCanvas) {
      const c = this.toolKind() === 'build' ? this.hoverCell : this.hoverSolid!;
      html = `<span>${c[0]}, ${c[2]} · Y ${c[1]}</span>`;
    }
    this.tip.classList.toggle('hidden', !html);
    if (html !== this.tipHTML) { this.tipHTML = html; this.tip.innerHTML = html; }
    this.tip.style.transform = `translate(${Math.min(this.mx + 18, innerWidth - 260)}px, ${Math.min(this.my + 20, innerHeight - 90)}px)`;
  }
}
