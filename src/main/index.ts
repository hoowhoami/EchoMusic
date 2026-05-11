import { app } from 'electron';
import Conf from 'conf';
import { initMain as initAudioLoopback } from 'electron-audio-loopback';
import { ensureLinuxMpvEnv } from './mpv/linuxEnv';

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
  // 禁用 Chromium 的 DSF（设备缩放因子）缩放，以解决 Windows 高 DPI 下全屏可能出现的裁剪问题。
  // 这会强制 Electron 使用更传统的像素缩放方法，通常更可靠。
  app.commandLine.appendSwitch('disable-features', 'UseZoomForDSF');
}

// 必须在 app.ready 之前读取并应用 GPU 加速设置
const earlySettings = new Conf<{ disableGpuAcceleration?: boolean }>({
  projectName: app.getName(),
});
if (earlySettings.get('disableGpuAcceleration', false)) {
  app.disableHardwareAcceleration();
}

void import('./app');
