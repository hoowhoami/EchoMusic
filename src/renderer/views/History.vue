<script setup lang="ts">
defineOptions({ name: 'history' });
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { usePlaylistStore } from '@/stores/playlist';
import type { Song } from '@/models/song';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { useThemeStore } from '@/stores/theme';
import { getAccentGradientPair } from '@/utils/color';
import { useHistoryStore, type LocalHistoryEntry } from '@/stores/historyStore';
import { registerSongContextMenuExtension } from '@/components/music/songContextMenuExtensions';
import SliverHeader from '@/components/music/DetailPageSliverHeader.vue';
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import SongList from '@/components/music/SongList.vue';
import SongListHeader from '@/components/music/SongListHeader.vue';
import BatchActionDrawer from '@/components/music/BatchActionDrawer.vue';
import type { SortField, SortOrder } from '@/components/music/SongListHeader.vue';
import {
  iconClock,
  iconCurrentLocation,
  iconList,
  iconMusic,
  iconPlay,
  iconPulse,
  iconSearch,
  iconShare,
  iconStar,
  iconTrash,
} from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';
import Button from '@/components/ui/Button.vue';
import Badge from '@/components/ui/Badge.vue';
import Dialog from '@/components/ui/Dialog.vue';
import { useToastStore } from '@/stores/toast';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';
import { filterSongsByQuery, sortSongs } from '@/utils/songList';
import { getCurrentSharerName } from '@/utils/share';
import Tabs from '@/components/ui/Tabs.vue';
import TabsList from '@/components/ui/TabsList.vue';
import TabsTrigger from '@/components/ui/TabsTrigger.vue';
import TabsContent from '@/components/ui/TabsContent.vue';
import { useStickyTabsLayout } from '@/composables/useStickyTabsLayout';

const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const settingStore = useSettingStore();
const toastStore = useToastStore();
const themeStore = useThemeStore();
const historyStore = useHistoryStore();
const route = useRoute();

/** 动画状态：切歌置顶时触发列表滚动效果 */
const animatingList = ref(false);
let animTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => historyStore.playRecordVersion,
  () => {
    if (animTimer !== null) clearTimeout(animTimer);
    animatingList.value = false;
    // 在下一帧启动动画，确保 CSS class 被移除后重新应用
    requestAnimationFrame(() => {
      animatingList.value = true;
      animTimer = setTimeout(() => {
        animatingList.value = false;
        animTimer = null;
      }, 300);
    });
  },
);

const searchQuery = ref('');
const showBatchDrawer = ref(false);
const showClearDialog = ref(false);
const clearCountdown = ref(0);
let clearCountdownTimer: ReturnType<typeof setInterval> | null = null;

watch(showClearDialog, (open) => {
  if (open) {
    clearCountdown.value = 5;
    clearCountdownTimer = setInterval(() => {
      clearCountdown.value--;
      if (clearCountdown.value <= 0) {
        if (clearCountdownTimer) clearInterval(clearCountdownTimer);
        clearCountdownTimer = null;
      }
    }, 1000);
  } else {
    if (clearCountdownTimer) {
      clearInterval(clearCountdownTimer);
      clearCountdownTimer = null;
    }
    clearCountdown.value = 0;
  }
});

const confirmClear = () => {
  if (clearCountdown.value > 0) return;
  historyStore.clear();
  showClearDialog.value = false;
  toastStore.success('播放历史已清空');
};

const songListRef = ref<{ scrollToActive?: () => void } | null>(null);
const sliverHeaderRef = ref<{ currentHeight?: number } | null>(null);
const { tabsTop, tabsMinHeight } = useStickyTabsLayout(sliverHeaderRef);
const sortField = ref<SortField | null>(null);
const sortOrder = ref<SortOrder>(null);
const activeTab = ref<'songs' | 'stats'>('songs');
const historyStatsRef = ref<HTMLElement | null>(null);
const sharingStats = ref(false);

const handleTabChange = (value: string | number) => {
  const next = String(value);
  if (next === 'songs' || next === 'stats') activeTab.value = next;
};

const mapLocalEntryToSong = (entry: LocalHistoryEntry): Song => ({
  ...entry.song,
  lastPlayedAt: entry.lastPlayedAt,
  playCount: entry.playCount,
  historyKey: entry.historyKey,
});

// 只展示本地历史
const songs = computed(() => historyStore.entries.map(mapLocalEntryToSong));

const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
const TIME_BUCKETS = [
  { label: '凌晨', hint: '00:00-05:59', start: 0, end: 5 },
  { label: '上午', hint: '06:00-11:59', start: 6, end: 11 },
  { label: '下午', hint: '12:00-17:59', start: 12, end: 17 },
  { label: '夜晚', hint: '18:00-23:59', start: 18, end: 23 },
] as const;

const safePlayCount = (entry: LocalHistoryEntry) => Math.max(1, Number(entry.playCount) || 0);

