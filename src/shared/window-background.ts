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

// Keep the Windows HWND non-layered in every mode. DWM owns its frame,
// shadow, animations and corners; composition is applied independently.
export function getWindowComposition(value: WindowBackground, platform: string, build: number) {
  const systemMaterial = value.enabled && value.frosted && platform === 'win32' && build >= 22621;
  return {
    transparent: value.enabled && platform !== 'win32' && !(platform === 'darwin' && value.frosted),
    systemMaterial,
    clientCornerRadius: 0,
  };
}

/** Resolve effects against the immutable BrowserWindow.transparent creation option. */
export function resolveRunningWindowBackground(
  value: WindowBackground,
  platform: string,
  transparent: boolean,
) {
  const wanted = normalizeWindowBackground(value);
  if (platform === 'win32') return { background: wanted, restartRequired: false };
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
  return {
    background: resolveWindowBackground(wanted, transparent, false),
    restartRequired: wanted.enabled !== transparent,
  };
}
