<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  getMusicComments,
  getPlaylistComments,
  getAlbumComments,
  getMusicClassifyComments,
  getMusicHotwordComments,
  getFloorComments,
  getFavoriteCount,
  getCommentCount,
} from '@/api/comment';
import { getSongPrivilegeLite, getSongRanking } from '@/api/music';
import { mapCommentItem } from '@/utils/mappers';
import type { Comment } from '@/models/comment';
import { getSongEffectTags, getSongQualityTags } from '@/utils/song';
import Dialog from '@/components/ui/Dialog.vue';
import Tabs from '@/components/ui/Tabs.vue';
import TabsList from '@/components/ui/TabsList.vue';
import TabsTrigger from '@/components/ui/TabsTrigger.vue';
import TabsContent from '@/components/ui/TabsContent.vue';
import CustomTabBar from '@/components/ui/CustomTabBar.vue';
import CommentList from '@/components/music/CommentList.vue';
import SliverHeader from '@/components/music/DetailPageSliverHeader.vue';
import BackToTop from '@/components/ui/BackToTop.vue';
import Button from '@/components/ui/Button.vue';
import { iconX } from '@/icons';
import { useToastStore } from '@/stores/toast';

interface CommentPayload {
  hot?: Comment[];
  list: Comment[];
  total: number;
  classifyList: Array<{ id: number | string; name: string; count?: number }>;
  hotwordList: Array<{ content: string; count?: number }>;
}

const route = useRoute();
const router = useRouter();
const toastStore = useToastStore();
const id = route.params.id as string;
const type = route.query.type as 'music' | 'playlist' | 'album';

const songTitle = computed(() => String(route.query.title ?? ''));
const songArtist = computed(() => String(route.query.artist ?? ''));
const songAlbum = computed(() => String(route.query.album ?? ''));
// const songCover = computed(() => String(route.query.cover ?? ''));
const songHash = computed(() => String(route.query.hash ?? ''));
const songArtistIdFromQuery = computed(() => String(route.query.artistId ?? ''));
const songAlbumId = computed(() => String(route.query.albumId ?? ''));
const songMixSongId = computed(() => String(route.query.mixSongId ?? id));

const isMusicType = computed(() => type === 'music');
const resourceTitle = computed(() => songTitle.value || String(route.query.title ?? ''));
// const resourceSubtitle = computed(() => {
//   if (type === 'music') {
//     return [songArtist.value, songAlbum.value].filter(Boolean).join(' • ');
//   }
//   return String(route.query.artist ?? route.query.subtitle ?? '');
// });
const resourceCover = computed(() => String(route.query.cover ?? ''));
const headerTypeLabel = computed(() => {
  switch (type) {
    case 'music':
      return 'SONG';
    case 'playlist':
      return 'PLAYLIST';
    case 'album':
      return 'ALBUM';
    default:
      return 'COMMENTS';
  }
});

const headerTitle = computed(() => resourceTitle.value || title.value);

const mainTab = ref<'detail' | 'comment'>('detail');

const activeCommentTab = ref('hot');
const commentTabValues = ['hot', 'all', 'classify', 'hotword'] as const;
const activeCommentTabIndex = computed({
  get: () =>
    Math.max(
      0,
      commentTabValues.indexOf(activeCommentTab.value as (typeof commentTabValues)[number]),
    ),
  set: (value: number) => {
    handleCommentTabChange(commentTabValues[value] ?? 'hot');
  },
});

const isLoadingComments = ref(false);
const isLoadingClassify = ref(false);
const isLoadingHotword = ref(false);
const total = ref(0);
const hotComments = ref<Comment[]>([]);
const comments = ref<Comment[]>([]);
const page = ref(1);
const hasMore = ref(true);

const classifyList = ref<Array<{ id: number | string; name: string; count?: number }>>([]);
const hotwordList = ref<Array<{ content: string; count?: number }>>([]);
const classifyComments = ref<Comment[]>([]);
const classifyPage = ref(1);
const hasMoreClassify = ref(true);
const selectedClassify = ref<number | string | null>(null);
const hotwordComments = ref<Comment[]>([]);
const hotwordPage = ref(1);
const hasMoreHotword = ref(true);
const selectedHotword = ref<string | null>(null);

const detailLoading = ref(false);
const privilegeData = ref<Record<string, unknown> | null>(null);
const rankingData = ref<Record<string, unknown> | null>(null);
const favoriteCount = ref(0);
const commentCount = ref(0);
const commentCountData = ref<Record<string, unknown> | null>(null);

