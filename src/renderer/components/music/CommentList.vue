<script setup lang="ts">
import { iconMessageCircle, iconThumbsUp } from '@/icons';
import type { Comment } from '@/models/comment';
import Button from '@/components/ui/Button.vue';

interface Props {
  comments: Comment[];
  total?: number;
  loading?: boolean;
  showDivider?: boolean;
  onTapReplies?: (comment: Comment) => void;
  emptyText?: string;
  compact?: boolean;
  hideEmpty?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  showDivider: false,
  emptyText: '暂无评论',
  compact: false,
  hideEmpty: false,
});

const formatLike = (value: number) => {
  if (value < 10000) return value.toString();
  const fixed = (value / 10000).toFixed(value >= 100000 ? 0 : 1);
  return `${fixed.replace(/\.0$/, '')}w`;
};
</script>

<template>
  <div class="comment-list" :class="{ 'is-compact': compact }">
    <div v-if="loading && comments.length === 0" class="comment-loading">
      <div
        class="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin"
      ></div>
    </div>

    <div v-else-if="!hideEmpty && comments.length === 0" class="comment-empty">
      {{ emptyText }}
    </div>

    <div v-for="comment in comments" :key="comment.id" class="comment-item-wrap">
      <div class="comment-item">
        <div class="comment-avatar">
          <img v-if="comment.avatar" :src="comment.avatar" alt="avatar" />
          <div v-else class="comment-avatar-fallback">?</div>
        </div>

        <div class="comment-main">
          <div class="comment-topline">
            <div class="comment-meta">
              <div class="comment-userline">
                <span class="comment-name">{{ comment.userName }}</span>
                <span v-if="comment.isHot" class="comment-badge">热门</span>
                <span v-if="comment.isStar" class="comment-badge comment-badge-star">歌手</span>
              </div>
              <div class="comment-time">{{ comment.time }}</div>
            </div>

            <div class="comment-like">
              <Icon :icon="iconThumbsUp" width="12" height="12" />
              <span>{{ formatLike(comment.likeCount) }}</span>
            </div>
          </div>

          <div class="comment-content">{{ comment.content }}</div>

          <Button
            variant="unstyled"
            size="none"
            v-if="props.onTapReplies && comment.replyCount && comment.replyCount > 0"
            type="button"
            class="comment-reply"
            @click="props.onTapReplies?.(comment)"
          >
            <Icon :icon="iconMessageCircle" width="14" height="14" />
            <span>{{ `查看${comment.replyCount}条回复` }}</span>
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.comment-list {
  display: flex;
  flex-direction: column;
}

.comment-loading,
.comment-empty {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 96px;
  padding: 24px 0;
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 600;
}

.comment-item-wrap {
  display: flex;
  flex-direction: column;
}

.comment-item {
  margin: 0 12px 12px;
  padding: 20px;
  border-radius: 20px;
  background: color-mix(in srgb, var(--color-text-main) 5%, transparent);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.03);
}

.comment-list.is-compact .comment-item {
  margin-left: 0;
  margin-right: 0;
}

.comment-avatar {
  width: 36px;
  height: 36px;
  border-radius: 18px;
  overflow: hidden;
  flex-shrink: 0;
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
}

.comment-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.comment-avatar-fallback {
  font-size: 14px;
  font-weight: 700;
  color: var(--color-primary);
}

.comment-main {
  min-width: 0;
  flex: 1;
}

.comment-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.comment-topline {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.comment-meta {
  min-width: 0;
  flex: 1;
}

.comment-userline {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.comment-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-main);
}

.comment-time {
  margin-top: 2px;
  font-size: 10px;
  color: color-mix(in srgb, var(--color-text-main) 45%, transparent);
}

.comment-like {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 999px;
  background: var(--color-bg-card);
  color: var(--color-primary);
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
}

.comment-content {
  margin-top: 12px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--color-text-main);
  white-space: pre-wrap;
  word-break: break-word;
}

.comment-reply {
  margin-top: 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  background: transparent;
  color: var(--color-primary);
  font-size: 12px;
  font-weight: 500;
}

.comment-badge {
  padding: 2px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-primary) 20%, transparent);
}

.comment-badge-star {
  color: var(--color-primary);
  border-color: color-mix(in srgb, var(--color-primary) 20%, transparent);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
}
</style>
