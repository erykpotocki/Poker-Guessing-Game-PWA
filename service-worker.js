const CACHE_PREFIX = 'poker-zgadywany-' + self.registration.scope.replace(/[^a-z0-9]/gi, '_') + '-';
const CACHE_NAME = CACHE_PREFIX + '639277916292772404';
const CACHE_TIMEOUT = 1000;
const BODY_IDLE_TIMEOUT = 30000;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

function deadline(operation, milliseconds) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Przekroczono czas oczekiwania na plik gry.')), milliseconds);
    })
  ]).finally(() => clearTimeout(timer));
}

function abortReason(signal) {
  return signal.reason || new DOMException('Aborted', 'AbortError');
}

async function readBoundedBody(response, signal) {
  if (signal?.aborted) throw abortReason(signal);
  const reader = response.body.getReader();
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(abortReason(signal));
  signal?.addEventListener('abort', onAbort, { once: true });
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      // Reset after each received chunk, so a slow but progressing connection
      // is allowed to finish. A stalled response cannot freeze startup forever.
      const chunk = await Promise.race([deadline(reader.read(), BODY_IDLE_TIMEOUT), aborted]);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_BUFFERED_BYTES) throw new Error('Część pliku gry przekracza dozwolony rozmiar.');
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function canBuffer(response, url) {
  const length = Number(response.headers.get('Content-Length'));
  if (length > MAX_BUFFERED_BYTES) return false;
  return length > 0 || /\.part\d+(?:\.gzbin)?$/.test(url.pathname);
}

function saveInBackground(event, cache, request, response) {
  // Cache writes are optional and must never delay the bytes Unity needs.
  const save = deadline(Promise.resolve().then(() => cache.put(request, response)), CACHE_TIMEOUT).catch(() => {});
  event.waitUntil?.(save);
}

const SHELL = [
  './',
  './index.html',
  './mobile.js',
  './game-keyboard.js',
  './audio-lifecycle.js',
  './manifest.webmanifest?v=7',
  './icon-180.png?v=6',
  './icon-192.png?v=6',
  './icon-512.png?v=6',
  './boot-background.jpg?v=7',
  './boot-logo.png',
  './boot-chip.png'
];

self.addEventListener('install', event => {
  event.waitUntil(deadline(caches.open(CACHE_NAME), CACHE_TIMEOUT)
    .then(cache => deadline(cache.addAll(SHELL), 15000)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await deadline(caches.keys(), CACHE_TIMEOUT).catch(() => []);
    await Promise.all(
      keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map(key => deadline(caches.delete(key), CACHE_TIMEOUT).catch(() => false))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  const url = new URL(event.request.url);
  if (!url.href.startsWith(self.registration.scope)) return;
  if (url.pathname.includes('/Build/')) {
    // Only bounded parts may be buffered. Older builds can still request a
    // large WASM file; return its native stream without a second archive copy.
    event.respondWith((async () => {
      let cache;
      try {
        cache = await deadline(caches.open(CACHE_NAME), CACHE_TIMEOUT);
        // Integrity retries explicitly bypass any previously saved bytes.
        // The successful network response replaces that entry for offline use.
        if (event.request.cache !== 'reload' && event.request.cache !== 'no-store') {
          const hit = await deadline(cache.match(event.request), CACHE_TIMEOUT);
          if (hit) return hit;
        }
      } catch (_) { /* Storage may be unavailable in private browsing. */ }
      const response = await fetch(event.request);
      if (!response.ok || !cache || !response.body || !canBuffer(response, url)) return response;
      const bytes = await readBoundedBody(response, event.request.signal);
      const init = { status: response.status, headers: response.headers };
      saveInBackground(event, cache, event.request, new Response(bytes, init));
      return new Response(bytes, init);
    })());
    return;
  }
  if (url.pathname.endsWith('/release-notes.json')) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
    return;
  }
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && canBuffer(response, url)) {
      const copy = response.clone();
      event.waitUntil(deadline(caches.open(CACHE_NAME), CACHE_TIMEOUT)
        .then(cache => deadline(cache.put(event.request, copy), CACHE_TIMEOUT)).catch(() => {}));
    }
    return response;
  }).catch(() => deadline(caches.match(event.request), CACHE_TIMEOUT).catch(() => undefined)));
});
