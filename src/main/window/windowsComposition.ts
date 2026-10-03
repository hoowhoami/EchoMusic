import type { BrowserWindow } from 'electron';
import { getNativePlatform } from '../native/platform';
import { syncWindowsBackgroundMaterial } from './backgroundMaterial';
import type { WindowBackground } from '../../shared/windowBackground';

export const supportsWindowsAccent = () => Boolean(getNativePlatform());

const active = new WeakMap<
  BrowserWindow,
  'none' | 'clear' | 'electron-transparent' | 'accent-acrylic' | 'acrylic'
>();
const forcedActive = new WeakMap<BrowserWindow, boolean>();

const nativeWindowAddress = (win: BrowserWindow) => {
  const handle = win.getNativeWindowHandle();
  return handle.length === 8
    ? handle.readBigUInt64LE().toString()
    : String(handle.readUInt32LE());
};

// 失焦保持依赖未公开属性 WCA_FORCE_ACTIVEWINDOW_APPEARANCE；旧版原生模块缺失该
// 导出时静默跳过，不影响毛玻璃本身，仅回到系统默认的失焦降级行为。
const syncForceActiveAppearance = (win: BrowserWindow, desired: boolean) => {
  const native = getNativePlatform();
  if (typeof native?.setWindowForceActiveAppearance !== 'function') {
    forcedActive.set(win, false);
    return;
  }
  try {
    const ok = native.setWindowForceActiveAppearance(nativeWindowAddress(win), desired) === true;
    forcedActive.set(win, ok ? desired : false);
  } catch {
    forcedActive.set(win, false);
  }
};

export function readWindowsCompositionDiagnostics(win: BrowserWindow) {
  const native = getNativePlatform();
  const result = {
    requestedBackend: active.get(win) ?? 'none',
    nativeAvailable: Boolean(native),
    nativeDiagnosticsAvailable: typeof native?.getWindowCompositionDiagnostics === 'function',
  };
  if (!result.nativeDiagnosticsAvailable) return result;
  try {
    return {
      ...result,
      actual: native!.getWindowCompositionDiagnostics!(nativeWindowAddress(win)),
    };
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
  // 失焦保持仅对毛玻璃后端有意义；透明/关闭模式不涉及。
  const wantForce =
    (mode === 'acrylic' || mode === 'accent-acrylic') && background.keepFrostedOnBlur === true;
  const previous = active.get(win) ?? 'none';
  if (previous === mode) {
    // 模式未变（如仅切换失焦保持开关）时只需同步该标志，避免重放整套后端。
    if ((forcedActive.get(win) ?? false) !== wantForce) syncForceActiveAppearance(win, wantForce);
    return;
  }
  const accent = (value: number) => {
    if (!getNativePlatform()?.setWindowComposition(nativeWindowAddress(win), value)) {
      throw new Error('系统背景接口不可用，已使用实色背景；请确认原生模块已更新。');
    }
  };
  try {
    // Clear the previous backend before selecting another; do not reset DWM on tint updates.
    if (previous === 'acrylic' || (previous === 'clear' && build >= 22621))
      syncWindowsBackgroundMaterial(win, false);
    if (previous === 'clear') accent(0);
    if (previous === 'accent-acrylic') accent(11);
    active.set(win, 'none');
    if (mode === 'acrylic') syncWindowsBackgroundMaterial(win, true);
    else if (mode === 'clear' && build >= 22621) {
      // Native DWM alpha alone cannot update Chromium's internal translucent surface state.
      // Prepare it through Electron, then remove only the native system backdrop.
      syncWindowsBackgroundMaterial(win, true);
      accent(5);
    } else if (mode === 'accent-acrylic') accent(10);
    // Legacy clear is provided by BrowserWindow.transparent. Calling the old
    // DWM mode here would reintroduce the failed opaque-window workaround.
    active.set(win, mode);
    syncForceActiveAppearance(win, wantForce);
  } catch (error) {
    try {
      syncWindowsBackgroundMaterial(win, false);
    } catch {
      /* best effort */
    }
    try {
      accent(build < 22621 ? 11 : 0);
    } catch {
      /* solid Chromium surface remains the fallback */
    }
    syncForceActiveAppearance(win, false);
    active.delete(win);
    throw error;
  }
}
