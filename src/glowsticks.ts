import * as THREE from 'three';
import type { Game } from './main';

export const GLOWSTICK_LIMIT = 12;
export const GLOWSTICK_LIFETIME = 180;
export interface GlowstickSave { pos: [number, number, number]; vel: [number, number, number]; remaining: number }
interface Stick { mesh: THREE.Mesh; vel: THREE.Vector3; remaining: number }

/** Small, reusable light pool; every stick remains visibly emissive. */
export class Glowsticks {
  readonly sticks: Stick[] = [];
  readonly lights: THREE.PointLight[] = [];
  private geometry = new THREE.CylinderGeometry(.065, .065, .42, 6);
  private material = new THREE.MeshStandardMaterial({ color: 0x78ff8c, emissive: 0x36ff60, emissiveIntensity: 2.5, roughness: .5 });
  constructor(private game: Game) {
    for (let i = 0; i < 4; i++) {
      const light = new THREE.PointLight(0x77ff99, 0, 13, 1.5);
      game.scene.add(light); this.lights.push(light);
    }
  }
  private clearAt(x: number, y: number, z: number): boolean {
    const w = this.game.world, r = .1;
    for (const dx of [-r, r]) for (const dy of [-r, r]) for (const dz of [-r, r]) {
      const bx = Math.floor(x + dx), by = Math.floor(y + dy), bz = Math.floor(z + dz);
      if (!w.inBounds(bx, by, bz) || !w.chunkAt(bx, by, bz) || w.solid(bx, by, bz)) return false;
    }
    return true;
  }
  throw(): boolean {
    if (this.sticks.length >= GLOWSTICK_LIMIT) { this.game.ui.toast('Too many glowsticks active (12 maximum)', 'bad'); return false; }
    if ((this.game.inv.glowstick | 0) <= 0) { this.game.ui.toast('No glowsticks · craft more', 'bad'); return false; }
    const p = this.game.player, pos = p.pos.clone().add(new THREE.Vector3(0, 1.45, 0));
    if (!this.clearAt(pos.x, pos.y, pos.z)) { this.game.ui.toast('No room to throw a glowstick', 'bad'); return false; }
    const vel = p.aimDir.clone().multiplyScalar(10).add(new THREE.Vector3(0, 2.5, 0)).add(p.vel);
    this.add(pos, vel, GLOWSTICK_LIFETIME); this.game.inv.glowstick--; return true;
  }
  private add(pos: THREE.Vector3, vel: THREE.Vector3, remaining: number): void {
    const mesh = new THREE.Mesh(this.geometry, this.material); mesh.position.copy(pos); mesh.rotation.z = Math.PI / 2;
    this.game.scene.add(mesh); this.sticks.push({ mesh, vel, remaining });
  }
  update(dt: number): void {
    if (dt > 0) for (let i = this.sticks.length - 1; i >= 0; i--) {
      const s = this.sticks[i]; s.remaining -= dt;
      if (s.remaining <= 0) { this.game.scene.remove(s.mesh); this.sticks.splice(i, 1); continue; }
      // Short axis steps prevent fast throws crossing even a one-voxel wall.
      const steps = Math.max(1, Math.ceil(dt * Math.max(1, s.vel.length()) / .08));
      const h = dt / steps;
      for (let n = 0; n < steps; n++) {
        s.vel.y -= 18 * h;
        for (const axis of ['x', 'y', 'z'] as const) {
          const old = s.mesh.position[axis]; s.mesh.position[axis] += s.vel[axis] * h;
          if (!this.clearAt(s.mesh.position.x, s.mesh.position.y, s.mesh.position.z)) {
            s.mesh.position[axis] = old; s.vel[axis] *= -.35;
            if (axis === 'y') { s.vel.x *= .8; s.vel.z *= .8; }
            if (Math.abs(s.vel[axis]) < .2) s.vel[axis] = 0;
          }
        }
      }
    }
    const nearest = [...this.sticks].sort((a, b) => a.mesh.position.distanceToSquared(this.game.player.pos) - b.mesh.position.distanceToSquared(this.game.player.pos));
    this.lights.forEach((l, i) => { const s = nearest[i]; l.intensity = s ? 18 : 0; if (s) l.position.copy(s.mesh.position); });
  }
  snapshot(): GlowstickSave[] { return this.sticks.map(s => ({ pos: s.mesh.position.toArray() as [number, number, number], vel: s.vel.toArray() as [number, number, number], remaining: s.remaining })); }
  restore(data?: GlowstickSave[]): void {
    for (const s of this.sticks) this.game.scene.remove(s.mesh);
    this.sticks.length = 0;
    if (Array.isArray(data)) for (const s of data.slice(0, GLOWSTICK_LIMIT)) {
      if (!s || !Array.isArray(s.pos) || s.pos.length !== 3 || !s.pos.every(Number.isFinite) || !Array.isArray(s.vel) || s.vel.length !== 3 || !s.vel.every(Number.isFinite) || !Number.isFinite(s.remaining) || s.remaining <= 0) continue;
      const pos = new THREE.Vector3(...s.pos);
      if (!this.game.world.inBounds(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))) continue;
      this.add(pos, new THREE.Vector3(...s.vel), Math.min(GLOWSTICK_LIFETIME, s.remaining));
    }
    this.update(0);
  }
}
