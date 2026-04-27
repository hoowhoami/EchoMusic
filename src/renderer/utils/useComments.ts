import { ref, computed } from 'vue';
import {
  getMusicComments,
  getPlaylistComments,
  getAlbumComments,
  getMusicClassifyComments,
  getMusicHotwordComments,
  getFloorComments,
} from '@/api/comment';
import { mapCommentItem } from '@/utils/mappers';
import type { Comment } from '@/models/comment';
import { useToastStore } from '@/stores/toast';

export type CommentResourceType = 'music' | 'playlist' | 'album';

interface CommentPayload {
  hot?: Comment[];
  list: Comment[];
  total: number;
  classifyList: Array<{ id: number | string; name: string; count?: number }>;
  hotwordList: Array<{ content: string; count?: number }>;
}

interface UseCommentsOptions {
  resourceId: string;
  resourceType: CommentResourceType;
  mixSongId?: string;
}

/** 构建评论数据 */
const buildPayload = (data: unknown): CommentPayload => {
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const payload = (record.data as Record<string, unknown>) || record;
  const listCandidate = (payload.list ?? payload.comments ?? []) as unknown;
  const list = Array.isArray(listCandidate) ? listCandidate : [];
  const hotListCandidate =
    payload.weight_list ?? payload.hot_list ?? payload.star_cmts ?? payload.star_comment;
  const hotList = Array.isArray((hotListCandidate as Record<string, unknown> | undefined)?.list)
    ? (hotListCandidate as { list: unknown[] }).list
    : Array.isArray(hotListCandidate)
      ? hotListCandidate
      : [];
  const starCandidate =
    (payload.star_cmts as Record<string, unknown> | undefined)?.list ??
    (payload.star_comment as Record<string, unknown> | undefined)?.list ??
    [];
  const starList = Array.isArray(starCandidate) ? starCandidate : [];
  const classifyCandidate = payload.classify_list ?? [];
  const hotwordCandidate = payload.hot_word_list ?? [];

  const hotMapped = hotList.map(mapCommentItem).map((item) => ({ ...item, isHot: true }));
  const starMapped = starList.map(mapCommentItem).map((item) => ({ ...item, isStar: true }));

  return {
    hot: [...starMapped, ...hotMapped],
    list: list.map(mapCommentItem),
    total: Number(payload.count ?? payload.total ?? record.count ?? record.total ?? 0) || 0,
    classifyList: Array.isArray(classifyCandidate)
      ? classifyCandidate.map((item) => ({
          id: (item as Record<string, unknown>).id as string | number,
          name: String((item as Record<string, unknown>).name ?? ''),
          count: Number((item as Record<string, unknown>).cnt ?? 0) || 0,
        }))
      : [],
    hotwordList: Array.isArray(hotwordCandidate)
      ? hotwordCandidate.map((item) => ({
          content: String((item as Record<string, unknown>).content ?? ''),
          count: Number((item as Record<string, unknown>).count ?? 0) || 0,
        }))
      : [],
  };
};

