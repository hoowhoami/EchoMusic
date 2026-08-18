import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import {
  ListenTogetherApiError,
  addListenTogetherMusicRoomSongs,
  checkListenTogetherMinor,
  configureListenTogetherRoom,
  createListenTogetherGroup,
  deleteCreatedListenTogetherStudyRoom,
  dismissListenTogetherRoom,
  getCreatedListenTogetherStudyRooms,
  getListenTogetherMusicRoomHistory,
  getListenTogetherMembers,
  getListenTogetherMessages,
  getListenTogetherPlaylist,
  getListenTogetherRecentPlaylist,
  getListenTogetherRoomDetail,
  getListenTogetherRoomState,
  getListenTogetherRooms,
  getListenTogetherSongOrders,
  heartbeatListenTogetherRoom,
  initializeListenTogetherMusicRoom,
  joinListenTogetherRoom,
  leaveListenTogetherRoom,
  requestListenTogetherSong,
  removeListenTogetherSongOrder,
  searchListenTogetherChannels,
  sendListenTogetherMessage,
  switchListenTogetherMusicRoomSong,
  syncListenTogetherPlayer,
  updateListenTogetherMusicRoomPlayer,
} from '@/api/listenTogether';
import { getAudioMetadata } from '@/api/music';
import type {
  ListenTogetherChannel,
  ListenTogetherCreateInput,
  ListenTogetherMember,
  ListenTogetherMessage,
  ListenTogetherRemotePlayback,
  ListenTogetherRoom,
  ListenTogetherSongOrder,
  ListenTogetherRoomType,
  ListenTogetherSessionPhase,
} from '@/models/listenTogether';
import type { Song } from '@/models/song';
import {
  extractListenTogetherRoomId,
  getListenTogetherRoomPageInfo,
  mapListenTogetherChannelList,
  mapListenTogetherMemberList,
  mapListenTogetherMessageList,
  mapListenTogetherRemotePlayback,
  mapListenTogetherRoom,
  mapListenTogetherRoomList,
  mapListenTogetherSongList,
  mapListenTogetherSongOrders,
} from '@/utils/listenTogether';
import { usePlayerStore } from './player';
import { useLyricStore } from './lyric';
import {
  LISTEN_TOGETHER_QUEUE_ID,
  PERSONAL_FM_QUEUE_ID,
  usePlaylistStore,
  type SetPlaybackQueueOptions,
} from './playlist';
import { useToastStore } from './toast';
import { useUserStore } from './user';
import logger from '@/utils/logger';

const FAST_POLL_INTERVAL = 5_000;
const SLOW_POLL_INTERVAL = 15_000;
const HEARTBEAT_INTERVAL = 55_000;
const ROOM_PAGE_SIZE = 20;
const ROOM_PLAYLIST_PAGE_SIZE = 50;

const isMissingRoomMessage = (message: string) => /(?:群组|房间)(?:不存在|已解散)/.test(message);

const getErrorMessage = (error: unknown) => {
  if (error instanceof ListenTogetherApiError) {
    if (error.code === 51002) return '请先登录后再使用一起听';
    if (
      error.code === 55006 ||
      error.code === 20005 ||
      (error.code === 20002 && isMissingRoomMessage(error.message))
    )
      return '房间不存在或已解散，无法加入';
    if (error.code === 20003) return '房间频道或歌曲配置不完整';
    if (error.code === 20006) return '账号当前已有未结束的众乐房会话';
    return error.message;
  }
  return error instanceof Error && error.message ? error.message : '一起听操作失败';
};

const isDissolvedRoomError = (error: unknown) =>
  error instanceof ListenTogetherApiError &&
  (error.code === 55006 ||
    error.code === 20005 ||
    (error.code === 20002 && isMissingRoomMessage(error.message)));

const readNestedFlag = (payload: unknown, key: string, depth = 0): boolean => {
  if (depth > 6 || !payload || typeof payload !== 'object') return false;
  if (!Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (key in record) return Number(record[key]) === 1 || record[key] === true;
  }
  return Object.values(payload).some((value) => readNestedFlag(value, key, depth + 1));
};

const readNestedString = (payload: unknown, key: string, depth = 0): string => {
  if (depth > 6 || !payload || typeof payload !== 'object') return '';
  if (!Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number') {
      const normalized = String(value).trim();
      if (normalized) return normalized;
    }
  }
  for (const value of Object.values(payload)) {
    const nested = readNestedString(value, key, depth + 1);
    if (nested) return nested;
  }
  return '';
};

const readNestedNumber = (payload: unknown, key: string, depth = 0): number => {
  if (!payload || typeof payload !== 'object' || depth > 6) return 0;
  if (Array.isArray(payload)) {
    for (const value of payload) {
      const nested = readNestedNumber(value, key, depth + 1);
      if (nested > 0) return nested;
    }
    return 0;
  }
  const record = payload as Record<string, unknown>;
  const direct = Number(record[key]);
  if (Number.isFinite(direct) && direct > 0) return direct;
  for (const value of Object.values(record)) {
    const nested = readNestedNumber(value, key, depth + 1);
    if (nested > 0) return nested;
  }
  return 0;
};

