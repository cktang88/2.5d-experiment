// @ts-nocheck
// Shared weapon-building kit for the stylized 3D turrets (weapons3d.ts + weapons/*.ts).
// Turret frame: +X = muzzle direction, +Y = up, origin on the deck at the turret ring centre.
// Rig groups: b = yaw (traverse, static housing), p = pitch (elevating cradle / mantlet), rc = recoil (barrels, launch
// boxes: everything that kicks back), sp = spin (gatling clusters, saw discs, drills; rotated about its local +X).
//
// Style rules (chunky toy-like, cel shaded, few big forms):
//   * housings are lofts of 8-point sections (wedges, casemates, hexes) or low-poly lathes (balls, drums), not boxes;
//   * small parts use cbox (32 tris) or plain boxes (12 tris), never the extruded bevel box (60+ tris);
//   * radial segments: 10-16 for drums, collars, barrels and cores (Bld caps them: 16 on S >= 2 units, 10 on S1;
//     detail() trims them and drops small extras on S3+ units, which carry many weapons); one team accent per turret;
//   * refined parts (see the "refined parts" section): smooth lofts (sloft / rbox / rcap), stacked plates with offset
//     edges, glowing cut-outs (win), scopes, cables, rings and drums; chunky emissive cores, never hairlines.
//   * paint plan (materials.ts PAINT_PLAN): housings are light shell (kit.panel), side boxes / shields / pods carry the
//     team colour (kit.hull), mantlets and receivers are dark (kit.trim), barrels bare metal (kit.metal: gunmetal or the
//     weapon's finish, finish3d.ts), breech rings / fume extractors kit.fitting.

import * as THREE from 'three';
import type { ModuleDef } from '../types.ts';
import { Bld, sec8, mtx, type V3 } from '../geo.ts';
import type { Kit, MatLike } from '../materials.ts';
import type { Turret } from '../weapons3d.ts';
import { unitK } from '../mountgeo.ts';
import { weaponD } from '../weaponsize.ts';

export interface WCtx {
  /** yaw (static housing) */ b: Bld;
  /** pitch cradle */ p: Bld;
  /** recoiling barrels */ rc: Bld;
  /** spinning cluster (about local +X of t.spin) */ sp: Bld;
  /** visible ammunition, in the recoil frame (hidden while the weapon reloads) */ am: Bld;
  kit: Kit;
  mod: ModuleDef;
  /** housing radius (cells) = D / 2 */ r: number;
  D: number;
  /** 0..1 position inside the size class (calibre, then weight) */ c: number;
  /** absolute barrel outer radius (cells) from the real calibre */ bore: number;
  /** size tier 1..5 (S, M, M-heavy, L, XL) */ tier: number;
  nb: number;
  /** turret ring top (housings sit on this) */ y0: number;
  /** main-gun barrel length wanted from the HULL (cells; 0 = not the unit's main gun / unknown): real tank guns are
   *  ~0.85 x hull length, far longer than the housing-relative default (see mainLen in guns.ts) */
  mainL: number;
  fixed: boolean;
  /** bevel size for small parts */ bv: number;
  t: Turret;
  /** set once a team accent was placed */
  acc?: boolean;
  /** armour level of the weapon body 0..1 (chassis size vs weapon size): light / medium / heavy housing */
  arm: number;
  /** set by mechHousing: the integrated weapon body's size (finishHousing builds the yoke) */
  mh?: { l: number; w: number; h: number; lv: number };
  /** detail tier (see detail()): 0 full (units S1-S2), 1 lean (S3-S4), 2 leanest (S5) */
  dl?: number;
  muzzle(x: number, y: number, z: number): void;
  /** make the spin group (optionally re-axed: 'z' spins about the turret's lateral axis, e.g. saw discs) */
  spin(axis?: 'x' | 'z', at?: V3): void;
}

const boxG = new THREE.BoxGeometry(1, 1, 1);

/** plain box (12 tris), centred, l along x, h along y, w along z */
export function bx(B: Bld, mat: MatLike, x: number, y: number, z: number, l: number, h: number, w: number, rot?: V3): void {
  B.g(boxG, mat, mtx([x, y, z], rot, [l, h, w]));
}

