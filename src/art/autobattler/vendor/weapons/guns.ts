// @ts-nocheck
// Kinetic guns: machine guns (pintle nests, ball mounts), autocannons (low wedges, quad AA cradles), scatterguns,
// gatlings (fork mounts with thin clamped barrel clusters + ammo drum), tank cannons (cast domes, angular wedges, twin hexes, siege
// casemates), gauss (square coil barrels), sniper (open long rifle), rails (twin glowing prongs), flak and point defence.

import { calibreMm } from '../weaponsize.ts';
import { accent, band, ball, barrel, bx, capsule, cbox, jacket, mechHousing, plinth, shell, type Station, type WCtx } from './wkit.ts';

export function buildGun(C: WCtx): void {
  const v = C.mod.visual;
  if (v === 'gatling') return gatling(C);
  if (v === 'shotgun') return scatter(C);
  if (v === 'pointdef') return pointDefence(C);
  if (v === 'flak') return flak(C);
  if (v === 'cannon') return C.tier >= 4 ? siegeCasemate(C) : C.nb >= 2 ? twinHex(C) : calibreMm(C.mod) < 100 ? castDome(C) : wedgeTank(C);
  if (v === 'gauss') return gauss(C);
  if (v === 'sniper') return sniper(C);
  if (v === 'rail') return rail(C);
  // 'gun'
  if (C.nb >= 4) return quadAA(C);
  if (C.tier === 1) return calibreMm(C.mod) < 15 ? pintle(C) : ballMount(C);
  return wedgeAC(C);
}

/** Barrel length: the family default (`base`, housing-relative), or for the unit's main gun a hull-proportioned length
 *  (C.mainL x k; tank cannons ~0.85 L, autocannons ~0.55 L), capped at `cap` x the housing so a gun never dwarfs its
 *  own turret on a huge hull. */
// the unit's main gun is only a little longer than the family default (barrel length follows the bore, see barrel())
const mainLen = (C: WCtx, base: number, _k = 1, _cap = 3.0) => (C.mainL > 0 ? base * 1.15 : base);

const zs = (n: number, gap: number) => Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * gap);

/** MG nest: octagonal pedestal, receiver, slanted gun shield, ammo can. */
function pintle(C: WCtx) {
  const { b, p, rc, kit, r, y0, nb } = C;
  const R = C.bore;
  plinth(C, 0.72, 0.26);
  b.cyl(kit.metal, r * 0.12, r * 0.1, r * 0.3, [0, y0 + r * 0.26, 0], 'y', 6);
  C.t.pitch.position.set(r * 0.05, y0 + r * 0.62, 0);
  const w = nb > 1 ? r * 0.5 : r * 0.32;
  cbox(p, kit.trim, -r * 0.05, 0, 0, r * 0.75, r * 0.3, w);
  bx(p, kit.hull, -r * 0.05, -r * 0.05, w / 2 + r * 0.12, r * 0.38, r * 0.3, r * 0.22);
  // gun shield: leaning plate, wider than the gun
  cbox(p, kit.panel, r * 0.38, r * 0.02, 0, r * 0.1, r * 0.72, r * 1.15, r * 0.04, [0, 0, -0.28]);
  accent(C, r * 0.45, r * 0.02, -r * 0.32, r * 0.08, r * 0.2, [0, 0, -0.28 + Math.PI / 2], p);
  const len = C.D * (1.05 + 0.35 * C.c), x0 = r * 0.25;
  const heavy = calibreMm(C.mod) > 10, jk = nb > 1 ? 1.55 : 1.9;
  for (const z of zs(nb, w * 0.62)) {
    barrel(C, rc, { len, rad: R * 0.85, x0, z, seg: 6, brake: heavy ? 'cone' : 'flash', taper: 0.95 });
    if (heavy) {
      // heavy MG: short perforated barrel-support sleeve at the receiver, long bare barrel, muzzle can
      rc.lathe(kit.trim, [[0, 0], [R * 1.55, 0], [R * 1.55, len * 0.22], [R * 1.05, len * 0.26], [0, len * 0.26]], [x0, 0, z], 'x', 7);
      band(rc, kit.metal, x0 + len * 0.11, 0, z, R * 1.7, len * 0.04, 7);
    } else {
      // rifle-calibre MG: fat ribbed cooling jacket over the first half, thin barrel poking out of it
      rc.lathe(kit.trim, [[0, 0], [R * jk, 0], [R * jk, len * 0.5], [R * 1.2, len * 0.56], [0, len * 0.56]], [x0, 0, z], 'x', 7);
      for (const f of [0.14, 0.3, 0.44]) band(rc, kit.metal, x0 + len * f, 0, z, R * (jk + 0.15), len * 0.035, 7);
    }
  }
  C.t.rate = 0.12;
}

