/** Passive health regeneration using active game-time seconds. */
export const HEALTH_REGEN_RATE = 1;
export const HEALTH_REGEN_DELAY = 8;

export class HealthRegeneration {
  delayRemaining = 0;
  foodHealing = 0;
  readonly maxFoodHealing = 30;
  readonly foodRate = 2;

  reset(): void { this.delayRemaining = 0; this.foodHealing = 0; }

  damaged(): void { this.delayRemaining = HEALTH_REGEN_DELAY; }

  /** Queue a timed food heal only when it can be used and the bounded queue has room. */
  consumeFood(amount: number, hp: number, maxHp: number, dead = false): boolean {
    if (dead || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(hp) || !Number.isFinite(maxHp) || maxHp <= 0 || hp >= maxHp || this.foodHealing >= maxHp - hp || this.foodHealing + amount > this.maxFoodHealing) return false;
    this.foodHealing += amount;
    return true;
  }

  /** Return HP to restore; callers own health and game-state updates. */
  update(dt: number, hp: number, maxHp: number, dead = false, burning = false): number {
    if (!Number.isFinite(dt) || dt <= 0 || !Number.isFinite(hp) || !Number.isFinite(maxHp) || maxHp <= 0 || dead || burning || hp >= maxHp) return 0;
    const waiting = Math.min(this.delayRemaining, dt);
    this.delayRemaining -= waiting;
    const regenDt = dt - waiting;
    const missing = maxHp - hp;
    const passive = regenDt * HEALTH_REGEN_RATE;
    const food = Math.min(this.foodHealing, dt * this.foodRate);
    const applied = Math.min(missing, passive + food);
    const foodApplied = Math.min(food, Math.max(0, applied - passive));
    if (hp + applied >= maxHp) this.foodHealing = 0;
    else this.foodHealing = Math.max(0, this.foodHealing - foodApplied);
    return applied;
  }

  status(hp: number, maxHp: number, dead = false, burning = false): string {
    if (dead || hp >= maxHp) return '';
    if (burning) return 'Burning · healing paused';
    const passive = this.delayRemaining > 0 ? `Healing in ${Math.ceil(this.delayRemaining)}s` : 'Regenerating +1 HP/s';
    return this.foodHealing > 0 ? `${passive} · Food 2 HP/s (${Math.ceil(this.foodHealing)} HP left)` : passive;
  }
}
