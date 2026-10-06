<script setup lang="ts">
import { computed, reactive, ref, watch, onBeforeUnmount } from 'vue';
import { iconMessageCircle, iconThumbsUp, iconChevronUp, iconTrash } from '@/icons';
import type { Comment } from '@/models/comment';
import type { CommentResourceType } from '@/composables/useComments';
import FloorReplyComposer from './FloorReplyComposer.vue';
import Button from '@/components/ui/Button.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import Popconfirm from '@/components/ui/Popconfirm.vue';
import { deleteComment, getFloorComments, sendFloorComment } from '@/api/comment';
import { mapCommentItem } from '@/utils/mappers';
import { enrichCommentsWithYoungVip } from '@/utils/commentVipCache';
import { useToastStore } from '@/stores/toast';
import { useUserStore } from '@/stores/user';
import { captureUserSession } from '@/utils/userSession';
import { toRecord } from '../../../shared/object';
import {
  groupCommentRelations,
  mainCommentParentId,
  mergeFloorReplies,
  presentFloorReply,
} from '@/utils/commentRelations';

interface Props {
  comments: Comment[];
  total?: number;
  loading?: boolean;
  showDivider?: boolean;
  emptyText?: string;
  compact?: boolean;
  hideEmpty?: boolean;
  resourceType?: CommentResourceType;
  resourceId?: string | number;
  fallbackMixSongId?: string;
  inlineReplies?: boolean;
  loadingSkeletonCount?: number;
  // UI 接入点：调用方完成真实接口调用后才 resolve，失败应 reject。
  sendFloorReply?: (request: {
    root: Comment;
    target: Comment;
    content: string;
    resourceType: CommentResourceType;
    mixSongId?: string;
  }) => Promise<void>;
}

const props = withDefaults(defineProps<Props>(), {
  showDivider: false,
  emptyText: '暂无评论',
  compact: false,
  hideEmpty: false,
  resourceType: 'music',
  inlineReplies: true,
  loadingSkeletonCount: 3,
});

const emit = defineEmits<{
  (e: 'deleted', comment: Comment): void;
}>();

const relations = computed(() => groupCommentRelations(props.comments));
const visibleComments = computed(() =>
  props.inlineReplies ? relations.value.roots : props.comments,
);
const mainPresentations = computed(() =>
  visibleComments.value.map((comment) => ({
    comment,
    ...presentFloorReply(comment, []),
  })),
);
const contextRoot = (comment: Comment): Comment => {
  const parent = mainCommentParentId(comment);
  return parent ? { ...comment, id: parent, tid: parent } : comment;
};
const floorStateFor = (comment: Comment) => getFloorState(contextRoot(comment).id);
const displayedReplies = (comment: Comment) =>
  mergeFloorReplies(
    relations.value.replies.get(String(comment.id)) ?? [],
    floorStateFor(comment).replies,
  );
const replyPresentations = computed(() => {
  const result = new Map<
    string | number,
    { reply: Comment; body: string; quote?: { userName: string; content: string } }[]
  >();
  for (const comment of visibleComments.value) {
    const floors = floorStateFor(comment).replies;
    result.set(
      comment.id,
      displayedReplies(comment).map((reply) => ({
        reply,
        ...presentFloorReply(reply, isFloorRecord(comment, reply) ? floors : []),
      })),
    );
  }
  return result;
});
const replyCountFor = (comment: Comment) =>
  Math.max(comment.replyCount ?? 0, floorStateFor(comment).total, displayedReplies(comment).length);
const isFloorRecord = (comment: Comment, reply: Comment) =>
  floorStateFor(comment).replies.some((item) => item === reply);

