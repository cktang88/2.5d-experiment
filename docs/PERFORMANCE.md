# Simulation performance benchmark

Run a Vite development server (`npm run dev -- --host 127.0.0.1`), then in another terminal run `python tests/performance_validation.py`. The script requires Python Playwright and Chromium at `/usr/bin/chromium` (override with `CHROMIUM`); pass a URL as the first argument if the server is elsewhere. It prints JSON with the browser, WebGL renderer, timings, retained counts and browser errors, and fails if fixture counts change.

The script starts a new game, stops its animation loop, and runs `game.step(1/60)` directly. Each case uses 60 warm-up updates and 120 individually timed updates. The reported median, nearest-rank p95 and maximum are wall-clock milliseconds per update as measured by `performance.now()` in the page. They include all work in `Game.step`, including simulation, streaming, camera, UI and minimap updates; they exclude `frame()` rendering, GPU work, presentation and setup. The 16.7 ms 60 Hz frame interval must also accommodate rendering and other work, so these numbers alone do not establish a frame rate. Timings vary with the host, browser, background activity and generated terrain.

The baseline is the freshly started game. The second case builds a 65 × 65 supported floor and two-block-thick, 12-block-high perimeter, for 10,273 explicitly placed floor and wall blocks. It adds 30 turrets across five types, 24 traps across four types, 48 alternating zombies and brutes, and 12 glowsticks. Enemies run their normal update but are returned to fixed positions and made invulnerable after each update; this keeps targeting and navigation work present while preventing the fixture from being depleted. A seeded random stream begins when the castle is constructed; the original generated terrain and starting position can still vary. The wave director is held in the safe phase and the player is invulnerable. The warm-up and measurement cover three seconds of game time, so this is a bounded steady fixture, not a long survival or construction benchmark. Turrets and traps can fire; projectile and transient visual counts can vary. The script checks that the intended persistent entities remain and that the four-light glowstick pool is active.

## Example measurement

Measured in this cloud environment on 2026-11-09, using Chromium 156.0.8078.79 and a virtual Intel Xeon Platinum 8573C (five visible CPUs). No `/dev/dri` or NVIDIA device was exposed. WebGL reported ANGLE SwiftShader, a software renderer; these are CPU update timings, not hardware rendering or FPS results.

| Fixture | Median | p95 | Maximum | Scene objects | Scene lights |
| --- | ---: | ---: | ---: | ---: | ---: |
| New game | 0.86 ms | 2.64 ms | 10.02 ms | 413 | 12 |
| Castle | 0.87 ms | 1.82 ms | 8.58 ms | 1,703 | 12 |

The castle retained all 48 enemies, 30 turrets, 24 traps and 12 glowsticks; four glowstick lights were active. Scene counts include children and all lights, not just glowsticks; both cases had 10 point lights in total. This sample does not characterize large-world mesh rebuilds, build placement spikes, long-running memory behavior, GPU rendering, or actual gameplay frame rate. Re-run on representative target hardware and profile rendering separately before drawing conclusions about those costs.
