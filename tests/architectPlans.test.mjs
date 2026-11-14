// Fast geometry tests for the architect planner against placeholder voxel worlds (no renderer).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlan, boxVolume, MAX_SPAN } from '../src/architectPlans.ts';
import { defenseRings, footprintSize } from '../src/defenses.ts';

/** a tiny world: solid below `ground` (or a per-column height function), everything generated */
function flatWorld(ground = 10, extra = new Set(), heightAt = null) {
  return {
    W: 512, H: 128, D: 512,
    solid: (x, y, z) => extra.has(`${x},${y},${z}`) || y < (heightAt ? heightAt(x, z) : ground),
    isGenerated: () => true,
  };
}
const opts = (o = {}) => ({
  tool: 'wall', height: 3, thickness: 1, depth: 3, eraseHeight: 10, battlements: false, foundation: false,
  roof: true, door: true, pillars: true, hollow: true, flood: true, span: 3, camera: { x: 0, z: 0 }, ...o,
});
const cellsOf = (boxes) => {
  const s = new Set();
  for (const b of boxes) for (let y = b[1]; y <= b[4]; y++) for (let z = b[2]; z <= b[5]; z++) for (let x = b[0]; x <= b[3]; x++) s.add(`${x},${y},${z}`);
  return s;
};
const volume = (boxes) => boxes.reduce((n, b) => n + boxVolume(b), 0);
const has = (set, x, y, z) => set.has(`${x},${y},${z}`);

test('wall enclosure: hollow ring of the set thickness, boxes never overlap', () => {
  const p = makePlan(flatWorld(), opts({ thickness: 2 }), [100, 10, 100], [109, 10, 107], 10);
  const cells = cellsOf(p.fill);
  assert.equal(p.error, '');
  assert.equal(volume(p.fill), cells.size, 'overlapping boxes');
  assert.equal(cells.size, (10 * 8 - 6 * 4) * 3);
  assert.ok(has(cells, 101, 12, 101) && !has(cells, 102, 10, 102), 'two thick, hollow inside');
  assert.ok(!has(cells, 100, 13, 100), 'height 3 stops at base + 2');
});

test('thin drag makes a straight wall centred on the drag line', () => {
  const cells = cellsOf(makePlan(flatWorld(), opts({ thickness: 3 }), [50, 10, 60], [70, 10, 60], 10).fill);
  for (const z of [59, 60, 61]) assert.ok(has(cells, 60, 10, z));
  assert.ok(!has(cells, 60, 10, 58) && !has(cells, 60, 10, 62));
  assert.equal(cells.size, 21 * 3 * 3);
});

test('100 x 200 x 5 block is exactly 100,000 cells in one box', () => {
  const p = makePlan(flatWorld(), opts({ tool: 'box', height: 5 }), [10, 20, 10], [109, 20, 209], 20);
  assert.equal(p.error, '');
  assert.equal(p.fill.length, 1);
  assert.equal(volume(p.fill), 100_000);
});

test('foundations fill dips down to the ground but skip bottomless drops', () => {
  const heightAt = (x) => x === 33 ? 67 : x === 34 ? 5 : 70; // a 3-deep dip, and a 65-deep shaft
  const p = makePlan(flatWorld(70, new Set(), heightAt), opts({ foundation: true }), [30, 70, 5], [36, 70, 5], 70);
  const cells = cellsOf(p.fill);
  for (const y of [67, 68, 69]) assert.ok(has(cells, 33, y, 5), `dip filled at y ${y}`);
  assert.ok(!has(cells, 33, 66, 5), 'stops on the ground');
  assert.ok(!has(cells, 34, 69, 5), 'no 48-block stilt down a shaft');
  assert.ok(!has(cells, 31, 69, 5), 'flat ground needs nothing');
});