/** cheap chamfered box (32 tris): top and bottom edges chamfered by e, vertical edges sharp. Centred. */
export function cbox(B: Bld, mat: MatLike, x: number, y: number, z: number, l: number, h: number, w: number, e = Math.min(l, h, w) * 0.16, rot?: V3, top = 1): void {
  e = Math.min(e, l * 0.4, w * 0.4, h * 0.45);
  const L = l / 2, W = w / 2, H = h / 2;
  const rect = (yy: number, ll: number, ww: number): V3[] => [[-ll, yy, -ww], [ll, yy, -ww], [ll, yy, ww], [-ll, yy, ww]];
  const tl = L * top, tw = W * top;
  const rings = [rect(-H, L - e, W - e), rect(-H + e, L, W), rect(H - e, tl, tw), rect(H, Math.max(0.001, tl - e), Math.max(0.001, tw - e))];
  B.loft(mat, rings, true, true, mtx([x, y, z], rot));
}

/** One housing section station: [x, half-width at the waist, half-width at the roof, height]. */
export type Station = [number, number, number, number];

/** Housing loft from plan stations along x (8-point sections: chamfered skirt, straight waist, sloped cheeks, flat roof). */
export function shell(B: Bld, mat: MatLike, st: Station[], y: number, z = 0, m?: THREE.Matrix4): void {
  B.loft(mat, st.map(([x, w, wt, h]) => sec8(x, w * 0.86, w, wt, y, y + h * 0.16, y + h * 0.58, y + h).map((v) => [v[0], v[1], v[2] + z] as V3)), true, true, m);
}

/** octagonal (chamfered-rectangle) section in the y-z plane at x: h tall, w wide, centred (y, z) */
function oct8(x: number, y: number, z: number, h: number, w: number, c = 0.3): V3[] {
  const H = h / 2, W = w / 2, ch = Math.min(H, W) * c * 2;
  return [[x, y + H, z - W + ch], [x, y + H, z + W - ch], [x, y + H - ch, z + W], [x, y - H + ch, z + W],
    [x, y - H, z + W - ch], [x, y - H, z - W + ch], [x, y - H + ch, z - W], [x, y + H - ch, z - W]];
}
/** armoured jacket segment along +X: octagonal section, chamfered (narrower) ends */
export function jacket(B: Bld, mat: MatLike, x0: number, x1: number, y: number, z: number, h: number, w: number, taper = 0.92): void {
  const e = Math.min((x1 - x0) * 0.18, h * 0.3);
  B.loft(mat, [oct8(x0, y, z, h * 0.78, w * 0.82), oct8(x0 + e, y, z, h, w), oct8(x1 - e, y, z, h * taper, w * taper), oct8(x1, y, z, h * taper * 0.8, w * taper * 0.84)]);
}

/** Barrel along +X from x0, in the armoured sci-fi style: a bare inner tube that only shows toward the muzzle, an
 *  angular octagonal shroud over the breech two-thirds in two stepped segments (light receiver jacket, darker forward
 *  jacket) on a dark gap, a top rail, dark vent slots and a team glow strip along the side, and an angular ported block
 *  muzzle brake. Adds a muzzle. (sleeve: longer shroud; evac: a third short collar segment near the muzzle.) */
