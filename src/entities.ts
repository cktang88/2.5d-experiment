import { createDefenseModel } from './art/autobattlerWeapons';
// Procedural and imported 3D actors living in the voxel world.
import * as THREE from 'three';
import { B, BLOCKS, WATER_LEVEL } from './world';
import { makeBlobTexture } from './sprites';
import { FlowField } from './flowfield';
import { CastleNavigation } from './castleNavigation';
import { HealthRegeneration } from './healthRegen';
import { limitFlightAltitude, JETPACK_MAX_ALTITUDE } from './jetpack';
import type { Game } from './main';
import type { WaveFront } from './waveDirector';
import { getDefense, footprintSize, ballisticVelocity, ballisticClear, type DefenseId } from './defenses';

const HOSTILE_SPEED = 0.65;
export interface WaveSpawnQueue { center: [number, number, number]; entries: { type: string; front: WaveFront }[] }
const FRONT_ANGLE: Record<WaveFront, number> = { north: -Math.PI / 2, east: 0, south: Math.PI / 2, west: Math.PI };
const G = 25;
const FALL_SAFE_V = 17; // landing faster than this hurts (a ~6 block drop)
const TERMINAL_V = 55; // falling speed cap (a 400-block plunge shouldn't tunnel or take forever to resolve)
const GRID_CELL = 2, GRID_SLACK = 0.6; // enemy spatial hash (cell size, extra reach for movement within a frame)
const GRID_SPAN = 192; // grid cells per side, centred on the player (enemies further out share the border cells)
// by day the dead only notice the player this close (or once hurt), and lose interest past AGGRO_LOSE;
// at night the whole horde homes in (without this, crawlers spawned 50+ blocks out reached a new
// player in ~9 s and killed one standing at spawn within 16 s of pressing New game)
const AGGRO_DAY = 26, AGGRO_LOSE = 44, AGGRO_DY = 16;
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
let blobTex: THREE.Texture | null = null;
const planeCache: Record<string, THREE.PlaneGeometry> = {};
function spritePlane(w: number, h: number): THREE.PlaneGeometry {
  const k = w + 'x' + h;
  if (!planeCache[k]) { const g = new THREE.PlaneGeometry(w, h); g.translate(0, h / 2, 0); planeCache[k] = g; }
  return planeCache[k];
}

// Low-poly voxel actors use shared geometry and materials to keep large hordes inexpensive.
const actorCube = new THREE.BoxGeometry(1, 1, 1);
const actorMaterials = new Map<number, THREE.MeshLambertMaterial>();
function actorPart(group: THREE.Group, color: number, x: number, y: number, z: number, w: number, h: number, d: number): THREE.Mesh {
  let material = actorMaterials.get(color);
  if (!material) { material = new THREE.MeshLambertMaterial({ color }); actorMaterials.set(color, material); }
  const part = new THREE.Mesh(actorCube, material);
  part.position.set(x, y, z); part.scale.set(w, h, d); part.castShadow = true;
  group.add(part); return part;
}
let droneShell: THREE.MeshStandardMaterial | undefined;
const droneMetal = new THREE.MeshStandardMaterial({ color: 0x687782, metalness: 0.72, roughness: 0.43 });
const droneDark = new THREE.MeshStandardMaterial({ color: 0x202d35, metalness: 0.48, roughness: 0.62 });
const droneTrim = new THREE.MeshStandardMaterial({ color: 0xc18a45, metalness: 0.67, roughness: 0.48 });
const droneEye = new THREE.MeshStandardMaterial({ color: 0xff563c, emissive: 0xff2816, emissiveIntensity: 2.2, roughness: 0.25 });
const dronePanelGeo = new THREE.BoxGeometry(1, 1, 1);
function droneBodyMaterial(): THREE.MeshStandardMaterial {
  if (droneShell) return droneShell;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#788792'; ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#626f78'; ctx.fillRect(5, 5, 118, 118);
  ctx.fillStyle = '#8f9aa0'; ctx.fillRect(8, 8, 112, 12); ctx.fillRect(8, 108, 112, 12);
  ctx.fillStyle = '#35434b'; ctx.fillRect(10, 27, 108, 3); ctx.fillRect(10, 98, 108, 3);
  ctx.fillStyle = '#b78342'; ctx.fillRect(10, 34, 9, 4); ctx.fillRect(109, 34, 9, 4);
  ctx.fillRect(10, 90, 9, 4); ctx.fillRect(109, 90, 9, 4);
  // Stamped panel seams, worn edges, and fasteners remain legible at a distance.
  ctx.strokeStyle = '#46545d'; ctx.lineWidth = 2; ctx.strokeRect(24, 18, 80, 92);
  ctx.fillStyle = '#c6b17e';
  for (const [x, y] of [[15, 15], [113, 15], [15, 113], [113, 113], [29, 23], [99, 23], [29, 103], [99, 103]]) {
    ctx.fillRect(x, y, 3, 3);
  }
  droneShell = new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(canvas), color: 0xffffff, metalness: 0.7, roughness: 0.5 });
  droneShell.map!.colorSpace = THREE.SRGBColorSpace;
  return droneShell;
}
function dronePart(group: THREE.Group, material: THREE.Material, x: number, y: number, z: number, w: number, h: number, d: number): THREE.Mesh {
  const mesh = new THREE.Mesh(dronePanelGeo, material);
  mesh.position.set(x, y, z); mesh.scale.set(w, h, d); mesh.castShadow = true;
  group.add(mesh); return mesh;
}
function droneModel(h: number): THREE.Group {
  const group = new THREE.Group();
  const shell = droneBodyMaterial();
  // Flattened armored fuselage, reinforced nose, exposed undercarriage and rotor pods.
  dronePart(group, shell, 0, 0, 0, 0.62, 0.27, 0.76);
  dronePart(group, droneDark, 0, -0.16, -0.02, 0.4, 0.12, 0.48);
  dronePart(group, droneTrim, 0, 0.015, 0.4, 0.44, 0.19, 0.12);
  dronePart(group, droneMetal, 0, 0.17, -0.02, 0.22, 0.08, 0.3);
  // Four broad, segmented stabilizer wings distinguish the silhouette from a plain box.
  for (const side of [-1, 1]) {
    dronePart(group, droneDark, side * 0.48, -0.01, -0.02, 0.55, 0.11, 0.24);
    dronePart(group, shell, side * 0.76, 0.005, -0.04, 0.34, 0.09, 0.29);
    dronePart(group, droneTrim, side * 0.81, 0.057, -0.04, 0.12, 0.018, 0.18);
    // Twin red position markers are emissive materials, avoiding per-drone lights.
    dronePart(group, droneEye, side * 0.9, 0.075, -0.03, 0.07, 0.045, 0.07);
  }
  // Forward sensor and paired glowing optics.
  dronePart(group, droneDark, 0, 0.035, 0.49, 0.26, 0.16, 0.12);
  for (const side of [-1, 1]) dronePart(group, droneEye, side * 0.105, 0.045, 0.56, 0.075, 0.075, 0.025);
  group.position.y = h * 0.5;
  return group;
}
function actorModel(kind: string, h: number): THREE.Group {
  const group = new THREE.Group();
  const green = kind === 'spitter' || kind === 'boss', bat = kind === 'bat', crawl = kind === 'crawler';
  if (bat) {
    return droneModel(h);
  } else if (crawl) {
    actorPart(group, 0x57744c, 0, .37, 0, .65, .35, .8);
    actorPart(group, 0x86a56b, 0, .4, .48, .42, .3, .35);
    for (const x of [-.4, .4]) for (const z of [-.3, .3]) actorPart(group, 0x405c3b, x, .15, z, .25, .3, .16);
  } else {
    const skin = green ? 0x80a94b : 0x8ca77a;
    const shirt = green ? 0x566b31 : 0x465d68;
    const scale = h / 1.75;
    actorPart(group, 0x343947, -.19 * scale, .36 * scale, 0, .3 * scale, .72 * scale, .32 * scale);
    actorPart(group, 0x343947, .19 * scale, .36 * scale, 0, .3 * scale, .72 * scale, .32 * scale);
    actorPart(group, shirt, 0, 1.02 * scale, 0, .72 * scale, .67 * scale, .38 * scale);
    actorPart(group, skin, 0, 1.53 * scale, 0, .52 * scale, .48 * scale, .44 * scale);
    actorPart(group, skin, -.49 * scale, .99 * scale, .08 * scale, .25 * scale, .64 * scale, .26 * scale);
    actorPart(group, skin, .49 * scale, .99 * scale, .08 * scale, .25 * scale, .64 * scale, .26 * scale);
    actorPart(group, 0xf04736, -.13 * scale, 1.57 * scale, .228 * scale, .08 * scale, .07 * scale, .02 * scale);
    actorPart(group, 0xf04736, .13 * scale, 1.57 * scale, .228 * scale, .08 * scale, .07 * scale, .02 * scale);
    if (kind === 'boss') {
      // Broad shell and horns make the brood mother distinct from ordinary spitters.
      actorPart(group, 0x514032, 0, 1.09 * scale, -.22 * scale, 1.05 * scale, .7 * scale, .25 * scale);
      actorPart(group, 0xe2c780, -.24 * scale, 1.86 * scale, 0, .13 * scale, .38 * scale, .14 * scale);
      actorPart(group, 0xe2c780, .24 * scale, 1.86 * scale, 0, .13 * scale, .38 * scale, .14 * scale);
      group.scale.x = 1.5;
    }
  }
  return group;
}

export interface EntityOpts {
  r?: number; h?: number; hp?: number; kind: string;
  tex?: THREE.Texture; sw?: number; sh?: number; lean?: number;
}

type Drops = Record<string, [number, number]>;
type Vec3Tuple = [number, number, number];

export interface Sheets {
  player: THREE.Texture;
  zombies: THREE.Texture[];
  crawler: THREE.Texture;
  brute: THREE.Texture;
  bat: THREE.Texture;
  spitter: THREE.Texture;
}

export interface InputState {
  keys: Record<string, boolean | undefined>;
  pressed: Record<string, boolean | undefined>;
}

export interface Pickup { m: THREE.Mesh; res: string; v: THREE.Vector3; t: number; }
export interface Corpse { e: Entity; v: THREE.Vector3; t: number; spinV: number; }

export class Entity {
  game: Game;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  r: number; h: number;
  hp: number; maxHp: number;
  onGround: boolean; dead: boolean;
  facing: THREE.Vector2;
  animT: number; walking: boolean;
  flash: number; burn: number; inWater: boolean;
  blockedH: boolean;
  kind: string;
  hitSquash = 0;
  stagger = 0;
  burnTick?: number;
  sideOnly?: boolean;
  animSpeed?: number;
  spin?: number;
  squash?: number;
  lean = 0;
  model3d?: THREE.Group;
  farModel?: THREE.Mesh;
  modelDetail = -1;
  tex!: THREE.Texture;
  mat!: THREE.MeshLambertMaterial;
  mesh!: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>;
  caster!: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  xmat!: THREE.MeshBasicMaterial;
  xray!: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  blob!: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

  constructor(game: Game, x: number, y: number, z: number, o: EntityOpts) {
    this.game = game;
    this.pos = new THREE.Vector3(x, y, z);
    this.vel = new THREE.Vector3();
    this.r = o.r ?? 0.35; this.h = o.h ?? 1.8;
    this.maxHp = this.hp = o.hp ?? 100;
    this.onGround = false; this.dead = false;
    this.facing = new THREE.Vector2(0, 1);
    this.animT = Math.random() * 10; this.walking = false;
    this.flash = 0; this.burn = 0; this.inWater = false;
    this.blockedH = false;
    this.kind = o.kind;
    if (o.tex) this.makeSprite(o.tex, o.sw ?? 2.3, o.sh ?? 2.3, o.lean ?? 0.45);
  }

