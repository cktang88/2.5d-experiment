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
  vec3 deep = vec3(0.06, 0.25, 0.42), shallow = vec3(0.25, 0.62, 0.7);
  float w = vn(vW.xz * 1.2 + vec2(uTime * 0.4, uTime * 0.25)) * 0.6 + vn(vW.xz * 3.1 - uTime * 0.5) * 0.4;
  vec3 c = mix(deep, shallow, clamp(vDepthK + w * 0.25, 0.0, 1.0));
  // pixel-quantised caustic glints
  vec2 q = floor(vW.xz * 8.0) / 8.0;
  float spark = step(0.93, vn(q * 2.0 + uTime * 0.7)) * step(0.5, vN.y);
  c += spark * 0.5 * uDay;
  // fresnel-ish rim toward the horizon
  vec3 V = normalize(uCamPos - vW);
  float fr = pow(1.0 - clamp(dot(V, normalize(vN)), 0.0, 1.0), 3.0);
  c = mix(c, vec3(0.75, 0.9, 1.0), fr * 0.35);
  // foam on falling / side faces
  if (vN.y < 0.5) c = mix(c, vec3(0.9, 0.95, 1.0), 0.35 + 0.25 * step(0.6, vn(vec2(vW.x + vW.z, vW.y * 2.0 + uTime * 6.0))));
  c *= mix(0.25, 1.0, uDay);
  gl_FragColor = vec4(c, 0.78);
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
  chunks: WaterChunk[] = [];
  material: THREE.ShaderMaterial;
  uniforms: Record<string, THREE.IUniform>;
  group = new THREE.Group();

  constructor(game: Game, world: World) {
    this.game = game; this.world = world;
    this.lv = new Uint8Array(world.W * world.H * world.D);
    const ncx = Math.ceil(world.W / CHUNK), ncz = Math.ceil(world.D / CHUNK);
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

  // ocean cells (below sea level in sea / beach columns) are infinite sources
  initOcean(): void {
    const w = this.world;
    for (let z = 0; z < w.D; z++) for (let x = 0; x < w.W; x++) {
      if (w.surfaceY(x, z) > WATER_LEVEL) continue;
      for (let y = 1; y < WATER_LEVEL; y++) if (w.get(x, y, z) === B.AIR) this.lv[this.idx(x, y, z)] = FULL | SOURCE;
    }
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
    const ncx = Math.ceil(this.world.W / CHUNK);
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    for (let a = cx - 1; a <= cx + 1; a++) for (let b = cz - 1; b <= cz + 1; b++) {
      if (a < 0 || b < 0 || a >= ncx || b >= Math.ceil(this.world.D / CHUNK)) continue;
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
  }

  tick(): void {
    const w = this.world, W = w.W, WD = w.W * w.D, data = w.data;
    const list = [...this.active];
    this.active.clear();
    // process from the bottom up so falling water settles in one pass
    list.sort((a, b) => a - b);
    let n = 0;
    for (const i of list) {
      if (++n > BUDGET) { this.next.add(i); continue; }
      const L = this.level(i);
      if (!L) continue;
      const x = i % W, z = Math.floor(i / W) % w.D, y = Math.floor(i / WD);
      if (data[i] !== B.AIR) { this.lv[i] = 0; continue; }
      const src = this.isSource(i);
      // fall
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
      const cur = () => (src ? FULL : this.level(i));
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= W || nz >= w.D) continue;
        const j = i + dx + dz * W;
        if (data[j] !== B.AIR) continue;
        const lj = this.level(j);
        if (cur() - lj >= 2 || (cur() >= 1 && lj === 0 && data[j - WD] === B.AIR)) {
          this.move(i, j, 1);
          moved = true;
          this.markDirty(nx, nz);
        }
        if (!src && this.level(i) <= 1) break;
      }
      if (moved) this.markDirty(x, z);
      // put out fires next to water
      for (const k of [i + 1, i - 1, i + W, i - W, i + WD, i - WD]) {
        if (w.burning.has(k)) { w.burning.delete(k); const kx = k % W, kz = Math.floor(k / W) % w.D, ky = Math.floor(k / WD); this.game.particles.smokePuff(kx + 0.5, ky + 0.8, kz + 0.5, 3, 0.7); this.game.audio.sizzle(); w.markDirty(kx, kz); }
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
    const ncx = Math.ceil(this.world.W / CHUNK);
    for (let c = 0; c < this.chunks.length && built < 2; c++) {
      if (!this.chunks[c].dirty) continue;
      this.buildChunk(c % ncx, Math.floor(c / ncx));
      built++;
    }
  }

  buildChunk(cx: number, cz: number): void {
    const w = this.world, ch = this.chunks[cx + cz * Math.ceil(w.W / CHUNK)];
    ch.dirty = false;
    const pos: number[] = [], nor: number[] = [], shade: number[] = [], ind: number[] = [];
    const x0 = cx * CHUNK, z0 = cz * CHUNK, x1 = Math.min(x0 + CHUNK, w.W), z1 = Math.min(z0 + CHUNK, w.D);
    const quad = (a: number[], b: number[], c: number[], d: number[], n: number[], s: number) => {
      const base = pos.length / 3;
      pos.push(...a, ...b, ...c, ...d);
      for (let k = 0; k < 4; k++) { nor.push(...n); shade.push(s); }
      ind.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    for (let y = 1; y < w.H; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      const i = this.idx(x, y, z);
      const L = this.level(i);
      if (!L || (this.isSource(i) && y < WATER_LEVEL)) continue; // the ocean plane draws the sea
      const above = y + 1 < w.H ? this.level(i + w.W * w.D) : 0;
      const top = above ? y + 1 : y + L / FULL - 0.05;
      const depthK = Math.min(1, L / FULL * 0.6 + (this.level(i - w.W * w.D) ? 0 : 0.3));
      if (!above) quad([x, top, z + 1], [x + 1, top, z + 1], [x + 1, top, z], [x, top, z], [0, 1, 0], 1 - depthK);
      // sides facing open air (waterfalls / edges)
      const sides: [number, number, number[]][] = [[1, 0, [1, 0, 0]], [-1, 0, [-1, 0, 0]], [0, 1, [0, 0, 1]], [0, -1, [0, 0, -1]]];
      for (const [dx, dz, n] of sides) {
        const nx = x + dx, nz = z + dz;
        if (w.get(nx, y, nz) !== B.AIR) continue;
        const nl = this.levelAt(nx, y, nz);
        if (nl >= L && !above) continue;
        const bot = y + (above ? 0 : Math.min(nl, L) / FULL);
        if (top - bot < 0.05) continue;
        if (dx === 1) quad([x + 1, bot, z + 1], [x + 1, bot, z], [x + 1, top, z], [x + 1, top, z + 1], n, 0.5);
        else if (dx === -1) quad([x, bot, z], [x, bot, z + 1], [x, top, z + 1], [x, top, z], n, 0.5);
        else if (dz === 1) quad([x, bot, z + 1], [x + 1, bot, z + 1], [x + 1, top, z + 1], [x, top, z + 1], n, 0.5);
        else quad([x + 1, bot, z], [x, bot, z], [x, top, z], [x + 1, top, z], n, 0.5);
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

  // carve a reservoir held back by a stone dam on high ground, and a moat around the castle
  generateFeatures(): void {
    const w = this.world;
    // reservoir: highest grassy spot at least 22 blocks from the castle
    let best: [number, number, number] | null = null;
    for (let z = 12; z < w.D - 12; z += 2) for (let x = 12; x < w.W - 12; x += 2) {
      if (Math.hypot(x - w.W / 2, z - w.D / 2) < 24) continue;
      const h = w.surfaceY(x, z);
      if (!best || h > best[1]) best = [x, h, z];
    }
    if (best) {
      const [bx, by, bz] = best;
      for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
        const r = Math.hypot(dx, dz);
        if (r > 3.4) continue;
        const depth = r < 2 ? 3 : 2;
        for (let k = 0; k < depth; k++) { w.set(bx + dx, by - 1 - k, bz + dz, B.AIR, true); }
        for (let k = 0; k < depth; k++) this.lv[this.idx(bx + dx, by - 1 - k, bz + dz)] = FULL;
      }
      this.springAt = [bx, by - 1, bz];
    }
    // moat ring just outside the castle walls
    const cx = Math.floor(w.W / 2), cz = Math.floor(w.D / 2);
    for (let z = cz - 14; z <= cz + 14; z++) for (let x = cx - 14; x <= cx + 14; x++) {
      const d = Math.max(Math.abs(x - cx), Math.abs(z - cz));
      if (d < 12 || d > 13) continue;
      // keep land bridges at the two gates
      if ((Math.abs(x - cx) <= 1 && z > cz) || (Math.abs(z - cz) <= 1 && x < cx)) continue;
      const top = w.surfaceY(x, z);
      for (let y = top - 1; y >= top - 2; y--) { w.set(x, y, z, B.AIR, true); this.lv[this.idx(x, y, z)] = FULL; }
      for (let y = top; y < top + 3; y++) if (w.get(x, y, z) === B.AIR) w.decor[w.idx(x, y, z)] = 0;
    }
    for (let i = 0; i < this.lv.length; i++) if (this.lv[i] && !(this.lv[i] & SOURCE)) this.active.add(i);
  }
  springAt: [number, number, number] | null = null;

  // compact snapshot for save games (sources keep their flag)
  snapshot(): Uint8Array { return this.lv.slice(); }
  restore(lv: Uint8Array): void {
    this.lv.set(lv);
    this.active.clear();
    for (let i = 0; i < lv.length; i++) if (lv[i] && !(lv[i] & SOURCE)) this.active.add(i);
    for (const c of this.chunks) c.dirty = true;
  }
}
