// Billboarded pixel-art actors living in the 3D voxel world.
import * as THREE from 'three';
import { B, BLOCKS, WATER_LEVEL } from './world';
import { makeBlobTexture } from './sprites';
import { FlowField } from './flowfield';
import type { Game } from './main';

const G = 25;
const GRID_CELL = 2, GRID_SLACK = 0.6; // enemy spatial hash (cell size, extra reach for movement within a frame)
const _v = new THREE.Vector3(), _w = new THREE.Vector3();
let blobTex: THREE.Texture | null = null;
const planeCache: Record<string, THREE.PlaneGeometry> = {};
function spritePlane(w: number, h: number): THREE.PlaneGeometry {
  const k = w + 'x' + h;
  if (!planeCache[k]) { const g = new THREE.PlaneGeometry(w, h); g.translate(0, h / 2, 0); planeCache[k] = g; }
  return planeCache[k];
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
    this.tex = tex.clone(); this.tex.needsUpdate = true;
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
  }

  removeSprite() {
    const s = this.game.scene;
    if (this.mesh) { s.remove(this.mesh); s.remove(this.xray); s.remove(this.blob); s.remove(this.caster); this.caster.material.dispose(); this.mat.dispose(); this.xmat.dispose(); this.blob.material.dispose(); this.mesh.customDepthMaterial!.dispose(); this.tex.dispose(); }
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
    // pop out if a block ended up inside us (placed, rubble, spawn)
    for (let i = 0; i < 4 && this.overlaps(); i++) this.pos.y = Math.floor(this.pos.y) + 1;
    this.inWater = (this.pos.y + 0.4 < WATER_LEVEL && !w.solidAt(this.pos.x, this.pos.y + 0.5, this.pos.z))
      || this.game.waterSim.levelAt(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.4), Math.floor(this.pos.z)) >= 4;
    if (this.inWater) {
      this.vel.y = Math.max(this.vel.y - gravity * 0.25 * dt, -3);
      if (this.pos.y + 0.7 < WATER_LEVEL || this.game.waterSim.levelAt(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.7), Math.floor(this.pos.z)) >= 4) this.vel.y += 12 * dt; // buoyancy
      if (this.burn > 0) this.burn = 0;
    } else this.vel.y -= gravity * dt;
    this.blockedH = false;
    if (this.moveAxis('x', this.vel.x * dt)) { this.blockedH = true; this.vel.x *= this.onGround ? 0 : 0.2; }
    if (this.moveAxis('z', this.vel.z * dt)) { this.blockedH = true; this.vel.z *= this.onGround ? 0 : 0.2; }
    const vy = this.vel.y;
    this.onGround = false;
    if (this.moveAxis('y', vy * dt)) {
      if (vy < 0) { this.onGround = true; if (vy < -17) this.damage((-vy - 17) * 4, null, 'fall'); }
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
    this.stagger = 0.14;
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
function box(w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0, emissive = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color, emissive }));
  m.position.set(x, y, z); m.castShadow = true;
  return m;
}
export function gunModel(kind: string) {
  const g = new THREE.Group();
  const dark = 0x3a3e48, mid = 0x5a606c, wood = 0x8a5a32;
  if (kind === 'pistol') { g.add(box(0.12, 0.12, 0.4, mid, 0, 0, 0.12)); g.add(box(0.1, 0.22, 0.12, wood, 0, -0.12, -0.02)); }
  else if (kind === 'shotgun') { g.add(box(0.12, 0.12, 0.9, dark, 0, 0.02, 0.3)); g.add(box(0.14, 0.16, 0.4, wood, 0, -0.04, -0.15)); g.add(box(0.1, 0.08, 0.3, wood, 0, -0.06, 0.35)); }
  else if (kind === 'smg') { g.add(box(0.14, 0.16, 0.6, mid, 0, 0, 0.15)); g.add(box(0.08, 0.28, 0.1, dark, 0, -0.18, 0.15)); g.add(box(0.06, 0.06, 0.25, dark, 0, 0.02, 0.55)); }
  else if (kind === 'rocket') { g.add(box(0.22, 0.22, 1.1, 0x5a7a4a, 0, 0.06, 0.1)); g.add(box(0.26, 0.26, 0.12, 0x3a4a30, 0, 0.06, 0.66)); g.add(box(0.08, 0.2, 0.1, dark, 0, -0.12, 0)); }
  else if (kind === 'grenade') { g.add(box(0.2, 0.24, 0.2, 0x5a7a3a, 0, 0, 0.1)); g.add(box(0.06, 0.08, 0.06, 0xaaaaaa, 0, 0.16, 0.1)); }
  else if (kind === 'pick') { g.add(box(0.07, 0.07, 0.8, wood, 0, 0, 0.3)); g.add(box(0.6, 0.1, 0.1, 0x9aa4ac, 0, 0, 0.66)); }
  else { const c = ({ planks: 0xc9955a, bricks: 0xa8705a, tnt: 0xd8443a, turret: 0x7a8a96, lantern: 0xffd27a } as Record<string, number>)[kind] ?? 0xffffff; g.add(box(0.3, 0.3, 0.3, c, 0, 0, 0.15, kind === 'lantern' ? 0x664400 : 0)); }
  return g;
}

