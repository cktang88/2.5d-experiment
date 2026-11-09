# Mineral generation

The existing surface height generator uses layered two-dimensional value noise: fractal Brownian motion shapes coastlines, plains, hills and lakes, while a ridged variant shapes mountains. Structure pads blend into that terrain. Keeping this height calculation unchanged preserves familiar shorelines, structures and compatibility with existing modified chunks; the new three-dimensional gradient Perlin field only varies the boundaries of underground deposits.

Copper, iron and coal are generated as underground deposits. Every global 32×32×32 cell has one seed-hashed candidate center and type, with ellipsoid radii of 5–8 blocks horizontally and 3.5–6 vertically. A seeded three-dimensional gradient Perlin field, sampled at a seven-block scale, perturbs the ellipsoid boundary. Its lattice gradients are hashed from integer world coordinates and the seed; quintic interpolation keeps the field continuous. Deposits are clipped to stone and to depth below the local shaped terrain surface: copper 4–70, iron 12–180 and coal 6–140 blocks. Existing scattered legacy ore remains and still yields metal.

The centers and noise use world coordinates, so deposits crossing chunk columns match regardless of generation order. Candidates are enumerated in the same global order in every column, making overlapping deposits deterministic. Generation depends on the seed and these parameters; changing either changes new deposits. Terrain heights, shorelines and structure placement are unchanged.

The generator examines only candidate bounding boxes and evaluates noise within the expanded deposit ellipsoid. It materializes a previously uniform stone chunk only when it actually writes ore; rock beyond the maximum deposit depth remains uniform. On this environment, an illustrative Node benchmark of 40 nearby columns in a 5120×512×5120 world, after warming both versions, measured roughly 1.9–2.3 ms per column before and 3.0–4.1 ms after. Timing depends on terrain and runtime warmup; this is not a frame-time measurement.

Block IDs 20–22 are appended; ID 10 and its metal drop remain unchanged. Existing saved modified chunks keep their stored blocks, while untouched chunks generated after the update receive deposits. This does not require a save-version reset, but old explored or modified chunks may have fewer new resources than newly generated areas.

Run the mineral tests with `node --no-warnings --experimental-loader ./tests/worldgen-loader.mjs --test tests/mineralGeneration.test.mjs`.
