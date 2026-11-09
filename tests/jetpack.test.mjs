import test from 'node:test';
import assert from 'node:assert/strict';
import { JetpackFlight, JETPACK_MAX_HORIZONTAL_SPEED, JETPACK_MAX_VERTICAL_SPEED } from '../src/jetpack.ts';

test('Z toggles flight directly, while a single Space press remains a jump', () => {
  const flight = new JetpackFlight();
  assert.equal(flight.active, false);
  assert.deepEqual(flight.handleKeyDown('Space', 1000), { handled: false, toggled: false, jump: true });
  assert.equal(flight.active, false);
  assert.deepEqual(flight.handleKeyDown('KeyZ', 1100), { handled: true, toggled: true, jump: false });
  assert.equal(flight.active, true);
  assert.equal(flight.handleKeyDown('KeyZ', 1200).toggled, true);
  assert.equal(flight.active, false);
});

test('double-tap Space toggles flight both ways; active single Space is ascent input', () => {
  const flight = new JetpackFlight();
  assert.equal(flight.handleKeyDown('Space', 100).jump, true);
  assert.deepEqual(flight.handleKeyDown('Space', 400), { handled: true, toggled: true, jump: false });
  assert.equal(flight.active, true);
  assert.deepEqual(flight.handleKeyDown('Space', 500), { handled: false, toggled: false, jump: false });
  assert.deepEqual(flight.handleKeyDown('Space', 800), { handled: true, toggled: true, jump: false });
  assert.equal(flight.active, false);

  const late = new JetpackFlight();
  late.handleKeyDown('Space', 100);
  assert.equal(late.handleKeyDown('Space', 401).jump, true);
  assert.equal(late.active, false);
});

test('repeated keydowns cannot toggle; menu reset clears pending double-tap', () => {
  const flight = new JetpackFlight();
  assert.equal(flight.handleKeyDown('Space', 100).jump, true);
  assert.deepEqual(flight.handleKeyDown('Space', 400, true), { handled: false, toggled: false, jump: false });
  assert.equal(flight.active, false);
  flight.resetTap();
  assert.equal(flight.handleKeyDown('Space', 410).jump, true);
  assert.equal(flight.active, false);
  flight.handleKeyDown('KeyZ', 500);
  flight.handleKeyDown('Space', 600);
  assert.deepEqual(flight.handleKeyDown('Space', 900, true), { handled: false, toggled: false, jump: false });
  assert.equal(flight.active, true);
});

test('WASD flight accelerates smoothly, normalizes diagonals, and stays bounded', () => {
  const flight = new JetpackFlight();
  flight.handleKeyDown('KeyZ', 0);
  const velocity = { x: 0, y: 0, z: 0 };
  flight.updateVelocity(velocity, { forward: true, right: true }, 0, 1 / 60);
  assert.ok(velocity.x > 0 && velocity.z < 0);
  assert.ok(Math.hypot(velocity.x, velocity.z) <= HORIZONTAL_ACCELERATION_BOUND());
  for (let i = 0; i < 240; i++) flight.updateVelocity(velocity, { forward: true, right: true }, 0, 1 / 60);
  assert.ok(Math.abs(Math.hypot(velocity.x, velocity.z) - JETPACK_MAX_HORIZONTAL_SPEED) < 1e-9);
});

test('Space and Ctrl smoothly control climb/descent; no input holds a stable hover', () => {
  const flight = new JetpackFlight();
  flight.handleKeyDown('KeyZ', 0);
  const velocity = { x: 0, y: 0, z: 0 };
  flight.updateVelocity(velocity, { ascend: true }, 0, 1);
  assert.equal(velocity.y, JETPACK_MAX_VERTICAL_SPEED);
  flight.updateVelocity(velocity, {}, 0, 0.1);
  assert.ok(velocity.y > 0 && velocity.y < JETPACK_MAX_VERTICAL_SPEED);
  for (let i = 0; i < 30; i++) flight.updateVelocity(velocity, {}, 0, 1 / 60);
  assert.equal(velocity.y, 0);
  flight.updateVelocity(velocity, { descend: true }, 0, 1);
  assert.equal(velocity.y, -JETPACK_MAX_VERTICAL_SPEED);
  flight.updateVelocity(velocity, { ascend: true, descend: true }, 0, 1);
  assert.equal(velocity.y, 0);
});

test('inactive flight and zero or invalid dt leave velocity untouched', () => {
  const flight = new JetpackFlight();
  const velocity = { x: 1, y: 2, z: 3 };
  flight.updateVelocity(velocity, { forward: true, ascend: true }, 1, 1);
  assert.deepEqual(velocity, { x: 1, y: 2, z: 3 });
  flight.handleKeyDown('KeyZ', 0);
  flight.updateVelocity(velocity, { forward: true }, 1, 0);
  assert.deepEqual(velocity, { x: 1, y: 2, z: 3 });
  flight.updateVelocity(velocity, { ascend: true }, 1, NaN);
  assert.deepEqual(velocity, { x: 1, y: 2, z: 3 });
});

test('entering flight clamps inherited fall and dash velocity immediately', () => {
  const flight = new JetpackFlight();
  flight.handleKeyDown('KeyZ', 0);
  const velocity = { x: 30, y: -40, z: 40 };
  flight.updateVelocity(velocity, {}, 0, 1 / 60);
  assert.ok(Math.hypot(velocity.x, velocity.z) <= JETPACK_MAX_HORIZONTAL_SPEED);
  assert.ok(Math.abs(velocity.y) <= JETPACK_MAX_VERTICAL_SPEED);
});

function HORIZONTAL_ACCELERATION_BOUND() { return JETPACK_MAX_HORIZONTAL_SPEED; }
