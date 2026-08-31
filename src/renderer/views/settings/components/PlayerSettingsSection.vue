<script setup lang="ts">
import { useSettingStore } from '@/stores/setting';
import InputNumber from '@/components/ui/InputNumber.vue';
import Select from '@/components/ui/Select.vue';
import Switch from '@/components/ui/Switch.vue';
import { Icon } from '@iconify/vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';

const settingStore = useSettingStore();
const MIB = 1024 * 1024;
const MAX_CACHE_SECS = 3_600_000;
const MAX_DEMUXER_CACHE_MB = 4096;
const MAX_AUDIO_BUFFER_SECS = 10;
const cacheOptions = [
  { label: '自动', value: 'auto' },
  { label: '开启', value: 'yes' },
  { label: '关闭', value: 'no' },
];
const audioSamplerateOptions = [
  { label: '自动', value: 'auto' },
  { label: '44.1 kHz', value: '44100' },
  { label: '48 kHz', value: '48000' },
  { label: '96 kHz', value: '96000' },
  { label: '192 kHz', value: '192000' },
];
const audioChannelOptions = [
  { label: '安全自动', value: 'auto-safe' },
  { label: '自动', value: 'auto' },
  { label: '立体声', value: 'stereo' },
  { label: '单声道', value: 'mono' },
];
const audioFormatOptions = [
  { label: '自动', value: 'auto' },
  { label: '32-bit Float', value: 'float' },
  { label: '16-bit Integer', value: 's16' },
  { label: '32-bit Integer', value: 's32' },
];
const gaplessAudioOptions = [
  { label: '弱', value: 'weak' },
  { label: '开启', value: 'yes' },
  { label: '关闭', value: 'no' },
];

