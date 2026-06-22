<script setup lang="ts">
defineOptions({ name: 'song-detail-page' });
import { ref, onMounted, onBeforeUnmount, computed, watch, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  getMusicComments,
  getPlaylistComments,
  getAlbumComments,
  getMusicClassifyComments,
  getMusicHotwordComments,
  getFavoriteCount,
  getCommentCount,
} from '@/api/comment';
import { getSongPrivilegeLite, getSongRanking } from '@/api/music';
import { mapCommentItem } from '@/utils/mappers';
import type { Comment } from '@/models/comment';
import type { Song } from '@/models/song';
import { getSongEffectTags, getSongQualityTags } from '@/utils/song';
import Tabs from '@/components/ui/Tabs.vue';
import TabsList from '@/components/ui/TabsList.vue';
import TabsTrigger from '@/components/ui/TabsTrigger.vue';
import TabsContent from '@/components/ui/TabsContent.vue';
import CustomTabBar from '@/components/ui/CustomTabBar.vue';
import CommentList from '@/components/music/CommentList.vue';
import SliverHeader from '@/components/music/DetailPageSliverHeader.vue';
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import AddToPlaylistDialog from '@/components/music/AddToPlaylistDialog.vue';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';
import Button from '@/components/ui/Button.vue';
import { useToastStore } from '@/stores/toast';
import { PERSONAL_FM_QUEUE_ID, usePlaylistStore } from '@/stores/playlist';
import { usePlayerStore } from '@/stores/player';
import { useUserStore } from '@/stores/user';
import { queueAndPlaySong } from '@/utils/playback';
import { isPlayableSong } from '@/utils/song';
import { copyShareTarget, createShareTarget } from '@/utils/share';
import { iconList, iconPlay, iconShare } from '@/icons';

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
const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const userStore = useUserStore();
const id = route.params.id as string;
const type = route.query.type as 'music' | 'playlist' | 'album';

const detailSong = ref<Song | null>(null);
const showPlaylistDialog = ref(false);
const isPlaylistLoading = ref(false);

const songTitle = computed(() => String(route.query.title ?? detailSong.value?.title ?? ''));
const songArtist = computed(() => String(route.query.artist ?? detailSong.value?.artist ?? ''));
const songAlbum = computed(() => String(route.query.album ?? detailSong.value?.album ?? ''));
const songHash = computed(() => String(route.query.hash ?? detailSong.value?.hash ?? ''));
const songArtistIdFromQuery = computed(() =>
  String(route.query.artistId ?? detailSong.value?.artists?.[0]?.id ?? ''),
);
const songAlbumId = computed(() => String(route.query.albumId ?? detailSong.value?.albumId ?? ''));
const songMixSongId = computed(() =>
  String(route.query.mixSongId ?? detailSong.value?.mixSongId ?? id),
);

const isMusicType = computed(() => type === 'music');
const resourceTitle = computed(() => songTitle.value || String(route.query.title ?? ''));
// const resourceSubtitle = computed(() => {
//   if (type === 'music') {
//     return [songArtist.value, songAlbum.value].filter(Boolean).join(' • ');
//   }
//   return String(route.query.artist ?? route.query.subtitle ?? '');
// });
const resourceCover = computed(() => String(route.query.cover ?? detailSong.value?.coverUrl ?? ''));
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

