import * as Vue from 'vue';
import { computed, reactive, watch, type App as VueApp } from 'vue';
import type { Pinia } from 'pinia';
import type { Router } from 'vue-router';
import { Icon } from '@iconify/vue';
import type {
  EchoPluginDescriptor,
  EchoPluginManifest,
  PluginFailureRecord,
  PluginListResult,
  PluginProcessLaunchOptions,
  PluginProcessLaunchResult,
  PluginProcessTerminateResult,
  PluginWindowBounds,
  PluginWindowShowOptions,
} from '../../shared/plugins';
import type { AudioSpectrumFrame, AudioSpectrumOptions } from '../../shared/audio-spectrum';
import type {
  NowPlayingAppearancePayload,
  NowPlayingCommand,
  NowPlayingLyricPayload,
  NowPlayingSnapshot,
} from '../../shared/now-playing';
import { createFontApi } from '../../shared/font';
import * as icons from '@/icons';
import type { Song } from '@/models/song';
import { hexToRgb } from '@/utils/color';
import { usePlayerStore } from '@/stores/player';
import { usePlaylistStore, type SetPlaybackQueueOptions } from '@/stores/playlist';
import { useLyricStore } from '@/stores/lyric';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import { useThemeStore } from '@/stores/theme';
import type { AudioEffectValue, AudioQualityValue, PlayMode } from '@/types';
import { logger } from '@/utils/logger';
import { addSongToPlayNext, queueAndPlaySong, replaceQueueAndPlay } from '@/utils/playback';
import {
  createPluginUiApi,
  executePluginCommand,
  registerPluginCommand,
  removePluginContributions,
} from './registry';
import {
  registerPluginAudioSourceResolver,
  type PluginAudioSourceResolverContribution,
} from './audioSource';
import { registerPluginLyricResolver, type PluginLyricResolverContribution } from './lyrics';
import { registerPluginLyricEffect, type PluginLyricEffectContribution } from './lyricEffects';
import { createKugouApi, type PluginKugouApi } from './kugou';
import type { Component } from 'vue';

type PluginModule =
  | {
      activate?: (ctx: EchoPluginContext) => unknown;
      deactivate?: (ctx: EchoPluginContext) => unknown;
      default?: PluginModuleDefault;
    }
  | PluginModuleDefault;

type PluginModuleDefault =
  | ((ctx: EchoPluginContext) => unknown)
  | {
      activate?: (ctx: EchoPluginContext) => unknown;
      deactivate?: (ctx: EchoPluginContext) => unknown;
    };

export interface PluginSurfaceOptions {
  enabled?: boolean;
  mainOpacity?: number | string;
  sidebarOpacity?: number | string;
  cardOpacity?: number | string;
  elevatedOpacity?: number | string;
  dialogOpacity?: number | string;
  playerOpacity?: number | string;
  backdropFilter?: string;
  playerBackdropFilter?: string;
}

export type PluginPageTransitionMode = 'default' | 'out-in' | 'in-out';

export interface PluginPageTransitionOptions {
  enabled?: boolean;
  name?: string;
  css?: string;
  mode?: PluginPageTransitionMode;
  appear?: boolean;
  durationMs?: number | string;
  easing?: string;
  enterOpacity?: number | string;
  leaveOpacity?: number | string;
  enterTranslateX?: number | string;
  enterTranslateY?: number | string;
  leaveTranslateX?: number | string;
  leaveTranslateY?: number | string;
  enterScale?: number | string;
  leaveScale?: number | string;
  enterFilter?: string;
  leaveFilter?: string;
}

/** 顶部主题色渐变氛围层的暗色专属覆盖（仅覆盖与主题强相关的视觉字段） */
export interface PluginAccentGradientDarkVariant {
  color?: string;
  peakOpacity?: number | string;
  midOpacity?: number | string;
  background?: string;
}

/** 顶部主题色渐变氛围层（横跨侧栏与内容顶部的色带）配置 */
export interface PluginAccentGradientOptions {
  /** 为 false 时隐藏整条渐变（等效 opacity:0） */
  enabled?: boolean;
  /** 整层不透明度倍率，支持 0-1 小数、0-100 数字或百分比字符串 */
  opacity?: number | string;
  /** 渐变基础颜色，支持十六进制或 'r,g,b' 字符串，默认跟随主题色 */
  color?: string;
  /** 渐变角度，数字按 deg 处理，如 180 或 '180deg' */
  angle?: number | string;
  /** 色带高度，数字按百分比处理，也接受 '240px' / '50%' */
  height?: number | string;
  /** 中段色标位置，数字按百分比处理，默认 60% */
  midPosition?: number | string;
  /** 顶部色标透明度（rgba alpha），支持 0-1 / 0-100 / 百分比 */
  peakOpacity?: number | string;
  /** 中段色标透明度（rgba alpha），支持 0-1 / 0-100 / 百分比 */
  midOpacity?: number | string;
  /** 完整 background 覆盖（逃生通道，设置后忽略上述颜色/透明度字段） */
  background?: string;
  /** 暗色模式专属覆盖 */
  dark?: PluginAccentGradientDarkVariant;
}

export interface PluginThemeApi {
  surface: {
    set: (options: PluginSurfaceOptions) => () => void;
    clear: () => void;
  };
  pageTransition: {
    set: (options: PluginPageTransitionOptions) => () => void;
    clear: () => void;
  };
  accentGradient: {
    set: (options: PluginAccentGradientOptions) => () => void;
    clear: () => void;
  };
}

export interface PluginScrollContainerState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceToBottom: number;
  canScroll: boolean;
  atTop: boolean;
  atBottom: boolean;
}

export interface PluginScrollContainerQueryOptions {
  role?: string;
  visible?: boolean;
}

export interface EchoPluginContext {
  id: string;
  manifest: EchoPluginManifest;
  descriptor: EchoPluginDescriptor;
  app: VueApp;
  vue: typeof Vue;
  router: Router;
  pinia: Pinia;
  stores: {
    player: ReturnType<typeof usePlayerStore>;
    playlist: ReturnType<typeof usePlaylistStore>;
    lyric: ReturnType<typeof useLyricStore>;
    settings: ReturnType<typeof useSettingStore>;
    theme: ReturnType<typeof useThemeStore>;
  };
  player: ReturnType<typeof createPlayerApi>;
  audio: ReturnType<typeof createAudioApi>;
  playlist: ReturnType<typeof createPlaylistApi>;
  lyric: ReturnType<typeof useLyricStore>;
  lyrics: ReturnType<typeof createLyricsApi>;
  lyricEffects: ReturnType<typeof createLyricEffectsApi>;
  kugou: PluginKugouApi;
  settings: ReturnType<typeof useSettingStore>;
  theme: PluginThemeApi;
  appearance: ReturnType<typeof createAppearanceApi>;
  fonts: ReturnType<typeof createFontsApi>;
  scroll: ReturnType<typeof createScrollApi>;
  appIcons: {
    refresh: () => Promise<unknown>;
    restoreDefaultDesktopIcon: () => Promise<unknown>;
    restoreDefaultTaskbarIcon: () => Promise<unknown>;
    setRuntimeWindowIcon: (iconPath: string) => Promise<unknown>;
    restoreDefaultWindowIcon: () => Promise<unknown>;
  };
  nowPlaying: Window['electron']['nowPlaying'];
  windows: {
    show: (windowId: string, options?: PluginWindowShowOptions) => Promise<unknown>;
    hide: (windowId: string) => Promise<unknown>;
    close: (windowId: string) => Promise<unknown>;
    move: (windowId: string, bounds: Partial<PluginWindowBounds>) => Promise<unknown>;
    getBounds: (windowId: string) => Promise<unknown>;
    setIgnoreMouseEvents: (windowId: string, ignore: boolean) => Promise<unknown>;
  };
  toast: ReturnType<typeof createToastApi>;
  storage: {
    get: <T = unknown>(key: string) => Promise<T | null>;
    set: (key: string, value: unknown) => Promise<unknown>;
    delete: (key: string) => Promise<unknown>;
  };
  dialog: NonNullable<Window['electron']['plugins']>['dialog'];
  fs: ReturnType<typeof createPluginFsApi>;
  process: {
    launch: (options: PluginProcessLaunchOptions) => Promise<PluginProcessLaunchResult>;
    terminate: (pid: number) => Promise<PluginProcessTerminateResult>;
  };
  ui: ReturnType<typeof createRuntimeUiApi>;
  commands: {
    register: (
      id: string,
      handler: (...args: unknown[]) => unknown,
      options?: { title?: string },
    ) => () => void;
    execute: (id: string, ...args: unknown[]) => unknown;
  };
  shortcuts: {
    register: (accelerator: string, handler: () => void) => () => void;
  };
  css: {
    inject: (cssText: string, options?: { id?: string }) => () => void;
  };
  events: {
    onTrackChange: (handler: (track: unknown) => void) => () => void;
    onPlaybackChange: (handler: (isPlaying: boolean) => void) => () => void;
  };
  dom: {
    query: <T extends Element = Element>(selector: string) => T | null;
    queryAll: <T extends Element = Element>(selector: string) => T[];
    observe: (
      selector: string,
      handler: (element: Element) => void | (() => void),
      options?: { root?: Element | Document; once?: boolean },
    ) => () => void;
  };
  net: {
    fetch: typeof fetch;
  };
  icons: typeof icons;
  electron: Window['electron'];
  dispose: (dispose: () => void) => () => void;
}

export interface PluginRuntimeHost {
  app: VueApp;
  router: Router;
  pinia: Pinia;
}

export interface PluginRuntimeRecord {
  descriptor: EchoPluginDescriptor;
  status: 'idle' | 'loading' | 'active' | 'error';
  error: string;
}

export interface PluginRuntimeFailureDetail {
  pluginId: string;
  reason: PluginFailureRecord['reason'];
  source: string;
  message: string;
  stack: string;
  createdAt: number;
}

