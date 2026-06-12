import { app } from 'electron';
import { initMain as initAudioLoopback } from 'electron-audio-loopback';
import { ensureLinuxMpvEnv } from './mpv/linuxEnv';
import { getDisableGpuAccelerationSetting } from './storage/settings';

type LinuxWindowingBackend = 'wayland' | 'x11';

const normalizeLinuxWindowingBackend = (value?: string): LinuxWindowingBackend | null => {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'wayland') return 'wayland';
  if (normalized === 'x11' || normalized === 'xorg' || normalized === 'xwayland') return 'x11';
  return null;
};

const applyLinuxWindowingBackend = (backend: LinuxWindowingBackend) => {
  process.env.ECHOMUSIC_WINDOWING_BACKEND = backend;
  app.commandLine.appendSwitch('ozone-platform', backend);
  app.commandLine.appendSwitch('ozone-platform-hint', backend);

  if (backend === 'x11') {
    // XWayland is still Chromium's X11 backend. Pin GTK too so native dialogs/theme
    // code does not initialize against Wayland while Chromium uses X11.
    process.env.GDK_BACKEND = 'x11';
  }
};

const configureLinuxWindowingBackend = () => {
  if (process.platform !== 'linux') return;

  const requestedBackend = normalizeLinuxWindowingBackend(process.env.ECHOMUSIC_WINDOWING_BACKEND);
  const hasX11Display = Boolean(process.env.DISPLAY);
  const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
  const isWaylandSession = process.env.XDG_SESSION_TYPE === 'wayland';
  const useNativeWayland =
    requestedBackend === 'wayland' ||
    process.env.ECHOMUSIC_NATIVE_WAYLAND === '1' ||
    process.env.ECHOMUSIC_NATIVE_WAYLAND?.toLowerCase() === 'true';

  // 用户明确要求使用原生 Wayland
  if (useNativeWayland) {
    applyLinuxWindowingBackend('wayland');
    return;
  }

  // 用户明确要求使用 X11/XWayland。Wayland 会话里的 XWayland 仍然走 x11 后端，
  // 但必须存在 DISPLAY；没有 DISPLAY 时强制 X11 会导致 Electron 无法创建窗口。
  if (requestedBackend === 'x11') {
    if (hasX11Display) {
      applyLinuxWindowingBackend('x11');
      return;
    }
    if (hasWaylandDisplay) {
      console.warn(
        '[Windowing] ECHOMUSIC_WINDOWING_BACKEND=x11 requested but DISPLAY is missing; falling back to Wayland.',
      );
      applyLinuxWindowingBackend('wayland');
    }
    return;
  }

  // 自动检测：
  // - 在 Wayland 会话中，默认使用原生 Wayland（窗口兼容性优先）
  //   注意：桌面歌词的鼠标穿透功能依赖 X11，在原生 Wayland 下不可用
  //   如需桌面歌词，请设置环境变量：ECHOMUSIC_WINDOWING_BACKEND=x11
  // - 在纯 X11 会话中，使用 X11
  if (isWaylandSession && hasWaylandDisplay) {
    applyLinuxWindowingBackend('wayland');
    return;
  }

  // 纯 X11 环境或有 XWayland 但不是 Wayland 会话
  if (hasX11Display) {
    applyLinuxWindowingBackend('x11');
    return;
  }

  // 没有检测到任何显示环境，不设置 ozone-platform
};

// Linux: 检测并修复 libmpv 运行环境（必须在所有其他初始化之前）
// 如果环境未正确设置，会自动 relaunch 并退出当前进程
if (!ensureLinuxMpvEnv()) {
  // relaunch 已触发，当前进程即将退出，不继续初始化
  process.exit(0);
}

configureLinuxWindowingBackend();

// 初始化系统音频 loopback（必须在 app.ready 之前）
initAudioLoopback();

if (process.platform === 'win32' && app.isPackaged) {
  app.commandLine.appendSwitch('no-sandbox');
}

// 必须在 app.ready 之前读取并应用 GPU 加速设置
if (getDisableGpuAccelerationSetting()) {
  app.disableHardwareAcceleration();
}

void import('./app');
