<script setup lang="ts">
import { useSettingStore } from '@/stores/setting';
import Switch from '@/components/ui/Switch.vue';
import InputNumber from '@/components/ui/InputNumber.vue';
import FontIcon from '@/components/ui/FontIcon.vue';
import { Icon } from '@iconify/vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';

const settingStore = useSettingStore();
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
