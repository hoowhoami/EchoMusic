<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Icon } from '@iconify/vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import Switch from '@/components/ui/Switch.vue';
import { iconCast, iconLoader2, iconRefreshCw, iconTrash } from '@/icons';
import { useOutputStore, type OutputTargetView } from '@/stores/output';
import { useSettingStore } from '@/stores/setting';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';

const output = useOutputStore();
const settingStore = useSettingStore();
const pin = ref('');
const pinTarget = ref('');

const dlnaTargets = computed(() =>
  output.visibleTargets.filter((target) => target.protocol === 'dlna'),
);
const airplayTargets = computed(() =>
  output.visibleTargets.filter((target) => target.protocol === 'airplay'),
);
const remoteActive = computed(() => output.snapshot && output.snapshot.protocol !== 'local');
const deviceCount = computed(() => dlnaTargets.value.length + airplayTargets.value.length);
const statusText = computed(() => {
  if (output.error) return output.error;
  if (output.searching && deviceCount.value === 0) return '正在搜索投放设备...';
  if (
    settingStore.networkPlaybackEnabled &&
    output.browsing &&
    deviceCount.value === 0 &&
    output.diagnostics &&
    output.diagnostics !== '本机播放'
  ) {
    return output.diagnostics;
  }
  return '';
});
const activeTitle = computed(() =>
  remoteActive.value ? output.snapshot?.displayName || '远端设备' : '本机播放',
);

onMounted(() => {
  void output.bind();
  void output.setBrowsing(true);
});

onUnmounted(() => {
  void output.setBrowsing(false);
});

function targetMeta(target: OutputTargetView): string {
  return target.note || '';
}

function isConnectingTarget(target: OutputTargetView): boolean {
  return output.connectingTargetId === target.targetId;
}

function isActiveTarget(target: OutputTargetView): boolean {
  return (
    output.snapshot?.protocol === target.protocol &&
    (output.snapshot.targetId
      ? output.snapshot.targetId === target.targetId
      : output.snapshot.displayName === target.displayName)
  );
}

async function choose(target: OutputTargetView): Promise<void> {
  if (
    target.protocol === 'airplay' &&
    target.note === '需要 PIN' &&
    pinTarget.value !== target.targetId
  ) {
    pinTarget.value = target.targetId;
    pin.value = '';
    return;
  }
  const result = await output.connect(
    target.targetId,
    pinTarget.value === target.targetId ? pin.value : undefined,
  );
  if (result.ok) {
    pinTarget.value = '';
    pin.value = '';
  } else if (result.error === 'pin-required') {
    pinTarget.value = target.targetId;
  }
}

function submitPin(): void {
  const target = airplayTargets.value.find((item) => item.targetId === pinTarget.value);
  if (target) void choose(target);
}
</script>

<template>
  <SettingsSectionShell id="cast" :title="sectionTitles.cast.label">
    <template #icon>
      <Icon
        :icon="sectionTitles.cast.icon || iconCast"
        width="20"
        height="20"
        class="text-primary-text"
      />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">启用投放</h3>
        <p class="text-sm text-text-secondary">搜索并连接 DLNA / AirPlay 设备</p>
      </div>
      <Switch v-model="settingStore.networkPlaybackEnabled" />
    </div>

    <div class="settings-divider"></div>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">当前输出</h3>
        <p class="text-sm text-text-secondary">{{ activeTitle }}</p>
        <p v-if="statusText" class="cast-status" :class="{ warning: output.error }">
          {{ statusText }}
        </p>
      </div>
      <div class="cast-action-row">
        <button
          v-if="remoteActive"
          type="button"
          class="settings-action"
          :disabled="output.busy"
          @click="output.useLocal()"
        >
          <Icon
            v-if="output.switchingLocal"
            :icon="iconLoader2"
            width="14"
            height="14"
            class="animate-spin"
          />
          {{ output.switchingLocal ? '停止中' : '停止投放' }}
        </button>
        <button
          type="button"
          class="settings-action settings-action-primary"
          :disabled="output.busy || output.searching || !settingStore.networkPlaybackEnabled"
          @click="output.refresh()"
        >
          <Icon
            :icon="iconRefreshCw"
            width="14"
            height="14"
            :class="{ 'animate-spin': output.searching }"
          />
          {{ output.searching ? '搜索中' : '刷新' }}
        </button>
      </div>
    </div>

    <div class="settings-divider"></div>

    <div class="cast-toolbar">
      <strong>可用设备</strong>
      <span>{{ settingStore.networkPlaybackEnabled ? `${deviceCount} 台` : '未启用' }}</span>
    </div>

    <div class="cast-groups">
      <section class="cast-group">
        <div class="cast-group-title">
          <h3>DLNA</h3>
          <span>{{ dlnaTargets.length }} 台</span>
        </div>
        <Scrollbar class="cast-device-scroll" :scrollbar-inset="4" :scrollbar-right-bleed="10">
          <button
            v-for="target in dlnaTargets"
            :key="target.targetId"
            type="button"
            class="cast-device"
            :class="{ active: isActiveTarget(target), connecting: isConnectingTarget(target) }"
            :disabled="output.busy || !settingStore.networkPlaybackEnabled"
            @click="choose(target)"
          >
            <span class="cast-device-name">{{ target.displayName }}</span>
            <span v-if="isConnectingTarget(target)" class="cast-device-meta is-connecting">
              <Icon :icon="iconLoader2" width="12" height="12" class="animate-spin" />
              连接中
            </span>
            <span v-else-if="targetMeta(target)" class="cast-device-meta">
              {{ targetMeta(target) }}
            </span>
          </button>
          <p v-if="dlnaTargets.length === 0" class="cast-empty">
            {{ output.searching ? '正在搜索设备' : '没有找到设备' }}
          </p>
        </Scrollbar>
      </section>

      <section class="cast-group">
        <div class="cast-group-title">
          <h3>AirPlay</h3>
          <span>{{ airplayTargets.length }} 台</span>
        </div>
        <Scrollbar class="cast-device-scroll" :scrollbar-inset="4" :scrollbar-right-bleed="10">
          <button
            v-for="target in airplayTargets"
            :key="target.targetId"
            type="button"
            class="cast-device"
            :class="{ active: isActiveTarget(target), connecting: isConnectingTarget(target) }"
            :disabled="output.busy || !settingStore.networkPlaybackEnabled"
            @click="choose(target)"
          >
            <span class="cast-device-name">{{ target.displayName }}</span>
            <span v-if="isConnectingTarget(target)" class="cast-device-meta is-connecting">
              <Icon :icon="iconLoader2" width="12" height="12" class="animate-spin" />
              连接中
            </span>
            <span v-else-if="targetMeta(target)" class="cast-device-meta">
              {{ targetMeta(target) }}
            </span>
          </button>
          <label v-if="pinTarget" class="cast-pin">
            PIN
            <input
              v-model="pin"
              maxlength="8"
              inputmode="numeric"
              @keydown.enter.prevent="submitPin"
            />
            <button
              type="button"
              class="settings-action"
              :disabled="output.busy"
              @click="submitPin"
            >
              连接
            </button>
          </label>
          <p v-if="airplayTargets.length === 0" class="cast-empty">
            {{ output.searching ? '正在搜索设备' : '没有找到设备' }}
          </p>
        </Scrollbar>
      </section>
    </div>

    <div class="settings-divider"></div>

    <div class="cast-records">
      <div>
        <h3>清除设备记录</h3>
        <p>清除各设备记住的音量和本机保存的 AirPlay 配对。</p>
      </div>
      <button
        type="button"
        class="settings-action settings-action-danger"
        @click="output.clearRecords()"
      >
        <Icon :icon="iconTrash" width="14" height="14" />
        清除
      </button>
    </div>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
