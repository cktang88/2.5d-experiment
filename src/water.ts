// Voxel water: a volume-conserving cellular automaton (levels 1..8 per air cell).
// Levels live in each 32³ chunk's `water` array. Water falls, spreads to lower neighbours
// and settles; the sea acts as an infinite source, so craters dug below sea level flood.
// Blowing open a dam drains a lake downhill. Water puts out fire and slows anything wading in it.
import * as THREE from 'three';
import { B, WATER_LEVEL, sharedUniforms, CHUNK, CY, chunkKey } from './world';
import type { World } from './world';
import type { Game } from './main';

export const FULL = 8;
const SOURCE = 0x80;
const LEVEL = 0x0f;
const TICK = 0.09;
const BUDGET = 6000;
const SIM_RANGE = 80;
const NEIGHBOURS_DX = [1, -1, 0, 0];
const NEIGHBOURS_DZ = [0, 0, 1, -1];
// horizontal neighbours whose faces may be exposed: [dx, dz]
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

const WATER_VS = /* glsl */`
uniform float uTime;
varying vec3 vW; varying vec3 vN; varying float vDepthK;
attribute float shade;
#include <fog_pars_vertex>
void main() {
  vec3 p = position;
  // gentle swell on top faces only
  if (normal.y > 0.5) p.y += sin(p.x * 1.3 + uTime * 2.0) * 0.03 + cos(p.z * 1.1 + uTime * 1.6) * 0.03;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vW = wp.xyz; vN = normal; vDepthK = shade;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const WATER_FS = /* glsl */`
