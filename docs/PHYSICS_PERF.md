# Terrain physics: measurements (October 2026)

How much the Rapier terrain colliders cost after the 5120 × 512 × 5120 world (32³ chunks) rewrite, and what changed in `src/rigid.ts`.

All measurements were taken in this repo's container, in headless Chromium (logic only, rendering off) and in Node 22. The container is a shared 4-core VM with a load average of 10 to 15 during these runs. Isolated spikes of 5 to 40 ms show up even in empty world steps and in a fixed busy loop: a 0.9 ms loop peaked at 11 ms. So read the "max" columns as upper bounds, and the counts and medians as the reliable numbers.

## What was slow

| Cost (one 32³ chunk) | Before | After |
|---|---|---|
| Collider size | every solid voxel: up to 32 768 for a rock chunk next to air | exposed shell only: about 1 000 on average (max seen about 3 000) |
| Build (Rapier `voxels` + seam coupling) | 6 ms on average in game, 35 ms max | 0.7 ms median in browser (0.87 µs per voxel), plus 0.1 to 0.3 ms of JS for the shell |
| First world step after inserting colliders | 8 to 14 ms per full chunk (81 to 140 ms for 10 chunks) | about 0.1 ms |
| World step after one `setVoxel` on a full chunk | 2.5 to 3.5 ms | 0.03 to 0.06 ms |

**Cause of the "first step stall".** Colliders attached to fixed bodies still get their mass properties computed over every voxel whenever they are inserted or edited. Giving the terrain colliders `density 0` removes the stall completely.

## What changed

- **Rapier build.** The SIMD build (`@dimforge/rapier3d-simd-compat` 0.21.0) loads first. If it fails, the scalar build loads; if that fails too, the built-in physics takes over. The console logs which one loaded. `?rapier=scalar` and `?rapier=off` force the other two paths for testing.
- **Shell-only colliders.** A chunk collides only with solid cells that have an air face neighbour. Unloaded neighbours count as air, which adds extra voxels but never leaves a hole. Edits keep the shell exact by exposing the neighbours of a removed cell. A uniform rock chunk buried on all sides gets no collider at all.
- **No tunnelling.** Bodies are capped at 40 blocks/s, so a 0.96 cube moves less than 1.96 cells per step and cannot skip a 1-cell shell. In a Node test with 200 cubes per case, none fell through a 1-thick shell even at 140 blocks/s.
- **Budgeted building.** A build runs in two stages: shell, then Rapier collider plus seam coupling. Each frame gets 2.5 ms, and the Rapier stage starts only if its estimated cost fits the remaining budget. The estimate comes from the shell's voxel count times a running per-voxel average.
- **Build order:**
  1. Chunks a body touches. These are built regardless of the budget.
  2. Chunks along each moving body's path for the next 0.4 s.
  3. The player's 3×3×3 chunks, nearest first.
- **Pre-built start area.** Terrain around spawn is mirrored while the title screen loads, and around the player when a save loads.
- **Bodies that leave the world.** A body more than 160 blocks from the player, or over an ungenerated column, is frozen and dropped down its column as rubble. Bricks and structures still falling after their usual timeout keep falling, up to 60 s.

## In-game frame costs

Per-frame terrain-collider work plus world step, with the player moved along the path. "Before" is the original code on this branch; "after" is the range over 2 to 3 runs.

| Scenario | Frames | Before: max / frames > 4 ms | After: max / frames > 4 ms |
|---|---|---|---|
| 30 frames after re-mirroring (start or load) | 30 | 87 ms / 1 | 3 to 8 ms / 0 to 2 |
| Walk 600 blocks at 6 blocks/s | about 3 600 | 98 ms / 70 | 6 to 17 ms / 5 to 10 |
| Dash 500 blocks at 14 blocks/s | about 1 300 | 61 ms / 66 | 5 to 8 ms / 2 to 8 |
| Teleport to the highest peak (y 486) | about 55 | 16 ms / 4 | 3 to 8 ms / 0 to 2 |
| Run around the peak at 12 blocks/s | about 2 100 | 64 ms / 153 | 7 to 15 ms / 6 to 9 |

In the "after" runs, the median is 0.1 ms and the 95th percentile is 0.2 to 0.6 ms in every scenario. Most frames over 4 ms after the change were world steps with no bodies at all, or builds that took 5 to 10 times their usual time. Both match the machine's own jitter.

A separate 2 500-step walk profile went from the following before to after:

| Metric | Before | After |
|---|---|---|
| `buildChunkCollider` | 6.1 ms average, 35.5 ms max | collider commit 1.56 ms average, about 0.7 ms median |
| `physics.update` | 89.7 ms max | 0.22 ms average |

## Destruction on tall terrain (Rapier)

Test scenarios:
- A 72-block brick tower dropped off a 347-block cliff.
- 80 bricks and 4 TNT dropped from 120 to 300 blocks above a slope.
- Summit blasts on the highest peak, 3 runs.
- Bricks dropped onto x, z and corner chunk seams, and onto a y seam (surface top at y 63).

Results:
- No body was ever buried in terrain. The test checked every body on every frame.
- Bricks rest 0.48 above the surface on all seams.
- Every body that went past a chunk boundary had its colliders built ahead of it: 70 to 150 "ahead" builds per scenario.

## Known issues

- **World step spikes.** The world step itself, not terrain work, reaches 5 to 15 ms in the first second after a blast creates 60 to 80 bricks. That cost is dynamic-body contacts.
- **Stale seam coupling.** When a chunk's collider is dropped, its neighbours keep the seam coupling computed against it. A body can only reach that seam if the dropped chunk is rebuilt, and rebuilding re-couples it.
- **Unused colliders.** Shells built next to an unloaded column keep their extra wall voxels until the chunk is rebuilt. They are never touched.

## Buoyancy (October 2026)

Bodies in water (the voxel water levels, which include the sea's source cells below `WATER_LEVEL`) get buoyancy and drag in `src/rigid.ts`; debris, and the fallback's structures and TNT, get a simpler version in `src/physics.ts`.

- **Per point.** A structure is sampled per block, a brick or TNT per octant. The submerged part of each sample's height gives an upward force at that point, and a drag acts on the point's velocity relative to a slow current. So bodies tilt to their waterline, right themselves, and drift.
- **Densities** (water = 1): planks 0.5, log 0.6, crate 0.55, barrel 0.5, roof 0.65, leaves 0.3, TNT 0.85; brick 1.9, cobble 2.2, stone 2.4, ore 3.2, metal 4.5. Colliders keep mass 1 per block. Buoyancy is scaled by N / sum(densities), so a structure floats exactly when its average density is below water's. In water, a zero-sum force pair moves the centre of gravity to the heavy blocks: a hut floats roof up.
- **Floating bodies are never written into the grid.** They drift until they wash ashore (then they settle like any other body) or get waterlogged (bricks after 40 s, structures after 60 s), sink and vanish in bubbles. Sinking bodies settle on the bottom as rubble. Water stops a fall without shattering the body.
- **Cost.** Once per frame, each body checks whether any chunk within 3 blocks of it holds water. A body far from water does no per-block lookups at all. Measured in headless Chromium:
  - 60 bricks falling on dry land: under 0.01 ms/frame of water work.
  - Hot loop with 60 floating bricks: 0.14 ms per world step, about 2 µs per brick. The world step for those 60 awake bricks is 0.57 ms.
  - In-game: 0.5 to 0.9 ms/frame for 60 floating bricks plus a 72-block and a 125-block floating structure, at 2 steps per 1/30 s frame, on the loaded VM.
