// @ts-nocheck
// Core shared types. Every module (sim, match, ai, client, server) speaks these.

/** chassis size class: 1 light (5 m) · 2 medium (10 m) · 3 heavy (15 m) · 4 GIANT (20 m) · 5 TITAN (25 m) */
export type Size = 1 | 2 | 3 | 4 | 5;
/** Weapon mount size, like T-shirt sizes: S < M < L < XL. A slot accepts modules of its size or smaller.
 *  L = giant-class weapons (only giant and titan hulls have L slots); XL = titan-class (only titan hulls have XL slots). */
export type MountClass = 'S' | 'M' | 'L' | 'XL';
export type MoveKind = 'ground' | 'air' | 'static';
/** Unit class, chosen first in the designer: chassis and mobility must share a domain.
 *  ground = tanks/walkers/hover/emplacements · jet = fixed-wing aircraft · heli = rotorcraft & grav-lift VTOLs */
export type Domain = 'ground' | 'jet' | 'heli';
export type Side = 0 | 1;

/** Combat role tags (Zero-K / Mechabellum style) used to filter and describe parts. */
export type Role =
  | 'raider' | 'skirmisher' | 'riot' | 'assault' | 'tank' | 'artillery' | 'antiair'
  | 'support' | 'scout' | 'flyer' | 'bomber' | 'siege' | 'stealth' | 'melee';

export type ChassisTrait = 'rangeBoost' | 'repairAura' | 'airOnly' | 'compact' | 'swift';
/** distance (cells, edge to edge) at which a 'stealth' cloak is revealed */
export const CLOAK_REVEAL = 2.5;
/** [aura balance] Support radii are measured EDGE TO EDGE (carrier footprint to the other unit's footprint), so big
 *  carriers project further and big allies are easy to cover. Auras never stack: each unit takes the single strongest
 *  source of each effect. Radius (cells, edge to edge) of the chassis 'repairAura' trait. */
export const REPAIR_AURA_RANGE = 6;
/** Drive traits. Movement ones (see sim steer): 'omni' walks any direction at full speed without facing its move;
 *  'pivot' stops and turns on the spot before it drives on; 'hover' floats: immune to burning ground and being crushed,
 *  half damage from ground-burst splash (artillery, mortar and bomb blasts; direct hits are unchanged). */
export type MobilityTrait = 'evasive' | 'leap' | 'fortified' | 'stable' | 'strafe' | 'crush' | 'omni' | 'pivot' | 'hover';

export interface ChassisDef {
  id: string;
  name: string;
  desc: string;
  size: Size;
  hp: number;
  armor: number;
  weight: number;
  cost: number;
  mounts: MountClass[];
  /** body turn-rate multiplier of the hull (nimble frames > 1, lumbering hulls < 1) */
  agility: number;
  /** unit class; defaults to 'ground' */
  domain?: Domain;
  /** unit footprint in cells [w across, h long/deep] when not square (default [size, size]).
   *  h is the unit's LENGTH along its facing; w its width. Size class (mount classes, stats) stays `size`. */
  footprint?: [number, number];
  /** box (cells, [w across, l along]) the art is drawn into when it differs from the footprint: legs, claws, tails,
   *  rotors or wings reaching past the hull get a bigger footprint over the same art, or the art shrinks to fit.
   *  Default = footprint. Hardpoints scale with it (shared/mountgeo.ts artBox). */
  art?: [number, number];
  /** if set, only these mobility ids fit this chassis (e.g. mechs need legs) */
  mobility?: string[];
  /** most weapon modules this hull may carry (default by size: parts.ts maxWeaponsFor); the other sockets take
   *  utilities, armour, shields and other non-weapons only */
  maxWeapons?: number;
  /** roles this hull is built for */
  roles: Role[];
  traits: ChassisTrait[];
  /** Render hint: silhouette family for procedural art. */
  shape: 'wedge' | 'box' | 'pod' | 'hex' | 'long' | 'round' | 'cross' | 'fortress' | 'titan' | 'airframe'
    | 'goliath' | 'leviathan' | 'carrier' | 'colossal' | 'citadel'
    | 'mantis' | 'mech' | 'arachnid' | 'crab' | 'saucer' | 'delta' | 'warlord' | 'scorpion' | 'centipede' | 'broodmother' | 'arachne'
    | 'carriage' | 'siegeplat' | 'riot' | 'hunter' | 'juggernaut' | 'interceptor' | 'bomber'
    | 'strikejet' | 'stratobomber' | 'heavyheli' | 'lance' | 'monolith' | 'strategic' | 'superfortress' | 'airship';
}

