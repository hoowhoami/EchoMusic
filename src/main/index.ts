import { app } from 'electron';
import { initMain as initAudioLoopback } from 'electron-audio-loopback';
import { ensureLinuxMpvEnv } from './mpv/linuxEnv';
import { getDisableGpuAccelerationSetting, getHighDpiSettings } from './storage/settings';

// Linux: 兜底检测 libmpv 运行环境。
// 正式包应优先由启动 wrapper 在 Electron 启动前设置 LD_PRELOAD；这里仅处理异常入口。
if (!ensureLinuxMpvEnv()) {
  // relaunch 已触发，当前进程即将退出，不继续初始化
  process.exit(0);
}

// Windows 音频/媒体会话初始化前先固定应用身份，避免系统把后续会话识别成临时客户端。
if (process.platform === 'win32') {
  app.setAppUserModelId('com.hoowhoami.echomusic');
}

// 初始化系统音频 loopback（必须在 app.ready 之前）
initAudioLoopback();

if (process.platform === 'win32') {
  app.commandLine.appendSwitch('no-sandbox');
}

// 必须在 app.ready 之前读取并应用 GPU 加速设置
if (getDisableGpuAccelerationSetting()) {
  app.disableHardwareAcceleration();
}

// 高 DPI 支持：在 app.ready 前让 Chromium 使用指定设备缩放因子。
const highDpiSettings = getHighDpiSettings();
if (highDpiSettings.enabled) {
  app.commandLine.appendSwitch('high-dpi-support', '1');
  app.commandLine.appendSwitch('force-device-scale-factor', String(highDpiSettings.dpiScale));
}

void import('./app');
