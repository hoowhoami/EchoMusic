import type { BrowserWindow } from 'electron';
import { nativeTheme } from 'electron';
import { getNativePlatform } from '../native/platform';
import { syncWindowsBackgroundMaterial } from './backgroundMaterial';
import type { WindowBackground } from '../../shared/windowBackground';

export const supportsWindowsAccent = () => Boolean(getNativePlatform());

type CompositionMode =
  'none' | 'clear' | 'electron-transparent' | 'accent-acrylic' | 'accent-acrylic-keep' | 'acrylic';

const active = new WeakMap<BrowserWindow, { mode: CompositionMode; tint: number | undefined }>();

const nativeWindowAddress = (win: BrowserWindow) => {
  const handle = win.getNativeWindowHandle();
  return handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
};

export function readWindowsCompositionDiagnostics(win: BrowserWindow) {
  const native = getNativePlatform();
  const result = {
    requestedBackend: active.get(win)?.mode ?? 'none',
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

// keep 模式的系统等值 GradientColor（ABGR = alpha<<24 | 灰度）：在纯白/纯黑底板
// 上两点采样，与 backdrop 聚焦态对齐（深色 146/55 vs 146/54、浅色 225/134 vs
// 227/135，误差 ≤3 灰阶）。alpha 不能用遗留的 0x01——24H2 会把近零着色的
// accent 4 退化成无模糊灰罩，导致背景发黑。
const keepTint = () => (nativeTheme.shouldUseDarkColors ? 0x8c545454 : 0x8cd3d3d3);

export function applyWindowsComposition(
  win: BrowserWindow,
  background: WindowBackground,
  build: number,
) {
  // 失焦保持需要换成 Accent 后端：DWM 对 system backdrop（setBackgroundMaterial）
  // 的失焦平面化（模糊与内置遮罩一起消失）无法从外部阻止，只有 Accent 路径能
  // 在失焦后保持材质。着色由 native GradientColor 提供（随深浅色主题切换），
  // 无需渲染端遮罩；子类在拖动暂停后恢复 accent 4，失焦不再切换旧版模糊(3)。
  const keep = background.keepFrostedOnBlur === true;
  const tint = keep ? keepTint() : undefined;
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
  const previous = active.get(win) ?? { mode: 'none' as CompositionMode, tint: undefined };
  if (previous.mode === mode && previous.tint === tint) return;
  const accent = (value: number, keep = false, tint?: number) => {
    if (!getNativePlatform()?.setWindowComposition(nativeWindowAddress(win), value, keep, tint)) {
      throw new Error('系统背景接口不可用，已使用实色背景；请确认原生模块已更新。');
    }
  };
  try {
    // Clear the previous backend before selecting another; do not reset DWM on tint updates.
    // accent-acrylic-keep 在 Win11 上同样用 setBackgroundMaterial 准备过表面，退出时一并重置；
    // 未准备过时 syncWindowsBackgroundMaterial 内部会直接跳过。
    if (
      previous.mode === 'acrylic' ||
      previous.mode === 'accent-acrylic-keep' ||
      (previous.mode === 'clear' && build >= 22621)
    )
      syncWindowsBackgroundMaterial(win, false);
    if (previous.mode === 'clear') accent(0);
    if (previous.mode === 'accent-acrylic' || previous.mode === 'accent-acrylic-keep') accent(11);
    active.set(win, { mode: 'none', tint: undefined });
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
        accent(12, true, tint);
      } else {
        accent(10, true, tint);
      }
    } else if (mode === 'accent-acrylic') accent(10);
    // Legacy clear is provided by BrowserWindow.transparent. Calling the old
    // DWM mode here would reintroduce the failed opaque-window workaround.
    active.set(win, { mode, tint });
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
