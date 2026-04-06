<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { getSongMv, getVideoDetail, getVideoPrivilege, getVideoUrl } from '@/api/video';
import { formatDate, formatDuration, formatPlayCount } from '@/utils/format';
import { useToastStore } from '@/stores/toast';
import type { VideoMeta, VideoSource } from '@/models/video';
import Image from '@/components/ui/Image.vue';
import { extractVideoUrl, mapVideoMeta, mapVideoSourcesFromPrivilege, mergeVideoSources } from '@/utils/mappers/video';
import { usePlayerStore } from '@/stores/player';

const route = useRoute();
const toastStore = useToastStore();
const playerStore = usePlayerStore();

const videoRef = ref<HTMLVideoElement | null>(null);
const loading = ref(false);
const sourceLoading = ref(false);
const meta = ref<VideoMeta | null>(null);
const currentSourceHash = ref('');
const currentVideoUrl = ref('');
const playbackError = ref('');

const routeHash = computed(() => String(route.query.hash ?? route.params.id ?? '').trim());
const routeVideoId = computed(() => String(route.query.videoId ?? route.params.id ?? '').trim());
const routeAlbumAudioId = computed(() => String(route.query.albumAudioId ?? route.query.mixSongId ?? '').trim());

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
const selectedSource = computed(() =>
  sourceList.value.find((item) => item.hash === currentSourceHash.value) ?? sourceList.value[0] ?? null,
);
const authorList = computed(() => meta.value?.authors ?? []);
const stats = computed(() => [
  { label: '播放量', value: formatPlayCount(meta.value?.playCount) },
  { label: '收藏', value: formatPlayCount(meta.value?.collectionCount) },
  { label: '下载', value: formatPlayCount(meta.value?.downloadCount) },
  { label: '时长', value: formatDuration(meta.value?.duration) },
]);
const sourceSummary = computed(() => {
  const source = selectedSource.value;
  if (!source) return '暂无片源';
  const parts = [source.label, source.codec].filter(Boolean);
  if (source.bitrate) parts.push(`${Math.round(source.bitrate / 1000)} kbps`);
  if (source.size) parts.push(`${(source.size / 1024 / 1024).toFixed(1)} MB`);
  return parts.join(' · ');
});
const publishText = computed(() => (meta.value?.publishTime ? formatDate(meta.value.publishTime) : '未知'));

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
    artistName: nextMeta.artistName || current.artistName,
    albumName: nextMeta.albumName || current.albumName,
    authors: nextMeta.authors?.length ? nextMeta.authors : current.authors,
    tags: nextMeta.tags?.length ? nextMeta.tags : current.tags,
    sources: mergeVideoSources(current.sources ?? [], nextMeta.sources ?? []),
    playCount: nextMeta.playCount ?? current.playCount,
    publishTime: nextMeta.publishTime ?? current.publishTime,
    collectionCount: nextMeta.collectionCount ?? current.collectionCount,
    downloadCount: nextMeta.downloadCount ?? current.downloadCount,
    recommend: nextMeta.recommend ?? current.recommend,
  };
};

const syncCurrentSource = () => {
  if (!meta.value) return;
  const sources = meta.value.sources ?? [];
  const target = sources.find((item) => item.hash === currentSourceHash.value) ?? sources[0] ?? null;
  currentSourceHash.value = target?.hash ?? '';
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

const fetchMvMeta = async () => {
  loading.value = true;
  meta.value = buildInitialMeta();
  try {
    const tasks: Promise<unknown>[] = [];
    if (routeAlbumAudioId.value) tasks.push(getSongMv(routeAlbumAudioId.value));
    if (routeVideoId.value && routeVideoId.value !== routeHash.value) tasks.push(getVideoDetail(routeVideoId.value));
    if (routeHash.value) tasks.push(getVideoPrivilege(routeHash.value));

    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const payload = result.value;
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

const formatSourceMeta = (source: VideoSource) => {
  const parts: string[] = [];
  if (source.codec) parts.push(source.codec);
  if (source.width && source.height) parts.push(`${source.width}×${source.height}`);
  if (source.bitrate) parts.push(`${Math.round(source.bitrate / 1000)} kbps`);
  if (source.size) parts.push(`${(source.size / 1024 / 1024).toFixed(1)} MB`);
  return parts.join(' · ');
};

onMounted(async () => {
  meta.value = buildInitialMeta();
  if (playerStore.isPlaying) {
    await playerStore.togglePlay().catch(() => undefined);
  }
  await fetchMvMeta();
});

onBeforeUnmount(() => {
  if (videoRef.value) {
    videoRef.value.pause();
    videoRef.value.src = '';
  }
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
            <div class="mv-author">{{ authorLine }}</div>
            <div class="mv-submeta">发布于 {{ publishText }} · {{ sourceSummary }}</div>
          </div>
        </div>

        <div v-if="authorList.length" class="mv-author-list">
          <div v-for="author in authorList" :key="`${author.id ?? author.name}`" class="mv-author-item">
            <Image :src="author.avatar" :alt="author.name" class="mv-author-avatar" />
            <span>{{ author.name }}</span>
          </div>
        </div>

        <div class="mv-stat-grid">
          <div v-for="item in stats" :key="item.label" class="mv-stat-item">
            <div class="mv-stat-label">{{ item.label }}</div>
            <div class="mv-stat-value">{{ item.value }}</div>
          </div>
        </div>

        <div v-if="tagList.length" class="mv-tags">
          <span v-for="tag in tagList" :key="tag" class="mv-tag">{{ tag }}</span>
        </div>

        <div v-if="meta?.description" class="mv-description">{{ meta.description }}</div>
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
              <div>
                <div class="mv-source-title">{{ source.label }}</div>
                <div class="mv-source-meta">{{ formatSourceMeta(source) || '默认片源' }}</div>
              </div>
              <div class="mv-source-status">{{ source.hash === currentSourceHash ? '当前播放' : '切换' }}</div>
            </div>
            <div class="mv-source-hash">{{ source.hash }}</div>
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
  margin-top: 6px;
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text-main);
}

.mv-submeta {
  margin-top: 6px;
  font-size: 13px;
  color: var(--color-text-secondary);
}

.mv-author-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.mv-author-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 999px;
  background: var(--bg-info-card);
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-main);
}

.mv-author-avatar {
  width: 26px;
  height: 26px;
  border-radius: 999px;
  object-fit: cover;
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
  transition: border-color 0.18s ease, background 0.18s ease;
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

.mv-source-title {
  font-size: 14px;
  font-weight: 800;
  color: var(--color-text-main);
}

.mv-source-meta,
.mv-source-hash {
  margin-top: 6px;
  font-size: 12px;
  color: var(--color-text-secondary);
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
