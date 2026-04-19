import { usePlayerStore } from '@/stores/player';
import { usePlaylistStore } from '@/stores/playlist';
import { useSettingStore } from '@/stores/setting';
import { useDesktopLyricStore } from '@/desktopLyric/store';
import { useLyricStore } from '@/stores/lyric';
import { useToastStore } from '@/stores/toast';
import router from '@/router';
import { closeTransientView } from '@/utils/navigation';
import type {
  ShortcutCommand,
  ShortcutMap,
  ShortcutRegistrationResult,
} from '../../shared/shortcuts';

type ShortcutDisplayPlatform = 'darwin' | 'win32' | 'linux' | string;

const normalizeKey = (key: string): string => {
  if (!key) return '';
  if (key === ' ') return 'space';
  return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
};

const parseShortcutLabelParts = (label: string): string[] => {
  const normalized = String(label ?? '').trim();
  if (!normalized) return [];
  if (normalized.includes('+')) {
    return normalized
      .split('+')
      .map((part) => part.trim())
      .filter(Boolean);
  }

  const parts: string[] = [];
  let rest = normalized;
  const leadingTokens = ['⌘', '⇧', '⌥', '⌃', '←', '→', '↑', '↓', 'Space'];

  while (rest.length > 0) {
    const matched = leadingTokens.find((token) => rest.startsWith(token));
    if (!matched) {
      parts.push(rest);
      break;
    }
    parts.push(matched);
    rest = rest.slice(matched.length);
  }

  return parts;
};

const normalizeDisplayToken = (token: string): string => {
  const normalized = String(token ?? '').trim();
  if (!normalized) return '';
  const lower = normalized.toLowerCase();

  if (
    ['cmdorctrl', 'commandorcontrol', 'command', 'cmd', '⌘'].includes(lower) ||
    normalized === '⌘'
  ) {
    return 'cmdorctrl';
  }
  if (['ctrl', 'control', '⌃'].includes(lower) || normalized === '⌃') {
    return 'ctrl';
  }
  if (['shift', '⇧'].includes(lower) || normalized === '⇧') {
    return 'shift';
  }
  if (['alt', 'option', '⌥'].includes(lower) || normalized === '⌥') {
    return 'alt';
  }
  if (lower === 'meta') return 'meta';
  if (normalized === '←' || lower === 'left' || lower === 'arrowleft') return 'Left';
  if (normalized === '→' || lower === 'right' || lower === 'arrowright') return 'Right';
  if (normalized === '↑' || lower === 'up' || lower === 'arrowup') return 'Up';
  if (normalized === '↓' || lower === 'down' || lower === 'arrowdown') return 'Down';
  if (lower === 'spacebar' || lower === 'space') return 'Space';
  return normalized.length === 1 ? normalized.toUpperCase() : normalized;
};

const orderTokensForDisplay = (tokens: string[], platform: ShortcutDisplayPlatform) => {
  const unique = Array.from(new Set(tokens.filter(Boolean)));
  const isMac = platform === 'darwin';
  const modifierOrder = isMac
    ? ['cmdorctrl', 'shift', 'alt', 'ctrl', 'meta']
    : ['ctrl', 'shift', 'alt', 'meta', 'cmdorctrl'];
  const modifierTokens = modifierOrder.filter((token) => unique.includes(token));
  const mainTokens = unique.filter((token) => !modifierOrder.includes(token));
  return [...modifierTokens, ...mainTokens];
};

