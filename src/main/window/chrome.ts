import type { BrowserWindowConstructorOptions } from 'electron';

/** macOS owns its traffic lights; other platforms use the renderer's controls. */
export function getMainWindowChrome(platform: string): BrowserWindowConstructorOptions {
  return {
    frame: platform === 'darwin',
    titleBarStyle: 'hidden',
    ...(platform === 'darwin'
      ? { titleBarOverlay: true, trafficLightPosition: { x: 14, y: 14 } }
      : {}),
  };
}
