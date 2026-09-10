import type { BrowserWindow } from 'electron';
import { getNativePlatform } from '../native/platform';
import { syncWindowsBackgroundMaterial } from './backgroundMaterial';
import type { WindowBackground } from '../../shared/window-background';

export const supportsWindowsAccent = () => Boolean(getNativePlatform());
const active = new WeakMap<BrowserWindow, 'none' | 'clear' | 'blur' | 'acrylic'>();

export function applyWindowsComposition(
  win: BrowserWindow,
  background: WindowBackground,
  build: number,
) {
  const mode = !background.enabled
    ? 'none'
    : background.frosted
      ? build >= 22621
        ? 'acrylic'
        : 'blur'
      : 'clear';
  const previous = active.get(win) ?? 'none';
  if (previous === mode) return;
  const accent = (value: number) => {
    const handle = win.getNativeWindowHandle();
    const address =
      handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
    if (!getNativePlatform()?.setWindowComposition(address, value)) {
      throw new Error('系统背景接口不可用，已使用实色背景；请确认原生模块已更新。');
    }
  };
  try {
    // Clear the previous backend before selecting another; do not reset DWM on tint updates.
    if (previous === 'acrylic') syncWindowsBackgroundMaterial(win, false);
    if (previous === 'clear' || previous === 'blur') accent(0);
    active.set(win, 'none');
    if (mode === 'acrylic') syncWindowsBackgroundMaterial(win, true);
    else if (mode !== 'none') accent(mode === 'blur' ? 2 : 1);
    active.set(win, mode);
  } catch (error) {
    try {
      syncWindowsBackgroundMaterial(win, false);
    } catch {
      /* best effort */
    }
    try {
      accent(0);
    } catch {
      /* solid Chromium surface remains the fallback */
    }
    active.delete(win);
    throw error;
  }
}
