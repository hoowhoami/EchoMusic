import { app } from 'electron';

if (process.platform === 'win32' && app.isPackaged) {
  app.commandLine.appendSwitch('no-sandbox');
}

void import('./app');