export interface MobilityDef {
  id: string;
  name: string;
  desc: string;
  kind: MoveKind;
  sizes: Size[];
  /** cells / second at ideal load */
  speed: number;
  /** radians / second body turn rate */
  turn: number;
  /** speed factor when backing up (move direction more than ~100 deg off the facing); default 1 (no penalty) */
  reverse?: number;
  /** wheeled steering: turns at full rate only while rolling; standing still it turns at ARC_STILL_TURN of its rate
   *  (a small turning circle instead of an on-the-spot turn) */
  arc?: boolean;
  /** Max weight carried at full speed, per chassis size (index 0 = size 1 ... index 4 = size 5). 0 means unsupported. */
  capacity: [number, number, number, number, number];
  /** weight per size unit (total = weight * size) */
  weight: number;
  /** hp per size unit */
  hp: number;
  armor: number;
  /** cost per size unit */
  cost: number;
  traits: MobilityTrait[];
  /** no longer offered to players (designer, decks, server): validateDesign rejects it; the sim still runs it */
  retired?: boolean;
  /** roles this mobility suits */
  roles: Role[];
  /** unit class this mobility belongs to; defaults to 'ground' */
  domain?: Domain;
}

/** 'melee' = instant contact strike; its range is measured EDGE to edge (shooter radius + target radius excluded),
 *  ground targets only. 'arc' = lobbed shell with a real flight time that lands where the target WAS. */
export type ProjectileKind = 'bullet' | 'shell' | 'rocket' | 'missile' | 'beam' | 'flame' | 'arc' | 'lightning' | 'rail' | 'orb' | 'melee' | 'none';

/** Main weapon/module categories (UI grouping + AI roles). */
export type ModuleCategory =
  | 'machinegun' | 'autocannon' | 'cannon' | 'precision' | 'rocket' | 'missile' | 'artillery' | 'bomb'
  | 'energy' | 'flame' | 'disruption' | 'antiair' | 'melee'
  | 'support' | 'defense' | 'stealth' | 'systems' | 'armor';

/** Render family: the renderer draws a turret per visual kind, varied by barrels & caliber. */
export type ModuleVisual =
  | 'gun' | 'gatling' | 'shotgun' | 'cannon' | 'gauss' | 'sniper' | 'rail' | 'rocketPod' | 'missileRack' | 'cruise'
  | 'mortar' | 'artillery' | 'laser' | 'heatray' | 'plasma' | 'flamer' | 'tesla' | 'emp' | 'slowbeam' | 'flak'
  | 'repair' | 'shield' | 'sensor' | 'plate' | 'sonic' | 'gravity'
  // melee
  | 'saw' | 'chainsaw' | 'hammer' | 'claw' | 'blade' | 'drill' | 'prod' | 'ram'
  // utilities
  | 'cloak' | 'jammer' | 'smoke' | 'pointdef' | 'engine' | 'uplink' | 'charge' | 'gyro' | 'coolant' | 'dome' | 'nanite';
export type ModuleKind = 'weapon' | 'armor' | 'utility';

