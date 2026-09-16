// Назначения «к обязательному просмотру»: адресаты, прогресс, уведомления и напоминания.
import { one, many, query } from '../db.js';
import { notify } from './notify.js';
import { templates } from './mailer.js';
import { config } from '../config.js';
import { loadSettings } from './settings.js';
import { emitEvent, eventVideo, eventUser } from './events.js';
import { xapiStatement, xapiResultForProgress } from './xapi.js';

/** Все активные пользователи-адресаты назначения (по сотрудникам, группам или «всем»). */
export async function resolveTargetUsers(assignmentId) {
  return many(
    `SELECT DISTINCT u.id, u.email, u.display_name, u.prefs FROM users u
     JOIN assignment_targets t ON t.assignment_id = $1
     WHERE u.status = 'active' AND u.deleted_at IS NULL
       AND (t.target_type = 'all' OR t.user_id = u.id OR (t.target_type = 'group' AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = t.group_id AND gm.user_id = u.id)))`,
    [assignmentId],
  );
}

/** Видео, входящие в назначение (одно видео или содержимое плейлиста). */
export async function assignmentVideos(a) {
  if (a.kind === 'video') return many(`SELECT id, title, duration, short_id FROM videos WHERE id = $1 AND deleted_at IS NULL`, [a.video_id]);
  return many(
    `SELECT v.id, v.title, v.duration, v.short_id FROM playlist_items pi JOIN videos v ON v.id = pi.video_id
     WHERE pi.playlist_id = $1 AND v.deleted_at IS NULL AND v.status = 'ready' ORDER BY pi.position`,
    [a.playlist_id],
  );
}

/** Активные назначения, адресованные пользователю и содержащие это видео. */
export async function assignmentsForUserVideo(userId, videoId) {
  return many(
    `SELECT DISTINCT a.* FROM assignments a JOIN assignment_targets t ON t.assignment_id = a.id
     WHERE a.status = 'active' AND (a.video_id = $2 OR a.playlist_id IN (SELECT playlist_id FROM playlist_items WHERE video_id = $2))
       AND (t.target_type = 'all' OR t.user_id = $1 OR (t.target_type = 'group' AND t.group_id IN (SELECT group_id FROM group_members WHERE user_id = $1)))`,
    [userId, videoId],
  );
}

/** Обновить прогресс по назначениям после отметки просмотра (вызывается из /progress). */
export async function updateAssignmentProgress(userId, video, maxPosition) {
  const list = await assignmentsForUserVideo(userId, video.id);
  if (!list.length) return;
  const duration = Number(video.duration) || 0;
  const percent = duration > 0 ? Math.min(100, Math.round((Number(maxPosition) / duration) * 100)) : 0;
  for (const a of list) {
    const quizOk = await quizRequirementMet(a, video.id, userId);
    const done = percent >= a.required_percent && quizOk;
    const prev = await one('SELECT completed_at FROM assignment_progress WHERE assignment_id = $1 AND user_id = $2 AND video_id = $3', [a.id, userId, video.id]);
    await query(
      `INSERT INTO assignment_progress(assignment_id, user_id, video_id, percent, completed_at, last_at)
       VALUES ($1,$2,$3,$4, CASE WHEN $5 THEN now() END, now())
       ON CONFLICT (assignment_id, user_id, video_id) DO UPDATE SET
         percent = greatest(assignment_progress.percent, EXCLUDED.percent),
         completed_at = COALESCE(assignment_progress.completed_at, EXCLUDED.completed_at),
         last_at = now()`,
      [a.id, userId, video.id, percent, done],
    );
    if (done && a.certificate) await issueIfComplete(a, userId);
    if (done && !prev?.completed_at) await afterVideoCompleted(a, userId, video, percent);
  }
}

/** Видео назначения впервые засчитано: xAPI «completed», событие о выполнении всего назначения. */
async function afterVideoCompleted(a, userId, video, percent) {
  try {
    const u = await one('SELECT * FROM users WHERE id = $1', [userId]);
    const v = video.short_id ? video : await one('SELECT * FROM videos WHERE id = $1', [video.id]);
    if (u && v) await xapiStatement('completed', { user: u, video: v, result: xapiResultForProgress(percent, v.duration, true), context: { contextActivities: { parent: [{ id: `${config.baseUrl}/assignments/${a.id}`, definition: { name: { 'ru-RU': 'Назначение' }, type: 'http://adlnet.gov/expapi/activities/course' } }] } } });
    const videos = await assignmentVideos(a);
    const doneRows = await one('SELECT count(*)::int AS n FROM assignment_progress WHERE assignment_id = $1 AND user_id = $2 AND completed_at IS NOT NULL AND video_id = ANY($3)', [a.id, userId, videos.map((x) => x.id)]);
    if (videos.length && doneRows.n >= videos.length) {
      await emitEvent('assignment.completed', { assignment: { id: a.id, kind: a.kind, videoId: a.video_id, playlistId: a.playlist_id, dueAt: a.due_at, requiredPercent: a.required_percent, requireQuiz: a.require_quiz }, user: eventUser(u), video: eventVideo(v), percent });
    }
  } catch (e) { console.error('assignment events', e.message); }
}

