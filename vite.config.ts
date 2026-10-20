import { defineConfig } from 'vite';

// Cross-origin isolation: unlocks SharedArrayBuffer and WebAssembly threads, so workers can share
// chunk memory instead of copying it. require-corp (not credentialless, which Safari ignores) matches
// what coi-sw.js serves on GitHub Pages; the Google Fonts stylesheet is loaded with CORS to pass it.
// (The desktop build serves the same headers from its own protocol handler.)
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

export default defineConfig({
  // relative base so the build works from any sub-path
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
  server: { headers: isolation },
  preview: { headers: isolation },
});
