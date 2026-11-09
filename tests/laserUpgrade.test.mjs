import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LASER_UPGRADE_RECIPES,
  defaultLaserUpgradeLevels,
  getNextLaserUpgradeRecipe,
  laserUpgradeStats,
  normalizeLaserUpgradeLevels,
  purchaseLaserUpgrade,
} from '../src/laserUpgrade.ts';

const richInventory = () => ({ iron: 40, copper: 40, stone: 40, goo: 20 });

test('old and malformed save fields normalize to zero and supported level caps', () => {
  assert.deepEqual(defaultLaserUpgradeLevels(), { power: 0, reach: 0 });
  assert.deepEqual(normalizeLaserUpgradeLevels(undefined), { power: 0, reach: 0 });
  assert.deepEqual(normalizeLaserUpgradeLevels({ power: 4, reach: -3 }), { power: 2, reach: 0 });
  assert.deepEqual(normalizeLaserUpgradeLevels({ power: Number.NaN, reach: 1.9 }), { power: 0, reach: 1 });
  assert.deepEqual(laserUpgradeStats(), { damageMultiplier: 1, range: 8 });
});

test('each power tier raises cutting speed and range has an explicit 16 m cap', () => {
  assert.equal(laserUpgradeStats({ power: 1 }).damageMultiplier, 1.25);
  assert.equal(laserUpgradeStats({ power: 2 }).damageMultiplier, 1.5);
  assert.equal(laserUpgradeStats({ reach: 1 }).range, 12);
  assert.equal(laserUpgradeStats({ reach: 2 }).range, 16);
  assert.equal(laserUpgradeStats({ reach: 99 }).range, 16);
  assert.deepEqual(getNextLaserUpgradeRecipe('power')?.cost, { iron: 4, goo: 2 });
  assert.deepEqual(getNextLaserUpgradeRecipe('power', { power: 1 })?.cost, { iron: 8, goo: 4, stone: 3 });
  assert.ok(Object.values(LASER_UPGRADE_RECIPES).flat().every(r => Object.values(r.cost).every(c => Number.isFinite(c) && c > 0)));
});

test('upgrades require a workbench and insufficient purchases leave inventory and levels untouched', () => {
  const levels = defaultLaserUpgradeLevels();
  const inventory = { iron: 3, goo: 0 };
  const before = { ...inventory };
  assert.deepEqual(purchaseLaserUpgrade(levels, 'power', inventory, false), { ok: false, reason: 'workbench-required' });
  assert.deepEqual(purchaseLaserUpgrade(levels, 'power', inventory, true), { ok: false, reason: 'insufficient-resources' });
  assert.deepEqual(inventory, before);
  assert.deepEqual(levels, { power: 0, reach: 0 });
});

test('tiered purchases charge exact costs and max-level attempts never become free', () => {
  const levels = defaultLaserUpgradeLevels();
  const inventory = richInventory();
  const first = purchaseLaserUpgrade(levels, 'reach', inventory, true);
  assert.equal(first.ok, true);
  assert.deepEqual(levels, { power: 0, reach: 1 });
  assert.deepEqual(inventory, { iron: 40, copper: 36, stone: 36, goo: 19 });
  const second = purchaseLaserUpgrade(levels, 'reach', inventory, true);
  assert.equal(second.ok, true);
  assert.deepEqual(levels, { power: 0, reach: 2 });
  assert.deepEqual(inventory, { iron: 40, copper: 28, stone: 28, goo: 16 });
  const afterMax = { ...inventory };
  assert.deepEqual(purchaseLaserUpgrade(levels, 'reach', inventory, true), { ok: false, reason: 'max-level' });
  assert.deepEqual(inventory, afterMax);
});
