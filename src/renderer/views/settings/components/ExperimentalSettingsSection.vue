<script setup lang="ts">
import { computed, ref } from 'vue';
import { useClipboard } from '@vueuse/core';
import { useSettingStore } from '@/stores/setting';
import { useUserStore } from '@/stores/user';
import { useDeviceStore } from '@/stores/device';
import { useToastStore } from '@/stores/toast';
import { buildAuthHeader } from '@/utils/request';
import { parseAccountImport } from '@/utils/accountImport';
import { suspendRendererMemoryDiagnosticsForRelaunch } from '@/utils/rendererMemoryDiagnostics';
import type { AppLogLevel } from '../../../../shared/logging';
import type { UserPatch } from '@/models/user';
import Switch from '@/components/ui/Switch.vue';
import InputNumber from '@/components/ui/InputNumber.vue';
import Slider from '@/components/ui/Slider.vue';
import FontIcon from '@/components/ui/FontIcon.vue';
import Select from '@/components/ui/Select.vue';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Textarea from '@/components/ui/Textarea.vue';
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

const diagnosticRestartLabel = computed(() =>
  settingStore.appIsPackaged ? '诊断并重启' : '开启启动诊断',
);

const restartWithDiagnostics = async () => {
  settingStore.enableTemporaryDiagnosticLogging(10);
  if (!settingStore.appIsPackaged) {
    toastStore.info('启动诊断已开启，请在终端重新运行 pnpm run dev');
    return;
  }

  suspendRendererMemoryDiagnosticsForRelaunch();
  try {
    await window.electron?.appInfo?.relaunch?.();
  } catch {
    toastStore.warning('诊断日志已开启，请手动重启应用以记录启动阶段');
  }
};

const platform = window.electron?.platform;
const supportsHighDpiOverride = computed(() => platform === 'win32' || platform === 'linux');
const dpiScaleLabel = computed(() => Number(settingStore.dpiScale || 1).toFixed(1));

// 开发者模式开启前先弹窗告知 CDP 端口风险，确认后才写入设置
const showDevToolsRiskConfirm = ref(false);
const devToolsPortLabel = computed(() => String(settingStore.devToolsDebugPort || 9223));
const updateDevToolsDebugPort = (value: string | number) => {
  const port = Math.round(Number(value));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
  if (port === settingStore.devToolsDebugPort) return;
  settingStore.devToolsDebugPort = port;
  settingStore.syncDevToolsDebugPort();
};
const requestEnableDevTools = () => {
  showDevToolsRiskConfirm.value = true;
};
const confirmEnableDevTools = () => {
  showDevToolsRiskConfirm.value = false;
  if (settingStore.devToolsEnabled) return;
  settingStore.devToolsEnabled = true;
  settingStore.syncDevToolsEnabled();
};
const disableDevTools = () => {
  if (!settingStore.devToolsEnabled) return;
  settingStore.devToolsEnabled = false;
  settingStore.syncDevToolsEnabled();
};

const showUserInfo = ref(false);
const showImportUserInfo = ref(false);
const importUserInfoText = ref('');
const pendingImport = ref<UserPatch | null>(null);
const showOverwriteConfirm = ref(false);
const importPlaceholder =
  'token=...; userid=...; t1=...\n或 {"userid": 123, "token": "...", "nickname": "..."}';
const showResetDeviceIdentityConfirm = ref(false);
const deviceIdentity = ref<{ guid: string; mac: string; serverDev: string; mid: string } | null>(
  null,
);

const userInfoEntries = computed(() => {
  const info = userStore.info;
  const device = deviceStore.info;
  const identity = deviceIdentity.value;
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
  push('guid', device?.guid ?? identity?.guid);
  push('dev', device?.serverDev ?? identity?.serverDev);
  push('mac', device?.mac ?? identity?.mac);
  return entries;
});

const showUserInfoDialog = async () => {
  try {
    deviceIdentity.value = await window.electron.apiServer.identity();
  } catch {
    // IPC 不可用时忽略
  }
  showUserInfo.value = true;
};

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

const copyUserInfo = async () => {
  const info = userStore.info;
  if (!info) {
    toastStore.warning('当前没有可用的用户信息，请先登录');
    return;
  }
  const payload = {
    userid: info.userid,
    token: info.token,
    t1: info.t1,
    nickname: info.nickname ?? info.username,
    pic: info.pic ?? info.userPic,
    expires: info.expires,
  };
  try {
    await copy(JSON.stringify(payload, null, 2));
    toastStore.success('用户信息已复制');
  } catch {
    toastStore.actionFailed('复制');
  }
};

