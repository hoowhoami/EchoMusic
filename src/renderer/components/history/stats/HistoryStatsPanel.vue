<script setup lang="ts">
/**
 * 听歌统计的可复用面板容器（flat 形态）。
 * 移植自 EchoMusicNext HistoryStatsPanel.qml：标题 + 右侧强调数字 + 描述 + 内容区。
 */
import { computed } from 'vue';
import './statsShared.css';

const props = withDefaults(
  defineProps<{
    heading?: string;
    description?: string;
    detail?: string;
    /** 入场动画开关（导出时关闭） */
    animate?: boolean;
    /** 入场错峰序号，每档延迟 32ms（封顶 96ms，对齐 Next EchoEnter） */
    order?: number;
  }>(),
  { heading: '', description: '', detail: '', animate: true, order: 0 },
);

const enterDelay = computed(() => `${Math.min(props.order * 32, 96)}ms`);
const enterStyle = computed(() =>
  props.animate ? { animationDelay: enterDelay.value } : undefined,
);
</script>

<template>
  <section class="stats-panel" :class="{ 'stats-enter': animate }" :style="enterStyle">
    <header class="panel-head">
      <div class="panel-head-row">
        <h3 class="panel-heading">{{ heading }}</h3>
        <span v-if="detail" class="panel-detail">{{ detail }}</span>
      </div>
      <p v-if="description" class="panel-description">{{ description }}</p>
    </header>
    <div class="panel-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
@reference "@/style.css";

.stats-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
}

.panel-head {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.panel-head-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.panel-heading {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--color-text-main);
  font-size: 16px;
  font-weight: 700;
  line-height: 1.4;
}

.panel-detail {
  flex: 0 0 auto;
  color: var(--color-primary-text);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.panel-description {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 400;
  line-height: 1.45;
}

.panel-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
</style>