const toastStore = useToastStore();
const userStore = useUserStore();
const replyBusy = ref(false);
const replyRoot = ref<Comment | null>(null);
const replyTarget = ref<Comment | null>(null);
const deletingCommentIds = reactive<Set<string | number>>(new Set());
const DELETE_REFRESH_DELAY_MS = 450;
function startReply(root: Comment, target = root) {
  if (disposed || replyBusy.value || !isRootAvailable(root) || !isVisibleComment(target)) return;
  replyRoot.value = root;
  replyTarget.value = target;
}
async function submitFloorReply(content: string) {
  const root = replyRoot.value;
  const target = replyTarget.value;
  if (!root || !target || disposed || !isRootAvailable(root) || !isVisibleComment(target)) {
    throw new Error('回复暂不可用');
  }
  const isCurrent = captureScope();
  await (props.sendFloorReply ?? sendFloorComment)({
    root,
    target,
    content,
    resourceType: props.resourceType,
    mixSongId: props.fallbackMixSongId,
  });
  if (
    !isCurrent() ||
    !isRootAvailable(root) ||
    replyRoot.value !== root ||
    replyTarget.value !== target
  )
    return;
  toastStore.show('回复已提交，展示结果以平台审核为准', 'success');
  // 成功后立即结束原编辑，再刷新楼层；刷新失败不重新展示已提交的草稿。
  replyRoot.value = null;
  replyTarget.value = null;
  replyBusy.value = false;
  getFloorState(root.id).expanded = true;
  void fetchFloorReplies(root, true);
}

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
  requestGeneration: number;
  contentGeneration: number;
  receivedCount: number;
  rootKey: string;
}

const floorStates = reactive<Map<string | number, FloorState>>(new Map());

const getFloorState = (commentId: string | number): FloorState => {
  commentId = String(commentId);
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
      requestGeneration: 0,
      contentGeneration: 0,
      receivedCount: 0,
      rootKey: '',
    });
  }
  return floorStates.get(commentId)!;
};

const rootKey = (comment: Comment) =>
  JSON.stringify([
    String(comment.id),
    comment.specialId ??
      comment.specialChildId ??
      comment.special_id ??
      comment.special_child_id ??
      '',
    comment.code ?? '',
    comment.mixSongId ?? '',
  ]);
const isRootAvailable = (comment: Comment) =>
  props.comments.some((item) => rootKey(contextRoot(item)) === rootKey(comment));
const isVisibleComment = (comment: Comment) =>
  props.comments.some((item) => rootKey(item) === rootKey(comment)) ||
  Array.from(floorStates.values()).some((state) =>
    state.replies.some((item) => rootKey(item) === rootKey(comment)),
  );
let generation = 0;
let disposed = false;
const refreshTimers = new Set<number>();
const captureScope = () => {
  const token = generation;
  const isSessionCurrent = captureUserSession(userStore);
  return () => !disposed && token === generation && isSessionCurrent();
};
const invalidate = () => {
  generation++;
  floorStates.clear();
  expandedContents.clear();
  deletingCommentIds.clear();
  replyRoot.value = null;
  replyTarget.value = null;
  replyBusy.value = false;
  refreshTimers.forEach((timer) => window.clearTimeout(timer));
  refreshTimers.clear();
};
watch(
  [
    () => props.resourceType,
    () => props.resourceId,
    () => props.fallbackMixSongId,
    () => userStore.isLoggedIn,
    () => userStore.accountRevision,
    () => userStore.info?.userid ?? userStore.info?.userId,
    () => userStore.info?.token,
  ],
  invalidate,
  { flush: 'sync' },
);
watch(
  () => props.comments,
  () => {
    const roots = new Map<string, Set<string>>();
    for (const comment of props.comments) {
      const root = contextRoot(comment);
      const keys = roots.get(String(root.id)) ?? new Set<string>();
      keys.add(rootKey(root));
      roots.set(String(root.id), keys);
    }
    for (const [id, state] of floorStates) {
      if (!roots.has(String(id)) || (state.rootKey && !roots.get(String(id))?.has(state.rootKey))) {
        floorStates.delete(id);
      }
    }
    if (
      replyRoot.value &&
      (!isRootAvailable(replyRoot.value) ||
        (replyTarget.value && !isVisibleComment(replyTarget.value)))
    ) {
      replyRoot.value = null;
      replyTarget.value = null;
      replyBusy.value = false;
    }
  },
  { flush: 'sync' },
);
onBeforeUnmount(() => {
  disposed = true;
  invalidate();
});

