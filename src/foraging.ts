// Deterministic, local food plants and passive wildlife. The host game keeps wildlife
// in its own Entity[] so it participates in combat raycasts without joining hostile waves.
import * as THREE from 'three';
import { B, hash3 } from './world';
import { Enemy, type EnemyOpts } from './entities';
import type { Game } from './main';

export type ForageFood = 'apple' | 'berries' | 'meat';
export interface ForageReward { food: ForageFood; amount: number; name: string }
export interface ForageNode {
  id: string;
  food: 'apple' | 'berries';
  amount: number;
  name: string;
  position: THREE.Vector3;
  host: [number, number, number];
  hostType: 'leaf' | 'decor';
  mesh: THREE.Object3D;
}
export interface ForageHit { node: ForageNode; distance: number; point: THREE.Vector3 }
export interface ForagingSave { harvested: string[]; animalCooldown?: [string, number][] }

const SCAN_RADIUS = 25;
const SCAN_INTERVAL = 4;
const MAX_NODES = 64;
const MAX_ANIMALS = 4;
const HARVEST_REACH = 3;
const APPLE_GEO = new THREE.SphereGeometry(0.16, 10, 8);
const STEM_GEO = new THREE.CylinderGeometry(0.018, 0.025, 0.11, 5);
const BERRY_GEO = new THREE.SphereGeometry(0.075, 8, 6);
const BUSH_GEO = new THREE.SphereGeometry(0.33, 8, 6);
const ANIMAL_BODY_GEO = new THREE.SphereGeometry(1, 12, 8);
const ANIMAL_HEAD_GEO = new THREE.SphereGeometry(1, 10, 7);
const ANIMAL_LEG_GEO = new THREE.CylinderGeometry(0.075, 0.11, 0.48, 7);
const ANIMAL_NOSE_GEO = new THREE.ConeGeometry(0.13, 0.33, 8);
const ANIMAL_ANTLER_GEO = new THREE.CylinderGeometry(0.025, 0.045, 0.44, 5);
const PLANT_MATS = {
  apple: new THREE.MeshLambertMaterial({ color: 0xd9362b, emissive: 0x240400 }),
  appleGold: new THREE.MeshLambertMaterial({ color: 0xffb832, emissive: 0x241300 }),
  stem: new THREE.MeshLambertMaterial({ color: 0x513820 }),
  bush: new THREE.MeshLambertMaterial({ color: 0x497b36 }),
  berry: new THREE.MeshLambertMaterial({ color: 0x5d298b, emissive: 0x160922 }),
  deer: new THREE.MeshLambertMaterial({ color: 0x9a633c }),
  deerLight: new THREE.MeshLambertMaterial({ color: 0xe5c990 }),
  hoof: new THREE.MeshLambertMaterial({ color: 0x39302a }),
  antler: new THREE.MeshLambertMaterial({ color: 0xd7c39b }),
  boar: new THREE.MeshLambertMaterial({ color: 0x4f3a32 }),
  boarLight: new THREE.MeshLambertMaterial({ color: 0x927264 }),
  tusk: new THREE.MeshLambertMaterial({ color: 0xf2e7cf }),
};

const unitSphereHit = (origin: THREE.Vector3, direction: THREE.Vector3, center: THREE.Vector3, radius: number): number => {
  const ox = origin.x - center.x, oy = origin.y - center.y, oz = origin.z - center.z;
  const b = ox * direction.x + oy * direction.y + oz * direction.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : (-b + Math.sqrt(disc) >= 0 ? -b + Math.sqrt(disc) : Infinity);
};

function foodNodeId(kind: 'apple' | 'berries', x: number, y: number, z: number, ordinal = 0): string {
  return `${kind}:${x},${y},${z}:${ordinal}`;
}

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

function appleModel(seed: number): THREE.Group {
  const group = new THREE.Group();
  group.add(mesh(APPLE_GEO, seed % 3 === 0 ? PLANT_MATS.appleGold : PLANT_MATS.apple));
  const stem = mesh(STEM_GEO, PLANT_MATS.stem, 0, 0.19, 0);
  stem.rotation.z = -0.22;
  group.add(stem);
  return group;
}