type ActivePlugin = {
  descriptor: EchoPluginDescriptor;
  context: EchoPluginContext;
  module: PluginModule;
  disposables: Array<() => void>;
  blobUrls: string[];
};

export const pluginRuntimeState = reactive({
  directory: '',
  safeMode: false,
  lastFailure: null as PluginFailureRecord | null,
  failures: {} as Record<string, PluginRuntimeFailureDetail>,
  loading: false,
  records: [] as PluginRuntimeRecord[],
  initialized: false,
});

const activePlugins = new Map<string, ActivePlugin>();
let hostRef: PluginRuntimeHost | null = null;
let runtimeErrorHandlersInstalled = false;

type NormalizedSurfaceContribution = {
  enabled: boolean;
  updatedAt: number;
  mainOpacity?: string;
  sidebarOpacity?: string;
  cardOpacity?: string;
  elevatedOpacity?: string;
  dialogOpacity?: string;
  playerOpacity?: string;
  backdropFilter?: string;
  playerBackdropFilter?: string;
};

const pluginSurfaceContributions = new Map<string, NormalizedSurfaceContribution>();
let surfaceContributionRevision = 0;
type NormalizedPageTransitionContribution = {
  updatedAt: number;
  enabled?: boolean;
  name?: string;
  css?: string;
  mode?: PluginPageTransitionMode;
  appear?: boolean;
  duration?: string;
  easing?: string;
  enterOpacity?: string;
  leaveOpacity?: string;
  enterTranslateX?: string;
  enterTranslateY?: string;
  leaveTranslateX?: string;
  leaveTranslateY?: string;
  enterScale?: string;
  leaveScale?: string;
  enterFilter?: string;
  leaveFilter?: string;
};

const DEFAULT_PAGE_TRANSITION = {
  enabled: true,
  name: 'page',
  mode: 'out-in' as PluginPageTransitionMode,
  appear: true,
};

export const pageTransitionState = reactive({
  ...DEFAULT_PAGE_TRANSITION,
});

const pluginPageTransitionContributions = new Map<string, NormalizedPageTransitionContribution>();
const pluginPageTransitionStyleDisposers = new Map<string, () => void>();
let pageTransitionContributionRevision = 0;

const surfaceCssVariables = [
  '--surface-main-opacity',
  '--surface-sidebar-opacity',
  '--surface-card-opacity',
  '--surface-elevated-opacity',
  '--surface-dialog-opacity',
  '--surface-player-opacity',
  '--surface-backdrop-filter',
  '--surface-player-backdrop-filter',
] as const;

const pageTransitionCssVariables = [
  '--page-transition-duration',
  '--page-transition-easing',
  '--page-transition-enter-opacity',
  '--page-transition-leave-opacity',
  '--page-transition-enter-x',
  '--page-transition-enter-y',
  '--page-transition-leave-x',
  '--page-transition-leave-y',
  '--page-transition-enter-scale',
  '--page-transition-leave-scale',
  '--page-transition-enter-filter',
  '--page-transition-leave-filter',
] as const;

const accentGradientCssVariables = [
  '--accent-gradient-opacity',
  '--accent-gradient-color-rgb',
  '--accent-gradient-color-rgb-dark',
  '--accent-gradient-angle',
  '--accent-gradient-height',
  '--accent-gradient-mid-position',
  '--accent-gradient-peak-opacity',
  '--accent-gradient-peak-opacity-dark',
  '--accent-gradient-mid-opacity',
  '--accent-gradient-mid-opacity-dark',
  '--accent-gradient-background',
  '--accent-gradient-background-dark',
] as const;

type NormalizedAccentGradientContribution = {
  updatedAt: number;
  variables: Partial<Record<(typeof accentGradientCssVariables)[number], string>>;
};

const pluginAccentGradientContributions = new Map<string, NormalizedAccentGradientContribution>();
let accentGradientContributionRevision = 0;

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));
const clampNumber = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const normalizeSurfaceOpacity = (value: number | string | undefined) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${clampPercent(value <= 1 ? value * 100 : value)}%`;
  }

  const text = String(value).trim();
  if (!text) return undefined;

  if (text.endsWith('%')) {
    const numeric = Number(text.slice(0, -1).trim());
    if (Number.isFinite(numeric)) return `${clampPercent(numeric)}%`;
  }

  const numeric = Number(text);
  if (Number.isFinite(numeric)) return `${clampPercent(numeric <= 1 ? numeric * 100 : numeric)}%`;

  return undefined;
};

const normalizeBackdropFilter = (value: string | undefined) => {
  const text = String(value ?? '').trim();
  return text || undefined;
};

const normalizeAccentColorRgb = (value: string | undefined) => {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  const rgb = hexToRgb(text);
  if (rgb) return `${rgb.r}, ${rgb.g}, ${rgb.b}`;
  const parts = text
    .split(/[\s,]+/)
    .map((part) => Number(part))
    .filter((num) => Number.isFinite(num));
  if (parts.length === 3 && parts.every((num) => num >= 0 && num <= 255)) {
    return parts.map((num) => Math.round(num)).join(', ');
  }
  return undefined;
};

const normalizeAccentAlpha = (value: number | string | undefined) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(clampNumber(value > 1 ? value / 100 : value, 0, 1));
  }
  const text = String(value).trim();
  if (!text) return undefined;
  if (text.endsWith('%')) {
    const numeric = Number(text.slice(0, -1).trim());
    if (Number.isFinite(numeric)) return String(clampNumber(numeric / 100, 0, 1));
  }
  const numeric = Number(text);
  if (Number.isFinite(numeric))
    return String(clampNumber(numeric > 1 ? numeric / 100 : numeric, 0, 1));
  return undefined;
};

const normalizeAccentAngle = (value: number | string | undefined) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}deg`;
  const text = String(value).trim();
  if (!text) return undefined;
  if (/^-?\d+(\.\d+)?$/.test(text)) return `${text}deg`;
  if (/^-?\d+(\.\d+)?(deg|turn|rad|grad)$/.test(text)) return text;
  return undefined;
};

const normalizeAccentLength = (value: number | string | undefined) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}%`;
  const text = String(value).trim();
  if (!text) return undefined;
  if (/^-?\d+(\.\d+)?$/.test(text)) return `${text}%`;
  if (/^-?\d+(\.\d+)?(px|%|vh|vw|em|rem)$/.test(text)) return text;
  return undefined;
};

const normalizeAccentBackground = (value: string | undefined) => {
  const text = String(value ?? '').trim();
  return text || undefined;
};

const normalizeAccentGradientContribution = (
  options: PluginAccentGradientOptions,
): NormalizedAccentGradientContribution => {
  const variables: NormalizedAccentGradientContribution['variables'] = {};
  const assign = (name: (typeof accentGradientCssVariables)[number], value: string | undefined) => {
    if (value !== undefined) variables[name] = value;
  };

  assign('--accent-gradient-opacity', normalizeAccentAlpha(options.opacity));
  assign('--accent-gradient-color-rgb', normalizeAccentColorRgb(options.color));
  assign('--accent-gradient-angle', normalizeAccentAngle(options.angle));
  assign('--accent-gradient-height', normalizeAccentLength(options.height));
  assign('--accent-gradient-mid-position', normalizeAccentLength(options.midPosition));
  assign('--accent-gradient-peak-opacity', normalizeAccentAlpha(options.peakOpacity));
  assign('--accent-gradient-mid-opacity', normalizeAccentAlpha(options.midOpacity));
  assign('--accent-gradient-background', normalizeAccentBackground(options.background));

  if (options.dark) {
    assign('--accent-gradient-color-rgb-dark', normalizeAccentColorRgb(options.dark.color));
    assign('--accent-gradient-peak-opacity-dark', normalizeAccentAlpha(options.dark.peakOpacity));
    assign('--accent-gradient-mid-opacity-dark', normalizeAccentAlpha(options.dark.midOpacity));
    assign('--accent-gradient-background-dark', normalizeAccentBackground(options.dark.background));
  }

  // enabled:false 强制隐藏整条渐变，优先级高于 opacity 字段
  if (options.enabled === false) variables['--accent-gradient-opacity'] = '0';

  return {
    updatedAt: ++accentGradientContributionRevision,
    variables,
  };
};

const applyAccentGradientContributions = () => {
  if (typeof document === 'undefined') return;

  const body = document.body;
  accentGradientCssVariables.forEach((name) => body.style.removeProperty(name));

  const contributions = Array.from(pluginAccentGradientContributions.values()).sort(
    (a, b) => a.updatedAt - b.updatedAt,
  );
  if (contributions.length === 0) return;

  const merged: NormalizedAccentGradientContribution['variables'] = {};
  for (const contribution of contributions) Object.assign(merged, contribution.variables);

  Object.entries(merged).forEach(([name, value]) => {
    body.style.setProperty(name, value);
  });
};

const normalizeTransitionName = (value: string | undefined) => {
  const text = String(value ?? '').trim();
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(text) ? text : undefined;
};

const normalizeTransitionMode = (
  value: PluginPageTransitionMode | undefined,
): PluginPageTransitionMode | undefined => {
  if (value === 'default' || value === 'out-in' || value === 'in-out') return value;
  return undefined;
};

const normalizeTransitionDuration = (value: number | string | undefined) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${clampNumber(value, 0, 2000)}ms`;
  }

  const text = String(value).trim();
  if (!text) return undefined;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return `${clampNumber(numeric, 0, 2000)}ms`;
  if (/^\d+(\.\d+)?m?s$/.test(text)) return text;
  return undefined;
};

const normalizeTransitionOpacity = (value: number | string | undefined) => {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;

  if (text.endsWith('%')) {
    const numeric = Number(text.slice(0, -1).trim());
    if (Number.isFinite(numeric)) return String(clampNumber(numeric / 100, 0, 1));
  }

  const numeric = Number(text);
  if (Number.isFinite(numeric)) return String(clampNumber(numeric, 0, 1));
  return undefined;
};

