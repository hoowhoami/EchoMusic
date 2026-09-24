<script setup lang="ts">
import { computed, watch } from 'vue';
import Popover from '@/components/ui/Popover.vue';
import Tag from '@/components/ui/Tag.vue';
import Badge from '@/components/ui/Badge.vue';
import AudioWaveIcon from '@/components/ui/AudioWaveIcon.vue';
import Button from '@/components/ui/Button.vue';
import { usePlayerControls } from '@/composables/usePlayerControls';

const {
  player,
  settingStore,
  currentTrack,
  effectiveAudioQuality,
  requestedAudioQuality,
  isAudioSourceSwitching,
  isResolvedCloudSource,
  hasCloudAudioSourceOption,
  hasCatalogAudioSourceOption,
  isCatalogQualityLoading,
  hasCatalogQualityError,
  isAudioQualityDisabled,
  audioQualityButtonBadge,
  getAudioQualityTagColor,
  ensureCurrentTrackCatalogQualities,
  setAudioQuality,
  setCloudAudioSource,
} = usePlayerControls();

interface Props {
  /** 触发按钮的样式变体 */
  variant?: 'lyric' | 'bar';
  open?: boolean;
  /** Popover 弹出方向 */
  side?: 'top' | 'bottom';
  showArrow?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  open: undefined,
  variant: 'bar',
  side: 'top',
  showArrow: true,
});

const emit = defineEmits<{ 'update:open': [open: boolean] }>();
watch(
  () => props.open,
  (open) => {
    if (open) void ensureCurrentTrackCatalogQualities();
  },
  { immediate: true },
);

const allQualityOptions = [
  { value: '128', label: '标准', badge: 'SD' },
  { value: '320', label: '高品质', badge: 'HQ' },
  { value: 'flac', label: '无损', badge: 'SQ' },
  { value: 'high', label: 'Hi-Res', badge: 'HR' },
  { value: 'viper_tape', label: '蝰蛇母带', badge: 'VPT' },
] as const;

const qualityOptions = computed(() =>
  settingStore.viperTapeQualityEnabled
    ? allQualityOptions
    : allQualityOptions.filter((option) => option.value !== 'viper_tape'),
);

const isSwitchingToCloud = computed(
  () =>
    isAudioSourceSwitching.value &&
    !!player.currentTrackId &&
    player.currentCloudSourceOverrideTrackId === String(player.currentTrackId),
);
const switchingLabel = computed(() =>
  isSwitchingToCloud.value
    ? '云盘文件'
    : (qualityOptions.value.find((option) => option.value === requestedAudioQuality.value)?.label ??
      '音质'),
);
const isPendingQuality = (quality: string) =>
  isAudioSourceSwitching.value &&
  !isSwitchingToCloud.value &&
  requestedAudioQuality.value === quality;

const buttonClass = computed(() => {
  const activeClass =
    props.variant === 'lyric'
      ? 'text-black dark:text-white hover:scale-110 active:scale-90'
      : 'text-primary-text hover:scale-110 active:scale-90';
  const mutedClass =
    props.variant === 'lyric'
      ? 'text-black/40 dark:text-white/40 hover:scale-110 active:scale-90'
      : 'text-text-main/50 hover:text-primary-text hover:scale-110 active:scale-90';

  if (currentTrack.value) return activeClass;
  return mutedClass;
});
</script>

