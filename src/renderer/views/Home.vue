<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useUserStore } from '@/stores/user';
import { useSettingStore } from '@/stores/setting';
import { PERSONAL_FM_QUEUE_ID, usePlaylistStore } from '@/stores/playlist';
import { usePlayerStore } from '@/stores/player';
import { getPlaylistByCategory, getTopIP } from '@/api/playlist';
import PlaylistCard from '@/components/music/PlaylistCard.vue';
import { mapPlaylistMeta } from '@/utils/mappers';
import { extractList } from '@/utils/extractors';
import type { PlaylistMeta } from '@/models/playlist';
import { iconHeartFilled, iconPlay, iconSparkles } from '@/icons';
import Button from '@/components/ui/Button.vue';
import UserAgreementDialog from '@/components/app/UserAgreementDialog.vue';
import { replaceQueueAndPlay } from '@/utils/playback';
import Cover from '@/components/ui/Cover.vue';

interface RecommendSectionState {
  loading: boolean;
  error: string;
}

const router = useRouter();
const userStore = useUserStore();
const settingStore = useSettingStore();
const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const showUserAgreement = ref(false);
const personalFmLoading = ref(false);

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

const recommendState = ref<RecommendSectionState>({ loading: true, error: '' });
const topIpState = ref<RecommendSectionState>({ loading: true, error: '' });
const personalFmQueue = computed(
  () => playlistStore.playbackQueues.find((queue) => queue.id === PERSONAL_FM_QUEUE_ID) ?? null,
);
const personalFmCurrentTrack = computed(() => playlistStore.getPersonalFmPreviewTrack());
const isPersonalFmActive = computed(() => playlistStore.activeQueueId === PERSONAL_FM_QUEUE_ID);
const personalFmDisplayTracks = computed(() => playlistStore.getPersonalFmDisplayTracks(5));

const extractPlaylistList = (payload: unknown): unknown[] => extractList(payload);

const extractIpList = (payload: unknown): unknown[] => extractList(payload);

const loadRecommendPlaylists = async () => {
  recommendState.value = { loading: true, error: '' };
  try {
    const res = await getPlaylistByCategory('0', 0, 1);
    const list = extractPlaylistList(res).map((item) => mapPlaylistMeta(item));
    recommendedPlaylists.value = list;
  } catch {
    recommendState.value = { loading: false, error: '推荐歌单加载失败' };
    return;
  }
  recommendState.value = { loading: false, error: '' };
};

const loadTopIp = async () => {
  topIpState.value = { loading: true, error: '' };
  try {
    const res = await getTopIP();
    const list = extractIpList(res)
      .filter((item) => typeof item === 'object' && item !== null)
      .filter((item) => {
        const record = item as Record<string, unknown>;
        const extra = record.extra as Record<string, unknown> | undefined;
        const globalId = extra?.global_collection_id ?? extra?.global_special_id;
        return record.type === 1 && Boolean(globalId);
      })
      .map((item) => mapPlaylistMeta(item));
    topIpPlaylists.value = list;
  } catch {
    topIpState.value = { loading: false, error: '编辑精选加载失败' };
    return;
  }
  topIpState.value = { loading: false, error: '' };
};

const openRecommend = () => {
  router.push({ name: 'recommend-songs' });
};

const openRanking = () => {
  router.push({ name: 'ranking' });
};

const handlePlayPersonalFm = async () => {
  if (personalFmLoading.value) return;
  personalFmLoading.value = true;
  try {
    const ready = await playlistStore.startPersonalFm({ fresh: true });
    if (!ready) return;
    const targetSong = await playlistStore.consumeNextPersonalFmTrack({
      playtime: 0,
      isOverplay: false,
    });
    const queue = playlistStore.playbackQueues.find((item) => item.id === PERSONAL_FM_QUEUE_ID);
    if (!targetSong || !queue) return;
    await replaceQueueAndPlay(playlistStore, playerStore, queue.songs, 0, targetSong, {
      queueId: PERSONAL_FM_QUEUE_ID,
      title: '红心 Radio',
      subtitle: '猜你喜欢',
      type: 'fm',
      dynamic: true,
      meta: {
        mode: 'normal',
        song_pool_id: 0,
      },
    });
    void playlistStore.ensurePersonalFmQueue({ track: targetSong, playtime: 0, isOverplay: false });
  } finally {
    personalFmLoading.value = false;
  }
};