test('room: floor, roof, and a doorway only on the side facing the camera', () => {
  const o = opts({ tool: 'room', height: 6, camera: { x: 105, z: 400 } }); // camera far to +z (south)
  const cells = cellsOf(makePlan(flatWorld(), o, [100, 10, 100], [111, 10, 109], 10).fill);
  assert.ok(has(cells, 105, 10, 105), 'floor');
  assert.ok(has(cells, 105, 16, 105), 'roof at base + height');
  const doorX = Math.floor((100 + 111) / 2);
  for (const y of [11, 12, 13]) assert.ok(!has(cells, doorX, y, 109), `south doorway open at y ${y}`);
  assert.ok(has(cells, doorX, 14, 109), 'lintel above the door');
  for (const y of [11, 12, 13]) assert.ok(has(cells, doorX, y, 100), 'north wall solid');
});

test('room pillars keep every roof cell within the material span of a support', () => {
  for (const [span, door, cam] of [[3, false, 0], [6, false, 0], [3, true, 0], [6, true, 900], [4, true, 900]]) {
    const [x0, z0, x1, z1, base, H] = [200, 200, 240, 236, 10, 5];
    const o = opts({ tool: 'room', height: H, span, door, battlements: false, camera: { x: cam, z: 218 } });
    const cells = cellsOf(makePlan(flatWorld(), o, [x0, base, z0], [x1, base, z1], base).fill);
    const roofY = base + H;
    // supports: roof cells with a solid block directly under them (walls and pillars)
    const dist = new Map(), queue = [];
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (has(cells, x, roofY - 1, z)) { dist.set(`${x},${z}`, 0); queue.push([x, z]); }
    while (queue.length) {
      const [x, z] = queue.shift(), d = dist.get(`${x},${z}`);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz, k = `${nx},${nz}`;
        if (nx < x0 || nx > x1 || nz < z0 || nz > z1 || dist.has(k)) continue;
        dist.set(k, d + 1); queue.push([nx, nz]);
      }
    }
    assert.equal(dist.size, (x1 - x0 + 1) * (z1 - z0 + 1));
    assert.ok(Math.max(...dist.values()) <= span, `span ${span} door ${door}: worst ${Math.max(...dist.values())}`);
  }
});

test('narrow rooms need no pillars; pillars off warns instead', () => {
  const small = makePlan(flatWorld(), opts({ tool: 'room', height: 5 }), [0, 10, 0], [7, 10, 7], 10);
  assert.equal(cellsOf(small.fill).has('3,12,3'), false);
  const wide = makePlan(flatWorld(), opts({ tool: 'room', height: 5, pillars: false }), [0, 10, 0], [30, 10, 30], 10);
  assert.match(wide.note, /pillars/);
});

test('tower: symmetric hollow ring with a manned floor on top', () => {
  const cells = cellsOf(makePlan(flatWorld(), opts({ tool: 'tower', height: 6, thickness: 2 }), [64, 10, 64], [69, 10, 64], 10).fill);
  for (const [dx, dz] of [[5, 0], [-5, 0], [0, 5], [0, -5]]) assert.ok(has(cells, 64 + dx, 10, 64 + dz), 'radius 5 in every direction');
  assert.ok(!has(cells, 64, 10, 64) && !has(cells, 64, 14, 64), 'hollow core');
  assert.ok(has(cells, 64, 15, 64), 'top floor');
});

test('stairs climb one block per step toward the release point, capped at the rise', () => {
  const step = (cells, x) => { let y = 10; while (has(cells, x, y, 50)) y++; return y - 10; };
  const up = cellsOf(makePlan(flatWorld(), opts({ tool: 'stairs', height: 4 }), [10, 10, 50], [17, 10, 51], 10).fill);
  assert.deepEqual([10, 11, 12, 13, 14, 15, 16, 17].map(x => step(up, x)), [1, 2, 3, 4, 4, 4, 4, 4]);
  const back = cellsOf(makePlan(flatWorld(), opts({ tool: 'stairs', height: 4 }), [17, 10, 50], [10, 10, 51], 10).fill);
  assert.deepEqual([17, 16, 15, 14].map(x => step(back, x)), [1, 2, 3, 4]);
});

