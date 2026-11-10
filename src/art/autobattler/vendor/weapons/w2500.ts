// @ts-nocheck
// Year-2500 weapon designs: not modern weapons scaled up but new hardware on new physics, in the Mechabellum vein
// (layered armoured receivers, glowing cores seen through cut-outs, hollow bores, team-colour warheads). Same rig
// contract as the other families (weapons/wkit.ts): b = yaw housing, p = pitch cradle, rc = recoil, sp = spin; +X = muzzle.
// Style: few big refined forms (stacked bevelled plates with offset edges, smooth drums and lofts at up to 16
// segments), and chunky emissive cores that bloom (kit.plasma / glow / rail / hot with real width, never hairlines);
// no rows of tiny boxes.
//
//   rotary      rotary pulse driver (minigun, avenger): thick round barrels round a fat glowing core rod, a split
//               breech drum with a glowing band, clamp discs, power cells with charge windows and feed cables
//   blades      missile blades (rocket pods, MLRS, SAM, swarm, VLS, AA pair, rail rocket, ATGM): two layered launch
//               slabs either side of a trunnion drum, round tubes with team-colour ogive warheads, glowing seams
//               and hot exhaust louvres at the back
//   arc         arc projector (tesla family): a stacked coil column with a glowing core between layered pylons, a
//               floating crystal in a gyroscope of rings; arcCannon (small tiers): two conductor rails round a coil
//               stack and a haloed crystal
//   lens        lens projector (lasers): a smooth emitter body with cooling collars, a glowing focusing channel,
//               capacitor tubes and a deep hood round a big glowing iris
//   cradle      plasma cradle: layered jaws gripping a smooth glowing plasma core held by containment rings
//   flame       flame projector: rounded fuel cells with hot bands and hoses, a layered flared nozzle with a hot slot
//   railDriver  rail driver (rail rifle, railgun, mass driver): open fork of two armoured rails, coil teeth, glowing
//               breech rings, flickering arcs across the gap, swept wings

import type { V3 } from '../geo.ts';
import type { Bld } from '../geo.ts';
import type { MatLike } from '../materials.ts';
import { barrel, bx, cable, capsule, cbox, detail, drum, mechHousing, plinth, rbox, ring, scope, sloft, win, type WCtx } from './wkit.ts';

/** smooth radial segments (Bld caps them: 16 on units S >= 2, 10 on S1) */
const SM = 16;

/** hollow round muzzle collar along +X from x (length l, outer radius Ro): inner wall + a near-black core inside */
export function hollowMuzzle(C: WCtx, B: Bld, x: number, y: number, z: number, Ro: number, l: number, mat: MatLike = C.kit.metal, seg = 12): void {
  const Ri = Ro * 0.58;
  B.lathe(mat, [[Ri, 0], [Ro * 0.9, 0], [Ro, l * 0.22], [Ro, l * 0.86], [Ro * 0.9, l], [Ri, l], [Ri, 0]], [x, y, z], 'x', seg);
  B.lathe(C.kit.rubber, [[0, l * 0.3], [Ri * 1.01, l * 0.3], [Ri * 1.01, l * 0.36], [0, l * 0.36]], [x, y, z], 'x', 8);
}

/** faceted crystal (octahedron) of radius R and half-height h along `axis` */
function crystal(B: Bld, mat: MatLike, x: number, y: number, z: number, R: number, h: number, axis: 'x' | 'y' = 'y'): void {
  B.lathe(mat, [[0, -h], [R, 0], [0, h]], [x, y, z], axis, 4);
}

/** cut gem: a long faceted crystal with a girdle band (6 facets), half-height h along `axis` */
function gem(B: Bld, mat: MatLike, x: number, y: number, z: number, R: number, h: number, axis: 'x' | 'y' = 'y'): void {
  B.lathe(mat, [[0, -h], [R * 0.9, -h * 0.25], [R, 0], [R * 0.9, h * 0.25], [0, h]], [x, y, z], axis, 6);
}

/** rounded coil donut round +X at x (inner Ri, outer Ro, thickness t) */
function coil(B: Bld, mat: MatLike, x: number, y: number, z: number, Ri: number, Ro: number, t: number, axis: 'x' | 'y' = 'x', seg = SM): void {
  const e = Math.min(t * 0.35, (Ro - Ri) * 0.4);
  const at: V3 = axis === 'x' ? [x - t / 2, y, z] : [x, y - t / 2, z];
  B.lathe(mat, [[Ri, 0], [Ro - e, 0], [Ro, e], [Ro, t - e], [Ro - e, t], [Ri, t], [Ri, 0]], at, axis, seg);
}

