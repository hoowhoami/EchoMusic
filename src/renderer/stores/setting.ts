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
import {
  DEFAULT_NETWORK_SETTINGS,
  normalizeNetworkSettings,
  type NetworkSettings,
} from '../../shared/network';
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
  toggleMiniPlayer: '⌘I',
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
  toggleMiniPlayer: '⌘⇧I',
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

const toImpulseResponseFilePayload = (file: ImpulseResponseFile): ImpulseResponseFile => ({
  id: String(file.id || ''),
  name: String(file.name || ''),
  path: String(file.path || ''),
  size: Number(file.size) || 0,
  importedAt: Number(file.importedAt) || 0,
  format: file.format ? String(file.format) : undefined,
});

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
    autoPlayOnLaunch: false,
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
    lyricPageBackgroundRhythm: false,
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
    showFullscreenButton: true,
    outputDevice: 'default',
    outputDevices: [{ label: '系统默认', value: 'default' }] as OutputDeviceOption[],
    outputDeviceType: 'default' as 'default' | 'wasapi',
    exclusiveAudioDevice: false,
    outputDeviceStatus: 'idle' as OutputDeviceStatus,
    outputDeviceStatusMessage: '',
    outputDeviceDisconnectBehavior: 'pause' as OutputDeviceDisconnectBehavior,
    showAudioQualityBadge: true,
    showDesktopLyricStatus: true,
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
    highDpiEnabled: false,
    dpiScale: 1,
    autoLaunch: false,
    startMinimized: false,
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
    // 音频缓冲区设置
    audioCacheSecs: 30,
    audioDemuxerMaxMB: 48,
    audioDemuxerBackMB: 12,
    audioBufferSecs: 0.5,
    kugouApiProxyUrl: DEFAULT_NETWORK_SETTINGS.kugouApiProxyUrl,
    kugouApiTimeoutSecs: DEFAULT_NETWORK_SETTINGS.kugouApiTimeoutSecs,
    mpvHttpProxyUrl: DEFAULT_NETWORK_SETTINGS.mpvHttpProxyUrl,
    mpvNetworkTimeoutSecs: DEFAULT_NETWORK_SETTINGS.mpvNetworkTimeoutSecs,
    // 播放卡死检测：播放中进度超过该秒数无推进则判定卡死并自动恢复（0=禁用）
    playbackStallTimeout: 8,
    // 同一首歌连续卡死的最大自动恢复次数，超过则回退到失败提示/自动下一首
    playbackStallMaxAttempts: 3,
    // 快进 / 快退步长（秒）
    seekForwardOffset: 5,
    seekBackwardOffset: 5,
    // 歌词对齐微调步长（秒）
    lyricOffsetStep: 0.1,
    // DevTools 开关
    devToolsEnabled: false,
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
    ensureShortcutDefaults() {
      this.defaultShortcutLabels = {
        ...(this.defaultShortcutLabels ?? {}),
        ...DEFAULT_SHORTCUT_LABELS,
      };
      this.defaultGlobalShortcutLabels = {
        ...(this.defaultGlobalShortcutLabels ?? {}),
        ...DEFAULT_GLOBAL_SHORTCUT_LABELS,
      };
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
      void window.electron?.storage?.resetAll?.();
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
    syncHighDpiSettings() {
      this.dpiScale = Math.min(2, Math.max(0.5, Number(this.dpiScale) || 1));
      if (window.electron?.ipcRenderer) {
        window.electron.ipcRenderer.send('update-high-dpi-settings', {
          enabled: this.highDpiEnabled,
          dpiScale: this.dpiScale,
        });
      }
    },
    syncAutoLaunch() {
      if (window.electron?.ipcRenderer) {
        window.electron.ipcRenderer.send('update-auto-launch', this.autoLaunch);
      }
    },
    syncStartMinimized() {
      if (window.electron?.ipcRenderer) {
        window.electron.ipcRenderer.send('update-start-minimized', this.startMinimized);
      }
    },
    syncDevToolsEnabled() {
      if (window.electron?.ipcRenderer) {
        window.electron.ipcRenderer.send('update-devtools-enabled', this.devToolsEnabled);
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
    getNetworkSettings(): NetworkSettings {
      return normalizeNetworkSettings({
        kugouApiProxyUrl: this.kugouApiProxyUrl,
        kugouApiTimeoutSecs: this.kugouApiTimeoutSecs,
        mpvHttpProxyUrl: this.mpvHttpProxyUrl,
        mpvNetworkTimeoutSecs: this.mpvNetworkTimeoutSecs,
      });
    },
    syncNetworkSettings() {
      const settings = this.getNetworkSettings();
      this.kugouApiTimeoutSecs = settings.kugouApiTimeoutSecs;
      this.mpvNetworkTimeoutSecs = settings.mpvNetworkTimeoutSecs;
      void window.electron?.network?.update(settings);
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
      this.addImpulseResponseFiles([file]);
    },
    addImpulseResponseFiles(files: ImpulseResponseFile[]) {
      const normalizedFiles: ImpulseResponseFile[] = [];
      let names = this.impulseResponseFiles.map((item) => item.name);
      for (const file of files) {
        const normalizedFile = {
          ...file,
          name: getUniqueImpulseResponseName(file.name, names),
        };
        normalizedFiles.push(normalizedFile);
        names = [normalizedFile.name, ...names];
      }
      if (normalizedFiles.length === 0) return;
      const normalizedFile = {
        ...normalizedFiles[0],
      };
      this.impulseResponseFiles = [
        ...normalizedFiles,
        ...this.impulseResponseFiles.filter(
          (item) => !normalizedFiles.some((file) => file.id === item.id),
        ),
      ];
      this.selectedImpulseResponseId = normalizedFile.id;
    },
    async reconcileImpulseResponseFiles() {
      if (!window.electron?.audioEffects?.reconcileImpulseResponses) return;
      const nextFiles = await window.electron.audioEffects.reconcileImpulseResponses(
        this.impulseResponseFiles.map(toImpulseResponseFilePayload),
      );
      const nextIds = new Set(nextFiles.map((item) => item.id));
      this.impulseResponseFiles = nextFiles;
      if (this.selectedImpulseResponseId && !nextIds.has(this.selectedImpulseResponseId)) {
        this.selectedImpulseResponseId = nextFiles[0]?.id ?? '';
        this.impulseResponseEnabled = false;
      }
      if (nextFiles.length === 0) {
        this.selectedImpulseResponseId = '';
        this.impulseResponseEnabled = false;
      }
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