export const useListenTogetherStore = defineStore(
  'listenTogether',
  () => {
    const userStore = useUserStore();
    const playerStore = usePlayerStore();
    const lyricStore = useLyricStore();
    const playlistStore = usePlaylistStore();
    const toastStore = useToastStore();

    const rooms = ref<ListenTogetherRoom[]>([]);
    const roomsPage = ref(0);
    const roomsTotal = ref(0);
    const roomsEnded = ref(false);
    const roomsNotice = ref('');
    const activeTagId = ref('');
    const roomListType = ref<ListenTogetherRoomType>(1);
    const loadingRooms = ref(false);
    const ownedRooms = ref<ListenTogetherRoom[]>([]);
    const ownedRoomIndex = ref<ListenTogetherRoom[]>([]);
    const dissolvedRoomKeys = ref<string[]>([]);
    const loadingOwnedRooms = ref(false);

    const previewRoom = ref<ListenTogetherRoom | null>(null);
    const previewMembers = ref<ListenTogetherMember[]>([]);
    const loadingPreview = ref(false);

    const phase = ref<ListenTogetherSessionPhase>('idle');
    const activeRoomId = ref('');
    const activeRoom = ref<ListenTogetherRoom | null>(null);
    const members = ref<ListenTogetherMember[]>([]);
    const messages = ref<ListenTogetherMessage[]>([]);
    const roomSongs = ref<Song[]>([]);
    const songOrders = ref<ListenTogetherSongOrder[]>([]);
    const loadingSongOrders = ref(false);
    const handlingSongOrderId = ref('');
    const roomListVersion = ref('');
    const remotePlayback = ref<ListenTogetherRemotePlayback | null>(null);
    const lastError = ref('');
    const loadingRoom = ref(false);
    const sendingMessage = ref(false);
    const requestingSongHash = ref('');
    const channelResults = ref<ListenTogetherChannel[]>([]);
    const searchingChannels = ref(false);

    let heartbeatTimer: number | null = null;
    let fastPollTimer: number | null = null;
    let slowPollTimer: number | null = null;
    let initialRoomStateVerifyTimer: number | null = null;
    let heartbeatInFlight = false;
    let fastPollInFlight = false;
    let slowPollInFlight = false;
    let applyingPlayback = false;
    let roomSongsLoadInFlight: { roomKey: string; promise: Promise<void> } | null = null;
    let roomSongsLoadRevision = 0;
    let roomSongsRetryAfter = 0;
    let heartbeatFailureCount = 0;
    let previousPlaybackQueueId: string | null = null;
    let ownerCommandQueue = Promise.resolve();
    let ownerAutoSwitchUntil = 0;
    let ownerControlGraceUntil = 0;
    let ownerControlRevision = 0;
    let lastForcedLyricMetadataKey = '';
    let suppressAppliedPlayerEventsUntil = 0;
    let lastAppliedRemoteSeekKey = '';
    let lastAppliedRemoteSeekAt = 0;
    let lastMissingRemoteSongKey = '';
    let guestLocallyPaused = false;
    const metadataLookupAttempted = new Set<string>();

    const joined = computed(() => phase.value === 'joined' && Boolean(activeRoomId.value));
    const activeRoomType = computed<ListenTogetherRoomType>(() => activeRoom.value?.roomType ?? 1);
    const currentUserId = computed(() =>
      String(userStore.info?.userid ?? userStore.info?.userId ?? ''),
    );
    const isOwner = computed(
      () => Boolean(activeRoom.value?.ownerId) && activeRoom.value?.ownerId === currentUserId.value,
    );

    const getRoomKey = (room: Pick<ListenTogetherRoom, 'id' | 'roomType'>) =>
      `${room.roomType}:${room.id}`;

    const isKnownDissolvedRoom = (room: Pick<ListenTogetherRoom, 'id' | 'roomType'>) =>
      dissolvedRoomKeys.value.includes(getRoomKey(room));

    const rememberDissolvedRoom = (room: Pick<ListenTogetherRoom, 'id' | 'roomType'>) => {
      const key = getRoomKey(room);
      dissolvedRoomKeys.value = [
        key,
        ...dissolvedRoomKeys.value.filter((item) => item !== key),
      ].slice(0, 200);
    };

    const forgetDissolvedRoom = (room: Pick<ListenTogetherRoom, 'id' | 'roomType'>) => {
      const key = getRoomKey(room);
      dissolvedRoomKeys.value = dissolvedRoomKeys.value.filter((item) => item !== key);
    };

    const assertRoomIsLive = (payload: unknown) => {
      if (readNestedFlag(payload, 'room_state')) return;
      throw new ListenTogetherApiError('群组已解散', 20005, payload);
    };

    const normalizedSongHashes = (song: Song | null | undefined) =>
      new Set(
        [song?.hash, song?.originalHash]
          .map((value) =>
            String(value ?? '')
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean),
      );

    const normalizedSongMixIds = (song: Song | null | undefined) =>
      new Set(
        [song?.mixSongId, song?.albumAudioId, song?.originalAlbumAudioId]
          .map((value) => String(value ?? '').trim())
          .filter((value) => Boolean(value) && value !== '0'),
      );

    const isSameRoomSong = (left: Song | null | undefined, right: Song | null | undefined) => {
      if (!left || !right) return false;
      const leftHashes = normalizedSongHashes(left);
      if ([...normalizedSongHashes(right)].some((hash) => leftHashes.has(hash))) return true;
      const leftMixIds = normalizedSongMixIds(left);
      if ([...normalizedSongMixIds(right)].some((mixId) => leftMixIds.has(mixId))) return true;
      return Boolean(left.id && right.id && String(left.id) === String(right.id));
    };

    const isUsefulSongTitle = (value: string | undefined) =>
      Boolean(value && value !== '未知歌曲' && !/^房间歌曲 \d+$/.test(value));
    const isUsefulSongArtist = (value: string | undefined) =>
      Boolean(value && value !== '未知歌手' && value !== '一起听');
    const isUsefulSongCover = (value: string | undefined) => {
      const normalized = String(value ?? '').trim();
      return Boolean(
        normalized &&
        !normalized.includes('youthimgbssdl.kugou.com') &&
        !normalized.includes('/soft/collection/default.'),
      );
    };
    const firstUsableSongId = (...values: Array<string | number | undefined>) =>
      values.find((value) => {
        const normalized = String(value ?? '').trim();
        return Boolean(normalized) && normalized !== '0';
      });
    const songMetadataScore = (song: Song) =>
      Number(isUsefulSongTitle(song.title)) * 2 +
      Number(isUsefulSongArtist(song.artist)) * 2 +
      Number(isUsefulSongCover(song.coverUrl || song.cover)) * 3 +
      Number(Boolean(song.albumName || song.album)) +
      Number(Boolean(song.albumAudioId || song.mixSongId)) +
      Number(Boolean(song.relateGoods?.length));

    const mergeRoomSongMetadata = (cached: Song, incoming: Song): Song => {
      const incomingIsRicher = songMetadataScore(incoming) > songMetadataScore(cached);
      const preferredIdentity = incomingIsRicher ? incoming : cached;
      const alternateIdentity = incomingIsRicher ? cached : incoming;
      const incomingMetadata = Object.fromEntries(
        Object.entries(incoming).filter(([key, value]) => {
          if (key === 'id') return false;
          if (value === undefined || value === null) return false;
          if (typeof value === 'string') return Boolean(value.trim());
          if (Array.isArray(value)) {
            return value.length > 0 || !Array.isArray(cached[key as keyof Song]);
          }
          if (typeof value === 'number' && value === 0) {
            const cachedValue = cached[key as keyof Song];
            return cachedValue === undefined || cachedValue === null || cachedValue === 0;
          }
          return true;
        }),
      ) as Partial<Song>;
      const preferredHash = preferredIdentity.hash || alternateIdentity.hash;
      const alternateHash = alternateIdentity.hash;
      const originalHash =
        preferredIdentity.originalHash ||
        alternateIdentity.originalHash ||
        (alternateHash && alternateHash.toLowerCase() !== preferredHash.toLowerCase()
          ? alternateHash
          : undefined);
      const incomingCover = isUsefulSongCover(incoming.coverUrl || incoming.cover)
        ? incoming.coverUrl || incoming.cover
        : '';
      const cachedCover = isUsefulSongCover(cached.coverUrl || cached.cover)
        ? cached.coverUrl || cached.cover
        : '';
      const coverUrl =
        (incomingIsRicher ? incomingCover || cachedCover : cachedCover || incomingCover) || '';
      const title = isUsefulSongTitle(preferredIdentity.title)
        ? preferredIdentity.title
        : isUsefulSongTitle(alternateIdentity.title)
          ? alternateIdentity.title
          : preferredIdentity.title || alternateIdentity.title;
      const artist = isUsefulSongArtist(preferredIdentity.artist)
        ? preferredIdentity.artist
        : isUsefulSongArtist(alternateIdentity.artist)
          ? alternateIdentity.artist
          : preferredIdentity.artist || alternateIdentity.artist;
      const albumName =
        preferredIdentity.albumName ||
        preferredIdentity.album ||
        alternateIdentity.albumName ||
        alternateIdentity.album;
      const mixSongId =
        firstUsableSongId(
          preferredIdentity.mixSongId,
          preferredIdentity.albumAudioId,
          alternateIdentity.mixSongId,
          alternateIdentity.albumAudioId,
        ) ?? '';
      return {
        ...cached,
        ...incomingMetadata,
        // 队列当前项依赖 id，刷新元数据时保持 id 稳定，避免当前歌曲指针失效。
        id: cached.id || incoming.id,
        title,
        name: title || incoming.name || cached.name,
        artist,
        coverUrl,
        cover: coverUrl,
        albumName,
        album: albumName,
        albumId: preferredIdentity.albumId || alternateIdentity.albumId,
        duration: preferredIdentity.duration || alternateIdentity.duration,
        audioUrl: cached.audioUrl || incoming.audioUrl,
        hash: preferredHash,
        originalHash,
        mixSongId,
        albumAudioId: firstUsableSongId(
          preferredIdentity.albumAudioId,
          preferredIdentity.mixSongId,
          alternateIdentity.albumAudioId,
          alternateIdentity.mixSongId,
        ),
        originalAlbumAudioId: firstUsableSongId(
          preferredIdentity.originalAlbumAudioId,
          alternateIdentity.originalAlbumAudioId,
        ),
        relateGoods: incoming.relateGoods?.length ? incoming.relateGoods : cached.relateGoods,
      };
    };

    const mergeRoomSongList = (incomingSongs: Song[]) => {
      const cachedSongs = [
        ...roomSongs.value,
        ...playlistStore.getPlaybackQueueSongs(LISTEN_TOGETHER_QUEUE_ID),
      ];
      const current = playerStore.currentTrackSnapshot;
      if (current && playerStore.currentSourceQueueId === LISTEN_TOGETHER_QUEUE_ID) {
        const currentIndex = cachedSongs.findIndex((song) => isSameRoomSong(song, current));
        if (currentIndex >= 0) {
          cachedSongs[currentIndex] = mergeRoomSongMetadata(cachedSongs[currentIndex], current);
        } else {
          cachedSongs.push(current);
        }
      }
      return incomingSongs.map((incoming) => {
        const cached = cachedSongs.find((song) => isSameRoomSong(song, incoming));
        return cached ? mergeRoomSongMetadata(cached, incoming) : incoming;
      });
    };

    const findRemoteRoomSong = (remote: ListenTogetherRemotePlayback | null) => {
      if (!remote) return null;
      const remoteMixSongId = String(remote.mixSongId ?? '').trim();
      if (remoteMixSongId && remoteMixSongId !== '0') {
        const songByMixId = roomSongs.value.find((song) =>
          [song.mixSongId, song.albumAudioId, song.originalAlbumAudioId].some(
            (value) => String(value ?? '').trim() === remoteMixSongId,
          ),
        );
        if (songByMixId) return songByMixId;
      }

      const remoteHash = remote.hash.trim().toLowerCase();
      const songByHash = roomSongs.value.find((song) =>
        [song.hash, song.originalHash].some(
          (value) =>
            String(value ?? '')
              .trim()
              .toLowerCase() === remoteHash,
        ),
      );
      if (songByHash) return songByHash;

      return null;
    };

    const isRemotePositionForSong = (remote: ListenTogetherRemotePlayback, song: Song) => {
      const remoteMixSongId = String(remote.mixSongId ?? '').trim();
      const matchesMixSongId =
        remoteMixSongId &&
        remoteMixSongId !== '0' &&
        [song.mixSongId, song.albumAudioId, song.originalAlbumAudioId].some(
          (value) => String(value ?? '').trim() === remoteMixSongId,
        );
      if (matchesMixSongId) return true;
      const remoteHash = remote.hash.trim().toLowerCase();
      return [song.hash, song.originalHash].some(
        (value) =>
          String(value ?? '')
            .trim()
            .toLowerCase() === remoteHash,
      );
    };

    const currentRoomSong = computed(() => {
      const roomSong = findRemoteRoomSong(remotePlayback.value);
      const current = playerStore.currentTrackSnapshot;
      if (
        current &&
        playerStore.currentSourceQueueId === LISTEN_TOGETHER_QUEUE_ID &&
        (isSameRoomSong(roomSong, current) ||
          (remotePlayback.value && isRemotePositionForSong(remotePlayback.value, current)))
      ) {
        return roomSong ? mergeRoomSongMetadata(roomSong, current) : current;
      }
      return roomSong;
    });

    const requireLogin = () => {
      if (userStore.isLoggedIn) return;
      throw new ListenTogetherApiError('请先登录后再使用一起听', 51002);
    };

    const clearSessionTimers = () => {
      if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
      if (fastPollTimer !== null) window.clearInterval(fastPollTimer);
      if (slowPollTimer !== null) window.clearInterval(slowPollTimer);
      if (initialRoomStateVerifyTimer !== null) window.clearTimeout(initialRoomStateVerifyTimer);
      heartbeatTimer = null;
      fastPollTimer = null;
      slowPollTimer = null;
      initialRoomStateVerifyTimer = null;
      heartbeatInFlight = false;
      fastPollInFlight = false;
      slowPollInFlight = false;
      heartbeatFailureCount = 0;
    };

    const getListenTogetherQueueOptions = (): SetPlaybackQueueOptions => ({
      queueId: LISTEN_TOGETHER_QUEUE_ID,
      title: activeRoom.value?.name || '一起听',
      subtitle: activeRoomType.value === 1 ? '自习室 · 房间同步' : '众乐房 · 房间同步',
      coverUrl:
        currentRoomSong.value?.coverUrl ||
        (playerStore.currentSourceQueueId === LISTEN_TOGETHER_QUEUE_ID
          ? playerStore.currentTrackSnapshot?.coverUrl
          : '') ||
        roomSongs.value[0]?.coverUrl ||
        '',
      type: 'listen-together',
      dynamic: true,
      meta: {
        roomId: activeRoomId.value,
        roomType: activeRoomType.value,
      },
    });

    const capturePreviousPlaybackQueue = () => {
      if (playlistStore.activeQueueId === LISTEN_TOGETHER_QUEUE_ID) return;
      const activeQueue = playlistStore.getQueueById(playlistStore.activeQueueId);
      const fallbackQueue =
        playlistStore.activeQueueId === PERSONAL_FM_QUEUE_ID
          ? playlistStore.getQueueById(playlistStore.lastNonFmQueueId)
          : activeQueue;
      previousPlaybackQueueId = fallbackQueue?.id ?? null;

      // 私人 FM 和一起听都是临时播放上下文。先回到普通队列，避免创建房间队列时
      // 因队列数量上限淘汰真正需要在离房后恢复的队列。
      if (
        playlistStore.activeQueueId === PERSONAL_FM_QUEUE_ID &&
        fallbackQueue &&
        fallbackQueue.id !== PERSONAL_FM_QUEUE_ID
      ) {
        playlistStore.setActiveQueue(fallbackQueue.id);
      }
    };

    const syncListenTogetherQueue = (activate = true) => {
      if (!activeRoomId.value) return;
      const current = playerStore.currentTrackSnapshot;
      let syncedCurrent: Song | null = null;
      if (current && playerStore.currentSourceQueueId === LISTEN_TOGETHER_QUEUE_ID) {
        const currentIndex = roomSongs.value.findIndex((song) => isSameRoomSong(song, current));
        if (currentIndex >= 0) {
          syncedCurrent = mergeRoomSongMetadata(roomSongs.value[currentIndex], current);
          roomSongs.value = roomSongs.value.map((song, index) =>
            index === currentIndex ? syncedCurrent! : song,
          );
        }
      }
      playlistStore.setPlaybackQueueWithOptions(roomSongs.value, 0, {
        ...getListenTogetherQueueOptions(),
        activate,
      });
      if (syncedCurrent) {
        playlistStore.updateQueueCurrentTrack(syncedCurrent.id, LISTEN_TOGETHER_QUEUE_ID);
      }
      if (activate) {
        playerStore.currentSourceQueueId = LISTEN_TOGETHER_QUEUE_ID;
        playerStore.currentPlaylist = roomSongs.value;

        // 歌单元数据通常晚于播放状态返回。当前曲目未切换时 playTrack 不会重跑，
        // 因此要把补齐后的封面、专辑和版权 ID 合并回播放器快照。
        if (current) {
          const currentHashes = new Set(
            [current.hash, current.originalHash]
              .map((value) =>
                String(value ?? '')
                  .trim()
                  .toLowerCase(),
              )
              .filter(Boolean),
          );
          const currentMixIds = new Set(
            [current.mixSongId, current.albumAudioId, current.originalAlbumAudioId]
              .map((value) => String(value ?? '').trim())
              .filter((value) => Boolean(value) && value !== '0'),
          );
          const synced = roomSongs.value.find((song) => {
            if (String(song.id) === String(current.id)) return true;
            const matchesHash = [song.hash, song.originalHash].some((value) =>
              currentHashes.has(
                String(value ?? '')
                  .trim()
                  .toLowerCase(),
              ),
            );
            if (matchesHash) return true;
            return [song.mixSongId, song.albumAudioId, song.originalAlbumAudioId].some((value) =>
              currentMixIds.has(String(value ?? '').trim()),
            );
          });

          if (synced) {
            const nextTitle = synced.title || current.title;
            const nextArtist = synced.artist || current.artist;
            const nextCoverUrl = synced.coverUrl || current.coverUrl;
            const nextAlbumName = synced.albumName || current.albumName;
            const nextDuration = synced.duration || current.duration;
            const nextAlbumAudioId = firstUsableSongId(current.albumAudioId, synced.albumAudioId);
            const nextMixSongId = firstUsableSongId(current.mixSongId, synced.mixSongId) ?? '';
            const metadataChanged =
              current.title !== nextTitle ||
              current.artist !== nextArtist ||
              current.coverUrl !== nextCoverUrl ||
              current.albumName !== nextAlbumName ||
              current.duration !== nextDuration ||
              String(current.albumAudioId ?? '') !== String(nextAlbumAudioId ?? '') ||
              String(current.mixSongId ?? '') !== String(nextMixSongId ?? '');
            if (metadataChanged) {
              const enrichedCurrent: Song = mergeRoomSongMetadata(current, {
                ...synced,
                title: nextTitle,
                artist: nextArtist,
                coverUrl: nextCoverUrl,
                albumName: nextAlbumName,
                duration: nextDuration,
                albumAudioId: nextAlbumAudioId,
                mixSongId: nextMixSongId,
              });
              playerStore.currentTrackSnapshot = enrichedCurrent;

              // 首次播放时若只有 hash，歌词查询可能已经以不完整参数失败；
              // 元数据补齐后带 duration / album_audio_id 强制重新匹配一次。
              if (enrichedCurrent.hash) {
                const lyricMetadataKey = [
                  enrichedCurrent.hash.toLowerCase(),
                  enrichedCurrent.duration || 0,
                  enrichedCurrent.albumAudioId ?? enrichedCurrent.mixSongId ?? '',
                ].join(':');
                if (lyricMetadataKey !== lastForcedLyricMetadataKey) {
                  lastForcedLyricMetadataKey = lyricMetadataKey;
                  void lyricStore.fetchLyrics(enrichedCurrent.hash, {
                    force: true,
                    duration: enrichedCurrent.duration ? enrichedCurrent.duration * 1000 : 0,
                    albumAudioId: enrichedCurrent.albumAudioId ?? enrichedCurrent.mixSongId,
                    track: enrichedCurrent,
                  });
                }
              }
            }
          }
        }
      }
    };

    const restorePreviousPlaybackQueue = () => {
      const wasListenTogetherSource = playerStore.currentSourceQueueId === LISTEN_TOGETHER_QUEUE_ID;
      const fallbackQueue = previousPlaybackQueueId
        ? playlistStore.getQueueById(previousPlaybackQueueId)
        : null;

      playlistStore.removePlaybackQueue(LISTEN_TOGETHER_QUEUE_ID);
      if (fallbackQueue) playlistStore.setActiveQueue(fallbackQueue.id);

      if (wasListenTogetherSource) {
        const restoredQueue =
          fallbackQueue ?? playlistStore.activeQueue ?? playlistStore.playbackQueueList[0] ?? null;
        playerStore.currentSourceQueueId = restoredQueue?.id ?? null;
        playerStore.currentPlaylist = restoredQueue?.songs.slice() ?? [];
      }
      previousPlaybackQueueId = null;
    };

    const resetSessionState = () => {
      clearSessionTimers();
      restorePreviousPlaybackQueue();
      activeRoomId.value = '';
      activeRoom.value = null;
      members.value = [];
      messages.value = [];
      roomSongs.value = [];
      songOrders.value = [];
      loadingSongOrders.value = false;
      handlingSongOrderId.value = '';
      roomListVersion.value = '';
      remotePlayback.value = null;
      lastError.value = '';
      loadingRoom.value = false;
      sendingMessage.value = false;
      requestingSongHash.value = '';
      metadataLookupAttempted.clear();
      lastForcedLyricMetadataKey = '';
      suppressAppliedPlayerEventsUntil = 0;
      lastAppliedRemoteSeekKey = '';
      lastAppliedRemoteSeekAt = 0;
      lastMissingRemoteSongKey = '';
      guestLocallyPaused = false;
      // 请求本身无法取消，但不能让离开的房间占用下一次入房的首次歌单加载。
      roomSongsLoadRevision += 1;
      roomSongsLoadInFlight = null;
      roomSongsRetryAfter = 0;
      phase.value = 'idle';
    };

    const loadRooms = async (
      options: { reset?: boolean; tagId?: string; roomType?: ListenTogetherRoomType } = {},
    ) => {
      if (loadingRooms.value) return;
      const nextTag = options.tagId ?? activeTagId.value;
      const nextRoomType = options.roomType ?? roomListType.value;
      const shouldReset =
        options.reset === true ||
        nextTag !== activeTagId.value ||
        nextRoomType !== roomListType.value;
      if (!shouldReset && roomsEnded.value) return;
      loadingRooms.value = true;
      try {
        if (shouldReset) {
          activeTagId.value = nextTag;
          roomListType.value = nextRoomType;
          roomsPage.value = 0;
          roomsEnded.value = false;
        }
        const nextPage = roomsPage.value + 1;
        const payload = await getListenTogetherRooms({
          roomType: nextRoomType,
          page: nextPage,
          pageSize: ROOM_PAGE_SIZE,
          tagId: activeTagId.value,
        });
        const nextRooms = mapListenTogetherRoomList(payload, nextRoomType).filter(
          (room) => !isKnownDissolvedRoom(room),
        );
        const pageInfo = getListenTogetherRoomPageInfo(payload);
        roomsPage.value = nextPage;
        rooms.value = shouldReset
          ? nextRooms
          : Array.from(
              new Map([...rooms.value, ...nextRooms].map((room) => [room.id, room])).values(),
            );
        roomsTotal.value = pageInfo.total;
        roomsNotice.value = pageInfo.notice || roomsNotice.value;
        roomsEnded.value = pageInfo.ended;
        lastError.value = '';
      } catch (error) {
        lastError.value = getErrorMessage(error);
        if (options.reset) rooms.value = [];
        throw error;
      } finally {
        loadingRooms.value = false;
      }
    };

    const normalizeOwnedRoom = (room: ListenTogetherRoom): ListenTogetherRoom => {
      const isActive =
        joined.value && activeRoomId.value === room.id && activeRoomType.value === room.roomType;
      const currentSong = isActive ? currentRoomSong.value : null;
      const ownerId = currentUserId.value || room.ownerId;
      const ownerName = userStore.info?.nickname || room.ownerName || '我';
      const ownerAvatarUrl = userStore.info?.pic || room.ownerAvatarUrl;
      const activeMemberPreviews = isActive
        ? [
            ...members.value,
            ...(members.value.some((member) => member.userId === ownerId)
              ? []
              : [{ userId: ownerId, nickname: ownerName, avatarUrl: ownerAvatarUrl }]),
          ]
        : room.memberPreviews;
      return {
        ...room,
        ownerId,
        ownerName,
        ownerAvatarUrl,
        studyRoomKind: room.roomType === 1 ? 'community' : undefined,
        memberCount: isActive
          ? Math.max(1, room.memberCount, activeRoom.value?.memberCount ?? 0, members.value.length)
          : room.memberCount,
        memberPreviews: activeMemberPreviews,
        currentSongName: currentSong?.title || room.currentSongName,
        currentArtistName: currentSong?.artist || room.currentArtistName,
      };
    };

    const upsertOwnedRoom = (room: ListenTogetherRoom) => {
      const normalized = normalizeOwnedRoom(room);
      const key = `${normalized.ownerId}:${normalized.roomType}:${normalized.id}`;
      ownedRoomIndex.value = [
        normalized,
        ...ownedRoomIndex.value.filter(
          (item) => `${item.ownerId}:${item.roomType}:${item.id}` !== key,
        ),
      ].slice(0, 100);
      return normalized;
    };

    const removeOwnedRoom = (room: Pick<ListenTogetherRoom, 'id' | 'roomType'>) => {
      const matches = (item: ListenTogetherRoom) =>
        item.id === room.id && item.roomType === room.roomType;
      ownedRoomIndex.value = ownedRoomIndex.value.filter((item) => !matches(item));
      ownedRooms.value = ownedRooms.value.filter((item) => !matches(item));
    };

    const loadOwnedRooms = async (roomType: ListenTogetherRoomType) => {
      requireLogin();
      if (loadingOwnedRooms.value) return;
      loadingOwnedRooms.value = true;
      try {
        const userId = currentUserId.value;
        let remoteRooms: ListenTogetherRoom[] = [];
        if (roomType === 1) {
          const payload = await getCreatedListenTogetherStudyRooms();
          const listedRooms = mapListenTogetherRoomList(payload, 1).filter(
            (room) => !isKnownDissolvedRoom(room),
          );
          const detailResults = await Promise.allSettled(
            listedRooms.map(async (room) => {
              assertRoomIsLive(await getListenTogetherRoomState(room.id, 1));
              return getListenTogetherRoomDetail(room.id, 1);
            }),
          );
          remoteRooms = listedRooms
            .flatMap((listedRoom, index) => {
              const result = detailResults[index];
              if (result?.status === 'fulfilled') {
                const detailRoom = mapListenTogetherRoom(
                  (result.value as { data?: unknown })?.data ?? result.value,
                  listedRoom,
                  1,
                );
                if (detailRoom.closed) {
                  rememberDissolvedRoom(listedRoom);
                  return [];
                }
                return [detailRoom];
              }
              if (result?.status === 'rejected' && isDissolvedRoomError(result.reason)) {
                rememberDissolvedRoom(listedRoom);
                return [];
              }
              return [listedRoom];
            })
            .map(normalizeOwnedRoom);
        } else {
          const historyPayload = await getListenTogetherMusicRoomHistory();
          const historyRooms = Array.from(
            new Map(
              mapListenTogetherRoomList(historyPayload, 0)
                .filter((room) => !isKnownDissolvedRoom(room))
                .map((room) => [room.id, room]),
            ).values(),
          ).slice(0, 20);
          const detailResults = await Promise.allSettled(
            historyRooms.map(async (historyRoom) => {
              assertRoomIsLive(await getListenTogetherRoomState(historyRoom.id, 0));
              const detailPayload = await getListenTogetherRoomDetail(historyRoom.id, 0);
              return mapListenTogetherRoom(
                (detailPayload as { data?: unknown })?.data ?? detailPayload,
                historyRoom,
                0,
              );
            }),
          );
          remoteRooms = historyRooms
            .flatMap((historyRoom, index) => {
              const result = detailResults[index];
              if (result?.status === 'fulfilled') {
                if (result.value.closed) {
                  rememberDissolvedRoom(historyRoom);
                  return [];
                }
                return [result.value];
              }
              if (result?.status === 'rejected' && isDissolvedRoomError(result.reason)) {
                rememberDissolvedRoom(historyRoom);
                return [];
              }
              return [historyRoom];
            })
            .filter((room) => room.ownerId === userId)
            .map(normalizeOwnedRoom);
        }

        // 刷新“我的房间”时远端结果是权威快照。本地索引只额外保留当前仍在进行的会话，
        // 不再把已经从远端消失的历史房间重新回填到页面。
        const liveRoomIds = new Set(remoteRooms.map((room) => room.id));
        if (
          activeRoomId.value &&
          activeRoomType.value === roomType &&
          activeRoom.value?.ownerId === userId
        ) {
          liveRoomIds.add(activeRoomId.value);
        }
        const staleRoomIds = new Set(
          ownedRoomIndex.value
            .filter(
              (room) =>
                room.ownerId === userId && room.roomType === roomType && !liveRoomIds.has(room.id),
            )
            .map((room) => room.id),
        );
        ownedRoomIndex.value = ownedRoomIndex.value.filter(
          (room) =>
            room.ownerId !== userId || room.roomType !== roomType || liveRoomIds.has(room.id),
        );
        if (staleRoomIds.size) {
          rooms.value = rooms.value.filter(
            (room) => room.roomType !== roomType || !staleRoomIds.has(room.id),
          );
        }
        remoteRooms.forEach(upsertOwnedRoom);
        const nextRooms = ownedRoomIndex.value
          .filter((room) => room.ownerId === userId && room.roomType === roomType)
          .map(normalizeOwnedRoom);
        ownedRooms.value = [
          ...ownedRooms.value.filter((room) => room.roomType !== roomType),
          ...nextRooms,
        ];
        lastError.value = '';
      } catch (error) {
        lastError.value = getErrorMessage(error);
        throw error;
      } finally {
        loadingOwnedRooms.value = false;
      }
    };

    const dismissOwnedRoom = async (room: ListenTogetherRoom) => {
      requireLogin();
      if (room.roomType === 1) {
        await deleteCreatedListenTogetherStudyRoom(room.id, room.channelId);
      } else {
        await dismissListenTogetherRoom(room.id, room.roomType);
      }
      rememberDissolvedRoom(room);
      removeOwnedRoom(room);
      toastStore.success(`已解散「${room.name}」`);
    };

    const loadRoomMemberList = async (
      roomId: string,
      roomType: ListenTogetherRoomType,
      pageSize = 100,
    ): Promise<ListenTogetherMember[]> => {
      if (roomType === 0) {
        return mapListenTogetherMemberList(
          await getListenTogetherMembers(roomId, roomType, pageSize),
        );
      }

      const results = await Promise.allSettled([
        getListenTogetherMembers(roomId, roomType, pageSize, 1),
        getListenTogetherMembers(roomId, roomType, pageSize, 2),
      ]);
      const onlineMembers = new Map<string, ListenTogetherMember>();
      const lookerResult = results[1];
      if (lookerResult?.status === 'fulfilled') {
        mapListenTogetherMemberList(lookerResult.value, 2).forEach((member) => {
          onlineMembers.set(member.userId, member);
        });
      }
      const studyResult = results[0];
      if (studyResult?.status === 'fulfilled') {
        // 同一用户可能恰逢状态切换而同时出现在两份快照中，学习中状态优先。
        mapListenTogetherMemberList(studyResult.value, 1).forEach((member) => {
          onlineMembers.set(member.userId, member);
        });
      }
      if (!onlineMembers.size && results.every((result) => result.status === 'rejected')) {
        const rejected = results.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        throw rejected?.reason;
      }
      return Array.from(onlineMembers.values());
    };

    const inspectRoom = async (room: ListenTogetherRoom) => {
      loadingPreview.value = true;
      lastError.value = '';
      // 分享参数和列表卡片只用于定位房间，不能在状态校验前当作有效详情展示。
      previewRoom.value = null;
      previewMembers.value = [];
      try {
        const [stateResult, detailResult, memberResult] = await Promise.allSettled([
          getListenTogetherRoomState(room.id, room.roomType),
          getListenTogetherRoomDetail(room.id, room.roomType),
          loadRoomMemberList(room.id, room.roomType, 20),
        ]);
        if (stateResult.status === 'fulfilled') {
          try {
            assertRoomIsLive(stateResult.value);
          } catch (error) {
            rememberDissolvedRoom(room);
            rooms.value = rooms.value.filter(
              (item) => !(item.id === room.id && item.roomType === room.roomType),
            );
            removeOwnedRoom(room);
            closePreview();
            lastError.value = '房间已解散，已从列表移除';
            throw error;
          }
        } else if (isDissolvedRoomError(stateResult.reason)) {
          rememberDissolvedRoom(room);
          rooms.value = rooms.value.filter(
            (item) => !(item.id === room.id && item.roomType === room.roomType),
          );
          removeOwnedRoom(room);
          closePreview();
          lastError.value = '房间已解散，已从列表移除';
          throw stateResult.reason;
        } else {
          throw stateResult.reason;
        }
        if (detailResult.status === 'fulfilled') {
          const detailRoom = mapListenTogetherRoom(
            (detailResult.value as { data?: unknown })?.data ?? detailResult.value,
            room,
          );
          if (detailRoom.closed) {
            rememberDissolvedRoom(room);
            rooms.value = rooms.value.filter(
              (item) => !(item.id === room.id && item.roomType === room.roomType),
            );
            removeOwnedRoom(room);
            closePreview();
            lastError.value = detailRoom.closeReason || '房间已解散，已从列表移除';
            throw new ListenTogetherApiError(lastError.value, 20005, detailResult.value);
          }
          previewRoom.value = detailRoom;
        } else if (isDissolvedRoomError(detailResult.reason)) {
          rememberDissolvedRoom(room);
          rooms.value = rooms.value.filter(
            (item) => !(item.id === room.id && item.roomType === room.roomType),
          );
          removeOwnedRoom(room);
          closePreview();
          lastError.value = '房间已解散，已从列表移除';
          throw detailResult.reason;
        } else {
          throw detailResult.reason;
        }
        if (memberResult.status === 'fulfilled') {
          previewMembers.value = memberResult.value;
        }
        lastError.value = '';
      } catch (error) {
        previewRoom.value = null;
        previewMembers.value = [];
        if (!lastError.value) lastError.value = getErrorMessage(error);
        throw error;
      } finally {
        loadingPreview.value = false;
      }
    };

    const inspectRoomById = async (
      roomId: string,
      roomType: ListenTogetherRoomType,
      roomName = '一起听房间',
    ) => {
      // 这里的 roomType 是 EchoMusic 的房间大类，不能写进上游自习室内部的 room_type。
      const room = mapListenTogetherRoom(
        {
          room_id: roomId,
          room_name: roomName,
        },
        null,
        roomType,
      );
      await inspectRoom(room);
    };

    const closePreview = () => {
      previewRoom.value = null;
      previewMembers.value = [];
      loadingPreview.value = false;
    };

    const loadActiveRoomDetail = async () => {
      const roomId = activeRoomId.value;
      if (!roomId) return;
      const payload = await getListenTogetherRoomDetail(roomId, activeRoomType.value);
      const base = activeRoom.value ?? rooms.value.find((room) => room.id === roomId) ?? null;
      activeRoom.value = mapListenTogetherRoom(
        (payload as { data?: unknown })?.data ?? payload,
        base,
      );
    };

    const loadMembers = async () => {
      const roomId = activeRoomId.value;
      if (!roomId) return;
      members.value = await loadRoomMemberList(roomId, activeRoomType.value);
    };

    const loadMessages = async () => {
      const roomId = activeRoomId.value;
      if (!roomId) return;
      const nextMessages = mapListenTogetherMessageList(
        await getListenTogetherMessages(roomId, activeRoomType.value),
      );
      messages.value = Array.from(
        new Map(
          [...messages.value, ...nextMessages].map((message) => [message.id, message]),
        ).values(),
      )
        .sort((left, right) => left.sentAt - right.sentAt)
        .slice(-200);
    };

    const loadRoomSongsInternal = async (
      roomId: string,
      roomType: ListenTogetherRoomType,
      force = false,
    ) => {
      if (!roomId || Date.now() < roomSongsRetryAfter) return;
      const loadRevision = ++roomSongsLoadRevision;
      const isCurrentLoad = () =>
        activeRoomId.value === roomId &&
        activeRoomType.value === roomType &&
        roomSongsLoadRevision === loadRevision;
      const fallbackAudios = roomSongs.value.length
        ? roomSongs.value
        : (activeRoom.value?.audios ?? []);
      const enrichSongs = async (songs: Song[]) => {
        const unresolvedSongs = songs.filter(
          (song) =>
            (!song.title ||
              !song.artist ||
              !isUsefulSongCover(song.coverUrl || song.cover) ||
              !song.albumName ||
              !firstUsableSongId(song.albumAudioId, song.mixSongId) ||
              (/^房间歌曲 \d+$/.test(song.title) && song.artist === '一起听')) &&
            ![song.hash, song.originalHash].every((hash) =>
              metadataLookupAttempted.has(String(hash ?? '').toLowerCase()),
            ),
        );
        const unresolvedHashes = unresolvedSongs
          .flatMap((song) => [song.hash, song.originalHash])
          .filter(
            (hash): hash is string =>
              Boolean(hash) && !metadataLookupAttempted.has(String(hash).toLowerCase()),
          )
          .map(String);
        if (!unresolvedHashes.length) return songs;
        unresolvedHashes.forEach((hash) => metadataLookupAttempted.add(hash.toLowerCase()));
        try {
          return mapListenTogetherSongList(await getAudioMetadata(unresolvedHashes), songs);
        } catch (error) {
          unresolvedHashes.forEach((hash) => metadataLookupAttempted.delete(hash.toLowerCase()));
          logger.warn('ListenTogether', 'Failed to enrich room song metadata', error);
          return songs;
        }
      };
      const publishSongs = (songs: Song[]) => {
        if (!songs.length || !isCurrentLoad()) return false;
        roomSongs.value = mergeRoomSongList(songs);
        syncListenTogetherQueue();
        return true;
      };
      const enrichSongsInBackground = (songs: Song[]) => {
        const snapshot = songs.slice();
        void enrichSongs(snapshot)
          .then((enrichedSongs) => {
            publishSongs(enrichedSongs);
          })
          .catch((error) => {
            logger.warn('ListenTogether', 'Background room song enrichment failed', error);
          });
      };
      try {
        const useMusicRoomRecentList = roomType === 0 && !isOwner.value;
        const firstPayload = useMusicRoomRecentList
          ? await getListenTogetherRecentPlaylist(roomId)
          : await getListenTogetherPlaylist(roomId, roomType);
        if (!isCurrentLoad()) return;
        const previousListVersion = roomListVersion.value;
        const nextListVersion = readNestedString(firstPayload, 'list_version');
        const quantity = readNestedNumber(firstPayload, 'quantity');
        const playlistPlayback = mapListenTogetherRemotePlayback(firstPayload);
        if (playlistPlayback) remotePlayback.value = playlistPlayback;
        let songs = mapListenTogetherSongList(firstPayload, fallbackAudios);
        if (nextListVersion) roomListVersion.value = nextListVersion;

        // 概念版房主端每次只返回 50 首，用本页最后一首作为 audio 游标继续拉取；
        // 听众端走 music_recent_list，响应本身就是要直接替换的近期队列，不翻页。
        const hasCompleteCurrentList =
          roomType === 0 &&
          !useMusicRoomRecentList &&
          !force &&
          Boolean(nextListVersion) &&
          nextListVersion === previousListVersion &&
          roomSongs.value.length > 0 &&
          (!quantity || roomSongs.value.length === quantity);

        if (hasCompleteCurrentList) {
          songs = roomSongs.value;
        } else {
          // 首个权威响应就是首屏可播放数据。不能等游标分页和 /audio 元数据补全
          // 全部结束后才发布，否则入房后会先看到空列表，播放器也无法立即起播。
          publishSongs(songs);
        }

        if (
          roomType === 0 &&
          !useMusicRoomRecentList &&
          !hasCompleteCurrentList &&
          songs.length >= ROOM_PLAYLIST_PAGE_SIZE
        ) {
          const seen = new Set(songs.map((song) => song.hash.toLowerCase()));
          const seenCursors = new Set<string>();
          let cursor = songs.at(-1);
          for (
            let page = 1;
            page < 20 && cursor && (!quantity || songs.length < quantity);
            page += 1
          ) {
            const cursorAudio = {
              hash: cursor.originalHash || cursor.hash,
              mixSongId:
                cursor.originalAlbumAudioId ?? cursor.mixSongId ?? cursor.albumAudioId ?? '',
            };
            const cursorKey = `${cursorAudio.hash.toLowerCase()}:${cursorAudio.mixSongId}`;
            if (seenCursors.has(cursorKey)) break;
            seenCursors.add(cursorKey);
            let payload: unknown;
            try {
              payload = await getListenTogetherPlaylist(roomId, roomType, cursorAudio);
            } catch (error) {
              // music_fetch_list 会用 30009 表示当前游标已不可继续，APP 到这里即停止翻页。
              // 已拉取的页面仍然有效，不能清空版本后从头无限重试。
              if (error instanceof ListenTogetherApiError && error.code === 30009) {
                logger.info('ListenTogether', 'Room playlist cursor reached the end', cursorKey);
                break;
              }
              throw error;
            }
            const pageSongs = mapListenTogetherSongList(payload, fallbackAudios);
            let appended = 0;
            pageSongs.forEach((song) => {
              const key = song.hash.toLowerCase();
              if (seen.has(key)) return;
              seen.add(key);
              songs.push(song);
              appended += 1;
            });
            if (appended > 0) publishSongs(songs);
            const lastSong = pageSongs.at(-1);
            if (
              !lastSong ||
              appended === 0 ||
              pageSongs.length < ROOM_PLAYLIST_PAGE_SIZE ||
              (lastSong.originalHash || lastSong.hash) === (cursor.originalHash || cursor.hash)
            )
              break;
            cursor = lastSong;
          }
        }

        // quantity 是服务端歌单的唯一权威数量。游标边界偶尔可能返回重叠项，
        // 不能让本地队列因此超过服务端数量并在下一次刷新时回落。
        if (!useMusicRoomRecentList && quantity > 0 && songs.length > quantity) {
          songs = songs.slice(0, quantity);
        }

        if (songs.length) {
          publishSongs(songs);
          // 封面、专辑、歌词定位所需的元数据只增强列表，不决定列表是否可见。
          // 用加载修订号隔离后台结果，避免离房或下一轮刷新后旧请求覆盖新队列。
          enrichSongsInBackground(songs);
        }
      } catch (error) {
        if (!isCurrentLoad()) return;
        if (error instanceof ListenTogetherApiError && error.code === 30009) {
          roomSongsRetryAfter = Date.now() + 60_000;
          logger.warn('ListenTogether', 'Room playlist temporarily rejected, backing off', error);
          if (roomSongs.value.length) {
            syncListenTogetherQueue();
            return;
          }
        }
        const fallbackSongs = mapListenTogetherSongList(null, fallbackAudios);
        if (!fallbackSongs.length) throw error;
        publishSongs(fallbackSongs);
        enrichSongsInBackground(fallbackSongs);
        logger.warn('ListenTogether', 'Using room detail audio fallback', error);
      }
    };

    const loadRoomSongs = async (force = false) => {
      const roomId = activeRoomId.value;
      const roomType = activeRoomType.value;
      if (!roomId) return;
      const roomKey = `${roomType}:${roomId}`;
      if (roomSongsLoadInFlight?.roomKey === roomKey) return roomSongsLoadInFlight.promise;
      const request = {
        roomKey,
        promise: loadRoomSongsInternal(roomId, roomType, force),
      };
      roomSongsLoadInFlight = request;
      try {
        await request.promise;
      } finally {
        if (roomSongsLoadInFlight === request) roomSongsLoadInFlight = null;
      }
    };

    const refreshRoomSongs = async () => {
      const roomKey = `${activeRoomType.value}:${activeRoomId.value}`;
      if (roomSongsLoadInFlight?.roomKey === roomKey) {
        await roomSongsLoadInFlight.promise;
        // 已有请求就是最新一轮刷新，不再紧接着重复请求一次。
        return;
      }
      // 手动刷新必须重新校验元数据，否则本会话早先缓存的频道图/残缺信息
      // 会被 metadataLookupAttempted 判定为“已补全”，点击刷新也无法恢复。
      metadataLookupAttempted.clear();
      roomSongsRetryAfter = 0;
      await loadRoomSongs(true);
    };

    const loadSongOrders = async () => {
      const roomId = activeRoomId.value;
      if (!roomId || activeRoomType.value !== 0 || !isOwner.value || loadingSongOrders.value)
        return;
      loadingSongOrders.value = true;
      try {
        songOrders.value = mapListenTogetherSongOrders(await getListenTogetherSongOrders(roomId));
      } finally {
        loadingSongOrders.value = false;
      }
    };

    const currentMusicRoomProgress = () => {
      const remote = remotePlayback.value;
      const current = currentRoomSong.value;
      if (!current?.hash) return undefined;
      return {
        hash: current.hash,
        album_audio_id: current.mixSongId ?? current.albumAudioId ?? remote?.mixSongId ?? '',
        progress: Math.max(0, Math.floor(playerStore.currentTime || remote?.position || 0)),
        pause: playerStore.isPlaying || remote?.playing ? 1 : 2,
        play_mode:
          playerStore.playMode === 'single' ? '2' : playerStore.playMode === 'random' ? '3' : '1',
      };
    };

    const addRoomSong = async (song: Song, requesterId = '') => {
      requireLogin();
      if (
        !joined.value ||
        !activeRoomId.value ||
        activeRoomType.value !== 0 ||
        !isOwner.value ||
        !song.hash ||
        requestingSongHash.value
      ) {
        return;
      }
      requestingSongHash.value = song.hash;
      try {
        const payload = await addListenTogetherMusicRoomSongs(
          activeRoomId.value,
          [{ hash: song.hash, mixSongId: song.mixSongId ?? song.albumAudioId ?? '' }],
          {
            action: requesterId ? 4 : 1,
            listVersion: roomListVersion.value,
            progressInfo: currentMusicRoomProgress(),
            requesterId,
          },
        );
        const nextListVersion = readNestedString(payload, 'list_version');
        if (nextListVersion) roomListVersion.value = nextListVersion;
        await Promise.allSettled([loadRoomSongs(true), loadSongOrders()]);
        toastStore.success(`已将「${song.title}」加入房间歌单`);
      } finally {
        requestingSongHash.value = '';
      }
    };

    const approveSongOrder = async (order: ListenTogetherSongOrder) => {
      if (handlingSongOrderId.value) return;
      handlingSongOrderId.value = order.id;
      try {
        await addRoomSong(order.song, order.requesterId);
      } finally {
        handlingSongOrderId.value = '';
      }
    };

    const removeSongOrder = async (order: ListenTogetherSongOrder) => {
      requireLogin();
      if (
        !joined.value ||
        !activeRoomId.value ||
        activeRoomType.value !== 0 ||
        !isOwner.value ||
        handlingSongOrderId.value
      ) {
        return;
      }
      handlingSongOrderId.value = order.id;
      try {
        await removeListenTogetherSongOrder(
          activeRoomId.value,
          {
            hash: order.song.hash,
            mixSongId: order.song.mixSongId ?? order.song.albumAudioId ?? '',
          },
          order.requesterId,
        );
        songOrders.value = songOrders.value.filter((item) => item.id !== order.id);
        toastStore.info('已忽略这条点歌请求');
      } finally {
        handlingSongOrderId.value = '';
      }
    };

    const applyRemotePlayback = async (force = false) => {
      const remote = remotePlayback.value;
      if (!remote || applyingPlayback || !activeRoomId.value) return;
      let song = findRemoteRoomSong(remote);
      if (!song && activeRoomType.value === 0 && !roomSongs.value.length) {
        // 首次入房时 sync_player 可能先返回；只等待正在加载的队列。后续是否刷新
        // 由 list_version 决定，不能因无法匹配而在每次播放轮询中强制 fetch_list。
        await loadRoomSongs();
        song = findRemoteRoomSong(remote);
      }
      if (!song && activeRoomType.value === 0) {
        // APP 只在服务端返回的队列中定位当前曲目。sync_player 的曲目不属于歌单时
        // 不能额外插入，否则下一次权威列表覆盖时就会形成 50/51 来回跳。
        const missingSongKey = `${roomListVersion.value}:${remote.hash.toLowerCase()}:${remote.mixSongId}`;
        if (lastMissingRemoteSongKey !== missingSongKey) {
          lastMissingRemoteSongKey = missingSongKey;
          logger.warn('ListenTogether', 'Remote song is not present in the server playlist', {
            hash: remote.hash,
            mixSongId: remote.mixSongId,
            listVersion: roomListVersion.value,
          });
        }
      }
      if (!song) return;
      lastMissingRemoteSongKey = '';

      // 可能有多个首次同步调用同时在等待歌单；等待结束后必须再次检查，避免它们
      // 同时进入 playTrack，反复替换同一个原生音源。
      if (applyingPlayback) return;

      applyingPlayback = true;
      try {
        const suppressAppliedPlayerEvents = () => {
          // playerStore 的生命周期事件由 Vue watcher 延迟派发，届时 applyingPlayback
          // 可能已经复位。单独标记远端产生的事件，避免被当成本地控制再次回正/上报。
          suppressAppliedPlayerEventsUntil = Date.now() + 300;
        };
        const seekToRemotePosition = (position: number) => {
          const seekKey = [
            activeRoomId.value,
            remote.hash.toLowerCase(),
            remote.updatedAt,
            position.toFixed(3),
          ].join(':');
          const now = Date.now();
          // 同一份远端快照可能被 seek 事件回调再次应用；原生播放器尚未回报新进度时
          // drift 仍会很大，必须在调用 seek 之前登记，保证这条命令是幂等的。
          if (seekKey === lastAppliedRemoteSeekKey && now - lastAppliedRemoteSeekAt < 2_000) {
            return;
          }
          lastAppliedRemoteSeekKey = seekKey;
          lastAppliedRemoteSeekAt = now;
          suppressAppliedPlayerEvents();
          playerStore.seek(position);
        };

        syncListenTogetherQueue();
        playlistStore.updateQueueCurrentTrack(song.id, LISTEN_TOGETHER_QUEUE_ID);
        playerStore.currentSourceQueueId = LISTEN_TOGETHER_QUEUE_ID;
        playerStore.currentPlaylist = roomSongs.value;
        const currentHash = String(playerStore.currentTrackSnapshot?.hash ?? '').toLowerCase();
        const currentTrackMatches =
          currentHash === song.hash.toLowerCase() &&
          String(playerStore.currentTrackId ?? '') === String(song.id);
        const trackChanged =
          !currentTrackMatches || (!playerStore.currentAudioUrl && !playerStore.isLoading);
        const useRemotePosition = isRemotePositionForSong(remote, song);
        const expectedPosition = Math.max(
          0,
          useRemotePosition
            ? remote.position + (remote.playing ? (Date.now() - remote.updatedAt) / 1000 : 0)
            : 0,
        );
        const preserveGuestPause = !isOwner.value && guestLocallyPaused;
        const shouldPlayLocally = remote.playing && !preserveGuestPause;
        if (trackChanged) {
          suppressAppliedPlayerEvents();
          await playerStore.playTrack(song.id, roomSongs.value, {
            autoPlay: shouldPlayLocally,
            sourceQueueId: LISTEN_TOGETHER_QUEUE_ID,
          });
          if (expectedPosition > 1) seekToRemotePosition(expectedPosition);
          return;
        }

        const now = Date.now();
        const localPositionUpdatedAt = Number(playerStore.currentTimeUpdatedAt || now);
        // 原生 seek 后的首个 time-update 可能晚于下一轮房间同步。用本地播放时钟
        // 对最近位置做短时投影，避免服务端每增加 5 秒就再次 seek，导致解码器反复重启。
        const localClockProjection =
          shouldPlayLocally && playerStore.isPlaying
            ? Math.min(
                Math.max(0, (now - localPositionUpdatedAt) / 1000),
                FAST_POLL_INTERVAL / 1000 + 1,
              )
            : 0;
        const projectedLocalPosition = Number(playerStore.currentTime || 0) + localClockProjection;
        const drift = Math.abs(projectedLocalPosition - expectedPosition);
        // force 表示使用更严格的容差，而不是无条件 seek。无条件 seek 会触发播放器
        // 的 seek 事件，访客恢复逻辑收到该事件后再次 force seek，形成响应式死循环。
        // 正常播放允许一个轮询周期以上的抖动；暂停态仍按较小误差校准。
        const driftTolerance = force ? 0.75 : shouldPlayLocally ? 8 : 1.5;
        if (
          !preserveGuestPause &&
          drift > driftTolerance &&
          !playerStore.isLoading &&
          expectedPosition > 0
        ) {
          seekToRemotePosition(expectedPosition);
        }
        if (!playerStore.isLoading && shouldPlayLocally !== playerStore.isPlaying) {
          suppressAppliedPlayerEvents();
          await playerStore.togglePlay();
        }
      } finally {
        applyingPlayback = false;
      }
    };

    const syncPlayback = async (force = false) => {
      const roomId = activeRoomId.value;
      if (!roomId) return;
      // 房主也要接收服务端最终状态，否则同一账号在手机和电脑上会形成两个播放源。
      // 本机控制刚发出时短暂跳过普通轮询，防止尚未完成的旧请求把操作立即覆盖。
      if (
        !force &&
        activeRoomType.value === 0 &&
        isOwner.value &&
        Date.now() < ownerControlGraceUntil
      ) {
        return;
      }
      const requestedRevision = ownerControlRevision;
      const payload = await syncListenTogetherPlayer(roomId, activeRoomType.value);
      const mapped = mapListenTogetherRemotePlayback(payload);
      if (activeRoomId.value !== roomId) return;
      if (
        !force &&
        activeRoomType.value === 0 &&
        isOwner.value &&
        requestedRevision !== ownerControlRevision
      ) {
        return;
      }
      const syncedListVersion = readNestedString(payload, 'list_version');
      if (
        activeRoomType.value === 0 &&
        syncedListVersion &&
        syncedListVersion !== roomListVersion.value
      ) {
        await loadRoomSongs(true);
        if (activeRoomId.value !== roomId) return;
      }
      if (mapped && (!remotePlayback.value || mapped.updatedAt >= remotePlayback.value.updatedAt)) {
        // 手动同步、定时轮询和入房初始化可能并发返回；旧快照不能覆盖新状态。
        remotePlayback.value = mapped;
      }
      if (!remotePlayback.value) return;
      await applyRemotePlayback(force);
    };

    const fastPoll = async () => {
      if (!joined.value || fastPollInFlight) return;
      fastPollInFlight = true;
      try {
        await Promise.allSettled([loadMessages(), syncPlayback()]);
      } finally {
        fastPollInFlight = false;
      }
    };

    const slowPoll = async () => {
      if (!joined.value || slowPollInFlight) return;
      slowPollInFlight = true;
      try {
        await Promise.allSettled([
          loadActiveRoomDetail(),
          loadMembers(),
          // 自习室的 sync_player 不提供众乐房那套 list_version 变更通知，
          // 因此仍需定期获取权威歌单；众乐房只在版本变化时刷新。
          ...(activeRoomType.value === 1 ? [loadRoomSongs()] : []),
          loadSongOrders(),
        ]);
      } finally {
        slowPollInFlight = false;
      }
    };

    const heartbeat = async () => {
      if (!joined.value || heartbeatInFlight) return;
      heartbeatInFlight = true;
      try {
        await heartbeatListenTogetherRoom(activeRoomId.value, activeRoomType.value);
        heartbeatFailureCount = 0;
      } catch (error) {
        heartbeatFailureCount += 1;
        logger.warn('ListenTogether', 'Heartbeat failed', error);
        if (heartbeatFailureCount >= 3) {
          lastError.value = '房间连接不稳定，正在继续重试';
        }
      } finally {
        heartbeatInFlight = false;
      }
    };

    const startSessionTimers = () => {
      clearSessionTimers();
      heartbeatTimer = window.setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL);
      fastPollTimer = window.setInterval(() => void fastPoll(), FAST_POLL_INTERVAL);
      slowPollTimer = window.setInterval(() => void slowPoll(), SLOW_POLL_INTERVAL);
    };

    const hydrateSession = async (
      roomId: string,
      base?: ListenTogetherRoom | null,
      options: { verifyInitialRoomState?: boolean } = {},
    ) => {
      capturePreviousPlaybackQueue();
      activeRoomId.value = roomId;
      activeRoom.value = base ?? rooms.value.find((room) => room.id === roomId) ?? null;
      loadingRoom.value = true;
      phase.value = 'joined';
      startSessionTimers();
      try {
        // 播放状态和歌单是进入房间后的核心数据，立即并行请求；成员、聊天和点歌
        // 在后台补齐，不能阻塞播放器首次同步。
        const coreHydration = Promise.allSettled([loadRoomSongs(), syncPlayback(true)]);
        const peripheralHydration = Promise.allSettled([
          loadActiveRoomDetail(),
          loadMembers(),
          loadMessages(),
          loadSongOrders(),
        ]);
        const coreResults = await coreHydration;
        const initialSyncResult = coreResults[1];
        if (initialSyncResult?.status === 'rejected') {
          logger.warn('ListenTogether', 'Initial playback sync failed', initialSyncResult.reason);
        }
        if (activeRoomId.value !== roomId) return;
        syncListenTogetherQueue();
        if (!remotePlayback.value && activeRoomType.value === 1 && roomSongs.value[0]) {
          const firstSong = roomSongs.value[0];
          remotePlayback.value = {
            hash: firstSong.hash,
            mixSongId: firstSong.mixSongId ?? firstSong.albumAudioId ?? '',
            position: 0,
            playing: true,
            updatedAt: Date.now(),
          };
        }
        await applyRemotePlayback(true);
        if (options.verifyInitialRoomState && activeRoomType.value === 1) {
          initialRoomStateVerifyTimer = window.setTimeout(() => {
            initialRoomStateVerifyTimer = null;
            if (activeRoomId.value !== roomId || !joined.value) return;
            void (async () => {
              // make_room 的歌单写入与播放器状态可能短暂晚于创建响应，二者一起复核，
              // 避免首次 fetch_list 读到旧快照后等待 15 秒慢轮询。
              await loadRoomSongs();
              if (activeRoomId.value !== roomId) return;
              await syncPlayback(true);
            })().catch((error) => {
              logger.warn('ListenTogether', 'Initial study room state verification failed', error);
            });
          }, 600);
        }
        void peripheralHydration;
        lastError.value = '';
      } finally {
        if (activeRoomId.value === roomId) loadingRoom.value = false;
      }
    };

    const joinRoom = async (room: ListenTogetherRoom) => {
      requireLogin();
      if (joined.value && activeRoomId.value === room.id) return;
      if (activeRoomId.value) await leaveRoom({ silent: true });
      phase.value = 'joining';
      lastError.value = '';
      try {
        await joinListenTogetherRoom(room.id, room.roomType);
        forgetDissolvedRoom(room);
        // 服务端确认入房后立即进入会话，详情、歌单和播放状态在房间页后台补齐。
        const hydration = hydrateSession(room.id, room);
        closePreview();
        toastStore.success(`已加入「${room.name}」`);
        void hydration.catch((error) => {
          logger.warn('ListenTogether', 'Background room hydration failed', error);
          if (activeRoomId.value === room.id) lastError.value = getErrorMessage(error);
        });
      } catch (error) {
        clearSessionTimers();
        restorePreviousPlaybackQueue();
        activeRoomId.value = '';
        activeRoom.value = null;
        if (isDissolvedRoomError(error)) {
          rememberDissolvedRoom(room);
          rooms.value = rooms.value.filter(
            (item) => !(item.id === room.id && item.roomType === room.roomType),
          );
          removeOwnedRoom(room);
          closePreview();
          phase.value = 'idle';
        } else {
          phase.value = 'error';
        }
        lastError.value = getErrorMessage(error);
        throw error;
      }
    };

    const leaveRoom = async (options: { silent?: boolean; dismiss?: boolean } = {}) => {
      const roomId = activeRoomId.value;
      if (!roomId) {
        resetSessionState();
        return;
      }
      phase.value = 'leaving';
      const roomType = activeRoomType.value;
      clearSessionTimers();
      let leaveError: unknown = null;
      try {
        if (userStore.isLoggedIn) {
          if (options.dismiss) await dismissListenTogetherRoom(roomId, roomType);
          else await leaveListenTogetherRoom(roomId, roomType);
        }
      } catch (error) {
        leaveError = error;
        logger.warn('ListenTogether', 'Leave room failed', error);
      } finally {
        const roomName = activeRoom.value?.name || '一起听房间';
        resetSessionState();
        if (!options.silent) {
          if (leaveError) toastStore.warning('已退出本地会话，但服务端未确认离房');
          else toastStore.info(options.dismiss ? `已解散「${roomName}」` : `已离开「${roomName}」`);
        }
      }
    };

    const createRoom = async (input: ListenTogetherCreateInput, initialSongs: Song[] = []) => {
      requireLogin();
      if (!input.name.trim() || input.audios.length === 0) {
        throw new ListenTogetherApiError('请填写房间名并准备至少一首歌');
      }
      if (input.roomType === 1 && !input.channelId) {
        throw new ListenTogetherApiError('创建自习室前请选择音乐频道');
      }
      if (activeRoomId.value) await leaveRoom({ silent: true });
      phase.value = 'creating';
      lastError.value = '';
      let createdRoomId = '';
      const normalizedInput = {
        ...input,
        name: input.name.trim(),
        notice: input.notice.trim(),
      } as ListenTogetherCreateInput;
      try {
        if (normalizedInput.roomType === 1) {
          await checkListenTogetherMinor();
        }
        const createPayload = await createListenTogetherGroup(normalizedInput);
        createdRoomId = extractListenTogetherRoomId(createPayload);
        if (!createdRoomId) throw new ListenTogetherApiError('服务端未返回新房间 ID');
        forgetDissolvedRoom({ id: createdRoomId, roomType: normalizedInput.roomType });
        if (normalizedInput.roomType === 1) {
          await configureListenTogetherRoom(createdRoomId, normalizedInput);
        } else {
          await initializeListenTogetherMusicRoom(createdRoomId, normalizedInput);
        }
        const base = mapListenTogetherRoom({
          room_id: createdRoomId,
          room_name: normalizedInput.name,
          room_notice: normalizedInput.notice,
          room_type: normalizedInput.roomType,
          study_room_kind: normalizedInput.roomType === 1 ? 'community' : undefined,
          global_collection_id: normalizedInput.roomType === 1 ? normalizedInput.channelId : '',
          allow_chat: normalizedInput.roomType === 1 ? (normalizedInput.allowChat ? 1 : 0) : 1,
          userid: currentUserId.value,
          nick_name: userStore.info?.nickname,
          user_pic: userStore.info?.pic,
          audios: normalizedInput.audios,
        });
        upsertOwnedRoom(base);
        const localSongs = initialSongs.length
          ? initialSongs
          : ((playerStore.currentPlaylist?.length
              ? playerStore.currentPlaylist
              : playerStore.currentTrackSnapshot
                ? [playerStore.currentTrackSnapshot]
                : []) as Song[]);
        const localSongsByHash = new Map(
          localSongs.map((song) => [song.hash.toLowerCase(), song] as const),
        );
        roomSongs.value = normalizedInput.audios
          .map((audio) => localSongsByHash.get(audio.hash.toLowerCase()))
          .filter((song): song is Song => Boolean(song));
        await hydrateSession(createdRoomId, base, {
          verifyInitialRoomState: normalizedInput.roomType === 1,
        });
        toastStore.success(`「${normalizedInput.name}」已创建`);
        return createdRoomId;
      } catch (error) {
        if (createdRoomId) {
          await dismissListenTogetherRoom(createdRoomId, normalizedInput.roomType).catch(
            (cleanupError) => {
              logger.warn('ListenTogether', 'Failed to clean up incomplete room', cleanupError);
            },
          );
          removeOwnedRoom({ id: createdRoomId, roomType: normalizedInput.roomType });
        }
        clearSessionTimers();
        restorePreviousPlaybackQueue();
        activeRoomId.value = '';
        activeRoom.value = null;
        roomSongs.value = [];
        phase.value = 'error';
        lastError.value = getErrorMessage(error);
        throw error;
      }
    };

    const searchChannels = async (keyword: string) => {
      const normalized = keyword.trim();
      if (!normalized || searchingChannels.value) return;
      searchingChannels.value = true;
      try {
        channelResults.value = mapListenTogetherChannelList(
          await searchListenTogetherChannels(normalized),
        );
      } finally {
        searchingChannels.value = false;
      }
    };

    const sendMessage = async (message: string) => {
      requireLogin();
      const normalized = message.trim();
      if (!joined.value || !activeRoomId.value || !normalized || sendingMessage.value) return;
      if (!activeRoom.value?.allowChat) {
        throw new ListenTogetherApiError('当前房间已关闭聊天');
      }
      sendingMessage.value = true;
      try {
        await sendListenTogetherMessage(
          activeRoomId.value,
          activeRoomType.value,
          normalized.slice(0, 200),
          {
            nickname: userStore.info?.nickname,
            avatarUrl: userStore.info?.pic,
          },
        );
        await loadMessages();
      } finally {
        sendingMessage.value = false;
      }
    };

    const requestSong = async (song: Song) => {
      if (activeRoomType.value !== 0) return;
      requireLogin();
      if (!joined.value || !activeRoomId.value || !song.hash || requestingSongHash.value) return;
      requestingSongHash.value = song.hash;
      try {
        await requestListenTogetherSong(activeRoomId.value, {
          hash: song.hash,
          mixSongId: song.mixSongId ?? song.albumAudioId ?? '',
        });
        toastStore.success(`已点播「${song.title}」，等待房主允许加歌`);
      } finally {
        requestingSongHash.value = '';
      }
    };

    const canPublishOwnerPlayback = () =>
      joined.value &&
      activeRoomType.value === 0 &&
      isOwner.value &&
      playerStore.currentSourceQueueId === LISTEN_TOGETHER_QUEUE_ID &&
      !applyingPlayback;

    const enqueueOwnerCommand = (command: () => Promise<unknown>) => {
      ownerCommandQueue = ownerCommandQueue
        .then(command, command)
        .then(() => undefined)
        .catch((error) => {
          logger.warn('ListenTogether', 'Failed to publish owner playback command', error);
          if (joined.value && isOwner.value) lastError.value = getErrorMessage(error);
        });
    };

    const restoreGuestPlayback = () => {
      if (!joined.value || isOwner.value || applyingPlayback || !remotePlayback.value) {
        return;
      }
      // 这是本地播放器事件的回正路径，不能强制无条件校准；否则远端 seek
      // 触发的本地 seek 事件会再次进入这里，造成递归更新。
      void applyRemotePlayback(false);
    };

    const publishOwnerSongSwitch = (song: Song | null, isAuto: boolean) => {
      if (!song?.hash || !canPublishOwnerPlayback()) return;
      const roomId = activeRoomId.value;
      const controlRevision = ++ownerControlRevision;
      ownerControlGraceUntil = Date.now() + 3_000;
      remotePlayback.value = {
        hash: song.hash,
        mixSongId: String(song.mixSongId ?? song.albumAudioId ?? ''),
        position: Math.max(0, Number(playerStore.currentTime || 0)),
        playing: playerStore.isPlaying,
        updatedAt: Date.now(),
      };
      enqueueOwnerCommand(async () => {
        if (activeRoomId.value !== roomId || !isOwner.value) return;
        const payload = await switchListenTogetherMusicRoomSong(
          roomId,
          { hash: song.hash, mixSongId: song.mixSongId ?? song.albumAudioId ?? '' },
          { listVersion: roomListVersion.value, isAuto },
        );
        const nextListVersion = readNestedString(payload, 'list_version');
        if (nextListVersion) roomListVersion.value = nextListVersion;
        lastError.value = '';
        if (ownerControlRevision === controlRevision) {
          ownerControlGraceUntil = 0;
          await syncPlayback();
        }
      });
    };

    const publishOwnerPlayerOperation = (
      operation:
        | { action: 1; playMode: 1 | 2 | 3 }
        | { action: 2; progress: number }
        | { action: 3; playing: boolean },
    ) => {
      if (!canPublishOwnerPlayback()) return;
      const roomId = activeRoomId.value;
      const controlRevision = ++ownerControlRevision;
      ownerControlGraceUntil = Date.now() + 3_000;
      enqueueOwnerCommand(async () => {
        if (activeRoomId.value !== roomId || !isOwner.value) return;
        const payload = await updateListenTogetherMusicRoomPlayer(roomId, operation);
        const nextListVersion = readNestedString(payload, 'list_version');
        if (nextListVersion) roomListVersion.value = nextListVersion;
        lastError.value = '';
        if (ownerControlRevision === controlRevision) {
          ownerControlGraceUntil = 0;
          await syncPlayback();
        }
      });
    };

    const playRoomSong = async (song: Song) => {
      if (!canPublishOwnerPlayback() || !song.hash) return;
      await playerStore.playTrack(song.id, roomSongs.value, {
        autoPlay: true,
        sourceQueueId: LISTEN_TOGETHER_QUEUE_ID,
      });
    };

    playerStore.onPlayerEvent('ended', () => {
      if (canPublishOwnerPlayback()) ownerAutoSwitchUntil = Date.now() + 2_000;
    });
    playerStore.onPlayerEvent('trackchange', (payload) => {
      if (!joined.value || applyingPlayback) return;
      if (Date.now() < suppressAppliedPlayerEventsUntil) return;
      if (!isOwner.value) {
        restoreGuestPlayback();
        return;
      }
      if (activeRoomType.value !== 0) return;
      publishOwnerSongSwitch(payload.track, Date.now() <= ownerAutoSwitchUntil);
      ownerAutoSwitchUntil = 0;
    });
    playerStore.onPlayerEvent('play', () => {
      if (!joined.value || applyingPlayback || Date.now() < suppressAppliedPlayerEventsUntil)
        return;
      if (!isOwner.value) {
        guestLocallyPaused = false;
        // 本机恢复播放前重新获取一次快照，避免从暂停时的旧位置继续。
        void syncPlayback(true);
      } else if (activeRoomType.value === 0) {
        publishOwnerPlayerOperation({ action: 3, playing: true });
      }
    });
    playerStore.onPlayerEvent('pause', () => {
      if (!joined.value || applyingPlayback || Date.now() < suppressAppliedPlayerEventsUntil)
        return;
      if (!isOwner.value) {
        // 听众暂停只影响本机，不修改房间状态，后续轮询也不会把它自动恢复。
        guestLocallyPaused = true;
      } else if (activeRoomType.value === 0) {
        publishOwnerPlayerOperation({ action: 3, playing: false });
      }
    });
    playerStore.onPlayerEvent('seek', (payload) => {
      if (!joined.value || applyingPlayback || Date.now() < suppressAppliedPlayerEventsUntil)
        return;
      if (!isOwner.value) restoreGuestPlayback();
      else if (activeRoomType.value === 0)
        publishOwnerPlayerOperation({
          action: 2,
          progress: Math.max(0, Math.floor(payload.currentTime || 0)),
        });
    });

    watch(
      () => playerStore.playMode,
      (playMode) => {
        publishOwnerPlayerOperation({
          action: 1,
          playMode: playMode === 'single' ? 2 : playMode === 'random' ? 3 : 1,
        });
      },
    );

    watch(
      () => [
        playerStore.currentTrackSnapshot?.id,
        playerStore.currentTrackSnapshot?.coverUrl,
        playerStore.currentTrackSnapshot?.albumName,
        playerStore.currentTrackSnapshot?.albumAudioId,
        playerStore.currentTrackSnapshot?.mixSongId,
      ],
      () => {
        const current = playerStore.currentTrackSnapshot;
        if (!current || playerStore.currentSourceQueueId !== LISTEN_TOGETHER_QUEUE_ID) return;
        const currentHashes = [current.hash, current.originalHash]
          .map((value) =>
            String(value ?? '')
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean);
        const index = roomSongs.value.findIndex(
          (song) =>
            String(song.id) === String(current.id) ||
            [song.hash, song.originalHash].some((value) =>
              currentHashes.includes(
                String(value ?? '')
                  .trim()
                  .toLowerCase(),
              ),
            ),
        );
        if (index < 0) return;
        const song = roomSongs.value[index];
        const enrichedSong = mergeRoomSongMetadata(song, current);
        roomSongs.value = roomSongs.value.map((item, itemIndex) =>
          itemIndex === index ? enrichedSong : item,
        );
        playlistStore.setPlaybackQueueWithOptions(roomSongs.value, 0, {
          ...getListenTogetherQueueOptions(),
          activate: true,
        });
        playlistStore.updateQueueCurrentTrack(enrichedSong.id, LISTEN_TOGETHER_QUEUE_ID);
        playerStore.currentPlaylist = roomSongs.value;
      },
    );

    watch(
      () => userStore.isLoggedIn,
      (isLoggedIn) => {
        if (!isLoggedIn) {
          ownedRooms.value = [];
          if (activeRoomId.value) resetSessionState();
        }
      },
    );

    return {
      rooms,
      roomsPage,
      roomsTotal,
      roomsEnded,
      roomsNotice,
      activeTagId,
      roomListType,
      loadingRooms,
      ownedRooms,
      ownedRoomIndex,
      dissolvedRoomKeys,
      loadingOwnedRooms,
      previewRoom,
      previewMembers,
      loadingPreview,
      phase,
      activeRoomId,
      activeRoom,
      members,
      messages,
      roomSongs,
      songOrders,
      loadingSongOrders,
      handlingSongOrderId,
      remotePlayback,
      currentRoomSong,
      joined,
      isOwner,
      lastError,
      loadingRoom,
      sendingMessage,
      requestingSongHash,
      channelResults,
      searchingChannels,
      loadRooms,
      loadOwnedRooms,
      dismissOwnedRoom,
      inspectRoom,
      inspectRoomById,
      closePreview,
      joinRoom,
      leaveRoom,
      createRoom,
      searchChannels,
      sendMessage,
      requestSong,
      playRoomSong,
      addRoomSong,
      approveSongOrder,
      removeSongOrder,
      loadSongOrders,
      loadMembers,
      loadMessages,
      loadRoomSongs,
      refreshRoomSongs,
      syncPlayback,
      resetSessionState,
    };
  },
  {
    persist: {
      pick: ['ownedRoomIndex', 'dissolvedRoomKeys'],
    },
  },
);