test('moat: ring trench, water below the rim, hill cut only above the base', () => {
  const p = makePlan(flatWorld(), opts({ tool: 'moat', thickness: 2, depth: 3 }), [0, 9, 0], [19, 9, 19], 9);
  const dug = cellsOf(p.clear), water = cellsOf(p.flood);
  assert.ok(has(dug, 0, 7, 10) && has(dug, 1, 9, 10) && !has(dug, 2, 9, 10), 'two wide, three deep');
  assert.ok(!has(dug, 10, 8, 10), 'island untouched');
  for (const k of water) assert.ok(dug.has(k), 'water only inside the trench');
  assert.ok(has(water, 0, 8, 10) && !has(water, 0, 9, 10), 'one block of freeboard');
  assert.ok(p.cut.every(b => b[1] === 10));
});

test('errors: too wide, outside the world, unloaded', () => {
  const w = flatWorld();
  assert.match(makePlan(w, opts({ tool: 'box' }), [0, 10, 0], [MAX_SPAN, 10, 0], 10).error, /within/);
  assert.match(makePlan(w, opts({ tool: 'box' }), [-3, 10, 0], [3, 10, 0], 10).error, /Outside/);
  assert.match(makePlan(w, opts({ tool: 'box', height: 40 }), [0, 100, 0], [3, 100, 0], 100).error, /tall/);
  assert.match(makePlan({ ...w, isGenerated: () => false }, opts({ tool: 'box' }), [0, 10, 0], [3, 10, 0], 10).error, /loading/);
});

test('defense rings are centred on the rotated footprint the turret is spawned at', () => {
  for (const id of ['auto', 'cannon', 'twin', 'rocket', 'artillery']) for (let rot = 0; rot < 4; rot++) {
    const [w, d] = footprintSize(id, rot), r = defenseRings(id, rot, 40, 20, 70);
    assert.deepEqual([r.cx, r.cz], [40 + w / 2, 70 + d / 2]);
  }
});

test('elevated defenses show the ground reach of their 3D range', () => {
  const level = defenseRings('auto', 0, 0, 30, 0, 30);
  assert.equal(level.range, 18);
  const raised = defenseRings('auto', 0, 0, 30, 0, 20); // 10 blocks above the ground
  assert.ok(Math.abs(raised.range - Math.sqrt(18 * 18 - 100)) < 1e-9);
  assert.equal(raised.y, 20);
  assert.equal(raised.minRange, 2, 'minimum range is horizontal');
  assert.equal(defenseRings('auto', 0, 0, 50, 0, 20).range, 0, 'too high to reach the ground');
});

test('pillars stay out of the doorway approach and stay sparse', () => {
  const o = opts({ tool: 'room', height: 5, span: 3, battlements: false, camera: { x: 220, z: 900 } }); // door on the south side
  const [x0, z0, x1, z1] = [200, 200, 240, 236];
  const cells = cellsOf(makePlan(flatWorld(), o, [x0, 10, z0], [x1, 10, z1], 10).fill);
  const mid = Math.floor((x0 + x1) / 2);
  for (let x = mid - 2; x <= mid + 1; x++) for (let z = z1 - 3; z < z1; z++) assert.ok(!has(cells, x, 11, z), `clear in front of the door at ${x},${z}`);
  let pillars = 0;
  for (let z = z0 + 1; z < z1; z++) for (let x = x0 + 1; x < x1; x++) if (has(cells, x, 11, z)) pillars++;
  const interior = (x1 - x0 - 1) * (z1 - z0 - 1);
  assert.ok(pillars <= interior / 25 + 6, `${pillars} pillars for ${interior} cells`);
  // east-facing door: the approach runs along x instead
  const east = cellsOf(makePlan(flatWorld(), { ...o, camera: { x: 900, z: 218 } }, [x0, 10, z0], [x1, 10, z1], 10).fill);
  const midZ = Math.floor((z0 + z1) / 2);
  for (let z = midZ - 2; z <= midZ + 1; z++) for (let x = x1 - 3; x < x1; x++) assert.ok(!has(east, x, 11, z), `clear inside the east door at ${x},${z}`);
});

