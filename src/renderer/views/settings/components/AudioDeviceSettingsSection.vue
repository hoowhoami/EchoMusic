<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import Select from '@/components/ui/Select.vue';
import Switch from '@/components/ui/Switch.vue';
import FontIcon from '@/components/ui/FontIcon.vue';
import { Icon } from '@iconify/vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';

const settingStore = useSettingStore();
const playerStore = usePlayerStore();

const inputDeviceOptions = ref<{ label: string; value: string }[]>([
  { label: '系统默认', value: 'default' },
]);

const outputDeviceOptions = computed(() => settingStore.outputDevices);
const linuxSoundServerOutputSelected = computed(() =>
  /^(pipewire|pulse|pulseaudio):/.test(settingStore.outputDevice),
);
const currentOutputDeviceLabel = computed(() => {
  const matched = settingStore.outputDevices.find(
    (item) => item.value === playerStore.appliedOutputDeviceId,
  );
  return (
    matched?.label || (playerStore.appliedOutputDeviceId === 'default' ? '系统默认' : '未知设备')
  );
});

async function fetchInputDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((d) => d.kind === 'audioinput');
    inputDeviceOptions.value = [
      { label: '系统默认', value: 'default' },
      ...audioInputs
        .filter((d) => d.deviceId && d.deviceId !== 'default')
        .map((d) => ({
          label: d.label || `麦克风 (${d.deviceId.slice(0, 6)})`,
          value: d.deviceId,
        })),
    ];
    if (!inputDeviceOptions.value.some((d) => d.value === settingStore.inputDevice)) {
      settingStore.inputDevice = 'default';
    }
  } catch {
    inputDeviceOptions.value = [{ label: '系统默认', value: 'default' }];
  }
}

const handleInputDeviceChange = (value: string | number) => {
  settingStore.inputDevice = String(value ?? 'default');
};

const handleOutputDeviceChange = (value: string | number | boolean | null | undefined) => {
  const nextValue = String(value ?? 'default');
  if (nextValue === settingStore.outputDevice) return;
  settingStore.outputDevice = nextValue;
};

watch(
  linuxSoundServerOutputSelected,
  (selected) => {
    if (selected && settingStore.exclusiveAudioDevice) {
      settingStore.exclusiveAudioDevice = false;
    }
  },
  { immediate: true },
);

onMounted(() => {
  void fetchInputDevices();
});
</script>

<template>
  <SettingsSectionShell id="audioDevice" :title="sectionTitles.audioDevice.label">
    <template #icon>
      <Icon
        v-if="sectionTitles.audioDevice.icon"
        :icon="sectionTitles.audioDevice.icon"
        width="20"
        height="20"
        class="text-primary"
      />
      <FontIcon v-else :size="20" class="text-primary" />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">输入设备</h3>
        <p class="text-sm text-text-secondary">用于听歌识曲等需要录音的功能</p>
      </div>
      <Select
        class="w-45"
        :model-value="settingStore.inputDevice"
        :options="inputDeviceOptions"
        @update:model-value="handleInputDeviceChange($event as string)"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">输出设备</h3>
        <p class="text-sm text-text-secondary">选择音频播放输出设备</p>
        <p class="text-xs text-text-secondary/80">当前使用：{{ currentOutputDeviceLabel }}</p>
      </div>
      <Select
        class="w-45"
        :model-value="settingStore.outputDevice"
        :options="outputDeviceOptions"
        @update:model-value="handleOutputDeviceChange($event as string)"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">独占音频设备</h3>
        <p class="text-sm text-text-secondary">
          {{
            linuxSoundServerOutputSelected
              ? '当前输出设备通过系统音频服务输出，不支持独占模式'
              : '绕过系统混音器直接输出，可获得更高音质，但开启后其他应用将无法播放声音'
          }}
        </p>
      </div>
      <Switch
        v-model="settingStore.exclusiveAudioDevice"
        :disabled="linuxSoundServerOutputSelected"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">设备断开时暂停</h3>
        <p class="text-sm text-text-secondary">
          开启后，输出设备断开或不可用时立即暂停播放；关闭时自动重连，失败后切回系统默认设备继续播放。
        </p>
      </div>
      <Switch v-model="settingStore.pauseOnOutputDeviceDisconnect" />
    </div>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