// ---- rotary pulse driver --------------------------------------------------------------------------------------------
export function rotary(C: WCtx): void {
  const { p, rc, sp, kit, r, y0 } = C;
  const big = C.tier >= 4, n = big ? 4 : 3;
  const h = r * 0.5;
  mechHousing(C, r * 1.5, r * 0.7, h, 0.6);
  C.t.pitch.position.set(r * 0.5, y0 + h * 0.55, 0);
  const cr = r * (big ? 0.2 : 0.17), br = cr * 0.62, len = C.D * (big ? 0.95 : 0.8), CR = cr + br;
  // breech block, power cells either side (rounded, a glowing charge window facing out), feed cables into the drum
  cbox(p, kit.trim, 0, 0, 0, r * 0.5, h * 0.85, r * 0.7, r * 0.06, undefined, 0.85);
  const dt = detail(C);
  for (const s of [-1, 1]) {
    const zc = s * r * 0.43, R = r * 0.14;
    cbox(p, kit.hull2, -r * 0.08, -h * 0.12, zc, r * 0.5, h * 0.5, r * 0.2, r * 0.04);
    if (!dt) capsule(p, kit.hull, -r * 0.02, h * 0.08, zc, R, r * 0.56, 'x', 14);
    win(p, kit, kit.plasma, -r * 0.02, h * 0.08, zc + s * R * 0.92, r * 0.26, R * 0.7, s > 0 ? 'z+' : 'z-', dt ? 0 : 1, R * 0.3);
    if (!dt) cable(p, kit.rubber, [r * 0.24, h * 0.2, zc * 0.9], [r * 0.32, CR * 0.7, s * CR * 0.55], r * 0.025, [0, h * 0.12, s * r * 0.03], 4);
  }
  // split breech drum (recoils): team front half, dark back half, a glowing band in the split
  drum(rc, kit.trim, r * 0.12, 0, 0, CR * 1.12, r * 0.13, SM, 'x', dt ? 0 : undefined);
  ring(rc, kit.plasma, r * 0.275, 0, 0, CR * 0.6, CR * 1.06, r * 0.06);
  drum(rc, kit.hull, r * 0.3, 0, 0, CR * 1.18, r * 0.14, SM, 'x', dt ? 0 : undefined);
  // the spinning cluster: round stepped barrels round a fat glowing core rod, a mid clamp disc, hollow collars, the
  // rod ending in a glowing emitter cone between the muzzles
  C.spin('x', [r * 0.42, 0, 0]);
  const L2 = len - br * 2.2;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, yy = Math.sin(a) * cr, zz = Math.cos(a) * cr;
    sp.lathe(kit.metal, [[0, 0], [br * 1.12, 0], [br * 1.12, len * 0.16], [br, len * 0.19], [br, L2], [0, L2]], [0, yy, zz], 'x', 12);
    hollowMuzzle(C, sp, L2, yy, zz, br * 1.3, br * 2.2);
  }
  sp.lathe(kit.plasma, [[0, 0], [cr * 0.36, 0], [cr * 0.36, len * 0.84], [cr * 0.2, len * 0.9], [0, len * 0.93]], [0, 0, 0], 'x', 12);
  coil(sp, kit.trim, len * 0.47, 0, 0, cr * 0.5, CR * 1.04, len * 0.07);
  if (!dt) ring(sp, kit.metal, len * 0.47, 0, 0, CR * 0.96, CR * 1.1, len * 0.025);
  coil(sp, kit.hull2, L2 - br * 0.4, 0, 0, cr * 0.5, CR * 0.98, br * 0.5);
  C.muzzle(r * 0.42 + len + r * 0.04, 0, 0);
  C.t.rate = big ? 0.05 : 0.07;
}

// ---- missile blades ------------------------------------------------------------------------------------------------
export function blades(C: WCtx): void {
  const { p, rc, kit, r, y0 } = C;
  const n = Math.max(2, C.nb), per = Math.ceil(n / 2);
  // a big battery (16 cells) lays its cells out wide and low (2 rows of 4 per blade) on a low trunnion, so it stays as
  // low as the other guns of its class instead of towering in two tall stacks
  const big = per >= 8;
  const rows = big ? 2 : Math.min(per, per > 4 ? Math.ceil(per / 2) : per), cols = Math.ceil(per / rows), dt = detail(C);
  plinth(C, 0.62, 0.24);
  C.t.pitch.position.set(-r * 0.1, y0 + r * (big ? 0.42 : 0.52), 0);
  C.t.pitch.rotation.z = big ? 0.2 : 0.32;
  const cell = big ? r * 0.19 : Math.min(r * 0.26, (r * 1.1) / rows), bl = r * 1.45;
  const bh = rows * cell + r * 0.14, bw = cols * cell + r * 0.08, zb = r * (big ? 0.14 : 0.17) + bw / 2 + r * 0.03;
  // elevating core between the blades: a round trunnion drum (the pitch axis) with glowing hubs, a dark spine and a
  // sensor head riding on it
  drum(p, kit.trim, 0, 0, -zb, r * 0.17, zb * 2, SM, 'z');
  cbox(p, kit.hull2, -r * 0.08, 0, 0, r * 0.62, r * 0.36, r * 0.3, r * 0.05, undefined, 0.85);
  win(p, kit, kit.glow, -r * 0.1, r * 0.18, 0, r * 0.3, r * 0.14, 'y', 1, r * 0.04);
  scope(p, kit, r * 0.12, r * 0.3, 0, r * 0.06, r * 0.3);
  const tip = C.mod.id === 'incendiary' ? kit.hot : kit.accent;
  for (const s of [-1, 1]) {
    const z = s * zb, zf: 'z+' | 'z-' = s > 0 ? 'z+' : 'z-';
    ring(p, kit.glow, 0, 0, z - s * bw * 0.5 - s * r * 0.012, 0, r * 0.1, r * 0.02, SM, 'z');
    // the blade: a dark team core slab, a team armour plate on its outer face offset forward, a light roof plate set
    // back with a sloped prow, a glowing seam window on the outer plate, a hot exhaust louvre on the back
    cbox(rc, kit.hull2, 0, 0, z, bl, bh, bw, Math.min(bw, bh) * 0.16, undefined, 0.92);
    const zo = z + s * bw * 0.5;
    // outer face: a light plate over the front half, a team plate over the back (offset down), a glowing seam window
    // between them showing the core, a dark angled skirt along the bottom
    cbox(rc, kit.panel, bl * 0.2, bh * 0.04, zo, bl * 0.56, bh * 0.8, r * 0.08, r * 0.03, undefined, 0.88);
    cbox(rc, kit.hull, -bl * 0.3, -bh * 0.02, zo, bl * 0.34, bh * 0.74, r * 0.06, r * 0.025, undefined, 0.9);
    win(rc, kit, kit.glow, -bl * 0.1, bh * 0.1, zo, bl * 0.06, bh * 0.5, zf, 0, r * 0.04);
    cbox(rc, kit.trim, bl * 0.02, -bh * 0.44, zo + s * r * 0.02, bl * 0.86, bh * 0.14, r * 0.08, r * 0.03, [s * 0.35, 0, 0]);
    cbox(rc, kit.hull, -bl * 0.12, bh / 2 + r * 0.035, z, bl * 0.66, r * 0.07, bw * 1.04, r * 0.025);
    cbox(rc, kit.panel, bl * 0.36, bh / 2 + r * 0.02, z, bl * 0.24, r * 0.09, bw * 1.08, r * 0.03, [0, 0, -0.3]);
    win(rc, kit, kit.glow, -bl * 0.12, bh / 2 + r * 0.075, z, bl * 0.32, bw * 0.34, 'y', 2, r * 0.03);
    win(rc, kit, kit.hot, -bl / 2, 0, z, bw * 0.6, bh * 0.5, 'x-', 2, r * 0.05);
    // cell face: a dark recessed plate; per cell a round tube rim and a team-colour ogive warhead, staggered by column
    bx(rc, kit.trim, bl / 2 + r * 0.004, 0, z, r * 0.03, bh * 0.92, bw * 0.92);
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
      if (i * cols + j >= per) continue;
      const yy = (i - (rows - 1) / 2) * cell + (j % 2 ? cell * 0.18 : 0), zz = z + (j - (cols - 1) / 2) * cell, cR = cell * 0.36;
      if (!dt) ring(rc, kit.rubber, bl / 2 + r * 0.02, yy, zz, cR * 0.86, cR * 1.18, r * 0.03, 10);
      C.am.lathe(tip, dt ? [[cR, 0], [cR, cell * 0.12], [cR * 0.6, cell * 0.36], [0, cell * 0.48]] : [[0, 0], [cR, 0], [cR, cell * 0.12], [cR * 0.72, cell * 0.32], [cR * 0.3, cell * 0.44], [0, cell * 0.48]], [bl / 2 - cell * 0.1, yy, zz], 'x', 10);
      C.muzzle(bl / 2 + cell * 0.4, yy, zz);
    }
  }
  C.acc = true;
  C.t.shot = 'rocket';
  C.t.rate = n >= 8 ? 0.4 : 0.8;
}

