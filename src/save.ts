// Save games in IndexedDB. The world regenerates deterministically from its seed, so only
// chunks that changed are stored: their voxel, decor and water grids, gzip-compressed with
// the browser's CompressionStream.
import * as THREE from 'three';
import { Turret } from './entities';
import type { Game, Mods, Inventory } from './main';

const DB = 'blockfall-isle';
const STORE = 'saves';
const VERSION = 2;
const CHUNK_BYTES = 16 * 16 * 40;
export type Slot = 'auto' | 'manual';

interface SaveData {
  v: number;
  savedAt: number;
  chunks: number[]; // indices of modified chunks, in the order they appear in `blob`
  blob: Uint8Array; // gzip of [voxels, decor, water] per chunk
  damage: [number, number][];
  time: number; nightCount: number; kills: number; won: boolean; wasNight: boolean;
  mods: Mods; inv: Inventory;
  player: { pos: [number, number, number]; hp: number; maxHp: number };
  turrets: { pos: [number, number, number]; hp: number; ammo: number }[];
  enemies: { kind: string; pos: [number, number, number]; hp: number }[];
}

export interface SaveInfo { slot: Slot; savedAt: number; nightCount: number; kills: number }

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
const gzip = (d: Uint8Array) => pipe(d, new CompressionStream('gzip'));
const gunzip = (d: Uint8Array) => pipe(d, new DecompressionStream('gzip'));

const v3 = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z];

export async function saveGame(game: Game, slot: Slot): Promise<number> {
  const w = game.world, ents = game.entities, p = game.player, lv = game.waterSim.lv;
  const chunks: number[] = [];
  for (let i = 0; i < w.modified.length; i++) if (w.modified[i] && w.genState[i]) chunks.push(i);
  const raw = new Uint8Array(chunks.length * CHUNK_BYTES * 3);
  const water = new Uint8Array(CHUNK_BYTES);
  chunks.forEach((ci, k) => {
    const base = k * CHUNK_BYTES * 3;
    w.readChunk(ci, raw.subarray(base, base + CHUNK_BYTES), raw.subarray(base + CHUNK_BYTES, base + 2 * CHUNK_BYTES), 0);
    readWater(game, ci, lv, water);
    raw.set(water, base + 2 * CHUNK_BYTES);
  });
  const data: SaveData = {
    v: VERSION,
    savedAt: Date.now(),
    chunks,
    blob: await gzip(raw),
    damage: [...w.damage],
    time: game.time, nightCount: game.nightCount, kills: game.kills, won: game.won, wasNight: game.wasNight,
    mods: { ...game.mods }, inv: { ...game.inv },
    player: { pos: v3(p.pos), hp: p.hp, maxHp: p.maxHp },
    turrets: ents.turrets.filter(t => !t.dead).map(t => ({ pos: v3(t.pos), hp: t.hp, ammo: t.ammo })),
    enemies: ents.enemies.filter(e => !e.dead).map(e => ({ kind: e.kind, pos: v3(e.pos), hp: e.hp })),
  };
  await idb('readwrite', s => s.put(data, slot));
  return data.blob.length;
}

// water levels of one chunk in the same layout as World.readChunk (y, z, x)
function readWater(game: Game, ci: number, lv: Uint8Array, out: Uint8Array): void {
  const w = game.world, x0 = (ci % w.cx) * 16, z0 = Math.floor(ci / w.cx) * 16, WD = w.W * w.D;
  let k = 0;
  for (let y = 0; y < w.H; y++) for (let z = z0; z < z0 + 16; z++) for (let x = x0; x < x0 + 16; x++) out[k++] = lv[x + z * w.W + y * WD];
}
function writeWater(game: Game, ci: number, lv: Uint8Array, src: Uint8Array): void {
  const w = game.world, x0 = (ci % w.cx) * 16, z0 = Math.floor(ci / w.cx) * 16, WD = w.W * w.D;
  let k = 0;
  for (let y = 0; y < w.H; y++) for (let z = z0; z < z0 + 16; z++) for (let x = x0; x < x0 + 16; x++) lv[x + z * w.W + y * WD] = src[k++];
}

export async function saveInfo(slot: Slot): Promise<SaveInfo | null> {
  try {
    const d = await idb<SaveData | undefined>('readonly', s => s.get(slot));
    return d && d.v === VERSION ? { slot, savedAt: d.savedAt, nightCount: d.nightCount, kills: d.kills } : null;
  } catch { return null; }
}

// newest of the two slots, if any
export async function latestSave(): Promise<SaveInfo | null> {
  const [a, m] = await Promise.all([saveInfo('auto'), saveInfo('manual')]);
  if (!a) return m; if (!m) return a;
  return a.savedAt > m.savedAt ? a : m;
}

export async function loadGame(game: Game, slot: Slot): Promise<boolean> {
  const d = await idb<SaveData | undefined>('readonly', s => s.get(slot));
  if (!d || d.v !== VERSION) return false;
  const raw = await gunzip(d.blob);
  const w = game.world, lv = game.waterSim.lv;
  // clear everything dynamic, then rebuild the world: chunks changed in this session go back to
  // their generated state, saved chunks are generated and then overwritten with the saved voxels
  game.projectiles.reset();
  game.entities.reset();
  const saved = new Set(d.chunks);
  for (let i = 0; i < w.modified.length; i++) if (w.modified[i] && !saved.has(i)) w.regenChunk(i);
  d.chunks.forEach((ci, k) => {
    const base = k * CHUNK_BYTES * 3;
    w.regenChunk(ci);
    w.loadChunk(ci, raw.subarray(base, base + CHUNK_BYTES), raw.subarray(base + CHUNK_BYTES, base + 2 * CHUNK_BYTES), 0);
    writeWater(game, ci, lv, raw.subarray(base + 2 * CHUNK_BYTES, base + 3 * CHUNK_BYTES));
    game.waterSim.activateChunk(ci % w.cx, Math.floor(ci / w.cx));
  });
  for (const [i, v] of d.damage) w.damage.set(i, v);
  w.burning.clear();
  w.generateAround(d.player.pos[0], d.player.pos[2]);
  game.physics.reset(); // re-mirrors nearby terrain into Rapier from the loaded voxels
  game.time = d.time; game.nightCount = d.nightCount; game.kills = d.kills; game.won = d.won; game.wasNight = d.wasNight;
  Object.assign(game.mods, d.mods);
  for (const k of Object.keys(game.inv)) game.inv[k] = 0;
  Object.assign(game.inv, d.inv);
  const p = game.player;
  p.pos.set(...d.player.pos); p.vel.set(0, 0, 0);
  p.maxHp = d.player.maxHp; p.hp = d.player.hp; p.burn = 0; p.invuln = 1.5;
  if (p.dead) game.respawnAt(p.pos);
  for (const t of d.turrets) {
    const tur = new Turret(game, ...t.pos);
    tur.hp = t.hp; tur.ammo = t.ammo;
    game.entities.turrets.push(tur);
  }
  game.boss = null;
  for (const e of d.enemies) {
    // bats spawn 3 blocks above the given point, so undo that offset
    const en = game.entities.spawnEnemy(e.kind, e.pos[0], e.kind === 'bat' ? e.pos[1] - 3 : e.pos[1], e.pos[2]);
    en.hp = e.hp;
    if (e.kind === 'boss') game.boss = en;
  }
  game.ui.cache = {};
  game.camTarget.copy(p.pos);
  return true;
}
