import type {
  WindowBackgroundCapabilities,
  WindowBackgroundStrategyId,
  WindowBackgroundTransparentMode,
} from './windowBackgroundStrategy';

export interface WindowBackground {
  enabled: boolean;
  transparency: number;
  frosted: boolean;
  color: string;
}

export const DEFAULT_WINDOW_BACKGROUND: WindowBackground = {
  enabled: false,
  transparency: 0,
  frosted: false,
  color: '',
};

export function normalizeWindowBackground(
  value: Partial<WindowBackground> | null,
): WindowBackground {
  const transparency = Number(value?.transparency);
  return {
    enabled: value?.enabled === true,
    transparency: Number.isFinite(transparency) ? Math.min(100, Math.max(0, transparency)) : 0,
    frosted: value?.frosted === true,
    color:
      typeof value?.color === 'string' && /^#[\da-f]{6}$/i.test(value.color) ? value.color : '',
  };
}

// Keep saved preferences separate from the appearance the current window can use.
export function resolveWindowBackground(
  value: WindowBackground,
  activeEnabled: boolean,
  activeFrosted: boolean | null = null,
): WindowBackground {
  return activeEnabled
    ? {
        ...normalizeWindowBackground(value),
        enabled: true,
        frosted: activeFrosted ?? value.frosted === true,
      }
    : { ...DEFAULT_WINDOW_BACKGROUND };
}

// Both legacy Windows effects need Electron's alpha surface. Modern Windows
// uses native composition without a transparent BrowserWindow. Hyprland keeps
// the alpha surface for the lifetime of the window so the app layer can toggle
// its own opacity without recreating the BrowserWindow.
export function getWindowComposition(
  value: WindowBackground,
  platform: string,
  build: number,
  strategy: WindowBackgroundStrategyId = 'default',
) {
  const systemMaterial = value.enabled && value.frosted && platform === 'win32' && build >= 22621;
  const alwaysTransparent = platform === 'linux' && strategy === 'hyprland';
  return {
    transparent:
      alwaysTransparent ||
      (value.enabled &&
        (platform === 'win32' ? build < 22621 : !(platform === 'darwin' && value.frosted))),
    systemMaterial,
    clientCornerRadius: 0,
  };
}

/** Resolve effects against the immutable BrowserWindow.transparent creation option. */
export function resolveRunningWindowBackground(
  value: WindowBackground,
  platform: string,
  transparent: boolean,
  buildOrCapabilities:
    | number
    | Pick<WindowBackgroundCapabilities, 'frostMode' | 'strategy'> = 22621,
) {
  const build = typeof buildOrCapabilities === 'number' ? buildOrCapabilities : 22621;
  const frostMode =
    typeof buildOrCapabilities === 'number' ? 'none' : buildOrCapabilities.frostMode;
  const strategy =
    typeof buildOrCapabilities === 'number' ? 'default' : buildOrCapabilities.strategy;
  const alwaysTransparent = platform === 'linux' && strategy === 'hyprland';
  const wanted = normalizeWindowBackground(value);
  if (platform === 'win32') {
    if (build >= 22621) return { background: wanted, restartRequired: false };
    const needsTransparentWindow = wanted.enabled;
    const restartRequired = needsTransparentWindow !== transparent;
    return {
      // Neither effect can be enabled on an existing opaque window. Off is safe
      // immediately, but recreating the window restores its native frame.
      background: restartRequired ? { ...DEFAULT_WINDOW_BACKGROUND } : wanted,
      restartRequired,
    };
  }
  if (platform === 'darwin') {
    const needsTransparentWindow = wanted.enabled && !wanted.frosted;
    return {
      // Vibrancy is independent of transparent. Clear cannot be enabled on an opaque window.
      background:
        needsTransparentWindow && !transparent ? { ...DEFAULT_WINDOW_BACKGROUND } : wanted,
      restartRequired: needsTransparentWindow !== transparent,
    };
  }
  // Linux has no Electron backdrop-material API; preserve the current native mode until restart.
  // Hyprland creates a transparent BrowserWindow from the start, so toggling
  // the app layer and compositor blur is live after that initial creation.
  return {
    background: resolveWindowBackground(
      wanted,
      alwaysTransparent && transparent ? wanted.enabled : transparent,
      frostMode === 'compositor' ? wanted.frosted : false,
    ),
    restartRequired: alwaysTransparent ? !transparent : wanted.enabled !== transparent,
  };
}

/**
 * Resolve the renderer-facing appearance after the host backend is known.
 * Hyprland owns the native transparent surface and blur, while the page keeps
 * its color/opacity layer so the controls remain adjustable at runtime.
 */
export function resolveRendererWindowBackground(
  value: WindowBackground,
  transparentMode: WindowBackgroundTransparentMode = 'layered',
): WindowBackground {
  const normalized = normalizeWindowBackground(value);
  if (transparentMode !== 'pure' || !normalized.enabled) return normalized;
  return { ...normalized, transparency: 100, color: '' };
}
