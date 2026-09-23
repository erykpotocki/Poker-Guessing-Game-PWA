const CACHE_PREFIX = 'poker-zgadywany-' + self.registration.scope.replace(/[^a-z0-9]/gi, '_') + '-';
const CACHE_NAME = CACHE_PREFIX + '639257735584993350';
const SHELL = [
  './',
  './index.html',
  './mobile.js',
  './manifest.webmanifest?v=6',
  './icon-180.png?v=6',
  './icon-192.png?v=6',
  './icon-512.png?v=6',
  './boot-background.png?v=6',
  './boot-logo.png',
  './boot-chip.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map(key => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  const url = new URL(event.request.url);
  if (!url.href.startsWith(self.registration.scope)) return;
  if (url.pathname.includes('/Build/')) {
    // Save one bounded part before returning it. Avoid tee/clone buffering a
    // second full Unity archive while the engine decompresses it on iOS.
    event.respondWith((async () => {
      let cache;
      try {
        cache = await caches.open(CACHE_NAME);
        const hit = await cache.match(event.request);
        if (hit) return hit;
      } catch (_) { /* Storage may be unavailable in private browsing. */ }
      const response = await fetch(event.request);
      if (!response.ok || !cache) return response;
      const bytes = await response.arrayBuffer();
      const init = { status: response.status, headers: response.headers };
      try { await cache.put(event.request, new Response(bytes, init)); }
      catch (_) { /* Quota failure must not prevent the game from starting. */ }
      return new Response(bytes, init);
    })());
    return;
  }
  if (url.pathname.endsWith('/release-notes.json')) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
    return;
  }
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone())).catch(() => {}));
    return response;
  }).catch(() => caches.match(event.request)));
});
