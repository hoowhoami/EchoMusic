<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Icon } from '@iconify/vue';
import Select from '@/components/ui/Select.vue';
import Switch from '@/components/ui/Switch.vue';
import Slider from '@/components/ui/Slider.vue';
import {
  DEFAULT_TASKBAR_LYRIC_SETTINGS,
  type TaskbarLyricSettings,
  type TaskbarLyricState,
} from '../../../../shared/taskbar';
import { sectionTitles } from '../constants';
import SettingsSectionShell from './SettingsSectionShell.vue';

const isWindows = computed(() => window.electron?.platform === 'win32');
const barEnabled = ref(false);
const barBusy = ref(false);
const barMessage = ref('');
const barSettings = ref({ ...DEFAULT_TASKBAR_LYRIC_SETTINGS });
const barPositionOptions = [
  { label: '自动', value: 'auto' },
  { label: '左侧', value: 'left' },
  { label: '右侧', value: 'right' },
];
let alive = true;
let receivedState = false;
let disposeBarState: (() => void) | undefined;
const applyBarState = (state: TaskbarLyricState) => {
  if (!alive) return;
  barEnabled.value = Boolean(state.enabled);
  if (state.settings) barSettings.value = state.settings;
  barMessage.value =
    state.enabled && !state.visible ? '已开启，等待任务栏可用空间；全屏时暂时隐藏' : '';
};
const onBarState = (raw: unknown) => {
  if (!raw || typeof raw !== 'object') return;
  receivedState = true;
  applyBarState(raw as TaskbarLyricState);
};
onMounted(async () => {
  if (!isWindows.value) return;
  try {
    disposeBarState = window.electron.taskbarLyric.onStateChange(onBarState);
    const state = await window.electron.taskbarLyric.getState();
    if (!receivedState) applyBarState(state);
  } catch {
    barMessage.value = '读取失败，可点击重新显示重试';
  }
});
onUnmounted(() => {
  alive = false;
  disposeBarState?.();
});
const setBar = async (value: boolean) => {
  if (barBusy.value) return;
  barBusy.value = true;
  barMessage.value = '';
  try {
    const state = await window.electron.taskbarLyric.setEnabled(value);
    applyBarState(state);
  } catch (error) {
    barMessage.value = `打开失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    barBusy.value = false;
  }
};
const setBarSettings = async (patch: Partial<TaskbarLyricSettings>) => {
  try {
    applyBarState(await window.electron.taskbarLyric.setSettings(patch));
  } catch (error) {
    if (alive)
      barMessage.value = `设置失败：${error instanceof Error ? error.message : String(error)}`;
  }
};
</script>

<template>
  <SettingsSectionShell
    v-if="isWindows"
    id="taskbarLyric"
    :title="sectionTitles.taskbarLyric.label"
  >
    <template #icon>
      <Icon
        :icon="sectionTitles.taskbarLyric.icon"
        width="20"
        height="20"
        class="text-primary-text"
      />
    </template>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">启用任务栏歌词</h3>
        <p class="text-sm text-text-secondary">在 Windows 主任务栏显示歌词，悬停时显示播放控制</p>
      </div>
      <div class="flex items-center gap-3 shrink-0">
        <button
          v-if="barEnabled"
          type="button"
          class="settings-action"
          :disabled="barBusy"
          @click="setBar(true)"
        >
          重新显示
        </button>
        <Switch
          aria-label="启用任务栏歌词"
          :model-value="barEnabled"
          :disabled="barBusy"
          @update:model-value="setBar(Boolean($event))"
        />
      </div>
    </div>
    <p v-if="barMessage" role="status" class="text-sm text-text-secondary">
      {{ barMessage }}
    </p>
    <template v-if="barEnabled">
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">歌词位置</h3>
          <p class="text-sm text-text-secondary">自动选择任务栏空闲的一侧</p>
        </div>
        <Select
          class="shrink-0 w-45"
          aria-label="任务栏歌词位置"
          :model-value="barSettings.position"
          :options="barPositionOptions"
          @update:model-value="
            setBarSettings({ position: $event as TaskbarLyricSettings['position'] })
          "
        />
      </div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">最大宽度</h3>
          <p class="text-sm text-text-secondary">按歌词内容收窄，不占用空白区的点击空间</p>
        </div>
        <Slider
          class="w-45"
          :model-value="barSettings.maxWidth"
          :min="160"
          :max="800"
          :step="10"
          show-value
          value-suffix=" px"
          aria-label="任务栏歌词最大宽度"
          @update:model-value="barSettings.maxWidth = $event"
          @value-commit="setBarSettings({ maxWidth: $event })"
        />
      </div>
      <div class="settings-item">
        <h3 class="font-semibold">歌词字号</h3>
        <Slider
          class="w-45"
          :model-value="barSettings.fontSize"
          :min="11"
          :max="22"
          show-value
          value-suffix=" px"
          aria-label="任务栏歌词字号"
          @update:model-value="barSettings.fontSize = $event"
          @value-commit="setBarSettings({ fontSize: $event })"
        />
      </div>
      <div class="settings-item">
        <h3 class="font-semibold">显示封面</h3>
        <Switch
          :model-value="barSettings.showCover"
          @update:model-value="setBarSettings({ showCover: Boolean($event) })"
        />
      </div>
      <div class="settings-item">
        <h3 class="font-semibold">显示翻译</h3>
        <Switch
          :model-value="barSettings.showTranslation"
          @update:model-value="setBarSettings({ showTranslation: Boolean($event) })"
        />
      </div>
      <div class="settings-item">
        <h3 class="font-semibold">逐字高亮</h3>
        <Switch
          :model-value="barSettings.wordByWord"
          @update:model-value="setBarSettings({ wordByWord: Boolean($event) })"
        />
      </div>
    </template>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
