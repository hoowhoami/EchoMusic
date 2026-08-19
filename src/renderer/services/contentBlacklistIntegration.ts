import { reactive } from 'vue';
import { registerSongContextMenuExtension } from '@/components/music/songContextMenuExtensions';
import type { Song } from '@/models/song';
import { useContentBlacklistStore } from '@/stores/contentBlacklist';
import { useToastStore } from '@/stores/toast';
import { useUserStore } from '@/stores/user';
import { isSongHashId } from '@/utils/share';

const getSongHash = (song: Song): string => {
  const hash = String(song.hash ?? '')
    .trim()
    .toLowerCase();
  return isSongHashId(hash) ? hash : '';
};

const getSongName = (song: Song): string => {
  const artist = String(song.artist ?? '').trim();
  const title = String(song.name ?? song.title ?? '').trim();
  return [artist, title].filter(Boolean).join(' - ');
};

export const registerContentBlacklistIntegration = () => {
  const blacklistStore = useContentBlacklistStore();
  const toastStore = useToastStore();
  const userStore = useUserStore();
  const pendingHashes = reactive(new Set<string>());

  const getEntry = (song: Song) => {
    const hash = getSongHash(song);
    if (!hash) return undefined;
    return blacklistStore.song.entries.find(
      (entry) => entry.label === 'song' && entry.key === hash,
    );
  };

  const getStatus = (song: Song) => blacklistStore.status('song', getSongHash(song));

  const isVisible = (song: Song) => userStore.isLoggedIn && Boolean(getSongHash(song));
  const isEnabled = (song: Song) => !pendingHashes.has(getSongHash(song));

  const addSong = async (song: Song) => {
    const hash = getSongHash(song);
    if (!hash || pendingHashes.has(hash)) return;
    pendingHashes.add(hash);
    try {
      if (getStatus(song) === 'unknown') {
        const loaded = await blacklistStore.ensureFullyLoaded('song');
        if (!loaded) {
          toastStore.warning(blacklistStore.song.error || '不感兴趣列表加载失败，请稍后重试');
          return;
        }
      }
      if (getStatus(song) === 'present') {
        toastStore.info('已标记为不感兴趣，可在个人中心管理');
        return;
      }
      const success = await blacklistStore.addSong({
        hash,
        mixSongId: song.mixSongId || undefined,
        name: getSongName(song),
      });
      if (success) toastStore.actionCompleted('已标记为不感兴趣');
      else toastStore.warning(blacklistStore.song.error || '操作失败，请稍后重试');
    } finally {
      pendingHashes.delete(hash);
    }
  };

  const removeSong = async (song: Song) => {
    const hash = getSongHash(song);
    const entry = getEntry(song);
    if (!hash || !entry || pendingHashes.has(hash)) return;
    pendingHashes.add(hash);
    try {
      const success = await blacklistStore.remove(entry);
      if (success) toastStore.actionCompleted('已撤销不感兴趣');
      else toastStore.warning(blacklistStore.song.error || '撤销失败，请稍后重试');
    } finally {
      pendingHashes.delete(hash);
    }
  };

  const disposeAdd = registerSongContextMenuExtension({
    id: 'content-blacklist-add-song',
    label: '不感兴趣',
    order: 900,
    visible: (song) => isVisible(song) && getStatus(song) !== 'present',
    enabled: isEnabled,
    onSelect: addSong,
  });
  const disposeRemove = registerSongContextMenuExtension({
    id: 'content-blacklist-remove-song',
    label: '取消不感兴趣',
    order: 900,
    visible: (song) => isVisible(song) && getStatus(song) === 'present',
    enabled: isEnabled,
    onSelect: removeSong,
  });

  return () => {
    disposeAdd();
    disposeRemove();
    pendingHashes.clear();
  };
};