export function barrel(C: WCtx, B: Bld, o: {
  len: number; rad: number; x0?: number; y?: number; z?: number; seg?: number; mat?: MatLike;
  sleeve?: boolean; evac?: boolean; brake?: 'slot' | 'cone' | 'flash' | 'block' | 'none'; taper?: number; noMuzzle?: boolean;
  /** max length in barrel radii (default 18; precision rifles run longer) */ cap?: number;
}): number {
  const { kit } = C;
  // length follows the bore: thin guns are short and stubby, heavy guns long (never a thin rod as long as a cannon)
  const x0 = o.x0 ?? 0, y = o.y ?? 0, z = o.z ?? 0, R = o.rad, L = Math.min(o.len, R * (o.cap ?? 18)), seg = o.seg ?? 12;
  const brake = o.brake ?? 'none';
  const bl = brake === 'none' ? R * 1.6 : brake === 'flash' ? R * 2.4 : R * 3.0;
  // inner tube (bare metal, round) all the way to the brake
  B.lathe(o.mat ?? kit.metal, [[0, 0], [R * 0.9, 0], [R * 0.82, L - bl * 0.8], [0, L - bl * 0.8]], [x0, y, z], 'x', Math.max(6, seg));
  // shroud: two stepped octagonal segments, wider than tall, on a glowing coil ring that shows in the gap between them
  const sEnd = L * (o.sleeve ? 0.72 : 0.64), cut = sEnd * 0.42, g = R * 0.55;
  const h0 = R * 2.5, w0 = R * 2.9;
  jacket(B, kit.panel, x0, x0 + cut - g / 2, y, z, h0, w0, 0.96);
  // (the forward shroud is bare metal in the weapon's finish, finish3d.ts: grey / blued / silver ... by weapon group)
  jacket(B, kit.metal, x0 + cut + g / 2, x0 + sEnd, y, z, h0 * 0.86, w0 * 0.86, 0.88);
  B.lathe(kit.glow, [[0, 0], [R * 1.12, 0], [R * 1.12, g * 1.1], [0, g * 1.1]], [x0 + cut - g * 0.55, y, z], 'x', seg);
  if (!detail(C)) ring(B, kit.trim, x0 + cut, y, z, R * 0.9, R * 1.18, g * 0.3, seg);
  if (o.evac) jacket(B, kit.fitting, x0 + L * 0.74, x0 + L * 0.8, y, z, h0 * 0.7, w0 * 0.7, 0.9);
  // stacked top rail along the receiver jacket, a glowing vent window on each flank, a glow strip forward
  cbox(B, kit.hull2, x0 + cut * 0.5, y + h0 * 0.5 + R * 0.1, z, cut * 0.82, R * 0.24, R * 0.9, R * 0.08);
  for (const s of [-1, 1]) {
    if (!detail(C)) win(B, kit, kit.glow, x0 + cut * 0.5, y, z + s * w0 * 0.47, cut * 0.5, h0 * 0.26, s > 0 ? 'z+' : 'z-', 1, R * 0.16);
    bx(B, kit.glow, x0 + cut + (sEnd - cut) * 0.5, y + h0 * 0.06, z + s * w0 * 0.41, (sEnd - cut) * 0.5, R * 0.22, R * 0.1);
  }
  // muzzle: a HOLLOW round sleeve (inner wall + a near-black core set deep inside, so the bore reads as a hole), with
  // dark side ports on ported kinds
  const m0 = L - bl, Ro = R * (brake === 'none' ? 1.15 : 1.45), Ri = R * 0.72;
  B.lathe(kit.metal, [[Ri, 0], [Ro * 0.9, 0], [Ro, bl * 0.18], [Ro, bl * 0.86], [Ro * 0.92, bl], [Ri, bl], [Ri, 0]], [x0 + m0, y, z], 'x', seg);
  B.lathe(kit.rubber, [[0, bl * 0.25], [Ri * 1.01, bl * 0.25], [Ri * 1.01, bl * 0.3], [0, bl * 0.3]], [x0 + m0, y, z], 'x', 8);
  if (brake !== 'none' && brake !== 'flash') for (const f of [0.4, 0.75]) for (const s of [-1, 1]) bx(B, kit.rubber, x0 + m0 + bl * f, y, z + s * Ro * 0.9, bl * 0.16, R * 0.9, R * 0.3);
  if (!o.noMuzzle) C.muzzle(x0 + L + R * 0.3, y, z);
  return L;
}

/** Thin ring band around +X (coil rings, barrel clamps). */
export function band(B: Bld, mat: MatLike, x: number, y: number, z: number, R: number, w: number, seg = 8): void {
  B.lathe(mat, [[0, 0], [R, 0], [R, w], [0, w]], [x - w / 2, y, z], 'x', seg);
}

/** Low-poly ball / squashed sphere of radius R (vertical squash k), centred. */
export function ball(B: Bld, mat: MatLike, x: number, y: number, z: number, R: number, k = 1, seg = 10, axis: 'x' | 'y' = 'y'): void {
  const prof: [number, number][] = [[0, -R * k], [R * 0.62, -R * k * 0.78], [R * 0.95, -R * k * 0.3], [R * 0.95, R * k * 0.3], [R * 0.62, R * k * 0.78], [0, R * k]];
  B.lathe(mat, prof, [x, y, z], axis, seg);
}

/** Pressure tank / capsule along an axis: rounded ends. */
export function capsule(B: Bld, mat: MatLike, x: number, y: number, z: number, R: number, len: number, axis: 'x' | 'y' | 'z' = 'x', seg = 8): void {
  const e = Math.min(R * 0.7, len * 0.3);
  const prof: [number, number][] = [[0, 0], [R * 0.6, e * 0.15], [R, e], [R, len - e], [R * 0.6, len - e * 0.15], [0, len]];
  const at: V3 = axis === 'x' ? [x - len / 2, y, z] : axis === 'y' ? [x, y - len / 2, z] : [x, y, z - len / 2];
  B.lathe(mat, prof, at, axis, seg);
}

/** Turret ring (deck bearing) under non-fixed weapons. */
export function deckRing(C: WCtx, k = 0.5): void {
  // a low dark swivel well tucked under the housing, never a wide round plate (a dark disc under every gun read as
  // "a cylinder put on a box"); octagonal so it reads as machined armour, not a turned dish
  const { b, kit, r } = C;
  b.lathe(kit.trim, [[0, 0], [r * k, 0], [r * k, r * 0.06], [r * k * 0.88, r * 0.09], [0, r * 0.09]], [0, 0, 0], 'y', 8, [0, Math.PI / 8, 0]);
}

