<script setup lang="ts">
import { computed, ref } from 'vue';
import { useDebounceFn, useThrottleFn } from '@vueuse/core';
import { SliderRoot, SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import { Icon } from '@iconify/vue';
import Popover from '@/components/ui/Popover.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import Button from '@/components/ui/Button.vue';
import Badge from '@/components/ui/Badge.vue';
import {
  iconCheckMark,
  iconCloudDownload,
  iconLoader2,
  iconRefreshCw,
  iconSlidersHorizontal,
} from '@/icons';
import { usePlayerControls } from '@/composables/usePlayerControls';
import { useToastStore } from '@/stores/toast';
import {
  getCommunityAudioEffects,
  getCommunityImpulseResponseUrl,
  getCommunityImpulseResponseUrls,
  type CommunityAudioEffect,
  type CommunityAudioEffectSort,
} from '@/api/audioEffect';
import type { AudioEffectValue } from '@/types';
import { normalizeImpulseResponseName } from '../../../shared/audio';

const {
  player,
  settingStore,
  currentTrack,
  isAudioEffectPresetSelectionDisabled,
  audioEffectButtonBadge,
  setAudioEffect,
} = usePlayerControls();
const toastStore = useToastStore();

type EffectTab = 'effect' | 'eq' | 'irs';
type ImpulseResponseLibraryTab = 'mine' | 'community';

const activeTab = ref<EffectTab>('effect');
const activeImpulseResponseLibraryTab = ref<ImpulseResponseLibraryTab>('mine');
const COMMUNITY_PAGE_SIZE = 20;
const COMMUNITY_AUTO_SCAN_PAGE_LIMIT = 5;
const communitySortOptions: readonly { value: CommunityAudioEffectSort; label: string }[] = [
  { value: 2, label: '默认' },
  { value: 3, label: '最热' },
  { value: 4, label: '最新' },
];
const communitySort = ref<CommunityAudioEffectSort>(2);
const communityEffects = ref<CommunityAudioEffect[]>([]);
const communityTotal = ref(0);
const communityPage = ref(0);
const communityLoading = ref(false);
const communityError = ref('');
const communityScrollbarRef = ref<InstanceType<typeof Scrollbar> | null>(null);
const downloadingCommunityEffectId = ref<number | null>(null);

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
const audioEffectPresetActive = computed(
  () => !isAudioEffectPresetSelectionDisabled.value && player.audioEffect !== 'none',
);
const isAudioEffectOptionActive = (effect: AudioEffectValue) =>
  isAudioEffectPresetSelectionDisabled.value ? effect === 'none' : player.audioEffect === effect;

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

const resetImpulseResponse = () => {
  settingStore.impulseResponseEnabled = false;
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

const hasMoreCommunityEffects = computed(
  () => communityEffects.value.length < communityTotal.value,
);
// 当前仅展示可由卷积引擎直接使用的 WAV；VPF 为 ViPER 私有预设，暂不支持。
const compatibleCommunityEffects = computed(() =>
  communityEffects.value.filter((effect) => getCommunityImpulseResponseUrl(effect)),
);
const selectTab = (tab: EffectTab) => {
  activeTab.value = tab;
};

const selectImpulseResponseLibraryTab = (tab: ImpulseResponseLibraryTab) => {
  activeImpulseResponseLibraryTab.value = tab;
  if (tab === 'community' && communityEffects.value.length === 0 && !communityLoading.value) {
    void loadCommunityEffects(true);
  }
};

const selectCommunitySort = (sort: CommunityAudioEffectSort) => {
  if (communityLoading.value || communitySort.value === sort) return;
  communitySort.value = sort;
  void loadCommunityEffects(true);
};

const refreshCommunityEffects = () => {
  void loadCommunityEffects(true);
};

const loadCommunityEffects = async (reset = false) => {
  if (communityLoading.value) return;
  communityLoading.value = true;
  communityError.value = '';
  let nextPage = reset ? 1 : communityPage.value + 1;
  let scannedPages = 0;
  try {
    if (reset) {
      communityEffects.value = [];
      communityScrollbarRef.value?.setScrollTop(0);
    }
    while (scannedPages < COMMUNITY_AUTO_SCAN_PAGE_LIMIT) {
      const result = await getCommunityAudioEffects(
        nextPage,
        COMMUNITY_PAGE_SIZE,
        communitySort.value,
      );
      const newItems = result.items.filter(
        (item) => !communityEffects.value.some((current) => current.id === item.id),
      );
      communityEffects.value = [...communityEffects.value, ...newItems];
      communityTotal.value = result.total;
      communityPage.value = result.page;
      scannedPages += 1;

      const foundActionableEffect = newItems.some(
        (effect) => getCommunityImpulseResponseUrl(effect) && !getDownloadedCommunityEffect(effect),
      );
      if (
        foundActionableEffect ||
        communityEffects.value.length >= communityTotal.value ||
        result.items.length === 0
      ) {
        break;
      }
      nextPage = result.page + 1;
    }
  } catch (error) {
    communityError.value = error instanceof Error ? error.message : '社区音效加载失败';
    if (communityEffects.value.length > 0) toastStore.warning(communityError.value);
  } finally {
    communityLoading.value = false;
  }
};

const isCommunityEffectActive = (effect: CommunityAudioEffect) =>
  settingStore.impulseResponseEnabled &&
  settingStore.selectedImpulseResponseId === `kugou-community-${effect.id}`;

const getDownloadedCommunityEffect = (effect: CommunityAudioEffect) =>
  settingStore.impulseResponseFiles.find((file) => file.id === `kugou-community-${effect.id}`) ??
  null;

const formatCommunityUserCount = (count: number) => {
  if (count >= 10_000) return `${(count / 10_000).toFixed(count >= 100_000 ? 0 : 1)} 万人使用`;
  return `${count} 人使用`;
};

const handleCommunityEffectAction = async (effect: CommunityAudioEffect) => {
  const urls = getCommunityImpulseResponseUrls(effect);
  if (urls.length === 0 || downloadingCommunityEffectId.value !== null) return;
  const downloaded = getDownloadedCommunityEffect(effect);
  if (downloaded) {
    if (isCommunityEffectActive(effect)) return;
    settingStore.setSelectedImpulseResponse(downloaded.id);
    toastStore.success(`已使用“${effect.name}”`);
    return;
  }

  downloadingCommunityEffectId.value = effect.id;
  try {
    const result = await window.electron.audioEffects.downloadCommunityImpulseResponse({
      modelId: effect.id,
      name: effect.name,
      urls,
    });
    if (!result.file) throw new Error(result.error || '音效文件下载失败');
    settingStore.addImpulseResponseFile(result.file, { select: false });
    const downloadedFile = result.file;
    toastStore.showAction(
      `已下载“${effect.name}”`,
      {
        label: '立即使用',
        handler: () => settingStore.setSelectedImpulseResponse(downloadedFile.id),
      },
      'success',
      6000,
    );
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '社区音效下载失败');
  } finally {
    downloadingCommunityEffectId.value = null;
  }
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
          audioEffectPresetActive || gains.some((g: number) => g !== 0) || impulseResponseActive
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
          @click="selectTab('effect')"
        >
          预设音效
        </button>
        <button
          class="sidebar-item"
          :class="{ 'is-active': activeTab === 'eq' }"
          @click="selectTab('eq')"
        >
          均衡器
        </button>
        <button
          class="sidebar-item"
          :class="{ 'is-active': activeTab === 'irs' }"
          @click="selectTab('irs')"
        >
          空间音效
        </button>
      </div>

      <!-- 右侧主内容 -->
      <div class="effect-main">
        <!-- 音效面板 -->
        <div v-if="activeTab === 'effect'" class="panel-content">
          <div class="panel-header">
            <span class="panel-title">预设音效</span>
          </div>
          <div v-if="isAudioEffectPresetSelectionDisabled" class="panel-hint">
            当前使用云盘文件播放
          </div>
          <Scrollbar class="panel-scroll">
            <div class="effect-preset-grid">
              <button
                v-for="option in audioEffectOptions"
                :key="option.value"
                type="button"
                class="pm-item w-full! m-0!"
                :class="{
                  'is-active': isAudioEffectOptionActive(option.value),
                  'is-disabled': isAudioEffectPresetSelectionDisabled,
                }"
                :disabled="isAudioEffectPresetSelectionDisabled"
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
          <div class="panel-header irs-panel-header">
            <span class="panel-title">空间音效</span>
            <div v-if="impulseResponseActive" class="irs-strength-inline">
              <span class="irs-strength-inline-label">强度</span>
              <SliderRoot
                :model-value="[impulseResponseStrength]"
                :min="10"
                :max="100"
                :step="5"
                class="irs-strength-slider"
                @update:model-value="updateImpulseResponseStrength"
                @value-commit="commitImpulseResponseStrengthFromSlider"
              >
                <SliderTrack class="irs-strength-track">
                  <SliderRange class="irs-strength-range" />
                </SliderTrack>
                <SliderThumb class="irs-strength-thumb" />
              </SliderRoot>
              <span class="irs-strength-inline-value">{{ impulseResponseStrength }}%</span>
            </div>
          </div>

          <div class="irs-library-nav">
            <div class="irs-library-tabs">
              <button
                type="button"
                :class="{ 'is-active': activeImpulseResponseLibraryTab === 'mine' }"
                @click="selectImpulseResponseLibraryTab('mine')"
              >
                我的音效
              </button>
              <button
                type="button"
                :class="{ 'is-active': activeImpulseResponseLibraryTab === 'community' }"
                @click="selectImpulseResponseLibraryTab('community')"
              >
                音效社区
              </button>
            </div>
          </div>

          <div
            v-if="activeImpulseResponseLibraryTab === 'community'"
            class="community-library-tools"
          >
            <div class="community-sort-tabs" role="tablist" aria-label="社区音效排序">
              <button
                v-for="option in communitySortOptions"
                :key="option.value"
                type="button"
                role="tab"
                :aria-selected="communitySort === option.value"
                :class="{ 'is-active': communitySort === option.value }"
                :disabled="communityLoading"
                @click="selectCommunitySort(option.value)"
              >
                {{ option.label }}
              </button>
            </div>
            <button
              type="button"
              class="community-refresh-button"
              :class="{ 'is-loading': communityLoading }"
              title="刷新音效社区"
              aria-label="刷新音效社区"
              :disabled="communityLoading"
              @click="refreshCommunityEffects"
            >
              <Icon :icon="iconRefreshCw" width="14" height="14" />
            </button>
          </div>

          <Scrollbar
            v-if="activeImpulseResponseLibraryTab === 'mine'"
            class="panel-scroll irs-panel-scroll"
            :content-props="{ class: 'irs-scroll-wrap' }"
          >
            <div v-if="settingStore.impulseResponseFiles.length > 0" class="effect-preset-grid">
              <button
                type="button"
                class="pm-item w-full! m-0!"
                :class="{ 'is-active': !impulseResponseActive }"
                @click="resetImpulseResponse"
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
            <div v-else class="irs-panel-empty">
              <span>暂无音效文件</span>
              <small>可前往设置导入，或从音效社区下载</small>
            </div>
          </Scrollbar>

          <Scrollbar
            v-else
            ref="communityScrollbarRef"
            class="panel-scroll community-panel-scroll"
            :content-props="{ class: 'community-scroll-wrap' }"
          >
            <div v-if="compatibleCommunityEffects.length > 0" class="community-effect-list">
              <div
                v-for="effect in compatibleCommunityEffects"
                :key="effect.id"
                class="community-effect-item"
                :class="{
                  'is-active': isCommunityEffectActive(effect),
                }"
                :title="effect.intro || effect.name"
              >
                <span class="community-effect-copy">
                  <span class="community-effect-name">{{ effect.name }}</span>
                  <span class="community-effect-meta">
                    {{ effect.author || '匿名创作者' }}
                    <template v-if="effect.tagName"> · {{ effect.tagName }}</template>
                    <template v-if="effect.userCount">
                      · {{ formatCommunityUserCount(effect.userCount) }}
                    </template>
                  </span>
                </span>
                <button
                  type="button"
                  class="community-effect-action"
                  :class="{ 'is-active': isCommunityEffectActive(effect) }"
                  :disabled="
                    isCommunityEffectActive(effect) ||
                    (downloadingCommunityEffectId !== null &&
                      downloadingCommunityEffectId !== effect.id)
                  "
                  @click.stop="handleCommunityEffectAction(effect)"
                >
                  <Icon
                    v-if="downloadingCommunityEffectId === effect.id"
                    :icon="iconLoader2"
                    width="14"
                    height="14"
                    class="community-spin"
                  />
                  <Icon
                    v-else-if="isCommunityEffectActive(effect)"
                    :icon="iconCheckMark"
                    width="14"
                    height="14"
                  />
                  <Icon
                    v-else-if="!getDownloadedCommunityEffect(effect)"
                    :icon="iconCloudDownload"
                    width="14"
                    height="14"
                  />
                  <span>{{
                    downloadingCommunityEffectId === effect.id
                      ? '下载中'
                      : isCommunityEffectActive(effect)
                        ? '使用中'
                        : getDownloadedCommunityEffect(effect)
                          ? '使用'
                          : '下载'
                  }}</span>
                </button>
              </div>

              <button
                v-if="hasMoreCommunityEffects"
                type="button"
                class="community-load-more"
                :disabled="communityLoading"
                @click="loadCommunityEffects(false)"
              >
                {{ communityLoading ? '加载中…' : '加载更多' }}
              </button>
            </div>

            <div v-else-if="communityLoading" class="community-panel-state">
              <Icon :icon="iconLoader2" width="18" height="18" class="community-spin" />
              <span>正在加载社区音效…</span>
            </div>
            <div v-else-if="communityError" class="community-panel-state">
              <span>{{ communityError }}</span>
              <button type="button" @click="loadCommunityEffects(true)">重试</button>
            </div>
            <div v-else class="community-panel-state">
              <span>{{ hasMoreCommunityEffects ? '暂未找到可用音效' : '暂无可用音效' }}</span>
              <button
                v-if="hasMoreCommunityEffects"
                type="button"
                @click="loadCommunityEffects(false)"
              >
                继续查找
              </button>
            </div>
          </Scrollbar>
        </div>
      </div>
    </div>
  </Popover>