const clampNumber = (value: string | number, fallback: number, min: number, max: number) => {
  const rawValue = typeof value === 'string' ? value.trim() : value;
  if (rawValue === '') return fallback;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const bytesToMib = (value: unknown, fallback: number) =>
  Math.round((Number(value ?? fallback) / MIB) * 100) / 100;

const updateDemuxerReadaheadSecs = (value: string | number) => {
  settingStore.demuxerReadaheadSecs = clampNumber(value, 1, 0, MAX_CACHE_SECS);
};

const updateCache = (value: string | number | Array<string | number>) => {
  const next = String(Array.isArray(value) ? value[0] : value);
  settingStore.cache = next === 'yes' || next === 'no' ? next : 'auto';
};

const updateCacheSecs = (value: string | number) => {
  settingStore.cacheSecs = clampNumber(value, MAX_CACHE_SECS, 0, MAX_CACHE_SECS);
};

const updateCachePauseWaitSecs = (value: string | number) => {
  settingStore.cachePauseWaitSecs = clampNumber(value, 1, 0, MAX_CACHE_SECS);
};

const updateDemuxerMaxBytes = (value: string | number) => {
  const maxMB = clampNumber(value, 150, 0, MAX_DEMUXER_CACHE_MB);
  settingStore.demuxerMaxBytes = Math.round(maxMB * MIB);
};

const updateDemuxerMaxBackBytes = (value: string | number) => {
  settingStore.demuxerMaxBackBytes = Math.round(
    clampNumber(value, 50, 0, MAX_DEMUXER_CACHE_MB) * MIB,
  );
};

const updateAudioBufferSecs = (value: string | number) => {
  settingStore.audioBufferSecs = clampNumber(value, 0.2, 0, MAX_AUDIO_BUFFER_SECS);
};

const updateAudioSamplerate = (value: string | number | Array<string | number>) => {
  const next = String(Array.isArray(value) ? value[0] : value);
  settingStore.audioSamplerate = audioSamplerateOptions.some((item) => item.value === next)
    ? next
    : 'auto';
};

const updateAudioChannels = (value: string | number | Array<string | number>) => {
  const next = String(Array.isArray(value) ? value[0] : value);
  settingStore.audioChannels = audioChannelOptions.some((item) => item.value === next)
    ? next
    : 'auto-safe';
};

const updateAudioFormat = (value: string | number | Array<string | number>) => {
  const next = String(Array.isArray(value) ? value[0] : value);
  settingStore.audioFormat = audioFormatOptions.some((item) => item.value === next) ? next : 'auto';
};

const updateGaplessAudio = (value: string | number | Array<string | number>) => {
  const next = String(Array.isArray(value) ? value[0] : value);
  settingStore.gaplessAudio = gaplessAudioOptions.some((item) => item.value === next)
    ? next
    : 'weak';
};

const updatePlayResumeTimeout = (value: string | number) => {
  settingStore.playResumeTimeout = clampNumber(value, 0, 0, 30);
};

const updatePlaybackStallTimeout = (value: string | number) => {
  settingStore.playbackStallTimeout = clampNumber(value, 0, 0, 60);
};

const updatePlaybackStallMaxAttempts = (value: string | number) => {
  settingStore.playbackStallMaxAttempts = clampNumber(value, 3, 1, 10);
};
</script>

<template>
  <SettingsSectionShell id="player" :title="sectionTitles.player.label">
    <template #icon>
      <Icon
        v-if="sectionTitles.player.icon"
        :icon="sectionTitles.player.icon"
        width="20"
        height="20"
        class="text-primary"
      />
    </template>

    <div class="settings-notice">
      <p>部分音频输出设置修改后重启生效</p>
    </div>
    <div class="settings-divider"></div>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">普通预读时长</h3>
        <p class="text-sm text-text-secondary">本地播放使用的解复用前读时长</p>
      </div>
      <InputNumber
        class="w-45"
        :model-value="String(settingStore.demuxerReadaheadSecs ?? 1)"
        :min="0"
        :max="MAX_CACHE_SECS"
        :step="1"
        placeholder="1"
        suffix="秒"
        @update:model-value="updateDemuxerReadaheadSecs"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">网络缓存时长上限</h3>
        <p class="text-sm text-text-secondary">
          与前向缓存上限共同限制网络预读；默认 3600000 秒表示基本不按时长限制
        </p>
      </div>
      <InputNumber
        class="w-45"
        :model-value="String(settingStore.cacheSecs ?? MAX_CACHE_SECS)"
        :min="0"
        :max="MAX_CACHE_SECS"
        :step="1"
        placeholder="3600000"
        suffix="秒"
        @update:model-value="updateCacheSecs"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">网络缓存模式</h3>
        <p class="text-sm text-text-secondary">自动时仅网络音频启用更大的 packet 缓存</p>
      </div>
      <Select
        class="w-45"
        :model-value="settingStore.cache"
        :options="cacheOptions"
        @update:model-value="updateCache"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">缓存耗尽时暂停</h3>
        <p class="text-sm text-text-secondary">
          仅控制网络缓存不足时是否等待；音频输出缓冲由音频设备缓冲控制
        </p>
      </div>
      <Switch v-model="settingStore.cachePause" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">缓存恢复等待</h3>
        <p class="text-sm text-text-secondary">进入缓冲后，恢复播放前等待的可播放缓存时长</p>
      </div>
      <InputNumber
        class="w-45"
        :model-value="String(settingStore.cachePauseWaitSecs ?? 1)"
        :min="0"
        :max="MAX_CACHE_SECS"
        :step="0.1"
        placeholder="1"
        suffix="秒"
        @update:model-value="updateCachePauseWaitSecs"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">前向缓存上限</h3>
        <p class="text-sm text-text-secondary">解复用 packet 队列的前向缓存大小上限</p>
      </div>
      <InputNumber
        class="w-45"
        :model-value="String(bytesToMib(settingStore.demuxerMaxBytes, 150 * MIB))"
        :min="0"
        :max="MAX_DEMUXER_CACHE_MB"
        :step="8"
        placeholder="150"
        suffix="MB"
        @update:model-value="updateDemuxerMaxBytes"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">回退缓存上限</h3>
        <p class="text-sm text-text-secondary">保留已读 packet 的回退缓存字节上限</p>
      </div>
      <InputNumber
        class="w-45"
        :model-value="String(bytesToMib(settingStore.demuxerMaxBackBytes, 50 * MIB))"
        :min="0"
        :max="MAX_DEMUXER_CACHE_MB"
        :step="4"
        placeholder="50"
        suffix="MB"
        @update:model-value="updateDemuxerMaxBackBytes"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">音频设备缓冲</h3>
        <p class="text-sm text-text-secondary">
          输出设备侧的小缓冲，蓝牙设备可适当调高以减少断续，但会增加响应延迟
        </p>
      </div>
      <InputNumber
        class="w-45"
        :model-value="String(settingStore.audioBufferSecs ?? 0.2)"
        :min="0"
        :max="MAX_AUDIO_BUFFER_SECS"
        :step="0.05"
        placeholder="0.2"
        suffix="秒"
        @update:model-value="updateAudioBufferSecs"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">音频采样率</h3>
        <p class="text-sm text-text-secondary">
          自动时优先对齐输出设备，固定后由引擎重采样到目标采样率
        </p>
      </div>
      <Select
        class="w-45"
        :model-value="settingStore.audioSamplerate"
        :options="audioSamplerateOptions"
        @update:model-value="updateAudioSamplerate"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">音频声道</h3>
        <p class="text-sm text-text-secondary">安全自动会在音效需要立体声时升到双声道</p>
      </div>
      <Select
        class="w-45"
        :model-value="settingStore.audioChannels"
        :options="audioChannelOptions"
        @update:model-value="updateAudioChannels"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">输出采样格式</h3>
        <p class="text-sm text-text-secondary">仅独占输出下生效，普通输出使用系统混音格式</p>
      </div>
      <Select
        class="w-45"
        :model-value="settingStore.audioFormat"
        :options="audioFormatOptions"
        @update:model-value="updateAudioFormat"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">无缝播放</h3>
        <p class="text-sm text-text-secondary">关闭后每首歌都会重新加载并重新协商输出设备</p>
      </div>
      <Select
        class="w-45"
        :model-value="settingStore.gaplessAudio"
        :options="gaplessAudioOptions"
        @update:model-value="updateGaplessAudio"
      />
    </div>
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
        @update:model-value="updatePlayResumeTimeout"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">播放卡死自动恢复</h3>
        <p class="text-sm text-text-secondary">
          播放中进度超过该秒数无推进则判定为卡死，自动重取地址并从断点续播。设为 0 禁用
        </p>
      </div>
      <InputNumber
        class="w-45"
        :model-value="String(settingStore.playbackStallTimeout ?? 8)"
        :min="0"
        :max="60"
        :step="1"
        placeholder="8"
        suffix="秒"
        @update:model-value="updatePlaybackStallTimeout"
      />
    </div>
    <template v-if="(settingStore.playbackStallTimeout ?? 8) > 0">
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">最大自动恢复次数</h3>
          <p class="text-sm text-text-secondary">
            同一首歌连续卡死时最多自动恢复的次数，超过则提示并按设置自动切下一首
          </p>
        </div>
        <InputNumber
          class="w-45"
          :model-value="String(settingStore.playbackStallMaxAttempts ?? 3)"
          :min="1"
          :max="10"
          :step="1"
          placeholder="3"
          suffix="次"
          @update:model-value="updatePlaybackStallMaxAttempts"
        />
      </div>
    </template>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