const fetchFloorReplies = async (comment: Comment, reset = false) => {
  if (disposed || !isRootAvailable(comment)) return;
  const state = getFloorState(comment.id);
  if (state.loading && !reset) return;
  if (!state.hasMore && !reset) return;
  const requestGeneration = ++state.requestGeneration;
  if (reset) state.contentGeneration++;
  const contentGeneration = state.contentGeneration;
  const isScopeCurrent = captureScope();
  const isContentCurrent = () =>
    isScopeCurrent() &&
    isRootAvailable(comment) &&
    floorStates.get(String(comment.id)) === state &&
    state.contentGeneration === contentGeneration;
  const isCurrent = () => isContentCurrent() && state.requestGeneration === requestGeneration;
  const page = reset ? 1 : state.page;
  state.rootKey = rootKey(comment);
  state.loading = true;
  state.loadMoreMessage = '';
  try {
    const specialId =
      comment.specialId || comment.specialChildId || comment.special_id || comment.special_child_id;
    const tid = comment.tid || String(comment.id);
    const mixSongId =
      comment.mixSongId ?? (props.resourceType === 'music' ? props.fallbackMixSongId : undefined);
    if (!specialId || !tid) {
      state.message = '楼层评论暂不可用';
      state.hasMore = false;
      state.initialized = true;
      return;
    }
    const res = await getFloorComments({
      specialId,
      tid,
      mixSongId,
      code: comment.code,
      resourceType: props.resourceType,
      page,
      pagesize: 30,
    });
    if (!isCurrent()) return;

    const payload = toRecord(toRecord(res).data ?? res);
    const list = Array.isArray(payload.list) ? payload.list : [];
    const errCode = Number(payload.err_code ?? 0) || 0;
    const mapped = list.map(mapCommentItem);
    state.replies = mergeFloorReplies([], reset ? mapped : [...state.replies, ...mapped]);
    const totalCount = Number(payload.comments_num ?? payload.total ?? payload.count);
    if (Number.isFinite(totalCount) && totalCount >= 0) state.total = totalCount;
    else if (reset) state.total = 0;
    state.receivedCount = (reset ? 0 : state.receivedCount) + list.length;
    state.hasMore =
      list.length > 0 && (state.total > 0 ? state.receivedCount < state.total : list.length >= 30);
    state.page = state.hasMore ? page + 1 : page;
    state.message =
      state.replies.length === 0
        ? errCode !== 0
          ? '楼层评论暂不可用'
          : String(payload.message || '暂无回复')
        : '';
    state.initialized = true;
    void enrichCommentsWithYoungVip(mapped)
      .then((enriched) => {
        if (!isContentCurrent()) return;
        const byId = new Map(enriched.map((item) => [String(item.id), item]));
        state.replies = state.replies.map((item) => {
          const patch = byId.get(String(item.id));
          return patch
            ? {
                ...item,
                badges: patch.badges,
                talentIcon: patch.talentIcon,
                userId: patch.userId ?? item.userId,
                raw: patch.raw ? { ...item.raw, busi_vip: patch.raw.busi_vip } : item.raw,
              }
            : item;
        });
      })
      .catch(() => undefined);
  } catch {
    if (!isCurrent()) return;
    toastStore.loadFailed('楼层评论');
    state.loadMoreMessage = '加载更多失败，点击重试';
  } finally {
    if (isCurrent()) state.loading = false;
  }
};

const canLoadMoreFloor = (comment: Comment) => {
  const state = floorStateFor(comment);
  return (
    !state.loading && Boolean(state.loadMoreMessage || (state.hasMore && state.replies.length > 0))
  );
};
const loadMoreFloor = (comment: Comment) => {
  const state = floorStateFor(comment);
  return fetchFloorReplies(
    contextRoot(comment),
    Boolean(state.loadMoreMessage && (!state.initialized || !state.hasMore)),
  );
};

const toggleFloor = (comment: Comment) => {
  if (replyBusy.value && replyRoot.value?.id === comment.id) return;
  if (!props.inlineReplies) return;
  const state = floorStateFor(comment);
  if (!state.expanded) {
    state.expanded = true;
    if (!state.initialized) void fetchFloorReplies(contextRoot(comment), true);
  } else {
    state.expanded = false;
  }
};

const formatLike = (value: number) => {
  if (value < 10000) return value.toString();
  const fixed = (value / 10000).toFixed(value >= 100000 ? 0 : 1);
  return `${fixed.replace(/\.0$/, '')}w`;
};

