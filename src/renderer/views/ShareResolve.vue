<script setup lang="ts">
defineOptions({ name: 'share-resolve-page' });

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getAlbumDetail } from '@/api/album';
import { getArtistDetail } from '@/api/artist';
import { getSongPrivilegeLite } from '@/api/music';
import { getPlaylistDetail } from '@/api/playlist';
import Button from '@/components/ui/Button.vue';
import { iconArrowLeft, iconHome, iconRefreshCw, iconShare, iconTriangleAlert } from '@/icons';
import { extractFirstObject } from '@/utils/extractors';
import { mapAlbumDetailMeta, mapArtistDetailMeta, mapPlaylistMeta } from '@/utils/mappers';
import { isSongHashId, readShareDetailQuery } from '@/utils/share';
import { logger } from '@/utils/logger';
import { getShareResourceLabel, type ShareResourceType } from '../../shared/share';
import { isRecord } from '../../shared/object';

type ResolveState = 'loading' | 'failed';
type FailureReason = 'invalid' | 'not-found' | 'load-failed';

const route = useRoute();
const router = useRouter();

const state = ref<ResolveState>('loading');
const reason = ref<FailureReason>('load-failed');
const resolving = ref(false);
const showLoadingSpinner = ref(false);
let resolveToken = 0;
let loadingSpinnerTimer: number | null = null;

const clearLoadingSpinnerTimer = () => {
  if (loadingSpinnerTimer === null) return;
  window.clearTimeout(loadingSpinnerTimer);
  loadingSpinnerTimer = null;
};

const scheduleLoadingSpinner = () => {
  clearLoadingSpinnerTimer();
  showLoadingSpinner.value = false;
  loadingSpinnerTimer = window.setTimeout(() => {
    loadingSpinnerTimer = null;
    showLoadingSpinner.value = true;
  }, 220);
};

const stopLoadingSpinner = () => {
  clearLoadingSpinnerTimer();
  showLoadingSpinner.value = false;
};

const readText = (value: unknown) => {
  if (Array.isArray(value)) return String(value[0] ?? '').trim();
  return String(value ?? '').trim();
};

const isShareResourceType = (value: string): value is ShareResourceType =>
  value === 'song' || value === 'playlist' || value === 'artist' || value === 'album';

const targetType = computed(() => {
  const value = readText(route.query.type);
  return isShareResourceType(value) ? value : null;
});
const targetId = computed(() => readText(route.query.id));
const targetTitle = computed(() => readText(route.query.title));
const detailQuery = computed(() => readShareDetailQuery(route.query));
const resourceLabel = computed(() =>
  targetType.value ? getShareResourceLabel(targetType.value) : '内容',
);

const hasFailedStatus = (payload: unknown) =>
  isRecord(payload) && 'status' in payload && Number(payload.status) !== 1;

const getFirstPayloadRecord = (payload: unknown) => {
  if (!isRecord(payload) || hasFailedStatus(payload)) return null;
  const first = extractFirstObject(payload);
  return first && isRecord(first) ? first : null;
};

const readRecord = (record: Record<string, unknown>, key: string) =>
  isRecord(record[key]) ? (record[key] as Record<string, unknown>) : {};

const readArray = (...values: unknown[]) => {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
};

const readFirstText = (...values: unknown[]) => {
  for (const value of values) {
    const text = readText(value);
    if (text) return text;
  }
  return '';
};

