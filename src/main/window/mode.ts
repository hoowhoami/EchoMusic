export type WindowMode = 'main' | 'mini';

let activeWindowMode: WindowMode = 'main';

export const getActiveWindowMode = () => activeWindowMode;

export const setActiveWindowMode = (mode: WindowMode) => {
  activeWindowMode = mode;
};
