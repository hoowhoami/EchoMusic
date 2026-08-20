<script setup lang="ts">
defineOptions({ name: 'listen-together' });

import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useRoute, useRouter } from 'vue-router';
import Avatar from '@/components/ui/Avatar.vue';
import Button from '@/components/ui/Button.vue';
import Cover from '@/components/ui/Cover.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Input from '@/components/ui/Input.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { ListenTogetherApiError } from '@/api/listenTogether';
import { search } from '@/api/search';
import type {
  ListenTogetherMember,
  ListenTogetherRoom,
  ListenTogetherRoomPrivacy,
  ListenTogetherRoomType,
  ListenTogetherSongOrder,
} from '@/models/listenTogether';
import type { Song } from '@/models/song';
import { useListenTogetherStore } from '@/stores/listenTogether';
import { useHistoryStore } from '@/stores/historyStore';
import { usePlayerStore } from '@/stores/player';
import { usePlaylistStore } from '@/stores/playlist';
import { useToastStore } from '@/stores/toast';
import { useUserStore } from '@/stores/user';
import { toListenTogetherAudioRefs } from '@/utils/listenTogether';
import logger from '@/utils/logger';
import { mapSearchSong } from '@/utils/mappers';
import { copyShareTarget, createShareTarget } from '@/utils/share';
import { extractSearchLists } from '@/views/search/searchHelpers';
import {
  iconBroadcast,
  iconDoorExit,
  iconHeadphones,
  iconMusic,
  iconPlayerPlay,
  iconPlus,
  iconRefreshCw,
  iconSearch,
  iconSend,
  iconShare,
  iconUsers,
} from '@/icons';
import './listenTogether.css';

const route = useRoute();
const router = useRouter();
const listenStore = useListenTogetherStore();
const historyStore = useHistoryStore();
const playerStore = usePlayerStore();
const playlistStore = usePlaylistStore();
const userStore = useUserStore();
const toastStore = useToastStore();

const {
  rooms,
  roomsEnded,
  loadingRooms,
  ownedRooms,
  loadingOwnedRooms,
  previewRoom,
  previewMembers,
  loadingPreview,
  phase,
  activeRoom,
  members,
  messages,
  roomSongs,
  songOrders,
  loadingSongOrders,
  handlingSongOrderId,
  currentRoomSong,
  joined,
  isOwner,
  lastError,
  loadingRoom,
  sendingMessage,
  updatingChat,
  requestingSongHash,
} = storeToRefs(listenStore);

const roomSearch = ref('');
const selectedRoomType = ref<ListenTogetherRoomType>(0);
const roomScope = ref<'discover' | 'mine'>('discover');
const selectedTagKey = ref('');
const previewOpen = ref(false);
const createOpen = ref(false);
const leaveOpen = ref(false);
const sessionMinimized = ref(false);
const orderSongPickerOpen = ref(false);
const songOrdersOpen = ref(false);
const dismissOwnedOpen = ref(false);
const ownedRoomToDismiss = ref<ListenTogetherRoom | null>(null);
const dismissingOwnedRoom = ref(false);
const messageText = ref('');
const messagesScroll = ref<InstanceType<typeof Scrollbar> | null>(null);

const createName = ref('');
const createRoomType = ref<ListenTogetherRoomType>(0);
const createPrivacy = ref<ListenTogetherRoomPrivacy>(1);
type OrderSongSource = 'recent' | 'mine' | 'search';
const orderSongSources: { id: OrderSongSource; name: string }[] = [
  { id: 'recent', name: '最近播放' },
  { id: 'mine', name: '我喜欢' },
  { id: 'search', name: '搜索' },
];
const orderSongSource = ref<OrderSongSource>('recent');
const orderSongSearchKeyword = ref('');
const orderSongSearchResults = ref<Song[]>([]);
const searchingOrderSongs = ref(false);

const mergeVisibleMembers = (
  room: ListenTogetherRoom | null,
  remoteMembers: ListenTogetherMember[],
  includeCurrentUser: boolean,
) => {
  const result: ListenTogetherMember[] = [];
  const add = (member: ListenTogetherMember) => {
    const sameUserIndex = result.findIndex(
      (item) => !item.anonymous && !member.anonymous && item.userId === member.userId,
    );
    const sameAvatarIndex = member.avatarUrl
      ? result.findIndex((item) => item.avatarUrl && item.avatarUrl === member.avatarUrl)
      : -1;
    const existingIndex = sameUserIndex >= 0 ? sameUserIndex : sameAvatarIndex;
    if (existingIndex < 0) {
      result.push(member);
      return;
    }
    // 真实成员资料优先于 cover_urls 产生的匿名头像预览。
    if (result[existingIndex].anonymous && !member.anonymous) result[existingIndex] = member;
  };

  if (room && (room.ownerId || room.ownerAvatarUrl)) {
    add({
      userId: room.ownerId || `owner:${room.id}`,
      nickname: room.ownerName || '房主',
      avatarUrl: room.ownerAvatarUrl,
      studyTime: 0,
    });
  }
  remoteMembers.forEach(add);

  if (includeCurrentUser) {
    const currentUserId = String(userStore.info?.userid ?? userStore.info?.userId ?? '').trim();
    if (currentUserId) {
      add({
        userId: currentUserId,
        nickname: userStore.info?.nickname || '我',
        avatarUrl: userStore.info?.pic || '',
        studyTime: 0,
      });
    }
  }

  (room?.memberPreviews ?? []).forEach((member) => add({ ...member, studyTime: 0 }));
  return result;
};

const activeMembers = computed<ListenTogetherMember[]>(() => {
  return mergeVisibleMembers(activeRoom.value, members.value, joined.value);
});
const onlineMemberCount = computed(() =>
  joined.value
    ? Math.max(1, activeMembers.value.length, Number(activeRoom.value?.memberCount || 0))
    : 0,
);
const unlistedOnlineMemberCount = computed(() =>
  Math.max(0, onlineMemberCount.value - activeMembers.value.length),
);
const visiblePreviewMembers = computed(() =>
  mergeVisibleMembers(previewRoom.value, previewMembers.value, false),
);

const isCurrentSessionRoom = (room: ListenTogetherRoom | null | undefined) =>
  Boolean(
    room &&
    joined.value &&
    activeRoom.value?.id === room.id &&
    activeRoom.value.roomType === room.roomType,
  );
