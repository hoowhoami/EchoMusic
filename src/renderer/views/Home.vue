<script setup lang="ts">
defineOptions({ name: 'home' });
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useUserStore } from '@/stores/user';
import { useSettingStore } from '@/stores/setting';
import { getPlaylistByCategory, getTopIP } from '@/api/playlist';
import { getEverydayStyleRecommend } from '@/api/music';
import PlaylistCard from '@/components/music/PlaylistCard.vue';
import SongCard from '@/components/music/SongCard.vue';
import VirtualGrid from '@/components/ui/VirtualGrid.vue';
import { mapPlaylistMeta, mapTopSong } from '@/utils/mappers';
import { extractList } from '@/utils/extractors';
import type { PlaylistMeta } from '@/models/playlist';
import type { Song } from '@/models/song';
import { iconPlay, iconSlidersHorizontal, iconSparkles } from '@/icons';
import Button from '@/components/ui/Button.vue';
import UserAgreementDialog from '@/components/app/UserAgreementDialog.vue';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';
import { usePlaylistStore, type SetPlaybackQueueOptions } from '@/stores/playlist';
import { usePlayerStore } from '@/stores/player';
import { playSongInContext, replaceQueueAndPlay } from '@/utils/playback';
import { isPlayableSong } from '@/utils/song';
import { useToastStore } from '@/stores/toast';
import { isRecord } from '../../shared/object';

interface RecommendSectionState {
  loading: boolean;
  error: string;
}

interface PlaylistCardProps {
  id: string | number;
  name: string;
  coverUrl: string;
  creator?: string;
  songCount?: number;
}

interface StyleRecommendTag {
  id: string;
  name: string;
  default?: boolean;
}

interface StyleRecommendGroup {
  name: string;
  child: StyleRecommendTag[];
}

const RECOMMEND_PLAYLIST_CATEGORIES = [
  { id: '0', label: '推荐' },
  { id: '11292', label: 'Hi-Res' },
] as const;

const router = useRouter();
const userStore = useUserStore();
const settingStore = useSettingStore();
const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const toastStore = useToastStore();
const showUserAgreement = ref(false);

const todayLabel = computed(() => new Date().getDate().toString());

const greeting = computed(() => {
  const hour = new Date().getHours();
  const base =
    hour < 6
      ? '凌晨好'
      : hour < 9
        ? '早上好'
        : hour < 12
          ? '上午好'
          : hour < 14
            ? '中午好'
            : hour < 18
              ? '下午好'
              : '晚上好';
  const nickname = userStore.info?.nickname;
  return userStore.isLoggedIn && nickname ? `Hi, ${nickname} ${base}` : base;
});

const recommendedPlaylists = ref<PlaylistMeta[]>([]);
const topIpPlaylists = ref<PlaylistMeta[]>([]);
const styleSongs = ref<Song[]>([]);
const styleGroups = ref<StyleRecommendGroup[]>([]);
const selectedStyleTagIds = ref<Set<string>>(new Set());
const activeStyleGroupName = ref('');
const activeRecommendCategoryId = ref<(typeof RECOMMEND_PLAYLIST_CATEGORIES)[number]['id']>('0');

const recommendState = ref<RecommendSectionState>({ loading: true, error: '' });
const topIpState = ref<RecommendSectionState>({ loading: true, error: '' });
const styleState = ref<RecommendSectionState>({ loading: true, error: '' });

const extractPlaylistList = (payload: unknown): unknown[] => extractList(payload);
const extractIpList = (payload: unknown): unknown[] => extractList(payload);

let recommendRequestId = 0;

const loadRecommendPlaylists = async () => {
  const requestId = ++recommendRequestId;
  const categoryId = activeRecommendCategoryId.value;
  recommendState.value = { loading: true, error: '' };
  try {
    const res = await getPlaylistByCategory(categoryId, 0, 1);
    if (requestId !== recommendRequestId) return;
    recommendedPlaylists.value = extractPlaylistList(res).map((item) => mapPlaylistMeta(item));
  } catch {
    if (requestId === recommendRequestId) {
      recommendState.value = { loading: false, error: '推荐歌单加载失败' };
    }
    return;
  }
  if (requestId === recommendRequestId) {
    recommendState.value = { loading: false, error: '' };
  }
};

