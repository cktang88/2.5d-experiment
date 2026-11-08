import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CastleNavigation } from '../src/castleNavigation.ts';

function corridor(sealed = false) {
  const blocks = new Set();
  const put = (x, y, z) => blocks.add(`${x},${y},${z}`);
  for (let x = 0; x < 10; x++) for (let z = 0; z < 7; z++) put(x, 0, z);
  for (let x = 0; x < 10; x++) for (let y = 1; y < 9; y++) { put(x, y, 1); put(x, y, 3); }
  for (let x = 0; x < 10; x++) for (let y = 1; y < 9; y++) put(x, y, 5);
  // A low corridor connects the space beneath the upper floor back to the stairs.
  for (const x of [1, 6]) for (const y of [1, 2]) blocks.delete(`${x},${y},3`);
  for (let y = 1; y < 9; y++) { put(0, y, 4); put(9, y, 4); }
  for (let y = 1; y < 9; y++) { put(0, y, 2); put(9, y, 2); }
  for (let x = 6; x < 9; x++) put(x, 4, 2);
  put(3, 1, 2); put(4, 2, 2); put(5, 3, 2);
  if (sealed) for (let y = 1; y < 9; y++) { put(2, y, 2); put(1, y, 3); }
  return { W: 10, D: 7, H: 10, blocks, isGenerated: () => true, get: (x, y, z) => blocks.has(`${x},${y},${z}`) ? 1 : 0 };
}

test('routes from under an overlapping floor up a staircase', () => {
  const nav = new CastleNavigation(corridor());
  for (let i = 0; i < 100; i++) nav.update({ x: 8.5, y: 5, z: 2.5 }, 0.016);
  for (const [x, y] of [[1, 1], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [7, 5]]) {
    const d = nav.direction({ x: x + 0.5, y, z: 2.5 });
    assert.ok(d && d[0] > 0.99, `expected stair route from ${x},${y}`);
  }
  // The same column has two routes in opposite directions: upstairs toward
  // the target, downstairs toward the corridor and the foot of the stairs.
  const below = nav.direction({ x: 7.5, y: 1, z: 2.5 });
  assert.ok(below && below[0] < -0.99);
});

test('does not route through a sealed room', () => {
  const nav = new CastleNavigation(corridor(true));
  for (let i = 0; i < 100; i++) nav.update({ x: 8.5, y: 5, z: 2.5 }, 0.016);
  assert.equal(nav.direction({ x: 1.5, y: 1, z: 2.5 }), null);
});

test('rejects a next edge obstructed after the field was built', () => {
  const world = corridor();
  const nav = new CastleNavigation(world);
  for (let i = 0; i < 70; i++) nav.update({ x: 8.5, y: 5, z: 2.5 }, 0.016);
  const p = { x: 1.5, y: 1, z: 2.5 };
  assert.ok(nav.direction(p));
  world.blocks.add('2,1,2');
  assert.equal(nav.direction(p), null);
});


test('reset discards routes before a restored world is searched', () => {
  const world = corridor();
  const nav = new CastleNavigation(world);
  for (let i = 0; i < 100; i++) nav.update({ x: 8.5, y: 5, z: 2.5 }, 0.016);
  const start = { x: 1.5, y: 1, z: 2.5 };
  assert.ok(nav.direction(start));
  // A changed block beyond the immediate edge leaves the old first step valid.
  for (let y = 1; y < 9; y++) { world.blocks.add(`4,${y},2`); world.blocks.add(`1,${y},3`); }
  nav.reset();
  assert.equal(nav.direction(start), null);
  for (let i = 0; i < 100; i++) nav.update({ x: 8.5, y: 5, z: 2.5 }, 0.016);
  assert.equal(nav.direction(start), null);
});
