import type { AudioQuality, MusicEffect } from '@/types';

/**
 * 音质选项
 */
export const AUDIO_QUALITY_OPTIONS: readonly {
  label: string;
  value: AudioQuality;
}[] = [
  {
    label: '标准品质',
    value: '128',
  },
  {
    label: 'HQ高品质',
    value: '320',
  },
  {
    label: 'SQ无损品质',
    value: 'flac',
  },
] as const;

/**
 * 音效选项
 */
export const MUSIC_EFFECT_OPTIONS: readonly {
  label: string;
  value: MusicEffect;
}[] = [
  {
    label: '钢琴音效',
    value: 'piano',
  },
  {
    label: '人声伴奏',
    value: 'acappella',
  },
  {
    label: '骨笛音效',
    value: 'subwoofer',
  },
  {
    label: '尤克里里',
    value: 'ancient',
  },
  {
    label: '唢呐音效',
    value: 'surnay',
  },
  {
    label: 'DJ音效',
    value: 'dj',
  },
  {
    label: '蝰蛇母带',
    value: 'viper_tape',
  },
  {
    label: '蝰蛇全景声',
    value: 'viper_atmos',
  },
  {
    label: '蝰蛇超清',
    value: 'viper_clear',
  },
] as const;

/**
 * 倍速播放选项
 */
export const PLAY_SPEED_OPTIONS: readonly {
  label: string;
  value: number;
}[] = [
  {
    label: '0.25x',
    value: 0.25,
  },
  {
    label: '0.5x',
    value: 0.5,
  },
  {
    label: '0.75x',
    value: 0.75,
  },
  {
    label: '1.0x',
    value: 1,
  },
  {
    label: '1.25x',
    value: 1.25,
  },
  {
    label: '1.5x',
    value: 1.5,
  },
  {
    label: '1.75x',
    value: 1.75,
  },
  {
    label: '2.0x',
    value: 2,
  },
] as const;

/**
 * 音质/音效名称映射
 */
export const QUALITY_NAMES: Record<AudioQuality | MusicEffect, string> = {
  '128': '标准品质',
  '320': 'HQ高品质',
  flac: 'SQ无损品质',
  piano: '钢琴音效',
  acappella: '人声伴奏',
  subwoofer: '骨笛音效',
  ancient: '尤克里里',
  surnay: '唢呐音效',
  dj: 'DJ音效',
  viper_tape: '蝰蛇母带',
  viper_atmos: '蝰蛇全景声',
  viper_clear: '蝰蛇超清',
} as const;
