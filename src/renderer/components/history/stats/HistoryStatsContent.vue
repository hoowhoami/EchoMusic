<script setup lang="ts">
/**
 * 听歌统计内容组装层：页面统计 Tab 与分享导出共用同一份有界组合。
 * 移植自 EchoMusicNext HistoryStatsContent.qml：
 * Overview → Activity / Rankings（有数据才显示）→ 空态卡。
 */
import { computed } from 'vue';
import Button from '@/components/ui/Button.vue';
import { iconHeadphones } from '@/icons';
import type { HistoryStats } from '../../../../shared/historyStats';
import HistoryStatsOverview from './HistoryStatsOverview.vue';
import HistoryStatsActivity from './HistoryStatsActivity.vue';
import HistoryStatsRankings from './HistoryStatsRankings.vue';

const props = withDefaults(
  defineProps<{
    stats: HistoryStats;
    loading?: boolean;
    errorMessage?: string;
    interactive?: boolean;
    animate?: boolean;
  }>(),
  { loading: false, errorMessage: '', interactive: true, animate: true },
);

const emit = defineEmits<{ play: [id: string]; retry: [] }>();

const hasData = computed(() => props.stats.totalSongs > 0);
const hasError = computed(() => props.errorMessage.length > 0);

const emptyTitle = computed(() =>
  props.loading ? '正在整理听歌记录' : hasError.value ? '暂时无法读取记录' : '下一首，就是故事的开始',
);
const emptyBody = computed(() =>
  props.loading
    ? '你的听歌足迹，马上呈现。'
    : hasError.value
      ? props.errorMessage
      : '播放喜欢的音乐，听歌足迹会慢慢在这里展开。',
);
</script>

<template>
  <div class="stats-content">
    <HistoryStatsOverview
      :stats="stats"
      :interactive="interactive"
      :animate="animate"
      @play="id => emit('play', id)"
    />
    <HistoryStatsActivity v-if="hasData" :stats="stats" :animate="animate" />
    <HistoryStatsRankings
      v-if="hasData"
      :stats="stats"
      :interactive="interactive"
      :animate="animate"
      @play="id => emit('play', id)"
    />
    <div v-if="!hasData" class="stats-empty">
      <Icon :icon="iconHeadphones" width="32" height="32" class="empty-icon" />
      <div class="empty-title">{{ emptyTitle }}</div>
      <div class="empty-body">{{ emptyBody }}</div>
      <Button
        v-if="!loading && hasError"
        variant="soft-secondary"
        size="default"
        class="empty-retry"
        @click="emit('retry')"
      >
        重新读取
      </Button>
    </div>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.stats-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  padding-bottom: 16px;
}

.stats-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 32px 24px;
  border-radius: 12px;
  background: var(--control-muted-bg);
}

.empty-icon {
  color: var(--color-primary-text);
}

.empty-title {
  color: var(--color-text-main);
  font-size: 18px;
  font-weight: 600;
  line-height: 1.4;
  text-align: center;
}

.empty-body {
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
  text-align: center;
}

.empty-retry {
  margin-top: 4px;
}
</style>
