<script setup lang="ts">
import { computed, ref } from 'vue';
import { Icon } from '@iconify/vue';
import { RovingFocusGroup, RovingFocusItem } from 'reka-ui';
import Button from '@/components/ui/Button.vue';
import Popover from '@/components/ui/Popover.vue';
import { playModeOptions, usePlayerControls } from '@/composables/usePlayerControls';
import { iconCheckMark } from '@/icons';
import type { PlayMode } from '@/types';

const props = withDefaults(defineProps<{ open?: boolean; side?: 'top' | 'bottom' }>(), {
  open: undefined,
  side: 'top',
});
const emit = defineEmits<{ 'update:open': [open: boolean] }>();
const { player, playModeIcon, playModeLabel } = usePlayerControls();
const internalOpen = ref(false);
const menuRef = ref<HTMLElement | null>(null);
const popoverOpen = computed({
  get: () => props.open ?? internalOpen.value,
  set: (open: boolean) => {
    internalOpen.value = open;
    emit('update:open', open);
  },
});

const selectMode = (mode: PlayMode) => {
  if (mode !== player.playMode) player.setPlayMode(mode);
  popoverOpen.value = false;
};

const focusSelectedMode = (event: Event) => {
  const selected = menuRef.value?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
  if (!selected) return;
  event.preventDefault();
  selected.focus();
};
</script>

<template>
  <Popover
    v-model:open="popoverOpen"
    trigger="click"
    :side="props.side"
    align="center"
    :side-offset="8"
    content-class="play-mode-popover"
    @open-auto-focus="focusSelectedMode"
  >
    <template #trigger>
      <Button
        variant="unstyled"
        size="none"
        type="button"
        class="playback-action p-2 transition-all hover:scale-110 active:scale-90"
        :tooltip="`播放模式 · ${playModeLabel}`"
        :aria-label="`播放模式 · ${playModeLabel}`"
        :aria-expanded="popoverOpen"
        aria-haspopup="menu"
      >
        <Icon :icon="playModeIcon" width="20" height="20" />
      </Button>
    </template>

    <div ref="menuRef">
      <RovingFocusGroup
        orientation="vertical"
        loop
        role="menu"
        aria-label="播放模式"
        :default-current-tab-stop-id="player.playMode"
      >
        <RovingFocusItem
          v-for="option in playModeOptions"
          :key="option.value"
          :tab-stop-id="option.value"
          :active="player.playMode === option.value"
          as-child
        >
          <button
            type="button"
            role="menuitemradio"
            :aria-checked="player.playMode === option.value"
            class="play-mode-option app-focus-ring-soft echo-button-motion"
            :class="{ 'is-selected': player.playMode === option.value }"
            @click="selectMode(option.value)"
          >
            <Icon :icon="option.icon" width="20" height="20" aria-hidden="true" />
            <span class="flex-1 text-left">{{ option.label }}</span>
            <Icon
              v-if="player.playMode === option.value"
              :icon="iconCheckMark"
              width="16"
              height="16"
              aria-hidden="true"
            />
          </button>
        </RovingFocusItem>
      </RovingFocusGroup>
    </div>
  </Popover>
</template>

<style>
.play-mode-popover.echo-popover-content {
  width: 184px;
  padding: 6px;
}
</style>

<style scoped>
.play-mode-option {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 36px;
  padding: 8px 10px;
  border-radius: var(--radius-control);
  color: var(--color-text-main);
  font-size: 12px;
}

.play-mode-option:hover {
  background: var(--control-hover-bg);
}

.play-mode-option.is-selected {
  color: var(--color-primary-text);
  background: var(--control-muted-bg);
}
</style>
