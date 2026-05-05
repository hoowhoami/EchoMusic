<script setup lang="ts">
import { computed, ref } from 'vue';
import { useThrottleFn } from '@vueuse/core';
import { SliderRoot, SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import { Icon } from '@iconify/vue';
import Popover from '@/components/ui/Popover.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import Button from '@/components/ui/Button.vue';
import Badge from '@/components/ui/Badge.vue';
import { iconSlidersHorizontal } from '@/icons';
import { usePlayerControls } from '@/utils/usePlayerControls';
import type { AudioEffectValue } from '@/types';

const { player, settingStore, currentTrack, audioEffectButtonBadge, setAudioEffect } =
  usePlayerControls();

const activeTab = ref<'effect' | 'eq'>('effect');

const audioEffectOptions: readonly { value: AudioEffectValue; label: string }[] = [
  { value: 'none', label: '原声' },
  { value: 'piano', label: '钢琴' },
  { value: 'vocal', label: '人声' },
  { value: 'accompaniment', label: '伴奏' },
  { value: 'subwoofer', label: '骨笛' },
  { value: 'ancient', label: '尤克里里' },
  { value: 'surnay', label: '唢呐' },
  { value: 'dj', label: 'DJ' },
  { value: 'viper_tape', label: '蝰蛇母带' },
  { value: 'viper_atmos', label: '蝰蛇全景声' },
  { value: 'viper_clear', label: '蝰蛇超清' },
];

const eqPresets = [
  { name: '默认', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: '流行', gains: [3, 2, 0, -2, -4, -4, -2, 0, 2, 3] },
  { name: '摇滚', gains: [5, 4, 3, 0, -1, -1, 0, 3, 4, 5] },
  { name: '古典', gains: [4, 3, 2, 1, 0, 0, 1, 2, 3, 4] },
  { name: '爵士', gains: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  { name: '电子', gains: [6, 5, 0, -2, -4, 0, 2, 4, 5, 6] },
  { name: '重金属', gains: [4, 6, 4, 0, -2, 0, 2, 5, 7, 4] },
  { name: '民谣', gains: [2, 1, 0, 1, 2, 2, 1, 0, 1, 2] },
];

const frequencies = ['60', '170', '310', '600', '1k', '3k', '6k', '12k', '14k', '16k'];
const gains = computed(() => player.equalizerGains);

// 节流 EQ 更新，防止高频 IPC 调用导致音频卡顿
const throttledSetEq = useThrottleFn((newGains: number[]) => {
  player.setEq(newGains);
}, 100);

const updateGain = (index: number, value: number[] | undefined) => {
  if (!value) return;
  const newGains = [...gains.value];
  newGains[index] = value[0];
  // 立即更新 UI 状态
  player.equalizerGains = newGains;
  // 节流更新后端
  throttledSetEq(newGains);
};

const applyEqPreset = (presetGains: number[]) => {
  player.setEq([...presetGains]);
};

const isPresetActive = (presetGains: number[]) => {
  return gains.value.every((g, i) => Math.abs(g - presetGains[i]) < 0.1);
};

const resetGains = () => {
  player.setEq([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
};

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
    align="end"
    :side-offset="8"
    :show-arrow="true"
    content-class="effect-popover"
  >
    <template #trigger>
      <Button
        variant="unstyled"
        size="none"
        type="button"
        class="p-2 transition-all hover:scale-110 active:scale-90"
        :class="
          player.audioEffect !== 'none' || gains.some((g: number) => g !== 0)
            ? variant === 'lyric'
              ? 'text-black dark:text-white'
              : 'text-primary'
            : variant === 'lyric'
              ? 'text-black/40 dark:text-white/40'
              : 'text-text-main/50 hover:text-primary'
        "
        title="音效与均衡器"
      >
        <span class="relative inline-flex w-5 h-5 items-center justify-center">
          <Icon
            :icon="iconSlidersHorizontal"
            width="20"
            height="20"
            style="transform: translateY(3px)"
          />
          <Badge
            v-if="currentTrack && settingStore.showAudioQualityBadge && audioEffectButtonBadge"
            :count="audioEffectButtonBadge"
            class="absolute -top-2"
            :style="{
              right: '-12px',
              color: '#FFF',
              backgroundColor: '#10B981',
            }"
          />
        </span>
      </Button>
    </template>

    <div class="effect-layout">
      <!-- 左侧 Tab 切换 -->
      <div class="effect-sidebar">
        <button
          class="sidebar-item"
          :class="{ 'is-active': activeTab === 'effect' }"
          @click="activeTab = 'effect'"
        >
          音效
        </button>
        <button
          class="sidebar-item"
          :class="{ 'is-active': activeTab === 'eq' }"
          @click="activeTab = 'eq'"
        >
          均衡器
        </button>
      </div>

      <!-- 右侧主内容 -->
      <div class="effect-main">
        <!-- 音效面板 -->
        <div v-if="activeTab === 'effect'" class="panel-content">
          <div class="panel-header">
            <span class="panel-title">音效预设</span>
          </div>
          <Scrollbar class="panel-scroll">
            <div class="grid grid-cols-3 gap-2 p-2">
              <button
                v-for="option in audioEffectOptions"
                :key="option.value"
                type="button"
                class="pm-item !w-full !m-0"
                :class="{ 'is-active': player.audioEffect === option.value }"
                @click="setAudioEffect(option.value)"
              >
                <span class="pm-label text-center">{{ option.label }}</span>
              </button>
            </div>
          </Scrollbar>
        </div>

        <!-- 均衡器面板 -->
        <div v-if="activeTab === 'eq'" class="panel-content">
          <div class="panel-header">
            <span class="panel-title">自定义调节</span>
            <button class="reset-btn" @click="resetGains">重置</button>
          </div>

          <div class="eq-container">
            <div class="eq-bands">
              <div v-for="(gain, index) in gains" :key="index" class="eq-band">
                <SliderRoot
                  :model-value="[gain]"
                  :min="-12"
                  :max="12"
                  :step="0.1"
                  orientation="vertical"
                  class="eq-slider"
                  @update:model-value="(val) => updateGain(index, val)"
                >
                  <SliderTrack class="eq-track">
                    <SliderRange class="eq-range" />
                  </SliderTrack>
                  <SliderThumb class="eq-thumb" />
                </SliderRoot>
                <span class="eq-freq">{{ frequencies[index] }}</span>
              </div>
            </div>

            <div class="h-px bg-current opacity-5 my-3"></div>

            <div class="preset-chips">
              <button
                v-for="preset in eqPresets"
                :key="preset.name"
                class="preset-chip"
                :class="{ 'is-active': isPresetActive(preset.gains) }"
                @click="applyEqPreset(preset.gains)"
              >
                {{ preset.name }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Popover>
</template>

<style>
.effect-popover.echo-popover-content {
  width: 420px;
  height: 320px;
  padding: 0;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.75);
  backdrop-filter: blur(24px);
  border-color: rgba(0, 0, 0, 0.1);
  display: flex;
}

.dark .effect-popover.echo-popover-content {
  background: rgba(32, 32, 34, 0.8);
  border-color: rgba(255, 255, 255, 0.12);
}

.effect-layout {
  display: flex;
  width: 100%;
  height: 100%;
}

/* 侧边栏 */
.effect-sidebar {
  width: 80px;
  background: rgba(0, 0, 0, 0.03);
  display: flex;
  flex-direction: column;
  padding: 12px 6px;
  gap: 4px;
  border-right: 1px solid rgba(0, 0, 0, 0.05);
}

.dark .effect-sidebar {
  background: rgba(255, 255, 255, 0.02);
  border-right-color: rgba(255, 255, 255, 0.05);
}

.sidebar-item {
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-main);
  opacity: 0.6;
  transition: all 0.2s;
  cursor: pointer;
  border: none;
  background: transparent;
}

.sidebar-item:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.05);
}

