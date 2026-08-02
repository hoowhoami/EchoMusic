import { showMiniPlayerWindow } from '../miniPlayer';
import { getActiveWindowMode } from './mode';
import { showMainWindow } from './index';

export const restoreActiveWindowMode = async () => {
  if (getActiveWindowMode() === 'mini') {
    await showMiniPlayerWindow();
    return;
  }
  showMainWindow();
};
