import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WaveDirector } from '../src/waveDirector.ts';

test('new game stays peaceful for exactly 120 active seconds', () => {
  const waves = new WaveDirector();
  assert.deepEqual(waves.update(119.99, 0), []);
  assert.equal(waves.phase, 'safe');
  assert.ok(Math.abs(waves.remaining - 0.01) < 1e-9);
  const events = waves.update(0.01, 0);
  assert.deepEqual(events, [{ type: 'waveStarted', wave: 1, count: 10, rewardBonus: 0 }]);
  assert.equal(waves.phase, 'wave');
  assert.equal(waves.wave, 1);
});

test('pause, title, and build menus freeze the timer when caller passes zero dt', () => {
  const waves = new WaveDirector();
  assert.deepEqual(waves.update(0, 0), []);
  assert.deepEqual(waves.update(0, 1), []);
  assert.equal(waves.remaining, 120);
  waves.update(12, 0);
  const before = waves.snapshot();
  assert.deepEqual(waves.update(0, 0), []);
  assert.deepEqual(waves.snapshot(), before);
});

test('an active finite wave does not clear until all living enemies are gone', () => {
  const waves = new WaveDirector();
  waves.update(120, 0);
  assert.deepEqual(waves.update(30, 3), []);
  assert.equal(waves.phase, 'wave');
  assert.deepEqual(waves.update(500, 1), []);
  assert.deepEqual(waves.update(0.016, 0), [{ type: 'waveCleared', wave: 1, rewardBonus: 0 }]);
  assert.equal(waves.phase, 'rest');
  assert.equal(waves.remaining, 120);
});

test('the next wave begins 120 seconds after the previous wave is cleared', () => {
  const waves = new WaveDirector();
  waves.update(120, 0); // wave 1 starts
  waves.update(0.1, 0); // wave 1 clears
  assert.deepEqual(waves.update(119.99, 0), []);
  assert.equal(waves.phase, 'rest');
  assert.deepEqual(waves.update(0.01, 0), [{ type: 'waveStarted', wave: 2, count: 14, rewardBonus: 0 }]);
});

test('save and restore preserve phase, countdown, and wave number', () => {
  const original = new WaveDirector();
  original.update(120, 0);
  original.update(20, 2);
  const restored = new WaveDirector();
  restored.restore(original.snapshot());
  assert.deepEqual(restored.snapshot(), original.snapshot());
  assert.deepEqual(restored.update(1, 2), []);
  assert.deepEqual(restored.update(0, 0), []);
});

test('legacy night saves resume as an active wave instead of stacking a new wave', () => {
  const waves = new WaveDirector();
  waves.restore(undefined, { nightCount: 2, wasNight: true });
  assert.deepEqual(waves.snapshot(), { phase: 'wave', wave: 2, remaining: 0, rewardBonus: 0 });
  assert.deepEqual(waves.update(1000, 1), []);
  assert.deepEqual(waves.update(0.1, 0), [{ type: 'waveCleared', wave: 2, rewardBonus: 0 }]);
});

test('old day-one saves with no wave history retain a quiet opening', () => {
  const waves = new WaveDirector();
  waves.restore(undefined, { nightCount: 0, wasNight: false });
  assert.deepEqual(waves.snapshot(), { phase: 'safe', wave: 0, remaining: 120, rewardBonus: 0 });
});

test('legacy daytime saves with living ambient enemies adopt them as the current wave', () => {
  const waves = new WaveDirector();
  waves.restore(undefined, { nightCount: 0, wasNight: false, livingEnemies: 2 });
  assert.deepEqual(waves.snapshot(), { phase: 'wave', wave: 1, remaining: 0, rewardBonus: 0 });
  assert.deepEqual(waves.update(10, 2), []);
});

test('early start reward scales with peace skipped, capped at fifty percent', () => {
  const waves = new WaveDirector();
  waves.update(60, 0);
  assert.deepEqual(waves.startEarly(), [{ type: 'waveStarted', wave: 1, count: 10, rewardBonus: 0.25 }]);
  assert.equal(waves.phase, 'wave');
  assert.equal(waves.remaining, 0);
  assert.equal(waves.rewardBonus, 0.25);
  assert.deepEqual(waves.startEarly(), []);
});

test('starting immediately earns at most fifty percent and works during rest', () => {
  const waves = new WaveDirector();
  assert.deepEqual(waves.startEarly(), [{ type: 'waveStarted', wave: 1, count: 10, rewardBonus: 0.5 }]);
  assert.deepEqual(waves.update(1, 0), [{ type: 'waveCleared', wave: 1, rewardBonus: 0.5 }]);
  waves.update(30, 0);
  assert.deepEqual(waves.startEarly(), [{ type: 'waveStarted', wave: 2, count: 14, rewardBonus: 0.375 }]);
  assert.deepEqual(waves.startEarly(), []);
});

test('natural safe and rest starts do not award an early-start bonus', () => {
  const waves = new WaveDirector();
  assert.deepEqual(waves.update(120, 0), [{ type: 'waveStarted', wave: 1, count: 10, rewardBonus: 0 }]);
  waves.update(1, 0);
  assert.deepEqual(waves.update(120, 0), [{ type: 'waveStarted', wave: 2, count: 14, rewardBonus: 0 }]);
  assert.equal(waves.rewardBonus, 0);
});

test('wave clear reports its early bonus once, then rest does not replay the reward', () => {
  const waves = new WaveDirector();
  waves.update(40, 0);
  waves.startEarly();
  assert.deepEqual(waves.update(99, 1), []);
  assert.deepEqual(waves.update(0.01, 0), [{ type: 'waveCleared', wave: 1, rewardBonus: 1 / 3 }]);
  assert.deepEqual(waves.update(1, 0), []);
});

test('save and restore retain an active wave bonus until that wave clears', () => {
  const active = new WaveDirector();
  active.update(60, 0);
  active.startEarly();
  const resumed = new WaveDirector();
  resumed.restore(active.snapshot());
  assert.deepEqual(resumed.update(10, 2), []);
  assert.deepEqual(resumed.update(0.01, 0), [{ type: 'waveCleared', wave: 1, rewardBonus: 0.25 }]);
});

test('restored rest carries metadata but never re-emits the already-earned reward', () => {
  const original = new WaveDirector();
  original.startEarly();
  original.update(1, 0);
  const restored = new WaveDirector();
  restored.restore(original.snapshot());
  assert.equal(restored.phase, 'rest');
  assert.equal(restored.rewardBonus, 0.5);
  assert.deepEqual(restored.update(1, 0), []);
});
