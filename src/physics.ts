// Voxel physics: tumbling debris cubes, detached structures that fall as rigid
// bodies (and shatter / leave rubble on impact), and primed TNT.
// Everything here floats or sinks in water by its material density (helpers shared with rigid.ts).
import * as THREE from 'three';
import type { Entity } from './entities';
import { B, BLOCKS, patchWorldMaterial } from './world';
import { RigidPhysics, DENSITY, GRAV, waterTop, swell, current, splash } from './rigid';
import type { ChunkBlock } from './rigid';
import type { Game } from './main';

/** dens: material density (water = 1); wet: submerged fraction last frame */
interface DebrisItem { p: THREE.Vector3; v: THREE.Vector3; q: THREE.Quaternion; w: THREE.Vector3; s: number; c: THREE.Color; life: number; max: number; rest: number; slot: number; dens: number; wet: number }
interface FallingChunk {
  mesh: THREE.Mesh; blocks: ChunkBlock[]; local: THREE.Vector3[]; samples: number[]; vel: THREE.Vector3; w: THREE.Vector3;
  t: number; hit: Set<Entity>; radius: number;
  /** average material density, submerged fraction last frame, seconds spent floating */
  dens: number; wet: number; floatT: number;
}
interface TntEntry { grp: THREE.Group; mat: THREE.MeshLambertMaterial; band: THREE.MeshLambertMaterial; v: THREE.Vector3; fuse: number; t: number; wet: number }

const G = GRAV;
// water drag on small debris (1/s, per unit submerged fraction); splashes from debris per frame at most
const DEBRIS_DRAG = 3.5, DEBRIS_SPLASHES = 3;
// the fallback's floating structures break up into (floating) debris after this many seconds
const FALLBACK_FLOAT_LIFE = 30;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _v = new THREE.Vector3(), _e = new THREE.Euler();

export class Physics {
  game: Game;
  cap: number;
  mesh: THREE.InstancedMesh;
  debris: DebrisItem[];
  chunks: FallingChunk[];
  tnts: TntEntry[];
  chunkMat: THREE.MeshLambertMaterial;
  tntGeo: THREE.BoxGeometry;
  bandGeo: THREE.BoxGeometry;
  rigid: RigidPhysics | null;
  private waterT = 0; // clock for the swell and the current