const normalizeTransitionLength = (value: number | string | undefined) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}px`;

  const text = String(value).trim();
  if (!text) return undefined;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return `${numeric}px`;
  return text;
};

const normalizeTransitionScale = (value: number | string | undefined) => {
  if (value === undefined || value === null) return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return String(clampNumber(numeric, 0.5, 1.5));
};

const normalizeTransitionText = (value: string | undefined) => {
  const text = String(value ?? '').trim();
  return text || undefined;
};

const normalizeSurfaceContribution = (
  options: PluginSurfaceOptions,
): NormalizedSurfaceContribution => ({
  enabled: options.enabled !== false,
  updatedAt: ++surfaceContributionRevision,
  mainOpacity: normalizeSurfaceOpacity(options.mainOpacity),
  sidebarOpacity: normalizeSurfaceOpacity(options.sidebarOpacity),
  cardOpacity: normalizeSurfaceOpacity(options.cardOpacity),
  elevatedOpacity: normalizeSurfaceOpacity(options.elevatedOpacity),
  dialogOpacity: normalizeSurfaceOpacity(options.dialogOpacity),
  playerOpacity: normalizeSurfaceOpacity(options.playerOpacity),
  backdropFilter: normalizeBackdropFilter(options.backdropFilter),
  playerBackdropFilter: normalizeBackdropFilter(options.playerBackdropFilter),
});

const normalizePageTransitionContribution = (
  options: PluginPageTransitionOptions,
): NormalizedPageTransitionContribution => ({
  updatedAt: ++pageTransitionContributionRevision,
  enabled: typeof options.enabled === 'boolean' ? options.enabled : undefined,
  name: normalizeTransitionName(options.name),
  css: normalizeTransitionText(options.css),
  mode: normalizeTransitionMode(options.mode),
  appear: typeof options.appear === 'boolean' ? options.appear : undefined,
  duration: normalizeTransitionDuration(options.durationMs),
  easing: normalizeTransitionText(options.easing),
  enterOpacity: normalizeTransitionOpacity(options.enterOpacity),
  leaveOpacity: normalizeTransitionOpacity(options.leaveOpacity),
  enterTranslateX: normalizeTransitionLength(options.enterTranslateX),
  enterTranslateY: normalizeTransitionLength(options.enterTranslateY),
  leaveTranslateX: normalizeTransitionLength(options.leaveTranslateX),
  leaveTranslateY: normalizeTransitionLength(options.leaveTranslateY),
  enterScale: normalizeTransitionScale(options.enterScale),
  leaveScale: normalizeTransitionScale(options.leaveScale),
  enterFilter: normalizeTransitionText(options.enterFilter),
  leaveFilter: normalizeTransitionText(options.leaveFilter),
});

const applySurfaceContributions = () => {
  if (typeof document === 'undefined') return;

  const body = document.body;
  const enabledContributions = Array.from(pluginSurfaceContributions.values())
    .filter((contribution) => contribution.enabled)
    .sort((a, b) => a.updatedAt - b.updatedAt);

  surfaceCssVariables.forEach((name) => body.style.removeProperty(name));
  body.classList.toggle('echo-surface-translucent', enabledContributions.length > 0);

  if (enabledContributions.length === 0) return;

  const merged: Partial<Record<(typeof surfaceCssVariables)[number], string>> = {};

  for (const contribution of enabledContributions) {
    if (contribution.mainOpacity) merged['--surface-main-opacity'] = contribution.mainOpacity;
    if (contribution.sidebarOpacity) {
      merged['--surface-sidebar-opacity'] = contribution.sidebarOpacity;
    }
    if (contribution.cardOpacity) merged['--surface-card-opacity'] = contribution.cardOpacity;
    if (contribution.elevatedOpacity) {
      merged['--surface-elevated-opacity'] = contribution.elevatedOpacity;
    }
    if (contribution.dialogOpacity) {
      merged['--surface-dialog-opacity'] = contribution.dialogOpacity;
    }
    if (contribution.playerOpacity) {
      merged['--surface-player-opacity'] = contribution.playerOpacity;
    }
    if (contribution.backdropFilter) {
      merged['--surface-backdrop-filter'] = contribution.backdropFilter;
    }
    if (contribution.playerBackdropFilter) {
      merged['--surface-player-backdrop-filter'] = contribution.playerBackdropFilter;
    }
  }

  Object.entries(merged).forEach(([name, value]) => {
    body.style.setProperty(name, value);
  });
};

const applyPageTransitionContributions = () => {
  const contributions = Array.from(pluginPageTransitionContributions.values()).sort(
    (a, b) => a.updatedAt - b.updatedAt,
  );
  const next = { ...DEFAULT_PAGE_TRANSITION };
  const variables: Partial<Record<(typeof pageTransitionCssVariables)[number], string>> = {};

  for (const contribution of contributions) {
    if (contribution.enabled !== undefined) next.enabled = contribution.enabled;
    if (contribution.name) next.name = contribution.name;
    if (contribution.mode) next.mode = contribution.mode;
    if (contribution.appear !== undefined) next.appear = contribution.appear;
    if (contribution.duration) variables['--page-transition-duration'] = contribution.duration;
    if (contribution.easing) variables['--page-transition-easing'] = contribution.easing;
    if (contribution.enterOpacity) {
      variables['--page-transition-enter-opacity'] = contribution.enterOpacity;
    }
    if (contribution.leaveOpacity) {
      variables['--page-transition-leave-opacity'] = contribution.leaveOpacity;
    }
    if (contribution.enterTranslateX) {
      variables['--page-transition-enter-x'] = contribution.enterTranslateX;
    }
    if (contribution.enterTranslateY) {
      variables['--page-transition-enter-y'] = contribution.enterTranslateY;
    }
    if (contribution.leaveTranslateX) {
      variables['--page-transition-leave-x'] = contribution.leaveTranslateX;
    }
    if (contribution.leaveTranslateY) {
      variables['--page-transition-leave-y'] = contribution.leaveTranslateY;
    }
    if (contribution.enterScale)
      variables['--page-transition-enter-scale'] = contribution.enterScale;
    if (contribution.leaveScale)
      variables['--page-transition-leave-scale'] = contribution.leaveScale;
    if (contribution.enterFilter) {
      variables['--page-transition-enter-filter'] = contribution.enterFilter;
    }
    if (contribution.leaveFilter) {
      variables['--page-transition-leave-filter'] = contribution.leaveFilter;
    }
  }

  pageTransitionState.enabled = next.enabled;
  pageTransitionState.name = next.name;
  pageTransitionState.mode = next.mode;
  pageTransitionState.appear = next.appear;

  if (typeof document === 'undefined') return;

  const body = document.body;
  pageTransitionCssVariables.forEach((name) => body.style.removeProperty(name));
  body.classList.toggle('echo-page-transition-customized', contributions.length > 0);

  Object.entries(variables).forEach(([name, value]) => {
    body.style.setProperty(name, value);
  });
};

const clearPageTransitionStyle = (pluginId: string) => {
  const dispose = pluginPageTransitionStyleDisposers.get(pluginId);
  if (!dispose) return;
  dispose();
  pluginPageTransitionStyleDisposers.delete(pluginId);
};

const createThemeApi = (pluginId: string, addDisposable: (dispose: () => void) => () => void) => {
  let clearSurfaceRegistered = false;
  let clearPageTransitionRegistered = false;
  let clearAccentGradientRegistered = false;

  const clearSurface = () => {
    if (!pluginSurfaceContributions.delete(pluginId)) return;
    applySurfaceContributions();
  };

  const clearPageTransition = () => {
    clearPageTransitionStyle(pluginId);
    if (!pluginPageTransitionContributions.delete(pluginId)) return;
    applyPageTransitionContributions();
  };

  const clearAccentGradient = () => {
    if (!pluginAccentGradientContributions.delete(pluginId)) return;
    applyAccentGradientContributions();
  };

  const registerSurfaceClear = () => {
    if (clearSurfaceRegistered) return clearSurface;
    clearSurfaceRegistered = true;
    return addDisposable(clearSurface);
  };

  const registerPageTransitionClear = () => {
    if (clearPageTransitionRegistered) return clearPageTransition;
    clearPageTransitionRegistered = true;
    return addDisposable(clearPageTransition);
  };

  const registerAccentGradientClear = () => {
    if (clearAccentGradientRegistered) return clearAccentGradient;
    clearAccentGradientRegistered = true;
    return addDisposable(clearAccentGradient);
  };

  return {
    surface: {
      set: (options: PluginSurfaceOptions) => {
        pluginSurfaceContributions.set(pluginId, normalizeSurfaceContribution(options));
        applySurfaceContributions();
        return registerSurfaceClear();
      },
      clear: clearSurface,
    },
    pageTransition: {
      set: (options: PluginPageTransitionOptions) => {
        clearPageTransitionStyle(pluginId);
        const contribution = normalizePageTransitionContribution(options);
        pluginPageTransitionContributions.set(pluginId, contribution);
        if (contribution.css) {
          pluginPageTransitionStyleDisposers.set(
            pluginId,
            createStyleDisposer(pluginId, contribution.css, 'page-transition'),
          );
        }
        applyPageTransitionContributions();
        return registerPageTransitionClear();
      },
      clear: clearPageTransition,
    },
    accentGradient: {
      set: (options: PluginAccentGradientOptions) => {
        pluginAccentGradientContributions.set(
          pluginId,
          normalizeAccentGradientContribution(options),
        );
        applyAccentGradientContributions();
        return registerAccentGradientClear();
      },
      clear: clearAccentGradient,
    },
  };
};

export type PluginPlayTrackOptions = {
  playlist?: Song[];
  autoPlay?: boolean;
  sourceQueueId?: string | null;
};

export type PluginPlaybackQueueOptions = SetPlaybackQueueOptions & {
  filteredInvalidCount?: number;
  requestedSong?: Song;
};

export type PluginLyricCommand = Extract<
  NowPlayingCommand,
  | 'toggleTranslation'
  | 'toggleRomanization'
  | 'lyricOffsetBackward'
  | 'lyricOffsetForward'
  | 'lyricOffsetReset'
  | 'seekForward'
  | 'seekBackward'
>;

const clonePlaybackQueue = (queue: ReturnType<typeof usePlaylistStore>['activeQueue']) =>
  queue
    ? {
        ...queue,
        songs: queue.songs.slice(),
        queuedNextTrackIds: queue.queuedNextTrackIds.slice(),
        meta: { ...queue.meta },
      }
    : null;

const createFallbackLyricSnapshot = (): NowPlayingLyricPayload => ({
  trackId: null,
  revision: 0,
  lines: [],
  currentIndex: -1,
  timeOffset: 0,
  wantTranslation: false,
  wantRomanization: false,
  hasTranslation: false,
  hasRomanization: false,
  mode: 'none',
  tips: '暂无歌词',
});

const createFallbackAppearanceSnapshot = (): NowPlayingAppearancePayload => ({
  isDark: document.documentElement.classList.contains('dark'),
  accentColor: '#31cfa1',
});

const createFallbackNowPlayingSnapshot = (): NowPlayingSnapshot => ({
  playback: null,
  lyric: createFallbackLyricSnapshot(),
  appearance: createFallbackAppearanceSnapshot(),
  updatedAt: Date.now(),
});

const getNowPlayingSnapshot = () =>
  window.electron.nowPlaying?.getSnapshot?.() ??
  Promise.resolve(createFallbackNowPlayingSnapshot());

const createPlayerApi = (
  descriptor: EchoPluginDescriptor,
  addDisposable: (dispose: () => void) => () => void,
) => {
  const player = usePlayerStore();
  const playlist = usePlaylistStore();
  return {
    store: player,
    currentTrack: computed(() => player.currentTrackSnapshot),
    currentTrackId: computed(() => player.currentTrackId),
    currentTime: computed(() => player.currentTime),
    duration: computed(() => player.duration),
    isPlaying: computed(() => player.isPlaying),
    playbackRate: computed(() => player.playbackRate),
    volume: computed(() => player.volume),
    playMode: computed(() => player.playMode),
    audioQuality: computed(() => ({
      effective: player.getEffectiveAudioQuality(),
      resolved: player.currentResolvedAudioQuality,
      override: player.currentAudioQualityOverride,
    })),
    audioEffect: computed(() => ({
      current: player.audioEffect,
      resolved: player.currentResolvedAudioEffect,
    })),
    play: (trackId?: string | number, options?: PluginPlayTrackOptions) => {
      const resolvedTrackId = String(trackId ?? '').trim();
      if (resolvedTrackId) {
        return player.playTrack(resolvedTrackId, options?.playlist, {
          autoPlay: options?.autoPlay,
          sourceQueueId: options?.sourceQueueId,
        });
      }
      if (!player.isPlaying) return player.togglePlay();
      return undefined;
    },
    pause: () => {
      if (player.isPlaying) void player.togglePlay();
    },
    toggle: () => player.togglePlay(),
    stop: () => player.stop(),
    playTrack: (trackId: string | number, options?: PluginPlayTrackOptions) =>
      player.playTrack(String(trackId), options?.playlist, {
        autoPlay: options?.autoPlay,
        sourceQueueId: options?.sourceQueueId,
      }),
    playSong: (song: Song, options?: SetPlaybackQueueOptions) =>
      queueAndPlaySong(playlist, player, song, options),
    playNext: (song: Song, options?: SetPlaybackQueueOptions) =>
      addSongToPlayNext(playlist, player, song, options),
    replaceQueueAndPlay: (songs: Song[], options: PluginPlaybackQueueOptions = {}) =>
      replaceQueueAndPlay(
        playlist,
        player,
        songs,
        options.filteredInvalidCount,
        options.requestedSong,
        options,
      ),
    next: () => player.next(),
    prev: () => player.prev(),
    dislikePersonalFm: () => player.dislikePersonalFm(),
    seek: (time: number) => player.seek(time),
    setVolume: (volume: number) => player.setVolume(volume),
    setPlaybackRate: (rate: number) => player.setPlaybackRate(rate),
    setPlayMode: (mode: PlayMode) => player.setPlayMode(mode),
    setAudioQuality: (quality: AudioQualityValue | null, options?: { refresh?: boolean }) =>
      player.setCurrentAudioQualityOverride(quality, options),
    setAudioEffect: (effect: AudioEffectValue) => player.setAudioEffect(effect),
    toggleLyricView: (open?: boolean) => player.toggleLyricView(open),
    audioSource: {
      register: (contribution: PluginAudioSourceResolverContribution) => {
        if (descriptor.manifest.capabilities?.audioSource !== true) {
          throw new Error('插件未声明音源解析能力');
        }
        return addDisposable(
          registerPluginAudioSourceResolver(descriptor.id, contribution, (source, error) => {
            void reportPluginRuntimeError(descriptor.id, error, source);
          }),
        );
      },
    },
  };
};

const createAudioApi = (
  descriptor: EchoPluginDescriptor,
  addDisposable: (dispose: () => void) => () => void,
) => {
  const requireAudioSpectrumCapability = () => {
    if (descriptor.manifest.capabilities?.audioSpectrum !== true) {
      throw new Error('插件未声明音频频谱能力');
    }
  };

  return {
    spectrum: {
      getStatus: () => {
        requireAudioSpectrumCapability();
        return (
          window.electron.audioSpectrum?.getStatus() ??
          Promise.resolve({
            available: false,
            running: false,
            provider: 'unavailable' as const,
            reason: '频谱 API 不可用',
          })
        );
      },
      getSnapshot: () => {
        requireAudioSpectrumCapability();
        return window.electron.audioSpectrum?.getSnapshot() ?? Promise.resolve(null);
      },
      subscribe: (options: AudioSpectrumOptions, handler: (frame: AudioSpectrumFrame) => void) => {
        requireAudioSpectrumCapability();
        const dispose =
          window.electron.audioSpectrum?.subscribe(
            options,
            (frame) =>
              runPluginCallback(descriptor.id, '音频频谱事件', () => handler(frame), undefined),
            { pluginId: descriptor.id },
          ) ?? (() => undefined);
        return addDisposable(dispose);
      },
    },
  };
};

const createLyricsApi = (
  descriptor: EchoPluginDescriptor,
  addDisposable: (dispose: () => void) => () => void,
) => ({
  registerResolver: (contribution: PluginLyricResolverContribution) => {
    if (descriptor.manifest.capabilities?.lyrics !== true) {
      throw new Error('插件未声明歌词解析能力');
    }
    return addDisposable(
      registerPluginLyricResolver(descriptor.id, contribution, (source, error) => {
        void reportPluginRuntimeError(descriptor.id, error, source);
      }),
    );
  },
  getSnapshot: async () => (await getNowPlayingSnapshot()).lyric,
  onSnapshot: (handler: (lyric: NowPlayingLyricPayload, snapshot: NowPlayingSnapshot) => void) => {
    const dispose =
      window.electron.nowPlaying?.onSnapshot?.((snapshot) =>
        runPluginCallback(
          descriptor.id,
          '歌词快照事件',
          () => handler(snapshot.lyric, snapshot),
          undefined,
        ),
      ) ?? (() => undefined);
    return addDisposable(dispose);
  },
  command: (command: PluginLyricCommand) => window.electron.nowPlaying?.command?.(command),
});

const createLyricEffectsApi = (
  descriptor: EchoPluginDescriptor,
  addDisposable: (dispose: () => void) => () => void,
) => ({
  register: (contribution: PluginLyricEffectContribution) => {
    if (descriptor.manifest.capabilities?.lyricEffects !== true) {
      throw new Error('插件未声明歌词动效能力');
    }
    return addDisposable(
      registerPluginLyricEffect(descriptor.id, contribution, (source, error) => {
        void reportPluginRuntimeError(descriptor.id, error, source);
      }),
    );
  },
});

const createAppearanceApi = (
  pluginId: string,
  addDisposable: (dispose: () => void) => () => void,
) => ({
  getSnapshot: async () => (await getNowPlayingSnapshot()).appearance,
  onSnapshot: (
    handler: (appearance: NowPlayingAppearancePayload, snapshot: NowPlayingSnapshot) => void,
  ) => {
    const dispose =
      window.electron.nowPlaying?.onSnapshot?.((snapshot) =>
        runPluginCallback(
          pluginId,
          '外观快照事件',
          () => handler(snapshot.appearance, snapshot),
          undefined,
        ),
      ) ?? (() => undefined);
    return addDisposable(dispose);
  },
});

const createFontsApi = () =>
  createFontApi(() => window.electron.fonts?.getAll?.() ?? Promise.resolve([]));

const createPlaylistApi = () => {
  const playlist = usePlaylistStore();
  const player = usePlayerStore();
  return {
    store: playlist,
    activeQueue: computed(() => clonePlaybackQueue(playlist.activeQueue)),
    queues: computed(() => playlist.playbackQueueList.map(clonePlaybackQueue).filter(Boolean)),
    getActiveQueue: () => clonePlaybackQueue(playlist.activeQueue),
    getQueue: (queueId: string | number) => clonePlaybackQueue(playlist.getQueueById(queueId)),
    getQueueSongs: (queueId?: string | number | null) =>
      queueId === undefined || queueId === null
        ? (playlist.activeQueue?.songs ?? playlist.defaultList).slice()
        : playlist.getPlaybackQueueSongs(queueId),
    setActiveQueue: (queueId: string | number) => playlist.setActiveQueue(queueId),
    setPlaybackQueue: (songs: Song[], filteredInvalidCount = 0) =>
      playlist.setPlaybackQueue(songs, filteredInvalidCount),
    setPlaybackQueueWithOptions: (
      songs: Song[],
      filteredInvalidCount = 0,
      options?: SetPlaybackQueueOptions,
    ) => playlist.setPlaybackQueueWithOptions(songs, filteredInvalidCount, options),
    replace: (songs: Song[], options: PluginPlaybackQueueOptions = {}) =>
      playlist.setPlaybackQueueWithOptions(songs, options.filteredInvalidCount, options),
    replaceAndPlay: (songs: Song[], options: PluginPlaybackQueueOptions = {}) =>
      replaceQueueAndPlay(
        playlist,
        player,
        songs,
        options.filteredInvalidCount,
        options.requestedSong,
        options,
      ),
    append: (songs: Song[], options?: SetPlaybackQueueOptions) =>
      playlist.appendToPlaybackQueue(songs, options),
    appendToPlaybackQueue: (songs: Song[], options?: SetPlaybackQueueOptions) =>
      playlist.appendToPlaybackQueue(songs, options),
    playSong: (song: Song, options?: SetPlaybackQueueOptions) =>
      queueAndPlaySong(playlist, player, song, options),
    playNext: (song: Song, options?: SetPlaybackQueueOptions) =>
      addSongToPlayNext(playlist, player, song, options),
    enqueuePlayNext: (songId: string | number) => playlist.enqueuePlayNext(songId),
    clear: (queueId?: string | number) => playlist.clearPlaybackQueue(queueId),
    remove: (songId: string | number, queueId?: string | number) =>
      playlist.removeFromQueue(songId, queueId),
    reorder: (fromIndex: number, toIndex: number, queueId?: string | number) =>
      playlist.reorderPlaybackQueue(fromIndex, toIndex, queueId),
  };
};

const createToastApi = () => {
  const toast = useToastStore();
  return {
    info: toast.info,
    success: toast.success,
    warning: toast.warning,
    danger: toast.danger,
    show: toast.show,
  };
};

const createPluginWindowsApi = (pluginId: string) => {
  const getWindowsApi = () => window.electron.plugins?.windows;
  const unavailable = () => Promise.reject(new Error('插件窗口 API 不可用'));
  return {
    show: (windowId: string, options?: PluginWindowShowOptions) =>
      getWindowsApi()?.show(pluginId, windowId, options) ?? unavailable(),
    hide: (windowId: string) => getWindowsApi()?.hide(pluginId, windowId) ?? unavailable(),
    close: (windowId: string) => getWindowsApi()?.close(pluginId, windowId) ?? unavailable(),
    move: (windowId: string, bounds: Partial<PluginWindowBounds>) =>
      getWindowsApi()?.move(pluginId, windowId, bounds) ?? unavailable(),
    getBounds: (windowId: string) =>
      getWindowsApi()?.getBounds(pluginId, windowId) ?? unavailable(),
    setIgnoreMouseEvents: (windowId: string, ignore: boolean) =>
      getWindowsApi()?.setIgnoreMouseEvents(pluginId, windowId, ignore) ?? unavailable(),
  };
};

const createPluginFsApi = (pluginId: string) => {
  const getFsApi = () => window.electron.plugins?.fs;
  const unavailable = (message = '插件文件 API 不可用') =>
    Promise.resolve({ ok: false as const, error: message });
  return {
    listFiles: (
      directoryPath: string,
      options?: Parameters<NonNullable<Window['electron']['plugins']>['fs']['listFiles']>[2],
    ) =>
      getFsApi()?.listFiles(pluginId, directoryPath, serializeForIpc(options) as typeof options) ??
      unavailable(),
    listImageFiles: (
      directoryPath: string,
      options?: Parameters<NonNullable<Window['electron']['plugins']>['fs']['listImageFiles']>[1],
    ) =>
      getFsApi()?.listImageFiles(directoryPath, serializeForIpc(options) as typeof options) ??
      unavailable(),
    getFileUrl: (filePath: string) => getFsApi()?.getFileUrl(filePath) ?? unavailable(),
    readTextFile: (
      filePath: string,
      options?: Parameters<NonNullable<Window['electron']['plugins']>['fs']['readTextFile']>[2],
    ) =>
      getFsApi()?.readTextFile(pluginId, filePath, serializeForIpc(options) as typeof options) ??
      unavailable(),
    readFileBytes: (
      filePath: string,
      options?: Parameters<NonNullable<Window['electron']['plugins']>['fs']['readFileBytes']>[2],
    ) =>
      getFsApi()?.readFileBytes(pluginId, filePath, serializeForIpc(options) as typeof options) ??
      unavailable(),
    writeFile: (
      filePath: string,
      data: Parameters<NonNullable<Window['electron']['plugins']>['fs']['writeFile']>[2],
      options?: Parameters<NonNullable<Window['electron']['plugins']>['fs']['writeFile']>[3],
    ) => {
      const payload =
        data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? data : serializeForIpc(data);
      return (
        getFsApi()?.writeFile(
          pluginId,
          filePath,
          payload as typeof data,
          serializeForIpc(options) as typeof options,
        ) ?? unavailable()
      );
    },
    deleteFile: (filePath: string) => getFsApi()?.deleteFile(pluginId, filePath) ?? unavailable(),
  };
};

const createPluginProcessApi = (pluginId: string) => {
  const getProcessApi = () => window.electron.plugins?.process;
  return {
    launch: (options: PluginProcessLaunchOptions) =>
      getProcessApi()?.launch(pluginId, serializeForIpc(options) as PluginProcessLaunchOptions) ??
      Promise.resolve({ ok: false as const, error: '插件进程 API 不可用' }),
    terminate: (pid: number) =>
      getProcessApi()?.terminate(pluginId, pid) ??
      Promise.resolve({ ok: false as const, error: '插件进程 API 不可用' }),
  };
};

const hostComponentLoaders = {
  Avatar: () => import('@/components/ui/Avatar.vue').then((module) => module.default),
  Badge: () => import('@/components/ui/Badge.vue').then((module) => module.default),
  Button: () => import('@/components/ui/Button.vue').then((module) => module.default),
  Cover: () => import('@/components/ui/Cover.vue').then((module) => module.default),
  Dialog: () => import('@/components/ui/Dialog.vue').then((module) => module.default),
  Drawer: () => import('@/components/ui/Drawer.vue').then((module) => module.default),
  Input: () => import('@/components/ui/Input.vue').then((module) => module.default),
  InputNumber: () => import('@/components/ui/InputNumber.vue').then((module) => module.default),
  Popover: () => import('@/components/ui/Popover.vue').then((module) => module.default),
  Scrollbar: () => import('@/components/ui/Scrollbar.vue').then((module) => module.default),
  Select: () => import('@/components/ui/Select.vue').then((module) => module.default),
  Slider: () => import('@/components/ui/Slider.vue').then((module) => module.default),
  Switch: () => import('@/components/ui/Switch.vue').then((module) => module.default),
  Tabs: () => import('@/components/ui/Tabs.vue').then((module) => module.default),
  TabsContent: () => import('@/components/ui/TabsContent.vue').then((module) => module.default),
  TabsList: () => import('@/components/ui/TabsList.vue').then((module) => module.default),
  TabsTrigger: () => import('@/components/ui/TabsTrigger.vue').then((module) => module.default),
  Textarea: () => import('@/components/ui/Textarea.vue').then((module) => module.default),
  Tooltip: () => import('@/components/ui/Tooltip.vue').then((module) => module.default),
};

const resolveMountTarget = (target: string | Element): Element | null => {
  if (typeof target !== 'string') return target;
  return document.querySelector(target);
};

const insertMountContainer = (
  target: Element,
  container: HTMLElement,
  position: 'append' | 'prepend' | 'before' | 'after' | 'replace',
) => {
  if (position === 'prepend') {
    target.prepend(container);
    return;
  }
  if (position === 'before') {
    target.parentElement?.insertBefore(container, target);
    return;
  }
  if (position === 'after') {
    target.parentElement?.insertBefore(container, target.nextSibling);
    return;
  }
  if (position === 'replace') {
    target.replaceWith(container);
    container.appendChild(target);
    target.setAttribute('data-echo-plugin-replaced', 'true');
    return;
  }
  target.appendChild(container);
};

const createMountedComponentDisposer = (
  pluginId: string,
  host: PluginRuntimeHost,
  target: string | Element,
  component: Component,
  options: {
    props?: Record<string, unknown>;
    position?: 'append' | 'prepend' | 'before' | 'after' | 'replace';
    className?: string;
    id?: string;
  } = {},
) => {
  const targetElement = resolveMountTarget(target);
  if (!targetElement) throw new Error(`插件挂载目标不存在: ${String(target)}`);

  const container = document.createElement('div');
  container.className = ['echo-plugin-mount', options.className].filter(Boolean).join(' ');
  container.dataset.pluginId = pluginId;
  if (options.id) container.dataset.pluginMount = options.id;
  const position = options.position ?? 'append';
  insertMountContainer(targetElement, container, position);

  const mountedApp = Vue.createApp(component, options.props ?? {});
  mountedApp.use(host.pinia);
  mountedApp.use(host.router);
  mountedApp.component('Icon', Icon);
  mountedApp.config.globalProperties.$echo = host.app.config.globalProperties.$echo;
  mountedApp.config.errorHandler = (error, _instance, info) => {
    logger.error('PluginRuntime', 'Plugin mounted component failed', {
      pluginId,
      info,
      error,
    });
    void reportPluginRuntimeError(pluginId, error, `Vue 组件: ${info || '未知位置'}`);
  };
  mountedApp.mount(container);

  return () => {
    mountedApp.unmount();
    if (position === 'replace') {
      const replaced = container.querySelector<HTMLElement>('[data-echo-plugin-replaced="true"]');
      if (replaced) {
        replaced.removeAttribute('data-echo-plugin-replaced');
        container.replaceWith(replaced);
        return;
      }
    }
    container.remove();
  };
};

const SCROLL_CONTAINER_SELECTOR = '[data-echo-scroll-container]';

const isVisibleScrollContainer = (element: HTMLElement) =>
  element.clientHeight > 0 && element.getClientRects().length > 0;

const getScrollContainerState = (element: HTMLElement): PluginScrollContainerState => {
  const scrollTop = Math.max(0, element.scrollTop || 0);
  const scrollHeight = Math.max(0, element.scrollHeight || 0);
  const clientHeight = Math.max(0, element.clientHeight || 0);
  const distanceToBottom = Math.max(0, scrollHeight - clientHeight - scrollTop);
  return {
    scrollTop,
    scrollHeight,
    clientHeight,
    distanceToBottom,
    canScroll: scrollHeight - clientHeight > 1,
    atTop: scrollTop <= 1,
    atBottom: distanceToBottom <= 1,
  };
};

const createScrollApi = (pluginId: string, addDisposable: (dispose: () => void) => () => void) => {
  const queryContainers = (options: PluginScrollContainerQueryOptions = {}) => {
    const containers = Array.from(
      document.querySelectorAll<HTMLElement>(SCROLL_CONTAINER_SELECTOR),
    );
    return containers.filter((element) => {
      if (options.role && element.dataset.echoScrollRole !== options.role) return false;
      if (options.visible !== false && !isVisibleScrollContainer(element)) return false;
      return true;
    });
  };

  const getCurrentContainer = () => queryContainers({ visible: true })[0] ?? null;

  const scrollTo = (
    element: HTMLElement | null | undefined,
    target: 'top' | 'bottom' | number,
    options?: ScrollToOptions,
  ) => {
    if (!element) return;
    const top =
      target === 'top'
        ? 0
        : target === 'bottom'
          ? Math.max(0, element.scrollHeight - element.clientHeight)
          : Math.max(0, Number(target) || 0);
    element.scrollTo({
      ...options,
      top,
      behavior: options?.behavior ?? 'smooth',
    });
  };

  const observeContainers = (
    handler: (element: HTMLElement, state: PluginScrollContainerState) => void | (() => void),
    options: PluginScrollContainerQueryOptions = {},
  ) => {
    const seen = new WeakSet<HTMLElement>();
    const disposers: Array<() => void> = [];
    let stopped = false;

    const visit = (element: HTMLElement) => {
      if (stopped || seen.has(element)) return;
      seen.add(element);
      const dispose = runPluginCallback(
        pluginId,
        '滚动容器监听',
        () => handler(element, getScrollContainerState(element)),
        undefined,
      );
      if (typeof dispose === 'function') disposers.push(dispose);
    };

    const scan = () => {
      if (stopped) return;
      queryContainers(options).forEach(visit);
    };

    const observer = new MutationObserver(scan);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
      disposers
        .splice(0)
        .reverse()
        .forEach((dispose) => runPluginCallback(pluginId, '滚动容器监听清理', dispose, undefined));
    };

    scan();
    observer.observe(document.body, { childList: true, subtree: true });
    return addDisposable(stop);
  };

  return {
    selector: SCROLL_CONTAINER_SELECTOR,
    queryContainers,
    getCurrentContainer,
    getState: getScrollContainerState,
    scrollTo,
    scrollToTop: (element?: HTMLElement | null, options?: ScrollToOptions) =>
      scrollTo(element ?? getCurrentContainer(), 'top', options),
    scrollToBottom: (element?: HTMLElement | null, options?: ScrollToOptions) =>
      scrollTo(element ?? getCurrentContainer(), 'bottom', options),
    observeContainers,
  };
};

const createDomApi = (pluginId: string, addDisposable: (dispose: () => void) => () => void) => ({
  query: <T extends Element = Element>(selector: string) => document.querySelector<T>(selector),
  queryAll: <T extends Element = Element>(selector: string) =>
    Array.from(document.querySelectorAll<T>(selector)),
  observe: (
    selector: string,
    handler: (element: Element) => void | (() => void),
    options?: { root?: Element | Document; once?: boolean },
  ) => {
    const root = options?.root ?? document.body;
    const seen = new WeakSet<Element>();
    const disposers: Array<() => void> = [];
    let stopped = false;

    const visit = (element: Element) => {
      if (stopped || seen.has(element)) return;
      seen.add(element);
      const dispose = runPluginCallback(
        pluginId,
        `DOM 监听: ${selector}`,
        () => handler(element),
        undefined,
      );
      if (typeof dispose === 'function') disposers.push(dispose);
      if (options?.once) stop();
    };

    const scan = () => {
      if (stopped) return;
      if (root instanceof Element && root.matches(selector)) visit(root);
      const queryRoot = root instanceof Document ? root : root.ownerDocument;
      const scope = root instanceof Document ? root : root;
      if (!queryRoot) return;
      Array.from(scope.querySelectorAll(selector)).forEach(visit);
    };

    const observer = new MutationObserver(scan);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
      disposers
        .splice(0)
        .reverse()
        .forEach((dispose) =>
          runPluginCallback(pluginId, `DOM 监听清理: ${selector}`, dispose, undefined),
        );
    };

    scan();
    if (!stopped) observer.observe(root, { childList: true, subtree: true });
    return addDisposable(stop);
  },
});

const createShortcutsApi = (
  pluginId: string,
  addDisposable: (dispose: () => void) => () => void,
) => {
  const acceleratorToKeys = (accelerator: string): string[] => {
    const cleaned = accelerator.replace(/\s+/g, '');
    if (!cleaned) return [];
    const parts = cleaned.split('+').filter(Boolean);
    const modifiers: string[] = [];
    const keys: string[] = [];
    let hasCmdOrCtrl = false;

    const normalizeKey = (key: string) => key.toLowerCase();

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
      if (['meta', 'win', 'super'].includes(lower)) {
        modifiers.push('meta');
        continue;
      }
      keys.push(normalizeKey(part));
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

  const buildShortcut = (event: KeyboardEvent): string => {
    const keys = new Set<string>();
    if (event.ctrlKey) keys.add('ctrl');
    if (event.metaKey) keys.add('meta');
    if (event.altKey) keys.add('alt');
    if (event.shiftKey) keys.add('shift');
    const mainKey = event.key?.toLowerCase() || '';
    if (mainKey && !['control', 'shift', 'alt', 'meta'].includes(mainKey)) {
      keys.add(mainKey);
    }
    return Array.from(keys).sort().join('+');
  };

  return {
    register: (accelerator: string, handler: () => void) => {
      const targetKeys = acceleratorToKeys(accelerator);
      if (!targetKeys.length) {
        throw new Error(`Invalid accelerator: ${accelerator}`);
      }

      const keydownHandler = (event: KeyboardEvent) => {
        if (event.repeat) return;
        const pressed = buildShortcut(event);
        if (targetKeys.includes(pressed)) {
          event.preventDefault();
          runPluginCallback(pluginId, `快捷键: ${accelerator}`, () => handler(), undefined);
        }
      };

      window.addEventListener('keydown', keydownHandler);
      return addDisposable(() => {
        window.removeEventListener('keydown', keydownHandler);
      });
    },
  };
};

const createRuntimeUiApi = (
  pluginId: string,
  host: PluginRuntimeHost,
  addDisposable: (dispose: () => void) => () => void,
) => {
  const baseUi = createPluginUiApi(pluginId, addDisposable, (source, error) => {
    void reportPluginRuntimeError(pluginId, error, source);
  });
  return {
    ...baseUi,
    components: hostComponentLoaders,
    mount: (
      target: string | Element,
      component: Component,
      options?: {
        props?: Record<string, unknown>;
        position?: 'append' | 'prepend' | 'before' | 'after' | 'replace';
        className?: string;
        id?: string;
      },
    ) =>
      runPluginCallback(
        pluginId,
        '挂载插件组件',
        () =>
          addDisposable(createMountedComponentDisposer(pluginId, host, target, component, options)),
        () => undefined,
      ),
    teleport: (
      component: Component,
      options?: { props?: Record<string, unknown>; className?: string; id?: string },
    ) =>
      runPluginCallback(
        pluginId,
        '挂载插件浮层',
        () =>
          addDisposable(
            createMountedComponentDisposer(pluginId, host, document.body, component, {
              ...options,
              position: 'append',
              className: ['echo-plugin-teleport', options?.className].filter(Boolean).join(' '),
            }),
          ),
        () => undefined,
      ),
  };
};

const updateRecord = (
  descriptor: EchoPluginDescriptor,
  status: PluginRuntimeRecord['status'],
  error = '',
) => {
  const existing = pluginRuntimeState.records.find(
    (record) => record.descriptor.id === descriptor.id,
  );
  if (existing) {
    existing.descriptor = descriptor;
    existing.status = status;
    existing.error = error;
    return;
  }
  pluginRuntimeState.records.push({ descriptor, status, error });
};

const getErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error) return error.message || fallback;
  const message = String(error ?? '').trim();
  return message || fallback;
};

const getErrorStack = (error: unknown) => {
  if (error instanceof Error) return error.stack ?? '';
  return '';
};

const setRecordFailure = (pluginId: string, message: string) => {
  const record = pluginRuntimeState.records.find((item) => item.descriptor.id === pluginId);
  if (!record) return;
  record.status = 'error';
  record.error = message;
};

const getFailurePluginIds = (failure: PluginFailureRecord | null) =>
  new Set(
    [failure?.pluginId, ...(failure?.pluginIds ?? [])].filter((id): id is string => Boolean(id)),
  );

const isLastFailureForPlugin = (pluginId: string) =>
  getFailurePluginIds(pluginRuntimeState.lastFailure).has(pluginId);

const removePluginIdFromFailure = (
  failure: PluginFailureRecord | null,
  pluginId: string,
): PluginFailureRecord | null => {
  if (!failure) return null;
  const pluginIds = Array.from(getFailurePluginIds(failure));
  if (!pluginIds.includes(pluginId)) return failure;

  const remainingPluginIds = pluginIds.filter((id) => id !== pluginId);
  if (remainingPluginIds.length === 0) return null;

  return {
    pluginIds: remainingPluginIds,
    reason: failure.reason,
    message: failure.message,
    createdAt: failure.createdAt,
  };
};

const clearCurrentPluginFailure = (pluginId: string) => {
  delete pluginRuntimeState.failures[pluginId];
};

const clearRecordFailure = (pluginId: string) => {
  const record = pluginRuntimeState.records.find((item) => item.descriptor.id === pluginId);
  if (!record) return;
  record.error = '';
  if (record.status === 'error') {
    record.status = activePlugins.has(pluginId) ? 'active' : 'idle';
  }
};

const reportPluginFailure = async (
  pluginId: string,
  reason: PluginFailureRecord['reason'],
  error: unknown,
  options: {
    source: string;
    fallback: string;
  },
) => {
  const message = getErrorMessage(error, options.fallback);
  const createdAt = Date.now();
  const existing = pluginRuntimeState.failures[pluginId];
  const detail: PluginRuntimeFailureDetail = {
    pluginId,
    reason,
    source: options.source,
    message,
    stack: getErrorStack(error),
    createdAt,
  };

  pluginRuntimeState.failures[pluginId] = detail;
  pluginRuntimeState.lastFailure = {
    pluginId,
    reason,
    message,
    createdAt,
  };
  setRecordFailure(pluginId, message);

  if (
    existing?.reason === reason &&
    existing.source === options.source &&
    existing.message === message
  ) {
    return;
  }

  logger.warn('PluginRuntime', 'Plugin failure reported', {
    pluginId,
    reason,
    source: options.source,
    message,
    stack: detail.stack,
  });

  try {
    await window.electron.plugins?.reportFailure({
      pluginId,
      reason,
      message,
      createdAt,
    });
  } catch (error) {
    logger.warn('PluginRuntime', 'Plugin failure report failed', {
      pluginId,
      reason,
      error,
    });
  }
};

const reportPluginActivationFailure = (pluginId: string, error: unknown, source = '插件启动') =>
  reportPluginFailure(pluginId, 'activation-error', error, {
    source,
    fallback: '插件启动失败',
  });

const syncActivePluginSession = async () => {
  try {
    await window.electron.plugins?.setActiveSession(getActivePluginIds());
  } catch (error) {
    logger.warn('PluginRuntime', 'Plugin active session sync failed', { error });
  }
};

const extractPluginIdFromErrorSource = (...sources: unknown[]) => {
  const text = sources
    .filter((source) => source !== null && source !== undefined)
    .map((source) =>
      source instanceof Error ? `${source.message}\n${source.stack ?? ''}` : String(source),
    )
    .join('\n');
  return text.match(/echo-plugin:([a-zA-Z0-9._-]+)/)?.[1] ?? '';
};

const reportPluginRuntimeError = (
  pluginId: string,
  error: unknown,
  source = '插件运行时',
  fallback = '插件运行异常',
) =>
  reportPluginFailure(pluginId, 'runtime-error', error, {
    source,
    fallback,
  });

const runPluginCallback = <T>(
  pluginId: string,
  source: string,
  callback: () => T,
  fallback: T,
): T => {
  try {
    const result = callback();
    if (result instanceof Promise) {
      return result.catch((error) => {
        void reportPluginRuntimeError(pluginId, error, source);
        return fallback;
      }) as T;
    }
    return result;
  } catch (error) {
    void reportPluginRuntimeError(pluginId, error, source);
    return fallback;
  }
};

const installPluginRuntimeErrorHandlers = () => {
  if (runtimeErrorHandlersInstalled) return;
  runtimeErrorHandlersInstalled = true;

  window.addEventListener('error', (event) => {
    const pluginId = extractPluginIdFromErrorSource(event.error, event.message, event.filename);
    if (!pluginId) return;
    void reportPluginRuntimeError(
      pluginId,
      event.error ?? event.message,
      '全局错误',
      event.message || '插件运行异常',
    );
  });

  window.addEventListener('unhandledrejection', (event) => {
    const pluginId = extractPluginIdFromErrorSource(event.reason);
    if (!pluginId) return;
    void reportPluginRuntimeError(
      pluginId,
      event.reason,
      '未处理 Promise',
      '插件 Promise 未处理异常',
    );
  });
};

function createStyleDisposer(pluginId: string, cssText: string, styleId = 'runtime') {
  const elementId = `echo-plugin-style-${pluginId}-${styleId}`;
  document.getElementById(elementId)?.remove();
  const style = document.createElement('style');
  style.id = elementId;
  style.dataset.pluginId = pluginId;
  style.textContent = cssText;
  document.head.appendChild(style);
  return () => style.remove();
}

const serializeForIpc = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
};

const createPluginContext = (
  descriptor: EchoPluginDescriptor,
  host: PluginRuntimeHost,
  disposables: Array<() => void>,
): EchoPluginContext => {
  const addDisposable = (dispose: () => void) => {
    disposables.push(dispose);
    return dispose;
  };
  const playerStore = usePlayerStore();
  const playlistStore = usePlaylistStore();
  const lyricStore = useLyricStore();
  const settingStore = useSettingStore();
  const themeStore = useThemeStore();

  const context: EchoPluginContext = {
    id: descriptor.id,
    manifest: descriptor.manifest,
    descriptor,
    app: host.app,
    vue: Vue,
    router: host.router,
    pinia: host.pinia,
    stores: {
      player: playerStore,
      playlist: playlistStore,
      lyric: lyricStore,
      settings: settingStore,
      theme: themeStore,
    },
    player: createPlayerApi(descriptor, addDisposable),
    audio: createAudioApi(descriptor, addDisposable),
    playlist: createPlaylistApi(),
    lyric: lyricStore,
    lyrics: createLyricsApi(descriptor, addDisposable),
    lyricEffects: createLyricEffectsApi(descriptor, addDisposable),
    kugou: createKugouApi(descriptor),
    settings: settingStore,
    theme: createThemeApi(descriptor.id, addDisposable),
    appearance: createAppearanceApi(descriptor.id, addDisposable),
    fonts: createFontsApi(),
    scroll: createScrollApi(descriptor.id, addDisposable),
    appIcons: {
      refresh: () => window.electron.plugins?.icons.refresh() ?? Promise.resolve({ ok: false }),
      restoreDefaultDesktopIcon: () =>
        window.electron.plugins?.icons.restoreDefaultDesktopIcon() ??
        Promise.resolve({ ok: false, error: '图标 API 不可用' }),
      restoreDefaultTaskbarIcon: () =>
        window.electron.plugins?.icons.restoreDefaultTaskbarIcon() ??
        Promise.resolve({ ok: false, error: '图标 API 不可用' }),
      setRuntimeWindowIcon: (iconPath: string) =>
        window.electron.plugins?.icons.setRuntimeWindowIcon(iconPath) ??
        Promise.resolve({ ok: false, error: '图标 API 不可用' }),
      restoreDefaultWindowIcon: () =>
        window.electron.plugins?.icons.restoreDefaultWindowIcon() ??
        Promise.resolve({ ok: false, error: '图标 API 不可用' }),
    },
    nowPlaying: window.electron.nowPlaying,
    windows: createPluginWindowsApi(descriptor.id),
    toast: createToastApi(),
    storage: {
      get: <T = unknown>(key: string) =>
        window.electron.plugins?.storage.get<T>(descriptor.id, key) ?? Promise.resolve(null),
      set: (key: string, value: unknown) =>
        window.electron.plugins?.storage.set(descriptor.id, key, serializeForIpc(value)) ??
        Promise.resolve(null),
      delete: (key: string) =>
        window.electron.plugins?.storage.delete(descriptor.id, key) ?? Promise.resolve(null),
    },
    dialog: {
      selectDirectory: (options) =>
        window.electron.plugins?.dialog.selectDirectory(
          serializeForIpc(options) as typeof options,
        ) ?? Promise.resolve({ canceled: true, paths: [] }),
      selectFiles: (options) =>
        window.electron.plugins?.dialog.selectFiles(serializeForIpc(options) as typeof options) ??
        Promise.resolve({ canceled: true, paths: [] }),
    },
    fs: createPluginFsApi(descriptor.id),
    process: createPluginProcessApi(descriptor.id),
    ui: createRuntimeUiApi(descriptor.id, host, addDisposable),
    commands: {
      register: (id, handler, options) => {
        const dispose = registerPluginCommand(descriptor.id, {
          id,
          title: options?.title,
          handler: (...args) =>
            runPluginCallback(
              descriptor.id,
              `插件命令: ${options?.title || id}`,
              () => handler(...args),
              undefined,
            ),
        });
        return addDisposable(dispose);
      },
      execute: executePluginCommand,
    },
    shortcuts: createShortcutsApi(descriptor.id, addDisposable),
    css: {
      inject: (cssText, options) =>
        addDisposable(createStyleDisposer(descriptor.id, cssText, options?.id)),
    },
    events: {
      onTrackChange: (handler) =>
        addDisposable(
          watch(
            () => playerStore.currentTrackSnapshot,
            (track) =>
              runPluginCallback(descriptor.id, '播放曲目变化事件', () => handler(track), undefined),
            { deep: true },
          ),
        ),
      onPlaybackChange: (handler) =>
        addDisposable(
          watch(
            () => playerStore.isPlaying,
            (isPlaying) =>
              runPluginCallback(
                descriptor.id,
                '播放状态变化事件',
                () => handler(isPlaying),
                undefined,
              ),
          ),
        ),
    },
    dom: createDomApi(descriptor.id, addDisposable),
    net: {
      fetch: window.fetch.bind(window),
    },
    icons,
    electron: window.electron,
    dispose: addDisposable,
  };

  return context;
};

const resolvePluginActivator = (module: PluginModule) => {
  if (typeof module === 'function') return module;
  if (module && typeof module === 'object') {
    const defaultExport = Reflect.get(module, 'default') as PluginModuleDefault | undefined;
    if (typeof defaultExport === 'function') return defaultExport;
    if (
      defaultExport &&
      typeof defaultExport === 'object' &&
      typeof defaultExport.activate === 'function'
    ) {
      return defaultExport.activate.bind(defaultExport);
    }
    if (typeof Reflect.get(module, 'activate') === 'function') {
      return (Reflect.get(module, 'activate') as (ctx: EchoPluginContext) => unknown).bind(module);
    }
  }
  return null;
};

const resolvePluginDeactivator = (active: ActivePlugin) => {
  const module = active.module;
  if (module && typeof module === 'object') {
    const defaultExport = Reflect.get(module, 'default') as PluginModuleDefault | undefined;
    if (
      defaultExport &&
      typeof defaultExport === 'object' &&
      typeof defaultExport.deactivate === 'function'
    ) {
      return defaultExport.deactivate.bind(defaultExport);
    }
    if (typeof Reflect.get(module, 'deactivate') === 'function') {
      return (Reflect.get(module, 'deactivate') as (ctx: EchoPluginContext) => unknown).bind(
        module,
      );
    }
  }
  return null;
};

const importPluginModule = async (descriptor: EchoPluginDescriptor, code: string) => {
  const blob = new Blob([`${code}\n//# sourceURL=echo-plugin:${descriptor.id}`], {
    type: 'text/javascript',
  });
  const url = URL.createObjectURL(blob);
  const module = (await import(/* @vite-ignore */ url)) as PluginModule;
  return { module, url };
};

