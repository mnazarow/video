// Service worker CorpVideo: оболочка приложения офлайн, статика — из кэша, API и медиа — только сеть.
const VERSION = 'cv-1.2';
const OFFLINE = 'cv-offline-v1';   // скачанные видео (кладёт приложение, см. utils/offline.js)
const SHELL = ['/', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== OFFLINE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // Скачанное видео отдаём из кэша — так оно смотрится без сети
  if (url.pathname.startsWith('/media/')) {
    e.respondWith(caches.open(OFFLINE).then(async (c) => {
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      return fetch(req);
    }));
    return;
  }
  // API, вебсокеты, загрузки — всегда сеть
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws') || url.pathname.startsWith('/hls/') || url.pathname.startsWith('/whip')) return;
  // Собранные ассеты с хэшем — кэш навсегда
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/icons/')) {
    e.respondWith(caches.open(VERSION).then(async (c) => { const hit = await c.match(req); if (hit) return hit; const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res; }));
    return;
  }
  // Навигация: сеть, при её отсутствии — сохранённая оболочка
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => { if (res.ok) caches.open(VERSION).then((c) => c.put('/', res.clone())); return res; }).catch(() => caches.match('/').then((r) => r || new Response('<h1>Нет соединения</h1><p>Портал недоступен офлайн.</p>', { headers: { 'content-type': 'text/html; charset=utf-8' } }))));
  }
});
self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });
