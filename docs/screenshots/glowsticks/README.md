# Glowstick validation

Run `python tests/glowstick_validation.py` against Vite on port 5173. The image is a raw browser canvas capture of a controlled flat platform and wall at night. The test hides the emissive stick in both comparison frames, then toggles its pooled light to check that nonemissive world pixels change. It also exercises real L input, collision, pause, death, IndexedDB save/load, expiry and the light budget.