/** Team accent panel lying on a face (horizontal by default). */
export function accent(C: WCtx, x: number, y: number, z: number, l: number, w: number, rot?: V3, B: Bld = C.b): void {
  C.acc = true;
  // restrained team accent: a stripe, never a big painted panel
  const lo = C.r * 0.11, hi = C.r * 0.5;
  if (l >= w) { l = Math.min(l, hi); w = Math.min(w, lo); } else { w = Math.min(w, hi); l = Math.min(l, lo); }
  bx(B, C.kit.accent, x, y, z, l, Math.max(0.004, C.r * 0.02), w, rot);
}

/** Yellow/dark hazard bands around a cylinder along x (n alternating rings). */
export function hazardRings(B: Bld, kit: Kit, x: number, y: number, z: number, R: number, len: number, n = 3, seg = 8): void {
  const t = len / n;
  for (let i = 0; i < n; i++) band(B, i % 2 ? kit.trim : kit.hazard, x + t * (i + 0.5), y, z, R, t, seg);
}

/** Angular launcher / gun base: a faceted armoured plinth (radius k x r, height h x r) with a dark skirt and two yoke
 *  cheeks. Replaces round lathed pedestals. */
export function plinth(C: WCtx, k = 0.6, h = 0.22): void {
  const { b, kit, r, y0 } = C, R = r * k, H = r * h;
  bx(b, kit.trim, 0, y0 + H * 0.15, 0, R * 1.6, H * 0.3, R * 1.5);
  shell(b, kit.panel, [[-R, R * 0.7, R * 0.52, H], [-R * 0.5, R * 0.86, R * 0.66, H], [R * 0.6, R * 0.86, R * 0.66, H], [R, R * 0.6, R * 0.42, H * 0.8]], y0 + H * 0.1);
  for (const s of [-1, 1]) cbox(b, kit.hull, -R * 0.1, y0 + H * 1.2, s * R * 0.74, R * 0.9, H * 1.3, r * 0.1, r * 0.03, undefined, 0.8);
}


// ---- refined parts (layered receivers, glowing cut-outs, scopes, cables, smooth drums) ------------------------------

/** Smooth loft: like Bld.loft but with shared ring vertices, so rounded sections (superellipse rings) shade smooth
 *  instead of faceted. Rings must have the same count and winding; caps are flat. */
export function sloft(B: Bld, mat: MatLike, rings: V3[][], m?: THREE.Matrix4): void {
  const n = rings[0].length, pos: number[] = [], idx: number[] = [];
  for (const r of rings) for (const v of r) pos.push(...v);
  const P = (i: number): V3 => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
  const cen = rings.map((r) => r.reduce((a, v) => [a[0] + v[0] / n, a[1] + v[1] / n, a[2] + v[2] / n] as V3, [0, 0, 0] as V3));
  const tri = (a: number, b: number, c: number, out: V3) => {
    const A = P(a), Bv = P(b), Cv = P(c);
    const u = [Bv[0] - A[0], Bv[1] - A[1], Bv[2] - A[2]], v = [Cv[0] - A[0], Cv[1] - A[1], Cv[2] - A[2]];
    const nr = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const d = nr[0] * out[0] + nr[1] * out[1] + nr[2] * out[2];
    if (nr[0] * nr[0] + nr[1] * nr[1] + nr[2] * nr[2] < 1e-16) return;
    if (d < 0) idx.push(a, c, b); else idx.push(a, b, c);
  };
  for (let i = 0; i < rings.length - 1; i++) {
    const ci = [(cen[i][0] + cen[i + 1][0]) / 2, (cen[i][1] + cen[i + 1][1]) / 2, (cen[i][2] + cen[i + 1][2]) / 2];
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n, a = i * n + j, b = i * n + k, c = (i + 1) * n + k, d = (i + 1) * n + j;
      const mid = [0, 1, 2].map((q) => (pos[a * 3 + q] + pos[b * 3 + q] + pos[c * 3 + q] + pos[d * 3 + q]) / 4 - ci[q]) as V3;
      tri(a, b, c, mid); tri(a, c, d, mid);
    }
  }
  // flat caps: their own vertices (so the smooth sides do not bend round the end face)
  for (const [ri, ro] of [[0, 1], [rings.length - 1, rings.length - 2]]) {
    const out: V3 = [cen[ri][0] - cen[ro][0], cen[ri][1] - cen[ro][1], cen[ri][2] - cen[ro][2]];
    const c0 = pos.length / 3;
    pos.push(...cen[ri]);
    for (const v of rings[ri]) pos.push(...v);
    for (let j = 0; j < n; j++) tri(c0, c0 + 1 + j, c0 + 1 + ((j + 1) % n), out);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  B.g(g, mat, m);
}

