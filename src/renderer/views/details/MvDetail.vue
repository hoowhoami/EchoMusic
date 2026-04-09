<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { getSongMv, getVideoDetail, getVideoPrivilege, getVideoUrl } from '@/api/video';
import { formatDate, formatDuration, formatPlayCount } from '@/utils/format';
import { useToastStore } from '@/stores/toast';
import type { VideoMeta, VideoSource } from '@/models/video';
import Image from '@/components/ui/Image.vue';
import {
  extractVideoUrl,
  mapVideoMeta,
  mapVideoMetaList,
  mapVideoSourcesFromPrivilege,
  mergeVideoSources,
} from '@/utils/mappers/video';
import { usePlayerStore } from '@/stores/player';

const route = useRoute();
const toastStore = useToastStore();
const playerStore = usePlayerStore();

const videoRef = ref<HTMLVideoElement | null>(null);
const loading = ref(false);
const sourceLoading = ref(false);
const meta = ref<VideoMeta | null>(null);
const mvVersions = ref<VideoMeta[]>([]);
const currentVersionIndex = ref(0);
const currentSourceHash = ref('');
const currentVideoUrl = ref('');
const playbackError = ref('');

const routeHash = computed(() => String(route.query.hash ?? route.params.id ?? '').trim());
const routeVideoId = computed(() => String(route.query.videoId ?? route.params.id ?? '').trim());
const routeAlbumAudioId = computed(() =>
  String(route.query.albumAudioId ?? route.query.mixSongId ?? '').trim(),
);

const fallbackTitle = computed(() => String(route.query.title ?? 'MV播放'));
const fallbackArtist = computed(() => String(route.query.artist ?? ''));
const fallbackCover = computed(() => String(route.query.cover ?? ''));

const title = computed(() => meta.value?.title || fallbackTitle.value || 'MV播放');
const cover = computed(() => meta.value?.coverUrl || fallbackCover.value || '');
const authorLine = computed(() => {
  const authors = meta.value?.authors?.map((item) => item.name).filter(Boolean) ?? [];
  if (authors.length > 0) return authors.join(' / ');
  return meta.value?.artistName || fallbackArtist.value || '未知歌手';
});
const tagList = computed(() => meta.value?.tags?.map((item) => item.name).filter(Boolean) ?? []);
const sourceList = computed(() => meta.value?.sources ?? []);
const selectedSource = computed(
  () =>
    sourceList.value.find((item) => item.hash === currentSourceHash.value) ??
    sourceList.value[0] ??
    null,
);
const hasPrevVersion = computed(() => currentVersionIndex.value > 0);
const hasNextVersion = computed(() => currentVersionIndex.value < mvVersions.value.length - 1);
const authorList = computed(() => meta.value?.authors ?? []);
const primaryAuthor = computed(() => authorList.value[0] ?? null);
const hasDescription = computed(() => Boolean(meta.value?.description?.trim()));
const editionList = computed(() => {
  const items = [meta.value?.topic, meta.value?.remark]
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
  return [...new Set(items)];
});
const stats = computed(() => [
  { label: '播放量', value: formatPlayCount(meta.value?.playCount) },
  { label: '时长', value: formatDuration(meta.value?.duration) },
  { label: '收藏', value: formatPlayCount(meta.value?.collectionCount) },
  { label: '下载', value: formatPlayCount(meta.value?.downloadCount) },
]);
const publishText = computed(() =>
  meta.value?.publishTime ? formatDate(meta.value.publishTime) : '未知',
);

const buildInitialMeta = (): VideoMeta => ({
  id: routeVideoId.value || routeHash.value,
  hash: routeHash.value,
  title: fallbackTitle.value || 'MV播放',
  coverUrl: fallbackCover.value,
  duration: 0,
  artistName: fallbackArtist.value,
  authors: fallbackArtist.value
    ? fallbackArtist.value
        .split(/[,/，]/)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((name) => ({ name }))
    : [],
  tags: [],
  sources: routeHash.value ? [{ hash: routeHash.value, url: '', label: '默认', codec: '' }] : [],
});

