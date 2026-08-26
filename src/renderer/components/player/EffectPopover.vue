<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { useThrottleFn } from '@vueuse/core';
import {
  SliderRoot,
  SliderTrack,
  SliderRange,
  SliderThumb,
  TabsRoot,
  TabsList,
  TabsTrigger,
  TabsContent,
} from 'reka-ui';
import { Icon } from '@iconify/vue';
import Popover from '@/components/ui/Popover.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import Button from '@/components/ui/Button.vue';
import Badge from '@/components/ui/Badge.vue';
import Select from '@/components/ui/Select.vue';
import { iconArrowLeft, iconSettings, iconSlidersHorizontal } from '@/icons';
import { usePlayerControls } from '@/composables/usePlayerControls';
import EffectPlaza from './EffectPlaza.vue';
import { useAudioEffectPlaza } from '@/composables/useAudioEffectPlaza';
import type { AudioEffectValue } from '@/types';
import { normalizeAudioEffectName, type SpatialAudioEffectEntry } from '../../../shared/audio';
import type {
  DspJsonValue,
  DspProviderControl,
  DspProviderManifest,
  DspProviderPreset,
  DspProviderRuntimeState,
} from '../../../shared/player-audio-graph';
import {
  configurablePresetControls,
  controlDefault,
  controlVisible,
  makeDspPresetJson,
  parseDspPreset,
  presetControls,
  presetControlValues,
  runtimeMatchesPreset,
  validControlValue,
  type DspControlValues,
} from '../../../shared/dsp-provider-settings';

const {
  player,
  settingStore,
  currentTrack,
  isAudioEffectPresetSelectionDisabled,
  audioEffectButtonBadge,
  setAudioEffect,
} = usePlayerControls();

type EffectTab = 'effect' | 'eq' | 'irs' | 'plaza';
type ImpulseResponseLibraryTab = 'mine' | 'engine';

const activeTab = ref<EffectTab>('effect');
const effectPopoverOpen = ref(false);
const providerSettingsOpen = ref(false);
const providerSettingsPanel = ref<HTMLElement | null>(null);
const providerSettingsPanelId = useId();
let providerSettingsTrigger: HTMLElement | null = null;
const editingProviderPresetId = ref('');
const activeImpulseResponseLibraryTab = ref<ImpulseResponseLibraryTab>(
  settingStore.dspProviderEnabled && settingStore.dspProviderPath ? 'engine' : 'mine',
);
const audioEffectOptions: readonly { value: AudioEffectValue; label: string }[] = [
  { value: 'none', label: '原声' },
  { value: 'piano', label: '钢琴' },
  { value: 'vocal', label: '人声' },
  { value: 'accompaniment', label: '伴奏' },
  { value: 'subwoofer', label: '骨笛' },
  { value: 'ancient', label: '尤克里里' },
  { value: 'surnay', label: '唢呐' },
  { value: 'dj', label: 'DJ' },
  { value: 'viper_atmos', label: '蝰蛇全景声' },
  { value: 'viper_clear', label: '蝰蛇超清' },
];

// 内置曲线已按对数频率重采样到当前标准 10 段，运行时不做旧频点迁移。
const eqPresets = [
  { name: '默认', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: '流行', gains: [3, 3, 2.3, 0.7, -1.4, -4, -4, -3.2, -1.2, 3] },
  { name: '摇滚', gains: [5, 5, 4.3, 3.4, 0.8, -1, -1, -0.6, 1.2, 5] },
  { name: '古典', gains: [4, 4, 3.3, 2.4, 1.3, 0, 0, 0.4, 1.4, 4] },
  { name: '爵士', gains: [3, 3, 2.3, 1.4, 1.7, -1, -1, -0.6, 0.4, 3] },
  { name: '电子', gains: [6, 6, 5.3, 1.8, -1.4, -4, -1.5, 0.8, 2.8, 6] },
  { name: '重金属', gains: [4, 4.1, 5.4, 4.7, 1.1, -2, -0.7, 0.8, 3.2, 4] },
  { name: '民谣', gains: [2, 2, 1.3, 0.4, 0.7, 2, 2, 1.6, 0.6, 2] },
];

const frequencies = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
const gains = computed(() => player.equalizerGains);
const selectedImpulseResponse = computed(() => settingStore.getSelectedImpulseResponse());
const impulseResponseActive = computed(
  () => settingStore.impulseResponseEnabled && !!selectedImpulseResponse.value,
);
const providerRuntimeState = computed<DspProviderRuntimeState | null>(() => {
  const value = player.playbackDiagnostics.graph?.providerStateJson;
  if (!value) return null;
  try {
    return JSON.parse(value) as DspProviderRuntimeState;
  } catch {
    return null;
  }
});
const providerManifest = computed<DspProviderManifest | null>(() => {
  const value = player.playbackDiagnostics.graph?.providerManifestJson;
  if (!value) return null;
  try {
    const manifest = JSON.parse(value) as DspProviderManifest;
    return typeof manifest === 'object' && manifest !== null ? manifest : null;
  } catch {
    return null;
  }
});
const providerControls = computed<DspProviderControl[]>(() =>
  configurablePresetControls(providerManifest.value, editingProviderPresetId.value),
);
const providerPresets = computed(() => providerManifest.value?.presets ?? []);
const providerPresetAvailable = (preset: DspProviderPreset) => {
  const rate = player.playbackDiagnostics.graph?.processFormat.sampleRate;
  return !rate || !preset.supportedSampleRates || preset.supportedSampleRates.includes(rate);
};
const providerPresetDescription = (preset: DspProviderPreset) =>
  providerPresetAvailable(preset)
    ? preset.description
    : `当前采样率不支持此音效，支持 ${preset.supportedSampleRates?.map((rate) => rate / 1000).join(' / ')} kHz`;