/** Small autocannon in a squashed ball with a sight pod. */
function ballMount(C: WCtx) {
  const { b, p, rc, kit, r, y0 } = C;
  const R = C.bore;
  mechHousing(C, r * 1.5, r * 0.66, r * 0.62, 0.7);
  C.t.pitch.position.set(r * 0.55, y0 + r * 0.42, 0);
  ball(p, kit.trim, 0, 0, 0, r * 0.3, 1, 8, 'x');
  cbox(p, kit.metal, -r * 0.1, r * 0.32, -r * 0.22, r * 0.4, r * 0.2, r * 0.2);
  bx(p, kit.glass, r * 0.11, r * 0.32, -r * 0.22, r * 0.03, r * 0.12, r * 0.14);
  barrel(C, rc, { len: mainLen(C, C.D * 1.25, 0.55, 2.4), rad: R, x0: r * 0.1, seg: 7, sleeve: true, brake: 'flash' });
  accent(C, -r * 0.35, y0 + r * 0.92, 0, r * 0.4, r * 0.12);
  C.t.rate = 0.2;
}

/** Medium autocannon: low arrow-head wedge turret, mantlet, one/two long barrels, feed chute. */
function wedgeAC(C: WCtx) {
  const { b, p, rc, kit, r, y0, nb } = C;
  const R = C.bore, h = r * 0.52;
  mechHousing(C, r * 1.6, r * 0.72, h, 0.8);
  C.t.pitch.position.set(r * 0.62, y0 + h * 0.52, 0);
  const gap = R * 3.4;
  cbox(p, kit.trim, 0, 0, 0, r * 0.3, h * 0.62, nb > 1 ? gap * nb + R * 3 : R * 5.5);
  const len = mainLen(C, C.D * (1.1 + 0.35 * C.c), 0.62, 2.6), x0 = r * 0.1;
  const bofors = C.mod.id === 'ac40';
  for (const z of zs(nb, gap)) {
    if (bofors) {
      // Bofors: recoil spring sleeve over the root, bare barrel, big conical flash hider
      const lb = len * 0.85;
      barrel(C, rc, { len: lb, rad: R, x0, z, seg: 7, noMuzzle: true });
      rc.lathe(kit.trim, [[0, 0], [R * 1.5, 0], [R * 1.5, len * 0.3], [R * 1.15, len * 0.34], [0, len * 0.34]], [x0, 0, z], 'x', 7);
      rc.lathe(kit.metal, [[0, 0], [R * 0.95, 0], [R * 1.75, len * 0.15], [R * 1.3, len * 0.15], [0, len * 0.08]], [x0 + lb, 0, z], 'x', 7);
      C.muzzle(x0 + lb + len * 0.15, 0, z);
    } else barrel(C, rc, { len, rad: R, x0, z, seg: 7, sleeve: nb === 1, brake: nb > 1 ? 'flash' : 'slot' });
  }
  const mw = nb > 1 ? gap * nb + R * 3 : R * 5.5;
  if (bofors) {
    // the Bofors tell: a 4-round clip standing upright in the feed guide on top of the breech
    bx(p, kit.trim, -r * 0.06, h * 0.31 + r * 0.04, 0, r * 0.22, r * 0.08, R * 2.6);
    bx(p, kit.hull, -r * 0.06, h * 0.31 + r * 0.24, 0, r * 0.15, r * 0.36, R * 1.7);
    bx(p, kit.hazard, -r * 0.06, h * 0.31 + r * 0.44, 0, r * 0.12, r * 0.06, R * 1.4);
  } else if (nb === 1) {
    // side box magazine + feed chute
    cbox(p, kit.hull, -r * 0.05, -h * 0.05, -(mw / 2 + r * 0.1), r * 0.3, h * 0.5, r * 0.16, r * 0.03);
  }
  C.t.rate = 0.18 + (1 - C.c) * 0.1;
}

