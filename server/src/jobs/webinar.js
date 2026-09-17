// Вебинары: письма-напоминания (за сутки, за час, за 15 минут), письмо-послесловие с записью
// и материалами, сертификаты участникам, которые пробыли в эфире дольше порога.
import { one, many, query } from '../db.js';
import { config } from '../config.js';
import { loadSettings } from '../lib/settings.js';
import { templates, emailEnabled } from '../lib/mailer.js';
import { notify } from '../lib/notify.js';

const LEADS = [
  { key: '1440', minutes: 1440, label: 'завтра' },
  { key: '60', minutes: 60, label: 'через час' },
  { key: '15', minutes: 15, label: 'через 15 минут' },
];

const whenLabel = (d) => (d ? new Date(d).toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short' }) : '');
const pageUrl = (s) => `${config.baseUrl}/webinar/${s.slug || s.short_id}`;
const joinUrl = (s, r) => (r.token ? `${pageUrl(s)}?t=${r.token}` : pageUrl(s));

/** Напоминания участникам о ближайших вебинарах. */
export async function sendWebinarReminders() {
  const s = await loadSettings();
  if (!s['webinars.enabled']) return { sent: 0 };
  let sent = 0;
  const mailOk = await emailEnabled();
  const streams = await many(
    `SELECT * FROM live_streams WHERE webinar AND status <> 'ended' AND scheduled_at IS NOT NULL
       AND scheduled_at BETWEEN now() - interval '5 minutes' AND now() + interval '25 hours'`);
  for (const w of streams) {
    const minutesLeft = (new Date(w.scheduled_at).getTime() - Date.now()) / 60000;
    for (const lead of LEADS) {
      if (minutesLeft > lead.minutes || minutesLeft < lead.minutes - 20) continue;   // окно 20 минут
      const regs = await many(
        `SELECT * FROM live_registrations WHERE stream_id = $1 AND status = 'approved' AND NOT (reminded ? $2) LIMIT 500`,
        [w.id, lead.key]);
      for (const r of regs) {
        if (mailOk && r.email) {
          await templates.webinarReminder({ to: r.email, name: r.name || 'коллега', title: w.title, when: whenLabel(w.scheduled_at), url: joinUrl(w, r), leadLabel: lead.label }).catch(() => {});
        }
        if (r.user_id) {
          await notify(r.user_id, { type: 'live_reminder', title: `Вебинар ${lead.label}: ${w.title}`, body: whenLabel(w.scheduled_at), link: `/webinar/${w.slug || w.short_id}`, data: { streamId: w.id } });
        }
        await query(`UPDATE live_registrations SET reminded = reminded || jsonb_build_object($2::text, to_jsonb(now())) WHERE id = $1`, [r.id, lead.key]);
        sent += 1;
      }
    }
  }
  return { sent };
}

/** Порог присутствия в секундах для сертификата. */
export function certThreshold(w, durationSec) {
  const pct = Math.max(1, Math.min(100, Number(w.cert_min_percent) || 60));
  return Math.round((durationSec || 0) * pct / 100);
}

/** Выдать сертификаты участникам вебинара (после эфира). */
export async function issueWebinarCertificates(w) {
  const s = await loadSettings();
  if (!w.cert_enabled || !s['certificates.enabled']) return { issued: 0 };
  const durationSec = w.started_at && w.ended_at ? (new Date(w.ended_at) - new Date(w.started_at)) / 1000 : 0;
  const need = certThreshold(w, durationSec);
  const regs = await many(
    `SELECT r.*, COALESCE(a.seconds, 0) AS attend_seconds FROM live_registrations r
     LEFT JOIN live_attendance a ON a.stream_id = r.stream_id AND a.user_id = r.user_id
     WHERE r.stream_id = $1 AND r.status = 'approved' AND r.cert_id IS NULL`, [w.id]);
  let issued = 0;
  for (const r of regs) {
    const seconds = Math.max(Number(r.seconds) || 0, Number(r.attend_seconds) || 0);
    if (!r.user_id || seconds < need || seconds <= 0) continue;
    const seq = await one("SELECT nextval('certificates_number_seq')::int AS n");
    const number = `CV-${new Date().getFullYear()}-${String(seq.n).padStart(5, '0')}`;
    const details = {
      kind: 'webinar', webinar: w.title, minutes: Math.round(seconds / 60),
      requiredMinutes: Math.round(need / 60), heldAt: w.started_at,
      issuerName: s['certificates.issuer_name'] || s['site.name'], issuerTitle: s['certificates.issuer_title'],
      text: s['certificates.text'], siteName: s['site.name'],
    };
    const c = await one(
      `INSERT INTO certificates(number, user_id, title, details) VALUES ($1,$2,$3,$4::jsonb) RETURNING *`,
      [number, r.user_id, `Участие в вебинаре «${w.title}»`, JSON.stringify(details)]);
    await query('UPDATE live_registrations SET cert_id = $2 WHERE id = $1', [r.id, c.id]);
    await notify(r.user_id, { type: 'certificate', title: 'Сертификат участника вебинара', body: `${w.title} — № ${number}`, link: `/cert/${c.id}`, data: { certificateId: c.id } });
    issued += 1;
  }
  return { issued };
}

/** Письмо-послесловие: ссылка на запись, материалы, сертификат. */
export async function sendWebinarFollowup(w, { force = false } = {}) {
  const s = await loadSettings();
  if (!w.webinar) return { sent: 0, skipped: 'not-webinar' };
  if (w.followup_sent_at && !force) return { sent: 0, skipped: 'already' };
  const rec = w.recording_video_id ? await one('SELECT short_id FROM videos WHERE id = $1', [w.recording_video_id]) : null;
  if (!rec && !force && w.record) return { sent: 0, skipped: 'no-recording' };   // ждём обработку записи
  const materials = await many('SELECT * FROM webinar_materials WHERE stream_id = $1 ORDER BY position', [w.id]);
  const regs = await many(`SELECT * FROM live_registrations WHERE stream_id = $1 AND status = 'approved'`, [w.id]);
  const mailOk = await emailEnabled();
  let sent = 0;
  for (const r of regs) {
    const attended = (Number(r.seconds) || 0) > 60;
    if (mailOk && r.email) {
      await templates.webinarFollowup({
        to: r.email, name: r.name || 'коллега', title: w.title,
        url: `${config.baseUrl}/webinar/${w.slug || w.short_id}`,
        recordingUrl: rec ? `${config.baseUrl}/watch/${rec.short_id}` : null,
        materials: materials.map((m) => ({ name: m.name, url: `${config.baseUrl}/media/${m.path}` })),
        certUrl: r.cert_id ? `${config.baseUrl}/cert/${r.cert_id}` : null,
        attended,
      }).catch(() => {});
    }
    if (r.user_id && rec) {
      await notify(r.user_id, { type: 'video_ready', title: `Запись вебинара готова: ${w.title}`, body: 'Материалы и сертификат — на странице вебинара', link: `/watch/${rec.short_id}`, data: { streamId: w.id } });
    }
    sent += 1;
  }
  await query('UPDATE live_streams SET followup_sent_at = now() WHERE id = $1', [w.id]);
  return { sent, recording: rec?.short_id || null };
}

/** Обслуживание: завершившиеся вебинары — сертификаты и послесловие. */
export async function runWebinarMaintenance() {
  const s = await loadSettings();
  if (!s['webinars.enabled']) return { skipped: 'disabled' };
  const out = { reminders: await sendWebinarReminders(), certificates: 0, followups: 0 };
  const done = await many(
    `SELECT * FROM live_streams WHERE webinar AND status = 'ended' AND ended_at > now() - interval '7 days' AND followup_sent_at IS NULL`);
  for (const w of done) {
    // Даём записи время обработаться: письмо уходит либо когда запись готова, либо через 2 часа
    const waited = Date.now() - new Date(w.ended_at).getTime() > 2 * 3600 * 1000;
    if (w.cert_enabled) out.certificates += (await issueWebinarCertificates(w)).issued;
    if (w.recording_video_id || waited || !w.record) {
      const r = await sendWebinarFollowup(w, { force: waited });
      if (r.sent) out.followups += r.sent;
    }
  }
  return out;
}