uniform float uTime; uniform float uDay; uniform vec3 uCamPos;
varying vec3 vW; varying vec3 vN; varying float vDepthK;
#include <fog_pars_fragment>
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),u.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),u.x), u.y); }
void main() {
  vec3 deep = vec3(0.03, 0.16, 0.32), shallow = vec3(0.12, 0.42, 0.55);
  float w = vn(vW.xz * 1.2 + vec2(uTime * 0.4, uTime * 0.25)) * 0.6 + vn(vW.xz * 3.1 - uTime * 0.5) * 0.4;
  vec3 c = mix(deep, shallow, clamp(vDepthK + w * 0.25, 0.0, 1.0));
  // pixel-quantised caustic glints
  vec2 q = floor(vW.xz * 8.0) / 8.0;
  float spark = step(0.93, vn(q * 2.0 + uTime * 0.7)) * step(0.5, vN.y);
  c += spark * 0.5 * uDay;
  // fresnel-ish rim toward the horizon
  vec3 V = normalize(uCamPos - vW);
  float fr = pow(1.0 - clamp(dot(V, normalize(vN)), 0.0, 1.0), 3.0);
  c = mix(c, vec3(0.6, 0.8, 0.95), fr * 0.2);
  // foam on falling / side faces
  if (vN.y < 0.5) c = mix(c, vec3(0.85, 0.93, 1.0), 0.15 + 0.3 * step(0.62, vn(vec2((vW.x + vW.z) * 3.0, vW.y * 4.0 + uTime * 8.0))));
  c *= mix(0.25, 1.0, uDay);
  gl_FragColor = vec4(c, mix(0.7, 0.88, 1.0 - vDepthK));
  #include <fog_fragment>
}`;

interface WaterMesh { mesh: THREE.Mesh | null; dirty: boolean }

export class Water {
  game: Game;
  world: World;
  /** cells (global block idx) to simulate on the next tick */
  active = new Set<number>();
  next = new Set<number>();
  /** water cells waiting outside the sim range (kept out of `active` so they don't eat its budget) */
  parked = new Set<number>();
  private parkX = NaN; private parkZ = NaN; private parkT = 0; // player position / ticks since parked cells were last checked
  acc = 0;
  /** reusable sorted copy of `active` for tick() (grows on demand) */
  private order = new Float64Array(1024);
  /** water meshes by chunk key */
  meshes = new Map<number, WaterMesh>();
  material: THREE.ShaderMaterial;
  uniforms: Record<string, THREE.IUniform>;
  group = new THREE.Group();

  constructor(game: Game, world: World) {
    this.game = game; this.world = world;
    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 }, uDay: { value: 1 }, uCamPos: { value: new THREE.Vector3() },
    }]);
    this.uniforms.uTime = sharedUniforms.uTime;
    this.material = new THREE.ShaderMaterial({
      vertexShader: WATER_VS, fragmentShader: WATER_FS, uniforms: this.uniforms,
      transparent: true, depthWrite: false, fog: true,
    });
    this.group.renderOrder = 3;
  }

  idx(x: number, y: number, z: number): number { return this.world.idx(x, y, z); }
  // raw water byte of a cell by global index
  private raw(i: number): number { const w = this.world; return w.waterAt(w.ix(i), w.iy(i), w.iz(i)); }
  private put(i: number, v: number): void { const w = this.world; w.setWater(w.ix(i), w.iy(i), w.iz(i), v); }
  level(i: number): number { return this.raw(i) & LEVEL; }
  isSource(i: number): boolean { return (this.raw(i) & SOURCE) !== 0; }
  levelAt(x: number, y: number, z: number): number { return this.world.waterAt(x, y, z) & LEVEL; }

  fill(x: number, y: number, z: number, amount = FULL, source = false): void {
    if (this.world.get(x, y, z) !== B.AIR) return;
    if (!this.world.setWater(x, y, z, Math.min(FULL, amount) | (source ? SOURCE : 0))) return;
    this.markModified(x, y, z);
    this.wake(x, y, z);
  }

  // called whenever a block changes; re-activates water around it
  onBlockChanged(x: number, y: number, z: number, solid: boolean): void {
    const w = this.world;
    if (!w.inBounds(x, y, z)) return;
    if (solid && w.waterAt(x, y, z)) { w.setWater(x, y, z, 0); this.markDirty(x, y, z); }
    this.wake(x, y, z);
  }

  wake(x: number, y: number, z: number): void {
    const w = this.world;
    for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1) continue;
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (nx < 0 || ny < 1 || nz < 0 || nx >= w.W || ny >= w.H || nz >= w.D) continue;
      if (w.waterAt(nx, ny, nz)) this.active.add(this.idx(nx, ny, nz));
    }
    this.markDirty(x, y, z);
  }

  // the water mesh of the chunk holding (x, y, z), plus horizontal neighbours when on a border
  markDirty(x: number, y: number, z: number): void {
    const cx = x >> 5, cy = y >> 5, cz = z >> 5, lx = x & 31, lz = z & 31;
    const mark = (a: number, c: number, b: number) => {
      const ch = this.world.chunk(a, c, b);
      if (!ch) return;
      let m = this.meshes.get(ch.key);
      if (!m) this.meshes.set(ch.key, m = { mesh: null, dirty: true }); else m.dirty = true;
    };
    const layer = (c: number) => {
      mark(cx, c, cz);
      if (lx === 0) mark(cx - 1, c, cz); if (lx === 31) mark(cx + 1, c, cz);
      if (lz === 0) mark(cx, c, cz - 1); if (lz === 31) mark(cx, c, cz + 1);
    };
    layer(cy);
    // the cells below read this one (their top face, and their neighbours' side faces stop at its
    // surface), so on a chunk's bottom layer the chunks below change too; the cell above reads it
    // for its depth shade
    if ((y & 31) === 0) layer(cy - 1);
    if ((y & 31) === 31) mark(cx, cy + 1, cz);
  }

  private markModified(x: number, y: number, z: number): void {
    const ch = this.world.chunkAt(x, y, z);
    if (ch) ch.modified = true;
  }

  // move `amt` units from i to j, keeping both cells active
  private move(i: number, j: number, amt: number): void {
    const ri = this.raw(i), rj = this.raw(j);
    if (!(ri & SOURCE)) this.put(i, (ri & SOURCE) | ((ri & LEVEL) - amt));
    this.put(j, (rj & SOURCE) | Math.min(FULL, (rj & LEVEL) + amt));
    this.next.add(i); this.next.add(j);
    // water that moved makes both chunks part of the save
    const w = this.world;
    this.markModified(w.ix(i), w.iy(i), w.iz(i));
    this.markModified(w.ix(j), w.iy(j), w.iz(j));
  }

  tick(): void {
    const w = this.world, W = w.W, WD = w.W * w.D;
    const count = this.active.size;
    if (this.order.length < count) this.order = new Float64Array(Math.max(count, this.order.length * 2));
    let k = 0;
    for (const i of this.active) this.order[k++] = i;
    this.active.clear();
    // process from the bottom up so falling water settles in one pass (idx is y-major; typed-array sort is numeric)
    const list = this.order.subarray(0, count).sort();
    const px = this.game.player.pos.x, pz = this.game.player.pos.z;
    let n = 0;
    for (let li = 0; li < count; li++) {
      const i = list[li];
      const x = i % W, z = Math.floor(i / W) % w.D, y = Math.floor(i / WD);
      // only simulate near the player; far-away water is parked until we come back (before the
      // budget check: a big flood left behind would otherwise starve the water next to the player)
      if (Math.abs(x - px) > SIM_RANGE || Math.abs(z - pz) > SIM_RANGE) { this.parked.add(i); continue; }
      if (++n > BUDGET) { this.next.add(i); continue; }
      const L = this.levelAt(x, y, z);
      if (!L) continue;
      if (!w.isGenerated(x, z)) continue; // its column was unloaded
      if (w.get(x, y, z) !== B.AIR) { w.setWater(x, y, z, 0); continue; }
      const src = this.isSource(i);
      // shallow films slowly soak into the ground so floods don't leave sheets everywhere
      if (!src && L <= 2 && y > 1 && w.get(x, y - 1, z) !== B.AIR) {
        if (Math.random() < 0.04) { w.setWater(x, y, z, L - 1); this.markDirty(x, y, z); }
        this.next.add(i);
      }
      if (y > 1 && w.get(x, y - 1, z) === B.AIR) {
        const b = i - WD, lb = this.levelAt(x, y - 1, z);
        if (lb < FULL) {
          this.move(i, b, Math.min(L, FULL - lb));
          this.markDirty(x, y, z); this.markDirty(x, y - 1, z);
          continue;
        }
      }
      // spread sideways toward lower neighbours
      let moved = false;
      for (let d = 0; d < 4; d++) {
        const dx = NEIGHBOURS_DX[d], dz = NEIGHBOURS_DZ[d];
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= W || nz >= w.D || !w.isGenerated(nx, nz)) continue;
        if (w.get(nx, y, nz) !== B.AIR) continue;
        const j = i + dx + dz * W;
        const lj = this.levelAt(nx, y, nz);
        const cur = src ? FULL : this.level(i);
        if (cur - lj >= 2 || (cur >= 1 && lj === 0 && w.get(nx, y - 1, nz) === B.AIR)) {
          this.move(i, j, 1);
          moved = true;
          this.markDirty(nx, y, nz);
        }
        if (!src && this.level(i) <= 1) break;
      }
      if (moved) this.markDirty(x, y, z);
    }
    for (const i of this.next) this.active.add(i);
    this.next.clear();
  }

  // parked cells that are back in the sim range become active again (checked when the player has
  // moved a bit, and about once a second)
  private unpark(): void {
    if (!this.parked.size) return;
    const p = this.game.player.pos;
    if (Math.abs(p.x - this.parkX) < 8 && Math.abs(p.z - this.parkZ) < 8 && ++this.parkT < 11) return;
    this.parkX = p.x; this.parkZ = p.z; this.parkT = 0;
    const w = this.world;
    for (const i of this.parked) {
      if (Math.abs(w.ix(i) - p.x) > SIM_RANGE || Math.abs(w.iz(i) - p.z) > SIM_RANGE) continue;
      this.parked.delete(i); this.active.add(i);
    }
  }

  // put out fires next to water (checked from the fire's side, so water that already settled still counts)
  private douse(): void {
    const w = this.world;
    for (const k of [...w.burning.keys()]) {
      const x = w.ix(k), y = w.iy(k), z = w.iz(k);
      if (!(this.levelAt(x, y, z) || this.levelAt(x + 1, y, z) || this.levelAt(x - 1, y, z) || this.levelAt(x, y, z + 1)
        || this.levelAt(x, y, z - 1) || this.levelAt(x, y + 1, z) || this.levelAt(x, y - 1, z))) continue;
      w.burning.delete(k);
      this.game.particles.smokePuff(x + 0.5, y + 0.8, z + 0.5, 3, 0.7);
      this.game.audio.sizzle();
      w.markDirty(x, y, z);
    }
  }

  update(dt: number): void {
    this.acc += dt;
    if (this.acc >= TICK) { this.acc = 0; this.unpark(); if (this.active.size) this.tick(); if (this.world.burning.size) this.douse(); }
    this.uniforms.uDay.value = 0.25 + this.game.dayK * 0.75;
    (this.uniforms.uCamPos.value as THREE.Vector3).copy(this.game.camera.position);
    this.uniforms.fogColor.value = this.game.scene.fog?.color;
    const fog = this.game.scene.fog as THREE.Fog | null;
    if (fog) { this.uniforms.fogNear.value = fog.near; this.uniforms.fogFar.value = fog.far; }
    let built = 0;
    const p = this.game.player ? this.game.player.pos : this.game.camTarget;
    for (const [key, m] of this.meshes) {
      if (!m.dirty) continue;
      const ch = this.world.chunks[key];
      if (!ch) { this.disposeMesh(key); continue; }
      // only build water meshes in view; the rest stays dirty until we come close
      if (Math.max(Math.abs(ch.cx * CHUNK + 16 - p.x), Math.abs(ch.cz * CHUNK + 16 - p.z)) > 180) continue;
      this.buildChunk(key);
      if (++built >= 2) break;
    }
  }

  private disposeMesh(key: number): void {
    const m = this.meshes.get(key);
    if (m && m.mesh) { this.group.remove(m.mesh); m.mesh.geometry.dispose(); }
    this.meshes.delete(key);
  }

  buildChunk(key: number): void {
    const w = this.world, ch = w.chunks[key], m = this.meshes.get(key);
    if (!m) return;
    m.dirty = false;
    if (m.mesh) { this.group.remove(m.mesh); m.mesh.geometry.dispose(); m.mesh = null; }
    if (!ch || !ch.water) return;
    const wv = ch.water;
    const pos: number[] = [], nor: number[] = [], shade: number[] = [], ind: number[] = [];
    const x0 = ch.cx * CHUNK, y0 = ch.cy * CHUNK, z0 = ch.cz * CHUNK;
    const quad = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx2: number, cy: number, cz2: number,
      dx: number, dy: number, dz: number, nx: number, ny: number, nz: number, sh: number) => {
      const base = pos.length / 3;
      pos.push(ax, ay, az, bx, by, bz, cx2, cy, cz2, dx, dy, dz);
      nor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
      shade.push(sh, sh, sh, sh);
      ind.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    for (let li = 0; li < wv.length; li++) {
      const v = wv[li];
      if (!v) continue;
      const L = v & LEVEL;
      const x = x0 + (li & 31), z = z0 + ((li >> 5) & 31), y = y0 + (li >> 10);
      if (!L || y < 1 || ((v & SOURCE) && y < WATER_LEVEL)) continue; // the ocean plane draws the sea
      const above = this.levelAt(x, y + 1, z);
      const top = above ? y + 1 : y + L / FULL - 0.05;
      const depthK = Math.min(1, L / FULL * 0.6 + (this.levelAt(x, y - 1, z) ? 0 : 0.3));
      if (!above) quad(x, top, z + 1, x + 1, top, z + 1, x + 1, top, z, x, top, z, 0, 1, 0, 1 - depthK);
      // sides facing open air (waterfalls / edges)
      for (const [dx, dz] of SIDES) {
        const nx = x + dx, nz = z + dz;
        if (w.get(nx, y, nz) !== B.AIR) continue;
        const nl = this.levelAt(nx, y, nz);
        // only the part of the face that rises above the neighbour's own water surface is visible
        const bot = this.levelAt(nx, y + 1, nz) ? y + 1 : nl ? y + nl / FULL - 0.05 : y;
        if (top - bot < 0.05) continue;
        if (dx === 1) quad(x + 1, bot, z + 1, x + 1, bot, z, x + 1, top, z, x + 1, top, z + 1, 1, 0, 0, 0.5);
        else if (dx === -1) quad(x, bot, z, x, bot, z + 1, x, top, z + 1, x, top, z, -1, 0, 0, 0.5);
        else if (dz === 1) quad(x, bot, z + 1, x + 1, bot, z + 1, x + 1, top, z + 1, x, top, z + 1, 0, 0, 1, 0.5);
        else quad(x + 1, bot, z, x, bot, z, x, top, z, x + 1, top, z, 0, 0, -1, 0.5);
      }
    }
    if (!ind.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('shade', new THREE.Float32BufferAttribute(shade, 1));
    geo.setIndex(ind);
    geo.computeBoundingSphere();
    m.mesh = new THREE.Mesh(geo, this.material);
    m.mesh.renderOrder = 3;
    this.group.add(m.mesh);
  }

  // a freshly generated (or loaded) column: wake its non-source water (moats, reservoirs) and mesh it
  activateColumn(cx: number, cz: number): void {
    const w = this.world;
    for (let cy = 0; cy < CY; cy++) {
      const ch = w.chunk(cx, cy, cz);
      if (!ch || !ch.water) continue;
      const wv = ch.water, x0 = cx * CHUNK, y0 = cy * CHUNK, z0 = cz * CHUNK;
      let any = false;
      for (let li = 0; li < wv.length; li++) {
        const v = wv[li];
        if (!v) continue;
        if (!(v & SOURCE) || y0 + (li >> 10) >= WATER_LEVEL) any = true;
        if (!(v & SOURCE)) this.active.add(w.idx(x0 + (li & 31), y0 + (li >> 10), z0 + ((li >> 5) & 31)));
      }
      if (any) { const m = this.meshes.get(ch.key); if (m) m.dirty = true; else this.meshes.set(ch.key, { mesh: null, dirty: true }); }
      // neighbours' side faces may change too
      for (const [dx, dz] of SIDES) { const n = w.chunk(cx + dx, cy, cz + dz); if (n) { const m = this.meshes.get(n.key); if (m) m.dirty = true; } }
    }
  }

  /** a column is being unloaded: forget its meshes and active cells */
  dropColumn(cx: number, cz: number): void {
    for (let cy = 0; cy < CY; cy++) this.disposeMesh(chunkKey(cx, cy, cz));
    const w = this.world, x0 = cx * CHUNK, z0 = cz * CHUNK;
    for (const set of [this.active, this.parked])
      for (const i of set) { const x = w.ix(i), z = w.iz(i); if (x >= x0 && x < x0 + CHUNK && z >= z0 && z < z0 + CHUNK) set.delete(i); }
  }

  /** drop every mesh and active cell (loading a save) */
  reset(): void {
    for (const key of [...this.meshes.keys()]) this.disposeMesh(key);
    this.active.clear(); this.next.clear(); this.parked.clear();
  }
}