const deactivatePlugin = async (pluginId: string) => {
  const active = activePlugins.get(pluginId);
  if (!active) return;

  try {
    const deactivator = resolvePluginDeactivator(active);
    if (deactivator) await deactivator(active.context);
  } catch (error) {
    logger.warn('PluginRuntime', 'Plugin deactivate failed', { pluginId, error });
    void reportPluginRuntimeError(pluginId, error, '插件停用');
  }

  for (const dispose of active.disposables.slice().reverse()) {
    try {
      dispose();
    } catch (error) {
      logger.warn('PluginRuntime', 'Plugin disposable failed', { pluginId, error });
      void reportPluginRuntimeError(pluginId, error, '插件资源清理');
    }
  }
  await Promise.allSettled(
    active.descriptor.windows.map((item) =>
      window.electron.plugins?.windows.close(active.descriptor.id, item.id),
    ),
  );
  active.blobUrls.forEach((url) => URL.revokeObjectURL(url));
  removePluginContributions(pluginId);
  activePlugins.delete(pluginId);
  await syncActivePluginSession();
};

const activatePlugin = async (descriptor: EchoPluginDescriptor, host: PluginRuntimeHost) => {
  if (activePlugins.has(descriptor.id)) return;
  updateRecord(descriptor, 'loading');
  const mainAsset = await window.electron.plugins?.readAsset(descriptor.id, 'main');
  if (!mainAsset?.ok) {
    const message = mainAsset?.error || '插件入口读取失败';
    updateRecord(descriptor, 'error', message);
    await reportPluginActivationFailure(descriptor.id, message, '读取插件入口');
    return;
  }

  const disposables: Array<() => void> = [];
  const blobUrls: string[] = [];

  try {
    const styleAsset = descriptor.styleFile
      ? await window.electron.plugins?.readAsset(descriptor.id, 'style')
      : null;
    if (styleAsset?.ok && styleAsset.source) {
      disposables.push(createStyleDisposer(descriptor.id, styleAsset.source, 'manifest'));
    }

    const { module, url } = await importPluginModule(descriptor, mainAsset.source);
    blobUrls.push(url);
    const context = createPluginContext(descriptor, host, disposables);
    const activator = resolvePluginActivator(module);
    if (!activator) throw new Error('插件未导出 activate(ctx) 或默认函数');
    activePlugins.set(descriptor.id, { descriptor, context, module, disposables, blobUrls });
    await activator(context);
    clearCurrentPluginFailure(descriptor.id);
    updateRecord(descriptor, 'active');
  } catch (error) {
    await deactivatePlugin(descriptor.id);
    const message = getErrorMessage(error, '插件加载失败');
    logger.error('PluginRuntime', 'Plugin activate failed', { pluginId: descriptor.id, error });
    updateRecord(descriptor, 'error', message);
    await reportPluginActivationFailure(descriptor.id, error, '插件启动');
  }
};