export interface ModuleDef {
  id: string;
  name: string;
  desc: string;
  mount: MountClass;
  kind: ModuleKind;
  category: ModuleCategory;
  /** sub-category label shown in UI, e.g. "30mm" or "Twin 30mm" */
  family: string;
  visual: ModuleVisual;
  /** turret traverse speed in rad/s; omit to derive from mount class and weapon type (stats.ts turretTurnRate) */
  turretTurn?: number;
  /** visual barrel / tube count (1 if omitted) */
  barrels?: number;
  /** visual size 0..1 within its mount class */
  caliber?: number;
  weight: number;
  /** base complexity cost of the part; final unit cost also depends on predicted combat power (stats.ts) */
  cost: number;
  hp?: number;
  armor?: number;
  // ---- weapon fields (kind === 'weapon') ----
  /** damage per hit (per projectile) */
  damage?: number;
  /** seconds between shots (or between bursts when burst > 1) */
  cooldown?: number;
  /** projectiles per volley, fired ~0.1s apart */
  burst?: number;
  /** mounting restriction: 'air' = only on flying designs (bombs), 'ground' = only on non-flying designs */
  requires?: 'air' | 'ground';
  /** clip size: after this many shots (volleys) the weapon pauses `reload` seconds. Omit = continuous fire */
  magazine?: number;
  /** seconds to reload a full magazine */
  reload?: number;
  /** bomb bay: an empty magazine only reloads over the unit's own deploy zone, so the bomber flies home to rearm */
  resupply?: boolean;
  /** projectiles per shot fired simultaneously in a spread (shotguns, barrage) */
  pellets?: number;
  /** cells */
  range?: number;
  minRange?: number;
  targetsGround?: boolean;
  targetsAir?: boolean;
  projectile?: ProjectileKind;
  /** cells / second; ignored for hitscan (beam, lightning, rail) */
  projectileSpeed?: number;
  /** damage kind override (stats.ts damageKinds), e.g. a gauss slug flies as a 'shell' but is a solid kinetic round:
   *  reactive armour doesn't blunt it and point defense can't shoot it down */
  dmgKind?: 'kinetic' | 'explosive' | 'energy';
  /** splash radius in cells (0 = single target) */
  splash?: number;
  /** share of the centre damage dealt at the blast's rim (linear falloff in between; default SPLASH_EDGE 0.3): high =
   *  a flat lethal radius (heavy shells), low = a sharp point blast */
  splashEdge?: number;
  /** proximity fuse radius (cells): an anti-air shell bursts as soon as an enemy aircraft comes this close, so jinking
   *  or evasive flyers can't slip the airburst */
  proximity?: number;
  /** armour penetration tier: 0 (none), 0.5 (half: ignores half the target's armour) or 1 (full: ignores all of it).
   *  Only these three values are used (see AP_TIERS / apTier in stats.ts); shields ignore penetration entirely. */
  ap?: number;
  /** random aim error in cells at max range (0 = pinpoint). Hitscan beams/lightning/rail never miss;
   *  homing missiles track their target; every other projectile flies to where the target WAS when fired
   *  (no lead), so slow unguided shots miss fast movers. */
  spread?: number;
  /** lightning: additional jumps */
  chain?: number;
  /** multiplier vs flying targets (default 1) */
  airBonus?: number;
  /** rail/gauss: hits every enemy along its path (once each) */
  pierce?: boolean;
  /** vampiric: this share of the damage each hit deals (hull or shield) heals the shooter */
  lifesteal?: number;
  /** beam: each pulse also hits this many targets in total (the nearest others in reach, one beam each) */
  split?: number;
  /** beam: extra damage per hit = this share of the target's max hp (applied before armour) */
  pctHp?: number;
  /** armour stripped per hit (up to all of it); grows back 3 s after the last such hit */
  shred?: number;
  /** damage multiplier against shields (each point of the hit drains this many shield points; default 1) */
  shieldMult?: number;
  /** spinal weapon: fixed in the hull, aims only within this many radians of the hull's heading (the hull turns to aim) */
  spinal?: number;
  /** rail: half-width (cells) of the slug's path, added to each hull's width when testing what it passes through (default 0.1) */
  beamWidth?: number;
  /** rail: share of damage kept after each hull the slug passes through (default 0.6) */
  pierceKeep?: number;
  /** seconds of paralysis applied per hit (target can't move or fire); stacks up to 4s */
  stun?: number;
  /** slow applied per hit: fraction of speed & fire rate removed (0..1) for 2s; max 0.6 */
  slow?: number;
  /** burning damage over time applied per hit (refreshes, doesn't stack) */
  burn?: { dps: number; duration: number };
  /** knockback in cells per hit, away from the shooter (negative = pull toward). Halved vs size 2, x0.25 vs size 3, none vs static */
  impulse?: number;
  /** seconds per hit the target can't fire (but can still move); stacks to max 4s */
  disarm?: number;
  /** damage multiplier at max range (beams that fade with distance, e.g. 0.3); 1 = none */
  falloff?: number;
  /** rotary barrels: seconds of continuous fire to reach full rate of fire; starts at SPIN_MIN (25%) of it and
   *  spins back down while it has no target. `cooldown` is the full-speed rate */
  spinUp?: number;
  /** focusing beam: damage multiplier reached after RAMP_TIME (2.5 s) of continuous fire on the SAME target
   *  (resets on a target switch or a pause of more than 1 s); `damage` is the starting value */
  ramp?: number;
  /** arc shells: the landing leaves a burning patch (radius beyond the impact, cells) for `duration` s; enemy
   *  ground units inside are set alight at `dps` (burn rules: armour sheds heat, shields and hardened block it) */
  /** rad: a radioactive zone instead of fire: deals its dps straight to hulls inside (armor-piercing, no burn rules),
   *  air included */
  fireField?: { radius: number; duration: number; dps: number; rad?: boolean };
  /** arc shells: the shell bursts on landing into `count` bomblets that scatter up to `radius` cells from the
   *  impact and each explode for `damage` with `splash` */
  cluster?: { count: number; radius: number; damage: number; splash: number };
  // ---- utility ----
  /** hp healed per second to the most damaged ally in range */
  heal?: number;
  /** personal energy shield points (regenerates 5%/s after 3s without damage) */
  shield?: number;
  /** utility: +fraction weapon range for the whole unit (targeting computer) */
  rangeBonus?: number;
  /** utility: multiplies weapon spread (e.g. 0.6) */
  spreadMult?: number;
  // ---- more utilities (each is optional; a module may combine several) ----
  /** 'stealth': can't be targeted unless an enemy is within CLOAK_REVEAL cells or it fired in the last 1.5s.
   *  'phantom': can't be targeted except for 3s after each time it fires (proximity doesn't reveal it). */
  cloak?: 'stealth' | 'phantom';
  /** reveals cloaked enemies within this many cells, edge to edge (for all allies) */
  detect?: number;
  /** projects an energy shield onto allies (not self) within radius (edge to edge); each ally gets up to `amount` shield (capped at half its max hp), regenerating; domes don't stack (the strongest applies) */
  shieldAura?: { radius: number; amount: number };
  /** self-repair: fraction of max hp per second (only after 2s without damage) */
  regen?: number;
  /** +fraction move speed (applied in stats.speed) */
  speedBonus?: number;
  /** +fraction rate of fire for all of this unit's weapons */
  fireRateBonus?: number;
  /** -fraction reload time for clip weapons */
  reloadBonus?: number;
  /** allies within radius (edge to edge) get +bonus rate of fire (doesn't stack between uplinks: the strongest applies) */
  fireRateAura?: { radius: number; bonus: number };
  /** shoots down incoming enemy rockets/missiles/shells/arc/orb projectiles within range of its hull edge, one per cooldown */
  pointDefense?: { range: number; cooldown: number };
  /** enemy missiles aimed at allies within radius (edge to edge) lose homing; enemy spread doubled vs them (doesn't stack) */
  jammer?: number;
  /** when first dropping below 60% hp: smoke cloud of radius (beyond the carrier's hull) for duration; units inside can't be targeted from > 2.5 cells */
  smoke?: { radius: number; duration: number };
  /** number of explosive hits (shell/rocket/missile/arc/orb) reduced by 75% */
  reactive?: number;
  /** fraction of damage removed from beam/lightning/rail/plasma/flame hits */
  energyResist?: number;
  /** immune to stun, slow, disarm, burn and knockback */
  hardened?: boolean;
  /** explodes on death (radius beyond the carrier's hull); `friendly`: the blast also hurts allies (an ammo rack cooking off) */
  deathBlast?: { damage: number; radius: number; friendly?: boolean; stun?: number; slow?: number };
  // ---- small-hull utilities: worth most on light, fast or numerous units ----
  /** evasion thrusters: chance to dodge slow projectiles (shells, rockets, lobbed rounds, orbs); scaled down by hull size
   *  and up by speed (stats.ts dodgeChance) */
  dodge?: number;
  /** share of the dodge chance that also applies to bullets (evasion thrusters on a light hull) */
  dodgeBullets?: number;
  /** deflector: every hit on the hull loses this much damage first (never below 10% of it): shrugs off MG / flak swarms */
  deflect?: number;
  /** pack link: +`per` damage for each ally of the same design within `radius` cells, up to +`cap` */
  pack?: { per: number; cap: number; radius: number };
  // ---- trade-off utilities (the weapon cap leaves sockets for these; each is a net gain with a real cost) ----
  /** signed tuning of the whole unit (fractions, except `ap` and `splash` which add penetration tiers / blast cells):
   *  positives and negatives of the same key each stack with diminishing returns (stats.ts tuneOf) */
  tune?: Partial<Record<TuneKey, number>>;
  /** berserker: +`damage` (fraction) to every hit while the unit is below `below` of its max hp */
  berserk?: { below: number; damage: number };
  /** target painter: every hit marks the target for `duration` s; the whole side deals +`bonus` (fraction) to it */
  paint?: { bonus: number; duration: number };
  /** overcharge: a weapon's first volley after `idle` s without firing deals +`mult` (fraction) */
  overcharge?: { mult: number; idle: number };
  /** kill rush: after each kill, +`speed` and +`fireRate` (fractions) for `duration` s */
  killRush?: { speed: number; fireRate: number; duration: number };
  /** overheat: the hull loses this share of its max hp per second while its guns are firing (never below 25%) */
  overheat?: number;
  /** damage lost (fraction) on shots fired while still cloaked: the cloak field bleeds the guns' power */
  cloakDamage?: number;
  /** no longer buildable: kept so old records still simulate; saved designs swap it for `replacedBy` (else drop it) */
  retired?: boolean;
  replacedBy?: string;
  /** grants fire-on-move to the whole unit */
  gyro?: boolean;
}

