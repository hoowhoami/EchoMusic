interface MaterialWindow {
  setBackgroundMaterial(material: 'acrylic' | 'none'): void;
}

const materialWindows = new WeakSet<MaterialWindow>();

export function syncWindowsBackgroundMaterial(window: MaterialWindow, enabled: boolean) {
  if (materialWindows.has(window) === enabled) return false;

  // Both Acrylic and Win11 clear prepare Chromium's translucent surface here.
  // 'none' also resets Electron's surface state and DWM margins, so only call it
  // for windows that this helper prepared. Alpha/color changes must not reset it.
  window.setBackgroundMaterial(enabled ? 'acrylic' : 'none');
  if (enabled) materialWindows.add(window);
  else materialWindows.delete(window);
  return true;
}
