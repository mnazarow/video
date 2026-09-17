// Интеграционные тесты API. Требуют запущенных API (BASE) и воркера, а также ffmpeg.
// Запуск: BASE=http://localhost:3000 node --test test/
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN = { login: process.env.ADMIN_EMAIL || 'admin@vodokomfort.ru', password: process.env.ADMIN_PASSWORD || 'Admin12345' };

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (this.cookie) headers.cookie = this.cookie;
    let payload = body;
    if (body && !(body instanceof Buffer) && !(body instanceof FormData) && typeof body !== 'string') { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + url, { method, headers, body: payload, redirect: 'manual' });
    const sc = res.headers.getSetCookie?.() || [];
    for (const c of sc) {
      const [pair] = c.split(';');
      const [name] = pair.split('=');
      const others = this.cookie.split('; ').filter((x) => x && !x.startsWith(name + '='));
      this.cookie = [...others, pair].join('; ');
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  get(u) { return this.req('GET', u); }
  post(u, b, o) { return this.req('POST', u, b, o); }
  patch(u, b, o) { return this.req('PATCH', u, b, o); }
  put(u, b) { return this.req('PUT', u, b); }
  del(u) { return this.req('DELETE', u); }
}

const admin = new Client();
const user = new Client();
const guest = new Client();
const stamp = Date.now().toString(36);
const userEmail = `tester.${stamp}@vodokomfort.ru`;
let videoId, shortId;

before(async () => {
  const r = await admin.post('/api/auth/login', ADMIN);
  assert.equal(r.status, 200, 'admin login: ' + r.text);
});

test('регистрация: запрещённый домен отклоняется', async () => {
  const r = await guest.post('/api/auth/register', { email: `x${stamp}@gmail.com`, password: 'Password123', displayName: 'Чужой' });
  assert.equal(r.status, 403);
});