/** keys of ModuleDef.tune */
/** gunDamage: damage of every weapon but melee (a barrel kit does nothing for a saw) */
export type TuneKey = 'damage' | 'gunDamage' | 'range' | 'fireRate' | 'speed' | 'turn' | 'hp' | 'weight' | 'ap' | 'splash' | 'projSpeed' | 'traverse';

/** A player-authored unit blueprint. */
export interface Design {
  id: string;
  name: string;
  chassis: string;
  mobility: string;
  /** one entry per chassis mount slot; null = empty */
  mounts: (string | null)[];
  /** default battle AI for blocks of this design (overridable per placement) */
  behavior?: UnitBehavior;
  /** last time the player saved this design (ms epoch; starters have none) */
  editedAt?: number;
}

/** Derived stats of a design (see stats.ts). */
export interface UnitStats {
  size: Size;
  /** unit footprint in cells: width across, length along facing (from ChassisDef.footprint or size x size) */
  fw: number;
  fh: number;
  hp: number;
  armor: number;
  weight: number;
  capacity: number;
  /** weight / capacity */
  load: number;
  speed: number;
  turn: number;
  /** speed factor when backing up (MobilityDef.reverse; 1 = no penalty, omni drives and flyers) */
  reverse: number;
  /** supply price of one BLOCK (squad units), rounded via roundCost — what the player pays */
  cost: number;
  /** one unit's share of the block price: cost / squad (not rounded; show it with stats.ts fmtUnitPrice) */
  unitCost: number;
  /** supply breakdown of ONE unit's price (unrounded; (priceParts + pricePower + priceSupport) x squad rounds to cost):
   *  parts complexity, combat power (both scaled by hull class and drive), support auras / point defense */
  priceParts: number;
  pricePower: number;
  priceSupport: number;
  /** units per purchased block (stats.ts squadFor, by unit price: 16, 8 or 4 for light hulls, 4, 2 or 1 for medium, else 1) */
  squad: number;
  flying: boolean;
  isStatic: boolean;
  /** longest weapon range (after range bonuses) */
  range: number;
  /** approximate sustained dps vs 0 armor */
  dps: number;
  shield: number;
  heal: number;
  traits: string[];
  /** range multiplier from chassis/mobility traits and modules */
  rangeMult: number;
  /** spread multiplier from traits/modules (stable, targeting computer) */
  spreadMult: number;
  /** net trade-off tuning of the loadout (stats.ts tuneOf): the sim applies the per-weapon parts (damage, ap, splash,
   *  shell speed, traverse) through stats.ts tunedWeapon, the same numbers the price uses */
  tune: Partial<Record<TuneKey, number>>;
  // ---- cost model breakdown (see stats.ts) ----
  /** sum of the parts' base complexity costs */
  partsCost: number;
  /** predicted damage output rating */
  offense: number;
  /** effective hp rating (hp, shield, armor, evasion, flight) */
  ehp: number;
  /** combat power = sqrt(offense * ehp) * mobility factor */
  power: number;
  /** final parts + power price / analytic parts + power price (1 = analytic): the team-value correction (stats.ts
   *  TEAM_FIT, off in the game), the toughness floor and the monotone floor (a design is at least as dear as any of its
   *  sub-designs) */
  teamMult: number;
  /** the physical features that correction is computed from (stats.ts TEAM_FEATURES) */
  teamFeatures: Record<string, number>;
  /** toughness floor ("wall tax", stats.ts TOUGH): supply per unit added because the bare hull is priced below its
   *  toughness; included in pricePower (unrounded, before the squad factor) */
  toughTax: number;
}