.sidebar-item.is-active {
  opacity: 1;
  background: var(--color-primary);
  color: white;
}

/* 主面板 */
.effect-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.panel-content {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.panel-header {
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  flex-shrink: 0;
}

.panel-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text-main);
}

.reset-btn {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-primary);
  opacity: 0.8;
  background: transparent;
  border: none;
  cursor: pointer;
}

.reset-btn:hover {
  opacity: 1;
}

.panel-scroll {
  flex: 1;
}

/* 均衡器特定样式 */
.eq-container {
  padding: 0 16px 16px 16px;
  display: flex;
  flex-direction: column;
}

.eq-bands {
  display: flex;
  justify-content: space-between;
  height: 150px;
}

.eq-band {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 28px;
}

.eq-slider {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  user-select: none;
  touch-action: none;
  width: 100%;
  flex: 1;
}

.eq-track {
  position: relative;
  flex-grow: 1;
  border-radius: 9999px;
  width: 4px;
  background: rgba(29, 29, 31, 0.08);
}

.dark .eq-track {
  background: rgba(245, 245, 247, 0.1);
}

.eq-range {
  position: absolute;
  border-radius: 9999px;
  width: 100%;
  background: var(--color-primary);
}

.eq-thumb {
  display: block;
  width: 12px;
  height: 12px;
  background: white;
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 9999px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  outline: none;
}

.eq-freq {
  font-size: 10px;
  font-weight: 700;
  color: var(--color-text-main);
  opacity: 0.4;
}

/* 预设芯片 */
.preset-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.preset-chip {
  padding: 4px 10px;
  background: rgba(0, 0, 0, 0.05);
  border: 1px solid rgba(0, 0, 0, 0.05);
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-main);
  opacity: 0.8;
  cursor: pointer;
  transition: all 0.2s;
}

.dark .preset-chip {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.05);
}

.preset-chip:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.1);
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.preset-chip.is-active {
  opacity: 1;
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: white;
}

.dark .preset-chip:hover {
  background: rgba(255, 255, 255, 0.1);
}
</style>