  makeSprite(tex: THREE.Texture, w: number, h: number, lean: number) {
    const g = this.game;
    // per-entity clone for its own frame offset; it shares the sheet's image (one GPU upload per sheet).
    // Bump only the clone's version: needsUpdate would also bump the shared source and re-upload the
    // whole high-res sheet and its mips on every spawn.
    this.tex = tex.clone(); this.tex.version++;
    this.tex.repeat.set(1 / 4, 1 / 3);
    this.lean = lean;
    const geo = spritePlane(w, h);
    // lit by the scene, plus an ambient-tinted emissive copy of itself so it never goes muddy
    this.mat = new THREE.MeshLambertMaterial({ map: this.tex, emissiveMap: this.tex, alphaTest: 0.5, side: THREE.DoubleSide, emissive: 0x000000 });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.castShadow = false;
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: this.tex, alphaTest: 0.5 });
    this.mesh.customDepthMaterial = depth;
    // invisible shadow caster that always faces the sun, so the shadow keeps the sprite's silhouette
    this.caster = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, map: this.tex, alphaTest: 0.5, side: THREE.DoubleSide }));
    this.caster.castShadow = true;
    this.caster.customDepthMaterial = depth;
    g.scene.add(this.caster);
    this.mesh.rotation.order = 'YXZ';
    g.scene.add(this.mesh);
    // silhouette visible only where the sprite is hidden behind geometry
    this.xmat = new THREE.MeshBasicMaterial({ map: this.tex, alphaTest: 0.5, color: this.kind === 'player' ? 0x7fe0ff : 0xff6a5a, transparent: true, opacity: 0.45, depthWrite: false, depthFunc: THREE.GreaterDepth });
    this.xray = new THREE.Mesh(geo, this.xmat);
    this.xray.renderOrder = 20;
    this.xray.rotation.order = 'YXZ';
    g.scene.add(this.xray);
    if (!blobTex) blobTex = makeBlobTexture();
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }));
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.scale.setScalar(this.r * 3);
    this.blob.renderOrder = 2;
    g.scene.add(this.blob);
    // Keep the legacy sprite objects as invisible lifecycle anchors for saves and corpses.
    this.mat.visible = false; this.xmat.visible = false; this.caster.material.visible = false;
    if (this.kind !== 'player') {
      this.model3d = actorModel(this.kind, this.h); g.scene.add(this.model3d);
      const material = actorMaterials.get(0x596d55) ?? new THREE.MeshLambertMaterial({ color: 0x596d55 });
      actorMaterials.set(0x596d55, material);
      this.farModel = new THREE.Mesh(actorCube, material);
      this.farModel.scale.set(this.r * 1.6, this.h, this.r * 1.3);
      g.scene.add(this.farModel);
    }
    this.blob.visible = false;
  }

  removeSprite() {
    const s = this.game.scene;
    if (this.model3d) s.remove(this.model3d);
    if (this.farModel) s.remove(this.farModel);
    if (this.mesh) { s.remove(this.mesh); s.remove(this.xray); s.remove(this.blob); s.remove(this.caster); this.caster.material.dispose(); this.mat.dispose(); this.xmat.dispose(); this.blob.material.dispose(); this.blob.geometry.dispose(); this.mesh.customDepthMaterial!.dispose(); this.tex.dispose(); }
  }

  // ---------- voxel collision ----------
  overlaps(): boolean {
    const w = this.game.world, p = this.pos, r = this.r - 0.001;
    const x0 = Math.floor(p.x - r), x1 = Math.floor(p.x + r);
    const y0 = Math.floor(p.y + 0.001), y1 = Math.floor(p.y + this.h - 0.001);
    const z0 = Math.floor(p.z - r), z1 = Math.floor(p.z + r);
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (w.get(x, y, z) !== B.AIR) return true;
    return false;
  }
  moveAxis(axis: 'x' | 'y' | 'z', amt: number): boolean {
    if (amt === 0) return false;
    const steps = Math.ceil(Math.abs(amt) / 0.3);
    const da = amt / steps;
    for (let s = 0; s < steps; s++) {
      const prev = this.pos[axis];
      this.pos[axis] += da;
      if (this.overlaps()) {
        if (axis === 'y') {
          if (da < 0) this.pos.y = Math.floor(this.pos.y) + 1;
          else this.pos.y = Math.floor(this.pos.y + this.h) - this.h - 0.001;
        } else {
          const ext = this.r;
          if (da > 0) this.pos[axis] = Math.floor(this.pos[axis] + ext) - ext - 0.001;
          else this.pos[axis] = Math.floor(this.pos[axis] - ext) + 1 + ext + 0.001;
        }
        if (this.overlaps()) this.pos[axis] = prev;
        return true;
      }
    }
    return false;
  }
  physics(dt: number, gravity = G) {
    const w = this.game.world;
    // columns stream in asynchronously: an entity over one that isn't generated yet would fall
    // straight through it, so it waits (frozen in place) until the terrain under it exists
    if (!w.isGenerated(Math.floor(this.pos.x), Math.floor(this.pos.z))) { this.vel.set(0, 0, 0); this.onGround = true; return; }
    const px = this.pos.x, pz = this.pos.z;
    // pop out if a block ended up inside us (placed, rubble, spawn)
    for (let i = 0; i < 24 && this.overlaps(); i++) this.pos.y = Math.floor(this.pos.y) + 1;
    this.inWater = this.game.waterSim.levelAt(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.4), Math.floor(this.pos.z)) >= 4;
    if (this.inWater) {
      this.vel.y = Math.max(this.vel.y - gravity * 0.25 * dt, -3);
      if (this.game.waterSim.levelAt(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.7), Math.floor(this.pos.z)) >= 4) this.vel.y += 12 * dt; // buoyancy
      if (this.burn > 0) this.burn = 0;
    } else this.vel.y = Math.max(this.vel.y - gravity * dt, -TERMINAL_V);
    this.blockedH = false;
    const horizontal = (axis: 'x' | 'z', amount: number) => {
      if (this.kind !== 'player' || !this.onGround || amount === 0) return this.moveAxis(axis, amount);
      const before = this.pos.clone();
      if (!this.moveAxis(axis, amount)) return false;
      if (this.kind === 'player' && this.onGround) {
        this.pos.copy(before); this.pos.y += 1.001;
        if (!this.overlaps() && !this.moveAxis(axis, amount)) return false;
        this.pos.copy(before); this.moveAxis(axis, amount);
      }
      return true;
    };
    if (horizontal('x', this.vel.x * dt)) { this.blockedH = true; this.vel.x *= this.onGround ? 0 : 0.2; }
    if (horizontal('z', this.vel.z * dt)) { this.blockedH = true; this.vel.z *= this.onGround ? 0 : 0.2; }
    // never step into a column that hasn't been generated (it reads as empty air)
    if (!w.isGenerated(Math.floor(this.pos.x), Math.floor(this.pos.z))) { this.pos.x = px; this.pos.z = pz; this.vel.x = this.vel.z = 0; this.blockedH = true; }
    const vy = this.vel.y;
    this.onGround = false;
    if (this.moveAxis('y', vy * dt)) {
      // fall damage: free up to ~6 blocks, ~60 at 20 blocks, lethal from ~35 (water breaks any fall)
      if (vy < 0) { this.onGround = true; if (vy < -FALL_SAFE_V) this.damage((-vy - FALL_SAFE_V) * 4, null, 'fall'); }
      this.vel.y = 0;
    }
    const W = w.W, D = w.D;
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, 1, W - 1);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, 1, D - 1);
    if (this.pos.y < -10) this.damage(9999, null, 'void');
  }

  damage(amt: number, knock?: THREE.Vector3 | null, cause?: string) {
    if (this.dead) return;
    this.hp -= amt;
    this.flash = 0.08;
    this.hitSquash = 1;
    if (this.kind !== 'boss') this.stagger = 0.14; // the boss can't be stun-locked
    if (knock) { this.vel.add(knock); if (knock.y > 1) this.onGround = false; }
    const g = this.game;
    if (amt >= 1 && this.mesh) g.ui.floatText(this.pos.x, this.pos.y + this.h + 0.2, this.pos.z, String(Math.round(amt)), this.kind === 'player' ? '#ff6a6a' : (cause === 'burn' ? '#ffa040' : '#fff4c0'));
    if (this.hp <= 0) this.die(cause, knock);
  }
  die(_cause?: string, _knock?: THREE.Vector3 | null) { this.dead = true; }

  updateSprite(dt: number) {
    if (!this.mesh) return;
    const g = this.game;
    this.animT += dt * (this.walking ? 1 : 0);
    this.flash = Math.max(0, this.flash - dt);
    if (this.model3d && this.farModel) {
      const hs = this.hitSquash, sx = 1 + hs * 0.35, sy = (this.squash ?? 1) * (1 - hs * 0.2), rz = this.spin || 0;
      const distance = this.pos.distanceToSquared(g.player.pos);
      const detail = distance < 14 * 14 ? 2 : distance < 24 * 24 ? 1 : 0;
      if (detail !== this.modelDetail) {
        this.modelDetail = detail;
        this.model3d.visible = detail > 0;
        this.farModel.visible = detail === 0;
        this.model3d.traverse(obj => { if ((obj as THREE.Mesh).isMesh) obj.castShadow = detail === 2; });
      }
      this.farModel.position.set(this.pos.x, this.pos.y + this.h / 2, this.pos.z);
      this.farModel.rotation.set(0, Math.atan2(this.facing.x, this.facing.y), rz);
      this.model3d.position.copy(this.pos);
      this.model3d.rotation.set(0, Math.atan2(this.facing.x, this.facing.y), rz);
      this.model3d.scale.set(sx * (this.kind === 'boss' ? 1.5 : 1), sy, 1);
      const parts = this.model3d.children;
      if (this.kind !== 'bat' && detail > 0 && this.walking && parts.length >= 6) {
        const stride = Math.sin(this.animT * 8) * .25;
        parts[0].rotation.x = stride; parts[1].rotation.x = -stride;
        parts[4].rotation.x = -stride; parts[5].rotation.x = stride;
      }
    }
    if (this.model3d) {
      this.hitSquash = Math.max(0, this.hitSquash - dt * 6);
      return;
    }
    const amb = g.spriteAmbient;
    if (this.flash > 0) this.mat.emissive.setRGB(2.2, 2.2, 2.2);
    else if (this.burn > 0) this.mat.emissive.setRGB(1.2 + Math.random() * 0.4, 0.5, 0.15);
    else this.mat.emissive.copy(amb);
    const yaw = g.camYaw;
    // choose view: front / back / side
    const cfx = -Math.sin(yaw), cfz = -Math.cos(yaw);
    const crx = Math.cos(yaw), crz = -Math.sin(yaw);
    const d1 = this.facing.x * cfx + this.facing.y * cfz;
    const d2 = this.facing.x * crx + this.facing.y * crz;
    let row = 2, flip = d2 < 0;
    if (this.sideOnly) row = 2;
    else if (d1 > 0.55) { row = 1; flip = false; }
    else if (d1 < -0.55) { row = 0; flip = false; }
    const frame = this.walking ? Math.floor(this.animT * (this.animSpeed || 8)) % 4 : 0;
    this.tex.repeat.x = flip ? -0.25 : 0.25;
    this.tex.offset.set(flip ? (frame + 1) / 4 : frame / 4, 1 - (row + 1) / 3);
    const hs = this.hitSquash || 0, sx = 1 + hs * 0.35, sy = (this.squash ?? 1) * (1 - hs * 0.2);
    const rx = -g.camPitch * this.lean, rz = this.spin || 0;
    this.mesh.position.copy(this.pos); this.mesh.rotation.set(rx, yaw, rz); this.mesh.scale.set(sx, sy, 1);
    this.xray.position.copy(this.pos); this.xray.rotation.set(rx, yaw, rz); this.xray.scale.set(sx, sy, 1);
    this.hitSquash = Math.max(0, (this.hitSquash || 0) - dt * 6);
    this.caster.position.copy(this.pos);
    this.caster.rotation.set(0, g.sunYaw || 0, 0);
    this.caster.visible = this.mesh.visible;
    // blob shadow on the ground beneath
    const w = g.world;
    let gy = Math.floor(this.pos.y + 0.1);
    for (let i = 0; i < 10 && gy > 0 && !w.solid(Math.floor(this.pos.x), gy - 1, Math.floor(this.pos.z)); i++) gy--;
    const hgt = this.pos.y - gy;
    this.blob.position.set(this.pos.x, gy + 0.03, this.pos.z);
    this.blob.scale.setScalar(this.r * 3 * Math.max(0.4, 1 - hgt * 0.12));
    this.blob.material.opacity = Math.max(0.2, 1 - hgt * 0.15);
  }

  updateBurn(dt: number) {
    if (this.burn <= 0) return;
    this.burn -= dt;
    const g = this.game;
    if (Math.random() < dt * 30) g.particles.fire(this.pos.x + (Math.random() - 0.5) * 0.5, this.pos.y + Math.random() * this.h, this.pos.z + (Math.random() - 0.5) * 0.5);
    this.burnTick = (this.burnTick || 0) + dt;
    if (this.burnTick > 0.5) {
      this.burnTick = 0;
      this.damage(this.kind === 'player' ? 3 : 7, null, 'burn');
      // burning things spread fire to what they walk over
      if (Math.random() < 0.4) g.world.ignite(Math.floor(this.pos.x), Math.floor(this.pos.y - 0.5), Math.floor(this.pos.z));
    }
  }

  center(out: THREE.Vector3 = new THREE.Vector3()) { return out.set(this.pos.x, this.pos.y + this.h * 0.5, this.pos.z); }
  hitRadius() { return Math.max(this.r + 0.15, this.h * 0.45); }
}

