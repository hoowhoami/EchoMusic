import type { ShortcutCommand, ShortcutRegistrationFailure } from './shortcuts';

const SHORTCUT_COMMAND_LABELS: Record<ShortcutCommand, string> = {
  togglePlayback: '播放 / 暂停',
  previousTrack: '上一首',
  nextTrack: '下一首',
  seekForward: '快进',
  seekBackward: '快退',
  toggleMainLyric: '主歌词开关',
  toggleDesktopLyric: '桌面歌词开关',
  toggleLyricsMode: '歌词模式切换',
  cycleLyricsMode: '歌词模式轮换',
  openLyricSource: '选择歌词版本',
  volumeUp: '音量 +',
  volumeDown: '音量 -',
  toggleMute: '静音',
  toggleFavorite: '收藏当前歌曲',
  togglePlayMode: '切换播放模式',
  toggleMiniPlayer: 'Mini 模式切换',
  toggleWindow: '显示 / 隐藏窗口',
  toggleSidebar: '侧边栏开关',
};

export const formatShortcutRegistrationFailures = (
  failures: ShortcutRegistrationFailure[],
  formatAccelerator: (accelerator: string) => string = (accelerator) => accelerator,
): string =>
  failures
    .map(({ command, accelerator, scope, reason }) => {
      const commandLabel = SHORTCUT_COMMAND_LABELS[command] ?? command;
      const acceleratorLabel = formatAccelerator(accelerator);
      const shortcutType = scope === 'global' ? '全局快捷键' : '普通快捷键';
      const reasonLabel = reason === 'invalid' ? '格式无效' : '可能与其他软件冲突';
      return `${shortcutType}“${commandLabel}” (${acceleratorLabel}) ${reasonLabel}`;
    })
    .join('；');
