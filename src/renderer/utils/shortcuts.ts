import { usePlayerStore } from '@/stores/player';
import { usePlaylistStore } from '@/stores/playlist';
import { useSettingStore } from '@/stores/setting';
import { useDesktopLyricStore } from '@/desktopLyric/store';
import { useLyricStore } from '@/stores/lyric';
import { useToastStore } from '@/stores/toast';
import type {
  ShortcutCommand,
  ShortcutMap,
  ShortcutRegistrationResult,
} from '../../shared/shortcuts';

type ShortcutDisplayPlatform = 'darwin' | 'win32' | 'linux' | string;

const MODIFIER_KEY_TOKENS = new Set(['control', 'shift', 'alt', 'meta']);
const FUNCTION_KEY_PATTERN = /^F(?:[1-9]|1\d|2[0-4])$/i;
const NUMPAD_CODE_LABELS: Record<string, string> = {
  Numpad0: 'Num0',
  Numpad1: 'Num1',
  Numpad2: 'Num2',
  Numpad3: 'Num3',
  Numpad4: 'Num4',
  Numpad5: 'Num5',
  Numpad6: 'Num6',
  Numpad7: 'Num7',
  Numpad8: 'Num8',
  Numpad9: 'Num9',
  NumpadAdd: 'NumAdd',
  NumpadSubtract: 'NumSubtract',
  NumpadMultiply: 'NumMultiply',
  NumpadDivide: 'NumDivide',
  NumpadDecimal: 'NumDecimal',
  NumpadEnter: 'NumEnter',
  NumpadEqual: 'NumEqual',
  NumpadClear: 'NumClear',
};
const SPECIAL_KEY_LABELS: Record<string, string> = {
  ' ': 'Space',
  Spacebar: 'Space',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Home: 'Home',
  End: 'End',
  Insert: 'Insert',
  Delete: 'Delete',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Enter: 'Enter',
  Return: 'Enter',
  Escape: 'Escape',
  Esc: 'Escape',
  CapsLock: 'CapsLock',
  NumLock: 'NumLock',
  ScrollLock: 'ScrollLock',
  PrintScreen: 'PrintScreen',
  Fn: 'Fn',
  FnLock: 'FnLock',
};
const STANDALONE_SHORTCUT_LABELS = new Set([
  ...Object.values(SPECIAL_KEY_LABELS),
  ...Object.values(NUMPAD_CODE_LABELS),
  ...Array.from({ length: 24 }, (_item, index) => `F${index + 1}`),
]);

const normalizeEventKeyLabel = (event: KeyboardEvent): string => {
  if (event.code && Object.prototype.hasOwnProperty.call(NUMPAD_CODE_LABELS, event.code)) {
    return NUMPAD_CODE_LABELS[event.code];
  }
  const key = event.key || '';
  if (Object.prototype.hasOwnProperty.call(SPECIAL_KEY_LABELS, key)) return SPECIAL_KEY_LABELS[key];
  if (FUNCTION_KEY_PATTERN.test(key)) return key.toUpperCase();
  if (key.length === 1) return key.toUpperCase();
  return key;
};

const normalizeKeyForMatch = (key: string): string => {
  const normalized = normalizeDisplayToken(key);
  const lower = normalized.toLowerCase();
  if (lower.startsWith('num')) return `numpad${lower.slice(3)}`;
  if (lower === 'left') return 'arrowleft';
  if (lower === 'right') return 'arrowright';
  if (lower === 'up') return 'arrowup';
  if (lower === 'down') return 'arrowdown';
  return lower;
};

const getShortcutMainLabel = (label: string): string => {
  const tokens = parseShortcutLabelParts(label).map(normalizeDisplayToken).filter(Boolean);
  return (
    tokens.find(
      (token) => !['cmdorctrl', 'ctrl', 'shift', 'alt', 'meta'].includes(token.toLowerCase()),
    ) ?? ''
  );
};

