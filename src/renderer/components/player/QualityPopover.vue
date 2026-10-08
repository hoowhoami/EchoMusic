<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Popover from '@/components/ui/Popover.vue';
import Tag from '@/components/ui/Tag.vue';
import Badge from '@/components/ui/Badge.vue';
import AudioWaveIcon from '@/components/ui/AudioWaveIcon.vue';
import Button from '@/components/ui/Button.vue';
import { iconCheckMark } from '@/icons';
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
  isAudioQualityDisabled,
  isAudioQualityHidden,
  audioQualityAccessLookupKey,
  isAudioQualityAccessLoading,
  hasAudioQualityAccessError,
  hasAudioQualityAccessData,
  getAudioQualityAccessReason,
  getAudioQualitySizeText,
  retryCurrentTrackQualityAccess,
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
}

const props = withDefaults(defineProps<Props>(), {
  open: undefined,
  variant: 'bar',
  side: 'top',
});

const emit = defineEmits<{ 'update:open': [open: boolean] }>();
const isPanelOpen = ref(props.open ?? false);
watch(
  () => props.open,
  (open) => {
    if (open !== undefined) isPanelOpen.value = open;
  },
  { immediate: true },
);
watch(
  [isPanelOpen, audioQualityAccessLookupKey],
  ([open]) => {
    if (open) void ensureCurrentTrackCatalogQualities();
  },
  { immediate: true },
);
const handleOpenChange = (open: boolean) => {
  isPanelOpen.value = open;
  emit('update:open', open);
};

const qualityOptions = computed(() =>
  (
    [
      { value: '128', label: '标准', badge: 'SD' },
      { value: '320', label: '高品质', badge: 'HQ' },
      { value: 'flac', label: '无损', badge: 'SQ' },
      { value: 'high', label: 'Hi-Res', badge: 'HR' },
      { value: 'viper_tape', label: '蝰蛇母带', badge: 'VPT' },
      { value: 'viper_clear', label: '蝰蛇超清', badge: 'VPC' },
      { value: 'viper_atmos', label: '蝰蛇全景声', badge: 'VPA' },
    ] as const
  ).filter((option) => !isAudioQualityHidden(option.value)),
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

const selectedQuality = computed(() =>
  !currentTrack.value
    ? requestedAudioQuality.value
    : isResolvedCloudSource.value
      ? null
      : effectiveAudioQuality.value,
);

const qualityDetail = (quality: Parameters<typeof getAudioQualityAccessReason>[0]) =>
  isAudioQualityAccessLoading.value && !hasAudioQualityAccessData.value
    ? ''
    : getAudioQualityAccessReason(quality) || getAudioQualitySizeText(quality);
const isUnavailableQuality = (quality: Parameters<typeof isAudioQualityDisabled>[0]) =>
  isAudioQualityAccessLoading.value
    ? hasAudioQualityAccessData.value && !!getAudioQualityAccessReason(quality)
    : isAudioQualityDisabled(quality);

const panelStatus = computed(() => {
  if (!currentTrack.value) return '暂无歌曲';
  if (isAudioSourceSwitching.value) return `正在切换至${switchingLabel.value}…`;
  if (isAudioQualityAccessLoading.value) return '正在查询音质…';
  if (hasAudioQualityAccessError.value) return '权限查询失败';
  if (isResolvedCloudSource.value) return '当前使用云盘文件播放';
  if (hasCloudAudioSourceOption.value && !hasCatalogAudioSourceOption.value)
    return '暂无可切换的曲库音质';
  return '播放音质';
});

const triggerLabel = computed(() =>
  isAudioSourceSwitching.value
    ? `正在切换至${switchingLabel.value}`
    : isResolvedCloudSource.value
      ? '当前使用云盘文件'
      : '音质',
);

const buttonClass = 'playback-action hover:scale-110 active:scale-90';
</script>

<template>
  <Popover
    trigger="click"
    :open="props.open"
    @update:open="handleOpenChange"
    :side="props.side"
    align="center"
    :side-offset="8"
    content-class="quality-popover"
    @open-auto-focus="$event.preventDefault()"
  >
    <template #trigger>
      <Button
        variant="unstyled"
        size="none"
        type="button"
        class="action-icon relative p-2 transition-all"
        :class="buttonClass"
        :tooltip="triggerLabel"
        :aria-label="triggerLabel"
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
          tone="accent"
          placement="floating"
          class="playerbar-action-badge"
        />
      </Button>
    </template>

    <div class="quality-options">
      <div class="pm-header">
        <div class="pm-title">音质选择</div>
        <div class="pm-status" role="status" aria-live="polite">
          <span>{{ panelStatus }}</span>
          <button
            v-if="hasAudioQualityAccessError && !isAudioQualityAccessLoading"
            type="button"
            class="pm-retry"
            @click="retryCurrentTrackQualityAccess"
          >
            重试
          </button>
        </div>
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
        :aria-pressed="isResolvedCloudSource"
        @click="setCloudAudioSource"
      >
        <span class="pm-label">云盘文件</span>
        <Tag class="pm-tag" color="#0EA5E9">CLD</Tag>
        <span
          class="pm-check"
          :class="{ 'is-visible': isResolvedCloudSource || isSwitchingToCloud }"
        >
          <span v-if="isSwitchingToCloud" class="pm-spinner" aria-hidden="true"></span>
          <Icon v-else :icon="iconCheckMark" width="14" height="14" aria-hidden="true" />
        </span>
      </button>
      <div v-if="hasCloudAudioSourceOption" class="pm-divider"></div>
      <button
        v-for="q in qualityOptions"
        :key="q.value"
        type="button"
        class="pm-item"
        :class="{
          'is-active': selectedQuality === q.value,
          'is-disabled': !isAudioSourceSwitching && isUnavailableQuality(q.value),
          'is-loading': isAudioQualityAccessLoading,
          'is-locked': isAudioSourceSwitching,
          'is-pending': isPendingQuality(q.value),
        }"
        :disabled="isAudioQualityDisabled(q.value)"
        :title="
          !isAudioQualityAccessLoading || hasAudioQualityAccessData
            ? getAudioQualityAccessReason(q.value) || undefined
            : undefined
        "
        :aria-busy="isPendingQuality(q.value) || isAudioQualityAccessLoading"
        :aria-pressed="selectedQuality === q.value"
        @click="setAudioQuality(q.value)"
      >
        <span class="pm-label">
          <span>{{ q.label }}</span>
          <span class="pm-detail" :aria-hidden="!qualityDetail(q.value) || undefined">
            {{ qualityDetail(q.value) || '\u00a0' }}
          </span>
        </span>
        <Tag class="pm-tag" :color="getAudioQualityTagColor(q.value)">{{ q.badge }}</Tag>
        <span
          class="pm-check"
          :class="{
            'is-visible': selectedQuality === q.value || isPendingQuality(q.value),
          }"
        >
          <span v-if="isPendingQuality(q.value)" class="pm-spinner" aria-hidden="true"></span>
          <Icon v-else :icon="iconCheckMark" width="14" height="14" aria-hidden="true" />
        </span>
      </button>
    </div>
  </Popover>
