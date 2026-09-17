// Прочие задания: письма, импорт записи трансляции, обслуживание (расписание публикаций, очистка, агрегаты).
import path from 'node:path';
import fsp from 'node:fs/promises';
import { one, query, many, publish, withLock } from '../db.js';
import { sendMailNow } from '../lib/mailer.js';
import { storage, ensureDir, exists, removeDir, removeFile } from '../lib/storage.js';
import { loadSettings } from '../lib/settings.js';
import { enqueue } from '../lib/jobs.js';
import { notifySubscribersNewVideo, notifyPremiereAudience, notify } from '../lib/notify.js';
import { captionsToVtt } from './captions.js';
import { shortId } from '../lib/crypto.js';
import { config } from '../config.js';
import { sendReminders } from '../lib/assignments.js';
import { sendLiveReminders } from '../routes/live-interact.js';
import { emitEvent, eventVideo } from '../lib/events.js';
import { scanWatchFolder, sendDigests } from './platform.js';
import { runRetention } from './retention.js';

export async function runEmail(job) {
  const { to, subject, html, text } = job.payload;
  await sendMailNow({ to, subject, html, text });
  return { to };
}

/** Импорт записи завершённого эфира: файл записи → новое видео → обработка. */
export async function runLiveImport(job, ctx) {
  const { streamId, file } = job.payload;
  const stream = await one('SELECT s.*, u.display_name AS owner_name FROM live_streams s JOIN users u ON u.id = s.owner_id WHERE s.id = $1', [streamId]);
  if (!stream) throw Object.assign(new Error('Трансляция не найдена'), { noRetry: true });
  const src = file;
  if (!(await exists(src))) throw new Error('Файл записи ещё не появился: ' + src);
  // Дожидаемся, пока файл перестанет расти (MediaMTX закрывает сегмент)
  const st1 = await fsp.stat(src);
  await new Promise((r) => setTimeout(r, 3000));
  const st2 = await fsp.stat(src);
  if (st1.size !== st2.size) throw new Error('Файл записи ещё пишется');
  if (st2.size < 10000) { await fsp.unlink(src).catch(() => {}); return { skipped: 'empty' }; }

  const s = await loadSettings(true);
  const videoId = crypto.randomUUID();
  const dir = storage.videoDir(videoId);
  await ensureDir(dir);
  const ext = path.extname(src).slice(1) || 'mp4';
  const dest = path.join(dir, `original.${ext}`);
  await fsp.rename(src, dest).catch(async () => { await fsp.copyFile(src, dest); await fsp.unlink(src); });
  const title = `${stream.title} — запись эфира ${new Date(stream.started_at || Date.now()).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}`;
  await query(
    `INSERT INTO videos(id, short_id, owner_id, title, description, category_id, visibility, status, moderation_status, original_filename, original_size, original_path, is_live_recording, live_stream_id, comments_mode, recording_started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10,$11,true,$12,$13,$14)`,
    [videoId, shortId(), stream.owner_id, title, stream.description || '', stream.category_id, stream.visibility,
      s['upload.premoderation'] ? 'pending' : 'approved', path.basename(src), st2.size, storage.rel(dest), stream.id, s['comments.default_mode'], stream.started_at || null],
  );
  await query('UPDATE live_streams SET recording_video_id = $2 WHERE id = $1', [stream.id, videoId]);
  // Живые субтитры эфира сразу становятся субтитрами записи — расшифровку не нужно ждать (1.6)
  try {
    const caps = await many('SELECT seq, offset_sec, text FROM live_captions WHERE stream_id = $1 ORDER BY seq', [stream.id]);
    if (caps.length) {
      const vtt = captionsToVtt(caps);
      const subDir = storage.videoDir(videoId);
      await ensureDir(subDir);
      const subPath = path.join(subDir, 'subs_live_ru.vtt');
      await fsp.writeFile(subPath, vtt, 'utf8');
      await query(
        `INSERT INTO subtitles(video_id, lang, label, path, source, is_default) VALUES ($1,'ru','Русские (эфир)',$2,'asr',true)`,
        [videoId, storage.rel(subPath)]);
    }
  } catch (e) { ctx?.log?.warn({ err: e.message }, 'live captions → subtitles'); }
  await enqueue('transcode', { videoId }, { videoId, priority: 1 });
  await notify(stream.owner_id, { type: 'live_recording', title: 'Запись эфира сохранена', body: title, link: `/studio/videos/${videoId}`, data: { videoId } });
  return { videoId };
}

/** Обслуживание: выполняется воркером раз в минуту. */
export async function runMaintenance(job, ctx) {
  // При нескольких воркерах обслуживание должно выполняться ровно один раз:
  // иначе дайджесты рассылаются дважды, а папка автоимпорта обрабатывается параллельно.
  const r = await withLock('corpvideo:maintenance', () => maintenanceBody(job, ctx));
  if (r.ok) return r.value;
  // Ручной запуск (с hourly/daily) не отбрасываем: повторим, когда освободится блокировка
  if (job.payload?.hourly || job.payload?.daily) {
    await enqueue('maintenance', job.payload, { dedupe: false, maxAttempts: 1, runAt: new Date(Date.now() + 30000) });
    return { requeued: 'обслуживание занято другим воркером — повтор через 30 секунд' };
  }
  return { skipped: 'обслуживание уже выполняется другим воркером' };
}