const showFloor = ref(false);
const floorLoading = ref(false);
const floorReplies = ref<Comment[]>([]);
const floorTotal = ref(0);
const floorPage = ref(1);
const floorHasMore = ref(true);
const activeFloorComment = ref<Comment | null>(null);
const floorMessage = ref('');
const floorLoadMoreMessage = ref('');
const floorBodyRef = ref<HTMLElement | null>(null);
const classifyChipRowRef = ref<HTMLElement | null>(null);
const hotwordChipRowRef = ref<HTMLElement | null>(null);

const initialFloorComment = computed<Comment | null>(() => {
  const specialId = String(route.query.floorSpecialId ?? '');
  const tid = String(route.query.floorTid ?? '');
  if (!specialId || !tid) return null;
  return {
    id: String(route.query.floorCommentId ?? tid),
    userName: String(route.query.floorUserName ?? ''),
    avatar: String(route.query.floorAvatar ?? ''),
    content: String(route.query.floorContent ?? ''),
    time: String(route.query.floorTime ?? ''),
    likeCount: Number(route.query.floorLikeCount ?? 0) || 0,
    replyCount: Number(route.query.floorReplyCount ?? 0) || 0,
    isHot: String(route.query.floorIsHot ?? '') === '1',
    isStar: String(route.query.floorIsStar ?? '') === '1',
    specialId,
    tid,
    code: String(route.query.floorCode ?? ''),
    mixSongId: String(route.query.floorMixSongId ?? ''),
  };
});

const title = computed(() => {
  switch (type) {
    case 'music':
      return '歌曲评论';
    case 'playlist':
      return '歌单评论';
    case 'album':
      return '专辑评论';
    default:
      return '评论';
  }
});

const songLanguage = computed(() => {
  const transParam =
    (privilegeData.value?.trans_param as Record<string, unknown> | undefined) ?? undefined;
  return String(transParam?.language ?? '未知');
});

const resolveNumericId = (value: unknown) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return null;
  return parsed;
};

const isSameRoute = (name: string, targetId: string | number) => {
  const routeId = Array.isArray(route.params.id) ? route.params.id[0] : route.params.id;
  return route.name === name && String(routeId) === String(targetId);
};

const singerInfo = computed<Record<string, unknown> | null>(() => {
  if (!privilegeData.value) return null;
  const singerRaw =
    (privilegeData.value.singerinfo as unknown[] | undefined) ??
    (privilegeData.value.authors as unknown[] | undefined);
  if (!Array.isArray(singerRaw) || singerRaw.length === 0) return null;
  const first = singerRaw.find((item) => typeof item === 'object' && item !== null) as
    | Record<string, unknown>
    | undefined;
  return first ?? null;
});

const songArtistId = computed(() => {
  const queryId = resolveNumericId(songArtistIdFromQuery.value);
  if (queryId !== null) return queryId;
  const raw =
    singerInfo.value?.id ??
    singerInfo.value?.author_id ??
    singerInfo.value?.singerid ??
    singerInfo.value?.singer_id;
  return resolveNumericId(raw);
});

const canOpenArtist = computed(
  () =>
    isMusicType.value &&
    songArtistId.value !== null &&
    !isSameRoute('artist-detail', songArtistId.value),
);
const canOpenAlbum = computed(() => {
  const albumId = resolveNumericId(songAlbumId.value);
  return isMusicType.value && albumId !== null && !isSameRoute('album-detail', albumId);
});

const openArtistDetail = () => {
  if (!canOpenArtist.value || songArtistId.value === null) return;
  router.push({
    name: 'artist-detail',
    params: { id: String(songArtistId.value) },
  });
};

const openAlbumDetail = () => {
  const albumId = resolveNumericId(songAlbumId.value);
  if (!canOpenAlbum.value || albumId === null) return;
  router.push({
    name: 'album-detail',
    params: { id: String(albumId) },
  });
};

// const totalLabel = computed(() => (total.value > 0 ? `(${total.value})` : ''));
const showCommentsEnd = computed(
  () => !hasMore.value && !isLoadingComments.value && comments.value.length > 0,
);
const showClassifyEnd = computed(
  () => !hasMoreClassify.value && !isLoadingClassify.value && classifyComments.value.length > 0,
);
const showHotwordEnd = computed(
  () => !hasMoreHotword.value && !isLoadingHotword.value && hotwordComments.value.length > 0,
);
const showFloorEnd = computed(
  () => !floorHasMore.value && !floorLoading.value && floorReplies.value.length > 0,
);

