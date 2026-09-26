<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Icon } from '@iconify/vue';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import Switch from '@/components/ui/Switch.vue';
import { openSettingsDialog } from '@/composables/useSettingsDialog';
import { iconCast, iconLoader2, iconRefreshCw, iconSettings } from '@/icons';
import { useOutputStore, type OutputTargetView } from '@/stores/output';
import { useSettingStore } from '@/stores/setting';

const output = useOutputStore();
const settingStore = useSettingStore();
const pin = ref('');
const pinTarget = ref('');
const emit = defineEmits<{ close: [] }>();

const dlnaTargets = computed(() =>
  output.visibleTargets.filter((target) => target.protocol === 'dlna'),
);
const airplayTargets = computed(() =>
  output.visibleTargets.filter((target) => target.protocol === 'airplay'),
);
const remoteActive = computed(() => output.snapshot && output.snapshot.protocol !== 'local');
const remoteDeviceCount = computed(() => dlnaTargets.value.length + airplayTargets.value.length);
const activeTitle = computed(() =>
  remoteActive.value ? output.snapshot?.displayName : '本机播放',
);
const statusText = computed(() => {
  if (output.error) return output.error;
  if (output.searching && remoteDeviceCount.value === 0) return '正在搜索投放设备...';
  if (
    settingStore.networkPlaybackEnabled &&
    output.browsing &&
    remoteDeviceCount.value === 0 &&
    output.diagnostics &&
    output.diagnostics !== '本机播放'
  ) {
    return output.diagnostics;
  }
  return '';
});

const protocolLabel = (target: OutputTargetView) =>
  target.protocol === 'dlna' ? 'DLNA' : (target.note ?? 'AirPlay');
const targetMeta = (target: OutputTargetView) => (target.note ? target.note : '');
const deviceName = (target: OutputTargetView) => target.displayName || protocolLabel(target);
const isConnectingTarget = (target: OutputTargetView) =>
  output.connectingTargetId === target.targetId;

const isActiveTarget = (target: OutputTargetView) =>
  output.snapshot?.protocol === target.protocol &&
  (output.snapshot.targetId
    ? output.snapshot.targetId === target.targetId
    : output.snapshot.displayName === target.displayName);

async function choose(target: OutputTargetView): Promise<void> {
  const currentPinTarget = pinTarget.value === target.targetId;
  if (!currentPinTarget) {
    pinTarget.value = '';
    pin.value = '';
  }
  if (target.protocol === 'airplay' && target.paired === false && !currentPinTarget) {
    pinTarget.value = target.targetId;
    return;
  }

  const result = await output.connect(target.targetId, currentPinTarget ? pin.value : undefined);
  if (result.ok) {
    pinTarget.value = '';
    pin.value = '';
    emit('close');
  } else if (result.error === 'pin-required') {
    pinTarget.value = target.targetId;
  }
}

function submitPin(): void {
  const target = airplayTargets.value.find((item) => item.targetId === pinTarget.value);
  if (target) void choose(target);
}

function openCastSettings(): void {
  openSettingsDialog('cast');
}

onMounted(() => {
  void output.bind();
  void output.setBrowsing(true);
});

onUnmounted(() => {
  void output.setBrowsing(false);
});
</script>

