<script setup lang="ts">
import { computed, ref } from 'vue';
import { useClipboard } from '@vueuse/core';
import { useSettingStore } from '@/stores/setting';
import { useUserStore } from '@/stores/user';
import { useDeviceStore } from '@/stores/device';
import { useToastStore } from '@/stores/toast';
import { buildAuthHeader } from '@/utils/request';
import type { AppLogLevel } from '../../../../shared/logging';
import Switch from '@/components/ui/Switch.vue';
import Input from '@/components/ui/Input.vue';
import InputNumber from '@/components/ui/InputNumber.vue';
import Slider from '@/components/ui/Slider.vue';
import FontIcon from '@/components/ui/FontIcon.vue';
import Select from '@/components/ui/Select.vue';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import { Icon } from '@iconify/vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';

const settingStore = useSettingStore();
const userStore = useUserStore();
const deviceStore = useDeviceStore();
const toastStore = useToastStore();
const { copy } = useClipboard();

const logLevelOptions: { label: string; value: AppLogLevel }[] = [
  { label: '标准', value: 'info' },
  { label: '详细', value: 'debug' },
  { label: '极详细', value: 'verbose' },
  { label: '仅警告', value: 'warn' },
  { label: '仅错误', value: 'error' },
];

const diagnosticActive = computed(() => settingStore.logDiagnosticUntil > Date.now());

const diagnosticLabel = computed(() => {
  if (!diagnosticActive.value) return '未启用';
  const remaining = Math.max(0, settingStore.logDiagnosticUntil - Date.now());
  return `剩余约 ${Math.ceil(remaining / 60000)} 分钟`;
});

const dpiScaleLabel = computed(() => Number(settingStore.dpiScale || 1).toFixed(1));

const showUserInfo = ref(false);

const userInfoEntries = computed(() => {
  const info = userStore.info;
  const device = deviceStore.info;
  const entries: { label: string; value: string }[] = [];
  const push = (label: string, value: string | number | undefined | null) => {
    if (value !== undefined && value !== null && String(value).length > 0) {
      entries.push({ label, value: String(value) });
    }
  };
  push('用户 ID', info?.userid);
  push('昵称', info?.nickname ?? info?.username);
  push('token', info?.token);
  push('t1', info?.t1);
  push('dfid', device?.dfid);
  push('mid', device?.mid);
  push('uuid', device?.uuid);
  push('guid', device?.guid);
  push('dev', device?.serverDev);
  push('mac', device?.mac);
  return entries;
});

const copyAuthHeader = async () => {
  const header = buildAuthHeader();
  if (!header) {
    toastStore.warning('当前没有可用的鉴权头，请先登录');
    return;
  }
  try {
    await copy(header);
    toastStore.success('鉴权头已复制');
  } catch {
    toastStore.actionFailed('复制');
  }
};

const setHighDpiEnabled = (enabled: boolean) => {
  settingStore.highDpiEnabled = enabled;
  settingStore.syncHighDpiSettings();
};

const setDpiScale = (value: number) => {
  settingStore.dpiScale = Math.round((Number(value) || 1) * 10) / 10;
  settingStore.syncHighDpiSettings();
};
</script>

