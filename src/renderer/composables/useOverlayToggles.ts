import { readonly, ref, type Ref } from 'vue';
import { useDesktopLyricStore } from '@/desktopLyric/store';

/** 桌面层开关的最短切换间隔：建/拆窗口都有成本，连点会把还没走完的操作叠上去。 */
const SWITCH_INTERVAL_MS = 2000;

interface SwitchLock {
  locked: Readonly<Ref<boolean>>;
  tryLock: () => boolean;
}

const createSwitchLock = (intervalMs: number): SwitchLock => {
  const locked = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tryLock = () => {
    if (locked.value) return false;
    locked.value = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      locked.value = false;
      timer = null;
    }, intervalMs);
    return true;
  };
  return { locked: readonly(locked), tryLock };
};

/**
 * 播放条 / 歌词页上的桌面层快捷开关。
 *
 * 任务栏歌词与动态壁纸的窗口都由主进程掌管，渲染层只订阅主进程广播的状态，
 * 切换时走各自的 IPC，不在这里维护第二份真相。
 */
const supported = window.electron?.platform === 'win32';
const taskbarEnabled = ref(false);
const wallpaperEnabled = ref(false);
const desktopSurfaceLock = createSwitchLock(SWITCH_INTERVAL_MS);
const taskbarLock = createSwitchLock(SWITCH_INTERVAL_MS);
let started = false;

const applyTaskbar = (state: { enabled?: boolean } | null | undefined) => {
  taskbarEnabled.value = Boolean(state && state.enabled);
};

const applyWallpaper = (state: { enabled?: boolean } | null | undefined) => {
  wallpaperEnabled.value = Boolean(state && state.enabled);
  // 壁纸占住桌面层时主进程会关掉桌面歌词，这里同步本地标志，按钮才不会显示错形态。
  if (wallpaperEnabled.value) useDesktopLyricStore().setLocal({ enabled: false });
};

const toggleTaskbar = async () => {
  if (!taskbarLock.tryLock()) return;
  const api = window.electron?.taskbarLyric;
  if (!api) return;
  applyTaskbar(await api.setEnabled(!taskbarEnabled.value));
};

const toggleWallpaper = async () => {
  const api = window.electron?.wallpaper;
  if (!api) return;
  applyWallpaper(await api.setEnabled(!wallpaperEnabled.value));
};

/**
 * 桌面歌词与动态壁纸是同一个位置的两种形态，互斥：关 → 桌面歌词 → 动态壁纸 → 关。
 * 切到壁纸时先关桌面歌词，主进程那边也会再做一次互斥，这里只是让顺序确定。
 */
const cycleDesktopSurface = async () => {
  if (!desktopSurfaceLock.tryLock()) return;
  const desktopLyric = useDesktopLyricStore();
  if (wallpaperEnabled.value) {
    await toggleWallpaper();
    return;
  }
  if (desktopLyric.settings.enabled) {
    await desktopLyric.setEnabled(false);
    await toggleWallpaper();
    return;
  }
  await desktopLyric.setEnabled(true);
};

export function useOverlayToggles() {
  if (!started && supported) {
    started = true;
    const api = window.electron;
    void api.taskbarLyric
      .getState()
      .then(applyTaskbar)
      .catch(() => {});
    api.taskbarLyric.onStateChange(applyTaskbar);
    void api.wallpaper
      .getState()
      .then(applyWallpaper)
      .catch(() => {});
    api.wallpaper.onStateChange(applyWallpaper);
  }
  return {
    supported,
    taskbarEnabled: readonly(taskbarEnabled),
    wallpaperEnabled: readonly(wallpaperEnabled),
    toggleTaskbar,
    toggleWallpaper,
    cycleDesktopSurface,
    desktopSurfaceLocked: desktopSurfaceLock.locked,
    taskbarLocked: taskbarLock.locked,
  };
}