const mergeMeta = (nextMeta: VideoMeta | null) => {
  if (!nextMeta) return;
  const current = meta.value ?? buildInitialMeta();
  meta.value = {
    ...current,
    ...nextMeta,
    title: nextMeta.title || current.title,
    coverUrl: nextMeta.coverUrl || current.coverUrl,
    description: nextMeta.description || current.description,
    remark: nextMeta.remark || current.remark,
    topic: nextMeta.topic || current.topic,
    artistName: nextMeta.artistName || current.artistName,
    albumName: nextMeta.albumName || current.albumName,
    authors: nextMeta.authors?.length ? nextMeta.authors : current.authors,
    tags: nextMeta.tags?.length ? nextMeta.tags : current.tags,
    sources: mergeVideoSources(current.sources ?? [], nextMeta.sources ?? []),
    duration: nextMeta.duration || current.duration,
    playCount: nextMeta.playCount ?? current.playCount,
    publishTime: nextMeta.publishTime ?? current.publishTime,
    collectionCount: nextMeta.collectionCount ?? current.collectionCount,
    downloadCount: nextMeta.downloadCount ?? current.downloadCount,
    hotScore: nextMeta.hotScore ?? current.hotScore,
    recommend: nextMeta.recommend ?? current.recommend,
  };
};

const syncCurrentSource = () => {
  if (!meta.value) return;
  const sources = meta.value.sources ?? [];
  const target =
    sources.find((item) => item.hash === currentSourceHash.value) ?? sources[0] ?? null;
  currentSourceHash.value = target?.hash ?? '';
};

const pauseMusicPlayback = async () => {
  if (!playerStore.isPlaying) return;
  await playerStore.togglePlay().catch(() => undefined);
};

const loadVideoUrl = async (hash: string) => {
  if (!hash) return;
  sourceLoading.value = true;
  playbackError.value = '';
  try {
    const response = await getVideoUrl(hash);
    const url = extractVideoUrl(response, hash);
    if (!url) throw new Error('empty-url');
    currentVideoUrl.value = url;
    await nextTick();
    if (videoRef.value) {
      await pauseMusicPlayback();
      videoRef.value.load();
      await videoRef.value.play().catch(() => undefined);
    }
  } catch {
    currentVideoUrl.value = '';
    playbackError.value = '当前视频暂时无法播放';
    toastStore.loadFailed('MV');
  } finally {
    sourceLoading.value = false;
  }
};

const applySources = (sources: VideoSource[]) => {
  if (!sources.length) return;
  meta.value = {
    ...(meta.value ?? buildInitialMeta()),
    sources: mergeVideoSources(meta.value?.sources ?? [], sources),
  };
  syncCurrentSource();
};

const applyVersion = (nextMeta: VideoMeta) => {
  meta.value = {
    ...buildInitialMeta(),
    ...nextMeta,
    sources: nextMeta.sources ?? [],
  };
  currentSourceHash.value = nextMeta.sources?.[0]?.hash ?? nextMeta.hash ?? '';
  currentVideoUrl.value = '';
  playbackError.value = '';
};

const fetchMvMeta = async () => {
  loading.value = true;
  meta.value = buildInitialMeta();
  mvVersions.value = [];
  currentVersionIndex.value = 0;
  try {
    const tasks: Promise<unknown>[] = [];
    if (routeAlbumAudioId.value) tasks.push(getSongMv(routeAlbumAudioId.value));
    if (routeVideoId.value && routeVideoId.value !== routeHash.value)
      tasks.push(getVideoDetail(routeVideoId.value));
    if (routeHash.value) tasks.push(getVideoPrivilege(routeHash.value));

    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const payload = result.value;
      const versionList = mapVideoMetaList(payload);
      if (versionList.length > 0) {
        mvVersions.value = versionList;
        currentVersionIndex.value = 0;
        applyVersion(versionList[0]);
      }
      mergeMeta(mapVideoMeta(payload, routeHash.value));
      applySources(mapVideoSourcesFromPrivilege(payload));
    }

    syncCurrentSource();
    if (routeHash.value && !currentSourceHash.value) {
      currentSourceHash.value = routeHash.value;
    }
  } finally {
    loading.value = false;
  }
};

const handleVideoError = () => {
  playbackError.value = '视频解码失败，请切换其他片源';
};

const changeSource = (hash: string) => {
  if (!hash || hash === currentSourceHash.value) return;
  currentSourceHash.value = hash;
};

const handleVideoPlay = () => {
  void pauseMusicPlayback();
};

const destroyVideoPlayer = () => {
  const video = videoRef.value;
  if (!video) return;
  video.pause();
  video.removeAttribute('src');
  video.load();
  currentVideoUrl.value = '';
};

const switchVersion = (offset: -1 | 1) => {
  const nextIndex = currentVersionIndex.value + offset;
  if (nextIndex < 0 || nextIndex >= mvVersions.value.length) return;
  const nextMeta = mvVersions.value[nextIndex];
  if (!nextMeta) return;
  currentVersionIndex.value = nextIndex;
  applyVersion(nextMeta);
};

onMounted(async () => {
  meta.value = buildInitialMeta();
  await fetchMvMeta();
});

onBeforeUnmount(() => {
  destroyVideoPlayer();
});

watch(
  () => currentSourceHash.value,
  (hash) => {
    if (!hash) return;
    void loadVideoUrl(hash);
  },
  { immediate: true },
);
</script>