async function maintenanceBody(job, ctx) {
  const s = await loadSettings(true);
  const out = {};
  // 1. Отложенная публикация
  const due = await many(
    `UPDATE videos SET published_at = now(), scheduled_at = NULL WHERE scheduled_at IS NOT NULL AND scheduled_at <= now() AND status = 'ready' AND deleted_at IS NULL RETURNING *`,
  );
  for (const v of due) {
    const owner = await one('SELECT id, display_name FROM users WHERE id = $1', [v.owner_id]);
    await publish({ type: 'video.published', videoId: v.id, ownerId: v.owner_id });
    if (['public', 'internal'].includes(v.visibility) && v.moderation_status === 'approved') await notifySubscribersNewVideo(v, owner);
    await emitEvent('video.published', { video: eventVideo(v) });
  }
  out.published = due.length;
  // 1a. Премьеры: за 30 минут зовём подписчиков, в назначенный час начинаем показ (как на YouTube)
  try {
    const soon = await many(
      `UPDATE videos SET premiere_notified_at = now()
       WHERE premiere = true AND premiere_notified_at IS NULL AND status = 'ready' AND deleted_at IS NULL
         AND scheduled_at > now() AND scheduled_at <= now() + interval '30 minutes' RETURNING *`);
    for (const v of soon) {
      const owner = await one('SELECT id, display_name FROM users WHERE id = $1', [v.owner_id]);
      await notifyPremiereAudience(v, owner, 'soon');
    }
    const started = await many(
      `UPDATE videos SET premiere_started_at = now(), published_at = COALESCE(published_at, scheduled_at)
       WHERE premiere = true AND premiere_started_at IS NULL AND status = 'ready' AND deleted_at IS NULL
         AND scheduled_at <= now() RETURNING *`);
    for (const v of started) {
      const owner = await one('SELECT id, display_name FROM users WHERE id = $1', [v.owner_id]);
      await publish({ type: 'video.published', videoId: v.id, ownerId: v.owner_id });
      await notifyPremiereAudience(v, owner, 'start');
      await emitEvent('video.published', { video: eventVideo(v) });
    }
    out.premieres = { soon: soon.length, started: started.length };
  } catch (e) { ctx?.log?.warn({ err: e.message }, 'premieres'); }
  // 1b. Напоминания о запланированных эфирах (за 15 минут)
  try { out.liveReminders = await sendLiveReminders(); } catch (e) { ctx?.log?.warn({ err: e.message }, 'live reminders'); }
  // 1c. Срок публикации: видео с истёкшим сроком становятся приватными
  const expired = await many(`UPDATE videos SET visibility = 'private', expired_at = now() WHERE expires_at IS NOT NULL AND expires_at <= now() AND expired_at IS NULL AND deleted_at IS NULL RETURNING id, short_id, owner_id, title`);
  for (const v of expired) {
    await publish({ type: 'video.published', videoId: v.id, ownerId: v.owner_id });
    await notify(v.owner_id, { type: 'video_expired', title: 'Срок публикации видео истёк', body: `${v.title} — видео скрыто (приватное). Продлить срок можно в студии.`, link: `/studio/videos/${v.id}`, data: { videoId: v.id } });
    await emitEvent('video.expired', { video: { id: v.id, shortId: v.short_id, title: v.title, ownerId: v.owner_id, url: `/watch/${v.short_id}` } });
  }
  out.expired = expired.length;
  // 1d. Папка автоимпорта и еженедельный дайджест (1.3)
  try { const w = await scanWatchFolder(s, ctx?.log); if (w.imported) out.watchImported = w.imported; } catch (e) { ctx?.log?.warn({ err: e.message }, 'watch folder'); }
  try { const d = await sendDigests(s); if (d) out.digests = d; } catch (e) { ctx?.log?.warn({ err: e.message }, 'digest'); }

  const minute = new Date().getMinutes();
  if (job.payload.hourly || minute === 7) {
    // 2. Просроченные сессии и токены
    await query('DELETE FROM sessions WHERE expires_at < now()');
    await query(`DELETE FROM tokens WHERE expires_at < now() - interval '7 days'`);
    // 3. Брошенные загрузки
    const hours = s['retention.upload_tmp_hours'] || 48;
    const stale = await many(`UPDATE uploads SET status = 'expired' WHERE status = 'active' AND updated_at < now() - ($1 || ' hours')::interval RETURNING *`, [String(hours)]);
    for (const u of stale) {
      await fsp.unlink(u.tmp_path).catch(() => {});
      if (u.video_id) {
        const v = await one(`SELECT id FROM videos WHERE id = $1 AND status = 'uploading'`, [u.video_id]);
        if (v) { await query('DELETE FROM videos WHERE id = $1', [v.id]); await removeDir(storage.videoDir(v.id)).catch(() => {}); }
      }
    }
    out.expiredUploads = stale.length;
    // 4. Старые задания
    await query(`DELETE FROM jobs WHERE status IN ('done','cancelled') AND finished_at < now() - interval '14 days'`);
    await query(`DELETE FROM jobs WHERE status = 'failed' AND finished_at < now() - interval '90 days'`);
    // 5. Уведомления старше 90 дней
    await query(`DELETE FROM notifications WHERE created_at < now() - interval '90 days'`);
    // 6. Напоминания о сроках обязательных просмотров
    try { out.reminders = await sendReminders(); } catch (e) { ctx?.log?.warn({ err: e.message }, 'reminders'); }
    // 7. Автоматически закрываем назначения через 90 дней после срока
    await query(`UPDATE assignments SET status = 'closed', updated_at = now() WHERE status = 'active' AND due_at IS NOT NULL AND due_at < now() - interval '90 days'`);
  }
  if (job.payload.daily || (minute === 15 && new Date().getHours() === 4)) {
    const hist = s['retention.history_days'] || 365;
    const raw = s['retention.raw_views_days'] || 400;
    await query(`DELETE FROM video_views WHERE last_at < now() - ($1 || ' days')::interval`, [String(Math.max(hist, raw))]);
    await query(`DELETE FROM audit_log WHERE created_at < now() - ($1 || ' days')::interval`, [String(s['retention.audit_days'] || 730)]);
    // Сеансы воспроизведения (качество) и журнал вопросов к видеотеке
    await query(`DELETE FROM playback_sessions WHERE created_at < now() - ($1 || ' days')::interval`, [String(s['qoe.retention_days'] || 90)]);
    await query(`DELETE FROM ai_search_log WHERE created_at < now() - interval '180 days'`);
    // 1.6: реплики живых субтитров и закрытые комнаты совместного просмотра
    await query(`DELETE FROM live_captions WHERE created_at < now() - ($1 || ' days')::interval`, [String(s['retention.history_days'] || 365)]);
    await query(`UPDATE watch_parties SET ended_at = now(), playing = false WHERE ended_at IS NULL AND updated_at < now() - interval '12 hours'`);
    await query(`DELETE FROM watch_parties WHERE ended_at IS NOT NULL AND ended_at < now() - interval '30 days'`);
    await query(`DELETE FROM room_messages WHERE room LIKE 'party:%' AND created_at < now() - interval '30 days'`);
    // 1.8: исходники старше заданного срока удаляем — HLS и mp4 остаются, место освобождается
    const origDays = Number(s['storage.originals_days']) || 0;
    if (origDays > 0) {
      const old = await many(
        `SELECT id, original_path, storage_bytes FROM videos
         WHERE original_kept = true AND original_path IS NOT NULL AND status = 'ready' AND deleted_at IS NULL
           AND created_at < now() - ($1 || ' days')::interval LIMIT 50`, [String(origDays)]);
      for (const v of old) {
        try {
          const abs = storage.abs(v.original_path);
          const st = await fsp.stat(abs).catch(() => null);
          await removeFile(abs);
          await query('UPDATE videos SET original_kept = false, original_path = NULL, storage_bytes = greatest(0, storage_bytes - $2) WHERE id = $1',
            [v.id, st ? st.size : 0]);
        } catch (e) { ctx?.log?.warn({ err: e.message, videoId: v.id }, 'originals cleanup'); }
      }
      out.originalsRemoved = old.length;
    }
    // 1.9: правила хранения, архив и пересмотр актуальности — раз в сутки
    if (s['lifecycle.enabled']) {
      try { out.retention = await runRetention({ payload: {} }); } catch (e) { ctx?.log?.warn({ err: e.message }, 'retention'); }
    }
    await query(`DELETE FROM search_history WHERE created_at < now() - interval '180 days'`);
    // Корзина: окончательно удаляем видео, стёртые давнее retention.trash_days (файлы и записи)
    const trashDays = Math.max(1, Number(s['retention.trash_days']) || 30);
    const trashed = await many(`SELECT id FROM videos WHERE deleted_at IS NOT NULL AND deleted_at < now() - ($1 || ' days')::interval LIMIT 200`, [String(trashDays)]);
    for (const v of trashed) {
      await removeDir(storage.videoDir(v.id)).catch(() => {});
      await query('DELETE FROM videos WHERE id = $1', [v.id]);
    }
    out.purgedVideos = trashed.length;
    // Синхронизация счётчиков
    await query(`UPDATE users u SET subscriber_count = (SELECT count(*) FROM subscriptions s WHERE s.channel_id = u.id),
      video_count = (SELECT count(*) FROM videos v WHERE v.owner_id = u.id AND v.deleted_at IS NULL AND v.status = 'ready'),
      total_views = (SELECT coalesce(sum(view_count),0) FROM videos v WHERE v.owner_id = u.id AND v.deleted_at IS NULL)`);
    await query(`UPDATE categories c SET video_count = (SELECT count(*) FROM videos v WHERE v.category_id = c.id AND v.deleted_at IS NULL AND v.status = 'ready')`);
    out.daily = true;
  }
  return out;
}
