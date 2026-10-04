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

// Keep an alpha-capable surface for the entire window lifetime. Off mode paints
// an opaque background rather than changing BrowserWindow.transparent. Modern
// Windows prepares alpha through its native composition API and retains its frame.
export function getWindowComposition(
  value: WindowBackground,
  platform: string,
  build: number,
  strategy: WindowBackgroundStrategyId = 'default',
) {
  // All desktop strategies now keep the surface ready; retained for caller symmetry.
  void strategy;
  return {
    transparent: !(platform === 'win32' && build >= 22621),
    systemMaterial: value.enabled && value.frosted && platform === 'win32' && build >= 22621,
    clientCornerRadius: 0,
  };
}

/** Resolve against the alpha capability, not the last enabled material. */
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
  const wanted = normalizeWindowBackground(value);
  const alphaReady = transparent || (platform === 'win32' && build >= 22621);
  const requiresAlpha = wanted.enabled && !(platform === 'darwin' && wanted.frosted);
  if (requiresAlpha && !alphaReady)
    return { background: { ...DEFAULT_WINDOW_BACKGROUND }, restartRequired: true };
  return {
    background: {
      ...wanted,
      frosted: platform === 'linux' && frostMode !== 'compositor' ? false : wanted.frosted,
    },
    restartRequired: false,
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