const normalizeDurationSeconds = (duration: number | undefined) => {
  if (!duration || duration <= 0) return 0;
  return duration > 24 * 60 * 60 ? Math.floor(duration / 1000) : duration;
};

const formatCompactNumber = (value: number) => new Intl.NumberFormat('zh-CN').format(value);

const formatListenDuration = (seconds: number) => {
  if (seconds <= 0) return '0 分钟';
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = seconds / 3600;
  if (hours < 100) return `${hours >= 10 ? hours.toFixed(0) : hours.toFixed(1)} 小时`;
  const days = hours / 24;
  return `${days >= 10 ? days.toFixed(0) : days.toFixed(1)} 天`;
};

const formatHistoryDate = (timestamp: number | undefined) => {
  if (!timestamp) return '未知';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '未知';
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes(),
  ).padStart(2, '0')}`;
};

const formatShareTimestamp = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
};

const startOfDay = (timestamp: number) => {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const getArtistNames = (song: Song) => {
  const structured = [...(song.artists ?? []), ...(song.singers ?? [])]
    .map((artist) => artist.name?.trim())
    .filter(Boolean);
  if (structured.length > 0) return Array.from(new Set(structured));
  return (song.artist || '未知歌手')
    .split(/\s*(?:,|，|、|\/|&| feat\.?| ft\.?)\s*/i)
    .map((name) => name.trim())
    .filter(Boolean);
};

const historyStats = computed(() => {
  const entries = historyStore.entries;
  const totalSongs = entries.length;
  const totalPlays = entries.reduce((sum, entry) => sum + safePlayCount(entry), 0);
  const totalSeconds = entries.reduce(
    (sum, entry) => sum + normalizeDurationSeconds(entry.song.duration) * safePlayCount(entry),
    0,
  );
  const replayedSongs = entries.filter((entry) => safePlayCount(entry) > 1).length;
  const latestPlayedAt = entries.reduce((latest, entry) => Math.max(latest, entry.lastPlayedAt), 0);
  const oldestPlayedAt = entries.reduce(
    (oldest, entry) => (oldest === 0 ? entry.lastPlayedAt : Math.min(oldest, entry.lastPlayedAt)),
    0,
  );
  const activeDayKeys = new Set(
    entries
      .map((entry) => startOfDay(entry.lastPlayedAt))
      .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0),
  );
  const spanDays =
    latestPlayedAt > 0 && oldestPlayedAt > 0
      ? Math.max(
          1,
          Math.floor((startOfDay(latestPlayedAt) - startOfDay(oldestPlayedAt)) / DAY_MS) + 1,
        )
      : 0;

  const todayStart = startOfDay(Date.now());
  const recentDays = Array.from({ length: 7 }, (_, index) => {
    const dayStart = todayStart - (6 - index) * DAY_MS;
    const dayEnd = dayStart + DAY_MS;
    const date = new Date(dayStart);
    const value = entries.filter(
      (entry) => entry.lastPlayedAt >= dayStart && entry.lastPlayedAt < dayEnd,
    ).length;
    return {
      key: dayStart,
      label: index === 6 ? '今天' : `周${WEEKDAY_LABELS[date.getDay()]}`,
      dateLabel: `${date.getMonth() + 1}/${date.getDate()}`,
      value,
      ratio: 0,
    };
  });
  const maxRecentDayValue = Math.max(1, ...recentDays.map((item) => item.value));
  const normalizedRecentDays = recentDays.map((item) => ({
    ...item,
    ratio: item.value / maxRecentDayValue,
  }));

  const timeBuckets = TIME_BUCKETS.map((bucket) => ({ ...bucket, value: 0, ratio: 0 }));
  entries.forEach((entry) => {
    const date = new Date(entry.lastPlayedAt);
    if (Number.isNaN(date.getTime())) return;
    const hour = date.getHours();
    const bucket = timeBuckets.find((item) => hour >= item.start && hour <= item.end);
    if (bucket) bucket.value++;
  });
  const maxTimeBucketValue = Math.max(1, ...timeBuckets.map((item) => item.value));
  const normalizedTimeBuckets = timeBuckets.map((item) => ({
    ...item,
    ratio: item.value / maxTimeBucketValue,
  }));

  const artistMap = new Map<string, { name: string; plays: number; songs: number }>();
  const albumMap = new Map<string, { name: string; plays: number; songs: number }>();
  entries.forEach((entry) => {
    const playCount = safePlayCount(entry);
    getArtistNames(entry.song).forEach((name) => {
      const current = artistMap.get(name) ?? { name, plays: 0, songs: 0 };
      current.plays += playCount;
      current.songs += 1;
      artistMap.set(name, current);
    });

    const albumName = (entry.song.albumName || entry.song.album || '未知专辑').trim();
    const album = albumMap.get(albumName) ?? { name: albumName, plays: 0, songs: 0 };
    album.plays += playCount;
    album.songs += 1;
    albumMap.set(albumName, album);
  });

  const topArtists = Array.from(artistMap.values())
    .sort((a, b) => b.plays - a.plays || b.songs - a.songs || a.name.localeCompare(b.name))
    .slice(0, 6);
  const topAlbum = Array.from(albumMap.values()).sort(
    (a, b) => b.plays - a.plays || b.songs - a.songs || a.name.localeCompare(b.name),
  )[0];
  const topSongs = [...entries]
    .sort((a, b) => safePlayCount(b) - safePlayCount(a) || b.lastPlayedAt - a.lastPlayedAt)
    .slice(0, 6)
    .map((entry) => ({
      key: entry.historyKey,
      title: entry.song.name || '未知歌曲',
      artist: entry.song.artist || '未知歌手',
      coverUrl: entry.song.coverUrl || entry.song.cover || '',
      plays: safePlayCount(entry),
      lastPlayedLabel: formatHistoryDate(entry.lastPlayedAt),
    }));

  const statCards = [
    {
      label: '累计播放',
      value: formatCompactNumber(totalPlays),
      caption: `${formatCompactNumber(totalSongs)} 首本地历史`,
      icon: iconPlay,
      tone: 'primary',
    },
    {
      label: '估算时长',
      value: formatListenDuration(totalSeconds),
      caption: '按歌曲时长与次数估算',
      icon: iconClock,
      tone: 'cyan',
    },
    {
      label: '活跃天数',
      value: `${activeDayKeys.size} 天`,
      caption: spanDays > 0 ? `覆盖最近 ${spanDays} 天` : '暂无日期记录',
      icon: iconPulse,
      tone: 'emerald',
    },
    {
      label: '复听占比',
      value: totalSongs > 0 ? `${Math.round((replayedSongs / totalSongs) * 100)}%` : '0%',
      caption: `${formatCompactNumber(replayedSongs)} 首听过多次`,
      icon: iconStar,
      tone: 'amber',
    },
  ];

  return {
    totalSongs,
    totalPlays,
    latestPlayedLabel: formatHistoryDate(latestPlayedAt),
    statCards,
    recentDays: normalizedRecentDays,
    timeBuckets: normalizedTimeBuckets,
    topArtists,
    topAlbum,
    topSongs,
  };
});

const songCount = computed(() => songs.value.length);
const displayedCountLabel = computed(() => `${songCount.value}`);

const historyCoverUrl = computed(() => {
  const { from, to } = getAccentGradientPair(themeStore.sourceColor);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${to}" />
          <stop offset="100%" stop-color="${from}" />
        </linearGradient>
      </defs>
      <rect width="400" height="400" rx="60" fill="url(#g)" />
      <g transform="translate(200 200)">
        <circle cx="0" cy="0" r="92" fill="rgba(255,255,255,0.14)" />
        <circle cx="0" cy="0" r="70" fill="none" stroke="#FFFFFF" stroke-width="18" stroke-linecap="round" />
        <line x1="0" y1="0" x2="0" y2="-34" stroke="#FFFFFF" stroke-width="14" stroke-linecap="round" />
        <line x1="0" y1="0" x2="26" y2="16" stroke="#FFFFFF" stroke-width="14" stroke-linecap="round" />
      </g>
    </svg>
  `;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
});

