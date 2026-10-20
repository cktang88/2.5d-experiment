import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { N8AOPass } from 'n8ao';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { World, B, BLOCKS, WATER_LEVEL, MAX_RENDER_RADIUS, RENDER_RADIUS, sharedUniforms, CUT_RADIUS, terrainCutRadius, makeCapPlane, placeCapPlane } from './world';
import { makeSheets } from './sprites';
import { Particles } from './particles';
import { Physics } from './physics';
import { Entities, Turret } from './entities';
import type { Entity, Player } from './entities';
import { Projectiles } from './projectiles';
import { Audio } from './audio';
import { loadRapier } from './rigid';
import { Water } from './water';
import { saveGame, loadGame, latestSave } from './save';
import { VolumetricPass } from './volumetric';
import { Minimap } from './minimap';
import { FarTerrain } from './farTerrain';
import { WasmMeshing, blockTable } from './meshing';
import { VoxelCore } from './core';
import type { Slot } from './save';
import { UI } from './ui';

const DAY_LENGTH = 300; // seconds per full day
const BRASS = new THREE.Color(1.4, 1.0, 0.35), SHELL_RED = new THREE.Color(1.1, 0.25, 0.2);
const REACH = 6.5;
const SUN_DIST = 260;
const QUALITY_SCALE = [1, 0.8, 0.8, 0.62];

// scratch objects reused every frame (avoids per-frame garbage)
const _toP = new THREE.Vector3(), _cc = new THREE.Vector3(), _gun = new THREE.Vector3(), _d = new THREE.Vector3();
const _muzzle = new THREE.Vector3(), _sunDir = new THREE.Vector3(), _lightDir = new THREE.Vector3(), _focus = new THREE.Vector3(), _want = new THREE.Vector3();
const _sunCol = new THREE.Color(), _fog = new THREE.Color();
const C_SUN = new THREE.Color(0xfff2dc), C_DUSK = new THREE.Color(0xff9a5a), C_MOON = new THREE.Color(0x7a9cff);
const C_HEMI_DAY = new THREE.Color(0xcfe6ff), C_HEMI_NIGHT = new THREE.Color(0x3a4a80), C_GRD_DAY = new THREE.Color(0x6a5a40), C_GRD_NIGHT = new THREE.Color(0x1a1a30);
const C_FOG_DAY = new THREE.Color(0x9cc8d8), C_FOG_DUSK = new THREE.Color(0xe0a080), C_FOG_NIGHT = new THREE.Color(0x141c30);
const C_TURRET_GHOST = new THREE.Color(0x7a8a96);
// state for the roof-cutaway ray filter used by updateAim (mirrors the shader in world.ts)
let _cutCam: THREE.Vector3 = _toP, _cutL = 0, _cutY = 0, _cutTerrain = 0;
function cutaway(x: number, y: number, z: number, t: number): boolean {
  if (y < _cutY) return false;
  const anchored = BLOCKS[t].anchored;
  if (anchored && _cutTerrain < 0.5) return false;
  _cc.set(x + 0.5 - _cutCam.x, y + 0.5 - _cutCam.y, z + 0.5 - _cutCam.z);
  const along = _cc.dot(_toP);
  if (along > _cutL + 1.5) return false;
  const r = _cc.addScaledVector(_toP, -along).length();
  if (!anchored && r < CUT_RADIUS - 0.6) return true;
  return _cutTerrain >= 0.5 && r < terrainCutRadius(along, _cutL, _cutTerrain) * 0.8;
}
// state for the terrain-occlusion probe (updateCamera)
let _occCutY = 0;
const occluder = (_x: number, y: number, _z: number, t: number): boolean => !BLOCKS[t].anchored || y < _occCutY;
const _occO = new THREE.Vector3(), _occD = new THREE.Vector3(), _camR = new THREE.Vector3();
// camera pitch: the usual tilt, and how far it may steepen to look down into a valley
const CAM_PITCH = 0.8, CAM_PITCH_MAX = 1.15;
const CAM_MIN_DIST = 22; // closest the camera collision may pull in (any closer and the view gets cramped)
const CAM_SKIM = 6; // a camera this close above the terrain counts as buried
const TERRAIN_CUT_WIDE = 4; // terrain cut strength (circle radius multiplier) while the camera is buried
// camera shake noise
function shakeNoise(t: number, a: number, b: number): number { return Math.sin(t * a + b) * 0.6 + Math.sin(t * a * 2.3 + b * 1.7) * 0.4; }
const LANTERN_LIGHTS = 3, FLASH_LIGHTS = 2;

