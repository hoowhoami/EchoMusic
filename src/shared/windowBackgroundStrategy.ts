/**
 * Window-background behavior selected by the host desktop/compositor.
 *
 * Keep backend detection and capabilities in this module so adding another
 * compositor later does not spread platform checks through the renderer and
 * the main window implementation.
 */
export type WindowBackgroundStrategyId = 'default' | 'hyprland';

export type WindowBackgroundTransparentMode = 'layered' | 'pure';

export type WindowBackgroundFrostMode = 'none' | 'native' | 'compositor';

export type WindowBackgroundFrostBackend =
  | 'none'
  | 'vibrancy'
  | 'acrylic'
  | 'accent-acrylic'
  | 'blur-behind'
  | 'hyprland-blur';

export interface WindowBackgroundCapabilities {
  strategy: WindowBackgroundStrategyId;
  supportsFrost: boolean;
  frostBackend: WindowBackgroundFrostBackend;
  frostMode: WindowBackgroundFrostMode;
  /** Whether the selected frost implementation can switch without relaunch. */
  frostLive: boolean;
  /** Whether entering/leaving an enabled background mode can switch live. */
  live: boolean;
  transparentMode: WindowBackgroundTransparentMode;
}

type Environment = Readonly<Record<string, string | undefined>>;

const desktopNames = (value: string | undefined) =>
  (value ?? '')
    .split(/[:;,]/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

/** Detect Hyprland without depending on a compositor-specific executable. */
export function isHyprlandEnvironment(env: Environment = {}) {
  if (env.HYPRLAND_INSTANCE_SIGNATURE?.trim()) return true;
  return [env.XDG_CURRENT_DESKTOP, env.XDG_SESSION_DESKTOP, env.DESKTOP_SESSION].some((value) =>
    desktopNames(value).includes('hyprland'),
  );
}

export function detectWindowBackgroundStrategy({
  platform,
  env = {},
}: {
  platform: string;
  env?: Environment;
}): WindowBackgroundStrategyId {
  return platform === 'linux' && isHyprlandEnvironment(env) ? 'hyprland' : 'default';
}

export function resolveWindowBackgroundCapabilities({
  platform,
  build,
  strategy = 'default',
  windowsAccentAvailable = false,
}: {
  platform: string;
  build: number;
  strategy?: WindowBackgroundStrategyId;
  windowsAccentAvailable?: boolean;
}): WindowBackgroundCapabilities {
  if (platform === 'win32') {
    const supportsFrost = build >= 22621 || windowsAccentAvailable;
    return {
      strategy: 'default',
      supportsFrost,
      frostBackend: supportsFrost ? (build >= 22621 ? 'acrylic' : 'accent-acrylic') : 'none',
      frostMode: supportsFrost ? 'native' : 'none',
      frostLive: true,
      live: true,
      transparentMode: 'layered',
    };
  }

  if (platform === 'darwin') {
    return {
      strategy: 'default',
      supportsFrost: true,
      frostBackend: 'vibrancy',
      frostMode: 'native',
      frostLive: true,
      live: false,
      transparentMode: 'layered',
    };
  }

  if (platform === 'linux' && strategy === 'hyprland') {
    return {
      strategy: 'hyprland',
      // Hyprland supplies the backdrop through decoration.blur. The app only
      // exposes a transparent surface and never edits the user's compositor
      // configuration.
      supportsFrost: true,
      frostBackend: 'hyprland-blur',
      frostMode: 'compositor',
      frostLive: true,
      live: false,
      transparentMode: 'pure',
    };
  }

  return {
    strategy: 'default',
    supportsFrost: false,
    frostBackend: 'none',
    frostMode: 'none',
    frostLive: false,
    live: false,
    transparentMode: 'layered',
  };
}