export const refreshPlugins = async (
  options: { miniPlayer?: boolean; desktopLyric?: boolean; reloadActive?: boolean } = {},
) => {
  pluginRuntimeState.loading = true;
  try {
    const result: PluginListResult | undefined = await window.electron.plugins?.list();
    pluginRuntimeState.directory = result?.directory ?? '';
    pluginRuntimeState.safeMode = Boolean(result?.safeMode);
    pluginRuntimeState.lastFailure = result?.lastFailure ?? null;
    const descriptors = result?.plugins ?? [];
    const nextIds = new Set(descriptors.map((plugin) => plugin.id));
    const isRuntimeEligible = (descriptor: EchoPluginDescriptor) => {
      if (!descriptor.enabled || descriptor.invalid || !descriptor.compatibility.compatible) {
        return false;
      }
      if (options.miniPlayer) return descriptor.manifest.runtime?.miniPlayer === true;
      if (options.desktopLyric) return descriptor.manifest.runtime?.desktopLyric === true;
      return true;
    };

    for (const pluginId of Array.from(activePlugins.keys())) {
      const descriptor = descriptors.find((plugin) => plugin.id === pluginId);
      if (
        pluginRuntimeState.safeMode ||
        !nextIds.has(pluginId) ||
        !descriptor ||
        !isRuntimeEligible(descriptor) ||
        options.reloadActive
      ) {
        await deactivatePlugin(pluginId);
      }
    }

    pluginRuntimeState.records = descriptors.map((descriptor) => ({
      descriptor,
      status: activePlugins.has(descriptor.id) ? 'active' : descriptor.enabled ? 'idle' : 'idle',
      error: descriptor.error,
    }));

    if (pluginRuntimeState.safeMode || !hostRef) {
      await window.electron.plugins?.clearStartup();
      await syncActivePluginSession();
      return;
    }

    const enabledDescriptors = descriptors.filter(isRuntimeEligible);
    if (enabledDescriptors.length === 0) {
      await window.electron.plugins?.clearStartup();
      await syncActivePluginSession();
      return;
    }

    try {
      for (const descriptor of enabledDescriptors) {
        await window.electron.plugins?.markStartup([descriptor.id]);
        await activatePlugin(descriptor, hostRef);
      }
    } finally {
      await window.electron.plugins?.clearStartup();
      await syncActivePluginSession();
    }
  } finally {
    pluginRuntimeState.loading = false;
  }
};

