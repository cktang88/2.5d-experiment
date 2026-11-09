/** Fuel-free builder flight: keyboard toggle handling and bounded, acceleration-smoothed velocity. */
export interface FlightVelocity { x: number; y: number; z: number }
export interface FlightControls {
  forward?: boolean;
  backward?: boolean;
  left?: boolean;
  right?: boolean;
  ascend?: boolean;
  descend?: boolean;
}
export interface JetpackKeyResult { handled: boolean; toggled: boolean; jump: boolean }

export const JETPACK_MAX_HORIZONTAL_SPEED = 9;
export const JETPACK_MAX_VERTICAL_SPEED = 7;
/** Maximum distance from the player's feet to the nearest supporting block below. */
export const JETPACK_MAX_ALTITUDE = 30;

/** Limit ascent to the available distance; return smoothly when the ground drops away. */
export function limitFlightAltitude(velocity: FlightVelocity, feetY: number, groundY: number, dt: number): void {
  if (!Number.isFinite(dt) || dt <= 0) return;
  const remaining = groundY + JETPACK_MAX_ALTITUDE - feetY;
  if (remaining < 0) {
    velocity.y = approach(velocity.y, -JETPACK_MAX_VERTICAL_SPEED, VERTICAL_ACCELERATION * dt);
    velocity.y = Math.min(0, velocity.y);
  } else if (velocity.y > 0) {
    velocity.y = Math.min(velocity.y, remaining / dt);
  }
}
const HORIZONTAL_ACCELERATION = 18;
const VERTICAL_ACCELERATION = 24;
const DOUBLE_TAP_MS = 300;

/**
 * Space still jumps on a single grounded press and ascends with flight enabled. A second
 * press within 300 ms toggles flight either way; Z toggles it directly. Flight begins off so
 * ordinary walking/jumping remains familiar.
 */
export class JetpackFlight {
  active = false;
  private lastGroundSpacePress = -Infinity;

  handleKeyDown(code: string, nowMs: number, repeat = false): JetpackKeyResult {
    if (repeat) return { handled: false, toggled: false, jump: false };
    if (code === 'KeyZ') {
      this.active = !this.active;
      this.resetTap();
      return { handled: true, toggled: true, jump: false };
    }
    if (code !== 'Space') return { handled: false, toggled: false, jump: false };
    const doubled = Number.isFinite(nowMs) && nowMs >= this.lastGroundSpacePress && nowMs - this.lastGroundSpacePress <= DOUBLE_TAP_MS;
    if (doubled) {
      this.active = !this.active;
      this.lastGroundSpacePress = -Infinity;
      return { handled: true, toggled: true, jump: false };
    }
    this.lastGroundSpacePress = Number.isFinite(nowMs) ? nowMs : -Infinity;
    return { handled: false, toggled: false, jump: !this.active };
  }

  /** Call when input focus leaves gameplay (pause/menu/death) so taps cannot bridge states. */
  resetTap(): void { this.lastGroundSpacePress = -Infinity; }

  /** Drop the pending double-tap after grounded input stops; call with monotonic milliseconds. */
  expireTap(nowMs: number): void {
    if (Number.isFinite(nowMs) && nowMs - this.lastGroundSpacePress > DOUBLE_TAP_MS) this.lastGroundSpacePress = -Infinity;
  }

  /** Mutate horizontal/vertical velocity while flight is active; collision remains caller-owned. */
  updateVelocity(velocity: FlightVelocity, controls: FlightControls, yaw: number, dt: number, returningToLimit = false): FlightVelocity {
    if (!this.active || !Number.isFinite(dt) || dt <= 0) return velocity;
    const speed = Math.hypot(velocity.x, velocity.z);
    if (speed > JETPACK_MAX_HORIZONTAL_SPEED) {
      const scale = JETPACK_MAX_HORIZONTAL_SPEED / speed;
      velocity.x *= scale; velocity.z *= scale;
    }
    velocity.y = Math.max(-JETPACK_MAX_VERTICAL_SPEED, Math.min(JETPACK_MAX_VERTICAL_SPEED, velocity.y));
    let mx = 0, mz = 0;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    if (controls.forward) { mx += fx; mz += fz; }
    if (controls.backward) { mx -= fx; mz -= fz; }
    if (controls.right) { mx += rx; mz += rz; }
    if (controls.left) { mx -= rx; mz -= rz; }
    const length = Math.hypot(mx, mz);
    if (length > 0) { mx /= length; mz /= length; }
    const targetX = mx * JETPACK_MAX_HORIZONTAL_SPEED;
    const targetZ = mz * JETPACK_MAX_HORIZONTAL_SPEED;
    velocity.x = approach(velocity.x, targetX, HORIZONTAL_ACCELERATION * dt);
    velocity.z = approach(velocity.z, targetZ, HORIZONTAL_ACCELERATION * dt);
    const vertical = (controls.ascend ? 1 : 0) - (controls.descend ? 1 : 0);
    const targetY = (returningToLimit ? -1 : vertical) * JETPACK_MAX_VERTICAL_SPEED;
    velocity.y = approach(velocity.y, targetY, VERTICAL_ACCELERATION * dt);
    return velocity;
  }
}

function approach(current: number, target: number, amount: number): number {
  if (current < target) return Math.min(target, current + amount);
  return Math.max(target, current - amount);
}
