// Billboarded pixel-art actors living in the 3D voxel world.
import * as THREE from 'three';
import { B, BLOCKS, WATER_LEVEL } from './world.js';
import { makeBlobTexture } from './sprites.js';

const G = 25;
const _v = new THREE.Vector3(), _w = new THREE.Vector3();
let blobTex = null;
const planeCache = {};
function spritePlane(w, h) {
  const k = w + 'x' + h;
  if (!planeCache[k]) { const g = new THREE.PlaneGeometry(w, h); g.translate(0, h / 2, 0); planeCache[k] = g; }
  return planeCache[k];
}

export class Entity {
  constructor(game, x, y, z, o) {
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

  makeSprite(tex, w, h, lean) {
    const g = this.game;
    this.tex = tex.clone(); this.tex.needsUpdate = true;
    this.tex.repeat.set(1 / 4, 1 / 3);
    this.lean = lean;
    const geo = spritePlane(w, h);
    this.mat = new THREE.MeshLambertMaterial({ map: this.tex, alphaTest: 0.5, side: THREE.DoubleSide, emissive: 0x000000 });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.castShadow = true;
    this.mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: this.tex, alphaTest: 0.5 });
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
    if (this.mesh) { s.remove(this.mesh); s.remove(this.xray); s.remove(this.blob); this.mat.dispose(); this.xmat.dispose(); this.blob.material.dispose(); this.mesh.customDepthMaterial.dispose(); this.tex.dispose(); }
  }

  // ---------- voxel collision ----------
  overlaps() {
    const w = this.game.world, p = this.pos, r = this.r - 0.001;
    const x0 = Math.floor(p.x - r), x1 = Math.floor(p.x + r);
    const y0 = Math.floor(p.y + 0.001), y1 = Math.floor(p.y + this.h - 0.001);
    const z0 = Math.floor(p.z - r), z1 = Math.floor(p.z + r);
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (w.get(x, y, z) !== B.AIR) return true;
    return false;
  }
  moveAxis(axis, amt) {
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
  physics(dt, gravity = G) {
    const w = this.game.world;
    // pop out if a block ended up inside us (placed, rubble, spawn)
    for (let i = 0; i < 4 && this.overlaps(); i++) this.pos.y = Math.floor(this.pos.y) + 1;
    this.inWater = this.pos.y + 0.4 < WATER_LEVEL && !w.solidAt(this.pos.x, this.pos.y + 0.5, this.pos.z);
    if (this.inWater) {
      this.vel.y = Math.max(this.vel.y - gravity * 0.25 * dt, -3);
      if (this.pos.y + 0.7 < WATER_LEVEL) this.vel.y += 12 * dt; // buoyancy
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

  damage(amt, knock, cause) {
    if (this.dead) return;
    this.hp -= amt;
    this.flash = 0.12;
    if (knock) { this.vel.add(knock); if (knock.y > 1) this.onGround = false; }
    const g = this.game;
    if (amt >= 1 && this.mesh) g.ui.floatText(this.pos.x, this.pos.y + this.h + 0.2, this.pos.z, Math.round(amt), this.kind === 'player' ? '#ff6a6a' : (cause === 'burn' ? '#ffa040' : '#fff4c0'));
    if (this.hp <= 0) this.die(cause, knock);
  }
  die() { this.dead = true; }

  updateSprite(dt) {
    if (!this.mesh) return;
    const g = this.game;
    this.animT += dt * (this.walking ? 1 : 0);
    this.flash = Math.max(0, this.flash - dt);
    const fl = this.flash > 0 ? 0.9 : (this.burn > 0 ? 0.25 + Math.random() * 0.2 : 0);
    this.mat.emissive.setRGB(fl, fl * (this.burn > 0 && !this.flash ? 0.45 : 1), fl * (this.burn > 0 && !this.flash ? 0.1 : 1));
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
    for (const m of [this.mesh, this.xray]) {
      m.position.copy(this.pos);
      m.rotation.set(-g.camPitch * this.lean, yaw, this.spin || 0);
      m.scale.set(1, this.squash ?? 1, 1);
    }
    // blob shadow on the ground beneath
    const w = g.world;
    let gy = Math.floor(this.pos.y + 0.1);
    for (let i = 0; i < 10 && gy > 0 && !w.solid(Math.floor(this.pos.x), gy - 1, Math.floor(this.pos.z)); i++) gy--;
    const hgt = this.pos.y - gy;
    this.blob.position.set(this.pos.x, gy + 0.03, this.pos.z);
    this.blob.scale.setScalar(this.r * 3 * Math.max(0.4, 1 - hgt * 0.12));
    this.blob.material.opacity = Math.max(0.2, 1 - hgt * 0.15);
  }

  updateBurn(dt) {
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

  center(out = new THREE.Vector3()) { return out.set(this.pos.x, this.pos.y + this.h * 0.5, this.pos.z); }
  hitRadius() { return Math.max(this.r + 0.15, this.h * 0.45); }
}

// ---------------- player ----------------
function box(w, h, d, color, x = 0, y = 0, z = 0, emissive = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color, emissive }));
  m.position.set(x, y, z); m.castShadow = true;
  return m;
}
export function gunModel(kind) {
  const g = new THREE.Group();
  const dark = 0x3a3e48, mid = 0x5a606c, wood = 0x8a5a32;
  if (kind === 'pistol') { g.add(box(0.12, 0.12, 0.4, mid, 0, 0, 0.12)); g.add(box(0.1, 0.22, 0.12, wood, 0, -0.12, -0.02)); }
  else if (kind === 'shotgun') { g.add(box(0.12, 0.12, 0.9, dark, 0, 0.02, 0.3)); g.add(box(0.14, 0.16, 0.4, wood, 0, -0.04, -0.15)); g.add(box(0.1, 0.08, 0.3, wood, 0, -0.06, 0.35)); }
  else if (kind === 'smg') { g.add(box(0.14, 0.16, 0.6, mid, 0, 0, 0.15)); g.add(box(0.08, 0.28, 0.1, dark, 0, -0.18, 0.15)); g.add(box(0.06, 0.06, 0.25, dark, 0, 0.02, 0.55)); }
  else if (kind === 'rocket') { g.add(box(0.22, 0.22, 1.1, 0x5a7a4a, 0, 0.06, 0.1)); g.add(box(0.26, 0.26, 0.12, 0x3a4a30, 0, 0.06, 0.66)); g.add(box(0.08, 0.2, 0.1, dark, 0, -0.12, 0)); }
  else if (kind === 'grenade') { g.add(box(0.2, 0.24, 0.2, 0x5a7a3a, 0, 0, 0.1)); g.add(box(0.06, 0.08, 0.06, 0xaaaaaa, 0, 0.16, 0.1)); }
  else if (kind === 'pick') { g.add(box(0.07, 0.07, 0.8, wood, 0, 0, 0.3)); g.add(box(0.6, 0.1, 0.1, 0x9aa4ac, 0, 0, 0.66)); }
  else { const c = { planks: 0xc9955a, bricks: 0xa8705a, tnt: 0xd8443a, turret: 0x7a8a96, lantern: 0xffd27a }[kind] ?? 0xffffff; g.add(box(0.3, 0.3, 0.3, c, 0, 0, 0.15, kind === 'lantern' ? 0x664400 : 0)); }
  return g;
}