const loadTopIp = async () => {
  topIpState.value = { loading: true, error: '' };
  try {
    const res = await getTopIP();
    topIpPlaylists.value = extractIpList(res)
      .filter((item) => typeof item === 'object' && item !== null)
      .filter((item) => {
        const record = item as Record<string, unknown>;
        const extra = record.extra as Record<string, unknown> | undefined;
        const globalId = extra?.global_collection_id ?? extra?.global_special_id;
        return record.type === 1 && Boolean(globalId);
      })
      .map((item) => mapPlaylistMeta(item));
  } catch {
    topIpState.value = { loading: false, error: '编辑精选加载失败' };
    return;
  }
  topIpState.value = { loading: false, error: '' };
};

const readStyleRecommendData = (payload: unknown) => {
  if (!isRecord(payload)) return undefined;
  if (isRecord(payload.data)) return payload.data;
  return payload;
};

const extractStyleGroups = (payload: unknown): StyleRecommendGroup[] => {
  const data = readStyleRecommendData(payload);
  const rawGroups = Array.isArray(data?.tag_info) ? data.tag_info : [];
  return rawGroups
    .filter((group): group is Record<string, unknown> => isRecord(group))
    .map((group) => {
      const children = Array.isArray(group.child) ? group.child : [];
      return {
        name: typeof group.name === 'string' ? group.name : '',
        child: children
          .filter((tag): tag is Record<string, unknown> => isRecord(tag))
          .map((tag) => ({
            id: typeof tag.id === 'string' ? tag.id : String(tag.id ?? ''),
            name: typeof tag.name === 'string' ? tag.name : '',
            default: Number(tag.default ?? 0) === 1,
          }))
          .filter((tag) => tag.id && tag.name),
      };
    })
    .filter((group) => group.name && group.child.length > 0);
};

let styleRequestId = 0;

const getDefaultStyleTagIds = (groups: StyleRecommendGroup[]) =>
  groups.flatMap((group) => group.child.filter((tag) => tag.default).map((tag) => tag.id));

const syncStyleGroupsFromResponse = (payload: unknown) => {
  const nextGroups = extractStyleGroups(payload);
  if (nextGroups.length === 0) return;

  const hadGroups = styleGroups.value.length > 0;
  styleGroups.value = nextGroups;

  if (!styleGroups.value.some((group) => group.name === activeStyleGroupName.value)) {
    activeStyleGroupName.value = styleGroups.value[0]?.name ?? '';
  }

  if (!hadGroups && selectedStyleTagIds.value.size === 0) {
    const defaultIds = getDefaultStyleTagIds(nextGroups);
    selectedStyleTagIds.value = new Set(defaultIds);
  }
};

const loadStyleRecommend = async (options: { useSelectedTags?: boolean } = {}) => {
  const requestId = ++styleRequestId;
  const tagids = options.useSelectedTags ? Array.from(selectedStyleTagIds.value).join(',') : '';
  styleState.value = { loading: true, error: '' };
  try {
    const res = await getEverydayStyleRecommend({ tagids });
    if (requestId !== styleRequestId) return;
    syncStyleGroupsFromResponse(res);
    styleSongs.value = extractList(res).map((item) => mapTopSong(item));
  } catch {
    if (requestId === styleRequestId) {
      styleSongs.value = [];
      styleState.value = { loading: false, error: '风格推荐加载失败' };
    }
    return;
  }
  if (requestId === styleRequestId) {
    styleState.value = { loading: false, error: '' };
  }
};

const openRecommend = () => {
  router.push({ name: 'recommend-songs' });
};

const openRanking = () => {
  router.push({ name: 'ranking' });
};

const resolvePlaylistRouteId = (entry: PlaylistMeta) =>
  entry.listCreateGid || entry.globalCollectionId || entry.listCreateListid || entry.id;

const getPlaylistCardProps = (entry: PlaylistMeta): PlaylistCardProps => {
  return {
    id: resolvePlaylistRouteId(entry),
    name: entry.name,
    coverUrl: entry.pic,
    creator: entry.nickname,
    songCount: entry.count,
  };
};

const recommendedPlaylistCards = computed(() =>
  recommendedPlaylists.value.map((entry) => getPlaylistCardProps(entry)),
);

const topIpPlaylistCards = computed(() =>
  topIpPlaylists.value.map((entry) => getPlaylistCardProps(entry)),
);

const switchRecommendCategory = (
  categoryId: (typeof RECOMMEND_PLAYLIST_CATEGORIES)[number]['id'],
) => {
  if (activeRecommendCategoryId.value === categoryId) return;
  activeRecommendCategoryId.value = categoryId;
  void loadRecommendPlaylists();
};

