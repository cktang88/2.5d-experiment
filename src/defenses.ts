import * as THREE from 'three';

export type DefenseId = 'auto' | 'cannon' | 'twin' | 'rocket' | 'artillery';
export interface DefenseSpec {
  id: DefenseId; name: string; inventoryKey: string; footprint: readonly [number, number];
  height: number; hp: number; ammo: number; reload: number; range: number; minRange: number;
  damage: number; projectileSpeed: number;
}
// The fixed collision height covers the pedestal and neutral weapon body. Barrels
// can extend outside this box as they aim; they do not change its collision shape.
export const DEFENSE_BASE_HEIGHT = 1.2;
export const DEFENSES: Record<DefenseId, DefenseSpec> = {
  auto: { id:'auto', name:'Auto turret', inventoryKey:'turret', footprint:[2,2], height:1.8, hp:160, ammo:250, reload:.8, range:18, minRange:2, damage:45, projectileSpeed:70 },
  cannon: { id:'cannon', name:'Heavy cannon', inventoryKey:'cannonTurret', footprint:[3,3], height:2.1, hp:300, ammo:100, reload:3.5, range:32, minRange:8, damage:180, projectileSpeed:60 },
  twin: { id:'twin', name:'Twin cannon', inventoryKey:'twinTurret', footprint:[4,3], height:2.1, hp:360, ammo:160, reload:2.8, range:38, minRange:8, damage:110, projectileSpeed:65 },
  rocket: { id:'rocket', name:'Rocket battery', inventoryKey:'rocketTurret', footprint:[3,4], height:2.7, hp:280, ammo:60, reload:6, range:64, minRange:12, damage:100, projectileSpeed:32 },
  artillery: { id:'artillery', name:'Artillery', inventoryKey:'artilleryTurret', footprint:[4,4], height:2.65, hp:420, ammo:45, reload:7, range:90, minRange:18, damage:350, projectileSpeed:35 },
};
export function getDefense(id: string | undefined): DefenseSpec { return DEFENSES[id as DefenseId] ?? DEFENSES.auto; }
export function footprintSize(id: string | undefined, rotation = 0): readonly [number, number] {
  const [w,d] = getDefense(id).footprint;
  return Math.abs(Math.round(rotation)) % 2 ? [d,w] : [w,d];
}
// Choose a high, predictable arc and use the same constant-gravity equation for movement.
export function ballisticVelocity(from: THREE.Vector3, to: THREE.Vector3, gravity = 18): { velocity: THREE.Vector3; time: number } {
  const delta = to.clone().sub(from), distance = Math.hypot(delta.x, delta.z);
  const time = Math.max(1, distance / 25);
  return { velocity: new THREE.Vector3(delta.x / time, (delta.y + .5 * gravity * time * time) / time, delta.z / time), time };
}
export function ballisticClear(world: { inBounds(x:number,y:number,z:number): boolean; raycast(o:THREE.Vector3,d:THREE.Vector3,l:number): {hit:boolean} }, from: THREE.Vector3, velocity: THREE.Vector3, time: number, gravity = 18): boolean {
  let previous = from.clone();
  const steps = Math.max(1, Math.ceil(time / .05));
  for (let i = 1; i <= steps; i++) {
    const t = time * i / steps;
    const next = from.clone().addScaledVector(velocity,t); next.y -= .5 * gravity * t * t;
    if (!world.inBounds(next.x,next.y,next.z)) return false;
    const direction = next.clone().sub(previous), length = direction.length();
    if (length && world.raycast(previous, direction.divideScalar(length), length).hit) return false;
    previous = next;
  }
  return true;
}

// The nominal horizontal minimum and clearance around the rotated base protect
// nearby terrain and supporting cells even
// when an impact is above or below the turret. The extra margin covers the
// small backwards offset used for voxel impacts.
export interface DefenseSupport { x: number; z: number; width: number; depth: number; minRange: number }
export function defenseSupport(pos: THREE.Vector3, id: string, rotation: number): DefenseSupport {
  const [width, depth] = footprintSize(id, rotation);
  return { x: pos.x, z: pos.z, width, depth, minRange: getDefense(id).minRange };
}
export function threatensDefenseSupport(at: THREE.Vector3, support: DefenseSupport, radius: number): boolean {
  const dx = Math.max(0, Math.abs(at.x - support.x) - support.width / 2);
  const dz = Math.max(0, Math.abs(at.z - support.z) - support.depth / 2);
  return Math.hypot(at.x - support.x, at.z - support.z) < support.minRange || Math.hypot(dx, dz) <= radius + .1;
}
export function horizontalDistanceSquared(a: THREE.Vector3, b: THREE.Vector3): number {
  return (a.x-b.x)**2 + (a.z-b.z)**2;
}
