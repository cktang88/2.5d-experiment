// Save games in IndexedDB. The world regenerates deterministically from its seed, so only
// 32³ chunks that changed are stored: their voxel, decor and water arrays (uniform chunks as
// a single fill value), gzip-compressed with the browser's CompressionStream.
import * as THREE from 'three';
import { Turret } from './entities';
import type { Game, Mods, Inventory } from './main';
import { CHUNK_VOL } from './world';

const DB = 'blockfall-isle';
const STORE = 'saves';
const VERSION = 4; // bumped whenever generation changes, since saves only store modified chunks
// per saved chunk: which arrays follow in the blob
const HAS_BLOCKS = 1, HAS_DECOR = 2, HAS_WATER = 4;
export type Slot = 'auto' | 'manual';

interface SaveData {
  v: number;
  savedAt: number;
  chunks: [number, number, number, number, number][]; // [cx, cy, cz, fill, flags] per modified chunk, in blob order
  blob: Uint8Array; // gzip of each chunk's present arrays (blocks, decor, water; CHUNK_VOL bytes each)
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
  const w = game.world, ents = game.entities, p = game.player;
  const chunks: SaveData['chunks'] = [];
  const parts: Uint8Array[] = [];
  for (const ch of w.modifiedChunks()) {
    const flags = (ch.blocks ? HAS_BLOCKS : 0) | (ch.decor ? HAS_DECOR : 0) | (ch.water ? HAS_WATER : 0);
    chunks.push([ch.cx, ch.cy, ch.cz, ch.fill, flags]);
    // copies: everything is snapshotted before the first await
    if (ch.blocks) parts.push(ch.blocks.slice());
    if (ch.decor) parts.push(ch.decor.slice());
    if (ch.water) parts.push(ch.water.slice());
  }
  const raw = new Uint8Array(parts.length * CHUNK_VOL);
  parts.forEach((a, k) => raw.set(a, k * CHUNK_VOL));
  const data: SaveData = {
    v: VERSION,
    savedAt: Date.now(),
    chunks,
    blob: new Uint8Array(0), // filled in below
    damage: [...w.damage],
    time: game.time, nightCount: game.nightCount, kills: game.kills, won: game.won, wasNight: game.wasNight,
    mods: { ...game.mods }, inv: { ...game.inv },
    player: { pos: v3(p.pos), hp: p.dead ? p.maxHp : p.hp, maxHp: p.maxHp },
    turrets: ents.turrets.filter(t => !t.dead).map(t => ({ pos: v3(t.pos), hp: t.hp, ammo: t.ammo })),
    enemies: ents.enemies.filter(e => !e.dead).map(e => ({ kind: e.kind, pos: v3(e.pos), hp: e.hp })),
  };
  data.blob = await gzip(raw);
  await idb('readwrite', s => s.put(data, slot));
  return data.blob.length;
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
  const w = game.world;
  // clear everything dynamic, then rebuild the world: columns changed in this session go back to
  // their generated state, saved chunks are generated and then overwritten with the saved arrays
  game.projectiles.reset();
  game.entities.reset();
  game.timers.length = 0; game.batch = null; game.hitstopT = 0; game.hurtFx = 0; // pending explosions, upgrade offers, autosaves
  const cols = new Set<number>();
  for (const ch of w.modifiedChunks()) cols.add(ch.cx + ch.cz * 4096);
  for (const [cx, , cz] of d.chunks) cols.add(cx + cz * 4096);
  for (const c of cols) w.regenColumn(c % 4096, Math.floor(c / 4096));
  let off = 0;
  const take = () => { const a = raw.slice(off, off + CHUNK_VOL); off += CHUNK_VOL; return a; };
  for (const [cx, cy, cz, fill, flags] of d.chunks) {
    const blocks = flags & HAS_BLOCKS ? take() : null, decor = flags & HAS_DECOR ? take() : null, water = flags & HAS_WATER ? take() : null;
    w.loadChunk(cx, cy, cz, blocks, fill, decor, water);
  }
  for (const c of cols) game.waterSim.activateColumn(c % 4096, Math.floor(c / 4096));
  for (const [i, v] of d.damage) w.damage.set(i, v);
  w.burning.clear();
  w.generateAround(d.player.pos[0], d.player.pos[2], 3);
  w.rebuildAround(d.player.pos[0], d.player.pos[2], 2);
  game.physics.reset(); // re-mirrors nearby terrain into Rapier from the loaded voxels
  game.time = d.time; game.nightCount = d.nightCount; game.kills = d.kills; game.won = d.won; game.wasNight = d.wasNight;
  Object.assign(game.mods, d.mods);
  for (const k of Object.keys(game.inv)) game.inv[k] = 0;
  Object.assign(game.inv, d.inv);
  const p = game.player;
  p.pos.set(...d.player.pos); p.vel.set(0, 0, 0);
  if (p.dead) game.respawnAt(p.pos);
  p.maxHp = d.player.maxHp; p.hp = Math.max(1, d.player.hp); p.burn = 0; p.invuln = 1.5;
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
