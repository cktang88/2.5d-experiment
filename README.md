# Blockfall Isle: a 2.5D voxel survival sandbox

A browser game demo that mixes a fully 3D, destructible voxel world with hand-feel
2D pixel-art characters, in the spirit of Octopath Traveler's "HD-2D" look and
Don't Starve's billboarded sprites.

No image or audio assets: every sprite, texture, icon and sound is generated at runtime.

## Run it

A Vite + TypeScript web app (three.js r169, Rapier 0.21).

```sh
npm install
npm run dev        # dev server with hot reload, then open the printed URL
npm run build      # typecheck (tsc) + production build into dist/
npm run preview    # serve the production build
```

Pushes to `main` are built by GitHub Actions and deployed to GitHub Pages
(enable it once under **Settings → Pages → Source: GitHub Actions**).

## Controls

| Input | Action |
| --- | --- |
| WASD | move (camera-relative) |
| Space / Shift | jump / dash |
| Left mouse | shoot, throw, or place the selected item |
| Right mouse | mine the block under the cursor |
| 1–0 | pick a hotbar slot: pistol, shotgun, SMG, rocket, grenade, planks, bricks, TNT, turret, lantern |
| Q / E, middle-drag | rotate the camera |
| Mouse wheel | zoom |
| Tab or C | crafting (time slows while it's open) |
| H | use a medkit |
| P / O / M | pixel mode / tilt-shift / mute |

## What's in it

**2.5D rendering** (choices informed by write-ups on HD-2D, Don't Starve, Teardown and others)
- Each material has a procedural 16×16 pixel-art detail texture applied in world space: brick courses, planks, cobbles, bark, shingles, ore flecks.
- Sprites cast shadows from an invisible caster that always faces the sun, so the shadow keeps the character's silhouette at any camera angle. They also get an ambient-tinted emissive pass so they sit in the scene's light instead of looking pasted on.
- Game feel:
  - Hitstop on kills and blasts.
  - Trauma-based camera shake with a little roll.
  - The camera leads toward where you aim.
  - Enemies stagger and squash when hit.
  - Guns eject shell casings, and dust motes drift in sunlight.
- Voxel chunks meshed with per-vertex ambient occlusion, painterly colour patches, and drifting cloud shadows.
- Characters are procedurally drawn pixel-art sprite sheets on camera-facing cards that lean back toward the camera. They have front, back and side views plus walk cycles, are lit by the scene, and cast real shadows.
- Held weapons are small 3D models that rotate around the 2D sprite to aim in full 3D.
- Post-processing: tilt-shift miniature blur, bloom, split-tone colour grading, vignette and grain.
- Day/night cycle with sunsets, moonlight, fireflies, lantern blocks that get real point lights, and a lantern the player carries at night.

**Things a flat top-down game can't do**
- Rotate the camera freely around the scene.
- Height matters. You can jump onto walls, climb the watchtowers, and shoot down from battlements, while grenades and spitter acid arc over cover.
- Roofs and walls between you and the camera are cut away along a plane, with solid caps drawn on the cut. Anything still hidden shows through as a silhouette.
- Crawler bugs climb straight up walls, and explosions launch enemies through the air.

**Physics and simulation** (Rapier 0.21 via WASM, with a built-in fallback if it fails to load)
- The voxel terrain is mirrored into a single Rapier voxel collider and kept in sync on every block edit.
- Structures that lose support become dynamic voxel rigid bodies with real mass and inertia. They pivot over whatever still touches them and topple like Angry Birds towers. On a hard impact they shatter into individual rigid bricks, and bricks that come to rest are written back into the world as rubble you can mine.
- Explosions throw intact blocks around as rigid bricks, and fast bricks hurt enemies.
- Every block can be destroyed. Bullets chip blocks, and rockets, grenades and TNT carve craters.
- Structural integrity: each material has a maximum span. Stacking blocks is free, but every horizontal or hanging link costs 1, so anything that loses its load path breaks off as a rigid chunk. Chunks tip, fall, crush whatever is underneath, then shatter into tumbling debris and rubble piles. Knock out a tower's base and it comes down; cut a tree trunk and it topples.
- TNT is primed by bullets, fire or blasts, so it chain-reacts.
- Fire spreads through wood, leaves, grass and enemies. Burnt grass turns to scorched earth, and burnt-out supports cause collapses.
- Fast-moving debris hurts enemies (Angry Birds style).

**Survival**
- A three-night arc: night falls on a countdown, each wave is bigger, and night 3 brings the **Brood Mother** boss. She lobs acid volleys, births crawlers and bulldozes walls. Kill her to win, then keep going in endless mode.
- At each dawn you pick 1 of 3 upgrades (damage, speed, blast radius, mining, turrets, magnet, supplies).
- Horde pathfinding uses Dijkstra flow fields over the island. Walls cost the time it takes to break them, so zombies go through gates and gaps and only dig when that's quicker. Climbers have their own field that lets them scale walls.
- Enemies:
  - **Brutes** smash walls three times as hard.
  - **Bats** fly over your defenses.
  - Oil **barrels** explode into fire.
- Zombies batter through any walls you build. Crawlers pounce and climb. Spitters lob acid that eats blocks.
- Waves get bigger every night.
- Mine materials and loot crates and enemies (wood, stone, metal, goo), then craft ammo, rockets, grenades, building blocks, TNT, lanterns, medkits and auto-turrets.

## Code tour

| File | What it does |
| --- | --- |
| `src/main.ts` | Game loop, renderer and post-processing, lighting and day cycle, camera, input, combat, crafting |
| `src/world.ts` | Block types, island and castle generation, chunk meshing, cutaway shader, voxel raycasting, structural integrity, fire |
| `src/physics.ts` | Instanced small debris; fallback chunk/TNT physics when Rapier isn't available |
| `src/rigid.ts` | Rapier world: voxel terrain collider, toppling voxel bodies, rigid bricks, TNT |
| `src/flowfield.ts` | Dijkstra flow fields for horde pathing (walkers and wall-climbers) |
| `src/entities.ts` | Player, enemies and their AI, turrets, pickups, ragdoll corpses, voxel collision |
| `src/projectiles.ts` | Bullets, rockets, bouncing grenades, lobbed acid |
| `src/particles.ts` | Point-sprite particle systems (glow, smoke, chunky bits that land) |
| `src/sprites.ts` | Procedural pixel art: character sheets, foliage atlas, UI icons |
| `src/audio.ts` | WebAudio synthesised sound effects |
| `src/ui.ts` | HUD, hotbar, crafting panel, floating damage numbers |
