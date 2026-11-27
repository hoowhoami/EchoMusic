/**
 * 桌面壁纸：开关注册、显示器编排、省电策略与 IPC。
 *
 * 与桌面歌词互斥：打开壁纸会关掉桌面歌词，避免两套歌词同时抢桌面。
 */
import { app, powerMonitor, screen, type Display, type IpcMainInvokeEvent } from 'electron';
import { ipcRegistry } from '../ipc/registry';
import { getMainWindow } from '../window';
import { getMainAppSettings, setMainAppSetting } from '../storage/settings';
import { setDesktopLyricExclusionHook, updateDesktopLyricSettings } from '../desktopLyric';
import { getNowPlayingSnapshot, onNowPlayingChange } from '../nowPlaying';
import { getNativeWallpaper, isExclusiveFullscreenActive } from '../native/platform';
import {
  createWallpaperSurface,
  destroyWallpaperSurface,
  placeWallpaperSurface,
  resizeWallpaperSurface,
  resyncWallpaperSurface,
  resolveDisplays,
  surfaceRefreshRate,
  surfaceMatchesDisplay,
  type WallpaperOcclusionEvent,
  type WallpaperSurface,
} from './window';
import { resolveWallpaperFrame, type WallpaperFramePolicy } from './policy';
import {
  DEFAULT_WALLPAPER_SETTINGS,
  frameRateOf,
  occludedFpsOf,
  normalizeWallpaperSettings,
  reconcileFrameRates,
  pickDisplayIds,
  type WallpaperDisplay,
  type WallpaperLyricRect,
  type WallpaperSettings,
  type WallpaperState,
} from '../../shared/wallpaper';
import log from '../logger';

const surfaces = new Map<string, WallpaperSurface>();
let enabled = false;
let quitting = false;
let settings: WallpaperSettings = { ...DEFAULT_WALLPAPER_SETTINGS };
let settingsLoaded = false;
let lastPolicy: WallpaperFramePolicy | null = null;
// 系统睡眠期间不绘制：这里自己藏窗口，别让 hide 监听把它又显示回来。
let suspended = false;
let busy: Promise<void> | null = null;
let disposeNowPlaying: (() => void) | null = null;

const loadSettings = () => {
  if (settingsLoaded) return;
  settingsLoaded = true;
  const saved = getMainAppSettings();
  enabled = saved.wallpaperEnabled === true;
  settings = normalizeWallpaperSettings(saved.wallpaper);
  // Windows 上的 Display.id 会随缩放、重挂、驱动更新、重启换号。名字里留着的旧号一旦全部失效，
  // 设置页会把每块屏都判成「关」，而壁纸其实回落到主屏还在画 —— 先收敛到现存的屏幕上。
  const displayIds = pruneDisplayIds(settings.displayIds);
  if (displayIds.join(',') !== settings.displayIds.join(',')) {
    settings = { ...settings, displayIds };
    setMainAppSetting('wallpaper', settings);
  }
};

/** 串行化开关/重建，避免连点设置时同时创建多套窗口。 */
const runExclusive = <T>(task: () => Promise<T>): Promise<T> => {
  const next = (busy ?? Promise.resolve()).then(task, task);
  busy = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
};

// 显示器列表只在 display-* 事件里失效：state() 是热路径（播放中每次策略重算都会走），
// 每次都调 getAllDisplays() 是白花的主进程调用。
let displayCache: WallpaperDisplay[] | null = null;

const invalidateDisplayCache = () => {
  displayCache = null;
};

/**
 * 把每块屏的实时刷新率写回缓存。
 *
 * 缓存只在 display-* 事件里失效，但在系统设置里改刷新率并不一定触发事件（虚拟显示器尤其如此）：
 * 这样设置页会一直显示改之前的 144Hz，滑杆上限也按 144 放行，而真正生效的帧率被实时值压到 60。
 */
const refreshDisplayRates = (): void => {
  if (!displayCache) return;
  for (const display of screen.getAllDisplays()) {
    const entry = displayCache.find((item) => item.id === String(display.id));
    const rate = Number.isFinite(display.displayFrequency) ? display.displayFrequency : 0;
    if (entry && rate > 0 && entry.refreshRate !== rate) entry.refreshRate = rate;
  }
};