const providerDisplayName = computed(
  () =>
    providerManifest.value?.displayName?.trim() ||
    player.playbackDiagnostics.graph?.providerId ||
    '第三方音效引擎',
);
const activeProviderMode = computed(() => settingStore.dspProviderMode);
const providerVpfSupport = computed<'supported' | 'unsupported' | 'unknown'>(() => {
  const resources = providerManifest.value?.resources;
  if (!resources) return 'unknown';
  return resources.some(
    (resource) =>
      resource.kind.toLowerCase() === 'vpf' ||
      resource.extensions?.some((extension) => extension.toLowerCase() === '.vpf'),
  )
    ? 'supported'
    : 'unsupported';
});
const providerResourceSummary = computed(() => {
  const resources = providerManifest.value?.resources;
  if (!resources) return [];
  return resources.map((resource) => ({
    kind: resource.kind,
    extensions: resource.extensions?.join(', ') || '任意扩展名',
  }));
});
const effectiveProviderPresetJson = computed(() => settingStore.dspProviderPresetJson.trim());
const activeProviderPresetId = computed(
  () => parseDspPreset(effectiveProviderPresetJson.value).presetId,
);
const editingProviderPreset = computed(() =>
  providerPresets.value.find((p) => p.id === editingProviderPresetId.value),
);
const providerEngineId = computed(() => player.playbackDiagnostics.graph?.providerId ?? '');
const editingProviderPresetActive = computed(
  () =>
    !impulseResponseActive.value &&
    !!editingProviderPresetId.value &&
    editingProviderPresetId.value === activeProviderPresetId.value,
);
const editingProviderPresetJson = computed(() =>
  editingProviderPresetActive.value
    ? effectiveProviderPresetJson.value
    : settingStore.getDspProviderPreset(providerEngineId.value, editingProviderPresetId.value),
);
const providerValues = ref<DspControlValues>({});
watch(
  [
    editingProviderPresetJson,
    editingProviderPresetId,
    providerSettingsOpen,
    () => JSON.stringify(providerControls.value),
    providerEngineId,
    activeProviderMode,
  ],
  () => {
    providerValues.value = presetControlValues(
      providerControls.value,
      editingProviderPresetJson.value,
    );
  },
  { immediate: true },
);
const providerRuntimeCurrent = computed(
  () =>
    editingProviderPresetActive.value &&
    runtimeMatchesPreset(providerRuntimeState.value, editingProviderPresetId.value) &&
    player.playbackDiagnostics.graph?.providerPath === settingStore.dspProviderPath &&
    player.playbackDiagnostics.graph?.providerMode === activeProviderMode.value &&
    player.playbackDiagnostics.graph?.providerPresetJson === effectiveProviderPresetJson.value,
);
const visibleProviderControls = computed(() =>
  providerControls.value.filter((c) => controlVisible(c, providerValues.value)),
);
const providerSettingsApplied = computed(
  () =>
    providerRuntimeCurrent.value &&
    providerControls.value.every(
      (c) =>
        c.ownership === 'host' ||
        c.ownership === 'disabled' ||
        JSON.stringify(providerRuntimeState.value?.controls?.[c.id]?.value) ===
          JSON.stringify(providerValues.value[c.id]?.value),
    ),
);
const providerControlLabel = (control: DspProviderControl) => {
  const value = providerControlValue(control);
  return (
    control.options?.find((o) => JSON.stringify(o.value) === JSON.stringify(value))?.label ??
    (typeof value === 'boolean' ? (value ? '开启' : '关闭') : String(value))
  );
};
const providerEffectActive = computed(
  () =>
    activeProviderPresetId.value.length > 0 || effectiveProviderPresetJson.value.trim().length > 0,
);
const providerControlValue = (control: DspProviderControl): DspJsonValue =>
  providerValues.value[control.id]?.value ?? controlDefault(control);
const providerControlDisabled = (control: DspProviderControl) =>
  !providerSettingsOpen.value ||
  control.ownership === 'disabled' ||
  control.ownership === 'host' ||
  (providerRuntimeCurrent.value &&
    ['disabled', 'host'].includes(
      providerRuntimeState.value?.controls?.[control.id]?.ownership ?? '',
    ));
