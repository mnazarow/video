// Маршруты аутентификации: регистрация по разрешённым доменам, подтверждение e-mail, вход (локально/LDAP),
// второй фактор, сброс пароля, приглашения, сессии.
import { one, query, many, tx } from '../db.js';
import { hashPassword, verifyPassword, randomToken, generateTotpSecret, verifyTotp, totpUri } from '../lib/crypto.js';
import { templates, emailEnabled } from '../lib/mailer.js';
import { ldapAuthenticate } from '../lib/ldap.js';
import { badRequest, unauthorized, forbidden, notFound, conflict, EMAIL_RE, emailDomain, handleFromEmail, slugify } from '../lib/util.js';
import { userSelf } from '../lib/serialize.js';
import { notifyAdmins } from '../lib/notify.js';
import { audit } from '../lib/audit.js';
import { syncLdapGroups, syncExternalGroups } from './groups.js';
import { startLogin as oidcStart, finishLogin as oidcFinish } from '../lib/oidc.js';
import { config } from '../config.js';
import { invalidateSessionCache } from '../plugins/auth.js';
import { getSetting } from '../lib/settings.js';
import { emitEvent, eventUser } from '../lib/events.js';

const strictLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

/** Уникальный @handle на основе e-mail/имени. */
export async function uniqueHandle(base) {
  let h = base.replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+|[._-]+$/g, '').slice(0, 30) || 'user';
  let candidate = h;
  for (let i = 0; i < 50; i++) {
    const exists = await one('SELECT 1 FROM users WHERE handle = $1', [candidate]);
    if (!exists) return candidate;
    candidate = `${h}${Math.floor(Math.random() * 9000 + 1000)}`;
  }
  return `${h}${Date.now()}`;
}

async function domainRule(email) {
  const domain = emailDomain(email);
  if (!domain) return null;
  return one('SELECT * FROM allowed_domains WHERE domain = $1', [domain]);
}

async function checkPassword(password, settings) {
  const min = settings['security.password_min_length'] || 8;
  if (typeof password !== 'string' || password.length < min) throw badRequest(`Пароль должен быть не короче ${min} символов`);
  if (password.length > 200) throw badRequest('Слишком длинный пароль');
  if (!/[A-Za-zА-Яа-я]/.test(password) || !/\d/.test(password)) throw badRequest('Пароль должен содержать буквы и цифры');
}