const commentIpText = (comment: Comment) => comment.ipLocation || '';
const canDeleteComment = (comment: Comment) => {
  const currentUserId = String(userStore.info?.userid ?? userStore.info?.userId ?? '');
  return Boolean(
    !disposed &&
    userStore.isLoggedIn &&
    isVisibleComment(comment) &&
    currentUserId &&
    comment.userId &&
    String(comment.userId) === currentUserId,
  );
};
const isDeletingComment = (comment: Comment) => deletingCommentIds.has(comment.id);
const refreshDeletedFloor = (comment: Comment) => {
  const tid = comment.tid && String(comment.tid) !== String(comment.id) ? comment.tid : '';
  if (!tid) return false;
  const state = getFloorState(tid);
  if (!state.initialized && state.replies.length === 0) return false;
  const root = props.comments.map(contextRoot).find((item) => String(item.id) === String(tid));
  if (!root) return false;
  void fetchFloorReplies(root, true);
  return true;
};
const handleDeleteComment = async (comment: Comment) => {
  if (!canDeleteComment(comment) || isDeletingComment(comment)) return;
  const isScopeCurrent = captureScope();
  const isCurrent = () => isScopeCurrent() && isVisibleComment(comment);
  deletingCommentIds.add(comment.id);
  try {
    await deleteComment({
      comment,
      resourceType: props.resourceType,
      mixSongId: props.fallbackMixSongId,
    });
    if (!isCurrent()) return;
    toastStore.actionCompleted('评论已删除');
    refreshDeletedFloor(comment);
    const timer = window.setTimeout(() => {
      refreshTimers.delete(timer);
      if (isCurrent()) emit('deleted', comment);
    }, DELETE_REFRESH_DELAY_MS);
    refreshTimers.add(timer);
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : '删除评论失败';
    if (isCurrent()) toastStore.warning(message);
  } finally {
    if (isScopeCurrent()) deletingCommentIds.delete(comment.id);
  }
};
</script>