const activeStyleGroup = computed(
  () =>
    styleGroups.value.find((group) => group.name === activeStyleGroupName.value) ??
    styleGroups.value[0],
);

const selectedStyleLabels = computed(() => {
  const selected = selectedStyleTagIds.value;
  return styleGroups.value
    .flatMap((group) => group.child)
    .filter((tag) => selected.has(tag.id))
    .map((tag) => tag.name);
});

const styleSummary = computed(() =>
  selectedStyleLabels.value.length > 0 ? selectedStyleLabels.value.join(' / ') : '默认推荐',
);

const styleQueueOptions = computed<SetPlaybackQueueOptions>(() => {
  const tagKey = Array.from(selectedStyleTagIds.value).join('-') || 'default';
  return {
    queueId: `queue:home:style-recommend:${tagKey}`,
    title: '风格推荐',
    subtitle: styleSummary.value,
    coverUrl: styleSongs.value[0]?.coverUrl,
    type: 'style-recommend',
    dynamic: false,
    meta: {
      tagids: Array.from(selectedStyleTagIds.value).join(','),
    },
  };
});

const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);

const toggleStyleTag = (tag: StyleRecommendTag) => {
  const next = new Set(selectedStyleTagIds.value);
  if (next.has(tag.id)) {
    next.delete(tag.id);
  } else {
    next.add(tag.id);
  }
  selectedStyleTagIds.value = next;
  void loadStyleRecommend({ useSelectedTags: true });
};

const clearStyleTags = () => {
  selectedStyleTagIds.value = new Set();
  void loadStyleRecommend({ useSelectedTags: true });
};

const playStyleSongs = async (targetSong?: Song) => {
  const queueSongs = styleSongs.value.slice();
  if (queueSongs.length === 0) return false;
  return replaceQueueAndPlay(
    playlistStore,
    playerStore,
    queueSongs,
    0,
    targetSong,
    styleQueueOptions.value,
  );
};

const handleStyleSongCoverPlay = async (song: Song) => {
  if (!song || !isPlayableSong(song)) {
    toastStore.unavailable('当前歌曲');
    return;
  }

  try {
    const played = await playSongInContext(
      playlistStore,
      playerStore,
      song,
      styleSongs.value,
      0,
      styleQueueOptions.value,
    );
    if (!played) toastStore.unavailable('当前歌曲');
  } catch {
    toastStore.actionFailed('播放');
  }
};

const handleStyleSongDoubleTapPlay = async (song: Song) => {
  await playStyleSongs(song);
};

onMounted(() => {
  showUserAgreement.value = !settingStore.userAgreementAccepted;
  if (userStore.isLoggedIn) {
    void userStore.fetchUserInfoOnce();
  }
  void loadStyleRecommend();
  void loadRecommendPlaylists();
  void loadTopIp();
});

const handleAcceptAgreement = () => {
  settingStore.acceptUserAgreement();
};

const handleRejectAgreement = () => {
  window.electron.ipcRenderer.send('quit-app', null);
};
</script>

