// Seeded 3D gradient Perlin noise. Integer lattice gradients are hashed, and
// quintic interpolation makes the field continuous across lattice boundaries.
const gradients = [[1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],
  [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],
  [0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]];

function gradient(x: number, y: number, z: number, seed: number, dx: number, dy: number, dz: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  const g = gradients[(h >>> 0) % gradients.length];
  return g[0] * dx + g[1] * dy + g[2] * dz;
}
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function oreNoise(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const dx = x - ix, dy = y - iy, dz = z - iz;
  const u = fade(dx), v = fade(dy), w = fade(dz);
  const layer = (k: number) => lerp(
    lerp(gradient(ix, iy, iz + k, seed, dx, dy, dz - k), gradient(ix + 1, iy, iz + k, seed, dx - 1, dy, dz - k), u),
    lerp(gradient(ix, iy + 1, iz + k, seed, dx, dy - 1, dz - k), gradient(ix + 1, iy + 1, iz + k, seed, dx - 1, dy - 1, dz - k), u), v);
  return lerp(layer(0), layer(1), w);
}