test('регистрация с разрешённого домена → ожидание одобрения → одобрение админом', async () => {
  const r = await user.post('/api/auth/register', { email: userEmail, password: 'Password123', displayName: 'Тестовый Пользователь' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'pending_approval'); // SMTP не настроен → без подтверждения e-mail
  const me = await user.get('/api/auth/me');
  assert.equal(me.json.user.status, 'pending_approval');
  // Неактивный пользователь не может загружать
  const up = await user.post('/api/uploads', { filename: 'a.mp4', size: 100 });
  assert.equal(up.status, 403);
  // Админ видит заявку и одобряет
  const list = await admin.get('/api/admin/users?status=pending_approval');
  const found = list.json.users.find((u) => u.email === userEmail);
  assert.ok(found, 'заявка в списке');
  const ap = await admin.post(`/api/admin/users/${found.id}/approve`, {});
  assert.equal(ap.status, 200);
  const me2 = await user.get('/api/auth/me');
  assert.equal(me2.json.user.status, 'active');
});

test('загрузка видео по частям, транскодирование воркером', async () => {
  const tmp = path.join(os.tmpdir(), `cv-test-${stamp}.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', tmp]);
  const data = fs.readFileSync(tmp);
  const init = await user.post('/api/uploads', { filename: 'Тестовое видео.mp4', size: data.length, mime: 'video/mp4', title: 'Тестовое видео', visibility: 'internal' });
  assert.equal(init.status, 200, init.text);
  const { uploadId, chunkSize } = init.json;
  videoId = init.json.videoId; shortId = init.json.shortId;
  const chunk = Math.min(chunkSize, 200000);
  for (let off = 0; off < data.length; off += chunk) {
    const part = data.subarray(off, Math.min(data.length, off + chunk));
    const r = await user.req('PATCH', `/api/uploads/${uploadId}`, part, { headers: { 'content-type': 'application/offset+octet-stream', 'upload-offset': String(off) } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.offset, off + part.length);
  }
  // Повтор с неверным смещением → 409
  const bad = await user.req('PATCH', `/api/uploads/${uploadId}`, data.subarray(0, 10), { headers: { 'content-type': 'application/offset+octet-stream', 'upload-offset': '0' } });
  assert.equal(bad.status, 409);
  const done = await user.post(`/api/uploads/${uploadId}/complete`, {});
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.video.status, 'queued');
  // Ждём обработку
  let v;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const g = await user.get(`/api/videos/${videoId}`);
    v = g.json.video;
    if (v.status === 'ready' || v.status === 'failed') break;
  }
  assert.equal(v.status, 'ready', 'видео обработано: ' + JSON.stringify(v.processingError));
  assert.ok(v.hlsUrl.endsWith('master.m3u8'));
  assert.ok(v.renditions.length >= 1);
  assert.ok(v.thumbnailUrl);
  assert.ok(v.duration > 4 && v.duration < 6);
  fs.unlinkSync(tmp);
});

test('доступ: internal-видео недоступно гостю, HLS раздаётся владельцу', async () => {
  const g = await guest.get(`/api/videos/${shortId}`);
  assert.equal(g.status, 401);
  const v = (await user.get(`/api/videos/${shortId}`)).json.video;
  const m = await user.get(v.hlsUrl);
  assert.equal(m.status, 200);
  assert.ok(m.text.includes('#EXTM3U'));
  const gm = await guest.get(v.hlsUrl);
  assert.equal(gm.status, 401);
  const auth = await guest.req('GET', '/api/media/auth', null, { headers: { 'x-original-uri': v.hlsUrl } });
  assert.equal(auth.status, 401);
  const auth2 = await user.req('GET', '/api/media/auth', null, { headers: { 'x-original-uri': v.hlsUrl } });
  assert.equal(auth2.status, 200);
});

test('редактирование: публичная видимость, теги, главы; гость видит публичное', async () => {
  const r = await user.patch(`/api/videos/${videoId}`, { visibility: 'public', tags: ['тест', 'обучение'], description: '0:00 Начало\n0:02 Середина\nОписание #hashtag', categoryId: 1 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.video.visibility, 'public');
  assert.deepEqual(r.json.video.tags, ['тест', 'обучение']);
  assert.equal(r.json.video.chapters.length, 2);
  const g = await guest.get(`/api/videos/${shortId}`);
  assert.equal(g.status, 200);
  const home = await guest.get('/api/feed/home');
  assert.equal(home.status, 200);
  assert.ok(home.json.sections.some((s) => (s.videos || []).some((v) => v.id === videoId)));
});

test('просмотры и прогресс', async () => {
  let r;
  for (let i = 0; i < 3; i++) r = await guest.post(`/api/videos/${shortId}/progress`, { position: 1 + i, watchedDelta: 4, buckets: [i * 10], source: 'home' });
  assert.equal(r.status, 200);
  assert.equal(r.json.counted, true);
  const v = (await user.get(`/api/videos/${shortId}`)).json.video;
  assert.equal(v.viewCount, 1);
  const a = await user.get(`/api/videos/${videoId}/analytics?range=7d`);
  assert.equal(a.status, 200);
  assert.equal(a.json.analytics.totals.views, 1);
  assert.match(a.json.analytics.daily[0].day, /^\d{4}-\d{2}-\d{2}$/);
});

test('лайки, комментарии, ответы, закрепление', async () => {
  const like = await user.post(`/api/videos/${shortId}/like`, { value: 1 });
  assert.equal(like.json.likeCount, 1);
  const c = await user.post(`/api/videos/${shortId}/comments`, { body: 'Первый комментарий' });
  assert.equal(c.status, 200, c.text);
  const reply = await admin.post(`/api/videos/${shortId}/comments`, { body: 'Ответ', parentId: c.json.comment.id });
  assert.equal(reply.status, 200);
  const list = await guest.get(`/api/videos/${shortId}/comments`);
  assert.equal(list.json.comments.length, 1);
  assert.equal(list.json.comments[0].replyCount, 1);
  const replies = await guest.get(`/api/comments/${c.json.comment.id}/replies`);
  assert.equal(replies.json.comments.length, 1);
  const pin = await user.post(`/api/comments/${c.json.comment.id}/pin`, { pinned: true });
  assert.equal(pin.json.pinned, true);
  const notif = await user.get('/api/notifications');
  assert.ok(notif.json.notifications.some((n) => n.type === 'comment_reply'));
});

test('плейлисты и «смотреть позже»', async () => {
  const p = await user.post('/api/playlists', { title: 'Мой плейлист', visibility: 'internal', videoId });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.json.playlist.itemCount, 1);
  const wl = await user.post('/api/playlists/watch-later/toggle', { videoId });
  assert.equal(wl.json.inWatchLater, true);
  const mine = await user.get('/api/playlists');
  assert.ok(mine.json.playlists.some((x) => x.kind === 'watch_later' && x.itemCount === 1));
  const view = await guest.get(`/api/playlists/${p.json.playlist.id}`);
  assert.equal(view.status, 403);
});

test('поиск и подсказки', async () => {
  const s = await guest.get('/api/search?q=' + encodeURIComponent('тестовое'));
  assert.equal(s.status, 200, s.text);
  assert.ok(s.json.videos.some((v) => v.id === videoId), 'найдено по названию');
  const tag = await guest.get('/api/search?q=' + encodeURIComponent('обучение'));
  assert.ok(tag.json.videos.some((v) => v.id === videoId), 'найдено по тегу');
  const sug = await user.get('/api/search/suggest?q=' + encodeURIComponent('тест'));
  assert.ok(sug.json.suggestions.length >= 1);
});

test('подписки и канал', async () => {
  const me = (await user.get('/api/auth/me')).json.user;
  const ch = await admin.get(`/api/channels/${me.handle}`);
  assert.equal(ch.status, 200);
  const sub = await admin.post(`/api/channels/${me.handle}/subscribe`, {});
  assert.equal(sub.json.subscribed, true);
  assert.equal(sub.json.subscriberCount, 1);
  const feed = await admin.get('/api/feed/subscriptions');
  assert.ok(feed.json.videos.some((v) => v.id === videoId));
});

test('модерация: блокировка и разблокировка администратором', async () => {
  const b = await admin.post(`/api/admin/videos/${videoId}/block`, { reason: 'проверка' });
  assert.equal(b.status, 200);
  const g = await guest.get(`/api/videos/${shortId}`);
  assert.equal(g.status, 401);
  const u = await admin.post(`/api/admin/videos/${videoId}/unblock`, {});
  assert.equal(u.status, 200);
  const g2 = await guest.get(`/api/videos/${shortId}`);
  assert.equal(g2.status, 200);
});

test('домены и настройки в админке', async () => {
  const d = await admin.post('/api/admin/domains', { domain: `test-${stamp}.ru`, autoApprove: true });
  assert.equal(d.status, 200, d.text);
  const list = await admin.get('/api/admin/domains');
  assert.ok(list.json.domains.some((x) => x.domain === `test-${stamp}.ru`));
  await admin.del(`/api/admin/domains/${d.json.domain.id}`);
  const s = await admin.get('/api/admin/settings');
  assert.equal(s.json.settings['site.name'], 'Водокомфорт Видео');
  const put = await admin.put('/api/admin/settings', { settings: { 'upload.premoderation': false, 'site.tagline': 'Тест' } });
  assert.equal(put.json.settings['site.tagline'], 'Тест');
  await admin.put('/api/admin/settings', { settings: { 'site.tagline': 'Корпоративный видеохостинг' } });
  const stats = await admin.get('/api/admin/stats');
  assert.ok(stats.json.videos.total >= 1);
  const forbidden = await user.get('/api/admin/stats');
  assert.equal(forbidden.status, 403);
});

test('трансляции: создание, хук авторизации', async () => {
  const s = await user.post('/api/studio/live', { title: 'Тестовый эфир', visibility: 'internal' });
  assert.equal(s.status, 200, s.text);
  assert.ok(s.json.stream.streamKey);
  const ok = await guest.post('/api/live/hooks/auth', { action: 'publish', path: `live/${s.json.stream.streamKey}`, protocol: 'rtmp' });
  assert.equal(ok.status, 200);
  const bad = await guest.post('/api/live/hooks/auth', { action: 'publish', path: 'live/wrongkey', protocol: 'rtmp' });
  assert.equal(bad.status, 403);
  const chat = await user.post(`/api/live/${s.json.stream.shortId}/chat`, { body: 'Привет!' });
  assert.equal(chat.status, 200, chat.text);
  const msgs = await user.get(`/api/live/${s.json.stream.shortId}/chat`);
  assert.equal(msgs.json.messages.length, 1);
  await user.del(`/api/studio/live/${s.json.stream.id}`);
});

test('токен API и простая загрузка', async () => {
  const t = await user.post('/api/me/tokens', { name: 'тест' });
  assert.ok(t.json.token.startsWith('cv_'));
  const api = new Client();
  const me = await api.req('GET', '/api/auth/me', null, { headers: { authorization: `Bearer ${t.json.token}` } });
  assert.equal(me.json.user.email, userEmail);
});

// --- Корпоративные функции 1.1 -------------------------------------------------------------
const viewer = new Client();
const viewerEmail = `viewer.${stamp}@vodokomfort.ru`;
let groupId, assignmentId, shareToken;

test('группы: создание, добавление по e-mail, справочник для сотрудников', async () => {
  const reg = await viewer.post('/api/auth/register', { email: viewerEmail, password: 'Password123', displayName: 'Зритель Тестовый' });
  assert.equal(reg.status, 200, reg.text);
  const list = await admin.get('/api/admin/users?status=pending_approval');
  const found = list.json.users.find((u) => u.email === viewerEmail);
  await admin.post(`/api/admin/users/${found.id}/approve`, {});
  const g = await admin.post('/api/admin/groups', { name: `Отдел продаж ${stamp}`, description: 'тест' });
  assert.equal(g.status, 200, g.text);
  groupId = g.json.group.id;
  const dup = await admin.post('/api/admin/groups', { name: `отдел продаж ${stamp}` });
  assert.equal(dup.status, 409, 'название без учёта регистра уникально');
  const add = await admin.post(`/api/admin/groups/${groupId}/members`, { users: [viewerEmail, 'nobody@vodokomfort.ru'] });
  assert.equal(add.status, 200, add.text);
  assert.equal(add.json.added, 1);
  assert.deepEqual(add.json.notFound, ['nobody@vodokomfort.ru']);
  assert.equal(add.json.group.memberCount, 1);
  const mine = await viewer.get('/api/groups/mine');
  assert.ok(mine.json.groups.some((x) => x.id === groupId));
  const dir = await user.get('/api/groups?q=продаж');
  assert.ok(dir.json.groups.some((x) => x.id === groupId));
  const members = await admin.get(`/api/admin/groups/${groupId}`);
  assert.equal(members.json.members[0].email, viewerEmail);
  const forbidden = await user.post('/api/admin/groups', { name: 'x' });
  assert.equal(forbidden.status, 403);
});

test('доступ к приватному видео по группе', async () => {
  const r = await user.patch(`/api/videos/${videoId}`, { visibility: 'private', accessGroups: [] });
  assert.equal(r.status, 200, r.text);
  const denied = await viewer.get(`/api/videos/${shortId}`);
  assert.equal(denied.status, 403);
  const r2 = await user.patch(`/api/videos/${videoId}`, { accessGroups: [groupId] });
  assert.equal(r2.status, 200, r2.text);
  assert.equal(r2.json.video.accessGroups.length, 1);
  const ok = await viewer.get(`/api/videos/${shortId}`);
  assert.equal(ok.status, 200, ok.text);
  const hls = await viewer.get(ok.json.video.hlsUrl);
  assert.equal(hls.status, 200);
  const auth = await viewer.req('GET', '/api/media/auth', null, { headers: { 'x-original-uri': ok.json.video.hlsUrl } });
  assert.equal(auth.status, 200);
});

test('назначение к обязательному просмотру: создание, прогресс, отчёт, CSV', async () => {
  const noRights = await viewer.post('/api/assignments', { videoId, targets: [{ type: 'all' }] });
  assert.equal(noRights.status, 403, 'обычный сотрудник не назначает (who_can_assign=staff)');
  const due = new Date(Date.now() + 2 * 86400000).toISOString();
  const a = await admin.post('/api/assignments', { videoId, targets: [{ type: 'group', id: groupId }], dueAt: due, note: 'Обязательно', requiredPercent: 80 });
  assert.equal(a.status, 200, a.text);
  assignmentId = a.json.assignment.id;
  assert.equal(a.json.assignment.requiredPercent, 80);
  const mine = await viewer.get('/api/assignments/mine');
  assert.equal(mine.status, 200, mine.text);
  const m = mine.json.assignments.find((x) => x.id === assignmentId);
  assert.ok(m, 'назначение видно адресату');
  assert.equal(m.completed, false);
  const notif = await viewer.get('/api/notifications');
  assert.ok(notif.json.notifications.some((n) => n.type === 'assignment'), 'уведомление о назначении');
  // Просмотр почти до конца → выполнено
  const v = (await viewer.get(`/api/videos/${shortId}`)).json.video;
  const p = await viewer.post(`/api/videos/${shortId}/progress`, { position: v.duration - 0.2, watchedDelta: v.duration, buckets: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90], source: 'assignments' });
  assert.equal(p.status, 200, p.text);
  const mine2 = await viewer.get('/api/assignments/mine');
  const m2 = mine2.json.assignments.find((x) => x.id === assignmentId);
  assert.equal(m2.completed, true, JSON.stringify(m2));
  const report = await admin.get(`/api/assignments/${assignmentId}`);
  assert.equal(report.status, 200, report.text);
  assert.equal(report.json.report.total, 1);
  assert.equal(report.json.report.completed, 1);
  assert.equal(report.json.report.people[0].email, viewerEmail);
  const csv = await admin.get(`/api/assignments/${assignmentId}?format=csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(csv.text.includes(viewerEmail));
  const list = await admin.get('/api/assignments');
  assert.ok(list.json.assignments.some((x) => x.id === assignmentId));
  const viewers = await user.get(`/api/videos/${videoId}/viewers`);
  assert.equal(viewers.status, 200, viewers.text);
  assert.ok(viewers.json.viewers.some((x) => x.email === viewerEmail), 'автор видит, кто посмотрел');
});

test('тест внутри видео: редактор, прохождение, результаты', async () => {
  const bad = await user.put(`/api/videos/${videoId}/quiz`, { questions: [{ text: 'Без вариантов', options: [{ text: 'a' }] }] });
  assert.equal(bad.status, 400);
  const q = await user.put(`/api/videos/${videoId}/quiz`, {
    title: 'Проверка', passPercent: 50, questions: [
      { id: 'q1', at: 2, text: 'Сколько будет 2+2?', type: 'single', options: [{ id: 'a', text: '4', correct: true }, { id: 'b', text: '5' }] },
      { id: 'q2', text: 'Выберите чётные', type: 'multiple', options: [{ id: 'a', text: '2', correct: true }, { id: 'b', text: '3' }, { id: 'c', text: '4', correct: true }], explanation: 'Чётные — 2 и 4' },
    ],
  });
  assert.equal(q.status, 200, q.text);
  assert.equal(q.json.quiz.questions.length, 2);
  const card = (await user.get(`/api/videos/${shortId}`)).json.video;
  assert.equal(card.hasQuiz, true);
  const forViewer = await viewer.get(`/api/videos/${shortId}/quiz`);
  assert.equal(forViewer.status, 200, forViewer.text);
  assert.equal(forViewer.json.quiz.questions[0].options[0].correct, undefined, 'правильные ответы скрыты');
  const check = await viewer.post(`/api/videos/${shortId}/quiz/check`, { questionId: 'q1', answer: ['b'] });
  assert.equal(check.json.correct, false);
  const fin = await viewer.post(`/api/videos/${shortId}/quiz/finish`, { answers: { q1: ['a'], q2: ['a'] } });
  assert.equal(fin.status, 200, fin.text);
  assert.equal(fin.json.result.correct, 1);
  assert.equal(fin.json.result.percent, 50);
  assert.equal(fin.json.result.passed, true);
  const res = await user.get(`/api/videos/${videoId}/quiz/results`);
  assert.equal(res.json.total, 1);
  assert.equal(res.json.results[0].passed, true);
  const csv = await user.get(`/api/videos/${videoId}/quiz/results?format=csv`);
  assert.ok(csv.text.includes('Сотрудник'));
  const noAccess = await viewer.get(`/api/videos/${videoId}/quiz/full`);
  assert.equal(noAccess.status, 403);
});

test('защищённая ссылка: пароль, гостевой доступ к приватному видео, отзыв', async () => {
  const l = await user.post(`/api/videos/${videoId}/share-links`, { note: 'Партнёру', password: 'secret1', allowDownload: false });
  assert.equal(l.status, 200, l.text);
  shareToken = l.json.link.token;
  assert.ok(l.json.link.url.endsWith('/s/' + shareToken));
  const ext = new Client();
  const info = await ext.get(`/api/share/${shareToken}`);
  assert.equal(info.status, 200, info.text);
  assert.equal(info.json.requiresPassword, true);
  assert.equal(info.json.unlocked, false);
  const wrong = await ext.post(`/api/share/${shareToken}/unlock`, { password: 'nope' });
  assert.equal(wrong.status, 403);
  const denied = await ext.get(`/api/videos/${shortId}`);
  assert.equal(denied.status, 401);
  const ok = await ext.post(`/api/share/${shareToken}/unlock`, { password: 'secret1' });
  assert.equal(ok.status, 200, ok.text);
  assert.ok(ext.cookie.includes('cv_share='), 'cookie доступа выдана');
  const v = await ext.get(`/api/videos/${shortId}`);
  assert.equal(v.status, 200, v.text);
  assert.equal(v.json.video.viewer.guestLink, true);
  const hls = await ext.get(v.json.video.hlsUrl);
  assert.equal(hls.status, 200);
  const auth = await ext.req('GET', '/api/media/auth', null, { headers: { 'x-original-uri': v.json.video.hlsUrl } });
  assert.equal(auth.status, 200);
  const dl = await ext.get(`/api/videos/${shortId}/download`);
  assert.equal(dl.status, 403, 'скачивание по ссылке запрещено');
  const links = await user.get(`/api/videos/${videoId}/share-links`);
  assert.equal(links.json.links[0].viewCount, 1);
  const rev = await user.patch(`/api/videos/${videoId}/share-links/${l.json.link.id}`, { revoked: true });
  assert.equal(rev.json.link.active, false);
  const after = await ext.get(`/api/videos/${shortId}`);
  assert.equal(after.status, 401, 'после отзыва доступ закрыт');
  const state = await ext.get(`/api/share/${shareToken}`);
  assert.equal(state.json.state, 'revoked');
});

test('личные заметки с таймкодами и водяной знак зрителя', async () => {
  const n = await viewer.post(`/api/videos/${shortId}/notes`, { position: 3.5, body: 'Важный момент' });
  assert.equal(n.status, 200, n.text);
  const n2 = await viewer.post(`/api/videos/${shortId}/notes`, { position: 1, body: 'Начало' });
  const list = await viewer.get(`/api/videos/${shortId}/notes`);
  assert.deepEqual(list.json.notes.map((x) => x.body), ['Начало', 'Важный момент']);
  const other = await user.get(`/api/videos/${shortId}/notes`);
  assert.equal(other.json.notes.length, 0, 'заметки личные');
  const upd = await viewer.patch(`/api/videos/${shortId}/notes/${n2.json.note.id}`, { body: 'Самое начало' });
  assert.equal(upd.json.note.body, 'Самое начало');
  const md = await viewer.get(`/api/videos/${shortId}/notes/export`);
  assert.ok(md.text.includes('**0:01**') && md.text.includes('**0:04**') && md.text.includes('Самое начало'), md.text);
  const all = await viewer.get('/api/me/notes');
  assert.equal(all.json.videos[0].notes.length, 2);
  await viewer.del(`/api/videos/${shortId}/notes/${n.json.note.id}`);
  assert.equal((await viewer.get(`/api/videos/${shortId}/notes`)).json.notes.length, 1);
  const wm = await user.patch(`/api/videos/${videoId}`, { viewerWatermark: true });
  assert.equal(wm.json.video.viewerWatermark, true);
});

test('замена файла видео: версия увеличивается, повторная обработка', async () => {
  const tmp = path.join(os.tmpdir(), `cv-test-r-${stamp}.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', tmp]);
  const data = fs.readFileSync(tmp);
  const noRights = await viewer.post('/api/uploads', { filename: 'new.mp4', size: data.length, replaceVideoId: videoId });
  assert.equal(noRights.status, 403);
  const init = await user.post('/api/uploads', { filename: 'new.mp4', size: data.length, mime: 'video/mp4', replaceVideoId: videoId });
  assert.equal(init.status, 200, init.text);
  assert.equal(init.json.replace, true);
  assert.equal(init.json.videoId, videoId);
  const r = await user.req('PATCH', `/api/uploads/${init.json.uploadId}`, data, { headers: { 'content-type': 'application/offset+octet-stream', 'upload-offset': '0' } });
  assert.equal(r.status, 200, r.text);
  const done = await user.post(`/api/uploads/${init.json.uploadId}/complete`, {});
  assert.equal(done.status, 200, done.text);
  let v;
  for (let i = 0; i < 120; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    v = (await user.get(`/api/videos/${videoId}`)).json.video;
    if (v.status === 'ready' || v.status === 'failed') break;
  }
  assert.equal(v.status, 'ready', 'повторная обработка: ' + JSON.stringify(v.processingError));
  assert.equal(v.version, 2);
  assert.ok(v.replacedAt);
  assert.ok(v.duration > 2 && v.duration < 4, 'новая длительность ' + v.duration);
  fs.unlinkSync(tmp);
});

test('импорт по ссылке (прямая ссылка на файл)', async () => {
  // Отдаём mp4 предыдущего теста через сам API (оригинал доступен автору) — cookie передаём в ссылке нельзя,
  // поэтому публикуем видео и разрешаем скачивание: ссылка на /api/videos/:id/download?type=mp4 станет прямой.
  await user.patch(`/api/videos/${videoId}`, { visibility: 'public', allowDownload: true });
  const bad = await user.post('/api/uploads/from-url', { url: 'ftp://example.com/x.mp4' });
  assert.equal(bad.status, 400);
  const html = await user.post('/api/uploads/from-url', { url: `${BASE}/`, title: 'Импорт страницы' });
  assert.equal(html.status, 200, html.text);
  const src = await user.get(`/api/videos/${videoId}`);
  const direct = await user.post('/api/uploads/from-url', { url: `${BASE}${src.json.video.mp4Url || src.json.video.downloadUrl || `/media/videos/${videoId}/video.mp4`}`, title: 'Импорт по ссылке', visibility: 'internal' });
  assert.equal(direct.status, 200, direct.text);
  let v, page;
  for (let i = 0; i < 120; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    v = (await user.get(`/api/videos/${direct.json.videoId}`)).json.video;
    page = (await user.get(`/api/videos/${html.json.videoId}`)).json.video;
    if (['ready', 'failed'].includes(v.status) && page.status === 'failed') break;
  }
  assert.equal(page.status, 'failed', 'страница вместо файла → ошибка импорта');
  assert.equal(v.status, 'ready', 'импорт по ссылке: ' + JSON.stringify(v.processingError));
  assert.equal(v.sourceUrl.startsWith(BASE), true);
  await user.del(`/api/videos/${direct.json.videoId}`);
  await user.del(`/api/videos/${html.json.videoId}`);
});

test('ИИ-подсказки: ошибки без сервера, генерация через OpenAI-совместимый мок', async () => {
  const off = await user.post(`/api/videos/${videoId}/ai`, { fields: ['summary'] });
  assert.equal(off.status, 400, 'ИИ выключен по умолчанию');
  // Мок OpenAI-совместимого сервера
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body || '{}');
      const prompt = j.messages?.[1]?.content || '';
      const answer = /Ответь одним словом/.test(prompt) || /Ответь одним словом/.test(j.messages?.[0]?.content || '')
        ? 'готов'
        : JSON.stringify({ title: 'Тестовое видео: конспект', summary: 'Краткое содержание.\nКлючевые пункты: раз, два.', chapters: [{ start: 0, title: 'Начало' }, { start: 2, title: 'Середина' }], tags: ['тест', 'ИИ'] });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const st = await admin.put('/api/admin/settings', { settings: { 'ai.enabled': true, 'ai.url': `http://127.0.0.1:${port}/v1/chat/completions`, 'ai.timeout_sec': 20 } });
    assert.equal(st.status, 200);
    const t = await admin.post('/api/admin/settings/test-ai', {});
    assert.equal(t.status, 200, t.text);
    assert.match(t.json.answer, /готов/);
    const noTranscript = await user.post(`/api/videos/${videoId}/ai`, {});
    assert.equal(noTranscript.status, 400, 'без транскрипта — подсказка');
    // Субтитры → транскрипт → генерация
    const vtt = 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nПривет, это тест.\n\n2\n00:00:02.000 --> 00:00:04.000\nВторая реплика.\n';
    const form = new FormData(); form.append('language', 'ru'); form.append('label', 'Русский'); form.append('file', new Blob([vtt], { type: 'text/vtt' }), 'ru.vtt');
    const sub = await user.post(`/api/videos/${videoId}/subtitles`, form);
    assert.equal(sub.status, 200, sub.text);
    const run = await user.post(`/api/videos/${videoId}/ai`, { fields: ['title', 'summary', 'chapters', 'tags'] });
    assert.equal(run.status, 200, run.text);
    let ai = null;
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 1000)); ai = (await user.get(`/api/videos/${videoId}/ai`)).json; if (ai.suggestions && !ai.pending) break; }
    assert.ok(ai.suggestions, 'подсказки получены');
    assert.equal(ai.suggestions.title, 'Тестовое видео: конспект');
    assert.equal(ai.suggestions.chapters.length, 2);
    assert.deepEqual(ai.suggestions.tags, ['тест', 'ии']);
    const v = (await user.get(`/api/videos/${videoId}`)).json.video;
    assert.equal(v.aiSuggestions.title, 'Тестовое видео: конспект', 'подсказки видны автору');
    const g = (await guest.get(`/api/videos/${shortId}`)).json.video;
    assert.equal(g.aiSuggestions, undefined, 'гостю подсказки не показываются');
    const clear = await user.del(`/api/videos/${videoId}/ai`);
    assert.equal(clear.status, 200);
  } finally {
    srv.close();
    await admin.put('/api/admin/settings', { settings: { 'ai.enabled': false } });
  }
  const pub = await guest.get('/api/config');
  assert.equal(pub.json.aiEnabled, false);
});