const setProviderMode = (mode: 'headphone' | 'speaker') => {
  if (!player.playbackDiagnostics.graph?.providerPath || activeProviderMode.value === mode) return;
  const id = activeProviderPresetId.value;
  settingStore.rememberDspProviderPreset(providerEngineId.value);
  settingStore.$patch(() => {
    settingStore.setDspProviderMode(mode);
    if (id)
      settingStore.setDspProviderPreset(
        makeDspPresetJson(
          id,
          presetControls(providerManifest.value, id),
          settingStore.getDspProviderPreset(providerEngineId.value, id),
        ),
        providerEngineId.value,
      );
  });
};
const previewProviderControl = (control: DspProviderControl, value: DspJsonValue) => {
  if (!providerControlDisabled(control) && validControlValue(control, value)) {
    providerValues.value = { ...providerValues.value, [control.id]: { value } };
  }
};
const setProviderControl = (control: DspProviderControl, value: DspJsonValue) => {
  if (
    providerControlDisabled(control) ||
    !player.playbackDiagnostics.graph?.providerPath ||
    !editingProviderPresetId.value ||
    !validControlValue(control, value)
  ) {
    return;
  }
  previewProviderControl(control, value);
  const presetJson = makeDspPresetJson(
    editingProviderPresetId.value,
    presetControls(providerManifest.value, editingProviderPresetId.value),
    JSON.stringify({
      presetId: editingProviderPresetId.value,
      controls: {
        ...parseDspPreset(editingProviderPresetJson.value).controls,
        ...providerValues.value,
      },
    }),
  );
  if (presetJson !== editingProviderPresetJson.value)
    settingStore.saveDspProviderPresetSettings(presetJson, providerEngineId.value);
};
const providerSelectOptions = (control: DspProviderControl) =>
  (control.options ?? []).map((option) => ({
    label: option.label,
    value: JSON.stringify(option.value),
  }));
const setProviderSelect = (
  control: DspProviderControl,
  value: string | number | (string | number)[],
) => {
  const option = control.options?.find((item) => JSON.stringify(item.value) === value);
  if (option) setProviderControl(control, option.value);
};
const resetProviderControls = () => {
  if (!editingProviderPresetId.value || !providerSettingsOpen.value) return;
  const json = makeDspPresetJson(
    editingProviderPresetId.value,
    presetControls(providerManifest.value, editingProviderPresetId.value),
  );
  providerValues.value = presetControlValues(providerControls.value, json);
  if (json !== editingProviderPresetJson.value)
    settingStore.saveDspProviderPresetSettings(json, providerEngineId.value);
};
const openProviderSettings = async (presetId: string, event: MouseEvent) => {
  if (!configurablePresetControls(providerManifest.value, presetId).length) return;
  providerSettingsTrigger = event.currentTarget as HTMLElement | null;
  editingProviderPresetId.value = presetId;
  providerSettingsOpen.value = true;
  await nextTick();
  providerSettingsPanel.value?.focus({ preventScroll: true });
};
const closeProviderSettings = async () => {
  providerSettingsOpen.value = false;
  await nextTick();
  if (effectPopoverOpen.value) providerSettingsTrigger?.focus({ preventScroll: true });
};
watch(effectPopoverOpen, (open) => {
  if (!open) providerSettingsOpen.value = false;
});
// An open editor must never write into a newly loaded engine or output-mode bank.
watch([providerEngineId, () => settingStore.dspProviderPath, activeProviderMode], () => {
  providerSettingsOpen.value = false;
});
watch(providerControls, (controls) => {
  if (!controls.length) providerSettingsOpen.value = false;
});
const setProviderPreset = (presetId: string) => {
  if (!player.playbackDiagnostics.graph?.providerPath) return;
  const preset = providerPresets.value.find((item) => item.id === presetId);
  if (!preset || !providerPresetAvailable(preset)) return;
  if (
    !impulseResponseActive.value &&
    providerEffectActive.value &&
    activeProviderPresetId.value === presetId
  ) {
    return;
  }
  settingStore.rememberDspProviderPreset(providerEngineId.value);
  settingStore.selectDspProviderPreset(
    makeDspPresetJson(
      presetId,
      presetControls(providerManifest.value, presetId),
      settingStore.getDspProviderPreset(providerEngineId.value, presetId),
    ),
    providerEngineId.value,
  );
};
const providerEqLocked = computed(() => {
  const ownership = providerRuntimeState.value?.controlPolicy?.eq;
  return ownership === 'provider' || ownership === 'disabled';
});
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
  if (!value || providerEqLocked.value) return;
  const newGains = [...gains.value];
  newGains[index] = value[0];
  // 立即更新 UI 状态
  player.equalizerGains = newGains;
  // 节流更新后端
  throttledSetEq(newGains);
};

const applyEqPreset = (presetGains: number[]) => {
  if (providerEqLocked.value) return;
  player.setEq([...presetGains]);
};

const isPresetActive = (presetGains: number[]) => {
  return gains.value.every((g, i) => Math.abs(g - presetGains[i]) < 0.1);
};