const handleSort = (field: SortField) => {
  if (sortField.value === field) {
    if (sortOrder.value === 'asc') {
      sortOrder.value = 'desc';
    } else if (sortOrder.value === 'desc') {
      sortField.value = null;
      sortOrder.value = null;
    }
  } else {
    sortField.value = field;
    sortOrder.value = 'asc';
  }
};

const sortedSongs = computed(() => {
  return sortSongs(songs.value, sortField.value, sortOrder.value, {
    indexSource: songs.value,
  });
});
const displayedSongs = computed(() => filterSongsByQuery(sortedSongs.value, searchQuery.value));

const handleSongDoubleTapPlay = async (song: Song) => {
  const queueSongs = displayedSongs.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, queueSongs, 0, song, {
    queueId: 'queue:history',
    title: '播放历史',
    subtitle: '最近播放',
    type: 'history',
    dynamic: false,
  });
};

const handlePlayAll = async () => {
  const queueSongs = displayedSongs.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, queueSongs, 0, undefined, {
    queueId: 'queue:history',
    title: '播放历史',
    subtitle: '最近播放',
    type: 'history',
    dynamic: false,
  });
};

const openBatchDrawer = () => {
  if (songs.value.length === 0) return;
  showBatchDrawer.value = true;
};

const handleBatchRemove = (selected: Song[]) => {
  const keys = selected.map((s) => s.historyKey).filter(Boolean) as string[];
  if (keys.length > 0) {
    historyStore.removeEntries(keys);
  }
  toastStore.actionCompleted(`已从播放历史移除 ${selected.length} 首`);
};

const handleLocate = () => songListRef.value?.scrollToActive?.();

const waitForAnimationFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const waitForPaint = async () => {
  await waitForAnimationFrame();
  await waitForAnimationFrame();
};

