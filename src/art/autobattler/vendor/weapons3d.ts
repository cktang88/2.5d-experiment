// @ts-nocheck
// Adapted from upstream buildTurret: preserve its builders, ring, rig and muzzle placement.
import * as THREE from 'three';
import { moduleTier } from './parts.ts';
import { boreOf, calibreMm, classPos } from './weaponsize.ts';
import { Bld } from './geo.ts';
import { accent, deckRing, finishHousing } from './weapons/wkit.ts';
import { buildGun } from './weapons/guns.ts';
import { carbine, blades, artillery } from './weapons/w2500.ts';
export function buildTurret(mod, kit, D) {
 const r = D / 2, yaw = new THREE.Group(), pitch = new THREE.Group(), recoil = new THREE.Group();
 yaw.add(pitch); pitch.add(recoil);
 const t = { yaw, pitch, recoil, muzzles: [], fixed: false, shot: 'tracer', rate: .5, r, tris: 0, spinV: 0, idleSpin: 0 };
 let spinG = null;
 const C = { b:new Bld(), p:new Bld(), rc:new Bld(), sp:new Bld(), am:new Bld(), kit, mod, r, D,
  c:classPos(mod), tier:moduleTier(mod), nb:mod.barrels ?? 1, arm:.85,
  bore:Math.max(boreOf(calibreMm(mod)) * .4 * (1.5/.52) * D/1.5, r*.075),
  y0:r*.1, fixed:false, mainL:0, bv:Math.max(.004,r*.05), t,
  muzzle:(x,y,z)=>{const o=new THREE.Object3D(); o.position.set(x,y,z); recoil.add(o); t.muzzles.push(o);},
  spin:(axis='x',at=[0,0,0])=>{ spinG=new THREE.Group(); if(axis==='z'){const holder=new THREE.Group();holder.rotation.y=-Math.PI/2;holder.position.set(...at);holder.add(spinG);recoil.add(holder);}else{spinG.position.set(...at);recoil.add(spinG);}t.spin=spinG; }
 };
 C.b.segMax=C.p.segMax=C.rc.segMax=16;
 deckRing(C);
 if(mod.visual==='gun') carbine(C);
 else if(mod.visual==='rocketPod') blades(C);
 else if(mod.visual==='artillery') artillery(C);
 else buildGun(C);
 finishHousing(C);
 if(!C.acc) accent(C,-r*.3,C.y0+r*.42,-r*.42,r*.36,r*.07);
 C.b.mount(yaw); C.p.mount(pitch); C.rc.mount(recoil);
 if(spinG) C.sp.mount(spinG);
 if(C.am.m.size){const ag=new THREE.Group();recoil.add(ag);C.am.mount(ag);t.ammo=ag;}
 return t;
}