test('напоминания о сроке назначения', async () => {
  // Назначение со сроком через 1 день и напоминанием за 3 дня → попадает в выборку напоминаний
  const a = await admin.post('/api/assignments', { videoId, targets: [{ type: 'user', id: viewerEmail }], dueAt: new Date(Date.now() + 86400000).toISOString(), remindDays: 3 });
  assert.equal(a.status, 200, a.text);
  const r = await admin.post(`/api/assignments/${a.json.assignment.id}/remind`, {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.sent, 0, 'зритель уже выполнил просмотр — напоминать некому');
  const notif = await viewer.get('/api/notifications');
  assert.ok(notif.json.notifications.some((n) => n.type === 'assignment'), 'уведомление о новом назначении есть');
  const closed = await admin.patch(`/api/assignments/${a.json.assignment.id}`, { status: 'closed' });
  assert.equal(closed.json.assignment.status, 'closed');
  await admin.del(`/api/assignments/${a.json.assignment.id}`);
});

// --- Платформа 1.2 -----------------------------------------------------------------------------
const http12 = await import('node:http');
const crypto12 = await import('node:crypto');
function listen(srv) { return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port))); }

test('вход через SSO (OpenID Connect): обнаружение, PKCE, id_token, автосоздание учётной записи, группы', async () => {
  // Мок OIDC-провайдера (RS256)
  const { publicKey, privateKey } = crypto12.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }); jwk.kid = 'k1'; jwk.alg = 'RS256'; jwk.use = 'sig';
  let issuer = ''; let lastNonce = ''; let redirectUri = ''; const codes = new Map();
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const srv = http12.createServer((req, res) => {
    const u = new URL(req.url, issuer);
    const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/.well-known/openid-configuration') return json({ issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, userinfo_endpoint: `${issuer}/userinfo`, jwks_uri: `${issuer}/jwks`, scopes_supported: ['openid', 'profile', 'email'] });
    if (u.pathname === '/jwks') return json({ keys: [jwk] });
    if (u.pathname === '/auth') {
      const code = crypto12.randomBytes(8).toString('hex'); lastNonce = u.searchParams.get('nonce'); redirectUri = u.searchParams.get('redirect_uri');
      codes.set(code, { nonce: lastNonce, challenge: u.searchParams.get('code_challenge') });
      res.writeHead(302, { location: `${redirectUri}?code=${code}&state=${encodeURIComponent(u.searchParams.get('state'))}` }); return res.end();
    }
    if (u.pathname === '/token') {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const p = new URLSearchParams(body); const c = codes.get(p.get('code'));
        if (!c) return json({ error: 'invalid_grant' }, 400);
        const expected = crypto12.createHash('sha256').update(p.get('code_verifier')).digest('base64url');
        if (expected !== c.challenge) return json({ error: 'invalid_grant', error_description: 'pkce' }, 400);
        const now = Math.floor(Date.now() / 1000);
        const payload = { iss: issuer, sub: 'sso-' + stamp, aud: 'corpvideo', exp: now + 300, iat: now, nonce: c.nonce, email: `sso.${stamp}@vodokomfort.ru`, name: 'Сотрудник SSO', groups: ['/Отдел продаж ' + stamp, 'video-admins'] };
        const signed = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${b64(payload)}`;
        const sig = crypto12.sign('sha256', Buffer.from(signed), privateKey).toString('base64url');
        json({ access_token: 'at-1', token_type: 'Bearer', id_token: `${signed}.${sig}` });
      });
      return;
    }
    if (u.pathname === '/userinfo') return json({ sub: 'sso-' + stamp, email: `sso.${stamp}@vodokomfort.ru`, name: 'Сотрудник SSO', department: 'Продажи' });
    json({ error: 'not found' }, 404);
  });
  const port = await listen(srv); issuer = `http://127.0.0.1:${port}`;
  try {
    const st = await admin.put('/api/admin/settings', { settings: { 'oidc.enabled': true, 'oidc.issuer': issuer, 'oidc.client_id': 'corpvideo', 'oidc.client_secret': 'secret', 'oidc.admin_group': 'video-admins', 'oidc.sync_groups': true } });
    assert.equal(st.status, 200, st.text);
    const t = await admin.post('/api/admin/settings/test-oidc', {});
    assert.equal(t.status, 200, t.text);
    assert.equal(t.json.authorization, `${issuer}/auth`);
    const cfg = await guest.get('/api/config');
    assert.equal(cfg.json.oidcEnabled, true);
    // Полный проход: start → провайдер → callback
    const sso = new Client();
    const start = await sso.req('GET', '/api/auth/oidc/start?next=/assignments');
    assert.equal(start.status, 302, start.text);
    const authUrl = start.headers.get('location');
    assert.ok(authUrl.startsWith(`${issuer}/auth?`), authUrl);
    const provider = await fetch(authUrl, { redirect: 'manual' });
    assert.equal(provider.status, 302);
    const back = new URL(provider.headers.get('location'));
    assert.ok(back.pathname.endsWith('/api/auth/oidc/callback'));
    const cb = await sso.req('GET', back.pathname + back.search);
    assert.equal(cb.status, 302, cb.text);
    assert.equal(cb.headers.get('location'), '/assignments', 'редирект на next');
    const me = await sso.get('/api/auth/me');
    assert.equal(me.json.user?.email, `sso.${stamp}@vodokomfort.ru`, me.text);
    assert.equal(me.json.user.role, 'admin', 'группа video-admins → администратор');
    assert.equal(me.json.user.authProvider, 'oidc');
    const groups = await sso.get('/api/groups/mine');
    assert.ok(groups.json.groups.some((g) => g.name === 'Отдел продаж ' + stamp), 'группа из claim синхронизирована по названию');
    // Повторный вход того же пользователя — без дублей
    const start2 = await sso.req('GET', '/api/auth/oidc/start');
    const p2 = await fetch(start2.headers.get('location'), { redirect: 'manual' });
    const b2 = new URL(p2.headers.get('location'));
    await sso.req('GET', b2.pathname + b2.search);
    const dup = await admin.get(`/api/admin/users?q=${encodeURIComponent('sso.' + stamp)}`);
    assert.equal(dup.json.users.filter((u) => u.email === `sso.${stamp}@vodokomfort.ru`).length, 1);
    // Неверный state → понятная ошибка
    const bad = await guest.req('GET', '/api/auth/oidc/callback?code=x&state=nope');
    assert.equal(bad.status, 302);
    assert.match(decodeURIComponent(bad.headers.get('location')), /начните вход заново/);
    // Код и state, полученные в чужом браузере, не должны завершать вход здесь (подмена сеанса)
    const victim = new Client();
    const start3 = await victim.req('GET', '/api/auth/oidc/start');
    const p3 = await fetch(start3.headers.get('location'), { redirect: 'manual' });
    const b3 = new URL(p3.headers.get('location'));
    const stolen = await guest.req('GET', b3.pathname + b3.search);
    assert.equal(stolen.status, 302);
    assert.match(decodeURIComponent(stolen.headers.get('location')), /начните вход заново/, 'чужой code+state отклонён');
    assert.equal((await guest.get('/api/auth/me')).json.user, null, 'вход не выполнен');
    // А в своём браузере тот же ответ провайдера срабатывает
    const own = await victim.req('GET', b3.pathname + b3.search);
    assert.equal(own.status, 302, own.text);
    assert.ok(!/error=/.test(own.headers.get('location')), own.headers.get('location'));
  } finally {
    srv.close();
    await admin.put('/api/admin/settings', { settings: { 'oidc.enabled': false } });
  }
});

test('срок публикации: видео становится приватным, автор уведомлён', async () => {
  const r = await user.patch(`/api/videos/${videoId}`, { visibility: 'internal', expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.video.expiresAt);
  await admin.post('/api/admin/system/maintenance', {});
  let v;
  for (let i = 0; i < 30; i++) { await new Promise((res) => setTimeout(res, 1000)); v = (await user.get(`/api/videos/${videoId}`)).json.video; if (v.expiredAt) break; }
  assert.ok(v.expiredAt, 'отметка об истечении');
  assert.equal(v.visibility, 'private');
  const notif = await user.get('/api/notifications');
  assert.ok(notif.json.notifications.some((n) => n.type === 'video_expired'));
  // Возврат видимости снимает срок
  const back = await user.patch(`/api/videos/${videoId}`, { visibility: 'public' });
  assert.equal(back.json.video.expiresAt, null);
  assert.equal(back.json.video.expiredAt, null);
});

test('вложения к видео: загрузка, список, скачивание, удаление', async () => {
  const form = new FormData();
  form.append('title', 'Презентация инструктажа');
  form.append('file', new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }), 'Инструктаж.pdf');
  const up = await user.post(`/api/videos/${videoId}/attachments`, form);
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.attachment.title, 'Презентация инструктажа');
  assert.equal(up.json.attachment.ext, 'pdf');
  const bad = new FormData(); bad.append('file', new Blob(['x'], { type: 'application/x-msdownload' }), 'virus.exe');
  assert.equal((await user.post(`/api/videos/${videoId}/attachments`, bad)).status, 400);
  const list = await viewer.get(`/api/videos/${shortId}/attachments`);
  assert.equal(list.json.attachments.length, 1);
  const dl = await viewer.get(list.json.attachments[0].url);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal(dl.text, '%PDF-1.4 test');
  const noRights = await viewer.del(`/api/videos/${videoId}/attachments/${up.json.attachment.id}`);
  assert.equal(noRights.status, 403);
  const del2 = await user.del(`/api/videos/${videoId}/attachments/${up.json.attachment.id}`);
  assert.equal(del2.status, 200);
  assert.equal((await user.get(`/api/videos/${videoId}/attachments`)).json.attachments.length, 0);
});

test('транскрипт: скачивание txt / srt / vtt / json', async () => {
  const txt = await viewer.get(`/api/videos/${shortId}/transcript`);
  assert.equal(txt.status, 200, txt.text);
  assert.ok(txt.text.includes('Привет, это тест'));
  const srt = await viewer.get(`/api/videos/${shortId}/transcript?format=srt`);
  assert.match(srt.text, /00:00:00,000 --> 00:00:02,000/);
  const vtt = await viewer.get(`/api/videos/${shortId}/transcript?format=vtt`);
  assert.ok(vtt.text.startsWith('WEBVTT'));
  const json = await viewer.get(`/api/videos/${shortId}/transcript?format=json`);
  assert.equal(json.json.segments.length, 2);
});