export const formatShortcutLabelForDisplay = (
  label: string,
  platform: ShortcutDisplayPlatform = window.electron?.platform ?? '',
): string => {
  const parts = parseShortcutLabelParts(label).map(normalizeDisplayToken).filter(Boolean);
  if (!parts.length) return '';

  const ordered = orderTokensForDisplay(parts, platform);
  const isMac = platform === 'darwin';
  if (isMac) {
    return ordered
      .map((token) => {
        if (token === 'cmdorctrl' || token === 'meta') return '⌘';
        if (token === 'shift') return '⇧';
        if (token === 'alt') return '⌥';
        if (token === 'ctrl') return '⌃';
        if (token === 'Left') return '←';
        if (token === 'Right') return '→';
        if (token === 'Up') return '↑';
        if (token === 'Down') return '↓';
        return token;
      })
      .join('');
  }

  return ordered
    .map((token) => {
      if (token === 'cmdorctrl' || token === 'ctrl') return 'Ctrl';
      if (token === 'shift') return 'Shift';
      if (token === 'alt') return 'Alt';
      if (token === 'meta') return 'Win';
      return token;
    })
    .join('+');
};

export const formatAcceleratorForDisplay = (
  accelerator: string,
  platform: ShortcutDisplayPlatform = window.electron?.platform ?? '',
): string => {
  return formatShortcutLabelForDisplay(accelerator, platform);
};

export const areShortcutLabelsEquivalent = (left: string, right: string): boolean => {
  return labelToAccelerator(left) === labelToAccelerator(right);
};

const buildShortcut = (event: KeyboardEvent): string => {
  const keys = new Set<string>();
  if (event.ctrlKey) keys.add('ctrl');
  if (event.metaKey) keys.add('meta');
  if (event.altKey) keys.add('alt');
  if (event.shiftKey) keys.add('shift');
  const mainKey = normalizeKey(event.key);
  if (mainKey && !['control', 'shift', 'alt', 'meta'].includes(mainKey)) {
    keys.add(mainKey);
  }
  return Array.from(keys).sort().join('+');
};

const labelToAccelerator = (label: string): string => {
  return label
    .replace(/\s+/g, '')
    .replace(/CommandOrControl/gi, 'CmdOrCtrl+')
    .replace(/[⌘]/g, 'CmdOrCtrl+')
    .replace(/[⇧]/g, 'Shift+')
    .replace(/[⌥]/g, 'Alt+')
    .replace(/[⌃]/g, 'Ctrl+')
    .replace(/[←]/g, 'Left')
    .replace(/[→]/g, 'Right')
    .replace(/[↑]/g, 'Up')
    .replace(/[↓]/g, 'Down')
    .replace(/\bSpace\b/gi, 'Space')
    .replace(/\+\+/g, '+')
    .replace(/\+$/, '');
};

const acceleratorToKeys = (accelerator: string): string[] => {
  const cleaned = accelerator.replace(/\s+/g, '');
  if (!cleaned) return [];
  const parts = cleaned.split('+').filter(Boolean);
  const modifiers: string[] = [];
  const keys: string[] = [];
  let hasCmdOrCtrl = false;

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (['cmdorctrl', 'commandorcontrol', 'command', 'cmd'].includes(lower)) {
      hasCmdOrCtrl = true;
      continue;
    }
    if (['ctrl', 'control'].includes(lower)) {
      modifiers.push('ctrl');
      continue;
    }
    if (['shift'].includes(lower)) {
      modifiers.push('shift');
      continue;
    }
    if (['alt', 'option'].includes(lower)) {
      modifiers.push('alt');
      continue;
    }
    if (lower === 'left') keys.push('arrowleft');
    else if (lower === 'right') keys.push('arrowright');
    else if (lower === 'up') keys.push('arrowup');
    else if (lower === 'down') keys.push('arrowdown');
    else if (lower === 'space') keys.push('space');
    else keys.push(lower);
  }

  const buildCombo = (extra: string[]) => {
    const combo = Array.from(new Set([...modifiers, ...extra, ...keys]));
    return combo.sort().join('+');
  };

  if (hasCmdOrCtrl) {
    return [buildCombo(['meta']), buildCombo(['ctrl'])];
  }
  return [buildCombo([])];
};

