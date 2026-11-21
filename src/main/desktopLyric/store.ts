import { screen } from 'electron';
import type {
  DesktopLyricLayout,
  DesktopLyricSettings,
  DesktopLyricShadowStrength,
} from '../../shared/desktopLyric';
import {
  DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS,
  getDesktopLyricPersistedSettings,
  patchDesktopLyricPersistedSettings,
  type DesktopLyricWindowState,
} from '../storage/settings';
import { normalizeLyricTextConversionMode } from '../../shared/opencc';

export type { DesktopLyricWindowState } from '../storage/settings';

export const DESKTOP_LYRIC_MIN_WIDTH = 80;
export const DESKTOP_LYRIC_MIN_HEIGHT = 80;
export const DESKTOP_LYRIC_MAX_WIDTH = 100000;
export const DESKTOP_LYRIC_MAX_HEIGHT = 100000;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const isDesktopLyricShadowStrength = (value: unknown): value is DesktopLyricShadowStrength =>
  value === 'none' || value === 'soft' || value === 'normal' || value === 'strong';
const isDesktopLyricLayout = (value: unknown): value is DesktopLyricLayout =>
  value === 'horizontal' || value === 'vertical';

export const getDesktopLyricWindowLimits = () => ({
  minWidth: DESKTOP_LYRIC_MIN_WIDTH,
  minHeight: DESKTOP_LYRIC_MIN_HEIGHT,
  maxWidth: DESKTOP_LYRIC_MAX_WIDTH,
  maxHeight: DESKTOP_LYRIC_MAX_HEIGHT,
});

export function getDesktopLyricSettings(): DesktopLyricSettings {
  const raw = getDesktopLyricPersistedSettings();
  return {
    enabled: Boolean(raw.enabled),
    locked: Boolean(raw.locked),
    showUnlockButton:
      typeof raw.showUnlockButton === 'boolean'
        ? raw.showUnlockButton
        : DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS.showUnlockButton,
    autoShow: Boolean(raw.autoShow),
    alwaysOnTop: Boolean(raw.alwaysOnTop),
    wantTranslation: Boolean(raw.wantTranslation),
    wantRomanization: Boolean(raw.wantRomanization),
    showRomanizationAsRuby: Boolean(raw.showRomanizationAsRuby),
    textConversionMode: normalizeLyricTextConversionMode(raw.textConversionMode),
    theme: raw.theme ?? 'system',
    opacity: clamp(
      Number(raw.opacity) || DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS.opacity,
      0.25,
      1,
    ),
    scale: clamp(Number(raw.scale) || DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS.scale, 0.75, 1.5),
    fontFamily: String(raw.fontFamily || DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS.fontFamily),
    inactiveFontSize: clamp(
      Math.round(
        Number(raw.inactiveFontSize) || DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS.inactiveFontSize,
      ),
      18,
      56,
    ),
    activeFontSize: clamp(
      Math.round(
        Number(raw.activeFontSize) || DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS.activeFontSize,
      ),
      24,
      76,
    ),
    secondaryFontSize: clamp(
      Math.round(
        Number(raw.secondaryFontSize) || DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS.secondaryFontSize,
      ),
      12,
      36,
    ),
    lineGap: clamp(
      Math.round(Number(raw.lineGap) || DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS.lineGap),
      4,
      28,
    ),
    alignment: raw.alignment ?? 'both',
    showNextLinePreview:
      typeof raw.showNextLinePreview === 'boolean'
        ? raw.showNextLinePreview
        : DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS.showNextLinePreview,
    playedColor: String(raw.playedColor || '#31cfa1'),
    followCoverColor: Boolean(raw.followCoverColor),
    unplayedColor: String(raw.unplayedColor || '#7a7a7a'),
    unplayedFollowCoverColor: Boolean(raw.unplayedFollowCoverColor),
    strokeColor: String(raw.strokeColor || '#f1b8b3'),
    strokeEnabled: Boolean(raw.strokeEnabled),
    shadowStrength: isDesktopLyricShadowStrength(raw.shadowStrength)
      ? raw.shadowStrength
      : DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS.shadowStrength,
    bold: Boolean(raw.bold),
    layout: isDesktopLyricLayout(raw.layout) ? raw.layout : 'horizontal',
    filterEnabled: Boolean(raw.filterEnabled),
    filterPattern: String(raw.filterPattern || ''),
    offsetStep: clamp(
      Number(raw.offsetStep) || DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS.offsetStep,
      0.1,
      5,
    ),
  };
}