// ---- arc projector ---------------------------------------------------------------------------------------------------
export function arc(C: WCtx): void {
  if (C.tier <= 3) return arcCannon(C);
  const { b, rc, kit, r, y0 } = C;
  const big = C.tier >= 4, n = C.tier >= 5 ? 3 : 2;
  detail(C);
  plinth(C, 0.75, 0.28);
  const yb = y0 + r * 0.25, H = r * (big ? 1.6 : 1.35), cy = yb + H * 0.74;
  // the coil column: stacked rounded donuts shrinking upward round a glowing core rod
  b.lathe(kit.rail, [[0, 0], [r * 0.11, 0], [r * 0.11, H * 0.6], [0, H * 0.6]], [0, yb, 0], 'y', 12);
  for (let i = 0; i < 3; i++) {
    const R = r * (0.36 - i * 0.07), t = r * 0.13;
    coil(b, i % 2 ? kit.trim : kit.metal, 0, yb + r * 0.12 + i * r * 0.21, 0, r * 0.13, R, t, 'y');
  }
  // pylons: tall layered blades leaning round the core (a team core, a light outer plate, a glowing inner channel),
  // a crystal tip on each
  for (let i = 0; i < n; i++) {
    const a = n === 2 ? (i ? Math.PI / 2 : -Math.PI / 2) : (i / n) * Math.PI * 2 + Math.PI;
    const ca = Math.cos(a), sa = Math.sin(a), px = ca * r * 0.5, pz = sa * r * 0.5;
    cbox(b, kit.hull, px, yb + H * 0.45, pz, r * 0.5, H * 0.9, r * 0.17, r * 0.05, [0, -a, 0], 0.62);
    cbox(b, kit.panel, px + ca * r * 0.1, yb + H * 0.32, pz + sa * r * 0.1, r * 0.4, H * 0.5, r * 0.06, r * 0.02, [0, -a, 0], 0.75);
    bx(b, kit.rail, px - ca * r * 0.09, yb + H * 0.5, pz - sa * r * 0.09, r * 0.1, H * 0.62, r * 0.02, [0, -a, 0]);
    gem(b, kit.rail, px * 0.9, yb + H * 0.95, pz * 0.9, r * 0.075, r * 0.15);
  }
  // floating core in a gyroscope of two crossed rings (recoil group: it pulses when it fires)
  C.t.pitch.position.set(0, cy, 0);
  gem(rc, kit.rail, 0, 0, 0, r * (big ? 0.3 : 0.26), r * (big ? 0.5 : 0.44));
  const gR = r * 0.5;
  rc.lathe(kit.trim, [[gR * 0.86, 0], [gR, 0], [gR, r * 0.07], [gR * 0.86, r * 0.07], [gR * 0.86, 0]], [0, -r * 0.035, 0], 'y', SM);
  rc.lathe(kit.panel, [[gR * 0.72, 0], [gR * 0.84, 0], [gR * 0.84, r * 0.06], [gR * 0.72, r * 0.06], [gR * 0.72, 0]], [0, 0, 0], 'y', SM, [Math.PI / 2, 0, 0.5]);
  ring(rc, kit.rail, 0, 0, 0, gR * 0.78, gR * 0.88, r * 0.03, SM, 'y');
  C.muzzle(r * 0.3, 0, 0);
  C.acc = true;
  C.t.rate = 0.95;
}

/** Arc cannon (tesla, arc lance): the integrated weapon body with two layered conductor rails reaching forward round
 *  a stacked coil (rounded donuts with glowing discs between them on a glowing rod), a faceted crystal held in a
 *  ringed halo between the rail tips, wide glowing channels on the rails' inner faces. */
