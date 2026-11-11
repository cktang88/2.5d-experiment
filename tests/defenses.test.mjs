import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DEFENSES, getDefense, footprintSize, ballisticVelocity, ballisticClear, defenseSupport, threatensDefenseSupport } from '../src/defenses.ts';

test('catalog provides unique inventory keys and rotated rectangular footprints', () => {
  assert.equal(new Set(Object.values(DEFENSES).map(d => d.inventoryKey)).size, 5);
  assert.deepEqual(footprintSize('twin', 0), [4,3]);
  assert.deepEqual(footprintSize('twin', 1), [3,4]);
  assert.equal(getDefense('invalid').id, 'auto');
  assert.deepEqual(Object.values(DEFENSES).map(d => d.range), [18,32,38,64,90]);
  assert.deepEqual(Object.values(DEFENSES).map(d => d.minRange), [2,8,8,12,18]);
});

test('ballistic trajectory reaches distant elevated target and checks overhead clearance', () => {
  const from = new THREE.Vector3(10,10,10), to = new THREE.Vector3(100,14,10);
  const { velocity, time } = ballisticVelocity(from,to);
  const at = from.clone().addScaledVector(velocity,time); at.y -= 9*time*time;
  assert.ok(at.distanceTo(to) < 1e-9);
  const open = { inBounds: (x,y,z) => x>=0 && y>=0 && y<100 && z>=0, raycast: () => ({hit:false}) };
  assert.equal(ballisticClear(open,from,velocity,time),true);
  const roof = { ...open, raycast: (o,d,l) => ({ hit: o.y < 30 && o.y+d.y*l >= 30 }) };
  assert.equal(ballisticClear(roof,from,velocity,time),false);
  assert.equal(ballisticClear({...open, inBounds:(x,y,z) => y<30},from,velocity,time),false);
});

test('explosive impact clearance covers both the minimum range and rotated support footprint', () => {
  const pos = new THREE.Vector3(10, 20, 10);
  const support = defenseSupport(pos, 'rocket', 1);
  assert.equal(threatensDefenseSupport(new THREE.Vector3(19, 100, 10), support, 3.4), true);
  assert.equal(threatensDefenseSupport(new THREE.Vector3(22.1, 20, 10), support, 3.4), false);
  const closeRange = { ...support, minRange: 0 };
  assert.equal(threatensDefenseSupport(new THREE.Vector3(15.3, 0, 10), closeRange, 3.4), true);
  assert.equal(threatensDefenseSupport(new THREE.Vector3(10, 0, 15.3), closeRange, 3.4), false);
});