// ---- real terrain: generated columns from WorldGen, wrapped as the planner's world interface ----
import { WorldGen } from '../src/worldgen.ts';
import { B } from '../src/blocks.ts';
function generatedWorld(seed = 12345) {
  const gen = new WorldGen(5120, 512, 5120, seed), cols = new Map();
  const col = (cx, cz) => { const k = cx * 4096 + cz; if (!cols.has(k)) cols.set(k, gen.generateColumn(cx, cz)); return cols.get(k); };
  const get = (x, y, z) => {
    if (y < 0) return B.BEDROCK;
    const c = col(x >> 5, z >> 5), cy = y >> 5, b = c.blocks[cy];
    return b ? b[(x & 31) | ((z & 31) << 5) | ((y & 31) << 10)] : c.fill[cy];
  };
  return { gen, get, W: 5120, H: 512, D: 5120, solid: (x, y, z) => get(x, y, z) !== B.AIR, isGenerated: () => true };
}

test('on generated hills, a foundation-backed wall leaves no gap down to the ground', () => {
  const w = generatedWorld();
  // a 60-block wall run across varied terrain away from the spawn castle
  const z = w.gen.spawn.z + 70, xs = [w.gen.spawn.x - 30, w.gen.spawn.x + 29];
  let base = 0;
  for (let x = xs[0]; x <= xs[1]; x++) base = Math.max(base, Math.floor(w.gen.heightAt(x, z)) + 1);
  const cells = cellsOf(makePlan(w, opts({ foundation: true, height: 4 }), [xs[0], base, z], [xs[1], base, z], base).fill);
  let filled = 0;
  for (let x = xs[0]; x <= xs[1]; x++) {
    // walking down from the wall base, every air cell must be planned until real ground is hit
    for (let y = base - 1; y >= 1 && !w.solid(x, y, z); y--) {
      if (base - y > 48) break; // the planner refuses stilts deeper than this
      assert.ok(has(cells, x, y, z), `gap under the wall at ${x},${y},${z}`);
      filled++;
    }
  }
  assert.ok(filled > 0, 'the test site should actually be uneven');
});

test('battlements sit on one outer row only, leaving the walkway on thick walls clear', () => {
  const merlonRows = (cells, y, axis) => new Set([...cells].filter(k => +k.split(',')[1] === y).map(k => +k.split(',')[axis]));
  for (const T of [2, 3]) {
    // straight wall along x, camera to the south (+z): merlons on the far (north) edge only
    const o = opts({ thickness: T, height: 4, battlements: true, camera: { x: 60, z: 400 } });
    const straight = cellsOf(makePlan(flatWorld(), o, [50, 10, 60], [70, 10, 60], 10).fill);
    const z0 = 60 - Math.floor((T - 1) / 2);
    assert.deepEqual([...merlonRows(straight, 14, 2)], [z0], `straight T=${T}: one row of merlons, on the far side`);
    // free-angle diagonal wall: no merlon on the camera side of the centre line
    const line = cellsOf(makePlan(flatWorld(), { ...o, tool: 'line', camera: { x: 0, z: 400 } }, [100, 10, 100], [140, 10, 140], 10).fill);
    const top = [...line].filter(k => +k.split(',')[1] === 14).map(k => k.split(',').map(Number));
    assert.ok(top.length > 0, 'line wall has merlons');
    // the camera at (0, 400) is on the +z-x side of the x=z line; merlons must all be on the other side
    assert.ok(top.every(([x, , z]) => x - z >= 0), `line T=${T}: merlons only on the far side`);
    // and the top of the wall keeps a walkable lane: some wall cells along the line have nothing above them
    const lane = [...line].filter(k => +k.split(',')[1] === 13).map(k => k.split(',').map(Number)).filter(([x, , z]) => x - z < 0 && !line.has(`${x},14,${z}`));
    assert.ok(lane.length > 20, `line T=${T}: walkway lane clear (${lane.length})`);
  }
  // rectangles, rooms and towers already crown only the outer ring
  const ring = cellsOf(makePlan(flatWorld(), opts({ thickness: 2, height: 4, battlements: true }), [0, 10, 0], [11, 10, 11], 10).fill);
  assert.ok(!has(ring, 1, 14, 5) && !has(ring, 1, 14, 6), 'inner row of a 2-thick enclosure stays clear');
});
