# Blockfall Isle

Browser voxel survival game (Vite + TypeScript, three.js, Rapier, a Rust/WASM voxel core). See README.md for the code tour.

## Testing: cheap first

This machine has no GPU; full renders take minutes and gigabytes. Follow `.claude/skills/fast-3d-testing/SKILL.md`:

- `npx tsc --noEmit`, then `npm run qa:changed` (Node-only tests, about 1 s) before every commit; `npm run e2e -- <names>` for journeys you touched (`npm run e2e` runs all 26, about 90 s).
- `npm run probe -- --eval "..."` or `--eval-file tests/e2e/<journey>.js` to check the running game (~3 s, needs `npx vite --port 5173 --strictPort &`).
- Screenshots only when looks matter: `npm run probe -- ... --nohud --shot <path>` (480×270).
- Put new rules in pure modules (like `src/architectPlans.ts`, `src/defenses.ts`) so they can be unit-tested against placeholder voxel worlds.