/** One placed unit instance on a player's board. Coordinates are in the player's LOCAL deploy grid (see grid.ts). */
export interface Placement {
  /** unique per side within a match */
  uid: number;
  designId: string;
  /** top-left cell, local coords */
  x: number;
  y: number;
  /** 1..MAX_LEVEL */
  level: number;
  /** round it was placed in */
  round: number;
  /** squads only: empty cells between neighbouring units in the block (0..MAX_SPACING = 2, default 0). See grid.ts */
  spacing?: number;
  /** squads only: formation turned 90° (8 across x 2 deep becomes 2 across x 8 deep). Locked once the round resolves. */
  rot?: boolean;
  /** targeting priority for every unit in the block (default 'closest'). Hidden from the opponent until the round resolves. */
  target?: TargetPriority;
  /** squads: keep the deployed spacing while moving/fighting (true/absent) or close in freely (false). Hidden like `target`. */
  hold?: boolean;
  /** keep to the edge of own weapon range: close in until in range, back away from enemies that come closer.
   *  Unset = the design's default (defaultOrders in stats.ts). Hidden like `target`. */
  kite?: boolean;
  /** mount index (into design.mounts) whose range kiting keeps to; absent/invalid = the longest-range weapon */
  kiteMount?: number;
  /** prefer the target nearby allies are already shooting (combined with `target`). Unset = the design's default. */
  focus?: boolean;
  stance?: Stance;
  /** seconds to wait before moving (one of START_DELAYS); weapons still fire at anything in range */
  delay?: number;
  /** below 30% hp fall back toward own lines / nearest repair source, return when healed above 70% */
  retreat?: boolean;
  /** Placement only: uid of a friendly block to stay close to and protect */
  escort?: number;
}