/**
 * 存下来的每屏帧率按「真实存在的屏 + 这块屏的实时刷新率」收敛一遍，变了就落盘。
 * 返回是否改过设置（改过就要重播状态，设置页的滑杆跟着回落）。
 */
const reconcileFrameRatesInto = (): boolean => {
  const { rates, changed } = reconcileFrameRates(settings.frameRates, listDisplays());
  if (!changed) return false;
  settings = { ...settings, frameRates: rates };
  setMainAppSetting('wallpaper', settings);
  return true;
};

const listDisplays = (): WallpaperDisplay[] => {
  if (displayCache) return displayCache;
  const primary = screen.getPrimaryDisplay();
  displayCache = screen.getAllDisplays().map((display) => ({
    id: String(display.id),
    label: display.label || `显示器 ${display.id}`,
    width: display.size.width,
    height: display.size.height,
    scaleFactor: display.scaleFactor,
    // 设置页按屏显示「档位高于屏幕刷新率」的提示，必须拿到真实刷新率。
    refreshRate: Number.isFinite(display.displayFrequency) ? display.displayFrequency : 0,
    primary: display.id === primary.id,
  }));
  return displayCache;
};

/**
 * 把持久化的屏幕 id 收敛到当前真实存在的屏幕上（空集回落主屏）。
 *
 * 收敛到一处：读配置、改配置、插拔屏幕三条路径都过一遍，否则名单会越攒越多，
 * 界面上勾不上的屏幕和主进程还在画的屏幕就对不上了。
 */
const pruneDisplayIds = (ids: readonly string[]): string[] =>
  pickDisplayIds(
    ids,
    listDisplays().map((display) => display.id),
    String(screen.getPrimaryDisplay().id),
  );

const activeDisplayIds = (): string[] => Array.from(surfaces.keys());

/** 状态与采样用哪块屏作代表：取第一个还活着的壁纸窗口。 */
const representative = (): WallpaperSurface | null => {
  for (const surface of surfaces.values()) {
    if (!surface.win.isDestroyed()) return surface;
  }
  return null;
};

/** 每块屏现在实际被限成多少帧：设置页按屏显示「当前」，别拿代表屏的数糊弄。 */
const activeFrameRates = (): Record<string, number> => {
  const rates: Record<string, number> = {};
  for (const [id, surface] of surfaces) {
    if (surface.win.isDestroyed()) continue;
    rates[id] = surface.policy?.frameRate ?? 0;
  }
  return rates;
};

/** 0 帧到底是被窗口挡住、全屏还是暂停播放：只报「暂停」用户分不清，也修不了。 */
const activeReasons = (): Record<string, string> => {
  const reasons: Record<string, string> = {};
  for (const [id, surface] of surfaces) {
    if (surface.win.isDestroyed()) continue;
    reasons[id] = surface.policy?.reason ?? '';
  }
  return reasons;
};

const state = (): WallpaperState => {
  const surface = representative();
  return {
    enabled,
    supported: getNativeWallpaper() !== null,
    attached: surfaces.size > 0,
    activeDisplayIds: activeDisplayIds(),
    // 每块屏各算各的档位，这里报第一块屏的状态给设置页展示。
    coverage: surface?.coverage ?? 0,
    frameRate: surface?.policy?.frameRate ?? lastPolicy?.frameRate ?? 0,
    activeFrameRates: activeFrameRates(),
    activeReasons: activeReasons(),
    reason: surface?.policy?.reason ?? lastPolicy?.reason ?? 'disabled',
    displays: listDisplays(),
    settings,
  };
};

/**
 * 单块屏自己的状态。壁纸窗口只能按自己那块屏的档位决定冻结与降帧：
 * 之前所有窗口共用「代表屏」那份快照，多屏时副屏会照主屏的档位渲染 ——
 * 主屏被判 covered/occluded，副屏自己整块被盖住也照样全速跑。
 */
const surfaceState = (surface: WallpaperSurface): WallpaperState => ({
  ...state(),
  coverage: surface.coverage,
  frameRate: surface.policy?.frameRate ?? lastPolicy?.frameRate ?? 0,
  reason: surface.policy?.reason ?? lastPolicy?.reason ?? 'disabled',
});

