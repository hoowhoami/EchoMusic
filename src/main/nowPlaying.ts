import { ipcRegistry } from './ipc/registry';
import { BrowserWindow } from 'electron';
import type {
  NowPlayingAppearancePayload,
  NowPlayingBroadcastPatch,
  NowPlayingLyricPayload,
  NowPlayingPlaybackPayload,
  NowPlayingSnapshot,
  NowPlayingSnapshotPatch,
} from '../shared/nowPlaying';
import {
  DEFAULT_NOW_PLAYING_APPEARANCE,
  DEFAULT_NOW_PLAYING_LYRIC,
  isNowPlayingCommand,
} from '../shared/nowPlaying';
import type { LyricLinePayload } from '../shared/lyrics';
import type { IpcContext } from './ipc/types';
import { getMainWindow } from './window';
import { isCoverPreviewEnabled, setCoverPreviewEnabled } from './taskbarThumbnail';
import { setTaskbarProgressEnabled } from './taskbarProgress';
import { updateThumbarPlayback } from './thumbar';
import { setMainAppSetting } from './storage/settings';
import { buildPlaybackClockSnapshot } from '../shared/playback';
import { normalizeLyricTextConversionMode } from '../shared/opencc';

let snapshot: NowPlayingSnapshot = {
  playback: null,
  lyric: { ...DEFAULT_NOW_PLAYING_LYRIC },
  appearance: { ...DEFAULT_NOW_PLAYING_APPEARANCE },
  updatedAt: Date.now(),
};

const visibleOnlyWindows = new WeakMap<BrowserWindow, () => boolean>();
/** 独立歌词窗口隐藏时停止高频推送，显示时补发最新状态（包含暂停期间的换歌）。 */
export function bindVisibleNowPlayingWindow(
  win: BrowserWindow,
  isAvailable: () => boolean = () => !win.isDestroyed(),
): void {
  visibleOnlyWindows.set(win, isAvailable);
  // 渲染端 reload/导航后 preload 的 merged 归零，必须让下一条广播重新走全量，
  // 否则增量 patch 会被直接当成完整快照，丢掉 lyric/appearance 等未携带字段。
  watchNowPlayingBaseline(win.webContents);
  win.on('show', () => {
    if (isAvailable() && !win.webContents.isDestroyed()) sendFullSnapshot(win.webContents);
  });
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const toFiniteNumber = (value: unknown, fallback = 0) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};

const toOptionalString = (value: unknown) => {
  const text = String(value ?? '').trim();
  return text || undefined;
};

const sanitizeLyricLine = (line: unknown): LyricLinePayload | null => {
  if (!isPlainRecord(line)) return null;
  const text = String(line.text ?? '');
  const characters = Array.isArray(line.characters)
    ? line.characters
        .map((char) => {
          if (!isPlainRecord(char)) return null;
          return {
            text: String(char.text ?? ''),
            startTime: toFiniteNumber(char.startTime),
            endTime: toFiniteNumber(char.endTime, toFiniteNumber(char.startTime)),
          };
        })
        .filter((char): char is LyricLinePayload['characters'][number] => Boolean(char))
    : [{ text, startTime: Math.round(toFiniteNumber(line.time) * 1000), endTime: 0 }];
  const rubyUnits = Array.isArray(line.rubyUnits)
    ? line.rubyUnits
        .map((unit) => {
          if (!isPlainRecord(unit)) return null;
          const chars = Array.isArray(unit.chars)
            ? unit.chars
                .map((char) => {
                  if (!isPlainRecord(char)) return null;
                  return {
                    text: String(char.text ?? ''),
                    startTime: toFiniteNumber(char.startTime),
                    endTime: toFiniteNumber(char.endTime, toFiniteNumber(char.startTime)),
                  };
                })
                .filter(
                  (
                    char,
                  ): char is NonNullable<LyricLinePayload['rubyUnits']>[number]['chars'][number] =>
                    Boolean(char),
                )
            : [];
          return {
            text: String(unit.text ?? ''),
            ruby: String(unit.ruby ?? ''),
            startTime: toFiniteNumber(unit.startTime),
            endTime: toFiniteNumber(unit.endTime, toFiniteNumber(unit.startTime)),
            charStart: Math.round(toFiniteNumber(unit.charStart)),
            chars,
          };
        })
        .filter((unit): unit is NonNullable<LyricLinePayload['rubyUnits']>[number] => Boolean(unit))
    : undefined;
  const translatedCharacters = Array.isArray(line.translatedCharacters)
    ? line.translatedCharacters
        .map((char) => {
          if (!isPlainRecord(char)) return null;
          return {
            text: String(char.text ?? ''),
            startTime: toFiniteNumber(char.startTime),
            endTime: toFiniteNumber(char.endTime, toFiniteNumber(char.startTime)),
          };
        })
        .filter((char): char is NonNullable<LyricLinePayload['translatedCharacters']>[number] =>
          Boolean(char),
        )
    : undefined;
  const romanizedCharacters = Array.isArray(line.romanizedCharacters)
    ? line.romanizedCharacters
        .map((char) => {
          if (!isPlainRecord(char)) return null;
          return {
            text: String(char.text ?? ''),
            startTime: toFiniteNumber(char.startTime),
            endTime: toFiniteNumber(char.endTime, toFiniteNumber(char.startTime)),
          };
        })
        .filter((char): char is NonNullable<LyricLinePayload['romanizedCharacters']>[number] =>
          Boolean(char),
        )
    : undefined;
  return {
    time: toFiniteNumber(line.time),
    text,
    translated: toOptionalString(line.translated),
    romanized: toOptionalString(line.romanized),
    characters,
    ...(line.charactersEstimated ? { charactersEstimated: true } : {}),
    ...(translatedCharacters?.length ? { translatedCharacters } : {}),
    ...(romanizedCharacters?.length ? { romanizedCharacters } : {}),
    ...(rubyUnits?.length ? { rubyUnits } : {}),
  };
};

