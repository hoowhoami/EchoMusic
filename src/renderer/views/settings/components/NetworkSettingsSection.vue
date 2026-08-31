<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Icon } from '@iconify/vue';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import InputNumber from '@/components/ui/InputNumber.vue';
import Select from '@/components/ui/Select.vue';
import {
  normalizeProxyPacScript,
  normalizeProxyRules,
  type NetworkProxyMode,
} from '../../../../shared/network';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';

const settingStore = useSettingStore();
const toastStore = useToastStore();
const proxyModeOptions = [
  { label: '跟随系统', value: 'system' },
  { label: '自动检测（WPAD）', value: 'auto_detect' },
  { label: 'PAC 脚本', value: 'pac_script' },
  { label: '手动代理', value: 'fixed_servers' },
  { label: '强制直连', value: 'direct' },
];
const proxyModeDraft = ref<NetworkProxyMode>(settingStore.proxyMode);
const proxyPacScriptDraft = ref(settingStore.proxyPacScript);
const proxyRulesDraft = ref(settingStore.proxyRules);
const proxyUsernameDraft = ref(settingStore.proxyUsername);
const proxyPasswordDraft = ref('');
const proxyBypassRulesDraft = ref(settingStore.proxyBypassRules);
const kugouApiTimeoutDraft = ref(settingStore.kugouApiTimeoutSecs);
const playerNetworkTimeoutDraft = ref(settingStore.playerNetworkTimeoutSecs);
const hasSavedProxyPassword = ref(false);
const clearSavedProxyPassword = ref(false);
const applyingProxy = ref(false);

const clampNumber = (value: string | number, fallback: number, min: number, max: number) => {
  const rawValue = typeof value === 'string' ? value.trim() : value;
  if (rawValue === '') return fallback;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const updateProxyModeDraft = (value: string | number | Array<string | number>) => {
  const next = String(Array.isArray(value) ? value[0] : value);
  proxyModeDraft.value = proxyModeOptions.some((item) => item.value === next)
    ? (next as NetworkProxyMode)
    : 'system';
};

const updateKugouApiTimeout = (value: string | number) => {
  kugouApiTimeoutDraft.value = clampNumber(value, 0, 0, 300);
};

const updatePlayerNetworkTimeout = (value: string | number) => {
  playerNetworkTimeoutDraft.value = clampNumber(value, 60, 1, 300);
};

const applyProxySettings = async () => {
  if (!window.electron?.network || applyingProxy.value) return;
  const proxyPacScript = normalizeProxyPacScript(proxyPacScriptDraft.value);
  const proxyRules = normalizeProxyRules(proxyRulesDraft.value);
  if (proxyModeDraft.value === 'pac_script' && !proxyPacScript) {
    toastStore.warning('请输入有效的 HTTP、HTTPS 或本地文件 PAC 地址');
    return;
  }
  if (proxyModeDraft.value === 'fixed_servers' && !proxyRules) {
    toastStore.warning('请输入有效的 Electron 代理规则');
    return;
  }

  applyingProxy.value = true;
  try {
    const password = proxyPasswordDraft.value || undefined;
    const result = await window.electron.network.update({
      settings: {
        ...settingStore.getNetworkSettings(),
        proxyMode: proxyModeDraft.value,
        proxyPacScript,
        proxyRules,
        proxyUsername: proxyUsernameDraft.value.trim(),
        proxyBypassRules: proxyBypassRulesDraft.value,
        kugouApiTimeoutSecs: kugouApiTimeoutDraft.value,
        playerNetworkTimeoutSecs: playerNetworkTimeoutDraft.value,
      },
      ...(password !== undefined ? { proxyPassword: password } : {}),
      clearProxyPassword: clearSavedProxyPassword.value,
    });
    settingStore.applyNetworkSettings(result.settings);
    proxyModeDraft.value = result.settings.proxyMode;
    proxyPacScriptDraft.value = result.settings.proxyPacScript;
    proxyRulesDraft.value = result.settings.proxyRules;
    proxyUsernameDraft.value = result.settings.proxyUsername;
    proxyBypassRulesDraft.value = result.settings.proxyBypassRules;
    kugouApiTimeoutDraft.value = result.settings.kugouApiTimeoutSecs;
    playerNetworkTimeoutDraft.value = result.settings.playerNetworkTimeoutSecs;
    proxyPasswordDraft.value = '';
    clearSavedProxyPassword.value = false;
    hasSavedProxyPassword.value = result.hasProxyPassword;
    toastStore.success('全局网络设置已应用');
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '应用网络设置失败');
  } finally {
    applyingProxy.value = false;
  }
};

const removeSavedProxyPassword = () => {
  proxyPasswordDraft.value = '';
  clearSavedProxyPassword.value = !clearSavedProxyPassword.value;
};

const updateProxyPasswordDraft = (value: unknown) => {
  proxyPasswordDraft.value = String(value ?? '');
  if (proxyPasswordDraft.value) clearSavedProxyPassword.value = false;
};

onMounted(async () => {
  try {
    const result = await window.electron?.network?.get();
    if (!result) return;
    settingStore.applyNetworkSettings(result.settings);
    proxyModeDraft.value = result.settings.proxyMode;
    proxyPacScriptDraft.value = result.settings.proxyPacScript;
    proxyRulesDraft.value = result.settings.proxyRules;
    proxyUsernameDraft.value = result.settings.proxyUsername;
    proxyBypassRulesDraft.value = result.settings.proxyBypassRules;
    kugouApiTimeoutDraft.value = result.settings.kugouApiTimeoutSecs;
    playerNetworkTimeoutDraft.value = result.settings.playerNetworkTimeoutSecs;
    hasSavedProxyPassword.value = result.hasProxyPassword;
  } catch {
    // 主进程启动设置已是可信回退值，读取失败时沿用渲染层状态。
  }
});
</script>