function berriesModel(seed: number): THREE.Group {
  const group = new THREE.Group();
  group.add(mesh(BUSH_GEO, PLANT_MATS.bush, 0, 0.22, 0));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + (seed % 17) * 0.1;
    group.add(mesh(BERRY_GEO, PLANT_MATS.berry, Math.cos(a) * 0.23, 0.35 + (i % 2) * 0.1, Math.sin(a) * 0.23));
  }
  return group;
}

function animalModel(kind: 'deer' | 'boar'): THREE.Group {
  const group = new THREE.Group();
  const boar = kind === 'boar';
  const body = mesh(ANIMAL_BODY_GEO, boar ? PLANT_MATS.boar : PLANT_MATS.deer, 0, boar ? 0.7 : 0.93, 0);
  body.scale.set(boar ? 0.74 : 0.82, boar ? 0.55 : 0.46, boar ? 1.04 : 0.88);
  // The first two and last two parts are legs; Entity.updateSprite animates them in pairs.
  const legAt = [[-.34, .44, .34], [.34, .44, .34], [-.34, .44, -.34], [.34, .44, -.34]];
  const legs: THREE.Mesh[] = [];
  for (const [x, y, z] of legAt) {
    const leg = mesh(ANIMAL_LEG_GEO, boar ? PLANT_MATS.boar : PLANT_MATS.deer, x, y, z);
    legs.push(leg);
  }
  const headGroup = new THREE.Group();
  if (boar) {
    const head = mesh(ANIMAL_HEAD_GEO, PLANT_MATS.boarLight, 0, 1.07, 0.68); head.scale.set(0.36, 0.31, 0.42); headGroup.add(head);
    const snout = mesh(ANIMAL_NOSE_GEO, PLANT_MATS.boarLight, 0, 1.01, 1.0); snout.rotation.x = Math.PI / 2; headGroup.add(snout);
    for (const side of [-1, 1]) {
      const tusk = mesh(ANIMAL_NOSE_GEO, PLANT_MATS.tusk, side * 0.26, 0.86, 0.84); tusk.scale.setScalar(0.52); tusk.rotation.x = Math.PI * 0.94; headGroup.add(tusk);
      const ear = mesh(ANIMAL_NOSE_GEO, PLANT_MATS.boar, side * 0.27, 1.29, 0.55); ear.scale.set(0.5, 0.6, 0.5); ear.rotation.z = side * 0.6; headGroup.add(ear);
    }
  } else {
    const neck = mesh(ANIMAL_BODY_GEO, PLANT_MATS.deer, 0, 1.2, 0.56); neck.scale.set(0.25, 0.55, 0.28); neck.rotation.x = -0.28; headGroup.add(neck);
    const head = mesh(ANIMAL_HEAD_GEO, PLANT_MATS.deerLight, 0, 1.56, 0.81); head.scale.set(0.24, 0.25, 0.32); headGroup.add(head);
    for (const side of [-1, 1]) {
      const ear = mesh(ANIMAL_NOSE_GEO, PLANT_MATS.deer, side * 0.2, 1.73, 0.74); ear.scale.set(0.45, 0.6, 0.4); ear.rotation.z = side * 0.65; headGroup.add(ear);
      const antler = mesh(ANIMAL_ANTLER_GEO, PLANT_MATS.antler, side * 0.12, 1.9, 0.8); antler.rotation.z = side * 0.28; headGroup.add(antler);
    }
  }
  // Order matters for the shared gait animation: front legs, body/head, hind legs.
  group.add(legs[0], legs[1], body, headGroup, legs[2], legs[3]);
  return group;
}

export class Wildlife extends Enemy {
  readonly spawnId: string;
  fleeingFor = 0;

  constructor(game: Game, x: number, y: number, z: number, kind: 'deer' | 'boar', spawnId: string) {
    const isBoar = kind === 'boar';
    const options: EnemyOpts = {
      kind, tex: game.entities.sheets.spitter, hp: isBoar ? 52 : 34,
      speed: isBoar ? 3.2 : 4.1, atk: 0, r: isBoar ? 0.52 : 0.38, h: isBoar ? 1.25 : 1.8,
      gore: [0.52, 0.28, 0.18], drops: { meat: [isBoar ? 2 : 1, 1] },
    };
    super(game, x, y, z, options);
    this.spawnId = spawnId;
    this.model3d?.parent?.remove(this.model3d);
    this.model3d = animalModel(kind);
    game.scene.add(this.model3d);
    if (this.farModel) {
      this.farModel.geometry = ANIMAL_BODY_GEO;
      this.farModel.material = isBoar ? PLANT_MATS.boar : PLANT_MATS.deer;
      this.farModel.scale.set(isBoar ? 0.9 : 0.92, isBoar ? 0.66 : 0.7, isBoar ? 1.2 : 1.05);
    }
    this.blob.visible = false;
  }