export const setRuntimePluginEnabled = async (pluginId: string, enabled: boolean) => {
  const result = await window.electron.plugins?.setEnabled(pluginId, enabled);
  if (!result?.ok) {
    throw new Error(result?.error || '插件启停失败');
  }
  await refreshPlugins();
  return result.plugin;
};

export const setRuntimePluginSafeMode = async (enabled: boolean) => {
  const result = await window.electron.plugins?.setSafeMode(enabled);
  if (!result?.ok) {
    throw new Error(result?.error || '插件安全模式切换失败');
  }
  await refreshPlugins();
  return result.safeMode;
};

export const clearRuntimePluginFailure = async (pluginId: string) => {
  const shouldClearLastFailure = isLastFailureForPlugin(pluginId);
  if (shouldClearLastFailure) {
    const result = await window.electron.plugins?.clearFailure(pluginId);
    if (!result?.ok) {
      throw new Error('插件异常记录清除失败');
    }
    pluginRuntimeState.lastFailure = removePluginIdFromFailure(
      pluginRuntimeState.lastFailure,
      pluginId,
    );
  }
  clearCurrentPluginFailure(pluginId);
  clearRecordFailure(pluginId);
};

export const uninstallRuntimePlugin = async (pluginId: string) => {
  await deactivatePlugin(pluginId);
  const result = await window.electron.plugins?.uninstall(pluginId);
  if (!result?.ok) {
    throw new Error(result?.error || '插件卸载失败');
  }
  await refreshPlugins();
  return result.pluginId;
};

