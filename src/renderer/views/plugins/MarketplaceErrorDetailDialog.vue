<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue';
import { Icon } from '@iconify/vue';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import { iconCheck, iconCopy } from '@/icons';
import { openSettingsDialog } from '@/composables/useSettingsDialog';
import type { MarketplaceErrorDetail } from '../../../shared/networkErrorClassifier';

const props = defineProps<{
  open: boolean;
  sourceName: string;
  detail: MarketplaceErrorDetail | null;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const formattedTime = computed(() =>
  props.detail ? new Date(props.detail.failedAt).toLocaleString() : '',
);

const copyRawMessage = async () => {
  if (!props.detail?.rawMessage) return;
  try {
    await navigator.clipboard.writeText(props.detail.rawMessage);
    copied.value = true;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    // 剪贴板不可用时静默忽略
  }
};

// 打开网络设置：先关闭详情弹窗，再直达设置页网络区块。
const openNetworkSettings = () => {
  emit('update:open', false);
  openSettingsDialog('network');
};

watch(
  () => props.open,
  (open) => {
    if (!open) copied.value = false;
  },
);

onUnmounted(() => {
  if (copiedTimer) clearTimeout(copiedTimer);
});
</script>

<template>
  <Dialog
    :open="open"
    title="加载失败详情"
    show-close
    content-class="plugin-failure-detail-dialog"
    body-class="plugin-failure-detail-body"
    @update:open="emit('update:open', $event)"
  >
    <div v-if="detail" class="plugin-failure-detail">
      <div class="plugin-failure-detail-grid">
        <span>错误类型</span>
        <strong>{{ detail.categoryLabel }}</strong>
        <span>插件源</span>
        <strong>{{ sourceName }}</strong>
        <span>发生时间</span>
        <strong>{{ formattedTime }}</strong>
        <template v-if="detail.httpStatus">
          <span>HTTP 状态</span>
          <strong>{{ detail.httpStatus }}</strong>
        </template>
        <template v-if="detail.url">
          <span>请求地址</span>
          <strong>{{ detail.url }}</strong>
        </template>
      </div>

      <div class="plugin-failure-detail-block">
        <h4>可能的原因</h4>
        <p>{{ detail.hint }}</p>
      </div>

      <div class="plugin-failure-detail-block">
        <div class="plugin-error-detail-heading">
          <h4>原始错误信息</h4>
          <button
            type="button"
            class="plugin-error-copy-btn"
            :aria-label="copied ? '已复制原始错误信息' : '复制原始错误信息'"
            @click="copyRawMessage"
          >
            <Icon :icon="copied ? iconCheck : iconCopy" width="12" height="12" />
            {{ copied ? '已复制' : '复制' }}
          </button>
        </div>
        <pre>{{ detail.rawMessage }}</pre>
      </div>
    </div>

    <template #footer>
      <div class="plugin-failure-detail-footer">
        <Button variant="secondary" size="default" @click="openNetworkSettings">
          打开网络设置
        </Button>
        <Button variant="secondary" size="default" @click="emit('update:open', false)">
          关闭
        </Button>
      </div>
    </template>
  </Dialog>
</template>
