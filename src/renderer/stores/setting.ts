import { defineStore } from 'pinia';
import type { CloseBehavior, ThemeMode } from '../../shared/app';
import type { AppLogLevel, LogSettings } from '../../shared/logging';
import type {
  AudioQualityValue,
  OutputDeviceDisconnectBehavior,
  OutputDeviceOption,
  OutputDeviceStatus,
} from '../types';
import { buildFontFamily } from '../../shared/font';
import { normalizeImpulseResponseName, type ImpulseResponseFile } from '../../shared/audio';
import { configureRendererLogger } from '@/utils/logger';

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
  toggleSidebar: '⌘B',
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
  toggleWindow: '⌥⌘S',
  toggleSidebar: '⌘⇧B',
};

const getUniqueImpulseResponseName = (name: string, existingNames: string[]): string => {
  const baseName = normalizeImpulseResponseName(name);
  const usedNames = new Set(
    existingNames.map((item) => normalizeImpulseResponseName(item).toLocaleLowerCase()),
  );
  if (!usedNames.has(baseName.toLocaleLowerCase())) return baseName;

  let index = 2;
  while (true) {
    const nextName = `${baseName} ${index}`;
    if (!usedNames.has(nextName.toLocaleLowerCase())) return nextName;
    index += 1;
  }
};