const broadcastState = () => {
  const main = getMainWindow();
  if (main && !main.isDestroyed()) main.webContents.send('wallpaper:state', state());
  for (const surface of surfaces.values()) {
    if (surface.win.isDestroyed()) continue;
    surface.win.webContents.send('wallpaper:state', surfaceState(surface));
  }
};

const isPlayingNow = (): boolean => {
  const snapshot = getNowPlayingSnapshot() as {
    playback?: { isPlaying?: boolean };
    isPlaying?: boolean;
  } | null;
  return Boolean(snapshot?.playback?.isPlaying ?? snapshot?.isPlaying);
};

/** 应用省电策略：每块屏各算自己的档位，状态没变就不重复下发。 */
const applyPolicy = () => {
  let changed = false;
  if (!surfaces.size) {
    lastPolicy = {
      frameRate: 0,
      visible: false,
      reason: !enabled ? 'disabled' : fullscreenSuppressed ? 'fullscreen' : 'detached',
    };
    return;
  }
  // 先把「实时刷新率」和「存下来的帧率」对齐：设定值不能长期高于这块屏真能给的上限。
  refreshDisplayRates();
  if (reconcileFrameRatesInto()) changed = true;
  const playing = isPlayingNow();
  // 档位只是上限：超过这块屏的刷新率就是在白唤醒合成器（240 档配 144Hz 屏，
  // 每帧都要先等一个 4ms 定时器再要帧），按屏幕刷新率再压一次。
  const capByRefresh = (fps: number, surface: WallpaperSurface) => {
    const frequency = surfaceRefreshRate(surface);
    return frequency > 0 ? Math.min(fps, frequency) : fps;
  };
  for (const surface of surfaces.values()) {
    if (surface.win.isDestroyed()) continue;
    // 帧率按屏取：同一个数摆到刷新率不同的屏上，高出来的那部分就纯空烧。
    // 省电档跟着设置值走（20%），不再单独配一档。
    const playingFps = capByRefresh(frameRateOf(settings, surface.displayId), surface);
    // 一块屏被挡住、被全屏，不代表另一块屏也要跟着降帧：各用各的状态算。
    const policy = resolveWallpaperFrame({
      enabled,
      attached: surface.attached,
      playing,
      coverage: surface.coverage,
      lyricCoverage: surface.lyricCoverage,
      lyricRegionKnown: surface.lyricRect !== null,
      pauseBehavior: settings.pauseBehavior,
      playingFps,
      occludedFps: capByRefresh(occludedFpsOf(playingFps), surface),
      // 带上上一轮的档位：冻结/降帧的退出阈值比进入阈值低（滞回），
      // 否则窗口压在阈值上动一下就会冻结→解冻→冻结地抖。
      previousReason: surface.policy?.reason,
    });
    surface.policy = policy;
    // 逐个窗口比对「已经下发过的策略」：新建的窗口是在上一轮之后才出现的，
    // 不比对自己那份就会一直停在创建时的可见状态。
    const applied = surface.applied;
    if (
      applied &&
      applied.frameRate === policy.frameRate &&
      applied.visible === policy.visible &&
      applied.reason === policy.reason
    ) {
      continue;
    }
    changed = true;
    surface.applied = {
      frameRate: policy.frameRate,
      visible: policy.visible,
      reason: policy.reason,
    };
    try {
      // setFrameRate() 只对离屏渲染生效，对挂在桌面层的窗口完全不起作用；
      // 帧预算改由渲染层的 setRenderFrameRate() 执行（见 utils/frameBudget.ts）。
      surface.win.webContents.setBackgroundThrottling(!policy.visible);
    } catch (error) {
      log.warn('[Wallpaper] 设置帧率失败:', error);
    }
    // 隐藏的窗口 Chromium 不再合成，比降到 0fps 更省。
    if (policy.visible && !surface.win.isVisible()) {
      surface.win.showInactive();
      // 重新显示时 Chromium 会按屏幕坐标恢复 bounds，子窗口会偏一个宿主原点。
      placeWallpaperSurface(surface);
    }
    if (!policy.visible) {
      // 隐藏之后 Chromium 认页面为 hidden，合成与 rAF 才会真停。
      // 注意：隐藏期间不能再调 placeWallpaperSurface —— 原生摆放带 SWP_SHOWWINDOW，
      // 会把窗口在 Win32 层偷偷显示回来，而 Chromium 仍当它隐藏，桌面上就留一块空壳。
      if (surface.win.isVisible()) surface.win.hide();
    }
  }
  // lastPolicy 只是「代表屏」那份：多屏时用它给设置页兜底展示，真正的每屏策略看 surface.policy。
  const nextLast = representative()?.policy ?? {
    frameRate: 0,
    visible: false,
    reason: enabled ? 'detached' : 'disabled',
  };
  if (
    !lastPolicy ||
    lastPolicy.frameRate !== nextLast.frameRate ||
    lastPolicy.visible !== nextLast.visible ||
    lastPolicy.reason !== nextLast.reason
  ) {
    changed = true;
  }
  lastPolicy = nextLast;
  // 播放进度每 120ms 一跳都会走到这里：档位没变就不广播，
  // 否则设置页与每个壁纸窗口都被约 8Hz 的状态包拖着重渲染。
  if (changed) broadcastState();
};

