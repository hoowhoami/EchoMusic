import type { AccentMode } from '@/stores/theme';
import type { AudioQualityValue, OutputDeviceDisconnectBehavior, ShortcutItem } from '@/types';
import type { CloseBehavior, ThemeMode } from '../../../shared/app';
import {
  iconDeviceSpeaker,
  iconFlask,
  iconInfo,
  iconKeyboard,
  iconPalette,
  iconPlayerPlay,
  iconPlugin,
  iconShield,
  iconSlidersHorizontal,
  iconTypography,
} from '@/icons';

export const sectionTitles = {
  appearance: { label: '外观与界面', icon: iconPalette },
  font: { label: '字体设置', icon: null },
  playback: { label: '播放体验', icon: iconPlayerPlay },
  player: { label: '播放器设置', icon: iconSlidersHorizontal },
  pageLyric: { label: '页面歌词', icon: null },
  desktopLyric: { label: '桌面歌词', icon: iconTypography },
  shortcuts: { label: '快捷键', icon: iconKeyboard },
  audioDevice: { label: '音频设备', icon: iconDeviceSpeaker },
  experimental: { label: '实验性功能', icon: iconFlask },
  plugins: { label: '插件', icon: iconPlugin },
  data: { label: '数据与安全', icon: iconShield },
  about: { label: '关于', icon: iconInfo },
} as const;

export const accentModeOptions: { label: string; value: AccentMode }[] = [
  { label: '跟随封面', value: 'cover' },
  { label: '预设主题', value: 'preset' },
  { label: '自定义', value: 'custom' },
];

export const themeOptions: { label: string; value: ThemeMode }[] = [
  { label: '跟随系统', value: 'system' },
  { label: '浅色模式', value: 'light' },
  { label: '深色模式', value: 'dark' },
];

export const shortcutItems: ShortcutItem[] = [
  { command: 'togglePlayback', title: '播放 / 暂停', desc: '切换当前歌曲的播放状态' },
  { command: 'previousTrack', title: '上一首', desc: '跳转到播放列表中的上一首歌曲' },
  { command: 'nextTrack', title: '下一首', desc: '跳转到播放列表中的下一首歌曲' },
  { command: 'volumeUp', title: '音量 +', desc: '将播放器音量提高 5%' },
  { command: 'volumeDown', title: '音量 -', desc: '将播放器音量降低 5%' },
  { command: 'toggleMute', title: '静音', desc: '切换播放器静音状态' },
  { command: 'toggleFavorite', title: '收藏当前歌曲', desc: '切换播放器当前歌曲的收藏状态' },
  {
    command: 'togglePlayMode',
    title: '切换播放模式',
    desc: '在列表循环、单曲循环、随机播放之间切换',
  },
  { command: 'toggleMiniPlayer', title: 'Mini 模式切换', desc: '在主窗口和 Mini 模式之间切换' },
  { command: 'toggleWindow', title: '显示 / 隐藏窗口', desc: '切换主窗口的显示和隐藏状态' },
  { command: 'toggleSidebar', title: '侧边栏开关', desc: '展开或收起侧边栏' },
  { command: 'toggleMainLyric', title: '页面歌词开关', desc: '打开或关闭页面歌词' },
  { command: 'toggleDesktopLyric', title: '桌面歌词开关', desc: '打开或关闭桌面歌词窗口' },
];

export const desktopLyricAlignOptions = [
  { label: '左对齐', value: 'left' },
  { label: '居中', value: 'center' },
  { label: '右对齐', value: 'right' },
  { label: '交替', value: 'both' },
];

export const desktopLyricLayoutOptions = [
  { label: '横排', value: 'horizontal' },
  { label: '竖排', value: 'vertical' },
];

export const desktopLyricShadowOptions = [
  { label: '关闭', value: 'none' },
  { label: '柔和', value: 'soft' },
  { label: '标准', value: 'normal' },
  { label: '清晰', value: 'strong' },
];

export const audioQualityOptions: { label: string; value: AudioQualityValue }[] = [
  { label: '标准品质', value: '128' },
  { label: 'HQ 高品质', value: '320' },
  { label: 'SQ 无损品质', value: 'flac' },
  { label: 'Hi-Res 品质', value: 'high' },
  { label: 'DSD 臻品音质', value: 'super' },
];

export const closeBehaviorOptions: { label: string; value: CloseBehavior }[] = [
  { label: '最小化到托盘', value: 'tray' },
  { label: '彻底退出程序', value: 'exit' },
];

export const outputDeviceDisconnectBehaviorOptions: {
  label: string;
  value: OutputDeviceDisconnectBehavior;
}[] = [
  { label: '暂停播放', value: 'pause' },
  { label: '切到默认设备', value: 'fallback' },
];

export const desktopLyricColorPresets = [
  '#31cfa1',
  '#b9b9b9',
  '#ffffff',
  '#ffd166',
  '#ef476f',
  '#118ab2',
  '#8b5cf6',
  '#f97316',
  '#22c55e',
  '#60a5fa',
  '#f43f5e',
  '#0f172a',
];