export class Player extends Entity {
  dashT: number; dashCd: number; coyote: number; invuln: number;
  gunHolder: THREE.Group;
  models: Record<string, THREE.Group>;
  currentModel: THREE.Group | null;
  currentKind?: string;
  aimDir: THREE.Vector3;
  swing: number; recoil: number;
  light: THREE.PointLight;
  constructor(game: Game, x: number, y: number, z: number, tex: THREE.Texture) {
    super(game, x, y, z, { tex, hp: 100, kind: 'player', r: 0.32, h: 1.7 });
    this.dashT = 0; this.dashCd = 0; this.coyote = 0; this.invuln = 0;
    this.gunHolder = new THREE.Group();
    game.scene.add(this.gunHolder);
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
    if (this.currentModel) this.gunHolder.remove(this.currentModel);
    if (!this.models[kind]) this.models[kind] = gunModel(kind);
    this.currentModel = this.models[kind]; this.currentKind = kind;
    this.gunHolder.add(this.currentModel);
  }
  update(dt: number, input: InputState) {
    const g = this.game;
    if (this.dead) return;
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
    if (input.pressed.ShiftLeft && this.dashCd <= 0 && len > 0) {
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
    // facing follows aim
    this.facing.set(this.aimDir.x, this.aimDir.z).normalize();
    if (this.facing.lengthSq() < 0.01) this.facing.set(mx || 0, mz || 1);
    this.updateBurn(dt);
    this.updateSprite(dt);
    // held item points at the cursor in full 3D
    this.recoil = Math.max(0, this.recoil - dt * 6);
    this.swing = Math.max(0, this.swing - dt * 4);
    const hx = this.aimDir.x, hz = this.aimDir.z, hl = Math.hypot(hx, hz) || 1;
    this.gunHolder.position.set(this.pos.x + hx / hl * 0.32, this.pos.y + 0.95, this.pos.z + hz / hl * 0.32);
    const pitch = Math.asin(THREE.MathUtils.clamp(this.aimDir.y, -1, 1));
    this.gunHolder.rotation.set(0, 0, 0);
    this.gunHolder.rotation.order = 'YXZ';
    this.gunHolder.rotation.y = Math.atan2(hx, hz);
    this.gunHolder.rotation.x = -pitch - this.swing * 2.2 + this.recoil * 0.35;
    if (this.currentModel) this.currentModel.position.z = -this.recoil * 0.15;
    this.light.position.set(this.pos.x, this.pos.y + 2.2, this.pos.z);
  }
  damage(amt: number, knock?: THREE.Vector3 | null, cause?: string) {
    if (this.invuln > 0 && cause !== 'void') return;
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
  abstract think(dt: number): void;
  constructor(game: Game, x: number, y: number, z: number, o: EnemyOpts) {
    super(game, x, y, z, o);
    this.speed = o.speed; this.atk = o.atk; this.atkCd = 0; this.blockedT = 0; this.strafe = 0; this.strafeT = 0;
    this.goreCol = o.gore || [0.55, 0.05, 0.05];
    this.drops = o.drops || {};
    this.thinkT = Math.random();
    this.sound = o.sound;
  }
  pickTarget(): Entity | null {
    const g = this.game, p = g.entities.player;
    let best: Entity | null = p.dead ? null : p, bd = best ? best.pos.distanceToSquared(this.pos) * 0.6 : Infinity;
    for (const t of g.entities.turrets) { const d = t.pos.distanceToSquared(this.pos); if (d < bd) { bd = d; best = t; } }
    return best;
  }
  // push apart from nearby enemies, looking only at the spatial-hash cells that can contain a neighbour
  separation(out: THREE.Vector3) {
    const ents = this.game.entities, head = ents.gridHead, next = ents.gridNext, list = ents.gridList, gw = ents.gridW, gd = ents.gridD;
    // grid positions are from the start of the frame, so leave slack for enemies that moved since
    const reach = Math.ceil(((this.r + ents.gridMaxR) * 1.3 + GRID_SLACK) / GRID_CELL);
    const cx = Math.floor(this.pos.x / GRID_CELL), cz = Math.floor(this.pos.z / GRID_CELL);
    const x0 = Math.max(0, cx - reach), x1 = Math.min(gw - 1, cx + reach), z0 = Math.max(0, cz - reach), z1 = Math.min(gd - 1, cz + reach);
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      for (let i = head[x + z * gw]; i >= 0; i = next[i]) {
        const o = list[i];
        if (o === this || o.dead) continue;
        const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
        const d2 = dx * dx + dz * dz, rr = (this.r + o.r) * 1.3;
        if (d2 < rr * rr && d2 > 1e-4) { const d = Math.sqrt(d2); out.x += dx / d * (rr - d) * 4; out.z += dz / d * (rr - d) * 4; }
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
    else if (d > 3.5 && tgt === this.game.entities.player) {
      const f = (this.climbs ? this.game.entities.climbField : this.game.entities.walkField).sample(this.pos.x, this.pos.z);
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
  contactAttack(tgt: Entity, dist: number): boolean {
    if (dist < this.r + tgt.r + 0.55 && Math.abs(tgt.pos.y - this.pos.y) < 1.4 && this.atkCd <= 0) {
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
    if (!tgt) { this.walking = false; this.vel.x *= 0.9; this.vel.z *= 0.9; return; }
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
  constructor(game: Game, x: number, y: number, z: number, tex: THREE.Texture) {
    super(game, x, y, z, { tex, kind: 'crawler', hp: 22, speed: 5.4, atk: 7, r: 0.38, h: 0.7, sw: 1.7, sh: 1.7, lean: 0.25, gore: [0.3, 0.8, 0.2], drops: { goo: [1, 0.7] }, sound: 'chitter' });
    this.sideOnly = true; this.animSpeed = 14; this.atkRate = 0.6; this.pounceCd = 1; this.climbs = true;
  }
  think(dt: number) {
    const tgt = this.pickTarget();
    this.climbing = false;
    if (!tgt) { this.walking = false; return; }
    const d = this.steer(dt, tgt);
    this.pounceCd -= dt;
    if (d < 5 && d > 1.6 && this.onGround && this.pounceCd <= 0) {
      this.pounceCd = 2 + Math.random();
      this.vel.x = this.facing.x * 10; this.vel.z = this.facing.y * 10; this.vel.y = 6.5;
      this.game.audio.chitter(0.7);
    }
    this.contactAttack(tgt, d);
    // bugs crawl straight up walls
    if (this.blockedH) { this.climbing = true; this.vel.y = 4.2; this.spin = 0; }
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
    if (!tgt) { this.walking = false; return; }
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
    Object.assign(this, { kind: 'brute', maxHp: 280, hp: 280, speed: 1.9, atk: 26, r: 0.6, h: 2.6, wallDmg: 4.5, atkRate: 1.4, animSpeed: 4 });
    this.drops = { metal: [3, 1], goo: [2, 0.8] };
    this.goreCol = [0.45, 0.05, 0.08];
    this.removeSprite(); this.makeSprite(tex, 3.4, 3.4, 0.45);
    this.mat.color.setRGB(1.0, 0.7, 0.7);
  }
  contactAttack(tgt: Entity, dist: number): boolean {
    const hit = super.contactAttack(tgt, dist);
    if (hit) { tgt.vel.y += 6; this.game.shake(0.3); this.game.audio.thunk(1); }
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
    if (!tgt) return;
    const c = tgt.center(_v);
    let dx = c.x - this.pos.x, dz = c.z - this.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    this.retreat -= dt;
    let sign = this.retreat > 0 ? -1 : 1;
    const ground = w.surfaceY(Math.floor(this.pos.x), Math.floor(this.pos.z));
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
    Object.assign(this, { kind: 'boss', maxHp: 1600, hp: 1600, speed: 1.6, atk: 30, r: 1.4, h: 3.2 });
    this.drops = { metal: [8, 1], goo: [10, 1] };
    this.removeSprite(); this.makeSprite(tex, 7, 7, 0.35);
    this.mat.color.setRGB(1.0, 0.55, 0.75);
    this.broodCd = 4;
  }
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
    super.die(cause, knock);
    this.game.onBossDefeated(this);
  }
}

// ---------------- turret (3D model, not a sprite) ----------------
export class Turret extends Entity {
  head: THREE.Group;
  grp: THREE.Group;
  cd: number; ammo: number; yaw: number; side: number;
  target: Enemy | null = null; scanT = 0;
  constructor(game: Game, x: number, y: number, z: number) {
    super(game, x, y, z, { kind: 'turret', hp: 160, r: 0.45, h: 1.2 });
    const grp = new THREE.Group();
    grp.add(box(0.9, 0.35, 0.9, 0x5a6470, 0, 0.18, 0));
    grp.add(box(0.5, 0.4, 0.5, 0x48505a, 0, 0.55, 0));
    this.head = new THREE.Group();
    this.head.position.y = 0.95;
    this.head.add(box(0.55, 0.4, 0.6, 0x7a8a96));
    this.head.add(box(0.12, 0.12, 0.7, 0x2a2e36, 0.12, 0, 0.5));
    this.head.add(box(0.12, 0.12, 0.7, 0x2a2e36, -0.12, 0, 0.5));
    this.head.add(box(0.2, 0.08, 0.05, 0xff3a2a, 0, 0.1, 0.31, 0xff2a1a));
    grp.add(this.head);
    grp.position.copy(this.pos);
    grp.traverse(m => { if ((m as THREE.Mesh).isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    this.head.children[3].userData.keep = true;
    this.grp = grp;
    game.scene.add(grp);
    this.cd = 0; this.ammo = 250; this.yaw = 0; this.side = 1;
  }
  update(dt: number) {
    const g = this.game;
    this.physics(dt);
    this.grp.position.copy(this.pos);
    this.cd -= dt;
    // full nearest-visible-enemy scan only a few times a second; in between just re-check the cached target
    this.scanT -= dt;
    if (this.scanT <= 0 || (this.target && (this.target.dead || !this.canSee(this.target, 18 * 18)))) {
      this.scanT = 0.12;
      let best: Enemy | null = null, bd = 18 * 18;
      for (const e of g.entities.enemies) {
        if (e.dead) continue;
        const d = e.pos.distanceToSquared(this.pos);
        if (d < bd && this.canSee(e, bd)) { bd = d; best = e; }
      }
      this.target = best;
    }
    const best = this.target;
    if (best) {
      const to = best.center(new THREE.Vector3());
      const want = Math.atan2(to.x - this.pos.x, to.z - this.pos.z);
      let diff = want - this.yaw; diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.yaw += diff * Math.min(1, dt * 10);
      if (Math.abs(diff) < 0.2 && this.cd <= 0 && this.ammo > 0) {
        this.cd = 0.16 * g.mods.turret; this.ammo--; this.side = -this.side;
        const from = new THREE.Vector3(this.pos.x + Math.cos(this.yaw) * 0.12 * this.side, this.pos.y + 0.95, this.pos.z - Math.sin(this.yaw) * 0.12 * this.side);
        const dir = to.sub(from).normalize();
        from.addScaledVector(dir, 0.8);
        g.projectiles.bullet(from, dir, { dmg: 9, speed: 70, blockDmg: 0.2, owner: this, spread: 0.03 });
        g.particles.muzzle(from.x, from.y, from.z, dir);
        g.audio.shot('turret', Math.max(0.1, 1 - this.pos.distanceTo(g.entities.player.pos) / 30));
      }
    } else this.yaw += dt * 0.5;
    this.head.rotation.y = this.yaw;
    const fl = this.flash > 0 ? 0.8 : 0; this.flash = Math.max(0, this.flash - dt);
    this.grp.traverse(m => { const mat = (m as THREE.Mesh).material as THREE.MeshLambertMaterial | undefined; if ((m as THREE.Mesh).isMesh && mat && mat.emissive && !m.userData.keep) mat.emissive.setRGB(fl, fl, fl); });
    if (this.ammo <= 0 && !this.dead) { this.ammo = 0; g.ui.toast('A turret ran out of ammo'); this.die(); }
  }
  // within range (squared distance < maxD2) and not blocked by voxels
  canSee(e: Enemy, maxD2: number): boolean {
    if (e.pos.distanceToSquared(this.pos) >= maxD2) return false;
    const from = _v.set(this.pos.x, this.pos.y + 0.95, this.pos.z);
    const dir = e.center(_w).sub(from); const L = dir.length(); dir.divideScalar(L);
    return !this.game.world.raycast(from, dir, L).hit;
  }
  die() {
    if (this.dead) return;
    this.dead = true;
    this.game.scene.remove(this.grp);
    this.game.explode(this.pos.clone().add(new THREE.Vector3(0, 0.6, 0)), 2.2, 6, 'turret');
  }
}

// ---------------- manager ----------------
// drop dead entities in place (keeps array identity, no per-frame allocation)
const DESPAWN_RANGE = 90;

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
  walkField: FlowField;
  climbField: FlowField;
  fieldT: number; fieldFlip: boolean; fieldCell: number;
  pickGeo: THREE.BoxGeometry;
  gridHead = new Int32Array(0); gridNext = new Int32Array(0); gridList: Enemy[] = [];
  gridW = 0; gridD = 0; gridMaxR = 0;
  pickMats: Record<string, THREE.MeshLambertMaterial>;
  constructor(game: Game, sheets: Sheets) {
    this.game = game; this.sheets = sheets;
    this.player = null!; this.enemies = []; this.turrets = []; this.pickups = []; this.corpses = [];
    this.spawnT = 3;
    this.walkField = new FlowField(game.world, false);
    this.climbField = new FlowField(game.world, true);
    this.fieldT = 0; this.fieldFlip = false; this.fieldCell = -1;
    this.pickGeo = new THREE.BoxGeometry(0.28, 0.28, 0.28);
    this.pickMats = {
      wood: new THREE.MeshLambertMaterial({ color: 0x9a6a3a }), stone: new THREE.MeshLambertMaterial({ color: 0xa8a6a0 }),
      metal: new THREE.MeshLambertMaterial({ color: 0x9ab4c8, emissive: 0x223344 }), goo: new THREE.MeshLambertMaterial({ color: 0x5adf3a, emissive: 0x1a6a10 }),
    };
  }
  all(): Entity[] { return [this.player, ...this.enemies, ...this.turrets].filter(e => e && !e.dead); }
  // bucket live enemies into a coarse XZ grid (linked lists in typed arrays) for neighbour queries
  buildGrid(): void {
    const w = this.game.world, gw = Math.ceil(w.W / GRID_CELL), gd = Math.ceil(w.D / GRID_CELL);
    if (gw !== this.gridW || gd !== this.gridD) { this.gridW = gw; this.gridD = gd; this.gridHead = new Int32Array(gw * gd); }
    this.gridHead.fill(-1);
    const list = this.gridList; list.length = 0;
    let maxR = 0;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const cx = Math.min(gw - 1, Math.max(0, Math.floor(e.pos.x / GRID_CELL))), cz = Math.min(gd - 1, Math.max(0, Math.floor(e.pos.z / GRID_CELL)));
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
    for (const t of this.turrets) s.remove(t.grp);
    for (const k of this.pickups) s.remove(k.m);
    this.enemies = []; this.corpses = []; this.turrets = []; this.pickups = [];
    this.walkField.ready = this.climbField.ready = false;
    this.fieldCell = -1;
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

  randomSpawnPoint(minD = 24, maxD = 40): Vec3Tuple | null {
    const w = this.game.world, p = this.player.pos;
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2, d = minD + Math.random() * (maxD - minD);
      const x = Math.floor(p.x + Math.cos(a) * d), z = Math.floor(p.z + Math.sin(a) * d);
      if (x < 3 || z < 3 || x > w.W - 4 || z > w.D - 4 || !w.isGenerated(x, z)) continue;
      const y = w.surfaceY(x, z);
      // keep spawns out of the moat and other pools
      if (this.game.waterSim.levelAt(x, y, z) > 0) continue;
      if (y <= WATER_LEVEL + 0.5) continue;
      return [x + 0.5, y + 0.1, z + 0.5];
    }
    return null;
  }

  spawnWave(n: number) {
    for (let i = 0; i < n; i++) {
      const sp = this.randomSpawnPoint(22, 42);
      if (!sp) continue;
      this.spawnEnemy(this.pickType(), ...sp);
    }
  }

  // enemy mix escalates night by night
  pickType(): string {
    const n = this.game.nightCount, night = this.game.isNight(), r = Math.random();
    if (night && n >= 2 && r < 0.08) return 'brute';
    if (night && n >= 1 && r < 0.2) return 'bat';
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

  blocksCell(x: number, y: number, z: number) {
    const hits = (e: Entity) => !e.dead && e.pos.x + e.r > x && e.pos.x - e.r < x + 1 && e.pos.z + e.r > z && e.pos.z - e.r < z + 1 && e.pos.y + e.h > y && e.pos.y < y + 1;
    if (this.player && hits(this.player)) return true;
    for (const e of this.enemies) if (hits(e)) return true;
    for (const t of this.turrets) if (hits(t)) return true;
    return false;
  }

  // nearest entity hit along a segment (sphere approximation)
  raycast(o: THREE.Vector3, d: THREE.Vector3, maxDist: number, ignore?: Entity | null): { e: Entity; t: number } | null {
    // who can be hit depends only on the shooter: the player and turrets are allies, enemies only hurt them
    const ik = ignore ? ignore.kind : '';
    const allyShooter = ik === 'player' || ik === 'turret', enemyShooter = !!ignore && !allyShooter;
    this._best = null; this._bt = maxDist;
    if (this.player && ik !== 'turret' && this.player !== ignore && !this.player.dead) this.rayTest(this.player, o, d);
    if (!enemyShooter) for (const e of this.enemies) if (!e.dead && e !== ignore) this.rayTest(e, o, d);
    if (!allyShooter) for (const t of this.turrets) if (!t.dead && t !== ignore) this.rayTest(t, o, d);
    return this._best ? { e: this._best, t: this._bt } : null;
  }
  private _best: Entity | null = null; private _bt = 0;
  private rayTest(e: Entity, o: THREE.Vector3, d: THREE.Vector3): void {
    const r = e.hitRadius();
    const ox = o.x - e.pos.x, oy = o.y - (e.pos.y + e.h * 0.5), oz = o.z - e.pos.z;
    const b = ox * d.x + oy * d.y + oz * d.z;
    const disc = b * b - (ox * ox + oy * oy + oz * oz - r * r);
    if (disc < 0) return;
    const t = -b - Math.sqrt(disc);
    if (t >= -r && t < this._bt) { this._bt = Math.max(0, t); this._best = e; }
  }

  update(dt: number) {
    const g = this.game;
    // flow fields: recompute one class at a time, when the player moves cell or every second
    this.fieldT -= dt;
    const pc = Math.floor(this.player.pos.x) + Math.floor(this.player.pos.z) * 1000;
    if (this.fieldT <= 0 && (pc !== this.fieldCell || this.fieldT < -1)) {
      this.fieldT = 0.2;
      this.fieldFlip = !this.fieldFlip;
      if (!this.fieldFlip) this.fieldCell = pc;
      (this.fieldFlip ? this.walkField : this.climbField).compute(this.player.pos.x, this.player.pos.y, this.player.pos.z);
    }
    // spawning
    this.spawnT -= dt;
    let alive = 0;
    for (const e of this.enemies) if (!e.dead) alive++;
    const night = g.isNight();
    if (this.spawnT <= 0 && alive < (night ? 45 : 18) && !this.player.dead) {
      this.spawnT = night ? 2.2 : 6.5;
      const sp = this.randomSpawnPoint();
      if (sp) this.spawnEnemy(this.pickType(), ...sp);
    }
    this.buildGrid();
    for (const e of this.enemies) if (!e.dead) e.update(dt);
    for (const t of this.turrets) if (!t.dead) t.update(dt);
    // enemies that wander far from the player despawn quietly (the boss never does)
    const pp = this.player.pos;
    for (const e of this.enemies) {
      if (e.dead || e.kind === 'boss') continue;
      const dx = e.pos.x - pp.x, dz = e.pos.z - pp.z;
      if (dx * dx + dz * dz > DESPAWN_RANGE * DESPAWN_RANGE) { e.dead = true; e.removeSprite(); }
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
        e.mesh.scale.y = Math.max(0.01, 1 - (c.t - 2.6) * 2.5);
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
      } else {
        k.v.y -= G * dt;
        const ny = m.position.y + k.v.y * dt;
        if (k.v.y < 0 && g.world.solidAt(m.position.x, ny - 0.15, m.position.z)) { m.position.y = Math.floor(ny - 0.15) + 1.15; k.v.set(0, 0, 0); }
        else { m.position.y = ny; m.position.x += k.v.x * dt; m.position.z += k.v.z * dt; if (g.world.solidAt(m.position.x, m.position.y, m.position.z)) { m.position.y += 1; } }
      }
      m.rotation.y += dt * 3; m.rotation.x = 0.5;
      if (k.t > 60) { g.scene.remove(m); this.pickups.splice(i, 1); i--; }
    }
  }
}