const roomDisplayMemberCount = (room: ListenTogetherRoom) =>
  isCurrentSessionRoom(room) ? onlineMemberCount.value : room.memberCount;
const roomDisplaySongName = (room: ListenTogetherRoom) =>
  (isCurrentSessionRoom(room) ? currentRoomSong.value?.title : '') ||
  room.currentSongName ||
  room.channelName ||
  '等待房间音乐';
const roomDisplayArtistName = (room: ListenTogetherRoom) =>
  (isCurrentSessionRoom(room) ? currentRoomSong.value?.artist : '') || room.currentArtistName;

const sourceRooms = computed(() => (roomScope.value === 'mine' ? ownedRooms.value : rooms.value));
const loadingRoomList = computed(() =>
  roomScope.value === 'mine' ? loadingOwnedRooms.value : loadingRooms.value,
);
const filteredRooms = computed(() => {
  const query = roomSearch.value.trim().toLowerCase();
  return sourceRooms.value
    .filter((room) => room.roomType === selectedRoomType.value)
    .filter((room) => {
      if (!selectedTagKey.value) return true;
      return [...room.tags, ...room.musicStyles].some(
        (tag) => `${tag.id}:${tag.name}` === selectedTagKey.value,
      );
    })
    .filter(
      (room) =>
        !query ||
        [
          room.name,
          room.ownerName,
          room.channelName,
          room.currentSongName,
          room.currentArtistName,
          ...room.tags.map((tag) => tag.name),
          ...room.musicStyles.map((tag) => tag.name),
        ].some((value) => value.toLowerCase().includes(query)),
    );
});
const typedRooms = computed(() =>
  sourceRooms.value.filter((room) => room.roomType === selectedRoomType.value),
);
const roomTags = computed(() => {
  const tagMap = new Map<string, { key: string; name: string; count: number }>();
  typedRooms.value.forEach((room) => {
    [...room.tags, ...room.musicStyles].forEach((tag) => {
      const key = `${tag.id}:${tag.name}`;
      const current = tagMap.get(key);
      tagMap.set(key, { key, name: tag.name, count: (current?.count ?? 0) + 1 });
    });
  });
  return Array.from(tagMap.values()).sort(
    (left, right) => right.count - left.count || left.name.localeCompare(right.name, 'zh-CN'),
  );
});
const selectedRoomTypeName = computed(() => '众乐房');
const createRoomTypeName = computed(() => '众乐房');
const createDescription = computed(() => '设置房间名称与权限，创建时会沿用当前播放器队列。');

const activePlaylistSongs = computed<Song[]>(() => {
  const list = (playerStore.currentPlaylist ?? []) as Song[];
  if (list.length) return list;
  return playerStore.currentTrackSnapshot ? [playerStore.currentTrackSnapshot] : [];
});
const musicRoomQueueSongs = computed(() => {
  const songs = activePlaylistSongs.value.filter(
    (song) =>
      Boolean(String(song.hash ?? '').trim()) &&
      Number(song.mixSongId ?? song.albumAudioId ?? 0) > 0,
  );
  if (songs.length <= 50) return songs;

  const currentHash = String(playerStore.currentTrackSnapshot?.hash ?? '').toLowerCase();
  const currentIndex = songs.findIndex((song) => song.hash.toLowerCase() === currentHash);
  if (currentIndex < 5) return songs.slice(0, 10);
  if (currentIndex + 5 > songs.length) return songs.slice(-10);
  return songs.slice(currentIndex - 5, currentIndex + 5);
});
const createAudios = computed(() => toListenTogetherAudioRefs(musicRoomQueueSongs.value, 50));
const musicRoomProgressInfo = computed(() => {
  const current = playerStore.currentTrackSnapshot;
  if (!current?.hash) return undefined;
  const mixSongId = current.mixSongId ?? current.albumAudioId ?? '';
  if (!mixSongId) return undefined;
  return {
    hash: current.hash,
    album_audio_id: mixSongId,
    progress: Math.max(0, Math.floor(playerStore.currentTime || 0)),
    pause: (playerStore.isPlaying ? 1 : 2) as 1 | 2,
    play_mode: (playerStore.playMode === 'single'
      ? '2'
      : playerStore.playMode === 'random'
        ? '3'
        : '1') as '1' | '2' | '3',
  };
});
const mineSongs = computed(() =>
  (playlistStore.favorites as Song[]).filter((song) => Boolean(String(song.hash ?? '').trim())),
);
const canCreate = computed(
  () =>
    Boolean(createName.value.trim()) && createAudios.value.length > 0 && phase.value !== 'creating',
);
const roomCountLabel = computed(() => {
  const loaded = typedRooms.value.length;
  return roomScope.value === 'mine'
    ? `我的${selectedRoomTypeName.value} ${loaded.toLocaleString('zh-CN')} 间`
    : `已加载 ${loaded.toLocaleString('zh-CN')} 个${selectedRoomTypeName.value}`;
});

const roomTypeName = (room: ListenTogetherRoom | null | undefined) => {
  return room ? '众乐房' : '房间';
};

const promptLogin = (action: string) => {
  toastStore.showAction(`请先登录后再${action}`, {
    label: '去登录',
    handler: () => void router.push('/login'),
  });
};

const showStoreError = (fallback: string) => {
  toastStore.warning(lastError.value || fallback);
};

const loadRooms = async (reset = false, roomType = selectedRoomType.value) => {
  try {
    if (roomScope.value === 'mine') {
      if (!userStore.isLoggedIn) {
        promptLogin('查看我的房间');
        return;
      }
      await listenStore.loadOwnedRooms(roomType);
    } else {
      await listenStore.loadRooms({ reset, tagId: '', roomType });
    }
  } catch {
    showStoreError('房间列表加载失败');
  }
};

const selectRoomScope = (scope: 'discover' | 'mine') => {
  if (roomScope.value === scope) return;
  if (scope === 'mine' && !userStore.isLoggedIn) {
    promptLogin('查看我的房间');
    return;
  }
  roomScope.value = scope;
  selectedTagKey.value = '';
  roomSearch.value = '';
  void loadRooms(true);
};