async function issueIfComplete(a, userId) {
  try { const { maybeIssueCertificate } = await import('./certificates.js'); await maybeIssueCertificate(a, userId); } catch (e) { console.error('certificate', e.message); }
}

/** При создании назначения: засчитать уже состоявшиеся просмотры и сданные тесты адресатов. */
export async function seedProgress(a) {
  const users = await resolveTargetUsers(a.id);
  const videos = await assignmentVideos(a);
  let seeded = 0;
  for (const v of videos) {
    const duration = Number(v.duration) || 0;
    for (const u of users) {
      const row = await one('SELECT max(max_position)::float AS m, max(last_at) AS last_at FROM video_views WHERE video_id = $1 AND user_id = $2', [v.id, u.id]);
      if (!row?.m) continue;
      const percent = duration > 0 ? Math.min(100, Math.round((row.m / duration) * 100)) : 0;
      const quizOk = await quizRequirementMet(a, v.id, u.id);
      const quizRow = a.require_quiz ? await one('SELECT bool_or(passed) AS p FROM quiz_attempts WHERE video_id = $1 AND user_id = $2', [v.id, u.id]) : null;
      const done = percent >= a.required_percent && quizOk;
      await query(
        `INSERT INTO assignment_progress(assignment_id, user_id, video_id, percent, quiz_passed, completed_at, last_at) VALUES ($1,$2,$3,$4,$5, CASE WHEN $6 THEN $7::timestamptz END, $7::timestamptz)
         ON CONFLICT (assignment_id, user_id, video_id) DO NOTHING`,
        [a.id, u.id, v.id, percent, quizRow ? quizRow.p : null, done, row.last_at || new Date()],
      );
      seeded++;
      if (done && a.certificate) await issueIfComplete(a, u.id);
    }
  }
  return seeded;
}

/** После прохождения теста: отметить, что требование теста выполнено. */
export async function markQuizPassed(userId, videoId, passed) {
  const list = await assignmentsForUserVideo(userId, videoId);
  for (const a of list) {
    const p = await one('SELECT * FROM assignment_progress WHERE assignment_id = $1 AND user_id = $2 AND video_id = $3', [a.id, userId, videoId]);
    const percent = p?.percent || 0;
    const done = passed && percent >= a.required_percent;
    await query(
      `INSERT INTO assignment_progress(assignment_id, user_id, video_id, percent, quiz_passed, completed_at, last_at)
       VALUES ($1,$2,$3,$4,$5, CASE WHEN $6 THEN now() END, now())
       ON CONFLICT (assignment_id, user_id, video_id) DO UPDATE SET
         quiz_passed = EXCLUDED.quiz_passed OR COALESCE(assignment_progress.quiz_passed, false),
         completed_at = COALESCE(assignment_progress.completed_at, EXCLUDED.completed_at), last_at = now()`,
      [a.id, userId, videoId, percent, passed, done],
    );
    if (done && a.certificate) await issueIfComplete(a, userId);
    if (done && !p?.completed_at) await afterVideoCompleted(a, userId, { id: videoId }, percent);
  }
}

async function quizRequirementMet(a, videoId, userId) {
  if (!a.require_quiz) return true;
  const q = await one('SELECT id FROM video_quizzes WHERE video_id = $1 AND jsonb_array_length(questions) > 0', [videoId]);
  if (!q) return true; // теста нет — требование не применяется
  const ok = await one('SELECT 1 FROM quiz_attempts WHERE quiz_id = $1 AND user_id = $2 AND passed LIMIT 1', [q.id, userId]);
  return !!ok;
}