export function sanitizeDesktopLyricSettings(
  partial: Partial<DesktopLyricSettings>,
  current: DesktopLyricSettings,
): DesktopLyricSettings {
  const mergedBase = {
    ...current,
    ...partial,
  };

  return {
    enabled: Boolean(mergedBase.enabled),
    locked: Boolean(mergedBase.locked),
    showUnlockButton:
      typeof mergedBase.showUnlockButton === 'boolean'
        ? mergedBase.showUnlockButton
        : current.showUnlockButton,
    autoShow: Boolean(mergedBase.autoShow),
    alwaysOnTop: Boolean(mergedBase.alwaysOnTop),
    wantTranslation: Boolean(mergedBase.wantTranslation),
    wantRomanization: Boolean(mergedBase.wantRomanization),
    showRomanizationAsRuby: Boolean(mergedBase.showRomanizationAsRuby),
    textConversionMode: normalizeLyricTextConversionMode(mergedBase.textConversionMode),
    theme: mergedBase.theme ?? current.theme,
    opacity: clamp(Number(mergedBase.opacity) || current.opacity, 0.25, 1),
    scale: clamp(Number(mergedBase.scale) || current.scale, 0.75, 1.5),
    fontFamily: String(mergedBase.fontFamily || current.fontFamily),
    inactiveFontSize: clamp(
      Math.round(Number(mergedBase.inactiveFontSize) || current.inactiveFontSize),
      18,
      56,
    ),
    activeFontSize: clamp(
      Math.round(Number(mergedBase.activeFontSize) || current.activeFontSize),
      24,
      76,
    ),
    secondaryFontSize: clamp(
      Math.round(Number(mergedBase.secondaryFontSize) || current.secondaryFontSize),
      12,
      36,
    ),
    lineGap: clamp(Math.round(Number(mergedBase.lineGap) || current.lineGap), 4, 28),
    alignment: mergedBase.alignment ?? current.alignment,
    showNextLinePreview: Boolean(mergedBase.showNextLinePreview),
    playedColor: String(mergedBase.playedColor || current.playedColor),
    followCoverColor:
      typeof mergedBase.followCoverColor === 'boolean'
        ? mergedBase.followCoverColor
        : current.followCoverColor,
    unplayedColor: String(mergedBase.unplayedColor || current.unplayedColor),
    unplayedFollowCoverColor:
      typeof mergedBase.unplayedFollowCoverColor === 'boolean'
        ? mergedBase.unplayedFollowCoverColor
        : current.unplayedFollowCoverColor,
    strokeColor: String(mergedBase.strokeColor || current.strokeColor),
    strokeEnabled: Boolean(mergedBase.strokeEnabled),
    shadowStrength: isDesktopLyricShadowStrength(mergedBase.shadowStrength)
      ? mergedBase.shadowStrength
      : current.shadowStrength,
    bold: Boolean(mergedBase.bold),
    layout: isDesktopLyricLayout(mergedBase.layout) ? mergedBase.layout : current.layout,
    filterEnabled: Boolean(mergedBase.filterEnabled),
    filterPattern: String(mergedBase.filterPattern || ''),
    offsetStep: clamp(Number(mergedBase.offsetStep) || current.offsetStep, 0.1, 5),
  };
}

