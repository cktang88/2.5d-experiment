# Glowstick validation

These captures came from the former `tests/glowstick_validation.py` script; its checks now run as `npm run e2e -- glowsticks` (no screenshots). The image is a raw browser canvas capture of a controlled flat platform and wall at night. The test hides the emissive stick in both comparison frames, then toggles its pooled light to check that nonemissive world pixels change. It also exercises real L input, collision, pause, death, IndexedDB save/load, expiry and the light budget.
