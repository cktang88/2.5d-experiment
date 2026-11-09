// Bullets (hitscan-ish fast segments), rockets, bouncing grenades and lobbed acid.
import * as THREE from 'three';
import { B, BLOCKS } from './world';
import type { Game } from './main';
import type { Entity, Enemy } from './entities';

export type ProjectileType = 'bullet' | 'rocket' | 'grenade' | 'acid' | 'shell' | 'cannon';
export interface Projectile {
  type: ProjectileType; pos: THREE.Vector3; vel: THREE.Vector3; life: number;
  owner?: Entity | null;
  dmg?: number; blockDmg?: number; knock?: number;
  g?: number; spin?: THREE.Vector3; blastRadius?: number;
  mesh?: THREE.Mesh;
  hostilesOnly?: boolean;
}
export interface BulletOpts { spread?: number; speed?: number; dmg: number; blockDmg?: number; knock?: number; owner?: Entity | null; hostilesOnly?: boolean }
// result of World.raycast (voxel hit)
interface VoxelHit { hit: boolean; t: number; point: THREE.Vector3; x: number; y: number; z: number; nx: number; ny: number; nz: number }

const _d = new THREE.Vector3(), _n = new THREE.Vector3(), _c = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Projectiles {
  game: Game;
  list: Projectile[];
  bulletGeo: THREE.BoxGeometry;
  bulletMat: THREE.MeshBasicMaterial;
  turretMat: THREE.MeshBasicMaterial;
  rocketGeo: THREE.BoxGeometry;
  rocketMat: THREE.MeshLambertMaterial;
  cannonGeo: THREE.SphereGeometry;
  cannonMat: THREE.MeshLambertMaterial;
  grenadeGeo: THREE.BoxGeometry;
  grenadeMat: THREE.MeshLambertMaterial;
  acidGeo: THREE.IcosahedronGeometry;
  acidMat: THREE.MeshBasicMaterial;

  constructor(game: Game) {
    this.game = game;
    this.list = [];
    this.bulletGeo = new THREE.BoxGeometry(0.06, 0.06, 0.7);
    this.bulletMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 4.5, 1.5) });
    this.turretMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 1.6, 1.2) });
    this.rocketGeo = new THREE.BoxGeometry(0.16, 0.16, 0.5);
    this.rocketMat = new THREE.MeshLambertMaterial({ color: 0x6a7a5a, emissive: 0x221100 });
    this.cannonGeo = new THREE.SphereGeometry(.16, 8, 6);
    this.cannonMat = new THREE.MeshLambertMaterial({ color: 0xb99c62, emissive: 0x663300 });
    this.grenadeGeo = new THREE.BoxGeometry(0.22, 0.26, 0.22);
    this.grenadeMat = new THREE.MeshLambertMaterial({ color: 0x5a7a3a });
    this.acidGeo = new THREE.IcosahedronGeometry(0.22, 0);
    this.acidMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.8, 3.2, 0.5) });
  }

  add(p: Projectile, geo: THREE.BufferGeometry, mat: THREE.Material): Projectile {
    const mesh = new THREE.Mesh(geo, mat);
    p.mesh = mesh;
    mesh.position.copy(p.pos);
    mesh.castShadow = p.type !== 'bullet';
    this.game.scene.add(mesh);
    this.list.push(p);
    return p;
  }

  bullet(from: THREE.Vector3, dir: THREE.Vector3, o: BulletOpts): Projectile {
    const d = dir.clone();
    const sp = o.spread || 0;
    d.x += (Math.random() - 0.5) * sp * 2; d.y += (Math.random() - 0.5) * sp; d.z += (Math.random() - 0.5) * sp * 2;
    d.normalize();
    return this.add({ type: 'bullet', pos: from.clone(), vel: d.multiplyScalar(o.speed || 70), life: 1.2, dmg: o.dmg, blockDmg: o.blockDmg ?? 1, knock: o.knock ?? 2, owner: o.owner, hostilesOnly:o.hostilesOnly }, this.bulletGeo, o.owner && o.owner.kind === 'turret' ? this.turretMat : this.bulletMat);
  }
  rocket(from: THREE.Vector3, dir: THREE.Vector3, owner?: Entity | null): Projectile {
    return this.add({ type: 'rocket', pos: from.clone(), vel: dir.clone().multiplyScalar(26), life: 4, owner }, this.rocketGeo, this.rocketMat);
  }
  // ballistic lob that lands at `to`
  lob(type: 'grenade' | 'acid', from: THREE.Vector3, to: THREE.Vector3, owner?: Entity | null): Projectile {
    const diff = to.clone().sub(from);
    const dist = Math.hypot(diff.x, diff.z);
    const g = type === 'acid' ? 18 : 22;
    const T = THREE.MathUtils.clamp(dist / (type === 'acid' ? 10 : 14), 0.35, 1.5);
    const vel = new THREE.Vector3(diff.x / T, (diff.y + 0.5 * g * T * T) / T, diff.z / T);
    const p: Projectile = { type, pos: from.clone(), vel, life: type === 'grenade' ? 2.1 : 5, owner, g, spin: new THREE.Vector3(Math.random() * 10, Math.random() * 10, 0) };
    return this.add(p, type === 'grenade' ? this.grenadeGeo : this.acidGeo, type === 'grenade' ? this.grenadeMat : this.acidMat);
  }

  defenseRocket(from: THREE.Vector3, dir: THREE.Vector3, owner: Entity, damage: number): Projectile {
    return this.add({ type:'rocket', pos:from.clone(), vel:dir.clone().multiplyScalar(32), life:3, owner, dmg:damage }, this.rocketGeo, this.rocketMat);
  }
  defenseCannon(from: THREE.Vector3, dir: THREE.Vector3, owner: Entity, damage: number, speed: number, heavy: boolean): Projectile {
    const p = this.add({ type:'cannon', pos:from.clone(), vel:dir.clone().multiplyScalar(speed), life:1.4, owner, dmg:damage, blastRadius:heavy ? 2.2 : 1.25 }, this.cannonGeo, this.cannonMat);
    p.mesh!.scale.setScalar(heavy ? 1.4 : 1);
    return p;
  }
  defenseShell(from: THREE.Vector3, vel: THREE.Vector3, time: number, owner: Entity, damage: number): Projectile {
    return this.add({ type:'shell', pos:from.clone(), vel:vel.clone(), life:time + .3, owner, dmg:damage, g:18 }, this.grenadeGeo, this.grenadeMat);
  }
  defenseBlast(at: THREE.Vector3, damage: number, radius: number): void {
    const g = this.game;
    for (const e of g.entities.enemies) {
      if (e.dead) continue;
      const dir = e.center(new THREE.Vector3()).sub(at), d = dir.length();
      if (d >= radius || (d > .001 && g.world.raycast(at, dir.clone().divideScalar(d), d).hit)) continue;
      const k = 1 - d / radius;
      e.damage(damage * k, dir.normalize().multiplyScalar(8*k).add(new THREE.Vector3(0,3*k,0)), 'explosion');
    }
    g.particles.explosion(at.x,at.y,at.z,radius*.6);
    g.audio.explosion(radius/3.5, Math.max(.15,1-at.distanceTo(g.entities.player.pos)/50));
  }

  reset(): void {
    for (const p of this.list) if (p.mesh) this.game.scene.remove(p.mesh);
    this.list = [];
  }

  update(dt: number): void {
    const g = this.game, w = g.world;
    for (let i = 0; i < this.list.length; i++) {
      const p = this.list[i];
      p.life -= dt;
      let remove = p.life <= 0;
      if (p.type === 'grenade') {
        if (remove) { g.explode(p.pos.clone(), 3.2, 11, 'grenade'); }
        else this.stepGrenade(p, dt);
      } else if (!remove) {
        const displacement = p.vel.clone().multiplyScalar(dt);
        if (p.g) { displacement.y -= .5 * p.g * dt * dt; p.vel.y -= p.g * dt; }
        const L = displacement.length();
        _d.copy(displacement).divideScalar(L || 1);
        const vox = w.raycast(p.pos, _d, L);
        const ent = g.entities.raycast(p.pos, _d, vox.hit ? vox.t : L, p.owner, 0, p.hostilesOnly);
        if (ent) { this.hitEntity(p, ent.e, _c.copy(p.pos).addScaledVector(_d, ent.t)); remove = true; }
        else if (vox.hit) { this.hitBlock(p, vox as VoxelHit); remove = true; }
        else {
          p.pos.addScaledVector(_d, L);
          if (p.type === 'rocket') { g.particles.trail(p.pos.x, p.pos.y, p.pos.z); }
          if (p.type === 'acid') { g.particles.acid(p.pos.x, p.pos.y, p.pos.z); }
        }
      } else if (p.type === 'shell' || p.type === 'cannon') this.defenseBlast(p.pos.clone(), p.dmg!, p.type === 'shell' ? 5 : p.blastRadius!);
      else if (p.type === 'rocket') { if (p.owner?.kind === 'turret') this.defenseBlast(p.pos.clone(), p.dmg!, 3.4); else g.explode(p.pos.clone(), 3.4, 13, 'rocket'); } // fuse ran out
      const mesh = p.mesh!;
      if (remove) { g.scene.remove(mesh); this.list.splice(i, 1); i--; continue; }
      mesh.position.copy(p.pos);
      if (p.type === 'bullet' || p.type === 'rocket' || p.type === 'cannon' || p.type === 'shell') mesh.lookAt(_c.copy(p.pos).add(p.vel));
      else if (p.spin) { mesh.rotation.x += p.spin.x * dt; mesh.rotation.y += p.spin.y * dt; }
    }
  }

  stepGrenade(p: Projectile, dt: number): void {
    const w = this.game.world;
    p.vel.y -= p.g! * dt;
    const steps = 3;
    for (let s = 0; s < steps; s++) {
      const h = dt / steps;
      for (const ax of ['x', 'y', 'z'] as const) {
        const old = p.pos[ax];
        p.pos[ax] += p.vel[ax] * h;
        if (w.solidAt(p.pos.x, p.pos.y, p.pos.z)) {
          p.pos[ax] = old;
          const sp = Math.abs(p.vel[ax]);
          p.vel[ax] *= -0.45;
          if (ax === 'y') { p.vel.x *= 0.7; p.vel.z *= 0.7; }
          p.spin!.multiplyScalar(0.7);
          if (sp > 3) this.game.audio.thud();
        }
      }
      // bounce off enemies too
      const hit = this.game.entities.raycast(p.pos, _d.copy(p.vel).normalize(), 0.2, p.owner);
      if (hit && hit.e.kind !== 'player') { p.vel.x *= -0.4; p.vel.z *= -0.4; }
    }
    if (Math.random() < 0.4) this.game.particles.sparks(p.pos.x, p.pos.y + 0.15, p.pos.z, 1, 0, 1, 0, [3, 2, 0.6]);
  }

  hitEntity(p: Projectile, e: Entity, at: THREE.Vector3): void {
    const g = this.game;
    if (p.type === 'shell' || p.type === 'cannon' || (p.type === 'rocket' && p.owner?.kind === 'turret')) { this.defenseBlast(at.clone(), p.dmg!, p.type === 'shell' ? 5 : p.type === 'cannon' ? p.blastRadius! : 3.4); return; }
    if (p.type === 'rocket') { g.explode(at, 3.4, 13, 'rocket'); return; }
    if (p.type === 'acid') { this.splash(at); return; }
    const kb = _n.copy(p.vel).normalize().multiplyScalar(p.knock!);
    kb.y = Math.max(kb.y, p.knock! * 0.3);
    e.damage(p.dmg!, kb.clone(), 'bullet');
    g.particles.blood(at.x, at.y, at.z, ('goreCol' in e ? (e as Enemy).goreCol : [0.6, 0.1, 0.1]), 5, _n.copy(p.vel).normalize());
    g.audio.hit();
    if (p.owner && p.owner.kind === 'player') g.hitmarker();
  }

  hitBlock(p: Projectile, vox: VoxelHit): void {
    const g = this.game;
    const pt = vox.point;
    if (p.type === 'shell' || p.type === 'cannon' || (p.type === 'rocket' && p.owner?.kind === 'turret')) { this.defenseBlast(pt.clone().addScaledVector(_d, -.05), p.dmg!, p.type === 'shell' ? 5 : p.type === 'cannon' ? p.blastRadius! : 3.4); return; }
    if (p.type === 'rocket') { g.explode(pt.addScaledVector(_d, -0.3), 3.4, 13, 'rocket'); return; }
    if (p.type === 'acid') { this.splash(pt.addScaledVector(_d, -0.2)); return; }
    if (p.hostilesOnly || p.owner?.kind === 'turret') { g.particles.sparks(pt.x, pt.y, pt.z, 3, vox.nx, vox.ny, vox.nz); return; }
    const t = g.world.get(vox.x, vox.y, vox.z);
    const bd = BLOCKS[t];
    g.particles.sparks(pt.x, pt.y, pt.z, 3, vox.nx, vox.ny, vox.nz);
    if (bd) g.particles.chips(pt.x + vox.nx * 0.05, pt.y + vox.ny * 0.05, pt.z + vox.nz * 0.05, bd.cSide, 2, 3);
    if (t === B.TNT || t === B.BARREL) { g.world.damageBlock(vox.x, vox.y, vox.z, 99, 'bullet'); return; }
    g.world.damageBlock(vox.x, vox.y, vox.z, p.blockDmg!, 'bullet');
  }

  splash(hitAt: THREE.Vector3): void {
    const g = this.game;
    const at = hitAt.clone(); // callers pass shared scratch vectors that hurt() below would overwrite
    for (let i = 0; i < 18; i++) g.particles.blood(at.x, at.y, at.z, [0.4, 1.4, 0.3], 1);
    g.particles.sparks(at.x, at.y, at.z, 8, 0, 1, 0, [0.8, 3, 0.4]);
    g.audio.sizzle();
    // acid only hurts the player and turrets, and not through a wall (a splash on the far side of the
    // block you hide behind used to reach you)
    const hurt = (e: Entity) => {
      if (e.dead) return;
      const d = e.center(_c).distanceTo(at);
      if (d < 1.8 && (d < 1e-3 || !g.world.raycast(at, _c.sub(at).divideScalar(d), d).hit)) e.damage(14 * (1 - d / 2.2), _n.subVectors(e.pos, at).setY(0).normalize().multiplyScalar(3).add(UP), 'acid');
    };
    if (g.entities.player) hurt(g.entities.player);
    for (const t of g.entities.turrets) hurt(t);
    // acid eats a little bit of the world
    const x = Math.floor(at.x), y = Math.floor(at.y), z = Math.floor(at.z);
    for (let dy = -1; dy <= 0; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++)
      if (Math.random() < 0.4) g.world.damageBlock(x + dx, y + dy, z + dz, 0.8, 'acid');
  }
}