// ---------------- player ----------------
const OUTLINE = new THREE.MeshBasicMaterial({ color: 0x14101a, side: THREE.BackSide });
// Held-item pieces reuse meshes' geometry and materials across cached models.
const heldGeometry = new Map<string, THREE.BoxGeometry>();
const heldMaterials = new Map<string, THREE.MeshLambertMaterial>();
// a held-item part: lit box with a dark inverted-hull outline so it reads against any background
function box(w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0, emissive = 0) {
  const key = `${w},${h},${d}`, materialKey = `${color},${emissive}`;
  let geo = heldGeometry.get(key);
  if (!geo) { geo = new THREE.BoxGeometry(w, h, d); heldGeometry.set(key, geo); }
  let material = heldMaterials.get(materialKey);
  if (!material) { material = new THREE.MeshLambertMaterial({ color, emissive: emissive || new THREE.Color(color).multiplyScalar(0.18).getHex() }); heldMaterials.set(materialKey, material); }
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z); m.castShadow = true;
  const o = new THREE.Mesh(geo, OUTLINE);
  o.scale.set(1 + 0.05 / w, 1 + 0.05 / h, 1 + 0.05 / d);
  m.add(o);
  return m;
}
export function gunModel(kind: string) {
  const g = new THREE.Group();
  const dark = 0x4a505c, mid = 0x7a828e, wood = 0xa86e3c;
  // The barrel axes follow local +Z; small contrasting pieces keep each silhouette readable.
  const cylinder = (radius: number, length: number, color: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 8), new THREE.MeshLambertMaterial({ color }));
    m.rotation.x = Math.PI / 2; m.position.set(x, y, z); g.add(m); return m;
  };
  const part = (w: number, h: number, d: number, color: number, x: number, y: number, z: number) => { const m = box(w, h, d, color, x, y, z); g.add(m); return m; };
  if (kind === 'pistol') {
    part(.14,.13,.37,mid,0,.04,.10); // slide
    part(.12,.07,.33,dark,0,-.04,.08);
    const grip = part(.10,.24,.12,wood,0,-.16,-.015); grip.rotation.x = -.18;
    part(.11,.025,.12,dark,0,-.28,-.015);
    part(.035,.035,.06,dark,0,.12,-.04); part(.025,.035,.035,dark,0,.12,.27);
    cylinder(.035,.08,0x252a32,0,.025,.31);
    part(.018,.025,.12,0xb4bac0,.075,.055,.11);
  }
  else if (kind === 'shotgun') {
    cylinder(.052,.85,0x353c46,0,.08,.32); cylinder(.034,.56,0x252a32,0,-.005,.35);
    part(.16,.15,.30,mid,0,.015,-.10);
    const stock = part(.14,.16,.37,wood,0,-.055,-.40); stock.rotation.x = -.13;
    part(.15,.17,.045,dark,0,-.08,-.59);
    const pump = part(.15,.11,.27,wood,0,-.035,.30); pump.name = 'pump';
    for (let z = -.10; z <= .10; z += .05) pump.add(box(.155,.015,.012,0x754628,0,-.057,z));
    part(.025,.035,.04,0xd5b26f,0,.145,.70);
    part(.045,.045,.05,dark,0,.13,-.12);
  }
  else if (kind === 'smg') {
    part(.16,.16,.43,dark,0,.02,.10); part(.14,.07,.32,mid,0,.12,.08);
    cylinder(.045,.27,0x303640,0,.035,.43); cylinder(.06,.07,0x20252c,0,.035,.58);
    const grip = part(.10,.22,.11,0x343943,0,-.17,-.04); grip.rotation.x = -.16;
    const mag = part(.095,.26,.11,0x252b33,0,-.18,.18); mag.rotation.x = .12;
    part(.12,.035,.13,mid,0,-.31,.19);
    part(.045,.045,.05,dark,0,.18,-.01); part(.025,.05,.035,dark,0,.14,.48);
    part(.065,.065,.28,mid,0,.01,-.25); part(.14,.13,.04,dark,0,.01,-.40);
    part(.025,.025,.12,0xb0b8bd,.09,.06,.08);
  }
  else if (kind === 'rocket') { g.add(box(0.22, 0.22, 1.1, 0x5a7a4a, 0, 0.06, 0.1)); g.add(box(0.26, 0.26, 0.12, 0x3a4a30, 0, 0.06, 0.66)); g.add(box(0.08, 0.2, 0.1, dark, 0, -0.12, 0)); }
  else if (kind === 'grenade') { g.add(box(0.2, 0.24, 0.2, 0x5a7a3a, 0, 0, 0.1)); g.add(box(0.06, 0.08, 0.06, 0xaaaaaa, 0, 0.16, 0.1)); }
  else if (kind === 'pick') { g.add(box(0.07, 0.07, 0.8, wood, 0, 0, 0.3)); g.add(box(0.6, 0.1, 0.1, 0x9aa4ac, 0, 0, 0.66)); }
  else if (kind === 'cutter') {
    g.add(box(0.18, 0.16, 0.7, 0x394a5a, 0, 0, 0.16));
    g.add(box(0.12, 0.22, 0.16, 0x26323c, 0, -0.16, -0.02));
    g.add(box(0.2, 0.2, 0.15, 0x607987, 0, 0, 0.54));
    g.add(box(0.1, 0.1, 0.04, 0x72f7ff, 0, 0, 0.64, 0x32aabb));
  }
  else { const c = ({ planks: 0xc9955a, bricks: 0xa8705a, tnt: 0xd8443a, turret: 0x7a8a96, lantern: 0xffd27a } as Record<string, number>)[kind] ?? 0xffffff; g.add(box(0.3, 0.3, 0.3, c, 0, 0, 0.15, kind === 'lantern' ? 0x664400 : 0)); }
  g.scale.setScalar(1.5); // readable at the default camera distance
  return g;
}

