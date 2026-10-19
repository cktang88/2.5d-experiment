# Engine decision: what Blockfall Isle runs on

*October 2026. Six evaluators (Rust engines, compiled engines, JS/TS engines, GPU voxel rendering, physics, and evidence from shipped browser games), most of it hands-on in this repo's container. Raw prototypes and logs were kept in session scratch space.*

## Requirements we scored against

The game is a 2.5D "HD-2D" voxel survival shooter in the browser:
- **World scale:** 5000 × 5000 × 500 blocks, fully destructible, streamed.
- **Look:** pixel-art billboard sprites lit by the scene, custom world shaders (roof cutaway with caps, pixel detail textures, foliage sway, cloud shadows), SSAO, volumetric light shafts, tilt-shift and bloom.
- **Destruction:** rigid-body destruction (toppling voxel structures, flying bricks).
- **Simulation:** cellular-automaton water, fire, structural integrity, horde flow fields.
- **Saves:** IndexedDB save games.

At the owner's request, initial download size is **not** a differentiator. Porting cost and rewriting our shaders and simulations are acceptable if an engine buys enough.

## What was measured

| Candidate | Built/ran here? | Key measurements | Verdict |
|---|---|---|---|
| **three.js r169** (current) + Rust/WASM mesher | yes | 121 KB gz; 4–8 ms CPU/frame for 400 chunks; mesher 0.5 ms/chunk in workers | keep |
| **three.js r186** WebGL / WebGPURenderer + TSL | yes (WebGPU fell back to WebGL2 in the old test Chromium) | +13 KB / +95 KB gz; TSL ships GTAO, SSGI, god rays, DoF, TRAA, compute nodes | upgrade path |
| Babylon 9.31 + Havok | yes | 364 KB gz; 8–10 ms CPU/frame (unoptimised); rich built-in post | best alternative, full port |
| PlayCanvas 2.23 | yes | 280 KB gz; 2.4–5 ms CPU/frame | full port, no voxel ecosystem |
| Voxelize 3.0 | inspected | needs its Rust server; no single-player; no destruction/water | no |
| Divine Voxel Engine 0.0.86 | inspected | pre-1.0, Babylon-only renderer | no |
| noa | inspected | last release 2023 | no |
| **Bevy 0.20** (+ bevy_voxel_world, bevy_rapier) | yes, WebGL2 | 17–23 MB raw; first frame ~0.9 s; no SSAO on web; single-threaded ECS on web; 5–9 min release builds; WESL shader migration | no (for now) |
| macroquad / three-d / raw wgpu | macroquad, three-d built | 0.13–0.29 MB gz, but no post stack / no engine | no |
| **Godot 4.6** web export | yes | 37 MB wasm; boots in ~2.5 s; web is Compatibility renderer only (no SSAO/volumetrics); godot_voxel needs a custom engine build | no |
| Unity 6 / Unreal / O3DE | research only | Unity WebGPU experimental, no web threads; Unreal has no HTML5 export | no |

### Physics (Node benchmarks, ms per 1/60 s step)

| Engine | 2000 cubes falling / settled | edit 50 terrain voxels | add terrain chunk | native voxel shape |
|---|---|---|---|---|
| **Rapier 0.21 SIMD** | 6.7 / **0.53** | **0.8** | **0.4** | **yes** |
| Jolt (multithread SIMD build) | 4.0 / 5.8 | 1.4 | 0.8 | no |
| Havok | 3.1 / 5.8 | 5.3 | 4.9 | no |
| PhysX | 3.0 / 5.8 | 1.7 | 1.3 | no |
| Box3D (box3d.js 0.1) | 4.4 / 0.02 | 1.4 | 3.2 | no (early) |

Rapier is the only engine with a voxel collider, and it is by far the cheapest for terrain edits and sleeping piles. Havok and PhysX are 2–3× faster only while large piles are actively falling. None of them does fracture natively.

## Scores (0–5, download size excluded, scale requirement included)

| | Rendering for the HD-2D look | Voxel / destruction / 5k-world support | Physics | Browser perf | Dev velocity | Maturity | Porting cost (5 = cheap) | **Total** |
|---|---|---|---|---|---|---|---|---|
| **three.js + our Rust/WASM voxel core** | 4 → 5 with WebGPU/TSL | 4 (ours) | 5 (Rapier) | 4 | 5 | 5 | 5 | **32–33** |
| Babylon 9 + Havok | 5 | 2 | 3 | 3 | 3 | 5 | 1 | 22 |
| Bevy 0.20 + bevy_voxel_world | 3 | 3 | 4 | 3 | 2 | 3 | 1 | 19 |
| PlayCanvas | 3 | 1 | 3 | 4 | 2 | 4 | 1 | 18 |
| Godot 4.6 web | 3 | 1 | 4 | 3 | 4 | 3 | 1 | 19 |
| Raw wgpu (Rust) | 4 | 1 | 2 | 4 | 1 | 4 | 0 | 16 |

## Why no engine wins

1. **None provides the hard parts.** No engine, Rust, C++ or JS, ships a streamed, destructible voxel world at 5k × 5k × 500 with structural collapse, voxel water and horde pathing. Every option means building those ourselves, and we already have them.
2. **The engines that render best on the web don't do voxels.** Babylon is the strongest renderer, but its physics (Havok) is the wrong shape for destructible voxels. The engines that do voxels (Bevy plus plugins, Voxelize, DVE) lack our post stack on the web or are server-bound or pre-1.0.
3. **Native-engine web exports are second-class.** Godot ships only its Compatibility renderer on the web. Bevy runs single-threaded on the web with no SSAO, and Unity's WebGPU is experimental. Our stack is web-first.
4. **No shipped browser voxel or destruction game proves out an alternative.** Shipped evidence favours three.js and PlayCanvas (Krunker, Venge) and TypeScript SDKs (Hytopia). Nobody has a verified Teardown-style browser game.

## Decision

Keep three.js as the renderer, and grow **our own Rust/WASM voxel core** underneath it: the part of an "engine" that actually matters for this game, running in Web Workers.

1. **World core (now):** sparse 32³ cubic chunks keyed by coordinate. All-air and all-solid chunks take no memory. This replaces the flat 512 × 512 × 40 arrays and is required for 5000 × 5000 × 500.
2. **Generation in workers:** structures are placed by per-region hashing so any chunk generates independently. Terrain gets real height (500 blocks: mountain ranges, cliffs, caves).
3. **Meshing in workers (done):** Rust mesher with compact vertices. Next comes greedy meshing that preserves AO, then far-terrain LOD rings.
4. **Simulation near the player only:** water, fire, AI and physics keyed per chunk. Hot loops (water cellular automaton, structural integrity, flow fields) move to Rust/WASM.
5. **Physics:** Rapier 0.21, switched to the SIMD build. Terrain colliders are built ahead of time around spawn (Rapier stalls 50–100 ms on the first step after inserts) and spread across frames afterwards.
6. **Rendering roadmap:** upgrade three.js to r186. Then move to WebGPURenderer + TSL, which falls back to WebGL2 automatically. Then add a voxel 3D texture for ray-marched AO and sun shadows and GPU water and fire (the hybrid architecture from the GPU research), keeping the current look as the fallback.

**Revisit triggers:** Bevy gets web SSAO and stable web threading; godot_voxel ships official web builds; or Babylon gains a native voxel physics shape.