</template>

<style scoped>
:global(.quality-popover.echo-popover-content) {
  width: 208px;
  box-sizing: border-box;
  max-width: calc(100vw - 24px);
  padding: 6px;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius-popover);
}

.quality-options {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pm-header {
  padding: 6px 10px 10px;
}

.pm-title {
  font-size: 12px;
  font-weight: 700;
}

.pm-status {
  display: flex;
  align-items: center;
  margin-top: 4px;
  min-height: 17px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.pm-divider {
  height: 1px;
  margin: 4px 6px;
  background: var(--border-subtle);
}

.pm-retry {
  margin-left: 6px;
  color: var(--color-primary-text);
  cursor: pointer;
}

.pm-detail {
  display: block;
  min-height: 16px;
  font-size: 11px;
  font-weight: 400;
  line-height: 16px;
  color: var(--color-text-secondary);
}

.pm-item {
  display: flex;
  align-items: center;
  box-sizing: border-box;
  width: 100%;
  min-height: 36px;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-control);
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  color: var(--color-text-main);
  background: transparent;
  border: 0;
  box-shadow: none;
  cursor: pointer;
  transition:
    background-color var(--motion-duration-fast) var(--motion-ease-standard),
    color var(--motion-duration-fast) var(--motion-ease-standard),
    box-shadow var(--motion-duration-fast) var(--motion-ease-standard),
    opacity var(--motion-duration-fast) var(--motion-ease-standard);
}

.pm-item:hover:not(:disabled) {
  background: var(--control-hover-bg);
  box-shadow: none;
}

.pm-item:active:not(:disabled) {
  background: var(--control-neutral-pressed-bg);
}

.pm-item.is-active,
.pm-item.is-pending,
.pm-item.is-active:focus-visible,
.pm-item.is-pending:focus-visible {
  color: var(--color-primary-text);
  background: var(--control-active-bg);
  box-shadow: none;
}

.pm-item.is-active:hover:not(:disabled) {
  background: var(--control-accent-hover-bg);
  box-shadow: none;
}

.pm-item.is-active:active:not(:disabled) {
  background: var(--control-accent-pressed-bg);
}

.pm-item:focus-visible:not(:disabled),
.pm-item.is-active:focus-visible:not(:disabled),
.pm-item.is-pending:focus-visible:not(:disabled) {
  box-shadow: inset 0 0 0 1px var(--color-primary-text);
}

.pm-item.is-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.pm-item.is-locked {
  cursor: wait;
  opacity: 0.5;
}

.pm-item.is-loading {
  cursor: wait;
}

.pm-item.is-pending {
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
  .pm-item {
    transition: none;
  }
}

.pm-label {
  flex: 1;
  min-width: 0;
  text-align: left;
}

.pm-tag {
  flex-shrink: 0;
}

.pm-check {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  width: 14px;
  flex-shrink: 0;
  text-align: right;
  font-size: 12px;
  opacity: 0;
}

.pm-check.is-visible {
  opacity: 1;
}
</style>
