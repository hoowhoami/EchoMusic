<script setup lang="ts">
import type { IconifyIcon } from '@iconify/types';
import { iconPlay, iconList } from '@/icons';
import Button from '@/components/ui/Button.vue';
interface Action {
  icon: IconifyIcon;
  label: string;
  onTap: () => void | Promise<void>;
  disabled?: boolean;
  emphasized?: boolean;
  tone?: 'default' | 'favorite';
}

interface Props {
  playLabel?: string;
  playDisabled?: boolean;
  batchLabel?: string;
  batchDisabled?: boolean;
  onPlay?: () => void;
  secondaryActions?: Action[];
}

withDefaults(defineProps<Props>(), {
  playLabel: '播放',
  playDisabled: false,
  batchLabel: '批量',
  batchDisabled: false,
  secondaryActions: () => [],
});

const emit = defineEmits<{
  (e: 'play'): void;
  (e: 'batch'): void;
}>();
</script>

<template>
  <div class="action-row-wrap flex flex-wrap gap-2">
    <!-- 主要操作 (播放) -->
    <Button
      variant="unstyled"
      size="none"
      :disabled="playDisabled"
      @click="emit('play')"
      class="action-btn primary"
    >
      <Icon :icon="iconPlay" width="16" height="16" />
      <span>{{ playLabel }}</span>
    </Button>

    <!-- 次主操作 (批量/添加到等) -->
    <Button
      variant="unstyled"
      size="none"
      :disabled="batchDisabled"
      @click="emit('batch')"
      class="action-btn secondary"
    >
      <Icon :icon="iconList" width="16" height="16" />
      <span>{{ batchLabel }}</span>
    </Button>

    <!-- 次要操作 (收藏、分享等) -->
    <Button
      variant="unstyled"
      size="none"
      v-for="action in secondaryActions"
      :key="action.label"
      :disabled="action.disabled"
      @click="action.onTap"
      class="action-btn secondary"
      :class="[{ emphasized: action.emphasized }, action.tone === 'favorite' ? 'favorite' : '']"
    >
      <div class="icon-wrap">
        <Icon :icon="action.icon" width="16" height="16" />
      </div>
      <span>{{ action.label }}</span>
    </Button>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.action-btn {
  @apply flex items-center gap-2 px-3 h-9 rounded-lg text-[12px] font-semibold transition-all active:scale-95 select-none;
  background-color: var(--bg-info-card);
  color: var(--color-text-main);
}

.action-btn.primary {
  @apply bg-primary text-white hover:bg-primary-hover;
}

.action-btn.secondary.favorite {
  color: #f87171;
  background: color-mix(in srgb, #ef4444 6%, transparent);
}

.action-btn.secondary.favorite:hover {
  color: #ef4444;
  background: color-mix(in srgb, #ef4444 10%, transparent);
}

.action-btn.secondary.emphasized {
  color: #ef4444;
  background: color-mix(in srgb, #ef4444 12%, transparent);
}

.action-btn.secondary.emphasized:hover {
  color: #dc2626;
  background: color-mix(in srgb, #ef4444 16%, transparent);
}

.action-btn:hover {
  @apply brightness-95;
}

.icon-wrap {
  @apply flex items-center justify-center w-4 h-4;
}
</style>
