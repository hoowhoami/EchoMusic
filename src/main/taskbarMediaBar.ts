import { BrowserWindow, Menu, nativeTheme, screen } from 'electron';
import { join } from 'node:path';
import { ipcRegistry } from './ipc/registry';
import { getMainWindow, showMainWindow } from './window';
import { getMainAppSettings, setMainAppSetting } from './storage/settings';
import { getNativeTaskbarLyric, type NativeTaskbarLyricSession } from './native/platform';
import {
  DEFAULT_TASKBAR_LYRIC_SETTINGS,
  normalizeTaskbarLyricSettings,
  resolveTaskbarLyricRegion,
  type NativeTaskbarLayout,
  type TaskbarLyricSettings,
} from '../shared/taskbar';
import log from './logger';
import { bindVisibleNowPlayingWindow } from './nowPlaying';

let win: BrowserWindow | null = null;
let creating: Promise<void> | null = null;
let session: NativeTaskbarLyricSession | null = null;
let enabled = false;
let quitting = false;
let layout: NativeTaskbarLayout | null = null;
let region: ReturnType<typeof resolveTaskbarLyricRegion> = null;
let contentWidth = 160;
let disposeSystem: (() => void) | null = null;
let settings = { ...DEFAULT_TASKBAR_LYRIC_SETTINGS };
let settingsLoaded = false;
const destroyedNativeWindows = new WeakSet<BrowserWindow>();
let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
const nativeWidth = () => settings.maxWidth;
function loadSettings(): void {
  if (settingsLoaded) return;
  settings = getMainAppSettings().taskbarLyric;
  settingsLoaded = true;
}
const usable = (value: BrowserWindow | null): value is BrowserWindow =>
  Boolean(value && !destroyedNativeWindows.has(value) && !value.isDestroyed());
const state = () => ({
  enabled,
  visible: usable(win) && win.isVisible(),
  isDark: layout?.isDark ?? nativeTheme.shouldUseDarkColorsForSystemIntegratedUI,
  anchor: region?.anchor ?? 'left',
  maxWidth: region?.bounds.width ?? settings.maxWidth,
  settings,
});
function broadcastState(): void {
  const value = state();
  if (usable(win)) win.webContents.send('taskbar-player:state', value);
  const main = getMainWindow();
  if (usable(main)) main.webContents.send('taskbar-player:state', value);
}
let appliedShape = '';
function applyShape(): void {
  if (!usable(win) || !region) return;
  const width = Math.min(region.bounds.width, Math.max(160, Math.ceil(contentWidth)));
  const next: { x: number; y: number; width: number; height: number }[] =
    width === region.bounds.width
      ? []
      : [
          {
            x: region.anchor === 'right' ? region.bounds.width - width : 0,
            y: 0,
            width,
            height: region.bounds.height,
          },
        ];
  // SetWindowRgn 每次调用都会强制重绘。而任务栏每次被点击 / 前台切换，native 侧
  // 都会故意清空 last_layout 强制重发一份布局（为了恢复被系统隐藏的窗口，几何
  // 没变也要发）。若在这里无条件 setShape，歌词就会跟着闪一下 —— 表现为点击
  // 任务栏 / 托盘展开按钮时窗口抖动，而几何其实从未变过。形状没变就不要碰区域。
  const key = next.map((r) => `${r.x},${r.y},${r.width},${r.height}`).join('|');
  if (key === appliedShape) return;
  appliedShape = key;
  win.setShape(next);
}
function present(): void {
  if (!usable(win)) return;
  region = layout ? resolveTaskbarLyricRegion(layout, settings) : null;
  if (!enabled || quitting || !region || getMainWindow()?.isFullScreen()) {
    if (win.isVisible()) win.hide();
  } else {
    const before = win.getBounds();
    if (
      (['x', 'y', 'width', 'height'] as const).some((key) => before[key] !== region!.bounds[key])
    ) {
      win.setBounds(region.bounds, false);
    }
    applyShape();
    if (!win.isVisible()) win.showInactive();
  }
  broadcastState();
}
function release(): void {
  stopHeartbeat();
  disposeSystem?.();
  disposeSystem = null;
  session?.stop();
  session = null;
  layout = null;
  region = null;
}
function cancelRecovery(): void {
  clearTimeout(recoveryTimer);
  recoveryTimer = undefined;
}
/**
 * 停会话并销毁歌词窗口。
 *
 * 顺序不能反。`session.stop()` 会在本线程同步解除歌词窗口与 Shell_TrayWnd 的父子
 * 关系（native 侧 `detach`），之后 Chromium 窗口才回到自己的进程与线程内被销毁，
 * 收到完整的 WM_DESTROY → WM_NCDESTROY 序列。反过来先销毁，就是让 Explorer
 * 去销毁别的进程的子窗口 —— Chromium 的 NativeThemeObserver 析构 CHECK 失败，
 * 而由 native 补发 WM_DESTROY 又等于在 explorer 线程上跑 Chromium 宿主，
 * 直接拖垮整个 shell。
 */