/** Сводка выполнения назначения по всем адресатам. */
export async function assignmentReport(a) {
  const users = await resolveTargetUsers(a.id);
  const videos = await assignmentVideos(a);
  const rows = await many('SELECT * FROM assignment_progress WHERE assignment_id = $1', [a.id]);
  const byUser = new Map();
  for (const r of rows) {
    const m = byUser.get(r.user_id) || new Map();
    m.set(r.video_id, r); byUser.set(r.user_id, m);
  }
  const people = users.map((u) => {
    const m = byUser.get(u.id) || new Map();
    let sum = 0; let completed = 0; let lastAt = null; let quiz = null;
    for (const v of videos) {
      const p = m.get(v.id);
      sum += p?.percent || 0;
      if (p?.completed_at) completed++;
      if (p?.last_at && (!lastAt || p.last_at > lastAt)) lastAt = p.last_at;
      if (p && p.quiz_passed != null) quiz = quiz === false ? false : p.quiz_passed;
    }
    const total = videos.length || 1;
    return {
      id: u.id, email: u.email, displayName: u.display_name,
      percent: Math.round(sum / total), completedVideos: completed, totalVideos: videos.length,
      completed: videos.length > 0 && completed === videos.length, lastAt, quizPassed: quiz,
    };
  }).sort((x, y) => Number(x.completed) - Number(y.completed) || y.percent - x.percent || x.displayName.localeCompare(y.displayName, 'ru'));
  const done = people.filter((p) => p.completed).length;
  return { people, videos, total: people.length, completed: done, overdue: a.due_at && new Date(a.due_at) < new Date() ? people.length - done : 0 };
}

/** Уведомить адресатов о новом назначении. */
export async function notifyAssigned(a, actorId) {
  const users = await resolveTargetUsers(a.id);
  const link = a.kind === 'video' ? `/watch/${(await one('SELECT short_id FROM videos WHERE id = $1', [a.video_id]))?.short_id}` : `/playlist/${a.playlist_id}`;
  const due = a.due_at ? ` до ${new Date(a.due_at).toLocaleDateString('ru-RU')}` : '';
  const s = await loadSettings();
  for (const u of users) {
    if (u.id === actorId) continue;
    await notify(u.id, {
      type: 'assignment', title: `Вам назначено к просмотру: ${a.title}`, body: `Обязательный просмотр${due}${a.note ? ' — ' + a.note : ''}`, link: '/assignments', actorId, data: { assignmentId: a.id, link },
    }, { email: s['smtp.enabled'] ? () => templates.assignment({ to: u.email, name: u.display_name, title: a.title, due: a.due_at, note: a.note, url: `${config.baseUrl}${link}` }) : null });
  }
  return users.length;
}

/** Напомнить всем, кто ещё не выполнил назначение. Возвращает число уведомлений. */
export async function remindAssignment(a, settings = null) {
  const s = settings || await loadSettings();
  const report = await assignmentReport(a);
  const link = a.kind === 'video' ? `/watch/${(await one('SELECT short_id FROM videos WHERE id = $1', [a.video_id]))?.short_id}` : `/playlist/${a.playlist_id}`;
  const due = a.due_at ? ` до ${new Date(a.due_at).toLocaleDateString('ru-RU')}` : '';
  let sent = 0;
  for (const p of report.people) {
    if (p.completed) continue;
    await notify(p.id, {
      type: 'assignment_reminder', title: `Напоминание: «${a.title}» нужно посмотреть${due}`,
      body: `Просмотрено ${p.percent}%`, link: '/assignments', data: { assignmentId: a.id, link },
    }, { email: s['smtp.enabled'] ? () => templates.assignmentReminder({ to: p.email, name: p.displayName, title: a.title, due: a.due_at, percent: p.percent, url: `${config.baseUrl}${link}` }) : null });
    sent++;
  }
  await query('UPDATE assignments SET reminded_at = now() WHERE id = $1', [a.id]);
  return sent;
}

/** Напоминания о приближающемся сроке (вызывается обслуживанием раз в час). */
export async function sendReminders() {
  const s = await loadSettings();
  const due = await many(
    `SELECT * FROM assignments WHERE status = 'active' AND due_at IS NOT NULL AND reminded_at IS NULL
       AND due_at > now() AND due_at <= now() + (remind_days || ' days')::interval`,
  );
  let sent = 0;
  for (const a of due) sent += await remindAssignment(a, s);
  return sent;
}

export function assignmentOut(a, extra = {}) {
  return {
    id: a.id, kind: a.kind, videoId: a.video_id, playlistId: a.playlist_id, title: a.title, note: a.note,
    dueAt: a.due_at, requiredPercent: a.required_percent, requireQuiz: a.require_quiz, remindDays: a.remind_days,
    attentionCheckMin: a.attention_check_min || 0, certificate: !!a.certificate,
    status: a.status, createdAt: a.created_at, createdBy: a.created_by, creatorName: a.creator_name,
    videoShortId: a.video_short_id, thumbnailUrl: a.thumbnail_path ? `/media/${a.thumbnail_path}` : null,
    ...extra,
  };
}
