import { onBeforeUnmount, ref, watch } from 'vue';
import { getAlbumComments, getPlaylistComments } from '@/api/comment';
import { mapCommentItem } from '@/utils/mappers';
import { enrichCommentsWithYoungVip } from '@/utils/commentVipCache';
import { captureUserSession } from '@/utils/userSession';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import { isRecord, toRecord } from '../../shared/object';
import type { Comment } from '@/models/comment';

/** 详情评论的资源切换、分页和会话生命周期；歌曲分类评论由 useComments 管理。 */
export function useDetailComments(options: {
  type: 'album' | 'playlist';
  resourceId: () => string | number;
  isActive: () => boolean;
}) {
  const user = useUserStore();
  const toast = useToastStore();
  const loadingComments = ref(false);
  const comments = ref<Comment[]>([]);
  const hotComments = ref<Comment[]>([]);
  const commentTotal = ref(0);
  const commentPage = ref(1);
  const hasMoreComments = ref(true);
  let generation = 0;
  let disposed = false;
  let receivedCount = 0;

  const invalidate = () => {
    generation++;
    receivedCount = 0;
    loadingComments.value = false;
    comments.value = [];
    hotComments.value = [];
    commentTotal.value = 0;
    commentPage.value = 1;
    hasMoreComments.value = true;
  };
  const sessionSources = [
    () => user.isLoggedIn,
    () => user.accountRevision,
    () => user.info?.userid ?? user.info?.userId,
    () => user.info?.token,
  ];
  watch([options.resourceId, ...sessionSources], invalidate, { flush: 'sync' });
  // 账号切换仍停留在同一个详情时，重新取得当前账号的评论状态。
  watch(sessionSources, () => {
    if (options.isActive()) void fetchComments(true);
  });
  onBeforeUnmount(() => {
    disposed = true;
    generation++;
  });

  const mergeVip = (current: Comment[], enriched: Comment[]) => {
    const byId = new Map(enriched.map((item) => [String(item.id), item]));
    return current.map((item) => {
      const patch = byId.get(String(item.id));
      if (!patch) return item;
      return {
        ...item,
        userId: patch.userId ?? item.userId,
        badges: patch.badges,
        talentIcon: patch.talentIcon,
        raw: patch.raw ? { ...item.raw, busi_vip: patch.raw.busi_vip } : item.raw,
      };
    });
  };

  const fetchComments = async (reset = false) => {
    const resourceId = options.resourceId();
    if (disposed || !resourceId) return;
    if (!reset && (loadingComments.value || !hasMoreComments.value)) return;
    if (reset) generation++;
    const requestGeneration = generation;
    const isSessionCurrent = captureUserSession(user);
    const isCurrent = () =>
      !disposed &&
      generation === requestGeneration &&
      resourceId === options.resourceId() &&
      isSessionCurrent();
    const page = reset ? 1 : commentPage.value;
    loadingComments.value = true;
    try {
      const fetch = options.type === 'album' ? getAlbumComments : getPlaylistComments;
      const response = await fetch(resourceId, page, 30, {
        showClassify: page === 1,
        showHotwordList: page === 1,
      });
      if (!isCurrent()) return;
      if (
        !response ||
        typeof response !== 'object' ||
        !('status' in response) ||
        response.status !== 1
      )
        return;
      const record = toRecord(response);
      const data = toRecord(record.data ?? record.info ?? record);
      const candidate = 'list' in data ? data.list : data.comments;
      const raw = Array.isArray(candidate) ? candidate : [];
      const hotCandidate = data.hot_list ?? data.weight_list ?? [];
      const hotRaw = Array.isArray(hotCandidate)
        ? hotCandidate
        : isRecord(hotCandidate) && Array.isArray(hotCandidate.list)
          ? hotCandidate.list
          : [];
      const mapped = raw.map(mapCommentItem).filter((item) => item.content.length > 0);
      const mappedHot = hotRaw.map(mapCommentItem).filter((item) => item.content.length > 0);
      const rawTotal = data.total ?? data.count ?? record.total ?? record.count;
      const total = Number(rawTotal);

      // 只有成功响应替换快照；失败刷新保留已显示内容和可重试页码。
      comments.value = reset ? mapped : [...comments.value, ...mapped];
      if (reset) hotComments.value = mappedHot;
      if (rawTotal != null && Number.isFinite(total) && total >= 0) commentTotal.value = total;
      else if (reset) commentTotal.value = 0;
      receivedCount = (reset ? 0 : receivedCount) + raw.length;
      hasMoreComments.value =
        raw.length > 0 &&
        (commentTotal.value > 0 ? receivedCount < commentTotal.value : raw.length >= 30);
      commentPage.value = hasMoreComments.value ? page + 1 : page;

      // 铭牌查询不阻塞首屏和下一页；迟到结果只更新当前资源中的对应评论。
      void Promise.all([
        enrichCommentsWithYoungVip(mapped),
        reset ? enrichCommentsWithYoungVip(mappedHot) : Promise.resolve([]),
      ])
        .then(([list, hot]) => {
          if (!isCurrent()) return;
          comments.value = mergeVip(comments.value, list);
          if (reset) hotComments.value = mergeVip(hotComments.value, hot);
        })
        .catch(() => undefined);
    } catch {
      if (isCurrent()) toast.loadFailed(options.type === 'album' ? '专辑评论' : '歌单评论');
    } finally {
      if (isCurrent()) loadingComments.value = false;
    }
  };

  return {
    loadingComments,
    comments,
    hotComments,
    commentTotal,
    commentPage,
    hasMoreComments,
    fetchComments,
  };
}