const selectTag = (tagKey: string) => {
  selectedTagKey.value = selectedTagKey.value === tagKey ? '' : tagKey;
};

const openRoomPreview = async (room: ListenTogetherRoom) => {
  previewOpen.value = true;
  try {
    await listenStore.inspectRoom(room);
  } catch {
    previewOpen.value = false;
    showStoreError('房间详情加载失败');
  }
};

const shareRoom = async (room: ListenTogetherRoom | null | undefined) => {
  if (!room) return;
  const target = createShareTarget('listen-together', room.id, room.name, {
    roomType: room.roomType,
    roomName: room.name,
  });
  if (!target) {
    toastStore.warning('这个房间暂时无法分享');
    return;
  }
  try {
    const copied = await copyShareTarget(target);
    if (copied) toastStore.success('房间链接已复制，可直接邀请好友进入');
    else toastStore.warning('房间链接复制失败');
  } catch {
    toastStore.warning('房间链接复制失败');
  }
};

const joinPreviewRoom = async () => {
  const room = previewRoom.value;
  if (!room) return;
  if (!userStore.isLoggedIn) {
    promptLogin('加入房间');
    return;
  }
  if (joined.value && activeRoom.value?.id === room.id) {
    sessionMinimized.value = false;
    previewOpen.value = false;
    return;
  }
  if (joined.value && isOwner.value) {
    toastStore.warning('请先结束当前房间，再加入其他房间');
    return;
  }
  try {
    await listenStore.joinRoom(room);
    sessionMinimized.value = false;
    previewOpen.value = false;
  } catch {
    if (!previewRoom.value) previewOpen.value = false;
    showStoreError('加入房间失败');
  }
};

const openCreateRoom = () => {
  if (!userStore.isLoggedIn) {
    promptLogin('创建房间');
    return;
  }
  if (joined.value && isOwner.value) {
    toastStore.warning('请先结束当前房间，再创建新房间');
    return;
  }
  createRoomType.value = selectedRoomType.value;
  createPrivacy.value = 1;
  createName.value = `${userStore.info?.nickname || '我'}的${selectedRoomTypeName.value}`;
  createOpen.value = true;
};

const songHashKey = (song: Song) => song.hash.trim().toLowerCase();

const dedupeSongs = (songs: Song[]) =>
  Array.from(
    new Map(
      songs
        .filter((song) => Boolean(songHashKey(song)))
        .map((song) => [songHashKey(song), song] as const),
    ).values(),
  );

const recentOrderSongs = computed(() =>
  dedupeSongs(historyStore.entries.map((entry) => entry.song))
    .filter((song) => Number(song.mixSongId ?? song.albumAudioId ?? 0) > 0)
    .slice(0, 100),
);
const orderSongCandidates = computed(() => {
  if (orderSongSource.value === 'mine') {
    return mineSongs.value.filter((song) => Number(song.mixSongId ?? song.albumAudioId ?? 0) > 0);
  }
  if (orderSongSource.value === 'search') {
    return orderSongSearchResults.value.filter(
      (song) => Number(song.mixSongId ?? song.albumAudioId ?? 0) > 0,
    );
  }
  return recentOrderSongs.value;
});
const orderSongEmptyCopy = computed(() => {
  if (orderSongSource.value === 'recent') return '还没有最近播放的歌曲';
  if (orderSongSource.value === 'mine') return '你还没有收藏歌曲';
  return orderSongSearchKeyword.value.trim() ? '没有找到匹配歌曲' : '输入歌名或歌手搜索';
});

const submitCreateRoom = async () => {
  if (!canCreate.value) return;
  try {
    await listenStore.createRoom(
      {
        roomType: 0,
        name: createName.value,
        notice: '',
        audios: createAudios.value,
        privacy: createPrivacy.value,
        capacity: 5,
        progressInfo: musicRoomProgressInfo.value,
      },
      musicRoomQueueSongs.value,
    );
    createOpen.value = false;
  } catch (error) {
    if (error instanceof ListenTogetherApiError && error.code === 55004) {
      createOpen.value = false;
      selectedRoomType.value = createRoomType.value;
      roomScope.value = 'mine';
      selectedTagKey.value = '';
      roomSearch.value = '';
      await loadRooms(true, createRoomType.value);
      toastStore.warning('已达到房间创建上限，请先在“我的房间”中管理已有房间');
      return;
    }
    showStoreError('创建房间失败');
  }
};

const openOwnedRoomDismiss = (room: ListenTogetherRoom) => {
  ownedRoomToDismiss.value = room;
  dismissOwnedOpen.value = true;
};

const confirmDismissOwnedRoom = async () => {
  const room = ownedRoomToDismiss.value;
  if (!room || dismissingOwnedRoom.value) return;
  dismissingOwnedRoom.value = true;
  try {
    await listenStore.dismissOwnedRoom(room);
    dismissOwnedOpen.value = false;
    previewOpen.value = false;
    ownedRoomToDismiss.value = null;
  } catch {
    showStoreError('解散房间失败');
  } finally {
    dismissingOwnedRoom.value = false;
  }
};

const confirmLeave = async (dismiss = false) => {
  if (isOwner.value && !dismiss) {
    sessionMinimized.value = true;
    leaveOpen.value = false;
    selectedRoomType.value = activeRoom.value?.roomType ?? selectedRoomType.value;
    roomScope.value = 'mine';
    void loadRooms(true, selectedRoomType.value);
    toastStore.info('房间已转入后台，仍在保持同步');
    return;
  }
  try {
    await listenStore.leaveRoom({ dismiss });
    sessionMinimized.value = false;
    leaveOpen.value = false;
  } catch {
    showStoreError(dismiss ? '解散房间失败' : '离开房间失败');
  }
};

const sendMessage = async () => {
  const text = messageText.value.trim();
  if (!text) return;
  try {
    await listenStore.sendMessage(text);
    messageText.value = '';
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '消息发送失败');
  }
};

const toggleChat = async () => {
  if (!activeRoom.value || !isOwner.value || updatingChat.value) return;
  try {
    await listenStore.setChatEnabled(!activeRoom.value.allowChat);
  } catch (error) {
    toastStore.danger(error instanceof Error ? error.message : '聊天设置更新失败');
  }
};

const handleMessageKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  void sendMessage();
};

