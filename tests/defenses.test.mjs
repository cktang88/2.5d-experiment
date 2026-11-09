import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DEFENSES, getDefense, footprintSize, ballisticVelocity, ballisticClear } from '../src/defenses.ts';

test('catalog provides unique inventory keys and rotated rectangular footprints', () => {
  assert.equal(new Set(Object.values(DEFENSES).map(d => d.inventoryKey)).size, 5);
  assert.deepEqual(footprintSize('twin', 0), [3,2]);
  assert.deepEqual(footprintSize('twin', 1), [2,3]);
  assert.equal(getDefense('invalid').id, 'auto');
  assert.deepEqual(Object.values(DEFENSES).map(d => d.range), [18,32,38,64,90]);
  assert.equal(DEFENSES.artillery.minRange, 12);
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
