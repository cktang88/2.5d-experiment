import * as THREE from 'three';
import { DEFENSE_BASE_HEIGHT, type DefenseId, type DefenseSpec } from '../defenses';
import { MODULE_BY_ID } from './autobattler/vendor/parts';
import { buildTurret } from './autobattler/vendor/weapons3d';

export interface DefenseModel {
  root: THREE.Group;
  yawGroup: THREE.Group;
  pitchGroup: THREE.Group;
  recoilGroup: THREE.Group;
  muzzles: THREE.Object3D[];
}
const sourceIds: Record<DefenseId, string> = { auto:'autocannon', cannon:'cannon', twin:'twin120', rocket:'mlrs', artillery:'howitzer' };
const palette = {
 hull:0x607663, hull2:0x435746, trim:0x293337, panel:0x87918b, metal:0x475358,
 steel:0x78868a, rubber:0x252b2b, glass:0x6ac2cf, hazard:0xd2a84c, accent:0xe4aa43,
 glow:0x66c5d1, lamp:0xe1d8a3, hot:0xf48b45, plasma:0x81d4db, rail:0x81d4db, fitting:0x63747a,
};
const kit = Object.fromEntries(Object.entries(palette).map(([name,color]) => [name,new THREE.MeshStandardMaterial({color, roughness:.72, metalness:.35, ...(name === 'glow' ? {emissive:color, emissiveIntensity:.35} : {})})]));
// Cache templates. Object3D.clone shares the expensive merged geometries and materials.
const templates = new Map<string, DefenseModel>();
export function createDefenseModel(id: DefenseId, spec: DefenseSpec): DefenseModel {
 const diameter = Math.min(spec.footprint[0], spec.footprint[1]) * .76;
 const key = `${id}:${diameter}`;
 let template = templates.get(key);
 if (!template) {
  const source = MODULE_BY_ID.get(sourceIds[id]);
  // The defense fires four tubes; keep the upstream MLRS builder with four cells.
  const mod = id === 'rocket' ? { ...source, barrels: 4 } : source;
  const turret = buildTurret(mod, kit, diameter);
  const root = new THREE.Group();
  // Upstream +X forward -> game +Z forward. The separate yaw remains game-aligned.
  const yawGroup = new THREE.Group(); const orientation = new THREE.Group(); orientation.rotation.y = -Math.PI / 2;
  const base = new THREE.Group(); base.name = 'base';
  const [width, depth] = spec.footprint;
  const body = new THREE.Mesh(new THREE.BoxGeometry(width, DEFENSE_BASE_HEIGHT, depth), kit.hull2);
  body.position.y = DEFENSE_BASE_HEIGHT / 2; body.castShadow = true; body.receiveShadow = true; base.add(body);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(width, .12, depth), kit.metal);
  cap.position.y = DEFENSE_BASE_HEIGHT - .06; cap.castShadow = true; base.add(cap);
  root.add(yawGroup, base); yawGroup.position.y = DEFENSE_BASE_HEIGHT;
  yawGroup.add(orientation); orientation.add(turret.yaw);
  turret.pitch.name='pitch'; turret.recoil.name='recoil';
  turret.muzzles.forEach((m: THREE.Object3D,i: number)=>m.name=`muzzle-${i}`);
  template = { root, yawGroup, pitchGroup:turret.pitch, recoilGroup:turret.recoil, muzzles:turret.muzzles };
  templates.set(key,template);
 }
 const root=template.root.clone(true) as THREE.Group;
 const yawGroup=root.children[0] as THREE.Group;
 const pitchGroup=root.getObjectByName('pitch') as THREE.Group;
 const recoilGroup=root.getObjectByName('recoil') as THREE.Group;
 const muzzles=template.muzzles.map((_,i)=>root.getObjectByName(`muzzle-${i}`)!);
 return {root,yawGroup,pitchGroup,recoilGroup,muzzles};
}