<template>
  <PageScrollContainer class="home-view-container">
    <div class="home-view px-10 pt-4 pb-10">
      <div class="home-header">
        <div class="text-[22px] font-semibold tracking-tight text-text-main">{{ greeting }}</div>
        <div class="text-[12px] text-text-secondary/80 mt-1">由此开启好心情 ~</div>
      </div>

      <div class="home-feature-row">
        <Button variant="unstyled" size="none" class="home-feature-card" @click="openRecommend">
          <div class="feature-icon gradient-primary">{{ todayLabel }}</div>
          <div class="feature-meta">
            <div class="feature-title">每日推荐</div>
            <div class="feature-sub">为你量身定制</div>
          </div>
          <div class="feature-action">
            <Icon :icon="iconPlay" width="14" height="14" />
          </div>
        </Button>
        <Button variant="unstyled" size="none" class="home-feature-card" @click="openRanking">
          <div class="feature-icon gradient-secondary">TOP</div>
          <div class="feature-meta">
            <div class="feature-title">排行榜</div>
            <div class="feature-sub">实时热门趋势</div>
          </div>
          <div class="feature-action">
            <Icon :icon="iconSparkles" width="14" height="14" />
          </div>
        </Button>
      </div>

      <section class="home-section style-recommend-section">
        <div class="section-header">
          <div>
            <div class="section-title">风格推荐</div>
          </div>
          <div class="style-section-actions">
            <Button
              variant="unstyled"
              size="none"
              class="style-play-btn"
              :disabled="styleSongs.length === 0"
              @click="playStyleSongs()"
            >
              <Icon :icon="iconPlay" width="14" height="14" />
              <span>播放全部</span>
            </Button>
          </div>
        </div>

        <div class="style-recommend-panel">
          <div class="style-category-row">
            <div class="style-panel-label">
              <Icon :icon="iconSlidersHorizontal" width="14" height="14" />
              <span>{{ styleSummary }}</span>
            </div>
            <div class="style-category-tabs">
              <Button
                v-for="group in styleGroups"
                :key="group.name"
                variant="unstyled"
                size="none"
                class="style-category-btn"
                :class="{ active: activeStyleGroupName === group.name }"
                @click="activeStyleGroupName = group.name"
              >
                {{ group.name }}
              </Button>
            </div>
          </div>

          <div class="style-tag-row">
            <Button
              variant="unstyled"
              size="none"
              class="style-tag-clear"
              :class="{ active: selectedStyleTagIds.size === 0 }"
              @click="clearStyleTags"
            >
              默认
            </Button>
            <Button
              v-for="tag in activeStyleGroup?.child ?? []"
              :key="tag.id"
              variant="unstyled"
              size="none"
              class="style-tag-btn"
              :class="{ active: selectedStyleTagIds.has(tag.id) }"
              @click="toggleStyleTag(tag)"
            >
              {{ tag.name }}
            </Button>
          </div>

          <div v-if="styleState.loading" class="style-song-placeholder">加载中...</div>
          <div v-else-if="styleState.error" class="style-song-placeholder">
            {{ styleState.error }}
          </div>
          <div v-else-if="styleSongs.length === 0" class="style-song-placeholder">暂无风格推荐</div>
          <div v-else class="style-song-grid">
            <SongCard
              v-for="song in styleSongs"
              :key="song.id"
              :song="song"
              :active="activeSongId === String(song.id)"
              :queueContext="styleSongs"
              :queueOptions="styleQueueOptions"
              :showAlbum="false"
              :showDuration="false"
              :showMore="false"
              :showCoverPlayButton="true"
              :enableDefaultDoubleTapPlay="true"
              :onDoubleTapPlay="
                settingStore.replacePlaylist ? handleStyleSongDoubleTapPlay : undefined
              "
              :onCoverPlay="handleStyleSongCoverPlay"
            />
          </div>
        </div>
      </section>

      <section class="home-section">
        <div class="section-header">
          <div class="section-title">推荐歌单</div>
          <div class="playlist-source-tabs">
            <Button
              v-for="category in RECOMMEND_PLAYLIST_CATEGORIES"
              :key="category.id"
              variant="unstyled"
              size="none"
              class="playlist-source-btn"
              :class="{ active: activeRecommendCategoryId === category.id }"
              @click="switchRecommendCategory(category.id)"
            >
              {{ category.label }}
            </Button>
          </div>
        </div>
        <div v-if="recommendState.loading" class="section-placeholder">加载中...</div>
        <div v-else-if="recommendState.error" class="section-placeholder">
          {{ recommendState.error }}
        </div>
        <VirtualGrid
          v-else
          class="playlist-grid"
          :items="recommendedPlaylistCards"
          :itemMinWidth="180"
          :itemAspectRatio="1"
          :itemChromeHeight="66"
          :gap="20"
          :overscan="3"
          keyField="id"
        >
          <template #default="{ item }">
            <PlaylistCard v-bind="item" layout="grid" />
          </template>
        </VirtualGrid>
      </section>

      <section class="home-section">
        <div class="section-header">
          <div class="section-title">编辑精选</div>
        </div>
        <div v-if="topIpState.loading" class="section-placeholder">加载中...</div>
        <div v-else-if="topIpState.error" class="section-placeholder">{{ topIpState.error }}</div>
        <VirtualGrid
          v-else
          class="playlist-grid"
          :items="topIpPlaylistCards"
          :itemMinWidth="180"
          :itemAspectRatio="1"
          :itemChromeHeight="66"
          :gap="20"
          :overscan="3"
          keyField="id"
        >
          <template #default="{ item }">
            <PlaylistCard v-bind="item" layout="grid" />
          </template>
        </VirtualGrid>
      </section>
    </div>

    <UserAgreementDialog
      v-model:open="showUserAgreement"
      @accept="handleAcceptAgreement"
      @reject="handleRejectAgreement"
    />
  </PageScrollContainer>
