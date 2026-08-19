import { defineStore } from 'pinia';
import {
  addSingerToBlacklist,
  addSongToBlacklist,
  getBlacklistErrorMessage,
  getBlacklistPage,
  removeBlacklistEntry,
  type BlacklistEntry,
  type BlacklistLabel,
  type BlacklistSingerTarget,
  type BlacklistSongTarget,
} from '@/api/blacklist';
import { useUserStore } from '@/stores/user';
import logger from '@/utils/logger';

export interface ContentBlacklistBucket {
  page: number;
  pageSize: number;
  total: number;
  entries: BlacklistEntry[];
  keys: Set<string>;
  loading: boolean;
  loaded: boolean;
  fullyLoaded: boolean;
  readEpoch: number;
  revision: number;
  error: string;
}

type ContentBlacklistBuckets = Record<BlacklistLabel, ContentBlacklistBucket>;
export type ContentBlacklistStatus = 'unknown' | 'present' | 'absent';

const fetchRequests = new WeakMap<object, Map<string, Promise<boolean>>>();
const fullLoadRequests = new WeakMap<object, Map<string, Promise<boolean>>>();
const mutationRequests = new WeakMap<object, Map<string, Promise<boolean>>>();
const FULL_LOAD_PAGE_SIZE = 500;
const MAX_BLACKLIST_PAGES = 1000;

const createBucket = (): ContentBlacklistBucket => ({
  page: 0,
  pageSize: 30,
  total: 0,
  entries: [],
  keys: new Set<string>(),
  loading: false,
  loaded: false,
  fullyLoaded: false,
  readEpoch: 0,
  revision: 0,
  error: '',
});

const createBuckets = (): ContentBlacklistBuckets => ({
  song: createBucket(),
  singer: createBucket(),
});

const normalizeKey = (label: BlacklistLabel, key: string | number): string => {
  const normalized = String(key ?? '').trim();
  return label === 'song' ? normalized.toLowerCase() : normalized;
};

const currentAccountKey = (): string => {
  const userStore = useUserStore();
  if (!userStore.isLoggedIn) return '';
  return String(userStore.info?.userid ?? userStore.info?.userId ?? '').trim();
};

const isCurrentRequest = (
  store: { accountKey: string; generation: number },
  accountKey: string,
  generation: number,
): boolean =>
  store.accountKey === accountKey &&
  store.generation === generation &&
  currentAccountKey() === accountKey;

const pendingMap = (
  requests: WeakMap<object, Map<string, Promise<boolean>>>,
  store: object,
): Map<string, Promise<boolean>> => {
  let pending = requests.get(store);
  if (!pending) {
    pending = new Map();
    requests.set(store, pending);
  }
  return pending;
};