</template>

<style>
.effect-popover.echo-popover-content {
  width: 480px;
  height: 380px;
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

.panel-hint {
  margin: -4px 16px 8px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.4;
  color: var(--color-text-secondary);
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

.effect-popover .pm-item.is-disabled {
  cursor: not-allowed;
  opacity: 0.38;
}

.effect-popover .pm-item.is-disabled:hover {
  border-color: var(--control-border);
  background: var(--control-muted-bg);
  color: var(--color-text-main);
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

.irs-panel-header {
  gap: 16px;
}

.irs-strength-inline {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.irs-strength-inline-label,
.irs-strength-inline-value {
  flex: 0 0 auto;
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
}

.irs-strength-inline-value {
  width: 32px;
  text-align: right;
}

.irs-strength-slider {
  position: relative;
  display: flex;
  align-items: center;
  width: 132px;
  min-width: 0;
  flex: 0 0 132px;
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
  height: 170px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--color-text-main);
  opacity: 0.42;
  font-size: 12px;
  font-weight: 700;
}

.irs-panel-empty small {
  font-size: 10px;
  font-weight: 500;
}

.irs-library-nav {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 10px 8px;
}

.irs-library-tabs {
  display: grid;
  min-width: 0;
  flex: 1;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  padding: 3px;
  border-radius: 8px;
  background: var(--control-muted-bg);
}

.irs-library-tabs button {
  height: 26px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}

.irs-library-tabs button:hover {
  color: var(--color-text-main);
}

.irs-library-tabs button.is-active {
  background: var(--color-bg-elevated);
  color: var(--color-primary);
  box-shadow: var(--shadow-control);
}

.community-library-tools {
  display: flex;
  width: 100%;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px 8px;
  box-sizing: border-box;
}

.community-sort-tabs {
  display: flex;
  align-items: center;
  padding: 2px;
  border-radius: 7px;
  background: var(--control-muted-bg);
}

.community-sort-tabs button {
  min-width: 48px;
  height: 24px;
  padding: 0 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
}

.community-sort-tabs button:hover:not(:disabled) {
  color: var(--color-primary);
}

.community-sort-tabs button.is-active {
  background: var(--color-bg-elevated);
  color: var(--color-primary);
  box-shadow: var(--shadow-control);
}

.community-sort-tabs button:disabled {
  cursor: wait;
  opacity: 0.58;
}

.community-refresh-button {
  display: inline-flex;
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.community-refresh-button:hover:not(:disabled) {
  background: var(--control-hover-bg);
  color: var(--color-primary);
}

.community-refresh-button:disabled {
  cursor: wait;
  opacity: 0.5;
}

.community-refresh-button.is-loading svg {
  animation: community-effect-spin 0.8s linear infinite;
}

.community-panel-scroll,
.effect-popover .community-scroll-wrap,
.effect-popover .community-scroll-wrap > .scrollbar-view {
  width: 100% !important;
  min-width: 0 !important;
  align-self: stretch !important;
  box-sizing: border-box;
}

.community-effect-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 0 10px 10px;
}

.community-effect-item {
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: 52px;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--control-border);
  border-radius: 9px;
  background: var(--control-muted-bg);
  color: var(--color-text-main);
  text-align: left;
}

.community-effect-item:hover,
.community-effect-item.is-active {
  border-color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 9%, transparent);
}

.community-effect-item.is-active .community-effect-name,
.community-effect-item:hover .community-effect-action:not(.is-active) {
  color: var(--color-primary);
}

.community-effect-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}

.community-effect-name {
  overflow: hidden;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.community-effect-meta {
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: 10px;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.community-effect-action {
  display: inline-flex;
  flex: 0 0 auto;
  min-width: 62px;
  height: 28px;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0 8px;
  border: 1px solid var(--control-border);
  border-radius: 7px;
  background: var(--color-bg-elevated);
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
}

.community-effect-action:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.community-effect-action.is-active {
  border-color: var(--color-primary);
  background: var(--color-primary);
  color: white;
}

.community-effect-action:disabled {
  cursor: default;
  opacity: 0.72;
}

.community-load-more {
  height: 30px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--color-primary);
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}

.community-load-more:hover:not(:disabled) {
  background: var(--control-hover-bg);
}

.community-load-more:disabled {
  cursor: wait;
  opacity: 0.55;
}

.community-panel-state {
  display: flex;
  min-height: 150px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 600;
}

.community-panel-state button {
  border: 0;
  background: transparent;
  color: var(--color-primary);
  cursor: pointer;
  font-weight: 700;
}

.community-spin {
  animation: community-effect-spin 0.8s linear infinite;
}

@keyframes community-effect-spin {
  to {
    transform: rotate(360deg);
  }
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