const resetGains = () => {
  if (providerEqLocked.value) return;
  player.setEq([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
};

const resetImpulseResponse = () => {
  if (!impulseResponseActive.value && !providerEffectActive.value) return;
  settingStore.rememberDspProviderPreset(providerEngineId.value);
  settingStore.selectOriginalSpatialAudio();
};

const selectImpulseResponse = (id: string) => {
  settingStore.setSelectedImpulseResponse(id);
};

const currentPlaybackEffectSelection = computed(() => {
  if (impulseResponseActive.value && selectedImpulseResponse.value) {
    const effect = selectedImpulseResponse.value;
    const type = effect.kind === 'imported-ir' ? '本地卷积音效' : '在线音效';
    return {
      active: true,
      name: getImpulseResponseDisplayName(effect.name),
      type,
      detail: player.playbackDiagnostics.graph?.providerId
        ? `由 ${providerDisplayName.value} 处理`
        : '由内置音效引擎处理',
    };
  }

  const presetId = activeProviderPresetId.value;
  const preset = providerPresets.value.find((item) => item.id === presetId);
  if (presetId && preset) {
    return {
      active: true,
      name: preset.label,
      type: '引擎预设',
      detail: providerDisplayName.value,
    };
  }

  if (providerEffectActive.value) {
    return {
      active: true,
      name: '自定义调节',
      type: '引擎音效',
      detail: providerDisplayName.value,
    };
  }

  return {
    active: false,
    name: '原声',
    type: '原声',
    detail: player.playbackDiagnostics.graph?.providerId
      ? `${providerDisplayName.value} 已就绪`
      : '未启用第三方音效引擎',
  };
});

const getImpulseResponseDisplayName = (name: string) => normalizeAudioEffectName(name);

const myEffectSources = [
  { id: 'local', label: '本地导入' },
  { id: 'artist', label: '歌手音效' },
  { id: 'headphone', label: '耳机音效' },
  { id: 'market', label: '音效市场' },
] as const;
type MyEffectSource = (typeof myEffectSources)[number]['id'];
const getMyEffectSource = (file: SpatialAudioEffectEntry): MyEffectSource => {
  if (file.kind === 'imported-ir') return 'local';
  return file.source === 'artist' || file.source === 'headphone' ? file.source : 'market';
};
const initialSelectedEffect = settingStore.getSelectedImpulseResponse();
const activeMyEffectSource = ref<string>(
  initialSelectedEffect ? getMyEffectSource(initialSelectedEffect) : 'local',
);
const myEffectGroups = computed(() =>
  myEffectSources.map((group) => ({
    ...group,
    files: settingStore.impulseResponseFiles.filter((file) => getMyEffectSource(file) === group.id),
  })),
);

const plaza = useAudioEffectPlaza(providerVpfSupport);
const selectTab = (tab: EffectTab) => {
  providerSettingsOpen.value = false;
  activeTab.value = tab;
  if (tab === 'plaza') plaza.ensureLoaded();
};
const selectImpulseResponseLibraryTab = (tab: ImpulseResponseLibraryTab) => {
  activeImpulseResponseLibraryTab.value = tab;
};
const openMyEffectPlaza = (source: MyEffectSource) => {
  if (source === 'local') return;
  plaza.selectCategory(source);
  selectTab('plaza');
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
    v-model:open="effectPopoverOpen"
    :trigger="providerSettingsOpen ? 'click' : 'hover'"
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
          歌曲音效
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
          音效
        </button>
        <button
          type="button"
          class="sidebar-item"
          :class="{ 'is-active': activeTab === 'plaza' }"
          @click="selectTab('plaza')"
        >
          音效广场
        </button>
      </div>

      <!-- 右侧主内容 -->
      <div v-show="!providerSettingsOpen" class="effect-main">
        <EffectPlaza v-if="activeTab === 'plaza'" :plaza="plaza" />
        <!-- 音效面板 -->
        <div v-if="activeTab === 'effect'" class="panel-content">
          <div class="panel-header">
            <span class="panel-title">歌曲音效</span>
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
            <button class="reset-btn" :disabled="providerEqLocked" @click="resetGains">重置</button>
          </div>

          <div v-if="providerEqLocked" class="panel-hint eq-bypass-hint">
            当前音效已包含 EQ 设置，EQ 均衡器暂不可调节
          </div>

          <div class="eq-container" :class="{ 'is-disabled': providerEqLocked }">
            <div class="eq-bands">
              <div v-for="(gain, index) in gains" :key="index" class="eq-band">
                <SliderRoot
                  :model-value="[gain]"
                  :min="-12"
                  :max="12"
                  :step="0.1"
                  :disabled="providerEqLocked"
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
                :disabled="providerEqLocked"
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
            <span class="panel-title">音效</span>
            <button
              type="button"
              class="original-effect-button"
              :class="{ 'is-active': !impulseResponseActive && !providerEffectActive }"
              :aria-pressed="!impulseResponseActive && !providerEffectActive"
              title="关闭音效文件和引擎预设，保留均衡器设置"
              @click="resetImpulseResponse"
            >
              原声
            </button>
          </div>

          <div
            class="current-spatial-effect"
            :class="{ 'is-active': currentPlaybackEffectSelection.active }"
          >
            <div class="current-spatial-effect-copy">
              <span class="current-spatial-effect-eyebrow">当前音效</span>
              <strong>{{ currentPlaybackEffectSelection.name }}</strong>
              <small>{{ currentPlaybackEffectSelection.detail }}</small>
            </div>
            <span class="current-spatial-effect-type">
              {{ currentPlaybackEffectSelection.type }}
            </span>
          </div>

          <div class="irs-library-nav">
            <div class="irs-library-tabs">
              <button
                type="button"
                :class="{ 'is-active': activeImpulseResponseLibraryTab === 'engine' }"
                @click="selectImpulseResponseLibraryTab('engine')"
              >
                引擎预设
              </button>
              <button
                type="button"
                :class="{ 'is-active': activeImpulseResponseLibraryTab === 'mine' }"
                @click="selectImpulseResponseLibraryTab('mine')"
              >
                我的音效
              </button>
            </div>
          </div>

          <TabsRoot
            v-if="activeImpulseResponseLibraryTab === 'mine'"
            v-model="activeMyEffectSource"
            class="my-effect-library"
          >
            <TabsList class="my-effect-source-tabs" aria-label="我的音效分类">
              <TabsTrigger
                v-for="group in myEffectGroups"
                :key="group.id"
                :value="group.id"
                class="my-effect-source-tab"
              >
                <span>{{ group.label }}</span>
                <small>{{ group.files.length }}</small>
              </TabsTrigger>
            </TabsList>
            <TabsContent
              v-for="group in myEffectGroups"
              :key="group.id"
              :value="group.id"
              class="my-effect-tab-panel"
            >
              <Scrollbar
                class="panel-scroll irs-panel-scroll"
                :content-props="{ class: 'irs-scroll-wrap' }"
              >
                <div v-if="group.files.length" class="effect-preset-grid">
                  <button
                    v-for="file in group.files"
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
                <div v-else class="my-effect-empty">
                  <span>{{
                    group.id === 'local' ? '暂无本地导入音效' : '此分类暂无已下载音效'
                  }}</span>
                  <small v-if="group.id === 'local'">在「设置 → 音效管理」中导入音效文件</small>
                  <template v-else>
                    <small>前往音效广场，找到喜欢的音效</small>
                    <button type="button" @click="openMyEffectPlaza(group.id)">去音效广场</button>
                  </template>
                </div>
              </Scrollbar>
            </TabsContent>
          </TabsRoot>

          <Scrollbar
            v-else
            class="panel-scroll provider-panel-scroll"
            :content-props="{ class: 'provider-scroll-wrap' }"
          >
            <div v-if="player.playbackDiagnostics.graph?.providerId" class="provider-panel-body">
              <section class="spatial-provider-card">
                <div class="provider-card-heading">
                  <span class="provider-card-copy">
                    <strong>{{ providerDisplayName }}</strong>
                    <small v-if="player.playbackDiagnostics.graph.providerVersion">
                      v{{ player.playbackDiagnostics.graph.providerVersion }}
                    </small>
                  </span>
                  <span class="provider-status-dot">运行中</span>
                </div>

                <div class="provider-mode-row">
                  <span>输出设备</span>
                  <div class="spatial-provider-mode-tabs">
                    <button
                      type="button"
                      :class="{ 'is-active': activeProviderMode === 'speaker' }"
                      @click="setProviderMode('speaker')"
                    >
                      扬声器
                    </button>
                    <button
                      type="button"
                      :class="{ 'is-active': activeProviderMode === 'headphone' }"
                      @click="setProviderMode('headphone')"
                    >
                      耳机
                    </button>
                  </div>
                </div>

                <div class="provider-capabilities">
                  <span
                    class="provider-capability"
                    :class="{ 'is-supported': providerVpfSupport === 'supported' }"
                  >
                    VPF
                    {{
                      providerVpfSupport === 'supported'
                        ? '支持'
                        : providerVpfSupport === 'unsupported'
                          ? '不支持'
                          : '未声明'
                    }}
                  </span>
                  <span
                    v-for="resource in providerResourceSummary"
                    :key="resource.kind"
                    class="provider-capability"
                    :title="resource.extensions"
                  >
                    {{ resource.kind }}
                  </span>
                </div>
              </section>

              <section v-if="providerPresets.length > 0" class="provider-section">
                <div class="provider-section-heading">
                  <strong>引擎预设</strong>
                  <span>由当前音效引擎提供</span>
                </div>
                <div class="provider-preset-grid">
                  <div
                    v-for="preset in providerPresets"
                    :key="preset.id"
                    class="provider-preset-option"
                    :class="{
                      'is-active': !impulseResponseActive && activeProviderPresetId === preset.id,
                    }"
                  >
                    <button
                      type="button"
                      class="provider-preset-button"
                      :aria-pressed="!impulseResponseActive && activeProviderPresetId === preset.id"
                      :title="providerPresetDescription(preset)"
                      :disabled="!providerPresetAvailable(preset)"
                      @click="setProviderPreset(preset.id)"
                    >
                      <span>{{ preset.label }}</span>
                    </button>
                    <button
                      v-if="configurablePresetControls(providerManifest, preset.id).length"
                      type="button"
                      class="provider-preset-settings"
                      :aria-label="`${preset.label}设置`"
                      :title="`${preset.label}设置`"
                      :aria-controls="providerSettingsPanelId"
                      :aria-expanded="providerSettingsOpen && editingProviderPresetId === preset.id"
                      @click.stop="openProviderSettings(preset.id, $event)"
                    >
                      <Icon :icon="iconSettings" width="15" height="15" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </section>

              <div v-if="providerPresets.length === 0" class="provider-empty-note">
                当前引擎没有声明额外预设。
              </div>
            </div>
            <div v-else class="provider-panel-empty">
              <strong>尚未启用音效引擎</strong>
              <span>请前往“设置 → 音效管理”导入第三方音效引擎</span>
            </div>
          </Scrollbar>
        </div>
      </div>
      <section
        v-if="providerSettingsOpen"
        :id="providerSettingsPanelId"
        ref="providerSettingsPanel"
        class="effect-main provider-settings-view"
        :aria-label="`${editingProviderPreset?.label || '音效'}设置`"
        tabindex="-1"
        @keydown.esc.stop.prevent="closeProviderSettings"
      >
        <div class="provider-settings-header">
          <button
            type="button"
            class="provider-settings-back"
            aria-label="返回引擎预设"
            title="返回引擎预设"
            @click="closeProviderSettings"
          >
            <Icon :icon="iconArrowLeft" width="18" height="18" aria-hidden="true" />
          </button>
          <div class="provider-settings-heading">
            <strong>{{ editingProviderPreset?.label || '音效' }}设置</strong>
            <small
              >{{ providerDisplayName }} ·
              {{ activeProviderMode === 'headphone' ? '耳机' : '扬声器' }}</small
            >
          </div>
          <Button variant="ghost" size="xs" @click="resetProviderControls">恢复默认</Button>
        </div>
        <Scrollbar class="panel-scroll provider-settings-scroll">
          <section class="provider-settings-panel">
            <p class="provider-settings-note" role="status">
              {{
                editingProviderPresetActive
                  ? providerSettingsApplied
                    ? '已应用 · 滑杆松手后生效'
                    : '等待应用 · 滑杆松手后生效'
                  : '参数自动保存，选用此音效时生效'
              }}
            </p>
            <div class="provider-controls">
              <div
                v-for="control in visibleProviderControls"
                :key="control.id"
                class="provider-control"
                :class="{ 'is-disabled': providerControlDisabled(control) }"
              >
                <label class="provider-control-label">
                  <span>{{ control.label || control.id }}</span>
                  <span class="provider-control-value">
                    {{ providerControlLabel(control) }}{{ control.unit || '' }}
                  </span>
                </label>
                <div
                  v-if="
                    control.type === 'number' && typeof providerControlValue(control) === 'number'
                  "
                  class="provider-number-control"
                >
                  <SliderRoot
                    :model-value="[providerControlValue(control) as number]"
                    :min="control.range?.min ?? 0"
                    :max="control.range?.max ?? 1"
                    :step="control.range?.step ?? 0.01"
                    :inverted="control.range?.inverted ?? false"
                    :disabled="providerControlDisabled(control)"
                    class="provider-slider"
                    :aria-label="control.label || control.id"
                    @update:model-value="
                      (value) => previewProviderControl(control, value?.[0] ?? 0)
                    "
                    @value-commit="(value) => setProviderControl(control, value?.[0] ?? 0)"
                  >
                    <SliderTrack class="provider-slider-track">
                      <SliderRange class="provider-slider-range" />
                    </SliderTrack>
                    <SliderThumb class="provider-slider-thumb" />
                  </SliderRoot>
                  <div
                    v-if="control.range?.minLabel || control.range?.maxLabel"
                    class="provider-slider-labels"
                    aria-hidden="true"
                  >
                    <span>{{
                      control.range.inverted ? control.range.maxLabel : control.range.minLabel
                    }}</span>
                    <span>{{
                      control.range.inverted ? control.range.minLabel : control.range.maxLabel
                    }}</span>
                  </div>
                </div>
                <label v-else-if="control.type === 'boolean'" class="provider-checkbox">
                  <input
                    type="checkbox"
                    :checked="providerControlValue(control) === true"
                    :disabled="providerControlDisabled(control)"
                    @change="
                      setProviderControl(control, ($event.target as HTMLInputElement).checked)
                    "
                  />
                  <span>{{ providerControlValue(control) ? '开启' : '关闭' }}</span>
                </label>
                <Select
                  v-else-if="control.type === 'select'"
                  :model-value="JSON.stringify(providerControlValue(control))"
                  :options="providerSelectOptions(control)"
                  :disabled="providerControlDisabled(control)"
                  class="provider-select"
                  :aria-label="control.label || control.id"
                  @update:model-value="(value) => setProviderSelect(control, value)"
                />
                <span v-else class="provider-value">
                  {{ JSON.stringify(providerControlValue(control)) }}
                </span>
                <small v-if="control.description" class="provider-settings-note">{{
                  control.description
                }}</small>
              </div>
            </div>
          </section>
        </Scrollbar>
      </section>
    </div>
  </Popover>
</template>

<style>
.provider-settings-note {
  display: block;
  margin: 6px 0 0;
  color: var(--color-text-secondary);
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.provider-settings-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 0 14px 14px;
}
.provider-settings-view {
  min-height: 0;
  outline: none;
}
.provider-settings-header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  padding: 12px 10px;
}
.provider-settings-back {
  display: inline-flex;
  flex: 0 0 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-main);
  cursor: pointer;
}
.provider-settings-back:hover {
  background: var(--row-hover-bg);
}
.provider-settings-back:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}
.provider-settings-heading {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}
.provider-settings-heading strong,
.provider-settings-heading small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.provider-settings-heading strong {
  color: var(--color-text-main);
  font-size: 13px;
}
.provider-settings-heading small {
  color: var(--color-text-secondary);
  font-size: 10px;
}
.effect-popover.echo-popover-content {
  width: min(540px, calc(100vw - 24px));
  height: min(460px, calc(100vh - 100px));
  padding: 0;
  overflow: hidden;
  background: var(--color-bg-elevated);
  border-color: var(--border-subtle);
  display: flex;
}