const overwriteAccountLabel = computed(() => {
  const account = pendingImport.value;
  if (!account?.userid) return '';
  const nickname = account.nickname ?? account.username;
  return nickname ? `账号 ${account.userid}（${nickname}）` : `账号 ${account.userid}`;
});

const openImportUserInfo = () => {
  importUserInfoText.value = '';
  pendingImport.value = null;
  showOverwriteConfirm.value = false;
  showImportUserInfo.value = true;
};

const applyImportedAccount = (overwrite: boolean) => {
  const parsed = pendingImport.value;
  if (!parsed) return;
  const wasLoggedIn = userStore.isLoggedIn;
  try {
    const result = userStore.importAccount(parsed, { overwrite });
    if (!result.applied) {
      // 提交后账号列表发生变化：继续走覆盖确认，不修改已有账号。
      showOverwriteConfirm.value = true;
      return;
    }
    showOverwriteConfirm.value = false;
    showImportUserInfo.value = false;
    pendingImport.value = null;
    importUserInfoText.value = '';
    if (!wasLoggedIn) {
      toastStore.success('已恢复登录');
    } else if (result.existed) {
      toastStore.success('账号信息已覆盖');
    } else {
      toastStore.success('账号已添加到账号列表');
    }
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '导入失败，请检查内容');
  }
};

const submitImportUserInfo = () => {
  try {
    const parsed = parseAccountImport(importUserInfoText.value);
    pendingImport.value = parsed;
    if (userStore.savedAccounts.some((account) => account.userid === parsed.userid)) {
      showOverwriteConfirm.value = true;
      return;
    }
    applyImportedAccount(false);
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '导入失败，请检查内容');
  }
};

const cancelOverwriteConfirm = () => {
  showOverwriteConfirm.value = false;
};

const setHighDpiEnabled = (enabled: boolean) => {
  settingStore.highDpiEnabled = enabled;
  settingStore.syncHighDpiSettings();
};

const setDpiScale = (value: number) => {
  settingStore.dpiScale = Math.round((Number(value) || 1) * 10) / 10;
  settingStore.syncHighDpiSettings();
};