<template>
  <div class="comment-list" :class="{ 'is-compact': compact }">
    <div v-if="loading && visibleComments.length === 0" class="comment-loading">
      <div v-for="index in loadingSkeletonCount" :key="index" class="comment-skeleton-item">
        <Skeleton variant="circle" width="36px" height="36px" />
        <div class="comment-skeleton-main">
          <div class="comment-skeleton-topline">
            <div class="comment-skeleton-meta">
              <Skeleton variant="text" width="112px" height="13px" />
              <Skeleton variant="text" width="72px" height="10px" />
            </div>
            <Skeleton variant="text" width="54px" height="24px" />
          </div>
          <div class="comment-skeleton-content">
            <Skeleton variant="text" width="92%" height="13px" />
            <Skeleton variant="text" width="74%" height="13px" />
          </div>
          <Skeleton variant="text" width="86px" height="12px" />
        </div>
      </div>
    </div>

    <div v-else-if="!hideEmpty && visibleComments.length === 0" class="comment-empty">
      {{ emptyText }}
    </div>

    <div
      v-for="{ comment, body, quote } in mainPresentations"
      :key="comment.id"
      class="comment-item-wrap"
    >
      <div class="comment-item">
        <div class="comment-avatar">
          <div class="comment-avatar-frame">
            <img v-if="comment.avatar" :src="comment.avatar" alt="avatar" />
            <div v-else class="comment-avatar-fallback">?</div>
          </div>
          <img
            v-if="comment.talentIcon"
            class="comment-talent-icon"
            :src="comment.talentIcon"
            alt=""
          />
        </div>
        <div class="comment-main">
          <div class="comment-topline">
            <div class="comment-meta">
              <div class="comment-userline">
                <span class="comment-name">{{ comment.userName }}</span>
                <span
                  v-for="badge in comment.badges"
                  :key="badge.key"
                  class="comment-badge"
                  :class="`comment-badge-${badge.kind}`"
                  >{{ badge.label }}</span
                >
                <span v-if="comment.isHot" class="comment-badge">热门</span>
              </div>
              <div class="comment-time">
                {{ comment.time
                }}<template v-if="commentIpText(comment)"> · {{ commentIpText(comment) }}</template>
              </div>
            </div>
            <div class="comment-like">
              <Icon :icon="iconThumbsUp" width="12" height="12" />
              <span>{{ formatLike(comment.likeCount) }}</span>
            </div>
          </div>

          <div v-if="quote" class="comment-time">回复 {{ quote.userName }}</div>
          <div class="comment-content">
            <template v-if="needsTruncate(body) && !isContentExpanded(comment.id)">
              {{ body.slice(0, 120) }}...<button
                type="button"
                class="comment-expand-btn"
                @click="toggleContent(comment.id)"
              >
                展开
              </button>
            </template>
            <template v-else>
              {{ body
              }}<button
                v-if="needsTruncate(body)"
                type="button"
                class="comment-expand-btn"
                @click="toggleContent(comment.id)"
              >
                收起
              </button>
            </template>
          </div>

          <blockquote v-if="quote" class="comment-floor-quote">
            <span class="comment-floor-quote-author">{{ quote.userName }}：</span
            >{{ quote.content }}
          </blockquote>
          <div v-if="inlineReplies || canDeleteComment(comment)" class="comment-actions">
            <Button
              variant="unstyled"
              size="none"
              v-if="inlineReplies && (replyCountFor(comment) > 0 || mainCommentParentId(comment))"
              type="button"
              class="comment-reply"
              @click="toggleFloor(comment)"
            >
              <Icon
                :icon="floorStateFor(comment).expanded ? iconChevronUp : iconMessageCircle"
                width="14"
                height="14"
              />
              <span>{{
                floorStateFor(comment).expanded
                  ? '收起回复'
                  : mainCommentParentId(comment)
                    ? '查看上下文'
                    : `查看${replyCountFor(comment)}条回复`
              }}</span>
            </Button>
            <Button
              v-if="inlineReplies && !mainCommentParentId(comment)"
              variant="unstyled"
              size="none"
              type="button"
              class="comment-reply"
              @click="startReply(comment)"
            >
              回复
            </Button>
            <Popconfirm
              v-if="canDeleteComment(comment)"
              :disabled="isDeletingComment(comment)"
              title="确认删除这条评论？"
              confirm-text="删除"
              tone="danger"
              @confirm="handleDeleteComment(comment)"
            >
              <template #trigger>
                <Button
                  variant="unstyled"
                  size="none"
                  type="button"
                  class="action-icon comment-delete"
                  :disabled="isDeletingComment(comment)"
                  tooltip="删除评论"
                >
                  <Icon :icon="iconTrash" width="13" height="13" />
                </Button>
              </template>
            </Popconfirm>
          </div>

          <FloorReplyComposer
            :notify-success="false"
            v-if="replyRoot?.id === comment.id && replyTarget?.id === comment.id"
            :key="`${comment.id}:${replyTarget.id}`"
            :target="replyTarget"
            :send="submitFloorReply"
            v-model:busy="replyBusy"
            @close="
              replyRoot = null;
              replyTarget = null;
            "
            @sent="
              replyRoot = null;
              replyTarget = null;
            "
          />

          <div v-if="inlineReplies && floorStateFor(comment).expanded" class="comment-floor-inline">
            <div class="comment-floor-heading">
              <span>{{ mainCommentParentId(comment) ? '所在楼层的回复' : '全部回复' }}</span
              ><span>{{ replyCountFor(comment) }}</span>
            </div>
            <div
              v-for="{ reply, body, quote } in replyPresentations.get(comment.id)"
              :key="reply.id"
              class="comment-floor-reply"
            >
              <div class="comment-floor-reply-avatar">
                <div class="comment-avatar-frame">
                  <img v-if="reply.avatar" :src="reply.avatar" alt="avatar" />
                  <div v-else class="comment-avatar-fallback">?</div>
                </div>
                <img
                  v-if="reply.talentIcon"
                  class="comment-talent-icon comment-talent-icon-floor"
                  :src="reply.talentIcon"
                  alt=""
                />
              </div>
              <div class="comment-floor-reply-body">
                <div class="comment-floor-reply-header">
                  <span class="comment-floor-reply-name">{{ reply.userName }}</span>
                  <span
                    v-for="badge in reply.badges"
                    :key="badge.key"
                    class="comment-badge comment-badge-floor"
                    :class="`comment-badge-${badge.kind}`"
                    >{{ badge.label }}</span
                  >
                  <span v-if="quote" class="comment-floor-reply-to">回复 {{ quote.userName }}</span>
                </div>
                <div class="comment-floor-reply-content">
                  <template v-if="needsTruncate(body) && !isContentExpanded(reply.id)"
                    >{{ body.slice(0, 120) }}...<button
                      type="button"
                      class="comment-expand-btn"
                      @click="toggleContent(reply.id)"
                    >
                      展开
                    </button></template
                  >
                  <template v-else
                    >{{ body
                    }}<button
                      v-if="needsTruncate(body)"
                      type="button"
                      class="comment-expand-btn"
                      @click="toggleContent(reply.id)"
                    >
                      收起
                    </button></template
                  >
                </div>
                <blockquote v-if="quote" class="comment-floor-quote">
                  <span class="comment-floor-quote-author">{{ quote.userName }}：</span
                  >{{ quote.content }}
                </blockquote>
                <div class="comment-floor-reply-footer">
                  <span class="comment-floor-reply-time">
                    {{ reply.time
                    }}<template v-if="commentIpText(reply)"> · {{ commentIpText(reply) }}</template>
                  </span>
                  <Button
                    variant="unstyled"
                    size="none"
                    type="button"
                    v-if="isFloorRecord(comment, reply)"
                    class="floor-target-reply"
                    @click="startReply(contextRoot(comment), reply)"
                    >回复</Button
                  >
                  <Popconfirm
                    v-if="canDeleteComment(reply)"
                    :disabled="isDeletingComment(reply)"
                    title="确认删除这条回复？"
                    confirm-text="删除"
                    tone="danger"
                    @confirm="handleDeleteComment(reply)"
                  >
                    <template #trigger>
                      <Button
                        variant="unstyled"
                        size="none"
                        type="button"
                        class="action-icon floor-target-delete"
                        :disabled="isDeletingComment(reply)"
                        tooltip="删除回复"
                      >
                        <Icon :icon="iconTrash" width="12" height="12" />
                      </Button>
                    </template>
                  </Popconfirm>
                </div>
                <FloorReplyComposer
                  :notify-success="false"
                  v-if="replyRoot?.id === contextRoot(comment).id && replyTarget?.id === reply.id"
                  :key="`${comment.id}:${replyTarget.id}`"
                  :target="reply"
                  :send="submitFloorReply"
                  v-model:busy="replyBusy"
                  @close="
                    replyRoot = null;
                    replyTarget = null;
                  "
                  @sent="
                    replyRoot = null;
                    replyTarget = null;
                  "
                />
              </div>
            </div>
            <div v-if="floorStateFor(comment).loading" class="comment-floor-loading">
              <div class="comment-loading-spinner"></div>
              <span>加载中...</span>
            </div>
            <div
              v-if="
                !floorStateFor(comment).loading &&
                floorStateFor(comment).initialized &&
                displayedReplies(comment).length === 0
              "
              class="comment-floor-empty"
            >
              {{ floorStateFor(comment).message || '暂无回复' }}
            </div>
            <div v-if="canLoadMoreFloor(comment)" class="comment-floor-more">
              <Button
                variant="unstyled"
                size="none"
                type="button"
                class="comment-floor-more-btn"
                @click="loadMoreFloor(comment)"
              >
                {{ floorStateFor(comment).loadMoreMessage || '加载更多回复' }}
              </Button>
            </div>
            <div
              v-if="
                !floorStateFor(comment).hasMore &&
                !floorStateFor(comment).loadMoreMessage &&
                !floorStateFor(comment).loading &&
                floorStateFor(comment).replies.length > 0
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

