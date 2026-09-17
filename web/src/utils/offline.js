// Офлайн-просмотр: скачанные видео живут в Cache Storage браузера, опись — в localStorage.
// Так же устроено «Скачать» в приложениях YouTube и Netflix: файл лежит на устройстве,
// доступен без сети и через заданный срок устаревает.
const CACHE = 'cv-offline-v1';
const KEY = 'cv.offline.items';

export const offlineSupported = () => typeof caches !== 'undefined' && typeof navigator !== 'undefined';

function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
function writeAll(items) {
  try { localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* приватный режим */ }
}

/** Список скачанного (без устаревшего). */
export function listOffline() {
  const now = Date.now();
  return readAll().filter((x) => !x.expiresAt || x.expiresAt > now);
}

export function isOffline(videoId) {
  return listOffline().some((x) => x.id === videoId);
}

export function offlineTotalBytes() {
  return listOffline().reduce((n, x) => n + (x.bytes || 0), 0);
}

/**
 * Скачать видео для просмотра без сети.
 * video — карточка с id, shortId, title, mp4Url, thumbnailUrl, duration.
 */
export async function saveOffline(video, { days = 30, maxBytes = 0, onProgress } = {}) {
  if (!offlineSupported()) throw new Error('Браузер не поддерживает офлайн-просмотр');
  if (!video.mp4Url) throw new Error('У этого видео нет файла для скачивания');
  if (maxBytes && offlineTotalBytes() >= maxBytes) throw new Error('Место для офлайн-видео закончилось — удалите лишнее');
  const cache = await caches.open(CACHE);
  const res = await fetch(video.mp4Url, { credentials: 'include' });
  if (!res.ok) throw new Error('Не удалось скачать видео');
  const total = Number(res.headers.get('content-length')) || 0;
  let bytes = total;
  // Читаем поток, чтобы показать прогресс, и складываем в кэш целиком
  if (res.body && onProgress && total) {
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(Math.min(99, Math.round((got / total) * 100)));
    }
    bytes = got;
    const blob = new Blob(chunks, { type: res.headers.get('content-type') || 'video/mp4' });
    await cache.put(video.mp4Url, new Response(blob, { headers: { 'content-type': blob.type, 'content-length': String(bytes) } }));
  } else {
    const blob = await res.blob();
    bytes = blob.size;
    await cache.put(video.mp4Url, new Response(blob, { headers: { 'content-type': blob.type } }));
  }
  if (video.thumbnailUrl) { try { await cache.add(video.thumbnailUrl); } catch { /* обложка не критична */ } }
  const items = listOffline().filter((x) => x.id !== video.id);
  items.unshift({
    id: video.id, shortId: video.shortId, title: video.title, duration: video.duration || 0,
    mp4Url: video.mp4Url, thumbnailUrl: video.thumbnailUrl || '', owner: video.owner?.displayName || '',
    bytes, savedAt: Date.now(), expiresAt: days > 0 ? Date.now() + days * 86400000 : 0,
  });
  writeAll(items);
  onProgress?.(100);
  return items[0];
}

export async function removeOffline(videoId) {
  const item = readAll().find((x) => x.id === videoId);
  if (item) {
    try {
      const cache = await caches.open(CACHE);
      await cache.delete(item.mp4Url);
      if (item.thumbnailUrl) await cache.delete(item.thumbnailUrl);
    } catch { /* ignore */ }
  }
  writeAll(readAll().filter((x) => x.id !== videoId));
}

/** Удалить устаревшее — вызывается при открытии раздела «Скачанные». */
export async function cleanupOffline() {
  const now = Date.now();
  const stale = readAll().filter((x) => x.expiresAt && x.expiresAt <= now);
  for (const x of stale) await removeOffline(x.id);
  return stale.length;
}

export function fmtBytes(n) {
  if (!n) return '0 МБ';
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} ГБ` : `${mb.toFixed(mb < 10 ? 1 : 0)} МБ`;
}
