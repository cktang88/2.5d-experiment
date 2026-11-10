// @ts-nocheck
// Hard-surface geometry toolkit for the 3D prototype: chamfered slabs/boxes, cross-section lofts (hulls, wings,
// fuselages), profile lathes with hard ring edges, struts, and a per-material merging builder.
// Everything returned is non-indexed with flat (face) normals unless noted, so chamfers catch the light.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
// The game uses the original geometry without upstream's optional meshoptimizer pass.
const SIMP = 0;
function simplifyGeo(g: THREE.BufferGeometry): THREE.BufferGeometry { return g; }
export type V3 = [number, number, number];
export interface UMat { uid: number; base: THREE.Material }
export type MatLike = THREE.Material | UMat;
export type P2 = [number, number];

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/** Compose a matrix from position / Euler rotation (radians) / scale. */
export function mtx(p: V3 = [0, 0, 0], r: V3 = [0, 0, 0], s: number | V3 = 1): THREE.Matrix4 {
  const sc = typeof s === 'number' ? new THREE.Vector3(s, s, s) : new THREE.Vector3(...s);
  _q.setFromEuler(_e.set(r[0], r[1], r[2], 'XYZ'));
  return new THREE.Matrix4().compose(new THREE.Vector3(...p), _q, sc);
}

function prep(g: THREE.BufferGeometry, keepUv = false): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g.clone();
  for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal' && !(keepUv && k === 'uv')) n.deleteAttribute(k);
  n.clearGroups();
  if (!n.attributes.normal) n.computeVertexNormals();
  return n;
}

// ---- level of detail ------------------------------------------------------------------------------------------
/** Geometry detail for what is built inside withDetail(): 1 = full; below 1 round sections (lathes, cylinders,
 *  struts, superellipse rings) get proportionally fewer radial segments (never under 6, and sections already at 6 or
 *  fewer keep theirs, so hex / square profiles stay true) and slab / box chamfers are dropped (the plan outline stays).
 *  The battlefield draws units at the fit view from a template built at low detail (render3d/units-adapter.ts). */
let detail = 1;
export function geoDetail(): number { return detail; }
export function withDetail<T>(k: number, fn: () => T): T {
  const was = detail;
  detail = k;
  try { return fn(); } finally { detail = was; }
}
/** radial segment count under the current detail */
export function lodSeg(n: number): number { return detail >= 1 || n <= 6 ? n : Math.max(6, Math.round(n * detail)); }

// ---- slabs / boxes ------------------------------------------------------------------------------
/** Prism from a plan polygon (x, z), y from 0..h, with a flat chamfer b on the top/bottom edges. Outline stays exact. */
export function slabGeo(poly: P2[], h: number, b = 0.02): THREE.BufferGeometry {
  const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z)));
  b = detail < 1 ? 0 : Math.max(0, Math.min(b, h * 0.45));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.0001, h - 2 * b), bevelEnabled: b > 0.0005, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: 1, curveSegments: 6,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, b > 0.0005 ? b : 0, 0);
  return g;
}
/** rectangle with cut corners, centred */
export function chamRect(w: number, d: number, c: number): P2[] {
  const x = w / 2, z = d / 2;
  c = Math.max(0, Math.min(c, x * 0.9, z * 0.9));
  if (c < 0.0005) return [[-x, -z], [x, -z], [x, z], [-x, z]];
  return [[-x + c, -z], [x - c, -z], [x, -z + c], [x, z - c], [x - c, z], [-x + c, z], [-x, z - c], [-x, -z + c]];
}
/** chamfered box centred at the origin */
export function bevBox(w: number, h: number, d: number, b = 0.02): THREE.BufferGeometry {
  const g = slabGeo(chamRect(w, d, b), h, b);
  g.translate(0, -h / 2, 0);
  return g;
}

// ---- lofts ----------------------------------------------------------------------------------------
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cen = (r: V3[]): V3 => { const c: V3 = [0, 0, 0]; for (const p of r) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; } return [c[0] / r.length, c[1] / r.length, c[2] / r.length]; };