const sanitizePlayback = (payload: unknown): NowPlayingPlaybackPayload | null => {
  if (payload === null) return null;
  if (!isPlainRecord(payload)) return snapshot.playback;
  const trackId = String(payload.trackId ?? '').trim();
  if (!trackId) return null;
  const playback: NowPlayingPlaybackPayload = {
    trackId,
    lyricHash: String(payload.lyricHash || trackId),
    title: String(payload.title || '未知歌曲'),
    artist: String(payload.artist || '未知歌手'),
    album: toOptionalString(payload.album),
    coverUrl: toOptionalString(payload.coverUrl),
    duration: Math.max(0, toFiniteNumber(payload.duration)),
    currentTime: Math.max(0, toFiniteNumber(payload.currentTime)),
    isPlaying: Boolean(payload.isPlaying),
    isFavorite: Boolean(payload.isFavorite),
    isPersonalFM: Boolean(payload.isPersonalFM),
    playbackRate: Math.max(0.1, toFiniteNumber(payload.playbackRate, 1)),
    updatedAt: toFiniteNumber(payload.updatedAt, Date.now()),
    seekTimestamp: Math.max(0, toFiniteNumber(payload.seekTimestamp)),
  };
  const clock = isPlainRecord(payload.clock) ? payload.clock : {};
  playback.clock = buildPlaybackClockSnapshot({
    ...playback,
    trackSeq: toFiniteNumber(clock.trackSeq),
    isAdvancing: typeof clock.isAdvancing === 'boolean' ? clock.isAdvancing : playback.isPlaying,
    updatedAt: toFiniteNumber(clock.sampledAt, playback.updatedAt),
  });
  return playback;
};

const sanitizeLyric = (
  payload: Partial<NowPlayingLyricPayload> | undefined,
): NowPlayingLyricPayload => {
  if (!isPlainRecord(payload)) return snapshot.lyric;
  const lines =
    payload.lines === undefined
      ? snapshot.lyric.lines
      : Array.isArray(payload.lines)
        ? payload.lines
            .map(sanitizeLyricLine)
            .filter((line): line is LyricLinePayload => Boolean(line))
        : [];
  const mode = ['translation', 'romanization', 'both', 'none'].includes(String(payload.mode))
    ? (String(payload.mode) as NowPlayingLyricPayload['mode'])
    : snapshot.lyric.mode;

  return {
    trackId:
      payload.trackId === undefined
        ? snapshot.lyric.trackId
        : String(payload.trackId || '').trim() || null,
    revision: Math.max(0, Math.round(toFiniteNumber(payload.revision, snapshot.lyric.revision))),
    lines,
    currentIndex: Math.round(toFiniteNumber(payload.currentIndex, snapshot.lyric.currentIndex)),
    timeOffset: Math.round(toFiniteNumber(payload.timeOffset, snapshot.lyric.timeOffset)),
    wantTranslation:
      payload.wantTranslation === undefined
        ? snapshot.lyric.wantTranslation
        : Boolean(payload.wantTranslation),
    wantRomanization:
      payload.wantRomanization === undefined
        ? snapshot.lyric.wantRomanization
        : Boolean(payload.wantRomanization),
    textConversionMode:
      payload.textConversionMode === undefined
        ? snapshot.lyric.textConversionMode
        : normalizeLyricTextConversionMode(payload.textConversionMode),
    hasTranslation:
      payload.hasTranslation === undefined
        ? snapshot.lyric.hasTranslation
        : Boolean(payload.hasTranslation),
    hasRomanization:
      payload.hasRomanization === undefined
        ? snapshot.lyric.hasRomanization
        : Boolean(payload.hasRomanization),
    mode,
    isLoading:
      payload.isLoading === undefined ? snapshot.lyric.isLoading : Boolean(payload.isLoading),
    tips: payload.tips === undefined ? snapshot.lyric.tips : String(payload.tips || ''),
    syncWarning:
      payload.syncWarning === undefined ? snapshot.lyric.syncWarning : Boolean(payload.syncWarning),
  };
};

