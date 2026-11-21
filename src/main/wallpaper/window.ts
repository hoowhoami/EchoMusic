/**
 * 桌面壁纸窗口：每块被选中的显示器一个窗口，挂在 Explorer 的 WorkerW 上。
 * 内容复用主渲染进程（index.html + #/wallpaper），因此不用重新注入 store。
 */
import { BrowserWindow, screen, type Display } from 'electron';
import { join } from 'node:path';
import { getNativeWallpaper, type NativeWallpaperMonitor } from '../native/platform';
import type { WallpaperFramePolicy } from './policy';
import { installWindowBackgroundThrottling } from '../windowBackgroundThrottling';
import log from '../logger';

export interface WallpaperSurface {
  displayId: string;
  win: BrowserWindow;
  monitor: NativeWallpaperMonitor | null;
  coverage: number;
  /** 歌词区域被窗口盖住的比例。 */
  lyricCoverage: number;
  /** 渲染层最近一次上报的歌词区域（屏幕物理像素）；没上报过就是 null。 */
  lyricRect: { x: number; y: number; width: number; height: number } | null;
  /** 这块屏当前的省电档位；每块屏各算各的。 */
  policy: WallpaperFramePolicy | null;
  attached: boolean;
  /** 这个窗口在该显示器上应占的屏幕矩形（DIP，Electron 口径）。 */
  rect: { x: number; y: number; width: number; height: number };
  /** 同一矩形的屏幕物理像素版本（原生 SetWindowPos 口径）。 */
  nativeRect: { x: number; y: number; width: number; height: number };
  /** 这块屏的缩放系数，用于把渲染层上报的 CSS 像素换算成物理像素。 */
  scaleFactor: number;
  /** 已经下发给这个窗口的省电策略；新建窗口从这里开始是空，必须补下发一次。 */
  applied: { frameRate: number; visible: boolean; reason: WallpaperFramePolicy['reason'] } | null;
}

export interface WallpaperOcclusionEvent {
  displayId: string;
  coverage: number;
  lyricCoverage: number;
}

/** BrowserWindow 的原生句柄统一转成十进制字符串，与 native 侧的解析保持一致。 */
const nativeHandle = (win: BrowserWindow): string => {
  const buffer = win.getNativeWindowHandle();
  return buffer.length >= 8 ? buffer.readBigUInt64LE(0).toString() : String(buffer.readUInt32LE(0));
};

/**
 * 壁纸在该显示器上应占的矩形：左右按整屏算（工作区左右会被桌面浮窗挤掉几像素，
 * 用工作区会导致两边露边），底边跟随工作区底边——任务栏不自动隐藏时让开任务栏，
 * 自动隐藏后工作区就是整块屏，壁纸随之铺满。
 */
const displayBounds = (display: Display) => ({
  x: Math.round(display.bounds.x),
  y: Math.round(display.bounds.y),
  width: Math.max(1, Math.round(display.bounds.width)),
  height: Math.max(1, Math.round(display.workArea.y + display.workArea.height - display.bounds.y)),
});

/** 显示器缩放系数；异常值（0/NaN）按 1 处理，否则原生侧会摆出 0 尺寸的窗口。 */
const scaleOf = (display: Display): number =>
  Number.isFinite(display.scaleFactor) && display.scaleFactor > 0 ? display.scaleFactor : 1;

/**
 * 同一个矩形换算成屏幕物理像素。原生侧（SetWindowPos）按物理像素摆放，Electron 的
 * display.bounds / BrowserWindow 构造参数全是 DIP，两边不能混用：150% 缩放的
 * 2880×1620 屏按 DIP 摆出去只盖住 1920×1080，桌面会露 1/3。
 */
export const displayPhysicalBounds = (display: Display) => {
  const bounds = displayBounds(display);
  const scale = scaleOf(display);
  // 原点不能乘本屏缩放：DIP 坐标是各屏首尾相接的，原点里已经含有别的屏按别的缩放
  // 折算出的偏移（主屏 150%、副屏 100% 上下排列时，副屏 DIP 原点 y=720 乘 1 得 720，
  // 而它的物理原点在 1080），乘出来整块窗口就偏了。交给 Electron 的 DIP→物理换算。
  const origin = screen.dipToScreenPoint({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
  });
  return {
    x: Math.round(origin.x),
    y: Math.round(origin.y),
    width: Math.max(1, Math.round(bounds.width * scale)),
    height: Math.max(1, Math.round(bounds.height * scale)),
  };
};

