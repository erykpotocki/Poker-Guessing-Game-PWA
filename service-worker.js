const CACHE_PREFIX = 'poker-zgadywany-' + self.registration.scope.replace(/[^a-z0-9]/gi, '_') + '-';
const CACHE_NAME = CACHE_PREFIX + '639257496224034226';
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
  if (url.pathname.endsWith('/release-notes.json')) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
    return;
  }
  const isLargeRuntimeAsset = url.pathname.includes('/Build/') || url.pathname.includes('/StreamingAssets/');
  if (isLargeRuntimeAsset) {
    event.respondWith(caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok) cache.put(event.request, response.clone());
      return response;
    }).catch(() => caches.match(event.request)));
    return;
  }
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(event.request)));
});
