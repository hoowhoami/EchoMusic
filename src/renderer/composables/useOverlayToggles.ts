import { computed, reactive, readonly, ref } from 'vue';
import { useDesktopLyricStore } from '@/desktopLyric/store';

/** 桌面层按钮上两种形态的标识。 */
export type DesktopSurfaceKind = 'lyric' | 'wallpaper';

/**
 * 播放条 / 歌词页上的桌面层快捷开关。
 *
 * 任务栏歌词与动态壁纸的窗口都由主进程掌管，渲染层只订阅主进程广播的状态，
 * 切换时走各自的 IPC，不在这里维护第二份真相。
 */
const supported = window.electron?.platform === 'win32';
const taskbarEnabled = ref(false);
const wallpaperEnabled = ref(false);
/** 上一次用过的桌面层形态：都关着时按钮上的图案还留在这一种。 */
const lastSurface = ref<DesktopSurfaceKind>('lyric');
/** 桌面层按钮弹出的两项菜单：位置取按钮本身的位置。 */
const desktopSurfaceMenu = reactive({ open: false, x: 0, y: 0 });
let started = false;

const applyTaskbar = (state: { enabled?: boolean } | null | undefined) => {
  taskbarEnabled.value = Boolean(state && state.enabled);
};

const applyWallpaper = (state: { enabled?: boolean } | null | undefined) => {
  wallpaperEnabled.value = Boolean(state && state.enabled);
  // 壁纸占住桌面层时主进程会关掉桌面歌词，这里同步本地标志，按钮才不会显示错形态。
  if (wallpaperEnabled.value) {
    lastSurface.value = 'wallpaper';
    useDesktopLyricStore().setLocal({ enabled: false });
  }
};

const toggleTaskbar = async () => {
  const api = window.electron?.taskbarLyric;
  if (!api) return;
  applyTaskbar(await api.setEnabled(!taskbarEnabled.value));
};

const toggleWallpaper = async () => {
  const api = window.electron?.wallpaper;
  if (!api) return;
  applyWallpaper(await api.setEnabled(!wallpaperEnabled.value));
};

/** 当前开着的形态；两种都关着时是 null。 */
const desktopSurfaceCurrent = computed<DesktopSurfaceKind | null>(() => {
  if (wallpaperEnabled.value) return 'wallpaper';
  if (useDesktopLyricStore().settings.enabled) return 'lyric';
  return null;
});

/** 按钮上的图案：开着显示开的那个，关着显示上次用过的那个。 */
const desktopSurfaceIconKind = computed<DesktopSurfaceKind>(
  () => desktopSurfaceCurrent.value ?? lastSurface.value,
);

const desktopSurfaceActive = computed(() => desktopSurfaceCurrent.value !== null);

/** 菜单里的两项，enabled 的那项就是当前开着的形态。 */
const desktopSurfaceItems = computed(() => [
  {
    key: 'lyric' as DesktopSurfaceKind,
    label: '桌面歌词',
    enabled: desktopSurfaceCurrent.value === 'lyric',
  },
  {
    key: 'wallpaper' as DesktopSurfaceKind,
    label: '动态歌词壁纸',
    enabled: desktopSurfaceCurrent.value === 'wallpaper',
  },
]);

/** 上一次收起菜单的时刻：外部点击会先收起菜单再触发按钮的 click，用它区分「再点一次收回」。 */
let closedAt = 0;
const closeDesktopSurfaceMenu = () => {
  desktopSurfaceMenu.open = false;
  closedAt = Date.now();
};

/** 点按钮弹出菜单，菜单开着时再点一次就收起来；拿不到按钮位置时退回右下角。 */
const openDesktopSurfaceMenu = () => {
  if (desktopSurfaceMenu.open) {
    closeDesktopSurfaceMenu();
    return;
  }
  // 菜单开着时点按钮：指针按下的瞬间已经被外部点击监听收起了，这里不要又弹回来。
  if (Date.now() - closedAt < 300) return;
  // 鼠标点击会把按钮设为 activeElement，用它当锚点，省得把事件从动作表一路传进来。
  const rect = (document.activeElement as HTMLElement | null)?.getBoundingClientRect();
  desktopSurfaceMenu.x = rect ? Math.round(rect.left) : Math.round(window.innerWidth - 200);
  desktopSurfaceMenu.y = rect ? Math.round(rect.top) : Math.round(window.innerHeight - 120);
  desktopSurfaceMenu.open = true;
};

/**
 * 点菜单里的一项：点已开的那项就是关掉，点另一项就是切过去。
 * 两种形态互斥，切过去之前先把另一种关掉。
 */
const setDesktopSurface = async (kind: DesktopSurfaceKind) => {
  const desktopLyric = useDesktopLyricStore();
  const lyricOn = desktopLyric.settings.enabled;
  const wallpaperOn = wallpaperEnabled.value;
  if (kind === 'lyric') {
    if (lyricOn) {
      await desktopLyric.setEnabled(false);
    } else {
      if (wallpaperOn) await toggleWallpaper();
      lastSurface.value = 'lyric';
      await desktopLyric.setEnabled(true);
    }
  } else if (wallpaperOn) {
    await toggleWallpaper();
  } else {
    if (lyricOn) await desktopLyric.setEnabled(false);
    lastSurface.value = 'wallpaper';
    await toggleWallpaper();
  }
  closeDesktopSurfaceMenu();
};

/** 按钮上的提示文案按动作说：开着说关什么，关着说开什么。 */
const desktopSurfaceHint = computed(() => {
  const name = desktopSurfaceIconKind.value === 'wallpaper' ? '动态歌词壁纸' : '桌面歌词';
  return (desktopSurfaceCurrent.value ? '关闭' : '开启') + name;
});

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
    desktopSurfaceMenu: readonly(desktopSurfaceMenu),
    desktopSurfaceItems,
    desktopSurfaceCurrent,
    desktopSurfaceIconKind,
    desktopSurfaceActive,
    desktopSurfaceHint,
    openDesktopSurfaceMenu,
    closeDesktopSurfaceMenu,
    setDesktopSurface,
  };
}
