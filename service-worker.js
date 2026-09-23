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
    const hadPreviousCache = keys.some(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME);
    await Promise.all(
      keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map(key => caches.delete(key))
    );
    await self.clients.claim();
    if (!hadPreviousCache) return;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(windows.map(client => {
      const freshUrl = new URL('./?pwa-updated=' + Date.now(), self.registration.scope);
      return client.navigate(freshUrl.href);
    }));
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  if (new URL(event.request.url).pathname.endsWith('/release-notes.json')) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
    return;
  }
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(event.request)));
});