<style scoped>
.cast-groups {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  align-items: start;
}

.cast-records h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 800;
}

.cast-records p {
  margin: 3px 0 0;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.cast-status {
  display: inline-flex;
  max-width: 100%;
  margin-top: 7px;
  padding: 3px 7px;
  border-radius: 999px;
  color: var(--color-text-secondary);
  background: var(--control-muted-bg);
  font-size: 11px;
  font-weight: 700;
}

.cast-status.warning {
  color: #ef4444;
  background: color-mix(in srgb, #ef4444 10%, transparent);
}

.cast-action-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.cast-action-row .settings-action,
.cast-records .settings-action,
.cast-pin .settings-action {
  gap: 5px;
}

.cast-toolbar {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding: 0 1px;
}

.cast-toolbar strong,
.cast-group-title h3 {
  font-size: 13px;
  font-weight: 800;
}

.cast-toolbar span,
.cast-group-title span {
  margin-left: 8px;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 700;
}

.cast-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  min-height: 0;
  padding: 10px;
  border: 1px solid var(--control-border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--control-muted-bg) 64%, transparent);
}

.cast-group-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.cast-group-title h3 {
  margin: 0;
}

.cast-device-scroll {
  max-height: min(320px, calc(100vh - 360px));
  min-height: 0;
}

.cast-device-scroll :deep(.scrollbar-view) {
  display: grid;
  gap: 8px;
  padding-right: 4px;
}

.cast-device {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 38px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: var(--floating-surface-bg);
  color: inherit;
  cursor: pointer;
  text-align: left;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;
}

.cast-device:hover:not(:disabled),
.cast-device.active,
.cast-device.connecting {
  border-color: color-mix(in srgb, var(--color-primary) 24%, transparent);
  background: var(--control-hover-bg);
}

.cast-device.active::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 999px;
  background: var(--color-primary);
}

.cast-device.active .cast-device-name {
  padding-left: 6px;
}

.cast-device.connecting {
  opacity: 1;
}

.cast-device:disabled:not(.connecting) {
  cursor: not-allowed;
  opacity: 0.55;
}

.cast-device-name {
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  font-weight: 750;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cast-device-meta,
.cast-pin,
.cast-empty {
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 650;
}

.cast-device-meta.is-connecting {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--color-primary-text);
}

.cast-pin {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cast-pin input {
  width: 6rem;
  border: 1px solid var(--control-border);
  border-radius: 8px;
  background: var(--control-muted-bg);
  color: inherit;
  padding: 6px 8px;
}

.cast-empty {
  padding: 9px;
}

.cast-records {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

@media (max-width: 760px) {
  .cast-groups {
    grid-template-columns: 1fr;
  }

  .cast-toolbar,
  .cast-records {
    align-items: stretch;
  }

  .cast-toolbar,
  .cast-records {
    flex-direction: column;
  }

  .cast-action-row {
    justify-content: flex-start;
  }
}
</style>
