// Service Worker: офлайн-кэш приложения и управляемое обновление.
// CACHE_VERSION меняется скриптом tools/bump-version.mjs.
const CACHE_VERSION = '1.1.0';
const CACHE = 'skanword-' + CACHE_VERSION;
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest',
  'css/app.css',
  'js/app.js', 'js/generator.js', 'js/gen-worker.js', 'js/storage.js', 'js/i18n.js', 'js/update.js', 'js/version.js',
  'dict/ru.txt', 'dict/uk.txt', 'dict/fallback-ru.json', 'dict/fallback-uk.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // Новая версия скачивается целиком, но не активируется, пока пользователь не согласится.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('skanword-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/version.json')) return; // всегда из сети
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(e.request);
      if (res.ok && res.type === 'basic') cache.put(e.request, res.clone());
      return res;
    } catch (err) {
      if (e.request.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
      return Response.error();
    }
  })());
});
