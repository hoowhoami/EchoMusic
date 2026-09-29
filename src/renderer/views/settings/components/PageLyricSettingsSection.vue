<script setup lang="ts">
import { computed } from 'vue';
import { useSettingStore } from '@/stores/setting';
import { DEFAULT_LYRIC_FILTER_PATTERN, useLyricStore } from '@/stores/lyric';
import Switch from '@/components/ui/Switch.vue';
import Select from '@/components/ui/Select.vue';
import PageLyricIcon from '@/components/ui/PageLyricIcon.vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';
import { normalizeLyricOffsetMs } from '../../../../shared/lyricOffset';

const settingStore = useSettingStore();
const lyricStore = useLyricStore();
const globalOffsetSeconds = computed(
  () => normalizeLyricOffsetMs(lyricStore.globalTimeOffsetMs) / 1000,
);
const updateGlobalOffset = (event: Event) => {
  const input = event.target as HTMLInputElement;
  lyricStore.setGlobalTimeOffset(input.valueAsNumber * 1000);
  input.value = String(globalOffsetSeconds.value);
};

type RomanizationStyle = 'separate-line' | 'ruby';
const romanizationStyleOptions = [
  { label: '独立一行', value: 'separate-line' },
  { label: '注音', value: 'ruby' },
];
const romanizationStyle = computed<RomanizationStyle>({
  get: () => (lyricStore.showRomanizationAsRuby ? 'ruby' : 'separate-line'),
  set: (value) => {
    lyricStore.showRomanizationAsRuby = value === 'ruby';
  },
});

const offsetStepOptions = [0.1, 0.25, 0.5, 1, 2].map((value) => ({
  label: `${value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} 秒`,
  value: String(value),
}));
</script>

<template>
  <SettingsSectionShell id="pageLyric" :title="sectionTitles.pageLyric.label">
    <template #icon>
      <PageLyricIcon :size="20" class="text-primary-text" />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">显示翻译</h3>
        <p class="text-sm text-text-secondary">有翻译时在歌词页面中显示翻译行</p>
      </div>
      <Switch v-model="lyricStore.wantTranslation" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">显示音译</h3>
        <p class="text-sm text-text-secondary">有音译时在歌词页面中显示音译行</p>
      </div>
      <Switch v-model="lyricStore.wantRomanization" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">音译样式</h3>
        <p class="text-sm text-text-secondary">选择页面歌词中音译的显示方式</p>
      </div>
      <Select
        class="w-45 shrink-0"
        :model-value="romanizationStyle"
        :options="romanizationStyleOptions"
        @update:model-value="romanizationStyle = $event as RomanizationStyle"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">封面模糊背景</h3>
        <p class="text-sm text-text-secondary">
          将封面图片模糊化作为歌词页背景，关闭时使用主题色纯色背景
        </p>
      </div>
      <Switch v-model="settingStore.lyricPageBackgroundBlur" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">背景律动</h3>
        <p class="text-sm text-text-secondary">
          开启后，歌词页封面模糊背景会变成无规律色块流动效果，此功能会增加性能消耗
        </p>
      </div>
      <Switch
        v-model="settingStore.lyricPageBackgroundRhythm"
        :disabled="!settingStore.lyricPageBackgroundBlur"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">全局歌词时间偏移</h3>
        <p id="global-lyric-offset-help" class="text-sm text-text-secondary">
          对所有歌曲生效，切歌和重启后保留；适用于页面、桌面、Mini 和任务栏等歌词视图。
          正数让歌词提前，负数让歌词延后；与单曲微调叠加，不改变音频播放进度。
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <input
          type="number"
          class="settings-input w-24"
          aria-label="全局歌词时间偏移（秒）"
          aria-describedby="global-lyric-offset-help"
          min="-10"
          max="10"
          step="0.1"
          :value="globalOffsetSeconds"
          @change="updateGlobalOffset"
        />
        <span class="text-sm text-text-secondary">秒</span>
        <button
          type="button"
          class="settings-action"
          :disabled="globalOffsetSeconds === 0"
          @click="lyricStore.setGlobalTimeOffset(0)"
        >
          重置全局
        </button>
      </div>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">歌词对齐微调步长</h3>
        <p class="text-sm text-text-secondary">歌词页中前进/后退微调歌词的时间间隔</p>
      </div>
      <Select
        class="w-45 shrink-0"
        :model-value="String(settingStore.lyricOffsetStep)"
        :options="offsetStepOptions"
        @update:model-value="settingStore.lyricOffsetStep = Number($event)"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">歌词过滤</h3>
        <p class="text-sm text-text-secondary">过滤非歌词内容（如制作人信息、版权声明等）</p>
      </div>
      <Switch v-model="settingStore.lyricFilterEnabled" />
    </div>
    <template v-if="settingStore.lyricFilterEnabled">
      <div class="settings-divider"></div>
      <div class="settings-item items-start">
        <div class="space-y-1">
          <h3 class="font-semibold">过滤表达式</h3>
          <p class="text-sm text-text-secondary">正则表达式，匹配的行将被隐藏</p>
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
