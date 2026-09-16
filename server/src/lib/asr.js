// Клиент сервера распознавания речи (OpenAI-совместимый API /v1/audio/transcriptions: Whisper, GigaAM и т.п.).
import fs from 'node:fs';
import path from 'node:path';
import { getSettings } from './settings.js';
import { segmentsToVtt, toVtt } from './util.js';

/**
 * Отправляет аудиофайл на сервер ASR и возвращает { vtt, text }.
 * Пробует формат verbose_json (сегменты с таймкодами), затем vtt, затем srt/json.
 */
export async function transcribe(audioPath, { signal, settings } = {}) {
  const s = settings || await getSettings('asr.');
  if (!s['asr.enabled'] && !settings) throw new Error('ASR отключён');
  const url = s['asr.url'];
  if (!url) throw new Error('Не задан адрес сервера ASR');
  const timeoutMs = (Number(s['asr.timeout_sec']) || 3600) * 1000;
  const attempts = ['verbose_json', 'vtt', 'srt', 'json'];
  let lastErr = null;
  for (const format of attempts) {
    try {
      const form = new FormData();
      const buf = await fs.promises.readFile(audioPath);
      form.append('file', new Blob([buf], { type: 'audio/mpeg' }), path.basename(audioPath));
      if (s['asr.model']) form.append('model', s['asr.model']);
      if (s['asr.language']) form.append('language', s['asr.language']);
      form.append('response_format', format);
      if (format === 'verbose_json') form.append('timestamp_granularities[]', 'segment');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: s['asr.api_key'] ? { Authorization: `Bearer ${s['asr.api_key']}` } : {},
          body: form,
          signal: ctrl.signal,
        });
      } finally { clearTimeout(timer); }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // сервер не поддерживает формат — пробуем следующий
        if (res.status === 400 || res.status === 422) { lastErr = new Error(`ASR ${res.status}: ${body.slice(0, 300)}`); continue; }
        throw new Error(`ASR ответил ${res.status}: ${body.slice(0, 300)}`);
      }
      const ct = res.headers.get('content-type') || '';
      if (format === 'verbose_json' || format === 'json' || ct.includes('json')) {
        const data = await res.json();
        if (Array.isArray(data.segments) && data.segments.length) {
          const segs = data.segments.map((x) => ({ start: Number(x.start) || 0, end: Number(x.end) || 0, text: x.text }));
          return { vtt: segmentsToVtt(segs), text: segs.map((x) => String(x.text || '').trim()).join(' ') };
        }
        if (typeof data.text === 'string' && data.text.trim()) {
          // без таймкодов — одна реплика на всё видео (лучше, чем ничего)
          return { vtt: segmentsToVtt([{ start: 0, end: 0.1, text: data.text.trim() }]), text: data.text.trim(), noTimestamps: true };
        }
        lastErr = new Error('Пустой ответ ASR'); continue;
      }
      const text = await res.text();
      const vtt = toVtt(text);
      return { vtt, text: vttText(vtt) };
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Таймаут запроса к серверу ASR');
      lastErr = e;
    }
  }
  throw lastErr || new Error('Не удалось получить распознавание');
}

function vttText(vtt) {
  return vtt.split('\n').filter((l) => l && !/^WEBVTT/.test(l) && !/-->/.test(l) && !/^\d+$/.test(l)).join(' ').replace(/\s+/g, ' ').trim();
}

/** Проверка доступности ASR (GET /v1/models или HEAD url). */
export async function asrTest(settings) {
  const url = settings['asr.url'];
  const base = url.replace(/\/v1\/audio\/transcriptions\/?$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const headers = settings['asr.api_key'] ? { Authorization: `Bearer ${settings['asr.api_key']}` } : {};
    let res = await fetch(`${base}/v1/models`, { headers, signal: ctrl.signal }).catch(() => null);
    if (!res || !res.ok) res = await fetch(base + '/', { headers, signal: ctrl.signal }).catch(() => null);
    if (!res) throw new Error('Сервер недоступен');
    return { ok: res.ok, status: res.status };
  } finally { clearTimeout(timer); }
}