const resolvePlaylistRouteId = (entry: PlaylistMeta) =>
  entry.listCreateGid || entry.globalCollectionId || entry.listCreateListid || entry.id;

onMounted(() => {
  showUserAgreement.value = !settingStore.userAgreementAccepted;
  if (userStore.isLoggedIn) {
    void userStore.fetchUserInfoOnce();
  }
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
  <div class="home-view px-10 pt-6 pb-10">
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

    <section class="home-section">
      <div class="section-header">
        <div class="section-title">红心 Radio</div>
      </div>
      <div class="radio-hero">
        <div class="radio-card">
          <div class="radio-chip">
            <Icon :icon="iconHeartFilled" width="14" height="14" />
            <span>猜你喜欢</span>
          </div>
          <div class="radio-title">红心 Radio</div>
          <div class="radio-subtitle">
            {{
              personalFmCurrentTrack
                ? `${personalFmCurrentTrack.artist} · ${personalFmCurrentTrack.title}`
                : '根据你的口味持续续播'
            }}
          </div>
          <div class="radio-footer">
            <div class="radio-bars" aria-hidden="true">
              <span v-for="index in 10" :key="index"></span>
            </div>
            <Button
              variant="unstyled"
              size="none"
              class="radio-play"
              :disabled="personalFmLoading"
              @click="handlePlayPersonalFm"
            >
              <Icon :icon="iconPlay" width="18" height="18" />
            </Button>
          </div>
        </div>
        <div class="radio-stack" aria-hidden="true">
          <div
            v-for="(track, index) in personalFmDisplayTracks"
            :key="`${track.id}:${track.hash ?? ''}:${index}`"
            class="radio-stack-disc"
            :class="[`radio-stack-disc-${index}`]"
          >
            <Cover :url="track.coverUrl" :size="320" :borderRadius="'50%'" class="w-full h-full" />
          </div>
          <div v-if="personalFmDisplayTracks.length === 0" class="radio-stack-placeholder">
            <div class="radio-stack-disc radio-stack-disc-0"></div>
            <div class="radio-stack-disc radio-stack-disc-1"></div>
            <div class="radio-stack-disc radio-stack-disc-2"></div>
            <div class="radio-stack-disc radio-stack-disc-3"></div>
            <div class="radio-stack-disc radio-stack-disc-4"></div>
          </div>
        </div>
      </div>
    </section>

    <section class="home-section">
      <div class="section-header">
        <div class="section-title">推荐歌单</div>
      </div>
      <div v-if="recommendState.loading" class="section-placeholder">加载中...</div>
      <div v-else-if="recommendState.error" class="section-placeholder">
        {{ recommendState.error }}
      </div>
      <div v-else class="playlist-grid">
        <PlaylistCard
          v-for="entry in recommendedPlaylists"
          :key="String(entry.id)"
          :id="resolvePlaylistRouteId(entry)"
          :name="entry.name"
          :coverUrl="entry.pic"
          :creator="entry.nickname"
          :songCount="entry.count"
          layout="grid"
        />
      </div>
    </section>

    <section class="home-section">
      <div class="section-header">
        <div class="section-title">编辑精选</div>
      </div>
      <div v-if="topIpState.loading" class="section-placeholder">加载中...</div>
      <div v-else-if="topIpState.error" class="section-placeholder">{{ topIpState.error }}</div>
      <div v-else class="playlist-grid">
        <PlaylistCard
          v-for="entry in topIpPlaylists"
          :key="`ip-${String(entry.id)}`"
          :id="resolvePlaylistRouteId(entry)"
          :name="entry.name"
          :coverUrl="entry.pic"
          :creator="entry.nickname"
          :songCount="entry.count"
          layout="grid"
        />
      </div>
    </section>
  </div>

  <UserAgreementDialog
    v-model:open="showUserAgreement"
    @accept="handleAcceptAgreement"
    @reject="handleRejectAgreement"
  />
</template>

<style scoped>
@reference "@/style.css";

.home-view {
  animation: fade-in 0.6s ease-out;
}

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
  background: color-mix(in srgb, var(--color-text-main) 2%, transparent);
  border: 1px solid var(--color-border-light);
  transition: all 0.2s ease;
}

.dark .home-feature-card {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.12);
}

