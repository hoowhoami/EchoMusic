<script setup lang="ts">
// 播放进度条独立子组件：player.currentTime 每 250ms 更新一次，若直接绑定在
// PlayerBar 根组件模板中，会让整个常驻 PlayerBar（三组按钮条 + 多个 Popover +
// 底部抽屉）跟着做全量 render + VNode diff。把进度相关状态全部收敛到本组件内，
// 高频更新只重渲染本组件。
import { computed } from 'vue';
import { SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import SliderRoot from '@/components/ui/SliderRoot.vue';
import ProgressBusyOverlay from '@/components/player/ProgressBusyOverlay.vue';
import { usePlayerStore } from '@/stores/player';
import { useDeferredSeek } from '@/composables/useDeferredSeek';
import { usePlaybackProgressStatus } from '@/composables/usePlaybackProgressStatus';

const player = usePlayerStore();

const formatTime = (seconds: number) => {
  if (!seconds || Number.isNaN(seconds)) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

const {
  pendingSeekTime,
  isDragging: isDraggingSeek,
  progressValue,
  handleStart: handleSeekStart,
  handleValueUpdate: handleSeek,
  handleCommit: handleSeekCommit,
  handleEnd: handleSeekEnd,
  handleCancel: handleSeekCancel,
} = useDeferredSeek({
  getCurrentTime: () => player.currentTime,
  seek: (time) => player.seek(time),
});

const { isBusy: isProgressBusy, ariaLabel: progressAriaLabel } = usePlaybackProgressStatus(
  () => player.playbackProgressBusyReason,
);

const displayTime = computed(() =>
  formatTime(
    isDraggingSeek.value && pendingSeekTime.value !== null
      ? pendingSeekTime.value
      : player.currentTime,
  ),
);
</script>

<template>
  <!-- 进度条系统 - 动态伸缩至最大值 -->
  <div class="w-full max-w-120 flex items-center gap-3 px-1 h-3.5 min-w-0">
    <span
      class="text-[10px] font-medium text-text-secondary w-9 shrink-0 text-right tabular-nums"
      >{{ displayTime }}</span
    >
    <SliderRoot
      :model-value="progressValue"
      :max="player.duration || 100"
      :step="0.1"
      :aria-busy="isProgressBusy"
      :aria-label="progressAriaLabel"
      class="echo-slider echo-slider-progress relative flex items-center flex-1 min-w-0 h-4 group/progress"
      :data-dragging="isDraggingSeek"
      @update:model-value="handleSeek"
      @pointerdown.capture="handleSeekStart"
      @value-commit="handleSeekCommit"
      @pointerup="handleSeekEnd"
      @pointercancel="handleSeekCancel"
    >
      <SliderTrack class="echo-slider-track">
        <div class="climax-mark-layer">
          <template v-for="(mark, index) in player.climaxMarks" :key="`${mark.start}-${index}`">
            <span
              class="climax-tick"
              :style="{ left: `calc(${(mark.start * 100).toFixed(3)}% - 1px)` }"
            >
            </span>
            <span
              v-if="mark.end > mark.start"
              class="climax-tick"
              :style="{ left: `calc(${(mark.end * 100).toFixed(3)}% - 1px)` }"
            >
            </span>
          </template>
        </div>
        <SliderRange class="echo-slider-range">
          <ProgressBusyOverlay v-if="isProgressBusy" />
        </SliderRange>
      </SliderTrack>
      <SliderThumb
        class="echo-slider-thumb"
        :aria-label="progressAriaLabel"
        :aria-valuetext="displayTime"
      />
    </SliderRoot>
    <span class="text-[10px] font-medium text-text-secondary w-9 shrink-0 text-left tabular-nums">{{
      formatTime(player.duration)
    }}</span>
  </div>
</template>

<style scoped>
.climax-mark-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.climax-tick {
  position: absolute;
  top: calc(50% - 3px);
  width: 2px;
  height: 6px;
  border-radius: 1px;
  background: color-mix(in srgb, var(--color-primary) 80%, transparent);
}

:global(.dark) .climax-tick {
  background: color-mix(in srgb, var(--color-primary) 65%, transparent);
}
</style>