export class Player extends Entity {
  constructor(game, x, y, z, tex) {
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
  setModel(kind) {
    if (this.currentKind === kind) return;
    if (this.currentModel) this.gunHolder.remove(this.currentModel);
    if (!this.models[kind]) this.models[kind] = gunModel(kind);
    this.currentModel = this.models[kind]; this.currentKind = kind;
    this.gunHolder.add(this.currentModel);
  }
  update(dt, input) {
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
    let speed = this.inWater ? 3.5 : 6.2;
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
  damage(amt, knock, cause) {
    if (this.invuln > 0 && cause !== 'void') return;
    super.damage(amt, knock, cause);
    this.game.onPlayerHurt(amt);
  }
  die(cause) {
    this.dead = true;
    this.game.onPlayerDeath(cause);
  }
}

// ---------------- enemies ----------------
class Enemy extends Entity {
  constructor(game, x, y, z, o) {
    super(game, x, y, z, o);
    this.speed = o.speed; this.atk = o.atk; this.atkCd = 0; this.blockedT = 0; this.strafe = 0; this.strafeT = 0;
    this.goreCol = o.gore || [0.55, 0.05, 0.05];
    this.drops = o.drops || {};
    this.thinkT = Math.random();
    this.sound = o.sound;
  }
  pickTarget() {
    const g = this.game, p = g.entities.player;
    let best = p.dead ? null : p, bd = best ? best.pos.distanceToSquared(this.pos) * 0.6 : Infinity;
    for (const t of g.entities.turrets) { const d = t.pos.distanceToSquared(this.pos); if (d < bd) { bd = d; best = t; } }
    return best;
  }
  separation(out) {
    for (const o of this.game.entities.enemies) {
      if (o === this || o.dead) continue;
      const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz, rr = (this.r + o.r) * 1.3;
      if (d2 < rr * rr && d2 > 1e-4) { const d = Math.sqrt(d2); out.x += dx / d * (rr - d) * 4; out.z += dz / d * (rr - d) * 4; }
    }
    return out;
  }
  steer(dt, tgt, speedMul = 1, away = false) {
    let dx = tgt.pos.x - this.pos.x, dz = tgt.pos.z - this.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    if (away) { dx = -dx; dz = -dz; }
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
  die(cause, knock) {
    this.dead = true;
    const g = this.game;
    g.entities.addCorpse(this, knock);
    g.particles.blood(this.pos.x, this.pos.y + this.h * 0.5, this.pos.z, this.goreCol, 18, knock ? _v.copy(knock).normalize() : null);
    for (const [res, [n, chance]] of Object.entries(this.drops)) {
      if (Math.random() < chance) g.entities.addPickup(res, n, this.pos.x, this.pos.y + 0.6, this.pos.z);
    }
    g.kills++;
    g.audio.splat();
  }
  contactAttack(tgt, dist) {
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
  update(dt) {
    this.atkCd -= dt;
    if (this.squash !== undefined) this.squash = Math.min(1, (this.squash ?? 1) + dt * 2);
    this.think(dt);
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
  constructor(game, x, y, z, tex) {
    super(game, x, y, z, { tex, kind: 'zombie', hp: 70, speed: 2.4 + Math.random() * 0.8, atk: 12, r: 0.34, h: 1.75, gore: [0.5, 0.08, 0.06], drops: { metal: [1, 0.55], goo: [1, 0.25] }, sound: 'groan' });
    this.animSpeed = 5;
  }
  think(dt) {
    const tgt = this.pickTarget();
    if (!tgt) { this.walking = false; this.vel.x *= 0.9; this.vel.z *= 0.9; return; }
    const before = this.pos.clone();
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
            w.damageBlock(fx, yy, fz, 1.4, 'zombie');
            this.game.particles.chips(fx + 0.5, yy + 0.5, fz + 0.5, BLOCKS[t].cSide, 3);
            this.game.audio.thunk(0.6);
            this.atkCd = 0.8; this.squash = 0.82; broke = true; break;
          }
        }
        if (!broke && this.blockedT > 1.6) { this.strafe = Math.random() < 0.5 ? -1 : 1; this.strafeT = 1.4; this.blockedT = 0; }
      }
    } else this.blockedT = Math.max(0, this.blockedT - dt);
    void before;
  }
}

export class Crawler extends Enemy {
  constructor(game, x, y, z, tex) {
    super(game, x, y, z, { tex, kind: 'crawler', hp: 22, speed: 5.4, atk: 7, r: 0.38, h: 0.7, sw: 1.7, sh: 1.7, lean: 0.25, gore: [0.3, 0.8, 0.2], drops: { goo: [1, 0.7] }, sound: 'chitter' });
    this.sideOnly = true; this.animSpeed = 14; this.atkRate = 0.6; this.pounceCd = 1;
  }
  think(dt) {
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
  constructor(game, x, y, z, tex) {
    super(game, x, y, z, { tex, kind: 'spitter', hp: 38, speed: 2.8, atk: 6, r: 0.5, h: 1.1, sw: 2.3, sh: 2.3, lean: 0.3, gore: [0.35, 0.95, 0.25], drops: { goo: [2, 0.9], metal: [1, 0.3] }, sound: 'chitter' });
    this.sideOnly = true; this.animSpeed = 9; this.spitCd = 2 + Math.random() * 2;
  }
  think(dt) {
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

// ---------------- turret (3D model, not a sprite) ----------------
export class Turret extends Entity {
  constructor(game, x, y, z) {
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
    grp.traverse(m => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    this.head.children[3].userData.keep = true;
    this.grp = grp;
    game.scene.add(grp);
    this.cd = 0; this.ammo = 250; this.yaw = 0; this.side = 1;
  }
  update(dt) {
    const g = this.game;
    this.physics(dt);
    this.grp.position.copy(this.pos);
    this.cd -= dt;
    let best = null, bd = 18 * 18;
    for (const e of g.entities.enemies) {
      if (e.dead) continue;
      const d = e.pos.distanceToSquared(this.pos);
      if (d < bd) {
        const from = _v.set(this.pos.x, this.pos.y + 0.95, this.pos.z);
        const to = e.center(new THREE.Vector3());
        const dir = to.clone().sub(from); const L = dir.length(); dir.divideScalar(L);
        if (!g.world.raycast(from, dir, L).hit) { bd = d; best = e; }
      }
    }
    if (best) {
      const to = best.center(new THREE.Vector3());
      const want = Math.atan2(to.x - this.pos.x, to.z - this.pos.z);
      let diff = want - this.yaw; diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.yaw += diff * Math.min(1, dt * 10);
      if (Math.abs(diff) < 0.2 && this.cd <= 0 && this.ammo > 0) {
        this.cd = 0.16; this.ammo--; this.side = -this.side;
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
    this.grp.traverse(m => { if (m.isMesh && m.material.emissive && !m.userData.keep) m.material.emissive.setRGB(fl, fl, fl); });
    if (this.ammo <= 0 && !this.dead) { this.ammo = 0; g.ui.toast('A turret ran out of ammo'); this.die(); }
  }
  die() {
    if (this.dead) return;
    this.dead = true;
    this.game.scene.remove(this.grp);
    this.game.explode(this.pos.clone().add(new THREE.Vector3(0, 0.6, 0)), 2.2, 6, 'turret');
  }
}

// ---------------- manager ----------------
export class Entities {
  constructor(game, sheets) {
    this.game = game; this.sheets = sheets;
    this.player = null; this.enemies = []; this.turrets = []; this.pickups = []; this.corpses = [];
    this.spawnT = 3;
    this.pickGeo = new THREE.BoxGeometry(0.28, 0.28, 0.28);
    this.pickMats = {
      wood: new THREE.MeshLambertMaterial({ color: 0x9a6a3a }), stone: new THREE.MeshLambertMaterial({ color: 0xa8a6a0 }),
      metal: new THREE.MeshLambertMaterial({ color: 0x9ab4c8, emissive: 0x223344 }), goo: new THREE.MeshLambertMaterial({ color: 0x5adf3a, emissive: 0x1a6a10 }),
    };
  }
  all() { return [this.player, ...this.enemies, ...this.turrets].filter(e => e && !e.dead); }
  spawnPlayer(x, y, z) { this.player = new Player(this.game, x, y, z, this.sheets.player); return this.player; }

  spawnEnemy(type, x, y, z) {
    let e;
    if (type === 'zombie') e = new Zombie(this.game, x, y, z, this.sheets.zombies[(Math.random() * this.sheets.zombies.length) | 0]);
    else if (type === 'crawler') e = new Crawler(this.game, x, y, z, this.sheets.crawler);
    else e = new Spitter(this.game, x, y, z, this.sheets.spitter);
    this.enemies.push(e);
    return e;
  }

  randomSpawnPoint(minD = 24, maxD = 40) {
    const w = this.game.world, p = this.player.pos;
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2, d = minD + Math.random() * (maxD - minD);
      const x = Math.floor(p.x + Math.cos(a) * d), z = Math.floor(p.z + Math.sin(a) * d);
      if (x < 3 || z < 3 || x > w.W - 4 || z > w.D - 4) continue;
      const y = w.surfaceY(x, z);
      if (y <= WATER_LEVEL + 0.5) continue;
      return [x + 0.5, y + 0.1, z + 0.5];
    }
    return null;
  }

  spawnWave(n) {
    for (let i = 0; i < n; i++) {
      const sp = this.randomSpawnPoint(22, 42);
      if (!sp) continue;
      const r = Math.random();
      this.spawnEnemy(r < 0.55 ? 'zombie' : r < 0.85 ? 'crawler' : 'spitter', ...sp);
    }
  }

  addPickup(res, n, x, y, z) {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(this.pickGeo, this.pickMats[res] || this.pickMats.stone);
      m.castShadow = true;
      m.position.set(x, y, z);
      this.game.scene.add(m);
      this.pickups.push({ m, res, v: new THREE.Vector3((Math.random() - 0.5) * 4, 4 + Math.random() * 2, (Math.random() - 0.5) * 4), t: 0 });
    }
  }

  addCorpse(e, knock) {
    // detach the sprite and let it tumble away like a ragdoll
    const v = knock ? knock.clone().multiplyScalar(1.4) : new THREE.Vector3();
    v.y = Math.max(v.y, 4 + Math.random() * 3);
    this.corpses.push({ e, v, t: 0, spinV: (Math.random() < 0.5 ? -1 : 1) * (6 + Math.random() * 6) });
  }

  blocksCell(x, y, z) {
    for (const e of this.all()) {
      if (e.pos.x + e.r > x && e.pos.x - e.r < x + 1 && e.pos.z + e.r > z && e.pos.z - e.r < z + 1 && e.pos.y + e.h > y && e.pos.y < y + 1) return true;
    }
    return false;
  }

  // nearest entity hit along a segment (sphere approximation)
  raycast(o, d, maxDist, ignore) {
    let best = null, bt = maxDist;
    const c = new THREE.Vector3();
    for (const e of this.all()) {
      if (e === ignore || (ignore && ignore.kind === 'turret' && e.kind === 'turret') || (ignore && ignore.kind === 'player' && e.kind === 'turret') || (ignore && ignore.kind === 'turret' && e.kind === 'player')) continue;
      if (ignore && ignore.kind !== 'player' && ignore.kind !== 'turret' && e.kind !== 'player' && e.kind !== 'turret') continue; // enemies don't shoot each other
      e.center(c);
      const r = e.hitRadius();
      const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
      const b = ox * d.x + oy * d.y + oz * d.z;
      const cc = ox * ox + oy * oy + oz * oz - r * r;
      const disc = b * b - cc;
      if (disc < 0) continue;
      const t = -b - Math.sqrt(disc);
      if (t >= -r && t < bt) { bt = Math.max(0, t); best = e; }
    }
    return best ? { e: best, t: bt } : null;
  }

  update(dt) {
    const g = this.game;
    // spawning
    this.spawnT -= dt;
    const alive = this.enemies.filter(e => !e.dead).length;
    const night = g.isNight();
    if (this.spawnT <= 0 && alive < (night ? 45 : 18) && !this.player.dead) {
      this.spawnT = night ? 2.2 : 6.5;
      const sp = this.randomSpawnPoint();
      if (sp) {
        const r = Math.random();
        this.spawnEnemy(r < (night ? 0.5 : 0.6) ? 'zombie' : r < 0.85 ? 'crawler' : 'spitter', ...sp);
      }
    }
    for (const e of this.enemies) if (!e.dead) e.update(dt);
    for (const t of this.turrets) if (!t.dead) t.update(dt);
    this.enemies = this.enemies.filter(e => !e.dead);
    this.turrets = this.turrets.filter(t => !t.dead);
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
      if (k.t > 0.4 && d < 3.2 && !p.dead) {
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
