// Cross-origin isolation for static hosts that can't set headers (GitHub Pages): this service
// worker re-serves every response with COOP/COEP, which the shared-memory voxel core needs.
// Dev/preview servers and the desktop build send the headers themselves and never register it.
// COEP is require-corp, not credentialless: Safari (so every iOS browser) ignores credentialless
// and the page would never isolate. Cross-origin loads must therefore be CORS (see the fonts link).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;
  e.respondWith(fetch(r).then((res) => {
    if (res.status === 0) return res; // opaque: pass through untouched
    const h = new Headers(res.headers);
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Cross-Origin-Embedder-Policy', 'require-corp');
    h.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }));
});