/**
 * 独占全屏（游戏、演示模式）：桌面层本身就不可见，直接把壁纸窗口销毁，
 * 比隐藏更省——连那个渲染进程都不留。退出全屏以后再重建。
 *
 * 判定不需要窗口句柄（系统通知状态），所以窗口销毁期间照样能问出「该不该回来」，
 * 这里定时轮询，进入/退出各处理一次。
 */
let fullscreenSuppressed = false;
let fullscreenTimer: ReturnType<typeof setInterval> | null = null;
const FULLSCREEN_POLL_MS = 2000;

const syncFullscreenSuppression = () => {
  if (!enabled || quitting) return;
  const active = isExclusiveFullscreenActive();
  if (active === fullscreenSuppressed) return;
  fullscreenSuppressed = active;
  log.info('[Wallpaper] 独占全屏', active ? '开始，销毁壁纸窗口' : '结束，重建壁纸窗口');
  if (active) {
    destroyAll();
    lastPolicy = { frameRate: 0, visible: false, reason: 'fullscreen' };
    broadcastState();
    return;
  }
  void runExclusive(rebuild).catch((error) => log.error('[Wallpaper] 退出全屏后重建失败:', error));
};

const startFullscreenWatch = () => {
  if (fullscreenTimer !== null) return;
  syncFullscreenSuppression();
  fullscreenTimer = setInterval(syncFullscreenSuppression, FULLSCREEN_POLL_MS);
};

const stopFullscreenWatch = () => {
  if (fullscreenTimer !== null) clearInterval(fullscreenTimer);
  fullscreenTimer = null;
  fullscreenSuppressed = false;
};

/** 某块屏的遮挡情况变了：只更新那块屏自己的状态，再统一重算。 */
const handleOcclusion = (event: WallpaperOcclusionEvent) => {
  const surface = surfaces.get(event.displayId);
  if (!surface) return;
  surface.coverage = event.coverage;
  surface.lyricCoverage = event.lyricCoverage;
  applyPolicy();
};

/**
 * 桌面层被 Explorer 重建（比如「显示桌面」、切换虚拟桌面、Explorer 重启）时，
 * 挂在它下面的窗口会被一起销毁，或者被系统藏起来。这里兜住这两种情况，
 * 否则 surfaces 里留着一个死窗口，重建时又因为「这个显示器已经有了」被跳过，
 * 壁纸就再也回不来了。
 */
const watchSurface = (surface: WallpaperSurface) => {
  const id = surface.displayId;
  surface.win.on('closed', () => {
    // 主动销毁时 surfaces 里已经不是它了，不用管。
    if (surfaces.get(id) !== surface) return;
    surfaces.delete(id);
    // 睡眠时是主动销毁的，别在现场重建，等唤醒后统一建。
    if (!enabled || quitting || suspended) return;
    void runExclusive(rebuild).catch((error) => log.error('[Wallpaper] 重建失败:', error));
  });
  surface.win.on('hide', () => {
    if (surface.win.isDestroyed()) return;
    if (!surface.policy?.visible) return;
    // 睡眠时是自己藏的，不是系统把桌面层收起来了：别把 hide 又撤销掉。
    if (suspended) return;
    // 不该隐藏却隐藏了（系统收起了桌面层），重新显示并按宿主坐标摆正。
    surface.win.showInactive();
    placeWallpaperSurface(surface);
  });
};