const readPositiveId = (...values: unknown[]) => {
  const text = readFirstText(...values);
  if (!text) return '';
  const parsed = Number.parseInt(text, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return '';
  return String(parsed);
};

const normalizeCover = (value: string) => {
  if (!value) return '';
  const resolved = value.replaceAll('{size}', '400');
  return resolved.startsWith('//') ? `https:${resolved}` : resolved;
};

const readArtistsFromPrivilege = (record: Record<string, unknown>) => {
  const audioInfo = readRecord(record, 'audio_info');
  const authors = readArray(record.authors, record.singerinfo, audioInfo.singerinfo);
  const artists = authors
    .map((item) => {
      if (!isRecord(item)) return null;
      const base = readRecord(item, 'base');
      const source = Object.keys(base).length > 0 ? base : item;
      const name = readFirstText(
        source.name,
        source.author_name,
        source.AuthorName,
        source.singername,
        source.singer,
      );
      if (!name) return null;
      const id = readFirstText(
        source.id,
        source.author_id,
        source.AuthorId,
        source.singerid,
        source.singer_id,
      );
      return { name, id };
    })
    .filter((item): item is { name: string; id: string } => Boolean(item));

  if (artists.length > 0) return artists;

  const name = readFirstText(
    record.author_name,
    record.AuthorName,
    record.singername,
    record.singer,
    audioInfo.author_name,
    audioInfo.AuthorName,
    audioInfo.singername,
  );
  if (!name) return [];
  const id = readFirstText(
    record.author_id,
    record.AuthorId,
    record.singerid,
    record.singer_id,
    audioInfo.author_id,
    audioInfo.AuthorId,
    audioInfo.singerid,
    audioInfo.singer_id,
  );
  return [{ name, id }];
};

const getSongPrivilegeRecord = (payload: unknown) => {
  if (!isRecord(payload) || hasFailedStatus(payload)) return null;
  const list = Array.isArray(payload.data) ? payload.data : [];
  const first = list[0];
  return first && isRecord(first) ? first : null;
};

const buildSongDetailQuery = (hash: string, record: Record<string, unknown>) => {
  const base = readRecord(record, 'base');
  const audioInfo = readRecord(record, 'audio_info');
  const albumInfo = readRecord(record, 'album_info');
  const transParam = readRecord(record, 'trans_param');
  const artists = readArtistsFromPrivilege(record);
  const firstArtist = artists[0];
  const query = detailQuery.value;

  const mixSongId = readPositiveId(
    query.mixSongId,
    base.mixsongid,
    base.album_audio_id,
    base.audio_id,
    record.mixsongid,
    record.album_audio_id,
    record.audio_id,
  );
  const title = readFirstText(
    query.title,
    targetTitle.value,
    base.audio_name,
    record.audio_name,
    record.songname,
    record.name,
    record.filename,
  );
  const album = readFirstText(
    query.album,
    albumInfo.album_name,
    albumInfo.albumname,
    record.album_name,
    record.albumname,
  );
  const albumId = readFirstText(
    query.albumId,
    base.album_id,
    base.albumid,
    albumInfo.album_id,
    albumInfo.albumid,
    record.album_id,
    record.albumid,
  );
  const cover = normalizeCover(
    readFirstText(
      query.cover,
      record.pic,
      record.img,
      audioInfo.img,
      albumInfo.sizable_cover,
      albumInfo.cover,
      transParam.union_cover,
    ),
  );

  return {
    ...query,
    mainTab: 'detail',
    type: 'music',
    hash,
    ...(title ? { title } : {}),
    ...(artists.length > 0 ? { artist: artists.map((item) => item.name).join(', ') } : {}),
    ...(firstArtist?.id ? { artistId: firstArtist.id } : {}),
    ...(album ? { album } : {}),
    ...(albumId ? { albumId } : {}),
    ...(cover ? { cover } : {}),
    ...(mixSongId ? { mixSongId } : {}),
  };
};

const resolveSong = async (id: string) => {
  if (!isSongHashId(id)) return false;
  const record = getSongPrivilegeRecord(await getSongPrivilegeLite(id, detailQuery.value.albumId));
  if (!record) return false;
  const query = buildSongDetailQuery(id, record);
  if (!query.mixSongId || !query.title) return false;
  router.replace({
    name: 'song-detail',
    params: { id },
    query,
  });
  return true;
};

const resolvePlaylist = async (id: string) => {
  const raw = getFirstPayloadRecord(await getPlaylistDetail(id));
  if (!raw) return false;
  const meta = mapPlaylistMeta(raw);
  if (!meta.name && !meta.id && !meta.globalCollectionId && !meta.listCreateGid) return false;
  router.replace({ name: 'playlist-detail', params: { id }, query: detailQuery.value });
  return true;
};

const resolveArtist = async (id: string) => {
  const raw = getFirstPayloadRecord(await getArtistDetail(id));
  if (!raw) return false;
  const meta = mapArtistDetailMeta(raw);
  if (!meta.name && !meta.id) return false;
  router.replace({ name: 'artist-detail', params: { id }, query: detailQuery.value });
  return true;
};

const resolveAlbum = async (id: string) => {
  const raw = getFirstPayloadRecord(await getAlbumDetail(id));
  if (!raw) return false;
  const meta = mapAlbumDetailMeta(raw);
  if (!meta.name && !meta.id) return false;
  router.replace({ name: 'album-detail', params: { id }, query: detailQuery.value });
  return true;
};

const fail = (nextReason: FailureReason) => {
  stopLoadingSpinner();
  reason.value = nextReason;
  state.value = 'failed';
};

const resolveShare = async () => {
  const type = targetType.value;
  const id = targetId.value;
  const forcedReason = readText(route.query.reason);
  const token = ++resolveToken;

  if (forcedReason === 'invalid') {
    fail('invalid');
    return;
  }
  if (!type || !id) {
    fail('invalid');
    return;
  }

  state.value = 'loading';
  resolving.value = true;
  scheduleLoadingSpinner();
  try {
    const ok =
      type === 'song'
        ? await resolveSong(id)
        : type === 'playlist'
          ? await resolvePlaylist(id)
          : type === 'artist'
            ? await resolveArtist(id)
            : await resolveAlbum(id);
    if (token !== resolveToken) return;
    if (!ok) fail('not-found');
  } catch (error) {
    if (token !== resolveToken) return;
    logger.warn('ShareResolve', 'Failed to resolve share target', { type, id, error });
    fail('load-failed');
  } finally {
    if (token === resolveToken) {
      resolving.value = false;
      stopLoadingSpinner();
    }
  }
};

const titleText = computed(() => {
  if (targetTitle.value) return `分享的${resourceLabel.value}「${targetTitle.value}」打不开`;
  return `分享的${resourceLabel.value}打不开`;
});

const reasonText = computed(() => {
  if (reason.value === 'invalid') return '这个分享链接格式不正确，无法识别目标内容。';
  if (reason.value === 'not-found') {
    return `分享的${resourceLabel.value}可能已被删除、权限不可见，或当前数据源没有返回。`;
  }
  return `暂时没能获取到分享的${resourceLabel.value}，可能是网络或数据源异常。`;
});

const handleRetry = () => {
  void resolveShare();
};

const handleGoHome = () => {
  router.replace('/main/home');
};

const handleGoBack = () => {
  if (window.history.length > 1) {
    router.back();
    return;
  }
  handleGoHome();
};

onMounted(() => {
  void resolveShare();
});

onBeforeUnmount(() => {
  stopLoadingSpinner();
});

watch(
  () => route.fullPath,
  () => {
    if (route.name === 'share-resolve') void resolveShare();
  },
);
</script>

<template>
  <div class="share-resolve-page">
    <section class="share-resolve-shell">
      <div class="share-resolve-kicker">
        <Icon :icon="iconShare" width="15" height="15" />
        分享链接
      </div>

      <template v-if="state === 'loading'">
        <div class="share-resolve-loading">
          <div v-if="showLoadingSpinner" class="share-resolve-spinner"></div>
          <div v-else class="share-resolve-spinner-placeholder"></div>
          <div>
            <h1>正在打开分享的{{ resourceLabel }}</h1>
            <p>正在确认分享内容是否可用。</p>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="share-resolve-main">
          <div class="share-resolve-icon">
            <Icon :icon="iconTriangleAlert" width="30" height="30" />
          </div>

          <div class="share-resolve-copy">
            <h1>{{ titleText }}</h1>
            <p>{{ reasonText }}</p>
          </div>
        </div>

        <div class="share-resolve-meta">
          <div class="share-resolve-meta-item">
            <span>类型</span>
            <strong>{{ resourceLabel }}</strong>
          </div>
          <div v-if="targetId" class="share-resolve-meta-item">
            <span>ID</span>
            <strong>{{ targetId }}</strong>
          </div>
        </div>

        <div class="share-resolve-actions">
          <Button
            variant="primary"
            size="sm"
            class="share-resolve-action"
            :disabled="resolving"
            @click="handleRetry"
          >
            <Icon :icon="iconRefreshCw" width="15" height="15" />
            重新打开
          </Button>
          <Button variant="secondary" size="sm" class="share-resolve-action" @click="handleGoHome">
            <Icon :icon="iconHome" width="15" height="15" />
            回到首页
          </Button>
          <Button variant="secondary" size="sm" class="share-resolve-action" @click="handleGoBack">
            <Icon :icon="iconArrowLeft" width="15" height="15" />
            返回上页
          </Button>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.share-resolve-page {
  min-height: calc(100vh - 140px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 24px 72px;
  background: var(--color-bg-main);
}

.share-resolve-shell {
  width: min(680px, 100%);
  padding: 28px;
  border: 1px solid var(--border-subtle);
  border-radius: 18px;
  background: var(--color-bg-elevated);
  box-shadow: var(--shadow-elevated);
}

.share-resolve-kicker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 10px;
  border-radius: 8px;
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  font-size: 12px;
  font-weight: 700;
}

.share-resolve-loading,
.share-resolve-main {
  display: flex;
  gap: 20px;
  align-items: flex-start;
  margin-top: 20px;
}

.share-resolve-spinner {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 3px solid color-mix(in srgb, var(--color-primary) 18%, transparent);
  border-top-color: var(--color-primary);
  animation: share-resolve-spin 0.85s linear infinite;
  margin: 4px 10px 0 10px;
}

.share-resolve-spinner-placeholder {
  flex: 0 0 auto;
  width: 44px;
  height: 32px;
}

.share-resolve-icon {
  flex: 0 0 auto;
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 16px;
  color: var(--state-warning);
  background: color-mix(in srgb, var(--state-warning) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--state-warning) 24%, transparent);
}

