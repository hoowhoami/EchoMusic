import { app, screen } from 'electron';
import Conf from 'conf';
import {
  DEFAULT_DESKTOP_LYRIC_SETTINGS,
  type DesktopLyricSettings,
} from '../../shared/desktop-lyric';

export type DesktopLyricWindowState = {
  width: number;
  height: number;
  x?: number;
  y?: number;
};

type DesktopLyricPersistedSettings = DesktopLyricSettings & {
  windowState: DesktopLyricWindowState;
};

const DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS: DesktopLyricPersistedSettings = {
  ...DEFAULT_DESKTOP_LYRIC_SETTINGS,
  windowState: {
    width: 800,
    height: 180,
  },
};

const settingsStore = new Conf<DesktopLyricPersistedSettings>({
  projectName: app.getName(),
  configName: 'desktop-lyric',
  defaults: DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS,
});

export const DESKTOP_LYRIC_MIN_WIDTH = 640;
export const DESKTOP_LYRIC_MIN_HEIGHT = 140;
export const DESKTOP_LYRIC_MAX_WIDTH = 1400;
export const DESKTOP_LYRIC_MAX_HEIGHT = 360;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function getDesktopLyricSettings(): DesktopLyricSettings {
  const raw = settingsStore.store;
  return {
    enabled: Boolean(raw.enabled),
    locked: Boolean(raw.locked),
    autoShow: Boolean(raw.autoShow),
    alwaysOnTop: Boolean(raw.alwaysOnTop),
    secondaryEnabled: Boolean(raw.secondaryEnabled),
    theme: raw.theme ?? 'system',
    opacity: clamp(Number(raw.opacity) || DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS.opacity, 0.25, 1),
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
    secondaryMode: raw.secondaryMode ?? 'none',
    alignment: raw.alignment ?? 'both',
    doubleLine: typeof raw.doubleLine === 'boolean' ? raw.doubleLine : true,
    playedColor: String(raw.playedColor || '#31cfa1'),
    unplayedColor: String(raw.unplayedColor || '#7a7a7a'),
    strokeColor: String(raw.strokeColor || '#f1b8b3'),
    strokeEnabled: Boolean(raw.strokeEnabled),
    bold: Boolean(raw.bold),
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
    autoShow: Boolean(mergedBase.autoShow),
    alwaysOnTop: Boolean(mergedBase.alwaysOnTop),
    secondaryEnabled: Boolean(mergedBase.secondaryEnabled),
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
    secondaryMode: mergedBase.secondaryMode ?? current.secondaryMode,
    alignment: mergedBase.alignment ?? current.alignment,
    doubleLine: Boolean(mergedBase.doubleLine),
    playedColor: String(mergedBase.playedColor || current.playedColor),
    unplayedColor: String(mergedBase.unplayedColor || current.unplayedColor),
    strokeColor: String(mergedBase.strokeColor || current.strokeColor),
    strokeEnabled: Boolean(mergedBase.strokeEnabled),
    bold: Boolean(mergedBase.bold),
  };
}

export function persistDesktopLyricSettings(nextSettings: DesktopLyricSettings) {
  settingsStore.set({
    enabled: nextSettings.enabled,
    locked: nextSettings.locked,
    autoShow: nextSettings.autoShow,
    alwaysOnTop: nextSettings.alwaysOnTop,
    secondaryEnabled: nextSettings.secondaryEnabled,
    theme: nextSettings.theme,
    opacity: nextSettings.opacity,
    scale: nextSettings.scale,
    fontFamily: nextSettings.fontFamily,
    inactiveFontSize: nextSettings.inactiveFontSize,
    activeFontSize: nextSettings.activeFontSize,
    secondaryFontSize: nextSettings.secondaryFontSize,
    lineGap: nextSettings.lineGap,
    secondaryMode: nextSettings.secondaryMode,
    alignment: nextSettings.alignment,
    doubleLine: nextSettings.doubleLine,
    playedColor: nextSettings.playedColor,
    unplayedColor: nextSettings.unplayedColor,
    strokeColor: nextSettings.strokeColor,
    strokeEnabled: nextSettings.strokeEnabled,
    bold: nextSettings.bold,
  });
}