/** 短时间内反复被销毁说明重建也不会好（例如桌面层一直被顶着），先停下来。 */
const lossGuard = new Map<string, { count: number; at: number }>();
const MAX_LOSS_REBUILDS = 3;
const LOSS_WINDOW_MS = 60_000;

/**
 * 桌面层被 Explorer 重建时（「显示桌面」、切换虚拟桌面、Explorer 重启），挂在
 * 它下面的子窗口会被系统直接销毁，Electron 侧可能还当它活着，导致重建时被
 * 「这个显示器已经有了」跳过。这里把它从表里摘掉并重建一次。
 */
const handleSurfaceLost = (displayId: string) => {
  const surface = surfaces.get(displayId);
  if (!surface) return;
  surfaces.delete(displayId);
  // 窗口可能还活着（Explorer 只是把它藏了起来）：一并销毁。只摘记录不销毁的话，
  // 会留下一个没人管、也不在 surfaces 里的僵尸窗口。
  destroyWallpaperSurface(surface);
  // 「窗口没了」只有在它本来就该开着的时候才值得重建：开关被关掉，或者这块屏
  // 已经从设置里取消勾选，就只是把这条记录摘掉，不重启。
  if (!enabled || quitting) return;
  const stillWanted = resolveDisplays(settings.displayIds).some(
    (display) => String(display.id) === displayId,
  );
  if (!stillWanted) {
    log.info('[Wallpaper] 屏幕已不再启用壁纸，跳过重建', displayId);
    return;
  }
  const now = Date.now();
  const recent = lossGuard.get(displayId);
  const tries = recent && now - recent.at < LOSS_WINDOW_MS ? recent.count + 1 : 1;
  lossGuard.set(displayId, { count: tries, at: now });
  if (tries > MAX_LOSS_REBUILDS) {
    log.warn('[Wallpaper] 桌面层窗口反复消失，暂停自动重建', displayId);
    return;
  }
  log.info('[Wallpaper] 桌面层窗口已被系统销毁，重建', displayId);
  void runExclusive(rebuild).catch((error) => log.error('[Wallpaper] 重建失败:', error));
};

// 桌面层（Progman/WorkerW）没就绪时挂载会失败——典型场景是 Explorer 刚重启。
// 设置页承诺「稍后会自动重试」，这里按指数退避重试，和 lossGuard 一起兜住反复失败。
const mountRetries = new Map<string, { attempts: number; timer: ReturnType<typeof setTimeout> }>();
const MAX_MOUNT_RETRIES = 5;
const MOUNT_RETRY_BASE_MS = 1_000;
const MOUNT_RETRY_MAX_MS = 30_000;

const clearMountRetry = (displayId: string) => {
  const retry = mountRetries.get(displayId);
  if (!retry) return;
  clearTimeout(retry.timer);
  mountRetries.delete(displayId);
};

const scheduleMountRetry = (displayId: string) => {
  if (!enabled || quitting) return;
  const previous = mountRetries.get(displayId);
  const attempts = (previous?.attempts ?? 0) + 1;
  if (previous) clearTimeout(previous.timer);
  if (attempts > MAX_MOUNT_RETRIES) {
    mountRetries.delete(displayId);
    log.warn('[Wallpaper] 桌面层多次未就绪，暂停自动重试', displayId);
    return;
  }
  const delay = Math.min(MOUNT_RETRY_BASE_MS * 2 ** (attempts - 1), MOUNT_RETRY_MAX_MS);
  log.info('[Wallpaper] 桌面层还没准备好，' + delay + 'ms 后重试挂载', displayId);
  const timer = setTimeout(() => {
    mountRetries.delete(displayId);
    if (!enabled || quitting) return;
    void runExclusive(rebuild).catch((error) => log.error('[Wallpaper] 重试挂载失败:', error));
  }, delay);
  mountRetries.set(displayId, { attempts, timer });
};

const clearMountRetries = () => {
  for (const retry of mountRetries.values()) clearTimeout(retry.timer);
  mountRetries.clear();
};