<template>
  <div class="mv-page bg-bg-main min-h-full">
    <div class="mv-player-wrap">
      <div class="mv-player-box">
        <video
          ref="videoRef"
          class="mv-video"
          controls
          preload="metadata"
          playsinline
          :poster="cover"
          @play="handleVideoPlay"
          @error="handleVideoError"
        >
          <source v-if="currentVideoUrl" :src="currentVideoUrl" />
        </video>

        <div v-if="loading || sourceLoading" class="mv-overlay-state">
          <div class="mv-loading-spinner"></div>
          <span>{{ sourceLoading ? '正在切换片源...' : '正在加载 MV ...' }}</span>
        </div>

        <div v-else-if="!currentVideoUrl" class="mv-overlay-state">
          <span>{{ playbackError || '暂无可播放的视频' }}</span>
        </div>
      </div>
    </div>

    <div class="mv-detail-wrap">
      <section class="card-block card-block--hero">
        <div class="mv-main-head">
          <div class="mv-cover-thumb">
            <Image :src="cover" :alt="title" class="mv-cover-img" />
          </div>
          <div class="mv-title-block">
            <div v-if="meta?.recommend" class="mv-recommend">推荐版本</div>
            <h1 class="mv-title">{{ title }}</h1>
            <div class="mv-meta-line">
              <Image
                v-if="primaryAuthor?.avatar"
                :src="primaryAuthor.avatar"
                :alt="authorLine"
                class="mv-inline-author-avatar"
              />
              <span class="mv-author">{{ authorLine }}</span>
              <span class="mv-meta-separator">·</span>
              <span class="mv-submeta">发布于 {{ publishText }}</span>
            </div>
          </div>

          <div v-if="mvVersions.length > 1" class="mv-version-switcher">
            <button
              type="button"
              class="mv-version-button"
              :disabled="!hasPrevVersion"
              @click="switchVersion(-1)"
            >
              上一版
            </button>
            <div class="mv-version-index">
              {{ currentVersionIndex + 1 }} / {{ mvVersions.length }}
            </div>
            <button
              type="button"
              class="mv-version-button"
              :disabled="!hasNextVersion"
              @click="switchVersion(1)"
            >
              下一版
            </button>
          </div>
        </div>

        <div class="mv-stat-grid">
          <div v-for="item in stats" :key="item.label" class="mv-stat-item">
            <div class="mv-stat-label">{{ item.label }}</div>
            <div class="mv-stat-value">{{ item.value }}</div>
          </div>
        </div>

        <div v-if="editionList.length" class="mv-tags mv-tags--edition">
          <span v-for="item in editionList" :key="item" class="mv-tag mv-tag--edition">{{
            item
          }}</span>
        </div>

        <div v-if="tagList.length" class="mv-tags">
          <span v-for="tag in tagList" :key="tag" class="mv-tag">{{ tag }}</span>
        </div>

        <div v-if="hasDescription" class="mv-description">{{ meta?.description }}</div>
      </section>

      <section class="card-block">
        <div class="section-title">视频片源</div>
        <div class="mv-source-list">
          <button
            v-for="source in sourceList"
            :key="source.hash"
            type="button"
            class="mv-source-card"
            :class="{ 'is-active': source.hash === currentSourceHash }"
            @click="changeSource(source.hash)"
          >
            <div class="mv-source-row">
              <div class="mv-source-main">
                <div class="mv-source-copy">
                  <div class="mv-source-title">{{ source.label }}</div>
                  <div class="mv-source-badges">
                    <span v-if="source.codec" class="mv-source-badge">{{ source.codec }}</span>
                    <span v-if="source.width && source.height" class="mv-source-badge"
                      >{{ source.width }}×{{ source.height }}</span
                    >
                    <span v-if="source.bitrate" class="mv-source-badge"
                      >{{ Math.round(source.bitrate / 1000) }} kbps</span
                    >
                    <span v-if="source.size" class="mv-source-badge"
                      >{{ (source.size / 1024 / 1024).toFixed(1) }} MB</span
                    >
                  </div>
                </div>
              </div>
              <div class="mv-source-status">
                {{ source.hash === currentSourceHash ? '当前播放' : '切换' }}
              </div>
            </div>
          </button>

          <div v-if="!sourceList.length && !loading" class="mv-empty-hint">暂无更多片源</div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.mv-player-wrap,
.mv-detail-wrap {
  width: min(1120px, calc(100% - 32px));
  margin: 0 auto;
}

.mv-player-wrap {
  padding-top: 16px;
}

.mv-player-box {
  position: relative;
  overflow: hidden;
  aspect-ratio: 16 / 9;
  border-radius: 18px;
  background: #000;
}