/** Skin a list of same-sized convex rings (3D points). Flat shaded, outward-oriented, optionally capped. */
export function loft(rings: V3[][], cap0 = true, cap1 = true): THREE.BufferGeometry {
  const pos: number[] = [];
  const n = rings[0].length;
  const cs = rings.map(cen);
  const tri = (a: V3, b: V3, c: V3, out: V3) => {
    const nr = cross(sub(b, a), sub(c, a));
    if (dot(nr, nr) < 1e-14) return;
    if (dot(nr, out) < 0) { const t = b; b = c; c = t; }
    pos.push(...a, ...b, ...c);
  };
  for (let i = 0; i < rings.length - 1; i++) {
    const ci: V3 = [(cs[i][0] + cs[i + 1][0]) / 2, (cs[i][1] + cs[i + 1][1]) / 2, (cs[i][2] + cs[i + 1][2]) / 2];
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      const a = rings[i][j], b = rings[i][k], c = rings[i + 1][k], d = rings[i + 1][j];
      const mid: V3 = [(a[0] + b[0] + c[0] + d[0]) / 4, (a[1] + b[1] + c[1] + d[1]) / 4, (a[2] + b[2] + c[2] + d[2]) / 4];
      const out = sub(mid, ci);
      tri(a, b, c, out); tri(a, c, d, out);
    }
  }
  const cap = (ri: number, other: number) => {
    const out = sub(cs[ri], cs[other]);
    for (let j = 0; j < n; j++) tri(cs[ri], rings[ri][j], rings[ri][(j + 1) % n], out);
  };
  if (cap0) cap(0, 1);
  if (cap1) cap(rings.length - 1, rings.length - 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** 8-point hull cross-section at x: bottom width wb @y0, lower side wm @y1..y2, shoulder to top width wt @y3 (half widths). */
export function sec8(x: number, wb: number, wm: number, wt: number, y0: number, y1: number, y2: number, y3: number): V3[] {
  return [[x, y0, -wb], [x, y0, wb], [x, y1, wm], [x, y2, wm], [x, y3, wt], [x, y3, -wt], [x, y2, -wm], [x, y1, -wm]];
}
/** superellipse ring in the YZ plane (fuselages, nacelles) */
export function ellRing(x: number, cy: number, cz: number, ry: number, rz: number, n = 12, pw = 2.4, flatBottom = 0): V3[] {
  const out: V3[] = [];
  n = lodSeg(n);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    const ex = 2 / pw;
    let y = Math.sign(s) * Math.pow(Math.abs(s), ex) * ry;
    if (y < 0) y *= 1 - flatBottom;
    out.push([x, cy + y, cz + Math.sign(c) * Math.pow(Math.abs(c), ex) * rz]);
  }
  return out;
}

// ---- lathe with hard ring edges -------------------------------------------------------------------------------
/** Revolve a profile [r, y] about +Y. Outward normal of each segment is (dy, -dr): go bottom-centre -> out -> up -> top-centre.
 *  Segment joints sharper than smoothDeg keep a hard edge, gentler ones are smoothed. */
