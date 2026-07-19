<script setup lang="ts">
import { computed, ref } from 'vue';
import { useDebounceFn, useThrottleFn } from '@vueuse/core';
import { SliderRoot, SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import { Icon } from '@iconify/vue';
import Popover from '@/components/ui/Popover.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import Button from '@/components/ui/Button.vue';
import Badge from '@/components/ui/Badge.vue';
import { iconSlidersHorizontal } from '@/icons';
import { usePlayerControls } from '@/composables/usePlayerControls';
import type { AudioEffectValue } from '@/types';
import { normalizeImpulseResponseName } from '../../../shared/audio';

const { player, settingStore, currentTrack, audioEffectButtonBadge, setAudioEffect } =
  usePlayerControls();

const activeTab = ref<'effect' | 'eq' | 'irs'>('effect');

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
const selectedImpulseResponse = computed(() => settingStore.getSelectedImpulseResponse());
const impulseResponseActive = computed(
  () => settingStore.impulseResponseEnabled && !!selectedImpulseResponse.value,
);
const impulseResponseStrengthSaved = computed(() =>
  Math.round(settingStore.impulseResponseMix * 100),
);
// 拖动时保留本地草稿，避免持久化状态的显示延迟；null = 未在拖动，用已保存值。
const impulseResponseStrengthDraft = ref<number | null>(null);
const impulseResponseStrength = computed(
  () => impulseResponseStrengthDraft.value ?? impulseResponseStrengthSaved.value,
);

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

const toggleImpulseResponse = () => {
  if (!selectedImpulseResponse.value) return;
  settingStore.impulseResponseEnabled = !settingStore.impulseResponseEnabled;
};

const selectImpulseResponse = (id: string) => {
  settingStore.setSelectedImpulseResponse(id);
};

// 强度变化走原生轻量 mix 更新，不重载 IR 文件；节流限制 IPC 频率，松手再 commit 最终值兜底。
const throttledCommitImpulseResponseStrength = useThrottleFn((percent: number) => {
  settingStore.setImpulseResponseMix(percent / 100);
}, 50);

// 松手后应用最终强度并清除本地草稿。debounce 兜底合并按住键盘方向键的连续 commit。
const commitImpulseResponseStrength = useDebounceFn((percent: number) => {
  settingStore.setImpulseResponseMix(percent / 100);
  impulseResponseStrengthDraft.value = null;
}, 80);

const updateImpulseResponseStrength = (value: number[] | undefined) => {
  if (!value?.length) return;
  // 拖动中：更新本地显示并节流实时下发到后端
  impulseResponseStrengthDraft.value = value[0];
  throttledCommitImpulseResponseStrength(value[0]);
};

const commitImpulseResponseStrengthFromSlider = (value: number[] | undefined) => {
  if (!value?.length) return;
  commitImpulseResponseStrength(value[0]);
};

const getImpulseResponseDisplayName = (name: string) => normalizeImpulseResponseName(name);

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
          player.audioEffect !== 'none' ||
          gains.some((g: number) => g !== 0) ||
          impulseResponseActive
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
            class="absolute top-2px"
            :style="{ right: '-12px' }"
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
        <button
          class="sidebar-item"
          :class="{ 'is-active': activeTab === 'irs' }"
          @click="activeTab = 'irs'"
        >
          空间音效
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
            <div class="effect-preset-grid">
              <button
                v-for="option in audioEffectOptions"
                :key="option.value"
                type="button"
                class="pm-item w-full! m-0!"
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

        <!-- IR 面板 -->
        <div v-if="activeTab === 'irs'" class="panel-content irs-panel-content">
          <div class="panel-header">
            <span class="panel-title">空间音效</span>
          </div>

          <div v-if="selectedImpulseResponse" class="irs-strength">
            <div class="irs-strength-label">
              <span>效果强度</span>
              <span>{{ impulseResponseStrength }}%</span>
            </div>
            <SliderRoot
              :model-value="[impulseResponseStrength]"
              :min="10"
              :max="100"
              :step="5"
              class="irs-strength-slider"
              style="width: 100%; min-width: 0"
              @update:model-value="updateImpulseResponseStrength"
              @value-commit="commitImpulseResponseStrengthFromSlider"
            >
              <SliderTrack class="irs-strength-track" style="width: 100%; min-width: 0">
                <SliderRange class="irs-strength-range" />
              </SliderTrack>
              <SliderThumb class="irs-strength-thumb" />
            </SliderRoot>
          </div>

          <Scrollbar
            class="panel-scroll irs-panel-scroll"
            :content-props="{ class: 'irs-scroll-wrap' }"
          >
            <div v-if="settingStore.impulseResponseFiles.length > 0" class="effect-preset-grid">
              <button
                type="button"
                class="pm-item w-full! m-0!"
                :class="{ 'is-active': !impulseResponseActive }"
                @click="toggleImpulseResponse"
              >
                <span class="pm-label text-center">原声</span>
              </button>
              <button
                v-for="file in settingStore.impulseResponseFiles"
                :key="file.id"
                type="button"
                class="pm-item irs-preset-item w-full! m-0!"
                :class="{
                  'is-active':
                    file.id === settingStore.selectedImpulseResponseId && impulseResponseActive,
                }"
                :title="getImpulseResponseDisplayName(file.name)"
                @click="selectImpulseResponse(file.id)"
              >
                <span class="pm-label text-center irs-preset-label">
                  {{ getImpulseResponseDisplayName(file.name) }}
                </span>
              </button>
            </div>
            <div v-else class="irs-panel-empty">暂无音效文件</div>
          </Scrollbar>
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
  background: var(--color-bg-elevated);
  border-color: var(--border-subtle);
  display: flex;
}