const openOrderSongPicker = () => {
  orderSongSource.value = 'recent';
  orderSongSearchKeyword.value = '';
  orderSongSearchResults.value = [];
  orderSongPickerOpen.value = true;
  void historyStore.hydrate();
  if (!playlistStore.favoritesLoaded && !playlistStore.favoritesLoading) {
    void playlistStore.fetchLikedPlaylistSongs();
  }
};

const selectOrderSongSource = (source: OrderSongSource) => {
  orderSongSource.value = source;
};

const searchOrderSongs = async () => {
  const keyword = orderSongSearchKeyword.value.trim();
  if (!keyword || searchingOrderSongs.value) return;
  searchingOrderSongs.value = true;
  try {
    const payload = await search(keyword, 'song', 1, 50);
    orderSongSearchResults.value = dedupeSongs(extractSearchLists(payload).map(mapSearchSong));
  } catch {
    toastStore.warning('歌曲搜索失败，请稍后重试');
  } finally {
    searchingOrderSongs.value = false;
  }
};

const requestSong = async (song: Song) => {
  try {
    if (isOwner.value) await listenStore.addRoomSong(song);
    else await listenStore.requestSong(song);
    orderSongPickerOpen.value = false;
  } catch (error) {
    toastStore.warning(
      error instanceof Error ? error.message : isOwner.value ? '添加歌曲失败' : '点歌失败',
    );
  }
};

const openSongOrders = async () => {
  songOrdersOpen.value = true;
  try {
    await listenStore.loadSongOrders();
  } catch {
    toastStore.warning('点播列表加载失败');
  }
};

const approveSongOrder = async (order: ListenTogetherSongOrder) => {
  try {
    await listenStore.approveSongOrder(order);
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '允许加歌失败');
  }
};

const removeSongOrder = async (order: ListenTogetherSongOrder) => {
  try {
    await listenStore.removeSongOrder(order);
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '忽略点歌失败');
  }
};

const refreshRoomSongs = async () => {
  try {
    await listenStore.refreshRoomSongs();
  } catch {
    toastStore.warning('房间歌单刷新失败');
  }
};

const playRoomSong = async (song: Song) => {
  if (!isOwner.value || activeRoom.value?.roomType !== 0) return;
  try {
    await listenStore.playRoomSong(song);
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '切换歌曲失败');
  }
};

const formatMessageTime = (timestamp: number) => {
  if (!timestamp) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
};

watch(previewOpen, (open) => {
  if (!open) listenStore.closePreview();
});

watch(joined, (isJoined) => {
  if (!isJoined) sessionMinimized.value = false;
});

watch(
  () => messages.value.length,
  async () => {
    await nextTick();
    messagesScroll.value?.scrollTo({ top: 999_999, behavior: 'smooth' });
  },
);

watch(
  () => `${String(route.query.roomId ?? '')}:${String(route.query.roomType ?? '')}`,
  () => {
    const roomId = String(route.query.roomId ?? '').trim();
    if (!roomId || route.name !== 'listen-together') return;
    if (String(route.query.roomType ?? '0') !== '0') {
      toastStore.warning('自习室已下线，一起听目前仅支持众乐房');
      void router.replace({ name: 'listen-together' });
      return;
    }
    const roomType: ListenTogetherRoomType = 0;
    const roomName = String(route.query.roomName ?? '').trim() || '一起听房间';
    selectedRoomType.value = roomType;
    roomScope.value = 'discover';
    selectedTagKey.value = '';
    roomSearch.value = '';
    previewOpen.value = true;
    void loadRooms(true, roomType);
    void listenStore.inspectRoomById(roomId, roomType, roomName).catch(() => {
      previewOpen.value = false;
      showStoreError('分享的房间暂时无法打开');
    });
  },
  { immediate: true },
);

onMounted(() => {
  void (async () => {
    // 分享链接由上面的路由 watcher 打开预览；普通入口则优先恢复服务端仍有效的
    // 众乐房会话，避免应用重启后对同一个房间重复执行 join。
    if (String(route.query.roomId ?? '').trim()) return;
    if (userStore.isLoggedIn) {
      try {
        const restoredRoomId = await listenStore.recoverCurrentMusicRoomSession();
        if (restoredRoomId) return;
      } catch (error) {
        logger.warn('ListenTogether', 'Failed to restore current room on mount', error);
      }
    }
    await loadRooms(true);
  })();
});
</script>

