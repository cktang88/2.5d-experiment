// GPU point-sprite particle systems: additive glow (fire/sparks), soft smoke,
// and chunky square bits (blood, block chips, dust) that land on the voxel ground.
import * as THREE from 'three';

const VS = /* glsl */`
attribute float size; attribute float alpha; attribute vec3 pcolor;
uniform float uScale;
varying float vA; varying vec3 vC;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = size * uScale / -mv.z;
  vA = alpha; vC = pcolor;
}`;
const FS = (soft) => /* glsl */`
varying float vA; varying vec3 vC;
void main(){
  ${soft ? `vec2 p = gl_PointCoord - 0.5; float d = length(p); if (d > 0.5) discard;
  float a = vA * smoothstep(0.5, 0.15, d);` : 'float a = vA;'}
  gl_FragColor = vec4(vC, a);
}`;

class System {
  constructor(scene, cap, { additive = false, soft = false, collide = false } = {}) {
    this.cap = cap; this.n = 0; this.collide = collide;
    this.pos = new Float32Array(cap * 3); this.vel = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 3); this.alpha = new Float32Array(cap);
    this.size = new Float32Array(cap); this.s0 = new Float32Array(cap); this.s1 = new Float32Array(cap);
    this.life = new Float32Array(cap); this.max = new Float32Array(cap);
    this.grav = new Float32Array(cap); this.drag = new Float32Array(cap); this.a0 = new Float32Array(cap);
    this.rest = new Uint8Array(cap);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos); g.setAttribute('pcolor', this.aCol);
    g.setAttribute('alpha', this.aAlpha); g.setAttribute('size', this.aSize);
    this.uniforms = { uScale: { value: 400 } };
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS(soft), uniforms: this.uniforms,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 10 : 5;
    scene.add(this.points);
  }
  spawn(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, grav = 0, drag = 0) {
    if (this.n >= this.cap) return;
    const i = this.n++, k = i * 3;
    this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z;
    this.vel[k] = vx; this.vel[k + 1] = vy; this.vel[k + 2] = vz;
    this.col[k] = r; this.col[k + 1] = g; this.col[k + 2] = b;
    this.life[i] = life; this.max[i] = life; this.s0[i] = s0; this.s1[i] = s1;
    this.a0[i] = a; this.grav[i] = grav; this.drag[i] = drag; this.rest[i] = 0;
  }
  kill(i) {
    const j = --this.n;
    if (i === j) return;
    const ki = i * 3, kj = j * 3;
    for (let c = 0; c < 3; c++) { this.pos[ki + c] = this.pos[kj + c]; this.vel[ki + c] = this.vel[kj + c]; this.col[ki + c] = this.col[kj + c]; }
    this.life[i] = this.life[j]; this.max[i] = this.max[j]; this.s0[i] = this.s0[j]; this.s1[i] = this.s1[j];
    this.a0[i] = this.a0[j]; this.grav[i] = this.grav[j]; this.drag[i] = this.drag[j]; this.rest[i] = this.rest[j];
  }
  update(dt, world) {
    for (let i = 0; i < this.n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.kill(i); i--; continue; }
      const k = i * 3;
      if (!this.rest[i]) {
        const dr = Math.max(0, 1 - this.drag[i] * dt);
        this.vel[k] *= dr; this.vel[k + 1] = this.vel[k + 1] * dr - this.grav[i] * dt; this.vel[k + 2] *= dr;
        const nx = this.pos[k] + this.vel[k] * dt, ny = this.pos[k + 1] + this.vel[k + 1] * dt, nz = this.pos[k + 2] + this.vel[k + 2] * dt;
        if (this.collide && world.solidAt(nx, ny, nz)) {
          if (!world.solidAt(nx, this.pos[k + 1], nz)) {
            // landed: snap onto the surface and rest (blood / chips stay as splats)
            this.pos[k] = nx; this.pos[k + 2] = nz; this.pos[k + 1] = Math.floor(ny) + 1.02;
            this.rest[i] = 1;
          } else { this.vel[k] *= -0.3; this.vel[k + 2] *= -0.3; }
        } else { this.pos[k] = nx; this.pos[k + 1] = ny; this.pos[k + 2] = nz; }
      }
      const t = 1 - this.life[i] / this.max[i];
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      const fadeIn = Math.min(1, t * 8);
      this.alpha[i] = this.a0[i] * fadeIn * (this.rest[i] ? Math.min(1, this.life[i] / 1.5) : (1 - t * t));
    }
    this.points.geometry.setDrawRange(0, this.n);
    this.aPos.needsUpdate = this.aCol.needsUpdate = this.aAlpha.needsUpdate = this.aSize.needsUpdate = true;
  }
}

const R = Math.random;
const rs = (s) => (R() - 0.5) * 2 * s;