// 每个 WebContents 上次已发送的快照部分（引用比较），用于增量广播：
// 播放期间渲染端以 120ms 频率同步进度，若每次都广播含完整歌词行的全量快照，
// 数千个子对象会随每次 IPC 做结构化克隆；增量仅携带引用变化的部分。
type SentSnapshotParts = {
  playback: NowPlayingPlaybackPayload | null;
  lyric: NowPlayingLyricPayload;
  lyricLinesRef: unknown;
  appearance: NowPlayingAppearancePayload;
};
const sentPartsByWebContents = new WeakMap<Electron.WebContents, SentSnapshotParts>();

// 所有窗口（主窗口、任务栏窗口、后续独立窗口）只要收到过 now-playing 广播，
// 就监听导航/reload 并清除其增量基线，避免 reload 后首条仍是 patch。
const baselineWatchedWebContents = new WeakSet<Electron.WebContents>();
const watchNowPlayingBaseline = (webContents: Electron.WebContents): void => {
  if (baselineWatchedWebContents.has(webContents)) return;
  baselineWatchedWebContents.add(webContents);
  const resetBaseline = () => sentPartsByWebContents.delete(webContents);
  webContents.on('did-start-navigation', resetBaseline);
  webContents.on('did-finish-load', resetBaseline);
};

const currentSnapshotParts = (): SentSnapshotParts => ({
  playback: snapshot.playback,
  lyric: snapshot.lyric,
  lyricLinesRef: snapshot.lyric.lines,
  appearance: snapshot.appearance,
});

/** 全量补发（首次显示/show/reload 后）同样要推进基线，避免之后按旧基线漏发 patch。 */
const sendFullSnapshot = (webContents: Electron.WebContents): void => {
  try {
    if (webContents.isDestroyed()) return;
    watchNowPlayingBaseline(webContents);
    webContents.send('now-playing:snapshot', snapshot);
    sentPartsByWebContents.set(webContents, currentSnapshotParts());
  } catch {
    // ignore windows that are closing while broadcasting
  }
};

const sendSnapshot = () => {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (visibleOnlyWindows.get(win)?.() === false) continue;
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      if (visibleOnlyWindows.has(win) && !win.isVisible()) continue;
      const webContents = win.webContents;
      watchNowPlayingBaseline(webContents);
      const prev = sentPartsByWebContents.get(webContents);
      const patch: NowPlayingBroadcastPatch = {};
      if (!prev || prev.playback !== snapshot.playback) patch.playback = snapshot.playback;
      if (!prev || prev.appearance !== snapshot.appearance) patch.appearance = snapshot.appearance;
      if (!prev || prev.lyric !== snapshot.lyric) {
        // lines 引用未变时不随 patch 重发大数组，preload 合并时沿用上次接收值
        patch.lyric =
          !prev || prev.lyricLinesRef !== snapshot.lyric.lines
            ? snapshot.lyric
            : { ...snapshot.lyric, lines: undefined };
      }
      if (
        patch.playback === undefined &&
        patch.lyric === undefined &&
        patch.appearance === undefined
      ) {
        continue;
      }
      webContents.send('now-playing:snapshot', patch);
      // 发送成功后才推进基线；send 抛错时保留旧基线，下次会重发这部分。
      sentPartsByWebContents.set(webContents, currentSnapshotParts());
    } catch {
      // ignore windows that are closing while broadcasting
    }
  }
};

export const getNowPlayingSnapshot = () => snapshot;

