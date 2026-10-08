<script setup lang="ts">
import { computed, ref } from 'vue';
import { SliderRoot, SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import Popover from '@/components/ui/Popover.vue';
import Button from '@/components/ui/Button.vue';
import VolumeIcon from './VolumeIcon.vue';
import { usePlayerControls } from '@/composables/usePlayerControls';

const { player, handleVolumeChange, toggleMute } = usePlayerControls();

interface Props {
  variant?: 'lyric' | 'bar';
  side?: 'top' | 'bottom';
  open?: boolean;
  showArrow?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'bar',
  side: 'top',
  open: undefined,
  showArrow: true,
});
const emit = defineEmits<{ 'update:open': [open: boolean] }>();

const isMac = navigator.platform.toLowerCase().includes('mac');
const internalOpen = ref(false);
const popoverOpen = computed({
  get: () => props.open ?? internalOpen.value,
  set: (open: boolean) => {
    internalOpen.value = open;
    emit('update:open', open);
  },
});

// 滚轮保持弹出层不消失的定时器
let wheelKeepAliveTimer: ReturnType<typeof setTimeout> | null = null;

const handleWheel = (e: WheelEvent) => {
  // 弹出层未打开时不拦截，让 Sidebar 正常滚动
  if (!popoverOpen.value) return;
  e.preventDefault();
  e.stopPropagation();

  const normalized = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120);
  const step = (normalized / 120) * 5;
  const direction = isMac ? 1 : -1;
  player.adjustVolume(step * direction);

  // 滚轮操作时保持弹出层打开
  if (wheelKeepAliveTimer) clearTimeout(wheelKeepAliveTimer);
  popoverOpen.value = true;
  wheelKeepAliveTimer = setTimeout(() => {
    wheelKeepAliveTimer = null;
  }, 300);
};
</script>

<template>
  <div class="flex items-center" @wheel="handleWheel">
    <Popover
      v-model:open="popoverOpen"
      :trigger="props.open === undefined ? 'hover' : 'click'"
      :side="side"
      align="center"
      :side-offset="0"
      :show-arrow="props.showArrow"
      content-class="vol-popover"
      @open-auto-focus="$event.preventDefault()"
    >
      <template #trigger>
        <Button
          variant="unstyled"
          size="none"
          type="button"
          :class="[
            'playback-action transition-colors',
            props.variant === 'lyric'
              ? 'flex h-10 w-10 items-center justify-center rounded-full transition-all hover:scale-110 active:scale-90'
              : 'flex h-9 w-9 items-center justify-center hover:scale-110 active:scale-90',
          ]"
          @click.stop="toggleMute"
          :aria-label="player.volume === 0 ? '取消静音' : '静音'"
        >
          <VolumeIcon />
        </Button>
      </template>
      <div class="vol-body">
        <SliderRoot
          :model-value="[player.volume]"
          :max="100"
          orientation="vertical"
          class="vol-slider echo-slider"
          @update:model-value="handleVolumeChange"
        >
          <SliderTrack class="echo-slider-track">
            <SliderRange class="echo-slider-range" />
          </SliderTrack>
          <SliderThumb
            class="echo-slider-thumb"
            aria-label="音量"
            :aria-valuetext="`${Math.round(player.volume)}%`"
          />
        </SliderRoot>
        <span class="vol-value">{{ Math.round(player.volume) }}</span>
      </div>
    </Popover>
  </div>
</template>

<style>
.vol-popover.echo-popover-content {
  width: auto;
  padding: 12px;
  border-color: var(--border-subtle);
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
  cursor: pointer;
  width: 24px;
  flex: 1;
}

.vol-value {
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-secondary);
}
</style>