/** rounded-box (superellipse) ring in the y-z plane at x: half-height ry, half-width rz, n points */
export function rbox(x: number, y: number, z: number, ry: number, rz: number, n = 16, pw = 3.6): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) / n) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), e = 2 / pw;
    out.push([x, y + Math.sign(s) * Math.pow(Math.abs(s), e) * ry, z + Math.sign(c) * Math.pow(Math.abs(c), e) * rz]);
  }
  return out;
}

/** D-section ring in the y-z plane at x: a superellipse arch of half-height ry / half-width rz over the base y = yb
 *  (sides drop straight to the base, slightly inset): the section of a shell plate laid over a core. */
export function rcap(x: number, yb: number, ry: number, rz: number, n = 13, pw = 3.4): V3[] {
  const out: V3[] = [], e = 2 / pw;
  for (let i = 0; i <= n - 1; i++) {
    const a = (i / (n - 1)) * Math.PI, c = Math.cos(a), s = Math.sin(a);
    out.push([x, Math.pow(s, e) * ry, Math.sign(c) * Math.pow(Math.abs(c), e) * rz]);
  }
  out.push([x, yb, -rz * 0.94], [x, yb, rz * 0.94]);
  return out;
}

/** Glowing cut-out on a face: a chunky emissive core showing through a dark framed window, split by `ribs` dark bars.
 *  face 'z+' / 'z-': a side face (l along x, h along y); 'y': a top face (l along x, h along z); 'x+' / 'x-': an end
 *  face (l along z, h along y). d: frame depth. */
export function win(B: Bld, kit: Kit, glow: MatLike, x: number, y: number, z: number, l: number, h: number, face: 'z+' | 'z-' | 'y' | 'x+' | 'x-', ribs = 1, d = h * 0.32): void {
  const sg = face.endsWith('-') ? -1 : 1;
  const put = (u: number, v: number, n: number, lu: number, lv: number, ln: number, mat: MatLike) =>
    face === 'y' ? bx(B, mat, x + u, y + n, z + v, lu, ln, lv)
      : face[0] === 'x' ? bx(B, mat, x + sg * n, y + v, z + u, ln, lv, lu)
        : bx(B, mat, x + u, y + v, z + sg * n, lu, lv, ln);
  const t = h * 0.2;
  put(0, 0, 0, l, h, d, glow);
  for (const s of [-1, 1]) {
    put(0, (s * (h + t)) / 2, d * 0.3, l + t * 2, t, d * 1.2, kit.trim);
    put((s * (l + t)) / 2, 0, d * 0.3, t, h, d * 1.2, kit.trim);
  }
  for (let i = 1; i <= ribs; i++) put(-l / 2 + (l * i) / (ribs + 1), 0, d * 0.25, t * 0.8, h, d, kit.trim);
}

/** Sensor / scope: a rounded tube along +X on a dark riser, a deep hood and a glowing iris with a dark pupil. Centred. */
export function scope(B: Bld, kit: Kit, x: number, y: number, z: number, R: number, len: number, iris: MatLike = kit.rail, seg = 10): void {
  cbox(B, kit.trim, x - len * 0.12, y - R * 1.0, z, len * 0.42, R * 1.2, R * 1.1, R * 0.2);
  B.lathe(kit.hull2, [[0, 0], [R * 0.9, len * 0.1], [R * 0.9, len * 0.72], [R * 1.12, len * 0.78], [R * 1.12, len], [R * 0.82, len], [R * 0.82, len - R * 0.4]], [x - len / 2, y, z], 'x', seg);
  B.lathe(iris, [[0, 0], [R * 0.82, 0], [R * 0.82, R * 0.1], [0, R * 0.1]], [x + len / 2 - R * 0.42, y, z], 'x', seg);
}

/** Cable / hose from a to b bowing by `bow` (an offset of the curve's middle), n strut segments. */
export function cable(B: Bld, mat: MatLike, a: V3, b: V3, rad: number, bow: V3, n = 5, seg = 6): void {
  const m: V3 = [(a[0] + b[0]) / 2 + bow[0] * 2, (a[1] + b[1]) / 2 + bow[1] * 2, (a[2] + b[2]) / 2 + bow[2] * 2];
  let prev = a;
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const q: V3 = [0, 1, 2].map((k) => u * u * a[k] + 2 * u * t * m[k] + t * t * b[k]) as V3;
    B.strut(mat, prev, q, rad, rad, seg);
    prev = q;
  }
}