.spatial-provider-card {
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--color-primary) 24%, transparent);
  border-radius: 12px;
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--color-primary) 11%, var(--color-bg-elevated)),
    color-mix(in srgb, var(--color-primary) 3%, var(--color-bg-elevated))
  );
}

.provider-card-heading,
.provider-mode-row,
.provider-section-heading,
.provider-control-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.provider-card-heading {
  margin-bottom: 12px;
}

.provider-card-copy {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 6px;
}

.provider-card-copy strong {
  overflow: hidden;
  color: var(--color-text-main);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-card-copy small,
.provider-section-heading span {
  color: var(--color-text-secondary);
  font-size: 9px;
  font-weight: 600;
}

.provider-status-dot {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
  color: #22a06b;
  font-size: 9px;
  font-weight: 700;
}

.provider-status-dot::before {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: currentColor;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 14%, transparent);
  content: '';
}

.provider-mode-row {
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 700;
}

.spatial-provider-mode-tabs {
  display: grid;
  width: 142px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  padding: 3px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-text-main) 6%, transparent);
}

.spatial-provider-mode-tabs button {
  height: 24px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
}

.spatial-provider-mode-tabs button:hover,
.spatial-provider-mode-tabs button.is-active {
  color: var(--color-primary);
  background: var(--color-bg-elevated);
}

