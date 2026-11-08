# Asset research for the first-person survival conversion

Research checked 2026-11-08. The existing game already uses Three.js 0.169 and Rapier 0.21 and already contains voxel survival, crafting, combat, and a generated starter castle. The asset research below is for visual upgrades; it does not replace voxel collision, building, or destruction.

## Sources checked

### Kenney Starter Kit FPS

- Repository: <https://github.com/KenneyNL/Starter-Kit-FPS> (checked at commit `185fd23`). A local checkout used for inspection is `/tmp/kenney-fps`.
- Its README states that the starter project code is MIT licensed and its included 2D sprites, 3D models, and sound effects are CC0. Keep the MIT notice if copying code; the listed art assets can be reused under CC0.
- The repo includes these compact, already-downloaded GLBs: `models/enemy-flying.glb` (60 KB), `models/blaster.glb` (60 KB), `models/blaster-repeater.glb` (68 KB), plus cloud, grass, platform, and wall models. They are available at `/tmp/kenney-fps/models/` in this workspace; no external asset download is needed to inspect them.
- `enemy-flying.glb` is a flying enemy and could be a full-3D replacement for the existing bat. It is not a grounded humanoid enemy. The repo does not document GLB animation clips; the Godot starter animates movement in script, so inspect the GLB before assuming it has a rig or clips.
- The blasters are suitable for a first-person held weapon prototype. The game already builds its weapons procedurally in `src/entities.ts`; adapting or retaining those may fit the current style better.

### Quaternius character packs

Official site source and pack pages were inspected from the repository <https://github.com/Quaternius/quaternius.github.io> (local checkout `/tmp/quaternius-site`, commit `c219437`). Official pages declare CC0 and list the formats and pack contents:

- [Ultimate Animated Character Pack](https://quaternius.com/packs/ultimatedanimatedcharacter.html): 52 animated characters; FBX, OBJ, and Blend. The site index describes characters including zombies and goblins. This is the broadest candidate for grounded enemies, but select only a few characters rather than importing the whole pack.
- [RPG Character Pack](https://quaternius.com/packs/rpgcharacters.html): 6 rigged, animated, textured fantasy characters; FBX, OBJ, and Blend.
- [Cute Animated Monsters Pack](https://quaternius.com/packs/cutemonsters.html): 21 animated monsters; FBX, OBJ, and Blend.

The official pack pages state commercial and personal use and identify CC0. The download buttons link to Google Drive. The pack archives were not downloaded in this research, so exact file sizes, individual animation clip names, and Three.js import behavior remain to be checked after choosing a small subset. Three.js has an FBX loader; GLB conversion can be done offline if GLB is preferred.

### Polyfork catalog

- Catalog index: <https://github.com/lucas-martinic/polyfork-catalog> (checked at `a03ba80`); local index checkout: `/tmp/polyfork-catalog`.
- The repo is an index only; it contains names, links, catalog JSON, and kit covers, not model binaries. Each catalog entry links to a model page and GLB/module URLs.
- The catalog README and `LICENSE.md` say free models may be used and modified in personal or commercial projects with no attribution. It separately says free mesh files (GLB/FBX/USD/OBJ) are CC BY 4.0, requiring a credit line if redistributed or re-hosted. The `.mjs` source and HD editions are not CC BY. Check the model page and current terms when acquiring a specific asset.
- Concrete low-poly candidates in the index: [Goblin](https://polyfork.dev/asset/goblin-2461c8) (4,083 triangles), [Orc Brute](https://polyfork.dev/asset/orc-brute-08c6ca) (2,633), [Shambling Ghoul](https://polyfork.dev/asset/shambling-ghoul-256f2f) (3,697), [Teen Zombie](https://polyfork.dev/asset/teen-zombie-b5bb27) (4,951), [Watchtower](https://polyfork.dev/asset/watchtower-140f78) (1,736), [Wooden Bridge](https://polyfork.dev/asset/wooden-bridge-9d2308) (752), [Wooden Gate](https://polyfork.dev/asset/wooden-gate-0e001c) (630), and [Upgradeable Assembly Workbench](https://polyfork.dev/asset/upgradeable-assembly-workbench-a18ff3) (884).
- Model pages and `polyfork.dev` CDN requests were blocked in this execution environment at the CONNECT tunnel: Envoy returned HTTP 403 with a 16-byte response and no explanatory reason. Thus the index rows and repo license text were verified, but model page contents and binaries were not. No Polyfork files have been downloaded.

No Hugging Face dataset was used or verified; no asset provenance or license should be inferred from an uninspected dataset listing.

## Mechanics and integration recommendations

- Keep voxel blocks as the authoritative world geometry for terrain, castle walls, stairs, battlements, and drawbridge behavior. The world already has sparse 32-cube chunks, greedy WASM meshing, worker meshing, voxel raycasts, and Rapier colliders. Decorative GLBs should not be mistaken for destructible/collidable construction pieces.
- Existing generated castle in `src/worldgen.ts` has brick walls, four corner towers, moat, two land bridges, a gate opening, and a central keep. The main gaps are functional doors/drawbridge, stair/ramp building pieces, richer battlements, and a crafting station. Existing placement in `src/main.ts` places one voxel per click from the raycast face; recipes are available globally from Tab/C.
- First-person input can reuse `src/main.ts` camera aim/raycast/placement and camera-relative movement in `src/entities.ts`. Switch to pointer-lock mouse look, use a camera rig at player eye height with clamped pitch, and keep the voxel raycast for mining/building. The player already has a `gunHolder` and procedural weapon models in `src/entities.ts`; attach/adapt it as a camera view model. Review the current third-person terrain/roof cutaway before using it at eye level, because it can remove nearby surfaces that obstruct the first-person view.
- For the user's full-3D enemy requirement, use rigged animated characters from a small Quaternius subset where clips are available. Kenney's tiny flying enemy is a fast option for the existing bat. Keep enemy numbers and active animation updates bounded; asset triangle counts are only one part of the cost, with draw calls, materials, skeleton updates, shadows, and Rapier bodies also contributing. Reuse materials/geometries and avoid real-time shadow casting on every crowd member.
- Polyfork's static GLBs are suitable as limited decorative props, but catalog data alone does not establish rigs or animation. Their mesh/redistribution credit requirement also differs from CC0 packs.
