# Building and flight design

The default Luanti controls include directional movement and jumping, plus a free-movement mode; see its [official default key settings](https://github.com/luanti-org/luanti/blob/master/src/defaultsettings.cpp). This game adapts that idea to an always-equipped jetpack: Z or double-tap Space toggles flight, WASD steers, Space ascends, and Ctrl descends. Flight keeps voxel collisions and has no fuel cost.

Construction snaps to the voxel grid and uses the selected face as an anchor. Depth extends from the near face, so large plans can be placed in front of the builder. The Q menu provides individual blocks, wall presets, custom solid shapes, and an open-roof room shell with a doorway. Free construction starts on for plank and brick structures; the Q menu can switch back to material costs. Geometry, occupancy, structural support, and the 8,192-cell limit still apply.
