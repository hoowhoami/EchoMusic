import type { CloseBehavior, ThemeMode } from '../../shared/app';
import type { DesktopLyricSettings } from '../../shared/desktop-lyric';
import { DEFAULT_DESKTOP_LYRIC_SETTINGS } from '../../shared/desktop-lyric';
import type { LogSettings } from '../../shared/logging';
import { DEFAULT_LOG_SETTINGS } from '../../shared/logging';
import { getKvStorage } from './kv';

export type MainWindowState = {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized: boolean;
  boundsMode?: 'window' | 'content';
};

export type MiniPlayerWindowState = {
  width: number;
  height: number;
  x?: number;
  y?: number;
  alwaysOnTop: boolean;
};

export type MainAppSettings = {
  closeBehavior: CloseBehavior;
  theme: ThemeMode;
  rememberWindowSize: boolean;
  preventSleep: boolean;
  disableGpuAcceleration: boolean;
  autoLaunch: boolean;
  startMinimized: boolean;
  highDpiEnabled: boolean;
  dpiScale: number;
  devToolsEnabled: boolean;
  windowState: MainWindowState;
  miniPlayerWindowState: MiniPlayerWindowState;
};

export type DesktopLyricWindowState = {
  width: number;
  height: number;
  x?: number;
  y?: number;
};

export type DesktopLyricPersistedSettings = DesktopLyricSettings & {
  windowState: DesktopLyricWindowState;
};

export const DEFAULT_MAIN_APP_SETTINGS: MainAppSettings = {
  closeBehavior: 'tray',
  theme: 'system',
  rememberWindowSize: true,
  preventSleep: true,
  disableGpuAcceleration: false,
  autoLaunch: false,
  startMinimized: false,
  highDpiEnabled: false,
  dpiScale: 1,
  devToolsEnabled: false,
  windowState: {
    width: 1100,
    height: 750,
    isMaximized: false,
  },
  miniPlayerWindowState: {
    width: 560,
    height: 120,
    alwaysOnTop: false,
  },
};

export const DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS: DesktopLyricPersistedSettings = {
  ...DEFAULT_DESKTOP_LYRIC_SETTINGS,
  windowState: {
    width: 800,
    height: 180,
  },
};

const MAIN_SETTINGS_KEY = 'main:settings';
const LOG_SETTINGS_KEY = 'main:logSettings';
const DESKTOP_LYRIC_SETTINGS_KEY = 'main:desktopLyricSettings';

const mergeObject = <T extends Record<string, unknown>>(defaults: T, saved: Partial<T> | null): T =>
  ({
    ...defaults,
    ...(saved ?? {}),
  }) as T;

export const getMainAppSettings = (): MainAppSettings => {
  const saved = getKvStorage().get<Partial<MainAppSettings>>(MAIN_SETTINGS_KEY);
  const merged = mergeObject(DEFAULT_MAIN_APP_SETTINGS, saved);
  return {
    ...merged,
    windowState: {
      ...DEFAULT_MAIN_APP_SETTINGS.windowState,
      ...(saved?.windowState ?? {}),
    },
    miniPlayerWindowState: {
      ...DEFAULT_MAIN_APP_SETTINGS.miniPlayerWindowState,
      ...(saved?.miniPlayerWindowState ?? {}),
    },
  };
};

export const setMainAppSetting = <K extends keyof MainAppSettings>(
  key: K,
  value: MainAppSettings[K],
) => {
  const next = {
    ...getMainAppSettings(),
    [key]: value,
  };
  getKvStorage().set(MAIN_SETTINGS_KEY, next);
};

export const getDisableGpuAccelerationSetting = () =>
  Boolean(getMainAppSettings().disableGpuAcceleration);

export const getHighDpiSettings = () => {
  const settings = getMainAppSettings();
  const dpiScale = Math.min(2, Math.max(0.5, Number(settings.dpiScale) || 1));
  return {
    enabled: Boolean(settings.highDpiEnabled),
    dpiScale,
  };
};

export const getDevToolsEnabledSetting = () => Boolean(getMainAppSettings().devToolsEnabled);

export const getPersistedLogSettings = (): LogSettings =>
  getKvStorage().get<LogSettings>(LOG_SETTINGS_KEY) ?? DEFAULT_LOG_SETTINGS;

export const setPersistedLogSettings = (settings: LogSettings) => {
  getKvStorage().set(LOG_SETTINGS_KEY, settings);
};

export const getDesktopLyricPersistedSettings = (): DesktopLyricPersistedSettings => {
  const saved = getKvStorage().get<Partial<DesktopLyricPersistedSettings>>(
    DESKTOP_LYRIC_SETTINGS_KEY,
  );
  const merged = mergeObject(DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS, saved);
  return {
    ...merged,
    windowState: {
      ...DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS.windowState,
      ...(saved?.windowState ?? {}),
    },
  };
};

export const patchDesktopLyricPersistedSettings = (
  patch: Partial<DesktopLyricPersistedSettings>,
) => {
  getKvStorage().set(DESKTOP_LYRIC_SETTINGS_KEY, {
    ...getDesktopLyricPersistedSettings(),
    ...patch,
    windowState: {
      ...getDesktopLyricPersistedSettings().windowState,
      ...(patch.windowState ?? {}),
    },
  });
};
