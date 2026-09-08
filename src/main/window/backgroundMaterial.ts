interface MaterialWindow {
  setBackgroundMaterial(material: 'acrylic' | 'none'): void;
}

const frostedWindows = new WeakSet<MaterialWindow>();

export function syncWindowsBackgroundMaterial(window: MaterialWindow, frosted: boolean) {
  if (frostedWindows.has(window) === frosted) return false;

  // Electron's 'none' also resets DWM client-area margins. A fresh transparent
  // window must keep its initial composition setup; only clear material that
  // we actually enabled. Theme/color/alpha updates must not reset it either.
  window.setBackgroundMaterial(frosted ? 'acrylic' : 'none');
  if (frosted) frostedWindows.add(window);
  else frostedWindows.delete(window);
  return true;
}
