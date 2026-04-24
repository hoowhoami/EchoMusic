<script setup lang="ts">
import { SliderRoot, SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import Popover from '@/components/ui/Popover.vue';
import Button from '@/components/ui/Button.vue';
import { iconVolume2, iconVolume1, iconVolume3 } from '@/icons';
import { usePlayerControls } from '@/utils/usePlayerControls';

const { player, handleVolumeChange, toggleMute } = usePlayerControls();

interface Props {
  variant?: 'lyric' | 'bar';
  side?: 'top' | 'bottom';
}

withDefaults(defineProps<Props>(), {
  variant: 'bar',
  side: 'top',
});

const isMac = navigator.platform.toLowerCase().includes('mac');

const handleWheel = (e: WheelEvent) => {
  e.preventDefault();
  const normalized = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120);
  const step = (normalized / 120) * 0.05;
  const direction = isMac ? 1 : -1;
  player.setVolume(Math.max(0, Math.min(1, player.volume + step * direction)));
};
</script>

<template>
  <div @wheel.prevent="handleWheel">
    <Popover
      trigger="hover"
      :side="side"
      align="center"
      :side-offset="8"
      :show-arrow="true"
      content-class="vol-popover"
    >
      <template #trigger>
        <Button
          variant="unstyled"
          size="none"
          type="button"
          :class="[
            'p-2 transition-colors',
            variant === 'lyric'
              ? 'flex h-9 w-9 items-center justify-center rounded-full hover:bg-black/5 dark:hover:bg-white/10 text-black/55 dark:text-white/55'
              : 'text-text-main/50 hover:text-primary hover:scale-110 active:scale-90',
          ]"
          @click.stop="toggleMute"
        >
          <Icon
            v-if="player.volume === 0"
            :icon="iconVolume3"
            :width="variant === 'lyric' ? 21 : 22"
            :height="variant === 'lyric' ? 21 : 22"
          />
          <Icon
            v-else-if="player.volume <= 0.5"
            :icon="iconVolume1"
            :width="variant === 'lyric' ? 21 : 22"
            :height="variant === 'lyric' ? 21 : 22"
          />
          <Icon
            v-else
            :icon="iconVolume2"
            :width="variant === 'lyric' ? 21 : 22"
            :height="variant === 'lyric' ? 21 : 22"
          />
        </Button>
      </template>
      <div class="vol-body">
        <SliderRoot
          :model-value="[player.volume * 100]"
          :max="100"
          orientation="vertical"
          class="vol-slider"
          @update:model-value="handleVolumeChange"
        >
          <SliderTrack class="vol-track">
            <SliderRange class="vol-range" />
          </SliderTrack>
          <SliderThumb class="vol-thumb" />
        </SliderRoot>
        <span class="vol-value">{{ Math.round(player.volume * 100) }}</span>
      </div>
    </Popover>
  </div>
</template>

<style>
.vol-popover.echo-popover-content {
  width: auto;
  padding: 12px;
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(18px);
  border-color: rgba(0, 0, 0, 0.1);
}

.dark .vol-popover.echo-popover-content {
  background: rgba(28, 28, 30, 0.78);
  border-color: rgba(255, 255, 255, 0.12);
}

.vol-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 120px;
  gap: 6px;
}

.vol-slider {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  user-select: none;
  touch-action: none;
  width: 20px;
  flex: 1;
}

.vol-track {
  position: relative;
  flex-grow: 1;
  border-radius: 9999px;
  width: 3px;
  background: rgba(29, 29, 31, 0.18);
}

.dark .vol-track {
  background: rgba(245, 245, 247, 0.15);
}

.vol-range {
  position: absolute;
  border-radius: 9999px;
  width: 100%;
  background: var(--color-primary);
}

.vol-thumb {
  display: block;
  width: 12px;
  height: 12px;
  background: white;
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 9999px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  outline: none;
}

.vol-thumb:focus-visible {
  box-shadow: none;
}

.vol-value {
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-main);
  opacity: 0.6;
}
</style>
