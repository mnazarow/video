// WebSocket: уведомления, прогресс обработки, чат трансляций, служебные события для админки.
import { bus } from '../db.js';
import { addSocket, joinChannel, leaveChannel, localToUser, localToChannel, localBroadcast } from '../lib/realtime.js';
import { loadStream } from './live.js';
import { canViewLive } from '../lib/access.js';

let wired = false;
function wireBus() {
  if (wired) return; wired = true;
  for (const t of ['video.progress', 'video.ready', 'video.failed', 'video.subtitles', 'video.published', 'video.ai']) {
    bus.on(t, (e) => { if (e.ownerId) localToUser(e.ownerId, { ...e }); localToChannel('admin', { ...e }); });
  }
  for (const t of ['live.started', 'live.ended']) bus.on(t, (e) => localBroadcast({ ...e }));
  bus.on('job.enqueued', (e) => localToChannel('admin', { ...e }));
  bus.on('settings.changed', (e) => localBroadcast({ type: 'settings.changed' }));
}

export default async function wsRoutes(app) {
  wireBus();
  app.get('/ws', { websocket: true }, (socket, req) => {
    addSocket(socket, req.user);
    if (req.user && ['admin', 'moderator'].includes(req.user.role)) joinChannel(socket, 'admin');
    socket.send(JSON.stringify({ type: 'hello', userId: req.user?.id || null }));
    socket.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ping') { socket.send(JSON.stringify({ type: 'pong', t: Date.now() })); return; }
      if (msg.type === 'join' && typeof msg.channel === 'string') {
        const ch = msg.channel.slice(0, 80);
        if (ch.startsWith('live:')) {
          const s = await loadStream(ch.slice(5)).catch(() => null);
          if (!s || !canViewLive(s, req.user)) return;
          joinChannel(socket, `live:${s.id}`);
          socket.send(JSON.stringify({ type: 'joined', channel: `live:${s.id}` }));
        }
        return;
      }
      if (msg.type === 'leave' && typeof msg.channel === 'string') { leaveChannel(socket, msg.channel); }
    });
    // Пинг для поддержания соединения
    const iv = setInterval(() => { try { if (socket.readyState === 1) socket.ping(); } catch { /* ignore */ } }, 25000);
    socket.on('close', () => clearInterval(iv));
  });
}
