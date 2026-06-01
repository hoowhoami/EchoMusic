<script setup lang="ts">
import { computed } from 'vue';
import { useSettingStore } from '@/stores/setting';
import type { AppLogLevel } from '../../../../shared/logging';
import Switch from '@/components/ui/Switch.vue';
import InputNumber from '@/components/ui/InputNumber.vue';
import FontIcon from '@/components/ui/FontIcon.vue';
import Select from '@/components/ui/Select.vue';
import Button from '@/components/ui/Button.vue';
import { Icon } from '@iconify/vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';

const settingStore = useSettingStore();

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
        <p class="text-sm text-text-secondary">每次启动自动领取每日 VIP</p>
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
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