/** Quad AA: central drum, two side cradles with stacked barrels, search radar at the back. */
function quadAA(C: WCtx) {
  const { b, p, rc, kit, r, y0 } = C;
  const R = C.bore;
  plinth(C, 0.6, 0.58);
  b.cyl(kit.metal, r * 0.04, r * 0.04, r * 0.4, [-r * 0.45, y0 + r * 0.5, 0], 'y', 5);
  cbox(b, kit.hull, -r * 0.45, y0 + r * 0.95, 0, r * 0.08, r * 0.24, r * 0.6, r * 0.03, [0, 0, 0.3]);
  C.t.pitch.position.set(r * 0.05, y0 + r * 0.42, 0);
  C.t.pitch.rotation.z = 0.32;
  bx(p, kit.trim, 0, 0, 0, r * 0.3, r * 0.18, r * 1.0);
  const len = C.D * 1.2;
  for (const s of [-1, 1]) {
    cbox(p, kit.panel, r * 0.05, 0, s * r * 0.62, r * 0.75, r * 0.5, r * 0.3);
    for (const y of [-r * 0.12, r * 0.12]) barrel(C, rc, { len, rad: R, x0: r * 0.35, y, z: s * r * 0.62, seg: 6, brake: 'flash' });
  }
  accent(C, r * 0.05, r * 0.26, -r * 0.62, r * 0.5, r * 0.2, undefined, p);
  C.t.rate = 0.1;
}

/** Scattergun: pintle-mounted blunt receiver, drum magazine slung underneath, two short flared barrels side by side. */
function scatter(C: WCtx) {
  const { b, p, rc, kit, r, y0 } = C;
  plinth(C, 0.75, 0.26);
  b.cyl(kit.metal, r * 0.11, r * 0.09, r * 0.4, [-r * 0.3, y0 + r * 0.22, 0], 'y', 6);
  C.t.pitch.position.set(0, y0 + r * 0.72, 0);
  cbox(p, kit.panel, -r * 0.12, 0, 0, r * 0.95, r * 0.32, r * 0.46, r * 0.06);
  cbox(p, kit.trim, -r * 0.2, r * 0.19, 0, r * 0.55, r * 0.07, r * 0.2, r * 0.02);
  // drum magazine: the scattergun's signature lump
  p.cylb(kit.hull, r * 0.27, r * 0.24, r * 0.05, [r * 0.08, -r * 0.33, -r * 0.12], 'z', 10);
  band(p, kit.trim, r * 0.08, -r * 0.33, 0, r * 0.1, r * 0.1, 6);
  accent(C, -r * 0.35, r * 0.165, r * 0.12, r * 0.3, r * 0.08, undefined, p);
  const R = Math.max(C.bore, r * 0.12);
  const len = C.D * 0.72, x0 = r * 0.33;
  for (const z of [-R * 1.08, R * 1.08]) barrel(C, rc, { len, rad: R, x0, z, seg: 7, brake: 'flash', taper: 1 });
  cbox(rc, kit.trim, x0 + len * 0.45, 0, 0, r * 0.08, R * 2.3, R * 4.5, R * 0.2);
  C.t.rate = 0.5;
}

/** APS: sensor dome with a lens emitter on a short arm. */
function pointDefence(C: WCtx) {
  const { b, p, rc, kit, r, y0 } = C;
  plinth(C, 0.7, 0.58);
  cbox(b, kit.hull, -r * 0.1, y0 + r * 0.62, 0, r * 0.1, r * 0.3, r * 0.5, r * 0.03, [0, 0, 0.35]);
  C.t.pitch.position.set(r * 0.35, y0 + r * 0.38, r * 0.3);
  ball(p, kit.trim, 0, 0, 0, r * 0.22, 1, 8, 'x');
  rc.cyl(kit.metal, r * 0.13, r * 0.11, r * 0.45, [0, 0, 0], 'x', 7);
  rc.cyl(kit.glass, r * 0.1, r * 0.1, r * 0.03, [r * 0.45, 0, 0], 'x', 7);
  rc.cyl(kit.rail, r * 0.05, r * 0.05, r * 0.02, [r * 0.47, 0, 0], 'x', 6);
  C.muzzle(r * 0.5, 0, 0);
  C.t.shot = 'beam';
  C.t.rate = 0.3;
}