const DEFAULT_WINDOW_TITLE = 'EchoMusic';

/** 根据当前播放信息更新主窗口标题（任务栏/后台任务窗口显示）：歌手-歌名，无有效信息时回退 EchoMusic */
const applyWindowTitle = (playback: NowPlayingPlaybackPayload | null | undefined) => {
  const showTitle = isCoverPreviewEnabled();
  const artist = showTitle ? String(playback?.artist ?? '').trim() : '';
  const title = showTitle ? String(playback?.title ?? '').trim() : '';
  const hasRealInfo = Boolean(
    artist &&
    title &&
    artist !== '未知歌手' &&
    title !== '未知歌曲' &&
    artist !== 'Unknown Artist' &&
    title !== 'Unknown',
  );
  const next = hasRealInfo ? `${artist} - ${title}` : DEFAULT_WINDOW_TITLE;
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed()) continue;
      // 只更新主窗口（miniPlayer / desktopLyric 等独立窗口保持自己的标题）
      if (win === getMainWindow()) {
        if (win.getTitle() !== next) win.setTitle(next);
        break;
      }
    } catch {
      // ignore windows closing while updating title
    }
  }
};

export const syncNowPlayingSnapshot = (payload: NowPlayingSnapshotPatch) => {
  if (!payload || typeof payload !== 'object') return snapshot;
  snapshot = {
    playback:
      payload.playback === undefined ? snapshot.playback : sanitizePlayback(payload.playback),
    lyric: payload.lyric === undefined ? snapshot.lyric : sanitizeLyric(payload.lyric),
    appearance:
      payload.appearance === undefined
        ? snapshot.appearance
        : {
            isDark: Boolean(payload.appearance.isDark),
            accentColor: String(
              payload.appearance.accentColor || DEFAULT_NOW_PLAYING_APPEARANCE.accentColor,
            ),
            fontFamily: toOptionalString(payload.appearance.fontFamily),
            floatingSurfaceFrosted: payload.appearance.floatingSurfaceFrosted === true,
            colors: isPlainRecord(payload.appearance.colors)
              ? (Object.fromEntries(
                  Object.entries(payload.appearance.colors).filter(
                    ([key, value]) =>
                      /^--(theme-shell|surface-(sidebar|main|card|elevated|dialog|player)-base|(floating-)?text-(main|secondary)|content-tone|floating-(tone|card-base|border|accent-text)|border-light)$/.test(
                        key,
                      ) &&
                      typeof value === 'string' &&
                      /^#[0-9a-f]{6}$/i.test(value),
                  ),
                ) as Record<string, string>)
              : undefined,
          },
    updatedAt: Date.now(),
  };
  sendSnapshot();
  applyWindowTitle(snapshot.playback);
  updateThumbarPlayback(snapshot.playback);
  return snapshot;
};

export const registerNowPlayingHandlers = (context: IpcContext) => {
  ipcRegistry.registerHandler('now-playing:get-snapshot', () => getNowPlayingSnapshot());

  // 任务栏封面预览开关：关闭时标题固定为 EchoMusic，并让任务栏回退到窗口实时画面
  ipcRegistry.registerListener('update-taskbar-cover-preview', (_event, enabled: boolean) => {
    setCoverPreviewEnabled(Boolean(enabled));
    setMainAppSetting('taskbarCoverPreview', Boolean(enabled));
    applyWindowTitle(snapshot.playback);
  });

  // 任务栏播放进度条开关：关闭时立即移除，开启时按当前播放状态重放
  ipcRegistry.registerListener('update-taskbar-progress', (_event, enabled: boolean) => {
    setTaskbarProgressEnabled(Boolean(enabled));
    setMainAppSetting('taskbarProgress', Boolean(enabled));
  });

  ipcRegistry.registerListener(
    'now-playing:sync-snapshot',
    (event, payload: NowPlayingSnapshotPatch) => {
      const mainWindow = context.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (event.sender.id !== mainWindow.webContents.id) return;
      syncNowPlayingSnapshot(payload);
    },
  );

  ipcRegistry.registerHandler('now-playing:command', async (_event, command: unknown) => {
    if (!isNowPlayingCommand(command)) return false;
    const mainWindow = context.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed())
      return false;
    mainWindow.webContents.send('now-playing:command', command);
    return true;
  });

  ipcRegistry.registerListener('now-playing:command', (_event, command: unknown) => {
    if (!isNowPlayingCommand(command)) return;
    const mainWindow = context.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send('now-playing:command', command);
  });
};
