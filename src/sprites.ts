// Procedural art entry point: character sprite sheets, foliage atlas, UI icons and the voxel detail
// atlas. Everything is drawn at runtime as smooth inked vector art (see src/art/), so there are no
// image assets. This module keeps the small public surface the rest of the game imports.
import * as THREE from 'three';
import { canvas, get2d } from './art/draw';

export type { Palette, SpriteSheets } from './art/characters';
export { makeSheets } from './art/characters';
export { makeFoliageAtlas } from './art/foliage';
export { icon } from './art/icons';
export { TILE, makeDetailAtlas, DETAIL_TILE, DETAIL_GUTTER, DETAIL_CELL, DETAIL_SIZE } from './art/tiles';

// soft round texture for smoke & blob shadows
export function makeBlobTexture(): THREE.CanvasTexture {
  const c = canvas(64, 64), ctx = get2d(c);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(0.6, 'rgba(0,0,0,0.3)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