export class Player extends Entity {
  dashT: number; dashCd: number; coyote: number; invuln: number;
  readonly healthRegen = new HealthRegeneration();
  gunHolder: THREE.Group;
  models: Record<string, THREE.Group>;
  currentModel: THREE.Group | null;
  currentKind?: string;
  aimDir: THREE.Vector3;
  swing: number; recoil: number; recoilRise = 0; cameraKick = 0;
  light: THREE.PointLight;
  /** Height of the player's feet above the nearest solid block below, or null while unloaded. */
  flightAltitude: number | null = null;
  constructor(game: Game, x: number, y: number, z: number, tex: THREE.Texture) {
    super(game, x, y, z, { tex, hp: 100, kind: 'player', r: 0.32, h: 1.7 });
    this.dashT = 0; this.dashCd = 0; this.coyote = 0; this.invuln = 0;
    this.gunHolder = new THREE.Group();
    game.camera.add(this.gunHolder);
    game.scene.add(game.camera);
    this.models = {};
    this.currentModel = null;
    this.aimDir = new THREE.Vector3(0, 0, 1);
    this.swing = 0;
    this.recoil = 0;
    this.light = new THREE.PointLight(0xffb060, 0, 14, 1.6);
    game.scene.add(this.light);
  }
  setModel(kind: string) {
    if (this.currentKind === kind) return;
    this.recoil = 0; this.recoilRise = 0; this.cameraKick = 0;
    if (this.currentModel) this.gunHolder.remove(this.currentModel);
    if (!this.models[kind]) this.models[kind] = gunModel(kind);
    this.currentModel = this.models[kind]; this.currentKind = kind;
    this.gunHolder.add(this.currentModel);
  }
  fireWeapon(kind: string) {
    const strength = kind === 'shotgun' ? 1.65 : kind === 'rocket' ? 1.8 : kind === 'smg' ? .62 : 1;
    this.recoil = Math.min(2, this.recoil + strength);
    this.recoilRise = Math.min(2, this.recoilRise + strength);
    this.cameraKick = Math.min(.045, this.cameraKick + (kind === 'shotgun' ? .027 : kind === 'rocket' ? .032 : kind === 'smg' ? .007 : .014));
  }
  update(dt: number, input: InputState) {
    const g = this.game;
    if (this.dead) { this.recoil = 0; this.recoilRise = 0; this.cameraKick = 0; return; }
    const yaw = g.camYaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    let mx = 0, mz = 0;
    if (input.keys.KeyW) { mx += fx; mz += fz; }
    if (input.keys.KeyS) { mx -= fx; mz -= fz; }
    if (input.keys.KeyD) { mx += rx; mz += rz; }
    if (input.keys.KeyA) { mx -= rx; mz -= rz; }
    const len = Math.hypot(mx, mz);
    if (len > 0) { mx /= len; mz /= len; }
    this.walking = len > 0 && this.onGround;
    this.dashCd -= dt; this.invuln -= dt;
    const flying = g.jetpack.active;
    if (flying) {
      this.dashT = 0;
      this.coyote = 0;
      const world = g.world, x = Math.floor(this.pos.x), z = Math.floor(this.pos.z);
      let flightCeiling: number | null = null;
      if (world.isGenerated(x, z)) {
        // Leaves collide like other solid blocks, so they support flight too. Water is stored separately.
        // Begin just below the feet so roofs or canopies overhead cannot raise the limit.
        const hit = world.raycast(new THREE.Vector3(this.pos.x, this.pos.y - 0.0001, this.pos.z), new THREE.Vector3(0, -1, 0), world.H + 1);
        const groundY = hit.hit ? hit.y + 1 : 0;
        this.flightAltitude = Math.max(0, this.pos.y - groundY);
        flightCeiling = Math.min(groundY + JETPACK_MAX_ALTITUDE, Math.max(1, world.H - this.h));
        g.jetpack.updateVelocity(this.vel, {
          forward: input.keys.KeyW, backward: input.keys.KeyS, left: input.keys.KeyA, right: input.keys.KeyD,
          ascend: input.keys.Space, descend: input.keys.ControlLeft || input.keys.ControlRight,
        }, yaw, dt, this.pos.y > flightCeiling);
        limitFlightAltitude(this.vel, this.pos.y, flightCeiling - JETPACK_MAX_ALTITUDE, dt);
      } else {
        this.flightAltitude = null;
        this.vel.set(0, 0, 0);
      }
      const previousY = this.pos.y;
      this.physics(dt, 0);
      // Buoyancy can add vertical speed inside physics; prevent it crossing the limit too.
      if (flightCeiling !== null && previousY <= flightCeiling && this.pos.y > flightCeiling) {
        this.pos.y = flightCeiling; this.vel.y = Math.min(0, this.vel.y);
      }
      const ceiling = Math.max(1, g.world.H - this.h);
      if (this.pos.y > ceiling) { this.pos.y = ceiling; this.vel.y = Math.min(0, this.vel.y); }
    } else {
      if ((input.pressed.ShiftLeft || input.pressed.ShiftRight) && this.dashCd <= 0 && len > 0) {
        this.dashT = 0.18; this.dashCd = 0.8; this.invuln = 0.25; g.audio.dash();
        g.particles.dust(this.pos.x, this.pos.y + 0.1, this.pos.z, 8);
      }
      let speed = (this.inWater ? 3.5 : 6.2) * g.mods.speed;
      if (this.dashT > 0) { this.dashT -= dt; speed = 19; }
      const accel = this.onGround ? 14 : 5;
      const k = Math.min(1, accel * dt);
      this.vel.x += (mx * speed - this.vel.x) * k;
      this.vel.z += (mz * speed - this.vel.z) * k;
      if (this.onGround) this.coyote = 0.1; else this.coyote -= dt;
      if (input.pressed.Space && (this.coyote > 0 || this.inWater)) { this.vel.y = this.inWater ? 6 : 8.6; this.coyote = 0; g.audio.jump(); }
      this.physics(dt);
    }
    // facing follows aim
    this.facing.set(this.aimDir.x, this.aimDir.z).normalize();
    if (this.facing.lengthSq() < 0.01) this.facing.set(mx || 0, mz || 1);
    this.updateBurn(dt);
    this.updateSprite(dt);
    // held item points at the cursor in full 3D
    this.recoil *= Math.exp(-dt * 13);
    this.recoilRise *= Math.exp(-dt * 8);
    this.cameraKick *= Math.exp(-dt * 9);
    this.swing = Math.max(0, this.swing - dt * 4);
    const hx = this.aimDir.x, hz = this.aimDir.z, hl = Math.hypot(hx, hz) || 1;
    // Camera-space view model follows the eye and stays readable while looking up or down.
    this.gunHolder.position.set(0.34, -0.32 + (this.walking ? Math.sin(this.animT * 10) * 0.015 : 0) - this.recoil * 0.035, -0.55 + this.recoil * 0.14);
    this.gunHolder.rotation.set(-this.swing * 1.1 + this.recoilRise * 0.28, Math.PI, -this.recoil * 0.035);
    const pump = this.currentKind === 'shotgun' ? this.currentModel?.getObjectByName('pump') : undefined;
    if (pump) pump.position.z = .30 - Math.min(.13, this.recoilRise * .08);
    this.gunHolder.scale.setScalar(0.65);
    this.light.position.set(this.pos.x + hx / hl * 1.3, this.pos.y + 3.4, this.pos.z + hz / hl * 1.3);
  }
  regenerate(dt: number): void {
    this.hp += this.healthRegen.update(dt, this.hp, this.maxHp, this.dead, this.burn > 0);
  }
  get regenerationStatus(): string {
    return this.healthRegen.status(this.hp, this.maxHp, this.dead, this.burn > 0);
  }
  damage(amt: number, knock?: THREE.Vector3 | null, cause?: string) {
    if (this.dead || (this.invuln > 0 && cause !== 'void')) return;
    if (amt > 0) this.healthRegen.damaged();
    super.damage(amt, knock, cause);
    this.game.onPlayerHurt(amt);
  }
  die(cause?: string) {
    this.dead = true;
    this.game.onPlayerDeath(cause);
  }
}

// ---------------- enemies ----------------
export interface EnemyOpts extends EntityOpts {
  speed: number; atk: number; gore?: Vec3Tuple; drops?: Drops; sound?: 'groan' | 'chitter';
}

export abstract class Enemy extends Entity {
  speed: number; atk: number; atkCd: number; blockedT: number; strafe: number; strafeT: number;
  goreCol: Vec3Tuple;
  drops: Drops;
  thinkT: number;
  sound?: 'groan' | 'chitter';
  climbs?: boolean;
  climbing?: boolean;
  atkRate?: number;
  aggro = false; // noticed the player (always on at night)
  wanderT = 0; wanderX = 0; wanderZ = 0; // idle shuffle while unaware (day)
  abstract think(dt: number): void;
  constructor(game: Game, x: number, y: number, z: number, o: EnemyOpts) {
    super(game, x, y, z, o);
    this.speed = o.speed * (o.kind === 'deer' || o.kind === 'boar' ? 1 : HOSTILE_SPEED); this.atk = o.atk; this.atkCd = 0; this.blockedT = 0; this.strafe = 0; this.strafeT = 0;
    this.goreCol = o.gore || [0.55, 0.05, 0.05];
    this.drops = o.drops || {};
    this.thinkT = Math.random();
    this.sound = o.sound;
  }
  // aware of the player? always at night; by day only within AGGRO_DAY (kept up to AGGRO_LOSE) or once hurt
  awake(): boolean {
    const g = this.game;
    if (g.waveDirector.phase === 'wave' || g.isNight()) { this.aggro = true; return true; }
    const p = g.entities.player.pos, dx = p.x - this.pos.x, dz = p.z - this.pos.z, d2 = dx * dx + dz * dz;
    if (this.aggro) { if (d2 > AGGRO_LOSE * AGGRO_LOSE) this.aggro = false; }
    else if (d2 < AGGRO_DAY * AGGRO_DAY && Math.abs(p.y - this.pos.y) < AGGRO_DY) this.aggro = true;
    return this.aggro;
  }
  damage(amt: number, knock?: THREE.Vector3 | null, cause?: string) { this.aggro = true; super.damage(amt, knock, cause); }
  // unaware: shuffle about slowly, pausing now and then
  wander(dt: number) {
    this.wanderT -= dt;
    if (this.wanderT <= 0) {
      this.wanderT = 2 + Math.random() * 4;
      const a = Math.random() * Math.PI * 2, go = Math.random() < 0.55;
      this.wanderX = go ? Math.cos(a) : 0; this.wanderZ = go ? Math.sin(a) : 0;
    }
    if (this.blockedH) { this.wanderX = -this.wanderX; this.wanderZ = -this.wanderZ; }
    const sp = this.speed * 0.3, k = Math.min(1, (this.onGround ? 8 : 2) * dt);
    this.vel.x += (this.wanderX * sp - this.vel.x) * k;
    this.vel.z += (this.wanderZ * sp - this.vel.z) * k;
    this.walking = this.wanderX !== 0 || this.wanderZ !== 0;
    if (this.walking) this.facing.set(this.wanderX, this.wanderZ);
  }
  pickTarget(): Entity | null {
    const g = this.game, p = g.entities.player;
    if (!this.awake()) return null;
    let best: Entity | null = p.dead ? null : p, bd = best ? best.pos.distanceToSquared(this.pos) * 0.6 : Infinity;
    for (const t of g.entities.turrets) { const d = t.pos.distanceToSquared(this.pos); if (d < bd) { bd = d; best = t; } }
    return best;
  }
  // push apart from nearby enemies, looking only at the spatial-hash cells that can contain a neighbour
  separation(out: THREE.Vector3) {
    const ents = this.game.entities, head = ents.gridHead, next = ents.gridNext, list = ents.gridList, gw = ents.gridW, gd = ents.gridD;
    // grid positions are from the start of the frame, so leave slack for enemies that moved since
    const reach = Math.ceil(((this.r + ents.gridMaxR) * 1.3 + GRID_SLACK) / GRID_CELL);
    const cx = Math.floor(this.pos.x / GRID_CELL) - ents.gridOX, cz = Math.floor(this.pos.z / GRID_CELL) - ents.gridOZ;
    const x0 = Math.max(0, cx - reach), x1 = Math.min(gw - 1, cx + reach), z0 = Math.max(0, cz - reach), z1 = Math.min(gd - 1, cz + reach);
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      for (let i = head[x + z * gw]; i >= 0; i = next[i]) {
        const o = list[i];
        if (o === this || o.dead) continue;
        const dy = o.pos.y - this.pos.y;
        if (dy > this.h || -dy > o.h) continue; // different heights (e.g. a bat overhead) don't crowd each other
        let dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
        let d2 = dx * dx + dz * dz;
        const rr = (this.r + o.r) * 1.3;
        if (d2 <= 1e-4) { const a = Math.random() * Math.PI * 2; dx = Math.cos(a) * 0.01; dz = Math.sin(a) * 0.01; d2 = dx * dx + dz * dz; } // exactly stacked: pick a random way out
        if (d2 < rr * rr) { const d = Math.sqrt(d2); out.x += dx / d * (rr - d) * 4; out.z += dz / d * (rr - d) * 4; }
      }
    }
    return out;
  }
  steer(dt: number, tgt: Entity, speedMul = 1, away = false) {
    let dx = tgt.pos.x - this.pos.x, dz = tgt.pos.z - this.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    if (away) { dx = -dx; dz = -dz; }
    // follow the shared flow field when the target is the player and not close by
    else if (tgt === this.game.entities.player) {
      const local = this.kind !== 'bat' && this.h <= 2 && this.r <= 0.45 && (Math.abs(tgt.pos.y - this.pos.y) > 1 || this.blockedH)
        ? this.game.entities.castleNavigation.direction(this.pos) : null;
      const f = local || (d > 3.5 ? (this.climbs ? this.game.entities.climbField : this.game.entities.walkField).sample(this.pos.x, this.pos.z) : null);
      if (f) { dx = f[0]; dz = f[1]; }
    }
    if (this.strafeT > 0) { this.strafeT -= dt; const sx = -dz * this.strafe, sz = dx * this.strafe; dx = dx * 0.3 + sx; dz = dz * 0.3 + sz; }
    const sep = this.separation(_w.set(0, 0, 0));
    const sp = this.speed * speedMul * (this.inWater ? 0.5 : 1);
    const k = Math.min(1, (this.onGround ? 8 : 2) * dt);
    this.vel.x += (dx * sp + sep.x - this.vel.x) * k;
    this.vel.z += (dz * sp + sep.z - this.vel.z) * k;
    this.facing.set(dx, dz);
    this.walking = true;
    return d;
  }
  die(_cause?: string, knock?: THREE.Vector3 | null) {
    if (this.dead) return; // callers outside damage() can reach an already-dead enemy: no second corpse, kill or drops
    this.dead = true;
    const g = this.game;
    g.entities.addCorpse(this, knock);
    g.particles.blood(this.pos.x, this.pos.y + this.h * 0.5, this.pos.z, this.goreCol, 18, knock ? _v.copy(knock).normalize() : null);
    for (const [res, [n, chance]] of Object.entries(this.drops)) {
      if (Math.random() < chance) g.entities.addPickup(res, n, this.pos.x, this.pos.y + 0.6, this.pos.z);
    }
    g.kills++;
    g.audio.splat();
    g.hitstop(0.05);
  }
  // nothing solid between the two bodies (a diagonal wall's corner gap let zombies bite through it)
  reaches(tgt: Entity): boolean {
    const from = this.center(_a), dir = tgt.center(_b).sub(from), L = dir.length();
    return L < 1e-3 || !this.game.world.raycast(from, dir.divideScalar(L), L).hit;
  }
  contactAttack(tgt: Entity, dist: number): boolean {
    if (dist < this.r + tgt.r + 0.55 && Math.abs(tgt.pos.y - this.pos.y) < 1.4 && this.atkCd <= 0 && this.reaches(tgt)) {
      this.atkCd = this.atkRate || 1;
      const kb = _v.set(tgt.pos.x - this.pos.x, 0, tgt.pos.z - this.pos.z).normalize().multiplyScalar(5);
      kb.y = 3;
      tgt.damage(this.atk, kb.clone(), 'melee');
      this.squash = 0.8;
      return true;
    }
    return false;
  }
  update(dt: number) {
    this.atkCd -= dt;
    if (this.squash !== undefined) this.squash = Math.min(1, (this.squash ?? 1) + dt * 2);
    if (this.stagger > 0) { this.stagger -= dt; this.vel.x *= 0.9; this.vel.z *= 0.9; this.atkCd = Math.max(this.atkCd, 0.15); }
    else this.think(dt);
    this.physics(dt, this.climbing ? 4 : G);
    this.updateBurn(dt);
    this.updateSprite(dt);
    if (this.sound && Math.random() < dt * 0.08) {
      const d = this.pos.distanceTo(this.game.entities.player.pos);
      if (d < 22) this.game.audio[this.sound](1 - d / 22);
    }
  }
}