const waitForImages = async (root: HTMLElement) => {
  const images = Array.from(root.querySelectorAll('img')).filter((image) => !image.complete);
  if (images.length === 0) return;

  await Promise.race([
    Promise.all(
      images.map(
        (image) =>
          new Promise<void>((resolve) => {
            image.addEventListener('load', () => resolve(), { once: true });
            image.addEventListener('error', () => resolve(), { once: true });
          }),
      ),
    ),
    new Promise<void>((resolve) => window.setTimeout(resolve, 800)),
  ]);
};

const buildHistoryStatsShareText = () => {
  const sharer = getCurrentSharerName();
  const updatedAt = formatShareTimestamp();
  return {
    title: `${sharer} 的听歌统计`,
    updatedAt,
  };
};

const createStatsCaptureStage = (shareText: ReturnType<typeof buildHistoryStatsShareText>) => {
  if (!historyStatsRef.value) return null;

  const stage = document.createElement('div');
  stage.className = 'history-share-capture-stage';
  Object.assign(stage.style, {
    position: 'fixed',
    left: '16px',
    top: '16px',
    zIndex: '2147483647',
    width: `${Math.min(1180, Math.max(760, window.innerWidth - 32))}px`,
    padding: '16px',
    borderRadius: '12px',
    background: 'var(--color-bg-main)',
    boxShadow: '0 24px 60px rgb(0 0 0 / 18%)',
    pointerEvents: 'none',
    transformOrigin: 'top left',
    visibility: 'hidden',
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: '16px',
    marginBottom: '14px',
    padding: '2px 2px 0',
  });

  const title = document.createElement('div');
  title.textContent = shareText.title;
  Object.assign(title.style, {
    minWidth: '0',
    color: 'var(--color-text-main)',
    fontSize: '22px',
    fontWeight: '800',
    lineHeight: '1.2',
  });

  const updatedAt = document.createElement('div');
  updatedAt.textContent = `更新时间：${shareText.updatedAt}`;
  Object.assign(updatedAt.style, {
    flex: '0 0 auto',
    color: 'var(--color-text-secondary)',
    fontSize: '12px',
    fontWeight: '700',
    lineHeight: '1.4',
    opacity: '0.78',
    whiteSpace: 'nowrap',
  });

  header.append(title, updatedAt);
  stage.appendChild(header);

  const clone = historyStatsRef.value.cloneNode(true) as HTMLElement;
  clone.classList.add('is-share-capture');
  stage.appendChild(clone);
  document.body.appendChild(stage);
  return stage;
};

const captureStageToClipboard = async (stage: HTMLElement) => {
  const capture = window.electron?.share?.captureRectToClipboard;
  if (!capture) return false;

  const margin = 16;
  const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth);
  const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight);
  const scale = Math.min(
    1,
    (viewportWidth - margin * 2) / Math.max(1, stage.offsetWidth),
    (viewportHeight - margin * 2) / Math.max(1, stage.offsetHeight),
  );

  stage.style.transform = `scale(${scale})`;
  stage.style.visibility = 'visible';
  await waitForPaint();

  const rect = stage.getBoundingClientRect();
  const padding = 8;
  const x = Math.max(0, Math.floor(rect.left - padding));
  const y = Math.max(0, Math.floor(rect.top - padding));
  const width = Math.max(1, Math.min(viewportWidth - x, Math.ceil(rect.width + padding * 2)));
  const height = Math.max(1, Math.min(viewportHeight - y, Math.ceil(rect.height + padding * 2)));

  return capture({ x, y, width, height });
};

const handleShareStats = async () => {
  if (sharingStats.value) return;
  if (!window.electron?.share?.captureRectToClipboard) {
    toastStore.unavailable('听歌统计');
    return;
  }

  sharingStats.value = true;
  let stage: HTMLElement | null = null;
  try {
    await nextTick();
    const shareText = buildHistoryStatsShareText();
    stage = createStatsCaptureStage(shareText);
    if (!stage) {
      toastStore.actionFailed('复制听歌统计');
      return;
    }

    await waitForImages(stage);
    await waitForPaint();
    const copied = await captureStageToClipboard(stage);
    if (copied) {
      toastStore.actionCompleted('听歌统计已复制');
    } else {
      toastStore.actionFailed('复制听歌统计');
    }
  } catch {
    toastStore.actionFailed('复制听歌统计');
  } finally {
    stage?.remove();
    sharingStats.value = false;
  }
};

const statsSecondaryActions = computed(() => [
  {
    icon: iconShare,
    label: '分享',
    onTap: handleShareStats,
    disabled: sharingStats.value,
  },
]);

let unregisterContextMenu: (() => void) | null = null;

onMounted(() => {
  void historyStore.hydrate();
  unregisterContextMenu = registerSongContextMenuExtension({
    id: 'history-remove-song',
    label: '从播放历史中移除',
    order: 1000,
    danger: true,
    visible: () => route.name === 'history',
    onSelect: (song: Song) => {
      if (song.historyKey) historyStore.removeEntry(song.historyKey);
    },
  });
});

