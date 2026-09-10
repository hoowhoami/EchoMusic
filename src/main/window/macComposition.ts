import type { WindowBackground } from '../../shared/window-background';

interface MacCompositionWindow {
  setVibrancy(type: 'hud' | 'under-window' | null): void;
  setBackgroundColor(color: string): void;
  hasShadow(): boolean;
  setHasShadow(value: boolean): void;
  invalidateShadow(): void;
}

const materials = new WeakMap<MacCompositionWindow, 'hud' | 'under-window' | null>();

export function applyMacWindowBackground(
  win: MacCompositionWindow,
  background: WindowBackground,
  transparent: boolean,
  dark: boolean,
) {
  const material =
    background.enabled && background.frosted ? (dark ? 'hud' : 'under-window') : null;
  if (materials.get(win) !== material) {
    win.setVibrancy(material);
    materials.set(win, material);
  }
  // Reveal NSVisualEffectView beneath the web surface without making NSWindow transparent.
  win.setBackgroundColor(background.enabled ? '#00000000' : dark ? '#26262a' : '#f5f5f7');
  // Only genuinely transparent windows need the alpha-shadow workaround.
  const shadow =
    !transparent || !background.enabled || (!background.frosted && background.transparency === 0);
  if (win.hasShadow() !== shadow) {
    win.setHasShadow(shadow);
    win.invalidateShadow();
  }
}
