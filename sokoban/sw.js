// Service worker: precaches the app shell so the game opens instantly and
// works offline. Requests are answered from cache and refreshed in the
// background (stale-while-revalidate), so a deploy shows up on the next
// load. The deploy workflow stamps VERSION with the commit, which retires
// the previous cache on activation.

const VERSION = '6cda3ed';
const CACHE = 'sokoban-' + VERSION;

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/main.js',
  'js/engine.js',
  'js/render.js',
  'js/input.js',
  'js/generator.js',
  'js/solver.js',
  'js/worker.js',
  'js/rng.js',
  'js/rules.js',
  'js/share.js',
  'js/storage.js',
  'js/themes.js',
  'js/icons.js',
  'js/ui.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  // navigations all resolve to the shell (start_url), whatever the query
  const key = request.mode === 'navigate' ? './' : request;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(key);
      const refresh = fetch(request)
        .then((res) => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached ?? refresh;
    })
  );
});
