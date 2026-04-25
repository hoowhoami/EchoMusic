<script setup lang="ts">
import { SliderRoot, SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import Popover from '@/components/ui/Popover.vue';
import Button from '@/components/ui/Button.vue';
import { iconSpeedometer } from '@/icons';
import { usePlayerControls } from '@/utils/usePlayerControls';

const {
  player,
  playbackRateDisplay,
  handlePlaybackRateSlider,
  resetPlaybackRate,
  setPlaybackRate,
} = usePlayerControls();

interface Props {
  variant?: 'lyric' | 'bar';
  side?: 'top' | 'bottom';
}

withDefaults(defineProps<Props>(), {
  variant: 'bar',
  side: 'top',
});
</script>

<template>
  <Popover
    trigger="hover"
    :side="side"
    align="center"
    :side-offset="8"
    :show-arrow="true"
    content-class="speed-popover"
  >
    <template #trigger>
      <Button
        variant="unstyled"
        size="none"
        type="button"
        class="p-2 transition-all"
        :class="
          player.playbackRate !== 1
            ? variant === 'lyric'
              ? 'text-black dark:text-white hover:scale-110 active:scale-90'
              : 'text-primary hover:scale-110 active:scale-90'
            : variant === 'lyric'
              ? 'text-black/40 dark:text-white/40 hover:scale-110 active:scale-90'
              : 'text-text-main/50 hover:text-primary hover:scale-110 active:scale-90'
        "
        title="播放倍速"
      >
        <Icon :icon="iconSpeedometer" width="20" height="20" />
      </Button>
    </template>
    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <span class="text-[11px] font-bold opacity-50">播放倍速</span>
        <Button
          variant="unstyled"
          size="none"
          class="text-[13px] font-extrabold px-1.5 py-0.5 rounded-md transition-colors"
          :class="
            player.playbackRate === 1 ? 'opacity-40' : 'hover:bg-black/5 dark:hover:bg-white/10'
          "
          @click="resetPlaybackRate"
          >{{ playbackRateDisplay }}</Button
        >
      </div>
      <div class="flex items-center gap-2">
        <span class="text-[10px] font-semibold opacity-40 shrink-0">0.1</span>
        <SliderRoot
          class="relative flex items-center select-none touch-none flex-1 h-5"
          :model-value="[Math.round(player.playbackRate * 10)]"
          :min="1"
          :max="50"
          :step="1"
          orientation="horizontal"
          @update:model-value="handlePlaybackRateSlider"
        >
          <SliderTrack class="relative grow rounded-full h-[3px] bg-black/12 dark:bg-white/15">
            <SliderRange class="absolute h-full rounded-full bg-black dark:bg-white" />
          </SliderTrack>
          <SliderThumb
            class="block w-3 h-3 bg-black dark:bg-white rounded-full shadow-md focus-visible:outline-none"
          />
        </SliderRoot>
        <span class="text-[10px] font-semibold opacity-40 shrink-0">5x</span>
      </div>
      <div class="flex items-center justify-between">
        <Button
          v-for="r in [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0]"
          :key="r"
          variant="unstyled"
          size="none"
          class="text-[11px] font-semibold px-2 py-1 rounded-md transition-colors"
          :class="
            Math.abs(player.playbackRate - r) < 0.01
              ? 'bg-black/10 dark:bg-white/15'
              : 'opacity-50 hover:bg-black/5 dark:hover:bg-white/8 hover:opacity-100'
          "
          @click="setPlaybackRate(r)"
          >{{ r === Math.floor(r) ? r.toFixed(1) : r }}x</Button
        >
      </div>
    </div>
  </Popover>
</template>

<style>
.speed-popover.echo-popover-content {
  width: 320px;
  padding: 14px 16px 12px;
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(18px);
  border-color: rgba(0, 0, 0, 0.1);
}

.dark .speed-popover.echo-popover-content {
  background: rgba(28, 28, 30, 0.78);
  border-color: rgba(255, 255, 255, 0.12);
}
</style>
