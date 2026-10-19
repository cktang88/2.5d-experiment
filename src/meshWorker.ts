// Mesh worker: runs the Rust/WASM chunk mesher off the main thread.
import init, { Mesher } from './wasm/voxel_core';
import { runMesher, transferables } from './meshCore';
import type { MeshInput } from './meshCore';

let mesher: Mesher | null = null;
let memory: WebAssembly.Memory | null = null;
const ready = init().then((w) => { memory = w.memory; });

type Msg = { type: 'init'; table: Float32Array } | { type: 'greedy'; on: boolean } | { type: 'mesh'; inp: MeshInput };

self.onmessage = async (e: MessageEvent<Msg>) => {
  await ready;
  const msg = e.data;
  if (msg.type === 'init') {
    mesher = new Mesher();
    mesher.set_blocks(msg.table);
    return;
  }
  if (msg.type === 'greedy') { mesher!.set_greedy(msg.on); return; }
  const out = runMesher(mesher!, memory!, msg.inp);
  (self as unknown as Worker).postMessage(out, transferables(out));
};