export const openPluginDirectory = () => window.electron.plugins?.openDirectory();

export const reloadOtherPluginRuntimes = () =>
  window.electron.plugins?.reloadRuntimes() ?? Promise.resolve();

export const onPluginRuntimeReloadRequested = (handler: () => void) =>
  window.electron.plugins?.onRuntimeReloadRequested(handler) ?? (() => {});

export const installPluginRuntime = (host: PluginRuntimeHost) => {
  hostRef = host;
  installPluginRuntimeErrorHandlers();
  const previousErrorHandler = host.app.config.errorHandler;
  host.app.config.errorHandler = (error, instance, info) => {
    const pluginId = extractPluginIdFromErrorSource(error);
    if (pluginId) {
      logger.error('PluginRuntime', 'Plugin Vue component failed', {
        pluginId,
        info,
        error,
      });
      void reportPluginRuntimeError(pluginId, error, `Vue 组件: ${info || '未知位置'}`);
      return;
    }
    previousErrorHandler?.(error, instance, info);
  };
  host.app.config.globalProperties.$echo = {
    app: host.app,
    router: host.router,
    pinia: host.pinia,
    plugins: pluginRuntimeState,
    executeCommand: executePluginCommand,
  };
  pluginRuntimeState.initialized = true;
};

export const getActivePluginIds = () => Array.from(activePlugins.keys());
