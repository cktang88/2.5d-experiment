// How much of the world the minimap shows, and where off-map enemies are pointed to. Pure, so it is
// unit-tested in Node (tests/minimapView.test.mjs).

/** blocks across the minimap in normal play: close enough that a single enemy dot is easy to spot */
export const BASE_VIEW = 96;
/** the furthest it zooms out to keep the last few enemies on the map */
export const MAX_VIEW = 256;
/** with this many enemies or fewer left, the map widens until all of them fit */
export const FIT_COUNT = 5;
const MARGIN = 10; // blocks between the farthest enemy and the map's edge

export interface XZ { x: number; z: number }

/**
 * Blocks across the (circular) minimap. Normally BASE_VIEW; when only a few enemies remain it widens
 * just enough to show all of them, up to MAX_VIEW. Enemies further out still get rim arrows.
 */
export function minimapView(center: XZ, enemies: readonly XZ[]): number {
  if (!enemies.length || enemies.length > FIT_COUNT) return BASE_VIEW;
  let far = 0;
  for (const e of enemies) far = Math.max(far, Math.hypot(e.x - center.x, e.z - center.z));
  return Math.min(MAX_VIEW, Math.max(BASE_VIEW, Math.ceil(2 * (far + MARGIN))));
}

/** ease the shown view toward the wanted one (called a few times a second; widening is quicker than narrowing) */
export function easeView(current: number, wanted: number): number {
  const k = wanted > current ? 0.5 : 0.25;
  const next = current + (wanted - current) * k;
  return Math.abs(wanted - next) < 0.5 ? wanted : next;
}

/**
 * For an enemy outside the map circle (radius `view / 2` around `center`), the point on the rim
 * `inset` blocks inside the edge in its direction and the angle to draw the arrow at; null when it is
 * on the map.
 */
export function rimMarker(center: XZ, e: XZ, view: number, inset = 0): { x: number; z: number; angle: number } | null {
  const dx = e.x - center.x, dz = e.z - center.z, d = Math.hypot(dx, dz), r = view / 2 - inset;
  if (d <= view / 2) return null;
  return { x: center.x + dx / d * r, z: center.z + dz / d * r, angle: Math.atan2(dz, dx) };
}
