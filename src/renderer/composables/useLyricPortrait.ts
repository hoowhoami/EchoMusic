import { ref, computed, watch, type ComputedRef } from 'vue';
import { getAudioImages, type AudioImageAuthor, type AudioImagePortrait } from '@/api/music';

// 写真图片获取、轮播、预解码逻辑

interface PortraitOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  currentTrack: ComputedRef<Record<string, any> | null | undefined>;
  currentTrackLyricHash: ComputedRef<string>;
  settingStore: {
    lyricArtistBackdrop: boolean;
    lyricCarouselEnabled: boolean;
    lyricCarouselInterval: number;
  };
}

const singerPortraitCache = new Map<string, string[]>();
const singerPortraitPending = new Map<string, Promise<string[]>>();

const normalizeRemoteImageUrl = (url: string | undefined): string => {
  return String(url ?? '')
    .trim()
    .replace(/^http:\/\//, 'https://');
};

const resolvePortraitsFromAuthors = (authors: unknown): string[] => {
  if (!Array.isArray(authors)) return [];
  const portraitSet = new Set<string>();
  for (const author of authors as AudioImageAuthor[]) {
    const portraits = Array.isArray(author?.imgs?.['3'])
      ? (author.imgs?.['3'] as AudioImagePortrait[])
      : [];
    for (const portrait of portraits) {
      const url = normalizeRemoteImageUrl(portrait?.sizable_portrait);
      if (url) portraitSet.add(url);
    }
  }
  return [...portraitSet];
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

  const hasPortraitGallery = computed(
    () => settingStore.lyricArtistBackdrop && artistPortraitUrls.value.length > 0,
  );

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

    if (!settingStore.lyricArtistBackdrop || !track || !lyricHash) {
      clearArtistBackdrop();
      return;
    }

    if (singerPortraitCache.has(lyricHash)) {
      artistPortraitUrls.value = singerPortraitCache.get(lyricHash) ?? [];
      syncPortraitIndex();
      restartPortraitCarousel();
      return;
    }

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
            singerPortraitCache.set(lyricHash, portraitUrls);
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
      singerPortraitCache.set(lyricHash, []);
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