function arcCannon(C: WCtx): void {
  const { rc, kit, r } = C;
  mechHousing(C, r * 1.55, r * 0.7, r * 0.55, 0.7);
  const L = C.D * 0.85, g = r * 0.36, cx = r * 0.25 + L * 0.9, x0 = r * 0.2;
  for (const s of [-1, 1]) {
    const z = s * g;
    cbox(rc, kit.hull2, x0 + L * 0.45, 0, z, L * 0.9, r * 0.3, r * 0.15, r * 0.04, undefined, 0.75);
    cbox(rc, kit.hull, x0 + L * 0.4, r * 0.01, z + s * r * 0.07, L * 0.66, r * 0.24, r * 0.06, r * 0.02, undefined, 0.8);
    cbox(rc, kit.panel, x0 + L * 0.3, r * 0.16, z, L * 0.4, r * 0.04, r * 0.13, r * 0.012);
    win(rc, kit, kit.glow, x0 + L * 0.55, 0, z - s * r * 0.075, L * 0.5, r * 0.1, s > 0 ? 'z-' : 'z+', 2, r * 0.035);
    drum(rc, kit.trim, x0 + L * 0.86, 0, z, r * 0.09, r * 0.08, 10);
    gem(rc, kit.glow, x0 + L * 0.98, 0, z, r * 0.05, r * 0.09, 'x');
  }
  // coil stack at the root between the rails
  rc.lathe(kit.glow, [[0, 0], [r * 0.07, 0], [r * 0.07, L * 0.45], [0, L * 0.45]], [x0, 0, 0], 'x', 10);
  for (let i = 0; i < 3; i++) coil(rc, i % 2 ? kit.metal : kit.trim, x0 + r * 0.1 + i * r * 0.14, 0, 0, r * 0.07, r * (0.24 - i * 0.03), r * 0.09);
  // haloed crystal at the front, three claws from the rails holding the halo
  gem(rc, kit.rail, cx, 0, 0, r * 0.13, r * 0.24, 'x');
  coil(rc, kit.trim, cx, 0, 0, r * 0.25, r * 0.34, r * 0.1);
  ring(rc, kit.rail, cx, 0, 0, r * 0.22, r * 0.26, r * 0.05);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
    cbox(rc, kit.hull2, cx - r * 0.06, Math.sin(a) * r * 0.36, Math.cos(a) * r * 0.36, r * 0.2, r * 0.06, r * 0.08, r * 0.015, [a, 0, 0]);
  }
  C.muzzle(cx + r * 0.22, 0, 0);
  C.t.rate = C.mod.id === 'arclance' ? 1.2 : 0.9;
}

// ---- lens projector ------------------------------------------------------------------------------------------------
export function lens(C: WCtx): void {
  const { rc, kit, r, y0 } = C;
  const n = C.nb >= 2 ? 2 : 1, h = r * 0.55;
  mechHousing(C, r * 1.5, r * 0.68, h, 0.6);
  const dt = detail(C);
  C.t.pitch.position.set(r * 0.35, y0 + h * 0.55, 0);
  for (let k = 0; k < n; k++) {
    const z = n > 1 ? (k - 0.5) * r * 0.62 : 0, L = C.D * 0.75, e = r * (n > 1 ? 0.19 : 0.25);
    // emitter body: smooth rounded sections tapering toward the hood
    sloft(rc, kit.hull, [[0, 0.62, 0.62], [L * 0.05, 0.75, 0.75], [L * 0.62, 0.72, 0.72], [L * 0.86, 0.6, 0.6]].map(([x, a, c]) => rbox(x, 0, z, e * a, e * c, dt ? 10 : 14, 2.6)));
    // cooling collars, a glowing focusing channel along the top, capacitor tubes on the flanks with glowing caps
    for (const f of dt ? [0.18] : [0.12, 0.27]) coil(rc, kit.trim, L * f, 0, z, e * 0.5, e * 0.98, L * 0.07);
    cbox(rc, kit.panel, L * 0.36, e * 0.7, z, L * 0.3, e * 0.16, e * 1.0, e * 0.05, undefined, 0.85);
    win(rc, kit, kit.glow, L * 0.64, e * 0.7, z, L * 0.22, e * 0.36, 'y', dt ? 0 : 2, e * 0.14);
    for (const s of [-1, 1]) {
      if (n > 1 && s === (k ? -1 : 1)) continue; // twin emitters: tubes and windows on the outer flanks only
      const zc = z + s * e * 0.8;
      if (!dt) {
        capsule(rc, kit.panel, L * 0.4, -e * 0.32, zc, e * 0.22, L * 0.42, 'x', 12);
        ring(rc, kit.rail, L * 0.4, -e * 0.32, zc, 0, e * 0.235, L * 0.05, 12);
      }
      win(rc, kit, kit.glow, L * 0.6, e * 0.22, z + s * e * 0.7, L * 0.3, e * 0.28, s > 0 ? 'z+' : 'z-', 2, e * 0.12);
    }
    // the emitter head: no dish. Four armoured petals (team top, dark sides, light belly) close round the barrel tip in
    // a long angular square shroud, open at the corners and the mouth; inside, a pointed focusing crystal glows deep in
    // the throat and its light leaks out through the corner slots
    const hx = L * 0.8, hl = e * 1.7;
    for (let q = 0; q < 4; q++) {
      const a = (q * Math.PI) / 2, cy = Math.cos(a), cz = Math.sin(a);
      const mat = q === 0 ? kit.hull : q === 2 ? kit.panel : kit.trim;
      cbox(rc, mat, hx + hl / 2, cy * e * 0.78, z + cz * e * 0.78, hl, cz ? e * 0.95 : e * 0.3, cz ? e * 0.3 : e * 0.95, e * 0.08, [a, 0, 0], 0.86);
      // a raked tooth at the front of each petal
      cbox(rc, kit.trim, hx + hl + e * 0.12, cy * e * 0.86, z + cz * e * 0.86, e * 0.3, cz ? e * 0.55 : e * 0.22, cz ? e * 0.22 : e * 0.55, e * 0.05, [a, 0, 0], 0.5);
    }
    rc.lathe(kit.plasma, [[0, 0], [e * 0.42, e * 0.35], [e * 0.3, hl * 0.75], [0, hl * 0.95]], [hx + e * 0.05, 0, z], 'x', 6, [Math.PI / 6, 0, 0]);
    if (!dt) rc.lathe(kit.trim, [[e * 0.45, 0], [e * 0.66, 0], [e * 0.66, e * 0.12], [e * 0.45, e * 0.12], [e * 0.45, 0]], [hx + hl * 0.45, 0, z], 'x', 8, [Math.PI / 8, 0, 0]);
    C.muzzle(L * 0.8 + e * 2.0, 0, z);
  }
  C.t.rate = n > 1 ? 0.4 : 0.5;
}