<template>
  <SettingsSectionShell id="network" :title="sectionTitles.network.label">
    <template #icon>
      <Icon
        v-if="sectionTitles.network.icon"
        :icon="sectionTitles.network.icon"
        width="20"
        height="20"
        class="text-primary"
      />
    </template>

    <div class="settings-notice">
      <p>全局代理点击“应用”后立即用于新连接；加速站是否直连由 bypass、系统或 PAC 决定</p>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">全局网络代理</h3>
        <p class="text-sm text-text-secondary">
          同时用于接口、封面、音频直链、更新和其他应用网络请求
        </p>
      </div>
      <Select
        class="w-45"
        :model-value="proxyModeDraft"
        :options="proxyModeOptions"
        aria-label="网络代理模式"
        @update:model-value="updateProxyModeDraft"
      />
    </div>
    <template v-if="proxyModeDraft === 'pac_script'">
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">PAC 脚本地址</h3>
          <p class="text-sm text-text-secondary">支持 HTTP、HTTPS 和 file:// 本地文件地址</p>
        </div>
        <Input
          :model-value="proxyPacScriptDraft"
          placeholder="https://example.com/proxy.pac"
          class="w-60! rounded-lg"
          input-class="!h-9 !rounded-lg !pl-3 !pr-8 !text-sm"
          @update:model-value="proxyPacScriptDraft = String($event ?? '')"
          @clear="proxyPacScriptDraft = ''"
        />
      </div>
    </template>
    <template v-if="proxyModeDraft === 'fixed_servers'">
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">代理规则</h3>
          <p class="text-sm text-text-secondary">
            Electron proxyRules，例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080
          </p>
        </div>
        <Input
          :model-value="proxyRulesDraft"
          placeholder="http://127.0.0.1:7890"
          class="w-60! rounded-lg"
          input-class="!h-9 !rounded-lg !pl-3 !pr-8 !text-sm"
          @update:model-value="proxyRulesDraft = String($event ?? '')"
          @clear="proxyRulesDraft = ''"
        />
      </div>
    </template>
    <template v-if="proxyModeDraft !== 'direct'">
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">代理认证</h3>
          <p class="text-sm text-text-secondary">
            HTTP/HTTPS 由全局网络栈认证；SOCKS5 认证仅原生音频支持
          </p>
        </div>
        <div class="flex w-60! flex-col gap-2">
          <Input
            :model-value="proxyUsernameDraft"
            placeholder="用户名（可选）"
            class="rounded-lg"
            input-class="!h-9 !rounded-lg !pl-3 !pr-8 !text-sm"
            @update:model-value="proxyUsernameDraft = String($event ?? '')"
            @clear="proxyUsernameDraft = ''"
          />
          <div class="flex items-center gap-2">
            <Input
              :model-value="proxyPasswordDraft"
              type="password"
              :placeholder="hasSavedProxyPassword ? '已安全保存，留空保持不变' : '密码（可选）'"
              class="min-w-0 flex-1 rounded-lg"
              input-class="!h-9 !rounded-lg !pl-3 !pr-8 !text-sm"
              @update:model-value="updateProxyPasswordDraft"
              @clear="proxyPasswordDraft = ''"
            />
            <Button
              v-if="hasSavedProxyPassword"
              variant="ghost"
              size="xs"
              type="button"
              @click="removeSavedProxyPassword"
            >
              {{ clearSavedProxyPassword ? '取消清除' : '清除' }}
            </Button>
          </div>
        </div>
      </div>
    </template>
    <template v-if="proxyModeDraft === 'fixed_servers'">
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">不代理地址</h3>
          <p class="text-sm text-text-secondary">
            逗号分隔；可加入 GitHub 加速站域名使其直连，默认 &lt;local&gt; 保护本机地址
          </p>
        </div>
        <Input
          :model-value="proxyBypassRulesDraft"
          placeholder="<local>"
          class="w-60! rounded-lg"
          input-class="!h-9 !rounded-lg !pl-3 !pr-8 !text-sm"
          @update:model-value="proxyBypassRulesDraft = String($event ?? '')"
          @clear="proxyBypassRulesDraft = ''"
        />
      </div>
    </template>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">GitHub 加速地址</h3>
        <p class="text-sm text-text-secondary">
          用于更新和在线插件；失败后自动切回原始 GitHub，两段均服从全局代理规则
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
        <h3 class="font-semibold">酷狗 API 超时</h3>
        <p class="text-sm text-text-secondary">接口请求超过该时间后中止，设为 0 使用默认行为</p>
      </div>
      <InputNumber
        class="w-45"
        :model-value="String(kugouApiTimeoutDraft)"
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
        <h3 class="font-semibold">播放器网络超时</h3>
        <p class="text-sm text-text-secondary">播放器打开音频直链的网络等待时间</p>
      </div>
      <InputNumber
        class="w-45"
        :model-value="String(playerNetworkTimeoutDraft)"
        :min="1"
        :max="300"
        :step="10"
        placeholder="60"
        suffix="秒"
        @update:model-value="updatePlayerNetworkTimeout"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">应用网络设置</h3>
        <p class="text-sm text-text-secondary">
          手动模式仅在 proxyRules 包含 direct:// 时回退直连；系统和 PAC 模式遵循解析结果
        </p>
      </div>
      <Button
        variant="outline"
        size="xs"
        type="button"
        :loading="applyingProxy"
        @click="applyProxySettings"
      >
        应用
      </Button>
    </div>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
