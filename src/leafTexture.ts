// Cut-out leaf texture (16x16, one tile per block face), after "maple_leaves.png" from the CC0
// "16x16 Block Texture Set" on OpenGameArt (see docs/ASSET_PROVENANCE.md). The darkest colour
// became the holes ('.'); the two greens are shades ('1' dark, '2' light) that multiply the block's
// own leaf colour, so biome tints and the painterly patches still apply.
import * as THREE from 'three';

export const LEAF_ROWS = [
  '..1211..1111222.',
  '..121..1111212..',
  '122222.1111211..',
  '2222222..22222..',
  '2222222.2222222.',
  '11222..12222222.',
  '1.222..1..222...',
  '1112.11111222.11',
  '111112111112.111',
  '11111211111..111',
  '11.222221....2.1',
  '112222222....2.1',
  '1.2222222..22222',
  '211122211.222222',
  '211122211.222222',
  '...1121...1.222.',
];

/** shade multipliers for '1' and '2' (mean over the opaque texels is about 1) */
export const LEAF_SHADE: Record<string, number> = { '1': 0.8, '2': 1.12 };

/** RGBA8 texture: R = shade / 2, A = 255 where there is leaf, 0 for holes. Read with texelFetch. */
export function makeLeafTexture(): THREE.DataTexture {
  const data = new Uint8Array(16 * 16 * 4);
  LEAF_ROWS.forEach((row, y) => [...row].forEach((c, x) => {
    const i = ((15 - y) * 16 + x) * 4; // row 0 is the top of the face
    const s = LEAF_SHADE[c] ?? 0;
    data[i] = Math.round(s / 2 * 255);
    data[i + 3] = c === '.' ? 0 : 255;
  }));
  const tex = new THREE.DataTexture(data, 16, 16, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}
