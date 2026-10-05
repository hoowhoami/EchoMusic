<script setup lang="ts">
import { computed } from 'vue';
import { useLyricStore } from '@/stores/lyric';
import { useSettingStore } from '@/stores/setting';
import { DEFAULT_LYRIC_FILTER_PATTERN } from '@/stores/lyric';
import Switch from '@/components/ui/Switch.vue';
import Select from '@/components/ui/Select.vue';
import InputNumber from '@/components/ui/InputNumber.vue';
import { Icon } from '@iconify/vue';
import { iconMusicShare } from '@/icons';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { normalizeGlobalLyricOffsetMs } from '../../../../shared/lyricOffset';

const lyricStore = useLyricStore();
const settingStore = useSettingStore();

type RomanizationStyle = 'separate-line' | 'ruby';

const romanizationStyleOptions = [
  { label: '独立一行', value: 'separate-line' },
  { label: '注音', value: 'ruby' },
];

const textConversionOptions = [
  { label: '原文', value: 'none' },
  { label: '转简体', value: 'simplified' },
  { label: '转繁体', value: 'traditional' },
  { label: '转台湾正体', value: 'traditional-tw' },
  { label: '转香港繁体', value: 'traditional-hk' },
];

const globalOffsetSeconds = computed(
  () => normalizeGlobalLyricOffsetMs(lyricStore.globalTimeOffsetMs) / 1000,
);

const wantsTranslation = computed(() => lyricStore.wantTranslation);
const wantsRomanization = computed(() => lyricStore.wantRomanization);
const romanizationStyle = computed<RomanizationStyle>(() =>
  lyricStore.showRomanizationAsRuby ? 'ruby' : 'separate-line',
);
const textConversionMode = computed(() => lyricStore.textConversionMode);

const setTranslationEnabled = (enabled: boolean) => {
  lyricStore.wantTranslation = enabled;
};

const setRomanizationEnabled = (enabled: boolean) => {
  lyricStore.wantRomanization = enabled;
};

const updateRomanizationStyle = (value: string | number | (string | number)[]) => {
  lyricStore.showRomanizationAsRuby = value === 'ruby';
};

const updateTextConversionMode = (value: string | number | (string | number)[]) => {
  lyricStore.setTextConversionMode(value);
};

const updateGlobalOffset = (value: string) => {
  lyricStore.setGlobalTimeOffset(Number(value) * 1000);
};

const updateLyricOffsetStep = (value: string) => {
  const next = Number(value);
  settingStore.lyricOffsetStep = Number.isFinite(next) ? Math.max(0.1, Math.min(5, next)) : 0.5;
};
</script>

<template>
  <SettingsSectionShell id="lyric" title="通用">
    <template #icon>
      <Icon :icon="iconMusicShare" width="20" height="20" class="text-primary-text" />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">显示翻译</h3>
        <p class="text-sm text-text-secondary">有翻译时显示，播放页、桌面和 Mini 歌词共用</p>
      </div>
      <Switch
        :model-value="wantsTranslation"
        @update:model-value="setTranslationEnabled(Boolean($event))"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">显示音译</h3>
        <p class="text-sm text-text-secondary">有音译时显示，播放页、桌面和 Mini 歌词共用</p>
      </div>
      <Switch
        :model-value="wantsRomanization"
        @update:model-value="setRomanizationEnabled(Boolean($event))"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">音译样式</h3>
        <p class="text-sm text-text-secondary">选择各歌词视图中音译的显示方式</p>
      </div>
      <Select
        class="w-45 shrink-0"
        :model-value="romanizationStyle"
        :options="romanizationStyleOptions"
        @update:model-value="updateRomanizationStyle"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">歌词文字转换</h3>
        <p class="text-sm text-text-secondary">
          对播放页、桌面歌词和 Mini 歌词的歌词文本进行简繁转换
        </p>
      </div>
      <Select
        class="w-45 shrink-0"
        :model-value="textConversionMode"
        :options="textConversionOptions"
        @update:model-value="updateTextConversionMode"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">全局歌词时间偏移</h3>
        <p id="global-lyric-offset-help" class="text-sm text-text-secondary">
          对所有歌曲和歌词视图生效。正数让歌词提前，负数让歌词延后；与单曲微调叠加。
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <button
          type="button"
          class="settings-action"
          :disabled="globalOffsetSeconds === 0"
          @click="lyricStore.setGlobalTimeOffset(0)"
        >
          重置
        </button>
        <InputNumber
          class="w-45"
          :model-value="String(globalOffsetSeconds)"
          :min="-20"
          :max="20"
          :step="0.1"
          placeholder="0"
          suffix="秒"
          @update:model-value="updateGlobalOffset"
        />
      </div>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">单曲微调步长</h3>
        <p class="text-sm text-text-secondary">播放页和桌面歌词前进 / 后退按钮每次调整的时间量</p>
      </div>
      <InputNumber
        class="w-45"
        :model-value="String(settingStore.lyricOffsetStep)"
        :min="0.1"
        :max="5"
        :step="0.1"
        placeholder="0.5"
        suffix="秒"
        @update:model-value="updateLyricOffsetStep"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">歌词过滤</h3>
        <p class="text-sm text-text-secondary">过滤播放页和桌面歌词中的制作、版权等信息</p>
      </div>
      <Switch v-model="settingStore.lyricFilterEnabled" />
    </div>
    <template v-if="settingStore.lyricFilterEnabled">
      <div class="settings-divider"></div>
      <div class="settings-item items-start">
        <div class="space-y-1">
          <h3 class="font-semibold">过滤表达式</h3>
          <p class="text-sm text-text-secondary">正则表达式，匹配的行将被隐藏或替换</p>
        </div>
        <div class="flex items-center gap-2">
          <button
            class="settings-action"
            v-if="settingStore.lyricFilterPattern"
            type="button"
            @click="settingStore.lyricFilterPattern = ''"
          >
            恢复默认
          </button>
          <input
            v-model="settingStore.lyricFilterPattern"
            type="text"
            class="settings-input w-64"
            :placeholder="DEFAULT_LYRIC_FILTER_PATTERN"
          />
        </div>
      </div>
    </template>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
