type WindowingEnvironment = Readonly<Record<string, string | undefined>>;

type WindowingBackendOptions = {
  platform?: NodeJS.Platform;
  env?: WindowingEnvironment;
  argv?: readonly string[];
};

const getSwitchValue = (argv: readonly string[], name: string) => {
  const prefix = `--${name}=`;
  const inlineValue = argv.find((argument) => argument.startsWith(prefix));
  if (inlineValue) return inlineValue.slice(prefix.length).toLowerCase();

  const switchIndex = argv.indexOf(`--${name}`);
  return switchIndex >= 0 ? argv[switchIndex + 1]?.toLowerCase() : undefined;
};

export const isWaylandWindowingBackend = ({
  platform = process.platform,
  env = process.env,
  argv = process.argv,
}: WindowingBackendOptions = {}) => {
  if (platform !== 'linux') return false;

  const explicitBackend = env.ECHOMUSIC_WINDOWING_BACKEND?.toLowerCase();
  if (explicitBackend === 'wayland') return true;
  if (explicitBackend === 'x11' || explicitBackend === 'xwayland') return false;

  const ozonePlatform = getSwitchValue(argv, 'ozone-platform') ?? env.OZONE_PLATFORM?.toLowerCase();
  if (ozonePlatform === 'wayland') return true;
  if (ozonePlatform === 'x11') return false;

  const ozonePlatformHint = getSwitchValue(argv, 'ozone-platform-hint');
  if (ozonePlatformHint === 'wayland') return true;
  if (ozonePlatformHint === 'x11') return false;

  // Electron 38+ 在 XDG Wayland 会话中默认选择原生 Wayland；auto 也遵循该值。
  return env.XDG_SESSION_TYPE?.toLowerCase() === 'wayland';
};