export function setDesktopLyricEnabledFlag(enabled: boolean) {
  settingsStore.set('enabled', enabled);
}

export function setDesktopLyricLockedFlag(locked: boolean) {
  settingsStore.set('locked', locked);
}

export function getDesktopLyricWindowState(): DesktopLyricWindowState {
  const state = settingsStore.get('windowState', DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS.windowState);
  return {
    width: clamp(
      Math.round(Number(state.width) || DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS.windowState.width),
      DESKTOP_LYRIC_MIN_WIDTH,
      DESKTOP_LYRIC_MAX_WIDTH,
    ),
    height: clamp(
      Math.round(
        Number(state.height) || DEFAULT_DESKTOP_LYRIC_PERSISTED_SETTINGS.windowState.height,
      ),
      DESKTOP_LYRIC_MIN_HEIGHT,
      DESKTOP_LYRIC_MAX_HEIGHT,
    ),
    ...(typeof state.x === 'number' ? { x: state.x } : {}),
    ...(typeof state.y === 'number' ? { y: state.y } : {}),
  };
}

const hasVisibleArea = (bounds: DesktopLyricWindowState) => {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const x = bounds.x ?? area.x;
    const y = bounds.y ?? area.y;
    return (
      x < area.x + area.width &&
      x + bounds.width > area.x &&
      y < area.y + area.height &&
      y + bounds.height > area.y
    );
  });
};

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
  const width = clamp(
    bounds.width,
    DESKTOP_LYRIC_MIN_WIDTH,
    Math.min(DESKTOP_LYRIC_MAX_WIDTH, area.width),
  );
  const height = clamp(
    bounds.height,
    DESKTOP_LYRIC_MIN_HEIGHT,
    Math.min(DESKTOP_LYRIC_MAX_HEIGHT, area.height),
  );
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
  const screenWidth = primaryArea.width;
  const screenHeight = primaryArea.height;
  const defaultWidth = Math.floor(screenWidth * 0.7);
  const defaultHeight = 200;

  const savedState = getDesktopLyricWindowState();
  let x = savedState.x;
  let y = savedState.y;
  let width = savedState.width || defaultWidth;
  let height = savedState.height || defaultHeight;

  width = Math.min(width, screenWidth);
  height = Math.min(height, screenHeight);

  const isValidPosition =
    x !== undefined &&
    y !== undefined &&
    x >= primaryArea.x &&
    x <= primaryArea.x + screenWidth &&
    y >= primaryArea.y &&
    y <= primaryArea.y + screenHeight;

  if (!isValidPosition) {
    x = Math.floor(primaryArea.x + (screenWidth - width) / 2);
    y = Math.floor(primaryArea.y + screenHeight - height);
  }

  return constrainBoundsToDisplay({ width, height, x, y });
}

export function persistDesktopLyricWindowState(bounds: DesktopLyricWindowState) {
  settingsStore.set('windowState', {
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
    ...(typeof bounds.x === 'number' ? { x: Math.round(bounds.x) } : {}),
    ...(typeof bounds.y === 'number' ? { y: Math.round(bounds.y) } : {}),
  });
}

export function getDesktopLyricVirtualScreenBounds() {
  const displays = screen.getAllDisplays();
  const bounds = displays.map((display) => display.workArea);
  return {
    minX: Math.min(...bounds.map((bound) => bound.x)),
    minY: Math.min(...bounds.map((bound) => bound.y)),
    maxX: Math.max(...bounds.map((bound) => bound.x + bound.width)),
    maxY: Math.max(...bounds.map((bound) => bound.y + bound.height)),
  };
}