// ---- plasma cradle ---------------------------------------------------------------------------------------------------
export function cradle(C: WCtx): void {
  const { rc, kit, r, y0 } = C;
  const big = C.tier >= 4, lance = C.mod.projectile === 'beam', n = Math.min(2, Math.max(1, C.nb));
  const h = r * (big ? 0.6 : 0.52);
  mechHousing(C, r * 1.6, r * 0.72, h, 0.7);
  const dt = detail(C);
  C.t.pitch.position.set(r * 0.4, y0 + h * 0.55, 0);
  for (let k = 0; k < n; k++) {
    const z = n > 1 ? (k - 0.5) * r * 0.66 : 0, L = C.D * (lance ? 1.0 : 0.8), cr = r * (big ? 0.2 : 0.17) * (n > 1 ? 0.85 : 1);
    // the core: a smooth glowing plasma body, held by three containment rings
    rc.lathe(kit.plasma, [[0, 0], [cr * 0.55, L * 0.04], [cr * 0.95, L * 0.16], [cr, L * 0.4], [cr * 0.8, L * 0.56], [0, L * 0.66]], [L * 0.1, 0, z], 'x', SM);
    for (const f of dt ? [0.3, 0.48] : [0.24, 0.38, 0.52]) coil(rc, kit.trim, L * f, 0, z, cr * 0.92, cr * 1.3, L * 0.035);
    // layered jaws above and below: a dark team base, a team armour plate offset forward, a light lip at the back
    for (const s of [-1, 1]) {
      const y = s * cr * 1.45;
      cbox(rc, kit.hull2, L * 0.42, y, z, L * 0.72, cr * 0.42, cr * 1.8, cr * 0.14, undefined, 0.86);
      cbox(rc, kit.hull, L * 0.5, y + s * cr * 0.3, z, L * 0.56, cr * 0.26, cr * 1.5, cr * 0.1, undefined, 0.84);
      if (!dt) cbox(rc, kit.panel, L * 0.2, y + s * cr * 0.32, z, L * 0.2, cr * 0.22, cr * 1.65, cr * 0.08, undefined, 0.8);
      win(rc, kit, kit.plasma, L * 0.62, y + s * cr * 0.43, z, L * 0.2, cr * 0.6, 'y', 1, cr * 0.12);
    }
    // rear injector drum with a glowing band, a flared hollow emitter nozzle with a glowing throat
    drum(rc, kit.hull, 0, 0, z, cr * 1.35, r * 0.12);
    ring(rc, kit.plasma, r * 0.15, 0, z, cr * 0.5, cr * 1.28, r * 0.05);
    drum(rc, kit.trim, r * 0.17, 0, z, cr * 1.3, r * 0.1);
    rc.lathe(kit.metal, [[cr * 0.7, 0], [cr * 1.1, 0], [cr * 1.32, L * 0.12], [cr * 1.4, L * 0.2], [cr * 1.05, L * 0.2], [cr * 0.7, L * 0.06], [cr * 0.7, 0]], [L * 0.8, 0, z], 'x', SM);
    rc.lathe(kit.plasma, [[0, 0], [cr * 0.72, 0], [cr * 0.72, L * 0.05], [0, L * 0.05]], [L * 0.8, 0, z], 'x', SM);
    C.muzzle(L + r * 0.05, 0, z);
  }
  C.t.shot = lance ? 'beam' : 'orb';
  C.t.rate = 1.6;
}

// ---- flame projector -------------------------------------------------------------------------------------------------
export function flame(C: WCtx): void {
  const { p, rc, kit, r, y0 } = C;
  const big = C.tier >= 4, h = r * 0.5;
  const top = mechHousing(C, r * 1.6, r * 0.72, h, 0.5) - y0, lv = C.mh!.lv;
  C.t.pitch.position.set(r * 0.5, y0 + h * 0.5, 0);
  const L = C.D * (big ? 0.8 : 0.7), w = r * (big ? 0.26 : 0.22), hh = r * 0.13;
  // fuel cells riding the receiver: rounded tanks with a hot band, dark end caps, hoses running forward to the nozzle
  const tR = r * (lv ? 0.13 : 0.1), ty = top * 0.5 + tR * 0.75;
  for (const s of [-1, 1]) {
    const zc = s * r * 0.2;
    capsule(p, kit.hull2, -r * 0.42, ty, zc, tR, r * 0.62, 'x', 14);
    ring(p, kit.hot, -r * 0.42, ty, zc, tR * 0.85, tR * 1.04, r * 0.07, 14);
    ring(p, kit.trim, -r * 0.24, ty, zc, tR * 0.7, tR * 1.06, r * 0.05, 14);
    cable(p, kit.rubber, [-r * 0.1, ty, zc], [r * 0.05, hh * 0.9, s * w * 0.4], r * 0.03, [0, r * 0.05, s * r * 0.02], 4);
  }
  // nozzle: smooth rounded sections flaring flat and wide toward the mouth, a team armour plate over its top with a
  // hot slot, a dark lower jaw plate, a hot mouth inside a dark lip, a pilot igniter under it
  sloft(rc, kit.hull2, [[0, 1, 0.7], [L * 0.55, 0.9, 0.75], [L * 0.85, 0.72, 1.12], [L, 0.64, 1.38]].map(([x, a, c]) => rbox(x, 0, 0, hh * a, w * c, 16, 3)));
  cbox(rc, kit.hull, L * 0.4, hh * 0.92, 0, L * 0.62, hh * 0.3, w * 1.4, hh * 0.1, undefined, 0.85);
  cbox(rc, kit.panel, L * 0.16, hh * 1.12, 0, L * 0.22, hh * 0.22, w * 1.1, hh * 0.08, undefined, 0.8);
  win(rc, kit, kit.hot, L * 0.48, hh * 1.07, 0, L * 0.26, w * 0.6, 'y', 1, hh * 0.15);
  cbox(rc, kit.trim, L * 0.6, -hh * 0.8, 0, L * 0.5, hh * 0.32, w * 1.6, hh * 0.1);
  bx(rc, kit.rubber, L + r * 0.004, 0, 0, r * 0.02, hh * 1.25, w * 2.65);
  bx(rc, kit.hot, L + r * 0.012, 0, 0, r * 0.02, hh * 0.8, w * 2.3);
  drum(rc, kit.trim, L * 0.8, -hh * 1.15, 0, r * 0.04, L * 0.18, 10);
  rc.lathe(kit.lamp, [[0, 0], [r * 0.03, 0], [r * 0.03, r * 0.02], [0, r * 0.02]], [L * 0.98, -hh * 1.15, 0], 'x', 10);
  C.muzzle(L + r * 0.05, 0, 0);
  C.t.shot = 'flame';
  C.t.rate = 0.12;
}

