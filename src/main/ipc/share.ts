import { clipboard } from 'electron';
import { ipcRegistry } from './registry';

export const registerShareHandlers = () => {
  ipcRegistry.registerHandler('share:copy', (_event, text: string) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });
  ipcRegistry.registerHandler('share:read-clipboard', () => clipboard.readText());
};
