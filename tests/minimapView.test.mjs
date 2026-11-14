import test from 'node:test';
import assert from 'node:assert/strict';
import { minimapView, easeView, rimMarker, BASE_VIEW, MAX_VIEW, FIT_COUNT } from '../src/minimapView.ts';

const c = { x: 1000, z: 1000 };
const at = (dx, dz) => ({ x: c.x + dx, z: c.z + dz });

test('normal play shows the close-in default view', () => {
  assert.equal(minimapView(c, []), BASE_VIEW);
  const many = Array.from({ length: FIT_COUNT + 1 }, (_, i) => at(200, i));
  assert.equal(minimapView(c, many), BASE_VIEW, 'a big wave does not zoom the map out');
});

test('the last few enemies are fitted onto the map, within limits', () => {
  assert.equal(minimapView(c, [at(10, 0)]), BASE_VIEW, 'already visible: no zoom');
  const v = minimapView(c, [at(80, 0), at(0, -30)]);
  assert.ok(v / 2 >= 80 && v <= MAX_VIEW, `farthest enemy inside the circle (view ${v})`);
  assert.equal(minimapView(c, [at(900, 900)]), MAX_VIEW, 'very far: capped (rim arrows take over)');
});

test('easing converges and widens faster than it narrows', () => {
  let v = BASE_VIEW, n = 0;
  while (v !== MAX_VIEW && n < 50) { v = easeView(v, MAX_VIEW); n++; }
  let w = MAX_VIEW, m = 0;
  while (w !== BASE_VIEW && m < 80) { w = easeView(w, BASE_VIEW); m++; }
  assert.equal(v, MAX_VIEW); assert.equal(w, BASE_VIEW);
  assert.ok(n < m, `out in ${n} ticks, back in ${m}`);
});

test('rim arrows only for enemies off the map, placed on the rim pointing at them', () => {
  assert.equal(rimMarker(c, at(40, 0), 96), null);
  const m = rimMarker(c, at(0, 300), 96, 4);
  assert.ok(Math.abs(Math.hypot(m.x - c.x, m.z - c.z) - 44) < 1e-9, 'inset from the rim');
  assert.ok(Math.abs(m.angle - Math.PI / 2) < 1e-9, 'points toward +z');
});
