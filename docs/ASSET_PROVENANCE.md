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