export function lathe(profile: P2[], seg = 16, smoothDeg = 38): THREE.BufferGeometry {
  seg = lodSeg(seg);
  const m = profile.length - 1;
  const sn: P2[] = [];
  for (let i = 0; i < m; i++) {
    const dr = profile[i + 1][0] - profile[i][0], dy = profile[i + 1][1] - profile[i][1];
    const l = Math.hypot(dr, dy) || 1;
    sn.push([dy / l, -dr / l]);
  }
  const cosT = Math.cos((smoothDeg * Math.PI) / 180);
  const endN = (i: number, atEnd: boolean): P2 => {
    const j = atEnd ? i + 1 : i - 1;
    if (j < 0 || j >= m) return sn[i];
    const a = sn[i], b = sn[j];
    if (a[0] * b[0] + a[1] * b[1] > cosT) { const x = a[0] + b[0], y = a[1] + b[1], l = Math.hypot(x, y) || 1; return [x / l, y / l]; }
    return a;
  };
  const pos: number[] = [], nor: number[] = [];
  const push = (r: number, y: number, a: number, nr: number, ny: number) => {
    pos.push(r * Math.cos(a), y, r * Math.sin(a));
    nor.push(nr * Math.cos(a), ny, nr * Math.sin(a));
  };
  for (let i = 0; i < m; i++) {
    const [r0, y0] = profile[i], [r1, y1] = profile[i + 1];
    const n0 = endN(i, false), n1 = endN(i, true);
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
      // orientation: choose winding so geometric normal agrees with the outward segment normal
      const am = (a0 + a1) / 2;
      const p = (r: number, y: number, a: number): V3 => [r * Math.cos(a), y, r * Math.sin(a)];
      const A = p(r0, y0, a0), B = p(r0, y0, a1), C = p(r1, y1, a1), D = p(r1, y1, a0);
      const out: V3 = [sn[i][0] * Math.cos(am), sn[i][1], sn[i][0] * Math.sin(am)];
      const emit = (v: [number, number, number, number, number][]) => {
        const g = cross(sub(p(v[1][0], v[1][1], v[1][2]), p(v[0][0], v[0][1], v[0][2])), sub(p(v[2][0], v[2][1], v[2][2]), p(v[0][0], v[0][1], v[0][2])));
        if (dot(g, g) < 1e-16) return;
        if (dot(g, out) < 0) { const t = v[1]; v[1] = v[2]; v[2] = t; }
        for (const q of v) push(q[0], q[1], q[2], q[3], q[4]);
      };
      emit([[r0, y0, a0, n0[0], n0[1]], [r0, y0, a1, n0[0], n0[1]], [r1, y1, a1, n1[0], n1[1]]]);
      emit([[r0, y0, a0, n0[0], n0[1]], [r1, y1, a1, n1[0], n1[1]], [r1, y1, a0, n1[0], n1[1]]]);
      void A; void B; void C; void D;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}
/** tapered cylinder, base at y=0, along +Y */
export const cylG = (r0: number, r1: number, len: number, seg = 14) => lathe([[0, 0], [r0, 0], [r1, len], [0, len]], seg);
/** chamfered cylinder, base at y=0 */
export const cylB = (r: number, len: number, b: number, seg = 16) => { b = Math.min(b, r * 0.45, len * 0.45); return lathe([[0, 0], [r - b, 0], [r, b], [r, len - b], [r - b, len], [0, len]], seg); };
export type Axis = 'x' | 'y' | 'z' | '-x' | '-z';
/** rotate a +Y-axis geometry so its axis points along `axis` */
export function orient(g: THREE.BufferGeometry, axis: Axis): THREE.BufferGeometry {
  if (axis === 'x') g.rotateZ(-Math.PI / 2);
  else if (axis === 'z') g.rotateX(Math.PI / 2);
  else if (axis === '-x') g.rotateZ(Math.PI / 2);
  else if (axis === '-z') g.rotateX(-Math.PI / 2);
  return g;
}
/** cylinder/strut from a to b */
export function strutGeo(a: V3, b: V3, r0: number, r1 = r0, seg = 8): THREE.BufferGeometry {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = d.length();
  const g = cylG(r0, r1, len, seg);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...a), q, new THREE.Vector3(1, 1, 1)));
  return g;
}
/** basis matrix with z along `dir`, y as close to `up` as possible, at `at` */
export function aim(at: V3, dir: V3, up: V3 = [0, 1, 0]): THREE.Matrix4 {
  const z = new THREE.Vector3(...dir).normalize();
  let y = new THREE.Vector3(...up);
  y.addScaledVector(z, -y.dot(z));
  if (y.lengthSq() < 1e-8) y = new THREE.Vector3(1, 0, 0).addScaledVector(z, -z.x);
  y.normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(...at);
}

