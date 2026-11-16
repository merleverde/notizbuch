// Offline-Cache: sofort aus dem Speicher starten, im Hintergrund nach Updates schauen.
// Ein Update ist beim nächsten Öffnen der App da.
const CACHE = 'notizbuch-v11';
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-maskable.svg',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/pdf-lib.min.js'];

self.addEventListener('install', e => {
  // 'reload' umgeht den HTTP-Cache, damit wirklich die neue Version gespeichert wird
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(req, { ignoreSearch: true });
    const fresh = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; });
    if (cached) { e.waitUntil(fresh.catch(() => {})); return cached; }
    return fresh;
  }));
});
