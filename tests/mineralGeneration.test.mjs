import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorldGen } from '../src/worldgen.ts';
import { B } from '../src/blocks.ts';

const ores = [B.COPPER_ORE, B.IRON_ORE, B.COAL_ORE];
const bands = new Map([[B.COPPER_ORE, [4, 70]], [B.IRON_ORE, [12, 180]], [B.COAL_ORE, [6, 140]]]);
const gen = seed => new WorldGen(5120, 512, 5120, seed);
function at(col, x, y, z) {
  const cy = y >> 5, b = col.blocks[cy];
  return b ? b[(x & 31) | ((z & 31) << 5) | ((y & 31) << 10)] : col.fill[cy];
}
function sameColumn(a, b) {
  assert.deepEqual(a.fill, b.fill);
  assert.deepEqual(a.blocks, b.blocks);
  assert.deepEqual(a.decor, b.decor);
  assert.deepEqual(a.water, b.water);
}

test('ore generation is deterministic regardless of column order and changes with seed', () => {
  const a = gen(12345), b = gen(12345), c = gen(54321);
  const first = a.generateColumn(80, 80);
  a.generateColumn(81, 80);
  b.generateColumn(81, 80);
  sameColumn(first, b.generateColumn(80, 80));
  assert.notDeepEqual(first.blocks, c.generateColumn(80, 80).blocks);
  // Hold the surface fixed, so differences cannot come from terrain shape.
  for (const g of [a, c]) { g.rawHeight = () => 100; g.sitesNear = () => []; g.treeAt = () => 0; }
  const flatA = a.generateColumn(10, 10), flatC = c.generateColumn(10, 10);
  const mask = col => Array.from({ length: 32 * 32 * 100 }, (_, i) => {
    const x = i & 31, z = (i >> 5) & 31, y = i >> 10;
    const t = at(col, x, y, z);
    return ores.includes(t) ? t : 0;
  });
  assert.notDeepEqual(mask(flatA), mask(flatC));
});

test('accessible deposits obey depth bands and connect across column seams', () => {
  const g = gen(12345), cols = new Map(), counts = new Map(ores.map(t => [t, 0]));
  let joined = 0, shallow = 0;
  for (let cx = 78; cx <= 82; cx++) for (let cz = 78; cz <= 82; cz++) cols.set(`${cx},${cz}`, g.generateColumn(cx, cz));
  for (let cx = 78; cx <= 82; cx++) for (let cz = 78; cz <= 82; cz++) {
    const col = cols.get(`${cx},${cz}`);
    for (let x = cx * 32; x < (cx + 1) * 32; x++) for (let z = cz * 32; z < (cz + 1) * 32; z++) {
      const h = Math.floor(g.heightAt(x, z));
      for (let y = 1; y <= h; y++) {
        const t = at(col, x, y, z);
        if (!bands.has(t)) continue;
        counts.set(t, counts.get(t) + 1);
        const [min, max] = bands.get(t), depth = h - y;
        assert.ok(depth >= min && depth <= max, `${t} at depth ${depth}`);
        if (depth <= 25) shallow++;
        if (x % 32 === 31 && cx < 82 && at(cols.get(`${cx + 1},${cz}`), x + 1, y, z) === t) joined++;
      }
    }
  }
  for (const t of ores) assert.ok(counts.get(t) > 100, `scarce ore ${t}: ${counts.get(t)}`);
  assert.ok(shallow > 100, `too few shallow blocks: ${shallow}`);
  assert.ok(joined > 10, `no coherent seams: ${joined}`);
});

test('rock far below deposits stays uniform', () => {
  const g = gen(12345);
  g.rawHeight = () => 400;
  g.sitesNear = () => [];
  g.treeAt = () => 0;
  const col = g.generateColumn(10, 10);
  for (let cy = 1; cy <= 5; cy++) {
    assert.equal(col.blocks[cy], null);
    assert.equal(col.fill[cy], B.STONE);
  }
});

test('terrain and spawn heights match the previous generator', () => {
  const g = gen(12345);
  assert.deepEqual(g.spawn, { kind: 'castle', x: 2560, z: 2560, g: 57, r: 16 });
  for (const [x, z, raw, shaped] of [
    [2560, 2560, 56.84683772279844, 56.2],
    [2500, 2500, 78.01348076454313, 78.01348076454313],
    [1200, 4000, 90.38255476497366, 90.38255476497366],
    [30, 30, 22, 22], [3800, 1800, 22, 22],
  ]) {
    assert.equal(g.rawHeight(x, z), raw);
    assert.equal(g.heightAt(x, z), shaped);
  }
});