/** Flak: open AA mount: drum base, cheek plates, long steeply elevated barrels with flash hiders and clip racks. */
function flak(C: WCtx) {
  const { b, p, rc, kit, r, y0 } = C;
  const n = Math.max(1, C.nb);
  const R = C.bore;
  plinth(C, 0.8, 0.3);
  const cols = n >= 4 ? 2 : n, rows = n >= 4 ? 2 : 1;
  const gap = R * 4, wid = cols * gap + R * 2;
  // trunnion cheeks: thin, light plates either side of the cradle (not a solid wall)
  for (const s of [-1, 1]) shell(b, kit.hull, [[-r * 0.4, r * 0.05, r * 0.04, r * 0.62], [r * 0.2, r * 0.05, r * 0.04, r * 0.46]], y0 + r * 0.2, s * (wid / 2 + r * 0.08));
  C.t.pitch.position.set(0, y0 + r * 0.7, 0);
  C.t.pitch.rotation.z = 0.55;
  cbox(p, kit.panel, -r * 0.05, 0, 0, r * 0.7, r * (0.3 + 0.22 * (rows - 1)), wid, r * 0.06);
  const len = C.D * (1.3 + 0.2 * C.c);
  for (let j = 0; j < rows; j++) for (const z of zs(cols, gap)) {
    const y = rows > 1 ? (j - 0.5) * R * 3.6 : 0;
    barrel(C, rc, { len, rad: R, x0: r * 0.2, y, z, seg: 7, sleeve: true, brake: 'flash' });
    // ready clip on top of each breech, shell tips showing
    bx(rc, kit.hull, -r * 0.08, y + R * 1.6 + r * 0.1, z, r * 0.32, r * 0.18, R * 1.8);
    bx(rc, kit.hazard, r * 0.1, y + R * 1.6 + r * 0.1, z, r * 0.05, r * 0.14, R * 1.5);
  }
  accent(C, -r * 0.15, r * (0.15 + 0.11 * (rows - 1)), 0, r * 0.4, wid * 0.6, undefined, p);
  C.t.shot = 'shell';
  C.t.rate = 0.35;
}

/** Gatling: fork-mounted receiver drum, a spinning cluster of thin barrels (rear carrier, spindle, mid and muzzle
 *  clamps) and an ammo drum: a side drum on the minigun, a huge drum behind the receiver on the L/XL rotary cannon. */