<template>
  <SettingsSectionShell id="experimental" :title="sectionTitles.experimental.label">
    <template #icon>
      <Icon
        v-if="sectionTitles.experimental.icon"
        :icon="sectionTitles.experimental.icon"
        width="20"
        height="20"
        class="text-primary"
      />
      <FontIcon v-else :size="20" class="text-primary" />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">自动领取 VIP</h3>
        <p class="text-sm text-text-secondary">每次进入个人中心时自动领取每日会员权益</p>
      </div>
      <Switch v-model="settingStore.autoReceiveVip" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">页面缓存</h3>
        <p class="text-sm text-text-secondary">
          缓存已访问的页面，返回时无需重新加载，关闭后所有页面不缓存
        </p>
      </div>
      <Switch v-model="settingStore.keepAliveEnabled" />
    </div>
    <template v-if="settingStore.keepAliveEnabled">
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">最大缓存页面数</h3>
          <p class="text-sm text-text-secondary">超出后自动释放最早缓存的页面，避免占用过多内存</p>
        </div>
        <InputNumber
          class="w-45"
          :model-value="String(settingStore.keepAliveMax)"
          :min="3"
          :max="30"
          :step="1"
          placeholder="20"
          @update:model-value="
            (val) => {
              const parsed = Number.parseInt(String(val), 10);
              settingStore.keepAliveMax = Number.isNaN(parsed)
                ? 20
                : Math.max(3, Math.min(parsed, 30));
            }
          "
        />
      </div>
    </template>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">GitHub 加速地址</h3>
        <p class="text-sm text-text-secondary">
          用于更新检测、在线插件源和插件下载，留空则直连 GitHub
        </p>
      </div>
      <Input
        v-model="settingStore.githubProxyUrl"
        placeholder="https://ghfast.top"
        class="w-60! rounded-lg"
        input-class="!h-9 !rounded-lg !pl-3 !pr-8 !text-sm"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">日志级别</h3>
        <p class="text-sm text-text-secondary">标准模式只记录关键运行信息、警告和错误</p>
      </div>
      <Select
        class="w-36"
        :model-value="settingStore.logLevel"
        :options="logLevelOptions"
        @update:model-value="(value) => settingStore.setLogLevel(value as AppLogLevel)"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">API 响应体日志</h3>
        <p class="text-sm text-text-secondary">仅排查接口问题时开启，内容会裁剪并脱敏</p>
      </div>
      <Switch
        :model-value="settingStore.logApiResponseBody"
        @update:model-value="(enabled: boolean) => settingStore.setLogApiResponseBody(enabled)"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">临时诊断日志</h3>
        <p class="text-sm text-text-secondary">{{ diagnosticLabel }}</p>
      </div>
      <div class="flex items-center gap-2">
        <Button
          v-if="diagnosticActive"
          variant="outline"
          size="xs"
          @click="settingStore.disableTemporaryDiagnosticLogging()"
        >
          关闭
        </Button>
        <Button
          variant="secondary"
          size="xs"
          @click="settingStore.enableTemporaryDiagnosticLogging(10)"
        >
          10 分钟
        </Button>
      </div>
    </div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">禁用 GPU 加速</h3>
        <p class="text-sm text-text-secondary">遇到界面花屏等渲染异常时可尝试开启，重启后生效</p>
      </div>
      <Switch
        :model-value="settingStore.disableGpuAcceleration"
        @update:model-value="
          (v: boolean) => {
            settingStore.disableGpuAcceleration = v;
            settingStore.syncDisableGpuAcceleration();
          }
        "
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">高 DPI 支持</h3>
        <p class="text-sm text-text-secondary">按指定缩放因子适配高分屏，重启后生效</p>
      </div>
      <Switch
        :model-value="settingStore.highDpiEnabled"
        @update:model-value="setHighDpiEnabled(Boolean($event))"
      />
    </div>
    <template v-if="settingStore.highDpiEnabled">
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">缩放因子</h3>
          <p class="text-sm text-text-secondary">当前 {{ dpiScaleLabel }}，范围 0.5 至 2.0</p>
        </div>
        <Slider
          class="w-60"
          :model-value="settingStore.dpiScale"
          :min="0.5"
          :max="2"
          :step="0.1"
          show-value
          :format-value="(value) => value.toFixed(1)"
          @update:model-value="setDpiScale"
          @value-commit="setDpiScale"
        />
      </div>
    </template>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">开发者工具</h3>
        <p class="text-sm text-text-secondary">开启后允许打开开发者工具进行调试，重启后生效</p>
      </div>
      <Switch
        :model-value="settingStore.devToolsEnabled"
        @update:model-value="
          (v: boolean) => {
            settingStore.devToolsEnabled = v;
            settingStore.syncDevToolsEnabled();
          }
        "
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">用户信息</h3>
        <p class="text-sm text-text-secondary">查看当前账号与设备信息，可复制鉴权头用于调试接口</p>
      </div>
      <Button variant="secondary" size="xs" @click="showUserInfo = true">查看</Button>
    </div>

    <Dialog v-model:open="showUserInfo" title="用户信息" showClose contentClass="user-info-dialog">
      <div class="user-info-list">
        <div v-for="entry in userInfoEntries" :key="entry.label" class="user-info-row">
          <span class="user-info-label">{{ entry.label }}</span>
          <span class="user-info-value">{{ entry.value }}</span>
        </div>
        <p v-if="userInfoEntries.length === 0" class="user-info-empty">暂无用户信息，请先登录</p>
      </div>
      <template #footer>
        <Button variant="primary" size="sm" @click="copyAuthHeader">复制鉴权头</Button>
      </template>
    </Dialog>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>

<style scoped>
.user-info-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 60vh;
  overflow-y: auto;
}

.user-info-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--control-muted-bg);
}

.user-info-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--color-text-secondary);
}

.user-info-value {
  font-size: 13px;
  color: var(--color-text-main);
  word-break: break-all;
  user-select: text;
}

.user-info-empty {
  padding: 20px 0;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-secondary);
}
</style>
