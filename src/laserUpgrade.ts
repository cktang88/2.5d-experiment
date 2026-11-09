/** One-time workbench upgrades for the laser cutter. Keep this state JSON-safe for saves. */
export interface LaserUpgradeLevels {
  power: number;
  reach: number;
}

export type LaserUpgradeId = keyof LaserUpgradeLevels;
export type LaserUpgradeInventory = Record<string, number>;
export type LaserUpgradeFailure = 'workbench-required' | 'max-level' | 'insufficient-resources' | 'unknown-upgrade';

export interface LaserUpgradeRecipe {
  id: LaserUpgradeId;
  level: number;
  name: string;
  description: string;
  cost: Readonly<Record<string, number>>;
}

export const LASER_UPGRADE_RECIPES: Readonly<Record<LaserUpgradeId, readonly LaserUpgradeRecipe[]>> = {
  power: [
    { id: 'power', level: 1, name: 'Power Cell I', description: '+25% laser cutting speed', cost: { iron: 4, goo: 2 } },
    { id: 'power', level: 2, name: 'Power Cell II', description: '+25% laser cutting speed', cost: { iron: 8, goo: 4, stone: 3 } },
  ],
  reach: [
    { id: 'reach', level: 1, name: 'Focusing Lens I', description: '+4 m cutting range (12 m total)', cost: { copper: 4, stone: 4, goo: 1 } },
    { id: 'reach', level: 2, name: 'Focusing Lens II', description: '+4 m cutting range (16 m total)', cost: { copper: 8, stone: 8, goo: 3 } },
  ],
};

const MAX_LEVEL = 2;

export function defaultLaserUpgradeLevels(): LaserUpgradeLevels {
  return { power: 0, reach: 0 };
}

/** Accept absent/old/corrupt save fields and clamp each upgrade to its supported level. */
export function normalizeLaserUpgradeLevels(value?: Partial<LaserUpgradeLevels> | null): LaserUpgradeLevels {
  const level = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(MAX_LEVEL, Math.floor(v))) : 0;
  return { power: level(value?.power), reach: level(value?.reach) };
}

export interface LaserUpgradeStats {
  damageMultiplier: number;
  range: number;
}

/** Baseline is 8 m / 8 damage per second. Range and power each have a two-tier cap. */
export function laserUpgradeStats(value?: Partial<LaserUpgradeLevels> | null): LaserUpgradeStats {
  const levels = normalizeLaserUpgradeLevels(value);
  return {
    damageMultiplier: 1 + 0.25 * levels.power,
    range: Math.min(16, 8 + 4 * levels.reach),
  };
}

export function getNextLaserUpgradeRecipe(
  id: LaserUpgradeId,
  value?: Partial<LaserUpgradeLevels> | null,
): LaserUpgradeRecipe | null {
  const recipes = LASER_UPGRADE_RECIPES[id];
  if (!recipes) return null;
  const level = normalizeLaserUpgradeLevels(value)[id];
  return recipes[level] ?? null;
}

/**
 * Purchase the next tier. Inventory and level mutate only after all checks pass,
 * so failed clicks cannot partially charge and max-level clicks can never be free.
 */
export function purchaseLaserUpgrade(
  levels: LaserUpgradeLevels,
  id: LaserUpgradeId,
  inventory: LaserUpgradeInventory,
  atWorkbench: boolean,
): { ok: true; recipe: LaserUpgradeRecipe } | { ok: false; reason: LaserUpgradeFailure } {
  if (!(id in LASER_UPGRADE_RECIPES)) return { ok: false, reason: 'unknown-upgrade' };
  if (!atWorkbench) return { ok: false, reason: 'workbench-required' };
  const recipe = getNextLaserUpgradeRecipe(id, levels);
  if (!recipe) return { ok: false, reason: 'max-level' };
  for (const [resource, amount] of Object.entries(recipe.cost)) {
    if (!(amount > 0) || !Number.isFinite(amount) || !Number.isFinite(inventory[resource]) || inventory[resource] < amount) {
      return { ok: false, reason: 'insufficient-resources' };
    }
  }
  for (const [resource, amount] of Object.entries(recipe.cost)) inventory[resource] -= amount;
  levels[id] = recipe.level;
  return { ok: true, recipe };
}