export class Particles {
  constructor(game) {
    this.game = game;
    const s = game.scene;
    this.glow = new System(s, 6000, { additive: true, soft: true });
    this.smoke = new System(s, 3000, { soft: true });
    this.bits = new System(s, 5000, { collide: true });
  }
  setScale(v) { for (const sys of [this.glow, this.smoke, this.bits]) sys.uniforms.uScale.value = v; }
  update(dt) {
    const w = this.game.world;
    this.glow.update(dt, w); this.smoke.update(dt, w); this.bits.update(dt, w);
  }
  fire(x, y, z) {
    const h = R();
    this.glow.spawn(x, y, z, rs(0.3), 1.5 + R() * 1.5, rs(0.3), 0.45 + R() * 0.4, 0.85, 0.15, 3.2, 1.0 + h * 0.9, 0.2, 0.9, -1, 1);
    if (R() < 0.15) this.smoke.spawn(x, y + 0.5, z, rs(0.3), 1.2 + R(), rs(0.3), 1.5 + R(), 0.5, 1.6, 0.18, 0.16, 0.15, 0.35, -0.5, 0.5);
    if (R() < 0.08) this.glow.spawn(x, y, z, rs(1), 3 + R() * 2, rs(1), 0.8, 0.12, 0.05, 4, 2, 0.4, 1, 1, 0.5);
  }
  smokePuff(x, y, z, n = 4, dark = 0.25) {
    for (let i = 0; i < n; i++) this.smoke.spawn(x + rs(0.4), y + rs(0.4), z + rs(0.4), rs(1), 0.8 + R() * 1.2, rs(1), 1.4 + R() * 1.4, 0.6, 2.2, dark, dark * 0.95, dark * 0.9, 0.5, -0.3, 0.8);
  }
  dust(x, y, z, n = 6, col = [0.75, 0.68, 0.55]) {
    for (let i = 0; i < n; i++) this.smoke.spawn(x + rs(0.4), y, z + rs(0.4), rs(2), R() * 1.2, rs(2), 0.6 + R() * 0.6, 0.35, 1.1, col[0], col[1], col[2], 0.45, 0, 2.5);
  }
  sparks(x, y, z, n = 6, nx = 0, ny = 1, nz = 0, col = [4, 2.6, 1]) {
    for (let i = 0; i < n; i++) this.glow.spawn(x, y, z, nx * 4 + rs(4), ny * 4 + rs(3) + 1, nz * 4 + rs(4), 0.2 + R() * 0.25, 0.14, 0.04, col[0], col[1], col[2], 1, 14, 1);
  }
  chips(x, y, z, c, n = 5, speed = 4) {
    for (let i = 0; i < n; i++) {
      const k = 0.8 + R() * 0.4;
      this.bits.spawn(x, y, z, rs(speed), R() * speed + 1, rs(speed), 1.5 + R() * 2, 0.16, 0.16, c.r * k, c.g * k, c.b * k, 1, 18, 0.5);
    }
  }
  blood(x, y, z, col, n = 8, dir) {
    for (let i = 0; i < n; i++) {
      const k = 0.7 + R() * 0.5;
      this.bits.spawn(x, y, z, (dir ? dir.x * 3 : 0) + rs(3), R() * 4 + 1, (dir ? dir.z * 3 : 0) + rs(3), 3 + R() * 4, 0.13 + R() * 0.08, 0.13, col[0] * k, col[1] * k, col[2] * k, 1, 20, 0.5);
    }
  }
  muzzle(x, y, z, d) {
    for (let i = 0; i < 4; i++) this.glow.spawn(x + d.x * 0.1 * i, y + d.y * 0.1 * i, z + d.z * 0.1 * i, d.x * 3 + rs(1), d.y * 3 + rs(1), d.z * 3 + rs(1), 0.06, 0.5 - i * 0.08, 0.1, 5, 3.2, 1.2, 1);
    this.smoke.spawn(x, y, z, d.x + rs(0.3), 0.6, d.z + rs(0.3), 0.6, 0.25, 0.8, 0.6, 0.6, 0.6, 0.3, -0.5, 2);
  }
  trail(x, y, z) {
    this.smoke.spawn(x, y, z, rs(0.3), rs(0.3) + 0.3, rs(0.3), 1.2 + R(), 0.35, 1.3, 0.75, 0.73, 0.7, 0.55, -0.2, 1);
    this.glow.spawn(x, y, z, rs(0.5), rs(0.5), rs(0.5), 0.12, 0.45, 0.1, 5, 2.4, 0.6, 1);
  }
  acid(x, y, z) {
    this.glow.spawn(x, y, z, rs(0.4), rs(0.4), rs(0.4), 0.25, 0.4, 0.05, 0.8, 3, 0.4, 0.9);
  }
  explosion(x, y, z, r) {
    // flash core
    for (let i = 0; i < 26; i++) {
      const a = R() * Math.PI * 2, e = R() * Math.PI - Math.PI / 2, sp = r * (2 + R() * 4);
      this.glow.spawn(x, y, z, Math.cos(a) * Math.cos(e) * sp, Math.abs(Math.sin(e)) * sp + 1, Math.sin(a) * Math.cos(e) * sp,
        0.3 + R() * 0.4, r * 0.9, r * 0.2, 5, 2.2 + R(), 0.5, 1, -2, 4);
    }
    for (let i = 0; i < 30; i++) this.glow.spawn(x, y, z, rs(14), R() * 12 + 2, rs(14), 0.5 + R() * 0.7, 0.16, 0.05, 6, 3.5, 1.2, 1, 16, 0.4);
    for (let i = 0; i < 22; i++) this.smoke.spawn(x + rs(r * 0.6), y + rs(r * 0.4), z + rs(r * 0.6), rs(4), 1 + R() * 4, rs(4), 2.5 + R() * 2.5, r * 0.5, r * 1.6, 0.2, 0.19, 0.18, 0.75, -0.6, 1.4);
  }
  firefly(x, y, z) {
    this.glow.spawn(x, y, z, rs(0.6), rs(0.3), rs(0.6), 3 + R() * 3, 0.14, 0.14, 1.8, 3, 0.8, 0.9, 0, 0);
  }
}