function gatling(C: WCtx) {
  const { b, p, rc, sp, kit, r, y0 } = C;
  const n = Math.max(6, C.nb);
  const big = C.tier >= 4;
  const cr = r * (big ? 0.3 : 0.25);
  // thin barrels with clear gaps between them (a fat tube bundle reads as a revolver cylinder)
  const rb = Math.min(Math.max(C.bore * 0.75, r * 0.04), cr * Math.sin(Math.PI / n) * 0.6);
  const len = C.D * (big ? 1.3 : 1.2);
  const ro = cr + rb * 1.8; // clamp / receiver outer radius
  // yoke
  plinth(C, 0.72, 0.24);
  for (const s of [-1, 1]) cbox(b, kit.trim, -r * 0.05, y0 + r * 0.42, s * (ro + r * 0.2), r * 0.5, r * 0.5, r * 0.12, r * 0.04);
  C.t.pitch.position.set(-r * 0.05, y0 + r * 0.5, 0);
  // receiver drum (pitches with the barrels)
  // octagonal armoured receiver (pitches with the barrels) and a shroud over the rear of the barrel cluster
  jacket(p, kit.panel, -r * 0.5, r * 0.3, 0, 0, (ro + r * 0.06) * 2, (ro + r * 0.1) * 2, 0.92);
  jacket(rc, kit.trim, r * 0.36, r * 0.36 + len * 0.38, 0, 0, (ro + r * 0.02) * 2, (ro + r * 0.02) * 2, 0.94);
  bx(rc, kit.glow, r * 0.36 + len * 0.19, ro * 0.6, ro + r * 0.02, len * 0.26, r * 0.03, r * 0.02);
  if (big) {
    // linkless ammo drum behind the receiver, with a feed/return chute arching over it
    p.cylb(kit.hull, ro * 1.05, r * 0.75, r * 0.06, [-r * 1.22, 0, 0], 'x', 10);
    band(p, kit.trim, -r * 0.85, 0, 0, ro * 1.1, r * 0.06, 10);
    cbox(p, kit.trim, -r * 0.62, ro * 1.0, 0, r * 0.5, r * 0.12, r * 0.22, r * 0.03);
    accent(C, -r * 0.85, ro * 1.07, 0, r * 0.4, r * 0.14, undefined, p);
  } else {
    p.cylb(kit.hull, r * 0.3, r * 0.26, r * 0.05, [-r * 0.2, 0, -(ro + r * 0.06)], '-z', 10);
    bx(p, kit.trim, -r * 0.02, -r * 0.12, -(ro + r * 0.01), r * 0.28, r * 0.12, r * 0.1);
    accent(C, -r * 0.25, ro + r * 0.04, 0, r * 0.45, r * 0.12, undefined, p);
  }
  // fixed front bearing collar (recoils)
  rc.lathe(kit.trim, [[0, 0], [ro, 0], [ro, r * 0.1], [0, r * 0.1]], [r * 0.25, 0, 0], 'x', 10);
  C.spin('x', [r * 0.33, 0, 0]);
  sp.cyl(kit.trim, ro * 0.95, ro * 0.95, r * 0.08, [0, 0, 0], 'x', n); // rear barrel carrier
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; sp.cyl(kit.metal, rb, rb, len, [0, Math.sin(a) * cr, Math.cos(a) * cr], 'x', 5); }
  sp.cyl(kit.trim, cr * 0.42, cr * 0.42, len * 0.84, [0, 0, 0], 'x', 6); // central spindle
  sp.cyl(kit.steel, ro * 0.92, ro * 0.92, r * 0.05, [len * 0.42, 0, 0], 'x', n); // mid clamp
  sp.cyl(kit.steel, ro, ro, r * 0.1, [len * 0.8, 0, 0], 'x', 10); // muzzle clamp; the barrels stick out past it
  C.muzzle(r * 0.33 + len + r * 0.04, 0, 0);
  C.t.rate = 0.07;
}

const tankCommon = (C: WCtx, roofY: number, cx: number, cz: number) => {
  const { b, kit, r } = C;
  b.lathe(kit.trim, [[0, 0], [r * 0.17, 0], [r * 0.15, r * 0.1], [0, r * 0.12]], [cx, roofY - 0.002, cz], 'y', 8);
  bx(b, kit.glass, cx + r * 0.15, roofY + r * 0.05, cz, r * 0.03, r * 0.05, r * 0.12);
};

/** 75 mm class: compact armoured turret, single shrouded gun with a block brake. */
function castDome(C: WCtx) {
  const { p, rc, kit, r, y0 } = C;
  const R = C.bore, h = r * 0.5;
  mechHousing(C, r * 1.7, r * 0.72, h, 0.9);
  C.t.pitch.position.set(r * 0.7, y0 + h * 0.5, 0);
  cbox(p, kit.trim, 0, 0, 0, r * 0.4, h * 0.8, Math.max(R * 5.5, r * 0.62), r * 0.07, undefined, 0.78);
  barrel(C, rc, { len: mainLen(C, C.D * 1.45, 0.72), rad: R, x0: r * 0.12, seg: 8, evac: true, brake: 'slot' });
  C.t.shot = 'shell';
  C.t.rate = 1.0;
}