  constructor(game: Game) {
    this.game = game;
    this.cap = 1400;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial();
    this.mesh = new THREE.InstancedMesh(geo, mat, this.cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true; this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    for (let i = 0; i < this.cap; i++) this.mesh.setColorAt(i, new THREE.Color(1, 1, 1));
    game.scene.add(this.mesh);
    this.debris = [];
    this.chunks = [];
    this.tnts = [];
    this.chunkMat = patchWorldMaterial(new THREE.MeshLambertMaterial({ vertexColors: true }), { cutaway: false, emissive: true, clouds: false });
    // primed TNT model: red block with white band
    this.tntGeo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
    this.bandGeo = new THREE.BoxGeometry(0.94, 0.3, 0.94);
    // Rapier handles falling structures, bricks and TNT when available
    this.rigid = game.R ? new RigidPhysics(game, game.R) : null;
  }

  // ---------- debris ----------
  /** dens: material density (water = 1; the default sinks, like shell casings and stone chips) */
  addDebris(x: number, y: number, z: number, color: THREE.Color, size: number, vx: number, vy: number, vz: number, life = 5 + Math.random() * 4, dens = 2): void {
    if (this.debris.length >= this.cap) this.debris.shift();
    this.debris.push({
      p: new THREE.Vector3(x, y, z), v: new THREE.Vector3(vx, vy, vz),
      q: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6)),
      w: new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14),
      s: size, c: color.clone(), life, max: life, rest: 0, slot: -1, dens, wet: 0,
    });
  }

  burstBlock(x: number, y: number, z: number, type: number, power = 5, n = 3): void {
    const bd = BLOCKS[type];
    if (!bd) return;
    for (let i = 0; i < n; i++) {
      const c = (i % 2 ? bd.cSide : bd.cTop).clone().multiplyScalar(0.85 + Math.random() * 0.3);
      this.addDebris(x + 0.5 + (Math.random() - 0.5) * 0.6, y + 0.5 + (Math.random() - 0.5) * 0.6, z + 0.5 + (Math.random() - 0.5) * 0.6,
        c, 0.22 + Math.random() * 0.25,
        (Math.random() - 0.5) * power, Math.random() * power * 0.8 + 2, (Math.random() - 0.5) * power, undefined, DENSITY[type]);
    }
  }

  updateDebris(dt: number): void {
    const w = this.game.world;
    const enemies = this.game.entities.enemies;
    const list = this.debris, mesh = this.mesh;
    const mat = mesh.instanceMatrix.array as Float32Array;
    let n = 0, touched = false, recoloured = false, splashes = 0;
    const T = this.waterT;
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      d.life -= dt;
      if (d.life <= 0) continue; // dropped by the in-place compaction below
      let moving = false;
      if (d.rest < 1) {
        moving = true;
        d.v.y -= G * dt;
        const h = d.s * 0.5;
        // water: lift by the submerged fraction over the density, drag toward the slow current (floating chips
        // never land, so they drift until their life runs out)
        const top = waterTop(w, Math.floor(d.p.x), Math.floor(d.p.z), Math.floor(d.p.y - h), Math.floor(d.p.y + h));
        if (top > -Infinity) {
          let f = (top + swell(d.p.x, d.p.z, T) - d.p.y + h) / d.s;
          f = f < 0 ? 0 : f > 1 ? 1 : f;
          if (f > 0) {
            if (!d.wet && d.v.y < -5 && d.s > 0.25 && splashes < DEBRIS_SPLASHES) { splashes++; splash(this.game, d.p.x, top, d.p.z, 0.08); }
            d.v.y += G * dt * f / d.dens;
            const [ux, uz] = current(d.p.x, d.p.z, T), k = 1 - Math.exp(-DEBRIS_DRAG * f * dt);
            d.v.x += (ux - d.v.x) * k; d.v.y -= d.v.y * k; d.v.z += (uz - d.v.z) * k;
            d.w.multiplyScalar(1 - k);
          }
          d.wet = f;
        } else d.wet = 0;
        const nx = d.p.x + d.v.x * dt;
        if (w.solidAt(nx + Math.sign(d.v.x) * h, d.p.y, d.p.z)) { d.v.x *= -0.35; d.w.multiplyScalar(0.8); } else d.p.x = nx;
        const nz = d.p.z + d.v.z * dt;
        if (w.solidAt(d.p.x, d.p.y, nz + Math.sign(d.v.z) * h)) { d.v.z *= -0.35; d.w.multiplyScalar(0.8); } else d.p.z = nz;
        const ny = d.p.y + d.v.y * dt;
        if (d.v.y < 0 && w.solidAt(d.p.x, ny - h, d.p.z)) {
          d.p.y = Math.floor(ny - h) + 1 + h;
          if (Math.abs(d.v.y) < 2.5) { d.v.y = 0; d.v.x *= 0.82; d.v.z *= 0.82; d.w.multiplyScalar(0.7); }
          else { d.v.y *= -0.32; d.v.x *= 0.7; d.v.z *= 0.7; d.w.multiplyScalar(0.6); }
          if (d.v.lengthSq() < 0.05) d.rest += dt * 3;
        } else if (d.v.y > 0 && w.solidAt(d.p.x, ny + h, d.p.z)) d.v.y = 0;
        else d.p.y = ny;
        if (d.p.y < -5) d.life = 0;
        // fast debris hurts enemies (angry-birds style)
        const sp2 = d.v.lengthSq();
        if (sp2 > 64 && d.s > 0.3) {
          for (const e of enemies) {
            if (e.dead) continue;
            const dx = e.pos.x - d.p.x, dz = e.pos.z - d.p.z, dy = (e.pos.y + e.h * 0.5) - d.p.y;
            if (dx * dx + dz * dz < 0.5 && Math.abs(dy) < e.h * 0.6) { e.damage(Math.sqrt(sp2) * 1.2, d.v.clone().multiplyScalar(0.15), 'crush'); d.v.multiplyScalar(-0.3); }
          }
        }
        const wl2 = d.w.lengthSq();
        if (wl2 > 1e-4) {
          const wl = Math.sqrt(wl2);
          _q.setFromAxisAngle(_v.copy(d.w).multiplyScalar(1 / wl), wl * dt);
          d.q.premultiply(_q);
        }
      }
      list[n] = d;
      // colour only changes when the item moves to a different instance slot
      if (d.slot !== n) { mesh.setColorAt(n, d.c); recoloured = true; }
      // resting debris keeps its matrix unless it moved slot or is fading out
      if (moving || d.slot !== n || d.life < 0.8) {
        const sc = d.s * Math.min(1, d.life / 0.8);
        _m.compose(d.p, d.q, _s.set(sc, sc, sc));
        _m.toArray(mat, n * 16);
        touched = true;
      }
      d.slot = n;
      n++;
    }
    list.length = n;
    mesh.count = n;
    if (touched) mesh.instanceMatrix.needsUpdate = true;
    if (recoloured && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  // ---------- falling structures ----------
  addChunk(blocks: ChunkBlock[]): void {
    if (this.rigid) return this.rigid.addChunk(blocks);
    const c = new THREE.Vector3();
    for (const [x, y, z] of blocks) c.add(_v.set(x + 0.5, y + 0.5, z + 0.5));
    c.divideScalar(blocks.length);
    const key = (x: number, y: number, z: number) => x + ',' + y + ',' + z;
    const set = new Set(blocks.map(([x, y, z]) => key(x, y, z)));
    const pos: number[] = [], nor: number[] = [], col: number[] = [], emit: number[] = [], ind: number[] = [];
    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;
    const local: THREE.Vector3[] = [];
    let minY = Infinity;
    for (const [x, y, z, t] of blocks) {
      const lx = x + 0.5 - c.x, ly = y + 0.5 - c.y, lz = z + 0.5 - c.z;
      local.push(new THREE.Vector3(lx, ly, lz));
      minY = Math.min(minY, ly);
      const bd = BLOCKS[t];
      for (let f = 0; f < 6; f++) {
        const [dx, dy, dz] = dirs[f];
        if (set.has(key(x + dx, y + dy, z + dz))) continue;
        const a = dx ? 0 : dy ? 1 : 2, s = dx + dy + dz;
        const u = (a + 1) % 3, v = (a + 2) % 3;
        const base = pos.length / 3;
        const fc = a === 1 ? (s > 0 ? bd.cTop : bd.cBottom) : bd.cSide;
        const tint = 0.85 + Math.random() * 0.15;
        for (let k = 0; k < 4; k++) {
          const q = [lx - 0.5, ly - 0.5, lz - 0.5];
          q[a] += s > 0 ? 1 : 0; q[u] += (k === 1 || k === 2) ? 1 : 0; q[v] += k >= 2 ? 1 : 0;
          pos.push(q[0], q[1], q[2]); nor.push(dx, dy, dz);
          col.push(fc.r * tint, fc.g * tint, fc.b * tint); emit.push(bd.emit);
        }
        const tris = s > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
        for (const ti of tris) ind.push(base + ti);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('emit', new THREE.Float32BufferAttribute(emit, 1));
    geo.setIndex(ind);
    const mesh = new THREE.Mesh(geo, this.chunkMat);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.position.copy(c);
    this.game.scene.add(mesh);
    // sample points used for collision: lowest blocks first, then the rest
    const order = local.map((p, i) => i).sort((i, j) => local[i].y - local[j].y);
    const samples = order.slice(0, Math.min(order.length, 260));
    const axis = new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
    const n = blocks.length;
    let dens = 0;
    for (const b of blocks) dens += DENSITY[b[3]];
    this.chunks.push({
      mesh, blocks, local, samples, vel: new THREE.Vector3(0, -0.5, 0),
      w: axis.multiplyScalar((0.35 + Math.random() * 0.6) * (n < 6 ? 2.5 : 1)), t: 0, hit: new Set(),
      radius: Math.max(...local.map(p => p.length())) + 1, dens: dens / n, wet: 0, floatT: 0,
    });
    this.game.audio.creak(Math.min(1, n / 60));
  }

  updateChunks(dt: number): void {
    const g = this.game, w = g.world;
    for (let ci = 0; ci < this.chunks.length; ci++) {
      const ch = this.chunks[ci];
      ch.t += dt;
      ch.vel.y -= G * dt;
      // water (no torques here: a falling chunk just spins down): lift and drag by the submerged fraction of up to
      // 64 of its lowest blocks
      const f = this.chunkWet(ch);
      if (f > 0) {
        if (!ch.wet && ch.vel.y < -3) splash(g, ch.mesh.position.x, ch.mesh.position.y, ch.mesh.position.z, Math.min(1, -ch.vel.y / 20));
        ch.vel.y += G * dt * f / ch.dens;
        const [ux, uz] = current(ch.mesh.position.x, ch.mesh.position.z, this.waterT), k = 1 - Math.exp(-2 * f * dt);
        ch.vel.x += (ux - ch.vel.x) * k; ch.vel.y -= ch.vel.y * k; ch.vel.z += (uz - ch.vel.z) * k;
        ch.w.multiplyScalar(Math.exp(-4 * f * dt)); // (water stops the tipping)
        if (ch.dens < 1 && f > ch.dens * 0.25) ch.floatT += dt;
      }
      ch.wet = f;
      if (ch.floatT > FALLBACK_FLOAT_LIFE) { // waterlogged: breaks up into floating debris, nothing is written
        for (let i = 0; i < ch.blocks.length; i++) {
          _v.copy(ch.local[i]).applyQuaternion(ch.mesh.quaternion).add(ch.mesh.position);
          if (i % 2 === 0) this.addDebris(_v.x, _v.y, _v.z, BLOCKS[ch.blocks[i][3]].cSide.clone(), 0.35, 0, 0, 0, undefined, DENSITY[ch.blocks[i][3]]);
        }
        this.game.scene.remove(ch.mesh); ch.mesh.geometry.dispose();
        this.chunks.splice(ci, 1); ci--;
        continue;
      }
      const prev = ch.mesh.position.clone(), prevQ = ch.mesh.quaternion.clone();
      ch.mesh.position.addScaledVector(ch.vel, dt);
      // tipping accelerates as it falls
      ch.w.multiplyScalar(1 + dt * 0.8);
      _q.setFromAxisAngle(_v.copy(ch.w).normalize(), ch.w.length() * dt);
      ch.mesh.quaternion.premultiply(_q);
      let hit = false;
      for (const si of ch.samples) {
        _v.copy(ch.local[si]).applyQuaternion(ch.mesh.quaternion).add(ch.mesh.position);
        if (w.solidAt(_v.x, _v.y - 0.45, _v.z)) { hit = true; break; }
      }
      // crush entities in the way
      const speed = ch.vel.length();
      if (speed > 3) {
        for (const e of g.entities.all()) {
          if (e.dead || ch.hit.has(e)) continue;
          const ec = _s.set(e.pos.x, e.pos.y + e.h * 0.5, e.pos.z);
          if (ec.distanceTo(ch.mesh.position) > ch.radius) continue;
          for (const si of ch.samples) {
            _v.copy(ch.local[si]).applyQuaternion(ch.mesh.quaternion).add(ch.mesh.position);
            if (_v.distanceToSquared(ec) < 0.9) {
              ch.hit.add(e);
              e.damage(18 + speed * 4, new THREE.Vector3(0, -2, 0), 'crush');
              break;
            }
          }
        }
      }
      if (!hit && ch.mesh.position.y > -10) continue;
      ch.mesh.position.copy(prev); ch.mesh.quaternion.copy(prevQ);
      // a floating one that ran aground in the shallows stays afloat (it never lands mid-water)
      if (ch.dens < 1 && ch.wet > ch.dens * 0.25) { ch.vel.set(ch.vel.x * -0.3, Math.max(0, ch.vel.y), ch.vel.z * -0.3); continue; }
      this.resolveChunk(ch, ch.wet > 0 ? Math.min(speed, 7) : speed); // (landing through water is gentle)
      this.game.scene.remove(ch.mesh); ch.mesh.geometry.dispose();
      this.chunks.splice(ci, 1); ci--;
    }
  }

  /** submerged fraction of a fallback chunk, over up to 64 of its lowest blocks */
  private chunkWet(ch: FallingChunk): number {
    const w = this.game.world, n = Math.min(64, ch.samples.length);
    let sub = 0;
    for (let i = 0; i < n; i++) {
      _v.copy(ch.local[ch.samples[i]]).applyQuaternion(ch.mesh.quaternion).add(ch.mesh.position);
      const top = waterTop(w, Math.floor(_v.x), Math.floor(_v.z), Math.floor(_v.y - 0.5), Math.floor(_v.y + 0.5));
      if (top > -Infinity) sub += Math.min(1, Math.max(0, top - _v.y + 0.5));
    }
    // (the samples are the lowest blocks: scale to the whole body, which is never wetter than its bottom)
    return n ? sub / n * Math.min(1, n / ch.blocks.length + 0.5) : 0;
  }

  resolveChunk(ch: FallingChunk, speed: number): void {
    const g = this.game, w = g.world;
    const n = ch.blocks.length;
    // a 1-block drop lands at ~7.3 blocks/s (the hit test fires 0.45 above the floor): that must stay gentle, as it
    // does with Rapier, instead of shattering most of a structure that merely sagged one cell
    const gentle = speed < 8 && ch.t < 0.45;
    const placed: [number, number, number][] = [];
    const debrisBudget = Math.max(0, Math.min(500, this.cap - this.debris.length + 200));
    const perBlock = Math.max(0.15, Math.min(2, debrisBudget / n));
    let impactCenter = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const t = ch.blocks[i][3];
      _v.copy(ch.local[i]).applyQuaternion(ch.mesh.quaternion).add(ch.mesh.position);
      impactCenter.add(_v);
      const bx = Math.floor(_v.x), by = Math.floor(_v.y), bz = Math.floor(_v.z);
      if (t === B.TNT) { g.physics.primeTNT(_v.x, _v.y, _v.z, 0.1 + Math.random() * 0.3); continue; }
      const keep = gentle ? 0.95 : (t === B.LEAVES ? 0.05 : 0.3);
      if (Math.random() < keep) {
        // drop the block down its column into a rubble pile
        let y = by;
        if (!w.solid(bx, y, bz)) {
          while (y > 0 && !w.solid(bx, y - 1, bz)) y--;
        } else {
          while (y < w.H - 1 && w.solid(bx, y, bz)) y++;
        }
        if (y < w.H && !w.solid(bx, y, bz) && !g.entities.blocksCell(bx, y, bz)) { w.set(bx, y, bz, t); placed.push([bx, y, bz]); continue; }
      }
      // otherwise shatter into debris
      if (Math.random() < perBlock) {
        const bd = BLOCKS[t];
        const cnt = perBlock > 1 ? 2 : 1;
        for (let k = 0; k < cnt; k++) {
          this.addDebris(_v.x, _v.y, _v.z, (k ? bd.cSide : bd.cTop).clone().multiplyScalar(0.8 + Math.random() * 0.3), 0.3 + Math.random() * 0.35,
            ch.vel.x * 0.4 + (Math.random() - 0.5) * 6, Math.random() * 5 + 2, ch.vel.z * 0.4 + (Math.random() - 0.5) * 6, undefined, DENSITY[t]);
        }
      } else g.particles.chips(_v.x, _v.y, _v.z, BLOCKS[t].cSide, 2);
      // crushing damage to whatever it landed on
      if (!gentle && Math.random() < 0.3) w.damageBlock(bx, by - 1, bz, speed * 0.25, 'crush');
    }
    impactCenter.divideScalar(n);
    if (!gentle) {
      g.particles.dust(impactCenter.x, impactCenter.y - 0.5, impactCenter.z, Math.min(40, 6 + n));
      g.shake(Math.min(1.2, 0.15 + n * 0.012));
      g.audio.crash(Math.min(1, n / 50));
    } else g.audio.thud();
    if (placed.length) g.checkSupport(placed);
  }

  // ---------- primed TNT ----------
  primeTNT(x: number, y: number, z: number, fuse = 1.6): void {
    if (this.rigid) return this.rigid.primeTNT(x, y, z, fuse);
    const grp = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0xd8443a, emissive: 0x000000 });
    const band = new THREE.MeshLambertMaterial({ color: 0xeee4d0, emissive: 0x000000 });
    grp.add(new THREE.Mesh(this.tntGeo, mat));
    grp.add(new THREE.Mesh(this.bandGeo, band));
    grp.children.forEach(c => { c.castShadow = true; });
    grp.position.set(x, y, z);
    this.game.scene.add(grp);
    this.tnts.push({ grp, mat, band, v: new THREE.Vector3((Math.random() - 0.5) * 2, 3, (Math.random() - 0.5) * 2), fuse, t: 0, wet: 0 });
    this.game.audio.fuse();
  }

  updateTNT(dt: number): void {
    const g = this.game, w = g.world;
    for (let i = 0; i < this.tnts.length; i++) {
      const T = this.tnts[i];
      T.t += dt; T.fuse -= dt;
      T.v.y -= G * dt;
      const p = T.grp.position;
      const top = waterTop(w, Math.floor(p.x), Math.floor(p.z), Math.floor(p.y - 0.45), Math.floor(p.y + 0.45));
      const f = top > -Infinity ? Math.min(1, Math.max(0, (top + swell(p.x, p.z, this.waterT) - p.y + 0.45) / 0.9)) : 0;
      if (f > 0) {
        if (!T.wet && T.v.y < -3) splash(g, p.x, top, p.z, 0.3);
        T.v.y += G * dt * f / DENSITY[B.TNT];
        const k = 1 - Math.exp(-3 * f * dt);
        T.v.multiplyScalar(1 - k);
      }
      T.wet = f;
      const nx = p.x + T.v.x * dt, nz = p.z + T.v.z * dt, ny = p.y + T.v.y * dt;
      if (!w.solidAt(nx, p.y, p.z)) p.x = nx; else T.v.x *= -0.3;
      if (!w.solidAt(p.x, p.y, nz)) p.z = nz; else T.v.z *= -0.3;
      if (T.v.y < 0 && w.solidAt(p.x, ny - 0.45, p.z)) { p.y = Math.floor(ny - 0.45) + 1.45; T.v.y *= -0.2; T.v.x *= 0.8; T.v.z *= 0.8; }
      else p.y = ny;
      const flash = Math.sin(T.t * (8 + (1.6 - T.fuse) * 14)) > 0;
      const e = flash ? 0.9 : 0;
      T.mat.emissive.setRGB(e, e, e); T.band.emissive.setRGB(e, e, e);
      const sc = 1 + (T.fuse < 0.3 ? (0.3 - T.fuse) : 0);
      T.grp.scale.setScalar(sc);
      if (Math.random() < 0.5) g.particles.sparks(p.x, p.y + 0.5, p.z, 1);
      if (p.y < -10) { g.scene.remove(T.grp); this.tnts.splice(i, 1); i--; continue; } // fell out of the loaded world
      if (T.fuse <= 0) {
        g.scene.remove(T.grp);
        this.tnts.splice(i, 1); i--;
        g.explode(p.clone(), 4.2, 17, 'tnt');
      }
    }
  }

  impulse(center: THREE.Vector3, radius: number, force: number): void {
    if (this.rigid) this.rigid.impulse(center, radius, force * 0.6);
    for (const d of this.debris) {
      _v.subVectors(d.p, center);
      const dist = _v.length();
      if (dist > radius) continue;
      const k = (1 - dist / radius) * force;
      d.v.addScaledVector(_v.normalize(), k); d.v.y += k * 0.6; d.rest = 0;
    }
    for (const T of this.tnts) {
      _v.subVectors(T.grp.position, center);
      const dist = _v.length();
      if (dist > radius || dist < 0.01) continue;
      const k = (1 - dist / radius) * force * 0.6;
      T.v.addScaledVector(_v.normalize(), k); T.v.y += k * 0.5;
    }
  }

  /** drop every dynamic body; `at` is where the player will be (the terrain is re-mirrored around it) */
  reset(at?: ArrayLike<number>): void {
    for (const ch of this.chunks) { this.game.scene.remove(ch.mesh); ch.mesh.geometry.dispose(); }
    for (const T of this.tnts) this.game.scene.remove(T.grp);
    this.chunks = []; this.tnts = []; this.debris = [];
    this.mesh.count = 0;
    if (this.rigid) this.rigid.reset(at);
  }
  /** whether falling bodies are near this column (so the world must keep it loaded) */
  columnInUse(cx: number, cz: number): boolean { return this.rigid ? this.rigid.columnInUse(cx, cz) : false; }


  update(dt: number): void {
    this.waterT += dt;
    if (this.rigid) this.rigid.update(dt);
    this.updateChunks(dt);
    this.updateDebris(dt);
    this.updateTNT(dt);
  }
}
void _e;