// ---- pulse carbine (machine guns, autocannons, quad AA, scatterguns, flak, point defence, sniper) -----------------
export function carbine(C: WCtx): void {
  const { p, rc, kit, r } = C;
  const v = C.mod.visual, sniper = v === 'sniper', flak = v === 'flak', pd = v === 'pointdef', scat = v === 'shotgun';
  const h = r * (flak ? 0.55 : 0.5);
  const top = mechHousing(C, r * (sniper ? 1.8 : 1.5), r * (scat ? 0.7 : 0.62), h, sniper ? 1.1 : 0.7) - C.y0;
  const { l, w, lv } = C.mh!;
  const nb = Math.max(1, C.nb), cols = nb >= 4 ? 2 : Math.min(nb, 3), rows = nb >= 4 ? 2 : 1;
  const R = C.bore * (scat ? 1.6 : 1), gap = Math.max(R * 3.2, r * 0.2);
  const len = C.D * (sniper ? 2.4 : scat ? 0.75 : flak ? 1.3 : 1.1);
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    barrel(C, rc, { len, rad: R, x0: r * 0.1, y: (i - (rows - 1) / 2) * gap, z: (j - (cols - 1) / 2) * gap, sleeve: sniper, cap: sniper ? 44 : 18,
      brake: flak ? 'slot' : scat ? 'none' : sniper ? 'block' : 'flash' });
  }
  if (sniper) {
    // long optic on a raised mount: the precision rifle's signature
    scope(rc, kit, r * 0.4, R * 2.4 + r * 0.14, 0, r * 0.075, r * 0.95, kit.rail);
  } else if (flak) {
    // ammo hopper on the receiver roof: a layered block with a hot feed window
    const hy = top * 0.62 + r * 0.1;
    cbox(p, kit.hull2, -l * 0.25, hy, w * 0.2, r * 0.42, r * 0.2, r * 0.3, r * 0.04, undefined, 0.85);
    cbox(p, kit.hull, -l * 0.22, hy + r * 0.12, w * 0.2, r * 0.3, r * 0.06, r * 0.26, r * 0.02);
    win(p, kit, kit.hot, -l * 0.25, hy, w * 0.2 + r * 0.15, r * 0.24, r * 0.08, 'z+', 1, r * 0.03);
  } else if (lv) {
    // power cell under the barrel root: a rounded cell with a glowing charge window
    capsule(p, kit.hull, -l * 0.1, -h * 0.35, w * 0.55, r * 0.09, r * 0.5, 'x', 12);
    win(p, kit, kit.plasma, -l * 0.1, -h * 0.35, w * 0.55 + r * 0.085, r * 0.22, r * 0.06, 'z+', 1, r * 0.03);
  }
  if (flak) C.t.pitch.rotation.z = 0.5;
  C.t.shot = flak ? 'shell' : pd ? 'beam' : 'tracer';
  C.t.rate = flak ? 0.35 : pd ? 0.3 : sniper ? 2.0 : scat ? 0.5 : nb >= 4 ? 0.1 : C.tier === 1 ? 0.12 : 0.2;
}

// ---- artillery cradle (mortar, howitzer, barrage, cluster, doomsday) ------------------------------------------------
export function artillery(C: WCtx): void {
  const { rc, kit, r } = C;
  const mortar = C.mod.visual === 'mortar', nb = Math.max(1, C.nb), xl = C.tier >= 5;
  mechHousing(C, r * (mortar ? 1.3 : 1.9), r * (nb > 1 ? 0.85 : 0.7), r * 0.6, mortar ? 0.5 : 1.0, 1);
  const R = C.bore * (mortar ? 1.4 : 1), gap = Math.max(R * 3.2, r * 0.26), len = C.D * (mortar ? 0.9 : 1.6);
  for (let k = 0; k < nb; k++) {
    const z = (k - (nb - 1) / 2) * gap;
    const L = barrel(C, rc, { len, rad: R, x0: r * 0.1, z, sleeve: !mortar, evac: !mortar, brake: mortar ? 'none' : 'slot' });
    // breech block: a layered block at the barrel root with a hot chamber window on its roof
    cbox(rc, kit.hull2, r * 0.02, 0, z, r * 0.3, R * 3.0, R * 3.2, R * 0.4, undefined, 0.88);
    cbox(rc, kit.hull, r * 0.05, R * 1.6, z, r * 0.22, R * 0.5, R * 2.6, R * 0.2, undefined, 0.8);
    win(rc, kit, kit.hot, r * 0.05, R * 1.85, z, r * 0.12, R * 1.4, 'y', 1, R * 0.2);
    if (!mortar) for (const s of [-1, 1]) {
      // recoil cylinders above and below: round, a glowing band near the breech
      const yy = R * 1.55 * s, x0 = r * 0.1 + L * 0.06;
      drum(rc, kit.trim, x0, yy, z, R * 0.4, L * 0.3, 12);
      drum(rc, kit.metal, x0 + L * 0.3, yy, z, R * 0.3, L * 0.1, 12);
      ring(rc, kit.glow, x0 + L * 0.06, yy, z, R * 0.2, R * 0.46, R * 0.35, 12);
    }
  }
  C.t.pitch.rotation.z = mortar ? 0.9 : nb >= 3 ? 0.55 : 0.45;
  C.t.shot = 'shell';
  C.t.rate = mortar ? 1.4 : xl ? 3 : 2.4;
}

