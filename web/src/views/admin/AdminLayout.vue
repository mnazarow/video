<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { get } from '../../api.js';
import { useAuth } from '../../stores/auth.js';
import * as ws from '../../ws.js';

const auth = useAuth();
const counts = ref({});
let timer = null;
async function refresh() { try { const s = await get('/api/admin/stats'); counts.value = { pending: s.users.pending, moderation: s.videos.pendingModeration, reports: s.reportsOpen, comments: s.commentsHeld, jobs: s.jobs.queued + s.jobs.running, failed: s.jobs.failed, live: s.liveNow }; } catch { /* ignore */ } }
onMounted(() => { refresh(); timer = setInterval(refresh, 60000); });
onBeforeUnmount(() => clearInterval(timer));
const NAV = [
  { to: '/admin', label: 'Дашборд', icon: 'dashboard', exact: true },
  { to: '/admin/users', label: 'Пользователи', icon: 'accounts', badge: 'pending' },
  { to: '/admin/domains', label: 'Домены и приглашения', icon: 'domain' },
  { to: '/admin/groups', label: 'Группы сотрудников', icon: 'groups' },
  { to: '/admin/moderation', label: 'Модерация', icon: 'gavel', badge: 'moderation' },
  { to: '/admin/videos', label: 'Все видео', icon: 'movie' },
  { to: '/admin/comments', label: 'Комментарии', icon: 'comment', badge: 'comments' },
  { to: '/admin/reports', label: 'Жалобы', icon: 'flag', badge: 'reports' },
  { to: '/admin/live', label: 'Трансляции', icon: 'broadcast', badge: 'live' },
  { to: '/admin/learning', label: 'Обучение', icon: 'school' },
  { to: '/admin/categories', label: 'Категории', icon: 'folder' },
  { to: '/admin/jobs', label: 'Очередь заданий', icon: 'listStatus', badge: 'jobs' },
  { to: '/admin/settings', label: 'Настройки', icon: 'settings', admin: true },
  { to: '/admin/audit', label: 'Журнал действий', icon: 'clipboard' },
  { to: '/admin/system', label: 'Система', icon: 'server' },
];
</script>

<template>
  <div class="page admin">
    <div class="layout-with-nav">
      <nav class="side-nav">
        <div class="sb-title" style="padding-left: 14px">Администрирование</div>
        <template v-for="n in NAV" :key="n.to">
          <router-link v-if="!n.admin || auth.isAdmin" :to="n.to" :class="{ 'router-link-active': n.exact ? $route.path === n.to : $route.path.startsWith(n.to) }" active-class=""><Icon :name="n.icon" :size="20" /> <span class="grow">{{ n.label }}</span><span v-if="n.badge && counts[n.badge]" class="badge" :class="n.badge === 'live' ? 'live' : 'brand'">{{ counts[n.badge] }}</span></router-link>
        </template>
      </nav>
      <div style="min-width:0">
        <div v-if="auth.isAdmin && auth.config?.requireTotpAdmins && !auth.user?.totpEnabled" class="alert danger mb-16"><Icon name="shieldAlert" :size="20" /><span class="grow">Для администраторов обязательна двухфакторная защита. Пока она не включена, разделы панели администратора недоступны.</span><router-link to="/settings/security" class="btn sm">Включить 2FA</router-link></div>
        <router-view @refresh="refresh" />
      </div>
    </div>
  </div>
</template>
