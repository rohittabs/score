/* Score service worker: makes the whole player work offline.
   Bump CACHE_VERSION whenever any app file below changes.
   The sound bank lives in its own cache (SOUND_CACHE) so an app update never downloads it again.
   Only bump SOUND_CACHE (here and in js/score.js) when sounds/score.sf3 itself changes. */
const CACHE_VERSION = 'score-v1.2.0-tour';
const SOUND_CACHE = 'score-sounds-v2';

const PRECACHE = [
  './',
  './index.html',
  './slides.html',
  './css/score.css',
  './js/score.js',
  './js/musescore.js',
  './manifest.webmanifest',
  './favicon.png',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './icon-maskable-512.png',
  './vendor/alphatab/alphaTab.min.js',
  './vendor/alphatab/font/Bravura.woff2',
  './vendor/alphatab/font/Bravura.woff',
  './vendor/alphatab/font/Bravura.otf',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the browser's HTTP cache. Without it an update can store the previous version's
  // files under the new cache name (GitHub Pages lets browsers reuse files for 10 minutes).
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION && k !== SOUND_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function cacheFirst(cacheName, req, navigateFallback) {
  return caches.open(cacheName).then((cache) =>
    cache.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      }).catch(() => {
        if (navigateFallback && req.mode === 'navigate') return cache.match('./index.html');
        return Response.error();
      });
    })
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.includes('/sounds/')) {
    // The page downloads the sound bank itself (with a progress bar) and stores it in SOUND_CACHE.
    event.respondWith(cacheFirst(SOUND_CACHE, req, false));
    return;
  }
  event.respondWith(cacheFirst(CACHE_VERSION, req, true));
});