/** 120 mm class: long low armoured wedge, heavy cheeks, long shrouded smoothbore with a muzzle sensor. */
function wedgeTank(C: WCtx) {
  const { p, rc, kit, r, y0 } = C;
  const R = C.bore, h = r * 0.46;
  mechHousing(C, r * 2.1, r * 0.82, h, 1.25);
  C.t.pitch.position.set(r * 0.9, y0 + h * 0.52, 0);
  cbox(p, kit.trim, 0, 0, 0, r * 0.44, h * 0.84, Math.max(R * 6, r * 0.66), r * 0.06, undefined, 0.8);
  const len = mainLen(C, C.D * 1.6, 0.76);
  barrel(C, rc, { len, rad: R, x0: r * 0.12, seg: 8, sleeve: true, evac: true, brake: 'block' });
  cbox(rc, kit.trim, r * 0.12 + len * 0.6, R * 1.6, 0, R * 1.6, R * 0.6, R * 0.8, R * 0.1);
  C.t.shot = 'shell';
  C.t.rate = 1.2;
}

/** Twin 120: wide armoured housing, two shrouded barrels on one broad mantlet. */
function twinHex(C: WCtx) {
  const { p, rc, kit, r, y0 } = C;
  const R = C.bore, h = r * 0.46, gap = Math.max(R * 3.6, r * 0.34);
  mechHousing(C, r * 1.9, r * 0.92, h, 1.15);
  C.t.pitch.position.set(r * 0.85, y0 + h * 0.5, 0);
  cbox(p, kit.trim, 0, 0, 0, r * 0.4, h * 0.76, gap + R * 6, r * 0.06, undefined, 0.85);
  for (const z of zs(2, gap)) barrel(C, rc, { len: mainLen(C, C.D * 1.4, 0.68), rad: R, x0: r * 0.1, z, seg: 8, evac: true, brake: 'slot' });
  C.t.shot = 'shell';
  C.t.rate = 0.9;
}

/** 240 mm siege gun: tall armoured casemate, monster shrouded barrel with exposed recoil rams. */
function siegeCasemate(C: WCtx) {
  const { p, rc, kit, r, y0 } = C;
  const R = C.bore, h = r * 0.66;
  mechHousing(C, r * 1.95, r * 0.8, h, 1.0, 1);
  C.t.pitch.position.set(r * 0.6, y0 + h * 0.6, 0);
  cbox(p, kit.trim, 0, 0, 0, r * 0.46, h * 0.85, R * 5, r * 0.07, undefined, 0.85);
  for (const s of [-1, 1]) p.cyl(kit.steel, R * 0.4, R * 0.4, C.D * 0.45, [r * 0.1, R * 1.6, s * R * 1.3], 'x', 6);
  barrel(C, rc, { len: mainLen(C, C.D * 1.6, 0.7, 2.6), rad: R, x0: r * 0.15, seg: 8, sleeve: true, evac: true, brake: 'slot' });
  C.t.shot = 'shell';
  C.t.rate = 2.2;
}

/** Gauss: flat angular casemate, square-section barrel with glowing coil rings, rear capacitor tanks. */
function gauss(C: WCtx) {
  const { b, p, rc, kit, r, y0 } = C;
  const R = Math.max(C.bore, r * 0.14), h = r * 0.48;
  mechHousing(C, r * 1.8, r * 0.78, h, 0.9, 1);
  for (const s of [-1, 1]) {
    capsule(b, kit.hull, -r * 0.55, y0 + h + r * 0.1, s * r * 0.35, r * 0.15, r * 0.7, 'x', 8);
    bx(b, kit.rail, -r * 0.55, y0 + h + r * 0.255, s * r * 0.35, r * 0.4, r * 0.02, r * 0.05);
  }
  C.acc = true;
  accent(C, r * 0.25, y0 + h + 0.002, 0, r * 0.25, r * 0.6);
  C.t.pitch.position.set(r * 0.62, y0 + h * 0.55, 0);
  cbox(p, kit.trim, 0, 0, 0, r * 0.3, h * 0.7, R * 4.4, r * 0.05);
  const len = C.D * 1.3;
  cbox(rc, kit.metal, len / 2 + r * 0.05, 0, 0, len, R * 2.1, R * 2.1, R * 0.35);
  for (let i = 1; i <= 4; i++) rc.lathe(i % 2 ? kit.rail : kit.fitting, [[0, 0], [R * 1.75, 0], [R * 1.75, R * 0.7], [0, R * 0.7]], [len * (0.18 + i * 0.17), 0, 0], 'x', 4, [Math.PI / 4, 0, 0]);
  cbox(rc, kit.trim, len + r * 0.08, 0, 0, R * 1.2, R * 2.6, R * 2.6, R * 0.3);
  C.muzzle(len + r * 0.1 + R * 0.6, 0, 0);
  C.t.shot = 'shell';
  C.t.rate = 1.4;
}