/** Annulus around an axis centred at (x, y, z): inner Ri, outer Ro, thickness t. */
export function ring(B: Bld, mat: MatLike, x: number, y: number, z: number, Ri: number, Ro: number, t: number, seg = 16, axis: 'x' | 'y' | 'z' = 'x'): void {
  const at: V3 = axis === 'x' ? [x - t / 2, y, z] : axis === 'y' ? [x, y - t / 2, z] : [x, y, z - t / 2];
  B.lathe(mat, Ri > 0 ? [[Ri, 0], [Ro, 0], [Ro, t], [Ri, t], [Ri, 0]] : [[0, 0], [Ro, 0], [Ro, t], [0, t]], at, axis, seg);
}

/** Rounded drum along an axis from (x, y, z), length l, radius R, chamfered rims e. */
export function drum(B: Bld, mat: MatLike, x: number, y: number, z: number, R: number, l: number, seg = 16, axis: 'x' | 'y' | 'z' = 'x', e = Math.min(R, l) * 0.2): void {
  B.lathe(mat, [[0, 0], [R - e, 0], [R, e], [R, l - e], [R - e, l], [0, l]], [x, y, z], axis, seg);
}

/** Detail tier of this weapon from the carrying unit's size class: big units mount many weapons on dense hulls, so
 *  their weapons trade round-part segments and small extras (cables, ribs, extra cut-outs) for the triangle budget
 *  (S1 <= 10k, S2..S5 <= 30k per unit). The size class is recovered from the housing radius (r = weaponD x
 *  unitScale(S) / 2; weapons are never class-shrunk, so it is exact). Sets the builders' segK once. */
export function detail(C: WCtx): number {
  if (C.dl !== undefined) return C.dl;
  const k = (2 * C.r) / weaponD(C.mod);
  let S = 1, err = Infinity;
  for (let s = 1; s <= 5; s++) {
    const e = Math.abs(unitK(s) * (s > 2 ? 1 + 0.22 * (s - 2) : 1) - k);
    if (e < err) { err = e; S = s; }
  }
  C.dl = S >= 5 ? 2 : S >= 3 ? 1 : 0;
  const sk = C.dl === 2 ? 0.5 : C.dl ? 0.6 : 1;
  for (const B of [C.b, C.p, C.rc, C.sp]) B.segK = sk;
  return C.dl;
}

/** Integrated weapon body (not a turret box the barrel pokes out of): the armour is built ROUND THE BARREL in the
 *  pitch group, so the whole body elevates with the gun. A smooth rounded receiver core (superellipse loft) from a
 *  reactor drum at the back (a glowing band between two dark discs) to a round collar where the barrel exits; on
 *  heavier bodies layered side pods (dark base, team armour plate offset forward, light lip) each with a glowing
 *  vent window, a three-plate stacked roof with a glowing cut-out, a scope and two cable runs from the reactor to the
 *  pods. l / w / h: length, half-width, height (cells); fwd: how far the side pods reach forward. Pitch-local frame
 *  (origin on the trunnion); finishHousing() then sets the trunnion near the ring centre and builds the yoke under
 *  it. Returns the body's top height (approx). */