onUnmounted(() => {
  unregisterContextMenu?.();
  if (clearCountdownTimer) clearInterval(clearCountdownTimer);
  if (animTimer) clearTimeout(animTimer);
});
</script>

<template>
  <PageScrollContainer class="history-view-container">
    <div class="history-view bg-bg-main min-h-full">
      <SliverHeader
        ref="sliverHeaderRef"
        typeLabel="HISTORY"
        title="最近播放"
        :coverUrl="historyCoverUrl"
        :hasDetails="true"
        :expandedHeight="176"
        :collapsedHeight="56"
      >
        <template #details>
          <div class="flex flex-col gap-2">
            <div class="text-[13px] font-semibold text-text-secondary">
              记录过往播放轨迹，快速回溯曾听过的歌曲与内容。
            </div>
            <div
              class="flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px] font-semibold text-text-secondary/80"
            >
              <div class="inline-flex items-center gap-1.5">
                <Icon :icon="iconPlay" width="12" height="12" />
                <span>{{ displayedCountLabel }}</span>
              </div>
            </div>
          </div>
        </template>

        <template #actions>
          <ActionRow
            v-if="activeTab === 'songs'"
            :playDisabled="songCount === 0"
            :batchDisabled="songCount === 0"
            @play="handlePlayAll"
            @batch="openBatchDrawer"
          />
          <ActionRow
            v-else
            :showPlaybackActions="false"
            :secondaryActions="statsSecondaryActions"
          />
        </template>

        <template #collapsed-actions>
          <template v-if="activeTab === 'songs'">
            <Button
              variant="unstyled"
              size="none"
              :disabled="songCount === 0"
              @click="handlePlayAll"
              class="p-2 rounded-lg hover:bg-[var(--control-hover-bg)] text-primary"
            >
              <Icon :icon="iconPlay" width="20" height="20" />
            </Button>
            <Button
              variant="unstyled"
              size="none"
              :disabled="songCount === 0"
              @click="openBatchDrawer"
              class="p-2 rounded-lg hover:bg-[var(--control-hover-bg)] text-text-main opacity-60"
            >
              <Icon :icon="iconList" width="18" height="18" />
            </Button>
          </template>
          <Button
            v-else
            variant="unstyled"
            size="none"
            :disabled="sharingStats"
            @click="handleShareStats"
            class="p-2 rounded-lg hover:bg-[var(--control-hover-bg)] text-text-main opacity-70"
            title="分享听歌统计"
            aria-label="分享听歌统计"
          >
            <Icon :icon="iconShare" width="18" height="18" />
          </Button>
        </template>
      </SliverHeader>

      <BatchActionDrawer
        v-model:open="showBatchDrawer"
        :songs="songs"
        source-id="history"
        remove-context="history"
        :on-batch-remove="handleBatchRemove"
      />

      <Tabs
        :model-value="activeTab"
        class="w-full"
        :style="{ minHeight: tabsMinHeight }"
        @update:model-value="handleTabChange"
      >
        <div class="song-list-sticky sticky z-110 bg-bg-main" :style="{ top: `${tabsTop}px` }">
          <div class="px-6">
            <div class="border-b border-[var(--border-subtle)]">
              <div class="flex items-center justify-between h-14">
                <TabsList class="bg-transparent border-none gap-8">
                  <TabsTrigger value="songs">
                    <span class="relative">歌曲 <Badge :count="displayedCountLabel" /></span>
                  </TabsTrigger>
                  <TabsTrigger value="stats">
                    <span class="relative">统计</span>
                  </TabsTrigger>
                </TabsList>

                <div v-if="activeTab === 'songs'" class="flex items-center gap-2">
                  <div class="relative">
                    <input
                      v-model="searchQuery"
                      type="text"
                      placeholder="搜索歌曲..."
                      class="song-search-input w-52 h-9 pl-8 pr-3 rounded-lg text-text-main placeholder:text-text-main/50 outline-none text-[12px] transition-all"
                    />
                    <Icon
                      class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-main/60"
                      :icon="iconSearch"
                      width="14"
                      height="14"
                    />
                  </div>
                  <Button
                    variant="unstyled"
                    size="none"
                    @click="handleLocate"
                    class="song-locate-btn p-2 rounded-lg"
                    title="定位当前播放"
                  >
                    <Icon :icon="iconCurrentLocation" width="16" height="16" />
                  </Button>
                  <Button
                    variant="unstyled"
                    size="none"
                    :disabled="songCount === 0"
                    @click="showClearDialog = true"
                    class="song-locate-btn p-2 rounded-lg text-text-main/40 hover:text-danger transition-colors"
                    title="清空播放历史"
                  >
                    <Icon :icon="iconTrash" width="16" height="16" />
                  </Button>
                </div>
                <div
                  v-else
                  class="hidden sm:flex items-center gap-1.5 text-[12px] font-semibold text-text-secondary/80"
                >
                  <Icon :icon="iconClock" width="14" height="14" />
                  <span>最近 {{ historyStats.latestPlayedLabel }}</span>
                </div>
              </div>
            </div>
          </div>

          <SongListHeader
            v-if="activeTab === 'songs'"
            :sortField="sortField"
            :sortOrder="sortOrder"
            :showCover="true"
            paddingClass="px-6"
            @sort="handleSort"
          />
        </div>

        <div class="pb-12">
          <TabsContent value="songs" class="px-6">
            <div
              v-if="songCount === 0"
              class="history-empty flex flex-col items-center justify-center py-24 text-center"
            >
              <div
                class="w-16 h-16 rounded-[18px] bg-primary/10 text-primary flex items-center justify-center mb-4"
              >
                <Icon :icon="iconClock" width="28" height="28" />
              </div>
              <div class="text-[18px] font-semibold text-text-main">暂无播放历史</div>
              <div class="mt-2 text-[13px] font-medium text-text-secondary/75">
                最近播放的歌曲会展示在这里
              </div>
            </div>
            <div
              v-else-if="displayedSongs.length === 0"
              class="history-empty flex flex-col items-center justify-center py-24 text-center"
            >
              <div
                class="w-16 h-16 rounded-[18px] bg-primary/10 text-primary flex items-center justify-center mb-4"
              >
                <Icon :icon="iconSearch" width="28" height="28" />
              </div>
              <div class="text-[18px] font-semibold text-text-main">未找到相关歌曲</div>
              <div class="mt-2 text-[13px] font-medium text-text-secondary/75">换个关键词试试</div>
            </div>
            <div
              v-else
              class="history-song-list-wrapper"
              :class="{ 'is-scrolling-in': animatingList }"
            >
              <SongList
                ref="songListRef"
                :songs="displayedSongs"
                :contextSongs="sortedSongs"
                :promotedKey="historyStore.promotedKey"
                :removingKeys="historyStore.removingKeys"
                itemKeyField="historyKey"
                :searchQuery="searchQuery"
                :disableInternalFilter="true"
                :activeId="activeSongId"
                :showCover="true"
                :queueOptions="{
                  queueId: 'queue:history',
                  title: '播放历史',
                  subtitle: '最近播放记录',
                  type: 'history',
                  dynamic: false,
                }"
                :enableDefaultDoubleTapPlay="true"
                :onSongDoubleTapPlay="
                  settingStore.replacePlaylist ? handleSongDoubleTapPlay : undefined
                "
              />
            </div>
          </TabsContent>

          <TabsContent value="stats" class="px-6 pt-5">
            <div ref="historyStatsRef" class="history-stats">
              <div class="history-stat-grid">
                <div
                  v-for="card in historyStats.statCards"
                  :key="card.label"
                  class="history-stat-card"
                >
                  <div class="history-stat-card-icon" :data-tone="card.tone">
                    <Icon :icon="card.icon" width="18" height="18" />
                  </div>
                  <div class="min-w-0">
                    <div class="history-stat-label">{{ card.label }}</div>
                    <div class="history-stat-value">{{ card.value }}</div>
                    <div class="history-stat-caption">{{ card.caption }}</div>
                  </div>
                </div>
              </div>

              <div class="history-stats-layout">
                <section class="history-panel history-week-panel">
                  <div class="history-panel-header">
                    <div>
                      <div class="history-panel-title">最近 7 天</div>
                      <div class="history-panel-subtitle">按最后播放日期统计歌曲回访</div>
                    </div>
                  </div>
                  <div class="history-week-chart">
                    <div
                      v-for="day in historyStats.recentDays"
                      :key="day.key"
                      class="history-week-item"
                    >
                      <div class="history-week-value">{{ day.value }}</div>
                      <div class="history-week-track">
                        <div
                          class="history-week-bar"
                          :style="{
                            height: day.value > 0 ? `${Math.max(12, day.ratio * 100)}%` : '4px',
                          }"
                        ></div>
                      </div>
                      <div class="history-week-label">{{ day.label }}</div>
                      <div class="history-week-date">{{ day.dateLabel }}</div>
                    </div>
                  </div>
                </section>

                <section class="history-panel">
                  <div class="history-panel-header">
                    <div>
                      <div class="history-panel-title">时段偏好</div>
                      <div class="history-panel-subtitle">按最后播放时间归类</div>
                    </div>
                  </div>
                  <div class="history-time-list">
                    <div
                      v-for="bucket in historyStats.timeBuckets"
                      :key="bucket.label"
                      class="history-time-row"
                    >
                      <div class="history-time-row-head">
                        <span>{{ bucket.label }}</span>
                        <span>{{ bucket.value }} 首</span>
                      </div>
                      <div class="history-time-track">
                        <div
                          class="history-time-bar"
                          :style="{
                            width: bucket.value > 0 ? `${Math.max(8, bucket.ratio * 100)}%` : '0%',
                          }"
                        ></div>
                      </div>
                      <div class="history-time-hint">{{ bucket.hint }}</div>
                    </div>
                  </div>
                </section>
              </div>

              <div class="history-stats-layout is-rankings">
                <section class="history-panel">
                  <div class="history-panel-header">
                    <div>
                      <div class="history-panel-title">常听歌手</div>
                      <div class="history-panel-subtitle">按本地累计播放次数排序</div>
                    </div>
                    <Icon class="text-primary/75" :icon="iconMusic" width="18" height="18" />
                  </div>
                  <div class="history-rank-list">
                    <div
                      v-for="(artist, index) in historyStats.topArtists"
                      :key="artist.name"
                      class="history-rank-row"
                    >
                      <div class="history-rank-index">{{ index + 1 }}</div>
                      <div class="history-rank-main">
                        <div class="history-rank-name">{{ artist.name }}</div>
                        <div class="history-rank-meta">{{ artist.songs }} 首歌曲</div>
                        <div class="history-rank-track">
                          <div
                            class="history-rank-bar"
                            :style="{
                              width: `${Math.max(
                                10,
                                (artist.plays /
                                  Math.max(1, historyStats.topArtists[0]?.plays ?? 1)) *
                                  100,
                              )}%`,
                            }"
                          ></div>
                        </div>
                      </div>
                      <div class="history-rank-count">{{ artist.plays }} 次</div>
                    </div>
                  </div>
                </section>

                <section class="history-panel">
                  <div class="history-panel-header">
                    <div>
                      <div class="history-panel-title">高频歌曲</div>
                      <div class="history-panel-subtitle">越常复听越靠前</div>
                    </div>
                    <Icon class="text-amber-500/85" :icon="iconStar" width="18" height="18" />
                  </div>
                  <div class="history-song-rank-list">
                    <div
                      v-for="(song, index) in historyStats.topSongs"
                      :key="song.key"
                      class="history-song-rank-row"
                    >
                      <div class="history-song-rank-index">{{ index + 1 }}</div>
                      <div class="history-song-cover">
                        <img v-if="song.coverUrl" :src="song.coverUrl" alt="" />
                        <Icon v-else :icon="iconMusic" width="18" height="18" />
                      </div>
                      <div class="history-song-rank-main">
                        <div class="history-song-rank-title">{{ song.title }}</div>
                        <div class="history-song-rank-meta">
                          {{ song.artist }} · {{ song.lastPlayedLabel }}
                        </div>
                      </div>
                      <div class="history-song-rank-count">{{ song.plays }} 次</div>
                    </div>
                  </div>
                </section>
              </div>

              <section v-if="historyStats.topAlbum" class="history-album-highlight">
                <div class="history-album-icon">
                  <Icon :icon="iconMusic" width="18" height="18" />
                </div>
                <div class="min-w-0">
                  <div class="history-album-label">最常回访专辑</div>
                  <div class="history-album-title">{{ historyStats.topAlbum.name }}</div>
                </div>
                <div class="history-album-count">
                  {{ historyStats.topAlbum.plays }} 次 · {{ historyStats.topAlbum.songs }} 首
                </div>
              </section>
            </div>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  </PageScrollContainer>

  <Dialog
    v-model:open="showClearDialog"
    title="清空播放历史"
    description="确认清空全部本地播放历史？此操作不可撤销。"
  >
    <template #footer>
      <div class="flex justify-end gap-3">
        <Button variant="outline" size="sm" @click="showClearDialog = false"> 取消 </Button>
        <Button variant="primary" size="sm" :disabled="clearCountdown > 0" @click="confirmClear">
          确认清空<span v-if="clearCountdown > 0"> ({{ clearCountdown }}s)</span>
        </Button>
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
@reference "@/style.css";

