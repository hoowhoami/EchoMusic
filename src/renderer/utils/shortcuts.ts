import { usePlayerStore } from '@/stores/player';
import { usePlaylistStore } from '@/stores/playlist';
import { useSettingStore } from '@/stores/setting';
import { useDesktopLyricStore } from '@/desktopLyric/store';
import { useLyricStore } from '@/stores/lyric';
import router from '@/router';
import { closeTransientView } from '@/utils/navigation';
import type { ShortcutCommand, ShortcutMap } from '../../shared/shortcuts';

const normalizeKey = (key: string): string => {
  if (!key) return '';
  if (key === ' ') return 'space';
  return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
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
    lyricStore.toggleSecondaryEnabled();
  } else if (command === 'cycleLyricsMode') {
    lyricStore.cycleSecondaryMode();
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

export const syncGlobalShortcuts = () => {
  const settingStore = useSettingStore();
  const shortcutMap = resolveShortcutMap('global');
  const enabled = settingStore.globalShortcutsEnabled;
  window.electron?.shortcuts?.register({ enabled, shortcutMap });
};

export const initShortcutSync = () => {
  const removeLocal = registerLocalShortcuts();
  syncGlobalShortcuts();
  const removeGlobal = window.electron?.shortcuts?.onTrigger((command) => {
    if (!command) return;
    executeShortcutCommand(command as ShortcutCommand);
  });
  return () => {
    removeLocal();
    if (typeof removeGlobal === 'function') removeGlobal();
  };
};
