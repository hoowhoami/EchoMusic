<script setup lang="ts">
/**
 * 听歌统计头部概览区。
 * 移植自 EchoMusicNext HistoryStatsOverview.qml：
 * 标题行 + 单曲循环 hero 卡 + 最常听专辑卡（黑胶插画）+ 四张指标卡。
 */
import { computed, ref } from 'vue';
import { useThemeStore } from '@/stores/theme';
import RollingNumber from '@/components/ui/RollingNumber.vue';
import Cover from '@/components/ui/Cover.vue';
import Button from '@/components/ui/Button.vue';
import { iconPlay, iconRepeat } from '@/icons';
import type { HistoryStats } from '../../../../shared/historyStats';
import { useContainerWidth } from './useContainerWidth';
import './statsShared.css';

const props = withDefaults(
  defineProps<{
    stats: HistoryStats;
    interactive?: boolean;
    animate?: boolean;
  }>(),
  { interactive: true, animate: true },
);

const emit = defineEmits<{ play: [id: string] }>();

const themeStore = useThemeStore();
const rootRef = ref<HTMLElement | null>(null);
const heroRef = ref<HTMLElement | null>(null);
const rootWidth = useContainerWidth(rootRef);
const heroWidth = useContainerWidth(heroRef);

/** 双卡并排的最小宽度（对齐 Next narrow: 760） */
const narrow = computed(() => rootWidth.value < 760);
/** 标题与 hero 内部紧凑形态（对齐 Next compact: 470） */
const compact = computed(() => rootWidth.value < 470);

const favorite = computed(() => props.stats.topSongs[0]);
const album = computed(() => props.stats.topAlbum);

const coverSize = computed(() => (compact.value ? 132 : Math.min(160, heroWidth.value * 0.29)));
const favoritePlayable = computed(() => Boolean(favorite.value && favorite.value.id && favorite.value.id !== '0'));

/** 指标卡列数：≥640 四列 / ≥300 两列 / 其余单列（对齐 Next metrics） */
const metricColumns = computed(() => (rootWidth.value >= 640 ? 4 : rootWidth.value >= 300 ? 2 : 1));

const enterStyle = (order: number) =>
  props.animate ? { animationDelay: `${Math.min(order * 32, 96)}ms` } : undefined;

const totalPlaysText = computed(() => `${props.stats.totalPlaysLabel || '0'} 次播放`);
const albumCountText = computed(
  () => `${album.value.songs || 0} 首歌，${album.value.plays || 0} 次回访`,
);
const replayCountText = computed(() => `已经重逢 ${favorite.value?.plays || 0} 次`);

/** 黑胶唱片插画底色（对齐 Next 专辑卡的暖调混合与唱片配色） */
const albumCardBackground = computed(() => {
  const ratio = themeStore.isDark ? '9%' : '10%';
  return `color-mix(in srgb, var(--control-muted-bg) ${100 - parseInt(ratio, 10)}%, #c69b69 ${ratio})`;
});
const vinylColor = computed(() => (themeStore.isDark ? '#202126' : '#30313a'));

const metricText = (card: { value: string; unit: string }) =>
  card.unit ? `${card.value} ${card.unit}` : card.value;
</script>

<template>
  <div ref="rootRef" class="stats-overview">
    <div class="overview-head" :class="{ 'stats-enter': animate }" :style="enterStyle(0)">
      <div class="head-left">
        <div class="head-eyebrow">LISTENING JOURNAL</div>
        <h2 class="head-title">音乐里的你</h2>
      </div>
      <div class="head-right">
        <div class="total-plays" :class="{ 'is-compact': compact }">
          <RollingNumber :value="totalPlaysText" />
        </div>
        <div v-if="!compact && stats.dateRangeLabel" class="date-range">
          {{ stats.dateRangeLabel }}
        </div>
      </div>
    </div>

    <div v-if="stats.totalSongs > 0" class="portrait-grid" :class="{ narrow }">
      <article
        ref="heroRef"
        class="hero-card"
        :class="{ 'stats-enter': animate }"
        :style="enterStyle(0)"
      >
        <div class="hero-eyebrow-row">
          <span class="hero-eyebrow">01 / 你的单曲循环</span>
          <Icon :icon="iconRepeat" width="18" height="18" class="hero-eyebrow-icon" />
        </div>
        <div class="hero-body" :class="{ narrow: compact }">
          <Cover
            class="hero-cover"
            :url="favorite?.cover"
            :size="Math.round(coverSize)"
            :width="Math.round(coverSize)"
            :height="Math.round(coverSize)"
            border-radius="var(--radius-media)"
            :alt="favorite?.title || '未知歌曲'"
          />
          <div class="hero-info">
            <div class="hero-title">{{ favorite?.title || '未知歌曲' }}</div>
            <div class="hero-artist">{{ favorite?.artist || '未知歌手' }}</div>
            <div class="hero-replay">{{ replayCountText }}</div>
            <Button
              v-if="interactive"
              variant="soft-primary"
              size="sm"
              class="hero-play"
              :disabled="!favoritePlayable"
              @click="favorite && emit('play', favorite.id)"
            >
              <Icon :icon="iconPlay" width="14" height="14" />
              再听一次
            </Button>
          </div>
        </div>
        <p class="hero-footnote">有些旋律，一响起就舍不得切走。</p>
      </article>

      <article
        class="album-card"
        :class="{ 'stats-enter': animate }"
        :style="[{ background: albumCardBackground }, enterStyle(1)]"
      >
        <div class="album-label">反复翻开的专辑</div>
        <div class="vinyl-scene">
          <div class="vinyl-disc" :style="{ background: vinylColor }">
            <div class="vinyl-ring" style="width: 98px; height: 98px"></div>
            <div class="vinyl-ring" style="width: 82px; height: 82px"></div>
            <div class="vinyl-ring" style="width: 66px; height: 66px"></div>
            <div class="vinyl-ring" style="width: 50px; height: 50px"></div>
            <div class="vinyl-core"></div>
          </div>
          <Cover
            class="vinyl-cover"
            :url="album?.cover"
            :size="240"
            width="116"
            height="116"
            border-radius="3px"
            :alt="album?.name || '未知专辑'"
          />
        </div>
        <div class="album-name">{{ album?.name || '未知专辑' }}</div>
        <div class="album-count">{{ albumCountText }}</div>
      </article>
    </div>

    <div
      v-if="stats.statCards.length > 0"
      class="metrics-grid"
      :class="{ 'stats-enter': animate }"
      :style="[{ gridTemplateColumns: `repeat(${metricColumns}, minmax(0, 1fr))` }, enterStyle(0)]"
    >
      <div v-for="card in stats.statCards" :key="card.label" class="metric-card">
        <div class="metric-value">
          <RollingNumber :value="metricText(card)" />
        </div>
        <div class="metric-label">{{ card.label }}</div>
      </div>
    </div>

    <div class="overview-divider"></div>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.stats-overview {
  display: flex;
  flex-direction: column;
  gap: 22px;
  min-width: 0;
}