/** Battle AI settings. A Design carries defaults (set in the garage); each Placement copies them when placed and
 *  may override them on the field. The sim only reads the Placement's values. Hidden from the opponent
 *  (redactFor strips them from the opponent's board AND deck) until a round resolves. */
export interface UnitBehavior {
  target?: TargetPriority;
  /** squads: keep deployed spacing while moving */
  hold?: boolean;
  /** stay at max weapon range and back away from enemies that close in */
  kite?: boolean;
  kiteMount?: number;
  focus?: boolean;
  stance?: Stance;
  delay?: number;
  retreat?: boolean;
}

/** Who a unit prefers to shoot, among valid targets it could engage.
 *  closest/farthest: by distance · threat: whoever last damaged this unit or its squad (else closest) ·
 *  lowestHp/highestHp: by current hp · highestDps/lowestDps: by the target's damage output. */
export type TargetPriority =
  | 'closest' | 'farthest' | 'threat' | 'lowestHp' | 'highestHp' | 'highestDps' | 'lowestDps'
  /** aircraft first (falls back to ground) */
  | 'aircraft'
  /** highest armor first */
  | 'armored'
  /** longest weapon range first (hunt artillery & snipers) */
  | 'longestRange'
  /** support first: repair, shields/domes, uplinks, jammers, sensors */
  | 'support'
  /** highest unitCost first */
  | 'valuable'
  /** smallest / cheapest first (clear swarms) */
  | 'swarm';