const resolveCommentCountFromHeaderStats = (): number | null => {
  const data = commentCountData.value;
  const hash = songHash.value;

  if (!data || !hash) return null;

  const exact = data[hash];
  if (typeof exact === 'number') return exact;
  if (typeof exact === 'string') {
    const parsed = Number(exact);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const lowerHash = hash.toLowerCase();
  for (const [key, value] of Object.entries(data)) {
    if (key.toLowerCase() !== lowerHash) continue;
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }

  return null;
};

const scrollChipRowToActive = (container: HTMLElement | null) => {
  if (!container) return;
  const activeChip = container.querySelector<HTMLElement>('.comment-chip.is-active');
  activeChip?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
};

const maybeFetchByScroll = () => {
  const scrollTop =
    window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const fullHeight = document.documentElement.scrollHeight || document.body.scrollHeight || 0;
  if (fullHeight - scrollTop - viewportHeight > 400) return;

  if (type !== 'music') {
    if (!isLoadingComments.value && hasMore.value) void fetchComments();
    return;
  }

  if (activeCommentTab.value === 'classify') {
    if (!isLoadingClassify.value && hasMoreClassify.value) void fetchClassifyComments();
    return;
  }

  if (activeCommentTab.value === 'hotword') {
    if (!isLoadingHotword.value && hasMoreHotword.value) void fetchHotwordComments();
    return;
  }

  if (!isLoadingComments.value && hasMore.value) {
    void fetchComments();
  }
};

const formatCount = (value: number) => {
  if (!Number.isFinite(value)) return '--';
  if (value < 10000) return value.toString();
  const fixed = (value / 10000).toFixed(value >= 100000 ? 0 : 1);
  return `${fixed.replace(/\.0$/, '')}w`;
};

const relateGoods = computed(() =>
  ((privilegeData.value?.relate_goods as Record<string, unknown>[] | undefined) ?? []).map(
    (item) => ({
      quality: String(item.quality ?? ''),
      level: typeof item.level === 'number' ? item.level : undefined,
      hash: String(item.hash ?? ''),
    }),
  ),
);

const qualityTags = computed(() => getSongQualityTags(relateGoods.value));

const effectTags = computed(() => getSongEffectTags(relateGoods.value));

const rankingInfo = computed<Array<Record<string, unknown>>>(() => {
  const data = rankingData.value?.data as Record<string, unknown> | undefined;
  const list = data?.info;
  return Array.isArray(list)
    ? list.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
      )
    : [];
});

const rankingSummary = computed(() => {
  const data = rankingData.value?.data as Record<string, unknown> | undefined;
  return String(data?.title2 ?? '');
});