export class Zombie extends Enemy {
  wallDmg?: number;
  constructor(game: Game, x: number, y: number, z: number, tex: THREE.Texture) {
    super(game, x, y, z, { tex, kind: 'zombie', hp: 70, speed: 2.4 + Math.random() * 0.8, atk: 12, r: 0.34, h: 1.75, gore: [0.5, 0.08, 0.06], drops: { metal: [1, 0.55], goo: [1, 0.25] }, sound: 'groan' });
    this.animSpeed = 5;
  }
  think(dt: number) {
    const tgt = this.pickTarget();
    if (!tgt) { this.wander(dt); return; }
    const d = this.steer(dt, tgt);
    this.contactAttack(tgt, d);
    // stuck handling: hop, then break through player-built structures
    if (this.blockedH) {
      this.blockedT += dt;
      if (this.onGround && this.blockedT > 0.15) this.vel.y = 8.2;
      if (this.blockedT > 0.7 && this.atkCd <= 0) {
        const w = this.game.world;
        const fx = Math.floor(this.pos.x + this.facing.x * (this.r + 0.4)), fz = Math.floor(this.pos.z + this.facing.y * (this.r + 0.4));
        let broke = false;
        for (const yy of [Math.floor(this.pos.y + 0.5), Math.floor(this.pos.y + 1.4)]) {
          const t = w.get(fx, yy, fz);
          if (t && !BLOCKS[t].anchored) {
            w.damageBlock(fx, yy, fz, this.wallDmg || 1.4, 'zombie');
            this.game.particles.chips(fx + 0.5, yy + 0.5, fz + 0.5, BLOCKS[t].cSide, 3);
            this.game.audio.thunk(0.6);
            this.atkCd = 0.8; this.squash = 0.82; broke = true; break;
          }
        }
        if (!broke && this.blockedT > 1.6) { this.strafe = Math.random() < 0.5 ? -1 : 1; this.strafeT = 1.4; this.blockedT = 0; }
      }
    } else this.blockedT = Math.max(0, this.blockedT - dt);
  }
}

export class Crawler extends Enemy {
  pounceCd: number;
  climbY?: number; // height when the current climb last made progress
  constructor(game: Game, x: number, y: number, z: number, tex: THREE.Texture) {
    super(game, x, y, z, { tex, kind: 'crawler', hp: 22, speed: 5.4, atk: 7, r: 0.38, h: 0.7, sw: 1.7, sh: 1.7, lean: 0.25, gore: [0.3, 0.8, 0.2], drops: { goo: [1, 0.7] }, sound: 'chitter' });
    this.sideOnly = true; this.animSpeed = 14; this.atkRate = 0.6; this.pounceCd = 1; this.climbs = true;
  }
  think(dt: number) {
    const tgt = this.pickTarget();
    this.climbing = false;
    if (!tgt) { this.wander(dt); return; }
    const d = this.steer(dt, tgt);
    this.pounceCd -= dt;
    if (d < 5 && d > 1.6 && this.onGround && this.pounceCd <= 0) {
      this.pounceCd = 2 + Math.random();
      this.vel.x = this.facing.x * 10 * HOSTILE_SPEED; this.vel.z = this.facing.y * 10 * HOSTILE_SPEED; this.vel.y = 6.5;
      this.game.audio.chitter(0.7);
    }
    this.contactAttack(tgt, d);
    // bugs crawl straight up walls; one wedged under an overhang (a tree canopy, battlements) stopped
    // rising and clung there forever, so after a moment without climbing it scuttles sideways instead
    if (this.blockedH) {
      this.climbing = true; this.vel.y = 4.2 * HOSTILE_SPEED; this.spin = 0;
      const y0 = this.climbY ?? this.pos.y;
      if (this.pos.y > y0 + 0.3) { this.climbY = this.pos.y; this.blockedT = 0; }
      else if ((this.blockedT += dt) > 0.8) { this.strafe = Math.random() < 0.5 ? -1 : 1; this.strafeT = 1.2; this.blockedT = 0; this.climbY = undefined; }
      else this.climbY = y0;
    } else { this.climbY = undefined; this.blockedT = 0; }
  }
}

export class Spitter extends Enemy {
  spitCd: number;
  constructor(game: Game, x: number, y: number, z: number, tex: THREE.Texture) {
    super(game, x, y, z, { tex, kind: 'spitter', hp: 38, speed: 2.8, atk: 6, r: 0.5, h: 1.1, sw: 2.3, sh: 2.3, lean: 0.3, gore: [0.35, 0.95, 0.25], drops: { goo: [2, 0.9], metal: [1, 0.3] }, sound: 'chitter' });
    this.sideOnly = true; this.animSpeed = 9; this.spitCd = 2 + Math.random() * 2;
  }
  think(dt: number) {
    const g = this.game;
    const tgt = this.pickTarget();
    this.climbing = false;
    if (!tgt) { this.wander(dt); return; }
    const d = Math.hypot(tgt.pos.x - this.pos.x, tgt.pos.z - this.pos.z);
    if (d > 12) this.steer(dt, tgt);
    else if (d < 7) this.steer(dt, tgt, 0.8, true);
    else { this.vel.x *= 0.9; this.vel.z *= 0.9; this.walking = false; this.facing.set((tgt.pos.x - this.pos.x) / d, (tgt.pos.z - this.pos.z) / d); }
    if (this.blockedH && this.onGround) this.vel.y = 8;
    this.spitCd -= dt;
    if (this.spitCd <= 0 && d < 16) {
      this.spitCd = 2.2 + Math.random() * 1.5;
      this.squash = 0.7;
      const from = this.center(new THREE.Vector3()); from.y += 0.3;
      const to = tgt.center(new THREE.Vector3());
      to.addScaledVector(tgt.vel, 0.5);
      g.projectiles.lob('acid', from, to, this);
      g.audio.spit();
    }
  }
}

// Brute: slow, tanky, smashes walls three times as hard and bowls the player over
export class Brute extends Zombie {
  constructor(game: Game, x: number, y: number, z: number, tex: THREE.Texture) {
    super(game, x, y, z, tex);
    Object.assign(this, { kind: 'brute', maxHp: 280, hp: 280, speed: 1.9 * HOSTILE_SPEED, atk: 26, r: 0.6, h: 2.6, wallDmg: 4.5, atkRate: 1.4, animSpeed: 4 });
    this.drops = { metal: [3, 1], goo: [2, 0.8] };
    this.goreCol = [0.45, 0.05, 0.08];
    this.removeSprite(); this.makeSprite(tex, 3.4, 3.4, 0.45);
    this.mat.color.setRGB(1.0, 0.7, 0.7);
  }
  contactAttack(tgt: Entity, dist: number): boolean {
    const hp = tgt.hp, hit = super.contactAttack(tgt, dist);
    // (the extra launch only when the blow landed: not through dash or respawn invulnerability)
    if (hit && tgt.hp < hp) { tgt.vel.y += 6; this.game.shake(0.3); this.game.audio.thunk(1); }
    return hit;
  }
}

// Bat: flies over walls, swoops in to bite, then peels away
export class Bat extends Enemy {
  retreat: number;
  constructor(game: Game, x: number, y: number, z: number, tex: THREE.Texture) {
    super(game, x, y + 3, z, { tex, kind: 'bat', hp: 16, speed: 7, atk: 6, r: 0.35, h: 0.6, sw: 1.5, sh: 1.5, lean: 0.2, gore: [0.5, 0.1, 0.25], drops: { goo: [1, 0.5] }, sound: 'chitter' });
    this.sideOnly = true; this.animSpeed = 16; this.retreat = 0; this.walking = true;
  }
  think(dt: number) {
    const g = this.game, w = g.world;
    const tgt = this.pickTarget();
    if (!tgt) { this.vel.multiplyScalar(0.95); return; } // hover in place (it kept its last velocity and flew off)
    const c = tgt.center(_v);
    let dx = c.x - this.pos.x, dz = c.z - this.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    this.retreat -= dt;
    let sign = this.retreat > 0 ? -1 : 1;
    // clear the terrain under us and a few blocks ahead, so bats rise over hills instead of grinding into them
    let ground = w.surfaceY(Math.floor(this.pos.x), Math.floor(this.pos.z));
    for (const ahead of [0.5, 1.5, 2.5]) ground = Math.max(ground, w.surfaceY(Math.floor(this.pos.x + dx / d * ahead), Math.floor(this.pos.z + dz / d * ahead)));
    const cruise = Math.max(ground + 2.5, c.y + (d < 4 && this.retreat <= 0 ? -0.2 : 2.5));
    this.vel.x += (dx / d * this.speed * sign - this.vel.x) * Math.min(1, dt * 3);
    this.vel.z += (dz / d * this.speed * sign - this.vel.z) * Math.min(1, dt * 3);
    this.vel.y += ((cruise - this.pos.y) * 3 + Math.sin(this.animT * 9) * 2 - this.vel.y) * Math.min(1, dt * 4);
    this.facing.set(dx / d * sign, dz / d * sign);
    this.walking = true;
    if (this.contactAttack(tgt, d) || (d < 1 && this.retreat <= 0)) this.retreat = 1.2;
  }
  update(dt: number) {
    this.atkCd -= dt;
    if (this.stagger > 0) { this.stagger -= dt; this.vel.y -= 10 * dt; } else this.think(dt);
    this.physics(dt, 0);
    this.updateBurn(dt);
    this.walking = true;
    this.updateSprite(dt);
  }
}