export function useComments(options: UseCommentsOptions) {
  const toastStore = useToastStore();
  const { resourceId, resourceType, mixSongId } = options;
  const effectiveId = mixSongId || resourceId;

  // 全部评论
  const isLoadingComments = ref(false);
  const total = ref(0);
  const hotComments = ref<Comment[]>([]);
  const comments = ref<Comment[]>([]);
  const page = ref(1);
  const hasMore = ref(true);

  // 分类评论
  const classifyList = ref<Array<{ id: number | string; name: string; count?: number }>>([]);
  const hotwordList = ref<Array<{ content: string; count?: number }>>([]);
  const isLoadingClassify = ref(false);
  const classifyComments = ref<Comment[]>([]);
  const classifyPage = ref(1);
  const hasMoreClassify = ref(true);
  const selectedClassify = ref<number | string | null>(null);

  // 热词评论
  const isLoadingHotword = ref(false);
  const hotwordComments = ref<Comment[]>([]);
  const hotwordPage = ref(1);
  const hasMoreHotword = ref(true);
  const selectedHotword = ref<string | null>(null);

  const singerComments = computed(() => hotComments.value.filter((item) => item.isStar));

  const showCommentsEnd = computed(
    () => !hasMore.value && !isLoadingComments.value && comments.value.length > 0,
  );
  const showClassifyEnd = computed(
    () => !hasMoreClassify.value && !isLoadingClassify.value && classifyComments.value.length > 0,
  );
  const showHotwordEnd = computed(
    () => !hasMoreHotword.value && !isLoadingHotword.value && hotwordComments.value.length > 0,
  );

  const fetchMusicComments = async (reset = false) => {
    if (isLoadingComments.value) return;
    if (reset) {
      page.value = 1;
      comments.value = [];
      total.value = 0;
      hasMore.value = true;
    }
    isLoadingComments.value = true;
    try {
      const res = await getMusicComments(effectiveId, page.value, 30, {
        showClassify: reset,
        showHotwordList: reset,
      });
      if (
        res &&
        typeof res === 'object' &&
        'status' in res &&
        (res as { status?: number }).status === 1
      ) {
        const payload = buildPayload(res);
        if (reset) {
          hotComments.value = payload.hot ?? [];
          classifyList.value = payload.classifyList;
          hotwordList.value = payload.hotwordList;
          if (!selectedClassify.value && classifyList.value.length > 0) {
            selectedClassify.value = classifyList.value[0].id;
          }
          if (!selectedHotword.value && hotwordList.value.length > 0) {
            selectedHotword.value = hotwordList.value[0].content;
          }
        }
        comments.value = reset
          ? payload.list
          : [...comments.value, ...payload.list.map((item) => ({ ...item, isHot: false }))];
        total.value = payload.total;
        hasMore.value =
          total.value > 0 ? comments.value.length < total.value : payload.list.length >= 30;
        if (hasMore.value) page.value += 1;
      }
    } catch {
      toastStore.loadFailed('评论');
    } finally {
      isLoadingComments.value = false;
    }
  };

  const fetchPlaylistComments = async (reset = false) => {
    if (isLoadingComments.value) return;
    if (reset) {
      page.value = 1;
      comments.value = [];
      total.value = 0;
      hasMore.value = true;
    }
    isLoadingComments.value = true;
    try {
      const res = await getPlaylistComments(resourceId, page.value, 30, {
        showClassify: reset,
        showHotwordList: reset,
      });
      if (
        res &&
        typeof res === 'object' &&
        'status' in res &&
        (res as { status?: number }).status === 1
      ) {
        const payload = buildPayload(res);
        if (reset) {
          hotComments.value = payload.hot ?? [];
        }
        comments.value = reset
          ? payload.list
          : [...comments.value, ...payload.list.map((item) => ({ ...item, isHot: false }))];
        total.value = payload.total;
        hasMore.value =
          total.value > 0 ? comments.value.length < total.value : payload.list.length >= 30;
        if (hasMore.value) page.value += 1;
      }
    } catch {
      toastStore.loadFailed('评论');
    } finally {
      isLoadingComments.value = false;
    }
  };

  const fetchAlbumComments = async (reset = false) => {
    if (isLoadingComments.value) return;
    if (reset) {
      page.value = 1;
      comments.value = [];
      total.value = 0;
      hasMore.value = true;
    }
    isLoadingComments.value = true;
    try {
      const res = await getAlbumComments(resourceId, page.value, 30, {
        showClassify: reset,
        showHotwordList: reset,
      });
      if (
        res &&
        typeof res === 'object' &&
        'status' in res &&
        (res as { status?: number }).status === 1
      ) {
        const payload = buildPayload(res);
        if (reset) {
          hotComments.value = payload.hot ?? [];
        }
        comments.value = reset
          ? payload.list
          : [...comments.value, ...payload.list.map((item) => ({ ...item, isHot: false }))];
        total.value = payload.total;
        hasMore.value =
          total.value > 0 ? comments.value.length < total.value : payload.list.length >= 30;
        if (hasMore.value) page.value += 1;
      }
    } catch {
      toastStore.loadFailed('评论');
    } finally {
      isLoadingComments.value = false;
    }
  };

  const fetchComments = async (reset = false) => {
    if (resourceType === 'music') return fetchMusicComments(reset);
    if (resourceType === 'playlist') return fetchPlaylistComments(reset);
    return fetchAlbumComments(reset);
  };

  const fetchClassifyComments = async (reset = false) => {
    if (!selectedClassify.value) return;
    if (resourceType !== 'music') return;
    if (isLoadingClassify.value) return;
    if (reset) {
      classifyPage.value = 1;
      classifyComments.value = [];
      hasMoreClassify.value = true;
    }
    isLoadingClassify.value = true;
    try {
      const res = await getMusicClassifyComments(
        effectiveId,
        selectedClassify.value,
        classifyPage.value,
        30,
      );
      if (
        res &&
        typeof res === 'object' &&
        'status' in res &&
        (res as { status?: number }).status === 1
      ) {
        const payload = buildPayload(res);
        classifyComments.value = reset
          ? payload.list
          : [...classifyComments.value, ...payload.list];
        const selectedItem = classifyList.value.find((item) => item.id === selectedClassify.value);
        const totalCount = payload.total || selectedItem?.count || 0;
        hasMoreClassify.value =
          totalCount > 0 ? classifyComments.value.length < totalCount : payload.list.length >= 30;
        if (hasMoreClassify.value) classifyPage.value += 1;
      }
    } catch {
      toastStore.loadFailed('分类评论');
    } finally {
      isLoadingClassify.value = false;
    }
  };

  const fetchHotwordComments = async (reset = false) => {
    if (!selectedHotword.value) return;
    if (resourceType !== 'music') return;
    if (isLoadingHotword.value) return;
    if (reset) {
      hotwordPage.value = 1;
      hotwordComments.value = [];
      hasMoreHotword.value = true;
    }
    isLoadingHotword.value = true;
    try {
      const res = await getMusicHotwordComments(
        effectiveId,
        selectedHotword.value,
        hotwordPage.value,
        30,
      );
      if (
        res &&
        typeof res === 'object' &&
        'status' in res &&
        (res as { status?: number }).status === 1
      ) {
        const payload = buildPayload(res);
        hotwordComments.value = reset ? payload.list : [...hotwordComments.value, ...payload.list];
        const selectedItem = hotwordList.value.find(
          (item) => item.content === selectedHotword.value,
        );
        const totalCount = payload.total || selectedItem?.count || 0;
        hasMoreHotword.value =
          totalCount > 0 ? hotwordComments.value.length < totalCount : payload.list.length >= 30;
        if (hasMoreHotword.value) hotwordPage.value += 1;
      }
    } catch {
      toastStore.loadFailed('热词评论');
    } finally {
      isLoadingHotword.value = false;
    }
  };

  return {
    // 全部评论
    isLoadingComments,
    total,
    hotComments,
    comments,
    hasMore,
    singerComments,
    showCommentsEnd,
    fetchComments,
    // 分类评论
    classifyList,
    isLoadingClassify,
    classifyComments,
    hasMoreClassify,
    selectedClassify,
    showClassifyEnd,
    fetchClassifyComments,
    // 热词评论
    hotwordList,
    isLoadingHotword,
    hotwordComments,
    hasMoreHotword,
    selectedHotword,
    showHotwordEnd,
    fetchHotwordComments,
  };
}

