<script setup lang="ts">
import { computed, ref } from 'vue';
import { SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import SliderRoot from '@/components/ui/SliderRoot.vue';
import Popover from '@/components/ui/Popover.vue';
import Button from '@/components/ui/Button.vue';
import { iconSpeedometer } from '@/icons';
import { usePlayerControls } from '@/composables/usePlayerControls';

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
  open?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'bar',
  side: 'top',
  open: undefined,
});
const emit = defineEmits<{ 'update:open': [open: boolean] }>();
const internalOpen = ref(false);
const popoverOpen = computed({
  get: () => props.open ?? internalOpen.value,
  set: (open: boolean) => {
    internalOpen.value = open;
    emit('update:open', open);
  },
});
</script>

<template>
  <Popover
    trigger="click"
    :open="popoverOpen"
    :side="props.side"
    align="center"
    :side-offset="8"
    content-class="speed-popover"
    @update:open="popoverOpen = $event"
  >
    <template #trigger>
      <Button
        variant="unstyled"
        size="none"
        type="button"
        class="playback-action p-2 transition-all hover:scale-110 active:scale-90"
        :class="{ 'is-active': player.playbackRate !== 1 }"
        :tooltip="`倍速播放 · ${playbackRateDisplay}`"
        aria-label="倍速播放"
      >
        <Icon :icon="iconSpeedometer" width="20" height="20" />
      </Button>
    </template>

    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <span class="text-[11px] font-bold text-text-secondary">倍速播放</span>
        <Button
          variant="soft-secondary"
          size="none"
          class="text-[13px] font-extrabold px-1.5 py-0.5 rounded-control"
          @click="resetPlaybackRate"
          >{{ playbackRateDisplay }}</Button
        >
      </div>
      <div class="flex items-center gap-2">
        <span class="text-[10px] font-semibold text-text-secondary shrink-0">0.1</span>
        <SliderRoot
          class="echo-slider relative flex items-center flex-1 h-6"
          :model-value="[Math.round(player.playbackRate * 10)]"
          :min="1"
          :max="50"
          :step="1"
          orientation="horizontal"
          @update:model-value="handlePlaybackRateSlider"
        >
          <SliderTrack class="echo-slider-track">
            <SliderRange class="echo-slider-range" />
          </SliderTrack>
          <SliderThumb
            class="echo-slider-thumb"
            aria-label="播放倍速"
            :aria-valuetext="playbackRateDisplay"
          />
        </SliderRoot>
        <span class="text-[10px] font-semibold text-text-secondary shrink-0">5x</span>
      </div>
      <div class="speed-presets">
        <Button
          v-for="r in [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0]"
          :key="r"
          :variant="Math.abs(player.playbackRate - r) < 0.01 ? 'soft-primary' : 'soft-secondary'"
          size="none"
          class="inline-flex items-center justify-center h-7 min-w-0 text-[11px] font-semibold px-1 py-1 whitespace-nowrap rounded-control"
          :aria-pressed="Math.abs(player.playbackRate - r) < 0.01"
          @click="setPlaybackRate(r)"
          >{{ r === Math.floor(r) ? r.toFixed(1) : r }}x</Button
        >
      </div>
    </div>
  </Popover>
</template>

<style>
.speed-popover.echo-popover-content {
  width: 360px;
  max-width: calc(100vw - 32px);
  padding: 14px 16px 12px;
  border-color: var(--border-subtle);
}

.speed-presets {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 6px;
}

@media (max-width: 380px) {
  .speed-presets {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
</style>
