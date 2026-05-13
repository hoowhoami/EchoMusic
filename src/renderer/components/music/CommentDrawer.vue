<script setup lang="ts">
import { ref, watch } from 'vue';
import type { ComponentPublicInstance } from 'vue';
import { useVModel } from '@vueuse/core';
import Drawer from '@/components/ui/Drawer.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import CommentList from '@/components/music/CommentList.vue';
import Button from '@/components/ui/Button.vue';
import { iconX } from '@/icons';
import { useComments, type CommentResourceType } from '@/composables/useComments';

interface Props {
  open?: boolean;
  resourceId: string;
  resourceType?: CommentResourceType;
  mixSongId?: string;
  title?: string;
}

const props = withDefaults(defineProps<Props>(), {
  open: false,
  resourceType: 'music',
  title: '评论',
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

const open = useVModel(props, 'open', emit, { defaultValue: false });
const scrollRef = ref<HTMLElement | null>(null);
let currentResourceKey = '';

const setScrollRef = (target: Element | ComponentPublicInstance | null) => {
  scrollRef.value = target instanceof HTMLElement ? target : null;
};

const {
  isLoadingComments,
  comments,
  hasMore,
  singerComments,
  showCommentsEnd,
  fetchComments,
  updateResource,
  total,
  stop,
  resume,
} = useComments({
  resourceId: props.resourceId,
  resourceType: props.resourceType,
  mixSongId: props.mixSongId,
});

const handleScroll = () => {
  if (!scrollRef.value) return;
  const { scrollTop, scrollHeight, clientHeight } = scrollRef.value;
  if (scrollHeight - scrollTop - clientHeight < 300) {
    if (!isLoadingComments.value && hasMore.value) {
      void fetchComments();
    }
  }
};

const resourceKey = () => `${props.resourceType}:${props.resourceId}:${props.mixSongId ?? ''}`;

// 资源变化时：打开状态下立即刷新，关闭状态下标记为需要刷新
watch(
  () => resourceKey(),
  async (newKey) => {
    if (newKey === currentResourceKey) return;
    updateResource({
      resourceId: props.resourceId,
      resourceType: props.resourceType,
      mixSongId: props.mixSongId,
    });
    if (open.value) {
      currentResourceKey = newKey;
      await fetchComments(true);
    } else {
      // 标记为需要刷新，下次打开时会重新加载
      currentResourceKey = '';
    }
  },
);

watch(
  () => open.value,
  async (isOpen) => {
    if (isOpen) {
      resume();
      const key = resourceKey();
      if (key !== currentResourceKey || comments.value.length === 0) {
        currentResourceKey = key;
        updateResource({
          resourceId: props.resourceId,
          resourceType: props.resourceType,
          mixSongId: props.mixSongId,
        });
        await fetchComments(true);
      }
    } else {
      stop();
    }
  },
);
</script>

<template>
  <Drawer
    v-model:open="open"
    side="right"
    overlayClass="comment-drawer-overlay"
    panelClass="comment-drawer"
  >
    <div class="comment-drawer-header">
      <div class="comment-drawer-heading">
        <div class="comment-drawer-title">{{ title }}</div>
        <div v-if="total > 0" class="comment-drawer-meta">{{ total }} 条</div>
      </div>
      <Button
        type="button"
        class="comment-drawer-close"
        variant="ghost"
        size="xs"
        title="关闭"
        @click="open = false"
      >
        <Icon :icon="iconX" width="20" height="20" />
      </Button>
    </div>

    <Scrollbar
      :hide-scrollbar="false"
      class="flex-1 min-h-0"
      :content-props="{ ref: setScrollRef }"
      @scroll="handleScroll"
    >
      <div class="comment-drawer-body">
        <div v-if="singerComments.length" class="comment-drawer-section">歌手说</div>
        <CommentList
          v-if="singerComments.length"
          :comments="singerComments"
          :loading="false"
          :resourceType="resourceType"
          :fallbackMixSongId="mixSongId || resourceId"
          compact
          hide-empty
        />
        <div v-if="singerComments.length" class="comment-drawer-divider"></div>

        <CommentList
          :comments="comments"
          :loading="isLoadingComments"
          :resourceType="resourceType"
          :fallbackMixSongId="mixSongId || resourceId"
          compact
        />

        <div v-if="isLoadingComments || showCommentsEnd" class="comment-drawer-load-more">
          <div v-if="isLoadingComments" class="comment-drawer-loading-inline">
            <div class="comment-drawer-loading-spinner"></div>
            <span>加载中...</span>
          </div>
          <div v-else class="comment-drawer-end-hint">已加载全部评论</div>
        </div>
      </div>
    </Scrollbar>
  </Drawer>
</template>

<style scoped>
@reference "@/style.css";

:global(.comment-drawer-overlay) {
  z-index: 1500;
  background: rgba(0, 0, 0, 0.16);
}

:global(.comment-drawer) {
  z-index: 1510;
  padding: 0;
  box-shadow: none;
  bottom: 0;
  border-radius: 18px 0 0 18px;
  width: min(460px, 88vw);
  font-size: 13px;
}

.comment-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 20px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-border-light) 60%, transparent);
}

