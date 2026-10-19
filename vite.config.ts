import { defineConfig } from 'vite';

// Cross-origin isolation: unlocks SharedArrayBuffer and WebAssembly threads, so workers can share
// chunk memory instead of copying it. 'credentialless' still allows the Google Fonts stylesheet.
// (The desktop build serves the same headers from its own protocol handler.)
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' };

export default defineConfig({
  // relative base so the build works from any sub-path
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
  server: { headers: isolation },
  preview: { headers: isolation },
});