</template>

<style scoped>
@reference "@/style.css";

.home-header {
  margin-bottom: 28px;
}

.home-feature-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 32px;
}

.home-feature-card {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 72px;
  padding: 0 18px;
  border-radius: 16px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-subtle);
  transition: all 0.2s ease;
}

.home-feature-card:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-card);
}

.feature-icon {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-weight: 700;
  font-size: 14px;
  box-shadow: 0 6px 14px rgba(0, 0, 0, 0.12);
}

.gradient-primary {
  background: linear-gradient(
    135deg,
    var(--color-primary),
    color-mix(in srgb, var(--color-primary) 70%, transparent)
  );
}

.gradient-secondary {
  background: linear-gradient(135deg, var(--color-secondary), rgba(90, 200, 250, 0.7));
}

.feature-meta {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.feature-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-main);
}

.feature-sub {
  font-size: 12px;
  font-weight: 500;
  color: color-mix(in srgb, var(--color-text-main) 60%, transparent);
}

.feature-action {
  width: 30px;
  height: 30px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  color: var(--color-primary);
}

.home-section {
  margin-top: 36px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text-main);
}

.playlist-source-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: 10px;
  background: var(--control-muted-bg);
}

.playlist-source-btn {
  height: 28px;
  padding: 0 12px;
  border-radius: 8px;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 700;
}

.playlist-source-btn:hover {
  color: var(--color-text-main);
  background: var(--control-hover-bg);
}

.playlist-source-btn.active {
  color: var(--color-text-main);
  background: var(--color-bg-elevated);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
}

.section-placeholder {
  height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: color-mix(in srgb, var(--color-text-main) 60%, transparent);
}

.style-recommend-section {
  margin-top: 30px;
}

.style-section-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.style-play-btn {
  height: 34px;
  padding: 0 12px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  font-size: 12px;
  font-weight: 700;
}

.style-play-btn:hover {
  background: color-mix(in srgb, var(--color-primary) 15%, transparent);
}

.style-recommend-panel {
  border: 1px solid var(--border-subtle);
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface-card-base) 86%, transparent);
  padding: 14px;
}

.style-category-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.style-panel-label {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 600;
}

.style-panel-label span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.style-category-tabs {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: 10px;
  background: var(--control-muted-bg);
}

.style-category-btn {
  height: 28px;
  padding: 0 12px;
  border-radius: 8px;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 700;
}

.style-category-btn:hover {
  color: var(--color-text-main);
  background: var(--control-hover-bg);
}

.style-category-btn.active {
  color: var(--color-text-main);
  background: var(--color-bg-elevated);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
}

.style-tag-row {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 2px;
  scrollbar-width: none;
}

.style-tag-row::-webkit-scrollbar {
  display: none;
}

.style-tag-btn,
.style-tag-clear {
  height: 32px;
  flex-shrink: 0;
  border-radius: 10px;
  padding: 0 12px;
  border: 1px solid transparent;
  font-size: 12px;
  font-weight: 700;
}

.style-tag-btn {
  color: var(--color-text-secondary);
  border-color: var(--control-border);
  background: var(--control-bg);
}

.style-tag-btn:hover {
  color: var(--color-text-main);
  border-color: var(--control-border-hover);
}

.style-tag-btn.active {
  color: var(--color-primary);
  border-color: var(--color-primary);
  background: var(--control-active-bg);
}

.style-tag-clear {
  color: color-mix(in srgb, var(--color-text-main) 45%, transparent);
}

.style-tag-clear:hover {
  color: var(--color-text-main);
  background: var(--control-hover-bg);
}

.style-tag-clear.active {
  color: var(--color-primary);
  border-color: var(--color-primary);
  background: var(--control-active-bg);
}

.style-song-placeholder {
  height: 156px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: color-mix(in srgb, var(--color-text-main) 56%, transparent);
  font-size: 12px;
}

.style-song-grid {
  margin-top: 14px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr));
  gap: 8px 12px;
}

.style-song-grid :deep(.song-card) {
  min-width: 0;
  background: color-mix(in srgb, var(--color-text-main) 3%, transparent);
}

.style-song-grid :deep(.song-card:hover) {
  background: var(--row-hover-bg);
}

@media (max-width: 820px) {
  .style-category-row {
    align-items: flex-start;
    flex-direction: column;
  }

  .style-category-tabs {
    width: 100%;
    overflow-x: auto;
  }
}
</style>