// ---------- post-processing shaders ----------
const TiltShift = (horizontal: boolean) => ({
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1 }, uTexel: { value: new THREE.Vector2() }, uFocus: { value: 0.5 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform vec2 uTexel; uniform float uFocus; varying vec2 vUv;
    void main(){
      float d = abs(vUv.y - uFocus);
      float blur = smoothstep(0.12, 0.5, d) * 3.2 * uAmount;
      vec2 dir = ${horizontal ? 'vec2(uTexel.x, 0.0)' : 'vec2(0.0, uTexel.y)'} * blur;
      vec4 s = texture2D(tDiffuse, vUv) * 0.2270270270;
      s += texture2D(tDiffuse, vUv + dir * 1.3846153846) * 0.3162162162;
      s += texture2D(tDiffuse, vUv - dir * 1.3846153846) * 0.3162162162;
      s += texture2D(tDiffuse, vUv + dir * 3.2307692308) * 0.0702702703;
      s += texture2D(tDiffuse, vUv - dir * 3.2307692308) * 0.0702702703;
      gl_FragColor = s;
    }`,
});
const Grade = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uNight: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uHurt: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime, uNight, uHurt; uniform vec2 uRes; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, 1.18 - uNight * 0.25);
      // split toning: warm highlights, cool shadows
      c *= mix(vec3(0.92, 0.97, 1.08), vec3(1.06, 1.0, 0.92), smoothstep(0.0, 0.7, l));
      c = mix(c, c * vec3(0.6, 0.72, 1.15), uNight * 0.55);
      vec2 p = vUv - 0.5;
      float vig = smoothstep(0.95, 0.3, length(p * vec2(1.0, 1.15)));
      c *= mix(0.45, 1.0, vig);
      c = mix(c, c * vec3(1.6, 0.3, 0.3), uHurt * (1.0 - vig) * 0.9);
      float n = fract(sin(dot(vUv * uRes + fract(uTime) * 91.7, vec2(12.9898, 78.233))) * 43758.5453);
      c += (n - 0.5) * 0.03 * (0.5 + l);
      gl_FragColor = vec4(c, 1.0);
    }`,
};

// the ocean's shoreline texture covers SHORE_RES x SHORE_RES samples, SHORE_STEP blocks apart (sampled in a terrain worker)
const SHORE_RES = 512, SHORE_STEP = 2;
// fog: squared-exponential, so the play area stays crisp and far terrain melts into the sky; the far plane sits where fog is total
const FOG_DENSITY = 1 / 1100, CAM_FAR = 2600;
// camera zoom range (boom length in blocks); zoomed far out the voxel world streams wider (see world.renderRadius)
const ZOOM_MIN = 18, ZOOM_MAX = 900;
const WaterShader = {
  vertexShader: `
    #include <common>
    #include <fog_pars_vertex>
    uniform float uTime; varying vec3 vW;
    void main(){
      vec3 p = position;
      vec4 wp = modelMatrix * vec4(p, 1.0);
      wp.y += sin(wp.x * 0.6 + uTime * 1.4) * 0.05 + cos(wp.z * 0.5 + uTime * 1.1) * 0.05;
      vW = wp.xyz;
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`,
  fragmentShader: `
    #include <common>
    #include <fog_pars_fragment>
    uniform float uTime, uDay; uniform sampler2D uShore; uniform vec2 uShoreO; uniform float uShoreS; uniform vec3 uSky;
    varying vec3 vW;
    float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
    float vn(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
      return mix(mix(h21(i),h21(i+vec2(1,0)),u.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),u.x), u.y); }
    void main(){
      vec2 suv = (vW.xz - uShoreO) / uShoreS;
      float shore = 0.0;
      if (suv.x > 0.0 && suv.y > 0.0 && suv.x < 1.0 && suv.y < 1.0) shore = texture2D(uShore, suv).r;
      vec3 deep = vec3(0.05, 0.22, 0.38), shallow = vec3(0.22, 0.62, 0.66);
      float w = vn(vW.xz * 0.35 + vec2(uTime * 0.15, uTime * 0.1)) * 0.6 + vn(vW.xz * 0.9 - uTime * 0.2) * 0.4;
      vec3 c = mix(deep, shallow, clamp(shore * 0.9 + w * 0.15, 0.0, 1.0));
      // stylised caustic lines
      float lines = smoothstep(0.47, 0.5, abs(fract(w * 4.0 + uTime * 0.1) - 0.5));
      c += lines * 0.08 * (0.4 + shore);
      // shoreline foam bands
      float band = sin(shore * 14.0 - uTime * 2.2) * 0.5 + 0.5;
      float foam = smoothstep(0.62, 0.95, shore) * smoothstep(0.55, 0.9, band + vn(vW.xz * 2.0) * 0.4);
      foam = max(foam, smoothstep(0.93, 1.0, shore));
      c = mix(c, vec3(0.95, 0.98, 1.0), foam * 0.85);
      float sp = step(0.985, vn(vW.xz * 3.0 + uTime * 0.6)) * (1.0 - shore);
      c += sp * 0.8 * uDay;
      c *= mix(0.22, 1.0, uDay);
      c = mix(c, uSky * 0.8, 0.12);
      gl_FragColor = vec4(c, mix(0.86, 0.55, shore));
      #include <fog_fragment>
    }`,
};

type RapierModule = NonNullable<Awaited<ReturnType<typeof loadRapier>>>;

export interface GunStats {
  cool: number; dmg: number; speed: number; spread: number; blockDmg: number; knock: number;
  pellets?: number; kick?: number; auto?: boolean;
}
export interface HotbarSlot {
  id: string; name: string; icon: string;
  ammo?: string; gun?: GunStats; rocket?: boolean; grenade?: boolean; turret?: boolean; place?: number;
}
export type Inventory = Record<string, number>;
export interface Recipe {
  name: string; icon: string; desc: string; cost: Record<string, number>; give: Record<string, number>;
}
export interface Upgrade { name: string; desc: string; icon: string; apply: () => void; }
export interface Mods { dmg: number; speed: number; blast: number; mine: number; turret: number; magnet: number; }
export interface InputState {
  keys: Record<string, boolean>; pressed: Record<string, boolean>;
  mouse: THREE.Vector2; mx: number; my: number;
  lmb: boolean; rmb: boolean; mmb: boolean; lmbPressed: boolean;
}
export interface FlashLight { l: THREE.PointLight; t: number; max: number; power: number; }
export interface GameTimer { t: number; fn: () => void; }
export interface VoxelHit { hit: boolean; x: number; y: number; z: number; nx: number; ny: number; nz: number; t: number; point: THREE.Vector3; }

export class Game {
  R: RapierModule | null;
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  composer!: EffectComposer;
  ao!: N8AOPass;
  shafts!: VolumetricPass;
  aoOn = true; shaftsOn = true;
  // automatic quality scaler: 0 = full, 1 = lower pixel ratio, 2 = also no light shafts, 3 = lower still
  autoQuality = !navigator.webdriver;
  qualityLevel = 0;
  private qAcc = 0; private qFrames = 0; private qSlow = 0; private qGrace = 3;
  tiltH!: ShaderPass;
  tiltV!: ShaderPass;
  bloom!: UnrealBloomPass;
  grade!: ShaderPass;
  pixelMode: boolean;
  tiltOn: boolean;
  camYaw: number; camYawT: number; camPitch: number; camDist: number; camDistT: number;
  trauma: number; hitstopT: number; spriteAmbient: THREE.Color; sunYaw: number; lead: THREE.Vector3;
  camTarget: THREE.Vector3;
  shakeAmt: number;
  time: number; dayK: number; nightCount: number; wasNight: boolean;
  kills: number;
  slowmo: number;
  hurtFx: number;
  audio: Audio;
  world: World;
  particles: Particles;
  physics: Physics;
  projectiles: Projectiles;
  sheets: ReturnType<typeof makeSheets>;
  entities: Entities;
  spawnPoint: THREE.Vector3;
  player: Player;
  mods: Mods;
  won: boolean; paused: boolean; timers: GameTimer[]; autosaveT = 120;
  continueSlot: Slot = 'auto'; private saving = false; private deadAt = 0;
  inv: Inventory;
  hotbar: HotbarSlot[];
  recipes: Recipe[];
  sel: number;
  fireCd: number; mineCd: number;
  ui: UI;
  minimap!: Minimap;
  far!: FarTerrain;
  clock: THREE.Clock;
  started: boolean;
  sun!: THREE.DirectionalLight;
  hemi!: THREE.HemisphereLight;
  flashLights!: FlashLight[];
  lanternLights!: THREE.PointLight[];
  lanternT!: number;
  private lanternD = new Float64Array(LANTERN_LIGHTS); private lanternI = new Int32Array(LANTERN_LIGHTS);
  shoreTex!: THREE.DataTexture;
  shoreOX = 0; shoreOZ = 0;
  private shoreWant: [number, number] | null = null;
  waterUniforms!: { [k: string]: THREE.IUniform };
  ocean!: THREE.Mesh;
  waterSim!: Water;
  hoverBox!: THREE.LineSegments;
  reticle!: THREE.Mesh;
  aimLine!: THREE.Line;
  ghost!: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  input!: InputState;
  raycaster: THREE.Raycaster | null = null;
  aimPoint: THREE.Vector3 | null = null;
  /** explore mode: the camera looks at this spot (picked on the map) and the world streams around it; gameplay is paused */
  explore: THREE.Vector3 | null = null;
  hover: VoxelHit | null = null;
  pickT = 0;
  lastBlast: THREE.Vector3 | null = null;
  lastDamagePos: THREE.Vector3 | null = null;
  batch: number[][] | null = null;
  boss: Entity | null = null;
  constructor(R: RapierModule | null, core: VoxelCore, meshing: WasmMeshing) {
    this.R = R;
    this.canvas = document.getElementById('game') as HTMLCanvasElement;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.pixelMode = false;
    this.tiltOn = true;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x9cc8d8, FOG_DENSITY);
    this.scene.background = new THREE.Color(0x9cc8d8);
    this.camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.5, CAM_FAR);
    this.camYaw = Math.PI * 0.25; this.camYawT = this.camYaw;
    this.camPitch = 0.8; this.camDist = 36; this.camDistT = 36;
    this.trauma = 0; this.hitstopT = 0; this.spriteAmbient = new THREE.Color(0.3, 0.3, 0.3); this.sunYaw = 0; this.lead = new THREE.Vector3();
    this.camTarget = new THREE.Vector3();
    this.shakeAmt = 0;
    this.time = 0.29; this.dayK = 1; this.nightCount = 0; this.wasNight = false;
    this.kills = 0;
    this.slowmo = 1;
    this.hurtFx = 0;

    this.audio = new Audio();
    this.setupLights();
    this.world = new World(this, core);
    this.world.meshing = meshing;
    meshing.onResult = (d) => this.world.applyMesh(d);
    meshing.rank = (key) => this.world.meshRank(key);
    meshing.onDrop = (key) => { const ch = this.world.chunks[key]; if (ch) ch.dirty = true; };
    this.waterSim = new Water(this, this.world);
    // the world streams in around the player; generate and mesh the start area up front
    const castle = this.world.gen.spawn;
    this.world.generateAround(castle.x, castle.z + 16, 3);
    this.scene.add(this.waterSim.group);
    this.scene.add(this.world.group);
    this.world.rebuildAround(castle.x, castle.z + 16, 2);
    this.far = new FarTerrain(this);
    this.scene.add(this.far.group);
    this.setupWater();

    this.particles = new Particles(this);
    this.physics = new Physics(this);
    this.projectiles = new Projectiles(this);
    this.sheets = makeSheets();
    this.entities = new Entities(this, this.sheets);
    const sx = castle.x + 0.5, sz = castle.z + 15.5;
    this.spawnPoint = new THREE.Vector3(sx, this.world.surfaceY(Math.floor(sx), Math.floor(sz)) + 0.1, sz);
    this.player = this.entities.spawnPlayer(this.spawnPoint.x, this.spawnPoint.y, this.spawnPoint.z);
    this.camTarget.set(castle.x, castle.g + 2, castle.z);
    this.camDist = this.camDistT = 46;

    this.mods = { dmg: 1, speed: 1, blast: 1, mine: 1, turret: 1, magnet: 3.2 };
    this.won = false; this.paused = false; this.timers = [];
    this.inv = { wood: 6, stone: 6, metal: 4, goo: 2, ammo: 90, shells: 16, rockets: 4, grenades: 5, planks: 24, bricks: 12, tnt: 3, turret: 1, lantern: 4, medkit: 1 };
    this.hotbar = [
      { id: 'pistol', name: 'Pistol', icon: 'pistol', gun: { cool: 0.26, dmg: 24, speed: 75, spread: 0.015, blockDmg: 1, knock: 3 } },
      { id: 'shotgun', name: 'Shotgun', icon: 'shotgun', ammo: 'shells', gun: { cool: 0.75, dmg: 11, speed: 60, spread: 0.13, pellets: 9, blockDmg: 0.8, knock: 5, kick: 3 } },
      { id: 'smg', name: 'SMG', icon: 'smg', ammo: 'ammo', gun: { cool: 0.075, dmg: 9, speed: 80, spread: 0.06, blockDmg: 0.5, knock: 1.5, auto: true } },
      { id: 'rocket', name: 'Rocket', icon: 'rocket', ammo: 'rockets', rocket: true },
      { id: 'grenade', name: 'Grenade', icon: 'grenade', ammo: 'grenades', grenade: true },
      { id: 'planks', name: 'Planks', icon: 'planks', ammo: 'planks', place: B.PLANKS },
      { id: 'bricks', name: 'Bricks', icon: 'bricks', ammo: 'bricks', place: B.BRICK },
      { id: 'tnt', name: 'TNT', icon: 'tnt', ammo: 'tnt', place: B.TNT },
      { id: 'turret', name: 'Turret', icon: 'turret', ammo: 'turret', turret: true },
      { id: 'lantern', name: 'Lantern', icon: 'lantern', ammo: 'lantern', place: B.LANTERN },
    ];
    this.recipes = [
      { name: 'SMG Rounds ×30', icon: 'ammo', desc: 'for the SMG', cost: { metal: 1 }, give: { ammo: 30 } },
      { name: 'Shells ×8', icon: 'shells', desc: 'for the shotgun', cost: { metal: 1, wood: 1 }, give: { shells: 8 } },
      { name: 'Rockets ×2', icon: 'rocket', desc: 'level a tower', cost: { metal: 2, goo: 1 }, give: { rockets: 2 } },
      { name: 'Grenades ×3', icon: 'grenade', desc: 'bouncy, lobbed', cost: { metal: 1, goo: 2 }, give: { grenades: 3 } },
      { name: 'Planks ×8', icon: 'planks', desc: 'cheap walls (flammable)', cost: { wood: 2 }, give: { planks: 8 } },
      { name: 'Bricks ×6', icon: 'bricks', desc: 'sturdy walls', cost: { stone: 3 }, give: { bricks: 6 } },
      { name: 'TNT', icon: 'tnt', desc: 'chain reactions!', cost: { goo: 2, wood: 1 }, give: { tnt: 1 } },
      { name: 'Lanterns ×2', icon: 'lantern', desc: 'light up the night', cost: { metal: 1, goo: 1 }, give: { lantern: 2 } },
      { name: 'Auto Turret', icon: 'turret', desc: 'shoots hostiles (250 rds)', cost: { metal: 6, stone: 4, wood: 2 }, give: { turret: 1 } },
      { name: 'Medkit', icon: 'medkit', desc: '+50 HP (press H)', cost: { goo: 3, wood: 1 }, give: { medkit: 1 } },
    ];
    this.sel = 0;
    this.fireCd = 0; this.mineCd = 0;
    this.ui = new UI(this);
    this.minimap = new Minimap(this);
    this.setupHover();
    this.setupInput();
    this.setupComposer();
    this.onResize();
    addEventListener('resize', () => this.onResize());
    this.select(0);
    // a few starting hostiles in the distance
    for (let i = 0; i < 6; i++) this.entities.spawnAround(i % 3 === 2 ? 'crawler' : 'zombie', 48, 72); // far enough that the first seconds are calm
    this.clock = new THREE.Clock();
    this.started = false;
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------- setup ----------
  setupLights() {
    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    // the light sits SUN_DIST from the player along the sun direction, and the depth range spans twice
    // that, so mountains up to a couple of hundred blocks above (or below) the player still cast and
    // receive shadows; the bias is scaled to keep the same world-space offset as the old 160-deep range
    sc.left = -34; sc.right = 34; sc.top = 34; sc.bottom = -34; sc.near = 1; sc.far = SUN_DIST * 2;
    this.sun.shadow.bias = -0.0006 * 160 / (SUN_DIST * 2); this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xcfe6ff, 0x6a5a40, 1.0);
    this.scene.add(this.hemi);
    this.flashLights = [];
    for (let i = 0; i < FLASH_LIGHTS; i++) { const l = new THREE.PointLight(0xffa040, 0, 18, 1.4); this.scene.add(l); this.flashLights.push({ l, t: 0, max: 1, power: 0 }); }
    this.lanternLights = [];
    for (let i = 0; i < LANTERN_LIGHTS; i++) { const l = new THREE.PointLight(0xffc070, 0, 13, 1.5); this.scene.add(l); this.lanternLights.push(l); }
    this.lanternT = 0;
  }

  setupWater() {
    const w = this.world;
    // shoreline depth from the analytic terrain, in a window that follows the player
    this.shoreTex = new THREE.DataTexture(new Uint8Array(SHORE_RES * SHORE_RES), SHORE_RES, SHORE_RES, THREE.RedFormat, THREE.UnsignedByteType);
    this.shoreTex.magFilter = THREE.LinearFilter; this.shoreTex.minFilter = THREE.LinearFilter;
    this.shoreOX = this.shoreOZ = -1e6; // nothing until the first worker reply
    const sp = w.gen.spawn;
    this.updateShore(sp.x, sp.z);
    this.waterUniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 }, uDay: { value: 1 }, uShore: { value: null }, uShoreO: { value: new THREE.Vector2(this.shoreOX, this.shoreOZ) },
      uShoreS: { value: SHORE_RES * SHORE_STEP }, uSky: { value: new THREE.Color() },
    }]);
    this.waterUniforms.uShore.value = this.shoreTex;
    const mat = new THREE.ShaderMaterial({ ...WaterShader, uniforms: this.waterUniforms, transparent: true, fog: true, depthWrite: false });
    // the ocean is endless: a plane reaching past the far plane in every direction, recentred on the
    // camera each frame (the shader works in world space). A fixed plane ended 800 blocks past the world
    // edge, which showed as a hard sea/sky line from a coastal mountain near the edge.
    const geo = new THREE.PlaneGeometry(CAM_FAR * 2.5, CAM_FAR * 2.5, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.ocean = new THREE.Mesh(geo, mat);
    this.ocean.position.set(w.W / 2, WATER_LEVEL - 0.12, w.D / 2);
    this.ocean.frustumCulled = false;
    this.ocean.renderOrder = 1;
    this.scene.add(this.ocean);
  }

  // ask a terrain worker for a new shore window once the player strays a quarter-window from the current one
  private updateShore(px: number, pz: number): void {
    const half = SHORE_RES * SHORE_STEP / 2;
    const [cx, cz] = this.shoreWant ?? [this.shoreOX, this.shoreOZ];
    if (Math.max(Math.abs(px - (cx + half)), Math.abs(pz - (cz + half))) < half / 2) return;
    const ox = Math.round((px - half) / 64) * 64, oz = Math.round((pz - half) / 64) * 64;
    this.shoreWant = [ox, oz];
    this.far.jobs.request({ type: 'shore', id: 0, x0: ox, z0: oz, step: SHORE_STEP, n: SHORE_RES }, 1, (r: { data: Uint8Array<ArrayBuffer> }) => {
      this.shoreTex.image.data = r.data;
      this.shoreTex.needsUpdate = true;
      this.shoreOX = ox; this.shoreOZ = oz;
      this.waterUniforms.uShoreO.value.set(ox, oz);
    }, 'shore');
  }

  setupComposer() {
    const r = this.renderer;
    this.composer = new EffectComposer(r);
    // N8AO renders the scene (replacing a plain RenderPass) and adds ambient occlusion
    this.ao = new N8AOPass(this.scene, this.camera, innerWidth, innerHeight);
    Object.assign(this.ao.configuration, {
      aoRadius: 2.2, distanceFalloff: 1.2, intensity: 2.2, halfRes: true, aoSamples: 12,
      denoiseSamples: 6, denoiseRadius: 10, gammaCorrection: false, screenSpaceRadius: false,
    });
    this.composer.addPass(this.ao);
    this.shafts = new VolumetricPass();
    this.composer.addPass(this.shafts);
    this.tiltH = new ShaderPass(TiltShift(true));
    this.tiltV = new ShaderPass(TiltShift(false));
    this.composer.addPass(this.tiltH); this.composer.addPass(this.tiltV);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.45, 0.82);
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(Grade);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
  }

  setupHover() {
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.02, 1.02, 1.02));
    this.hoverBox = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }));
    this.hoverBox.visible = false;
    this.scene.add(this.hoverBox);
    this.ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }));
    this.ghost.visible = false;
    this.scene.add(this.ghost);
    // 3D aim reticle (a camera-facing ring at the aim point) and a faint aim line from the muzzle,
    // so aiming up a cliff or down into a valley reads clearly from the tilted camera
    const over = { transparent: true, depthTest: false, depthWrite: false, fog: false };
    this.reticle = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.32, 24), new THREE.MeshBasicMaterial({ color: 0xfff2c8, opacity: 0.85, ...over }));
    this.reticle.add(new THREE.Mesh(new THREE.CircleGeometry(0.06, 12), new THREE.MeshBasicMaterial({ color: 0xff5a3a, opacity: 0.9, ...over })));
    this.reticle.renderOrder = 10; this.reticle.visible = false;
    this.aimLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineDashedMaterial({ color: 0xfff2c8, opacity: 0.35, dashSize: 0.35, gapSize: 0.25, ...over }));
    this.aimLine.renderOrder = 9; this.aimLine.visible = false; this.aimLine.frustumCulled = false;
    this.scene.add(this.reticle, this.aimLine);
  }

  // place the reticle and aim line for the current aim (called after updateAim); hidden under the pause
  // menu, upgrade picker and victory screen like the rest of the aiming UI
  private updateReticle(): void {
    const p = this.player, s = this.hotbar[this.sel];
    const show = this.started && !p.dead && !this.paused && !this.explore && !this.ui.craftOpen && !!this.aimPoint && !!(s.gun || s.rocket || s.grenade);
    this.reticle.visible = this.aimLine.visible = show;
    if (!show) return;
    const a = this.aimPoint!;
    this.reticle.position.copy(a);
    this.reticle.quaternion.copy(this.camera.quaternion);
    const pos = this.aimLine.geometry.attributes.position as THREE.BufferAttribute;
    const m = _muzzle.set(p.pos.x, p.pos.y + 0.95, p.pos.z).addScaledVector(p.aimDir, 0.75);
    pos.setXYZ(0, m.x, m.y, m.z); pos.setXYZ(1, a.x, a.y, a.z); pos.needsUpdate = true;
    this.aimLine.computeLineDistances();
  }

  setupInput() {
    this.input = { keys: {}, pressed: {}, mouse: new THREE.Vector2(), mx: innerWidth / 2, my: innerHeight / 2, lmb: false, rmb: false, mmb: false, lmbPressed: false };
    const I = this.input;
    addEventListener('keydown', (e) => {
      if (e.code === 'Tab' || e.code === 'F5' || e.code === 'F9') e.preventDefault();
      if (e.repeat) return; // auto-repeat must not re-toggle panels, spam saves or burn medkits
      if (this.started && e.code === 'F5') { this.save('manual'); return; }
      if (this.started && e.code === 'F9') { this.load('manual'); return; }
      if (this.started && e.code === 'Escape' && this.minimap.bigOpen) { this.minimap.toggleWorld(false); return; }
      if (this.started && (e.code === 'Escape' || e.code === 'Space') && this.explore) { this.stopExplore(); return; }
      if (this.started && e.code === 'KeyB') { this.minimap.toggleWorld(); return; }
      if (this.started && e.code === 'Escape' && !this.ui.craftOpen && !this.player.dead && !this.modalOpen()) { this.togglePause(); return; }
      if (!I.keys[e.code]) I.pressed[e.code] = true;
      I.keys[e.code] = true;
      if (!this.started) return;
      const play = !this.paused && !this.player.dead; // hotbar, crafting and medkits are for live gameplay only
      if (play && e.code.startsWith('Digit')) { const n = parseInt(e.code.slice(5)); this.select(n === 0 ? 9 : n - 1); }
      if (play && (e.code === 'Tab' || e.code === 'KeyC')) this.ui.toggleCraft();
      if (e.code === 'KeyQ') this.camYawT += Math.PI / 4;
      if (e.code === 'KeyE') this.camYawT -= Math.PI / 4;
      if (play && e.code === 'KeyH') this.useMedkit();
      if (e.code === 'KeyP') this.togglePixel();
      if (e.code === 'KeyN') this.minimap.toggle();
      if (e.code === 'KeyG') { this.aoOn = !this.aoOn; this.ui.toast('Ambient occlusion ' + (this.aoOn ? 'on' : 'off')); }
      if (e.code === 'KeyV') { this.shaftsOn = !this.shaftsOn; this.ui.toast('Light shafts ' + (this.shaftsOn ? 'on' : 'off')); }
      if (e.code === 'KeyO') { this.tiltOn = !this.tiltOn; this.ui.toast('Tilt-shift ' + (this.tiltOn ? 'on' : 'off')); }
      if (e.code === 'KeyM') this.ui.toast(this.audio.toggleMute() ? 'Muted' : 'Sound on');
      if (e.code === 'Escape' && this.ui.craftOpen) this.ui.toggleCraft(false);
    });
    addEventListener('keyup', (e) => { I.keys[e.code] = false; });
    addEventListener('blur', () => { I.keys = {}; I.lmb = I.rmb = I.mmb = false; });
    const cur = document.getElementById('cursor')!;
    addEventListener('mousemove', (e) => {
      if (I.mmb) this.camYawT -= (e.clientX - I.mx) * 0.008;
      I.mx = e.clientX; I.my = e.clientY;
      I.mouse.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
      cur.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    });
    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.started) return;
      if (this.ui.craftOpen) { this.ui.toggleCraft(false); return; }
      if (e.button === 0) { I.lmb = true; I.lmbPressed = true; }
      if (e.button === 2) I.rmb = true;
      if (e.button === 1) { I.mmb = true; e.preventDefault(); }
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) I.lmb = false;
      if (e.button === 2) I.rmb = false;
      if (e.button === 1) I.mmb = false;
    });
    addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('wheel', (e) => { this.camDistT = THREE.MathUtils.clamp(this.camDistT * (e.deltaY > 0 ? 1.15 : 1 / 1.15), ZOOM_MIN, ZOOM_MAX); }, { passive: true });
    document.getElementById('newgame')!.addEventListener('click', () => this.start());
    document.getElementById('continue')!.addEventListener('click', async () => { this.start(); await this.load(this.continueSlot, true); });
    document.getElementById('resume')!.addEventListener('click', () => this.togglePause(false));
    document.getElementById('psave')!.addEventListener('click', () => this.save('manual'));
    document.getElementById('pload')!.addEventListener('click', async () => { const last = await latestSave(); if (await this.load(last ? last.slot : 'manual')) this.togglePause(false); });
    document.getElementById('pnew')!.addEventListener('click', () => location.reload());
    document.getElementById('dead')!.addEventListener('click', () => { if (performance.now() - this.deadAt > 700) this.respawn(); });
    document.getElementById('win')!.addEventListener('click', () => { document.getElementById('win')!.classList.add('hidden'); this.paused = false; this.ui.toast('Endless mode: the nights keep coming.'); });
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.audio.init();
    if (this.audio.ctx && this.audio.ctx.state === 'suspended') this.audio.ctx.resume();
    document.getElementById('title')!.classList.add('hidden');
    document.getElementById('hud')!.classList.remove('hidden');
    this.ui.banner('Day 1');
    setTimeout(() => document.getElementById('hint')!.classList.add('faded'), 40000);
    this.camDistT = 36;
    this.ui.toast('Gather, build and survive. Press Tab to craft.');
  }

  onResize() {
    const w = innerWidth, h = innerHeight;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    const pr = this.pixelMode ? 0.34 : Math.min(devicePixelRatio, 1.75) * QUALITY_SCALE[this.qualityLevel];
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    const tw = w * pr, th = h * pr;
    this.tiltH.uniforms.uTexel.value.set(1 / tw, 1 / th);
    this.tiltV.uniforms.uTexel.value.set(1 / tw, 1 / th);
    this.grade.uniforms.uRes.value.set(tw, th);
    this.particles.setScale(th / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))));
    this.canvas.style.imageRendering = this.pixelMode ? 'pixelated' : 'auto';
  }
  togglePixel() { this.pixelMode = !this.pixelMode; this.onResize(); this.ui.toast('Pixel mode ' + (this.pixelMode ? 'on' : 'off')); }

  // ---------- gameplay API used by other modules ----------
  isNight() { return this.dayK < 0.3; }
  dayKAt(t: number) {
    const a = (t - 0.25) * Math.PI * 2, cx = Math.cos(a) * 0.8, sy = Math.sin(a);
    return THREE.MathUtils.smoothstep(sy / Math.sqrt(cx * cx + sy * sy + 0.2025), -0.12, 0.28);
  }
  // seconds until night falls (or dawn breaks); the switch time is searched once and then reused
  private switchAt = 0; private switchNight = false; private switchFrom = -1;
  timeToSwitch() {
    const night = this.isNight();
    const jumped = this.switchFrom < 0 || night !== this.switchNight || (this.time - this.switchFrom + 1) % 1 > 0.01;
    if (jumped) {
      this.switchNight = night; this.switchAt = this.time;
      for (let k = 1; k < 1000; k++) { const t = (this.time + k * 0.001) % 1; if ((this.dayKAt(t) < 0.3) !== night) { this.switchAt = t; break; } }
      this.switchFrom = this.time;
    }
    return ((this.switchAt - this.time + 1) % 1) * DAY_LENGTH;
  }
  // trauma-based shake: offset grows with trauma^2 and decays linearly
  shake(a: number) { this.trauma = Math.min(1, this.trauma + a * 0.6); }
  hitstop(s: number) { this.hitstopT = Math.max(this.hitstopT, s); }
  // run fn after `s` seconds of game time (respects pause, hitstop and slow-mo)
  after(s: number, fn: () => void) { this.timers.push({ t: s, fn }); }
  hitmarker() { const c = document.getElementById('cursor')!; c.classList.remove('hit'); void c.offsetWidth; c.classList.add('hit'); }

  flash(pos: THREE.Vector3, power = 40, dur = 0.25, color = 0xffa040) {
    const f = this.flashLights.reduce((a, b) => (a.t <= 0 ? a : (b.t <= 0 ? b : (a.t < b.t ? a : b))));
    f.l.position.copy(pos); f.l.color.setHex(color); f.t = dur; f.max = dur; f.power = power;
  }

  select(i: number) {
    this.sel = i;
    const s = this.hotbar[i];
    this.player.setModel(s.id === 'turret' ? 'turret' : s.id);
    this.audio.click();
  }

  canAfford(cost: Record<string, number>) { return Object.entries(cost).every(([k, v]) => (this.inv[k] | 0) >= v); }
  craft(i: number) {
    const rc = this.recipes[i];
    if (!this.canAfford(rc.cost)) { this.audio.deny(); this.ui.toast('Not enough materials'); return; }
    for (const [k, v] of Object.entries(rc.cost)) this.inv[k] -= v;
    for (const [k, v] of Object.entries(rc.give)) this.inv[k] = (this.inv[k] | 0) + v;
    this.audio.craft();
    this.ui.toast('Crafted ' + rc.name, 'good');
  }
  collect(res: string, n: number) {
    this.inv[res] = (this.inv[res] | 0) + n;
    this.audio.pickup();
    const p = this.player.pos;
    this.ui.floatText(p.x, p.y + 2, p.z, '+' + n + ' ' + res, { wood: '#e0b070', stone: '#d0d0d0', metal: '#a8d8ff', goo: '#8aff6a' }[res] || '#fff');
  }
  useMedkit() {
    if (this.player.dead) return;
    if (this.inv.medkit <= 0) { this.audio.deny(); this.ui.toast('No medkits - craft one (goo + wood)'); return; }
    if (this.player.hp >= this.player.maxHp) return;
    this.inv.medkit--;
    this.player.hp = Math.min(this.player.maxHp, this.player.hp + 50);
    this.audio.craft();
    const p = this.player.pos;
    this.ui.floatText(p.x, p.y + 2, p.z, '+50', '#7aff8a');
    for (let i = 0; i < 12; i++) this.particles.glow.spawn(p.x + (Math.random() - 0.5), p.y + Math.random() * 2, p.z + (Math.random() - 0.5), 0, 1.5, 0, 0.8, 0.25, 0.05, 0.6, 3, 0.8, 1);
  }

  offerUpgrades() {
    if (this.player.dead) { this.after(1, () => this.offerUpgrades()); return; } // not on top of the death screen
    this.ui.toggleCraft(false);
    const all: Upgrade[] = [
      { name: 'Thick Skin', desc: '+30 max HP and a full heal', icon: 'medkit', apply: () => { this.player.maxHp += 30; this.player.hp = this.player.maxHp; } },
      { name: 'Hot Loads', desc: '+30% gun damage', icon: 'ammo', apply: () => { this.mods.dmg *= 1.3; } },
      { name: 'Fleet Foot', desc: '+15% move speed', icon: 'grenade', apply: () => { this.mods.speed *= 1.15; } },
      { name: 'Demolition', desc: 'Explosions 35% bigger', icon: 'tnt', apply: () => { this.mods.blast *= 1.35; } },
      { name: 'Prospector', desc: 'Mine twice as fast', icon: 'pick', apply: () => { this.mods.mine *= 2; } },
      { name: 'Engineer', desc: '+1 turret, turrets fire 40% faster', icon: 'turret', apply: () => { this.inv.turret++; this.mods.turret *= 0.6; } },
      { name: 'Quartermaster', desc: '+60 rounds, +12 shells, +3 rockets', icon: 'rocket', apply: () => { this.inv.ammo += 60; this.inv.shells += 12; this.inv.rockets += 3; } },
      { name: 'Magnet', desc: 'Grab pickups from much further away', icon: 'metal', apply: () => { this.mods.magnet = 8; } },
      { name: 'Mason', desc: '+20 bricks, +20 planks, +4 TNT', icon: 'bricks', apply: () => { this.inv.bricks += 20; this.inv.planks += 20; this.inv.tnt += 4; } },
    ];
    const pick = all.sort(() => Math.random() - 0.5).slice(0, 3);
    this.paused = true;
    this.ui.showUpgrades(pick, (u: Upgrade) => { u.apply(); this.paused = false; this.audio.craft(); this.ui.toast(u.name + ' acquired', 'good'); });
  }

  onBossDefeated(boss: Entity) {
    this.won = true;
    this.hitstop(0.25);
    this.shake(1);
    this.explode(boss.center(new THREE.Vector3()), 3, 4, 'boss');
    this.after(2.5, () => {
      document.getElementById('winstats')!.textContent = `${this.kills} kills across ${this.nightCount} nights. The island is yours, for now.`;
      document.getElementById('win')!.classList.remove('hidden');
      this.paused = true;
    });
  }

  onPlayerHurt(amt: number) {
    this.hurtFx = Math.min(1, this.hurtFx + amt / 25);
    this.shake(0.4);
    this.hitstop(0.07);
    this.audio.hurt();
  }
  onPlayerDeath(_cause?: string) {
    this.deadAt = performance.now();
    this.ui.toggleCraft(false);
    const night = this.isNight();
    document.getElementById('deadstats')!.textContent = `Survived to ${night ? 'night ' + this.nightCount : 'day ' + (this.nightCount + 1)} with ${this.kills} kills.`;
    document.getElementById('dead')!.classList.remove('hidden');
    // (the sun-facing shadow caster and blob shadow too: a dead player's shadow stayed on the ground)
    const pl = this.player; pl.mesh.visible = pl.xray.visible = pl.gunHolder.visible = pl.caster.visible = pl.blob.visible = false;
    this.particles.blood(this.player.pos.x, this.player.pos.y + 1, this.player.pos.z, [0.6, 0.05, 0.05], 30);
  }
  // the night-3 boss walks in from somewhere she can actually reach the player; if there is no such
  // spot right now (a lone peak, the flow field still computing) she tries again a few seconds later
  spawnBoss() {
    if (this.won || this.boss || !this.isNight()) return;
    const b = this.player.dead ? null : this.entities.spawnAround('boss', 26, 36);
    if (!b) { this.after(4, () => this.spawnBoss()); return; }
    this.boss = b;
    this.ui.banner('The Brood Mother'); this.ui.toast('Something huge is coming. Kill it!', 'bad');
  }

  respawn() {
    const p = this.player;
    if (!p.dead) return;
    // the castle may have been unloaded while the player roamed: generate it before standing on it
    this.world.generateAround(this.spawnPoint.x, this.spawnPoint.z, 1);
    this.respawnAt(new THREE.Vector3(this.spawnPoint.x, this.world.surfaceY(Math.floor(this.spawnPoint.x), Math.floor(this.spawnPoint.z)) + 0.1, this.spawnPoint.z));
    // clear hostiles close to spawn for a fair restart
    // (removed quietly: die() counted them as kills and dropped their loot)
    for (const e of this.entities.enemies) if (e.kind !== 'boss' && !e.dead && e.pos.distanceTo(p.pos) < 16) { e.dead = true; e.removeSprite(); }
  }

  respawnAt(pos: THREE.Vector3) {
    const p = this.player;
    document.getElementById('dead')!.classList.add('hidden');
    p.dead = false; p.hp = p.maxHp; p.burn = 0; p.invuln = 2;
    p.pos.copy(pos);
    p.vel.set(0, 0, 0);
    p.mesh.visible = p.xray.visible = p.gunHolder.visible = p.caster.visible = p.blob.visible = true;
  }

  // ---------- save / load ----------
  async save(slot: Slot) {
    if (this.saving || (slot === 'auto' && this.player.dead)) return;
    this.saving = true;
    try {
      const bytes = await saveGame(this, slot);
      this.ui.toast(slot === 'auto' ? 'Autosaved' : `Game saved (${Math.round(bytes / 1024)} KB)`, 'good');
    } catch (e) { console.error(e); this.ui.toast('Save failed: ' + (e as Error).message, 'bad'); }
    this.saving = false;
  }
  async load(slot: Slot, quiet = false) {
    try {
      const ok = await loadGame(this, slot);
      if (!ok) { if (!quiet) this.ui.toast('No saved game in that slot', 'bad'); return false; }
      this.ui.toast('Game loaded', 'good');
      this.ui.banner(this.isNight() ? 'Night ' + this.nightCount : 'Day ' + (this.nightCount + 1));
      return true;
    } catch (e) { console.error(e); this.ui.toast('Load failed: ' + (e as Error).message, 'bad'); return false; }
  }
  // upgrade picker or victory screen showing: they own the pause state
  modalOpen() { return !document.getElementById('upgrade')!.classList.contains('hidden') || !document.getElementById('win')!.classList.contains('hidden'); }
  togglePause(force?: boolean) {
    const el = document.getElementById('pause')!;
    const show = force ?? el.classList.contains('hidden');
    el.classList.toggle('hidden', !show);
    this.paused = show;
  }

  onBlockDestroyed(x: number, y: number, z: number, t: number, cause: string) {
    const bd = BLOCKS[t];
    const explosive = cause === 'explosion';
    this.physics.burstBlock(x, y, z, t, explosive ? 9 : 4, explosive ? (Math.random() < 0.5 ? 1 : 2) : 3);
    this.particles.chips(x + 0.5, y + 0.5, z + 0.5, bd.cSide, explosive ? 2 : 6);
    if (!explosive) this.audio.break_(0.8);
    // blasts throw intact blocks around as rigid bricks
    // (never explosives or crates: a barrel both blew up and landed as a fresh barrel, a crate paid out its loot and
    // landed as a crate to loot again. A thrown block is the block itself, so it drops no resources either)
    const rigid = this.physics.rigid;
    let thrown = false;
    if (explosive && rigid && t !== B.LEAVES && t !== B.TNT && t !== B.BARREL && t !== B.CRATE && this.lastBlast && Math.random() < (bd.anchored ? 0.12 : 0.45)) {
      thrown = true;
      const c = this.lastBlast;
      const dx = x + 0.5 - c.x, dy = y + 0.5 - c.y, dz = z + 0.5 - c.z;
      const d = Math.max(0.5, Math.hypot(dx, dy, dz));
      const sp = 9 + Math.random() * 6;
      rigid.addBrick(x + 0.5, y + 0.5, z + 0.5, t, dx / d * sp, Math.abs(dy / d) * sp + 4, dz / d * sp);
    }
    if (t === B.BARREL) {
      // oil barrel: short fuse, then a fiery blast that lights everything around it
      const c = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5);
      this.after(explosive ? 0.08 + Math.random() * 0.2 : 0.25, () => {
        this.explode(c, 3.6, 13, 'barrel');
        for (let i = 0; i < 40; i++) this.world.ignite(x + Math.round((Math.random() - 0.5) * 7), y + Math.round((Math.random() - 0.5) * 3), z + Math.round((Math.random() - 0.5) * 7), true);
        for (let i = 0; i < 30; i++) this.particles.fire(c.x + (Math.random() - 0.5) * 4, c.y, c.z + (Math.random() - 0.5) * 4);
      });
    }
    if (t === B.TNT) {
      this.physics.primeTNT(x + 0.5, y + 0.5, z + 0.5, explosive || cause === 'fire' ? 0.15 + Math.random() * 0.35 : 1.5);
    }
    const playerCaused = cause === 'mine' || cause === 'bullet' || cause === 'explosion';
    if (bd.drop && playerCaused && !thrown) {
      for (const [res, n] of Object.entries(bd.drop)) {
        if (explosive && Math.random() > 0.35) continue;
        this.entities.addPickup(res, n, x + 0.5, y + 0.6, z + 0.5);
      }
    }
    if (t === B.CRATE && cause !== 'fire') {
      const loot = ([['ammo', 20], ['shells', 6], ['grenades', 2], ['rockets', 1], ['goo', 2]] as [string, number][])[(Math.random() * 5) | 0];
      if (loot[0] === 'goo') this.entities.addPickup('goo', 2, x + 0.5, y + 0.6, z + 0.5);
      else { this.inv[loot[0]] += loot[1]; this.ui.toast(`Crate: +${loot[1]} ${loot[0]}`, 'good'); }
    }
    if (this.batch) this.batch.push([x, y, z]);
    else this.checkSupport([[x, y, z]]);
  }

  checkSupport(cells: number[][]) {
    const clusters = this.world.findFloating(cells);
    for (const cl of clusters) {
      for (const [x, y, z] of cl) this.world.set(x, y, z, B.AIR);
      this.physics.addChunk(cl);
    }
  }

  explode(pos: THREE.Vector3, radius: number, power: number, source?: string) {
    const w = this.world;
    if (source === 'rocket' || source === 'grenade' || source === 'tnt' || source === 'barrel') { radius *= this.mods.blast; power *= Math.sqrt(this.mods.blast); }
    this.lastBlast = pos;
    this.lastDamagePos = pos.clone();
    // destroyed cells are collected and support-checked once at the end; the batch is always handed back (a throw
    // in between used to leave it set for good, silently disabling every later collapse)
    const outer = this.batch, removed: number[][] = this.batch = [];
    try {
      const r = Math.ceil(radius);
      const cx = Math.floor(pos.x), cy = Math.floor(pos.y), cz = Math.floor(pos.z);
      for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx, y = cy + dy, z = cz + dz;
        const d = Math.hypot(x + 0.5 - pos.x, y + 0.5 - pos.y, z + 0.5 - pos.z);
        if (d > radius) continue;
        const t = w.get(x, y, z);
        if (!t) continue;
        // explosives anywhere in the blast go off (chain reactions), however little damage reaches them
        const dmg = t === B.TNT || t === B.BARREL ? 99 : power * (1 - d / radius) * (0.75 + Math.random() * 0.5);
        if (w.damageBlock(x, y, z, dmg, 'explosion') > 0 && d > radius * 0.5 && Math.random() < 0.4) w.ignite(x, y, z);
      }
    } finally { this.batch = outer; }
    if (outer) outer.push(...removed);
    else if (removed.length) this.checkSupport(removed);
    // entities
    const R = radius * 1.7;
    const c = new THREE.Vector3();
    for (const e of this.entities.all()) {
      e.center(c);
      const d = c.distanceTo(pos);
      if (d > R) continue;
      const k = 1 - d / R;
      const dir = c.sub(pos).normalize();
      const knock = dir.multiplyScalar(14 * k); knock.y = Math.max(knock.y, 0) + 8 * k;
      let dmg = power * 7 * k;
      if (e.kind === 'player') dmg *= 0.45;
      e.damage(dmg, knock, 'explosion');
      if (k > 0.45 && e.kind !== 'turret') e.burn = Math.max(e.burn, 2.5);
    }
    this.physics.impulse(pos, radius * 2.2, 16);
    this.particles.explosion(pos.x, pos.y, pos.z, radius * 0.6);
    this.flash(pos.clone().add(new THREE.Vector3(0, 1, 0)), 160 * radius, 0.45, 0xff9a40);
    const pd = pos.distanceTo(this.player.pos);
    this.shake(Math.max(0, 1.1 - pd / 30) * (radius / 3.5));
    if (pd < 18) this.hitstop(0.08);
    this.audio.explosion(radius / 3.5, Math.max(0.15, 1 - pd / 50));
    void source;
  }

  burnEntitiesNear(x: number, y: number, z: number, _dt?: number) {
    for (const e of this.entities.all()) {
      if (e.kind === 'turret') continue;
      if (Math.abs(e.pos.x - x) < 1.1 && Math.abs(e.pos.z - z) < 1.1 && Math.abs(e.pos.y + 0.3 - y) < 1.3) e.burn = Math.max(e.burn, 2.5);
    }
  }

  // ---------- per-frame player actions ----------
  updateAim() {
    const I = this.input, p = this.player;
    this.raycaster = this.raycaster || new THREE.Raycaster();
    this.raycaster.setFromCamera(I.mouse, this.camera);
    const ray = this.raycaster.ray;
    // ignore blocks the roof-cutaway shader is currently hiding
    const cam = this.camera.position, pp = p.pos;
    _toP.set(pp.x - cam.x, pp.y - cam.y, pp.z - cam.z);
    _cutL = _toP.length(); _toP.divideScalar(_cutL);
    _cutCam = cam;
    _cutY = sharedUniforms.uCutY.value;
    _cutTerrain = sharedUniforms.uTerrainCut.value;
    const vox = this.world.raycast(ray.origin, ray.direction, 220, cutaway);
    // enemies anywhere along the ray, not just in front of the first voxel: one hidden behind a tree or
    // a hillside still shows as a silhouette under the cursor, and clicking it used to aim at the canopy
    // (upward) or the slope instead. The pick is padded so a click on a small sprite (a crawler, whose
    // body sits below the level of a ground-click shot) still counts.
    const ent = this.entities.raycast(ray.origin, ray.direction, 220, p, 0.35);
    const gun = _gun.set(p.pos.x, p.pos.y + 0.95, p.pos.z);
    const planeY = p.pos.y + 0.95;
    const aim = this.aimPoint = this.aimPoint || new THREE.Vector3();
    // aim at whatever is under the cursor, in full 3D: an enemy, a wall face, or chest height above
    // clicked ground (shots then fly level over flat ground, but go down into a valley or up a hill)
    if (ent && ent.e !== p) ent.e.center(aim);
    else if (vox.hit) { aim.copy(vox.point); if (vox.ny === 1) aim.y += 0.9; }
    else {
      const t = (planeY - ray.origin.y) / ray.direction.y;
      if (t > 0) aim.copy(ray.origin).addScaledVector(ray.direction, t);
      else { aim.copy(gun); aim.z += 1; }
    }
    const d = _d.copy(aim).sub(gun);
    if (d.lengthSq() < 0.04) d.set(p.facing.x, 0, p.facing.y);
    p.aimDir.copy(d.normalize());
    // hovered block within reach (for mining / building)
    this.hover = null;
    if (vox.hit) {
      _cc.set(vox.x + 0.5, vox.y + 0.5, vox.z + 0.5);
      if (_cc.distanceTo(gun) < REACH) this.hover = vox;
    }
  }

  updateActions(dt: number) {
    const I = this.input, p = this.player, inv = this.inv;
    if (p.dead || this.ui.craftOpen) { this.hoverBox.visible = this.ghost.visible = false; return; }
    const s = this.hotbar[this.sel];
    this.fireCd -= dt; this.mineCd -= dt;
    const muzzle = _muzzle.set(p.pos.x, p.pos.y + 0.95, p.pos.z).addScaledVector(p.aimDir, 0.75);
    const placing = s.place || s.turret;
    // hover visuals
    this.hoverBox.visible = !!this.hover && !!(I.rmb || placing);
    this.ghost.visible = false;
    if (this.hover) {
      this.hoverBox.position.set(this.hover.x + 0.5, this.hover.y + 0.5, this.hover.z + 0.5);
      if (placing) {
        const tx = this.hover.x + this.hover.nx, ty = this.hover.y + this.hover.ny, tz = this.hover.z + this.hover.nz;
        this.ghost.position.set(tx + 0.5, ty + 0.5, tz + 0.5);
        this.ghost.material.color.copy(s.place ? BLOCKS[s.place].cSide : C_TURRET_GHOST);
        this.ghost.visible = true;
        this.hoverBox.visible = false;
      }
    }
    // primary
    const trigger = (s.gun && s.gun.auto) ? I.lmb : I.lmbPressed;
    if (trigger && this.fireCd <= 0) {
      if (s.ammo && (inv[s.ammo] | 0) <= 0) { if (I.lmbPressed) { this.audio.deny(); this.ui.toast(`Out of ${s.name} ammo - craft more (Tab)`); } }
      else if (s.gun) {
        const G = s.gun;
        this.fireCd = G.cool;
        if (s.ammo) inv[s.ammo]--;
        for (let k = 0; k < (G.pellets || 1); k++) this.projectiles.bullet(muzzle, p.aimDir, { dmg: G.dmg * this.mods.dmg, speed: G.speed, spread: G.spread, blockDmg: G.blockDmg, knock: G.knock, owner: p });
        this.particles.muzzle(muzzle.x, muzzle.y, muzzle.z, p.aimDir);
        this.flash(muzzle, 25, 0.06, 0xffc070);
        p.recoil = 1;
        if (G.kick) { p.vel.x -= p.aimDir.x * G.kick; p.vel.z -= p.aimDir.z * G.kick; }
        this.shake(s.id === 'shotgun' ? 0.35 : s.id === 'smg' ? 0.05 : 0.1);
        this.audio.shot(s.id);
        // eject a brass casing sideways
        const side = new THREE.Vector3(-p.aimDir.z, 0, p.aimDir.x);
        this.physics.addDebris(muzzle.x - p.aimDir.x * 0.5, muzzle.y + 0.1, muzzle.z - p.aimDir.z * 0.5, s.id === 'shotgun' ? SHELL_RED : BRASS, 0.09,
          side.x * 3 + (Math.random() - 0.5), 3 + Math.random() * 2, side.z * 3 + (Math.random() - 0.5), 3);
      } else if (s.rocket) {
        this.fireCd = 0.9; inv.rockets--;
        this.projectiles.rocket(muzzle, p.aimDir, p);
        this.particles.muzzle(muzzle.x, muzzle.y, muzzle.z, p.aimDir);
        p.recoil = 1.4; p.vel.x -= p.aimDir.x * 4; p.vel.z -= p.aimDir.z * 4;
        this.shake(0.25); this.audio.shot('rocket');
      } else if (s.grenade) {
        this.fireCd = 0.55; inv.grenades--;
        const target = this.aimPoint!.clone();
        const flat = Math.hypot(target.x - p.pos.x, target.z - p.pos.z);
        if (flat > 18) target.sub(p.pos).multiplyScalar(18 / flat).add(p.pos);
        this.projectiles.lob('grenade', muzzle, target, p);
        p.swing = 0.6; this.audio.dash();
      } else if (placing && this.hover) {
        const tx = this.hover.x + this.hover.nx, ty = this.hover.y + this.hover.ny, tz = this.hover.z + this.hover.nz;
        if (this.world.inBounds(tx, ty, tz) && !this.world.solid(tx, ty, tz) && !this.entities.blocksCell(tx, ty, tz)) {
          if (s.turret) {
            this.entities.turrets.push(new Turret(this, tx + 0.5, ty + 0.01, tz + 0.5));
            this.ui.toast('Turret deployed', 'good');
          } else if (s.place !== undefined) { this.world.set(tx, ty, tz, s.place); this.checkSupport([[tx, ty, tz]]); } // past its span it falls
          inv[s.ammo!]--;
          this.fireCd = 0.12;
          p.swing = 0.4;
          this.audio.place();
          this.particles.dust(tx + 0.5, ty, tz + 0.5, 4);
        } else this.audio.deny();
      }
    }
    // secondary: mine whatever is under the cursor
    if (I.rmb && this.hover && this.mineCd <= 0) {
      this.mineCd = 0.24;
      p.setModel('pick'); this.pickT = 0.5;
      p.swing = 1;
      const h = this.hover;
      const t = this.world.get(h.x, h.y, h.z);
      const left = this.world.damageBlock(h.x, h.y, h.z, 1.7 * this.mods.mine, 'mine');
      if (left > 0 && BLOCKS[t]) { this.particles.chips(h.point.x, h.point.y, h.point.z, BLOCKS[t].cSide, 4); this.audio.thunk(0.7); }
    }
    if (this.pickT > 0) { this.pickT -= dt; if (this.pickT <= 0) this.player.setModel(this.hotbar[this.sel].id); }
    I.lmbPressed = false;
  }

  // ---------- environment ----------
  updateDay(dt: number) {
    this.time = (this.time + dt / DAY_LENGTH) % 1;
    const a = (this.time - 0.25) * Math.PI * 2; // sunrise at 0.25, sunset at 0.75
    const sunDir = _sunDir.set(Math.cos(a) * 0.8, Math.sin(a), 0.45).normalize();
    const dayK = THREE.MathUtils.smoothstep(sunDir.y, -0.12, 0.28);
    this.dayK = dayK;
    const dusk = Math.max(0, 1 - Math.abs(sunDir.y) / 0.35) * (sunDir.y > -0.2 ? 1 : 0);
    const lightDir = sunDir.y > -0.05 ? sunDir : _lightDir.set(-sunDir.x, -sunDir.y, sunDir.z * 0.5 + 0.4).normalize();
    this.sun.position.copy(this.camTarget).addScaledVector(lightDir, SUN_DIST);
    this.sun.target.position.copy(this.camTarget);
    // the one shadow-casting light is the sun by day and the moon by night. It swaps direction at the
    // sun's y = -0.05, so both fade to nothing there: no brightness pop, no shadows jumping across the scene
    const moon = sunDir.y <= -0.05;
    this.sun.color.copy(moon ? C_MOON : _sunCol.copy(C_SUN).lerp(C_DUSK, dusk * 0.8));
    this.sun.intensity = moon ? 0.85 * THREE.MathUtils.smoothstep(-sunDir.y, 0.05, 0.2) : 2.7 * dayK * THREE.MathUtils.smoothstep(sunDir.y, -0.05, 0.03);
    this.hemi.intensity = 0.45 + 0.65 * dayK;
    this.hemi.color.copy(C_HEMI_DAY).lerp(C_HEMI_NIGHT, 1 - dayK);
    this.hemi.groundColor.copy(C_GRD_DAY).lerp(C_GRD_NIGHT, 1 - dayK);
    const fog = _fog.copy(C_FOG_NIGHT).lerp(C_FOG_DAY, dayK).lerp(C_FOG_DUSK, dusk * 0.55);
    this.scene.fog!.color.copy(fog); (this.scene.background as THREE.Color).copy(fog);
    this.waterUniforms.uDay.value = 0.25 + dayK * 0.75;
    this.waterUniforms.uSky.value.copy(fog);
    sharedUniforms.uCloud.value = dayK;
    sharedUniforms.uCapLight.value = 0.3 + 0.7 * dayK;
    this.sunYaw = Math.atan2(lightDir.x, lightDir.z);
    this.spriteAmbient.copy(this.hemi.color).multiplyScalar(0.12 + 0.2 * dayK);
    if (dayK > 0.5 && Math.random() < dt * 10) {
      const pp = this.player.pos;
      const mx = pp.x + (Math.random() - 0.5) * 24, my = pp.y + 0.5 + Math.random() * 4, mz = pp.z + (Math.random() - 0.5) * 24;
      if (!this.world.solidAt(mx, my, mz)) this.particles.mote(mx, my, mz); // not inside a hillside
    }
    this.grade.uniforms.uNight.value = 1 - dayK;
    this.player.light.intensity = (1 - dayK) * 20; // (see Player.update: held out and up so the sprite isn't blown out)
    // lanterns near the player get real point lights
    this.lanternT -= dt;
    if (this.lanternT <= 0) {
      this.lanternT = 0.5;
      const w = this.world, pp = this.player.pos;
      // keep the nearest few lanterns (insertion into a tiny sorted list, no allocation)
      let n = 0;
      for (const i of w.lanterns) {
        const x = i % w.W, z = Math.floor(i / w.W) % w.D;
        const d = (x - pp.x) ** 2 + (z - pp.z) ** 2;
        if (d >= 40 * 40 || (n === LANTERN_LIGHTS && d >= this.lanternD[n - 1])) continue;
        let k = n < LANTERN_LIGHTS ? n++ : n - 1;
        while (k > 0 && this.lanternD[k - 1] > d) { this.lanternD[k] = this.lanternD[k - 1]; this.lanternI[k] = this.lanternI[k - 1]; k--; }
        this.lanternD[k] = d; this.lanternI[k] = i;
      }
      for (let k = 0; k < LANTERN_LIGHTS; k++) {
        const l = this.lanternLights[k];
        if (k < n) {
          const i = this.lanternI[k];
          l.position.set((i % w.W) + 0.5, Math.floor(i / (w.W * w.D)) + 0.5, (Math.floor(i / w.W) % w.D) + 0.5);
          l.userData.on = true;
        } else l.userData.on = false;
      }
    }
    for (const l of this.lanternLights) l.intensity = l.userData.on ? 4 + (1 - dayK) * 22 * (0.92 + Math.random() * 0.08) : 0;
    // nightfall
    const night = this.isNight();
    if (night && !this.wasNight) {
      this.nightCount++;
      this.ui.banner('Night ' + this.nightCount);
      this.ui.toast('The dead are rising... build defenses!', 'bad');
      this.audio.night();
      this.entities.spawnWave(6 + this.nightCount * 4);
      if (this.nightCount === 3 && !this.won) this.spawnBoss();
    } else if (!night && this.wasNight) {
      this.ui.banner('Day ' + (this.nightCount + 1));
      this.ui.toast('You survived the night.', 'good');
      if (!this.player.dead) { this.after(0.5, () => this.save('auto')); this.after(1.8, () => this.offerUpgrades()); }
    }
    this.wasNight = night;
    if (night && Math.random() < dt * 6) {
      const pp = this.player.pos;
      const x = pp.x + (Math.random() - 0.5) * 30, z = pp.z + (Math.random() - 0.5) * 30;
      const y = this.world.surfaceY(Math.floor(x), Math.floor(z)) + 0.5 + Math.random() * 1.5;
      // only near the player's own level (not on a peak far overhead, where the cutaway hides them anyway)
      if (y > WATER_LEVEL && Math.abs(y - pp.y) < 16) this.particles.firefly(x, y, z);
    }
  }

  /** where the world streams and the camera looks: the explored spot, else the player (or the title-screen orbit) */
  focus(): THREE.Vector3 {
    return this.explore ?? (this.started && this.player ? this.player.pos : this.camTarget);
  }

  /** fly the camera to (x, z) and stream the world in there; gameplay pauses until stopExplore() */
  startExplore(x: number, z: number): void {
    const w = this.world;
    x = THREE.MathUtils.clamp(x, 0, w.W - 1); z = THREE.MathUtils.clamp(z, 0, w.D - 1);
    if (!this.explore) this.ui.toast('Exploring: drag the map or WASD to pan, wheel to zoom, Esc to return');
    (this.explore ??= new THREE.Vector3()).set(x, w.surfaceY(x, z), z);
  }
  stopExplore(): void {
    if (!this.explore) return;
    this.explore = null;
    this.ui.toast('Back to the player');
  }

  // explore mode: WASD pans the explored spot (camera-relative, faster when zoomed out)
  private updateExplore(rdt: number): void {
    const e = this.explore!, k = this.input.keys, sp = this.camDist * 0.9 * rdt;
    const fx = -Math.sin(this.camYaw), fz = -Math.cos(this.camYaw);
    const f = (k.KeyW ? 1 : 0) - (k.KeyS ? 1 : 0), s2 = (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0);
    if (f || s2) this.startExplore(e.x + (fx * f - fz * s2) * sp, e.z + (fz * f + fx * s2) * sp);
    else e.y += (this.world.surfaceY(e.x, e.z) - e.y) * Math.min(1, rdt * 4); // follow terrain as it streams in
  }

  updateCamera(dt: number) {
    const p = this.player;
    const k = 1 - Math.exp(-dt * (this.started ? 7 : 2));
    // camera leads a little toward where you're aiming
    if (this.started && this.aimPoint && !p.dead) {
      const want = _want.copy(this.aimPoint).sub(p.pos).setY(0).multiplyScalar(0.18);
      if (want.length() > 5) want.setLength(5);
      this.lead.lerp(want, 1 - Math.exp(-dt * 4));
    }
    const ex = this.explore;
    const focus = ex ? _focus.set(ex.x, ex.y + 0.9, ex.z)
      : this.started ? _focus.set(p.pos.x + this.lead.x, p.pos.y + 0.9, p.pos.z + this.lead.z) : _focus.set(this.world.gen.spawn.x, this.world.gen.spawn.g + 2, this.world.gen.spawn.z);
    // fly quickly to a far explored spot, then settle
    this.camTarget.lerp(focus, ex ? 1 - Math.exp(-dt * 5) : k);
    this.camYaw += (this.camYawT - this.camYaw) * (1 - Math.exp(-dt * 9));
    this.camDist += (this.camDistT - this.camDist) * (1 - Math.exp(-dt * 8));
    // In a valley, steepen the tilt so the camera looks down over the ridge on its side instead of into
    // it (up to CAM_PITCH_MAX; anything taller is handled by the terrain cutaway below)
    const wide = !!ex || this.camDist > 100; // explore / zoomed-out views skip the close-up framing helpers
    const want = this.started && !wide ? this.valleyPitch() : CAM_PITCH;
    this.camPitch += (want - this.camPitch) * (1 - Math.exp(-dt * (want > this.camPitch ? 3 : 1.5)));
    const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch);
    // camera collision: never sit inside a mountain (looking out from inside rock shows the sky through
    // its back faces). Pull in quickly when the boom would end up in terrain, ease back out after.
    const free = this.started && !wide ? this.boomLength(cp, sp) : this.camDist;
    this.camBoom = free < this.camBoom ? this.camBoom + (free - this.camBoom) * (1 - Math.exp(-dt * 12)) : this.camBoom + (free - this.camBoom) * (1 - Math.exp(-dt * 2));
    const dist = Math.min(this.camDist, this.camBoom);
    const c = this.camera;
    c.position.set(
      this.camTarget.x + Math.sin(this.camYaw) * cp * dist,
      this.camTarget.y + sp * dist,
      this.camTarget.z + Math.cos(this.camYaw) * cp * dist);
    c.lookAt(this.camTarget);
    if (this.trauma > 0) {
      const s = this.trauma * this.trauma, t = performance.now() * 0.001;
      c.position.x += shakeNoise(t, 31, 1) * s * 0.7; c.position.y += shakeNoise(t, 29, 2) * s * 0.7; c.position.z += shakeNoise(t, 37, 3) * s * 0.7;
      c.rotateZ(shakeNoise(t, 23, 4) * s * 0.035);
      this.trauma = Math.max(0, this.trauma - dt * 1.4);
    }
    sharedUniforms.uPlayer.value.copy(p.pos);
    sharedUniforms.uCam.value.copy(c.position);
    // no cutaway in wide views (nothing to see through to, and the player may be kilometres away)
    const cutY = this.started && !wide ? Math.floor(p.pos.y + 0.05) + 2 : 10000;
    sharedUniforms.uCutY.value = cutY;
    this.world.updateCap(cutY, p.pos.x, p.pos.z);
    // terrain cutaway: on while hills or cliffs above the cut plane hide the player (or the ground just
    // beside them), held briefly so it doesn't flicker as the player walks along a ridge line, and
    // faded in and out (the shader dithers the edge of the cut circle as its radius grows)
    // When even the pulled-in camera is buried in a mountainside, or skims just over one (the slope would
    // fill the bottom of the screen, blurred, right in front of the lens), the circle widens to most of
    // the screen: everything above the player's head on the camera's side of them is sliced off, dollhouse style.
    const buried = this.started && this.world.gen.heightAt(c.position.x, c.position.z) + CAM_SKIM > c.position.y;
    if (this.started && !wide && !p.dead && (buried || this.terrainOccludes(c.position, cutY))) this.terrainCutHold = 0.6;
    else this.terrainCutHold -= dt;
    const tc = sharedUniforms.uTerrainCut, goal = this.terrainCutHold > 0 ? (buried ? TERRAIN_CUT_WIDE : 1) : 0;
    tc.value = goal > tc.value ? Math.min(goal, tc.value + dt * 4 * Math.max(1, goal)) : Math.max(goal, tc.value - dt * 2.5);
    // the slice through the rock is drawn by a plane at the cut height (see makeCapPlane)
    if (!this.capPlane) { this.capPlane = makeCapPlane(); this.scene.add(this.capPlane); }
    placeCapPlane(this.capPlane, cutY);
    this.zoomScale(dist);
  }

  // Zoomed out: stream voxels further, thin the fog, widen the shadow box and push the far plane, so
  // the whole streamed voxel world is on screen (far-terrain rings take over beyond it)
  private zoomedAt = -1;
  private zoomScale(dist: number): void {
    this.world.renderRadius = THREE.MathUtils.clamp(RENDER_RADIUS + Math.floor((dist - 50) / 45), RENDER_RADIUS, MAX_RENDER_RADIUS);
    if (Math.abs(dist - this.zoomedAt) < dist * 0.04) return;
    this.zoomedAt = dist;
    const z = Math.max(1, dist / 46);
    (this.scene.fog as THREE.FogExp2).density = FOG_DENSITY / z;
    const c = this.camera, far = Math.max(CAM_FAR, dist * 4);
    if (c.far !== far) { c.far = far; c.updateProjectionMatrix(); }
    const sc = this.sun.shadow.camera, ext = Math.min(34 * z, 420);
    sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.updateProjectionMatrix();
  }

  private terrainCutHold = 0;
  private capPlane: THREE.Mesh | null = null;
  readonly shared = sharedUniforms; // (for tests and the console)
  private camBoom = 72;
  // how far the camera can back away from its target along the current yaw/pitch before entering the
  // terrain (analytic height map: cheap, and structures are handled by the cutaway anyway)
  private boomLength(cp: number, sp: number): number {
    const t = this.camTarget, gen = this.world.gen;
    const dx = Math.sin(this.camYaw) * cp, dz = Math.cos(this.camYaw) * cp;
    for (let d = 4; d <= this.camDist; d += 1.5) {
      if (gen.heightAt(t.x + dx * d, t.z + dz * d) + 2.5 > t.y + sp * d) return Math.max(CAM_MIN_DIST, d - 3);
    }
    return this.camDist;
  }
  // does terrain above the cut plane stand between the camera and the player? Probes from the player's
  // feet, middle and head, and from points a little to either side, toward the camera.
  private terrainOccludes(cam: THREE.Vector3, cutY: number): boolean {
    const p = this.player.pos;
    _occCutY = cutY;
    _camR.set(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw)); // camera right
    for (let i = 0; i < 5; i++) {
      const side = i < 3 ? 0 : (i === 3 ? -1.8 : 1.8);
      _occO.set(p.x + _camR.x * side, p.y + (i < 3 ? 0.3 + i * 0.65 : 0.9), p.z + _camR.z * side);
      _occD.subVectors(cam, _occO);
      const L = _occD.length();
      if (L < 1) continue;
      _occD.divideScalar(L);
      if (this.world.raycast(_occO, _occD, L, occluder).hit) return true;
    }
    return false;
  }

  // the tilt needed to see over the terrain between the player and the camera (sampled from the
  // analytic height map along the camera's ground track), clamped to [CAM_PITCH, CAM_PITCH_MAX]
  private valleyPitch(): number {
    const p = this.player.pos, gen = this.world.gen;
    const dx = Math.sin(this.camYaw), dz = Math.cos(this.camYaw);
    const eye = this.camTarget.y, reach = Math.cos(CAM_PITCH) * this.camDist;
    let need = CAM_PITCH;
    for (let s = 3; s <= reach; s += 2) {
      const h = gen.heightAt(p.x + dx * s, p.z + dz * s) + 2.5; // top of the terrain plus the clearance boomLength keeps
      if (h > eye) need = Math.max(need, Math.atan2(h - eye, s));
    }
    return Math.min(CAM_PITCH_MAX, need);
  }

  // frame-rate readout (frames and the slowest frame over the last half second)
  private fpsEl: HTMLElement | null = null;
  private fpsN = 0; private fpsT = 0; private fpsWorst = 0;
  private updateFps(raw: number): void {
    this.fpsN++; this.fpsT += raw; this.fpsWorst = Math.max(this.fpsWorst, raw);
    if (this.fpsT < 0.5) return;
    const el = this.fpsEl ??= document.getElementById('fps');
    if (el) {
      const fps = this.fpsN / this.fpsT;
      el.textContent = `${fps.toFixed(0)} fps · ${(this.fpsWorst * 1000).toFixed(0)} ms`;
      el.style.color = fps >= 55 ? '#b8ff8a' : fps >= 30 ? '#ffe08a' : '#ff8a7a';
    }
    this.fpsN = 0; this.fpsT = 0; this.fpsWorst = 0;
  }

  frame() {
    const raw = this.clock.getDelta();
    this.updateFps(raw);
    this.step(Math.min(raw, 1 / 20));
    const ao = this.aoOn ? 2.2 : 0;
    if (this.ao.configuration.intensity !== ao) this.ao.configuration.intensity = ao;
    this.camera.updateMatrixWorld();
    const shafts = this.shaftsOn && this.qualityLevel < 2;
    this.shafts.update(this.camera, this.sun, this.ao.beautyRenderTarget.depthTexture!, this.player.pos.y - 1, shafts ? 0.35 + this.dayK : 0, performance.now() * 0.001);
    this.composer.render();
    if (this.autoQuality && this.started) this.scaleQuality(raw);
  }

  // Averages frame time over one second; two slow seconds in a row (< 45 fps) step the quality down a level.
  // There is no step back up (a vsync-capped fps can't show headroom), so it never oscillates.
  private scaleQuality(raw: number) {
    if (document.hidden || raw > 0.5) { this.qAcc = 0; this.qFrames = 0; this.qSlow = 0; return; }
    this.qAcc += raw; this.qFrames++;
    if (this.qAcc < 1) return;
    const fps = this.qFrames / this.qAcc;
    this.qAcc = 0; this.qFrames = 0;
    if (this.qGrace > 0) { this.qGrace--; return; }
    this.qSlow = fps < 45 ? this.qSlow + 1 : 0;
    if (this.qSlow >= 2 && this.qualityLevel < QUALITY_SCALE.length - 1) {
      this.qualityLevel++; this.qSlow = 0; this.qGrace = 2;
      this.onResize();
    }
  }

  // advance the simulation without rendering (also handy for fast-forwarding in tests)
  simulate(seconds: number, dt = 1 / 30) { for (let t = 0; t < seconds; t += dt) this.step(dt); }

  step(rdt: number) {
    this.slowmo += ((this.ui.craftOpen ? 0.2 : 1) - this.slowmo) * Math.min(1, rdt * 10);
    let stop = 1;
    if (this.hitstopT > 0) { this.hitstopT -= rdt; stop = 0.06; }
    const dt = this.paused || this.explore ? 0 : this.started ? rdt * this.slowmo * stop : rdt * 0.3;
    sharedUniforms.uTime.value += rdt;
    if (this.started && !this.paused && !this.player.dead) { this.autosaveT -= dt; if (this.autosaveT <= 0) { this.autosaveT = 120; this.save('auto'); } }
    for (let i = 0; i < this.timers.length; i++) { const tm = this.timers[i]; tm.t -= dt; if (tm.t <= 0) { this.timers.splice(i--, 1); tm.fn(); } }
    this.waterUniforms.uTime.value += rdt;
    this.updateShore(this.camTarget.x, this.camTarget.z);
    this.grade.uniforms.uTime.value += rdt;
    if (!this.started) {
      // attract mode: slow orbit over the island
      this.camYawT += rdt * 0.08;
      this.updateDay(0);
    } else {
      if (this.explore) this.updateExplore(rdt);
      else this.updateAim();
      if (!this.paused && !this.explore) { this.player.update(dt, this.input); this.updateActions(dt); }
      else this.input.lmbPressed = false; // a click made while paused must not fire on resume
      this.updateReticle();
      this.updateDay(dt);
    }
    this.entities.update(this.started ? dt : 0);
    this.projectiles.update(dt);
    this.physics.update(dt);
    this.world.updateFire(dt);
    this.waterSim.update(dt);
    this.particles.update(dt);
    const f = this.focus();
    this.world.stream(f.x, f.z, rdt);
    this.far.update(f.x, f.z);
    this.updateCamera(rdt);
    this.ocean.position.set(Math.round(this.camera.position.x / 64) * 64, WATER_LEVEL - 0.12, Math.round(this.camera.position.z / 64) * 64);
    for (const f of this.flashLights) { f.t -= rdt; f.l.intensity = f.t > 0 ? f.power * (f.t / f.max) : 0; }
    this.hurtFx = Math.max(0, this.hurtFx - rdt * 1.5);
    this.grade.uniforms.uHurt.value = this.hurtFx;
    this.tiltH.enabled = this.tiltV.enabled = this.tiltOn;
    if (this.started) { this.ui.update(rdt); this.minimap.update(rdt); }
    this.input.pressed = {};
  }
}

async function boot() {
  const go = document.querySelector('#title .go')!;
  go.textContent = 'loading physics and mesher...';
  // the voxel core lives in shared WebAssembly memory, which needs a cross-origin isolated page
  if (!self.crossOriginIsolated) { go.textContent = 'The voxel engine needs a cross-origin isolated page (COOP/COEP headers).'; return; }
  const [R, core] = await Promise.all([loadRapier(), VoxelCore.create()]);
  (window as unknown as { game: Game }).game = new Game(R, core, WasmMeshing.create(blockTable(), core));
  go.textContent = '';
  document.getElementById('titlebtns')!.classList.remove('hidden');
  const last = await latestSave();
  if (last) {
    (window as unknown as { game: Game }).game.continueSlot = last.slot;
    const mins = Math.round((Date.now() - last.savedAt) / 60000);
    const btn = document.getElementById('continue')!;
    btn.textContent = `Continue: night ${last.nightCount}, ${last.kills} kills (${mins < 1 ? 'just now' : mins + ' min ago'})`;
    btn.classList.remove('hidden');
  }
}
boot();
