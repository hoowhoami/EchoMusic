import { app } from 'electron';
import { initMain as initAudioLoopback } from 'electron-audio-loopback';
import { ensureLinuxMpvEnv } from './mpv/linuxEnv';
import { getDisableGpuAccelerationSetting } from './storage/settings';

// Linux: 检测并修复 libmpv 运行环境（必须在所有其他初始化之前）
// 如果环境未正确设置，会自动 relaunch 并退出当前进程
if (!ensureLinuxMpvEnv()) {
  // relaunch 已触发，当前进程即将退出，不继续初始化
  process.exit(0);
}

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