<template>
  <div class="cast-panel" aria-label="投放">
    <div class="cast-panel-header">
      <div class="cast-panel-title">
        <span class="cast-panel-icon">
          <Icon :icon="iconCast" width="17" height="17" />
        </span>
        <div>
          <strong>投放</strong>
          <span>{{ activeTitle }}</span>
        </div>
      </div>
      <div class="cast-panel-actions">
        <button
          type="button"
          class="cast-panel-icon-button app-focus-ring-soft"
          :disabled="output.busy || output.searching || !settingStore.networkPlaybackEnabled"
          title="刷新设备"
          @click="output.refresh()"
        >
          <Icon
            :icon="iconRefreshCw"
            width="15"
            height="15"
            :class="{ 'animate-spin': output.searching }"
          />
        </button>
        <button
          type="button"
          class="cast-panel-icon-button app-focus-ring-soft"
          title="投放设置"
          @click="openCastSettings"
        >
          <Icon :icon="iconSettings" width="15" height="15" />
        </button>
        <Switch v-model="settingStore.networkPlaybackEnabled" />
      </div>
    </div>

    <div v-if="statusText" class="cast-panel-status" :class="{ warning: output.error }">
      <span>{{ statusText }}</span>
    </div>

    <div v-if="remoteActive" class="cast-current">
      <span>
        {{ output.snapshot?.protocol === 'dlna' ? 'DLNA 原曲投放' : 'AirPlay 投放' }}
      </span>
      <Button
        class="cast-stop-button"
        variant="secondary"
        size="none"
        :loading="output.switchingLocal"
        :disabled="output.busy"
        @click="output.useLocal()"
      >
        停止投放
      </Button>
    </div>

    <div class="cast-device-list" :class="{ disabled: !settingStore.networkPlaybackEnabled }">
      <section>
        <div class="cast-section-title">
          <span>DLNA</span>
          <small>{{ dlnaTargets.length }} 台</small>
        </div>
        <Scrollbar class="cast-device-scroll" :scrollbar-inset="3" :scrollbar-right-bleed="9">
          <button
            v-for="target in dlnaTargets"
            :key="target.targetId"
            type="button"
            class="cast-device-row app-focus-ring-soft"
            :class="{ active: isActiveTarget(target), connecting: isConnectingTarget(target) }"
            :disabled="output.busy || !settingStore.networkPlaybackEnabled"
            @click="choose(target)"
          >
            <span class="cast-device-name">{{ deviceName(target) }}</span>
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

      <section>
        <div class="cast-section-title">
          <span>AirPlay</span>
          <small>{{ airplayTargets.length }} 台</small>
        </div>
        <Scrollbar class="cast-device-scroll" :scrollbar-inset="3" :scrollbar-right-bleed="9">
          <template v-for="target in airplayTargets" :key="target.targetId">
            <div
              v-if="pinTarget === target.targetId"
              class="cast-device-row cast-device-row-expanded"
              :class="{ active: isActiveTarget(target), connecting: isConnectingTarget(target) }"
            >
              <div class="cast-device-main">
                <span class="cast-device-name">{{ deviceName(target) }}</span>
                <span v-if="targetMeta(target)" class="cast-device-meta">
                  {{ targetMeta(target) }}
                </span>
              </div>
              <div class="cast-pin-form">
                <Input
                  v-model="pin"
                  class="cast-pin-input"
                  input-class="cast-pin-input-control"
                  placeholder="输入密码/验证码"
                  maxlength="32"
                  @keydown.enter.prevent="submitPin"
                />
                <Button
                  class="cast-pin-submit"
                  variant="secondary"
                  size="none"
                  :disabled="output.busy"
                  @click="submitPin"
                >
                  连接
                </Button>
              </div>
            </div>
            <button
              v-else
              type="button"
              class="cast-device-row app-focus-ring-soft"
              :class="{ active: isActiveTarget(target), connecting: isConnectingTarget(target) }"
              :disabled="output.busy || !settingStore.networkPlaybackEnabled"
              @click="choose(target)"
            >
              <span class="cast-device-name">{{ deviceName(target) }}</span>
              <span v-if="isConnectingTarget(target)" class="cast-device-meta is-connecting">
                <Icon :icon="iconLoader2" width="12" height="12" class="animate-spin" />
                连接中
              </span>
              <span v-else-if="targetMeta(target)" class="cast-device-meta">
                {{ targetMeta(target) }}
              </span>
            </button>
          </template>
          <p v-if="airplayTargets.length === 0" class="cast-empty">
            {{ output.searching ? '正在搜索设备' : '没有找到设备' }}
          </p>
        </Scrollbar>
      </section>
    </div>
  </div>
</template>

<style scoped>
.cast-panel {
  width: 286px;
  max-width: calc(100vw - 32px);
  display: flex;
  flex-direction: column;
  gap: 7px;
  color: var(--color-text-main);
}

.cast-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 2px 2px 4px;
}

.cast-panel-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
}

.cast-panel-actions {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
}

