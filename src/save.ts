// Save games in IndexedDB. Voxel, decor and water grids are gzip-compressed
// with the browser's CompressionStream (a full island is ~2 MB raw, ~60 KB packed).
import * as THREE from 'three';
import { Turret } from './entities';
import type { Game, Mods, Inventory } from './main';

const DB = 'blockfall-isle';
const STORE = 'saves';
const VERSION = 1;
export type Slot = 'auto' | 'manual';

interface SaveData {
  v: number;
  savedAt: number;
  world: Uint8Array; decor: Uint8Array; water: Uint8Array;
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
  const data: SaveData = {
    v: VERSION,
    savedAt: Date.now(),
    world: await gzip(w.data),
    decor: await gzip(w.decor),
    water: await gzip(game.waterSim.snapshot()),
    damage: [...w.damage],
    time: game.time, nightCount: game.nightCount, kills: game.kills, won: game.won, wasNight: game.wasNight,
    mods: { ...game.mods }, inv: { ...game.inv },
    player: { pos: v3(p.pos), hp: p.hp, maxHp: p.maxHp },
    turrets: ents.turrets.filter(t => !t.dead).map(t => ({ pos: v3(t.pos), hp: t.hp, ammo: t.ammo })),
    enemies: ents.enemies.filter(e => !e.dead).map(e => ({ kind: e.kind, pos: v3(e.pos), hp: e.hp })),
  };
  await idb('readwrite', s => s.put(data, slot));
  return data.world.length + data.decor.length + data.water.length;
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
  const [world, decor, water] = await Promise.all([gunzip(d.world), gunzip(d.decor), gunzip(d.water)]);
  // clear everything dynamic, then rebuild from the snapshot
  game.projectiles.reset();
  game.entities.reset();
  game.world.load(world, decor, d.damage);
  game.physics.reset(); // re-mirrors the terrain into Rapier from the loaded voxels
  game.waterSim.restore(water);
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
