import { useLyricStore, type LyricLine } from '@/stores/lyric';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import type { NowPlayingAppearancePayload, NowPlayingSnapshot } from '../../shared/nowPlaying';
import { portraitLyricCollapsed } from '@/views/lyric/portraitCollapseState';

/**
 * 壁纸窗口没有自己的播放引擎，画面所需的播放进度与歌词全部来自主窗口广播的快照。
 * 这里把快照写回本地 store，让歌词页（与主界面同一套皮肤和视图）照常渲染。
 */
export function connectWallpaperSync(): () => void {
  const api = window.electron?.nowPlaying;
  if (!api) return () => {};

  const playerStore = usePlayerStore();
  const lyricStore = useLyricStore();
  const settingStore = useSettingStore();
  let lyricRevision = -1;
  let disposed = false;

  // 皮肤与视图模式跟主窗口保持一致，主窗口一换肤桌面壁纸立即跟着变。
  const applyAppearance = (appearance: NowPlayingAppearancePayload) => {
    if (appearance.lyricsPageProvider)
      settingStore.lyricsPageProvider = appearance.lyricsPageProvider;
    if (appearance.lyricViewMode)
      settingStore.lyricViewMode = appearance.lyricViewMode as typeof settingStore.lyricViewMode;
    portraitLyricCollapsed.value = appearance.portraitLyricCollapsed === true;
  };

  const apply = (snapshot: NowPlayingSnapshot | null) => {
    if (disposed || !snapshot) return;
    if (snapshot.appearance) applyAppearance(snapshot.appearance);
    playerStore.applyNowPlayingMirror(snapshot.playback);
    const lyric = snapshot.lyric;
    if (!lyric || lyric.revision === lyricRevision) return;
    lyricRevision = lyric.revision;
    const lines = (lyric.lines ?? []) as unknown as LyricLine[];
    lyricStore.lines = lines;
    lyricStore.displayLines = lines;
    lyricStore.loadedHash = lyric.trackId ?? '';
    lyricStore.hasTranslation = Boolean(lyric.hasTranslation);
    lyricStore.hasRomanization = Boolean(lyric.hasRomanization);
    lyricStore.tips = lyric.tips ?? '';
    lyricStore.isLoading = Boolean(lyric.isLoading);
    // 译/音译/文字转换与歌词偏移也要镜像：少一样，壁纸里的歌词就和主界面不一致
    // （没有译文、或者整体错开半拍）。
    lyricStore.wantTranslation = Boolean(lyric.wantTranslation);
    lyricStore.wantRomanization = Boolean(lyric.wantRomanization);
    lyricStore.textConversionMode = lyric.textConversionMode;
    lyricStore.lyricSyncWarning = lyric.syncWarning === true;
    // 快照给的是主窗口叠加后的「有效偏移」；壁纸窗口不跑全局校准，直接存成该曲的单曲偏移，
    // 重复收到同一快照也只是覆盖同一个值，不会叠加。
    const offsetHash = lyric.trackId ?? '';
    const offsetMs = Math.round(Number(lyric.timeOffset) || 0);
    if (offsetHash && lyricStore.timeOffsetMap[offsetHash] !== offsetMs) {
      lyricStore.timeOffsetMap[offsetHash] = offsetMs;
    }
  };

  // 先订阅再取基线，两步之间播出的快照不会丢。
  const dispose = api.onSnapshot(apply);
  void api
    .getSnapshot()
    .then(apply)
    .catch(() => {});

  return () => {
    disposed = true;
    dispose();
  };
}
