/** Combat pacing, independent of the visual day/night clock. Advance only with active gameplay dt. */
export type WavePhase = 'safe' | 'wave' | 'rest';

export interface WaveDirectorState {
  phase: WavePhase;
  wave: number;
  remaining: number;
  /** Fractional reward increase for the active or most recently cleared wave. */
  rewardBonus: number;
}

export type WaveEvent =
  | { type: 'waveStarted'; wave: number; count: number; rewardBonus: number }
  | { type: 'waveCleared'; wave: number; rewardBonus: number };

export interface LegacyWaveState {
  nightCount?: number;
  wasNight?: boolean;
  livingEnemies?: number;
}

const SAFE_SECONDS = 120;
const REST_SECONDS = 120;
const MAX_WAVE_SIZE = 45;
const TIMER_EPSILON = 1e-6;

/**
 * A quiet 120 second opening, finite enemy waves, and a quiet 120 second interval
 * after the final living enemy is gone. This class has no wall-clock dependency;
 * callers freeze it by passing dt=0 while paused, on the title screen, or in a modal.
 */
export class WaveDirector {
  phase: WavePhase = 'safe';
  wave = 0;
  remaining = SAFE_SECONDS;
  rewardBonus = 0;

  static waveSize(wave: number): number {
    return Math.min(MAX_WAVE_SIZE, 6 + Math.max(1, Math.floor(wave)) * 4);
  }

  update(dt: number, livingEnemies: number): WaveEvent[] {
    if (!Number.isFinite(dt) || dt <= 0) return [];
    const alive = Math.max(0, Number.isFinite(livingEnemies) ? livingEnemies : 0);

    if (this.phase === 'wave') {
      if (alive === 0) {
        const clearedWave = this.wave;
        this.phase = 'rest';
        this.remaining = REST_SECONDS;
        return [{ type: 'waveCleared', wave: clearedWave, rewardBonus: this.rewardBonus }];
      }
      return [];
    }

    // The rest phase is only combat-free while no enemies remain. This also makes
    // legacy saves with surviving enemies safe to restore without overlapping waves.
    if (this.phase === 'rest' && alive > 0) return [];

    this.remaining = Math.max(0, this.remaining - dt);
    if (this.remaining > TIMER_EPSILON) return [];
    this.remaining = 0;

    if (this.phase === 'safe' || this.phase === 'rest') {
      return this.beginWave(0);
    }
    return [];
  }

  /** Start the next wave early and trade remaining peace for up to 50% more rewards. */
  startEarly(): WaveEvent[] {
    if (this.phase !== 'safe' && this.phase !== 'rest') return [];
    const bonus = Math.max(0, Math.min(0.5, 0.5 * this.remaining / SAFE_SECONDS));
    return this.beginWave(bonus);
  }

  private beginWave(rewardBonus: number): WaveEvent[] {
    this.phase = 'wave';
    this.wave++;
    this.remaining = 0;
    this.rewardBonus = rewardBonus;
    return [{ type: 'waveStarted', wave: this.wave, count: WaveDirector.waveSize(this.wave), rewardBonus }];
  }

  snapshot(): WaveDirectorState {
    return { phase: this.phase, wave: this.wave, remaining: this.remaining, rewardBonus: this.rewardBonus };
  }

  /** Restore current saves, or infer a sensible phase from pre-wave-system saves. */
  restore(state?: Partial<WaveDirectorState> | null, legacy?: LegacyWaveState): void {
    if (state && (state.phase === 'safe' || state.phase === 'wave' || state.phase === 'rest')
      && Number.isFinite(state.wave) && Number.isFinite(state.remaining)) {
      this.phase = state.phase;
      this.wave = Math.max(0, Math.floor(state.wave!));
      this.remaining = Math.max(0, Math.min(SAFE_SECONDS, state.remaining!));
      this.rewardBonus = Math.max(0, Math.min(0.5, Number.isFinite(state.rewardBonus) ? state.rewardBonus! : 0));
      if (this.phase === 'safe' && this.wave !== 0) this.wave = 0;
      if (this.phase === 'wave') this.remaining = 0;
      return;
    }

    // Legacy games used day/night and could have a live horde at save time. Resume
    // that horde as an active wave so the new director never adds a second wave on it.
    const nightCount = Math.max(0, Math.floor(Number(legacy?.nightCount) || 0));
    const wasNight = !!legacy?.wasNight;
    const hasLegacyEnemies = Number(legacy?.livingEnemies) > 0;
    if (wasNight || nightCount > 0 || hasLegacyEnemies) {
      this.phase = 'wave';
      this.wave = Math.max(1, nightCount);
      this.remaining = 0;
      this.rewardBonus = 0;
    } else {
      this.phase = 'safe';
      this.wave = 0;
      this.remaining = SAFE_SECONDS;
      this.rewardBonus = 0;
    }
  }
}