// ---- field emitter (heat ray, EMP / stun / disarm, slow beam, sonic, gravity) ---------------------------------------
export function emitter(C: WCtx): void {
  const { rc, kit, r } = C;
  const v = C.mod.visual, id = C.mod.id;
  const core = v === 'heatray' ? kit.hot : v === 'gravity' ? kit.plasma : v === 'slowbeam' ? kit.glow : v === 'sonic' ? kit.lamp : kit.rail;
  mechHousing(C, r * 1.5, r * 0.66, r * 0.55, 0.6);
  const L = C.D * 0.55, e = r * 0.3, x = r * 0.3 + L;
  // coil drum behind the focus: dark discs with a glowing band, a glowing feed rod forward to the core
  drum(rc, kit.trim, r * 0.22, 0, 0, e * 0.62, r * 0.12);
  ring(rc, core, r * 0.37, 0, 0, e * 0.3, e * 0.6, r * 0.05);
  drum(rc, kit.hull2, r * 0.4, 0, 0, e * 0.58, r * 0.1);
  rc.lathe(core, [[0, 0], [e * 0.12, 0], [e * 0.12, L * 0.7], [0, L * 0.7]], [r * 0.5, 0, 0], 'x', 10);
  // three layered prongs reaching forward round the core (top, lower left, lower right), a glowing strip inside each
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a), rot: V3 = [a - Math.PI / 2, 0, 0];
    cbox(rc, kit.hull2, r * 0.3 + L * 0.5, sa * e * 1.05, ca * e * 1.05, L * 0.95, e * 0.4, e * 0.46, e * 0.1, rot, 0.7);
    cbox(rc, kit.hull, r * 0.3 + L * 0.45, sa * e * 1.3, ca * e * 1.3, L * 0.7, e * 0.16, e * 0.36, e * 0.05, rot, 0.8);
    bx(rc, core, r * 0.3 + L * 0.62, sa * e * 0.82, ca * e * 0.82, L * 0.5, e * 0.06, e * 0.16, rot);
  }
  // the focus: a frame (a ring, a parabolic dish on the sonic pulser, a second crossed ring on the gravity gun) round a
  // big glowing orb
  if (v === 'sonic') rc.lathe(kit.panel, [[e * 0.3, 0], [e * 1.25, e * 0.45], [e * 1.12, e * 0.5], [e * 0.25, e * 0.12], [e * 0.3, 0]], [x - e * 0.3, 0, 0], 'x', SM);
  else coil(rc, kit.trim, x, 0, 0, e * 0.72, e * 1.0, e * 0.24);
  if (v === 'gravity') rc.lathe(kit.panel, [[e * 0.82, 0], [e * 0.95, 0], [e * 0.95, e * 0.12], [e * 0.82, e * 0.12], [e * 0.82, 0]], [x, 0, 0], 'y', SM, [0, 0, 0]);
  rc.lathe(core, [[0, -e * 0.5], [e * 0.3, -e * 0.42], [e * 0.5, -e * 0.15], [e * 0.5, e * 0.15], [e * 0.3, e * 0.42], [0, e * 0.5]], [x + e * 0.05, 0, 0], 'x', SM);
  C.muzzle(x + e * 0.6, 0, 0);
  C.t.shot = v === 'sonic' || id === 'empcannon' ? 'orb' : 'beam';
  C.t.rate = v === 'heatray' ? 0.7 : id === 'stungun' ? 0.8 : id === 'empcannon' ? 1.3 : v === 'slowbeam' ? 1.0 : v === 'sonic' ? 1.1 : 1.2;
}

// ---- rail driver ---------------------------------------------------------------------------------------------------
/** Rail driver (rail rifle, railgun, spinal mass driver): an open fork of two layered armoured rails with nothing
 *  between them but a floating chain of plasma crystals. Bright metal ridges run along the rails' inner faces round a
 *  wide plasma conductor; glowing windows are cut into their outer cheeks; plasma accelerator rings sit at the breech
 *  and a glowing ring at the mouth; plasma arcs jump the gap on an off-beat spin so they flicker; swept wings carry
 *  glowing edges. Two forks side by side on a twin mass driver. */
