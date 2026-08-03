import { useLyricStore } from '@/stores/lyric';
import { usePlayerStore } from '@/stores/player';
import { logger } from '@/utils/logger';

/**
 * 刷新当前播放状态
 * 在插件刷新后调用，确保歌曲、歌词、封面等信息同步
 */
export const refreshCurrentPlaybackState = () => {
  try {
    const playerStore = usePlayerStore();
    const lyricStore = useLyricStore();

    // 如果没有正在播放的歌曲，无需刷新
    if (!playerStore.currentTrackId || !playerStore.currentTrackSnapshot) {
      return;
    }

    const track = playerStore.currentTrackSnapshot;
    const lyricHash = String(track.hash ?? track.id ?? '').trim();

    // 重新加载歌词，强制刷新以确保使用最新的插件解析器
    if (lyricHash) {
      void lyricStore.fetchLyrics(lyricHash, {
        force: true,
        track,
        duration: track.duration ? track.duration * 1000 : 0,
      });
    }

    // 注意：封面的刷新会通过 coverFallbackRevision 自动触发
    // 不需要额外处理
  } catch (error) {
    logger.warn('PluginRuntime', 'Refresh current playback state failed', error);
  }
};
