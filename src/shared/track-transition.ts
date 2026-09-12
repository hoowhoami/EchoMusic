/**
 * 歌曲过渡设置（对应 QQ 音乐「歌曲过渡设置」四选一）：
 *
 * - `gapless`        无缝播放：自动跳过首尾静音片段，切歌时声音不间断
 * - `fade`           淡入淡出播放 0~15 秒：前曲渐弱、后曲渐强
 * - `automix-basic`  智能混音-基础渐变：更多保留原曲片段的丝滑衔接
 * - `automix-pro`    智能混音-进阶交融：切歌点更智能，适配段落节奏特征
 * - `none`           关闭（硬切）
 *
 * 引擎侧（native/echo-audio-player `transition` 模块）按同名字符串解析。
 */
export type TrackTransitionMode = 'none' | 'gapless' | 'fade' | 'automix-basic' | 'automix-pro';

export const TRACK_TRANSITION_MODES: readonly TrackTransitionMode[] = [
  'automix-pro',
  'automix-basic',
  'fade',
  'gapless',
  'none',
];

export const MAX_FADE_CROSS_SECS = 15;
export const DEFAULT_FADE_CROSS_SECS = 5;
export const DEFAULT_TRACK_TRANSITION_MODE: TrackTransitionMode = TRACK_TRANSITION_MODES[0];

export interface TrackTransitionOption {
  value: TrackTransitionMode;
  label: string;
  description: string;
}

export const TRACK_TRANSITION_OPTIONS: readonly TrackTransitionOption[] = [
  {
    value: 'automix-pro',
    label: '智能混音-进阶交融',
    description: '切歌点更智能 适配段落节奏特征',
  },
  {
    value: 'automix-basic',
    label: '智能混音-基础渐变',
    description: '更多保留原曲片段的丝滑衔接',
  },
  { value: 'fade', label: '淡入淡出播放', description: '前曲渐弱 后曲渐强' },
  {
    value: 'gapless',
    label: '无缝播放',
    description: '自动跳过首尾静音片段 切歌时声音不间断',
  },
  { value: 'none', label: '关闭', description: '播放完毕后直接切换 不做过渡处理' },
];

export function isTrackTransitionMode(value: unknown): value is TrackTransitionMode {
  return (
    value === 'none' ||
    value === 'gapless' ||
    value === 'fade' ||
    value === 'automix-basic' ||
    value === 'automix-pro'
  );
}

export function normalizeTrackTransitionMode(value: unknown): TrackTransitionMode {
  return isTrackTransitionMode(value) ? value : DEFAULT_TRACK_TRANSITION_MODE;
}

/** Clamp the crossfade length to QQ Music's 0–15 s slider range. */
export function clampFadeCrossSecs(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_FADE_CROSS_SECS;
  return Math.min(MAX_FADE_CROSS_SECS, Math.max(0, Math.round(numeric)));
}

/** Whether the mode needs the next track prepared (any mode except off). */
export function transitionPreparesNextTrack(mode: TrackTransitionMode): boolean {
  return mode !== 'none';
}

/** Whether the mode overlaps the two tracks (needs a longer prefetch window). */
export function transitionOverlapsTracks(mode: TrackTransitionMode): boolean {
  return mode === 'fade' || mode === 'automix-basic' || mode === 'automix-pro';
}

/**
 * Seconds before the end of the current track at which the next source must be
 * prepared. Mirrors `TransitionSettings::prefetch_lead_secs` in the engine; the renderer
 * uses it to decide when to resolve the next URL and hand it to native.
 */
export function transitionPrefetchLeadSecs(mode: TrackTransitionMode, fadeSecs: number): number {
  switch (mode) {
    case 'none':
      return 0;
    case 'gapless':
      return 30;
    case 'fade':
      return 30 + clampFadeCrossSecs(fadeSecs);
    case 'automix-basic':
    case 'automix-pro':
      return 75;
    default:
      return 30;
  }
}