.comment-loading {
  flex-direction: column;
  align-items: stretch;
  gap: 0;
  min-height: 0;
  padding: 0;
}

.comment-skeleton-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin: 0 12px 12px;
  padding: 20px;
  border-radius: var(--radius-item);
  background: color-mix(in srgb, var(--color-text-main) 5%, transparent);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.03);
}

.comment-list.is-compact .comment-skeleton-item {
  margin-left: 0;
  margin-right: 0;
}

.comment-skeleton-main {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}

.comment-skeleton-topline {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.comment-skeleton-meta {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 7px;
}

.comment-skeleton-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 14px;
  margin-bottom: 14px;
}

.comment-item-wrap {
  display: flex;
  flex-direction: column;
}

.comment-item {
  margin: 0 12px 12px;
  padding: 20px;
  border-radius: var(--radius-item);
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
  position: relative;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
}

.comment-avatar-frame {
  width: 100%;
  height: 100%;
  border-radius: var(--radius-card);
  overflow: hidden;
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
}

.comment-avatar-frame img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.comment-talent-icon {
  position: absolute;
  right: 1px;
  bottom: 1px;
  width: 16px;
  height: 16px;
  pointer-events: none;
  z-index: 1;
  object-fit: contain;
  user-select: none;
}

.comment-avatar-fallback {
  font-size: 14px;
  font-weight: 700;
  color: var(--color-primary-text);
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
  color: var(--color-text-secondary);
}

