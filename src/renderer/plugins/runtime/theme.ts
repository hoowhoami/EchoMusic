import { reactive } from 'vue';
import { hexToRgb } from '@/utils/color';
import { createStyleDisposer } from './styles';

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

export const createThemeApi = (
  pluginId: string,
  addDisposable: (dispose: () => void) => () => void,
) => {
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