// Brood Mother: the night-3 boss. Lobs acid volleys and births crawlers.
export class BroodMother extends Spitter {
  broodCd: number;
  constructor(game: Game, x: number, y: number, z: number, tex: THREE.Texture) {
    super(game, x, y, z, tex);
    Object.assign(this, { kind: 'boss', maxHp: 1600, hp: 1600, speed: 1.6 * HOSTILE_SPEED, atk: 30, r: 1.4, h: 3.2 });
    this.drops = { metal: [8, 1], goo: [10, 1] };
    this.removeSprite(); this.makeSprite(tex, 7, 7, 0.35);
    this.mat.color.setRGB(1.0, 0.55, 0.75);
    this.broodCd = 4;
  }
  awake() { return true; } // she came for you: never idles, even by day
  think(dt: number) {
    const g = this.game, tgt = this.pickTarget();
    if (!tgt) return;
    const d = Math.hypot(tgt.pos.x - this.pos.x, tgt.pos.z - this.pos.z);
    if (d > 9) this.steer(dt, tgt); else { this.vel.x *= 0.92; this.vel.z *= 0.92; this.walking = false; }
    this.contactAttack(tgt, d);
    if (this.blockedH) {
      // bulldozes through anything in the way
      const w = g.world;
      for (let dy = 0; dy < 3; dy++) for (let s = -1; s <= 1; s++) w.damageBlock(Math.floor(this.pos.x + this.facing.x * 1.8 - this.facing.y * s), Math.floor(this.pos.y + dy), Math.floor(this.pos.z + this.facing.y * 1.8 + this.facing.x * s), dt * 12, 'zombie');
      if (this.onGround) this.vel.y = 7;
    }
    this.spitCd -= dt;
    if (this.spitCd <= 0 && d < 22) {
      this.spitCd = 2.4;
      this.squash = 0.75;
      const from = this.center(new THREE.Vector3()); from.y += 1;
      for (let i = -1; i <= 1; i++) {
        const to = tgt.center(new THREE.Vector3()).addScaledVector(tgt.vel, 0.6);
        to.x += i * 2.2; to.z += (Math.random() - 0.5) * 2;
        g.projectiles.lob('acid', from, to, this);
      }
      g.audio.spit();
    }
    this.broodCd -= dt;
    if (this.broodCd <= 0) {
      this.broodCd = 6;
      for (let i = 0; i < 3; i++) {
        const c = g.entities.spawnEnemy('crawler', this.pos.x + (Math.random() - 0.5) * 2, this.pos.y + 1, this.pos.z + (Math.random() - 0.5) * 2);
        c.vel.set((Math.random() - 0.5) * 8, 6, (Math.random() - 0.5) * 8);
      }
      g.particles.blood(this.pos.x, this.pos.y + 1.5, this.pos.z, this.goreCol, 20);
    }
  }
  die(cause?: string, knock?: THREE.Vector3 | null) {
    if (this.dead) return;
    super.die(cause, knock);
    this.game.onBossDefeated(this);
  }
}

// ---------------- turret (3D model, not a sprite) ----------------
export class Turret extends Entity {
  head: THREE.Group; barrel: THREE.Group; muzzles: THREE.Object3D[] = []; grp: THREE.Group;
  cd = 0; ammo: number; yaw = 0; pitch = 0; side = 1;
  target: Enemy | null = null; scanT = 0;
  // Pending rockets are intentionally transient: loading cancels the unlaunched remainder.
  salvoAim: THREE.Vector3 | null = null; salvoIndex = 0; salvoDelay = 0;
  defenseId: DefenseId; rotation: number;
  constructor(game: Game, x: number, y: number, z: number, defenseId: DefenseId = 'auto', rotation = 0) {
    const spec = getDefense(defenseId);
    super(game, x, y, z, { kind: 'turret', hp: spec.hp, r: .45, h: spec.height });
    this.defenseId = spec.id; this.rotation = rotation; this.ammo = spec.ammo;
    const model = createDefenseModel(spec.id, spec);
    const grp = model.root;
    this.head = model.yawGroup; this.barrel = model.pitchGroup; this.muzzles = model.muzzles;
    grp.position.copy(this.pos);
    this.grp = grp; game.scene.add(grp);
  }
  update(dt: number) {
    if (this.dead) { this.salvoAim = null; return; }
    if (this.ammo <= 0) this.salvoAim = null;
    const g = this.game, spec = getDefense(this.defenseId);
    this.vel.x = 0; this.vel.z = 0; this.vel.y = Math.min(0, this.vel.y);
    this.physics(dt); this.grp.position.copy(this.pos); this.cd -= dt;
    this.scanT -= dt;
    if (this.scanT <= 0 || (this.target && (this.target.dead || this.target.pos.distanceToSquared(this.pos) >= spec.range * spec.range || this.target.pos.distanceToSquared(this.pos) < spec.minRange * spec.minRange))) {
      this.scanT = .3;
      let best: Enemy | null = null, bd = spec.range * spec.range;
      for (const e of g.entities.enemies) {
        if (e.dead) continue;
        const d = e.pos.distanceToSquared(this.pos);
        if (d < bd && this.canSee(e, spec.range * spec.range)) { bd = d; best = e; }
      }
      this.target = best;
    }
    const best = this.target;
    this.salvoDelay -= dt;
    if (best || this.salvoAim) {
      const selected = spec.id === 'twin' ? [0, 1] : spec.id === 'auto' ? [this.side > 0 ? 0 : (this.muzzles.length > 1 ? 1 : 0)] : spec.id === 'rocket' ? [this.salvoAim ? this.salvoIndex : 0] : [0];
      const from = this.muzzle(selected[0]), to = this.salvoAim ? this.salvoAim.clone() : best!.center(new THREE.Vector3());
      if (!this.salvoAim && best) {
        const travel = Math.min(2, from.distanceTo(to) / spec.projectileSpeed);
        to.addScaledVector(best.vel, travel * .65);
      }
      const desired = spec.id === 'artillery' ? ballisticVelocity(from, to).velocity : to.clone().sub(from);
      const wantYaw = Math.atan2(desired.x, desired.z);
      const wantPitch = Math.atan2(desired.y, Math.hypot(desired.x, desired.z));
      const yawDiff = Math.atan2(Math.sin(wantYaw - this.yaw), Math.cos(wantYaw - this.yaw));
      const step = (value: number, delta: number, limit: number) => value + THREE.MathUtils.clamp(delta, -limit, limit);
      this.yaw = step(this.yaw, yawDiff, dt * 2.5);
      this.pitch = step(this.pitch, wantPitch - this.pitch, dt * 1.8);
      this.pitch = THREE.MathUtils.clamp(this.pitch, -Math.PI / 3, Math.PI * 80 / 180);
      this.head.rotation.y = this.yaw;
      this.barrel.rotation.z = this.pitch;
      this.grp.updateMatrixWorld(true);
      if ((this.salvoAim ? this.salvoDelay <= 0 : this.cd <= 0) && this.ammo > 0) {
      const forward = new THREE.Vector3(1, 0, 0).transformDirection(this.muzzles[selected[0]].matrixWorld);
      const shots = selected.map(index => {
        const origin = this.muzzle(index);
        const arc = spec.id === 'artillery' ? ballisticVelocity(origin, to) : null;
        const required = arc ? arc.velocity.clone().normalize() : to.clone().sub(origin).normalize();
        const tolerance = (spec.id === 'artillery' || spec.id === 'rocket' ? 1.5 : 2) * Math.PI / 180;
        // Parallel twin barrels can both intersect a nearby target without their
        // axes converging on its center. Account for its physical radius.
        const targetWidth = spec.id === 'twin' ? Math.atan2(best?.r ?? 0, origin.distanceTo(to)) : 0;
        const aligned = forward.dot(required) >= Math.cos(tolerance + targetWidth);
        const elevation = Math.atan2(required.y, Math.hypot(required.x, required.z));
        const possible = elevation >= -Math.PI / 3 && elevation <= Math.PI * 80 / 180;
        const velocity = arc ? forward.clone().multiplyScalar(arc.velocity.length()) : null;
        const path = to.clone().sub(origin), length = path.length();
        const clear = aligned && possible && (arc && velocity ? ballisticClear(g.world, origin, velocity, arc.time) : length > 0 && !g.world.raycast(origin, forward, length).hit);
        return { origin, arc, velocity, aligned: aligned && possible && clear };
      });
      if (shots.every(shot => shot.aligned)) {
        if (spec.id === 'rocket') {
          if (!this.salvoAim) { this.salvoAim = to.clone(); this.salvoIndex = 0; this.cd = spec.reload * g.mods.turret; }
          this.salvoIndex++; this.salvoDelay = .18;
          if (this.salvoIndex >= 4 || this.ammo <= 1) this.salvoAim = null;
        } else this.cd = spec.reload * g.mods.turret;
        let fired = false;
        for (const shot of shots) {
          if (shot.arc && shot.velocity) g.projectiles.defenseShell(shot.origin, shot.velocity, shot.arc.time, this, spec.damage);
          else if (spec.id === 'rocket') {
            // Four distinct directions form a compact cluster at maximum range.
            const offsets = [[-.045,-.025],[.045,-.025],[-.045,.025],[.045,.025]];
            const [horizontal, vertical] = offsets[(this.salvoIndex - 1) % 4];
            const direction = forward.clone().applyAxisAngle(new THREE.Vector3(0,1,0), horizontal);
            direction.y += vertical; direction.normalize();
            // Recheck the actual rocket's path, including its spread, before spending the round.
            const distance = shot.origin.distanceTo(to);
            const impact = g.world.raycast(shot.origin, direction, distance);
            // Spread may strike the ground or a structure in the intended impact area.
            // A nearby obstruction still prevents launching into the battery's cover.
            if (impact.hit && (impact.point.distanceTo(shot.origin) < 3 || impact.point.distanceTo(to) > distance * .06 + 3.4)) { this.salvoAim = null; break; }
            g.projectiles.defenseRocket(shot.origin, direction, this, spec.damage);
          }
          else if (spec.id === 'cannon' || spec.id === 'twin') g.projectiles.defenseCannon(shot.origin, forward, this, spec.damage, spec.projectileSpeed, spec.id === 'cannon');
          else g.projectiles.bullet(shot.origin, forward, { dmg: spec.damage, speed: spec.projectileSpeed, blockDmg: 0, owner: this, spread: 0 });
          fired = true;
          g.particles.muzzle(shot.origin.x, shot.origin.y, shot.origin.z, forward);
        }
        if (fired) {
          this.ammo--; this.side = -this.side;
          g.audio.shot('turret', Math.max(.1, 1 - this.pos.distanceTo(g.entities.player.pos) / 30));
        }
      }
      }
    } else {
      this.yaw += dt * .5;
      this.head.rotation.y = this.yaw;
    }
    this.flash = Math.max(0, this.flash - dt);
  }
  overlaps(): boolean {
    const [w,d] = footprintSize(this.defenseId, this.rotation), p = this.pos;
    for (let y = Math.floor(p.y+.001); y <= Math.floor(p.y+this.h-.001); y++)
      for (let z = Math.floor(p.z-d/2+.001); z <= Math.floor(p.z+d/2-.001); z++)
        for (let x = Math.floor(p.x-w/2+.001); x <= Math.floor(p.x+w/2-.001); x++)
          if (this.game.world.get(x,y,z) !== B.AIR) return true;
    return false;
  }
  muzzle(index = 0): THREE.Vector3 { this.grp.updateMatrixWorld(true); return this.muzzles[index].getWorldPosition(new THREE.Vector3()); }
  canSee(e: Enemy, maxD2: number): boolean {
    const spec = getDefense(this.defenseId), d2 = e.pos.distanceToSquared(this.pos);
    if (d2 >= maxD2 || d2 < spec.minRange * spec.minRange) return false;
    const from = this.pos.clone().add(new THREE.Vector3(0, spec.height * .68, 0)), to = e.center(new THREE.Vector3());
    if (spec.id === 'artillery') { const arc = ballisticVelocity(from,to); return ballisticClear(this.game.world,from,arc.velocity,arc.time); }
    const dir = to.sub(from), length = dir.length();
    return length > 0 && !this.game.world.raycast(from, dir.divideScalar(length), length).hit;
  }
  disposeModel() {
    this.game.scene.remove(this.grp);
    // Imported model geometry and materials are shared by all turrets.
  }
  die() {
    if (this.dead) return;
    this.dead = true; this.disposeModel();
    this.game.explode(this.pos.clone().add(new THREE.Vector3(0, .6, 0)), 2.2, 6, 'turret');
  }
}

