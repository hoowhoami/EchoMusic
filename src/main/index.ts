import { app } from 'electron';
import { initMain as initAudioLoopback } from 'electron-audio-loopback';
import { ensureLinuxMpvEnv } from './mpv/linuxEnv';
import { getDisableGpuAccelerationSetting } from './storage/settings';

const configureLinuxWindowingBackend = () => {
  if (process.platform !== 'linux') return;

  const requestedBackend = process.env.ECHOMUSIC_WINDOWING_BACKEND?.toLowerCase();
  const hasX11Display = Boolean(process.env.DISPLAY);
  const useNativeWayland =
    requestedBackend === 'wayland' ||
    process.env.ECHOMUSIC_NATIVE_WAYLAND === '1' ||
    process.env.ECHOMUSIC_NATIVE_WAYLAND?.toLowerCase() === 'true';
  const useX11 = requestedBackend === 'x11' || (!requestedBackend && hasX11Display);

  if (useNativeWayland) {
    process.env.ECHOMUSIC_WINDOWING_BACKEND = 'wayland';
    app.commandLine.appendSwitch('ozone-platform', 'wayland');
    return;
  }

  if (useX11) {
    // 桌面歌词穿透依赖 X11 输入区域；原生 Wayland 下没有稳定通用的 pass-through。
    process.env.ECHOMUSIC_WINDOWING_BACKEND = 'x11';
    app.commandLine.appendSwitch('ozone-platform', 'x11');
    return;
  }

  // 在 Wayland 会话下，显式使用 XWayland 兼容层（支持桌面歌词穿透）
  // 必须显式设置 ozone-platform，否则 Electron 可能无法正确初始化窗口系统
  process.env.ECHOMUSIC_WINDOWING_BACKEND = 'x11';
  app.commandLine.appendSwitch('ozone-platform', 'x11');
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
