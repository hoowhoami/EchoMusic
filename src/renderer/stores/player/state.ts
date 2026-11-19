import type { Song } from '@/models/song';
import type { TrackLoudness } from '@/utils/player';
import type { AudioEffectValue, AudioQualityValue, PlayMode } from '../../types';
import type {
  ClimaxMark,
  EnginePlaybackState,
  PlaybackDiagnostics,
  PlaybackIntent,
  PlaybackNotice,
  PlaybackSource,
  PlaybackSourceKind,
} from './types';
import { DEFAULT_PLAYER_VOLUME } from '../../../shared/playback';
import { createSleepTimerState } from './sleepTimer';

/** 续播进度：一条记录线上一首曲目的进度。entry 说明它属于哪条线（audiobook:1 / album:1 / single）。 */
export interface ResumePosition {
  position: number;
  duration: number;
  updatedAt: number;
  entry: string;
  /** 这首歌 / 这一章的标题，给搜索页卡片显示「上次听到哪一章」。 */
  title?: string;
}

/** 详情页续播条目：kind 决定它属于哪个桶（有声/长专 / 专辑 / 歌手 / 歌单）。 */
export interface ResumeScopeRef {
  kind: 'audiobook' | 'album' | 'artist' | 'playlist';
  id: string;
  /** 详情页名称，给搜索页卡片显示。 */
  name: string;
  /** 封面地址，给搜索页卡片显示。 */
  cover: string;
  /** 上次听到哪一首（或哪一章）；空串表示只登记过、还没听过。 */
  trackId: string;
  updatedAt: number;
  /** 歌单桶专用：路由里的 collection 串（详情接口只认它，桶 id 是歌单自己的数字 id）。 */
  routeId?: string;
  /** 歌单桶专用：路由上的 type（user / special / album）。 */
  routeType?: string;
}

const createPlaybackIntent = (): PlaybackIntent => ({
  seq: 0,
  trackId: null,
  sourceQueueId: null,
  shouldPlay: false,
  phase: 'idle',
  startedAt: 0,
});

const createEnginePlaybackState = (): EnginePlaybackState => ({
  status: 'idle',
  trackId: null,
  updatedAt: 0,
});

const createPlaybackDiagnostics = (): PlaybackDiagnostics => ({
  core: null,
  ao: null,
  packetCache: null,
  output: null,
  graph: null,
});

export const createPlayerState = () => ({
  sleepTimer: createSleepTimerState(),
  isLyricViewOpen: false,
  volume: DEFAULT_PLAYER_VOLUME,
  lastNonZeroVolume: DEFAULT_PLAYER_VOLUME,
  currentTime: 0,
  /** 续播进度：曲目 id → 记录线（entry）→ 进度；同一首在不同卡上各记各的。 */
  resumePositions: {} as Record<string, Record<string, ResumePosition>>,
  /** 详情页续播桶：有声/长专 / 专辑 / 歌单 / 歌手各 20 条，顺序即 LRU。 */
  resumeScopes: [] as ResumeScopeRef[],
  // EOF survives pause events; resuming an exhausted source must reload it.
  playbackEnded: false,
  currentTimeUpdatedAt: 0,
  // Monotonic ordering for native buffering and actual-output-progress events.
  nativePlaybackEventRevision: 0,
  nativePlaybackProgressRevision: 0,
  duration: 0,
  playbackRate: 1,
  playMode: 'list' as PlayMode,
  equalizerGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] as number[],
  currentTrackId: null as string | null,
  currentSourceQueueId: null as string | null,
  lastError: '' as string | null,
  currentPlaylist: null as Song[] | null,
  currentAudioUrl: '' as string,
  currentPlaybackSource: null as PlaybackSource | null,
  currentAudioCandidateUrls: [] as string[],
  currentAudioCandidateSources: [] as PlaybackSource[],
  currentAudioCandidateIndex: -1,
  currentResolvedAudioQuality: null as AudioQualityValue | null,
  currentResolvedAudioEffect: 'none' as AudioEffectValue,
  currentResolvedAudioLoudness: null as TrackLoudness | null,
  currentResolvedSourceKind: 'catalog' as PlaybackSourceKind,
  nativeTrackSeq: null as number | null,
  supersededNativeTrackSeq: null as number | null,
  audioEffect: 'none' as AudioEffectValue,
  recentSeekIgnoreEnd: false,
  settingsWatcherRegistered: false,
  pendingSettingRefresh: false,
  audioSourceRefreshRequestSeq: null as number | null,
  audioSourceRefreshQuality: null as AudioQualityValue | null,
  climaxMarks: [] as ClimaxMark[],
  appliedOutputDeviceId: 'default' as string,
  _lastAppliedExclusive: false,
  currentAudioQualityOverride: null as AudioQualityValue | null,
  currentCatalogSourceOverrideTrackId: null as string | null,
  currentCloudSourceOverrideTrackId: null as string | null,
  playbackRequestSeq: 0,
  climaxRequestSeq: 0,
  currentTrackSnapshot: null as Song | null,
  historyUploadCommitted: false,
  historyUploadTrackId: null as string | null,
  historyLocalRecorded: false,
  autoNextTimer: null as number | null,
  autoNextAttempts: 0,
  autoNextSourceTrackId: null as string | null,
  // Certain synchronized playback contexts must wait for their remote controller instead.
  autoNextSuppressed: false,
  audioEffectError: '',
  audioEffectApplying: false,
  playbackNotice: null as PlaybackNotice | null,
  mvAudioFallbackFailureReason: '',
  shuffleQueue: null as number[] | null,
  shuffleQueueLength: 0,
  shufflePlayed: new Set<number>(),
  shuffleHistory: [] as string[],
  seekTargetTime: null as number | null,
  nativeSeekActive: false,
  nativeSeekGeneration: null as number | null,
  seekTimestamp: 0,
  isResuming: false,
  playbackIntent: createPlaybackIntent(),
  enginePlayback: createEnginePlaybackState(),
  playbackDiagnostics: createPlaybackDiagnostics(),
  // 原生换源护栏：开始加载时置 true，player 回报 file-loaded（新文件真正加载完成）后置 false。
  // 期间 timeUpdate/durationChange 收到的多为上一首在 loadFile 替换前后的残留回报，一律丢弃，
  // 避免进度条切歌时先跳到旧值再归零。
  awaitingTrackLoad: false,
  // 卡死恢复：恢复期间 UI 停在断点位置，忽略 reload 过程中 player 回报的归零/回跳值，避免进度条跳动
  stallRecovering: false,
  stallRecoverTarget: 0,
  stallRecoverDeadline: 0,
  stallRecoverAttempts: 0,
  stallRecoverTrackId: null as string | null,
});

export type PlayerState = ReturnType<typeof createPlayerState>;
