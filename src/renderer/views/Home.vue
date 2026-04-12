<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useUserStore } from '@/stores/user';
import { useSettingStore } from '@/stores/setting';
import { getPlaylistByCategory, getTopIP } from '@/api/playlist';
import PlaylistCard from '@/components/music/PlaylistCard.vue';
import { mapPlaylistMeta } from '@/utils/mappers';
import { extractList } from '@/utils/extractors';
import type { PlaylistMeta } from '@/models/playlist';
import { iconPlay, iconSparkles } from '@/icons';
import Button from '@/components/ui/Button.vue';
import UserAgreementDialog from '@/components/app/UserAgreementDialog.vue';

interface RecommendSectionState {
  loading: boolean;
  error: string;
}

const router = useRouter();
const userStore = useUserStore();
const settingStore = useSettingStore();
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

const recommendState = ref<RecommendSectionState>({ loading: true, error: '' });
const topIpState = ref<RecommendSectionState>({ loading: true, error: '' });

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
</style>