.history-empty {
  min-height: 320px;
}

/* 切歌置顶滚动动画 */
.history-song-list-wrapper {
  overflow: hidden;
}

.history-song-list-wrapper.is-scrolling-in {
  animation: historyListScrollIn 280ms cubic-bezier(0.33, 0, 0.2, 1);
}

.history-stats {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 1180px;
  padding-bottom: 16px;
}

.history-stats.is-share-capture {
  max-width: none;
  padding-bottom: 0;
}

.history-stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.history-stat-card,
.history-panel,
.history-album-highlight {
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-bg-main) 94%, var(--color-text-main) 6%);
}

.history-stat-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
  min-height: 112px;
  padding: 16px;
}

.history-stat-card-icon {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 8px;
}

.history-stat-card-icon[data-tone='primary'] {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 14%, transparent);
}

.history-stat-card-icon[data-tone='cyan'] {
  color: rgb(8 145 178);
  background: rgb(8 145 178 / 12%);
}

.history-stat-card-icon[data-tone='emerald'] {
  color: rgb(5 150 105);
  background: rgb(5 150 105 / 12%);
}

.history-stat-card-icon[data-tone='amber'] {
  color: rgb(217 119 6);
  background: rgb(217 119 6 / 13%);
}

.history-stat-label,
.history-panel-subtitle,
.history-stat-caption,
.history-week-date,
.history-time-hint,
.history-rank-meta,
.history-song-rank-meta,
.history-album-label {
  color: var(--color-text-secondary);
}

