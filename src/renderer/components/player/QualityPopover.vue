<script setup lang="ts">
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
  isAudioQualityDisabled,
  audioQualityButtonBadge,
  currentAudioQualityBadgeColor,
  getAudioQualityTagColor,
  setAudioQuality,
} = usePlayerControls();

interface Props {
  /** 触发按钮的样式变体 */
  variant?: 'lyric' | 'bar';
  /** Popover 弹出方向 */
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
    content-class="quality-popover"
  >
    <template #trigger>
      <Button
        variant="unstyled"
        size="none"
        type="button"
        class="p-2 transition-all"
        :class="
          player.currentAudioQualityOverride !== null
            ? variant === 'lyric'
              ? 'text-black dark:text-white hover:scale-110 active:scale-90'
              : 'text-primary hover:scale-110 active:scale-90'
            : variant === 'lyric'
              ? 'text-black/40 dark:text-white/40 hover:scale-110 active:scale-90'
              : 'text-text-main/50 hover:text-primary hover:scale-110 active:scale-90'
        "
        title="音质"
      >
        <span class="relative inline-flex w-5 h-5 items-center justify-center">
          <AudioWaveIcon class="w-5 h-5" style="transform: translateY(3px)" />
          <Badge
            v-if="currentTrack && settingStore.showAudioQualityBadge"
            :count="audioQualityButtonBadge"
            class="absolute -top-2"
            :style="{ right: '-12px' }"
          />
        </span>
      </Button>
    </template>
    <div class="space-y-1">
      <div class="pm-title">音质选择</div>
      <button
        v-for="q in ['128', '320', 'flac', 'high', 'super'] as const"
        :key="q"
        type="button"
        class="pm-item"
        :class="{
          'is-active': effectiveAudioQuality === q,
          'is-disabled': isAudioQualityDisabled(q) && effectiveAudioQuality !== q,
        }"
        :disabled="isAudioQualityDisabled(q) && effectiveAudioQuality !== q"
        @click="setAudioQuality(q)"
      >
        <span class="pm-label">{{
          q === '128'
            ? '标准'
            : q === '320'
              ? '高品质'
              : q === 'flac'
                ? '无损'
                : q === 'high'
                  ? 'Hi-Res'
                  : '臻品音质'
        }}</span>
        <Tag class="pm-tag" :color="getAudioQualityTagColor(q)">{{
          q === '128'
            ? 'SD'
            : q === '320'
              ? 'HQ'
              : q === 'flac'
                ? 'SQ'
                : q === 'high'
                  ? 'HR'
                  : 'DSD'
        }}</Tag>
        <span class="pm-check" :class="{ 'is-visible': effectiveAudioQuality === q }">✓</span>
      </button>
    </div>
  </Popover>
</template>

<style>
.quality-popover.echo-popover-content {
  width: 160px;
  padding: 10px 0;
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(18px);
  border-color: rgba(0, 0, 0, 0.1);
}

.dark .quality-popover.echo-popover-content {
  background: rgba(28, 28, 30, 0.78);
  border-color: rgba(255, 255, 255, 0.12);
}

.pm-title {
  font-size: 11px;
  font-weight: 700;
  opacity: 0.5;
  padding: 0 10px 4px 10px;
}

.pm-item {
  display: flex;
  align-items: center;
  width: calc(100% - 12px);
  margin: 0 6px;
  padding: 6px 8px;
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

.pm-item:hover {
  background: rgba(0, 0, 0, 0.05);
  opacity: 1;
}

.dark .pm-item:hover {
  background: rgba(255, 255, 255, 0.08);
}

.pm-item.is-active {
  background: rgba(0, 113, 227, 0.1);
  opacity: 1;
}

.dark .pm-item.is-active {
  background: rgba(0, 113, 227, 0.2);
}

.pm-item.is-disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.pm-item.is-disabled:hover {
  background: transparent;
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
  width: 14px;
  text-align: right;
  font-size: 12px;
  opacity: 0;
}

.pm-check.is-visible {
  opacity: 1;
}
</style>