test('трансляция: напоминание, календарь, опросы и вопросы спикеру', async () => {
  const s = await user.post('/api/studio/live', { title: 'Планёрка', scheduledAt: new Date(Date.now() + 3600000).toISOString(), visibility: 'internal' });
  assert.equal(s.status, 200, s.text);
  const sid = s.json.stream.shortId;
  const rem = await viewer.post(`/api/live/${sid}/remind`, { on: true });
  assert.equal(rem.status, 200, rem.text);
  assert.equal(rem.json.count, 1);
  const st = await viewer.get(`/api/live/${sid}`);
  assert.equal(st.json.stream.reminder, true);
  const ics = await viewer.get(`/api/live/${sid}/calendar.ics`);
  assert.match(ics.headers.get('content-type'), /text\/calendar/);
  assert.ok(ics.text.includes('BEGIN:VEVENT') && ics.text.includes('SUMMARY:Планёрка'));
  // Опрос
  const noRights = await viewer.post(`/api/live/${sid}/polls`, { question: 'x', options: ['a', 'b'] });
  assert.equal(noRights.status, 403);
  const poll = await user.post(`/api/live/${sid}/polls`, { question: 'Какой формат планёрки удобнее?', options: ['Утро', 'Вечер'] });
  assert.equal(poll.status, 200, poll.text);
  const pid = poll.json.poll.id;
  const vote = await viewer.post(`/api/live/${sid}/polls/${pid}/vote`, { optionIds: [poll.json.poll.options[1].id] });
  assert.equal(vote.status, 200, vote.text);
  assert.equal(vote.json.poll.total, 1);
  assert.equal(vote.json.poll.options[1].votes, 1);
  const closed = await user.patch(`/api/live/${sid}/polls/${pid}`, { status: 'closed' });
  assert.equal(closed.json.poll.status, 'closed');
  const lateVote = await viewer.post(`/api/live/${sid}/polls/${pid}/vote`, { optionIds: [poll.json.poll.options[0].id] });
  assert.equal(lateVote.status, 400);
  // Вопросы
  const q = await viewer.post(`/api/live/${sid}/questions`, { body: 'Когда будет премия?', anonymous: true });
  assert.equal(q.status, 200, q.text);
  assert.equal(q.json.question.mine, true);
  const listForOwner = await user.get(`/api/live/${sid}/questions`);
  assert.equal(listForOwner.json.questions[0].author.displayName, 'Анонимно');
  const up = await admin.post(`/api/live/${sid}/questions/${q.json.question.id}/upvote`, {});
  assert.equal(up.json.upvotes, 1);
  const ans = await user.patch(`/api/live/${sid}/questions/${q.json.question.id}`, { status: 'answered', answer: 'В следующем месяце' });
  assert.equal(ans.json.question.status, 'answered');
  const csv = await user.get(`/api/live/${sid}/questions/export`);
  assert.ok(csv.text.includes('Когда будет премия'));
  await user.del(`/api/studio/live/${s.json.stream.id}`);
});

test('сертификат о прохождении: выдача при выполнении назначения, проверка по ссылке', async () => {
  const a = await admin.post('/api/assignments', { videoId, targets: [{ type: 'user', id: viewerEmail }], requiredPercent: 50, certificate: true, attentionCheckMin: 5 });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.json.assignment.certificate, true);
  assert.equal(a.json.assignment.attentionCheckMin, 5);
  // Зритель уже смотрел видео (прогресс засчитан при создании) → сертификат выдан сразу
  let certs;
  for (let i = 0; i < 10; i++) { certs = (await viewer.get('/api/me/certificates')).json.certificates; if (certs.length) break; await new Promise((r) => setTimeout(r, 300)); }
  assert.ok(certs.length >= 1, 'сертификат выдан');
  const c = certs.find((x) => x.assignmentId === a.json.assignment.id);
  assert.ok(c, 'сертификат по назначению');
  assert.match(c.number, /^CV-\d{4}-\d{5}$/);
  const pub = await guest.get(`/api/certificates/${c.id}`);
  assert.equal(pub.status, 200, pub.text);
  assert.equal(pub.json.certificate.valid, true);
  assert.equal(pub.json.certificate.user.displayName, 'Зритель Тестовый');
  assert.equal(pub.json.certificate.user.email, undefined, 'гостю почта не показывается');
  const listCsv = await admin.get(`/api/assignments/${a.json.assignment.id}/certificates?format=csv`);
  assert.ok(listCsv.text.includes(c.number));
  const notif = await viewer.get('/api/notifications');
  assert.ok(notif.json.notifications.some((n) => n.type === 'certificate'));
  await admin.del(`/api/assignments/${a.json.assignment.id}`);
});

test('Telegram: привязка через код (мок Bot API) и доставка уведомления', async () => {
  const sent = []; let pendingStart = null;
  const srv = http12.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = body ? JSON.parse(body) : {};
      const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      if (req.url.endsWith('/getMe')) return json({ ok: true, result: { username: 'corpvideo_test_bot', first_name: 'CorpVideo' } });
      if (req.url.endsWith('/sendMessage')) { sent.push(j); return json({ ok: true, result: { message_id: sent.length } }); }
      if (req.url.endsWith('/getUpdates')) { const u = pendingStart ? [{ update_id: 1, message: { chat: { id: 4242 }, from: { username: 'tester' }, text: `/start ${pendingStart}` } }] : []; pendingStart = null; return json({ ok: true, result: u }); }
      json({ ok: false, description: 'unknown' });
    });
  });
  const port = await listen(srv);
  try {
    const st = await admin.put('/api/admin/settings', { settings: { 'telegram.enabled': true, 'telegram.bot_token': '123:ABC', 'telegram.api_url': `http://127.0.0.1:${port}`, 'telegram.types': [] } });
    assert.equal(st.status, 200);
    const t = await admin.post('/api/admin/settings/test-telegram', {});
    assert.equal(t.status, 200, t.text);
    assert.equal(t.json.username, 'corpvideo_test_bot');
    const link = await viewer.post('/api/me/telegram/link', {});
    assert.equal(link.status, 200, link.text);
    assert.ok(link.json.url.includes('t.me/corpvideo_test_bot?start='));
    pendingStart = link.json.code;
    let status;
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 500)); status = (await viewer.get('/api/me/telegram')).json; if (status.linked) break; }
    assert.equal(status.linked, true, 'воркер обработал /start');
    assert.ok(sent.some((m) => /Готово/.test(m.text)), 'бот ответил подтверждением');
    // Уведомление → сообщение в Telegram
    const a = await admin.post('/api/assignments', { videoId, targets: [{ type: 'user', id: viewerEmail }] });
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 500)); if (sent.some((m) => /назначено/i.test(m.text))) break; }
    assert.ok(sent.some((m) => m.chat_id === 4242 && /назначено/i.test(m.text)), 'уведомление доставлено в Telegram');
    await admin.del(`/api/assignments/${a.json.assignment.id}`);
    const unlink = await viewer.del('/api/me/telegram');
    assert.equal(unlink.status, 200);
    assert.equal((await viewer.get('/api/me/telegram')).json.linked, false);
  } finally {
    srv.close();
    await admin.put('/api/admin/settings', { settings: { 'telegram.enabled': false } });
  }
});

test('RAG: документ из видео, выгрузка во внешнюю систему (мок), pull-API по токену, описание через LLM', async () => {
  const received = [];
  const rag = http12.createServer((req, res) => { let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => { received.push({ url: req.url, auth: req.headers.authorization, body }); res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); }); });
  const llm = http12.createServer((req, res) => { let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'Конспект от ИИ для RAG.', tags: ['rag'] }) } }] })); }); });
  const ragPort = await listen(rag); const llmPort = await listen(llm);
  try {
    // Пустое описание → опция описания через LLM
    await user.patch(`/api/videos/${videoId}`, { description: '' });
    const st = await admin.put('/api/admin/settings', { settings: { 'rag.enabled': true, 'rag.url': `http://127.0.0.1:${ragPort}/ingest`, 'rag.api_key': 'rag-secret', 'rag.pull_token': 'pull-secret', 'rag.describe_with_ai': true, 'ai.enabled': true, 'ai.url': `http://127.0.0.1:${llmPort}/v1/chat/completions`, 'ai.auto_describe': true } });
    assert.equal(st.status, 200);
    const t = await admin.post('/api/admin/settings/test-rag', {});
    assert.equal(t.status, 200, t.text);
    assert.equal(received.length, 1);
    assert.equal(received[0].auth, 'Bearer rag-secret');
    const push = await user.post(`/api/videos/${videoId}/rag`, {});
    assert.equal(push.status, 200, push.text);
    let doc;
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 500)); doc = received.find((x) => x.body.includes(videoId)); if (doc) break; }
    assert.ok(doc, 'документ получен RAG');
    const j = JSON.parse(doc.body);
    assert.equal(j.id, videoId);
    assert.ok(j.text.includes('# Тестовое видео') && j.text.includes('Транскрипт') && j.text.includes('Привет, это тест'), j.text.slice(0, 300));
    assert.ok(j.text.includes('Конспект от ИИ для RAG'), 'описание от LLM попало в документ');
    const v = (await user.get(`/api/videos/${videoId}`)).json.video;
    assert.equal(v.description, 'Конспект от ИИ для RAG.', 'ai.auto_describe заполнил описание');
    assert.ok(v.ragSyncedAt, 'отметка о выгрузке');
    // Pull-API
    const noToken = await guest.get('/api/rag/documents');
    assert.equal(noToken.status, 401);
    const pull = await guest.req('GET', '/api/rag/documents?limit=5', null, { headers: { authorization: 'Bearer pull-secret' } });
    assert.equal(pull.status, 200, pull.text);
    assert.ok(pull.json.documents.some((d) => d.id === videoId));
    const one12 = await guest.req('GET', `/api/rag/documents/${shortId}?format=markdown`, null, { headers: { authorization: 'Bearer pull-secret' } });
    assert.match(one12.headers.get('content-type'), /markdown/);
    assert.ok(one12.text.startsWith('# Тестовое видео'));
    const status = await admin.get('/api/admin/rag/status');
    assert.ok(status.json.synced >= 1);
    const all = await admin.post('/api/admin/rag/push-all', { force: true });
    assert.ok(all.json.queued >= 1);
    const describe = await admin.post('/api/admin/rag/describe-all', {});
    assert.equal(describe.status, 200, describe.text);
  } finally {
    rag.close(); llm.close();
    await admin.put('/api/admin/settings', { settings: { 'rag.enabled': false, 'ai.enabled': false, 'ai.auto_describe': false, 'rag.describe_with_ai': false } });
  }
});

test('встраивание: ограничение доменов (CSP frame-ancestors)', async () => {
  await admin.put('/api/admin/settings', { settings: { 'embed.allowed_domains': ['intranet.vodokomfort.ru'] } });
  const r = await guest.get(`/embed/${shortId}`);
  assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'self' https:\/\/intranet\.vodokomfort\.ru/);
  assert.equal(r.headers.get('x-frame-options'), null);
  await admin.put('/api/admin/settings', { settings: { 'embed.allowed_domains': [] } });
  const r2 = await guest.get(`/embed/${shortId}`);
  assert.equal(r2.headers.get('content-security-policy'), null);
});


// ============================ 1.3 ============================
const http13 = await import('node:http');
const cryptoMod = await import('node:crypto');
const { totpCode } = await import('../src/lib/crypto.js');
let editVideoId, editShortId, clipVideoId;

