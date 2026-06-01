<script setup lang="ts">
import { computed } from 'vue';
import { useSettingStore } from '@/stores/setting';
import { usePlayerStore } from '@/stores/player';
import Switch from '@/components/ui/Switch.vue';
import Slider from '@/components/ui/Slider.vue';
import InputNumber from '@/components/ui/InputNumber.vue';
import FontIcon from '@/components/ui/FontIcon.vue';
import { Icon } from '@iconify/vue';
import { iconPlayerPlay } from '@/icons';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';

const settingStore = useSettingStore();
const playerStore = usePlayerStore();

const autoNextDelayInput = computed({
  get: () => String(settingStore.autoNextDelaySeconds ?? 0),
  set: (value: string | number) => {
    const parsed = Number.parseInt(String(value).trim(), 10);
    settingStore.autoNextDelaySeconds = Number.isNaN(parsed)
      ? 0
      : Math.max(0, Math.min(parsed, 600));
  },
});

const autoNextMaxAttemptsInput = computed({
  get: () => String(settingStore.autoNextMaxAttempts ?? 0),
  set: (value: string | number) => {
    const parsed = Number.parseInt(String(value).trim(), 10);
    settingStore.autoNextMaxAttempts = Number.isNaN(parsed)
      ? 1
      : Math.max(1, Math.min(parsed, 999));
  },
});

const handleVolumeNormalizationChange = (enabled: boolean) => {
  settingStore.volumeNormalization = enabled;
  playerStore.setVolumeNormalization(enabled);
};

const handleReferenceLufsSlider = (value: number) => {
  settingStore.volumeNormalizationLufs = value;
  playerStore.setReferenceLufs(value);
};
</script>

<template>
  <SettingsSectionShell id="playback" :title="sectionTitles.playback.label">
    <template #icon>
      <Icon :icon="iconPlayerPlay" width="20" height="20" class="text-primary" />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">播放替换队列</h3>
        <p class="text-sm text-text-secondary">双击播放单曲时用当前列表替换播放队列</p>
      </div>
      <Switch v-model="settingStore.replacePlaylist" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">淡入淡出播放</h3>
        <p class="text-sm text-text-secondary">启用歌曲切换时的过渡效果</p>
      </div>
      <Switch v-model="settingStore.volumeFade" />
    </div>
    <template v-if="settingStore.volumeFade">
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">淡入淡出时长</h3>
          <p class="text-sm text-text-secondary">调整歌曲切换时的过渡时长</p>
        </div>
        <Slider
          class="w-48"
          :model-value="settingStore.volumeFadeTime"
          :min="500"
          :max="3000"
          :step="100"
          show-value
          :value-suffix="'ms'"
          @update:model-value="settingStore.volumeFadeTime = $event"
          @value-commit="settingStore.volumeFadeTime = $event"
        />
      </div>
    </template>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">音量均衡</h3>
        <p class="text-sm text-text-secondary">自动调整不同歌曲的音量，使播放响度保持一致</p>
      </div>
      <Switch
        :model-value="settingStore.volumeNormalization"
        @update:model-value="handleVolumeNormalizationChange"
      />
    </div>
    <template v-if="settingStore.volumeNormalization">
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">参考响度</h3>
          <p class="text-sm text-text-secondary">数值越高整体音量越大，越低越安静</p>
        </div>
        <Slider
          class="w-48"
          :model-value="settingStore.volumeNormalizationLufs"
          :min="-20"
          :max="-8"
          :step="1"
          show-value
          :value-suffix="' LUFS'"
          @update:model-value="handleReferenceLufsSlider($event)"
          @value-commit="handleReferenceLufsSlider($event)"
        />
      </div>
    </template>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">自动跳过错误</h3>
        <p class="text-sm text-text-secondary">
          播放失败时停留在当前歌曲，并按设定延迟自动尝试下一首
        </p>
      </div>
      <Switch v-model="settingStore.autoNext" />
    </div>
    <template v-if="settingStore.autoNext">
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">失败后切换延迟</h3>
          <p class="text-sm text-text-secondary">给用户留出确认失败状态的时间，再自动切换</p>
        </div>
        <InputNumber
          class="w-45"
          :model-value="autoNextDelayInput"
          :min="0"
          :max="600"
          :step="1"
          placeholder="0"
          suffix="秒"
          @update:model-value="autoNextDelayInput = $event"
        />
      </div>
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">最大自动切换次数</h3>
          <p class="text-sm text-text-secondary">连续失败时最多自动尝试的次数，避免无限跳歌</p>
        </div>
        <InputNumber
          class="w-45"
          :model-value="autoNextMaxAttemptsInput"
          :min="1"
          :max="999"
          :step="1"
          placeholder="10"
          suffix="次"
          @update:model-value="autoNextMaxAttemptsInput = $event"
        />
      </div>
    </template>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">播放恢复超时</h3>
        <p class="text-sm text-text-secondary">
          长时间暂停后恢复播放可能卡住，超时后自动重新加载音频源。设为 0 禁用
        </p>
      </div>
      <InputNumber
        class="w-45"
        :model-value="String(settingStore.playResumeTimeout ?? 5)"
        :min="0"
        :max="30"
        :step="1"
        placeholder="5"
        suffix="秒"
        @update:model-value="
          settingStore.playResumeTimeout = Math.max(0, Math.min(30, Number($event) || 0))
        "
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">防止系统休眠</h3>
        <p class="text-sm text-text-secondary">播放音乐时阻止系统进入睡眠</p>
      </div>
      <Switch v-model="settingStore.preventSleep" />
    </div>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
