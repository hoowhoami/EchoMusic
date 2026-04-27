<script setup lang="ts">
import { reactive } from 'vue';
import { iconMessageCircle, iconThumbsUp, iconChevronUp } from '@/icons';
import type { Comment } from '@/models/comment';
import type { CommentResourceType } from '@/utils/useComments';
import Button from '@/components/ui/Button.vue';
import { getFloorComments } from '@/api/comment';
import { mapCommentItem } from '@/utils/mappers';
import { useToastStore } from '@/stores/toast';

interface Props {
  comments: Comment[];
  total?: number;
  loading?: boolean;
  showDivider?: boolean;
  emptyText?: string;
  compact?: boolean;
  hideEmpty?: boolean;
  resourceType?: CommentResourceType;
  fallbackMixSongId?: string;
  inlineReplies?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  showDivider: false,
  emptyText: '暂无评论',
  compact: false,
  hideEmpty: false,
  resourceType: 'music',
  inlineReplies: true,
});

const toastStore = useToastStore();

// 评论内容展开/收起
const expandedContents = reactive<Set<string | number>>(new Set());
const isContentExpanded = (id: string | number) => expandedContents.has(id);
const toggleContent = (id: string | number) => {
  if (expandedContents.has(id)) expandedContents.delete(id);
  else expandedContents.add(id);
};
const needsTruncate = (content: string) => {
  const lineCount = (content.match(/\n/g) || []).length + 1;
  return content.length > 120 || lineCount > 3;
};

// 楼层展开状态
interface FloorState {
  expanded: boolean;
  loading: boolean;
  replies: Comment[];
  total: number;
  page: number;
  hasMore: boolean;
  message: string;
  loadMoreMessage: string;
  initialized: boolean;
}

const floorStates = reactive<Map<string | number, FloorState>>(new Map());

const getFloorState = (commentId: string | number): FloorState => {
  if (!floorStates.has(commentId)) {
    floorStates.set(commentId, {
      expanded: false,
      loading: false,
      replies: [],
      total: 0,
      page: 1,
      hasMore: true,
      message: '',
      loadMoreMessage: '',
      initialized: false,
    });
  }
  return floorStates.get(commentId)!;
};

const fetchFloorReplies = async (comment: Comment, reset = false) => {
  const state = getFloorState(comment.id);
  if (state.loading) return;
  if (!state.hasMore && !reset) return;
  if (reset) {
    state.page = 1;
    state.replies = [];
    state.hasMore = true;
    state.message = '';
    state.loadMoreMessage = '';
  }
  state.loading = true;
  try {
    const specialId = comment.specialId ?? '';
    const tid = comment.tid ?? String(comment.id);
    const mixSongId =
      comment.mixSongId ?? (props.resourceType === 'music' ? props.fallbackMixSongId : undefined);
    if (!specialId || !tid) {
      state.message = '楼层评论暂不可用';
      state.hasMore = false;
      return;
    }
    const res = await getFloorComments({
      specialId,
      tid,
      mixSongId,
      code: comment.code,
      resourceType: props.resourceType,
      page: state.page,
      pagesize: 30,
    });
    if (res && typeof res === 'object') {
      const payload = (res as { data?: unknown }).data ?? res;
      const listCandidate = (payload as Record<string, unknown>).list ?? [];
      const errCode = Number((payload as Record<string, unknown>).err_code ?? 0) || 0;
      const message = String((payload as Record<string, unknown>).message ?? '');
      const list = Array.isArray(listCandidate) ? listCandidate : [];
      const mapped = list.map(mapCommentItem);
      state.replies = reset ? mapped : [...state.replies, ...mapped];
      const totalCount = Number((payload as Record<string, unknown>).comments_num ?? 0) || 0;
      state.total = totalCount;
      state.hasMore = totalCount > 0 ? state.replies.length < totalCount : mapped.length >= 30;
      if (state.hasMore) state.page += 1;
      if (state.replies.length === 0) {
        state.message = errCode !== 0 ? '楼层评论暂不可用' : message || '暂无回复';
      }
    }
  } catch {
    toastStore.loadFailed('楼层评论');
    state.loadMoreMessage = '加载更多失败，点击重试';
  } finally {
    state.loading = false;
    state.initialized = true;
  }
};