<template>
  <Popover
    :trigger="props.open === undefined ? 'hover' : 'click'"
    :open="props.open"
    @update:open="emit('update:open', $event)"
    :side="props.side"
    align="center"
    :side-offset="8"
    :show-arrow="props.showArrow"
    content-class="quality-popover"
  >
    <template #trigger>
      <Button
        variant="unstyled"
        size="none"
        type="button"
        class="relative p-2 transition-all"
        :class="buttonClass"
        :aria-label="
          isAudioSourceSwitching
            ? `正在切换至${switchingLabel}`
            : isResolvedCloudSource
              ? '当前使用云盘文件'
              : '音质'
        "
        :aria-busy="isAudioSourceSwitching"
        @mouseenter="ensureCurrentTrackCatalogQualities"
        @focus="ensureCurrentTrackCatalogQualities"
      >
        <span class="inline-flex w-5 h-5 items-center justify-center">
          <AudioWaveIcon class="w-5 h-5" />
        </span>
        <Badge
          v-if="currentTrack && settingStore.showAudioQualityBadge && audioQualityButtonBadge"
          :count="audioQualityButtonBadge"
          class="playerbar-action-badge"
        />
      </Button>
    </template>

    <div class="space-y-1">
      <div class="pm-header">
        <div class="pm-title">音质选择</div>
        <div class="pm-status" role="status" aria-live="polite">
          {{ isAudioSourceSwitching ? `正在切换至${switchingLabel}…` : '播放音质' }}
        </div>
      </div>
      <div v-if="isResolvedCloudSource && !isAudioSourceSwitching" class="pm-hint">
        当前使用云盘文件播放
      </div>
      <div v-if="hasCloudAudioSourceOption && isCatalogQualityLoading" class="pm-hint">
        正在获取曲库音质
      </div>
      <div v-else-if="hasCloudAudioSourceOption && hasCatalogQualityError" class="pm-hint">
        曲库音质获取失败
      </div>
      <div v-else-if="hasCloudAudioSourceOption && !hasCatalogAudioSourceOption" class="pm-hint">
        暂无可切换的曲库音质
      </div>
      <button
        v-if="hasCloudAudioSourceOption"
        type="button"
        class="pm-item"
        :class="{
          'is-active': isResolvedCloudSource,
          'is-pending': isSwitchingToCloud,
          'is-locked': isAudioSourceSwitching,
        }"
        :disabled="isAudioSourceSwitching"
        :aria-busy="isSwitchingToCloud"
        @click="setCloudAudioSource"
      >
        <span class="pm-label">云盘文件</span>
        <Tag class="pm-tag" color="#0EA5E9">CLD</Tag>
        <span
          class="pm-check"
          :class="{ 'is-visible': isResolvedCloudSource || isSwitchingToCloud }"
        >
          <span v-if="isSwitchingToCloud" class="pm-spinner" aria-hidden="true"></span>
          <template v-else>✓</template>
        </span>
      </button>
      <div v-if="hasCloudAudioSourceOption" class="pm-divider"></div>
      <button
        v-for="q in qualityOptions"
        :key="q.value"
        type="button"
        class="pm-item"
        :class="{
          'is-active': !isResolvedCloudSource && effectiveAudioQuality === q.value,
          'is-disabled': !isAudioSourceSwitching && isAudioQualityDisabled(q.value),
          'is-locked': isAudioSourceSwitching,
          'is-pending': isPendingQuality(q.value),
        }"
        :disabled="isAudioQualityDisabled(q.value)"
        :aria-busy="isPendingQuality(q.value)"
        @click="setAudioQuality(q.value)"
      >
        <span class="pm-label">{{ q.label }}</span>
        <Tag class="pm-tag" :color="getAudioQualityTagColor(q.value)">{{ q.badge }}</Tag>
        <span
          class="pm-check"
          :class="{
            'is-visible':
              (!isResolvedCloudSource && effectiveAudioQuality === q.value) ||
              isPendingQuality(q.value),
          }"
        >
          <span v-if="isPendingQuality(q.value)" class="pm-spinner" aria-hidden="true"></span>
          <template v-else>✓</template>
        </span>
      </button>
    </div>
  </Popover>
</template>

<style scoped>
:global(.quality-popover.echo-popover-content) {
  width: 208px;
  padding: 8px 0;
  border-color: var(--border-subtle);
}

.pm-header {
  padding: 4px 14px 8px;
}

.pm-title {
  font-size: 12px;
  font-weight: 700;
}

.pm-status {
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-text-secondary);
}

.pm-hint {
  padding: 0 10px 6px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.4;
  color: var(--color-text-secondary);
}

.pm-divider {
  height: 1px;
  margin: 4px 10px;
  background: var(--border-subtle);
}

.pm-item {
  display: flex;
  align-items: center;
  width: calc(100% - 12px);
  margin: 0 6px;
  padding: 9px 8px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  color: inherit;
  opacity: 0.7;
  background: transparent;
  border: none;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    opacity 0.15s ease;
}

.pm-item:hover:not(:disabled) {
  background: var(--row-hover-bg);
  opacity: 1;
}

.pm-item.is-active {
  background: var(--row-selected-bg);
  opacity: 1;
}

.pm-item.is-disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.pm-item.is-disabled:hover {
  background: transparent;
}

.pm-item.is-locked {
  cursor: wait;
  opacity: 0.4;
}

.pm-item.is-pending {
  background: var(--row-selected-bg);
  opacity: 1;
}

.pm-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: quality-spin 0.8s linear infinite;
}

@keyframes quality-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .pm-spinner {
    animation: none;
  }
}

.pm-label {
  flex: 1;
  text-align: left;
}

.pm-tag {
  font-size: 9px;
  padding: 0 4px;
  margin-right: 6px;
}

.pm-check {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  width: 14px;
  text-align: right;
  font-size: 12px;
  opacity: 0;
}

.pm-check.is-visible {
  opacity: 1;
}
</style>
