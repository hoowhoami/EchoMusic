import { defineStore } from 'pinia';
import { useToastStore } from './toast';
import type { DesktopLyricSettings } from '../../shared/desktop-lyric';

type OutputDeviceOption = {
  label: string;
  value: string;
  disabled?: boolean;
};

export type OutputDeviceDisconnectBehavior = 'pause' | 'fallback';

type OutputDeviceStatus = 'idle' | 'ready' | 'unsupported' | 'permission' | 'fallback' | 'error';

const DEFAULT_DESKTOP_LYRIC_SETTINGS: DesktopLyricSettings = {
  enabled: false,
  locked: false,
  clickThrough: true,
  autoShow: true,
  alwaysOnTop: true,
  secondaryEnabled: false,
  theme: 'system',
  opacity: 0.92,
  scale: 1,
  fontFamily:
    'SF Pro Display, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Inter, system-ui, sans-serif',
  inactiveFontSize: 26,
  activeFontSize: 40,
  secondaryFontSize: 18,
  lineGap: 14,
  width: 960,
  height: 220,
  secondaryMode: 'none',
  alignment: 'center',
  fontSize: 30,
  doubleLine: true,
  playedColor: '#31cfa1',
  unplayedColor: '#b9b9b9',
  strokeColor: '#f1b8b3',
  strokeEnabled: false,
  bold: false,
};

export const DEFAULT_SHORTCUT_LABELS: Record<string, string> = {
  togglePlayback: '⌘Space',
  previousTrack: '⌘←',
  nextTrack: '⌘→',
  toggleMainLyric: '⌘K',
  toggleDesktopLyric: '⌘D',
  volumeUp: '⌘↑',
  volumeDown: '⌘↓',
  toggleMute: '⌘M',
  toggleFavorite: '⌘L',
  togglePlayMode: '⌘P',
  toggleWindow: '⌘W',
};

export const DEFAULT_GLOBAL_SHORTCUT_LABELS: Record<string, string> = {
  togglePlayback: '⌘⇧Space',
  previousTrack: '⌘⇧←',
  nextTrack: '⌘⇧→',
  toggleMainLyric: '⌘⇧K',
  toggleDesktopLyric: '⌘⇧D',
  volumeUp: '⌘⇧↑',
  volumeDown: '⌘⇧↓',
  toggleMute: '⌘⇧M',
  toggleFavorite: '⌘⇧L',
  togglePlayMode: '⌘⇧P',
  toggleWindow: '⌘⇧W',
};

