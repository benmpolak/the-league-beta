const CACHE = 'the-league-shell-v1';
const SHELL = [
  './', './index.html', './css/style.css', './js/app.js', './js/data.js',
  './js/history25.js', './js/lore.js', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigation and score feeds prefer the network, with the last good copy as
  // an emergency fallback. Static assets render immediately and refresh behind
  // the scenes, so an existing install never hangs on a poor connection.
  const networkFirst = request.mode === 'navigate'
    || url.pathname.endsWith('/data/stats.json')
    || url.pathname.endsWith('/data/fixtures.json');
  if (networkFirst) {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) caches.open(CACHE).then(cache => cache.put(request, response.clone()));
      return response;
    }).catch(() => caches.match(request).then(hit => hit || caches.match('./index.html'))));
    return;
  }

  event.respondWith(caches.match(request).then(hit => {
    const update = fetch(request).then(response => {
      if (response.ok) caches.open(CACHE).then(cache => cache.put(request, response.clone()));
      return response;
    });
    return hit || update;
  }));
});
