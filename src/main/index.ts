import { app } from 'electron';
import { initMain as initAudioLoopback } from 'electron-audio-loopback';
import { getDisableGpuAccelerationSetting } from './storage/settings';

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