.provider-capabilities {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 10px;
}

.provider-capability {
  max-width: 100%;
  overflow: hidden;
  padding: 3px 7px;
  border: 1px solid var(--control-border);
  border-radius: 9999px;
  background: color-mix(in srgb, var(--color-bg-elevated) 72%, transparent);
  color: var(--color-text-secondary);
  font-size: 8px;
  font-weight: 700;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-capability.is-supported {
  border-color: color-mix(in srgb, #22a06b 35%, transparent);
  color: #22a06b;
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
  width: 88px;
  box-sizing: border-box;
  flex: 0 0 88px;
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
  width: auto;
  min-width: 0;
  align-self: stretch;
}

.panel-content {
  min-height: 0;
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

.reset-btn:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}

.panel-scroll {
  flex: 1;
  width: 100%;
  min-width: 0;
  align-self: stretch;
}

.irs-panel-content,
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

.eq-container.is-disabled {
  opacity: 0.42;
}

.eq-bypass-hint {
  margin-top: -8px;
  color: var(--color-primary);
}

.eq-container.is-disabled .eq-slider,
.eq-container.is-disabled .preset-chip {
  cursor: not-allowed;
}

.eq-bands {
  display: flex;
  justify-content: space-between;
  height: 150px;
}

.irs-panel-header {
  gap: 16px;
}

.original-effect-button {
  flex: 0 0 auto;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--control-border);
  border-radius: 7px;
  background: var(--control-muted-bg);
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.original-effect-button:hover,
.original-effect-button.is-active {
  border-color: color-mix(in srgb, var(--color-primary) 35%, transparent);
  background: color-mix(in srgb, var(--color-primary) 9%, transparent);
  color: var(--color-primary);
}

.original-effect-button:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.current-spatial-effect {
  display: flex;
  width: auto;
  max-width: calc(100% - 20px);
  box-sizing: border-box;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: -2px 10px 8px;
  padding: 9px 10px;
  border: 1px solid var(--control-border);
  border-radius: 10px;
  background: var(--control-muted-bg);
}

.current-spatial-effect.is-active {
  border-color: color-mix(in srgb, var(--color-primary) 40%, transparent);
  background: color-mix(in srgb, var(--color-primary) 7%, var(--color-bg-elevated));
}

.current-spatial-effect-copy {
  display: grid;
  min-width: 0;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: baseline;
  gap: 2px 7px;
}

.current-spatial-effect-eyebrow {
  color: var(--color-text-secondary);
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.current-spatial-effect-copy strong {
  overflow: hidden;
  color: var(--color-text-main);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.current-spatial-effect-copy small {
  grid-column: 1 / -1;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: 9px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.current-spatial-effect-type {
  flex: 0 0 auto;
  max-width: 108px;
  overflow: hidden;
  padding: 3px 7px;
  border-radius: 9999px;
  background: var(--color-bg-elevated);
  color: var(--color-text-secondary);
  font-size: 8px;
  font-weight: 700;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.current-spatial-effect.is-active .current-spatial-effect-type {
  background: var(--color-primary);
  color: white;
}

.irs-preset-item {
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: 42px;
}

.my-effect-library,
.my-effect-tab-panel {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.my-effect-tab-panel[data-state='inactive'] {
  display: none;
}

.my-effect-source-tabs {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  flex: 0 0 auto;
  gap: 4px;
  margin: 0 10px 3px;
  border-bottom: 1px solid var(--control-border);
}

.my-effect-source-tab {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 0;
  height: 34px;
  padding: 0 2px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.my-effect-source-tab:hover,
.my-effect-source-tab[data-state='active'] {
  color: var(--color-primary);
}

.my-effect-source-tab[data-state='active'] {
  border-bottom-color: var(--color-primary);
}

.my-effect-source-tab small {
  font-size: 9px;
  font-weight: 500;
  opacity: 0.7;
}

.my-effect-source-tab:focus-visible,
.my-effect-empty button:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
  border-radius: 4px;
}

.my-effect-empty {
  display: flex;
  min-height: 140px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 16px;
  color: var(--color-text-secondary);
  text-align: center;
  font-size: 12px;
}

.my-effect-empty small {
  font-size: 10px;
}

.my-effect-empty button {
  margin-top: 3px;
  padding: 5px 10px;
  border: 1px solid var(--control-border);
  border-radius: 6px;
  background: var(--control-muted-bg);
  color: var(--color-primary);
  font-size: 11px;
  cursor: pointer;
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
  display: flex;
  height: 26px;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
}

.irs-library-tabs button:hover {
  color: var(--color-text-main);
}

.irs-library-tabs button.is-active {
  background: var(--color-bg-elevated);
  color: var(--color-primary);
  box-shadow: inset 0 0 0 1px var(--control-border);
}

.provider-panel-scroll,
.effect-popover .provider-scroll-wrap,
.effect-popover .provider-scroll-wrap > .scrollbar-view {
  width: 100% !important;
  min-width: 0 !important;
  align-self: stretch !important;
  box-sizing: border-box;
}

.provider-panel-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 0 10px 12px;
}

.provider-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.provider-section-heading {
  padding: 0 2px;
}

.provider-section-heading strong {
  color: var(--color-text-main);
  font-size: 11px;
}

.provider-preset-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}

.provider-preset-option {
  display: flex;
  min-width: 0;
  align-items: center;
  border: 1px solid var(--control-border);
  border-radius: 9px;
  background: var(--control-muted-bg);
  color: var(--color-text-main);
}

.provider-preset-button {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 38px;
  align-items: center;
  padding: 7px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.provider-preset-button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.provider-preset-option:has(.provider-preset-button:hover:not(:disabled)) {
  border-color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 9%, transparent);
  color: var(--color-primary);
}

.provider-preset-option.is-active {
  border-color: var(--color-primary);
  background: var(--color-primary);
  color: white;
}

.provider-preset-option.is-active:has(.provider-preset-button:hover) {
  background: var(--color-primary);
  color: white;
}

.provider-preset-button span {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-preset-button span {
  font-size: 11px;
  font-weight: 700;
}

.provider-preset-settings {
  display: inline-flex;
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  margin-right: 4px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.provider-preset-settings:hover {
  background: color-mix(in srgb, currentColor 12%, transparent);
}

.provider-preset-button:focus-visible,
.provider-preset-settings:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: -3px;
}

.provider-settings-panel .provider-control {
  padding: 12px;
  gap: 12px;
}

.provider-settings-panel .provider-control-label {
  font-size: 13px;
}

.provider-settings-panel .provider-control-value,
.provider-settings-panel .provider-checkbox,
.provider-settings-panel .provider-select {
  font-size: 12px;
}

.provider-controls {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.provider-control {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid var(--control-border);
  border-radius: 9px;
  background: var(--control-muted-bg);
}

.provider-control.is-disabled {
  opacity: 0.42;
}

.provider-control-label {
  color: var(--color-text-main);
  font-size: 10px;
  font-weight: 700;
}

.provider-control-value {
  color: var(--color-text-secondary);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}

.provider-slider {
  position: relative;
  display: flex;
  width: 100%;
  height: 14px;
  align-items: center;
  user-select: none;
  touch-action: none;
}

.provider-slider-labels {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--color-text-secondary);
  font-size: 11px;
}

.provider-slider-track {
  position: relative;
  height: 4px;
  flex: 1;
  overflow: hidden;
  border-radius: 9999px;
  background: var(--control-track-bg);
}

.provider-slider-range {
  position: absolute;
  height: 100%;
  border-radius: inherit;
  background: var(--color-primary);
}

.provider-slider-thumb {
  display: block;
  width: 12px;
  height: 12px;
  border: 1px solid var(--control-border);
  border-radius: 9999px;
  background: var(--control-thumb-bg);
  box-shadow: var(--shadow-control);
  outline: none;
}

.provider-checkbox {
  display: inline-flex;
  width: fit-content;
  align-items: center;
  gap: 6px;
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 600;
}

.provider-checkbox input {
  accent-color: var(--color-primary);
}

.provider-select {
  width: 100%;
  min-width: 0;
}

.provider-value {
  min-height: 28px;
  padding: 0 8px;
  border: 1px solid var(--control-border);
  border-radius: 7px;
  background: var(--color-bg-elevated);
  color: var(--color-text-main);
  font-size: 10px;
}

.provider-value {
  display: flex;
  align-items: center;
  overflow-wrap: anywhere;
}

.provider-panel-empty {
  display: flex;
  min-height: 190px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 16px;
  color: var(--color-text-secondary);
  text-align: center;
}

.provider-panel-empty strong {
  color: var(--color-text-main);
  font-size: 12px;
}

.provider-panel-empty span,
.provider-empty-note {
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 600;
}

.provider-empty-note {
  padding: 12px;
  border: 1px dashed var(--control-border);
  border-radius: 9px;
  text-align: center;
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