export function persistDesktopLyricSettings(nextSettings: DesktopLyricSettings) {
  patchDesktopLyricPersistedSettings({
    enabled: nextSettings.enabled,
    locked: nextSettings.locked,
    showUnlockButton: nextSettings.showUnlockButton,
    autoShow: nextSettings.autoShow,
    alwaysOnTop: nextSettings.alwaysOnTop,
    wantTranslation: nextSettings.wantTranslation,
    wantRomanization: nextSettings.wantRomanization,
    showRomanizationAsRuby: nextSettings.showRomanizationAsRuby,
    textConversionMode: normalizeLyricTextConversionMode(nextSettings.textConversionMode),
    theme: nextSettings.theme,
    opacity: nextSettings.opacity,
    scale: nextSettings.scale,
    fontFamily: nextSettings.fontFamily,
    inactiveFontSize: nextSettings.inactiveFontSize,
    activeFontSize: nextSettings.activeFontSize,
    secondaryFontSize: nextSettings.secondaryFontSize,
    lineGap: nextSettings.lineGap,
    alignment: nextSettings.alignment,
    showNextLinePreview: nextSettings.showNextLinePreview,
    playedColor: nextSettings.playedColor,
    followCoverColor: nextSettings.followCoverColor,
    unplayedColor: nextSettings.unplayedColor,
    unplayedFollowCoverColor: nextSettings.unplayedFollowCoverColor,
    strokeColor: nextSettings.strokeColor,
    strokeEnabled: nextSettings.strokeEnabled,
    shadowStrength: nextSettings.shadowStrength,
    bold: nextSettings.bold,
    layout: nextSettings.layout,
    offsetStep: nextSettings.offsetStep,
  });
}

export function setDesktopLyricEnabledFlag(enabled: boolean) {
  patchDesktopLyricPersistedSettings({ enabled });
}

export function setDesktopLyricLockedFlag(locked: boolean) {
  patchDesktopLyricPersistedSettings({ locked });
}

export function getDesktopLyricWindowState(): DesktopLyricWindowState {
  const state = getDesktopLyricPersistedSettings().windowState;
  const limits = getDesktopLyricWindowLimits();
  return {
    width: clamp(
      Math.round(Number(state.width) || DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS.windowState.width),
      limits.minWidth,
      limits.maxWidth,
    ),
    height: clamp(
      Math.round(
        Number(state.height) || DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS.windowState.height,
      ),
      limits.minHeight,
      limits.maxHeight,
    ),
    ...(typeof state.x === 'number' ? { x: state.x } : {}),
    ...(typeof state.y === 'number' ? { y: state.y } : {}),
    ...(typeof state.displayId === 'string' && state.displayId
      ? { displayId: state.displayId }
      : {}),
    ...(typeof state.ratioX === 'number' && Number.isFinite(state.ratioX)
      ? { ratioX: state.ratioX }
      : {}),
    ...(typeof state.ratioY === 'number' && Number.isFinite(state.ratioY)
      ? { ratioY: state.ratioY }
      : {}),
  };
}

// const hasVisibleArea = (bounds: DesktopLyricWindowState) => {
//   return screen.getAllDisplays().some((display) => {
//     const area = display.workArea;
//     const x = bounds.x ?? area.x;
//     const y = bounds.y ?? area.y;
//     return (
//       x < area.x + area.width &&
//       x + bounds.width > area.x &&
//       y < area.y + area.height &&
//       y + bounds.height > area.y
//     );
//   });
// };

const getBestDisplayForBounds = (bounds: DesktopLyricWindowState) => {
  const displays = screen.getAllDisplays();
  const centerX = (bounds.x ?? 0) + bounds.width / 2;
  const centerY = (bounds.y ?? 0) + bounds.height / 2;
  const displayByPoint = screen.getDisplayNearestPoint({
    x: Math.round(centerX),
    y: Math.round(centerY),
  });
  if (displayByPoint) return displayByPoint;
  return displays[0] ?? screen.getPrimaryDisplay();
};

export function constrainBoundsToDisplay(bounds: DesktopLyricWindowState): DesktopLyricWindowState {
  const display = getBestDisplayForBounds(bounds);
  const area = display.workArea;
  const limits = getDesktopLyricWindowLimits();
  const width = clamp(bounds.width, limits.minWidth, Math.min(limits.maxWidth, area.width));
  const height = clamp(bounds.height, limits.minHeight, Math.min(limits.maxHeight, area.height));
  const rawX =
    typeof bounds.x === 'number' ? bounds.x : area.x + Math.round((area.width - width) / 2);
  const rawY =
    typeof bounds.y === 'number' ? bounds.y : area.y + Math.round(area.height * 0.72 - height / 2);

  return {
    width,
    height,
    x: clamp(rawX, area.x, area.x + area.width - width),
    y: clamp(rawY, area.y, area.y + area.height - height),
  };
}