  think(dt: number): void {
    if (this.fleeingFor > 0) {
      this.fleeingFor = Math.max(0, this.fleeingFor - dt);
      this.steer(dt, this.game.entities.player, 1.45, true);
    } else this.wander(dt);
  }

  damage(amount: number, knock?: THREE.Vector3 | null, cause?: string): void {
    if (amount > 0 && !this.dead) this.fleeingFor = 8;
    super.damage(amount, knock, cause);
  }
}

export class Foraging {
  readonly wildlife: Wildlife[] = [];
  private readonly game: Game;
  private nodes = new Map<string, ForageNode>();
  private harvested = new Set<string>();
  private scanTimer = 0;
  private animalCooldown = new Map<string, number>();
  private _worldHit = new THREE.Vector3();

  constructor(game: Game) { this.game = game; }

  get targets(): readonly ForageNode[] { return [...this.nodes.values()]; }

  /** Nearby deterministic sampling only; call with active gameplay dt. */
  update(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0 || this.game.player.dead) return;
    this.scanTimer -= dt;
    for (const [id, time] of this.animalCooldown) {
      const left = time - dt;
      if (left <= 0) this.animalCooldown.delete(id); else this.animalCooldown.set(id, left);
    }
    const player = this.game.player.pos;
    for (const [id, node] of this.nodes) {
      const dx = node.position.x - player.x, dz = node.position.z - player.z;
      if (dx * dx + dz * dz > 40 * 40) { this.game.scene.remove(node.mesh); this.nodes.delete(id); }
    }
    this.updateFruitHosts();
    if (this.scanTimer > 0) return;
    this.scanTimer = SCAN_INTERVAL;
    this.scanPlants();
    this.scanWildlife();
  }

  private addFruitNode(id: string, food: 'apple' | 'berries', amount: number, host: [number, number, number], hostType: 'leaf' | 'decor', position: THREE.Vector3): void {
    if (this.nodes.has(id) || this.harvested.has(id) || this.nodes.size >= MAX_NODES) return;
    const model = food === 'apple' ? appleModel(hash3(host[0], host[2], this.game.world.seed) * 1000 | 0) : berriesModel(hash3(host[0], host[2], this.game.world.seed) * 1000 | 0);
    model.position.copy(position);
    model.traverse(part => { if (part instanceof THREE.Mesh) part.castShadow = false; });
    this.game.scene.add(model);
    this.nodes.set(id, { id, food, amount, name: food === 'apple' ? 'Apple' : 'Wild berries', position: position.clone(), host, hostType, mesh: model });
  }

  private scanPlants(): void {
    const { world, player } = this.game;
    const x0 = Math.max(3, Math.floor(player.pos.x - SCAN_RADIUS)), x1 = Math.min(world.W - 4, Math.floor(player.pos.x + SCAN_RADIUS));
    const z0 = Math.max(3, Math.floor(player.pos.z - SCAN_RADIUS)), z1 = Math.min(world.D - 4, Math.floor(player.pos.z + SCAN_RADIUS));
    // Exact local sample of tree bases, at most ~2,600 columns every four seconds.
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      if (!world.isGenerated(x, z)) continue;
      const baseY = world.gen.treeAt(x, z);
      if (baseY > 0) this.addTreeFruit(x, baseY, z);
      const groundY = world.surfaceY(x, z);
      const decor = world.decorAt(x, groundY, z);
      if ((decor === 7 || decor === 8) && hash3(x, z, world.seed + 784) > 0.52) {
        const id = foodNodeId('berries', x, groundY, z);
        this.addFruitNode(id, 'berries', 3, [x, groundY, z], 'decor', new THREE.Vector3(x + 0.5, groundY + 0.05, z + 0.5));
      }
      if (this.nodes.size >= MAX_NODES) return;
    }
  }

  private addTreeFruit(x: number, baseY: number, z: number): void {
    const { world } = this.game;
    const height = 4 + ((hash3(x, z, 3) * 3) | 0);
    const canopyY = baseY + height;
    for (let ordinal = 0; ordinal < 2; ordinal++) {
      if (hash3(x + ordinal * 17, z - ordinal * 11, world.seed + 510) < 0.46) continue;
      const id = foodNodeId('apple', x, baseY, z, ordinal);
      if (this.nodes.has(id) || this.harvested.has(id)) continue;
      for (let attempt = 0; attempt < 32; attempt++) {
        const dx = ((hash3(x + attempt, z + ordinal * 31, world.seed + 511) * 7) | 0) - 3;
        const dz = ((hash3(x - attempt, z + ordinal * 29, world.seed + 512) * 7) | 0) - 3;
        const dy = canopyY - 2 + ((hash3(x + ordinal * 13, z + attempt, world.seed + 513) * 4) | 0);
        const hx = x + dx, hz = z + dz;
        if (world.get(hx, dy, hz) !== B.LEAVES) continue;
        // Fruit must sit outside an opaque leaf, with enough clearance to see it.
        // Prefer the underside so the stem visibly meets the canopy.
        let pos: THREE.Vector3 | null = null;
        if (world.get(hx, dy - 1, hz) === B.AIR) pos = new THREE.Vector3(hx + 0.5, dy - 0.18, hz + 0.5);
        else for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (world.get(hx + sx, dy, hz + sz) === B.AIR) {
            pos = new THREE.Vector3(hx + 0.5 + sx * 0.66, dy + 0.5, hz + 0.5 + sz * 0.66);
            break;
          }
        }
        if (!pos) continue;
        this.addFruitNode(id, 'apple', 1, [hx, dy, hz], 'leaf', pos);
        break;
      }
    }
  }

  private updateFruitHosts(): void {
    const { world, entities, scene } = this.game;
    for (const [id, node] of this.nodes) {
      const [x, y, z] = node.host;
      if (!world.isGenerated(x, z)) {
        scene.remove(node.mesh); this.nodes.delete(id); continue;
      }
      const stillThere = node.hostType === 'leaf' ? world.get(x, y, z) === B.LEAVES : world.decorAt(x, y, z) > 0;
      if (stillThere) continue;
      scene.remove(node.mesh); this.nodes.delete(id); this.harvested.add(id);
      const dropY = world.surfaceY(x, z) + 0.2;
      entities.addPickup(node.food, node.amount, x + 0.5, dropY, z + 0.5);
    }
  }

  /** Return the nearest looked-at node within 3 m, ignoring foliage but respecting solid walls. */
  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance = HARVEST_REACH): ForageHit | null {
    const dir = _forageDir.copy(direction).normalize();
    let best: ForageHit | null = null;
    for (const node of this.nodes.values()) {
      const t = unitSphereHit(origin, dir, node.position, node.food === 'apple' ? 0.3 : 0.52);
      if (t > maxDistance || (best && t >= best.distance)) continue;
      const obstruction = this.game.world.raycast(origin, dir, t + 0.04, (_x, _y, _z, block) => block === B.LEAVES);
      if (obstruction.hit && obstruction.t < t - 0.08) continue;
      this._worldHit.set(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
      best = { node, distance: t, point: this._worldHit.clone() };
    }
    return best;
  }

  /** Revalidate proximity and line of sight to prevent stale or through-wall harvesting. */
  interact(hit: ForageHit | null): ForageReward | null {
    if (!hit || this.game.player.dead) return null;
    const node = this.nodes.get(hit.node.id);
    if (!node || node !== hit.node) return null;
    const eye = _forageEye.copy(this.game.player.pos); eye.y += 1.45;
    const delta = node.position.clone().sub(eye), distance = delta.length();
    if (distance > HARVEST_REACH || distance < 1e-5) return null;
    delta.divideScalar(distance);
    const obstruction = this.game.world.raycast(eye, delta, distance + 0.04, (_x, _y, _z, block) => block === B.LEAVES);
    if (obstruction.hit && obstruction.t < distance - 0.08) return null;
    this.nodes.delete(node.id); this.harvested.add(node.id); this.game.scene.remove(node.mesh);
    return { food: node.food, amount: node.amount, name: node.name };
  }

  private scanWildlife(): void {
    const { world, player } = this.game;
    for (let i = this.wildlife.length - 1; i >= 0; i--) {
      const animal = this.wildlife[i];
      if (animal.dead) { this.animalCooldown.set(animal.spawnId, 180); this.wildlife.splice(i, 1); continue; }
      if (animal.pos.distanceToSquared(player.pos) > 64 * 64 || Math.abs(animal.pos.y - player.pos.y) > 20) {
        animal.dead = true; animal.removeSprite(); this.wildlife.splice(i, 1);
      }
    }
    if (this.wildlife.length >= MAX_ANIMALS) return;
    const gx0 = Math.floor((player.pos.x - 40) / 16), gx1 = Math.floor((player.pos.x + 40) / 16);
    const gz0 = Math.floor((player.pos.z - 40) / 16), gz1 = Math.floor((player.pos.z + 40) / 16);
    const candidates: { id: string; x: number; z: number; hash: number }[] = [];
    for (let gz = gz0; gz <= gz1; gz++) for (let gx = gx0; gx <= gx1; gx++) {
      const hash = hash3(gx, gz, world.seed + 922);
      if (hash > 0.24) continue;
      const ox = 2 + Math.floor(hash3(gx, gz, world.seed + 923) * 12);
      const oz = 2 + Math.floor(hash3(gx, gz, world.seed + 924) * 12);
      const id = `animal:${gx}:${gz}`;
      if (this.animalCooldown.has(id) || this.wildlife.some(a => a.spawnId === id)) continue;
      candidates.push({ id, x: gx * 16 + ox, z: gz * 16 + oz, hash });
    }
    candidates.sort((a, b) => a.hash - b.hash);
    for (const candidate of candidates) {
      if (this.wildlife.length >= MAX_ANIMALS) break;
      const { x, z, id } = candidate;
      if (x < 3 || z < 3 || x >= world.W - 3 || z >= world.D - 3 || !world.isGenerated(x, z)) continue;
      const dist2 = (x + 0.5 - player.pos.x) ** 2 + (z + 0.5 - player.pos.z) ** 2;
      if (dist2 < 10 * 10 || dist2 > 40 * 40) continue;
      const y = world.surfaceY(x, z);
      if (world.get(x, y - 1, z) !== B.GRASS || world.get(x, y, z) !== B.AIR || world.waterAt(x, y, z) > 0) continue;
      const kind = hash3(x, z, world.seed + 925) < 0.58 ? 'deer' : 'boar';
      const animal = new Wildlife(this.game, x + 0.5, y + 0.01, z + 0.5, kind, id);
      this.wildlife.push(animal);
    }
  }

  /** Called by the host when it removes an animal from the active wildlife collection. */
  onWildlifeRemoved(animal: Wildlife, killed = false): void {
    const i = this.wildlife.indexOf(animal);
    if (i >= 0) this.wildlife.splice(i, 1);
    if (killed) this.animalCooldown.set(animal.spawnId, 180);
  }

  snapshot(): ForagingSave {
    const cooldown = new Map(this.animalCooldown);
    // A save can happen in the same frame as a kill, before the next wildlife scan.
    for (const animal of this.wildlife) if (animal.dead) cooldown.set(animal.spawnId, 180);
    return { harvested: [...this.harvested].sort(), animalCooldown: [...cooldown] };
  }

  restore(state?: Partial<ForagingSave> | null): void {
    for (const node of this.nodes.values()) this.game.scene.remove(node.mesh);
    this.nodes.clear(); this.harvested.clear();
    for (const animal of this.wildlife) { animal.dead = true; animal.removeSprite(); }
    this.wildlife.length = 0;
    this.animalCooldown.clear();
    if (Array.isArray(state?.harvested)) for (const id of state.harvested) if (typeof id === 'string') this.harvested.add(id);
    if (Array.isArray(state?.animalCooldown)) for (const entry of state.animalCooldown) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && Number.isFinite(entry[1]) && entry[1] > 0) this.animalCooldown.set(entry[0], Math.min(180, entry[1]));
    }
    this.scanTimer = 0;
  }
}

const _forageDir = new THREE.Vector3();
const _forageEye = new THREE.Vector3();

/** Pure stable ID helper exported for persistence tests and save inspection. */
export const forageIdForTesting = foodNodeId;