export function mechHousing(C: WCtx, l: number, w: number, h: number, fwd = 1.05, sensorZ = -1): number {
  const { p, kit, r, y0 } = C;
  const dt = detail(C), n = 12 - 2 * dt, nc = 13 - 2 * dt;
  // armour level (chassis size vs weapon): light = slim receiver hugging the barrel; medium = + side pods and a
  // scope; heavy = the full body (thick layered pods, stacked roof)
  const lv = C.arm < 0.34 ? 0 : C.arm < 0.67 ? 1 : 2;
  if (lv < 2) { l *= lv ? 0.85 : 0.62; w *= lv ? 0.8 : 0.55; h *= lv ? 0.85 : 0.65; }
  const x0 = -l * 0.62, x1 = l * 0.38, span = x1 - x0, xm = (x0 + x1) / 2, pw = w * 0.62 + r * (lv ? 0.1 : 0.04);
  const RY = h * 0.41, RZ = w * 0.62;
  C.mh = { l, w, h, lv };
  C.acc = true;
  // receiver: a dark rounded core (superellipse loft) under two shell segments (smooth D-section lofts over its upper
  // body: light at the back, team colour at the front); in the gap between them a glowing band rings the core (the
  // shells stay outside the core everywhere, so their edges never cut through it)
  const st: [number, number, number][] = [[x0, 0.7, 0.72], [x0 + span * 0.06, 0.92, 0.92], [x1 - span * 0.32, 0.9, 0.9], [x1 - span * 0.12, 0.8, 0.82], [x1, 0.64, 0.7]];
  sloft(p, kit.trim, st.map(([x, a, c]) => rbox(x, 0, 0, RY * a, RZ * c, n, 3.4)));
  const gx = x0 + span * 0.34, gw = span * 0.07, yb = -RY * 0.42;
  const cap = ([x, k]: number[]) => rcap(x, yb, RY * k, RZ * (0.04 + 0.96 * k), nc);
  sloft(p, kit.panel, [[x0 + span * 0.03, 0.9], [x0 + span * 0.08, 1.02], [gx - gw / 2 - span * 0.03, 1.02], [gx - gw / 2, 0.97]].map(cap));
  sloft(p, kit.hull, [[gx + gw / 2, 0.97], [gx + gw / 2 + span * 0.04, 1.03], [x1 - span * 0.3, 1.03], [x1 - span * 0.14, 0.93], [x1 - span * 0.05, 0.86]].map(cap));
  sloft(p, kit.glow, [rbox(gx - gw * 0.45, 0, 0, RY * 0.95, RZ * 0.95, n, 3.4), rbox(gx + gw * 0.45, 0, 0, RY * 0.95, RZ * 0.95, n, 3.4)]);
  // vent cut-outs in the flanks of the rear shell, the core glowing through
  if (!dt) for (const s of [-1, 1]) win(p, kit, kit.glow, x0 + span * 0.19, RY * 0.12, s * RZ * 1.0, span * 0.18, RY * 0.32, s > 0 ? 'z+' : 'z-', 2, RY * 0.12);
  // muzzle collar
  ring(p, kit.trim, x1 + r * 0.02, 0, 0, RY * 0.4, RY * 0.74, r * 0.1, 12);
  // reactor at the back: a dark drum split by a glowing band
  const rl = r * (lv === 2 ? 0.26 : lv ? 0.2 : 0.14), DR = Math.min(RY, RZ) * 0.92;
  drum(p, kit.trim, x0 - rl, 0, 0, DR, rl * 1.02, 14, 'x', dt ? 0 : undefined);
  ring(p, kit.glow, x0 - rl * 0.5, 0, 0, 0, DR * 1.06, rl * 0.22, 14);
  if (lv === 0) {
    // light: one team plate on the roof, offset back over a dark base plate
    cbox(p, kit.hull2, xm - span * 0.05, RY + r * 0.015, 0, span * 0.6, r * 0.04, RZ * 1.1, r * 0.015);
    cbox(p, kit.hull, xm - span * 0.12, RY + r * 0.045, 0, span * 0.42, r * 0.035, RZ * 0.8, r * 0.012, undefined, 0.8);
    return y0 + h;
  }
  // side pods: dark base, team armour plate offset forward and out, a light lip along the top, a glowing vent window
  const pl = span * (lv === 2 ? 0.85 : 0.72), pxc = x0 + span * 0.55 + (lv === 2 ? l * fwd * 0.08 : 0), ph = h * (lv === 2 ? 0.72 : 0.6), pt = r * (lv === 2 ? 0.2 : 0.13);
  for (const s of [-1, 1]) {
    const face = s > 0 ? 'z+' : 'z-';
    cbox(p, kit.hull2, pxc - pl * 0.04, -h * 0.06, s * pw, pl, ph, pt, pt * 0.25, undefined, 0.86);
    const zo = s * (pw + pt * 0.3);
    cbox(p, kit.hull, pxc + pl * 0.07, h * 0.03, zo, pl * 0.8, ph * 0.8, pt * 0.5, pt * 0.16, undefined, 0.88);
    if (!dt) cbox(p, kit.panel, pxc - pl * 0.12, -h * 0.06 + ph * 0.5, s * (pw + pt * 0.1), pl * 0.62, ph * 0.16, pt * 1.05, pt * 0.2, undefined, 0.8);
    if (dt < 2) win(p, kit, kit.glow, pxc - pl * 0.1, -h * 0.02, zo + s * pt * 0.25, pl * 0.4, ph * 0.26, face, lv === 2 && !dt ? 2 : 1 - dt, pt * 0.14);
    else bx(p, kit.glow, pxc - pl * 0.1, -h * 0.02, zo + s * pt * 0.25, pl * 0.4, ph * 0.2, pt * 0.08);
  }
  // roof on the (team-colour) front shell: a dark plate under a light plate with a glowing cut-out (heavy bodies: a
  // wider stack and a sloped light lip at the front)
  const xf = x0 + span * 0.68, ry = RY * 1.02, hv = lv === 2;
  cbox(p, kit.hull2, xf - span * (hv ? 0 : 0.04), ry + r * 0.02, 0, span * (hv ? 0.5 : 0.4), r * (hv ? 0.06 : 0.05), RZ * (hv ? 1.3 : 1.1), r * 0.02);
  cbox(p, kit.panel, xf - span * (hv ? 0.06 : 0.07), ry + r * (hv ? 0.075 : 0.055), 0, span * (hv ? 0.32 : 0.26), r * 0.05, RZ * (hv ? 1.0 : 0.85), r * 0.02, undefined, 0.82);
  if (hv && !dt) cbox(p, kit.panel, xf + span * 0.21, ry + r * 0.045, 0, span * 0.1, r * 0.05, RZ * 1.15, r * 0.015, [0, 0, -0.2], 0.8);
  if (dt < 2) win(p, kit, kit.glow, xf - span * (hv ? 0.06 : 0.07), ry + r * (hv ? 0.1 : 0.08), 0, span * (hv ? 0.16 : 0.12), RZ * (hv ? 0.4 : 0.34), 'y', hv && !dt ? 2 : 1, r * 0.022);
  else bx(p, kit.glow, xf - span * (hv ? 0.06 : 0.07), ry + r * (hv ? 0.1 : 0.08), 0, span * (hv ? 0.16 : 0.12), r * 0.02, RZ * 0.3);
  if (!dt) scope(p, kit, x0 + span * 0.18, ry + r * (hv ? 0.1 : 0.08), sensorZ * w * 0.4, r * (hv ? 0.075 : 0.06), r * (hv ? 0.42 : 0.32));
  else {
    cbox(p, kit.trim, x0 + span * 0.18, ry + r * 0.05, sensorZ * w * 0.4, r * 0.3, r * 0.1, r * 0.14, r * 0.03);
    bx(p, kit.rail, x0 + span * 0.18 + r * 0.15, ry + r * 0.05, sensorZ * w * 0.4, r * 0.02, r * 0.06, r * 0.1);
  }
  return y0 + h;
}