const createSurfacesFor = async (displays: Display[]) => {
  const targets: Display[] = [];
  for (const display of displays) {
    const id = String(display.id);
    if (surfaces.has(id)) {
      const current = surfaces.get(id);
      // 顺手清掉已经销毁、但还留在表里的窗口。
      if (current && !current.win.isDestroyed()) continue;
      surfaces.delete(id);
    }
    targets.push(display);
  }
  // 每个窗口都要单独加载一遍前端页面，串行会把启动时间乘以屏幕块数，这里并行建。
  const created = await Promise.all(
    targets.map((display) =>
      createWallpaperSurface(display, handleOcclusion, () => handleSurfaceLost(String(display.id))),
    ),
  );
  for (const [index, surface] of created.entries()) {
    if (!surface) {
      const displayId = targets[index] ? String(targets[index].id) : '';
      if (displayId) scheduleMountRetry(displayId);
      continue;
    }
    clearMountRetry(surface.displayId);
    surfaces.set(surface.displayId, surface);
    watchSurface(surface);
  }
};

const destroyAll = () => {
  clearMountRetries();
  for (const surface of surfaces.values()) destroyWallpaperSurface(surface);
  surfaces.clear();
  lastPolicy = null;
};

const rebuild = async () => {
  if (!enabled || quitting) {
    destroyAll();
    broadcastState();
    return;
  }
  // 独占全屏期间不建窗口：退出全屏时轮询会再调一次重建。
  if (fullscreenSuppressed) {
    destroyAll();
    lastPolicy = { frameRate: 0, visible: false, reason: 'fullscreen' };
    broadcastState();
    return;
  }
  // 只增删差集：显示器属性变化（比如任务栏隐藏）不该把已经画着的窗口拆了重来。
  const wanted = resolveDisplays(settings.displayIds);
  const keep = new Set(wanted.map((display) => String(display.id)));
  for (const [id, surface] of Array.from(surfaces.entries())) {
    if (keep.has(id)) continue;
    destroyWallpaperSurface(surface);
    surfaces.delete(id);
  }
  await createSurfacesFor(wanted);
  applyPolicy();
  broadcastState();
  // 刚建出来的窗口是按「创建那一刻」的屏幕矩形挂的；插拔屏幕时那份矩形可能是旧的，
  // 建完再按最新几何复摆一遍，避免窗口留在主屏上。
  scheduleResync();
};

/**
 * 按最新显示器几何把所有壁纸窗口重新校准一遍。
 * 插拔屏幕、改缩放、任务栏显隐之后系统报的矩形常常滞后，只信创建那一刻就会摆错屏。
 */
const resyncSurfaces = () => {
  if (!enabled || quitting) return;
  let changed = false;
  for (const surface of surfaces.values()) {
    if (surface.win.isDestroyed()) continue;
    try {
      if (resyncWallpaperSurface(surface)) changed = true;
    } catch (error) {
      log.warn('[Wallpaper] 重新校准窗口位置失败:', error);
    }
  }
  if (changed) broadcastState();
};

/**
 * 排几次复摆：显示器事件本身会连着来（系统先报新屏、再报工作区变化），
 * 只在事件当下摆一次仍可能拿到旧矩形，所以按 0 / 300 / 1000ms 各来一遍。
 */
const scheduleResync = () => {
  for (const delay of [0, 300, 1000]) {
    const timer = setTimeout(() => {
      invalidateDisplayCache();
      resyncSurfaces();
    }, delay);
    timer.unref?.();
  }
};

// 与桌面歌词互斥：两套歌词同时占桌面没有意义，也会多一份渲染。
const releaseDesktopLyric = async () => {
  try {
    await updateDesktopLyricSettings({ enabled: false });
  } catch (error) {
    log.warn('[Wallpaper] 关闭桌面歌词失败:', error);
  }
};

export const setWallpaperEnabled = (value: boolean): Promise<void> => {
  loadSettings();
  // 非 Windows（或原生模块没编译出来）永远建不出窗口：直接拒绝启用，
  // 否则会把 enabled=true 写进设置，下次启动再失败一次，界面还显示「已开启」。
  if (value && getNativeWallpaper() === null) {
    log.warn('[Wallpaper] 当前平台不支持桌面壁纸，忽略启用请求');
    return Promise.resolve();
  }
  if (enabled === value) {
    if (!value) return Promise.resolve();
    startFullscreenWatch();
    return runExclusive(async () => {
      await releaseDesktopLyric();
      // 启动时开关已经是开的：这时还没有任何窗口，必须真的建一次。
      if (surfaces.size === 0) await rebuild();
    });
  }
  // 开关状态先落地并广播：建窗口、挂载要几百毫秒，界面不该等它。
  enabled = value;
  lossGuard.clear();
  setMainAppSetting('wallpaperEnabled', value);
  broadcastState();
  if (value) startFullscreenWatch();
  else stopFullscreenWatch();
  return runExclusive(async () => {
    if (value) await releaseDesktopLyric();
    await rebuild();
  });
};