function destroyBar(): void {
  if (!usable(win)) {
    release();
    return;
  }
  session?.stop();
  session = null;
  win.destroy();
}
async function createBar(): Promise<void> {
  const native = getNativeTaskbarLyric();
  if (!native) throw new Error('任务栏原生组件不可用，请重新构建 echo-platform-adaptor');
  if (!enabled || quitting) return;
  // 嵌入后 Chromium 的透明合成表面只能可靠缩小；初始大小覆盖可用的整个主屏。
  const display = screen.getPrimaryDisplay();
  const candidate = new BrowserWindow({
    width: Math.max(display.bounds.width, 800),
    height: 200,
    minWidth: 0,
    minHeight: 0,
    title: 'EchoMusic 任务栏歌词',
    type: 'toolbar',
    frame: false,
    thickFrame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    // 窗口创建后由 native 侧 SetParent 到 Shell_TrayWnd 嵌入任务栏，
    // 因此 setBounds 的坐标按父窗口客户区解释。这里没有 alwaysOnTop：
    // 子窗口由父窗口决定绘制顺序，不需要与 shell 争抢 z-order。
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: true,
      zoomFactor: 1,
      disableDialogs: true,
    },
  });
  win = candidate;
  // 新窗口的区域是空的；缓存沿用旧值会误判「形状没变」而跳过真正的设置。
  appliedShape = '';
  let recoverOnClose = true;
  // 跨进程销毁的诊断锚点。歌词窗口是 Shell_TrayWnd 的子窗口，Explorer 重建任务栏
  // 时会先摘掉子窗口；这条链上 Chromium 是否收到完整的
  // WM_DESTROY → WM_NCDESTROY 序列，直接决定浏览器进程会不会 CHECK 崩溃
  // （见 docs/taskbar-explorer-investigation.md）。两者的到达顺序与相对间隔都记进
  // 日志，崩溃复现时无需现场抓取即可还原现场。
  let destroySeenAt = 0;
  // 外部父窗口销毁 HWND 时，closed 之前还有一段 Chromium 清理期。
  // 期间禁止布局和播放推送再访问已经失效的窗口宿主。
  candidate.hookWindowMessage(0x0002 /* WM_DESTROY */, () => {
    destroySeenAt = Date.now();
    destroyedNativeWindows.add(candidate);
    if (enabled && !quitting) log.warn('[TaskbarLyric] WM_DESTROY on the lyric window');
  });
  candidate.hookWindowMessage(0x0082 /* WM_NCDESTROY */, () => {
    // gap < 0 表示 WM_NCDESTROY 先于 WM_DESTROY 到达 —— Chromium 的
    // NativeThemeObserver 此时还没注销，析构 CHECK 会失败。
    // 与 WM_DESTROY 一样只在会话存活期间记录，避免正常退出时刷警告。
    if (!enabled || quitting) return;
    const gap = destroySeenAt ? Date.now() - destroySeenAt : -1;
    log.warn(
      `[TaskbarLyric] WM_NCDESTROY on the lyric window (destroyGapMs=${gap}, ` +
        `sawDestroy=${destroySeenAt ? 1 : 0})`,
    );
  });
  bindVisibleNowPlayingWindow(candidate, () => usable(candidate));
  contentWidth = settings.maxWidth;
  candidate.on('closed', () => {
    if (win !== candidate) return;
    release();
    win = null;
    broadcastState();
    // Explorer 销毁父窗口时可能一并关闭子窗口；重新建立任务栏嵌入。
    if (recoverOnClose && enabled && !quitting && !creating) {
      // 不在 WM_DESTROY / closed 的同步调用栈里创建新 Chromium 窗口。
      cancelRecovery();
      recoveryTimer = setTimeout(() => {
        recoveryTimer = undefined;
        if (!enabled || quitting || win || creating) return;
        void setTaskbarPlayerEnabled(true).catch((error) =>
          log.error('[TaskbarLyric] Recovery failed:', error),
        );
      }, 0);
    }
  });
  candidate.on('page-title-updated', (event) => event.preventDefault());
  candidate.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  candidate.webContents.on('will-navigate', (event) => event.preventDefault());
  candidate.webContents.on('render-process-gone', (_event, details) => {
    recoverOnClose = false;
    log.error('[TaskbarLyric] Renderer exited:', details);
    // 渲染进程已经死了，但窗口宿主还在。仍然要先解挂再销毁，理由见 destroyBar。
    if (win === candidate) session?.stop();
    if (usable(candidate)) candidate.destroy();
  });
  candidate.webContents.on('context-menu', () => {
    Menu.buildFromTemplate([
      {
        label: '打开 EchoMusic',
        click: () => {
          void showMainWindow();
        },
      },
      { type: 'separator' },
      {
        label: '关闭任务栏歌词',
        click: () => {
          void setTaskbarPlayerEnabled(false);
        },
      },
    ]).popup({ window: candidate });
  });
  // loadFile 完成不代表透明合成表面已绘制；与 SPlayer-Next 一样等首帧后再嵌入。
  // 关闭同样结束等待，避免切换开关或退出时把 creating 永久挂住。
  let finishReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    finishReady = resolve;
  });
  candidate.once('ready-to-show', finishReady);
  candidate.once('closed', finishReady);
  try {
    const dev = process.env.VITE_DEV_SERVER_URL;
    if (dev) await candidate.loadURL(new URL('taskbar-player.html', dev).href);
    else await candidate.loadFile(join(__dirname, '../../dist/taskbar-player.html'));
    await ready;
    if (win !== candidate || !usable(candidate) || !enabled || quitting) return;
    const handle = candidate.getNativeWindowHandle();
    const hwnd =
      handle.length >= 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
    session = new native.TaskbarLyricSession(hwnd, nativeWidth(), (value) => {
      lastLayoutAt = Date.now();
      if (win !== candidate || !usable(candidate) || !enabled || quitting) return;
      layout = value;
      present();
    });
    const refresh = () => session?.update(nativeWidth());
    const main = getMainWindow();
    screen.on('display-metrics-changed', refresh);
    screen.on('display-added', refresh);
    screen.on('display-removed', refresh);
    nativeTheme.on('updated', refresh);
    main?.on('enter-full-screen', present);
    main?.on('leave-full-screen', refresh);
    disposeSystem = () => {
      screen.off('display-metrics-changed', refresh);
      screen.off('display-added', refresh);
      screen.off('display-removed', refresh);
      nativeTheme.off('updated', refresh);
      main?.off('enter-full-screen', present);
      main?.off('leave-full-screen', refresh);
    };
    broadcastState();
  } catch (error) {
    // 会话可能已经挂载成功（构造本身不抛错，失败点在之后的布局回调里不会走到
    // 这里，但 native 构造抛错时窗口可能已被 attach 过），同样要先解挂再销毁。
    if (win === candidate) {
      session?.stop();
      session = null;
    }
    if (usable(candidate)) candidate.destroy();
    throw error;
  } finally {
    candidate.off('ready-to-show', finishReady);
    candidate.off('closed', finishReady);
  }
}
export async function setTaskbarPlayerEnabled(value: boolean): Promise<ReturnType<typeof state>> {
  if (process.platform !== 'win32') throw new Error('任务栏歌词仅支持 Windows');
  loadSettings();
  enabled = value;
  if (!enabled) {
    cancelRecovery();
    destroyBar();
  }
  try {
    while (enabled && !quitting && (creating || !usable(win))) {
      if (!creating)
        creating = createBar().finally(() => {
          creating = null;
        });
      await creating;
    }
  } catch (error) {
    enabled = false;
    setMainAppSetting('taskbarPlayerEnabled', false);
    broadcastState();
    throw error;
  }
  if (!quitting) setMainAppSetting('taskbarPlayerEnabled', enabled);
  // 已经启用时也重新请求原生布局，让设置页 / 托盘的「重新显示」确实刷新隐藏状态。
  if (enabled) session?.update(nativeWidth());
  present();
  if (enabled) ensureHeartbeat();
  else stopHeartbeat();
  broadcastState();
  return state();
}