export default async function authRoutes(app) {
  // --- Регистрация -----------------------------------------------------------
  app.post('/register', strictLimit, async (req, reply) => {
    const s = req.settings;
    if (!s['registration.enabled']) throw forbidden('Регистрация закрыта. Обратитесь к администратору.');
    const { email, password, displayName } = req.body || {};
    const em = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(em)) throw badRequest('Укажите корректный адрес электронной почты');
    const rule = await domainRule(em);
    if (!rule) throw forbidden(`Регистрация с домена @${emailDomain(em)} не разрешена. Обратитесь к администратору.`);
    await checkPassword(password, s);
    const name = String(displayName || '').trim().slice(0, 80);
    if (name.length < 2) throw badRequest('Укажите имя (не короче 2 символов)');
    const existing = await one('SELECT id, status FROM users WHERE email = $1', [em]);
    if (existing) throw conflict('Пользователь с таким адресом уже зарегистрирован');

    const mailOk = await emailEnabled();
    const needVerify = s['registration.require_email_verification'] && mailOk;
    let status = needVerify ? 'pending_email' : (rule.auto_approve ? 'active' : 'pending_approval');
    const handle = await uniqueHandle(handleFromEmail(em));
    const user = await one(
      `INSERT INTO users(email, handle, display_name, password_hash, status, email_verified_at, approved_at, can_upload, can_stream)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [em, handle, name, hashPassword(password), status, needVerify ? null : new Date(), status === 'active' ? new Date() : null,
        !!s['registration.default_can_upload'], !!s['registration.default_can_stream']],
    );
    await audit(req, 'user.register', { targetType: 'user', targetId: user.id, details: { email: em, status } });
    await emitEvent('user.registered', { user: eventUser(user), autoApproved: status === 'active' });

    if (needVerify) {
      const token = randomToken(32);
      await query(`INSERT INTO tokens(token, type, user_id, email, expires_at) VALUES ($1,'verify_email',$2,$3, now() + interval '48 hours')`, [token, user.id, em]);
      await templates.verifyEmail({ to: em, name, url: `${config.baseUrl}/verify-email?token=${token}` });
    } else if (status === 'pending_approval') {
      await notifyNewRegistration(user);
    }
    // Автоматический вход (пользователь увидит страницу статуса)
    await app.createSession(reply, user, req);
    return { ok: true, status, user: userSelf(user), emailSent: needVerify };
  });

  async function notifyNewRegistration(user) {
    if (!(await getSetting('registration.notify_admins'))) return;
    await notifyAdmins({
      type: 'registration',
      title: 'Новая заявка на регистрацию',
      body: `${user.display_name} (${user.email}) ожидает одобрения`,
      link: '/admin/users?status=pending_approval',
      actorId: user.id,
      data: { userId: user.id },
    }, { email: (admin) => templates.adminNewRegistration({ to: admin.email, userName: user.display_name, userEmail: user.email, url: `${config.baseUrl}/admin/users?status=pending_approval` }) });
  }

  app.post('/verify-email', strictLimit, async (req, reply) => {
    const { token } = req.body || {};
    const t = await one(`SELECT * FROM tokens WHERE token = $1 AND type = 'verify_email' AND used_at IS NULL AND expires_at > now()`, [String(token || '')]);
    if (!t) throw badRequest('Ссылка недействительна или устарела. Запросите новое письмо.');
    const user = await one('SELECT * FROM users WHERE id = $1', [t.user_id]);
    if (!user) throw notFound();
    const rule = await domainRule(user.email);
    const auto = !!rule?.auto_approve;
    const nextStatus = user.status === 'pending_email' ? (auto ? 'active' : 'pending_approval') : user.status;
    await tx(async (c) => {
      await c.query('UPDATE tokens SET used_at = now() WHERE token = $1', [t.token]);
      await c.query('UPDATE users SET email_verified_at = now(), status = $2, approved_at = CASE WHEN $2 = $3 THEN now() ELSE approved_at END WHERE id = $1', [user.id, nextStatus, 'active']);
    });
    invalidateSessionCache(null, user.id);
    if (nextStatus === 'pending_approval') await notifyNewRegistration(user);
    if (nextStatus === 'active' && auto) {
      await templates.approved({ to: user.email, name: user.display_name, url: config.baseUrl });
    }
    await audit(req, 'user.verify_email', { targetType: 'user', targetId: user.id });
    if (!req.user) await app.createSession(reply, user, req);
    return { ok: true, status: nextStatus };
  });

  app.post('/resend-verification', strictLimit, async (req) => {
    const em = String(req.body?.email || req.user?.email || '').trim().toLowerCase();
    const user = await one(`SELECT * FROM users WHERE email = $1 AND status = 'pending_email'`, [em]);
    if (user) {
      await query(`UPDATE tokens SET used_at = now() WHERE user_id = $1 AND type = 'verify_email' AND used_at IS NULL`, [user.id]);
      const token = randomToken(32);
      await query(`INSERT INTO tokens(token, type, user_id, email, expires_at) VALUES ($1,'verify_email',$2,$3, now() + interval '48 hours')`, [token, user.id, em]);
      await templates.verifyEmail({ to: em, name: user.display_name, url: `${config.baseUrl}/verify-email?token=${token}` });
    }
    return { ok: true };
  });

  // --- Вход ------------------------------------------------------------------
  app.post('/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const s = req.settings;
    const login = String(req.body?.login || req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!login || !password) throw badRequest('Укажите логин и пароль');

    let user = await one('SELECT * FROM users WHERE (email = $1 OR handle = $1) AND deleted_at IS NULL', [login]);
    const maxAttempts = s['security.max_login_attempts'] || 8;

    if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
      throw forbidden(`Слишком много неудачных попыток. Повторите через ${Math.ceil((new Date(user.locked_until) - Date.now()) / 60000)} мин.`);
    }

    let ok = false;
    let ldapInfo = null;
    if (user && user.auth_provider === 'local' && user.password_hash) {
      ok = verifyPassword(password, user.password_hash);
    }
    if (!ok && s['ldap.enabled'] && (!user || user.auth_provider === 'ldap')) {
      try {
        ldapInfo = await ldapAuthenticate(login, password);
        ok = true;
      } catch (e) {
        req.log.info({ err: e.message }, 'ldap auth failed');
      }
    }
    if (!ok) {
      if (user) {
        const failed = (user.failed_logins || 0) + 1;
        const lock = failed >= maxAttempts ? new Date(Date.now() + (s['security.lockout_minutes'] || 15) * 60000) : null;
        await query('UPDATE users SET failed_logins = $2, locked_until = $3 WHERE id = $1', [user.id, lock ? 0 : failed, lock]);
      }
      await audit(req, 'user.login_failed', { details: { login } });
      throw unauthorized('Неверный логин или пароль');
    }

    if (ldapInfo) {
      user = await upsertLdapUser(ldapInfo, user, s);
      await syncLdapGroups(user.id, ldapInfo.groups).catch((e) => req.log.warn({ err: e.message }, 'ldap groups sync'));
    }
    if (user.status === 'blocked') throw forbidden('Учётная запись заблокирована администратором');
    if (user.status === 'rejected') throw forbidden('Заявка на регистрацию была отклонена');

    const totpPending = !!user.totp_enabled;
    await query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
    await app.createSession(reply, user, req, { totpPending });
    await audit(req, 'user.login', { targetType: 'user', targetId: user.id, details: { provider: ldapInfo ? 'ldap' : 'local' } });
    if (totpPending) return { ok: true, totpRequired: true };
    return { ok: true, user: userSelf(user) };
  });

  async function upsertLdapUser(info, existing, s) {
    const email = info.email || `${slugify(info.login)}@ldap.local`;
    if (existing) {
      const role = info.isAdmin && existing.role === 'user' ? 'admin' : existing.role;
      return one('UPDATE users SET display_name = COALESCE(NULLIF($2, \'\'), display_name), ldap_dn = $3, email_verified_at = COALESCE(email_verified_at, now()), role = $4, updated_at = now() WHERE id = $1 RETURNING *',
        [existing.id, info.name, info.dn, role]);
    }
    // Пользователь с таким e-mail мог быть заведён локально — привязываем
    const byEmail = await one('SELECT * FROM users WHERE email = $1', [email]);
    if (byEmail) {
      return one('UPDATE users SET auth_provider = \'ldap\', ldap_dn = $2, email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1 RETURNING *', [byEmail.id, info.dn]);
    }
    const status = s['ldap.auto_approve'] ? 'active' : 'pending_approval';
    const handle = await uniqueHandle(slugify(info.login, 30).replace(/-/g, '.'));
    const user = await one(
      `INSERT INTO users(email, handle, display_name, password_hash, role, status, auth_provider, ldap_dn, email_verified_at, approved_at, can_upload, can_stream)
       VALUES ($1,$2,$3,NULL,$4,$5,'ldap',$6, now(), $7, $8, $9) RETURNING *`,
      [email, handle, info.name || info.login, info.isAdmin ? 'admin' : 'user', status, info.dn, status === 'active' ? new Date() : null,
        !!s['registration.default_can_upload'], !!s['registration.default_can_stream']],
    );
    if (status === 'pending_approval') await notifyNewRegistration(user);
    return user;
  }

  // --- Вход через SSO (OpenID Connect) -----------------------------------------------------
  const oidcRedirect = () => `${config.baseUrl}/api/auth/oidc/callback`;
  const OIDC_COOKIE = 'cv_oidc';
  app.get('/oidc/start', async (req, reply) => {
    const s = req.settings;
    if (!s['oidc.enabled'] || !s['oidc.issuer'] || !s['oidc.client_id']) throw badRequest('Вход через SSO не настроен');
    const next = String(req.query.next || '/');
    let started;
    try { started = await oidcStart(s, oidcRedirect(), next.startsWith('/') && !next.startsWith('//') ? next : '/'); } catch (e) { return reply.redirect(`/login?error=${encodeURIComponent('SSO: ' + e.message)}`); }
    reply.setCookie(OIDC_COOKIE, started.state, { path: '/api/auth', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 900 });
    return reply.redirect(started.url);
  });
  app.get('/oidc/callback', async (req, reply) => {
    const s = req.settings;
    const fail = (msg) => reply.redirect(`/login?error=${encodeURIComponent(msg)}`);
    if (!s['oidc.enabled']) return fail('Вход через SSO отключён');
    if (req.query.error) return fail(`SSO: ${req.query.error_description || req.query.error}`);
    let info;
    const boundState = String(req.cookies?.[OIDC_COOKIE] || '');
    reply.clearCookie(OIDC_COOKIE, { path: '/api/auth' });
    try { info = await oidcFinish(s, oidcRedirect(), { code: String(req.query.code || ''), state: String(req.query.state || ''), boundState }); } catch (e) { req.log.warn({ err: e.message }, 'oidc'); return fail('SSO: ' + e.message); }
    if (!info.email || !EMAIL_RE.test(info.email)) return fail('SSO: провайдер не передал адрес электронной почты (проверьте scope email)');
    if (s['oidc.check_domain'] && !(await domainRule(info.email))) return fail(`Вход с домена @${emailDomain(info.email)} не разрешён. Обратитесь к администратору.`);
    let user = await one('SELECT * FROM users WHERE oidc_sub = $1 OR email = $2 ORDER BY (oidc_sub = $1) DESC LIMIT 1', [info.sub, info.email]);
    if (user && user.deleted_at) return fail('Учётная запись удалена');
    if (user) {
      const role = info.isAdmin && user.role === 'user' ? 'admin' : user.role;
      user = await one(`UPDATE users SET oidc_sub = $2, display_name = COALESCE(NULLIF($3, ''), display_name), email_verified_at = COALESCE(email_verified_at, now()), role = $4,
                          email = CASE WHEN email <> $5 AND NOT EXISTS (SELECT 1 FROM users x WHERE x.email = $5 AND x.id <> users.id) THEN $5 ELSE email END,
                          auth_provider = CASE WHEN auth_provider = 'local' AND password_hash IS NULL THEN 'oidc' ELSE auth_provider END, updated_at = now() WHERE id = $1 RETURNING *`,
        [user.id, info.sub, info.name, role, info.email]);
    } else {
      const status = s['oidc.auto_approve'] ? 'active' : 'pending_approval';
      const handle = await uniqueHandle(handleFromEmail(info.email));
      user = await one(
        `INSERT INTO users(email, handle, display_name, password_hash, role, status, auth_provider, oidc_sub, email_verified_at, approved_at, can_upload, can_stream)
         VALUES ($1,$2,$3,NULL,$4,$5,'oidc',$6, now(), $7, $8, $9) RETURNING *`,
        [info.email, handle, info.name || info.email.split('@')[0], info.isAdmin ? 'admin' : 'user', status, info.sub, status === 'active' ? new Date() : null,
          !!s['registration.default_can_upload'], !!s['registration.default_can_stream']],
      );
      if (status === 'pending_approval') await notifyNewRegistration(user);
    }
    if (s['oidc.sync_groups']) await syncExternalGroups(user.id, info.groups, { byName: true }).catch((e) => req.log.warn({ err: e.message }, 'oidc groups sync'));
    if (user.status === 'blocked') return fail('Учётная запись заблокирована администратором');
    if (user.status === 'rejected') return fail('Заявка на регистрацию была отклонена');
    await query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
    await app.createSession(reply, user, req, { totpPending: !!user.totp_enabled });
    await audit(req, 'user.login', { targetType: 'user', targetId: user.id, details: { provider: 'oidc' } });
    return reply.redirect(user.totp_enabled ? `/login?totp=1&next=${encodeURIComponent(info.nextUrl)}` : (user.status === 'active' ? info.nextUrl : '/account-status'));
  });

  app.post('/totp', strictLimit, async (req, reply) => {
    if (!req.session || !req.pendingUser) throw unauthorized('Сначала введите логин и пароль');
    const user = await one('SELECT * FROM users WHERE id = $1', [req.pendingUser.id]);
    if (!user?.totp_secret || !verifyTotp(user.totp_secret, req.body?.code)) throw unauthorized('Неверный код подтверждения');
    await query('UPDATE sessions SET totp_pending = false WHERE id = $1', [req.session.id]);
    invalidateSessionCache(req.session.id);
    return { ok: true, user: userSelf(user) };
  });

  app.post('/logout', async (req, reply) => {
    await app.destroySession(reply, req.session?.id);
    return { ok: true };
  });

  app.get('/me', async (req) => {
    if (!req.user) {
      if (req.pendingUser) return { user: null, totpRequired: true };
      return { user: null };
    }
    const unread = await one('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
    const wl = await one(`SELECT id FROM playlists WHERE owner_id = $1 AND kind = 'watch_later'`, [req.user.id]);
    // Незавершённые назначения «к обязательному просмотру» (для счётчика в меню)
    const asg = await one(
      `SELECT count(DISTINCT a.id)::int AS n FROM assignments a JOIN assignment_targets t ON t.assignment_id = a.id
       WHERE a.status = 'active' AND (t.target_type = 'all' OR t.user_id = $1 OR (t.target_type = 'group' AND t.group_id IN (SELECT group_id FROM group_members WHERE user_id = $1)))
         AND EXISTS (SELECT 1 FROM videos v WHERE v.deleted_at IS NULL AND v.status = 'ready' AND (v.id = a.video_id OR v.id IN (SELECT video_id FROM playlist_items WHERE playlist_id = a.playlist_id))
                       AND NOT EXISTS (SELECT 1 FROM assignment_progress p WHERE p.assignment_id = a.id AND p.user_id = $1 AND p.video_id = v.id AND p.completed_at IS NOT NULL))`,
      [req.user.id]);
    return { user: userSelf(req.user), unread: unread?.n || 0, watchLaterId: wl?.id || null, assignmentsPending: asg?.n || 0 };
  });

  // --- Восстановление пароля ---------------------------------------------------
  app.post('/forgot', strictLimit, async (req) => {
    const em = String(req.body?.email || '').trim().toLowerCase();
    const user = await one(`SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL AND auth_provider = 'local'`, [em]);
    if (user && (await emailEnabled())) {
      const token = randomToken(32);
      await query(`INSERT INTO tokens(token, type, user_id, email, expires_at) VALUES ($1,'reset_password',$2,$3, now() + interval '2 hours')`, [token, user.id, em]);
      await templates.resetPassword({ to: em, name: user.display_name, url: `${config.baseUrl}/reset-password?token=${token}` });
    }
    return { ok: true, emailEnabled: await emailEnabled() };
  });

  app.post('/reset', strictLimit, async (req, reply) => {
    const { token, password } = req.body || {};
    const t = await one(`SELECT * FROM tokens WHERE token = $1 AND type = 'reset_password' AND used_at IS NULL AND expires_at > now()`, [String(token || '')]);
    if (!t) throw badRequest('Ссылка недействительна или устарела');
    await checkPassword(password, req.settings);
    await tx(async (c) => {
      await c.query('UPDATE tokens SET used_at = now() WHERE token = $1', [t.token]);
      await c.query('UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [t.user_id, hashPassword(password)]);
      await c.query('DELETE FROM sessions WHERE user_id = $1', [t.user_id]);
    });
    invalidateSessionCache(null, t.user_id);
    await audit(req, 'user.password_reset', { targetType: 'user', targetId: t.user_id });
    return { ok: true };
  });

  app.post('/change-password', { preHandler: app.requireAuth }, async (req, reply) => {
    const user = await one('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (user.auth_provider !== 'local') throw badRequest('Пароль доменной учётной записи меняется в Active Directory');
    if (!verifyPassword(String(req.body?.currentPassword || ''), user.password_hash)) throw badRequest('Текущий пароль указан неверно');
    await checkPassword(req.body?.newPassword, req.settings);
    await query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [user.id, hashPassword(req.body.newPassword)]);
    await query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [user.id, req.session.id]);
    invalidateSessionCache(null, user.id);
    await audit(req, 'user.password_change', { targetType: 'user', targetId: user.id });
    return { ok: true };
  });

  // --- Приглашения -------------------------------------------------------------
  app.get('/invite/:token', async (req) => {
    const t = await one(`SELECT * FROM tokens WHERE token = $1 AND type = 'invite' AND used_at IS NULL AND expires_at > now()`, [req.params.token]);
    if (!t) throw notFound('Приглашение недействительно или устарело');
    return { email: t.email, role: t.payload?.role || 'user' };
  });

  app.post('/invite/:token', strictLimit, async (req, reply) => {
    const t = await one(`SELECT * FROM tokens WHERE token = $1 AND type = 'invite' AND used_at IS NULL AND expires_at > now()`, [req.params.token]);
    if (!t) throw notFound('Приглашение недействительно или устарело');
    const { password, displayName } = req.body || {};
    await checkPassword(password, req.settings);
    const name = String(displayName || '').trim().slice(0, 80);
    if (name.length < 2) throw badRequest('Укажите имя');
    const exists = await one('SELECT id FROM users WHERE email = $1', [t.email]);
    if (exists) throw conflict('Пользователь с таким адресом уже существует');
    const handle = await uniqueHandle(handleFromEmail(t.email));
    const user = await tx(async (c) => {
      await c.query('UPDATE tokens SET used_at = now() WHERE token = $1', [t.token]);
      return c.one(
        `INSERT INTO users(email, handle, display_name, password_hash, role, status, email_verified_at, approved_at, approved_by, can_upload, can_stream)
         VALUES ($1,$2,$3,$4,$5,'active', now(), now(), $6, true, true) RETURNING *`,
        [t.email, handle, name, hashPassword(password), t.payload?.role || 'user', t.created_by],
      );
    });
    await audit(req, 'user.invite_accept', { targetType: 'user', targetId: user.id });
    await app.createSession(reply, user, req);
    return { ok: true, user: userSelf(user) };
  });

  // --- Сессии ------------------------------------------------------------------
  app.get('/sessions', { preHandler: app.requireAuth }, async (req) => {
    const rows = await many('SELECT id, created_at, last_seen_at, expires_at, ip, user_agent FROM sessions WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC', [req.user.id]);
    return { sessions: rows.map((r) => ({ id: r.id.slice(0, 8), current: r.id === req.session.id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, ip: r.ip, userAgent: r.user_agent })) };
  });
  app.delete('/sessions/others', { preHandler: app.requireAuth }, async (req) => {
    await query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [req.user.id, req.session.id]);
    invalidateSessionCache(null, req.user.id);
    return { ok: true };
  });
  app.delete('/sessions/:prefix', { preHandler: app.requireAuth }, async (req) => {
    const rows = await many('SELECT id FROM sessions WHERE user_id = $1', [req.user.id]);
    const target = rows.find((r) => r.id.startsWith(req.params.prefix));
    if (target) { await query('DELETE FROM sessions WHERE id = $1', [target.id]); invalidateSessionCache(target.id); }
    return { ok: true };
  });

  // --- Двухфакторная аутентификация (TOTP) --------------------------------------
  app.post('/totp/setup', { preHandler: app.requireAuth }, async (req) => {
    if (!req.settings['security.allow_totp']) throw forbidden('Двухфакторная аутентификация отключена администратором');
    const secret = generateTotpSecret();
    await query('UPDATE users SET totp_secret = $2, totp_enabled = false WHERE id = $1', [req.user.id, secret]);
    return { secret, uri: totpUri(secret, req.user.email, req.settings['site.name']) };
  });
  app.post('/totp/enable', { preHandler: app.requireAuth }, async (req) => {
    const user = await one('SELECT totp_secret FROM users WHERE id = $1', [req.user.id]);
    if (!user?.totp_secret || !verifyTotp(user.totp_secret, req.body?.code)) throw badRequest('Неверный код. Проверьте время на устройстве.');
    await query('UPDATE users SET totp_enabled = true WHERE id = $1', [req.user.id]);
    invalidateSessionCache(null, req.user.id);
    await audit(req, 'user.totp_enable', { targetType: 'user', targetId: req.user.id });
    return { ok: true };
  });
  app.post('/totp/disable', { preHandler: app.requireAuth }, async (req) => {
    const user = await one('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const okPass = user.auth_provider === 'local' ? verifyPassword(String(req.body?.password || ''), user.password_hash) : true;
    const okCode = user.totp_secret && verifyTotp(user.totp_secret, req.body?.code);
    if (!okPass && !okCode) throw badRequest('Укажите текущий пароль или код из приложения');
    await query('UPDATE users SET totp_enabled = false, totp_secret = NULL WHERE id = $1', [req.user.id]);
    invalidateSessionCache(null, req.user.id);
    await audit(req, 'user.totp_disable', { targetType: 'user', targetId: req.user.id });
    return { ok: true };
  });
}