.comment-like {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 999px;
  background: var(--control-muted-bg);
  color: var(--color-primary-text);
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
  box-shadow: 0 2px 10px color-mix(in srgb, var(--color-text-main) 6%, transparent);
}

.comment-content {
  margin-top: 12px;
  font-size: 14px;
  line-height: 1.75;
  color: var(--color-text-main);
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}

.comment-expand-btn {
  display: inline;
  padding: 0;
  margin-left: 2px;
  border: 0;
  background: transparent;
  color: var(--color-primary-text);
  font-size: inherit;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.comment-expand-btn:hover {
  opacity: 0.8;
}

.comment-reply {
  margin-top: 0;
  height: 24px;
  line-height: 24px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  background: transparent;
  color: var(--color-primary-text);
  font-size: 12px;
  font-weight: 500;
  transition: color 0.2s ease;
}

.comment-reply:hover {
  opacity: 0.8;
}

.comment-delete,
.floor-target-delete {
  color: var(--icon-main);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.comment-delete {
  width: 24px;
  height: 24px;
}

.floor-target-delete {
  width: 20px;
  height: 20px;
}

.comment-delete:hover,
.floor-target-delete:hover {
  color: var(--state-danger);
}

.comment-delete:disabled,
.floor-target-delete:disabled {
  opacity: 0.5;
  pointer-events: none;
}

.comment-floor-inline {
  margin-top: 12px;
  padding: 16px 18px;
  border-radius: var(--radius-card);
  background: var(--control-muted-bg);
  border: none;
}

.comment-floor-reply {
  display: flex;
  gap: 12px;
  padding: 16px 0;
}

.comment-floor-reply + .comment-floor-reply {
  border-top: 1px solid var(--border-subtle);
}

.comment-floor-reply-avatar {
  position: relative;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
}

.comment-floor-reply-avatar .comment-avatar-frame {
  border-radius: 50%;
}

.comment-floor-reply-avatar .comment-avatar-fallback {
  font-size: 11px;
}

.comment-talent-icon-floor {
  width: 14px;
  height: 14px;
  right: 0;
  bottom: 0;
}

.comment-floor-reply-body {
  flex: 1;
  min-width: 0;
}

.comment-floor-reply-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.comment-floor-reply-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-main);
}

.comment-floor-reply-time {
  font-size: 11px;
  color: var(--text-secondary);
}

.comment-floor-reply-content {
  margin-top: 4px;
  font-size: 13px;
  line-height: 1.75;
  color: var(--color-text-main);
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
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
  border-top-color: var(--color-primary-text);
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
  color: var(--color-primary-text);
  padding: 4px 12px;
  border-radius: var(--radius-control);
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
  color: var(--color-text-secondary);
}
.floor-target-reply {
  color: var(--text-secondary);
  font-size: 12px;
}
.floor-target-reply:hover {
  color: var(--color-primary-text);
}
.comment-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 10px;
}
.comment-actions :deep(svg) {
  display: block;
  flex-shrink: 0;
}
.comment-actions .comment-reply {
  margin: 0;
  height: 24px;
  line-height: 24px;
}
.comment-floor-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  padding-bottom: 2px;
}
.comment-floor-heading span:last-child {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.comment-floor-reply-footer {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 8px;
}
.comment-floor-inline :deep(.floor-composer) {
  background: var(--color-bg-elevated);
}
@media (max-width: 640px) {
  .comment-floor-inline {
    padding: 12px;
  }
  .comment-floor-reply {
    gap: 8px;
  }
}

.comment-floor-reply-to {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 400;
  overflow-wrap: anywhere;
}
.comment-floor-quote {
  margin: 8px 0 0;
  padding: 6px 10px;
  border-left: 2px solid var(--border-subtle);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 96px;
  overflow-y: auto;
}
.comment-floor-quote-author {
  font-weight: 500;
}
</style>