/** 目标矩形是否已经就是这个尺寸（任务栏显示/隐藏、改分辨率都会走到这里）。 */
export const surfaceMatchesDisplay = (surface: WallpaperSurface, display: Display): boolean => {
  const bounds = displayBounds(display);
  return (
    surface.rect.x === bounds.x &&
    surface.rect.y === bounds.y &&
    surface.rect.width === bounds.width &&
    surface.rect.height === bounds.height
  );
};

/**
 * 等第一帧能显示就返回，不等整页加载完。ready-to-show 在 Chromium 画出首帧时
 * 触发：dev 下整个前端要在壁纸窗口里重新加载一遍，等 did-finish-load 要好几秒，
 * 而挂载只需要已经合成过一帧。1.5 秒还没出首帧就直接往下走，剩下的内容挂上去
 * 之后继续加载。
 */
const waitForFirstPaint = (win: BrowserWindow): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 1500);
    win.once('ready-to-show', finish);
    win.webContents.once('did-fail-load', finish);
  });

export const createWallpaperSurface = async (
  display: Display,
  onOcclusion: (event: WallpaperOcclusionEvent) => void,
  /** 窗口被系统销毁（桌面层重建）时回调，由主进程决定重建。 */
  onLost: () => void,
): Promise<WallpaperSurface | null> => {
  const native = getNativeWallpaper();
  if (!native) {
    log.warn('[Wallpaper] 原生模块不支持壁纸挂载，请重新构建 echo-platform-adaptor');
    return null;
  }
  const bounds = displayBounds(display);
  const nativeRect = displayPhysicalBounds(display);
  const candidate = new BrowserWindow({
    ...bounds,
    title: 'EchoMusic 桌面壁纸',
    frame: false,
    // 无边框窗口默认仍带 WS_THICKFRAME，客户区四边被隐形边框吃掉 7px，
    // 画面就填不满窗口，桌面上会露出原来壁纸的窄条。
    thickFrame: false,
    // 透明底：仅歌词模式要让系统桌面壁纸透出来，其余模式由页面自己画背景。
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    // 桌面层窗口不参与任务切换，Windows 上按工具窗口处理最省事。
    type: process.platform === 'win32' ? 'toolbar' : 'desktop',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // 壁纸窗口要加载插件的 file:// 页面与插件本地服务，与主窗口保持一致，否则 iframe 被同源策略拦下、页面根本不加载。
      webSecurity: false,
      allowRunningInsecureContent: true,
      backgroundThrottling: true,
      zoomFactor: 1,
      disableDialogs: true,
    },
  });
  installWindowBackgroundThrottling(candidate);
  // 页面 <title> 会把窗口标题覆盖成 `EchoMusic`，固定住便于排查时按标题找窗口。
  candidate.on('page-title-updated', (event) => event.preventDefault());
  const surface: WallpaperSurface = {
    displayId: String(display.id),
    win: candidate,
    monitor: null,
    coverage: 0,
    lyricCoverage: 0,
    lyricRect: null,
    policy: null,
    attached: false,
    rect: bounds,
    nativeRect,
    scaleFactor: scaleOf(display),
    applied: null,
  };
  // 监听要在 loadURL 之前挂上：ready-to-show 可能就在加载过程中触发，晚了就漏掉。
  const painted = waitForFirstPaint(candidate);
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev) {
    const url = new URL('index.html', dev);
    url.hash = '/wallpaper';
    await candidate.loadURL(url.toString());
  } else {
    await candidate.loadFile(join(__dirname, '../../dist/index.html'), { hash: '/wallpaper' });
  }
  await painted;
  // 首帧已经有了，再让窗口显示一小会儿，避免刚挂上去时桌面上出现一块空白。
  candidate.showInactive();
  await new Promise((resolve) => setTimeout(resolve, 60));
  try {
    const handle = nativeHandle(candidate);
    native.wallpaperAttach(handle);
    native.wallpaperResize(handle, nativeRect.x, nativeRect.y, nativeRect.width, nativeRect.height);
    surface.attached = true;
    log.info(
      '[Wallpaper] 已挂载到显示器 ' +
        surface.displayId +
        '（屏幕 ' +
        display.size.width +
        'x' +
        display.size.height +
        '，窗口 ' +
        bounds.width +
        'x' +
        bounds.height +
        '）',
    );
    surface.monitor = new native.WallpaperMonitor(handle, 500, (state) => {
      // 只认明确的 false：原生模块版本不一致时字段可能读成 undefined，
      // 用 !state.alive 会把它当成窗口没了，进而每 5 秒重建一次。
      if (state.alive === false) {
        onLost();
        return;
      }
      surface.coverage = state.coverage;
      surface.lyricCoverage = state.lyricCoverage ?? 0;
      onOcclusion({
        displayId: surface.displayId,
        coverage: state.coverage,
        // 旧原生模块没有这个字段时按 0 处理：宁可满帧，也不要误降帧。
        lyricCoverage: state.lyricCoverage ?? 0,
      });
    });
  } catch (error) {
    log.error('[Wallpaper] 挂载失败:', error);
    candidate.destroy();
    return null;
  }
  return surface;
};

