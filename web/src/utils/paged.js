// Композиция для постраничных списков, синхронизированных с query-параметром page.
import { ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get, qs } from '../api.js';

export function usePaged(urlFn, { key = 'videos', limit = 24, extraQuery = () => ({}), immediate = true, watchQuery = true } = {}) {
  const route = useRoute();
  const router = useRouter();
  const items = ref([]);
  const total = ref(0);
  const hasMore = ref(undefined);
  const page = ref(Number(route.query.page) || 1);
  const loading = ref(false);
  const error = ref(null);
  const extra = ref({});

  async function load() {
    loading.value = true; error.value = null;
    try {
      const url = typeof urlFn === 'function' ? urlFn() : urlFn;
      const r = await get(url + qs({ page: page.value, limit, ...extraQuery() }));
      items.value = r[key] || [];
      total.value = r.total ?? 0;
      hasMore.value = r.total === undefined ? items.value.length >= limit : undefined;
      extra.value = r;
    } catch (e) { error.value = e; items.value = []; } finally { loading.value = false; }
  }
  function setPage(p) {
    page.value = p;
    router.replace({ query: { ...route.query, page: p > 1 ? p : undefined } });
    load();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  if (watchQuery) watch(() => route.query, (q, old) => { if (JSON.stringify(q) !== JSON.stringify(old)) { page.value = Number(q.page) || 1; load(); } });
  if (immediate) load();
  return { items, total, hasMore, page, loading, error, extra, load, setPage, limit };
}
