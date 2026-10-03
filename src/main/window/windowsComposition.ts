import type { BrowserWindow } from 'electron';
import { getNativePlatform } from '../native/platform';
import { syncWindowsBackgroundMaterial } from './backgroundMaterial';
import type { WindowBackground } from '../../shared/windowBackground';

export const supportsWindowsAccent = () => Boolean(getNativePlatform());

const active = new WeakMap<
  BrowserWindow,
  'none' | 'clear' | 'electron-transparent' | 'accent-acrylic' | 'accent-acrylic-keep' | 'acrylic'
>();

const nativeWindowAddress = (win: BrowserWindow) => {
  const handle = win.getNativeWindowHandle();
  return handle.length === 8
    ? handle.readBigUInt64LE().toString()
    : String(handle.readUInt32LE());
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
  // 失焦保持需要换成 Accent 后端：DWM 对 system backdrop（setBackgroundMaterial）
  // 的失活降级无法从外部阻止，只有 Accent 路径能被子类在失焦时切换到旧版模糊(3)。
  // 提亮罩色由渲染端 CSS（app-background-frosted-keep::before）统一提供，聚焦(4)/
  // 失焦(3)共用同一层保证观感一致；accent 仍使用遗留的 0x01000000 着色
  // （native 的 tint 参数保留但不再使用，缺省即回退该值）。
  const keep = background.keepFrostedOnBlur === true;
  const mode = !background.enabled
    ? 'none'
    : background.frosted
      ? keep
        ? 'accent-acrylic-keep'
        : build >= 22621
          ? 'acrylic'
          : 'accent-acrylic'
      : build >= 22621
        ? 'clear'
        : 'electron-transparent';
  const previous = active.get(win) ?? 'none';
  if (previous === mode) return;
  const accent = (value: number, keep = false) => {
    if (!getNativePlatform()?.setWindowComposition(nativeWindowAddress(win), value, keep)) {
      throw new Error('系统背景接口不可用，已使用实色背景；请确认原生模块已更新。');
    }
  };
  try {
    // Clear the previous backend before selecting another; do not reset DWM on tint updates.
    // accent-acrylic-keep 在 Win11 上同样用 setBackgroundMaterial 准备过表面，退出时一并重置；
    // 未准备过时 syncWindowsBackgroundMaterial 内部会直接跳过。
    if (
      previous === 'acrylic' ||
      previous === 'accent-acrylic-keep' ||
      (previous === 'clear' && build >= 22621)
    )
      syncWindowsBackgroundMaterial(win, false);
    if (previous === 'clear') accent(0);
    if (previous === 'accent-acrylic' || previous === 'accent-acrylic-keep') accent(11);
    active.set(win, 'none');
    if (mode === 'acrylic') syncWindowsBackgroundMaterial(win, true);
    else if (mode === 'clear' && build >= 22621) {
      // Native DWM alpha alone cannot update Chromium's internal translucent surface state.
      // Prepare it through Electron, then remove only the native system backdrop.
      syncWindowsBackgroundMaterial(win, true);
      accent(5);
    } else if (mode === 'accent-acrylic-keep') {
      if (build >= 22621) {
        // Electron 先准备半透明表面，原生侧只清除 backdrop 并叠加 Accent Acrylic。
        syncWindowsBackgroundMaterial(win, true);
        accent(12, true);
      } else {
        accent(10, true);
      }
    } else if (mode === 'accent-acrylic') accent(10);
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
      accent(build < 22621 ? 11 : 0);
    } catch {
      /* solid Chromium surface remains the fallback */
    }
    active.delete(win);
    throw error;
  }
}