<template>
  <section class="listen-together-view">
    <template v-if="!joined || sessionMinimized">
      <Scrollbar class="listen-discovery-scroll">
        <div class="listen-discovery">
          <header class="listen-hero">
            <div class="listen-hero-content">
              <span class="listen-eyebrow">
                <Icon :icon="iconBroadcast" width="14" height="14" />
                LISTEN TOGETHER
              </span>
              <h1>此刻，一起听</h1>
              <p>进入正在播放的房间，和喜欢同一种声音的人共享音乐。</p>
              <div class="listen-hero-actions">
                <Button size="sm" @click="openCreateRoom">
                  <Icon :icon="iconPlus" width="16" height="16" />
                  创建众乐房
                </Button>
                <span class="listen-room-count">
                  <span class="listen-live-dot"></span>
                  {{ roomCountLabel }}
                </span>
              </div>
            </div>
            <div class="listen-hero-mark" aria-hidden="true">
              <Icon :icon="iconHeadphones" width="84" height="84" />
            </div>
            <span class="listen-hero-glow listen-hero-glow-one"></span>
            <span class="listen-hero-glow listen-hero-glow-two"></span>
          </header>

          <section v-if="joined" class="listen-active-session-banner">
            <div>
              <span><span class="listen-live-dot"></span> 房间正在后台同步</span>
              <strong>{{ activeRoom?.name || '一起听房间' }}</strong>
            </div>
            <Button size="sm" @click="sessionMinimized = false">
              <Icon :icon="iconHeadphones" width="15" height="15" />
              返回房间
            </Button>
          </section>

          <section class="listen-browser-panel">
            <div class="listen-browser-topbar">
              <div class="listen-scope-tabs" aria-label="房间范围">
                <button
                  type="button"
                  :class="{ 'is-active': roomScope === 'discover' }"
                  @click="selectRoomScope('discover')"
                >
                  发现房间
                </button>
                <button
                  type="button"
                  :class="{ 'is-active': roomScope === 'mine' }"
                  @click="selectRoomScope('mine')"
                >
                  我的房间
                </button>
              </div>
            </div>

            <div class="listen-toolbar">
              <div class="listen-search-shell">
                <Icon :icon="iconSearch" width="17" height="17" />
                <input
                  v-model="roomSearch"
                  :placeholder="`筛选已加载的${selectedRoomTypeName}、房主或歌曲`"
                />
              </div>
              <Button
                class="listen-refresh-button"
                variant="ghost"
                size="sm"
                :disabled="loadingRoomList"
                title="刷新房间"
                aria-label="刷新房间"
                @click="loadRooms(true)"
              >
                <Icon
                  :icon="iconRefreshCw"
                  width="16"
                  height="16"
                  :class="{ 'is-spinning': loadingRoomList }"
                />
              </Button>
            </div>

            <div v-if="roomScope === 'discover' && roomTags.length" class="listen-filter-strip">
              <div v-if="roomTags.length" class="listen-tag-row" aria-label="房间内容标签">
                <button
                  type="button"
                  class="listen-tag-button"
                  :class="{ 'is-active': !selectedTagKey }"
                  @click="selectedTagKey = ''"
                >
                  全部标签
                </button>
                <button
                  v-for="tag in roomTags"
                  :key="tag.key"
                  type="button"
                  class="listen-tag-button"
                  :class="{ 'is-active': selectedTagKey === tag.key }"
                  @click="selectTag(tag.key)"
                >
                  {{ tag.name }}
                  <small>{{ tag.count }}</small>
                </button>
              </div>
            </div>
          </section>

          <div class="listen-list-heading">
            <div>
              <h2>
                {{ roomScope === 'mine' ? `我的${selectedRoomTypeName}` : selectedRoomTypeName }}
              </h2>
              <p>
                {{ filteredRooms.length }} 个结果
                <template v-if="roomSearch || selectedTagKey"> · 已应用筛选 </template>
              </p>
            </div>
          </div>

          <div v-if="loadingRoomList && typedRooms.length === 0" class="listen-room-grid">
            <div v-for="index in 6" :key="index" class="listen-room-card is-skeleton">
              <Skeleton height="48" radius="14" />
              <Skeleton width="70%" height="18" radius="99" />
              <Skeleton width="46%" height="13" radius="99" />
            </div>
          </div>

          <div v-else-if="filteredRooms.length" class="listen-room-grid">
            <button
              v-for="room in filteredRooms"
              :key="room.id"
              type="button"
              class="listen-room-card"
              @click="openRoomPreview(room)"
            >
              <div class="listen-room-visual">
                <span class="listen-room-live"><span></span> LIVE</span>
                <span class="listen-room-type-badge">
                  {{ roomScope === 'mine' ? '我的房间' : roomTypeName(room) }}
                </span>
                <div class="listen-room-wave" aria-hidden="true">
                  <i></i><i></i><i></i><i></i><i></i>
                </div>
                <div class="listen-room-avatar-stack">
                  <Avatar
                    v-for="member in room.memberPreviews.slice(0, 3)"
                    :key="member.userId"
                    :src="member.avatarUrl"
                    :alt="member.nickname"
                    class="listen-room-mini-avatar"
                    :show-skeleton="false"
                  />
                  <Avatar
                    v-if="!room.memberPreviews.length"
                    :src="room.ownerAvatarUrl"
                    :alt="room.ownerName"
                    class="listen-room-mini-avatar"
                    :show-skeleton="false"
                  />
                </div>
              </div>
              <div class="listen-room-card-body">
                <div class="listen-room-card-heading">
                  <h2>{{ room.name }}</h2>
                  <span>
                    <Icon :icon="iconUsers" width="13" height="13" />
                    {{ roomDisplayMemberCount(room) }}
                  </span>
                </div>
                <p class="listen-room-owner">{{ room.ownerName || '房主' }} 的房间</p>
                <p class="listen-room-song">
                  <Icon :icon="iconMusic" width="14" height="14" />
                  <span>
                    {{ roomDisplaySongName(room) }}
                    <small v-if="roomDisplayArtistName(room)">
                      · {{ roomDisplayArtistName(room) }}</small
                    >
                  </span>
                </p>
                <div class="listen-room-tags">
                  <span
                    v-for="tag in [...room.tags, ...room.musicStyles].slice(0, 3)"
                    :key="tag.id + tag.name"
                  >
                    {{ tag.name }}
                  </span>
                </div>
              </div>
            </button>
          </div>

          <div v-else class="listen-empty-state">
            <Icon :icon="iconHeadphones" width="48" height="48" />
            <h2>
              {{
                roomScope === 'mine'
                  ? `还没有可管理的${selectedRoomTypeName}`
                  : '没有找到匹配的房间'
              }}
            </h2>
            <p>
              {{
                roomScope === 'mine'
                  ? '近期创建且仍有效的众乐房会显示在这里。'
                  : '试试清除房间来源、内容标签或搜索条件。'
              }}
            </p>
          </div>

          <div
            v-if="roomScope === 'discover' && rooms.length && !roomsEnded && !roomSearch"
            class="listen-load-more"
          >
            <Button variant="secondary" size="sm" :loading="loadingRooms" @click="loadRooms(false)">
              加载更多房间
            </Button>
          </div>
        </div>
      </Scrollbar>
    </template>

    <template v-else>
      <div class="listen-session">
        <header class="listen-session-header">
          <div class="listen-session-title">
            <span class="listen-session-live"><span></span> 同步中</span>
            <div>
              <h1>{{ activeRoom?.name || '一起听房间' }}</h1>
              <p>{{ activeRoom?.ownerName || '房主' }} · {{ onlineMemberCount }} 人在线</p>
            </div>
          </div>
          <div class="listen-session-actions">
            <Button variant="ghost" size="sm" @click="shareRoom(activeRoom)">
              <Icon :icon="iconShare" width="16" height="16" />
              分享房间
            </Button>
            <Button variant="outline" size="sm" @click="leaveOpen = true">
              <Icon :icon="iconDoorExit" width="16" height="16" />
              {{ isOwner ? '房间管理' : '离开房间' }}
            </Button>
          </div>
        </header>

        <div
          class="listen-session-grid"
          :class="{ 'is-loading': loadingRoom && roomSongs.length === 0 }"
        >
          <div class="listen-session-main">
            <section class="listen-now-playing">
              <div class="listen-now-cover-wrap">
                <Cover
                  :url="currentRoomSong?.coverUrl || playerStore.currentTrackSnapshot?.coverUrl"
                  :alt="currentRoomSong?.title || '当前歌曲'"
                  class="listen-now-cover"
                  width="100%"
                  height="100%"
                  :border-radius="22"
                />
                <span class="listen-now-badge">
                  <Icon :icon="iconBroadcast" width="14" height="14" />
                  房间同步
                </span>
              </div>
              <div class="listen-now-info">
                <span class="listen-eyebrow">
                  <Icon :icon="iconHeadphones" width="14" height="14" /> NOW PLAYING
                </span>
                <h2>
                  {{ currentRoomSong?.title || activeRoom?.currentSongName || '正在同步房间播放' }}
                </h2>
                <p>{{ currentRoomSong?.artist || activeRoom?.currentArtistName || '一起听' }}</p>
                <div class="listen-now-sync-note">
                  <template v-if="isOwner">
                    你可以控制房间播放，操作会同步到其他设备和成员。
                  </template>
                  <template v-else>
                    播放由房主控制；可仅在本机暂停，再次播放会追上房间进度。
                  </template>
                </div>
              </div>
            </section>

            <section class="listen-panel listen-queue-panel">
              <div class="listen-panel-header">
                <div>
                  <span class="listen-panel-kicker">房间歌单</span>
                  <h2>{{ roomSongs.length }} 首歌曲</h2>
                </div>
                <div class="listen-queue-header-actions">
                  <Button v-if="isOwner" variant="ghost" size="xs" @click="openSongOrders">
                    点播列表<span v-if="songOrders.length"> {{ songOrders.length }}</span>
                  </Button>
                  <Button variant="secondary" size="xs" @click="openOrderSongPicker">
                    <Icon :icon="iconPlus" width="14" height="14" />
                    {{ isOwner ? '添加歌曲' : '点歌' }}
                  </Button>
                  <Button
                    class="listen-panel-refresh-button"
                    variant="ghost"
                    size="xs"
                    title="刷新房间歌单"
                    aria-label="刷新房间歌单"
                    @click="refreshRoomSongs"
                  >
                    <Icon :icon="iconRefreshCw" width="15" height="15" />
                  </Button>
                </div>
              </div>
              <Scrollbar class="listen-queue-scroll">
                <div v-if="roomSongs.length" class="listen-queue-list">
                  <div
                    v-for="(song, index) in roomSongs"
                    :key="song.id"
                    class="listen-queue-item"
                    :class="{
                      'is-current': currentRoomSong?.hash === song.hash,
                      'is-readonly': !isOwner,
                      'is-controllable': isOwner,
                    }"
                    :role="isOwner ? 'button' : undefined"
                    :tabindex="isOwner ? 0 : undefined"
                    @click="playRoomSong(song)"
                    @keydown.enter.prevent="playRoomSong(song)"
                  >
                    <span class="listen-queue-index">
                      <Icon
                        v-if="currentRoomSong?.hash === song.hash"
                        :icon="iconPlayerPlay"
                        width="14"
                        height="14"
                      />
                      <template v-else>{{ index + 1 }}</template>
                    </span>
                    <Cover
                      :url="song.coverUrl"
                      :alt="song.title"
                      class="listen-queue-cover"
                      :width="42"
                      :height="42"
                      :border-radius="10"
                    />
                    <span class="listen-queue-meta">
                      <strong>{{ song.title || '歌曲信息同步中' }}</strong>
                      <small>{{ song.artist || '正在获取歌曲信息' }}</small>
                    </span>
                    <span class="listen-request-label">
                      {{
                        currentRoomSong?.hash === song.hash ? '播放中' : isOwner ? '点击播放' : ''
                      }}
                    </span>
                  </div>
                </div>
                <div v-else class="listen-panel-empty">
                  <Icon :icon="iconMusic" width="36" height="36" />
                  <p>正在获取房间歌单…</p>
                </div>
              </Scrollbar>
            </section>
          </div>

          <aside class="listen-session-side">
            <section
              class="listen-panel listen-members-panel"
              :class="{ 'is-empty': !activeMembers.length }"
            >
              <div class="listen-panel-header compact">
                <div>
                  <span class="listen-panel-kicker">在线成员</span>
                  <h2>{{ onlineMemberCount }} 人</h2>
                </div>
              </div>
              <Scrollbar class="listen-members-scroll">
                <div v-if="activeMembers.length" class="listen-member-list">
                  <div
                    v-for="member in activeMembers"
                    :key="member.userId"
                    class="listen-member-item"
                  >
                    <Avatar
                      :src="member.avatarUrl"
                      :alt="member.nickname"
                      class="listen-member-avatar"
                    />
                    <span class="listen-member-copy">
                      <strong>{{ member.nickname }}</strong>
                      <small>在线</small>
                    </span>
                    <i class="status-1"></i>
                  </div>
                  <div v-if="unlistedOnlineMemberCount" class="listen-member-item is-unlisted">
                    <span class="listen-member-avatar listen-member-avatar-placeholder">
                      <Icon :icon="iconUsers" width="15" height="15" />
                    </span>
                    <span class="listen-member-copy">
                      <strong>另有 {{ unlistedOnlineMemberCount }} 位听众</strong>
                      <small>在线身份未公开</small>
                    </span>
                  </div>
                </div>
                <div v-else class="listen-members-empty">
                  <Icon :icon="iconUsers" width="16" height="16" />
                  <span>成员加入后会显示在这里</span>
                </div>
              </Scrollbar>
            </section>

            <section class="listen-panel listen-chat-panel">
              <div class="listen-panel-header compact">
                <div>
                  <span class="listen-panel-kicker">房间聊天</span>
                  <h2>{{ activeRoom?.allowChat ? '和大家打个招呼' : '房主已关闭聊天' }}</h2>
                </div>
                <Button
                  v-if="isOwner"
                  variant="ghost"
                  size="xs"
                  :disabled="updatingChat"
                  @click="toggleChat"
                >
                  {{ activeRoom?.allowChat ? '关闭聊天' : '开启聊天' }}
                </Button>
              </div>
              <Scrollbar ref="messagesScroll" class="listen-chat-scroll">
                <div class="listen-message-list">
                  <div v-if="!messages.length" class="listen-message-empty">暂无房间消息</div>
                  <div
                    v-for="message in messages"
                    :key="message.id"
                    class="listen-message"
                    :class="{
                      'is-system': message.system,
                      'is-self': message.userId === String(userStore.info?.userid || ''),
                    }"
                  >
                    <template v-if="message.system">
                      <span>{{ message.text }}</span>
                    </template>
                    <template v-else>
                      <Avatar
                        :src="message.avatarUrl"
                        :alt="message.nickname"
                        class="listen-message-avatar"
                      />
                      <div>
                        <p>
                          <strong>{{ message.nickname }}</strong
                          ><time>{{ formatMessageTime(message.sentAt) }}</time>
                        </p>
                        <span>{{ message.text }}</span>
                      </div>
                    </template>
                  </div>
                </div>
              </Scrollbar>
              <div class="listen-chat-composer" :class="{ 'is-disabled': !activeRoom?.allowChat }">
                <textarea
                  v-model="messageText"
                  :disabled="!activeRoom?.allowChat || sendingMessage"
                  :placeholder="
                    activeRoom?.allowChat ? '输入消息，Enter 发送' : '当前房间不允许聊天'
                  "
                  maxlength="200"
                  rows="1"
                  @keydown="handleMessageKeydown"
                ></textarea>
                <button
                  type="button"
                  :disabled="!messageText.trim() || !activeRoom?.allowChat || sendingMessage"
                  title="发送消息"
                  @click="sendMessage"
                >
                  <Icon :icon="iconSend" width="17" height="17" />
                </button>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </template>

    <Dialog
      v-model:open="previewOpen"
      :title="previewRoom?.name || '房间详情'"
      show-close
      content-class="listen-room-preview-dialog"
    >
      <div v-if="loadingPreview && !previewRoom" class="listen-preview-loading">
        <Skeleton height="150" radius="16" />
        <Skeleton width="70%" height="20" radius="99" />
      </div>
      <div v-else-if="previewRoom" class="listen-preview">
        <div class="listen-preview-banner">
          <div>
            <span class="listen-room-live"><span></span> LIVE</span>
            <span class="listen-preview-type">{{ roomTypeName(previewRoom) }}</span>
            <Icon :icon="iconHeadphones" width="56" height="56" />
          </div>
          <p>
            <Icon :icon="iconMusic" width="15" height="15" />{{ roomDisplaySongName(previewRoom) }}
          </p>
        </div>
        <div class="listen-preview-owner">
          <Avatar
            :src="previewRoom.ownerAvatarUrl"
            :alt="previewRoom.ownerName"
            class="listen-preview-avatar"
          />
          <span
            ><strong>{{ previewRoom.ownerName }}</strong
            ><small>房主 · {{ roomDisplayMemberCount(previewRoom) }} 人在线</small></span
          >
        </div>
        <p v-if="previewRoom.notice" class="listen-preview-notice">{{ previewRoom.notice }}</p>
        <div class="listen-room-tags">
          <span
            v-for="tag in [...previewRoom.tags, ...previewRoom.musicStyles]"
            :key="tag.id + tag.name"
            >{{ tag.name }}</span
          >
        </div>
        <div v-if="visiblePreviewMembers.length" class="listen-preview-members">
          <Avatar
            v-for="member in visiblePreviewMembers.slice(0, 8)"
            :key="member.userId"
            :src="member.avatarUrl"
            :alt="member.nickname"
            class="listen-preview-member-avatar"
          />
          <span>{{ previewRoom?.memberCount ?? previewMembers.length }} 人正在房间</span>
        </div>
      </div>
      <template #footer>
        <Button variant="secondary" size="sm" @click="previewOpen = false">取消</Button>
        <Button v-if="previewRoom" variant="secondary" size="sm" @click="shareRoom(previewRoom)">
          <Icon :icon="iconShare" width="16" height="16" />
          分享
        </Button>
        <Button
          v-if="roomScope === 'mine' && previewRoom"
          variant="danger"
          size="sm"
          @click="openOwnedRoomDismiss(previewRoom)"
        >
          解散房间
        </Button>
        <Button size="sm" :loading="phase === 'joining'" @click="joinPreviewRoom">
          <Icon :icon="iconHeadphones" width="16" height="16" />
          加入一起听
        </Button>
      </template>
    </Dialog>

    <Dialog v-model:open="dismissOwnedOpen" title="解散房间">
      <p class="listen-leave-copy">
        确定解散「{{ ownedRoomToDismiss?.name || '这个房间' }}」吗？解散后无法恢复。
      </p>
      <template #footer>
        <Button
          variant="secondary"
          size="sm"
          :disabled="dismissingOwnedRoom"
          @click="dismissOwnedOpen = false"
        >
          取消
        </Button>
        <Button
          variant="danger"
          size="sm"
          :loading="dismissingOwnedRoom"
          @click="confirmDismissOwnedRoom"
        >
          确认解散
        </Button>
      </template>
    </Dialog>

    <Dialog
      v-model:open="createOpen"
      :title="`创建${createRoomTypeName}`"
      :description="createDescription"
      show-close
      content-class="listen-create-dialog"
      :close-on-escape="phase !== 'creating'"
      :close-on-interact-outside="phase !== 'creating'"
    >
      <div class="listen-create-form">
        <label>
          <span>房间名称</span>
          <Input v-model="createName" :show-clear="false" placeholder="给房间起个名字" />
        </label>
        <div class="listen-create-field">
          <span>房间权限</span>
          <div class="listen-privacy-options">
            <button
              type="button"
              :class="{ 'is-selected': createPrivacy === 1 }"
              @click="createPrivacy = 1"
            >
              <strong>公开房间</strong>
              <small>可在广场发现；账号需具备公开创房权限</small>
            </button>
            <button
              type="button"
              :class="{ 'is-selected': createPrivacy === 2 }"
              @click="createPrivacy = 2"
            >
              <strong>私密房间</strong>
              <small>仅限受邀成员，按 APP 默认最多 5 人</small>
            </button>
          </div>
        </div>
        <div class="listen-create-field">
          <span>播放队列</span>
          <div class="listen-create-playlist is-readonly">
            <span class="listen-create-playlist-icon">
              <Icon :icon="iconMusic" width="19" height="19" />
            </span>
            <span class="listen-create-playlist-copy">
              <strong>
                {{ createAudios.length ? '沿用当前播放队列' : '当前没有可用播放队列' }}
              </strong>
              <small v-if="createAudios.length">
                从“{{ playerStore.currentTrackSnapshot?.title || '当前歌曲' }}”开始同步
              </small>
              <small v-else>请先播放一首歌，再创建众乐房</small>
            </span>
            <span class="listen-create-playlist-action">
              {{ createAudios.length ? `${createAudios.length} 首` : '待准备' }}
            </span>
          </div>
        </div>
        <div class="listen-create-summary">
          <small>众乐房支持聊天与点歌，创建后可继续添加歌曲。</small>
        </div>
      </div>
      <template #footer>
        <Button
          variant="secondary"
          size="sm"
          :disabled="phase === 'creating'"
          @click="createOpen = false"
          >取消</Button
        >
        <Button
          size="sm"
          :disabled="!canCreate"
          :loading="phase === 'creating'"
          @click="submitCreateRoom"
        >
          创建{{ createRoomTypeName }}并进入
        </Button>
      </template>
    </Dialog>

    <Dialog
      v-model:open="orderSongPickerOpen"
      :title="isOwner ? '添加歌曲' : '点歌'"
      :description="
        isOwner ? '选择歌曲后直接加入房间播放队列' : '选择歌曲后提交给房主，允许加歌后进入房间队列'
      "
      show-close
      content-class="listen-order-song-dialog"
    >
      <div class="listen-order-song-picker">
        <div class="listen-song-picker-tabs">
          <button
            v-for="source in orderSongSources"
            :key="source.id"
            type="button"
            :class="{ 'is-active': orderSongSource === source.id }"
            @click="selectOrderSongSource(source.id)"
          >
            {{ source.name }}
          </button>
        </div>
        <form
          v-if="orderSongSource === 'search'"
          class="listen-song-picker-search"
          @submit.prevent="searchOrderSongs"
        >
          <Input
            v-model="orderSongSearchKeyword"
            placeholder="搜索歌名或歌手"
            aria-label="搜索点播歌曲"
          />
          <Button size="sm" :loading="searchingOrderSongs" type="submit">
            <Icon :icon="iconSearch" width="15" height="15" />
            搜索
          </Button>
        </form>
        <Scrollbar class="listen-order-song-scroll">
          <div v-if="orderSongCandidates.length" class="listen-order-song-list">
            <button
              v-for="song in orderSongCandidates"
              :key="song.hash"
              type="button"
              class="listen-order-song-option"
              :disabled="Boolean(requestingSongHash)"
              @click="requestSong(song)"
            >
              <Cover
                :url="song.coverUrl"
                :alt="song.title"
                :width="44"
                :height="44"
                :border-radius="10"
              />
              <span>
                <strong>{{ song.title }}</strong>
                <small>{{ song.artist || '未知歌手' }}</small>
              </span>
              <em>
                {{
                  requestingSongHash === song.hash
                    ? isOwner
                      ? '添加中'
                      : '点歌中'
                    : isOwner
                      ? '添加'
                      : '点歌'
                }}
              </em>
            </button>
          </div>
          <div v-else class="listen-song-picker-empty">
            <Icon :icon="iconMusic" width="28" height="28" />
            <span>{{ orderSongEmptyCopy }}</span>
          </div>
        </Scrollbar>
      </div>
    </Dialog>

    <Dialog
      v-model:open="songOrdersOpen"
      title="点播列表"
      description="房主允许加歌后，歌曲才会进入房间播放队列"
      show-close
      content-class="listen-song-orders-dialog"
    >
      <div class="listen-song-orders">
        <div v-if="loadingSongOrders && !songOrders.length" class="listen-song-picker-empty">
          <span>正在加载点播列表…</span>
        </div>
        <div v-else-if="songOrders.length" class="listen-song-order-list">
          <div v-for="order in songOrders" :key="order.id" class="listen-song-order-item">
            <Cover
              :url="order.song.coverUrl"
              :alt="order.song.title"
              :width="46"
              :height="46"
              :border-radius="10"
            />
            <span class="listen-song-order-copy">
              <strong>{{ order.song.title }}</strong>
              <small>{{ order.requesterName }} 的点歌 · {{ order.song.artist }}</small>
            </span>
            <div class="listen-song-order-actions">
              <Button
                variant="ghost"
                size="xs"
                :disabled="Boolean(handlingSongOrderId)"
                @click="removeSongOrder(order)"
              >
                忽略
              </Button>
              <Button
                size="xs"
                :loading="handlingSongOrderId === order.id"
                :disabled="Boolean(handlingSongOrderId)"
                @click="approveSongOrder(order)"
              >
                允许加歌
              </Button>
            </div>
          </div>
        </div>
        <div v-else class="listen-song-picker-empty">
          <Icon :icon="iconMusic" width="28" height="28" />
          <span>暂时没有人点歌</span>
        </div>
      </div>
    </Dialog>

    <Dialog v-model:open="leaveOpen" :title="isOwner ? '房间管理' : '离开房间'">
      <p class="listen-leave-copy">
        {{
          isOwner
            ? '返回列表后房间会继续在后台保持同步。只有结束一起听才会解散房间。'
            : '离开后将停止房间同步，当前歌曲会保留在本地播放器中。'
        }}
      </p>
      <template #footer>
        <Button
          variant="secondary"
          size="sm"
          :disabled="phase === 'leaving'"
          @click="leaveOpen = false"
          >取消</Button
        >
        <Button
          v-if="isOwner"
          variant="danger"
          size="sm"
          :loading="phase === 'leaving'"
          @click="confirmLeave(true)"
          >结束一起听</Button
        >
        <Button size="sm" :loading="phase === 'leaving'" @click="confirmLeave(false)">{{
          isOwner ? '返回房间列表' : '离开房间'
        }}</Button>
      </template>
    </Dialog>
  </section>
</template>