.comment-drawer-heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.comment-drawer-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--color-text-main);
}

.comment-drawer-meta {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.comment-drawer-close {
  width: 32px;
  height: 32px;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: color-mix(in srgb, var(--color-text-main) 50%, transparent);
  background: transparent;
  border: 0;
  box-shadow: none;
}

.comment-drawer-close:hover {
  color: var(--color-text-main);
}

.comment-drawer-body {
  padding: 12px 16px 24px;
}

/* 抽屉内评论文字缩小 */
.comment-drawer-body :deep(.comment-name) {
  font-size: 12px;
}

.comment-drawer-body :deep(.comment-content) {
  font-size: 12px;
  margin-top: 8px;
}

.comment-drawer-body :deep(.comment-item) {
  padding: 14px;
  margin-bottom: 8px;
  border-radius: 16px;
}

.comment-drawer-body :deep(.comment-avatar) {
  width: 30px;
  height: 30px;
  border-radius: 15px;
}

.comment-drawer-body :deep(.comment-reply) {
  font-size: 11px;
  margin-top: 8px;
}

.comment-drawer-body :deep(.comment-like) {
  font-size: 10px;
  padding: 4px 8px;
}

.comment-drawer-body :deep(.comment-floor-inline) {
  padding: 10px 12px;
}

.comment-drawer-body :deep(.comment-floor-reply-content) {
  font-size: 12px;
}

.comment-drawer-body :deep(.comment-floor-reply-name) {
  font-size: 11px;
}

.comment-drawer-section {
  margin: 12px 0 8px;
  padding: 0 4px;
  font-size: 13px;
  font-weight: 700;
  color: color-mix(in srgb, var(--color-text-main) 70%, transparent);
}

.comment-drawer-divider {
  margin: 12px 4px;
  height: 1px;
  background: color-mix(in srgb, var(--color-border-light) 50%, transparent);
}

.comment-drawer-load-more {
  display: flex;
  justify-content: center;
  margin: 18px 0 12px;
}

.comment-drawer-loading-inline {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.comment-drawer-loading-spinner {
  width: 16px;
  height: 16px;
  border-radius: 999px;
  border: 2px solid color-mix(in srgb, var(--color-primary) 28%, transparent);
  border-top-color: var(--color-primary);
  animation: comment-drawer-spin 0.8s linear infinite;
}

@keyframes comment-drawer-spin {
  to {
    transform: rotate(360deg);
  }
}

.comment-drawer-end-hint {
  font-size: 12px;
  font-weight: 600;
  color: color-mix(in srgb, var(--color-text-main) 42%, transparent);
}
</style>
