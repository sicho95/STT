const VERSION = 'v1';
const APP_CACHE = `app-${VERSION}`;
const RUNTIME_CACHE = `runtime-${VERSION}`;

const APP_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './worker.js',
  './sw.js',
  './manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(APP_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => {
      if (k !== APP_CACHE && k !== RUNTIME_CACHE) return caches.delete(k);
    })))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Same-origin app shell: cache-first
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      return fetch(event.request);
    })());
    return;
  }

  // Cross-origin runtime cache for:
  // - esm.sh (Transformers.js ESM)
  // - huggingface.co + cdn-lfs.huggingface.co (model files)
  const host = url.hostname;
  const isEsm = host.endsWith('esm.sh');
  const isHF = host.endsWith('huggingface.co') || host.endsWith('cdn-lfs.huggingface.co');

  if (isEsm || isHF) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const res = await fetch(event.request);
      if (res.ok) cache.put(event.request, res.clone());
      return res;
    })());
  }
});