/** deterministic -1..1 jitter for the n-th part of a builder */
function partJitter(n: number): number {
  let h = Math.imul((n + 1) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}

// ---- builder: collects geometry per material, merges, mounts -----------------------------------------------
export class Bld {
  private m = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private mids = new Map<THREE.Material, number>();
  private decals: THREE.BufferGeometry[] = [];
  private calls = 0;
  tris = 0;
  /** multiplies radial segment counts of cyl/cylb/lathe/strut (min 5): a cheap LOD knob for dense parts (turrets) */
  segK = 1;
  /** caps radial segments of cyl/cylb/lathe/strut (weapons use 6: faceted hex forms read as armour, not turned tubes) */
  segMax = 64;
  /** simplification error for this builder's meshes (fraction of each mesh's extent; default SIMP). The error is
   *  relative, so one big merged hull loses the most curvature: a large showpiece (the tug castle) sets it lower. */
  simp: number | undefined = undefined;
  private sg(n: number): number { return Math.min(this.segMax, this.segK === 1 ? n : Math.max(5, Math.round(n * this.segK))); }
  g(geo: THREE.BufferGeometry, matl: MatLike, m?: THREE.Matrix4): this {
    const n = prep(geo);
    if (m) n.applyMatrix4(m);
    const u = (matl as UMat).uid !== undefined ? (matl as UMat) : null;
    const mat = u ? u.base : (matl as THREE.Material);
    // row id + a small per-part jitter in its fraction (+-0.2, read back by the uber shader as a value / hue offset so
    // neighbouring plates of one role differ slightly); deterministic: a hash of the call index
    if (u) n.setAttribute('mid', new THREE.Float32BufferAttribute(new Float32Array(n.attributes.position.count).fill(u.uid + partJitter(this.calls++) * 0.2), 1));
    let l = this.m.get(mat);
    if (!l) this.m.set(mat, (l = []));
    l.push(n);
    return this;
  }
  box(mat: MatLike, w: number, h: number, d: number, x = 0, y = 0, z = 0, b = 0.02, rot?: V3): this {
    return this.g(bevBox(w, h, d, b), mat, mtx([x, y, z], rot));
  }
  /** box sitting on y (bottom at y) */
  boxB(mat: MatLike, w: number, h: number, d: number, x: number, y: number, z: number, b = 0.02, rot?: V3): this {
    return this.box(mat, w, h, d, x, y + h / 2, z, b, rot);
  }
  slab(mat: MatLike, poly: P2[], h: number, b: number, x = 0, y = 0, z = 0, rot?: V3): this {
    return this.g(slabGeo(poly, h, b), mat, mtx([x, y, z], rot));
  }
  cyl(mat: MatLike, r0: number, r1: number, len: number, at: V3, axis: Axis = 'y', seg = 14): this {
    return this.g(orient(cylG(r0, r1, len, this.sg(seg)), axis), mat, mtx(at));
  }
  cylb(mat: MatLike, r: number, len: number, b: number, at: V3, axis: Axis = 'y', seg = 16): this {
    return this.g(orient(cylB(r, len, b, this.sg(seg)), axis), mat, mtx(at));
  }
  lathe(mat: MatLike, profile: P2[], at: V3, axis: Axis = 'y', seg = 16, rot?: V3): this {
    const g = orient(lathe(profile, this.sg(seg)), axis);
    return this.g(g, mat, mtx(at, rot));
  }
  loft(mat: MatLike, rings: V3[][], cap0 = true, cap1 = true, m?: THREE.Matrix4): this {
    return this.g(loft(rings, cap0, cap1), mat, m);
  }
  strut(mat: MatLike, a: V3, b: V3, r0: number, r1 = r0, seg = 8): this {
    return this.g(strutGeo(a, b, r0, r1, this.sg(seg)), mat);
  }
  /** textured decal quad lying on +Y at (x,y,z); uv rect in atlas (u0,v0,u1,v1). Rotated about Y by ry. */
  decal(w: number, d: number, x: number, y: number, z: number, uv: [number, number, number, number], ry = 0): this {
    const g = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2);
    const uvs = g.attributes.uv;
    for (let i = 0; i < uvs.count; i++) uvs.setXY(i, uv[0] + uvs.getX(i) * (uv[2] - uv[0]), uv[1] + uvs.getY(i) * (uv[3] - uv[1]));
    g.applyMatrix4(mtx([x, y, z], [0, ry, 0]));
    const n = prep(g, true);
    this.decals.push(n);
    return this;
  }
  /** Merge per material and add meshes to parent. */
  mount(parent: THREE.Object3D, decalMat?: THREE.Material, opts: { shadow?: boolean } = {}): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [mat, list] of this.m) {
      const g0 = mergeGeometries(list, false);
      if (!g0) continue;
      const g = simplifyGeo(g0, this.simp === undefined ? SIMP : Math.min(this.simp, SIMP));
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = opts.shadow !== false;
      mesh.receiveShadow = true;
      parent.add(mesh);
      out.push(mesh);
      this.tris += g.attributes.position.count / 3;
    }
    if (decalMat && this.decals.length) {
      const g = mergeGeometries(this.decals, false);
      if (g) {
        const mesh = new THREE.Mesh(g, decalMat);
        mesh.receiveShadow = true;
        mesh.renderOrder = 1;
        parent.add(mesh);
        out.push(mesh);
      }
    }
    return out;
  }
}