export const resolveShortcutMap = (scope: 'local' | 'global'): ShortcutMap => {
  const settingStore = useSettingStore();
  const bindings =
    scope === 'global'
      ? (settingStore.globalShortcutBindings ?? {})
      : (settingStore.shortcutBindings ?? {});
  const defaults =
    scope === 'global'
      ? (settingStore.defaultGlobalShortcutLabels ?? {})
      : (settingStore.defaultShortcutLabels ?? {});
  return {
    togglePlayback: labelToAccelerator(bindings.togglePlayback ?? defaults.togglePlayback ?? ''),
    previousTrack: labelToAccelerator(bindings.previousTrack ?? defaults.previousTrack ?? ''),
    nextTrack: labelToAccelerator(bindings.nextTrack ?? defaults.nextTrack ?? ''),
    toggleMainLyric: labelToAccelerator(bindings.toggleMainLyric ?? defaults.toggleMainLyric ?? ''),
    toggleDesktopLyric: labelToAccelerator(
      bindings.toggleDesktopLyric ?? defaults.toggleDesktopLyric ?? '',
    ),
    toggleLyricsMode: '',
    cycleLyricsMode: '',
    volumeUp: labelToAccelerator(bindings.volumeUp ?? defaults.volumeUp ?? ''),
    volumeDown: labelToAccelerator(bindings.volumeDown ?? defaults.volumeDown ?? ''),
    toggleMute: labelToAccelerator(bindings.toggleMute ?? defaults.toggleMute ?? ''),
    toggleFavorite: labelToAccelerator(bindings.toggleFavorite ?? defaults.toggleFavorite ?? ''),
    togglePlayMode: labelToAccelerator(bindings.togglePlayMode ?? defaults.togglePlayMode ?? ''),
    toggleWindow: labelToAccelerator(bindings.toggleWindow ?? defaults.toggleWindow ?? ''),
  };
};

const getShortcutCommandLabel = (command: ShortcutCommand) => {
  const labels: Record<ShortcutCommand, string> = {
    togglePlayback: '播放 / 暂停',
    previousTrack: '上一首',
    nextTrack: '下一首',
    toggleMainLyric: '主歌词开关',
    toggleDesktopLyric: '桌面歌词开关',
    toggleLyricsMode: '歌词模式切换',
    cycleLyricsMode: '歌词模式轮换',
    volumeUp: '音量 +',
    volumeDown: '音量 -',
    toggleMute: '静音',
    toggleFavorite: '收藏当前歌曲',
    togglePlayMode: '切换播放模式',
    toggleWindow: '显示 / 隐藏窗口',
  };
  return labels[command] ?? command;
};

const showGlobalShortcutFailures = (result: ShortcutRegistrationResult | null | undefined) => {
  if (!result?.failures?.length) return;
  const toastStore = useToastStore();
  const message = result.failures
    .map(({ command, accelerator, reason }) => {
      const label = getShortcutCommandLabel(command);
      const displayAccelerator = formatAcceleratorForDisplay(accelerator);
      const suffix = reason === 'invalid' ? '格式无效' : '可能与其他软件冲突';
      return `${label} (${displayAccelerator}) ${suffix}`;
    })
    .join('；');
  toastStore.warning(`以下全局快捷键未生效：${message}`, 4200);
};

