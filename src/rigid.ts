// Rapier-backed rigid body physics for destruction.
//  - the voxel terrain is mirrored into a single Rapier `voxels` collider (kept in sync on every edit)
//  - structures that lose support become dynamic voxel bodies with real mass & inertia,
//    so they pivot over their remaining contact edge and topple instead of dropping straight down
//  - on a hard impact they shatter into individual rigid bricks (Angry Birds style)
//  - bricks that come to rest are written back into the voxel world as rubble
import * as THREE from 'three';
import type { RigidBody, World as RapierWorld, Collider, EventQueue } from '@dimforge/rapier3d-compat';
import { B, BLOCKS, patchWorldMaterial, tileFor } from './world';
import type { Game } from './main';
import type { Entity } from './entities';

export type RapierModule = typeof import('@dimforge/rapier3d-compat');
/** [x, y, z, blockType] */
export type ChunkBlock = [number, number, number, number];
interface RigidChunk {
  body: RigidBody; mesh: THREE.Mesh; blocks: ChunkBlock[]; ox: number; oy: number; oz: number;
  /** block centres in body-local space, xyz triplets (for the crush test) */
  local: Float32Array;
  prevV: THREE.Vector3; t: number; still: number; hit: Set<Entity>;
}
interface Brick { body: RigidBody; type: number; t: number; still: number; color: THREE.Color; slot: number }
interface RigidTnt { grp: THREE.Group; mat: THREE.MeshLambertMaterial; band: THREE.MeshLambertMaterial; body: RigidBody; fuse: number; t: number; total: number }

const STEP = 1 / 60;
const MAX_BRICKS = 240;
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _s = new THREE.Vector3(1, 1, 1);
const _qi = new THREE.Quaternion(), _c = new THREE.Vector3();
const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;
const TRI_FRONT = [0, 1, 2, 0, 2, 3], TRI_BACK = [0, 2, 1, 0, 3, 2];

export async function loadRapier(): Promise<RapierModule | null> {
  try {
    const mod = await import('@dimforge/rapier3d-compat');
    const R: RapierModule = (mod.default || mod) as RapierModule;
    await R.init();
    return R;
  } catch (e) {
    console.warn('Rapier unavailable, using built-in physics fallback:', e);
    return null;
  }
}

export class RigidPhysics {
  game: Game;
  R: RapierModule;
  rw: RapierWorld;
  eq: EventQueue;
  terrain: Collider;
  ground: RigidBody;
  acc: number;
  chunks: RigidChunk[];
  bricks: Brick[];
  tnts: RigidTnt[];
  chunkMat: THREE.MeshLambertMaterial;
  brickMesh: THREE.InstancedMesh;
  tntGeo: THREE.BoxGeometry;
  bandGeo: THREE.BoxGeometry;