/** After a family built a mechHousing weapon: trunnion near the ring centre, a yoke under it (a dark base narrower
 *  than the turret, two layered pylons up to the trunnion outside the side pods, round trunnion drums with glowing
 *  hubs, a metal axle). */
export function finishHousing(C: WCtx): void {
  if (!C.mh) return;
  const { b, kit, r, y0 } = C, { l, w, h, lv } = C.mh;
  const py = y0 + h * 0.6 + (lv ? 0 : r * 0.12), px = l * 0.12, zp = w * 0.62 + r * (lv === 2 ? 0.33 : lv ? 0.24 : 0.12);
  C.t.pitch.position.set(px, py, 0);
  // light mounts: two thin pylons straight off the ring, no base; heavier ones a dark base under the yoke
  if (lv) shell(b, kit.trim, [[-r * 0.6, r * 0.55, r * 0.45, h * 0.3], [r * 0.5, r * 0.55, r * 0.45, h * 0.3]].map(([x, a, c, d]) => [x * (lv === 2 ? 1 : 0.8), a * (lv === 2 ? 1 : 0.8), c * (lv === 2 ? 1 : 0.8), d]) as Station[], y0);
  const pt = lv === 2 ? r * 0.1 : lv ? r * 0.08 : r * 0.05, yb = lv ? y0 + h * 0.25 : y0, TR = r * (lv === 2 ? 0.15 : lv ? 0.12 : 0.075);
  for (const s of [-1, 1]) {
    cbox(b, kit.hull2, px, (yb + py) / 2, s * zp, r * (lv ? 0.4 : 0.26), py - yb + r * 0.1, pt, r * 0.02);
    // outer layer: a light plate offset down and back, tapered
    if (lv && (C.dl ?? 0) < 2) cbox(b, kit.panel, px - r * 0.05, yb + (py - yb) * 0.4, s * (zp + pt * 0.6), r * (lv === 2 ? 0.34 : 0.28), (py - yb) * 0.7, pt * 0.4, pt * 0.15, undefined, 0.7);
    // trunnion drum with a glowing hub
    const zc = s * (zp + pt * 0.5);
    if ((C.dl ?? 0) < 2) drum(b, kit.trim, px, py, zc - (s > 0 ? 0 : pt * 0.9), TR, pt * 0.9, 10, 'z');
    ring(b, kit.glow, px, py, zc + s * pt * 0.92, 0, TR * 0.55, pt * 0.12, 10, 'z');
  }
  b.cylb(kit.metal, r * 0.11, zp * 2 + r * 0.06, r * 0.02, [px, py, -zp - r * 0.03], 'z', 12);
}