export const executeShortcutCommand = (command: ShortcutCommand) => {
  const playerStore = usePlayerStore();
  const playlistStore = usePlaylistStore();
  const lyricStore = useLyricStore();
  // const settingStore = useSettingStore();
  const desktopLyricStore = useDesktopLyricStore();

  if (command === 'togglePlayback') {
    playerStore.togglePlay();
  } else if (command === 'previousTrack') {
    playerStore.prev();
  } else if (command === 'nextTrack') {
    playerStore.next();
  } else if (command === 'toggleMainLyric') {
    const currentRoute = router.currentRoute.value;
    if (currentRoute.name === 'lyric') {
      void closeTransientView(router, currentRoute);
      return;
    }
    router.push({
      name: 'lyric',
      query: { from: currentRoute.fullPath },
    });
  } else if (command === 'toggleDesktopLyric') {
    void desktopLyricStore.setEnabled(!desktopLyricStore.settings.enabled);
  } else if (command === 'toggleLyricsMode') {
    // 快捷键切换：翻译开关
    lyricStore.wantTranslation = !lyricStore.wantTranslation;
  } else if (command === 'cycleLyricsMode') {
    // 快捷键循环：无 → 翻译 → 音译 → 译+音 → 无
    if (!lyricStore.wantTranslation && !lyricStore.wantRomanization) {
      lyricStore.wantTranslation = true;
    } else if (lyricStore.wantTranslation && !lyricStore.wantRomanization) {
      lyricStore.wantTranslation = false;
      lyricStore.wantRomanization = true;
    } else if (!lyricStore.wantTranslation && lyricStore.wantRomanization) {
      lyricStore.wantTranslation = true;
    } else {
      lyricStore.wantTranslation = false;
      lyricStore.wantRomanization = false;
    }
  } else if (command === 'volumeUp') {
    playerStore.setVolume(playerStore.volume + 0.05);
  } else if (command === 'volumeDown') {
    playerStore.setVolume(playerStore.volume - 0.05);
  } else if (command === 'toggleMute') {
    const next = playerStore.volume > 0 ? 0 : 0.8;
    playerStore.setVolume(next);
  } else if (command === 'toggleFavorite') {
    const track =
      (playlistStore.activeQueue?.songs ?? []).find((s) => s.id === playerStore.currentTrackId) ||
      playlistStore.defaultList.find((s) => s.id === playerStore.currentTrackId) ||
      playlistStore.favorites.find((s) => s.id === playerStore.currentTrackId) ||
      playerStore.currentTrackSnapshot;
    if (!track) return;
    const exists = playlistStore.favorites.some((s) => s.id === track.id);
    if (exists) playlistStore.removeFromFavorites(track.id);
    else playlistStore.addToFavorites(track);
  } else if (command === 'togglePlayMode') {
    const nextMode =
      playerStore.playMode === 'sequential'
        ? 'list'
        : playerStore.playMode === 'list'
          ? 'random'
          : playerStore.playMode === 'random'
            ? 'single'
            : 'sequential';
    playerStore.setPlayMode(nextMode);
  } else if (command === 'toggleWindow') {
    window.electron?.ipcRenderer?.send('window-toggle', null);
  }
};

export const registerLocalShortcuts = () => {
  const settingStore = useSettingStore();

  const handler = (event: KeyboardEvent) => {
    if (!settingStore.shortcutEnabled) return;
    if (event.repeat) return;
    const shortcutMap = resolveShortcutMap('local');
    const pressed = buildShortcut(event);
    const matched = (Object.entries(shortcutMap) as Array<[ShortcutCommand, string]>).find(
      ([, accelerator]) => accelerator && acceleratorToKeys(accelerator).includes(pressed),
    );
    if (!matched) return;
    event.preventDefault();
    executeShortcutCommand(matched[0]);
  };

  window.addEventListener('keydown', handler);

  return () => {
    window.removeEventListener('keydown', handler);
  };
};

export const syncGlobalShortcuts = async () => {
  const settingStore = useSettingStore();
  const shortcutMap = resolveShortcutMap('global');
  const enabled = settingStore.globalShortcutsEnabled;
  const result = await window.electron?.shortcuts?.register({ enabled, shortcutMap });
  showGlobalShortcutFailures(result);
};

export const initShortcutSync = () => {
  const removeLocal = registerLocalShortcuts();
  void syncGlobalShortcuts();
  const removeGlobal = window.electron?.shortcuts?.onTrigger((command) => {
    if (!command) return;
    executeShortcutCommand(command as ShortcutCommand);
  });
  return () => {
    removeLocal();
    if (typeof removeGlobal === 'function') removeGlobal();
  };
};
