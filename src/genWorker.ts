// World-generation worker: builds whole 32-wide columns off the main thread and
// transfers the chunk arrays back.
import { WorldGen } from './worldgen';
import type { Column } from './worldgen';

let gen: WorldGen | null = null;
type Msg = { type: 'init'; seed: number } | { type: 'gen'; cx: number; cz: number };

self.onmessage = (e: MessageEvent<Msg>) => {
  const msg = e.data;
  if (msg.type === 'init') { gen = new WorldGen(5120, 512, 5120, msg.seed); return; }
  const col: Column = gen!.generateColumn(msg.cx, msg.cz);
  const transfer: ArrayBuffer[] = [];
  for (const list of [col.blocks, col.decor, col.water]) for (const a of list) if (a) transfer.push(a.buffer as ArrayBuffer);
  (self as unknown as Worker).postMessage(col, transfer);
};