async function waitJob(client, vid, jobId, timeoutSec = 180) {
  let j;
  for (let i = 0; i < timeoutSec; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const g = await client.get(`/api/videos/${vid}/editor/jobs/${jobId}`);
    j = g.json?.job;
    if (j && ['done', 'failed', 'cancelled'].includes(j.status)) return j;
  }
  return j;
}
async function waitVideoReady(client, vid, timeoutSec = 180) {
  let v;
  for (let i = 0; i < timeoutSec; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    v = (await client.get(`/api/videos/${vid}`)).json?.video;
    if (v && ['ready', 'failed'].includes(v.status)) return v;
  }
  return v;
}
function mockServer(handler) {
  const srv = http13.createServer((req, res) => { let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => handler(req, res, body)); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}

test('вебхуки: создание, подпись HMAC, доставка события, журнал, повтор', async () => {
  const received = [];
  const { srv, port } = await mockServer((req, res, body) => { received.push({ headers: req.headers, body }); res.statusCode = received.length === 1 ? 500 : 200; res.end('ok'); });
  try {
    const ev = await admin.get('/api/admin/webhooks/events');
    assert.ok(ev.json.events.some((e) => e.id === 'video.updated'));
    const c = await admin.post('/api/admin/webhooks', { name: 'Тест', url: `http://127.0.0.1:${port}/hook`, events: ['video.updated', 'webhook.test'] });
    assert.equal(c.status, 200, c.text);
    const hook = c.json.webhook;
    assert.ok(hook.secret.length >= 16, 'секрет сгенерирован');
    // проверочное событие: первая попытка получает 500 (maxAttempts 1 → failed), затем повтор вручную
    const t = await admin.post(`/api/admin/webhooks/${hook.id}/test`, {});
    assert.equal(t.status, 200, t.text);
    for (let i = 0; i < 20 && received.length < 1; i++) await new Promise((r) => setTimeout(r, 500));
    assert.equal(received.length, 1, 'проверочное событие доставлено');
    const h = received[0].headers;
    assert.equal(h['x-corpvideo-event'], 'webhook.test');
    const sig = cryptoMod.createHmac('sha256', hook.secret).update(`${h['x-corpvideo-timestamp']}.${received[0].body}`).digest('hex');
    assert.equal(h['x-corpvideo-signature'], `sha256=${sig}`, 'подпись совпадает');
    let dl = (await admin.get(`/api/admin/webhooks/${hook.id}/deliveries`)).json.deliveries;
    assert.equal(dl[0].status, 'failed');
    assert.equal(dl[0].httpStatus, 500);
    const retry = await admin.post(`/api/admin/webhooks/deliveries/${dl[0].id}/retry`, {});
    assert.equal(retry.status, 200);
    for (let i = 0; i < 20 && received.length < 2; i++) await new Promise((r) => setTimeout(r, 500));
    assert.equal(received.length, 2, 'повторная доставка');
    // событие портала: изменение видео
    const upd = await user.patch(`/api/videos/${videoId}`, { description: 'Описание для вебхука' });
    assert.equal(upd.status, 200);
    for (let i = 0; i < 30 && received.length < 3; i++) await new Promise((r) => setTimeout(r, 500));
    assert.equal(received.length, 3, 'событие video.updated доставлено');
    const payload = JSON.parse(received[2].body);
    assert.equal(payload.event, 'video.updated');
    assert.equal(payload.data.video.id, videoId);
    assert.ok(payload.data.fields.includes('description'));
    dl = (await admin.get(`/api/admin/webhooks/${hook.id}/deliveries`)).json.deliveries;
    assert.ok(dl.some((d) => d.event === 'video.updated' && d.status === 'ok'));
    const list = (await admin.get('/api/admin/webhooks')).json.webhooks.find((w) => w.id === hook.id);
    assert.equal(list.lastStatus, 200);
    // отключённый вебхук не получает события
    await admin.patch(`/api/admin/webhooks/${hook.id}`, { enabled: false });
    await user.patch(`/api/videos/${videoId}`, { description: 'Ещё одно изменение' });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(received.length, 3, 'отключённый вебхук молчит');
    const del = await admin.del(`/api/admin/webhooks/${hook.id}`);
    assert.equal(del.status, 200);
    const nobody = await user.get('/api/admin/webhooks');
    assert.equal(nobody.status, 403);
  } finally { srv.close(); }
});

test('редактор: поиск и удаление пауз, обрезка → новая версия, клип как отдельное вертикальное видео', async () => {
  // 12-секундное видео: тон 0–4 с, тишина 4–8 с, тон 8–12 с
  const tmp = path.join(os.tmpdir(), `cv-edit-${stamp}.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-af', "volume=enable='between(t,4,8)':volume=0", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', tmp]);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(tmp)], { type: 'video/mp4' }), 'Монтаж.mp4');
  form.append('title', 'Видео для монтажа'); form.append('visibility', 'internal');
  const up = await user.post('/api/uploads/simple', form);
  assert.equal(up.status, 200, up.text);
  editVideoId = up.json.video.id; editShortId = up.json.video.shortId;
  fs.unlinkSync(tmp);
  let v = await waitVideoReady(user, editVideoId);
  assert.equal(v.status, 'ready', 'видео обработано');
  assert.ok(v.audioUrl, 'аудиодорожка создана при обработке');
  const ed = await user.get(`/api/videos/${editVideoId}/editor`);
  assert.equal(ed.status, 200, ed.text);
  assert.equal(ed.json.enabled, true);
  assert.ok(ed.json.duration > 11);
  // 1. Поиск пауз (без применения)
  const det = await user.post(`/api/videos/${editVideoId}/editor/silence`, { apply: false, minSec: 1, noiseDb: -40 });
  assert.equal(det.status, 200, det.text);
  let j = await waitJob(user, editVideoId, det.json.jobId);
  assert.equal(j.status, 'done', 'silencedetect: ' + j?.error);
  assert.equal(j.result.silences, 1, 'найдена одна пауза');
  assert.ok(j.result.cuts[0].start > 3.5 && j.result.cuts[0].start < 5, 'пауза начинается около 4 с: ' + JSON.stringify(j.result.cuts));
  assert.ok(j.result.cuts[0].end > 7 && j.result.cuts[0].end < 8.5, 'пауза заканчивается около 8 с');
  // 2. Удаление пауз (применение) → новая версия
  const app1 = await user.post(`/api/videos/${editVideoId}/editor/silence`, { apply: true, minSec: 1, noiseDb: -40, keepSec: 0.3 });
  assert.equal(app1.status, 200, app1.text);
  j = await waitJob(user, editVideoId, app1.json.jobId);
  assert.equal(j.status, 'done', 'remove_silence: ' + j?.error);
  assert.equal(j.result.applied, true);
  v = await waitVideoReady(user, editVideoId);
  assert.equal(v.status, 'ready');
  assert.equal(v.version, 2, 'версия увеличилась');
  assert.ok(v.duration > 7.5 && v.duration < 9.5, 'длительность после удаления паузы ~8.6 с: ' + v.duration);
  assert.ok(v.editHistory.length >= 1 && v.editHistory[0].op === 'remove_silence');
  // 3. Обрезка начала и конца
  const trim = await user.post(`/api/videos/${editVideoId}/editor/trim`, { start: 1, end: 5 });
  assert.equal(trim.status, 200, trim.text);
  j = await waitJob(user, editVideoId, trim.json.jobId);
  assert.equal(j.status, 'done', 'trim: ' + j?.error);
  v = await waitVideoReady(user, editVideoId);
  assert.equal(v.version, 3);
  assert.ok(v.duration > 3.5 && v.duration < 4.5, 'после обрезки ~4 с: ' + v.duration);
  const badTrim = await user.post(`/api/videos/${editVideoId}/editor/trim`, { start: 0, end: 100 });
  assert.equal(badTrim.status, 400);
  // 4. Клип как отдельное вертикальное видео (создаёт зритель с правом загрузки)
  const clip = await viewer.post(`/api/videos/${editVideoId}/clips`, { start: 0.5, end: 3, title: 'Клип для ленты', vertical: true, visibility: 'public' });
  assert.equal(clip.status, 403, 'клип чужого internal-видео не может быть публичным');
  const clip2 = await viewer.post(`/api/videos/${editVideoId}/clips`, { start: 0.5, end: 3, title: 'Клип для ленты', vertical: true });
  assert.equal(clip2.status, 200, clip2.text);
  j = await waitJob(viewer, editVideoId, clip2.json.jobId);
  assert.equal(j.status, 'done', 'clip: ' + j?.error);
  clipVideoId = j.result.videoId;
  const cv = await waitVideoReady(viewer, clipVideoId);
  assert.equal(cv.status, 'ready', 'клип обработан');
  assert.equal(cv.clipOf, editVideoId);
  assert.equal(cv.clipRange.vertical, true);
  assert.ok(cv.height > cv.width, 'вертикальный формат: ' + cv.width + 'x' + cv.height);
  assert.ok(cv.duration > 2 && cv.duration < 3.5);
  assert.equal(cv.visibility, 'private');
  assert.equal(cv.title, 'Клип для ленты');
  const clips = await viewer.get(`/api/videos/${editVideoId}/clips`);
  assert.ok(clips.json.clips.some((c) => c.id === clipVideoId), 'клип в списке клипов исходного видео');
  await viewer.del(`/api/videos/${clipVideoId}`);
});

test('перевод субтитров через ИИ (мок LLM) и текст на экране (OCR)', async () => {
  const { srv, port } = await mockServer((req, res, body) => {
    const j = JSON.parse(body || '{}');
    const prompt = j.messages?.[1]?.content || '';
    let answer;
    if (/Lines:/.test(prompt)) {
      const lines = prompt.split('Lines:')[1].trim().split('\n').map((l) => l.replace(/^\d+\.\s*/, ''));
      answer = JSON.stringify({ lines: lines.map((l) => `EN: ${l}`) });
    } else answer = 'готов';
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: answer } }] }));
  });
  try {
    await admin.put('/api/admin/settings', { settings: { 'ai.enabled': true, 'ai.url': `http://127.0.0.1:${port}/v1/chat/completions`, 'ai.timeout_sec': 20 } });
    const vtt = 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.500\nПервая реплика.\n\n2\n00:00:01.500 --> 00:00:03.000\nВторая реплика.\n';
    const form = new FormData(); form.append('language', 'ru'); form.append('label', 'Русский'); form.append('file', new Blob([vtt], { type: 'text/vtt' }), 'ru.vtt');
    const sub = await user.post(`/api/videos/${editVideoId}/subtitles`, form);
    assert.equal(sub.status, 200, sub.text);
    const same = await user.post(`/api/videos/${editVideoId}/subtitles/${sub.json.subtitle.id}/translate`, { language: 'ru' });
    assert.equal(same.status, 400);
    const tr = await user.post(`/api/videos/${editVideoId}/subtitles/${sub.json.subtitle.id}/translate`, { language: 'en' });
    assert.equal(tr.status, 200, tr.text);
    const j = await waitJob(user, editVideoId, tr.json.jobId, 60);
    assert.equal(j.status, 'done', 'перевод: ' + j?.error);
    assert.equal(j.result.cues, 2);
    const subs = (await user.get(`/api/videos/${editVideoId}/subtitles`)).json.subtitles;
    const en = subs.find((x) => x.language === 'en');
    assert.ok(en && en.status === 'ready', 'английская дорожка готова');
    assert.equal(en.translatedFrom, sub.json.subtitle.id);
    const file = await user.get(en.url);
    assert.ok(file.text.includes('EN: Первая реплика.'), 'перевод записан с сохранением таймкодов: ' + file.text);
    assert.ok(file.text.includes('00:00:01.500 --> 00:00:03.000'));
  } finally { srv.close(); await admin.put('/api/admin/settings', { settings: { 'ai.enabled': false } }); }

  // OCR: видео из «слайда» с текстом
  const png = path.join(os.tmpdir(), `cv-slide-${stamp}.png`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=white:size=1280x720:duration=1', '-vf', "drawtext=text='Инструктаж по охране труда':fontsize=64:fontcolor=black:x=80:y=120:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf,drawtext=text='Zone 42 safety rules':fontsize=64:fontcolor=black:x=80:y=300:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", '-frames:v', '1', png]);
  const mp4 = path.join(os.tmpdir(), `cv-slide-${stamp}.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', png, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '6', '-r', '10', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4]);
  const form2 = new FormData(); form2.append('file', new Blob([fs.readFileSync(mp4)], { type: 'video/mp4' }), 'slide.mp4'); form2.append('title', 'Слайд с текстом'); form2.append('visibility', 'internal');
  const up = await user.post('/api/uploads/simple', form2);
  assert.equal(up.status, 200, up.text);
  fs.unlinkSync(png); fs.unlinkSync(mp4);
  const slideId = up.json.video.id;
  const ready = await waitVideoReady(user, slideId);
  assert.equal(ready.status, 'ready');
  const off = await user.post(`/api/videos/${slideId}/ocr`, {});
  assert.equal(off.status, 403, 'OCR выключен по умолчанию');
  const ocrTest = await admin.post('/api/admin/settings/test-ocr', {});
  assert.equal(ocrTest.status, 200, 'tesseract установлен: ' + ocrTest.text);
  assert.ok(ocrTest.json.languages.includes('eng'));
  await admin.put('/api/admin/settings', { settings: { 'ocr.enabled': true, 'ocr.interval_sec': 2 } });
  try {
    const run = await user.post(`/api/videos/${slideId}/ocr`, {});
    assert.equal(run.status, 200, run.text);
    const j = await waitJob(user, slideId, run.json.jobId, 120);
    assert.equal(j.status, 'done', 'OCR: ' + j?.error);
    assert.ok(j.result.texts >= 1, 'распознан хотя бы один кадр');
    const st = await user.get(`/api/videos/${slideId}/screen-text`);
    assert.equal(st.json.status, 'done');
    const all = st.json.items.map((i) => i.text).join('\n');
    assert.match(all, /Zone 42|safety/i, 'английский текст распознан: ' + all);
    if (ocrTest.json.languages.includes('rus')) assert.match(all, /охране труда|Инструктаж/i, 'русский текст распознан: ' + all);
    const found = await user.get(`/api/videos/${slideId}/screen-text?q=zone`);
    assert.equal(found.json.items.length >= 1, true);
    const search = await user.get('/api/search?q=safety%20rules&type=video');
    assert.ok(search.json.videos?.some?.((x) => x.id === slideId) || search.json.items?.some?.((x) => x.id === slideId), 'видео находится по тексту с экрана: ' + search.text.slice(0, 200));
    const v = (await user.get(`/api/videos/${slideId}`)).json.video;
    assert.equal(v.hasScreenText, true);
  } finally { await admin.put('/api/admin/settings', { settings: { 'ocr.enabled': false } }); }
  await user.del(`/api/videos/${slideId}`);
});

test('подсказки и конечная заставка, RSS/подкаст-ленты с личным токеном, SCORM-пакет', async () => {
  const p = await user.patch(`/api/videos/${editVideoId}`, {
    cards: [{ start: 2, type: 'video', target: shortId, title: 'Смотрите также', duration: 15 }, { start: 1, type: 'url', target: 'https://example.com/doc', title: 'Регламент' }, { start: 3, type: 'url', target: 'javascript:alert(1)', title: 'плохая' }],
    endScreen: { seconds: 12, items: [{ type: 'video', target: shortId, title: 'Следующее' }, { type: 'subscribe' }] },
  });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.json.video.cards.length, 2, 'небезопасная ссылка отброшена');
  assert.equal(p.json.video.cards[0].start, 1, 'подсказки отсортированы по времени');
  assert.equal(p.json.video.endScreen.seconds, 12);
  assert.equal(p.json.video.endScreen.items.length, 2);
  // RSS: публичная лента не содержит internal-видео, лента с токеном — содержит
  const rss = await guest.get('/api/rss/latest');
  assert.equal(rss.status, 200, rss.text);
  assert.ok(rss.headers.get('content-type').includes('rss+xml'));
  assert.ok(rss.text.includes('<rss'));
  assert.ok(!rss.text.includes(`/watch/${editShortId}`), 'internal-видео не в публичной ленте');
  const ft = await user.get('/api/me/feed-token');
  assert.equal(ft.status, 200, ft.text);
  assert.ok(ft.json.token.length >= 16);
  const my = await guest.get(`/api/rss/latest?ft=${ft.json.token}`);
  assert.ok(my.text.includes(`/watch/${editShortId}`), 'с личным токеном internal-видео видно');
  const atom = await guest.get(`/api/rss/latest?ft=${ft.json.token}&format=atom`);
  assert.ok(atom.text.includes('<feed') && atom.headers.get('content-type').includes('atom+xml'));
  const pod = await guest.get(`/api/rss/latest?ft=${ft.json.token}&audio=1`);
  assert.ok(pod.text.includes('itunes:duration'), 'подкаст-лента с тегами iTunes');
  const encl = pod.text.match(/<enclosure url="([^"]+)" type="audio\/mp4"/);
  assert.ok(encl, 'аудио-вложение в подкаст-ленте: ' + pod.text.slice(0, 500));
  const audio = await guest.get(encl[1].replace(BASE, '').replace(/&amp;/g, '&'));
  assert.equal(audio.status, 200, 'аудиодорожка доступна по токену ленты');
  const chan = await guest.get(`/api/rss/channel/${(await user.get('/api/auth/me')).json.user.handle}?ft=${ft.json.token}`);
  assert.equal(chan.status, 200, chan.text);
  const subsFeed = await guest.get('/api/rss/subscriptions');
  assert.equal(subsFeed.status, 403);
  const reset = await user.post('/api/me/feed-token/reset', {});
  assert.notEqual(reset.json.token, ft.json.token);
  const old = await guest.get(`/api/rss/latest?ft=${ft.json.token}`);
  assert.ok(!old.text.includes(`/watch/${editShortId}`), 'старый токен больше не действует');
  // SCORM
  const zip = await user.req('GET', `/api/videos/${editVideoId}/scorm.zip?version=1.2&percent=80&share=1`);
  assert.equal(zip.status, 200, zip.text.slice(0, 200));
  assert.ok(zip.headers.get('content-type').includes('zip'));
  assert.ok(zip.text.startsWith('PK'), 'zip-архив');
  assert.ok(zip.text.includes('imsmanifest.xml') && zip.text.includes('index.html') && zip.text.includes('scorm.js'));
  const links = await user.get(`/api/videos/${editVideoId}/share-links`);
  const scormLink = links.json.links.find((l) => l.note === 'SCORM');
  assert.ok(scormLink, 'создана гостевая ссылка для SCORM');
  const zip2004 = await user.req('GET', `/api/videos/${editVideoId}/scorm.zip?version=2004`);
  assert.equal(zip2004.status, 200);
  const forbidden = await viewer.req('GET', `/api/videos/${editVideoId}/scorm.zip`);
  assert.equal(forbidden.status, 403);
  const replay = await user.get(`/api/videos/${editVideoId}/chat-replay`);
  assert.equal(replay.json.available, false, 'не запись эфира — повтора чата нет');
});

test('xAPI: выражения в LRS при выполнении назначения и тесте (мок LRS)', async () => {
  const statements = [];
  const { srv, port } = await mockServer((req, res, body) => { statements.push({ auth: req.headers.authorization, url: req.url, version: req.headers['x-experience-api-version'], body: JSON.parse(body) }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(['00000000-0000-0000-0000-000000000000'])); });
  try {
    const st = await admin.put('/api/admin/settings', { settings: { 'xapi.enabled': true, 'xapi.endpoint': `http://127.0.0.1:${port}/xapi/`, 'xapi.username': 'lrs', 'xapi.password': 'secret' } });
    assert.equal(st.status, 200);
    const t = await admin.post('/api/admin/settings/test-xapi', {});
    assert.equal(t.status, 200, t.text);
    assert.equal(statements.length, 1);
    assert.equal(statements[0].auth, 'Basic ' + Buffer.from('lrs:secret').toString('base64'));
    assert.equal(statements[0].url, '/xapi/statements');
    assert.equal(statements[0].version, '1.0.3');
    // назначение зрителю на 12-секундное видео с порогом 50 % → прогресс → completed
    const a = await admin.post('/api/assignments', { videoId: editVideoId, targets: [{ type: 'user', id: viewerEmail }], requiredPercent: 50 });
    assert.equal(a.status, 200, a.text);
    const pr = await viewer.post(`/api/videos/${editShortId}/progress`, { position: 3.9, watchedDelta: 4, buckets: [0, 1, 2, 3] });
    assert.equal(pr.status, 200, pr.text);
    for (let i = 0; i < 30 && statements.length < 2; i++) await new Promise((r) => setTimeout(r, 500));
    const completed = statements.find((s) => s.body.verb?.id?.endsWith('/completed'));
    assert.ok(completed, 'выражение completed отправлено: ' + JSON.stringify(statements.map((s) => s.body.verb)));
    assert.equal(completed.body.actor.mbox, `mailto:${viewerEmail}`);
    assert.ok(completed.body.object.id.endsWith(`/watch/${editShortId}`));
    assert.equal(completed.body.result.completion, true);
    const log = await admin.get('/api/admin/xapi/statements');
    assert.ok(log.json.statements.some((x) => x.verb === 'completed' && x.status === 'ok'));
    await admin.del(`/api/assignments/${a.json.assignment.id}`);
  } finally { srv.close(); await admin.put('/api/admin/settings', { settings: { 'xapi.enabled': false } }); }
});

test('обязательная двухфакторная защита для администраторов', async () => {
  const on = await admin.put('/api/admin/settings', { settings: { 'security.require_totp_admins': true } });
  assert.equal(on.status, 200, on.text);
  try {
    const blocked = await admin.get('/api/admin/settings');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.code, 'totp_required');
    const cfg = await admin.get('/api/config');
    assert.equal(cfg.json.requireTotpAdmins, true);
  } finally {
    // Администратор включает TOTP → доступ возвращается; затем выключаем требование и TOTP
    const setup = await admin.post('/api/auth/totp/setup', {});
    assert.equal(setup.status, 200, setup.text);
    const code = totpCode(setup.json.secret, Math.floor(Date.now() / 1000 / 30));
    const en = await admin.post('/api/auth/totp/enable', { code });
    assert.equal(en.status, 200, en.text);
    const ok = await admin.get('/api/admin/settings');
    assert.equal(ok.status, 200, ok.text);
    await admin.put('/api/admin/settings', { settings: { 'security.require_totp_admins': false } });
    const off = await admin.post('/api/auth/totp/disable', { password: ADMIN.password });
    assert.equal(off.status, 200, off.text);
  }
});

test('папка автоимпорта и пробный дайджест', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-inbox-'));
  const file = path.join(dir, `Совещание_${stamp}.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
  await admin.put('/api/admin/settings', { settings: { 'import.watch_dir': dir, 'import.watch_owner': userEmail, 'import.watch_visibility': 'internal', 'import.watch_delete': true } });
  try {
    const scan = await admin.post('/api/admin/system/watch-scan', {});
    assert.equal(scan.status, 200, scan.text);
    assert.equal(scan.json.imported, 1, 'файл импортирован: ' + scan.text);
    assert.ok(!fs.existsSync(file), 'файл забран из папки');
    const entry = scan.json.log.find((l) => l.filename === `Совещание_${stamp}.mp4`);
    assert.equal(entry.status, 'imported');
    const v = await waitVideoReady(user, entry.videoId, 120);
    assert.equal(v.status, 'ready');
    assert.equal(v.title, `Совещание ${stamp}`);
    assert.equal(v.visibility, 'internal');
    const again = await admin.post('/api/admin/system/watch-scan', {});
    assert.equal(again.json.imported || 0, 0, 'повторно не импортируется');
    await user.del(`/api/videos/${entry.videoId}`);
    const digest = await admin.post('/api/admin/system/digest-test', {});
    assert.equal(digest.status, 400, 'без SMTP дайджест не отправляется');
  } finally {
    await admin.put('/api/admin/settings', { settings: { 'import.watch_dir': '', 'import.watch_enabled': false } });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  await user.del(`/api/videos/${editVideoId}`);
});

test('вебинары: регистрация, присутствие, отчёт и напоминания', async () => {
  const st = await admin.post('/api/studio/live', { title: `Вебинар теста ${stamp}`, scheduledAt: new Date(Date.now() + 3600000).toISOString() });
  assert.equal(st.status, 200, st.text);
  const sid = st.json.stream.id; const short = st.json.stream.shortId;

  // Без регистрации записаться нельзя
  const early = await user.post(`/api/live/${sid}/registration`, {});
  assert.equal(early.status, 400, 'регистрация выключена — 400');

  const on = await admin.patch(`/api/studio/live/${sid}`, { registration: true, registrationLimit: 2, registrationNote: 'Только отдел продаж' });
  assert.equal(on.json.stream.registration, true, on.text);

  const state = await user.get(`/api/live/${short}/registration`);
  assert.equal(state.json.enabled, true);
  assert.equal(state.json.seatsLeft, 2);
  assert.equal(state.json.note, 'Только отдел продаж');

  const reg = await user.post(`/api/live/${sid}/registration`, {});
  assert.equal(reg.status, 200, reg.text);
  const state2 = await user.get(`/api/live/${short}/registration`);
  assert.equal(state2.json.registered, true);
  assert.equal(state2.json.count, 1);
  assert.equal(state2.json.seatsLeft, 1);

  // Присутствие: за один сигнал засчитывается не больше 120 секунд
  await user.post(`/api/live/${sid}/attendance`, { seconds: 90 });
  await user.post(`/api/live/${sid}/attendance`, { seconds: 9999 });
  const rep = await admin.get(`/api/live/${sid}/attendees`);
  assert.equal(rep.status, 200, rep.text);
  const row = rep.json.people.find((p) => p.email === userEmail) || rep.json.people[0];
  assert.equal(row.seconds, 210, 'учтено 90 + 120 секунд');
  assert.equal(rep.json.totals.registered, 1);
  assert.equal(rep.json.totals.attended, 1);
  const csv = await admin.get(`/api/live/${sid}/attendees?format=csv`);
  assert.match(csv.text, /Был на эфире/);

  // Отчёт доступен только организатору
  const foreign = await user.get(`/api/live/${sid}/attendees`);
  assert.equal(foreign.status, 403, 'чужой отчёт закрыт');

  // Отмена регистрации
  await user.del(`/api/live/${sid}/registration`);
  const state3 = await user.get(`/api/live/${short}/registration`);
  assert.equal(state3.json.registered, false);
  assert.equal(state3.json.count, 0);
  await admin.del(`/api/studio/live/${sid}`);
});

test('качество воспроизведения: приём метрик и сводка', async () => {
  const vlist = await admin.get('/api/studio/videos?limit=5');
  const v = (vlist.json.videos || []).find((x) => x.status === 'ready');
  const key = `t${Date.now().toString(36)}qoe`;
  const p1 = await user.post('/api/playback', { sessionKey: key, videoId: v.id, startupMs: 700, watchSec: 10, rebufferCount: 1, rebufferMs: 500, qualityHeight: 720, bitrateKbps: 2000, started: true, device: 'mobile', browser: 'chrome', source: 'watch' });
  assert.equal(p1.status, 200, p1.text);
  // Повторный сигнал того же сеанса не задваивает счётчики, а обновляет их
  const p2 = await user.post('/api/playback', { sessionKey: key, videoId: v.id, watchSec: 30, rebufferCount: 2, rebufferMs: 800, started: true });
  assert.equal(p2.status, 200, p2.text);
  const bad = await user.post('/api/playback', { sessionKey: 'к!', videoId: v.id });
  assert.equal(bad.status, 400, 'некорректный ключ сеанса отклонён');

  const q = await admin.get('/api/admin/quality?days=1');
  assert.equal(q.status, 200, q.text);
  assert.ok(q.json.totals.sessions >= 1, 'сеансы учтены');
  assert.ok(q.json.totals.startupMedianMs >= 1, 'измерено время старта');
  assert.ok(q.json.byDevice.some((d) => d.device === 'mobile'), 'есть разрез по устройствам');
  const csv = await admin.get('/api/admin/quality?days=1&format=csv');
  assert.match(csv.text, /Доля буферизации/);
});

test('курсы: создание, шаги, публикация, прохождение, сертификат, отчёт и назначение', async () => {
  const stampC = Date.now().toString(36);
  const cr = await admin.post('/api/courses', { title: `Курс ${stampC}`, description: 'Проверочный курс', requiredPercent: 20 });
  assert.equal(cr.status, 200, cr.text);
  const cid = cr.json.course.id;
  assert.ok(cr.json.course.slug, 'у курса есть адрес');

  // Шаги: видео, текст, материал
  const vlist = await admin.get('/api/studio/videos?limit=10');
  const v = (vlist.json.videos || []).find((x) => x.status === 'ready' && Number(x.duration) > 3);
  assert.ok(v, 'нужно готовое видео');
  const i1 = await admin.post(`/api/courses/${cid}/items`, { kind: 'video', videoId: v.id, section: 'Раздел 1' });
  const i2 = await admin.post(`/api/courses/${cid}/items`, { kind: 'text', title: 'Пояснение', body: 'Текст шага', section: 'Раздел 1' });
  const i3 = await admin.post(`/api/courses/${cid}/items`, { kind: 'material', title: 'Регламент', url: 'https://example.com/doc.pdf', section: 'Раздел 2' });
  assert.equal(i1.status, 200, i1.text);
  assert.equal(i3.status, 200, i3.text);

  // Черновик нельзя назначить
  const early = await admin.post('/api/assignments', { courseId: cid, targets: [{ type: 'user', id: 'user@vodokomfort.ru' }] });
  assert.equal(early.status, 400, 'черновик курса не назначается');

  const pub = await admin.patch(`/api/courses/${cid}`, { status: 'published' });
  assert.equal(pub.json.course.status, 'published', pub.text);

  // Сотрудник записывается сам и проходит шаги
  await user.post(`/api/courses/${cid}/enroll`, {});
  const page = await user.get(`/api/courses/${cid}`);
  assert.equal(page.status, 200, page.text);
  assert.equal(page.json.items.length, 3);
  assert.equal(page.json.items[0].locked, false, 'первый шаг открыт');
  assert.equal(page.json.items[1].locked, true, 'последовательный курс: следующий шаг закрыт');
  const blocked = await user.post(`/api/courses/${cid}/items/${i2.json.item.id}/complete`, {});
  assert.equal(blocked.status, 400, 'закрытый шаг нельзя отметить');

  // Просмотр видео засчитывает первый шаг
  await user.post(`/api/videos/${v.shortId}/progress`, { position: Number(v.duration) * 0.95, watchedDelta: 6, source: 'watch' });
  const afterWatch = await user.get(`/api/courses/${cid}`);
  assert.equal(afterWatch.json.items[0].completed, true, 'видео-шаг засчитан');
  assert.equal(afterWatch.json.items[1].locked, false, 'следующий шаг открылся');

  await user.post(`/api/courses/${cid}/items/${i2.json.item.id}/complete`, {});
  await user.post(`/api/courses/${cid}/items/${i3.json.item.id}/complete`, {});
  const done = await user.get(`/api/courses/${cid}`);
  assert.equal(done.json.course.completed, true, 'курс пройден');
  assert.equal(done.json.course.percent, 100);

  // Сертификат за курс
  const certs = await user.get('/api/me/certificates');
  assert.ok((certs.json.certificates || []).some((c) => c.title === `Курс ${stampC}`), 'выдан сертификат за курс');

  // Отчёт автору и CSV
  const rep = await admin.get(`/api/courses/${cid}/report`);
  assert.ok(rep.json.report.people.some((p) => p.completed), 'в отчёте есть прошедший');
  const csv = await admin.get(`/api/courses/${cid}/report?format=csv`);
  assert.match(csv.text, /Сотрудник;/);

  // Назначение курса и раздел «Назначено вам»
  const asg = await admin.post('/api/assignments', { courseId: cid, targets: [{ type: 'all' }], note: 'Пройти курс' });
  assert.equal(asg.json.assignment.kind, 'course', asg.text);
  const mine = await user.get('/api/assignments/mine');
  assert.ok((mine.json.assignments || []).some((a) => a.kind === 'course'), 'курс виден в «Назначено вам»');

  // Сводка по обучению
  const ov = await admin.get('/api/learning/overview');
  assert.ok(ov.json.courses.some((c) => c.id === cid), 'курс в сводке по обучению');
  assert.ok(ov.json.people.length >= 1, 'в сводке есть сотрудники');
});

test('реакции по таймкоду, тепловая карта, звуковые дорожки и переход к моменту', async () => {
  const vlist = await admin.get('/api/studio/videos?limit=10');
  const v = (vlist.json.videos || []).find((x) => x.status === 'ready' && Number(x.duration) > 3);

  // Реакции: постановка, повтор снимает, сводка автору
  const r1 = await user.post(`/api/videos/${v.shortId}/reactions`, { kind: 'question', t: 4 });
  assert.equal(r1.status, 200, r1.text);
  const list = await user.get(`/api/videos/${v.shortId}/reactions`);
  assert.ok(list.json.totals.question >= 1, 'реакция учтена');
  assert.ok(list.json.marks.length >= 1, 'есть метки для полосы перемотки');
  const again = await user.post(`/api/videos/${v.shortId}/reactions`, { kind: 'question', t: 4.5 });
  assert.equal(again.json.removed, true, 'повторная реакция рядом снимает отметку');
  const bad = await user.post(`/api/videos/${v.shortId}/reactions`, { kind: 'nope', t: 1 });
  assert.equal(bad.status, 400, 'неизвестная реакция отклонена');
  const rep = await admin.get(`/api/videos/${v.shortId}/reactions/report`);
  assert.equal(rep.status, 200, rep.text);

  // Тепловая карта: автору видна всегда, зрителю — только при достаточном числе просмотров.
  // Кривая строится по данным удержания, поэтому сначала отправляем просмотр с отметками участков.
  await user.post(`/api/videos/${v.shortId}/progress`, { position: 3, watchedDelta: 3, buckets: [0, 1, 2, 3, 4] });
  const hmOwner = await admin.get(`/api/videos/${v.shortId}/heatmap`);
  assert.equal(hmOwner.json.available, true, 'автор видит кривую');
  assert.equal(hmOwner.json.points.length, 100);
  const hmUser = await user.get(`/api/videos/${v.shortId}/heatmap`);
  assert.equal(typeof hmUser.json.available, 'boolean');

  // Границы вступления
  const pv = await admin.patch(`/api/videos/${v.id}`, { introEnd: 2.5, outroStart: Math.max(3, Number(v.duration) - 1) });
  assert.equal(pv.status, 200, pv.text);
  assert.equal((await admin.get(`/api/videos/${v.shortId}`)).json.video.introEnd, 2.5);

  // Звуковая дорожка (дубляж)
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')], 64);
  const fd = new FormData();
  fd.append('kind', 'description');
  fd.append('language', 'ru');
  fd.append('label', 'Тифлокомментарий');
  fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  const up = await admin.req('POST', `/api/videos/${v.id}/audio-tracks`, fd);
  assert.equal(up.status, 200, up.text);
  const tracks = await user.get(`/api/videos/${v.shortId}/audio-tracks`);
  assert.ok(tracks.json.tracks.some((t) => t.kind === 'description'), 'дорожка видна зрителю');
  await admin.del(`/api/videos/${v.id}/audio-tracks/${up.json.track.id}`);

  // Переход к найденному моменту
  const mom = await user.get(`/api/videos/${v.shortId}/moment?q=${encodeURIComponent('вода')}`);
  assert.equal(mom.status, 200, mom.text);
  assert.ok(Array.isArray(mom.json.hits));
  const short = await user.get(`/api/videos/${v.shortId}/moment?q=a`);
  assert.equal(short.status, 400, 'слишком короткий запрос отклонён');
});

test('границы доступа после аудита: токены, секреты вебхуков, гонки монтажа, валидность лент', async () => {
  // 1. API-токен не даёт доступа к администрированию, даже если владелец — администратор
  const t = await admin.post('/api/me/tokens', { name: 'audit' });
  assert.equal(t.status, 200, t.text);
  const byToken = new Client();
  const adminCall = await byToken.req('GET', '/api/admin/users?limit=1', null, { headers: { authorization: `Bearer ${t.json.token}` } });
  assert.equal(adminCall.status, 403, 'админка недоступна по токену');
  const meCall = await byToken.req('GET', '/api/auth/me', null, { headers: { authorization: `Bearer ${t.json.token}` } });
  assert.equal(meCall.json.user?.role, 'admin', 'обычные вызовы по токену работают');

  // 2. Секрет вебхука не возвращается в списке
  const wh = await admin.post('/api/admin/webhooks', { name: 'audit', url: 'http://127.0.0.1:9/hook', events: [] });
  const list = await admin.get('/api/admin/webhooks');
  const row = list.json.webhooks.find((x) => x.id === wh.json.webhook.id);
  assert.equal(row.secret, undefined, 'секрета нет в списке');
  assert.ok(row.secretHint && row.secretHint.length <= 12, 'есть подсказка');
  const sec = await admin.get(`/api/admin/webhooks/${wh.json.webhook.id}/secret`);
  assert.equal(sec.json.secret, wh.json.webhook.secret, 'секрет отдаётся отдельным запросом');
  await admin.del(`/api/admin/webhooks/${wh.json.webhook.id}`);

  // 3. Одновременные запросы монтажа: принимается ровно один
  const vlist = await admin.get('/api/studio/videos?limit=10');
  const v = (vlist.json.videos || []).find((x) => x.status === 'ready' && Number(x.duration) > 3);
  if (v) {
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => admin.post(`/api/videos/${v.id}/editor/trim`, { start: 0.2 + i * 0.01, end: Number(v.duration) - 0.5 })));
    assert.equal(rs.filter((r) => r.status === 200).length, 1, 'принят один монтаж из пяти');
    for (const r of rs) if (r.json?.jobId) await admin.post(`/api/admin/jobs/${r.json.jobId}/cancel`, {});
    const bad = await admin.post(`/api/videos/${v.id}/editor/cut`, { cuts: [null] });
    assert.equal(bad.status, 400, 'некорректные фрагменты — 400, а не 500');
  }

  // 4. Ленты остаются корректным XML (без повторного объявления пространства имён и управляющих символов)
  const rss = await admin.get('/api/rss/latest?limit=5');
  assert.equal(rss.status, 200, rss.text);
  const rssTag = rss.text.match(/<rss[^>]*>/)[0];
  assert.equal((rssTag.match(/xmlns:atom=/g) || []).length, 1, 'xmlns:atom объявлен один раз');
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(rss.text), 'нет управляющих символов');

  // 5. Статика: выход за каталог assets запрещён
  const trav = await guest.get('/assets/..%2Findex.html');
  assert.equal(trav.status, 404, 'обход каталога закрыт');
});

test('премьера: анонс, чат, доступ к медиа и переход в обычное видео', async () => {
  const vlist = await admin.get('/api/studio/videos?limit=10');
  const v = (vlist.json.videos || []).find((x) => x.status === 'ready' && Number(x.duration) > 3);
  assert.ok(v, 'нужно готовое видео');

  // Премьера возможна только на будущее время
  const past = await admin.patch(`/api/videos/${v.id}`, { premiere: true, scheduledAt: new Date(Date.now() - 60000).toISOString() });
  assert.equal(past.status, 400, 'премьера в прошлом отклонена');

  const at = new Date(Date.now() + 3600 * 1000).toISOString();
  const set = await admin.patch(`/api/videos/${v.id}`, { premiere: true, premiereChat: true, scheduledAt: at, visibility: 'internal' });
  assert.equal(set.status, 200, set.text);
  assert.equal(set.json.video.premiere, true);
  assert.equal(set.json.video.premiereState, 'scheduled');

  // Анонс виден сотруднику, обратный отсчёт считается
  const pr = await user.get(`/api/videos/${v.shortId}/premiere`);
  assert.equal(pr.status, 200, pr.text);
  assert.equal(pr.json.state, 'scheduled');
  assert.ok(pr.json.startsInSec > 3000, 'до премьеры больше 50 минут');
  assert.equal(pr.json.position, 0);

  // Видео есть в поиске и лентах как анонс
  const card = await user.get(`/api/videos/${v.shortId}`);
  assert.equal(card.status, 200, 'страница анонса открывается');
  assert.equal(card.json.video.premiereState, 'scheduled');

  // Медиа до начала не отдаётся постороннему, автору — отдаётся
  const mediaUser = await user.req('GET', '/api/media/auth', null, { headers: { 'x-original-uri': `/media/videos/${v.id}/hls/master.m3u8` } });
  assert.equal(mediaUser.status, 403, 'зритель не может скачать видео до премьеры');
  const mediaOwner = await admin.req('GET', '/api/media/auth', null, { headers: { 'x-original-uri': `/media/videos/${v.id}/hls/master.m3u8` } });
  assert.equal(mediaOwner.status, 200, 'автор смотрит до премьеры');

  // Чат премьеры
  const msg = await user.post(`/api/videos/${v.shortId}/premiere/chat`, { body: 'Ждём!' });
  assert.equal(msg.status, 200, msg.text);
  assert.equal(msg.json.message.body, 'Ждём!');
  const empty = await user.post(`/api/videos/${v.shortId}/premiere/chat`, { body: '   ' });
  assert.equal(empty.status, 400, 'пустое сообщение отклонено');
  const again = await user.get(`/api/videos/${v.shortId}/premiere`);
  assert.ok(again.json.messages.length >= 1, 'история чата отдаётся');

  // Комнату совместного просмотра на не начавшейся премьере создать нельзя
  const party = await user.post(`/api/videos/${v.id}/party`, {});
  assert.equal(party.status, 400, 'комната до премьеры запрещена');

  // Премьера началась: позиция считается от назначенного времени
  await admin.patch(`/api/videos/${v.id}`, { premiere: false, scheduledAt: null });
  const back = await user.get(`/api/videos/${v.shortId}`);
  assert.equal(back.json.video.premiere, false, 'видео вернулось в обычный режим');
});

test('совместный просмотр: комната, синхронизация, чат и права', async () => {
  const vlist = await admin.get('/api/studio/videos?limit=10');
  const v = (vlist.json.videos || []).find((x) => x.status === 'ready' && Number(x.duration) > 3);
  const created = await admin.post(`/api/videos/${v.id}/party`, { everyoneControls: false });
  assert.equal(created.status, 200, created.text);
  const code = created.json.party.code;
  assert.ok(code && code.length >= 6, 'есть код комнаты');
  assert.ok(created.json.url.includes(`/party/${code}`), 'ссылка для рассылки');

  // Повторный вызов возвращает ту же комнату (ведущий не плодит комнаты)
  const again = await admin.post(`/api/videos/${v.id}/party`, {});
  assert.equal(again.json.party.code, code, 'комната переиспользуется');

  // Ведущий управляет, участник — нет (позиция не может быть дальше конца видео)
  const pos = Math.max(1, Math.min(20, Number(v.duration) / 2));
  const play = await admin.post(`/api/party/${code}/state`, { position: pos, playing: true });
  assert.equal(play.status, 200, play.text);
  assert.ok(Math.abs(play.json.party.position - pos) < 1, 'позиция принята');
  const byUser = await user.post(`/api/party/${code}/state`, { position: 0, playing: false });
  assert.equal(byUser.status, 403, 'участник не управляет, когда это запрещено');

  // Позиция «едет» вместе с эфиром комнаты
  await new Promise((r) => setTimeout(r, 1200));
  const state = await user.get(`/api/party/${code}`);
  assert.equal(state.status, 200, state.text);
  assert.ok(state.json.party.position > pos + 0.5, 'позиция догоняет реальное время');
  assert.ok(state.json.party.members.length >= 1, 'участники видны');

  // Чат комнаты и приглашение
  const msg = await user.post(`/api/party/${code}/chat`, { body: 'Привет' });
  assert.equal(msg.status, 200, msg.text);
  const inv = await admin.post(`/api/party/${code}/invite`, { userIds: [] });
  assert.equal(inv.status, 400, 'пустое приглашение отклонено');

  // Гость без входа в комнату не попадает
  const anon = await guest.get(`/api/party/${code}`);
  assert.equal(anon.status, 401, 'гостю комната недоступна');

  // Закрывает ведущий
  const byOther = await user.post(`/api/party/${code}/end`, {});
  assert.equal(byOther.status, 403, 'участник не закрывает комнату');
  const closed = await admin.post(`/api/party/${code}/end`, {});
  assert.equal(closed.status, 200, closed.text);
  const after = await admin.post(`/api/party/${code}/state`, { position: 5, playing: true });
  assert.equal(after.status, 400, 'в закрытой комнате состояние не меняется');
});

test('экраны-витрины: токен, содержимое, ротация и права', async () => {
  const created = await admin.post('/api/admin/screens', { name: 'Тестовый холл', source: 'latest', subtitles: true });
  assert.equal(created.status, 200, created.text);
  const sc = created.json.screen;
  assert.ok(sc.token && sc.url.includes(`/screen/${sc.token}`), 'есть ссылка экрана');

  // Плейлист отдаётся без входа — телевизору незачем логиниться
  const pl = await guest.get(`/api/screens/${sc.token}/playlist`);
  assert.equal(pl.status, 200, pl.text);
  assert.ok(pl.json.items.length > 0, 'в показе есть видео');
  assert.ok(pl.json.items.every((x) => ['public', 'internal'].includes(x.visibility)), 'личные видео на экран не попадают');
  assert.ok(pl.json.items.every((x) => x.hlsUrl || x.mp4Url), 'у каждого видео есть поток');

  // Сотрудник без прав не управляет экранами
  const byUser = await user.get('/api/admin/screens');
  assert.equal(byUser.status, 403, 'раздел только для модераторов');

  // Смена ссылки отключает старую
  const rot = await admin.patch(`/api/admin/screens/${sc.id}`, { rotateToken: true, shuffle: true });
  assert.equal(rot.status, 200, rot.text);
  assert.notEqual(rot.json.screen.token, sc.token, 'токен сменился');
  const old = await guest.get(`/api/screens/${sc.token}/playlist`);
  assert.equal(old.status, 404, 'старая ссылка больше не работает');

  // Выключенный экран ничего не показывает
  await admin.patch(`/api/admin/screens/${sc.id}`, { isActive: false });
  const off = await guest.get(`/api/screens/${rot.json.screen.token}/playlist`);
  assert.equal(off.status, 403, 'выключенный экран не отдаёт видео');

  const prev = await admin.get(`/api/admin/screens/${sc.id}/preview`);
  assert.equal(prev.status, 200, prev.text);
  assert.ok(prev.json.count >= 0);
  const delr = await admin.del(`/api/admin/screens/${sc.id}`);
  assert.equal(delr.status, 204);
});

test('живые субтитры эфира и видео-SEO', async () => {
  const streams = await admin.get('/api/studio/live');
  const st = (streams.json.streams || [])[0];
  assert.ok(st, 'нужна трансляция');
  const on = await admin.patch(`/api/studio/live/${st.id}`, { captions: true });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.json.stream.captions, true, 'субтитры включены');
  const caps = await user.get(`/api/live/${st.id}/captions`);
  assert.equal(caps.status, 200, caps.text);
  assert.ok(Array.isArray(caps.json.captions));
  await admin.patch(`/api/studio/live/${st.id}`, { captions: false });

  // Разметка schema.org и карта сайта для публичных видео
  const pub = (await admin.get('/api/studio/videos?limit=20')).json.videos.find((x) => x.status === 'ready' && x.visibility === 'public');
  if (pub) {
    const page = await guest.get(`/watch/${pub.shortId}`);
    assert.ok(page.text.includes('application/ld+json'), 'на странице есть разметка VideoObject');
    assert.ok(page.text.includes('"@type":"VideoObject"'), 'тип разметки — VideoObject');
  }
  const sitemap = await guest.get('/sitemap-video.xml');
  assert.equal(sitemap.status, 200, 'карта сайта отдаётся');
  assert.ok(sitemap.text.startsWith('<?xml'), 'это XML');
  const robots = await guest.get('/robots.txt');
  assert.ok(robots.text.includes('Sitemap: '), 'robots.txt указывает на карту сайта');
  assert.ok(robots.text.includes('Disallow: /admin'), 'админка закрыта от роботов');
});

test('тренажёр с ветвлением: настройка, выбор зрителя, отчёт и права', async () => {
  const vlist = await admin.get('/api/studio/videos?limit=10');
  const v = (vlist.json.videos || []).find((x) => x.status === 'ready' && Number(x.duration) > 3);
  assert.ok(v, 'нужно готовое видео');

  const saved = await admin.put(`/api/videos/${v.id}/scenario`, {
    title: 'Действия при утечке', active: true, showResult: true,
    points: [
      { id: 'p1', at: 2, text: 'Обнаружена утечка. Что делать первым?', options: [
        { id: 'o1', text: 'Перекрыть задвижку', goto: 5, feedback: 'Верно', correct: true },
        { id: 'o2', text: 'Уйти с объекта', goto: 8, feedback: 'Так нельзя', correct: false },
      ] },
      { id: 'bad', at: 1, text: 'Развилка без вариантов', options: [{ id: 'x', text: 'Один' }] },
    ],
  });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.scenario.points.length, 1, 'развилка без двух вариантов отброшена');

  // Зритель не видит, какой вариант правильный, пока не выберет
  const asViewer = await user.get(`/api/videos/${v.shortId}/scenario`);
  assert.equal(asViewer.status, 200, asViewer.text);
  assert.equal(asViewer.json.scenario.points[0].options[0].correct, undefined, 'правильность скрыта от зрителя');
  assert.equal(asViewer.json.scenario.points[0].options[0].feedback, undefined, 'пояснение скрыто до выбора');

  // Выбор возвращает переход и разбор
  const pick = await user.post(`/api/videos/${v.id}/scenario/choice`, { pointId: 'p1', optionId: 'o2' });
  assert.equal(pick.status, 200, pick.text);
  assert.equal(pick.json.goto, 8, 'переход на нужную секунду');
  assert.equal(pick.json.correct, false);
  assert.equal(pick.json.feedback, 'Так нельзя');
  const wrong = await user.post(`/api/videos/${v.id}/scenario/choice`, { pointId: 'p1', optionId: 'нет' });
  assert.equal(wrong.status, 400, 'несуществующий вариант отклонён');

  // Отчёт автору; зритель его не видит
  const rep = await admin.get(`/api/videos/${v.id}/scenario/report`);
  assert.equal(rep.status, 200, rep.text);
  assert.ok(rep.json.totals.choices >= 1, 'выбор учтён');
  assert.ok(rep.json.totals.mistakes >= 1, 'ошибка видна автору');
  const o2 = rep.json.points[0].options.find((o) => o.id === 'o2');
  assert.ok(o2.count >= 1 && o2.percent > 0, 'распределение по вариантам');
  const byUser = await user.get(`/api/videos/${v.id}/scenario/report`);
  assert.equal(byUser.status, 403, 'отчёт только автору и модераторам');
  const byUserEdit = await user.put(`/api/videos/${v.id}/scenario`, { points: [] });
  assert.equal(byUserEdit.status, 403, 'чужой тренажёр не настроить');

  // Выключенный тренажёр зрителю не отдаётся
  await admin.put(`/api/videos/${v.id}/scenario`, { title: 'Действия при утечке', active: false, points: saved.json.scenario.points });
  const off = await user.get(`/api/videos/${v.shortId}/scenario`);
  assert.equal(off.json.scenario, null, 'выключенный тренажёр скрыт');
  const card = await user.get(`/api/videos/${v.shortId}`);
  assert.equal(card.json.video.hasScenario, false, 'флаг снят');
});

test('итоги встречи и автоклипы: разбор ответа модели и границы', async () => {
  const { normalizeNotes, normalizeClips, toSeconds, transcriptText } = await import('../src/jobs/meeting.js');

  // Таймкоды в разных форматах
  assert.equal(toSeconds('01:05'), 65);
  assert.equal(toSeconds('1:02:03'), 3723);
  assert.equal(toSeconds(42), 42);
  assert.equal(toSeconds('ерунда'), 0);

  // Итоги: обрезка по длительности, отсев пустого
  const notes = normalizeNotes({
    summary: 'Кратко о планёрке',
    topics: [{ at: '00:30', title: 'Заявки', text: '' }, { at: '99:00', title: '', text: '' }],
    decisions: [{ at: '01:05', text: 'Согласуем в 1С' }, { at: '00:10', text: '' }],
    tasks: [{ at: '01:40', text: 'Инструкция', who: 'Иван', due: 'до 25-го' }],
    questions: [{ at: '02:10', text: 'Кто замещает?' }],
  }, 100);
  assert.equal(notes.decisions.length, 1, 'пустое решение отброшено');
  assert.equal(notes.topics.length, 1, 'тема без текста и названия отброшена');
  assert.equal(notes.topics[0].text, 'Заявки', 'текст темы берётся из названия');
  assert.equal(notes.tasks[0].who, 'Иван');
  assert.ok(notes.decisions[0].at <= 100, 'таймкод не выходит за длительность');

  // Клипы: отсев коротких и выходящих за пределы, сортировка по оценке
  const clips = normalizeClips({ clips: [
    { start: '00:20', end: '01:10', title: 'Инструкция', reason: 'Готово к отправке', score: 70 },
    { start: '00:00', end: '00:05', title: 'Короткий', score: 90 },
    { start: '02:00', end: '02:40', title: 'За пределами', score: 95 },
    { start: '00:30', end: '01:30', title: 'Лучший', score: 88 },
  ] }, 100);
  assert.equal(clips.length, 2, 'остались только пригодные фрагменты');
  assert.equal(clips[0].title, 'Лучший', 'сортировка по оценке');
  assert.ok(clips.every((c) => c.end - c.start >= 10 && c.end <= 100));

  // Расшифровка с таймкодами укладывается в лимит
  const segs = Array.from({ length: 500 }, (_, i) => ({ start: i * 2, end: i * 2 + 2, text: `Реплика номер ${i} про работу` }));
  const text = transcriptText({ segments: segs }, 2000);
  assert.ok(text.length <= 2600, 'текст прорежен до лимита');
  assert.ok(/^\[\d{2}:\d{2}\]/.test(text), 'таймкоды сохранены');

  // Права и проверки маршрутов
  const vlist = await admin.get('/api/studio/videos?limit=10');
  const v = (vlist.json.videos || []).find((x) => x.status === 'ready');
  const byUser = await user.post(`/api/videos/${v.id}/meeting-notes`, {});
  assert.equal(byUser.status, 403, 'итоги делает автор или модератор');
  const suggByUser = await user.get(`/api/videos/${v.id}/clip-suggestions`);
  assert.equal(suggByUser.status, 403, 'предложения видны автору');
  const short = await admin.post(`/api/videos/${v.id}/clip-suggestions`, {});
  assert.ok([200, 400].includes(short.status), 'для коротких видео — понятный отказ');
  if (short.status === 400) assert.match(short.json.error, /коротких|расшифровк|отключен/i);
  const notesGet = await admin.get(`/api/videos/${v.shortId}/meeting-notes`);
  assert.equal(notesGet.status, 200, notesGet.text);
  assert.equal(typeof notesGet.json.enabled, 'boolean');
});

test('удаление видео владельцем', async () => {
  const r = await user.del(`/api/videos/${videoId}`);
  assert.equal(r.status, 200);
  const g = await user.get(`/api/videos/${videoId}`);
  assert.equal(g.status, 404);
});