.cast-panel-title strong,
.cast-section-title span {
  display: block;
  font-size: 13px;
  font-weight: 800;
}

.cast-panel-title span,
.cast-section-title small,
.cast-device-meta,
.cast-empty,
.cast-panel-status {
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 600;
}

.cast-panel-title > div {
  min-width: 0;
}

.cast-panel-title > div > span {
  display: block;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cast-panel-icon,
.cast-panel-icon-button {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
}

.cast-panel-icon {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  color: var(--color-primary-text);
}

.cast-panel-status {
  display: flex;
  min-height: 30px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 2px 0 8px;
  border-radius: 8px;
  background: var(--control-muted-bg);
}

.cast-panel-status.warning {
  color: #ef4444;
  background: color-mix(in srgb, #ef4444 10%, transparent);
}

.cast-panel-status span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cast-panel-icon-button {
  width: 24px;
  height: 24px;
  border-radius: 7px;
  color: var(--color-text-secondary);
}

.cast-panel-icon-button:hover:not(:disabled) {
  color: var(--color-primary-text);
  background: var(--control-hover-bg);
}

.cast-current {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 7px 6px 8px;
  border: 1px solid color-mix(in srgb, var(--color-primary) 24%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  font-size: 12px;
  font-weight: 700;
}

.cast-stop-button {
  height: 30px;
  padding: 0 12px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 800;
  white-space: nowrap;
}

.cast-device-list {
  display: grid;
  gap: 7px;
}

.cast-device-list.disabled {
  opacity: 0.58;
}

.cast-device-list section {
  display: grid;
  gap: 5px;
  min-height: 0;
}

.cast-device-scroll {
  max-height: min(172px, calc(100vh - 260px));
  min-height: 0;
}

.cast-device-scroll :deep(.scrollbar-view) {
  display: grid;
  gap: 5px;
  padding-right: 4px;
}

.cast-section-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 1px 2px 0;
}

.cast-device-row {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  min-height: 32px;
  align-items: center;
  gap: 8px;
  padding: 0 7px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--color-text-main);
  background: transparent;
  text-align: left;
}

.cast-device-row:hover:not(:disabled),
.cast-device-row.active,
.cast-device-row.connecting {
  border-color: color-mix(in srgb, var(--color-primary) 20%, transparent);
  background: var(--control-hover-bg);
}

.cast-device-row.active {
  border-color: color-mix(in srgb, var(--color-primary) 18%, transparent);
  background: color-mix(in srgb, var(--color-primary) 6%, transparent);
}

.cast-device-row.active::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 999px;
  background: var(--color-primary);
}

.cast-device-row.active .cast-device-name {
  padding-left: 5px;
}

.cast-device-row.connecting {
  opacity: 1;
}

.cast-device-row-expanded {
  grid-template-columns: 1fr;
  align-items: stretch;
  gap: 7px;
  padding: 7px;
  border-color: color-mix(in srgb, var(--color-primary) 22%, transparent);
  background: color-mix(in srgb, var(--color-primary) 6%, var(--control-hover-bg));
}

.cast-device-main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.cast-device-name {
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cast-device-meta.is-connecting {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--color-primary-text);
}

.cast-empty {
  padding: 5px 8px;
}

.cast-pin-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px;
  align-items: center;
}

.cast-pin-input {
  min-width: 0;
}

.cast-pin-input :deep(.cast-pin-input-control) {
  height: 28px;
  padding-left: 8px;
  border-color: var(--control-border);
  border-radius: 7px;
  background: color-mix(in srgb, var(--floating-surface-bg) 84%, transparent);
  color: var(--color-text-main);
  font-size: 12px;
  font-weight: 650;
}

.cast-pin-input :deep(.cast-pin-input-control::placeholder) {
  color: var(--color-text-muted);
}

.cast-pin-input :deep(button[type='button']) {
  right: 5px;
  width: 20px;
  height: 20px;
  color: var(--color-text-secondary);
}

.cast-pin-input :deep(button[type='button']:hover) {
  color: var(--color-text-main);
  background: var(--control-hover-bg);
}

.cast-pin-submit {
  height: 28px;
  padding: 0 12px;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 800;
  white-space: nowrap;
}
</style>