export const TARGET_PRIORITIES: TargetPriority[] = [
  'closest', 'farthest', 'threat', 'lowestHp', 'highestHp', 'highestDps', 'lowestDps',
  'aircraft', 'armored', 'longestRange', 'support', 'valuable', 'swarm',
];

/** Movement stance. advance: default approach-and-engage · holdPos: never move, fire from where placed ·
 *  charge: never stop to shoot, close to contact · flankLeft/flankRight: swing wide along that side (from the
 *  owner's view) before turning in to engage. */
export type Stance = 'advance' | 'holdPos' | 'charge' | 'flankLeft' | 'flankRight';
export const STANCES: Stance[] = ['advance', 'holdPos', 'charge', 'flankLeft', 'flankRight'];
/** allowed start delays (seconds) */
export const START_DELAYS = [0, 3, 6, 10] as const;

/** Change the hidden battle settings of a unit already on the board (any round). */
export interface UnitConfig {
  uid: number;
  target?: TargetPriority;
  hold?: boolean;
  kite?: boolean;
  /** -1 clears (back to longest-range weapon) */
  kiteMount?: number;
  focus?: boolean;
  stance?: Stance;
  delay?: number;
  retreat?: boolean;
  /** uid of a friendly block to escort; -1 clears */
  escort?: number;
}

export interface DeployAction {
  round: number;
  /** newly bought units */
  place: Placement[];
  /** uids of existing units to upgrade by one level (may repeat a uid to upgrade twice) */
  upgrade: number[];
  /** uids of units placed in earlier rounds to sell back for SELL_REFUND of what was spent on them */
  sell?: number[];
  /** setting changes for units placed in earlier rounds (spacing can't change once locked in) */
  configure?: UnitConfig[];
}

export interface RoundResult {
  /** 0 or 1, or -1 for draw */
  winner: Side | -1;
  /** surviving unit uids per side */
  survivors: [number[], number[]];
  /** damage dealt TO each player this round */
  damage: [number, number];
  ticks: number;
}

export interface RoundRecord {
  round: number;
  seed: number;
  boards: [Placement[], Placement[]];
  result: RoundResult;
}

export interface PlayerState {
  name: string;
  /** up to DECK_SIZE designs, fixed for the match */
  deck: Design[];
  hp: number;
  supply: number;
  board: Placement[];
  nextUid: number;
  /** has submitted this round's deployment */
  ready: boolean;
  isAI?: boolean;
}

export type MatchMode = 'ai' | 'pvp';
export type MatchStatus = 'waiting' | 'deploy' | 'done';

export interface MatchState {
  id: string;
  mode: MatchMode;
  status: MatchStatus;
  round: number;
  seed: number;
  players: [PlayerState, PlayerState];
  history: RoundRecord[];
  winner?: Side | -1;
  createdAt: number;
  updatedAt: number;
  /** rules / price scale the match was created under (match.ts RULES_VERSION); absent on saves from before the marker */
  rules?: number;
}
