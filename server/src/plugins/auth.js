// Плагин аутентификации: сессии (cookie), токены API, проверки прав.
import fp from 'fastify-plugin';
import { one, query } from '../db.js';
import { config } from '../config.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { getSetting, loadSettings } from '../lib/settings.js';
import { unauthorized, forbidden } from '../lib/util.js';

// Небольшой кэш сессий: id → { user, session, at }
const sessionCache = new Map();
const CACHE_TTL = 20000;

export function invalidateSessionCache(sessionId = null, userId = null) {
  if (sessionId) sessionCache.delete(sessionId);
  if (userId) for (const [k, v] of sessionCache) if (v.user?.id === userId) sessionCache.delete(k);
  if (!sessionId && !userId) sessionCache.clear();
}

const USER_COLS = `u.id, u.email, u.handle, u.display_name, u.role, u.status, u.auth_provider, u.can_upload, u.can_stream,
  u.avatar_path, u.banner_path, u.bio, u.links, u.prefs, u.totp_enabled, u.subscriber_count, u.video_count, u.total_views,
  u.created_at, u.last_login_at, u.email_verified_at, u.deleted_at`;

async function loadSession(sessionId) {
  const cached = sessionCache.get(sessionId);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached;
  const row = await one(
    `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, s.totp_pending, ${USER_COLS}
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now() AND u.deleted_at IS NULL`,
    [sessionId],
  );
  if (!row) { sessionCache.delete(sessionId); return null; }
  const { session_id, expires_at, last_seen_at, totp_pending, ...user } = row;
  const entry = { user, session: { id: session_id, expiresAt: expires_at, lastSeenAt: last_seen_at, totpPending: totp_pending }, at: Date.now() };
  sessionCache.set(sessionId, entry);
  if (sessionCache.size > 5000) { const first = sessionCache.keys().next().value; sessionCache.delete(first); }
  // Скользящее продление сессии (не чаще раза в 5 минут)
  if (Date.now() - new Date(last_seen_at).getTime() > 5 * 60 * 1000) {
    const days = await getSetting('security.session_days');
    query(`UPDATE sessions SET last_seen_at = now(), expires_at = now() + ($2 || ' days')::interval WHERE id = $1`, [sessionId, String(days)]).catch(() => {});
    query('UPDATE users SET last_seen_at = now() WHERE id = $1', [user.id]).catch(() => {});
  }
  return entry;
}

async function loadApiToken(raw) {
  if (!raw || !raw.startsWith('cv_')) return null;
  const hash = sha256(raw);
  const row = await one(
    `SELECT t.id AS token_id, t.scopes, t.expires_at AS token_expires, ${USER_COLS}
     FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND (t.expires_at IS NULL OR t.expires_at > now()) AND u.deleted_at IS NULL`,
    [hash],
  );
  if (!row) return null;
  const { token_id, scopes, token_expires, ...user } = row;
  query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [token_id]).catch(() => {});
  return { user, session: { id: `api:${token_id}`, api: true, scopes }, at: Date.now() };
}

export default fp(async function authPlugin(app) {
  app.decorateRequest('user', null);
  app.decorateRequest('session', null);
  app.decorateRequest('settings', null);
  app.decorateRequest('shareTokens', null);
  app.decorateRequest('webinarTokens', null);

  app.addHook('onRequest', async (req) => {
    req.settings = await loadSettings();
    // Токены защищённых ссылок (гостевой доступ к отдельным видео)
    const share = req.cookies?.cv_share;
    req.shareTokens = share ? String(share).split(',').filter((t) => /^[A-Za-z0-9_-]{8,64}$/.test(t)).slice(0, 20) : [];
    // Токены вебинаров: персональная ссылка внешнего участника (1.10)
    const wt = req.cookies?.cv_webinar;
    req.webinarTokens = wt ? String(wt).split(',').filter((t) => /^[A-Za-z0-9_-]{8,64}$/.test(t)).slice(0, 10) : [];
    const qt = req.query?.t;
    if (qt && /^[A-Za-z0-9_-]{8,64}$/.test(String(qt))) req.webinarTokens.push(String(qt));
    let entry = null;
    const authz = req.headers.authorization;
    if (authz && authz.startsWith('Bearer ')) {
      entry = await loadApiToken(authz.slice(7).trim());
    }
    if (!entry) {
      const sid = req.cookies?.[config.sessionCookie];
      if (sid) entry = await loadSession(sid);
    }
    if (entry && !entry.session.totpPending) {
      req.user = entry.user;
      req.session = entry.session;
    } else if (entry) {
      // Ожидается второй фактор — пользователь не считается вошедшим
      req.session = entry.session;
      req.pendingUser = entry.user;
    }
  });

  /** Создать сессию и установить cookie. */
  app.decorate('createSession', async function createSession(reply, user, req, { totpPending = false } = {}) {
    const id = randomToken(32);
    const days = await getSetting('security.session_days');
    await query(
      `INSERT INTO sessions(id, user_id, expires_at, ip, user_agent, totp_pending)
       VALUES ($1, $2, now() + ($3 || ' days')::interval, $4, $5, $6)`,
      [id, user.id, String(days), req.ip, String(req.headers['user-agent'] || '').slice(0, 300), totpPending],
    );
    reply.setCookie(config.sessionCookie, id, {
      path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: days * 86400,
    });
    return id;
  });

  app.decorate('destroySession', async function destroySession(reply, sessionId) {
    if (sessionId) {
      await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
      invalidateSessionCache(sessionId);
    }
    reply.clearCookie(config.sessionCookie, { path: '/' });
  });

  // Проверки прав — используются как preHandler
  app.decorate('requireAuth', async function requireAuth(req) {
    if (!req.user) throw unauthorized();
  });
  app.decorate('requireActive', async function requireActive(req) {
    if (!req.user) throw unauthorized();
    if (req.user.status !== 'active') throw forbidden('Учётная запись ещё не активирована администратором');
  });
  app.decorate('requireStaff', async function requireStaff(req) {
    if (!req.user) throw unauthorized();
    if (req.user.status !== 'active' || !['admin', 'moderator'].includes(req.user.role)) throw forbidden('Требуются права модератора');
    if (req.session?.api && !(req.session.scopes || []).includes('admin')) throw forbidden('У этого API-токена нет доступа к администрированию (нужна область admin)');
  });
  app.decorate('requireAdmin', async function requireAdmin(req) {
    if (!req.user) throw unauthorized();
    if (req.user.status !== 'active' || req.user.role !== 'admin') throw forbidden('Требуются права администратора');
    // API-токен работает в администрировании только с областью admin (по умолчанию её нет)
    if (req.session?.api && !(req.session.scopes || []).includes('admin')) throw forbidden('У этого API-токена нет доступа к администрированию (нужна область admin)');
    // 1.3: обязательная двухфакторная защита для администраторов (кроме входа по API-токену)
    if (req.settings?.['security.require_totp_admins'] && !req.user.totp_enabled && !req.session?.api) {
      const err = forbidden('Для администраторов обязательна двухфакторная защита: включите её в настройках профиля (Безопасность)');
      err.extra = { code: 'totp_required' };
      throw err;
    }
  });
});
