import { app } from 'electron';
import Conf from 'conf';

if (process.platform === 'win32' && app.isPackaged) {
  app.commandLine.appendSwitch('no-sandbox');
}

// 必须在 app.ready 之前读取并应用 GPU 加速设置
const earlySettings = new Conf<{ disableGpuAcceleration?: boolean }>({
  projectName: app.getName(),
});
if (earlySettings.get('disableGpuAcceleration', false)) {
  app.disableHardwareAcceleration();
}

void import('./app');