export function resolveInitialBounds() {
  const primaryArea = screen.getPrimaryDisplay().workArea;
  const defaultWidth = Math.floor(primaryArea.width * 0.7);
  const defaultHeight = 200;

  const savedState = getDesktopLyricWindowState();
  const width = savedState.width || defaultWidth;
  const height = savedState.height || defaultHeight;
  // 位置带过所在屏与归一化比例时先按当前坐标系换算：缩放、分辨率变化后原始 DIP
  // 坐标会指向别的屏（主屏 100%→150% 时 DIP 空间缩半，副屏刚好顶上来）。
  const remapped = remapSavedPosition(savedState, width, height);
  if (remapped) return constrainBoundsToDisplay(remapped);
  const x = savedState.x;
  const y = savedState.y;

  // 检查保存的位置是否在任意一个显示器的工作区内有可见区域
  const isValidPosition =
    x !== undefined &&
    y !== undefined &&
    screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      // 窗口与该显示器工作区有交集（至少 50px 可见）
      const overlap = 50;
      return (
        x + width > area.x + overlap &&
        x < area.x + area.width - overlap &&
        y + height > area.y + overlap &&
        y < area.y + area.height - overlap
      );
    });

  if (!isValidPosition) {
    // 位置无效，回退到主显示器底部居中
    const fallbackX = Math.floor(primaryArea.x + (primaryArea.width - width) / 2);
    const fallbackY = Math.floor(primaryArea.y + primaryArea.height - height);
    return constrainBoundsToDisplay({ width, height, x: fallbackX, y: fallbackY });
  }

  return constrainBoundsToDisplay({ width, height, x, y });
}

/** 按标识找显示器；显示器重挂后 id 会变，找不到时退回原来的「按中心点选屏」逻辑。 */
const findDisplayById = (id?: string): ReturnType<typeof screen.getPrimaryDisplay> | null => {
  if (!id) return null;
  return screen.getAllDisplays().find((display) => String(display.id) === id) ?? null;
};

/**
 * 把保存时的位置还原到当前坐标系。位置是按所在屏工作区归一化存的：主屏从 100% 切到
 * 150% 后 DIP 空间直接缩半，原始 x/y 会落到下面那块屏上，必须按比例换算回来。
 */
const remapSavedPosition = (
  state: DesktopLyricWindowState,
  width: number,
  height: number,
): DesktopLyricWindowState | null => {
  if (typeof state.ratioX !== 'number' || typeof state.ratioY !== 'number') return null;
  const display = findDisplayById(state.displayId);
  if (!display) return null;
  const area = display.workArea;
  return {
    width,
    height,
    x: Math.round(area.x + state.ratioX * area.width),
    y: Math.round(area.y + state.ratioY * area.height),
  };
};

/** 存位置时一并记下所在屏与归一化比例，供下次按当前缩放还原。 */
const resolvePositionAnchor = (
  bounds: DesktopLyricWindowState,
): Pick<DesktopLyricWindowState, 'displayId' | 'ratioX' | 'ratioY'> => {
  if (typeof bounds.x !== 'number' || typeof bounds.y !== 'number') return {};
  const display = screen.getDisplayMatching({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  });
  if (!display) return {};
  const area = display.workArea;
  const clampRatio = (value: number) => Math.min(1, Math.max(0, value));
  return {
    displayId: String(display.id),
    ratioX: clampRatio((bounds.x - area.x) / Math.max(1, area.width)),
    ratioY: clampRatio((bounds.y - area.y) / Math.max(1, area.height)),
  };
};

export function persistDesktopLyricWindowState(bounds: DesktopLyricWindowState) {
  patchDesktopLyricPersistedSettings({
    windowState: {
      ...resolvePositionAnchor(bounds),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      ...(typeof bounds.x === 'number' ? { x: Math.round(bounds.x) } : {}),
      ...(typeof bounds.y === 'number' ? { y: Math.round(bounds.y) } : {}),
    },
  });
}
