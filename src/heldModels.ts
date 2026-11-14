// Imported (GLB) models for held weapons. The box-built model from gunModel() shows straight away and
// stays as the fallback; once the GLB has loaded (once per file, shared by every clone) it replaces
// the boxes inside the same group, so callers never wait.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface HeldModelSpec {
  /** file under public/models */
  file: string;
  /** longest side of the model, in the gun group's units (before gunModel's own 1.5 scale) */
  length: number;
  /** model position inside the gun group */
  offset: [number, number, number];
  /** yaw so the barrel points along +Z */
  yaw: number;
}

/** Tripo3D text-to-model (P2-20260801), see docs/ASSET_PROVENANCE.md */
export const HELD_MODELS: Record<string, HeldModelSpec> = {
  pistol: { file: 'tripo-pistol.glb', length: 0.6, offset: [0, -0.02, 0.08], yaw: Math.PI },
};

/** same dark ink as the box models' outlines (entities.ts) */
const OUTLINE = new THREE.MeshBasicMaterial({ color: 0x14101a, side: THREE.BackSide });
const INK = 0.022; // outline thickness in gun-group units, like the box parts

const cache = new Map<string, Promise<THREE.Object3D | null>>();

function load(spec: HeldModelSpec): Promise<THREE.Object3D | null> {
  let p = cache.get(spec.file);
  if (!p) {
    p = new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}models/${spec.file}`).then((gltf) => {
      const root = gltf.scene;
      const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
      const k = spec.length / Math.max(size.x, size.y, size.z);
      const meshes: THREE.Mesh[] = [];
      root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
      for (const m of meshes) {
        // Lambert like every other held part, lifted a little (as box parts are) so it reads at a distance
        const src = m.material as THREE.MeshStandardMaterial;
        m.material = new THREE.MeshLambertMaterial({ map: src.map, emissiveMap: src.map, emissive: 0x3a3a3a });
        m.castShadow = true;
        // ink outline: an inverted hull pushed out along the normals
        const geo = m.geometry.clone(), pos = geo.attributes.position, nrm = geo.attributes.normal, d = INK / k;
        for (let i = 0; i < pos.count; i++) pos.setXYZ(i, pos.getX(i) + nrm.getX(i) * d, pos.getY(i) + nrm.getY(i) * d, pos.getZ(i) + nrm.getZ(i) * d);
        m.add(new THREE.Mesh(geo, OUTLINE));
      }
      const pivot = new THREE.Group();
      root.position.copy(c).multiplyScalar(-1);
      pivot.add(root);
      pivot.scale.setScalar(k);
      pivot.rotation.y = spec.yaw;
      pivot.position.set(...spec.offset);
      pivot.name = 'imported';
      return pivot;
    }).catch((e) => { console.warn(`held model ${spec.file} failed to load, keeping the box model`, e); return null; });
    cache.set(spec.file, p);
  }
  return p;
}

/** Swap the box parts of `group` for the imported model of `kind` once it has loaded (no-op without one). */
export function attachHeldModel(group: THREE.Group, kind: string): void {
  const spec = HELD_MODELS[kind];
  if (!spec || typeof window === 'undefined') return;
  void load(spec).then((model) => {
    if (!model) return;
    for (const c of group.children) c.visible = false;
    group.add(model.clone());
  });
}
