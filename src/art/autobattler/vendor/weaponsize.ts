// @ts-nocheck
// Physically consistent weapon sizing. One place decides how big a weapon looks, from what it is:
//   - housing (turret base) diameter: a strict band per size tier (S < M < L < XL-giant < XL-titan, bands never overlap), placed
//     inside the band by calibre and module weight. Sized to the WEAPON, never to the slot it sits in.
//   - bore (barrel width): from the real calibre in mm where the name has one, otherwise an equivalent calibre from
//     damage per shot inside the class band. Bore grows sub-linearly (mm^0.65) so 7.62 .. 400 mm all stay drawable.
// All values are "reference" cells (a 1x1 hull); the layout multiplies them by its unit-size factor.

import type { ModuleDef, MountClass } from './types.ts';
import { moduleTier } from './parts.ts';

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export const CLASS_RANK: Record<MountClass, number> = { S: 1, M: 2, L: 4, XL: 5 };
/** size tier 1..5 (S, M, L, XL giant-scale, XL titan-scale); a slot class override maps S1 M2 L3 XL4 */
const tierOf = (m: ModuleDef, cls?: MountClass): number => (cls && cls !== m.mount ? CLASS_RANK[cls] : moduleTier(m));

/** equivalent-calibre band (mm) per class: named calibres fall inside these, others are placed by damage */
const BAND_MM: [number, number][] = [[0, 0], [5, 25], [25, 85], [90, 160], [170, 260], [280, 420]];
/** damage-per-shot range per class used to place un-named weapons in the band */
const BAND_DMG: [number, number][] = [[0, 0], [8, 140], [8, 150], [30, 480], [22, 520], [140, 2200]];
/** module weight range per class */
const BAND_WT: [number, number][] = [[0, 0], [0.8, 2], [2, 5], [6, 13], [12, 18], [30, 40]];
/** housing diameter band (reference cells) per class: max of one class < min of the next by >= 11% */
export const BAND_D: [number, number][] = [[0, 0], [0.28, 0.36], [0.42, 0.52], [0.58, 0.68], [0.8, 0.9], [1.0, 1.12]];

/** calibres that are not spelled out in the module name */
const NAMED_MM: Record<string, number> = {
  howitzer: 155, barrage: 105, cannon: 120, twin120: 120, siege240: 240, doomsday: 406, massdriver: 380, sniper: 14.5,
  mortar: 81, flak: 57, heavyflak: 88, skyfortress: 200, lightrail: 35, railgun: 110, gauss: 105, minigun: 7.62, avenger: 200,
};

const logT = (v: number, lo: number, hi: number) => clamp(Math.log(Math.max(v, 1e-3) / lo) / Math.log(hi / lo), 0, 1);

const mmCache = new Map<string, number>();
/** Real (or equivalent) calibre in mm. */
export function calibreMm(m: ModuleDef): number {
  let v = mmCache.get(m.id);
  if (v !== undefined) return v;
  const [lo, hi] = BAND_MM[moduleTier(m)];
  const named = NAMED_MM[m.id] ?? (/(\d+(?:\.\d+)?)\s*mm/i.exec(m.name) ? Number(/(\d+(?:\.\d+)?)\s*mm/i.exec(m.name)![1]) : undefined);
  if (named !== undefined) v = named;
  else if (m.kind === 'weapon' && m.damage) {
    const [dl, dh] = BAND_DMG[moduleTier(m)];
    v = lo * Math.pow(hi / lo, logT(m.damage, dl, dh));
  } else v = lo * Math.pow(hi / lo, clamp(m.caliber ?? 0.5, 0, 1));
  mmCache.set(m.id, v);
  return v;
}

/** 0..1 position of a module inside its class (calibre first, then weight). */
export function classPos(m: ModuleDef, cls?: MountClass): number {
  const t = tierOf(m, cls);
  const [lo, hi] = BAND_MM[t];
  const [wl, wh] = BAND_WT[t];
  return clamp(0.65 * logT(calibreMm(m), lo, hi) + 0.35 * clamp((m.weight - wl) / (wh - wl), 0, 1), 0, 1);
}

/** Housing (turret base) diameter in reference cells. `cls` overrides the class (utilities shrunk to a smaller hardpoint). */
export function weaponD(m: ModuleDef, cls?: MountClass): number {
  const [a, b] = BAND_D[tierOf(m, cls)];
  return a + (b - a) * classPos(m, cls);
}

/** Empty-slot / socket diameter for a hardpoint class (reference cells): the middle of the class band. */
export function slotD(cls: MountClass): number {
  const [a, b] = BAND_D[CLASS_RANK[cls]];
  return (a + b) / 2;
}

/** Absolute bore (barrel width) in reference cells for a calibre. */
export const boreOf = (mm: number) => 0.00535 * Math.pow(mm, 0.65);

/** Bore as a fraction of the turret radius r = d/2 (so it scales with the drawn turret). */
export function boreFrac(m: ModuleDef): number {
  return boreOf(calibreMm(m)) / (weaponD(m) / 2);
}

/** Sort key for visual size: class first, then calibre/weight inside the class. */
export const sizeKey = (m: ModuleDef, cls?: MountClass) => tierOf(m, cls) + classPos(m, cls) * 0.98;