export function railDriver(C: WCtx): void {
  const { p, rc, sp, kit, r } = C;
  const xl = C.tier >= 5, nf = C.nb >= 2 ? 2 : 1;
  mechHousing(C, r * 1.8, r * 0.78, r * 0.5, 0.8);
  const R = Math.max(C.bore * 1.2, r * 0.11) * (nf > 1 ? 0.85 : 1);
  const len = Math.min(C.D * (xl ? 1.65 : 1.35 + 0.2 * C.c), R * (xl ? 24 : 15 + 4 * C.c)), x0 = r * 0.02, x1 = x0 + len;
  const g = R * 1.2, rh = R * 1.15, rw = R * 2.1, xb = x0 + r * 0.72;
  // breech block on the cradle
  cbox(p, kit.trim, r * 0.1, 0, 0, r * 0.4, g * 2 + rh * 2.1, rw * nf + R * (nf > 1 ? 3.5 : 1.2), r * 0.05, undefined, 0.85);
  // folded wings: each side's wing is folded down flat against the outside of the fork (a vertical swept blade bridging
  // the upper and lower rail over the rear third), so the driver stays inside its class width. A dark root spar, the
  // team blade with a light plate set back on it, a thick plasma leading edge and a hot slot glowing through the fold.
  const zc = nf > 1 ? rw / 2 + R * 0.9 : 0, zo = zc + rw * 0.57, hw = g + rh * 1.1;
  for (const s of [-1, 1]) {
    const zf = s * (zo + R * 0.2), xw = x0 + len * 0.2;
    cbox(rc, kit.trim, xw - len * 0.02, 0, s * (zo + R * 0.06), len * 0.3, hw * 2 * 0.86, R * 0.2, R * 0.06, undefined, 0.8);
    cbox(rc, kit.hull, xw, 0, zf, len * 0.3, hw * 2, R * 0.3, R * 0.1, undefined, 0.62);
    cbox(rc, kit.panel, xw - len * 0.04, 0, zf + s * R * 0.16, len * 0.17, hw * 1.3, R * 0.1, R * 0.04, undefined, 0.7);
    bx(rc, kit.plasma, xw + len * 0.13, 0, zf + s * R * 0.04, R * 0.42, hw * 1.7, R * 0.36, [0, 0, -0.32]);
    bx(rc, kit.hot, xw - len * 0.04, 0, zf + s * R * 0.22, len * 0.12, R * 0.34, R * 0.06);
  }
  for (let f = 0; f < nf; f++) {
    const z = nf > 1 ? (f ? 1 : -1) * (rw / 2 + R * 0.9) : 0;
    for (const s of [-1, 1]) {
      const y = s * (g + rh / 2);
      // the rail: a main beam (team top, light bottom), a stacked dark plate offset back on it, a lighter cap plate
      cbox(rc, s > 0 ? kit.hull : kit.panel, (x0 + x1) / 2, y, z, len, rh, rw, rh * 0.25, undefined, 0.88);
      cbox(rc, kit.metal, (x0 + x1) / 2 - len * 0.06, y + s * rh * 0.55, z, len * 0.82, R * 0.26, rw * 0.8, R * 0.1, undefined, 0.8); // weapon finish (silver)
      cbox(rc, s > 0 ? kit.panel : kit.hull, (x0 + x1) / 2 - len * 0.12, y + s * rh * 0.7, z, len * 0.5, R * 0.18, rw * 0.5, R * 0.07, undefined, 0.75);
      // heavy layered tip
      cbox(rc, kit.metal, x1 - R * 1.0, y + s * R * 0.1, z, R * 2.4, rh * 1.35, rw * 1.14, R * 0.3, [0, 0, s * 0.1], 0.8);
      cbox(rc, s > 0 ? kit.hull : kit.panel, x1 - R * 1.3, y + s * R * 0.55, z, R * 1.6, R * 0.4, rw * 0.9, R * 0.12, [0, 0, s * 0.1], 0.75);
      // inner face: two bright metal ridges either side of a wide plasma conductor
      bx(rc, kit.plasma, (x0 + x1) / 2 + R * 0.6, s * g, z, len * 0.84, R * 0.14, rw * 0.32);
      for (const q of [-1, 1]) cbox(rc, kit.steel, (x0 + x1) / 2 + R * 0.6, s * (g - R * 0.06), z + q * rw * 0.33, len * 0.84, R * 0.24, rw * 0.2, R * 0.06, undefined, 0.7);
      // glowing windows cut into both outer cheeks
      for (const q of [-1, 1]) for (let k = 0; k < 3; k++) {
        const xw = x0 + len * (0.38 + k * 0.17);
        bx(rc, kit.trim, xw, y, z + q * (rw / 2 + R * 0.01), len * 0.13, rh * 0.6, R * 0.06);
        bx(rc, kit.plasma, xw, y, z + q * (rw / 2 + R * 0.03), len * 0.1, rh * 0.32, R * 0.04);
      }
    }
    // plasma accelerator rings at the breech, a glowing ring at the mouth, a floating chain of crystals between
    for (let i = 0; i < 3; i++) {
      const xr = xb + i * R * 1.4, Ro = g + rh * 1.06;
      rc.lathe(kit.trim, [[g * 0.95, 0], [Ro, 0], [Ro, R * 0.45], [g * 0.95, R * 0.45], [g * 0.95, 0]], [xr, 0, z], 'x', 8, [Math.PI / 8, 0, 0]);
      rc.lathe(i === 1 ? kit.hot : kit.plasma, [[R * 0.35, R * 0.12], [g * 0.96, R * 0.12], [g * 0.96, R * 0.38], [R * 0.35, R * 0.38], [R * 0.35, R * 0.12]], [xr, 0, z], 'x', 16);
    }
    rc.lathe(kit.plasma, [[g * 0.7, 0], [g * 0.95, 0], [g * 0.95, R * 0.25], [g * 0.7, R * 0.25], [g * 0.7, 0]], [x1 - R * 0.6, 0, z], 'x', 16);
    const nc = xl ? 6 : 4, cl = (x1 - R * 1.5 - (xb + R * 3.2)) / nc;
    for (let k = 0; k < nc; k++) crystal(rc, k % 2 ? kit.glow : kit.plasma, xb + R * 3.2 + cl * (k + 0.5), 0, z, R * (0.36 - k * 0.03), cl * 0.42, 'x');
    C.muzzle(x1 + R * 0.4, 0, z);
  }
  // the sizzle: thick plasma arcs jumping between the rails, on an off-beat spin so they flicker rather than turn
  C.spin('x', [x0 + len * 0.5, 0, 0]);
  const nb = xl ? 5 : 3;
  for (let f = 0; f < nf; f++) for (let i = 0; i < nb; i++) {
    const z = nf > 1 ? (f ? 1 : -1) * (rw / 2 + R * 0.9) : 0, xa = (i / (nb - 1) - 0.5) * len * 0.6, a = i * 2.4 + f;
    let prev: V3 = [xa, -g * 0.85, z];
    for (let k = 1; k <= 4; k++) {
      const t = k / 4, j = k < 4 ? (k % 2 ? 1 : -1) * R * 0.4 : 0;
      const nx: V3 = [xa + j * Math.cos(a), -g * 0.85 + t * g * 1.7, z + j * Math.sin(a) * 0.6];
      sp.strut(kit.plasma, prev, nx, R * 0.11, R * 0.11, 5);
      prev = nx;
    }
  }
  C.t.idleSpin = C.t.spinV = 23.3;
  C.t.shot = 'beam';
  C.t.rate = xl ? 3 : 2.0;
}
