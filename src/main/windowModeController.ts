import { getActiveWindowMode } from './windowMode';
import { showMiniPlayerWindow } from './miniPlayer';
import { showMainWindow } from './window';

export const restoreActiveWindowMode = async () => {
  if (getActiveWindowMode() === 'mini') {
    await showMiniPlayerWindow();
    return;
  }
  showMainWindow();
};