.mv-video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}

.mv-overlay-state {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: rgba(255, 255, 255, 0.84);
  background: rgba(0, 0, 0, 0.36);
  backdrop-filter: blur(6px);
}

.mv-loading-spinner {
  width: 28px;
  height: 28px;
  border: 3px solid rgba(255, 255, 255, 0.18);
  border-top-color: rgba(255, 255, 255, 0.92);
  border-radius: 999px;
  animation: mv-spin 0.9s linear infinite;
}

.mv-detail-wrap {
  padding: 18px 0 28px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.card-block {
  padding: 18px;
  border-radius: 18px;
  background: var(--color-bg-card);
  border: 1px solid color-mix(in srgb, var(--color-border-light) 80%, transparent);
}

.card-block--hero {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.mv-main-head {
  display: flex;
  gap: 14px;
  align-items: center;
}

.mv-cover-thumb {
  width: 96px;
  height: 96px;
  overflow: hidden;
  border-radius: 14px;
  flex-shrink: 0;
}

.mv-cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.mv-title-block {
  min-width: 0;
  flex: 1;
}

.mv-version-switcher {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  align-self: flex-start;
}

.mv-version-button {
  height: 34px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--color-border-light) 80%, transparent);
  background: var(--bg-info-card);
  color: var(--color-text-main);
  font-size: 12px;
  font-weight: 700;
  transition: all 0.18s ease;
}

.mv-version-button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.mv-version-index {
  min-width: 52px;
  text-align: center;
  font-size: 12px;
  font-weight: 700;
  color: var(--color-text-secondary);
}

.mv-recommend {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  color: var(--color-primary);
  font-size: 11px;
  font-weight: 700;
}

.mv-title {
  margin-top: 6px;
  font-size: 24px;
  font-weight: 800;
  color: var(--color-text-main);
  line-height: 1.3;
}

.mv-author {
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text-main);
}

.mv-meta-line {
  margin-top: 8px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.mv-inline-author-avatar {
  width: 24px;
  height: 24px;
  border-radius: 999px;
  flex-shrink: 0;
}

.mv-meta-separator {
  color: var(--color-text-secondary);
  font-size: 13px;
}

.mv-submeta {
  font-size: 13px;
  color: var(--color-text-secondary);
}

.mv-stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.mv-stat-item {
  padding: 14px;
  border-radius: 14px;
  background: var(--bg-info-card);
}

.mv-stat-label {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.mv-stat-value {
  margin-top: 6px;
  font-size: 15px;
  font-weight: 800;
  color: var(--color-text-main);
}

.mv-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.mv-tags--edition {
  margin-top: -2px;
}

.mv-tag {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  color: var(--color-primary);
  font-size: 12px;
  font-weight: 700;
}

.mv-tag--edition {
  background: color-mix(in srgb, var(--color-text-main) 6%, transparent);
  color: var(--color-text-main);
}

.mv-description {
  font-size: 13px;
  line-height: 1.8;
  color: var(--color-text-secondary);
}

.section-title {
  margin-bottom: 14px;
  font-size: 15px;
  font-weight: 800;
  color: var(--color-text-main);
}

.mv-source-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mv-source-card {
  padding: 14px 16px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--color-border-light) 80%, transparent);
  background: var(--bg-info-card);
  text-align: left;
  transition:
    border-color 0.18s ease,
    background 0.18s ease;
}

.mv-source-card.is-active {
  border-color: color-mix(in srgb, var(--color-primary) 60%, transparent);
  background: color-mix(in srgb, var(--color-primary) 7%, var(--bg-info-card));
}

.mv-source-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.mv-source-main {
  min-width: 0;
  flex: 1;
}

.mv-source-copy {
  min-width: 0;
  flex: 1;
}

.mv-source-title {
  font-size: 14px;
  font-weight: 800;
  color: var(--color-text-main);
}

.mv-source-badges {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.mv-source-badge {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  color: var(--color-text-main);
  font-size: 11px;
  font-weight: 700;
}

.mv-source-status {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 700;
  color: var(--color-primary);
}

.mv-empty-hint {
  padding: 8px 2px;
  font-size: 13px;
  color: var(--color-text-secondary);
}

@media (max-width: 768px) {
  .mv-player-wrap,
  .mv-detail-wrap {
    width: calc(100% - 24px);
  }

  .mv-main-head,
  .mv-source-row {
    flex-direction: column;
    align-items: flex-start;
  }

  .mv-version-switcher {
    margin-left: 0;
  }

  .mv-source-main {
    width: 100%;
  }

  .mv-stat-grid {
    grid-template-columns: 1fr 1fr;
  }
}

@keyframes mv-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