// 设置一律同步生效：建窗口、挂载要几百毫秒，界面不该等它。
export const updateWallpaperSettings = (patch: Partial<WallpaperSettings>): WallpaperState => {
  // 改了设置说明用户又想看到壁纸了，把「反复消失」的计数清掉重来。
  lossGuard.clear();
  loadSettings();
  // texture 必须深合并：只改一个滑块时整体替换会把其余键重置成默认值。
  const next = normalizeWallpaperSettings({
    ...settings,
    ...patch,
    texture: { ...settings.texture, ...(patch.texture ?? {}) },
    // 同理：只改一块屏的帧率时，整体替换会把其它屏的帧率抹掉。
    frameRates: { ...settings.frameRates, ...(patch.frameRates ?? {}) },
  });
  // 界面传下来的名单里也可能夹着已拔掉的屏幕，落库前先收敛。
  const displayIds = pruneDisplayIds(next.displayIds);
  next.displayIds = displayIds;
  const displaysChanged = displayIds.join(',') !== settings.displayIds.join(',');
  settings = next;
  setMainAppSetting('wallpaper', next);
  if (!displaysChanged) {
    applyPolicy();
    broadcastState();
    return state();
  }
  broadcastState();
  // 增删屏幕要建/毁窗口，这一步放到后台队列，设置本身已经落地。
  if (enabled) {
    void runExclusive(rebuild).catch((error) => log.error('[Wallpaper] 切换屏幕失败:', error));
  }
  return state();
};

export const restoreWallpaper = (): void => {
  quitting = false;
  loadSettings();
  if (!enabled) return;
  void setWallpaperEnabled(true).catch((error) => log.error('[Wallpaper] 恢复失败:', error));
};

export const cleanupWallpaper = (): void => {
  quitting = true;
  clearMountRetries();
  stopFullscreenWatch();
  setDesktopLyricExclusionHook(null);
  disposeNowPlaying?.();
  disposeNowPlaying = null;
  destroyAll();
};

const isMainSender = (senderId: number): boolean => {
  const main = getMainWindow();
  return Boolean(main && !main.isDestroyed() && main.webContents.id === senderId);
};

const isTrustedSender = (event: IpcMainInvokeEvent): boolean =>
  // 壁纸窗口在挂载完成前就会来读状态，此时还不在 surfaces 里，只能按来源页面判断。
  isMainSender(event.sender.id) || event.sender.getURL().includes('/wallpaper');

