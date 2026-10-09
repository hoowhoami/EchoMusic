import { watchUserSession } from '@/utils/watchUserSession';
import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import type { Playlist } from '@/models/playlist';
import type { Song } from '@/models/song';
import type { PlaybackQueueState } from '@/stores/playlist/types';
import { usePlaylistStore } from '@/stores/playlist';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import { captureUserSession } from '@/utils/userSession';

type TargetResult = {
  state: 'pending' | 'adding' | 'added' | 'exists' | 'failed';
  addedCount: number;
  failedSongs: Song[];
};

export type AddTargetKind = 'playlist' | 'queue';
export const addTargetKey = (kind: AddTargetKind, id: string | number) => `${kind}:${id}`;

const parseTargetKey = (key: string) => {
  const separator = key.indexOf(':');
  return { kind: key.slice(0, separator) as AddTargetKind, id: key.slice(separator + 1) };
};

/** 共享弹窗的多目标提交；默认单选仍交由原入口处理。 */
export function useMultiTargetAdd(options: {
  open: Ref<boolean>;
  songs: () => readonly Song[];
  playlists: () => readonly Playlist[];
  playbackQueues: () => readonly PlaybackQueueState[];
  reversePlaylistSongs: () => boolean;
  disabled: () => boolean;
  onComplete: () => void;
}) {
  const playlist = usePlaylistStore();
  const user = useUserStore();
  const toast = useToastStore();
  const multiple = ref(false);
  const selectedIds = ref(new Set<string>());
  const busy = ref(false);
  const results = ref<Record<string, TargetResult>>({});
  const progress = ref({ done: 0, total: 0 });
  const songs = shallowRef<Song[]>([]);
  let operation = 0;
  let isOpeningSessionCurrent = captureUserSession(user);

  const reset = () => {
    operation++;
    multiple.value = false;
    selectedIds.value = new Set();
    results.value = {};
    progress.value = { done: 0, total: 0 };
    busy.value = false;
  };

  // 在父组件完成全部 prop 更新后冻结歌曲，避免打开时读到上一首歌。
  watch(
    options.open,
    (open) => {
      reset();
      songs.value = open ? options.songs().map((song) => ({ ...song })) : [];
      isOpeningSessionCurrent = captureUserSession(user);
    },
    { immediate: true },
  );
  watch(
    options.open,
    (open) => {
      if (!open) {
        operation++;
        busy.value = false;
      }
    },
    { flush: 'sync' },
  );
  watchUserSession(
    user,
    () => {
      if (options.open.value) options.open.value = false;
      reset();
    },
    { flush: 'sync' },
  );
  onScopeDispose(() => operation++);

  const failedIds = computed(() =>
    Object.keys(results.value).filter((id) => results.value[id].state === 'failed'),
  );
  const hasResults = computed(() => Object.keys(results.value).length > 0);

  const toggleMode = () => {
    if (busy.value || options.disabled() || hasResults.value) return;
    multiple.value = !multiple.value;
    selectedIds.value = new Set();
  };
  const toggleTarget = (kind: AddTargetKind, id: string | number) => {
    if (busy.value || options.disabled() || hasResults.value) return;
    const next = new Set(selectedIds.value);
    const key = addTargetKey(kind, id);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selectedIds.value = next;
  };

  const submit = async (retry = false) => {
    if (
      busy.value ||
      options.disabled() ||
      !options.open.value ||
      !multiple.value ||
      !isOpeningSessionCurrent() ||
      songs.value.length === 0
    )
      return;

    const ids = retry ? failedIds.value : [...selectedIds.value];
    if (ids.length === 0 || (!retry && hasResults.value)) return;
    const targets = ids.map((key) => {
      const { kind, id } = parseTargetKey(key);
      const targetSongs = retry ? [...results.value[key].failedSongs] : [...songs.value];
      return {
        key,
        kind,
        id,
        songs:
          !retry && kind === 'playlist' && options.reversePlaylistSongs()
            ? targetSongs.reverse()
            : targetSongs,
      };
    });
    const currentOperation = ++operation;
    const generation = playlist.userCollectionsGeneration;
    const isCurrent = () =>
      currentOperation === operation &&
      options.open.value &&
      isOpeningSessionCurrent() &&
      playlist.userCollectionsGeneration === generation;

    for (const target of targets) {
      results.value[target.key] = {
        state: 'pending',
        addedCount: results.value[target.key]?.addedCount ?? 0,
        failedSongs: [],
      };
    }
    progress.value = {
      done: 0,
      total: targets.reduce((sum, target) => sum + target.songs.length, 0),
    };
    busy.value = true;
    let completedSongs = 0;

    try {
      for (const target of targets) {
        if (!isCurrent()) return;
        const previousAdded = results.value[target.key].addedCount;
        results.value[target.key].state = 'adding';
        const failedSongs: Song[] = [];
        try {
          if (target.kind === 'queue') {
            if (!options.playbackQueues().some((queue) => queue.id === target.id)) {
              throw new Error('Playback queue is no longer available');
            }
            // 历史队列可能尚未载入；载入后才能准确跳过重复歌曲。
            const queue = await playlist.ensurePlaybackQueueSongsLoaded(target.id);
            if (!isCurrent()) return;
            if (
              !queue ||
              (queue.songs.length === 0 && (queue.songCount ?? 0) > 0) ||
              !options.playbackQueues().some((entry) => entry.id === target.id)
            ) {
              throw new Error('Playback queue is no longer available');
            }
            const added = playlist.appendToPlaybackQueue(target.songs, {
              queueId: target.id,
              activate: false,
            });
            results.value[target.key] = {
              state: added > 0 ? 'added' : 'exists',
              addedCount: previousAdded + added,
              failedSongs: [],
            };
            completedSongs += target.songs.length;
            progress.value.done = completedSongs;
            continue;
          }
          if (
            !user.isLoggedIn ||
            !options.playlists().some((entry) => String(entry.listid ?? entry.id) === target.id)
          ) {
            throw new Error('Playlist is no longer available');
          }
          const result = await playlist.addSongsToPlaylist(
            target.id,
            target.songs,
            (done) => {
              if (isCurrent()) progress.value.done = completedSongs + done;
            },
            {
              checkDuplicates: true,
              isCurrent,
              onBatchResult: (batch, state) => {
                if (state === 'failed') failedSongs.push(...batch);
              },
            },
          );
          if (!isCurrent()) return;
          const addedCount = previousAdded + result.successCount;
          results.value[target.key] = {
            state: result.failedCount > 0 ? 'failed' : addedCount > 0 ? 'added' : 'exists',
            addedCount,
            failedSongs,
          };
        } catch {
          if (!isCurrent()) return;
          results.value[target.key] = {
            state: 'failed',
            addedCount: previousAdded,
            failedSongs: target.songs,
          };
        }
        completedSongs += target.songs.length;
        progress.value.done = completedSongs;
      }
      if (!isCurrent()) return;
      if (failedIds.value.length > 0) {
        const completed = Object.keys(results.value).length - failedIds.value.length;
        toast.warning(`已完成 ${completed} 个目标，${failedIds.value.length} 个目标有歌曲添加失败`);
      } else {
        const entries = Object.values(results.value);
        const addedTargets = entries.filter((result) => result.addedCount > 0).length;
        toast.actionCompleted(
          addedTargets > 0
            ? `已添加到 ${addedTargets} 个目标${entries.length > addedTargets ? '，其余目标已包含所选歌曲' : ''}`
            : '所选目标已包含这些歌曲',
        );
        options.onComplete();
      }
    } finally {
      if (currentOperation === operation) busy.value = false;
    }
  };

  return {
    multiple,
    selectedIds,
    busy,
    results,
    progress,
    songs,
    failedIds,
    hasResults,
    toggleMode,
    toggleTarget,
    submit,
  };
}
