import test from 'node:test';
import assert from 'node:assert/strict';
import { HealthRegeneration } from '../src/healthRegen.ts';

test('accepted damage starts an eight-second calm delay, then heals one HP per active second', () => {
  const regen = new HealthRegeneration();
  regen.damaged();
  assert.equal(regen.update(7.5, 50, 100), 0);
  assert.equal(regen.delayRemaining, 0.5);
  assert.equal(regen.update(0.5, 50, 100), 0);
  assert.equal(regen.status(50, 100), 'Regenerating +1 HP/s');
  assert.equal(regen.update(1, 50, 100), 1);
});

test('healing caps at max HP and full health has no indicator', () => {
  const regen = new HealthRegeneration();
  assert.equal(regen.update(2, 99.5, 100), 0.5);
  assert.equal(regen.status(100, 100), '');
  assert.equal(regen.update(4, 100, 100), 0);
});

test('paused, dead, and burning states neither heal nor consume the calm delay', () => {
  const regen = new HealthRegeneration();
  regen.damaged();
  for (const state of [{ dt: 3, dead: true }, { dt: 3, burning: true }, { dt: 0 }, { dt: -1 }]) {
    assert.equal(regen.update(state.dt, 50, 100, state.dead, state.burning), 0);
  }
  assert.equal(regen.status(50, 100, false, true), 'Burning · healing paused');
  assert.equal(regen.status(50, 100, true), '');
  assert.equal(regen.delayRemaining, 8);
  assert.equal(regen.update(5, 50, 100), 0);
  assert.equal(regen.delayRemaining, 3);
  assert.equal(regen.update(3.5, 50, 100), 0.5);
});

test('a later accepted hit restarts delay; reset clears it for respawn', () => {
  const regen = new HealthRegeneration();
  regen.damaged();
  regen.update(5, 50, 100);
  regen.damaged();
  assert.equal(regen.delayRemaining, 8);
  regen.reset();
  assert.equal(regen.delayRemaining, 0);
  assert.equal(regen.foodHealing, 0);
});

test('food queues bounded healing over time without depending on the passive calm delay', () => {
  const regen = new HealthRegeneration();
  regen.damaged();
  assert.equal(regen.consumeFood(10, 50, 100), true);
  assert.equal(regen.update(2, 50, 100), 4);
  assert.equal(regen.foodHealing, 6);
  assert.equal(regen.delayRemaining, 6);
  assert.equal(regen.consumeFood(30, 54, 100), false);
  assert.equal(regen.consumeFood(1, 100, 100), false);
  assert.equal(regen.consumeFood(1, 54, 100, true), false);
  regen.reset();
  assert.equal(regen.foodHealing, 0);
});

test('burning pauses food healing; reaching max HP clears unused queued healing', () => {
  const regen = new HealthRegeneration();
  regen.consumeFood(10, 99, 100);
  assert.equal(regen.update(1, 99, 100, false, true), 0);
  assert.equal(regen.foodHealing, 10);
  assert.equal(regen.update(1, 99, 100), 1);
  assert.equal(regen.foodHealing, 0);
  assert.equal(regen.status(100, 100), '');
});

test('queued food covering missing health cannot be consumed again', () => {
  const regen = new HealthRegeneration();
  assert.equal(regen.consumeFood(10, 95, 100), true);
  assert.equal(regen.consumeFood(6, 95, 100), false);
  assert.equal(regen.foodHealing, 10);
});