/**
 * 心跳：确认 native 会话仍在产出布局。
 *
 * Explorer 打开快速设置 / 通知中心这类 XAML 弹层时会销毁并重建 Shell_TrayWnd。
 * 这期间原生侧拿不到布局是**预期内**的，native 会自行重试并恢复；只有工作线程
 * 真的死了才需要重建 Chromium 窗口。两者的区分依据是任务栏句柄有没有变：
 * 变了说明 Explorer 在重建（等待即可），没变却长时间无响应才是会话失效。
 */
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let lastLayoutAt = 0;
let lastMountedTaskbar = 0;
const HEARTBEAT_INTERVAL_MS = 2000;
/** 连续这么多次心跳没有布局更新即判定会话已死。 */
const HEARTBEAT_MISS_LIMIT = 3;

function ensureHeartbeat(): void {
  if (heartbeatTimer) return;
  lastLayoutAt = Date.now();
  lastMountedTaskbar = getNativeTaskbarLyric()?.taskbarLyricMountedTaskbar?.() ?? 0;
  heartbeatTimer = setInterval(() => {
    if (!enabled || quitting || !usable(win)) return;
    session?.update(nativeWidth());
    if (Date.now() - lastLayoutAt < HEARTBEAT_INTERVAL_MS * HEARTBEAT_MISS_LIMIT) return;
    const mounted = getNativeTaskbarLyric()?.taskbarLyricMountedTaskbar?.() ?? 0;
    if (mounted !== lastMountedTaskbar) {
      // 任务栏句柄变了 => Explorer 正在重建，native 侧会自行重新挂载。
      // 这里只更新基线并继续等，不能重建窗口：重建又会落进下一个空窗，
      // 形成「销毁 -> 重建 -> 再次撞上空窗」的死循环。
      lastMountedTaskbar = mounted;
      lastLayoutAt = Date.now();
      return;
    }
    log.warn('[TaskbarLyric] Native session stopped responding, rebuilding the window');
    stopHeartbeat();
    destroyBar();
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
}
export function getTaskbarPlayerState(): ReturnType<typeof state> {
  loadSettings();
  return state();
}
function isSender(senderId: number): boolean {
  const main = getMainWindow();
  return (
    (usable(main) && senderId === main.webContents.id) ||
    (usable(win) && senderId === win.webContents.id)
  );
}
export function registerTaskbarPlayerHandlers(): void {
  ipcRegistry.registerHandler('taskbar-player:set-enabled', (event, value: boolean) => {
    if (!isSender(event.sender.id)) throw new Error('Invalid taskbar sender');
    if (typeof value !== 'boolean') throw new Error('Invalid taskbar state');
    return setTaskbarPlayerEnabled(value);
  });
  ipcRegistry.registerHandler('taskbar-player:get-state', () => {
    return getTaskbarPlayerState();
  });
  ipcRegistry.registerHandler(
    'taskbar-player:set-settings',
    (event, value: Partial<TaskbarLyricSettings>) => {
      if (!isSender(event.sender.id)) throw new Error('Invalid taskbar sender');
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid taskbar settings');
      loadSettings();
      settings = normalizeTaskbarLyricSettings({ ...settings, ...value });
      setMainAppSetting('taskbarLyric', settings);
      session?.update(nativeWidth());
      present();
      return state();
    },
  );
  ipcRegistry.registerListener('taskbar-player:content-width', (event, width: number) => {
    if (
      !usable(win) ||
      event.sender.id !== win.webContents.id ||
      !Number.isFinite(width) ||
      width <= 0
    )
      return;
    contentWidth = Math.min(settings.maxWidth, width);
    applyShape();
  });
  ipcRegistry.registerListener('taskbar-player:show-main', (event) => {
    if (usable(win) && event.sender.id === win.webContents.id) showMainWindow();
  });
}
export function restoreTaskbarPlayer(): void {
  quitting = false;
  if (process.platform === 'win32' && getMainAppSettings().taskbarPlayerEnabled) {
    void setTaskbarPlayerEnabled(true).catch((error) =>
      log.error('[TaskbarLyric] Restore failed:', error),
    );
  }
}
export function cleanupTaskbarPlayer(): void {
  quitting = true;
  cancelRecovery();
  destroyBar();
}
