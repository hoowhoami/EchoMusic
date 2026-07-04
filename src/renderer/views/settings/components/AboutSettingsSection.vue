<script setup lang="ts">
import { computed } from 'vue';
import { useSettingStore } from '@/stores/setting';
import Button from '@/components/ui/Button.vue';
import Switch from '@/components/ui/Switch.vue';
import FontIcon from '@/components/ui/FontIcon.vue';
import { Icon } from '@iconify/vue';
import { iconChevronRight, iconExternalLink } from '@/icons';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';

const settingStore = useSettingStore();

const versionLabel = computed(() => settingStore.appVersion || '未知');
const releaseChannelLabel = computed(() => (settingStore.isPrerelease ? 'Prerelease' : 'Release'));

defineProps<{
  isCheckingUpdate: boolean;
  onCheckUpdates: () => void;
  onShowChangelog: () => void;
  onShowDisclaimer: () => void;
}>();
</script>

<template>
  <SettingsSectionShell id="about" :title="sectionTitles.about.label">
    <template #icon>
      <Icon
        v-if="sectionTitles.about.icon"
        :icon="sectionTitles.about.icon"
        width="20"
        height="20"
        class="text-primary"
      />
      <FontIcon v-else :size="20" class="text-primary" />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">自动检查更新</h3>
        <p class="text-sm text-text-secondary">启动时自动检查是否有新版本</p>
      </div>
      <Switch v-model="settingStore.autoCheckUpdate" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">检查预发布版本</h3>
        <p class="text-sm text-text-secondary">开启后可收到 Alpha/Beta/RC 版本更新推送</p>
      </div>
      <Switch v-model="settingStore.checkPrerelease" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">静默安装</h3>
        <p class="text-sm text-text-secondary">更新安装时不弹出安装向导，后台自动完成</p>
      </div>
      <Switch v-model="settingStore.silentUpdate" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1 text-left min-w-0">
        <h3 class="font-semibold">当前版本</h3>
        <p class="text-sm text-text-secondary">
          Version v{{ versionLabel }} {{ releaseChannelLabel }}
        </p>
      </div>
      <div class="flex items-center gap-2">
        <Button
          variant="ghost"
          size="xs"
          class="text-text-secondary text-sm font-semibold"
          @click="onShowChangelog"
        >
          更新日志
        </Button>
        <Button
          variant="ghost"
          size="xs"
          class="text-primary text-sm font-semibold"
          :disabled="isCheckingUpdate"
          @click="onCheckUpdates"
        >
          {{ isCheckingUpdate ? '检查中...' : '检查更新' }}
        </Button>
      </div>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">项目源码</h3>
        <p class="text-sm text-text-secondary">开源共享于 GitHub</p>
      </div>
      <Button
        variant="ghost"
        size="xs"
        class="text-text-secondary h-10 w-10 min-w-0 p-0"
        @click="settingStore.openRepo()"
      >
        <Icon :icon="iconExternalLink" width="20" height="20" />
      </Button>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">免责声明</h3>
        <p class="text-sm text-text-secondary">查看法律条款与免责声明</p>
      </div>
      <Button
        variant="ghost"
        size="xs"
        class="text-text-secondary h-10 w-10 min-w-0 p-0"
        @click="onShowDisclaimer"
      >
        <Icon :icon="iconChevronRight" width="20" height="20" />
      </Button>
    </div>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