// ---------------- manager ----------------
// drop dead entities in place (keeps array identity, no per-frame allocation)
const DESPAWN_RANGE = 90, DESPAWN_DY = 60;

function compactAlive<T extends Entity>(a: T[]): void {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (!a[i].dead) a[n++] = a[i];
  a.length = n;
}

export class Entities {
  game: Game;
  sheets: Sheets;
  player: Player;
  enemies: Enemy[];
  turrets: Turret[];
  pickups: Pickup[];
  corpses: Corpse[];
  spawnT: number;
  waveSpawnQueue: WaveSpawnQueue | null = null;
  private waveSpawnWait = 0;
  private waveSpawnStall = 0;
  get pendingWaveSpawns(): number { return this.waveSpawnQueue?.entries.length ?? 0; }
  castleNavigation: CastleNavigation;
  walkField: FlowField;
  climbField: FlowField;
  fieldT: number; fieldFlip: boolean;
  fieldCells = [-1, -1]; // player cell each field (walk, climb) was last rooted at
  pickGeo: THREE.BoxGeometry;
  gridHead = new Int32Array(0); gridNext = new Int32Array(0); gridList: Enemy[] = [];
  gridW = 0; gridD = 0; gridMaxR = 0; gridOX = 0; gridOZ = 0; // grid size and corner (in cells); it covers a window around the player
  pickMats: Record<string, THREE.MeshLambertMaterial>;
  constructor(game: Game, sheets: Sheets) {
    this.game = game; this.sheets = sheets;
    this.player = null!; this.enemies = []; this.turrets = []; this.pickups = []; this.corpses = [];
    this.spawnT = 3;
    this.castleNavigation = new CastleNavigation(game.world);
    this.walkField = new FlowField(game.world, false);
    this.climbField = new FlowField(game.world, true);
    this.fieldT = 0; this.fieldFlip = false;
    this.pickGeo = new THREE.BoxGeometry(0.28, 0.28, 0.28);
    this.pickMats = {
      wood: new THREE.MeshLambertMaterial({ color: 0x9a6a3a }), stone: new THREE.MeshLambertMaterial({ color: 0xa8a6a0 }),
      metal: new THREE.MeshLambertMaterial({ color: 0x9ab4c8, emissive: 0x223344 }), goo: new THREE.MeshLambertMaterial({ color: 0x5adf3a, emissive: 0x1a6a10 }),
      iron: new THREE.MeshLambertMaterial({ color: 0xad8066 }), copper: new THREE.MeshLambertMaterial({ color: 0xc66c32 }), coal: new THREE.MeshLambertMaterial({ color: 0x35353b }),
      apple: new THREE.MeshLambertMaterial({ color: 0xe5362c }), berries: new THREE.MeshLambertMaterial({ color: 0x7a348f }), meat: new THREE.MeshLambertMaterial({ color: 0xb45548 }),
    };
  }
  all(): Entity[] { return [this.player, ...this.enemies, ...this.turrets, ...this.game.foraging.wildlife].filter(e => e && !e.dead); }
  // bucket live enemies into a coarse XZ grid (linked lists in typed arrays) for neighbour queries
  buildGrid(): void {
    const gw = GRID_SPAN, gd = GRID_SPAN, p = this.player.pos;
    const ox = this.gridOX = Math.floor(p.x / GRID_CELL) - (GRID_SPAN >> 1), oz = this.gridOZ = Math.floor(p.z / GRID_CELL) - (GRID_SPAN >> 1);
    if (gw !== this.gridW || gd !== this.gridD) { this.gridW = gw; this.gridD = gd; this.gridHead = new Int32Array(gw * gd); }
    this.gridHead.fill(-1);
    const list = this.gridList; list.length = 0;
    let maxR = 0;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const cx = Math.min(gw - 1, Math.max(0, Math.floor(e.pos.x / GRID_CELL) - ox)), cz = Math.min(gd - 1, Math.max(0, Math.floor(e.pos.z / GRID_CELL) - oz));
      const i = list.length, c = cx + cz * gw;
      list.push(e);
      if (i >= this.gridNext.length) { const n = new Int32Array(Math.max(64, this.gridNext.length * 2)); n.set(this.gridNext); this.gridNext = n; }
      this.gridNext[i] = this.gridHead[c]; this.gridHead[c] = i;
      if (e.r > maxR) maxR = e.r;
    }
    this.gridMaxR = maxR;
  }
  // remove every enemy, turret, pickup and corpse (used when loading a save)
  reset(): void {
    const s = this.game.scene;
    for (const e of this.enemies) e.removeSprite();
    for (const c of this.corpses) c.e.removeSprite();
    for (const t of this.turrets) t.disposeModel();
    for (const k of this.pickups) s.remove(k.m);
    this.enemies = []; this.corpses = []; this.turrets = []; this.pickups = [];
    this.walkField.ready = this.climbField.ready = false;
    this.walkField.running = this.climbField.running = false;
    this.fieldCells[0] = this.fieldCells[1] = -1;
    this.castleNavigation.reset();
    this.waveSpawnQueue = null;
  }

  spawnPlayer(x: number, y: number, z: number) { this.player = new Player(this.game, x, y, z, this.sheets.player); return this.player; }

  spawnEnemy(type: string, x: number, y: number, z: number): Enemy {
    let e: Enemy;
    if (type === 'zombie') e = new Zombie(this.game, x, y, z, this.sheets.zombies[(Math.random() * this.sheets.zombies.length) | 0]);
    else if (type === 'crawler') e = new Crawler(this.game, x, y, z, this.sheets.crawler);
    else if (type === 'brute') e = new Brute(this.game, x, y, z, this.sheets.brute);
    else if (type === 'bat') e = new Bat(this.game, x, y, z, this.sheets.bat);
    else if (type === 'boss') e = new BroodMother(this.game, x, y, z, this.sheets.spitter);
    else e = new Spitter(this.game, x, y, z, this.sheets.spitter);
    this.enemies.push(e);
    return e;
  }

  // A spawn spot 'minD'..'maxD' blocks (horizontally) from the player that the given kind of enemy can
  // actually use. Walkers and climbers must be able to reach the player: the spot comes from their flow
  // field (so never on top of a 200-block cliff, on a tree canopy or across a gorge), standing on dry
  // ground. Before the fields exist (game start, just loaded) it falls back to dry ground within a few
  // blocks of the player's height. Bats only need open air over generated terrain near the player's height.
  randomSpawnPoint(minD = 24, maxD = 40, type = 'zombie', front?: WaveFront, center?: [number, number, number]): Vec3Tuple | null {
    const w = this.game.world, p = center ? { x: center[0], y: center[1], z: center[2] } : this.player.pos, water = this.game.waterSim;
    const flyer = type === 'bat';
    const field = flyer ? null : (type === 'crawler' ? this.climbField : this.walkField);
    const py = Math.floor(p.y + 0.05);
    // A flow field rooted at a flying player or the top of a tall wall cannot
    // describe ground approaches. Search the terrain surface in that case.
    const playerX = Math.floor(this.player.pos.x), playerZ = Math.floor(this.player.pos.z);
    const elevated = !!front && w.isGenerated(playerX, playerZ)
      && this.player.pos.y - w.gen.heightAt(playerX, playerZ) > 10;
    for (let i = 0; i < 30; i++) {
      const a = front ? FRONT_ANGLE[front] + (Math.random() - 0.5) * Math.PI / 2 : Math.random() * Math.PI * 2, d = minD + Math.random() * (maxD - minD);
      const x = Math.floor(p.x + Math.cos(a) * d), z = Math.floor(p.z + Math.sin(a) * d);
      // Rounding to block centers can move a point across a quadrant boundary.
      const dx = x + 0.5 - p.x, dz = z + 0.5 - p.z;
      const actualFront = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north');
      if (front && actualFront !== front) continue;
      if (x < 3 || z < 3 || x > w.W - 4 || z > w.D - 4 || !w.isGenerated(x, z)) continue;
      let y = -1;
      if (flyer) {
        const s = w.surfaceY(x, z);
        y = Math.max(s, WATER_LEVEL) + 1; // Bat adds its own cruise height
        if (Math.abs(y - py) > 24) continue;
      } else if (field && field.ready) {
        y = field.reachLevel(x, z);
      }
      if (!flyer && y < 0 && (!field?.ready || elevated)) {
        // no field yet: the standing spot nearest the player's height, within 10 blocks of it
        const groundY = elevated ? w.surfaceY(x, z) + 1 : py;
        for (let k = 0; k <= 10 && y < 0; k++) {
          for (const yy of [groundY + k, groundY - k]) {
            if (yy < 1 || w.occ(x, yy, z) || w.occ(x, yy + 1, z)) continue;
            const below = w.get(x, yy - 1, z);
            if (below && BLOCKS[below].anchored) { y = yy; break; }
          }
        }
      }
      if (y < 1) continue;
      if (!flyer && (type === 'boss' || type === 'brute') && w.occ(x, y + 2, z)) continue;
      if (type === 'boss' && w.occ(x, y + 3, z)) continue;
      // keep walkers out of the sea, the moat and other pools
      if (!flyer && (y <= WATER_LEVEL || water.levelAt(x, y, z) > 0)) continue;
      return [x + 0.5, y + 0.1, z + 0.5];
    }
    return null;
  }

  /** spawn one enemy of `type` at a usable spot around the player (null if there is none right now) */
  spawnAround(type: string, minD = 24, maxD = 40): Enemy | null {
    const sp = this.randomSpawnPoint(minD, maxD, type);
    return sp ? this.spawnEnemy(type, sp[0], sp[1], sp[2]) : null;
  }

  spawnWave(n: number, fronts: WaveFront[], boss = false) {
    const player = this.player.pos, castle = this.game.world.gen.spawn;
    const p = Math.hypot(player.x - castle.x, player.z - castle.z) < 100
      ? { x: castle.x, y: castle.g + 1, z: castle.z } : player;
    const entries: WaveSpawnQueue['entries'] = Array.from({ length: n }, (_, i) => ({ type: this.pickType(), front: fronts[i % fronts.length] }));
    if (boss) entries.push({ type: 'boss', front: fronts[0] });
    this.waveSpawnQueue = { center: [p.x, p.y, p.z], entries };
    this.waveSpawnWait = 0;
    this.waveSpawnStall = 0;
  }

  private updateWaveSpawns(dt: number): void {
    const queue = this.waveSpawnQueue;
    if (!queue) return;
    const before = queue.entries.length;
    // Bound work per frame. Rotate blocked entries so other fronts can still arrive.
    for (let i = 0, attempts = Math.min(4, queue.entries.length); i < attempts; i++) {
      const entry = queue.entries.shift()!;
      const spot = this.randomSpawnPoint(32, Math.min(90, 48 + this.waveSpawnStall * 2), entry.type, entry.front, queue.center);
      if (!spot) { queue.entries.push(entry); continue; }
      const enemy = this.spawnEnemy(entry.type, ...spot);
      enemy.aggro = true;
      if (entry.type === 'boss') {
        this.game.boss = enemy;
        this.game.ui.banner('The Brood Mother');
        this.game.ui.toast('Something huge is coming. Kill it!', 'bad');
      }
    }
    if (!queue.entries.length) this.waveSpawnQueue = null;
    else if (queue.entries.length < before) { this.waveSpawnWait = 0; this.waveSpawnStall = 0; }
    else {
      this.waveSpawnStall += dt;
      if ((this.waveSpawnWait += dt) >= 12) {
        this.waveSpawnWait = 0;
        this.game.ui.toast(`Waiting for a clear approach from ${[...new Set(queue.entries.map(e => e.front))].join(', ')}`, 'bad');
      }
    }
  }

  // enemy mix escalates night by night
  pickType(): string {
    const n = this.game.waveDirector.wave, r = Math.random();
    if (n >= 2 && r < 0.08) return 'brute';
    if (n >= 1 && r < 0.2) return 'bat';
    if (n >= 3 && r < 0.12) return 'brute';
    const r2 = Math.random();
    return r2 < 0.55 ? 'zombie' : r2 < 0.85 ? 'crawler' : 'spitter';
  }

  addPickup(res: string, n: number, x: number, y: number, z: number) {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(this.pickGeo, this.pickMats[res] || this.pickMats.stone);
      m.castShadow = true;
      m.position.set(x, y, z);
      this.game.scene.add(m);
      this.pickups.push({ m, res, v: new THREE.Vector3((Math.random() - 0.5) * 4, 4 + Math.random() * 2, (Math.random() - 0.5) * 4), t: 0 });
    }
  }

  addCorpse(e: Entity, knock?: THREE.Vector3 | null) {
    // detach the sprite and let it tumble away like a ragdoll
    const v = knock ? knock.clone().multiplyScalar(1.4) : new THREE.Vector3();
    v.y = Math.max(v.y, 4 + Math.random() * 3);
    this.corpses.push({ e, v, t: 0, spinV: (Math.random() < 0.5 ? -1 : 1) * (6 + Math.random() * 6) });
  }

  blocksCell(x: number, y: number, z: number, ignoreTraps = false) {
    const hits = (e: Entity) => !e.dead && e.pos.x + e.r > x && e.pos.x - e.r < x + 1 && e.pos.z + e.r > z && e.pos.z - e.r < z + 1 && e.pos.y + e.h > y && e.pos.y < y + 1;
    if (this.player && hits(this.player)) return true;
    for (const e of this.enemies) if (hits(e)) return true;
    for (const animal of this.game.foraging.wildlife) if (hits(animal)) return true;
    for (const t of this.turrets) {
      const [w,d] = footprintSize(t.defenseId, t.rotation);
      if (!t.dead && t.pos.x + w/2 > x && t.pos.x - w/2 < x+1 && t.pos.z + d/2 > z && t.pos.z - d/2 < z+1 && t.pos.y + t.h > y && t.pos.y < y+1) return true;
    }
    return !ignoreTraps && !!this.game.traps?.blocksCell(x, y, z);
  }

  // nearest entity hit along a segment (sphere approximation)
  // (pad widens every body's sphere: a forgiving pick for the mouse cursor)
  raycast(o: THREE.Vector3, d: THREE.Vector3, maxDist: number, ignore?: Entity | null, pad = 0, hostilesOnly = false): { e: Entity; t: number } | null {
    // who can be hit depends only on the shooter: the player and turrets are allies, enemies only hurt them
    const ik = ignore ? ignore.kind : '';
    const allyShooter = ik === 'player' || ik === 'turret', enemyShooter = !!ignore && !allyShooter;
    this._best = null; this._bt = maxDist; this._pad = pad;
    if (!hostilesOnly && this.player && ik !== 'turret' && this.player !== ignore && !this.player.dead) this.rayTest(this.player, o, d);
    if (!enemyShooter) for (const e of this.enemies) if (!e.dead && e !== ignore) this.rayTest(e, o, d);
    if (!hostilesOnly && ik === 'player') for (const e of this.game.foraging.wildlife) if (!e.dead) this.rayTest(e, o, d);
    if (!hostilesOnly && !allyShooter) for (const t of this.turrets) if (!t.dead && t !== ignore) this.rayTest(t, o, d);
    return this._best ? { e: this._best, t: this._bt } : null;
  }
  private _best: Entity | null = null; private _bt = 0; private _pad = 0;
  private rayTest(e: Entity, o: THREE.Vector3, d: THREE.Vector3): void {
    if (e instanceof Turret) {
      const [w, depth] = footprintSize(e.defenseId, e.rotation);
      let near = 0, far = this._bt;
      for (const [origin, direction, min, max] of [
        [o.x,d.x,e.pos.x-w/2-this._pad,e.pos.x+w/2+this._pad],
        [o.y,d.y,e.pos.y-this._pad,e.pos.y+e.h+this._pad],
        [o.z,d.z,e.pos.z-depth/2-this._pad,e.pos.z+depth/2+this._pad],
      ]) {
        if (Math.abs(direction) < 1e-9) { if (origin < min || origin > max) return; continue; }
        let a = (min-origin)/direction, b = (max-origin)/direction;
        if (a > b) [a,b] = [b,a];
        near = Math.max(near,a); far = Math.min(far,b);
        if (near > far) return;
      }
      if (near < this._bt) { this._bt = near; this._best = e; }
      return;
    }
    const r = e.hitRadius() + this._pad;
    const ox = o.x - e.pos.x, oy = o.y - (e.pos.y + e.h * 0.5), oz = o.z - e.pos.z;
    const b = ox * d.x + oy * d.y + oz * d.z;
    const disc = b * b - (ox * ox + oy * oy + oz * oz - r * r);
    if (disc < 0) return;
    const t = -b - Math.sqrt(disc);
    if (t >= -r && t < this._bt) { this._bt = Math.max(0, t); this._best = e; }
  }

  update(dt: number) {
    if (dt <= 0) {
      // Newly loaded actors still need their models positioned while paused.
      for (const e of this.enemies) if (!e.dead) e.updateSprite(0);
      for (const animal of this.game.foraging.wildlife) if (!animal.dead) animal.updateSprite(0);
      return;
    }
    this.updateWaveSpawns(dt);
    const g = this.game;
    // flow fields: start a new search for one class at a time, when the player moves cell or every
    // second; searches are time-sliced (a rugged 192² window can take tens of ms) and swap in when done
    this.fieldT -= dt;
    const pc = Math.floor(this.player.pos.x) + Math.floor(this.player.pos.z) * 8192 + Math.floor(this.player.pos.y) * 67108864;
    const busy = this.walkField.running || this.climbField.running;
    if (!busy && this.fieldT <= 0) {
      // a field rooted somewhere else goes first (after a teleport or respawn both are stale, and they
      // take turns); with both current, they still alternate refreshes every second for world edits
      const stale0 = this.fieldCells[0] !== pc, stale1 = this.fieldCells[1] !== pc;
      if (stale0 || stale1 || this.fieldT < -1) {
        this.fieldFlip = stale0 !== stale1 ? stale1 : !this.fieldFlip; // true: the climb field
        const k = this.fieldFlip ? 1 : 0;
        this.fieldT = 0.2; this.fieldCells[k] = pc;
        (k ? this.climbField : this.walkField).start(this.player.pos.x, this.player.pos.y, this.player.pos.z);
      }
    }
    if (dt > 0) {
      // no field yet (start of a game, after loading): finish it now rather than leave the horde aimless
      const budget = this.walkField.ready && this.climbField.ready ? 1.5 : Infinity;
      if (this.walkField.running) this.walkField.step(budget);
      if (this.climbField.running) this.climbField.step(budget);
    }
    // spawning
    if (this.enemies.some(e => !e.dead && e.kind !== 'bat' && e.h <= 2 && e.r <= 0.45 && (Math.abs(e.pos.y - this.player.pos.y) > 1 || e.blockedH) && e.pos.distanceToSquared(this.player.pos) < 24 * 24))
      this.castleNavigation.update(this.player.pos, dt);
    this.buildGrid();
    for (const e of this.enemies) if (!e.dead) e.update(dt);
    for (const t of this.turrets) if (!t.dead) t.update(dt);
    for (const animal of this.game.foraging.wildlife) if (!animal.dead) animal.update(dt);
    // enemies that wander far from the player despawn quietly (the boss never does)
    const pp = this.player.pos;
    for (const e of this.enemies) {
      if (e.dead || e.kind === 'boss') continue;
      const dx = e.pos.x - pp.x, dz = e.pos.z - pp.z;
      // (also those left far above or below: knocked off a cliff, stranded on a peak)
      if (dx * dx + dz * dz > DESPAWN_RANGE * DESPAWN_RANGE || Math.abs(e.pos.y - pp.y) > DESPAWN_DY) { e.dead = true; e.removeSprite(); }
    }
    compactAlive(this.enemies);
    compactAlive(this.turrets);
    // corpses
    for (let i = 0; i < this.corpses.length; i++) {
      const c = this.corpses[i];
      c.t += dt;
      const e = c.e;
      c.v.y -= G * dt;
      const w = g.world;
      const nx = e.pos.x + c.v.x * dt, nz = e.pos.z + c.v.z * dt, ny = e.pos.y + c.v.y * dt;
      if (!w.solidAt(nx, e.pos.y + 0.3, e.pos.z)) e.pos.x = nx; else c.v.x *= -0.4;
      if (!w.solidAt(e.pos.x, e.pos.y + 0.3, nz)) e.pos.z = nz; else c.v.z *= -0.4;
      if (c.v.y < 0 && w.solidAt(e.pos.x, ny, e.pos.z)) { e.pos.y = Math.floor(ny) + 1; c.v.y *= -0.3; c.v.x *= 0.6; c.v.z *= 0.6; c.spinV *= 0.5; }
      else e.pos.y = ny;
      e.spin = (e.spin || 0) + c.spinV * dt;
      if (c.t > 1.2) { e.spin = THREE.MathUtils.lerp(e.spin, Math.round(e.spin / (Math.PI / 2)) * Math.PI / 2 + (Math.sign(c.spinV) * Math.PI / 2), dt * 4); }
      e.walking = false;
      e.flash = 0; e.burn = Math.max(0, e.burn - dt);
      e.updateSprite(dt);
      e.mat.opacity = 1;
      if (c.t > 2.6) {
        const shrink = Math.max(0.01, 1 - (c.t - 2.6) * 2.5);
        if (e.model3d) e.model3d.scale.y *= shrink;
        if (e.farModel) e.farModel.scale.y = e.h * shrink;
        e.mesh.scale.y = shrink;
        e.xray.visible = false;
      }
      if (c.t > 3) { e.removeSprite(); this.corpses.splice(i, 1); i--; }
    }
    // pickups
    const p = this.player;
    for (let i = 0; i < this.pickups.length; i++) {
      const k = this.pickups[i];
      k.t += dt;
      const m = k.m;
      const toP = _v.set(p.pos.x - m.position.x, p.pos.y + 0.8 - m.position.y, p.pos.z - m.position.z);
      const d = toP.length();
      if (k.t > 0.4 && d < g.mods.magnet && !p.dead) {
        k.v.lerp(toP.normalize().multiplyScalar(14), Math.min(1, dt * 8));
        m.position.addScaledVector(k.v, dt);
        if (d < 0.6) { g.collect(k.res, 1); g.scene.remove(m); this.pickups.splice(i, 1); i--; continue; }
      } else if (g.world.isGenerated(Math.floor(m.position.x), Math.floor(m.position.z))) { // (wait for unloaded ground)
        k.v.y = Math.max(k.v.y - G * dt, -TERMINAL_V);
        const ny = m.position.y + k.v.y * dt;
        if (k.v.y < 0 && g.world.solidAt(m.position.x, ny - 0.15, m.position.z)) { m.position.y = Math.floor(ny - 0.15) + 1.15; k.v.set(0, 0, 0); }
        else { m.position.y = ny; m.position.x += k.v.x * dt; m.position.z += k.v.z * dt; if (g.world.solidAt(m.position.x, m.position.y, m.position.z)) { m.position.y += 1; } }
      }
      m.rotation.y += dt * 3; m.rotation.x = 0.5;
      if (k.t > 60) { g.scene.remove(m); this.pickups.splice(i, 1); i--; }
    }
  }
}
