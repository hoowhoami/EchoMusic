/**
 * 歌曲过渡模式，供设置界面和播放引擎共用。
 *
 * - `gapless`        无缝播放：裁剪首尾静音后衔接
 * - `fade`           淡入淡出：按指定时长交叠播放
 * - `automix-basic`  自然衔接：保持原速，自动选择衔接位置
 * - `automix-pro`    节奏融合：结合节拍和段落调整混音
 * - `none`           关闭（硬切）
 *
 * 引擎侧（native/echo-audio-player `transition` 模块）按同名字符串解析。
 */
export type TrackTransitionMode = 'none' | 'gapless' | 'fade' | 'automix-basic' | 'automix-pro';

/** Actual transition carried by the incoming track's audible playback boundary. */
export interface TrackTransitionPlaybackInfo {
  mode: TrackTransitionMode;
  overlapSecs: number;
}

export function formatTrackTransitionNotice(
  transition: TrackTransitionPlaybackInfo | null | undefined,
  startTime: number,
): string | null {
  if (!transition || !isTrackTransitionMode(transition.mode) || transition.mode === 'none') {
    return null;
  }
  const label = {
    gapless: '无缝',
    fade: '淡入淡出',
    'automix-basic': '自然衔接',
    'automix-pro': '节奏融合',
  }[transition.mode];
  const parts = [label];
  const seconds = (value: number) =>
    Number.isFinite(value) && value > 0 ? Number(value.toFixed(1)) : 0;
  const overlap = seconds(transition.overlapSecs);
  const skipped = seconds(startTime);
  if (overlap > 0 && transition.mode !== 'gapless') {
    parts.push(`${overlap} 秒`);
  }
  if (skipped > 0) parts.push(`跳过 ${skipped} 秒`);
  return parts.join(' · ');
}

export const TRACK_TRANSITION_MODES: readonly TrackTransitionMode[] = [
  'automix-pro',
  'automix-basic',
  'fade',
  'gapless',
  'none',
];

export const MAX_FADE_CROSS_SECS = 15;
export const DEFAULT_FADE_CROSS_SECS = 15;
export const DEFAULT_TRACK_TRANSITION_MODE: TrackTransitionMode = TRACK_TRANSITION_MODES[0];

export interface TrackTransitionOption {
  value: TrackTransitionMode;
  label: string;
  description: string;
}

export const TRACK_TRANSITION_OPTIONS: readonly TrackTransitionOption[] = [
  {
    value: 'automix-pro',
    label: '节奏融合',
    description: '结合节拍与段落选择衔接位置，自动调整混音',
  },
  {
    value: 'automix-basic',
    label: '自然衔接',
    description: '保持歌曲原速，自动选择衔接位置与时长',
  },
  { value: 'fade', label: '淡入淡出', description: '按设定时长交叠播放，前曲渐弱、后曲渐强' },
  {
    value: 'gapless',
    label: '无缝播放',
    description: '跳过首尾静音，直接衔接下一首',
  },
  { value: 'none', label: '关闭', description: '保留完整首尾，播放结束后切换下一首' },
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

/** Keep the crossfade duration within the supported range. */
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

/** Preparation includes network reads and musical analysis, not just playback buffering. */
export function transitionPreparationTimeoutSecs(
  mode: TrackTransitionMode,
  remainingSecs: number,
  playbackRate: number,
): number {
  if (mode === 'none' || !Number.isFinite(remainingSecs)) return 0;
  const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
  // Release the native EOF wait before the outgoing song ends, even for a late request.
  const available = remainingSecs / rate - 2;
  if (available < 1) return 0;
  const budget = mode === 'automix-basic' || mode === 'automix-pro' ? 60 : 20;
  return Math.min(budget, available);
}