.effect-popover.echo-popover-content > div:first-child {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
}

.effect-layout {
  display: flex;
  width: 100%;
  height: 100%;
}

/* 侧边栏 */
.effect-sidebar {
  width: 80px;
  background: var(--control-muted-bg);
  display: flex;
  flex-direction: column;
  padding: 12px 6px;
  gap: 4px;
  border-right: 1px solid var(--border-subtle);
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
  background: var(--row-hover-bg);
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
  width: 100%;
  min-width: 0;
  align-self: stretch;
}

.panel-content {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  align-self: stretch;
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
  width: 100%;
  min-width: 0;
  align-self: stretch;
}

.irs-panel-content,
.irs-panel-content > *,
.irs-panel-scroll,
.effect-popover .irs-scroll-wrap,
.effect-popover .irs-scroll-wrap > .scrollbar-view {
  width: 100% !important;
  min-width: 0 !important;
  align-self: stretch !important;
  box-sizing: border-box;
}

.effect-popover .scroll-area,
.effect-popover .scrollbar-wrap,
.effect-popover .scrollbar-view {
  width: 100%;
  min-width: 0;
  align-self: stretch;
}

.effect-popover .pm-item {
  width: 100%;
  margin: 0;
  min-width: 0;
  min-height: 38px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--control-border);
  background: var(--control-muted-bg);
  color: var(--color-text-main);
  opacity: 0.82;
  align-items: center;
  justify-content: center;
  transition:
    background-color 0.16s ease,
    border-color 0.16s ease,
    color 0.16s ease,
    opacity 0.16s ease;
}

.effect-popover .pm-item:hover {
  border-color: color-mix(in srgb, var(--color-primary) 45%, transparent);
  background: color-mix(in srgb, var(--color-primary) 9%, transparent);
  color: var(--color-primary);
  opacity: 1;
}

.effect-popover .pm-item.is-active {
  border-color: var(--color-primary);
  background: var(--color-primary);
  color: white;
  opacity: 1;
}

.effect-popover .pm-label {
  min-width: 0;
  flex: 1;
  text-align: center;
}

.effect-preset-grid {
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  padding: 8px;
  box-sizing: border-box;
}

.effect-preset-grid > .pm-item {
  justify-self: stretch;
  align-self: stretch;
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

.irs-strength {
  flex-shrink: 0;
  width: 100%;
  min-width: 0;
  padding: 0 16px 12px;
  box-sizing: border-box;
}

.irs-strength-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-width: 0;
  margin-bottom: 8px;
  font-size: 11px;
  font-weight: 700;
  color: var(--color-text-main);
  opacity: 0.65;
}

.irs-strength-slider {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  height: 18px;
  user-select: none;
  touch-action: none;
  cursor: pointer;
  box-sizing: border-box;
}

.irs-strength-track {
  position: relative;
  flex: 1;
  width: 100%;
  min-width: 0;
  height: 4px;
  border-radius: 9999px;
  background: var(--control-track-bg);
  cursor: pointer;
}

.irs-strength-range {
  position: absolute;
  height: 100%;
  border-radius: 9999px;
  background: var(--color-primary);
}

.irs-strength-thumb {
  display: block;
  width: 14px;
  height: 14px;
  background: var(--control-thumb-bg);
  border: 1px solid var(--control-border);
  border-radius: 9999px;
  box-shadow: var(--shadow-control);
  outline: none;
  cursor: pointer;
}

.irs-preset-item {
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: 42px;
}

.irs-preset-label {
  display: -webkit-box;
  flex: 0 1 100%;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  font-size: 12px;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.irs-panel-empty {
  height: 210px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-main);
  opacity: 0.42;
  font-size: 12px;
  font-weight: 700;
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
  cursor: pointer;
  width: 100%;
  flex: 1;
}

.eq-track {
  position: relative;
  flex-grow: 1;
  border-radius: 9999px;
  width: 4px;
  background: var(--control-track-bg);
  cursor: pointer;
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
  background: var(--control-thumb-bg);
  border: 1px solid var(--control-border);
  border-radius: 9999px;
  box-shadow: var(--shadow-control);
  outline: none;
  cursor: pointer;
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
  background: var(--control-muted-bg);
  border: 1px solid var(--control-border);
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-main);
  opacity: 0.8;
  cursor: pointer;
  transition: all 0.2s;
}

.preset-chip:hover {
  opacity: 1;
  background: var(--control-hover-bg);
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.preset-chip.is-active {
  opacity: 1;
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: white;
}
</style>