/* ── 标题行 ─────────────────────────────── */
.overview-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
}

.head-left {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.head-eyebrow {
  color: var(--color-primary-text);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 2px;
}

.head-title {
  margin: 0;
  color: var(--color-text-main);
  font-size: 30px;
  font-weight: 700;
  line-height: 1.3;
}

.head-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
  flex: 0 0 auto;
}

.total-plays {
  color: var(--color-text-main);
  font-size: 19px;
  font-weight: 600;
  line-height: 1.5;
}

.total-plays.is-compact {
  font-size: 13px;
}

.date-range {
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 400;
}

/* ── 双卡网格 ───────────────────────────── */
.portrait-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(0, 1fr);
  gap: 18px;
}

.portrait-grid.narrow {
  grid-template-columns: minmax(0, 1fr);
}

.hero-card {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
  padding: 24px;
  border-radius: 12px;
  background: linear-gradient(
    to right,
    color-mix(in srgb, var(--control-muted-bg) 82%, var(--color-primary) 18%),
    color-mix(in srgb, var(--control-muted-bg) 96.5%, var(--color-primary) 3.5%)
  );
}

.hero-eyebrow-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.hero-eyebrow {
  color: var(--color-primary-text);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.hero-eyebrow-icon {
  color: var(--color-primary-text);
}

.hero-body {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 22px;
  align-items: center;
}

.hero-body.narrow {
  grid-template-columns: minmax(0, 1fr);
  gap: 18px;
}

.hero-cover {
  justify-self: start;
}

.hero-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.hero-title {
  color: var(--color-text-main);
  font-size: 24px;
  font-weight: 700;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.hero-artist {
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 500;
}

.hero-replay {
  color: var(--color-primary-text);
  font-size: 12px;
  font-weight: 600;
}

.hero-play {
  align-self: flex-start;
  margin-top: 6px;
}

.hero-footnote {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 400;
}

/* ── 专辑卡与黑胶插画 ───────────────────── */
.album-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 20px;
  border-radius: 12px;
}

.album-label {
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 500;
}

.vinyl-scene {
  position: relative;
  height: 136px;
  width: 100%;
}

.vinyl-disc {
  position: absolute;
  top: 8px;
  left: 50%;
  width: 112px;
  height: 112px;
  border-radius: 50%;
  transform: translateX(calc(-50% + 34px));
}

.vinyl-ring {
  position: absolute;
  top: 50%;
  left: 50%;
  border: 1px solid #45464c;
  border-radius: 50%;
  transform: translate(-50%, -50%);
}

.vinyl-core {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--color-primary);
  transform: translate(-50%, -50%);
}

.vinyl-cover {
  position: absolute;
  top: 9px;
  left: 50%;
  transform: translateX(calc(-50% - 16px)) rotate(-8deg);
}

.album-name {
  color: var(--color-text-main);
  font-size: 18px;
  font-weight: 700;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.album-count {
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 500;
}

/* ── 指标卡 ─────────────────────────────── */
.metrics-grid {
  display: grid;
  gap: 18px 20px;
}

.metric-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.metric-value {
  color: var(--color-text-main);
  font-size: 26px;
  font-weight: 600;
  line-height: 1.3;
  word-break: keep-all;
}

.metric-label {
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 400;
}

.overview-divider {
  height: 1px;
  background: var(--border-subtle);
}
</style>