const singerComments = computed(() => hotComments.value.filter((item) => item.isStar));
const popularComments = computed(() =>
  hotComments.value.filter((item) => item.isHot && !item.isStar),
);
const hasFeaturedComments = computed(
  () => singerComments.value.length > 0 || popularComments.value.length > 0,
);

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
    const res = await getMusicComments(songMixSongId.value || id, page.value, 30, {
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
    const res = await getPlaylistComments(id, page.value, 30, {
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
    const res = await getAlbumComments(id, page.value, 30, {
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

const fetchClassifyComments = async (reset = false) => {
  if (!selectedClassify.value) return;
  if (type !== 'music') return;
  if (isLoadingClassify.value) return;
  if (reset) {
    classifyPage.value = 1;
    classifyComments.value = [];
    hasMoreClassify.value = true;
  }
  isLoadingClassify.value = true;
  try {
    const res = await getMusicClassifyComments(
      songMixSongId.value || id,
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
      classifyComments.value = reset ? payload.list : [...classifyComments.value, ...payload.list];
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
  if (type !== 'music') return;
  if (isLoadingHotword.value) return;
  if (reset) {
    hotwordPage.value = 1;
    hotwordComments.value = [];
    hasMoreHotword.value = true;
  }
  isLoadingHotword.value = true;
  try {
    const res = await getMusicHotwordComments(
      songMixSongId.value || id,
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
      const selectedItem = hotwordList.value.find((item) => item.content === selectedHotword.value);
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

const fetchComments = async (reset = false) => {
  if (type === 'music') return fetchMusicComments(reset);
  if (type === 'playlist') return fetchPlaylistComments(reset);
  return fetchAlbumComments(reset);
};

const resetFloor = () => {
  floorReplies.value = [];
  floorTotal.value = 0;
  floorPage.value = 1;
  floorHasMore.value = true;
  floorMessage.value = '';
  floorLoadMoreMessage.value = '';
};

const openFloor = (comment: Comment) => {
  activeFloorComment.value = comment;
  resetFloor();
  showFloor.value = true;
  void fetchFloorReplies(true);
};

const handleFloorScroll = () => {
  if (!floorBodyRef.value) return;
  if (floorLoading.value || !floorHasMore.value) return;
  const { scrollTop, scrollHeight, clientHeight } = floorBodyRef.value;
  if (scrollHeight - scrollTop - clientHeight < 240) {
    void fetchFloorReplies();
  }
};

const fetchFloorReplies = async (reset = false) => {
  if (!activeFloorComment.value) return;
  if (floorLoading.value) return;
  if (!floorHasMore.value && !reset) return;
  if (reset) {
    floorPage.value = 1;
    floorReplies.value = [];
    floorHasMore.value = true;
  }
  floorLoading.value = true;
  try {
    const comment = activeFloorComment.value;
    const specialId = comment.specialId ?? '';
    const tid = comment.tid ?? String(comment.id);
    const mixSongId =
      comment.mixSongId ?? (type === 'music' ? songMixSongId.value || id : undefined);
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
      resourceType: type,
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

const handleCommentTabChange = (value: string | number) => {
  activeCommentTab.value = String(value);
  if (value === 'classify' && classifyComments.value.length === 0) {
    void fetchClassifyComments(true);
  }
  if (value === 'hotword' && hotwordComments.value.length === 0) {
    void fetchHotwordComments(true);
  }
  void nextTick(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    maybeFetchByScroll();
  });
};

const fetchHeaderStats = async () => {
  if (type !== 'music') return;
  try {
    const [favoriteRes, commentRes] = await Promise.all([
      getFavoriteCount(songMixSongId.value || id),
      getCommentCount(songHash.value || ''),
    ]);
    if (favoriteRes && typeof favoriteRes === 'object') {
      const record = favoriteRes as unknown as Record<string, unknown>;
      const data = (record.data as Record<string, unknown>) || record;
      const list = (data.list as Record<string, unknown>[]) || [];
      const first = Array.isArray(list) ? list[0] : undefined;
      const count =
        Number(first?.count ?? first?.collect_count ?? data.count ?? data.collect_count ?? 0) || 0;
      favoriteCount.value = count;
    }
    if (commentRes && typeof commentRes === 'object') {
      const record = commentRes as unknown as Record<string, unknown>;
      commentCountData.value = record;
      const headerCount = resolveCommentCountFromHeaderStats();
      if (headerCount !== null) {
        commentCount.value = headerCount;
      }
    }
  } catch {
    // ignore
  }
};

const fetchDetailData = async () => {
  if (type !== 'music') return;
  if (!songHash.value) return;
  detailLoading.value = true;
  try {
    const [privilegeRes, rankingRes] = await Promise.all([
      getSongPrivilegeLite(songHash.value, songAlbumId.value || undefined),
      getSongRanking(songMixSongId.value || id),
    ]);
    if (privilegeRes && typeof privilegeRes === 'object') {
      const record = privilegeRes as unknown as Record<string, unknown>;
      const data = (record.data as unknown[]) || [];
      const list = Array.isArray(data) ? data : [];
      privilegeData.value =
        list.length > 0 && typeof list[0] === 'object'
          ? (list[0] as Record<string, unknown>)
          : null;
    }
    if (rankingRes && typeof rankingRes === 'object') {
      rankingData.value = rankingRes as unknown as Record<string, unknown>;
    }
  } finally {
    detailLoading.value = false;
  }
};

onMounted(async () => {
  if (route.query.floorSpecialId || route.query.floorTid) {
    mainTab.value = 'comment';
  } else {
    mainTab.value =
      String(route.query.tab ?? route.query.mainTab ?? 'detail') === 'comment'
        ? 'comment'
        : 'detail';
  }
  window.addEventListener('scroll', maybeFetchByScroll, { passive: true });
  await fetchComments(true);
  if (isMusicType.value) {
    void fetchHeaderStats();
    void fetchDetailData();
  }
  if (initialFloorComment.value) {
    openFloor(initialFloorComment.value);
  }
  void nextTick(() => {
    scrollChipRowToActive(classifyChipRowRef.value);
    scrollChipRowToActive(hotwordChipRowRef.value);
  });
});

onBeforeUnmount(() => {
  window.removeEventListener('scroll', maybeFetchByScroll);
});

watch(selectedClassify, () => {
  void nextTick(() => scrollChipRowToActive(classifyChipRowRef.value));
});

watch(selectedHotword, () => {
  void nextTick(() => scrollChipRowToActive(hotwordChipRowRef.value));
});

watch(total, (value) => {
  if (!commentCount.value && value > 0) {
    commentCount.value = value;
  }
});
</script>

<template>
  <div class="comment-page bg-bg-main min-h-full">
    <SliverHeader
      :typeLabel="headerTypeLabel"
      :title="headerTitle"
      :coverUrl="resourceCover"
      :hasDetails="true"
      :expandedHeight="164"
      :collapsedHeight="56"
      :contentPaddingX="0"
      :contentGap="10"
      :coverBaseSize="124"
      :titleFontSize="20"
      :detailsGap="6"
      :detailsMarginTop="6"
    >
      <template #details>
        <div class="comment-song-header">
          <Button
            variant="unstyled"
            size="none"
            v-if="songArtist"
            type="button"
            class="comment-song-subtitle"
            :class="{ 'is-link': canOpenArtist }"
            :disabled="!canOpenArtist"
            @click="openArtistDetail"
          >
            {{ songArtist }}
          </Button>
          <div v-if="isMusicType" class="comment-song-meta-row">
            <Button
              variant="unstyled"
              size="none"
              type="button"
              class="comment-song-meta"
              :class="{ 'is-link': canOpenAlbum }"
              :disabled="!canOpenAlbum"
              @click="openAlbumDetail"
            >
              <span class="comment-song-meta-label">专辑</span>
              <span class="comment-song-meta-value">{{ songAlbum || '单曲' }}</span>
            </Button>
            <div class="comment-song-meta">
              <span class="comment-song-meta-label">语言</span>
              <span class="comment-song-meta-value">{{ songLanguage }}</span>
            </div>
            <div class="comment-song-meta">
              <span class="comment-song-meta-label">累计收藏</span>
              <span class="comment-song-meta-value">{{ formatCount(favoriteCount) }}</span>
            </div>
            <div class="comment-song-meta">
              <span class="comment-song-meta-label">评论</span>
              <span class="comment-song-meta-value">{{ formatCount(commentCount) }}</span>
            </div>
          </div>
        </div>
      </template>
    </SliverHeader>

    <div class="comment-content-wrap comment-content-wrap--music">
      <template v-if="isMusicType">
        <Tabs :model-value="mainTab" @update:model-value="mainTab = $event as 'detail' | 'comment'">
          <div class="comment-main-tabs sticky z-[120] bg-bg-main" :style="{ top: '56px' }">
            <TabsList class="comment-main-tab-list">
              <TabsTrigger value="detail" class="comment-main-tab-trigger">详情</TabsTrigger>
              <TabsTrigger value="comment" class="comment-main-tab-trigger">评论</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="detail">
            <div
              v-if="
                !detailLoading &&
                (qualityTags.length || effectTags.length || rankingInfo.length || rankingSummary)
              "
              class="detail-section detail-section--plain"
            >
              <div v-if="qualityTags.length" class="detail-block">
                <div class="detail-title">可选音质</div>
                <div class="detail-tags">
                  <span v-for="tag in qualityTags" :key="tag" class="detail-tag">{{ tag }}</span>
                </div>
              </div>
              <div v-if="effectTags.length" class="detail-block">
                <div class="detail-title">可用音效</div>
                <div class="detail-tags">
                  <span v-for="tag in effectTags" :key="tag" class="detail-tag">{{ tag }}</span>
                </div>
              </div>
              <div v-if="rankingSummary || rankingInfo.length" class="detail-block">
                <div class="detail-title">榜单成就</div>
                <div v-if="rankingSummary" class="detail-summary">• {{ rankingSummary }}</div>
                <div v-if="rankingInfo.length" class="ranking-list">
                  <div v-for="(rank, index) in rankingInfo" :key="index" class="ranking-card">
                    <div class="ranking-card-header">
                      <div class="ranking-title">{{ rank.platform_name || '未知平台' }}</div>
                      <div class="ranking-rank">第 {{ rank.ranking_num || 0 }} 名</div>
                    </div>
                    <div class="ranking-meta">
                      <span>累计上榜：{{ rank.ranking_times || 0 }}次</span>
                      <span>最近上榜：{{ rank.last_time || '未知' }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="comment">
            <div class="comment-tabs-shell">
              <div class="comment-sub-tabs">
                <CustomTabBar
                  v-model="activeCommentTabIndex"
                  class="comment-sub-tabbar"
                  :tabs="['精彩评论', '全部评论', '分类评论', '热词评论']"
                />
              </div>

              <template v-if="activeCommentTab === 'hot'">
                <div class="comment-list-wrap">
                  <div v-if="singerComments.length" class="comment-section-title">歌手说</div>
                  <CommentList
                    :comments="singerComments"
                    :loading="isLoadingComments"
                    :onTapReplies="openFloor"
                    compact
                    hide-empty
                  />
                  <div v-if="popularComments.length" class="comment-section-title">热门评论</div>
                  <CommentList
                    :comments="popularComments"
                    :loading="isLoadingComments"
                    :onTapReplies="openFloor"
                    compact
                    hide-empty
                  />
                  <div v-if="!isLoadingComments && !hasFeaturedComments" class="comment-only-empty">
                    暂无评论
                  </div>
                </div>
              </template>

              <template v-else-if="activeCommentTab === 'all'">
                <div class="comment-list-wrap">
                  <CommentList
                    :comments="comments"
                    :loading="isLoadingComments"
                    :onTapReplies="openFloor"
                    compact
                  />
                  <div v-if="isLoadingComments || showCommentsEnd" class="comment-load-more">
                    <div v-if="isLoadingComments" class="comment-loading-inline">
                      <div class="comment-loading-spinner"></div>
                      <span>加载中...</span>
                    </div>
                    <div v-else class="comment-end-hint">已加载全部评论</div>
                  </div>
                </div>
              </template>

              <template v-else-if="activeCommentTab === 'classify'">
                <div class="comment-list-wrap">
                  <div ref="classifyChipRowRef" class="comment-chip-row">
                    <Button
                      variant="unstyled"
                      size="none"
                      v-for="item in classifyList"
                      :key="item.id"
                      :class="['comment-chip', selectedClassify === item.id && 'is-active']"
                      @click="
                        selectedClassify = item.id;
                        void fetchClassifyComments(true);
                      "
                    >
                      {{ item.name
                      }}<span v-if="item.count" class="comment-chip-count">{{ item.count }}</span>
                    </Button>
                  </div>
                  <CommentList
                    :comments="classifyComments"
                    :loading="isLoadingClassify"
                    :onTapReplies="openFloor"
                    compact
                    empty-text="该分类下暂无评论"
                  />
                  <div v-if="isLoadingClassify || showClassifyEnd" class="comment-load-more">
                    <div v-if="isLoadingClassify" class="comment-loading-inline">
                      <div class="comment-loading-spinner"></div>
                      <span>加载中...</span>
                    </div>
                    <div v-else class="comment-end-hint">已加载全部评论</div>
                  </div>
                </div>
              </template>

              <template v-else>
                <div class="comment-list-wrap">
                  <div ref="hotwordChipRowRef" class="comment-chip-row">
                    <Button
                      variant="unstyled"
                      size="none"
                      v-for="item in hotwordList"
                      :key="item.content"
                      :class="['comment-chip', selectedHotword === item.content && 'is-active']"
                      @click="
                        selectedHotword = item.content;
                        void fetchHotwordComments(true);
                      "
                    >
                      {{ item.content
                      }}<span v-if="item.count" class="comment-chip-count">{{ item.count }}</span>
                    </Button>
                  </div>
                  <CommentList
                    :comments="hotwordComments"
                    :loading="isLoadingHotword"
                    :onTapReplies="openFloor"
                    compact
                    empty-text="该热词下暂无评论"
                  />
                  <div v-if="isLoadingHotword || showHotwordEnd" class="comment-load-more">
                    <div v-if="isLoadingHotword" class="comment-loading-inline">
                      <div class="comment-loading-spinner"></div>
                      <span>加载中...</span>
                    </div>
                    <div v-else class="comment-end-hint">已加载全部评论</div>
                  </div>
                </div>
              </template>
            </div>
          </TabsContent>
        </Tabs>
      </template>

      <template v-else>
        <div v-if="hotComments.length" class="comment-section-title">热门评论</div>
        <CommentList
          :comments="hotComments"
          :loading="isLoadingComments"
          :onTapReplies="openFloor"
          compact
          hide-empty
        />
        <CommentList
          :comments="comments"
          :loading="isLoadingComments"
          :onTapReplies="openFloor"
          compact
        />
        <div v-if="isLoadingComments || showCommentsEnd" class="comment-load-more">
          <div v-if="isLoadingComments" class="comment-loading-inline">
            <div class="comment-loading-spinner"></div>
            <span>加载中...</span>
          </div>
          <div v-else class="comment-end-hint">已加载全部评论</div>
        </div>
      </template>
    </div>

    <Dialog
      v-model:open="showFloor"
      contentClass="comment-floor-dialog"
      bodyClass="comment-floor-dialog-body"
    >
      <div class="comment-floor-header">
        <div class="comment-floor-title">楼层评论</div>
        <Button class="comment-floor-close" variant="ghost" size="xs" @click="showFloor = false">
          <Icon :icon="iconX" width="20" height="20" />
        </Button>
      </div>
      <div class="comment-floor-body" ref="floorBodyRef" @scroll="handleFloorScroll">
        <div class="comment-floor-section">原评论</div>
        <CommentList
          v-if="activeFloorComment"
          :comments="[activeFloorComment]"
          :showDivider="false"
          :loading="false"
          compact
        />
        <div class="comment-floor-section">回复{{ floorTotal > 0 ? ` (${floorTotal})` : '' }}</div>
        <CommentList :comments="floorReplies" :loading="floorLoading" :showDivider="true" compact />
        <div v-if="!floorLoading && floorReplies.length === 0" class="comment-floor-empty">
          {{ floorMessage || '暂无回复' }}
        </div>
        <div
          v-if="floorHasMore || floorLoading || showFloorEnd"
          class="comment-load-more comment-load-more-floor"
        >
          <div v-if="floorLoading" class="comment-loading-inline">
            <div class="comment-loading-spinner"></div>
            <span>加载中...</span>
          </div>
          <Button v-else-if="floorHasMore" variant="outline" size="xs" @click="fetchFloorReplies()">
            {{ floorLoadMoreMessage || '加载更多' }}
          </Button>
          <div v-else class="comment-end-hint">已加载全部评论</div>
        </div>
      </div>
    </Dialog>

    <BackToTop target-selector=".comment-content-wrap" :threshold="360" />
  </div>
</template>

<style scoped>
@reference "@/style.css";

.comment-page {
  padding: 0 24px 40px;
}

.comment-content-wrap {
  width: 100%;
  max-width: none;
  margin: 0;
  padding: 8px 0 40px;
}

.comment-content-wrap--music {
  padding-top: 2px;
}

.comment-tabs-shell {
  margin-top: 8px;
  width: 100%;
}

.comment-main-tabs {
  margin: 0 0 14px;
  padding: 8px 0 10px;
  width: 100%;
}

.comment-main-tab-list {
  @apply !h-auto gap-7 bg-transparent p-0 border-0;
}

.comment-main-tab-trigger {
  @apply !h-auto !pb-2 text-[18px] font-semibold text-text-main/55 data-[state=active]:text-text-main;
}

.comment-song-header {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.comment-song-subtitle {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0;
  background: transparent;
  text-align: left;
}

.comment-song-subtitle.is-link {
  cursor: pointer;
}

.comment-song-meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
}

.comment-song-meta {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  padding: 0;
  background: transparent;
  text-align: left;
}

.comment-song-meta.is-link {
  cursor: pointer;
}

.comment-song-meta-label {
  font-size: 12px;
  font-weight: 600;
  color: color-mix(in srgb, var(--color-text-main) 50%, transparent);
}

.comment-song-meta-value {
  font-size: 12px;
  font-weight: 700;
  color: var(--color-text-main);
}

.comment-song-meta.is-link .comment-song-meta-value {
  color: var(--color-primary);
}

.comment-sub-tabs {
  margin: 8px 0 16px;
  width: 100%;
}

.comment-sub-tabbar {
  width: 100%;
  max-width: none;
}

.comment-list-wrap {
  min-height: 120px;
}

.comment-only-empty {
  padding: 36px 0 16px;
  text-align: center;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.comment-sub-list {
  background: color-mix(in srgb, var(--color-text-main) 7%, transparent);
  padding: 4px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--color-text-main) 10%, transparent);
}

.comment-chip-row {
  display: flex;
  gap: 8px;
  flex-wrap: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  width: 100%;
  padding: 8px 0 4px 8px;
  margin: 0 0 12px;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
}

.comment-chip-row::-webkit-scrollbar {
  display: none;
}

.comment-chip {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  padding: 0 12px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--color-text-main) 12%, transparent);
  background: color-mix(in srgb, var(--color-text-main) 6%, transparent);
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
  white-space: nowrap;
  box-shadow: none;
}

.comment-chip.is-active {
  color: white;
  border-color: transparent;
  background: var(--color-primary);
  box-shadow: none;
}

.comment-chip-count {
  margin-left: 5px;
  font-size: 10px;
  opacity: 0.72;
  font-family: monospace;
}

.comment-section-title {
  margin: 18px 0 10px;
  padding: 0 12px;
  font-size: 13px;
  font-weight: 700;
  color: color-mix(in srgb, var(--color-text-main) 70%, transparent);
}

.comment-load-more {
  display: flex;
  justify-content: center;
  margin: 18px 0 30px;
}

.comment-load-more button {
  padding: 8px 24px;
  border-radius: 999px;
  border: 1px solid var(--color-border-light);
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-main);
  background: var(--color-bg-card);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.04);
}

.comment-loading-inline {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.comment-end-hint {
  font-size: 12px;
  font-weight: 600;
  color: color-mix(in srgb, var(--color-text-main) 42%, transparent);
}

.comment-loading-spinner {
  width: 16px;
  height: 16px;
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

.detail-section {
  margin-top: 12px;
  padding: 20px;
  border-radius: 20px;
  background: color-mix(in srgb, var(--color-text-main) 4%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-text-main) 8%, transparent);
}

.detail-section--plain {
  padding: 8px 0 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.detail-block + .detail-block {
  margin-top: 16px;
}

.detail-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text-main);
  margin-bottom: 12px;
}

.detail-tags {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.detail-tag {
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-primary) 24%, transparent);
}

.detail-summary {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin-bottom: 12px;
}

.ranking-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.ranking-card {
  padding: 18px;
  border-radius: 18px;
  background: color-mix(in srgb, var(--color-text-main) 6%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-text-main) 10%, transparent);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ranking-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.ranking-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--color-text-main);
  min-width: 0;
}

.ranking-meta {
  display: flex;
  gap: 20px;
  font-size: 12px;
  color: var(--color-text-secondary);
  flex-wrap: wrap;
}

.ranking-rank {
  flex-shrink: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--color-text-main);
  text-align: right;
}

@media (max-width: 520px) {
  .ranking-card-header {
    align-items: stretch;
    flex-direction: column;
  }

  .ranking-rank {
    text-align: left;
  }
}

.comment-detail-empty {
  padding: 24px 0;
  text-align: center;
  color: var(--color-text-secondary);
}

:global(.comment-floor-dialog) {
  left: calc(var(--drawer-content-left, 0px) + (var(--drawer-content-width, 92vw) / 2));
  top: calc(var(--drawer-content-top, 0px) + (var(--drawer-content-height, 100vh) / 2));
  width: min(620px, calc(var(--drawer-content-width, 92vw) - 40px));
  max-width: calc(var(--drawer-content-width, 92vw) - 40px);
  max-height: min(720px, calc(var(--drawer-content-height, 100vh) - 24px));
  padding: 24px 2px 24px 24px;
  border-radius: 24px;
  overflow: hidden;
  box-shadow: 0 18px 48px color-mix(in srgb, black 18%, transparent);
  transform: translate(-50%, -50%) scale(0.98);
}

:global(.comment-floor-dialog[data-state='open']) {
  transform: translate(-50%, -50%) scale(1);
}

:global(.comment-floor-dialog[data-state='closed']) {
  transform: translate(-50%, -50%) scale(0.98);
}

:global(.comment-floor-dialog .dialog-scroll-area) {
  margin-top: 0;
  overflow-y: auto;
  min-height: 0;
}

:global(.comment-floor-dialog .comment-floor-dialog-body) {
  padding-right: 16px;
  margin-top: 0;
}

.comment-floor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 0 16px 12px 0;
  margin-bottom: 4px;
  background: var(--color-bg-main);
  border-bottom: 1px solid color-mix(in srgb, var(--color-border-light) 72%, transparent);
}

.comment-floor-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--color-text-main);
}

.comment-floor-close {
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

.comment-floor-close:hover {
  color: var(--color-text-main);
}

.comment-floor-body {
  padding: 0 0 2px;
  max-height: none;
  overflow: visible;
}

.comment-floor-empty {
  padding: 16px 0 24px;
  text-align: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.comment-floor-section {
  margin: 16px 0 10px;
  font-size: 12px;
  font-weight: 700;
  color: var(--color-text-secondary);
}

.comment-load-more-floor {
  margin-bottom: 8px;
}
</style>
