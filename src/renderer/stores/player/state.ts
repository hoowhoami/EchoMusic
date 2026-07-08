import type { Song } from '@/models/song';
import type { AudioEffectValue, AudioQualityValue, PlayMode } from '../../types';
import type { ClimaxMark, PlaybackNotice } from './types';
import { DEFAULT_PLAYER_VOLUME } from '../../../shared/playback';

export const createPlayerState = () => ({
  isPlaying: false,
  isLyricViewOpen: false,
  volume: DEFAULT_PLAYER_VOLUME,
  lastNonZeroVolume: DEFAULT_PLAYER_VOLUME,
  currentTime: 0,
  duration: 0,
  playbackRate: 1,
  playMode: 'list' as PlayMode,
  equalizerGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] as number[],
  currentTrackId: null as string | null,
  currentSourceQueueId: null as string | null,
  isLoading: false,
  lastError: '' as string | null,
  currentPlaylist: null as Song[] | null,
  currentAudioUrl: '' as string,
  currentAudioCandidateUrls: [] as string[],
  currentAudioCandidateIndex: -1,
  currentResolvedAudioQuality: null as AudioQualityValue | null,
  currentResolvedAudioEffect: 'none' as AudioEffectValue,
  audioEffect: 'none' as AudioEffectValue,
  recentSeekIgnoreEnd: false,
  settingsWatcherRegistered: false,
  isDraggingProgress: false,
  pendingSettingRefresh: false,
  climaxMarks: [] as ClimaxMark[],
  appliedOutputDeviceId: 'default' as string,
  _lastAppliedExclusive: false,
  currentAudioQualityOverride: null as AudioQualityValue | null,
  playbackRequestSeq: 0,
  climaxRequestSeq: 0,
  currentTrackSnapshot: null as Song | null,
  historyUploadCommitted: false,
  historyUploadTrackId: null as string | null,
  historyLocalRecorded: false,
  autoNextTimer: null as number | null,
  autoNextAttempts: 0,
  autoNextSourceTrackId: null as string | null,
  playbackNotice: null as PlaybackNotice | null,
  shuffleQueue: null as number[] | null,
  shuffleQueueLength: 0,
  shufflePlayed: new Set<number>(),
  shuffleHistory: [] as string[],
  seekTargetTime: null as number | null,
  seekTimestamp: 0,
  isResuming: false,
  // 切歌加载护栏：playTrack 重置时置 true，mpv 回报 file-loaded（新文件真正加载完成）后置 false。
  // 期间 timeUpdate/durationChange 收到的多为上一首在 loadFile 替换前后的残留回报，一律丢弃，
  // 避免进度条切歌时先跳到旧值再归零。
  awaitingTrackLoad: false,
  // 卡死恢复：恢复期间 UI 停在断点位置，忽略 reload 过程中 mpv 回报的归零/回跳值，避免进度条跳动
  stallRecovering: false,
  stallRecoverTarget: 0,
  stallRecoverDeadline: 0,
  stallRecoverAttempts: 0,
  stallRecoverTrackId: null as string | null,
});

export type PlayerState = ReturnType<typeof createPlayerState>;
