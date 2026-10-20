// Mesh worker: runs the Rust/WASM chunk mesher off the main thread, on the shared voxel core
// (chunks are read straight from shared memory; only the finished geometry is posted back).
import { Mesher } from './wasm/voxel_core';
import { VoxelCore } from './core';
import type { CoreHandle } from './core';
import { runMesher, transferables } from './meshCore';
import type { MeshInput } from './meshCore';

let mesher: Mesher | null = null;
let memory: WebAssembly.Memory | null = null;
let ready: Promise<void> | null = null;

type Msg = { type: 'init'; table: Float32Array; core: CoreHandle } | { type: 'greedy'; on: boolean } | { type: 'mesh'; inp: MeshInput };

self.onmessage = async (e: MessageEvent<Msg>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    ready = VoxelCore.attach(msg.core).then(() => {
      memory = msg.core.memory;
      mesher = new Mesher();
      mesher.set_blocks(msg.table);
      mesher.attach_store(msg.core.blk, msg.core.dec, msg.core.fill);
    });
    return;
  }
  await ready;
  if (msg.type === 'greedy') { mesher!.set_greedy(msg.on); return; }
  const out = runMesher(mesher!, memory!, msg.inp);
  (self as unknown as Worker).postMessage(out, transferables(out));
};
