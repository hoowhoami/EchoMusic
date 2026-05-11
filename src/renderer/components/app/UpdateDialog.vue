<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { useVModel } from '@vueuse/core';
import { marked } from 'marked';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import type { UpdateCheckResult } from '@/../shared/app';
import type { UpdateDownloadStatus } from '@/../shared/app';
import { useSettingStore } from '@/stores/setting';

interface Props {
  open?: boolean;
  result: UpdateCheckResult | null;
  dismissLabel?: string;
}

const props = withDefaults(defineProps<Props>(), {
  open: false,
  dismissLabel: '关闭',
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

const open = useVModel(props, 'open', emit, { defaultValue: false });

const downloadStatus = ref<UpdateDownloadStatus>('idle');
const downloadPercent = ref(0);
const downloadError = ref('');
let disposeListener: (() => void) | null = null;

const title = computed(() => {
  const r = props.result;
  if (!r) return '检查更新';
  if (r.status === 'available') {
    return `发现新版本 ${r.releaseName || r.latestVersion || ''}`.trim();
  }
  if (r.status === 'latest') return '已是最新版本';
  return '检查更新失败';
});

const description = computed(() => {
  const r = props.result;
  if (!r) return '';
  if (r.status === 'available') {
    return `当前版本 v${r.currentVersion}，发现新版本 ${r.releaseName || r.latestVersion || ''}`.trim();
  }
  if (r.status === 'latest') {
    return `当前版本 v${r.currentVersion} 已是最新版本。`;
  }
  return r.message || '暂时无法获取更新信息，请稍后再试。';
});

const bodyHtml = computed(() => {
  const raw = props.result?.body?.trim();
  if (!raw) return '';
  // 如果已经是 HTML（GitHub API 返回的 body_html），直接用
  if (raw.startsWith('<')) return raw;
  // 否则用 marked 渲染 markdown
  return marked.parse(raw, { async: false }) as string;
});

const handleDownload = () => {
  downloadStatus.value = 'downloading';
  downloadPercent.value = 0;
  downloadError.value = '';
  window.electron?.updater?.download();
};

const handleInstall = () => {
  const settingStore = useSettingStore();
  window.electron?.updater?.install(settingStore.silentUpdate);
};

const handleOpenRelease = () => {
  const url = props.result?.releaseUrl;
  if (!url) return;
  window.electron?.ipcRenderer?.send('open-external', url);
};

// 重置下载状态（弹窗关闭时或 result 变化时）
const resetDownload = () => {
  downloadStatus.value = 'idle';
  downloadPercent.value = 0;
  downloadError.value = '';
};

onMounted(() => {
  disposeListener =
    window.electron?.updater?.onDownloadStatus((result) => {
      downloadStatus.value = result.status;
      if (result.progress) {
        downloadPercent.value = Math.round(result.progress.percent);
      }
      if (result.error) {
        downloadError.value = result.error;
      }
    }) ?? null;
});

onUnmounted(() => {
  disposeListener?.();
  disposeListener = null;
});

const handleClose = () => {
  open.value = false;
  resetDownload();
};
</script>

<template>
  <Dialog
    v-model:open="open"
    :title="title"
    :description="description"
    showClose
    noScroll
    :content-style="{ width: '520px' }"
  >
    <Scrollbar v-if="bodyHtml" class="update-changelog" :content-props="{ class: 'px-4 py-3' }">
      <div class="changelog-content" v-html="bodyHtml"></div>
    </Scrollbar>

    <template #footer>
      <!-- 左侧：进度条 -->
      <div
        v-if="
          result?.status === 'available' &&
          (downloadStatus === 'downloading' || downloadStatus === 'downloaded')
        "
        class="flex-1 min-w-0 flex items-center gap-2 mr-3"
      >
        <span class="text-xs text-text-secondary shrink-0">
          {{ downloadStatus === 'downloaded' ? '下载完成' : `${downloadPercent}%` }}
        </span>
        <div class="flex-1 h-1.5 rounded-full bg-black/5 dark:bg-white/10 overflow-hidden">
          <div
            class="h-full rounded-full bg-primary transition-all duration-300"
            :style="{ width: `${downloadPercent}%` }"
          ></div>
        </div>
      </div>
      <div
        v-else-if="result?.status === 'available' && downloadStatus === 'error'"
        class="flex-1 min-w-0 mr-3 flex items-center gap-2"
      >
        <span class="text-xs text-red-500 truncate">
          下载失败：{{ downloadError || '未知错误' }}
        </span>
        <Button variant="ghost" size="sm" @click="handleOpenRelease">前往下载</Button>
      </div>
      <div v-else class="flex-1"></div>

      <!-- 右侧：按钮 -->
      <Button variant="ghost" size="sm" @click="handleClose">{{ dismissLabel }}</Button>
      <template v-if="result?.status === 'available'">
        <Button v-if="result?.releaseUrl" variant="ghost" size="sm" @click="handleOpenRelease">
          前往下载
        </Button>
        <Button
          v-if="downloadStatus === 'downloaded'"
          variant="primary"
          size="sm"
          @click="handleInstall"
        >
          立即安装
        </Button>
        <Button v-else-if="downloadStatus === 'downloading'" variant="secondary" size="sm" disabled>
          下载中
        </Button>
        <Button v-else variant="primary" size="sm" @click="handleDownload"> 立即更新 </Button>
      </template>
    </template>
  </Dialog>
</template>

<style scoped>
.update-changelog {
  max-height: min(288px, 40vh);
  font-size: 13px;
  line-height: 1.5;
  color: var(--color-text-secondary);
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.03);
}

:global(.dark) .update-changelog {
  background: rgba(255, 255, 255, 0.04);
}

.changelog-content :deep(h2) {
  font-size: 14px;
  font-weight: 800;
  color: var(--color-text-main);
  margin: 16px 0 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

:global(.dark) .changelog-content :deep(h2) {
  border-bottom-color: rgba(255, 255, 255, 0.08);
}

.changelog-content :deep(h2:first-child) {
  margin-top: 0;
}

.changelog-content :deep(h3),
.changelog-content :deep(h4) {
  font-size: 13px;
  font-weight: 700;
  color: var(--color-text-main);
  margin: 12px 0 4px;
}

.changelog-content :deep(h3:first-child),
.changelog-content :deep(h4:first-child) {
  margin-top: 0;
}

.changelog-content :deep(ul) {
  list-style: none;
  padding: 0;
  margin: 0 0 4px;
}

.changelog-content :deep(li) {
  position: relative;
  padding-left: 14px;
  line-height: 1.8;
}

.changelog-content :deep(li::before) {
  content: '·';
  position: absolute;
  left: 2px;
  font-weight: 700;
}

.changelog-content :deep(p) {
  margin: 4px 0;
}
</style>
