<script setup lang="ts">
import { useSettingStore } from '@/stores/setting';
import Input from '@/components/ui/Input.vue';
import InputNumber from '@/components/ui/InputNumber.vue';
import { Icon } from '@iconify/vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';

const settingStore = useSettingStore();

const clampNumber = (value: string | number, fallback: number, min: number, max: number) => {
  const rawValue = typeof value === 'string' ? value.trim() : value;
  if (rawValue === '') return fallback;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const updateAudioCacheSecs = (value: string | number) => {
  settingStore.audioCacheSecs = clampNumber(value, 30, 10, 120);
};

const updateAudioDemuxerMaxMB = (value: string | number) => {
  const maxMB = clampNumber(value, 48, 8, 512);
  settingStore.audioDemuxerMaxMB = maxMB;
  settingStore.audioDemuxerBackMB = Math.min(settingStore.audioDemuxerBackMB ?? 12, maxMB);
};

const updateAudioDemuxerBackMB = (value: string | number) => {
  settingStore.audioDemuxerBackMB = clampNumber(value, 12, 0, settingStore.audioDemuxerMaxMB ?? 48);
};

const updateAudioBufferSecs = (value: string | number) => {
  settingStore.audioBufferSecs = clampNumber(value, 2, 1, 5);
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

const updateKugouApiProxy = (value: string | number) => {
  settingStore.kugouApiProxyUrl = String(value ?? '');
  settingStore.syncNetworkSettings();
};

const updateKugouApiTimeout = (value: string | number) => {
  settingStore.kugouApiTimeoutSecs = clampNumber(value, 0, 0, 300);
  settingStore.syncNetworkSettings();
};

const updatePlayerHttpProxy = (value: string | number) => {
  settingStore.playerHttpProxyUrl = String(value ?? '');
  settingStore.syncNetworkSettings();
};

const updatePlayerNetworkTimeout = (value: string | number) => {
  settingStore.playerNetworkTimeoutSecs = clampNumber(value, 60, 1, 300);
  settingStore.syncNetworkSettings();
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

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">音频缓冲时长</h3>
        <p class="text-sm text-text-secondary">
          网络音频预读时长，增加可减少网络波动导致的播放中断（需重启应用生效）
        </p>
      </div>
      <InputNumber
        class="w-45"
        :model-value="String(settingStore.audioCacheSecs ?? 30)"
        :min="10"
        :max="120"
        :step="10"
        placeholder="30"
        suffix="秒"
        @update:model-value="updateAudioCacheSecs"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">预读缓存上限</h3>
        <p class="text-sm text-text-secondary">
          解复用 packet 前向缓存大小上限，增加可改善网络波动下的连续播放（需重启应用生效）
        </p>
      </div>
      <InputNumber
        class="w-45"
        :model-value="String(settingStore.audioDemuxerMaxMB ?? 48)"
        :min="8"
        :max="512"
        :step="8"
        placeholder="48"
        suffix="MB"
        @update:model-value="updateAudioDemuxerMaxMB"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">回退缓存上限</h3>
        <p class="text-sm text-text-secondary">
          保留已读 packet 的缓存大小，便于短距离回退或精确定位（需重启应用生效）
        </p>
      </div>
      <InputNumber
        class="w-45"
        :model-value="String(settingStore.audioDemuxerBackMB ?? 12)"
        :min="0"
        :max="settingStore.audioDemuxerMaxMB ?? 48"
        :step="4"
        placeholder="12"
        suffix="MB"
        @update:model-value="updateAudioDemuxerBackMB"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">音频设备缓冲</h3>
        <p class="text-sm text-text-secondary">
          音频输出设备缓冲时长，增加可改善网络受限时的播放稳定性（需重启应用生效）
        </p>
      </div>
      <InputNumber
        class="w-45"
        :model-value="String(settingStore.audioBufferSecs ?? 2)"
        :min="1"
        :max="5"
        :step="0.5"
        placeholder="2"
        suffix="秒"
        @update:model-value="updateAudioBufferSecs"
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
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">酷狗 API 代理</h3>
        <p class="text-sm text-text-secondary">
          用于歌曲地址、歌词和推荐等接口，支持 HTTP/HTTPS 代理
        </p>
      </div>
      <Input
        :model-value="settingStore.kugouApiProxyUrl"
        placeholder="http://127.0.0.1:7890"
        class="w-60! rounded-lg"
        input-class="!h-9 !rounded-lg !pl-3 !pr-8 !text-sm"
        @update:model-value="updateKugouApiProxy"
        @clear="updateKugouApiProxy('')"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">酷狗 API 超时</h3>
        <p class="text-sm text-text-secondary">接口请求超过该时间后中止，设为 0 使用默认行为</p>
      </div>
      <InputNumber
        class="w-45"
        :model-value="String(settingStore.kugouApiTimeoutSecs ?? 0)"
        :min="0"
        :max="300"
        :step="10"
        placeholder="0"
        suffix="秒"
        @update:model-value="updateKugouApiTimeout"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">播放器 HTTP 代理</h3>
        <p class="text-sm text-text-secondary">用于播放器直接加载音频直链，支持 HTTP/HTTPS 代理</p>
      </div>
      <Input
        :model-value="settingStore.playerHttpProxyUrl"
        placeholder="http://127.0.0.1:7890"
        class="w-60! rounded-lg"
        input-class="!h-9 !rounded-lg !pl-3 !pr-8 !text-sm"
        @update:model-value="updatePlayerHttpProxy"
        @clear="updatePlayerHttpProxy('')"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">播放器网络超时</h3>
        <p class="text-sm text-text-secondary">播放器打开音频直链的网络等待时间</p>
      </div>
      <InputNumber
        class="w-45"
        :model-value="String(settingStore.playerNetworkTimeoutSecs ?? 60)"
        :min="1"
        :max="300"
        :step="10"
        placeholder="60"
        suffix="秒"
        @update:model-value="updatePlayerNetworkTimeout"
      />
    </div>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