/** 楼层评论加载 */
export function useFloorComments(resourceType: CommentResourceType, fallbackMixSongId?: string) {
  const toastStore = useToastStore();

  const floorLoading = ref(false);
  const floorReplies = ref<Comment[]>([]);
  const floorTotal = ref(0);
  const floorPage = ref(1);
  const floorHasMore = ref(true);
  const floorMessage = ref('');
  const floorLoadMoreMessage = ref('');

  const showFloorEnd = computed(
    () => !floorHasMore.value && !floorLoading.value && floorReplies.value.length > 0,
  );

  const resetFloor = () => {
    floorReplies.value = [];
    floorTotal.value = 0;
    floorPage.value = 1;
    floorHasMore.value = true;
    floorMessage.value = '';
    floorLoadMoreMessage.value = '';
  };

  const fetchFloorReplies = async (comment: Comment, reset = false) => {
    if (floorLoading.value) return;
    if (!floorHasMore.value && !reset) return;
    if (reset) {
      floorPage.value = 1;
      floorReplies.value = [];
      floorHasMore.value = true;
    }
    floorLoading.value = true;
    try {
      const specialId = comment.specialId ?? '';
      const tid = comment.tid ?? String(comment.id);
      const mixSongId =
        comment.mixSongId ?? (resourceType === 'music' ? fallbackMixSongId : undefined);
      if (!specialId || !tid) {
        floorMessage.value = '楼层评论暂不可用';
        floorHasMore.value = false;
        return;
      }
      const res = await getFloorComments({
        specialId,
        tid,
        mixSongId,
        code: comment.code,
        resourceType,
        page: floorPage.value,
        pagesize: 30,
      });
      if (res && typeof res === 'object') {
        const payload = (res as { data?: unknown }).data ?? res;
        const listCandidate = (payload as Record<string, unknown>).list ?? [];
        const errCode = Number((payload as Record<string, unknown>).err_code ?? 0) || 0;
        const message = String((payload as Record<string, unknown>).message ?? '');
        const list = Array.isArray(listCandidate) ? listCandidate : [];
        const mapped = list.map(mapCommentItem);
        floorReplies.value = reset ? mapped : [...floorReplies.value, ...mapped];
        const totalCount = Number((payload as Record<string, unknown>).comments_num ?? 0) || 0;
        floorTotal.value = totalCount;
        floorHasMore.value =
          totalCount > 0 ? floorReplies.value.length < totalCount : mapped.length >= 30;
        if (floorHasMore.value) floorPage.value += 1;
        if (floorReplies.value.length === 0) {
          floorMessage.value = errCode !== 0 ? '楼层评论暂不可用' : message || '暂无回复';
        }
      }
    } catch {
      toastStore.loadFailed('楼层评论');
      floorLoadMoreMessage.value = '加载更多失败，点击重试';
    } finally {
      floorLoading.value = false;
    }
  };

  return {
    floorLoading,
    floorReplies,
    floorTotal,
    floorPage,
    floorHasMore,
    floorMessage,
    floorLoadMoreMessage,
    showFloorEnd,
    resetFloor,
    fetchFloorReplies,
  };
}
