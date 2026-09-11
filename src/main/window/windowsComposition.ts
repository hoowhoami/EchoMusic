import type { BrowserWindow } from 'electron';
import { getNativePlatform } from '../native/platform';
import { syncWindowsBackgroundMaterial } from './backgroundMaterial';
import type { WindowBackground } from '../../shared/window-background';

export const supportsWindowsAccent = () => Boolean(getNativePlatform());

export function getWindowsCompositionOptions(build: number, transparent = false) {
  return {
    // Before Win11 22H2, setBackgroundMaterial returns before updating Chromium.
    // The constructor still reads this value for IsTranslucent / DirectComposition.
    // Clear instead uses transparent:true and needs no material bootstrap.
    // No system Acrylic is applied on these OS versions; Accent owns the effect.
    ...(build < 22621 && !transparent ? { backgroundMaterial: 'acrylic' as const } : {}),
  };
}

const active = new WeakMap<
  BrowserWindow,
  'none' | 'clear' | 'electron-transparent' | 'accent-acrylic' | 'acrylic'
>();

export function readWindowsCompositionDiagnostics(win: BrowserWindow) {
  const native = getNativePlatform();
  const result = {
    requestedBackend: active.get(win) ?? 'none',
    nativeAvailable: Boolean(native),
    nativeDiagnosticsAvailable: typeof native?.getWindowCompositionDiagnostics === 'function',
  };
  if (!result.nativeDiagnosticsAvailable) return result;
  try {
    const handle = win.getNativeWindowHandle();
    const address =
      handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
    return { ...result, actual: native!.getWindowCompositionDiagnostics!(address) };
  } catch (error) {
    return { ...result, error: error instanceof Error ? error.message : String(error) };
  }
}

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
        : 'accent-acrylic'
      : build >= 22621
        ? 'clear'
        : 'electron-transparent';
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
    if (previous === 'acrylic' || (previous === 'clear' && build >= 22621))
      syncWindowsBackgroundMaterial(win, false);
    if (previous === 'clear' || previous === 'accent-acrylic') accent(0);
    active.set(win, 'none');
    if (mode === 'acrylic') syncWindowsBackgroundMaterial(win, true);
    else if (mode === 'clear' && build >= 22621) {
      // Native DWM alpha alone cannot update Chromium's internal translucent surface state.
      // Prepare it through Electron, then remove only the native system backdrop.
      syncWindowsBackgroundMaterial(win, true);
      accent(5);
    } else if (mode === 'accent-acrylic') accent(8);
    // Legacy clear is provided by BrowserWindow.transparent. Calling the old
    // DWM mode here would reintroduce the failed opaque-window workaround.
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