const activeCommentTab = ref('all');
const commentTabValues = ['all', 'classify', 'hotword'] as const;
const activeCommentTabIndex = computed({
  get: () =>
    Math.max(
      0,
      commentTabValues.indexOf(activeCommentTab.value as (typeof commentTabValues)[number]),
    ),
  set: (value: number) => {
    handleCommentTabChange(commentTabValues[value] ?? 'all');
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

const classifyChipRowRef = ref<HTMLElement | null>(null);
const hotwordChipRowRef = ref<HTMLElement | null>(null);

const title = computed(() => {
  switch (type) {
    case 'music':
      return '歌曲详情';
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

const toPlainRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const readText = (...values: unknown[]) => {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
};

const readNumber = (...values: unknown[]) => {
  const text = readText(...values);
  if (!text) return 0;
  const parsed = Number.parseInt(text, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const readRecord = (record: Record<string, unknown>, key: string) => toPlainRecord(record[key]);

const readArray = (...values: unknown[]) => {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
};

const normalizeCover = (value: string) => {
  if (!value) return '';
  const resolved = value.replaceAll('{size}', '400');
  return resolved.startsWith('//') ? `https:${resolved}` : resolved;
};

const normalizeDuration = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1000 ? Math.floor(value / 1000) : value;
};

const buildArtistsFromPrivilege = (record: Record<string, unknown>) => {
  const audioInfo = readRecord(record, 'audio_info') ?? {};
  const authors = readArray(record.authors, record.singerinfo, audioInfo.singerinfo);
  const artists = authors
    .map((item) => {
      const author = toPlainRecord(item);
      if (!author) return null;
      const base = readRecord(author, 'base') ?? author;
      const name = readText(
        base.name,
        base.author_name,
        base.AuthorName,
        base.singername,
        base.singer,
      );
      if (!name) return null;
      const authorId = readText(
        base.id,
        base.author_id,
        base.AuthorId,
        base.singerid,
        base.singer_id,
      );
      return { ...(authorId ? { id: authorId } : {}), name };
    })
    .filter((item): item is { id?: string; name: string } => Boolean(item));

  if (artists.length > 0) return artists;

  const fallbackName = readText(
    record.author_name,
    record.AuthorName,
    record.singername,
    record.singer,
    audioInfo.author_name,
    audioInfo.AuthorName,
    audioInfo.singername,
  );
  if (!fallbackName) return [];

  const fallbackId = readText(
    record.author_id,
    record.AuthorId,
    record.singerid,
    record.singer_id,
    audioInfo.author_id,
    audioInfo.AuthorId,
    audioInfo.singerid,
    audioInfo.singer_id,
  );
  return [{ ...(fallbackId ? { id: fallbackId } : {}), name: fallbackName }];
};

const buildSongFromPrivilege = (record: Record<string, unknown>): Song => {
  const base = readRecord(record, 'base') ?? {};
  const audioInfo = readRecord(record, 'audio_info') ?? {};
  const albumInfo = readRecord(record, 'album_info') ?? {};
  const transParam = readRecord(record, 'trans_param') ?? {};
  const artists = buildArtistsFromPrivilege(record);
  const artistName = artists.map((item) => item.name).join(', ') || readText(route.query.artist);
  const cover = normalizeCover(
    readText(
      route.query.cover,
      record.pic,
      record.img,
      audioInfo.img,
      albumInfo.sizable_cover,
      albumInfo.cover,
      transParam.union_cover,
    ),
  );
  const targetId = readText(
    route.query.mixSongId,
    id,
    base.mixsongid,
    base.album_audio_id,
    base.audio_id,
    record.mixsongid,
    record.album_audio_id,
    record.audio_id,
  );
  const title = readText(
    route.query.title,
    base.audio_name,
    record.audio_name,
    record.songname,
    record.name,
    record.filename,
    '未知歌曲',
  );
  const albumName = readText(
    route.query.album,
    albumInfo.album_name,
    albumInfo.albumname,
    record.album_name,
    record.albumname,
  );
  const albumId = readText(
    route.query.albumId,
    base.album_id,
    base.albumid,
    albumInfo.album_id,
    albumInfo.albumid,
    record.album_id,
    record.albumid,
  );

  return {
    id: targetId || readText(route.params.id),
    title,
    name: title,
    artist: artistName || '未知歌手',
    artists,
    singers: artists,
    album: albumName,
    albumName,
    albumId,
    duration: normalizeDuration(
      readNumber(audioInfo.duration, audioInfo.duration_128, record.timelength, record.duration),
    ),
    coverUrl: cover,
    cover,
    audioUrl: '',
    hash: readText(route.query.hash, audioInfo.hash, record.hash, record.hash_128),
    mixSongId: targetId || id,
    privilege: readNumber(record.privilege) || undefined,
    payType: readNumber(record.pay_type, record.PayType, record.payType) || undefined,
    oldCpy: readNumber(record.old_cpy, record.media_old_cpy) || undefined,
    relateGoods: relateGoods.value,
  };
};

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

const actionSong = computed<Song | null>(() => {
  if (!isMusicType.value) return null;
  if (detailSong.value) return detailSong.value;

  const targetId = songMixSongId.value || id;
  if (!targetId) return null;

  return {
    id: targetId,
    title: songTitle.value || '未知歌曲',
    name: songTitle.value || '未知歌曲',
    artist: songArtist.value || '未知歌手',
    artists: songArtist.value
      ? [{ id: songArtistIdFromQuery.value || undefined, name: songArtist.value }]
      : [],
    singers: songArtist.value
      ? [{ id: songArtistIdFromQuery.value || undefined, name: songArtist.value }]
      : [],
    album: songAlbum.value,
    albumName: songAlbum.value,
    albumId: songAlbumId.value,
    duration: 0,
    coverUrl: resourceCover.value,
    cover: resourceCover.value,
    audioUrl: '',
    hash: songHash.value,
    mixSongId: targetId,
  };
});

const selectablePlaylists = computed(() =>
  playlistStore.getCreatedPlaylists(userStore.info?.userid),
);

const addToPlaybackQueues = computed(() =>
  playlistStore.playbackQueueList.filter(
    (queue) =>
      queue.id !== PERSONAL_FM_QUEUE_ID && Math.max(0, queue.songCount ?? queue.songs.length) > 0,
  ),
);

const canUseSongActions = computed(() =>
  Boolean(actionSong.value && isPlayableSong(actionSong.value)),
);

const handlePlaySong = async () => {
  const song = actionSong.value;
  if (!song || !isPlayableSong(song)) {
    toastStore.unavailable('当前歌曲');
    return;
  }

  try {
    const played = await queueAndPlaySong(playlistStore, playerStore, song);
    if (!played) toastStore.unavailable('当前歌曲');
  } catch {
    toastStore.actionFailed('播放');
  }
};

const handleOpenAddToPlaylist = async () => {
  const song = actionSong.value;
  if (!song || !isPlayableSong(song)) {
    toastStore.unavailable('当前歌曲');
    return;
  }
  if (!userStore.isLoggedIn) {
    toastStore.loginRequired('添加到歌单');
    return;
  }

  showPlaylistDialog.value = true;
  if (playlistStore.userPlaylists.length === 0) {
    isPlaylistLoading.value = true;
    try {
      await playlistStore.fetchUserPlaylists();
    } catch {
      toastStore.loadFailed('歌单');
    } finally {
      isPlaylistLoading.value = false;
    }
  }
};

const handleAddToQueue = (queueId?: string) => {
  const song = actionSong.value;
  if (!song) return;
  const options = queueId ? { queueId } : {};
  const addedCount = playlistStore.appendToPlaybackQueue?.([song], options) ?? 0;
  if (addedCount > 0) {
    toastStore.actionCompleted('已添加到队列');
  } else {
    toastStore.actionCompleted('歌曲已在队列中');
  }
  showPlaylistDialog.value = false;
};

const handleSelectPlaylist = async (listId: string | number) => {
  const song = actionSong.value;
  if (!song) return;

  try {
    const result = await playlistStore.addToPlaylist(String(listId), song);
    if (result === 'added') {
      toastStore.actionCompleted('添加成功');
      showPlaylistDialog.value = false;
      return;
    }
    if (result === 'exists') {
      toastStore.warning('歌单中已有此内容');
      showPlaylistDialog.value = false;
      return;
    }
    toastStore.actionFailed('添加到歌单');
  } catch {
    toastStore.actionFailed('添加到歌单');
  }
};

const handleShareSong = async () => {
  const target = createShareTarget('song', songMixSongId.value || id, songTitle.value);
  if (!target) return;
  try {
    await copyShareTarget(target);
    toastStore.actionCompleted('分享链接已复制');
  } catch {
    toastStore.actionFailed('复制分享链接');
  }
};

const songSecondaryActions = computed(() => [
  {
    icon: iconShare,
    label: '分享',
    onTap: handleShareSong,
  },
]);

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

const resolveCommentCountFromHeaderStats = (): number | null => {
  const raw = commentCountData.value;
  const hash = songHash.value;

  if (!raw || !hash) return null;

  // 尝试在顶层和嵌套 data 中查找
  const sources = [raw, raw.data as Record<string, unknown> | undefined].filter(
    (s): s is Record<string, unknown> => typeof s === 'object' && s !== null,
  );

  for (const source of sources) {
    const exact = source[hash];
    if (typeof exact === 'number') return exact;
    if (typeof exact === 'string') {
      const parsed = Number(exact);
      if (Number.isFinite(parsed)) return parsed;
    }

    const lowerHash = hash.toLowerCase();
    for (const [key, value] of Object.entries(source)) {
      if (key.toLowerCase() !== lowerHash) continue;
      if (typeof value === 'number') return value;
      if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }

  return null;
};

const scrollChipRowToActive = (container: HTMLElement | null) => {
  if (!container) return;
  const activeChip = container.querySelector<HTMLElement>('.comment-chip.is-active');
  activeChip?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
};

// 使用 IntersectionObserver 替代 window scroll 检测加载更多
import { useScrollContainer } from '@/composables/usePageScroll';

const scrollContainerRef = useScrollContainer();
const commentSentinelRef = ref<HTMLElement | null>(null);
let commentLoadMoreObserver: IntersectionObserver | null = null;

const triggerLoadMore = () => {
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

const setupCommentLoadMoreObserver = () => {
  commentLoadMoreObserver?.disconnect();
  const root = scrollContainerRef.value ?? null;
  commentLoadMoreObserver = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      if (!entry?.isIntersecting) return;
      triggerLoadMore();
    },
    { root, rootMargin: '0px 0px 400px 0px' },
  );
  if (commentSentinelRef.value) {
    commentLoadMoreObserver.observe(commentSentinelRef.value);
  }
};

watch(commentSentinelRef, (el) => {
  if (!commentLoadMoreObserver) {
    setupCommentLoadMoreObserver();
    return;
  }
  commentLoadMoreObserver.disconnect();
  if (el) commentLoadMoreObserver.observe(el);
});

watch(scrollContainerRef, () => {
  setupCommentLoadMoreObserver();
});

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
// const popularComments = computed(() =>
//   hotComments.value.filter((item) => item.isHot && !item.isStar),
// );
// const hasFeaturedComments = computed(
//   () => singerComments.value.length > 0 || popularComments.value.length > 0,
// );

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
      if (!reset && payload.list.length === 0) {
        hasMore.value = false;
      } else {
        hasMore.value =
          total.value > 0 ? comments.value.length < total.value : payload.list.length >= 30;
      }
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
      if (!reset && payload.list.length === 0) {
        hasMore.value = false;
      } else {
        hasMore.value =
          total.value > 0 ? comments.value.length < total.value : payload.list.length >= 30;
      }
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
      if (!reset && payload.list.length === 0) {
        hasMore.value = false;
      } else {
        hasMore.value =
          total.value > 0 ? comments.value.length < total.value : payload.list.length >= 30;
      }
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
      if (!reset && payload.list.length === 0) {
        hasMoreClassify.value = false;
      } else {
        hasMoreClassify.value =
          totalCount > 0 ? classifyComments.value.length < totalCount : payload.list.length >= 30;
      }
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
      if (!reset && payload.list.length === 0) {
        hasMoreHotword.value = false;
      } else {
        hasMoreHotword.value =
          totalCount > 0 ? hotwordComments.value.length < totalCount : payload.list.length >= 30;
      }
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

const handleCommentTabChange = (value: string | number) => {
  activeCommentTab.value = String(value);
  if (value === 'classify' && classifyComments.value.length === 0) {
    void fetchClassifyComments(true);
  }
  if (value === 'hotword' && hotwordComments.value.length === 0) {
    void fetchHotwordComments(true);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
  // 延迟检查，等待 DOM 更新完成
  setTimeout(() => {
    triggerLoadMore();
  }, 100);
};

const fetchHeaderStats = async () => {
  if (type !== 'music') return;
  try {
    const hash = songHash.value;
    const [favoriteRes, commentRes] = await Promise.all([
      getFavoriteCount(songMixSongId.value || id),
      hash ? getCommentCount(hash) : Promise.resolve(null),
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
  detailLoading.value = true;
  try {
    const hash = songHash.value;
    const [privilegeRes, rankingRes] = await Promise.all([
      hash ? getSongPrivilegeLite(hash, songAlbumId.value || undefined) : Promise.resolve(null),
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
      if (privilegeData.value) {
        detailSong.value = buildSongFromPrivilege(privilegeData.value);
      }
    }
    if (rankingRes && typeof rankingRes === 'object') {
      rankingData.value = rankingRes as unknown as Record<string, unknown>;
    }
  } catch {
    toastStore.loadFailed('歌曲详情');
  } finally {
    detailLoading.value = false;
  }
};

const loadCurrentResource = async () => {
  mainTab.value =
    String(route.query.tab ?? route.query.mainTab ?? 'detail') === 'comment' ? 'comment' : 'detail';
  await fetchComments(true);
  if (isMusicType.value) {
    void fetchDetailData().finally(() => {
      void fetchHeaderStats();
    });
  }
};

onMounted(async () => {
  setupCommentLoadMoreObserver();
  await loadCurrentResource();
  void nextTick(() => {
    scrollChipRowToActive(classifyChipRowRef.value);
    scrollChipRowToActive(hotwordChipRowRef.value);
  });
});

onBeforeUnmount(() => {
  commentLoadMoreObserver?.disconnect();
  commentLoadMoreObserver = null;
});

watch(selectedClassify, () => {
  void nextTick(() => scrollChipRowToActive(classifyChipRowRef.value));
});

watch(selectedHotword, () => {
  void nextTick(() => scrollChipRowToActive(hotwordChipRowRef.value));
});

watch(total, (value) => {
  if (value > commentCount.value) {
    commentCount.value = value;
  }
});
</script>

<template>
  <PageScrollContainer class="comment-page-container" :back-to-top-threshold="360">
    <div class="comment-page bg-bg-main min-h-full">
      <SliverHeader
        :typeLabel="headerTypeLabel"
        :title="headerTitle"
        :coverUrl="resourceCover"
        :hasDetails="true"
        :expandedHeight="196"
        :collapsedHeight="56"
      >
        <template #details>
          <div class="song-detail-header">
            <Button
              variant="unstyled"
              size="none"
              v-if="songArtist"
              type="button"
              class="song-detail-artist"
              :class="{ 'is-link': canOpenArtist }"
              :disabled="!canOpenArtist"
              @click="openArtistDetail"
            >
              {{ songArtist }}
            </Button>
            <div v-if="isMusicType" class="song-detail-meta-line">
              <Button
                variant="unstyled"
                size="none"
                type="button"
                class="song-detail-meta-link"
                :class="{ 'is-link': canOpenAlbum }"
                :disabled="!canOpenAlbum"
                @click="openAlbumDetail"
              >
                {{ songAlbum || '单曲' }}
              </Button>
              <span>{{ songLanguage }}</span>
              <span>{{ formatCount(favoriteCount) }} 收藏</span>
              <span>{{ formatCount(commentCount) }} 评论</span>
            </div>
          </div>
        </template>

        <template v-if="isMusicType" #actions>
          <ActionRow
            batchLabel="添加到"
            :playDisabled="!canUseSongActions || detailLoading"
            :batchDisabled="!canUseSongActions || detailLoading"
            :secondaryActions="songSecondaryActions"
            @play="handlePlaySong"
            @batch="handleOpenAddToPlaylist"
          />
        </template>

        <template v-if="isMusicType" #collapsed-actions>
          <Button
            type="button"
            class="p-2 rounded-lg hover:bg-[var(--control-hover-bg)] text-primary"
            variant="unstyled"
            size="none"
            title="播放"
            aria-label="播放"
            :disabled="!canUseSongActions || detailLoading"
            @click="handlePlaySong"
          >
            <Icon :icon="iconPlay" width="18" height="18" />
          </Button>
          <Button
            type="button"
            class="p-2 rounded-lg hover:bg-[var(--control-hover-bg)] text-text-main opacity-60"
            variant="unstyled"
            size="none"
            title="添加到"
            aria-label="添加到"
            :disabled="!canUseSongActions || detailLoading"
            @click="handleOpenAddToPlaylist"
          >
            <Icon :icon="iconList" width="17" height="17" />
          </Button>
          <Button
            type="button"
            class="p-2 rounded-lg hover:bg-[var(--control-hover-bg)] text-text-main opacity-60"
            variant="unstyled"
            size="none"
            title="分享"
            aria-label="分享"
            @click="handleShareSong"
          >
            <Icon :icon="iconShare" width="17" height="17" />
          </Button>
        </template>
      </SliverHeader>

      <div class="comment-content-wrap comment-content-wrap--music">
        <template v-if="isMusicType">
          <Tabs
            :model-value="mainTab"
            @update:model-value="mainTab = $event as 'detail' | 'comment'"
          >
            <div class="comment-main-tabs sticky z-120 bg-bg-main" :style="{ top: '56px' }">
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
                    :tabs="['全部评论', '分类评论', '热词评论']"
                  />
                </div>

                <template v-if="activeCommentTab === 'all'">
                  <div class="comment-list-wrap">
                    <div v-if="singerComments.length" class="comment-section-title">歌手说</div>
                    <CommentList
                      v-if="singerComments.length"
                      :comments="singerComments"
                      :loading="false"
                      :resourceType="type"
                      :fallbackMixSongId="songMixSongId || id"
                      compact
                      hide-empty
                    />
                    <div v-if="singerComments.length" class="comment-singer-divider"></div>
                    <CommentList
                      :comments="comments"
                      :loading="isLoadingComments"
                      :resourceType="type"
                      :fallbackMixSongId="songMixSongId || id"
                      compact
                    />
                    <div v-if="hasMore" ref="commentSentinelRef" class="h-1" />
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
                      :resourceType="type"
                      :fallbackMixSongId="songMixSongId || id"
                      compact
                      empty-text="该分类下暂无评论"
                    />
                    <div v-if="hasMoreClassify" ref="commentSentinelRef" class="h-1" />
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
                      :resourceType="type"
                      :fallbackMixSongId="songMixSongId || id"
                      compact
                      empty-text="该热词下暂无评论"
                    />
                    <div v-if="hasMoreHotword" ref="commentSentinelRef" class="h-1" />
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
            :resourceType="type"
            :fallbackMixSongId="songMixSongId || id"
            compact
            hide-empty
          />
          <CommentList
            :comments="comments"
            :loading="isLoadingComments"
            :resourceType="type"
            :fallbackMixSongId="songMixSongId || id"
            compact
          />
          <div v-if="hasMore" ref="commentSentinelRef" class="h-1" />
          <div v-if="isLoadingComments || showCommentsEnd" class="comment-load-more">
            <div v-if="isLoadingComments" class="comment-loading-inline">
              <div class="comment-loading-spinner"></div>
              <span>加载中...</span>
            </div>
            <div v-else class="comment-end-hint">已加载全部评论</div>
          </div>
        </template>
      </div>
    </div>
  </PageScrollContainer>

  <AddToPlaylistDialog
    v-model:open="showPlaylistDialog"
    :playbackQueues="addToPlaybackQueues"
    :playlists="selectablePlaylists"
    :loading="isPlaylistLoading"
    @selectQueue="handleAddToQueue"
    @selectPlaylist="handleSelectPlaylist"
  />
</template>

<style scoped>
@reference "@/style.css";

.comment-page {
  padding: 0 0 40px;
}

.comment-content-wrap {
  width: 100%;
  max-width: none;
  margin: 0;
  padding: 8px 24px 40px;
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
  @apply h-auto! gap-7 bg-transparent p-0 border-0;
}

.comment-main-tab-trigger {
  @apply h-auto! pb-2! text-[15px] font-semibold text-text-main/55 data-[state=active]:text-text-main;
}

.song-detail-header {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.song-detail-artist {
  align-self: flex-start;
  max-width: 100%;
  padding: 0;
  background: transparent;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.song-detail-artist.is-link,
.song-detail-meta-link.is-link {
  cursor: pointer;
}

.song-detail-meta-line {
  display: flex;
  flex-wrap: wrap;
  gap: 0 8px;
  align-items: baseline;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.7;
  color: var(--color-text-secondary);
}

.song-detail-meta-line > *:not(:last-child)::after {
  content: '•';
  margin-left: 8px;
  color: color-mix(in srgb, var(--color-text-secondary) 65%, transparent);
}

.song-detail-meta-link {
  max-width: min(360px, 100%);
  padding: 0;
  background: transparent;
  color: var(--color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.song-detail-meta-link:disabled {
  color: var(--color-text-secondary);
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
  -webkit-overflow-scrolling: touch;
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

.comment-singer-divider {
  margin: 16px 12px;
  height: 1px;
  background: var(--border-subtle);
}

.comment-load-more {
  display: flex;
  justify-content: center;
  margin: 18px 0 30px;
}

.comment-load-more button {
  padding: 8px 24px;
  border-radius: 999px;
  border: 1px solid var(--control-border);
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-main);
  background: var(--color-bg-elevated);
  box-shadow: var(--shadow-control);
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
</style>