export const useSettingStore = defineStore('setting', {
  state: () => ({
    theme: 'system' as ThemeMode,
    language: 'zh-CN',
    shortcutEnabled: true,
    autoPlay: true,
    rememberWindowSize: true,
    showPlaylistCount: true,
    searchDefaultEnabled: false,
    closeBehavior: 'tray' as CloseBehavior,
    replacePlaylist: false,
    volumeFade: true,
    volumeFadeTime: 1000,
    lyricViewMode: 'cover' as 'cover' | 'portrait' | 'lyric',
    lyricArtistBackdrop: true,
    lyricBackdropOpacity: 50,
    lyricCarouselEnabled: true,
    lyricCarouselInterval: 15,
    lyricAutoCollapseDelay: 5,
    lyricAutoCollapseEnabled: true,
    lyricCollapseHideControls: false,
    lyricPageBackgroundBlur: false,
    lyricFilterEnabled: false,
    lyricFilterPattern: '',
    desktopLyricFilterEnabled: false,
    desktopLyricFilterPattern: '',
    autoNext: false,
    autoNextDelaySeconds: 3,
    autoNextMaxAttempts: 10,
    preventSleep: true,
    defaultAudioQuality: 'high' as AudioQualityValue,
    compatibilityMode: true,
    globalShortcutsEnabled: false,
    shortcutBindings: {} as Record<string, string>,
    globalShortcutBindings: {} as Record<string, string>,
    defaultShortcutLabels: { ...DEFAULT_SHORTCUT_LABELS } as Record<string, string>,
    defaultGlobalShortcutLabels: { ...DEFAULT_GLOBAL_SHORTCUT_LABELS } as Record<string, string>,
    sidebarCollapsed: false,
    sidebarCollapseEnabled: false,
    outputDevice: 'default',
    outputDevices: [{ label: '系统默认', value: 'default' }] as OutputDeviceOption[],
    outputDeviceType: 'default' as 'default' | 'wasapi',
    exclusiveAudioDevice: false,
    outputDeviceStatus: 'idle' as OutputDeviceStatus,
    outputDeviceStatusMessage: '',
    outputDeviceDisconnectBehavior: 'pause' as OutputDeviceDisconnectBehavior,
    autoReceiveVip: false,
    showAudioQualityBadge: true,
    volumeNormalization: true,
    volumeNormalizationLufs: -14,
    impulseResponseEnabled: false,
    selectedImpulseResponseId: '',
    impulseResponseMix: 0.4,
    impulseResponseFiles: [] as ImpulseResponseFile[],
    impulseResponseSafetyMigrationDone: false,
    keepAliveEnabled: true,
    keepAliveMax: 20,
    playResumeTimeout: 5,
    silentUpdate: true,
    autoCheckUpdate: true,
    checkPrerelease: false,
    githubProxyUrl: '',
    appVersion: '',
    isPrerelease: false,
    searchHistory: [] as string[],
    userAgreementAccepted: false,
    disableGpuAcceleration: false,
    logLevel: 'info' as AppLogLevel,
    logApiResponseBody: false,
    logDiagnosticUntil: 0,
    // 字体设置
    globalFont: 'system-ui',
    lyricFont: 'follow',
    // 输入设备（麦克风）
    inputDevice: 'default',
    // 侧边栏板块折叠状态
    sidebarSectionCollapsed: { discover: false, library: false } as Record<string, boolean>,
    // 歌单排序方式
    playlistSortOrder: 'default' as 'default' | 'time-desc' | 'time-asc' | 'name-asc' | 'name-desc',
  }),
  actions: {
    setTheme(theme: ThemeMode) {
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
          githubProxyUrl: this.githubProxyUrl,
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
    syncDisableGpuAcceleration() {
      if (window.electron?.ipcRenderer) {
        window.electron.ipcRenderer.send(
          'update-disable-gpu-acceleration',
          this.disableGpuAcceleration,
        );
      }
    },
    getLogSettings(): LogSettings {
      return {
        level: this.logLevel,
        apiResponseBody: this.logApiResponseBody,
        diagnosticUntil: this.logDiagnosticUntil,
      };
    },
    syncLogSettings() {
      const settings = this.getLogSettings();
      configureRendererLogger(settings);
      if (window.electron?.logging) {
        void window.electron.logging.update(settings);
      } else if (window.electron?.ipcRenderer) {
        window.electron.ipcRenderer.send('logging:update-settings', settings);
      }
    },
    setLogLevel(level: AppLogLevel) {
      this.logLevel = level;
      this.syncLogSettings();
    },
    setLogApiResponseBody(enabled: boolean) {
      this.logApiResponseBody = enabled;
      this.syncLogSettings();
    },
    enableTemporaryDiagnosticLogging(minutes = 10) {
      this.logDiagnosticUntil = Date.now() + Math.max(1, minutes) * 60 * 1000;
      this.syncLogSettings();
    },
    disableTemporaryDiagnosticLogging() {
      this.logDiagnosticUntil = 0;
      this.syncLogSettings();
    },
    setOutputDeviceStatus(status: OutputDeviceStatus, message = '') {
      this.outputDeviceStatus = status;
      this.outputDeviceStatusMessage = message;
    },
    addImpulseResponseFile(file: ImpulseResponseFile) {
      const normalizedFile = {
        ...file,
        name: getUniqueImpulseResponseName(
          file.name,
          this.impulseResponseFiles.filter((item) => item.id !== file.id).map((item) => item.name),
        ),
      };
      this.impulseResponseFiles = [
        normalizedFile,
        ...this.impulseResponseFiles.filter((item) => item.id !== normalizedFile.id),
      ];
      this.selectedImpulseResponseId = normalizedFile.id;
    },
    removeImpulseResponseFile(id: string) {
      const target = this.impulseResponseFiles.find((item) => item.id === id);
      this.impulseResponseFiles = this.impulseResponseFiles.filter((item) => item.id !== id);
      if (this.selectedImpulseResponseId === id) {
        const next = this.impulseResponseFiles[0] ?? null;
        this.selectedImpulseResponseId = next?.id ?? '';
        this.impulseResponseEnabled = false;
      }
      if (target?.path && window.electron?.audioEffects) {
        void window.electron.audioEffects.deleteImpulseResponse(target.path);
      }
    },
    setSelectedImpulseResponse(id: string) {
      if (!this.impulseResponseFiles.some((item) => item.id === id)) return;
      this.selectedImpulseResponseId = id;
      this.impulseResponseEnabled = true;
    },
    renameImpulseResponseFile(id: string, name: string) {
      const normalizedName = getUniqueImpulseResponseName(
        name,
        this.impulseResponseFiles.filter((item) => item.id !== id).map((item) => item.name),
      );
      this.impulseResponseFiles = this.impulseResponseFiles.map((item) =>
        item.id === id ? { ...item, name: normalizedName } : item,
      );
    },
    setImpulseResponseMix(value: number) {
      this.impulseResponseMix = Math.min(1, Math.max(0.1, Number(value) || 0.4));
    },
    getSelectedImpulseResponse(): ImpulseResponseFile | null {
      if (!this.selectedImpulseResponseId) return null;
      return (
        this.impulseResponseFiles.find((item) => item.id === this.selectedImpulseResponseId) ?? null
      );
    },
    addToSearchHistory(keyword: string) {
      const normalized = keyword.trim();
      if (!normalized) return;
      this.searchHistory = [
        normalized,
        ...this.searchHistory.filter((item) => item !== normalized),
      ].slice(0, 20);
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
    // 获取系统字体列表
    async fetchSystemFonts(): Promise<string[]> {
      if (!window.electron?.fonts) return [];
      try {
        const fonts = await window.electron.fonts.getAll();
        return (fonts ?? []).map((f: string) => f.replace(/^['"]+|['"]+$/g, ''));
      } catch {
        return [];
      }
    },
    // 构建全局 font-family 字符串
    buildGlobalFontFamily(): string {
      return buildFontFamily(this.globalFont);
    },
    // 构建歌词区域 font-family 字符串
    buildLyricFontFamily(): string {
      if (!this.lyricFont || this.lyricFont === 'follow') return this.buildGlobalFontFamily();
      return buildFontFamily(this.lyricFont);
    },
  },
  persist: true,
});