/**
 * 按记录的屏幕矩形把窗口重新摆一遍。挂载后它是桌面宿主的子窗口，而 Chromium
 * 在窗口重新显示时仍会按屏幕坐标恢复自己那份 bounds，落点就会整整偏一个宿主
 * 原点，所以每次把它显示出来之后都要按父窗口坐标重新摆一次。
 */
export const placeWallpaperSurface = (surface: WallpaperSurface): void => {
  if (!surface.attached || surface.win.isDestroyed()) return;
  const native = getNativeWallpaper();
  if (!native) return;
  try {
    const { x, y, width, height } = surface.nativeRect;
    native.wallpaperResize(nativeHandle(surface.win), x, y, width, height);
  } catch (error) {
    log.warn('[Wallpaper] 摆放窗口失败:', error);
  }
};

/**
 * 显示器矩形变化（任务栏显示/隐藏、改分辨率、改缩放）后按新矩形摆一遍。
 * 窗口只是换尺寸，内容不重建，歌词和播放不会中断。
 */
export const resizeWallpaperSurface = (surface: WallpaperSurface, display: Display): void => {
  if (surface.win.isDestroyed()) return;
  const bounds = displayBounds(display);
  surface.rect = bounds;
  surface.nativeRect = displayPhysicalBounds(display);
  surface.scaleFactor = scaleOf(display);
  // 换分辨率/缩放/任务栏显隐之后，「相对窗口」的布局没有变，渲染层不会主动重报，
  // 旧的歌词屏幕矩形就不再成立：先作废，让渲染层按新几何再报一次。
  surface.lyricRect = null;
  surface.monitor?.setLyricRect(0, 0, 0, 0);
  if (!surface.attached) {
    // 还没挂到桌面层时它就是普通顶层窗口，交给 Electron 摆。
    surface.win.setBounds(bounds);
    return;
  }
  // 挂载之后它是桌面宿主的子窗口：Electron 的 setBounds 会把屏幕坐标直接当
  // 子窗口坐标用，落点整整偏一个宿主原点（还会被再夹一次），所以只走原生。
  placeWallpaperSurface(surface);
};

export const destroyWallpaperSurface = (surface: WallpaperSurface): void => {
  try {
    surface.monitor?.stop();
  } catch (error) {
    log.warn('[Wallpaper] 停止遮挡监控失败:', error);
  }
  surface.monitor = null;
  const native = getNativeWallpaper();
  if (native && surface.attached) {
    try {
      native.wallpaperDetach(nativeHandle(surface.win));
    } catch (error) {
      log.warn('[Wallpaper] 解挂失败:', error);
    }
    surface.attached = false;
  }
  if (!surface.win.isDestroyed()) surface.win.destroy();
};

/** 按显示器 id 找当前显示器；找不到或已被拔掉时回落到主屏。 */
export const resolveDisplays = (displayIds: string[]): Display[] => {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const wanted = displayIds
    .map((id) => all.find((display) => String(display.id) === id))
    .filter((display): display is Display => Boolean(display));
  if (wanted.length) return wanted;
  return [primary];
};