export const canUseStandaloneShortcutLabel = (label: string): boolean => {
  const mainLabel = getShortcutMainLabel(label);
  return Boolean(mainLabel && STANDALONE_SHORTCUT_LABELS.has(mainLabel));
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
  if (lower === 'pageup' || lower === 'page-up') return 'PageUp';
  if (lower === 'pagedown' || lower === 'page-down') return 'PageDown';
  if (lower === 'esc') return 'Escape';
  if (lower === 'return') return 'Enter';
  if (lower === 'fn' || lower === 'fnlock') return lower === 'fnlock' ? 'FnLock' : 'Fn';
  if (FUNCTION_KEY_PATTERN.test(normalized)) return normalized.toUpperCase();
  if (/^(?:numpad|num)[0-9]$/i.test(normalized)) return `Num${normalized.slice(-1)}`;
  if (['numpadadd', 'numadd'].includes(lower)) return 'NumAdd';
  if (['numpadsubtract', 'numsubtract', 'numsub'].includes(lower)) return 'NumSubtract';
  if (['numpadmultiply', 'nummultiply', 'nummul'].includes(lower)) return 'NumMultiply';
  if (['numpaddivide', 'numdivide', 'numdiv'].includes(lower)) return 'NumDivide';
  if (['numpaddecimal', 'numdecimal'].includes(lower)) return 'NumDecimal';
  if (['numpadenter', 'numenter'].includes(lower)) return 'NumEnter';
  if (['numpadequal', 'numequal'].includes(lower)) return 'NumEqual';
  if (['numpadclear', 'numclear'].includes(lower)) return 'NumClear';
  if (lower === 'spacebar' || lower === 'space') return 'Space';
  return normalized.length === 1 ? normalized.toUpperCase() : normalized;
};

