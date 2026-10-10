import { watchUserSession } from '@/utils/watchUserSession';
import { useUserStore } from '@/stores/user';
import { usePlaylistStore } from '@/stores/playlist';
import { useContentBlacklistStore } from '@/stores/contentBlacklist';
import { clearCloudAudioIndex, refreshCloudAudioIndex } from '@/services/cloudAudioIndex';
import { logger } from '@/utils/logger';
import type { AppLifetime } from './lifetime';

export function useAppUserSession(lifetime: AppLifetime) {
  const userStore = useUserStore();
  const playlistStore = usePlaylistStore();
  const contentBlacklistStore = useContentBlacklistStore();
  let cloudAudioIndexWarmupTimer: number | null = null;
  const clearCloudAudioIndexWarmupTimer = () => {
    if (cloudAudioIndexWarmupTimer === null) return;
    window.clearTimeout(cloudAudioIndexWarmupTimer);
    cloudAudioIndexWarmupTimer = null;
  };

  const scheduleCloudAudioIndexWarmup = () => {
    clearCloudAudioIndexWarmupTimer();
    if (!userStore.isLoggedIn) return;
    cloudAudioIndexWarmupTimer = window.setTimeout(() => {
      cloudAudioIndexWarmupTimer = null;
      void refreshCloudAudioIndex(false).catch((error) => {
        logger.debug('App', 'Warm cloud audio index failed:', error);
      });
    }, 1500);
  };

  watchUserSession(
    userStore,
    ({ isLoggedIn: loggedIn }, previous) => {
      contentBlacklistStore.reset();
      if (previous) playlistStore.resetUserCollections();
      if (loggedIn) {
        scheduleCloudAudioIndexWarmup();
      } else {
        if (!previous) playlistStore.resetUserCollections();
        clearCloudAudioIndexWarmupTimer();
        clearCloudAudioIndex();
      }
    },
    { immediate: true, flush: 'sync' },
  );
  lifetime.add(clearCloudAudioIndexWarmupTimer);
}
