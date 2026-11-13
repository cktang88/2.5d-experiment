---
name: fast-3d-testing
description: Fast, cheap testing and iteration for this voxel game on a GPU-less, CPU/RAM-limited machine. Use before verifying or iterating on any change (building tools, geometry, defenses, worldgen, waves, UI behaviour, looks) instead of full-world screenshots.
---

# Fast 3D testing and iteration

This machine has **no GPU** (SwiftShader software rendering) and limited RAM. A full-quality screenshot of the game takes minutes, ~4–5 GB in the renderer, and often gets OOM-killed. Most questions don't need pixels. Pick the cheapest check that answers the question:

| Question | Cheapest check | Cost |
|---|---|---|
| Does it compile? | `npx tsc --noEmit` | seconds |
| Geometry, sizes, overlaps, reach, support/span, game rules, determinism | `npm run qa:changed` or `npm run qa -- <area>` (Node only, real generators, no renderer) | ~1 s |
| A number or behaviour from the real running game | `npm run probe -- --eval "..."` (fast page, simulation stepped by hand) | ~2–3 s |
| A whole player journey (enter a mode, drag, undo, place, exit) | `npm run probe -- --eval-file tests/e2e/<journey>.js` | ~3 s |
| Does it *look* right? | `npm run probe -- ... --nohud --shot <scratchpad>/x.png` (480×270, fast flags) | ~3 s |
| Full-quality screenshot | last resort, one at a time, with a time cap | minutes, GBs |

## 1. Logic and geometry: `npm run qa`

- `npm run qa:changed` runs the tests covering files changed vs `origin/main` (`SRC_MAP` in `scripts/qa.mjs`). `npm run qa -- <area>` runs one area (`architect`, `defenses`, `worldgen`, `waves`, `navigation`, `player`, `laser`, … see `AREAS`) or a file-name pattern. `-t "<regex>"` filters by test name. The whole suite takes about 1 s.
- Tests are `tests/*.test.mjs` run by `node --test` with `tests/worldgen-loader.mjs` (resolves the app's extensionless `.ts` imports). Node strips the TypeScript types itself; no bundler.
- **Keep logic pure so it can be tested here.** Shape geometry lives in `src/architectPlans.ts` and takes a tiny world interface (`solid`, `isGenerated`, `W/H/D`); `src/defenses.ts` holds placement and range maths. Modules that touch the DOM, WebGL or the WASM voxel core (`main.ts`, `world.ts`, `architect.ts`) are not imported by tests: move the rule into a pure module first.
- **Placeholder voxel worlds**: a `Set` of solid cells or a height function (`flatWorld` in `tests/architectPlans.test.mjs`) is enough for most geometry tests.
- **Real terrain**: `new WorldGen(5120, 512, 5120, seed).generateColumn(cx, cz)` runs the real generator in Node (`generatedWorld` in `tests/architectPlans.test.mjs`).
- Write a test for every rule you care about instead of eyeballing a screenshot: cell counts and no overlapping boxes; nothing blocking doorways; every roof cell within `BLOCKS[t].span` of a support (BFS); rings centred on the footprint the entity spawns at; determinism for the same seed.
- New test file: add its area to `AREAS` and its source files to `SRC_MAP` in `scripts/qa.mjs`.

## 2. The running game: `npm run probe`

Needs a dev server: `npx vite --port 5173 --strictPort &` (kill it when done).

- `?fast=1` (added by default; flags in `src/flags.ts`) loads a cheap page: streamed radius 2 columns, no post-processing (AO, bloom, shafts, grading), no shadows, lowest render scale, muted, and **straight into a new game** (no title screen, no pointer lock). Explicit flags win: `--url "/?fast=1&r=4"`, `&post=1`, `&shadows=1`.
- The probe stops the animation loop and advances the game with `game.step(0.05)` (`--steps N` before, `--after N` after the eval), so results don't depend on machine speed.
- `--eval "expr"` prints JSON. Prefer one number over a screenshot.
- `--eval-file tests/e2e/<journey>.js`: an async function body run in the page with helpers `step(n)`, `render()`, `check(name, ok, detail)`, `mouse(type, x, y, button)` and `drag(x0, y0, x1, y1)` (returns the architect tooltip). Synthetic mouse events go through the real canvas handlers. Exit code 1 on any failed check or page error. Example: `tests/e2e/architect.js`.
- `--shot out.png` renders one 480×270 frame; add `--nohud` to hide panels that cover a small viewport. Go bigger (`--w 1280 --h 720`) only for a final comparison.
- Everything is capped (`--max`, default 180 s, exit 124).

## 3. Rules for the shared machine

- Nothing runs long or loops: cap every browser run (`--max`, or `timeout 300 ...`), and never start a background job without a timeout.
- Log progress with timestamps (the probe prints `[probe +Ns]` stages) so a stuck run shows where it stopped.
- If a run fails or times out **twice**, don't retry the same thing: make it smaller (`?r=1`, fewer steps, no shot, a `qa` test instead of pixels).
- "Target crashed" / OOM-killed pages are RAM: shrink the scene, don't raise the timeout.
- Don't drive the game with real Playwright `page.mouse.wheel` while the animation loop is stopped (it waits for a frame that never comes); dispatch events with the probe's `mouse()` helper.
- The `tests/*.py` scripts are older full-render checks; several still drive the removed Q blueprint panel. Prefer `qa` and `probe` journeys.

## 4. Iteration loop

1. Write or extend a `qa` test for the rule: make it fail, fix it, make it pass.
2. Check the integration with a probe `--eval` or an e2e journey.
3. Judge looks with a small `--nohud --shot`.
4. Before each commit: `npx tsc --noEmit` and `npm run qa:changed`. Run the relevant e2e journeys when you touched input or UI.
