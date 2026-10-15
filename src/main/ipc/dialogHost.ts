import {
  BrowserWindow,
  dialog,
  type MessageBoxOptions,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';
import log from '../logger';

/** 置前窗口的等待上限，超时就直接放行弹窗。 */
const SURFACE_TIMEOUT_MS = 1500;

const findVisibleWindow = () =>
  BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && win.isVisible());

/**
 * 原生对话框一律**不挂父窗口**，这是有意的。
 *
 * 带父窗口的 `dialog.show*Dialog(win, options)` 会把对话框建到与宿主不同的线程上。
 * 跨线程的 Win32 模态框会被正常创建、正常布局，却**永远不会显示**，同时把宿主
 * 窗口禁用掉 —— 表现为「弹窗弹不出来 + 应用整体卡死」，而且往对话框投 WM_CLOSE
 * 也无人处理（它的消息循环不在那个线程上跑），只能杀进程。
 *
 * 实测现场（插件「简单本地音乐」添加音乐文件夹，主窗口在前台、未最小化）：
 *   #32770 「选择音乐文件夹」   可见=False  可用=True   线程=27216
 *   Chrome_WidgetWin_1 主窗口  可见=True   可用=False  线程=26852
 *
 * 不挂父窗口时对话框是独立顶层窗口，与任何窗口的可见性、线程都无关。代价是它
 * 不再相对主窗口模态，所以先把一个可见窗口带到前台，保证用户知道是哪个应用在问。
 */
const surfaceWindow = async () => {
  // 已经有可见窗口时不惊动窗口状态机：showMainWindow 会取消待执行的后台关闭、
  // 切换窗口模式，插件自己触发的弹窗不该顺带改这些。
  const visible = findVisibleWindow();
  if (visible && !visible.isMinimized()) return;
  // 动态导入：window/index 会经 plugins/ 回到本模块（process.ts 用到消息框），
  // 静态导入会形成 window → plugins → process → dialogHost → window 的环。
  const { showMainWindow } = await import('../window');
  // 超时兜底：showMainWindow() 会 await mainWindowStartup，而后者只在「渲染进程
  // 挂载」或「窗口关闭」时 resolve —— 渲染进程起不来时会永久挂起，把「弹窗卡死」
  // 换个形式请回来。置前只是锦上添花（对话框本身不依赖任何窗口），超时即放行。
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, SURFACE_TIMEOUT_MS);
  });
  try {
    await Promise.race([
      showMainWindow().catch((err) => log.warn('[DialogHost] 置前窗口失败', err)),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (timedOut) log.warn(`[DialogHost] 置前超过 ${SURFACE_TIMEOUT_MS}ms，仍继续显示对话框`);
  if (!findVisibleWindow()) {
    log.warn('[DialogHost] 没有可见窗口，原生对话框仍会以独立窗口显示');
  }
};

const runDetached = async <T>(show: () => Promise<T>): Promise<T> => {
  await surfaceWindow();
  return show();
};

const APP_LABEL = 'EchoMusic';

/**
 * 独立窗口的对话框没有模态归属，用户看不出是哪个应用在问。统一在标题前带上
 * 应用名；标题里已经有就不重复加（设置备份那几条自带 EchoMusic）。
 *
 * 放在这里而不是逐个调用点，是为了以后新增对话框不会再退回裸标题。
 */
const withAppLabel = <T extends { title?: string }>(options: T): T => {
  const { title } = options;
  if (typeof title !== 'string' || !title.trim() || title.includes(APP_LABEL)) return options;
  return { ...options, title: `${APP_LABEL} · ${title}` };
};

/** 文件选择对话框（不挂父窗口）。 */
export const showOpenDialogSafely = (
  options: OpenDialogOptions,
): Promise<Electron.OpenDialogReturnValue> =>
  runDetached(() => dialog.showOpenDialog(withAppLabel(options)));

/** 文件保存对话框（不挂父窗口）。 */
export const showSaveDialogSafely = (
  options: SaveDialogOptions,
): Promise<Electron.SaveDialogReturnValue> =>
  runDetached(() => dialog.showSaveDialog(withAppLabel(options)));

/** 消息框（不挂父窗口）。 */
export const showMessageBoxSafely = (
  options: MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> =>
  runDetached(() => dialog.showMessageBox(withAppLabel(options)));