export const useSettingStore = defineStore('setting', {
  state: () => ({
    theme: 'system' as 'light' | 'dark' | 'system',
    language: 'zh-CN',
    shortcutEnabled: true,
    autoPlay: true,
    rememberWindowSize: true,
    showPlaylistCount: true,
    closeBehavior: 'tray' as 'tray' | 'exit',
    replacePlaylist: false,
    volumeFade: true,
    volumeFadeTime: 1000,
    autoNext: false,
    autoNextDelaySeconds: 3,
    autoNextMaxAttempts: 10,
    preventSleep: true,
    defaultAudioQuality: 'high' as '128' | '320' | 'flac' | 'high',
    compatibilityMode: true,
    globalShortcutsEnabled: false,
    shortcutBindings: {} as Record<string, string>,
    globalShortcutBindings: {} as Record<string, string>,
    defaultShortcutLabels: { ...DEFAULT_SHORTCUT_LABELS } as Record<string, string>,
    defaultGlobalShortcutLabels: { ...DEFAULT_GLOBAL_SHORTCUT_LABELS } as Record<string, string>,
    outputDevice: 'default',
    outputDevices: [
      { label: '系统默认', value: 'default' },
    ] as OutputDeviceOption[],
    outputDeviceType: 'default' as 'default' | 'wasapi',
    outputDeviceStatus: 'idle' as OutputDeviceStatus,
    outputDeviceStatusMessage: '',
    outputDeviceDisconnectBehavior: 'pause' as OutputDeviceDisconnectBehavior,
    autoReceiveVip: false,
    checkPrerelease: false,
    appVersion: '',
    isPrerelease: false,
    searchHistory: [] as string[],
    userAgreementAccepted: false,
    desktopLyric: { ...DEFAULT_DESKTOP_LYRIC_SETTINGS } as DesktopLyricSettings,
  }),
  actions: {
    setTheme(theme: 'light' | 'dark' | 'system') {
      this.theme = theme;
      this.syncTheme();
    },
    toggleShortcuts(enabled: boolean) {
      this.shortcutEnabled = enabled;
    },
    resetShortcutDefaults() {
      this.defaultShortcutLabels = { ...DEFAULT_SHORTCUT_LABELS };
      this.defaultGlobalShortcutLabels = { ...DEFAULT_GLOBAL_SHORTCUT_LABELS };
    },
    openLogDirectory() {
      if (window.electron?.ipcRenderer) {
        window.electron.ipcRenderer.send('open-log-directory', null);
      }
    },
    clearAppData() {
      if (window.electron?.ipcRenderer) {
        window.electron.ipcRenderer.send('clear-app-data', null);
      }
      localStorage.clear();
      sessionStorage.clear();
      this.$reset();
      window.setTimeout(() => {
        window.location.reload();
      }, 80);
    },
    checkForUpdates(silent = false) {
      if (window.electron?.ipcRenderer) {
        window.electron.ipcRenderer.send('check-for-updates', {
          prerelease: this.checkPrerelease,
          silent,
        });
      }
    },
    async hydrateAppInfo() {
      if (!window.electron?.appInfo) return;
      try {
        const appInfo = await window.electron.appInfo.get();
        this.appVersion = String(appInfo.version || '').trim();
        this.isPrerelease = Boolean(appInfo.isPrerelease);
      } catch {
        // ignore hydration failure and keep current value
      }
    },
    openRepo() {
      if (window.electron?.ipcRenderer) {
        window.electron.ipcRenderer.send('open-external', 'https://github.com/hoowhoami/EchoMusic');
      }
    },
    openDisclaimer() {
      if (window.electron?.ipcRenderer) {
        window.electron.ipcRenderer.send('open-disclaimer', null);
      }
    },
    syncCloseBehavior() {
      if (window.electron?.ipcRenderer) {
        window.electron.ipcRenderer.send('update-close-behavior', this.closeBehavior);
      }
    },
    syncTheme() {
      if (window.electron?.ipcRenderer) {
        window.electron.ipcRenderer.send('update-theme', this.theme);
      }
    },
    syncRememberWindowSize() {
      if (window.electron?.ipcRenderer) {
        window.electron.ipcRenderer.send('update-remember-window-size', this.rememberWindowSize);
      }
    },
    syncPreventSleep(isPlaying = false) {
      if (window.electron?.ipcRenderer) {
        window.electron.ipcRenderer.send('update-power-save-blocker', {
          enabled: this.preventSleep,
          isPlaying,
        });
      }
    },
    async hydrateDesktopLyric() {
      if (!window.electron?.desktopLyric) return;
      const toastStore = useToastStore();
      try {
        const snapshot = await window.electron.desktopLyric.getSnapshot();
        this.desktopLyric = {
          ...DEFAULT_DESKTOP_LYRIC_SETTINGS,
          ...snapshot.settings,
        };
      } catch {
        toastStore.actionFailed('同步桌面歌词状态');
      }
    },
    async syncDesktopLyricSettings(partial?: Partial<DesktopLyricSettings>) {
      if (!window.electron?.desktopLyric) return;
      const toastStore = useToastStore();
      const payload = {
        ...this.desktopLyric,
        ...(partial ?? {}),
      };
      try {
        const snapshot = await window.electron.desktopLyric.updateSettings(payload);
        this.desktopLyric = {
          ...DEFAULT_DESKTOP_LYRIC_SETTINGS,
          ...snapshot.settings,
        };
      } catch {
        toastStore.actionFailed('同步桌面歌词设置');
      }
    },
    async setDesktopLyricEnabled(enabled: boolean) {
      this.desktopLyric = {
        ...this.desktopLyric,
        enabled,
      };
      if (!window.electron?.desktopLyric) return;
      const toastStore = useToastStore();
      try {
        const snapshot = enabled
          ? await window.electron.desktopLyric.show()
          : await window.electron.desktopLyric.hide();
        this.desktopLyric = {
          ...DEFAULT_DESKTOP_LYRIC_SETTINGS,
          ...snapshot.settings,
        };
      } catch {
        toastStore.actionFailed(enabled ? '开启桌面歌词' : '关闭桌面歌词');
      }
    },
    setDesktopLyricLocal(partial: Partial<DesktopLyricSettings>) {
      this.desktopLyric = {
        ...this.desktopLyric,
        ...partial,
      };
    },
    setOutputDeviceStatus(status: OutputDeviceStatus, message = '') {
      this.outputDeviceStatus = status;
      this.outputDeviceStatusMessage = message;
    },
    addToSearchHistory(keyword: string) {
      const normalized = keyword.trim();
      if (!normalized) return;
      this.searchHistory = [normalized, ...this.searchHistory.filter((item) => item !== normalized)].slice(0, 20);
    },
    removeFromSearchHistory(keyword: string) {
      this.searchHistory = this.searchHistory.filter((item) => item !== keyword);
    },
    clearSearchHistory() {
      this.searchHistory = [];
    },
    acceptUserAgreement() {
      this.userAgreementAccepted = true;
    },
  },
  persist: true,
});