  constructor(game: Game, R: RapierModule) {
    this.game = game; this.R = R;
    const w = game.world;
    this.rw = new R.World({ x: 0, y: -25, z: 0 });
    this.rw.timestep = STEP;
    this.rw.numSolverIterations = 4;
    this.eq = new R.EventQueue(true);
    this.ground = this.rw.createRigidBody(R.RigidBodyDesc.fixed());
    this.terrain = this.buildTerrain();
    w.onSolidChange = (x, y, z, solid) => this.terrain.setVoxel(x, y, z, solid);
    this.acc = 0;
    this.chunks = [];
    this.bricks = [];
    this.tnts = [];
    this.chunkMat = patchWorldMaterial(new THREE.MeshLambertMaterial({ vertexColors: true }), { cutaway: false, emissive: true, clouds: false, detail: true });
    // bricks: one instanced cube with baked face shading (top bright, sides mid, bottom dark)
    const geo = new THREE.BoxGeometry(0.96, 0.96, 0.96);
    const shade: number[] = [], n = geo.attributes.normal;
    for (let i = 0; i < n.count; i++) { const k = n.getY(i) > 0.5 ? 1.08 : n.getY(i) < -0.5 ? 0.6 : 0.86; shade.push(k, k, k); }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(shade, 3));
    this.brickMesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }), MAX_BRICKS);
    this.brickMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.brickMesh.castShadow = this.brickMesh.receiveShadow = true;
    this.brickMesh.frustumCulled = false;
    for (let i = 0; i < MAX_BRICKS; i++) this.brickMesh.setColorAt(i, new THREE.Color(1, 1, 1));
    this.brickMesh.count = 0;
    game.scene.add(this.brickMesh);
    this.tntGeo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
    this.bandGeo = new THREE.BoxGeometry(0.94, 0.3, 0.94);
  }

  // mirror the voxel terrain into one voxels collider
  buildTerrain(): Collider {
    const w = this.game.world, R = this.R;
    const pts: number[] = [];
    for (let i = 0; i < w.data.length; i++) if (w.data[i]) pts.push(i % w.W, Math.floor(i / (w.W * w.D)), Math.floor(i / w.W) % w.D);
    return this.rw.createCollider(R.ColliderDesc.voxels(new Int32Array(pts), { x: 1, y: 1, z: 1 }).setFriction(0.9).setRestitution(0.05), this.ground);
  }

  // drop every dynamic body and re-mirror the terrain (used when loading a save)
  reset(): void {
    for (const ch of this.chunks) this.removeChunk(ch);
    for (const b of this.bricks) this.rw.removeRigidBody(b.body);
    for (const T of this.tnts) { this.game.scene.remove(T.grp); this.rw.removeRigidBody(T.body); }
    this.chunks = []; this.bricks = []; this.tnts = [];
    this.brickMesh.count = 0;
    this.rw.removeCollider(this.terrain, false);
    this.terrain = this.buildTerrain();
  }

  // ---------- falling structures ----------
  addChunk(blocks: ChunkBlock[]): void {
    const R = this.R, g = this.game;
    let ox = Infinity, oy = Infinity, oz = Infinity;
    for (const [x, y, z] of blocks) { ox = Math.min(ox, x); oy = Math.min(oy, y); oz = Math.min(oz, z); }
    const coords = new Int32Array(blocks.length * 3);
    blocks.forEach(([x, y, z], i) => { coords[i * 3] = x - ox; coords[i * 3 + 1] = y - oy; coords[i * 3 + 2] = z - oz; });
    const body = this.rw.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(ox, oy, oz).setLinearDamping(0.02).setAngularDamping(0.05));
    this.rw.createCollider(R.ColliderDesc.voxels(coords, { x: 1, y: 1, z: 1 }).setDensity(1).setFriction(0.85).setRestitution(0.05), body);
    // nudge it away from where the damage happened so it tips over its remaining support edge
    const com = body.worldCom();
    const hit = g.lastDamagePos || new THREE.Vector3(com.x, com.y, com.z);
    _v.set(com.x - hit.x, 0, com.z - hit.z);
    if (_v.lengthSq() < 0.01) _v.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    _v.normalize().multiplyScalar(body.mass() * (0.6 + Math.random() * 0.6));
    body.applyImpulseAtPoint({ x: _v.x, y: 0, z: _v.z }, { x: com.x, y: com.y + 1.5, z: com.z }, true);
    const mesh = this.buildMesh(blocks, ox, oy, oz);
    g.scene.add(mesh);
    const local = new Float32Array(blocks.length * 3);
    for (let i = 0; i < blocks.length; i++) { local[i * 3] = blocks[i][0] - ox + 0.5; local[i * 3 + 1] = blocks[i][1] - oy + 0.5; local[i * 3 + 2] = blocks[i][2] - oz + 0.5; }
    this.chunks.push({ body, mesh, blocks, local, ox, oy, oz, prevV: new THREE.Vector3(), t: 0, still: 0, hit: new Set() });
    g.audio.creak(Math.min(1, blocks.length / 60));
  }

  buildMesh(blocks: ChunkBlock[], ox: number, oy: number, oz: number): THREE.Mesh {
    // occupancy grid over the chunk's bounding box (with a 1-cell margin so neighbour lookups never leave it)
    let sx = 0, sy = 0, sz = 0;
    for (const [x, y, z] of blocks) { sx = Math.max(sx, x - ox); sy = Math.max(sy, y - oy); sz = Math.max(sz, z - oz); }
    sx += 3; sy += 3; sz += 3;
    const grid = new Uint8Array(sx * sy * sz);
    const gi = (x: number, y: number, z: number) => (x - ox + 1) + (z - oz + 1) * sx + (y - oy + 1) * sx * sz;
    for (const [x, y, z] of blocks) grid[gi(x, y, z)] = 1;
    const pos: number[] = [], nor: number[] = [], col: number[] = [], emit: number[] = [], tiles: number[] = [], ind: number[] = [];
    const q = [0, 0, 0];
    for (const [x, y, z, t] of blocks) {
      const bd = BLOCKS[t];
      const lx = x - ox, ly = y - oy, lz = z - oz;
      for (const [dx, dy, dz] of DIRS) {
        if (grid[gi(x + dx, y + dy, z + dz)]) continue;
        const a = dx ? 0 : dy ? 1 : 2, s = dx + dy + dz;
        const u = (a + 1) % 3, v = (a + 2) % 3;
        const base = pos.length / 3;
        const fc = a === 1 ? (s > 0 ? bd.cTop : bd.cBottom) : bd.cSide;
        const tint = 0.85 + Math.random() * 0.15;
        const tile = tileFor(t, a);
        for (let k = 0; k < 4; k++) {
          q[0] = lx; q[1] = ly; q[2] = lz;
          q[a] += s > 0 ? 1 : 0; q[u] += (k === 1 || k === 2) ? 1 : 0; q[v] += k >= 2 ? 1 : 0;
          pos.push(q[0], q[1], q[2]); nor.push(dx, dy, dz);
          col.push(fc.r * tint, fc.g * tint, fc.b * tint); emit.push(bd.emit); tiles.push(tile);
        }
        for (const ti of (s > 0 ? TRI_FRONT : TRI_BACK)) ind.push(base + ti);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('emit', new THREE.Float32BufferAttribute(emit, 1));
    geo.setAttribute('tile', new THREE.Float32BufferAttribute(tiles, 1));
    geo.setIndex(ind);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.chunkMat);
    mesh.castShadow = mesh.receiveShadow = true;
    return mesh;
  }

  // world-space centre of block i of a chunk
  blockCenter(ch: RigidChunk, i: number, out: THREE.Vector3): THREE.Vector3 {
    const [x, y, z] = ch.blocks[i];
    out.set(x - ch.ox + 0.5, y - ch.oy + 0.5, z - ch.oz + 0.5).applyQuaternion(ch.mesh.quaternion).add(ch.mesh.position);
    return out;
  }

  updateChunks(dt: number): void {
    for (let i = 0; i < this.chunks.length; i++) {
      const ch = this.chunks[i];
      ch.t += dt;
      const t = ch.body.translation(), r = ch.body.rotation(), lv = ch.body.linvel();
      ch.mesh.position.set(t.x, t.y, t.z);
      ch.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      const v = _w.set(lv.x, lv.y, lv.z);
      const speed = v.length();
      const dv = v.distanceTo(ch.prevV);
      const impactSpeed = ch.prevV.length();
      ch.prevV.copy(v);
      // crush entities in the way
      if (speed > 3) this.crush(ch, speed);
      let done = false;
      if (dv > 7 && ch.t > 0.12 && impactSpeed > 6) { this.shatter(ch, impactSpeed); done = true; }
      else {
        ch.still = speed < 0.4 && ch.body.angvel().x ** 2 + ch.body.angvel().z ** 2 < 0.2 ? ch.still + dt : 0;
        if (ch.body.isSleeping() || ch.still > 0.6) { this.settle(ch); done = true; }
        else if (t.y < -10 || ch.t > 15) { this.shatter(ch, 0); done = true; }
      }
      if (done) { this.removeChunk(ch); this.chunks.splice(i, 1); i--; }
    }
  }

  crush(ch: RigidChunk, speed: number): void {
    const g = this.game, c = _c;
    const ents = g.entities.all();
    const n = ch.blocks.length, stride = n > 300 ? 3 : 1, local = ch.local;
    // entity centres are tested in the chunk's local frame, so blocks need no per-entity transform
    _qi.copy(ch.mesh.quaternion).invert();
    const reach = n + 6;
    for (const e of ents) {
      if (ch.hit.has(e)) continue;
      e.center(c);
      if (c.distanceTo(ch.mesh.position) > reach) continue;
      c.sub(ch.mesh.position).applyQuaternion(_qi);
      for (let i = 0; i < n; i += stride) {
        const dx = local[i * 3] - c.x, dy = local[i * 3 + 1] - c.y, dz = local[i * 3 + 2] - c.z;
        if (dx * dx + dy * dy + dz * dz < 0.85) {
          ch.hit.add(e);
          e.damage(15 + speed * 4, new THREE.Vector3(0, -1, 0), 'crush');
          break;
        }
      }
    }
  }

  removeChunk(ch: RigidChunk): void {
    this.rw.removeRigidBody(ch.body);
    this.game.scene.remove(ch.mesh);
    ch.mesh.geometry.dispose();
  }

  // snap a resting chunk back into the voxel grid (only if it ended up nearly axis-aligned)
  settle(ch: RigidChunk): void {
    const q = ch.mesh.quaternion;
    const snap = new THREE.Quaternion();
    // nearest 90-degree orientation about Y
    const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    snap.setFromEuler(new THREE.Euler(0, Math.round(e.y / (Math.PI / 2)) * (Math.PI / 2), 0, 'YXZ'));
    if (q.angleTo(snap) > 0.3) { this.shatter(ch, 4); return; }
    const g = this.game, w = g.world, p = new THREE.Vector3(), placed: [number, number, number][] = [];
    for (let i = 0; i < ch.blocks.length; i++) {
      this.blockCenter(ch, i, p);
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
      if (w.inBounds(x, y, z) && !w.solid(x, y, z) && !g.entities.blocksCell(x, y, z)) { w.set(x, y, z, ch.blocks[i][3]); placed.push([x, y, z]); }
      else g.particles.chips(p.x, p.y, p.z, BLOCKS[ch.blocks[i][3]].cSide, 2);
    }
    g.audio.thud();
    g.particles.dust(ch.mesh.position.x, ch.mesh.position.y, ch.mesh.position.z, 8);
    if (placed.length) g.checkSupport(placed);
  }

  // break a chunk into rigid bricks + small debris
  shatter(ch: RigidChunk, impactSpeed: number): void {
    const g = this.game, w = g.world, p = new THREE.Vector3();
    const n = ch.blocks.length;
    const lv = ch.body.linvel(), av = ch.body.angvel();
    const com = ch.body.worldCom();
    const room = MAX_BRICKS - this.bricks.length;
    const brickChance = Math.min(1, Math.max(0.15, room / n));
    for (let i = 0; i < n; i++) {
      const t = ch.blocks[i][3];
      this.blockCenter(ch, i, p);
      if (t === B.TNT) { this.primeTNT(p.x, p.y, p.z, 0.1 + Math.random() * 0.3); continue; }
      // velocity of this point on the rotating body
      const rx = p.x - com.x, ry = p.y - com.y, rz = p.z - com.z;
      const vx = lv.x + av.y * rz - av.z * ry, vy = lv.y + av.z * rx - av.x * rz, vz = lv.z + av.x * ry - av.y * rx;
      const k = impactSpeed * 0.25;
      if (t !== B.LEAVES && Math.random() < brickChance) {
        this.addBrick(p.x, p.y, p.z, t, vx * 0.5 + (Math.random() - 0.5) * k, Math.abs(vy) * 0.2 + Math.random() * k, vz * 0.5 + (Math.random() - 0.5) * k, ch.mesh.quaternion);
      } else {
        const bd = BLOCKS[t];
        g.physics.addDebris(p.x, p.y, p.z, bd.cSide.clone().multiplyScalar(0.9), 0.3 + Math.random() * 0.3, vx * 0.4 + (Math.random() - 0.5) * 5, Math.random() * 5 + 2, vz * 0.4 + (Math.random() - 0.5) * 5);
      }
      if (impactSpeed > 8 && Math.random() < 0.25) w.damageBlock(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z), impactSpeed * 0.25, 'crush');
    }
    if (impactSpeed > 0) {
      g.particles.dust(com.x, com.y - 0.5, com.z, Math.min(40, 6 + n));
      const pd = g.player.pos.distanceTo(_v.set(com.x, com.y, com.z));
      g.shake(Math.min(0.9, 0.12 + n * 0.01) * Math.max(0, 1 - pd / 40));
      g.audio.crash(Math.min(1, n / 50));
    }
  }

  // ---------- rigid bricks ----------
  addBrick(x: number, y: number, z: number, type: number, vx: number, vy: number, vz: number, quat?: THREE.Quaternion): void {
    const R = this.R;
    if (this.bricks.length >= MAX_BRICKS) this.retireBrick(this.bricks[0], false);
    const desc = R.RigidBodyDesc.dynamic().setTranslation(x, y, z).setLinvel(vx, vy, vz)
      .setAngvel({ x: (Math.random() - 0.5) * 4, y: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 4 }).setAngularDamping(0.3);
    if (quat) desc.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w });
    const body = this.rw.createRigidBody(desc);
    this.rw.createCollider(R.ColliderDesc.cuboid(0.48, 0.48, 0.48).setDensity(1).setFriction(0.8).setRestitution(0.1), body);
    this.bricks.push({ body, type, t: 0, still: 0, color: BLOCKS[type].cSide, slot: -1 });
  }

  retireBrick(b: Brick, toWorld: boolean): void {
    const g = this.game, w = g.world;
    const t = b.body.translation();
    const idx = this.bricks.indexOf(b);
    if (idx >= 0) this.bricks.splice(idx, 1);
    this.rw.removeRigidBody(b.body);
    if (toWorld) {
      let x = Math.floor(t.x), y = Math.floor(t.y), z = Math.floor(t.z);
      if (w.solid(x, y, z)) y++;
      if (w.inBounds(x, y, z) && !w.solid(x, y, z) && w.solid(x, y - 1, z) && !g.entities.blocksCell(x, y, z)) {
        w.set(x, y, z, b.type);
        g.checkSupport([[x, y, z]]);
        return;
      }
    }
    g.physics.burstBlock(t.x - 0.5, t.y - 0.5, t.z - 0.5, b.type, 3, 2);
  }

  updateBricks(dt: number): void {
    const g = this.game, enemies = g.entities.enemies;
    const mesh = this.brickMesh, mat = mesh.instanceMatrix.array as Float32Array;
    let n = 0, recoloured = false;
    for (let i = 0; i < this.bricks.length; i++) {
      const b = this.bricks[i];
      b.t += dt;
      const lv = b.body.linvel();
      const sp2 = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z;
      b.still = sp2 < 0.15 ? b.still + dt : 0;
      const t = b.body.translation();
      if (b.body.isSleeping() || b.still > 0.5 || b.t > 9 || t.y < -5) { this.retireBrick(b, t.y > -5); i--; continue; }
      // flying bricks hurt enemies
      if (sp2 > 40) {
        for (const e of enemies) {
          if (e.dead) continue;
          const dx = e.pos.x - t.x, dz = e.pos.z - t.z, dy = e.pos.y + e.h * 0.5 - t.y;
          if (dx * dx + dz * dz < 0.7 && Math.abs(dy) < e.h * 0.6 + 0.5) {
            e.damage(Math.sqrt(sp2) * 2.2, new THREE.Vector3(lv.x * 0.3, 2, lv.z * 0.3), 'crush');
            b.body.setLinvel({ x: lv.x * 0.3, y: lv.y, z: lv.z * 0.3 }, true);
          }
        }
      }
      const r = b.body.rotation();
      _m.compose(_v.set(t.x, t.y, t.z), _q.set(r.x, r.y, r.z, r.w), _s).toArray(mat, n * 16);
      // colour is per-slot: only rewrite it when this brick lands in a different instance
      if (b.slot !== n) { mesh.setColorAt(n, b.color); b.slot = n; recoloured = true; }
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (recoloured && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  // ---------- primed TNT ----------
  primeTNT(x: number, y: number, z: number, fuse = 1.6): void {
    const R = this.R, g = this.game;
    const grp = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0xd8443a, emissive: 0x000000 });
    const band = new THREE.MeshLambertMaterial({ color: 0xeee4d0, emissive: 0x000000 });
    grp.add(new THREE.Mesh(this.tntGeo, mat), new THREE.Mesh(this.bandGeo, band));
    grp.children.forEach(c => { c.castShadow = true; });
    g.scene.add(grp);
    const body = this.rw.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x, y, z)
      .setLinvel((Math.random() - 0.5) * 2, 3, (Math.random() - 0.5) * 2).setAngvel({ x: Math.random() * 4 - 2, y: Math.random() * 4 - 2, z: Math.random() * 4 - 2 }));
    this.rw.createCollider(R.ColliderDesc.cuboid(0.45, 0.45, 0.45).setDensity(1.5).setFriction(0.7).setRestitution(0.2), body);
    this.tnts.push({ grp, mat, band, body, fuse, t: 0, total: fuse });
    g.audio.fuse();
  }

  updateTNT(dt: number): void {
    const g = this.game;
    for (let i = 0; i < this.tnts.length; i++) {
      const T = this.tnts[i];
      T.t += dt; T.fuse -= dt;
      const t = T.body.translation(), r = T.body.rotation();
      T.grp.position.set(t.x, t.y, t.z); T.grp.quaternion.set(r.x, r.y, r.z, r.w);
      const flash = Math.sin(T.t * (8 + (1 - T.fuse / Math.max(0.2, T.total)) * 22)) > 0 ? 0.9 : 0;
      T.mat.emissive.setRGB(flash, flash, flash); T.band.emissive.setRGB(flash, flash, flash);
      T.grp.scale.setScalar(1 + Math.max(0, 0.3 - T.fuse));
      if (Math.random() < 0.5) g.particles.sparks(t.x, t.y + 0.5, t.z, 1);
      if (T.fuse <= 0) {
        g.scene.remove(T.grp);
        this.rw.removeRigidBody(T.body);
        this.tnts.splice(i, 1); i--;
        g.explode(new THREE.Vector3(t.x, t.y, t.z), 4.2, 17, 'tnt');
      }
    }
  }

  impulse(center: THREE.Vector3, radius: number, force: number): void {
    const apply = (body: RigidBody) => {
      const t = body.translation();
      _v.set(t.x - center.x, t.y - center.y, t.z - center.z);
      const d = _v.length();
      if (d > radius) return;
      const k = (1 - d / radius) * force * body.mass();
      _v.normalize();
      body.applyImpulse({ x: _v.x * k, y: (_v.y + 0.6) * k, z: _v.z * k }, true);
    };
    for (const b of this.bricks) apply(b.body);
    for (const T of this.tnts) apply(T.body);
    for (const ch of this.chunks) apply(ch.body);
  }

  update(dt: number): void {
    this.acc = Math.min(this.acc + dt, STEP * 3);
    while (this.acc >= STEP) { this.rw.step(this.eq); this.acc -= STEP; }
    this.updateChunks(dt);
    this.updateBricks(dt);
    this.updateTNT(dt);
  }
}