.share-resolve-copy,
.share-resolve-loading > div {
  min-width: 0;
  flex: 1;
}

.share-resolve-copy h1,
.share-resolve-loading h1 {
  margin: 0;
  color: var(--color-text-main);
  font-size: 26px;
  line-height: 1.2;
  font-weight: 800;
}

.share-resolve-copy p,
.share-resolve-loading p {
  margin: 10px 0 0;
  color: var(--color-text-secondary);
  font-size: 14px;
  line-height: 1.7;
}

.share-resolve-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 24px;
}

.share-resolve-meta-item {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border-radius: 10px;
  background: var(--control-muted-bg);
}

.share-resolve-meta-item span {
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 700;
}

.share-resolve-meta-item strong {
  min-width: 0;
  color: var(--color-text-main);
  font-size: 13px;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.share-resolve-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 24px;
}

.share-resolve-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

@keyframes share-resolve-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 640px) {
  .share-resolve-page {
    align-items: flex-start;
    padding: 24px 16px 56px;
  }

  .share-resolve-shell {
    padding: 22px;
    border-radius: 14px;
  }

  .share-resolve-loading,
  .share-resolve-main {
    flex-direction: column;
  }

  .share-resolve-copy h1,
  .share-resolve-loading h1 {
    font-size: 22px;
  }

  .share-resolve-meta {
    grid-template-columns: 1fr;
  }

  .share-resolve-actions {
    flex-direction: column;
  }

  .share-resolve-action {
    width: 100%;
    justify-content: center;
  }
}
</style>
