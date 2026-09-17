// Состояние пользователя и публичной конфигурации.
import { defineStore } from 'pinia';
import { get, post } from '../api.js';

export const useAuth = defineStore('auth', {
  state: () => ({
    user: null,
    totpRequired: false,
    unread: 0,
    assignmentsPending: 0,
    watchLaterId: null,
    config: null,
    loaded: false,
  }),
  getters: {
    isLoggedIn: (s) => !!s.user,
    isActive: (s) => !!s.user && s.user.status === 'active',
    isStaff: (s) => !!s.user && ['admin', 'moderator'].includes(s.user.role),
    isAdmin: (s) => !!s.user && s.user.role === 'admin',
    canUpload: (s) => !!s.config?.permissions?.canUpload,
    canStream: (s) => !!s.config?.permissions?.canStream,
    canAssign: (s) => !!s.user && s.user.status === 'active' && (['admin', 'moderator'].includes(s.user.role) || s.config?.assignmentsWhoCanAssign === 'all'),
    siteName: (s) => s.config?.siteName || 'Видео',
  },
  actions: {
    async load() {
      try {
        const [me, cfg] = await Promise.all([get('/api/auth/me'), get('/api/config')]);
        this.user = me.user;
        this.totpRequired = !!me.totpRequired;
        this.unread = me.unread || 0;
        this.assignmentsPending = me.assignmentsPending || 0;
        this.watchLaterId = me.watchLaterId || null;
        this.config = cfg;
        try { localStorage.setItem('cv.config', JSON.stringify(cfg)); } catch { /* приватный режим */ }
      } catch (e) {
        // Без сети берём последние известные настройки: нужны разделу «Скачанные»
        try { const cached = localStorage.getItem('cv.config'); if (cached && !this.config) this.config = JSON.parse(cached); } catch { /* ignore */ }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) console.info('Сети нет — доступны скачанные видео');
        else console.error('auth load failed', e);
      } finally {
        this.loaded = true;
      }
    },
    async refreshConfig() {
      this.config = await get('/api/config');
    },
    async login(login, password) {
      const r = await post('/api/auth/login', { login, password });
      if (r.totpRequired) { this.totpRequired = true; return r; }
      this.user = r.user;
      this.totpRequired = false;
      await this.load();
      return r;
    },
    async totp(code) {
      const r = await post('/api/auth/totp', { code });
      this.user = r.user;
      this.totpRequired = false;
      await this.load();
      return r;
    },
    async logout() {
      await post('/api/auth/logout', {});
      this.user = null;
      this.unread = 0;
      await this.refreshConfig();
    },
    setUser(u) { this.user = u; },
  },
});