.history-stat-label {
  font-size: 12px;
  font-weight: 700;
}

.history-stat-value {
  margin-top: 4px;
  color: var(--color-text-main);
  font-size: 24px;
  font-weight: 800;
  line-height: 1.15;
  word-break: keep-all;
}

.history-stat-caption {
  margin-top: 6px;
  font-size: 12px;
  font-weight: 600;
  opacity: 0.78;
}

.history-stats-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(260px, 0.9fr);
  gap: 14px;
}

.history-stats-layout.is-rankings {
  grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.08fr);
}

.history-panel {
  min-width: 0;
  padding: 16px;
}

.history-panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.history-panel-title {
  color: var(--color-text-main);
  font-size: 15px;
  font-weight: 800;
  line-height: 1.2;
}

.history-panel-subtitle {
  margin-top: 4px;
  font-size: 12px;
  font-weight: 600;
  opacity: 0.72;
}

.history-week-chart {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 10px;
  align-items: end;
  min-height: 196px;
}

.history-week-item {
  display: grid;
  grid-template-rows: 20px 128px 18px 16px;
  gap: 6px;
  min-width: 0;
  text-align: center;
}

.history-week-value,
.history-week-label,
.history-time-row-head,
.history-rank-count,
.history-song-rank-count,
.history-album-count {
  color: var(--color-text-main);
  font-size: 12px;
  font-weight: 800;
}