/** Sniper: open pedestal, long slender rifle, big block brake, scope with a glinting lens. */
function sniper(C: WCtx) {
  const { b, p, rc, kit, r, y0 } = C;
  const R = C.bore;
  plinth(C, 0.6, 0.24);
  cbox(b, kit.trim, -r * 0.05, y0 + r * 0.4, 0, r * 0.35, r * 0.3, r * 0.3);
  C.t.pitch.position.set(0, y0 + r * 0.6, 0);
  cbox(rc, kit.panel, -r * 0.05, 0, 0, r * 1.0, r * 0.2, r * 0.16, r * 0.04);
  cbox(rc, kit.trim, -r * 0.6, -r * 0.04, 0, r * 0.3, r * 0.26, r * 0.13, r * 0.03);
  barrel(C, rc, { len: C.D * 1.75, rad: R, x0: r * 0.3, seg: 6, brake: 'block', taper: 0.9 });
  capsule(rc, kit.metal, r * 0.02, r * 0.22, 0, r * 0.075, r * 0.62, 'x', 6);
  rc.cyl(kit.glass, r * 0.07, r * 0.07, r * 0.02, [r * 0.33, r * 0.22, 0], 'x', 6);
  for (const s of [-1, 1]) rc.strut(kit.steel, [r * 0.8, -R, 0], [r * 1.0, -r * 0.4, s * r * 0.18], r * 0.022, r * 0.018, 4);
  accent(C, -r * 0.2, r * 0.11, 0, r * 0.4, r * 0.1, undefined, rc);
  C.t.rate = 2.0;
}

/** Rail: low wedge, twin steel prongs with a glowing channel and coil rings, rear capacitor block. */
function rail(C: WCtx) {
  const { b, p, rc, kit, r, y0 } = C;
  const R = Math.max(C.bore * 1.25, r * 0.11), h = r * 0.46;
  const xl = C.tier >= 5;
  mechHousing(C, r * 1.9, r * 0.8, h, 1.0, 1);
  cbox(b, kit.trim, -r * 0.55, y0 + h + r * 0.1, 0, r * 0.5, r * 0.2, r * 0.55);
  for (const s of [-1, 1]) bx(b, kit.rail, -r * 0.55, y0 + h + r * 0.12, s * r * 0.28, r * 0.36, r * 0.1, r * 0.02);
  accent(C, r * 0.2, y0 + h + 0.002, 0, r * 0.4, r * 0.18);
  C.t.pitch.position.set(r * 0.5, y0 + h * 0.55, 0);
  cbox(p, kit.trim, 0, 0, 0, r * 0.32, h * 0.75, R * 6);
  const len = C.D * (xl ? 1.6 : 1.3 + 0.2 * C.c);
  for (const s of [-1, 1]) cbox(rc, kit.metal, len / 2 + r * 0.05, 0, s * R * 1.25, len, R * 2.4, R * 0.9, R * 0.3);
  bx(rc, kit.rail, len / 2 + r * 0.1, 0, 0, len * 0.95, R * 1.6, R * 1.4);
  const nr = xl ? 5 : C.c > 0.6 ? 4 : 3;
  for (let i = 0; i < nr; i++) rc.lathe(kit.fitting, [[0, 0], [R * 2.1, 0], [R * 2.1, R * 0.8], [0, R * 0.8]], [len * (0.12 + (0.7 * i) / Math.max(1, nr - 1)), 0, 0], 'x', 6, [Math.PI / 6, 0, 0]);
  C.muzzle(len + r * 0.08, 0, 0);
  C.t.shot = 'beam';
  C.t.rate = 2.0;
}