export const useContentBlacklistStore = defineStore('contentBlacklist', {
  state: () => ({
    buckets: createBuckets(),
    accountKey: '',
    generation: 0,
  }),
  getters: {
    song: (state): ContentBlacklistBucket => state.buckets.song,
    singer: (state): ContentBlacklistBucket => state.buckets.singer,
    hasMore:
      (state) =>
      (label: BlacklistLabel): boolean => {
        const bucket = state.buckets[label];
        return (
          bucket.loaded &&
          !bucket.fullyLoaded &&
          bucket.page < MAX_BLACKLIST_PAGES &&
          bucket.page * bucket.pageSize < bucket.total
        );
      },
    status:
      (state) =>
      (label: BlacklistLabel, key: string | number): ContentBlacklistStatus => {
        if (state.accountKey !== currentAccountKey()) return 'unknown';
        const bucket = state.buckets[label];
        if (bucket.keys.has(normalizeKey(label, key))) return 'present';
        return bucket.fullyLoaded ? 'absent' : 'unknown';
      },
  },
  actions: {
    syncAccount() {
      const nextAccountKey = currentAccountKey();
      if (nextAccountKey === this.accountKey) return;
      this.generation++;
      this.accountKey = nextAccountKey;
      this.buckets = createBuckets();
    },

    async fetchPage(
      label: BlacklistLabel,
      page = 1,
      pageSize?: number,
      readEpoch?: number,
    ): Promise<boolean> {
      this.syncAccount();
      const bucket = this.buckets[label];
      const accountKey = this.accountKey;
      const generation = this.generation;
      if (readEpoch === undefined) {
        const fullLoad = pendingMap(fullLoadRequests, this).get(
          `${generation}:${label}:${bucket.readEpoch}`,
        );
        if (fullLoad) return fullLoad;
      } else if (readEpoch !== bucket.readEpoch) {
        return false;
      }

      const effectivePageSize = pageSize ?? bucket.pageSize;
      const effectiveReadEpoch = readEpoch ?? (page === 1 ? ++bucket.readEpoch : bucket.readEpoch);
      const revision = bucket.revision;
      const requestKey = `${generation}:${label}:${effectiveReadEpoch}:${page}:${effectivePageSize}`;
      const requests = pendingMap(fetchRequests, this);
      const pending = requests.get(requestKey);
      if (pending) return pending;

      bucket.loading = true;
      bucket.error = '';
      const request = (async () => {
        try {
          const result = await getBlacklistPage({ label, page, pageSize: effectivePageSize });
          if (!isCurrentRequest(this, accountKey, generation)) return false;
          const currentBucket = this.buckets[label];
          if (
            currentBucket.readEpoch !== effectiveReadEpoch ||
            currentBucket.revision !== revision
          ) {
            return false;
          }
          const entries = page === 1 ? [] : [...currentBucket.entries];
          const byKey = new Map(entries.map((entry) => [entry.key, entry]));
          for (const entry of result.entries) byKey.set(entry.key, entry);
          currentBucket.entries = Array.from(byKey.values());
          currentBucket.keys = new Set(currentBucket.entries.map((entry) => entry.key));
          currentBucket.page = result.page;
          currentBucket.pageSize = result.pageSize;
          currentBucket.total = result.total;
          currentBucket.loaded = true;
          currentBucket.fullyLoaded = result.page * result.pageSize >= result.total;
          return true;
        } catch (error) {
          const currentBucket = this.buckets[label];
          if (
            isCurrentRequest(this, accountKey, generation) &&
            currentBucket.readEpoch === effectiveReadEpoch &&
            currentBucket.revision === revision
          ) {
            currentBucket.error = getBlacklistErrorMessage(
              error,
              label === 'song' ? '不感兴趣列表加载失败' : '已屏蔽歌手加载失败',
            );
            logger.warn('ContentBlacklist', `Fetch ${label} blacklist failed`, error);
          }
          return false;
        } finally {
          requests.delete(requestKey);
          if (
            isCurrentRequest(this, accountKey, generation) &&
            this.buckets[label].readEpoch === effectiveReadEpoch
          ) {
            this.buckets[label].loading = Array.from(requests.keys()).some((key) =>
              key.startsWith(`${generation}:${label}:${effectiveReadEpoch}:`),
            );
          }
        }
      })();
      requests.set(requestKey, request);
      return request;
    },

    refresh(label: BlacklistLabel): Promise<boolean> {
      return this.fetchPage(label, 1, this.buckets[label].pageSize);
    },

    loadNextPage(label: BlacklistLabel): Promise<boolean> {
      this.syncAccount();
      const bucket = this.buckets[label];
      const fullLoad = pendingMap(fullLoadRequests, this).get(
        `${this.generation}:${label}:${bucket.readEpoch}`,
      );
      if (fullLoad) return fullLoad;
      if (!this.hasMore(label)) return Promise.resolve(true);
      return this.fetchPage(label, bucket.page + 1, bucket.pageSize);
    },

    async ensureFullyLoaded(label: BlacklistLabel): Promise<boolean> {
      this.syncAccount();
      const bucket = this.buckets[label];
      const accountKey = this.accountKey;
      const generation = this.generation;
      const requests = pendingMap(fullLoadRequests, this);
      const pending = requests.get(`${generation}:${label}:${bucket.readEpoch}`);
      if (pending) return pending;
      if (bucket.fullyLoaded) return true;

      const readEpoch = ++bucket.readEpoch;
      const revision = bucket.revision;
      const requestKey = `${generation}:${label}:${readEpoch}`;

      const request = (async () => {
        try {
          if (!(await this.fetchPage(label, 1, FULL_LOAD_PAGE_SIZE, readEpoch))) return false;
          let pagesLoaded = 1;
          while (this.hasMore(label) && pagesLoaded < MAX_BLACKLIST_PAGES) {
            if (!isCurrentRequest(this, accountKey, generation)) return false;
            const currentBucket = this.buckets[label];
            if (currentBucket.readEpoch !== readEpoch || currentBucket.revision !== revision) {
              return false;
            }
            if (
              !(await this.fetchPage(label, currentBucket.page + 1, FULL_LOAD_PAGE_SIZE, readEpoch))
            ) {
              return false;
            }
            pagesLoaded++;
          }

          if (!isCurrentRequest(this, accountKey, generation)) return false;
          const bucket = this.buckets[label];
          if (bucket.readEpoch !== readEpoch || bucket.revision !== revision) return false;
          if (bucket.page * bucket.pageSize < bucket.total) {
            bucket.error =
              label === 'song'
                ? '不感兴趣的歌曲过多，未能完成加载'
                : '已屏蔽的歌手过多，未能完成加载';
            return false;
          }
          bucket.fullyLoaded = true;
          return true;
        } finally {
          requests.delete(requestKey);
        }
      })();
      requests.set(requestKey, request);
      return request;
    },

    addSong(target: BlacklistSongTarget): Promise<boolean> {
      const key = normalizeKey('song', target.hash);
      return this.mutate('song', key, () => addSongToBlacklist(target));
    },

    addSinger(target: BlacklistSingerTarget): Promise<boolean> {
      const key = normalizeKey('singer', target.singerId);
      return this.mutate('singer', key, () => addSingerToBlacklist(target));
    },

    async remove(entry: BlacklistEntry): Promise<boolean> {
      const bucketBeforeMutation = this.buckets[entry.label];
      const needsPageRealignment = bucketBeforeMutation.loaded && !bucketBeforeMutation.fullyLoaded;
      const removed = await this.mutate(entry.label, entry.key, async () => {
        await removeBlacklistEntry(entry);
        return null;
      });
      if (!removed || !needsPageRealignment) return removed;

      // Offset 分页在删除后会整体前移；从第一页重新对齐，避免继续翻页时漏掉一项。
      const bucket = this.buckets[entry.label];
      bucket.page = 0;
      bucket.fullyLoaded = false;
      const readEpoch = ++bucket.readEpoch;
      await this.fetchPage(entry.label, 1, bucket.pageSize, readEpoch);
      return true;
    },

    async mutate(
      label: BlacklistLabel,
      key: string,
      operation: () => Promise<BlacklistEntry | null>,
    ): Promise<boolean> {
      this.syncAccount();
      const normalizedKey = normalizeKey(label, key);
      const accountKey = this.accountKey;
      const generation = this.generation;
      const requestKey = `${generation}:${label}:${normalizedKey}`;
      const requests = pendingMap(mutationRequests, this);
      const pending = requests.get(requestKey);
      if (pending) return pending;

      this.buckets[label].error = '';
      const request = (async () => {
        try {
          const entry = await operation();
          if (!isCurrentRequest(this, accountKey, generation)) return false;
          const bucket = this.buckets[label];
          if (entry) {
            const existed = bucket.keys.has(entry.key);
            bucket.entries = [entry, ...bucket.entries.filter((item) => item.key !== entry.key)];
            bucket.keys = new Set([...bucket.keys, entry.key]);
            if (!existed) bucket.total++;
          } else {
            const existed = bucket.keys.has(normalizedKey);
            bucket.entries = bucket.entries.filter((item) => item.key !== normalizedKey);
            const keys = new Set(bucket.keys);
            keys.delete(normalizedKey);
            bucket.keys = keys;
            if (existed) bucket.total = Math.max(0, bucket.total - 1);
          }
          bucket.revision++;
          return true;
        } catch (error) {
          if (isCurrentRequest(this, accountKey, generation)) {
            this.buckets[label].error = getBlacklistErrorMessage(
              error,
              label === 'song' ? '不感兴趣操作失败' : '屏蔽设置操作失败',
            );
            logger.warn('ContentBlacklist', `Mutate ${label} blacklist failed`, error);
          }
          return false;
        } finally {
          requests.delete(requestKey);
        }
      })();
      requests.set(requestKey, request);
      return request;
    },

    reset() {
      this.generation++;
      this.accountKey = currentAccountKey();
      this.buckets = createBuckets();
      fetchRequests.delete(this);
      fullLoadRequests.delete(this);
      mutationRequests.delete(this);
    },
  },
});