.home-feature-card:hover {
  transform: translateY(-1px);
  box-shadow: 0 8px 18px rgba(0, 0, 0, 0.08);
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
  background: linear-gradient(135deg, var(--color-primary), rgba(0, 113, 227, 0.7));
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

.section-placeholder {
  height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: color-mix(in srgb, var(--color-text-main) 60%, transparent);
}

.playlist-grid {
  display: grid;
  gap: 20px;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
}

.radio-hero {
  position: relative;
  display: grid;
  grid-template-columns: 292px minmax(0, 1fr);
  gap: 22px;
  width: 100%;
  min-height: 214px;
  padding: 18px 20px;
  border-radius: 24px;
  overflow: hidden;
  background:
    radial-gradient(circle at 16% 18%, rgba(112, 213, 255, 0.2), transparent 30%),
    linear-gradient(135deg, #0b3b53 0%, #105f82 40%, #091822 100%);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

.radio-card {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  min-height: 176px;
  width: 100%;
  aspect-ratio: 1 / 1;
  padding: 20px;
  border-radius: 22px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.08));
  backdrop-filter: blur(16px);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
}

.radio-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.88);
  font-size: 11px;
  font-weight: 700;
}

.radio-title {
  margin-top: 16px;
  color: #fff;
  font-size: 34px;
  line-height: 1;
  font-weight: 800;
  letter-spacing: -0.04em;
}

.radio-subtitle {
  margin-top: 10px;
  color: rgba(255, 255, 255, 0.8);
  font-size: 15px;
  font-weight: 500;
}

.radio-footer {
  margin-top: 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.radio-bars {
  display: flex;
  align-items: end;
  gap: 6px;
  flex: 1;
}

.radio-bars span {
  width: 3px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.4);
}

.radio-bars span:nth-child(1) {
  height: 11px;
}
.radio-bars span:nth-child(2) {
  height: 17px;
}
.radio-bars span:nth-child(3) {
  height: 8px;
}
.radio-bars span:nth-child(4) {
  height: 19px;
}
.radio-bars span:nth-child(5) {
  height: 13px;
}
.radio-bars span:nth-child(6) {
  height: 18px;
}
.radio-bars span:nth-child(7) {
  height: 9px;
}
.radio-bars span:nth-child(8) {
  height: 14px;
}
.radio-bars span:nth-child(9) {
  height: 8px;
}
.radio-bars span:nth-child(10) {
  height: 15px;
}

.radio-play {
  width: 52px;
  height: 52px;
  flex-shrink: 0;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #0d8fff, #2fb4ff);
  color: #fff;
  box-shadow: 0 14px 30px rgba(2, 118, 198, 0.35);
}

.radio-stack {
  position: relative;
  min-height: 196px;
}

.radio-stack-disc {
  position: absolute;
  top: 50%;
  width: 184px;
  height: 184px;
  border-radius: 999px;
  overflow: hidden;
  transform: translateY(-50%);
  border: 8px solid rgba(6, 15, 28, 0.38);
  box-shadow: 0 26px 40px rgba(5, 12, 20, 0.32);
  background:
    radial-gradient(
      circle at center,
      rgba(0, 0, 0, 0.26) 0 14%,
      rgba(255, 255, 255, 0.05) 15%,
      transparent 16%
    ),
    linear-gradient(135deg, rgba(255, 179, 122, 0.68), rgba(51, 21, 39, 0.96));
}

.radio-stack-disc-0 {
  left: 2%;
}

.radio-stack-disc-1 {
  left: 28%;
}

.radio-stack-disc-2 {
  left: 54%;
}

.radio-stack-disc-3 {
  left: 72%;
  width: 164px;
  height: 164px;
}

.radio-stack-disc-4 {
  left: 86%;
  width: 144px;
  height: 144px;
}

.radio-stack-placeholder {
  position: absolute;
  inset: 0;
}

@keyframes fade-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-width: 768px) {
  .radio-hero {
    grid-template-columns: 1fr;
    min-height: auto;
    padding: 16px;
  }

  .radio-card {
    aspect-ratio: auto;
  }

  .radio-stack {
    min-height: 150px;
  }

  .radio-stack-disc {
    width: 136px;
    height: 136px;
  }

  .radio-stack-disc-0 {
    left: 0;
  }

  .radio-stack-disc-1 {
    left: 24%;
  }

  .radio-stack-disc-2 {
    left: 48%;
  }

  .radio-stack-disc-3 {
    left: 66%;
    width: 116px;
    height: 116px;
  }

  .radio-stack-disc-4 {
    left: 82%;
    width: 104px;
    height: 104px;
  }

  .radio-title {
    font-size: 28px;
  }

  .radio-subtitle {
    font-size: 13px;
  }
}
</style>
