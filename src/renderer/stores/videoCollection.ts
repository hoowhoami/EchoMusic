import { computed, ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import { getUserVideoCollect } from '@/api/user';
import { setVideoCollected } from '@/api/video';
import { useUserStore } from '@/stores/user';
import { assertVideoCollectionSuccess, normalizeVideoId } from '@/utils/videoCollection';
import { toRecord } from '../../shared/object';

export const useVideoCollectionStore = defineStore('videoCollection', () => {
  const userStore = useUserStore();
  const accountKey = computed(() =>
    userStore.isLoggedIn ? String(userStore.info?.userid ?? userStore.info?.userId ?? '') : '',
  );
  const collectedIds = shallowRef(new Set<string>());
  const pendingIds = shallowRef(new Set<string>());
  const loaded = ref(false);
  const loading = ref(false);
  const revision = ref(0);
  let generation = 0;
  let loadPromise: Promise<void> | null = null;

  watch(
    accountKey,
    () => {
      generation += 1;
      collectedIds.value = new Set();
      pendingIds.value = new Set();
      loaded.value = false;
      loading.value = false;
      loadPromise = null;
    },
    { flush: 'sync' },
  );

  const ensureLoaded = (): Promise<void> => {
    if (!accountKey.value) return Promise.reject(new Error('请先登录'));
    if (loaded.value) return Promise.resolve();
    if (loadPromise) return loadPromise;
    const requestGeneration = generation;
    loading.value = true;
    const task = async () => {
      const ids = new Set<string>();
      const pageSize = 30;
      let count = 0;
      for (let page = 1; ; page += 1) {
        const response = await getUserVideoCollect(page, pageSize);
        if (requestGeneration !== generation) return;
        assertVideoCollectionSuccess(response);
        const data = toRecord(toRecord(response).data);
        if (!Array.isArray(data.info)) throw new Error('收藏视频列表格式异常');
        const previousSize = ids.size;
        for (const item of data.info) {
          const id = normalizeVideoId(toRecord(item).video_id);
          if (id) ids.add(id);
        }
        count += data.info.length;
        const total = Number(data.ctotal);
        if (
          data.info.length === 0 ||
          (Number.isFinite(total) && total >= 0 ? count >= total : data.info.length < pageSize)
        )
          break;
        if (ids.size === previousSize) throw new Error('收藏视频分页未推进');
      }
      collectedIds.value = ids;
      loaded.value = true;
    };
    loadPromise = task().finally(() => {
      if (requestGeneration !== generation) return;
      loading.value = false;
      loadPromise = null;
    });
    return loadPromise;
  };

  const isCollected = (id: string | number) => collectedIds.value.has(normalizeVideoId(id));
  const isPending = (id: string | number) => pendingIds.value.has(normalizeVideoId(id));

  const toggle = async (value: string | number): Promise<boolean | undefined> => {
    const id = normalizeVideoId(value);
    if (!id) throw new Error('无效的 MV ID');
    if (!accountKey.value) throw new Error('请先登录');
    if (isPending(id)) return;
    const requestGeneration = generation;
    pendingIds.value = new Set([...pendingIds.value, id]);
    try {
      await ensureLoaded();
      if (requestGeneration !== generation) return;
      const collected = !isCollected(id);
      await setVideoCollected(id, collected);
      if (requestGeneration !== generation) return;
      const next = new Set(collectedIds.value);
      if (collected) next.add(id);
      else next.delete(id);
      collectedIds.value = next;
      revision.value += 1;
      return collected;
    } finally {
      if (requestGeneration === generation) {
        const next = new Set(pendingIds.value);
        next.delete(id);
        pendingIds.value = next;
      }
    }
  };

  return { loaded, loading, revision, ensureLoaded, isCollected, isPending, toggle };
});
