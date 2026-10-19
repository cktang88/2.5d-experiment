// Voxel water: a volume-conserving cellular automaton (levels 1..8 per air cell).
// Water falls, spreads to lower neighbours and settles; the ocean around the
// island acts as an infinite source, so craters dug below sea level flood.
// Blowing open a dam drains a lake downhill. Water puts out fire and slows anything wading in it.
import * as THREE from 'three';
import { B, WATER_LEVEL, sharedUniforms } from './world';
import type { World } from './world';
import type { Game } from './main';

export const FULL = 8;
const SOURCE = 0x80;
const LEVEL = 0x0f;
const CHUNK = 16;
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

interface WaterChunk { mesh: THREE.Mesh | null; dirty: boolean }

export class Water {
  game: Game;
  world: World;
  lv: Uint8Array;
  active = new Set<number>();
  next = new Set<number>();
  acc = 0;
  /** reusable sorted copy of `active` for tick() (grows on demand) */
  private order = new Int32Array(1024);
  private ncx: number;
  private ncz: number;
  chunks: WaterChunk[] = [];
  material: THREE.ShaderMaterial;
  uniforms: Record<string, THREE.IUniform>;
  group = new THREE.Group();

  constructor(game: Game, world: World) {
    this.game = game; this.world = world;
    this.lv = new Uint8Array(world.W * world.H * world.D);
    const ncx = this.ncx = Math.ceil(world.W / CHUNK), ncz = this.ncz = Math.ceil(world.D / CHUNK);
    for (let i = 0; i < ncx * ncz; i++) this.chunks.push({ mesh: null, dirty: true });
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

  idx(x: number, y: number, z: number): number { return x + z * this.world.W + y * this.world.W * this.world.D; }
  level(i: number): number { return this.lv[i] & LEVEL; }
  isSource(i: number): boolean { return (this.lv[i] & SOURCE) !== 0; }
  levelAt(x: number, y: number, z: number): number {
    const w = this.world;
    if (x < 0 || z < 0 || y < 0 || x >= w.W || z >= w.D || y >= w.H) return 0;
    return this.lv[this.idx(x, y, z)] & LEVEL;
  }

  fill(x: number, y: number, z: number, amount = FULL, source = false): void {
    if (this.world.get(x, y, z) !== B.AIR) return;
    const i = this.idx(x, y, z);
    this.lv[i] = Math.min(FULL, amount) | (source ? SOURCE : 0);
    this.wake(x, y, z);
  }

  // called whenever a block changes; re-activates water around it
  onBlockChanged(x: number, y: number, z: number, solid: boolean): void {
    const w = this.world;
    if (!w.inBounds(x, y, z)) return;
    const i = this.idx(x, y, z);
    if (solid && this.lv[i]) { this.lv[i] = 0; this.markDirty(x, z); }
    this.wake(x, y, z);
  }

  wake(x: number, y: number, z: number): void {
    const w = this.world;
    for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1) continue;
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (nx < 0 || ny < 1 || nz < 0 || nx >= w.W || ny >= w.H || nz >= w.D) continue;
      const ni = this.idx(nx, ny, nz);
      if (this.lv[ni]) this.active.add(ni);
    }
    this.markDirty(x, z);
  }

  markDirty(x: number, z: number): void {
    const ncx = this.ncx;
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    for (let a = cx - 1; a <= cx + 1; a++) for (let b = cz - 1; b <= cz + 1; b++) {
      if (a < 0 || b < 0 || a >= ncx || b >= this.ncz) continue;
      // only neighbours when on a chunk border
      if ((a !== cx && x % CHUNK !== 0 && x % CHUNK !== CHUNK - 1) || (b !== cz && z % CHUNK !== 0 && z % CHUNK !== CHUNK - 1)) continue;
      this.chunks[a + b * ncx].dirty = true;
    }
  }

  // move `amt` units from i to j, keeping both cells active
  private move(i: number, j: number, amt: number): void {
    if (!this.isSource(i)) this.lv[i] = (this.lv[i] & SOURCE) | (this.level(i) - amt);
    const nl = Math.min(FULL, this.level(j) + amt);
    this.lv[j] = (this.lv[j] & SOURCE) | nl;
    this.next.add(i); this.next.add(j);
    // water that moved makes both chunks part of the save
    const w = this.world, mod = w.modified;
    mod[((i % w.W) >> 4) + ((Math.floor(i / w.W) % w.D) >> 4) * w.cx] = 1;
    mod[((j % w.W) >> 4) + ((Math.floor(j / w.W) % w.D) >> 4) * w.cx] = 1;
  }

  tick(): void {
    const w = this.world, W = w.W, WD = w.W * w.D, data = w.data;
    const count = this.active.size;
    if (this.order.length < count) this.order = new Int32Array(Math.max(count, this.order.length * 2));
    let k = 0;
    for (const i of this.active) this.order[k++] = i;
    this.active.clear();
    // process from the bottom up so falling water settles in one pass (typed-array sort is numeric)
    const list = this.order.subarray(0, count).sort();
    const burning = w.burning;
    const px = this.game.player.pos.x, pz = this.game.player.pos.z;
    let n = 0;
    for (let li = 0; li < count; li++) {
      const i = list[li];
      if (++n > BUDGET) { this.next.add(i); continue; }
      const L = this.level(i);
      if (!L) continue;
      const x = i % W, z = Math.floor(i / W) % w.D, y = Math.floor(i / WD);
      // only simulate near the player; far-away water waits until we come back
      if (Math.abs(x - px) > SIM_RANGE || Math.abs(z - pz) > SIM_RANGE) { this.next.add(i); continue; }
      if (data[i] !== B.AIR) { this.lv[i] = 0; continue; }
      const src = this.isSource(i);
      // shallow films slowly soak into the ground so floods don't leave sheets everywhere
      if (!src && L <= 2 && y > 1 && data[i - WD] !== B.AIR) {
        if (Math.random() < 0.04) { this.lv[i] = L - 1; this.markDirty(x, z); }
        this.next.add(i);
      }
      if (y > 1) {
        const b = i - WD;
        if (data[b] === B.AIR && this.level(b) < FULL) {
          this.move(i, b, Math.min(L, FULL - this.level(b)));
          this.markDirty(x, z);
          continue;
        }
      }
      // spread sideways toward lower neighbours
      let moved = false;
      for (let d = 0; d < 4; d++) {
        const dx = NEIGHBOURS_DX[d], dz = NEIGHBOURS_DZ[d];
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= W || nz >= w.D) continue;
        const j = i + dx + dz * W;
        if (data[j] !== B.AIR) continue;
        const lj = this.level(j);
        const cur = src ? FULL : this.level(i);
        if (cur - lj >= 2 || (cur >= 1 && lj === 0 && data[j - WD] === B.AIR)) {
          this.move(i, j, 1);
          moved = true;
          this.markDirty(nx, nz);
        }
        if (!src && this.level(i) <= 1) break;
      }
      if (moved) this.markDirty(x, z);
      // put out fires next to water
      if (burning.size) {
        for (let d = 0; d < 6; d++) {
          const k = d === 0 ? i + 1 : d === 1 ? i - 1 : d === 2 ? i + W : d === 3 ? i - W : d === 4 ? i + WD : i - WD;
          if (burning.has(k)) { burning.delete(k); const kx = k % W, kz = Math.floor(k / W) % w.D, ky = Math.floor(k / WD); this.game.particles.smokePuff(kx + 0.5, ky + 0.8, kz + 0.5, 3, 0.7); this.game.audio.sizzle(); w.markDirty(kx, kz); }
        }
      }
    }
    for (const i of this.next) this.active.add(i);
    this.next.clear();
  }

  update(dt: number): void {
    this.acc += dt;
    if (this.acc >= TICK) { this.acc = 0; if (this.active.size) this.tick(); }
    this.uniforms.uDay.value = 0.25 + this.game.dayK * 0.75;
    (this.uniforms.uCamPos.value as THREE.Vector3).copy(this.game.camera.position);
    this.uniforms.fogColor.value = this.game.scene.fog?.color;
    const fog = this.game.scene.fog as THREE.Fog | null;
    if (fog) { this.uniforms.fogNear.value = fog.near; this.uniforms.fogFar.value = fog.far; }
    let built = 0;
    const ncx = this.ncx;
    for (let c = 0; c < this.chunks.length && built < 2; c++) {
      if (!this.chunks[c].dirty) continue;
      this.buildChunk(c % ncx, Math.floor(c / ncx));
      built++;
    }
  }

  buildChunk(cx: number, cz: number): void {
    const w = this.world, ch = this.chunks[cx + cz * this.ncx];
    ch.dirty = false;
    const pos: number[] = [], nor: number[] = [], shade: number[] = [], ind: number[] = [];
    const x0 = cx * CHUNK, z0 = cz * CHUNK, x1 = Math.min(x0 + CHUNK, w.W), z1 = Math.min(z0 + CHUNK, w.D);
    const quad = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx2: number, cy: number, cz2: number,
      dx: number, dy: number, dz: number, nx: number, ny: number, nz: number, sh: number) => {
      const base = pos.length / 3;
      pos.push(ax, ay, az, bx, by, bz, cx2, cy, cz2, dx, dy, dz);
      nor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
      shade.push(sh, sh, sh, sh);
      ind.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    for (let y = 1; y < w.H; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      const i = this.idx(x, y, z);
      const L = this.level(i);
      if (!L || (this.isSource(i) && y < WATER_LEVEL)) continue; // the ocean plane draws the sea
      const above = y + 1 < w.H ? this.level(i + w.W * w.D) : 0;
      const top = above ? y + 1 : y + L / FULL - 0.05;
      const depthK = Math.min(1, L / FULL * 0.6 + (this.level(i - w.W * w.D) ? 0 : 0.3));
      if (!above) quad(x, top, z + 1, x + 1, top, z + 1, x + 1, top, z, x, top, z, 0, 1, 0, 1 - depthK);
      // sides facing open air (waterfalls / edges)
      for (const [dx, dz] of SIDES) {
        const nx = x + dx, nz = z + dz;
        if (w.get(nx, y, nz) !== B.AIR) continue;
        const nl = this.levelAt(nx, y, nz);
        if (nl >= L && !above) continue;
        const bot = y + (above ? 0 : Math.min(nl, L) / FULL);
        if (top - bot < 0.05) continue;
        if (dx === 1) quad(x + 1, bot, z + 1, x + 1, bot, z, x + 1, top, z, x + 1, top, z + 1, 1, 0, 0, 0.5);
        else if (dx === -1) quad(x, bot, z, x, bot, z + 1, x, top, z + 1, x, top, z, -1, 0, 0, 0.5);
        else if (dz === 1) quad(x, bot, z + 1, x + 1, bot, z + 1, x + 1, top, z + 1, x, top, z + 1, 0, 0, 1, 0.5);
        else quad(x + 1, bot, z, x, bot, z, x, top, z, x + 1, top, z, 0, 0, -1, 0.5);
      }
    }
    if (ch.mesh) { this.group.remove(ch.mesh); ch.mesh.geometry.dispose(); ch.mesh = null; }
    if (!ind.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('shade', new THREE.Float32BufferAttribute(shade, 1));
    geo.setIndex(ind);
    geo.computeBoundingSphere();
    ch.mesh = new THREE.Mesh(geo, this.material);
    ch.mesh.renderOrder = 3;
    this.group.add(ch.mesh);
  }

  // wake the non-source water a freshly generated chunk came with (moats, reservoirs)
  activateChunk(cx: number, cz: number): void {
    const w = this.world, x0 = cx * 16, z0 = cz * 16, WD = w.W * w.D;
    for (let y = 1; y < w.H; y++) for (let z = z0; z < z0 + 16; z++) for (let x = x0; x < x0 + 16; x++) {
      const i = x + z * w.W + y * WD;
      if (this.lv[i] && !(this.lv[i] & SOURCE)) this.active.add(i);
    }
    this.markDirty(x0 + 8, z0 + 8);
  }
}
