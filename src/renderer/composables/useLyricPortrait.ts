import { ref, computed, watch, type ComputedRef } from 'vue';
import { getAudioImages, type AudioImageAuthor, type AudioImagePortrait } from '@/api/music';

// 写真图片获取、轮播、预解码逻辑

interface PortraitOptions {
  currentTrack: ComputedRef<Record<string, any> | null | undefined>;
  currentTrackLyricHash: ComputedRef<string>;
  settingStore: {
    lyricCarouselEnabled: boolean;
    lyricCarouselInterval: number;
  };
}

const singerPortraitCache = new Map<string, { urls: string[]; expiresAt: number }>();
const singerPortraitPending = new Map<string, Promise<string[]>>();

// 有写真结果时缓存 30 分钟，空结果缓存 5 分钟后重试
const CACHE_TTL_HIT = 30 * 60 * 1000;
const CACHE_TTL_EMPTY = 5 * 60 * 1000;

const normalizeRemoteImageUrl = (url: string | undefined): string => {
  return String(url ?? '')
    .trim()
    .replace(/^http:\/\//, 'https://');
};

// 按优先级 3 > 4 > 2 取图，一旦某个类型有数据就使用该类型的全部图片
const PORTRAIT_TYPE_PRIORITY = ['3', '4', '2'];

const resolvePortraitsFromAuthors = (authors: unknown): string[] => {
  if (!Array.isArray(authors)) return [];
  const portraitSet = new Set<string>();

  for (const type of PORTRAIT_TYPE_PRIORITY) {
    for (const author of authors as AudioImageAuthor[]) {
      const portraits = Array.isArray(author?.imgs?.[type])
        ? (author.imgs?.[type] as AudioImagePortrait[])
        : [];
      for (const portrait of portraits) {
        const url = normalizeRemoteImageUrl(portrait?.sizable_portrait);
        if (url) portraitSet.add(url);
      }
    }
    // 当前优先级类型有数据就直接返回，不再尝试更低优先级
    if (portraitSet.size > 0) return [...portraitSet];
  }

  return [];
};

// 预解码写真，避免切换时浏览器同步解码造成卡顿
const preDecodePortrait = (url: string) => {
  if (!url) return;
  const img = new Image();
  img.src = url;
  img.decode?.().catch(() => {});
};

export function useLyricPortrait(options: PortraitOptions) {
  const { currentTrack, currentTrackLyricHash, settingStore } = options;

  const artistPortraitUrls = ref<string[]>([]);
  const activePortraitIndex = ref(0);
  let artistBackdropRequestId = 0;
  let portraitCarouselTimer: number | null = null;

  const activePortraitUrl = computed(() => {
    return artistPortraitUrls.value[activePortraitIndex.value] || '';
  });

  const hasPortraitGallery = computed(() => artistPortraitUrls.value.length > 0);

  const portraitCounterLabel = computed(() => {
    if (!hasPortraitGallery.value) return '';
    return `${activePortraitIndex.value + 1} / ${artistPortraitUrls.value.length}`;
  });

  const stopPortraitCarousel = () => {
    if (portraitCarouselTimer) {
      window.clearInterval(portraitCarouselTimer);
      portraitCarouselTimer = null;
    }
  };

  const startPortraitCarousel = () => {
    stopPortraitCarousel();
    if (!settingStore.lyricCarouselEnabled) return;
    if (artistPortraitUrls.value.length <= 1) return;
    const ms = Math.max(settingStore.lyricCarouselInterval || 15, 5) * 1000;
    portraitCarouselTimer = window.setInterval(() => {
      const total = artistPortraitUrls.value.length;
      if (total <= 1) {
        stopPortraitCarousel();
        return;
      }
      activePortraitIndex.value = (activePortraitIndex.value + 1) % total;
    }, ms);
  };

  const restartPortraitCarousel = () => {
    if (hasPortraitGallery.value && artistPortraitUrls.value.length > 1) {
      startPortraitCarousel();
    }
  };

  const syncPortraitIndex = (nextIndex = 0) => {
    if (artistPortraitUrls.value.length === 0) {
      activePortraitIndex.value = 0;
      return;
    }
    const max = artistPortraitUrls.value.length - 1;
    activePortraitIndex.value = Math.min(Math.max(nextIndex, 0), max);
  };

  const showPreviousPortrait = () => {
    if (artistPortraitUrls.value.length <= 1) return;
    const total = artistPortraitUrls.value.length;
    activePortraitIndex.value = (activePortraitIndex.value - 1 + total) % total;
    restartPortraitCarousel();
  };

  const showNextPortrait = () => {
    if (artistPortraitUrls.value.length <= 1) return;
    const total = artistPortraitUrls.value.length;
    activePortraitIndex.value = (activePortraitIndex.value + 1) % total;
    restartPortraitCarousel();
  };

  const clearArtistBackdrop = () => {
    artistPortraitUrls.value = [];
    activePortraitIndex.value = 0;
    stopPortraitCarousel();
  };

  const ensureArtistBackdropForCurrentTrack = async () => {
    const requestId = ++artistBackdropRequestId;
    const track = currentTrack.value;
    const lyricHash = currentTrackLyricHash.value;

    if (!track || !lyricHash) {
      clearArtistBackdrop();
      return;
    }

    if (singerPortraitCache.has(lyricHash)) {
      const cached = singerPortraitCache.get(lyricHash)!;
      if (Date.now() < cached.expiresAt) {
        artistPortraitUrls.value = cached.urls;
        syncPortraitIndex();
        restartPortraitCarousel();
        return;
      }
      // 缓存过期，删除后重新请求
      singerPortraitCache.delete(lyricHash);
    }

    // 切歌后若目标写真未命中缓存，立即清掉上一首的写真与计数，
    // 避免用户误以为当前歌曲串用了上一首的写真。
    clearArtistBackdrop();

    try {
      const pendingRequest =
        singerPortraitPending.get(lyricHash) ??
        (async () => {
          try {
            const res = await getAudioImages({
              hash: lyricHash,
              audioId: track.fileId,
              albumAudioId: track.mixSongId,
              filename: track.name ?? track.title,
              count: 5,
            });
            const data = Array.isArray((res as { data?: unknown[] })?.data)
              ? ((res as { data?: unknown[] }).data ?? [])
              : [];
            const matchedGroups = data.filter((group) => Array.isArray(group));
            const portraitSet = new Set<string>();
            for (const group of matchedGroups) {
              for (const portraitUrl of resolvePortraitsFromAuthors(group)) {
                portraitSet.add(portraitUrl);
              }
            }
            const portraitUrls = [...portraitSet].slice(0, 5);
            const ttl = portraitUrls.length > 0 ? CACHE_TTL_HIT : CACHE_TTL_EMPTY;
            singerPortraitCache.set(lyricHash, { urls: portraitUrls, expiresAt: Date.now() + ttl });
            return portraitUrls;
          } finally {
            singerPortraitPending.delete(lyricHash);
          }
        })();

      singerPortraitPending.set(lyricHash, pendingRequest);
      const portraitUrls = (await pendingRequest) ?? [];
      if (requestId !== artistBackdropRequestId) return;
      artistPortraitUrls.value = portraitUrls;
      syncPortraitIndex();
      restartPortraitCarousel();
      // 预解码前两张写真
      portraitUrls.slice(0, 2).forEach(preDecodePortrait);
    } catch {
      // 请求失败不缓存，下次切回来会重新请求
      if (requestId !== artistBackdropRequestId) return;
      clearArtistBackdrop();
    }
  };

  // 写真索引变化时预解码下一张
  watch(activePortraitIndex, (index) => {
    const urls = artistPortraitUrls.value;
    if (urls.length <= 1) return;
    const nextUrl = urls[(index + 1) % urls.length];
    if (nextUrl) preDecodePortrait(nextUrl);
  });

  const dispose = () => {
    artistBackdropRequestId += 1;
    stopPortraitCarousel();
  };

  return {
    artistPortraitUrls,
    activePortraitIndex,
    activePortraitUrl,
    hasPortraitGallery,
    portraitCounterLabel,
    showPreviousPortrait,
    showNextPortrait,
    clearArtistBackdrop,
    ensureArtistBackdropForCurrentTrack,
    startPortraitCarousel,
    stopPortraitCarousel,
    restartPortraitCarousel,
    dispose,
  };
}