const toggleFloor = (comment: Comment) => {
  if (!props.inlineReplies) return;
  const state = getFloorState(comment.id);
  if (!state.expanded) {
    state.expanded = true;
    if (!state.initialized) void fetchFloorReplies(comment, true);
  } else {
    state.expanded = false;
  }
};

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

          <div class="comment-content">
            <template v-if="needsTruncate(comment.content) && !isContentExpanded(comment.id)">
              {{ comment.content.slice(0, 120) }}...<button
                type="button"
                class="comment-expand-btn"
                @click="toggleContent(comment.id)"
              >
                展开
              </button>
            </template>
            <template v-else>
              {{ comment.content
              }}<button
                v-if="needsTruncate(comment.content)"
                type="button"
                class="comment-expand-btn"
                @click="toggleContent(comment.id)"
              >
                收起
              </button>
            </template>
          </div>

          <Button
            variant="unstyled"
            size="none"
            v-if="inlineReplies && comment.replyCount && comment.replyCount > 0"
            type="button"
            class="comment-reply"
            @click="toggleFloor(comment)"
          >
            <Icon
              :icon="getFloorState(comment.id).expanded ? iconChevronUp : iconMessageCircle"
              width="14"
              height="14"
            />
            <span>{{
              getFloorState(comment.id).expanded ? '收起回复' : `查看${comment.replyCount}条回复`
            }}</span>
          </Button>

          <div
            v-if="inlineReplies && getFloorState(comment.id).expanded"
            class="comment-floor-inline"
          >
            <div
              v-for="reply in getFloorState(comment.id).replies"
              :key="reply.id"
              class="comment-floor-reply"
            >
              <div class="comment-floor-reply-avatar">
                <img v-if="reply.avatar" :src="reply.avatar" alt="avatar" />
                <div v-else class="comment-avatar-fallback">?</div>
              </div>
              <div class="comment-floor-reply-body">
                <div class="comment-floor-reply-header">
                  <span class="comment-floor-reply-name">{{ reply.userName }}</span>
                  <span class="comment-floor-reply-time">{{ reply.time }}</span>
                </div>
                <div class="comment-floor-reply-content">
                  <template v-if="needsTruncate(reply.content) && !isContentExpanded(reply.id)"
                    >{{ reply.content.slice(0, 120) }}...<button
                      type="button"
                      class="comment-expand-btn"
                      @click="toggleContent(reply.id)"
                    >
                      展开
                    </button></template
                  >
                  <template v-else
                    >{{ reply.content
                    }}<button
                      v-if="needsTruncate(reply.content)"
                      type="button"
                      class="comment-expand-btn"
                      @click="toggleContent(reply.id)"
                    >
                      收起
                    </button></template
                  >
                </div>
              </div>
            </div>
            <div v-if="getFloorState(comment.id).loading" class="comment-floor-loading">
              <div class="comment-loading-spinner"></div>
              <span>加载中...</span>
            </div>
            <div
              v-if="
                !getFloorState(comment.id).loading &&
                getFloorState(comment.id).initialized &&
                getFloorState(comment.id).replies.length === 0
              "
              class="comment-floor-empty"
            >
              {{ getFloorState(comment.id).message || '暂无回复' }}
            </div>
            <div
              v-if="
                getFloorState(comment.id).hasMore &&
                !getFloorState(comment.id).loading &&
                getFloorState(comment.id).replies.length > 0
              "
              class="comment-floor-more"
            >
              <Button
                variant="unstyled"
                size="none"
                type="button"
                class="comment-floor-more-btn"
                @click="fetchFloorReplies(comment)"
              >
                {{ getFloorState(comment.id).loadMoreMessage || '加载更多回复' }}
              </Button>
            </div>
            <div
              v-if="
                !getFloorState(comment.id).hasMore &&
                !getFloorState(comment.id).loading &&
                getFloorState(comment.id).replies.length > 0
              "
              class="comment-floor-end"
            >
              已加载全部回复
            </div>
          </div>
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
  display: flex;
  align-items: flex-start;
  gap: 12px;
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

.comment-expand-btn {
  display: inline;
  padding: 0;
  margin-left: 2px;
  border: 0;
  background: transparent;
  color: var(--color-primary);
  font-size: inherit;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.comment-expand-btn:hover {
  opacity: 0.8;
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
  transition: color 0.2s ease;
}

.comment-reply:hover {
  opacity: 0.8;
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

.comment-floor-inline {
  margin-top: 14px;
  padding: 14px 16px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--color-text-main) 4%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-text-main) 8%, transparent);
}

.comment-floor-reply {
  display: flex;
  gap: 10px;
  padding: 10px 0;
}

.comment-floor-reply + .comment-floor-reply {
  border-top: 1px solid color-mix(in srgb, var(--color-text-main) 8%, transparent);
}

.comment-floor-reply-avatar {
  width: 28px;
  height: 28px;
  border-radius: 14px;
  overflow: hidden;
  flex-shrink: 0;
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
}

.comment-floor-reply-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.comment-floor-reply-avatar .comment-avatar-fallback {
  font-size: 11px;
}

.comment-floor-reply-body {
  flex: 1;
  min-width: 0;
}

.comment-floor-reply-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.comment-floor-reply-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-main);
}

.comment-floor-reply-time {
  font-size: 10px;
  color: color-mix(in srgb, var(--color-text-main) 40%, transparent);
}

.comment-floor-reply-content {
  margin-top: 4px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--color-text-main);
  white-space: pre-wrap;
  word-break: break-word;
}

.comment-floor-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.comment-loading-spinner {
  width: 14px;
  height: 14px;
  border-radius: 999px;
  border: 2px solid color-mix(in srgb, var(--color-primary) 28%, transparent);
  border-top-color: var(--color-primary);
  animation: comment-spin 0.8s linear infinite;
}

@keyframes comment-spin {
  to {
    transform: rotate(360deg);
  }
}

.comment-floor-empty {
  padding: 12px 0;
  text-align: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.comment-floor-more {
  display: flex;
  justify-content: center;
  padding: 8px 0 4px;
}

.comment-floor-more-btn {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-primary);
  padding: 4px 12px;
  border-radius: 8px;
  transition: background 0.2s ease;
}

.comment-floor-more-btn:hover {
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
}

.comment-floor-end {
  padding: 8px 0 4px;
  text-align: center;
  font-size: 11px;
  font-weight: 600;
  color: color-mix(in srgb, var(--color-text-main) 38%, transparent);
}
</style>
