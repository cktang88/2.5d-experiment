# Autobattler weapon models

The five defense models reuse weapon geometry and rig construction from
[cktang88/autobattler-2](https://github.com/cktang88/autobattler-2), commit
`25022e9f9997d02056dbc72c6a01e93232845ee7`, at the user's explicit request.
The source repository did not contain a license file at that revision; no license
terms are asserted here.

The vendored source in `src/art/autobattler/vendor` comes from upstream
`src/client/proto3d/geo.ts`, `weapons/{wkit,guns,w2500}.ts`, and
`src/shared/{types,parts,weaponsize}.ts`. The local `weapons3d.ts` adapts the
upstream `buildTurret` rig and dispatch to the five selected weapons. The
`mountgeo.ts` unit scaling function is extracted from the upstream file.
The optional meshoptimizer simplification pass was removed; merged original
geometry is used directly. Materials are local Three.js materials using the
upstream material roles and an adapted color palette. The local adapter scales
housing sizes, caches templates, and rotates the upstream +X forward axis to +Z.

| Defense | Upstream module | Builder |
| --- | --- | --- |
| Auto | autocannon | `carbine` |
| Heavy cannon | cannon | `buildGun` / `wedgeTank` |
| Twin cannon | twin120 | `buildGun` / `twinHex` |
| Rocket battery | mlrs | `blades` (four cells) |
| Artillery | howitzer | `artillery` |

Yaw, pitch, recoil and muzzle nodes preserve the upstream hierarchy. Geometry and
materials are shared between clones and must not be disposed by individual units.

# Leaf texture

`src/leafTexture.ts` encodes `blocks/maple_leaves.png` from
["16x16 Block Texture Set"](https://opengameart.org/content/16x16-block-texture-set) on OpenGameArt
(Kutejnikov, Boden), licensed **CC0 1.0** (public domain). The 16×16 image was converted to a
three-symbol grid: its darkest colour became the transparent holes, the two greens became shade
multipliers on the game's own leaf colour.

# Pistol model

`public/models/tripo-pistol.glb` was generated for this project with the Tripo3D API
(`POST /v3/generation/text-to-model`, model `P2-20260801`, face limit 800, texture without PBR;
task `c7acfbc8-4406-477b-a368-d605658fc1aa`, 2026-11-14) from the prompt "low poly stylized handgun
pistol game asset, chunky simple shapes, grey metal slide, dark frame, brown wooden grip, clean
flat-shaded". 877 triangles; its 2048² texture was downscaled to 512² JPEG. `src/heldModels.ts`
loads it and swaps it in for the box-built pistol (which stays as the fallback).

# SMG model

`public/models/tripo-smg.glb` was generated for this project with the Tripo3D API
(`POST /v3/generation/text-to-model`, model `v3.1-20260211` with `smart_low_poly: true`, face limit
1000, texture without PBR; task `bf2df1d3-6546-4ec5-a861-105a7b84052a`, 2026-11-14, 30 credits) from
the prompt "low poly stylized submachine gun game asset, compact boxy receiver, short barrel with
muzzle, straight box magazine below, pistol grip, short folding stock, dark gunmetal with lighter grey
metal accents, clean simple shapes". 1,916 triangles; texture downscaled from 2048² to 512² JPEG.
The model came out tilted nose-up, so `src/heldModels.ts` levels it with a small pitch.
