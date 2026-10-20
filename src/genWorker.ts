// World-generation worker: builds whole 32-wide columns off the main thread, writing them
// straight into slabs of the shared voxel core (the reply's arrays are views of shared memory, so
// nothing is copied). It also answers terrain-sampling jobs (far-terrain LOD grids,
// map images, the ocean's shoreline texture) from the analytic heightfield; those replies carry
// `type` and the request's `id` (a 'gen' reply is the bare Column, as before).
import { WorldGen } from './worldgen';
import type { Column } from './worldgen';
import { VoxelCore } from './core';
import type { CoreHandle } from './core';
import { farGrid, mapImage, allSites, shoreData } from './terrainSample';

let gen: WorldGen | null = null;
let ready: Promise<unknown> = Promise.resolve();
export type SampleMsg =
  | { type: 'far'; id: number; x0: number; z0: number; step: number; n: number }
  | { type: 'map'; id: number; x0: number; z0: number; step: number; w: number; h: number; sites?: boolean }
  | { type: 'shore'; id: number; x0: number; z0: number; step: number; n: number };
type Msg = { type: 'init'; seed: number; test?: boolean; core?: CoreHandle } | { type: 'gen'; cx: number; cz: number } | SampleMsg;
const post = (m: unknown, transfer: Transferable[]) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<Msg>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    const g = gen = new WorldGen(5120, 512, 5120, msg.seed, !!msg.test);
    // column generators allocate chunk arrays in shared memory (sampling-only workers don't need it)
    if (msg.core) ready = VoxelCore.attach(msg.core).then(core => { g.slabs = core; });
    return;
  }
  await ready;
  const g = gen!;
  if (msg.type === 'far') {
    const r = farGrid(g, msg.x0, msg.z0, msg.step, msg.n);
    post({ type: 'far', id: msg.id, pos: r.pos, col: r.col }, [r.pos.buffer, r.col.buffer]);
    return;
  }
  if (msg.type === 'map') {
    const img = mapImage(g, msg.x0, msg.z0, msg.step, msg.w, msg.h);
    const sites = msg.sites ? allSites(g).map(s => ({ kind: s.kind, x: s.x, z: s.z })) : undefined;
    // hand back a ready ImageBitmap where OffscreenCanvas exists, so the main thread never touches pixels
    if (typeof OffscreenCanvas !== 'undefined') {
      const oc = new OffscreenCanvas(msg.w, msg.h);
      oc.getContext('2d')!.putImageData(new ImageData(img, msg.w, msg.h), 0, 0);
      const bmp = oc.transferToImageBitmap();
      post({ type: 'map', id: msg.id, bmp, sites }, [bmp]);
    } else post({ type: 'map', id: msg.id, img, sites }, [img.buffer]);
    return;
  }
  if (msg.type === 'shore') {
    const d = shoreData(g, msg.x0, msg.z0, msg.step, msg.n);
    post({ type: 'shore', id: msg.id, data: d }, [d.buffer]);
    return;
  }
  const col: Column = g.generateColumn(msg.cx, msg.cz);
  post(col, []); // shared-memory views: cloned as views of the same memory, never transferred
};