.history-week-track {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  min-width: 0;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-text-main) 6%, transparent);
  overflow: hidden;
}

.history-week-bar {
  width: 100%;
  min-height: 4px;
  border-radius: 8px 8px 0 0;
  background: linear-gradient(180deg, var(--color-primary), rgb(8 145 178));
}

.history-week-label {
  line-height: 18px;
}

.history-week-date {
  font-size: 11px;
  font-weight: 700;
  opacity: 0.68;
}

.history-time-list,
.history-rank-list,
.history-song-rank-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.history-time-row {
  min-width: 0;
}

.history-time-row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  line-height: 1.2;
}

.history-time-track,
.history-rank-track {
  height: 7px;
  margin-top: 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-text-main) 7%, transparent);
  overflow: hidden;
}

.history-time-bar,
.history-rank-bar {
  height: 100%;
  border-radius: inherit;
}

.history-time-bar {
  background: linear-gradient(90deg, rgb(5 150 105), var(--color-primary));
}

.history-time-hint {
  margin-top: 5px;
  font-size: 11px;
  font-weight: 700;
  opacity: 0.64;
}

.history-rank-row,
.history-song-rank-row {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 10px;
}

.history-rank-index,
.history-song-rank-index {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  color: var(--color-text-main);
  background: color-mix(in srgb, var(--color-text-main) 8%, transparent);
  font-size: 12px;
  font-weight: 800;
}

.history-rank-main,
.history-song-rank-main {
  flex: 1 1 auto;
  min-width: 0;
}

.history-rank-name,
.history-song-rank-title,
.history-album-title {
  overflow: hidden;
  color: var(--color-text-main);
  font-weight: 800;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-rank-name,
.history-song-rank-title {
  font-size: 13px;
}

.history-rank-meta,
.history-song-rank-meta {
  overflow: hidden;
  margin-top: 3px;
  font-size: 11px;
  font-weight: 700;
  opacity: 0.72;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-rank-track {
  max-width: 210px;
}

.history-rank-bar {
  background: linear-gradient(90deg, var(--color-primary), rgb(217 119 6));
}

.history-rank-count,
.history-song-rank-count,
.history-album-count {
  flex: 0 0 auto;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.history-song-cover {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 7px;
  color: var(--color-text-secondary);
  background: color-mix(in srgb, var(--color-text-main) 7%, transparent);
  overflow: hidden;
}

.history-song-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.history-album-highlight {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 14px 16px;
}

.history-album-icon {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  color: rgb(8 145 178);
  background: rgb(8 145 178 / 12%);
}

.history-album-label {
  font-size: 11px;
  font-weight: 800;
  opacity: 0.74;
}

.history-album-title {
  margin-top: 2px;
  font-size: 13px;
}

@media (max-width: 980px) {
  .history-stat-grid,
  .history-stats-layout,
  .history-stats-layout.is-rankings {
    grid-template-columns: 1fr;
  }

  .history-stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .history-stat-grid {
    grid-template-columns: 1fr;
  }

  .history-week-chart {
    gap: 6px;
  }

  .history-song-rank-count,
  .history-rank-count,
  .history-album-count {
    font-size: 11px;
  }
}

@keyframes historyListScrollIn {
  from {
    transform: translateY(-52px);
    opacity: 0.92;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}
</style>
