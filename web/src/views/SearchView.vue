<script setup>
import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { usePaged } from '../utils/paged.js';
import VideoGrid from '../components/VideoGrid.vue';
import Pagination from '../components/Pagination.vue';
import ChannelAvatar from '../components/ChannelAvatar.vue';
import PlaylistCard from '../components/PlaylistCard.vue';
import LiveCard from '../components/LiveCard.vue';
import EmptyState from '../components/EmptyState.vue';
import { fmtSubs, fmtNumber } from '../utils/format.js';

const route = useRoute();
const router = useRouter();
const showFilters = ref(false);
const q = computed(() => String(route.query.q || ''));
const type = computed(() => String(route.query.type || 'video'));
const f = computed(() => ({ sort: route.query.sort || '', date: route.query.date || '', duration: route.query.duration || '', category: route.query.category || '', subtitles: route.query.subtitles || '', hd: route.query.hd || '' }));
const list = usePaged('/api/search', { key: type.value === 'video' ? 'videos' : type.value === 'channel' ? 'channels' : type.value === 'playlist' ? 'playlists' : 'streams', limit: 20, extraQuery: () => ({ q: q.value, type: type.value, ...f.value }) });
const results = computed(() => list.extra.value || {});
function setQuery(patch) { router.push({ query: { ...route.query, ...patch, page: undefined } }); }
const activeFilters = computed(() => Object.values(f.value).filter(Boolean).length);
watch(type, () => { list.items.value = []; });
const TYPES = [['video', 'Видео'], ['channel', 'Каналы'], ['playlist', 'Плейлисты'], ['live', 'Трансляции']];
</script>

<template>
  <div class="page medium">
    <div class="page-head">
      <div><h1>Поиск</h1><div class="sub" v-if="q">Результаты по запросу «{{ q }}»<span v-if="type === 'video' && results.total !== undefined"> — {{ results.total }}</span></div></div>
      <div class="actions"><button class="btn sm" :class="{ primary: showFilters }" @click="showFilters = !showFilters"><Icon name="filter" :size="16" /> Фильтры<span v-if="activeFilters" class="badge" style="background:#fff;color:var(--brand)">{{ activeFilters }}</span></button></div>
    </div>
    <div class="tabs mb-16">
      <button v-for="[k, l] in TYPES" :key="k" class="tab" :class="{ active: type === k }" @click="setQuery({ type: k })">{{ l }}</button>
    </div>
    <div v-if="showFilters && type === 'video'" class="panel soft mb-24 filters">
      <div class="form-grid">
        <div class="field"><label>Сортировка</label><select class="select" :value="f.sort" @change="setQuery({ sort: $event.target.value })"><option value="">По релевантности</option><option value="date">По дате</option><option value="views">По просмотрам</option><option value="rating">По оценкам</option></select></div>
        <div class="field"><label>Дата загрузки</label><select class="select" :value="f.date" @change="setQuery({ date: $event.target.value })"><option value="">Любая</option><option value="hour">Последний час</option><option value="day">Сегодня</option><option value="week">Неделя</option><option value="month">Месяц</option><option value="year">Год</option></select></div>
        <div class="field"><label>Длительность</label><select class="select" :value="f.duration" @change="setQuery({ duration: $event.target.value })"><option value="">Любая</option><option value="short">До 4 минут</option><option value="medium">4–20 минут</option><option value="long">Более 20 минут</option></select></div>
        <div class="field"><label>Особенности</label><div class="row wrap" style="height: 42px"><label class="check"><input type="checkbox" :checked="f.subtitles === '1'" @change="setQuery({ subtitles: $event.target.checked ? '1' : '' })" /> Субтитры</label><label class="check"><input type="checkbox" :checked="f.hd === '1'" @change="setQuery({ hd: $event.target.checked ? '1' : '' })" /> HD</label></div></div>
      </div>
      <button v-if="activeFilters" class="btn ghost sm mt-8" @click="setQuery({ sort: '', date: '', duration: '', category: '', subtitles: '', hd: '' })"><Icon name="close" :size="16" /> Сбросить фильтры</button>
    </div>

    <div v-if="list.loading.value" class="loading-block"><div class="spin"></div></div>
    <template v-else-if="type === 'video'">
      <VideoGrid :videos="list.items.value" layout="list" empty-icon="search" :empty-title="q ? 'Ничего не найдено' : 'Введите запрос'" :empty-text="q ? 'Попробуйте изменить запрос или снять фильтры. Поиск ведётся по названию, тегам, описанию и расшифровке речи.' : ''" />
      <Pagination :page="list.page.value" :total="list.total.value" :limit="20" @change="list.setPage" />
    </template>
    <template v-else-if="type === 'channel'">
      <EmptyState v-if="!list.items.value.length" icon="accounts" title="Каналы не найдены" />
      <div v-else class="col gap-8">
        <router-link v-for="c in list.items.value" :key="c.id" :to="`/@${c.handle}`" class="channel-row card">
          <ChannelAvatar :user="c" size="xl" />
          <div class="grow"><div class="h3" style="text-transform:none; font-family: var(--font-body); font-size: 18px">{{ c.displayName }}</div><div class="small muted">@{{ c.handle }} • {{ fmtSubs(c.subscriberCount) }} • {{ c.videoCount }} видео</div><p v-if="c.bio" class="small muted clamp-2" style="margin: 6px 0 0">{{ c.bio }}</p></div>
        </router-link>
      </div>
      <Pagination :page="list.page.value" :has-more="list.hasMore.value" @change="list.setPage" />
    </template>
    <template v-else-if="type === 'playlist'">
      <EmptyState v-if="!list.items.value.length" icon="playlist" title="Плейлисты не найдены" />
      <div v-else class="video-grid"><PlaylistCard v-for="p in list.items.value" :key="p.id" :playlist="p" /></div>
      <Pagination :page="list.page.value" :has-more="list.hasMore.value" @change="list.setPage" />
    </template>
    <template v-else>
      <EmptyState v-if="!list.items.value.length" icon="live" title="Трансляции не найдены" />
      <div v-else class="video-grid"><LiveCard v-for="s in list.items.value" :key="s.id" :stream="s" /></div>
    </template>
  </div>
</template>

<style>
.channel-row { display: flex; gap: 20px; align-items: center; color: var(--text); }
.channel-row:hover { border-color: var(--brand-300); }
</style>