const confirmResetDeviceIdentity = async () => {
  showResetDeviceIdentityConfirm.value = false;
  deviceStore.clearDeviceInfo();
  userStore.logout();
  deviceIdentity.value = null;
  try {
    await deviceStore.$clearPersistedState();
  } catch {
    toastStore.warning('设备身份已清除，但持久化数据删除可能未完成');
  }

  if (!settingStore.appIsPackaged) {
    toastStore.warning('设备身份已清除，请重新启动开发服务后再登录');
    return;
  }

  try {
    await window.electron?.appInfo?.relaunch?.();
  } catch {
    toastStore.warning('设备身份已清除，请手动重启应用后再登录');
  }
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
        class="text-primary-text"
      />
      <FontIcon v-else :size="20" class="text-primary-text" />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">页面缓存</h3>
        <p class="text-sm text-text-secondary">保留已访问的页面，返回时无需重新加载</p>
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
        <h3 class="font-semibold">日志级别</h3>
        <p class="text-sm text-text-secondary">标准模式只记录关键运行信息、警告和错误</p>
      </div>
      <Select
        class="w-45 shrink-0"
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
          variant="unstyled"
          size="default"
          class="settings-action"
          v-if="diagnosticActive"
          @click="settingStore.disableTemporaryDiagnosticLogging()"
        >
          关闭
        </Button>
        <Button
          variant="unstyled"
          size="default"
          class="settings-action"
          @click="settingStore.enableTemporaryDiagnosticLogging(10)"
        >
          10 分钟
        </Button>
        <Button
          variant="unstyled"
          size="default"
          class="settings-action"
          @click="restartWithDiagnostics"
        >
          {{ diagnosticRestartLabel }}
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
    <template v-if="supportsHighDpiOverride">
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
            aria-label="缩放因子"
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
    </template>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">开发者模式</h3>
        <p class="text-sm text-text-secondary">
          允许打开开发者工具，并在本机开放 CDP 调试端口供外部连接，重启后生效
        </p>
      </div>
      <div class="flex w-45 flex-col gap-2">
        <Switch
          :model-value="settingStore.devToolsEnabled"
          @update:model-value="(v: boolean) => (v ? requestEnableDevTools() : disableDevTools())"
        />
        <InputNumber
          class="w-45"
          :model-value="devToolsPortLabel"
          :min="1024"
          :max="65535"
          :step="1"
          placeholder="9223"
          suffix="端口"
          aria-label="开发者模式调试端口"
          @update:model-value="updateDevToolsDebugPort"
        />
      </div>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">用户信息</h3>
        <p class="text-sm text-text-secondary">查看当前账号与设备信息，可复制鉴权头用于调试接口</p>
      </div>
      <Button variant="unstyled" size="default" class="settings-action" @click="showUserInfoDialog"
        >查看</Button
      >
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">导入用户信息</h3>
        <p class="text-sm text-text-secondary">粘贴鉴权头或账号 JSON，可直接复用登录状态</p>
      </div>
      <Button variant="unstyled" size="default" class="settings-action" @click="openImportUserInfo"
        >导入</Button
      >
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">重置设备身份</h3>
        <p class="text-sm text-text-secondary">
          清除本机 guid、mid、dfid，并在重启后重新生成设备身份
        </p>
      </div>
      <Button
        variant="unstyled"
        size="default"
        class="settings-action settings-action-danger"
        @click="showResetDeviceIdentityConfirm = true"
      >
        重置
      </Button>
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
        <Button variant="outline" size="default" @click="copyUserInfo">复制用户信息</Button>
        <Button variant="primary" size="default" @click="copyAuthHeader">复制鉴权头</Button>
      </template>
    </Dialog>

    <Dialog
      v-model:open="showImportUserInfo"
      title="导入用户信息"
      description="支持粘贴「复制鉴权头」的内容或包含 userid/token 的 JSON。已登录时只会添加到账号列表，不会切换当前账号。"
    >
      <div class="import-user-info">
        <Textarea
          v-model="importUserInfoText"
          :rows="6"
          spellcheck="false"
          :placeholder="importPlaceholder"
        />
        <p class="import-user-info-hint">
          未登录时导入会直接恢复登录；账号已存在时会先询问是否覆盖。
        </p>
      </div>
      <template #footer>
        <Button variant="outline" size="default" @click="showImportUserInfo = false">取消</Button>
        <Button variant="primary" size="default" @click="submitImportUserInfo">导入</Button>
      </template>
    </Dialog>

    <Dialog
      v-model:open="showOverwriteConfirm"
      title="账号已存在"
      :description="`${overwriteAccountLabel} 已在账号列表中，是否使用导入的信息覆盖？`"
    >
      <template #footer>
        <Button variant="outline" size="default" @click="cancelOverwriteConfirm">取消</Button>
        <Button variant="danger" size="default" @click="applyImportedAccount(true)">覆盖</Button>
      </template>
    </Dialog>

    <Dialog
      v-model:open="showResetDeviceIdentityConfirm"
      title="重置设备身份"
      description="这会清除本机设备标识并退出当前账号。重启后会生成新的设备身份，酷狗可能会把它视为一台新设备。"
    >
      <template #footer>
        <Button variant="outline" size="default" @click="showResetDeviceIdentityConfirm = false">
          取消
        </Button>
        <Button variant="danger" size="default" @click="confirmResetDeviceIdentity">
          确认重置
        </Button>
      </template>
    </Dialog>
    <Dialog
      v-model:open="showDevToolsRiskConfirm"
      title="开启开发者模式"
      :description="`开启后应用将在本机开放 CDP 调试端口（127.0.0.1:${devToolsPortLabel}）。`"
    >
      <div class="devtools-risk-hint">
        <p>
          本机任意程序都可通过该调试端口完全控制应用：读取账号凭证与本地数据、执行任意代码、操控界面与文件。
        </p>
        <p>
          仅在需要调试时开启，用完请及时关闭；端口被其他程序占用时调试端口将不可用。变更将在重启应用后生效。
        </p>
      </div>
      <template #footer>
        <Button variant="outline" size="default" @click="showDevToolsRiskConfirm = false">
          取消
        </Button>
        <Button variant="danger" size="default" @click="confirmEnableDevTools">仍要开启</Button>
      </template>
    </Dialog>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>

<style scoped>
.devtools-risk-hint {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
}

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
  border-radius: var(--radius-item);
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

.import-user-info {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.import-user-info-hint {
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-secondary);
}
</style>