const formatDisplayMainToken = (token: string, platform: ShortcutDisplayPlatform) => {
  if (platform === 'darwin') {
    if (token === 'Left') return '←';
    if (token === 'Right') return '→';
    if (token === 'Up') return '↑';
    if (token === 'Down') return '↓';
  }
  if (token === 'NumAdd') return 'Num+';
  if (token === 'NumSubtract') return 'Num-';
  if (token === 'NumMultiply') return 'Num*';
  if (token === 'NumDivide') return 'Num/';
  if (token === 'NumDecimal') return 'Num.';
  if (token === 'NumEqual') return 'Num=';
  return token;
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
        return formatDisplayMainToken(token, platform);
      })
      .join('');
  }

  return ordered
    .map((token) => {
      if (token === 'cmdorctrl' || token === 'ctrl') return 'Ctrl';
      if (token === 'shift') return 'Shift';
      if (token === 'alt') return 'Alt';
      if (token === 'meta') return 'Win';
      return formatDisplayMainToken(token, platform);
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
  const mainKey = normalizeEventKeyLabel(event);
  const normalizedMainKey = normalizeKeyForMatch(mainKey);
  if (normalizedMainKey && !MODIFIER_KEY_TOKENS.has(normalizedMainKey)) {
    keys.add(normalizedMainKey);
  }
  return Array.from(keys).sort().join('+');
};

export const buildShortcutLabelFromEvent = (
  event: KeyboardEvent,
  platform: ShortcutDisplayPlatform = window.electron?.platform ?? '',
): string => {
  const mainKey = normalizeEventKeyLabel(event);
  if (!mainKey || MODIFIER_KEY_TOKENS.has(mainKey.toLowerCase())) return '';
  const isMac = platform === 'darwin';
  if (isMac) {
    const parts = [
      event.metaKey ? '⌘' : '',
      event.shiftKey ? '⇧' : '',
      event.altKey ? '⌥' : '',
      event.ctrlKey ? '⌃' : '',
      mainKey,
    ].filter(Boolean);
    return parts.join('');
  }
  const parts = [
    event.ctrlKey ? 'Ctrl' : '',
    event.shiftKey ? 'Shift' : '',
    event.altKey ? 'Alt' : '',
    event.metaKey ? 'Meta' : '',
    mainKey,
  ].filter(Boolean);
  return parts.join('+');
};

const labelToAccelerator = (label: string): string => {
  const normalizedLabel = label
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

  return parseShortcutLabelParts(normalizedLabel)
    .map(normalizeDisplayToken)
    .map((token) => {
      const lower = token.toLowerCase();
      if (['cmdorctrl', 'commandorcontrol', 'command', 'cmd'].includes(lower)) {
        return 'CmdOrCtrl';
      }
      if (lower === 'ctrl' || lower === 'control') return 'Ctrl';
      if (lower === 'shift') return 'Shift';
      if (lower === 'alt' || lower === 'option') return 'Alt';
      if (lower === 'meta' || lower === 'win' || lower === 'super') return 'Meta';
      return token;
    })
    .filter(Boolean)
    .join('+');
};

const acceleratorToKeys = (accelerator: string): string[] => {
  const cleaned = accelerator.replace(/\s+/g, '');
  if (!cleaned) return [];
  const parts = cleaned.split('+').filter(Boolean);
  const modifiers: string[] = [];
  const keys: string[] = [];
  let hasCmdOrCtrl = false;

  for (const part of parts) {
    const normalizedPart = normalizeDisplayToken(part);
    const lower = normalizedPart.toLowerCase();
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
    if (['meta', 'win', 'super'].includes(lower)) {
      modifiers.push('meta');
      continue;
    }
    keys.push(normalizeKeyForMatch(normalizedPart));
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
    seekForward: labelToAccelerator(bindings.seekForward ?? defaults.seekForward ?? ''),
    seekBackward: labelToAccelerator(bindings.seekBackward ?? defaults.seekBackward ?? ''),
    toggleMainLyric: labelToAccelerator(bindings.toggleMainLyric ?? defaults.toggleMainLyric ?? ''),
    toggleDesktopLyric: labelToAccelerator(
      bindings.toggleDesktopLyric ?? defaults.toggleDesktopLyric ?? '',
    ),
    toggleLyricsMode: '',
    cycleLyricsMode: '',
    openLyricSource: '',
    volumeUp: labelToAccelerator(bindings.volumeUp ?? defaults.volumeUp ?? ''),
    volumeDown: labelToAccelerator(bindings.volumeDown ?? defaults.volumeDown ?? ''),
    toggleMute: labelToAccelerator(bindings.toggleMute ?? defaults.toggleMute ?? ''),
    toggleFavorite: labelToAccelerator(bindings.toggleFavorite ?? defaults.toggleFavorite ?? ''),
    togglePlayMode: labelToAccelerator(bindings.togglePlayMode ?? defaults.togglePlayMode ?? ''),
    toggleMiniPlayer: labelToAccelerator(
      bindings.toggleMiniPlayer ?? defaults.toggleMiniPlayer ?? '',
    ),
    toggleWindow: labelToAccelerator(bindings.toggleWindow ?? defaults.toggleWindow ?? ''),
    toggleSidebar: labelToAccelerator(bindings.toggleSidebar ?? defaults.toggleSidebar ?? ''),
  };
};

const getShortcutCommandLabel = (command: ShortcutCommand) => {
  const labels: Record<ShortcutCommand, string> = {
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
  const settingStore = useSettingStore();
  const desktopLyricStore = useDesktopLyricStore();

  if (command === 'togglePlayback') {
    playerStore.togglePlay();
  } else if (command === 'previousTrack') {
    playerStore.prev();
  } else if (command === 'nextTrack') {
    playerStore.next();
  } else if (command === 'seekForward') {
    const offset = settingStore.seekForwardOffset ?? 5;
    const newTime = Math.min(playerStore.duration, playerStore.currentTime + offset);
    playerStore.seek(newTime);
  } else if (command === 'seekBackward') {
    const offset = settingStore.seekBackwardOffset ?? 5;
    const newTime = Math.max(0, playerStore.currentTime - offset);
    playerStore.seek(newTime);
  } else if (command === 'toggleMainLyric') {
    playerStore.toggleLyricView();
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
  } else if (command === 'openLyricSource') {
    playerStore.toggleLyricView(true);
    lyricStore.sourceDialogOpen = true;
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
  } else if (command === 'toggleMiniPlayer') {
    void window.electron?.miniPlayer?.toggle?.();
  } else if (command === 'toggleWindow') {
    window.electron?.ipcRenderer?.send('window-toggle', null);
  } else if (command === 'toggleSidebar') {
    if (settingStore.sidebarCollapseEnabled) {
      const handledByLayout = !window.dispatchEvent(
        new CustomEvent('echo:toggle-sidebar', { cancelable: true }),
      );
      if (handledByLayout) return;

      settingStore.sidebarCollapsed = !settingStore.sidebarCollapsed;
    }
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