export const registerWallpaperHandlers = (): void => {
  // 播放/暂停、换歌都要重算省电策略，否则壁纸会一直停在启动那一刻的档位。
  disposeNowPlaying?.();
  disposeNowPlaying = onNowPlayingChange(() => {
    if (enabled && surfaces.size) applyPolicy();
  });
  // 反向互斥：用户打开桌面歌词时，动态壁纸让位（壁纸占着桌面时两套歌词没有意义）。
  setDesktopLyricExclusionHook(async () => {
    if (!getMainAppSettings().wallpaperEnabled) return;
    await setWallpaperEnabled(false);
  });
  ipcRegistry.registerHandler('wallpaper:get-state', (event) => {
    if (!isTrustedSender(event)) throw new Error('Invalid wallpaper sender');
    loadSettings();
    return state();
  });
  ipcRegistry.registerHandler('wallpaper:set-enabled', (event, value: boolean) => {
    if (!isMainSender(event.sender.id)) throw new Error('Invalid wallpaper sender');
    if (typeof value !== 'boolean') throw new Error('Invalid wallpaper state');
    // 建窗口是后台任务，开关本身已经生效，这里不等它。
    void setWallpaperEnabled(value).catch((error) => log.error('[Wallpaper] 切换失败:', error));
    return state();
  });
  ipcRegistry.registerHandler(
    'wallpaper:set-settings',
    (event, value: Partial<WallpaperSettings>) => {
      if (!isMainSender(event.sender.id)) throw new Error('Invalid wallpaper sender');
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid wallpaper settings');
      }
      return updateWallpaperSettings(value);
    },
  );
  // 壁纸窗口上报「歌词区域」在屏幕上的位置：省电判定看的是这块地方有没有被盖住，
  // 而不是整块屏。挂载完成前也会先报一次，那时还找不到窗口，忽略即可。
  ipcRegistry.registerHandler('wallpaper:set-lyric-rect', (event, rect: WallpaperLyricRect) => {
    const surface = Array.from(surfaces.values()).find(
      (item) => !item.win.isDestroyed() && item.win.webContents.id === event.sender.id,
    );
    if (!surface) return null;
    if (!rect || typeof rect !== 'object') throw new Error('Invalid lyric rect');
    const dpr = Number(rect.dpr) > 0 ? Number(rect.dpr) : 1;
    const width = Math.round(Number(rect.width) * dpr);
    const height = Math.round(Number(rect.height) * dpr);
    // 渲染层给的是 CSS 像素（相对窗口左上角），换成屏幕物理像素再交给原生。
    // 宽高为 0 表示当前没有歌词区域：判定退回整块屏的覆盖率。
    surface.lyricRect =
      width > 0 && height > 0
        ? {
            // surface.nativeRect 是屏幕物理像素，渲染层给的是「窗口内 CSS 像素 × dpr」，
            // 两边同单位才能相加；混用会让副屏（DIP 原点不为 0）的遮挡区域整体偏移。
            x: Math.round(surface.nativeRect.x + Number(rect.left) * dpr),
            y: Math.round(surface.nativeRect.y + Number(rect.top) * dpr),
            width,
            height,
          }
        : null;
    surface.monitor?.setLyricRect(
      surface.lyricRect?.x ?? 0,
      surface.lyricRect?.y ?? 0,
      width,
      height,
    );
    return null;
  });
  // screen / powerMonitor 只能在 app ready 之后使用，注册时应用还没就绪。
  void app.whenReady().then(() => {
    // 显示器增删/缩放变化时按当前设置重挂一遍。
    const onChange = () => {
      invalidateDisplayCache();
      // 拔掉的屏幕要让出名单，插上的屏幕才能被勾上；收敛后落库，界面按同一份名单显示。
      const displayIds = pruneDisplayIds(settings.displayIds);
      if (displayIds.join(',') !== settings.displayIds.join(',')) {
        settings = { ...settings, displayIds };
        setMainAppSetting('wallpaper', settings);
      }
      if (!enabled) return;
      void runExclusive(rebuild).catch((error) => log.error('[Wallpaper] 重建失败:', error));
      // 新屏刚插上时报的矩形常常还是旧值（先落成主屏原点），重建完再复摆几次。
      scheduleResync();
    };
    screen.on('display-added', onChange);
    screen.on('display-removed', onChange);
    screen.on('display-metrics-changed', (_event, display) => {
      invalidateDisplayCache();
      if (!enabled) return;
      const surface = surfaces.get(String(display.id));
      // 任务栏显示/隐藏、换分辨率、改缩放都会触发，矩形没变就什么都不做。
      if (!surface || surfaceMatchesDisplay(surface, display)) return;
      resizeWallpaperSurface(surface, display);
      broadcastState();
      // 顺带把其余屏也校准一次：系统在改一块屏的几何时可能同时改了别的屏的工作区。
      scheduleResync();
    });
    // 睡眠时把桌面层销毁掉：挂着的窗口在睡眠期间没意义，也省一份渲染。
    // suspended 先置位，避免销毁触发 closed 回调时把窗口又建回来。
    powerMonitor.on('suspend', () => {
      suspended = true;
      destroyAll();
      broadcastState();
    });
    // 唤醒后按当前设置整批重建，并重新判断遮挡。
    powerMonitor.on('resume', () => {
      suspended = false;
      lastPolicy = null;
      if (!enabled || quitting) return;
      void runExclusive(rebuild).catch((error) => log.error('[Wallpaper] 唤醒后重建失败:', error));
    });
  });
};
