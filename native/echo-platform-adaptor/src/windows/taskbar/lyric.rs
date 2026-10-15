//! 任务栏子窗口与布局监听。UIA 在独立 COM 线程执行，变化合并后才通知 Electron。
//! 参考 SPlayer-Next 的 Win10/Win11 策略；本模块使用 EchoMusic 自有生命周期与接口。
use napi::{
    bindgen_prelude::Function,
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue},
    Status,
};
use napi_derive::napi;
use std::{
    cell::Cell,
    ffi::c_void,
    sync::Mutex,
    sync::{
        atomic::{AtomicBool, AtomicI32, AtomicIsize, AtomicU32, Ordering},
        Arc,
    },
    thread,
    time::Instant,
};
use windows::{
    core::{implement, w, Ref},
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
        Graphics::{
            Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED},
            Gdi::{
                GetMonitorInfoW, MapWindowPoints, MonitorFromWindow, MONITORINFO,
                MONITOR_DEFAULTTONEAREST,
            },
        },
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_MULTITHREADED, SAFEARRAY,
            },
            LibraryLoader::GetModuleHandleW,
            Threading::GetCurrentThreadId,
        },
        UI::{
            Accessibility::{
                CUIAutomation, IUIAutomation, IUIAutomationElement,
                IUIAutomationStructureChangedEventHandler,
                IUIAutomationStructureChangedEventHandler_Impl, SetWinEventHook,
                StructureChangeType, TreeScope_Descendants, UnhookWinEvent, HWINEVENTHOOK,
            },
            HiDpi::GetDpiForWindow,
            WindowsAndMessaging::*,
        },
    },
};
use winreg::{
    enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE},
    RegKey,
};

static WORKER_LOCK: Mutex<()> = Mutex::new(());
const CHANGE: u32 = WM_APP + 41;
const TIMER: usize = 41;
/// 挂载中的任务栏句柄，供 JS 侧读取（SHELL_HWND 是工作线程的 thread_local，
/// JS 线程读不到，必须另有一份跨线程可见的副本）。
static MOUNTED_TASKBAR: AtomicIsize = AtomicIsize::new(0);

/// Explorer 重排任务栏后的探测冷却截止时刻。
///
/// 冷却期内不做同步 UIA 探测，避免与正在重排的 shell 互相等待 —— 这正是
/// AF-Media-Bar 在 Explorer 连续重排时观察到并规避的死锁。
static PROBE_COOLDOWN_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);
/// 冷却时长。需覆盖 Explorer 销毁 + 重建任务栏的整个窗口期。
const PROBE_COOLDOWN_MS: u64 = 1200;

fn probe_cooling_down() -> bool {
    match PROBE_COOLDOWN_UNTIL.lock() {
        Ok(guard) => guard.is_some_and(|until| Instant::now() < until),
        Err(_) => false,
    }
}

fn start_probe_cooldown() {
    if let Ok(mut guard) = PROBE_COOLDOWN_UNTIL.lock() {
        *guard = Some(Instant::now() + std::time::Duration::from_millis(PROBE_COOLDOWN_MS));
    }
}
thread_local! {
    static SHELL_PID: Cell<u32> = const { Cell::new(0) };
    static SHELL_HWND: Cell<isize> = const { Cell::new(0) };
    static CREATED: Cell<u32> = const { Cell::new(0) };
    static FOREGROUND_HWND: Cell<isize> = const { Cell::new(0) };
}
#[napi(object)]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TaskbarRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
#[napi(object)]
#[derive(Clone, Debug, PartialEq)]
pub struct TaskbarLyricLayout {
    pub left: TaskbarRect,
    pub right: TaskbarRect,
    pub scale_factor: f64,
    pub centered: bool,
    pub is_dark: bool,
    pub available: bool,
}
type Callback =
    ThreadsafeFunction<TaskbarLyricLayout, UnknownReturnValue, TaskbarLyricLayout, Status, false>;

/// 当前会话实际挂载到的任务栏窗口句柄（0 = 尚未成功挂载 / 任务栏当前不存在）。
///
/// 供 JS 区分两种「拿不到布局」：
///   · 句柄变了 ⇒ Explorer 重建了任务栏，native 侧会自动重新挂载，此时**不该**
///     销毁重建 Chromium 窗口，否则窗口重建又落在下一个重建空窗里，形成死循环；
///   · 句柄没变却长时间无响应 ⇒ 工作线程确实死了，才需要 JS 重建窗口。
#[napi]
pub fn taskbar_lyric_mounted_taskbar() -> i64 {
    MOUNTED_TASKBAR.load(Ordering::Acquire) as i64
}

/// 把歌词窗口提到 topmost 顶端。
///
/// 歌词嵌入任务栏后与任务栏在同一父子层级，绘制顺序由父窗口决定，本就不需要
/// 争抢 z-order —— 这正是选择子窗口方案的原因（顶层窗口方案需要常驻置顶线程，
/// 且仍会被快速设置这类 XAML 弹层盖住）。
///
/// 因此这里只在**尚未挂载**（仍是顶层窗口）时兜底提一次，避免窗口在
/// SetParent 之前的窗口期闪到任务栏之外。
fn raise_lyric(child: HWND) {
    unsafe {
        // GetAncestor(GA_PARENT) 才是真正的父窗口判断：对 WS_POPUP 窗口
        // GetParent 返回的是 owner。这里要的是「已挂载就别动」，挂载后
        // 父窗口一定是 Shell_TrayWnd，两者都能判对，但保持一致更稳妥。
        if GetAncestor(child, GA_PARENT).0 as isize != 0 {
            return;
        }
        // 歌词窗口属于 Electron 的 UI 线程，而这里可能从工作线程调用。
        // 不加 SWP_ASYNCWINDOWPOS 时 SetWindowPos 会同步等目标线程处理，
        // 主进程一忙工作线程就被挂住；加上之后只投递请求，立即返回。
        let _ = SetWindowPos(
            child,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
        );
    }
}

/// 常驻置顶定时器的消息 id（与一次性布局用的 TIMER 区分，不会被 KillTimer 取消）。
/// SetTimer/KillTimer 收 usize，消息比对收 u32，两边各留一份常量。
/// 任务栏长期不可用时的低频重试间隔（快速重试耗尽后使用）。
const RETRY_IDLE_MS: u32 = 500;

#[napi]
pub struct TaskbarLyricSession {
    stopped: Arc<AtomicBool>,
    thread_id: Arc<AtomicU32>,
    width: Arc<AtomicI32>,
    restore: Arc<Mutex<Option<LegacyArea>>>,
    /// 歌词窗口句柄。解挂必须在 Electron 的 UI 线程上同步完成（见 `stop`）。
    child: usize,
}
#[napi]
impl TaskbarLyricSession {
    #[napi(
        constructor,
        ts_args_type = "handle: string, width: number, callback: (layout: TaskbarLyricLayout) => void"
    )]
    pub fn new(
        handle: String,
        width: i32,
        callback: Function<TaskbarLyricLayout, UnknownReturnValue>,
    ) -> napi::Result<Self> {
        let child = handle
            .parse::<usize>()
            .map_err(|_| napi::Error::from_reason("Invalid window handle"))?;
        if child == 0 || !unsafe { IsWindow(Some(HWND(child as *mut c_void))) }.as_bool() {
            return Err(napi::Error::from_reason(
                "Taskbar lyric window no longer exists",
            ));
        }
        let callback: Callback = callback
            .build_threadsafe_function::<TaskbarLyricLayout>()
            .build_callback(|ctx| Ok(ctx.value))?;
        // Install on Electron's UI thread, before the worker can SetParent.
        // A foreign shell parent can otherwise skip Electron's WM_DESTROY cleanup.
        unsafe { super::window_lifecycle::install(HWND(child as *mut c_void))? };
        let session = Self {
            stopped: Arc::new(AtomicBool::new(false)),
            thread_id: Arc::new(AtomicU32::new(0)),
            width: Arc::new(AtomicI32::new(width.clamp(0, 1000))),
            restore: Arc::new(Mutex::new(None)),
            child,
        };
        let stopped = session.stopped.clone();
        let thread_id = session.thread_id.clone();
        let width = session.width.clone();
        let restore = session.restore.clone();
        thread::Builder::new()
            .name("echo-taskbar-lyric".into())
            .spawn(move || unsafe {
                run(child, stopped, thread_id, width, restore, callback);
            })
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        Ok(session)
    }
    #[napi]
    pub fn update(&self, width: i32) {
        self.width.store(width.clamp(0, 1000), Ordering::Release);
        let id = self.thread_id.load(Ordering::Acquire);
        if id != 0 {
            unsafe {
                let _ = PostThreadMessageW(id, CHANGE, WPARAM(2), LPARAM(0));
            }
        }
    }
    #[napi]
    pub fn stop(&self) {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        // 退出进程前先还原 Win10 的任务列表，不依赖 JS 环境等待工作线程。
        let restore = self.restore.lock().ok().and_then(|mut value| value.take());
        if let Some(area) = restore {
            unsafe {
                area.restore();
            }
        }
        // 必须在通知工作线程退出**之前**同步解挂，且必须在调用方的线程上做。
        //
        // 调用方是 Electron 的 UI 线程，也就是该 HWND 自己的线程：
        //   · 放在这里做，Chromium 窗口销毁时已在自己的进程与线程内，
        //     WM_DESTROY → WM_NCDESTROY 序列完整，不再有跨进程销毁；
        //   · 交给工作线程做要跨线程 SetParent，会同步等 Electron 处理；
        //   · 等到工作线程退出后再做就太晚了 —— JS 侧紧接着就
        //     `win.destroy()`，窗口在被解挂之前就跨进程销毁了。
        unsafe { detach(HWND(self.child as *mut c_void)) };
        let id = self.thread_id.load(Ordering::Acquire);
        if id != 0 {
            unsafe {
                let _ = PostThreadMessageW(id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
    }
}
impl Drop for TaskbarLyricSession {
    fn drop(&mut self) {
        self.stop();
    }
}

unsafe extern "system" fn shell_event(
    _: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    object: i32,
    _: i32,
    _: u32,
    _: u32,
) {
    if event == EVENT_SYSTEM_FOREGROUND {
        FOREGROUND_HWND.with(|value| value.set(hwnd.0 as isize));
        let _ = PostThreadMessageW(GetCurrentThreadId(), CHANGE, WPARAM(2), LPARAM(0));
        return;
    }
    // 截图工具结束选区时可能只释放鼠标捕获，不发生前台切换。
    if event == EVENT_SYSTEM_CAPTUREEND {
        let _ = PostThreadMessageW(GetCurrentThreadId(), CHANGE, WPARAM(2), LPARAM(0));
        return;
    }
    // 截图遮罩可能只隐藏 / 销毁而不切换前台；结束时仍需重新检查全屏状态。
    let foreground_ended = FOREGROUND_HWND.with(|value| value.get() == hwnd.0 as isize)
        && matches!(
            event,
            EVENT_OBJECT_HIDE
                | EVENT_OBJECT_DESTROY
                | EVENT_OBJECT_CLOAKED
                | EVENT_OBJECT_UNCLOAKED
        );
    let mut pid = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    // 销毁事件发生时 GetAncestor/GetWindowThreadProcessId 可能已失败，先比较已记录的 HWND。
    let shell_changed = SHELL_HWND.with(|value| value.get() == hwnd.0 as isize)
        || (SHELL_PID.with(|p| p.get() == pid && pid != 0)
            && SHELL_HWND.with(|value| value.get() == GetAncestor(hwnd, GA_ROOT).0 as isize));
    if shell_changed || (object == OBJID_WINDOW.0 && foreground_ended) {
        let _ = PostThreadMessageW(
            GetCurrentThreadId(),
            CHANGE,
            WPARAM(if foreground_ended { 2 } else { 0 }),
            LPARAM(0),
        );
    }
}
unsafe extern "system" fn watcher_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if CREATED.with(|value| value.get() == msg)
        || matches!(msg, WM_SETTINGCHANGE | WM_DISPLAYCHANGE | WM_THEMECHANGED)
    {
        let restart = CREATED.with(|value| value.get() == msg);
        // Explorer 打开快速设置 / 通知中心这类 XAML 弹层时会销毁并重建任务栏。
        // 该窗口期内任务栏的 UIA 树处于半成品状态，同步探测会被编组到 explorer 线程，
        // 而 explorer 此刻正忙着重排 —— 双方互相等待，工作线程就此卡死，JS 侧却仍
        // 以为会话有效，歌词窗口最终停在初始位置。冷却期内一律不做同步探测。
        start_probe_cooldown();
        let _ = PostThreadMessageW(
            GetCurrentThreadId(),
            CHANGE,
            WPARAM(usize::from(restart)),
            LPARAM(0),
        );
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}
struct Apartment;
struct ThreadIdGuard(Arc<AtomicU32>);
impl Drop for ThreadIdGuard {
    fn drop(&mut self) {
        self.0.store(0, Ordering::Release);
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
struct Watchers {
    window: HWND,
    hooks: Vec<HWINEVENTHOOK>,
}
impl Drop for Watchers {
    fn drop(&mut self) {
        unsafe {
            let _ = KillTimer(Some(self.window), TIMER);
            for hook in &self.hooks {
                let _ = UnhookWinEvent(*hook);
            }
            if !self.window.0.is_null() {
                let _ = DestroyWindow(self.window);
            }
        }
    }
}
#[derive(Clone, Copy)]
struct LegacyArea {
    list: usize,
    parent: usize,
    right_gap: i32,
    bottom_gap: i32,
}
impl LegacyArea {
    unsafe fn bounds(&self) -> Option<RECT> {
        let list = HWND(self.list as *mut c_void);
        let parent = HWND(self.parent as *mut c_void);
        if !IsWindow(Some(list)).as_bool() || !IsWindow(Some(parent)).as_bool() {
            return None;
        }
        let current = rect(list)?;
        let mut points = [windows::Win32::Foundation::POINT {
            x: current.left,
            y: current.top,
        }];
        MapWindowPoints(None, Some(parent), &mut points);
        let mut client = RECT::default();
        GetClientRect(parent, &mut client).ok()?;
        Some(RECT {
            left: points[0].x,
            top: points[0].y,
            right: client.right - self.right_gap,
            bottom: client.bottom - self.bottom_gap,
        })
    }
    unsafe fn restore(&self) {
        if let Some(bounds) = self.bounds() {
            let list = HWND(self.list as *mut c_void);
            if let Some(current) = rect(list) {
                if current.right - current.left == bounds.right - bounds.left
                    && current.bottom - current.top == bounds.bottom - bounds.top
                {
                    return;
                }
            }
            // 同样是 explorer 的窗口，必须异步投递，见 Shell::layout 里的说明。
            let _ = SetWindowPos(
                list,
                None,
                bounds.left,
                bounds.top,
                (bounds.right - bounds.left).max(0),
                (bounds.bottom - bounds.top).max(0),
                SWP_ASYNCWINDOWPOS | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
            );
        }
    }
}
struct Shell {
    hwnd: HWND,
    child: HWND,
    tasklist: Option<LegacyArea>,
    automation: IUIAutomation,
    _structure_handler: Option<IUIAutomationStructureChangedEventHandler>,
}
impl Drop for Shell {
    fn drop(&mut self) {
        unsafe {
            let _ = self.automation.RemoveAllEventHandlers();
        }
        if let Some(area) = self.tasklist {
            unsafe {
                area.restore();
            }
        }
    }
}
unsafe fn rect(hwnd: HWND) -> Option<RECT> {
    let mut value = RECT::default();
    GetWindowRect(hwnd, &mut value).ok()?;
    Some(value)
}

/// 判断窗口是否属于 shell 自身的弹出面板（快速设置、通知中心、日历、开始菜单等）。
///
/// 这些面板由 ShellExperienceHost / StartMenuExperienceHost 承载，不在 explorer.exe 里，
/// 会被下面的全屏检测误判成「有全屏程序在跑」而隐藏歌词。用窗口类名识别，
/// 限定在已知的 shell 弹层类，避免放过第三方窗口。
fn is_shell_flyout(hwnd: HWND, pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let mut buffer = [0u16; 128];
    let len = unsafe { GetClassNameW(hwnd, &mut buffer) };
    if len <= 0 {
        return false;
    }
    let class = String::from_utf16_lossy(&buffer[..len as usize]);
    matches!(
        class.as_str(),
        // Win11 快速设置 / 通知中心 / 日历等 XAML 弹层
        "Windows.UI.Core.CoreWindow"
            | "Xaml_WindowedPopupClass"
            | "Windows.UI.Composition.CopFlyout"
            | "ShellExperienceHostWindow"
            // 托盘溢出面板（Win10 / Win11）
            | "NotifyIconOverflowWindow"
            | "Shell_SecondaryTrayWnd"
            | "TrayNotifyWnd"
            // 任务栏自身的 XAML 宿主与气泡
            | "Windows.UI.Composition.DesktopWindowContentBridge"
            | "Shell_TrayWnd"
            | "NotifyIconOverflow"
            | "TaskListThumbnail"
    )
}
fn registry_bool(path: &str, name: &str, default: bool) -> bool {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(path)
        .and_then(|k| k.get_value::<u32, _>(name))
        .map(|v| v != 0)
        .unwrap_or(default)
}
#[implement(IUIAutomationStructureChangedEventHandler)]
struct StructureHandler {
    thread_id: u32,
    stopped: Arc<AtomicBool>,
}
impl IUIAutomationStructureChangedEventHandler_Impl for StructureHandler_Impl {
    fn HandleStructureChangedEvent(
        &self,
        _: Ref<'_, IUIAutomationElement>,
        _: StructureChangeType,
        _: *const SAFEARRAY,
    ) -> windows::core::Result<()> {
        if !self.stopped.load(Ordering::Acquire) {
            unsafe {
                let _ = PostThreadMessageW(self.thread_id, CHANGE, WPARAM(0), LPARAM(0));
            }
        }
        Ok(())
    }
}

/// 解挂后窗口的停放位置：所有显示器可见区域之外。
///
/// 取 `-32000` 是 Win32「移出屏幕」的惯用值：SetWindowPos 对 WS_POPUP 按屏幕
/// 坐标解释它，不会被换算成相对坐标。
const DETACHED_OFFSCREEN_X: i32 = -32000;

/// 把歌词窗口从任务栏解挂，恢复为顶层窗口。
///
/// 跨进程的父子关系只应在会话存活期间存在。会话结束时若不解除，Chromium 窗口的
/// 销毁就会跨进程执行 —— Explorer 销毁它时只发 `WM_NCDESTROY`，Chromium 的
/// `NativeThemeObserver` 析构 CHECK 失败；而由我们补发 `WM_DESTROY` 又等于在
/// explorer 线程上跑 Chromium 宿主，直接拖垮 shell。做法参考 AF-Media-Bar 的
/// `UndockWindow`。
///
/// 解挂后不留下任何「可见的空窗期」：先隐藏，再停放到屏幕外，见函数体。
///
/// 只在仍确实是任务栏子窗口时动手，避免误改 Electron 自己的父子关系。
///
/// 用 GetAncestor(GA_PARENT) 判断：对 WS_POPUP 窗口 GetParent 返回的是 owner，
/// 不是真正的父窗口。
unsafe fn detach(child: HWND) {
    if GetAncestor(child, GA_PARENT).0.is_null() {
        return;
    }
    // 解挂前必须先隐藏。SetParent(child, NULL) 会让窗口立刻变成桌面上的顶层
    // 窗口：歌词子窗口的坐标是相对任务栏客户区的（y 通常为 0），换父之后这组
    // 坐标被当成屏幕坐标，窗口就会跳到屏幕顶部闪一下；紧接着还原的
    // WS_CAPTION / WS_THICKFRAME 还会给它画出一圈非客户区边框。
    let _ = ShowWindow(child, SW_HIDE);
    let style = GetWindowLongPtrW(child, GWL_STYLE);
    let ex = GetWindowLongPtrW(child, GWL_EXSTYLE);
    let _ = SetParent(child, None);
    // 与 attach() 对称还原：加回装饰位，去掉挂载时补的三个扩展样式。
    let decorations = WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU;
    SetWindowLongPtrW(child, GWL_STYLE, style | (decorations.0 as isize));
    SetWindowLongPtrW(
        child,
        GWL_EXSTYLE,
        ex & !((WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW).0 as isize),
    );
    // 最后把解挂后的窗口挪出可见区域。SW_HIDE 只保证「此刻不可见」，坐标却仍
    // 是换父时被重解释过的那一组（x 不变、y=0）：此后任何一次迟到的
    // show / restore / SetWindowPos(SWP_SHOWWINDOW) 都会让它弹到屏幕顶部。
    // 移出桌面后，这类显示请求就落不到屏幕上了。两个 detach 调用点
    // （stop() 与工作线程退出）都在会话末尾，窗口随即被销毁或等心跳重建，
    // 没有布局会依赖这里的坐标。
    let _ = SetWindowPos(
        child,
        None,
        DETACHED_OFFSCREEN_X,
        0,
        0,
        0,
        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
    );
}
unsafe fn attach(
    child: HWND,
    automation: &IUIAutomation,
    stopped: &Arc<AtomicBool>,
) -> Option<Shell> {
    let hwnd = FindWindowW(w!("Shell_TrayWnd"), None).ok()?;
    // 不接受同名的第三方窗口：Shell_TrayWnd 必须属于 Windows shell 进程。
    let shell = GetShellWindow();
    let mut owner = 0;
    let mut desktop_owner = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut owner));
    GetWindowThreadProcessId(shell, Some(&mut desktop_owner));
    if owner == 0 || owner != desktop_owner {
        return None;
    }
    SHELL_PID.with(|pid| pid.set(owner));
    SHELL_HWND.with(|value| value.set(hwnd.0 as isize));
    MOUNTED_TASKBAR.store(hwnd.0 as isize, Ordering::Release);
    // 嵌入为任务栏子窗口：歌词天然位于任务栏之上，无需与 shell 争抢 z-order，
    // 也不会被弹出的 XAML 面板（快速设置 / 通知中心）遮挡。
    //
    // 跨进程父子关系的风险由三处兜底：
    //   1. window_lifecycle 吞掉 WM_GETOBJECT，避免 Chromium 的无障碍实现在
    //      explorer 线程上运行（做法参考 AF-Media-Bar 的
    //      TaskbarHostMessagePolicy.ShouldSuppressPropagation）；
    //   2. 销毁阶段补齐缺失的 WM_DESTROY，Chromium 的 NativeThemeObserver 在那里
    //      注销，缺失才会 CHECK 失败；
    //   3. 会话停止时先解除父子关系（detach），不带着跨进程父子关系退出 ——
    //      做法同样取自 AF-Media-Bar 的 UndockWindow。
    let original_style = GetWindowLongPtrW(child, GWL_STYLE);
    let original_ex = GetWindowLongPtrW(child, GWL_EXSTYLE);
    // 顺序与 upstream（SPlayer-Next）一致：**先 SetParent，再改样式**。
    //
    // 之前我照 AF-Media-Bar 的顺序（先样式后 SetParent）来做，但那是给纯原生
    // 窗口的建议。实测结果：先样式后 SetParent 时歌词能显示、不遮挡、Explorer
    // 也不崩，但 Chromium 收到鼠标消息后不转发给渲染进程，hover 完全失效；
    // 而 upstream 的「先 SetParent 再补 WS_EX_LAYERED」版本 hover 是好的。
    // WS_EX_LAYERED 给窗口自己的输入 / 合成表面，是鼠标能否到达的决定因素，
    // 必须在已经挂进任务栏之后再加。
    if SetParent(child, Some(hwnd)).is_err() {
        return None;
    }
    // 挂载成功后复核一次真实父窗口。GetParent 对 WS_POPUP 窗口返回的是 owner
    // 而不是 parent，必须用 GetAncestor(GA_PARENT)。
    if GetAncestor(child, GA_PARENT) != hwnd {
        let _ = SetParent(child, None);
        return None;
    }
    // 与 SPlayer-Next 一致，保留 Electron 创建时的窗口类型，只剥离装饰位。
    // 不把已初始化的 Chromium 顶层窗口强改 WS_CHILD，避免与其窗口宿主状态不一致。
    let decorations = WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU;
    SetWindowLongPtrW(child, GWL_STYLE, original_style & !(decorations.0 as isize));
    SetWindowLongPtrW(
        child,
        GWL_EXSTYLE,
        original_ex
            | WS_EX_LAYERED.0 as isize
            | WS_EX_NOACTIVATE.0 as isize
            | WS_EX_TOOLWINDOW.0 as isize,
    );
    // Win11 可能仍保留旧式 tasklist HWND，存在不代表它承载当前图标；优先使用实际的 XAML 桥。
    let has_xaml = FindWindowExW(
        Some(hwnd),
        None,
        w!("Windows.UI.Composition.DesktopWindowContentBridge"),
        None,
    )
    .is_ok();
    let build = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion")
        .and_then(|key| key.get_value::<String, _>("CurrentBuild"))
        .ok()
        .and_then(|value| value.parse::<u32>().ok());
    // Win10 的小组件也可能使用 XAML；已知 Win10 仍由可见的旧 tasklist 预留空间。
    let rebar = if has_xaml && build.map(|value| value >= 22000).unwrap_or(true) {
        None
    } else {
        FindWindowExW(Some(hwnd), None, w!("ReBarWindow32"), None).ok()
    };
    let list = rebar.and_then(|rebar| {
        FindWindowExW(Some(rebar), None, w!("MSTaskSwWClass"), None)
            .ok()
            .or_else(|| FindWindowExW(Some(rebar), None, w!("MSTaskListWClass"), None).ok())
    });
    let tasklist = list.and_then(|list| {
        if !IsWindowVisible(list).as_bool() {
            return None;
        }
        let mut r = rect(list)?;
        if r.right <= r.left || r.bottom <= r.top {
            return None;
        }
        let parent = GetParent(list).ok()?;
        let mut points = [
            windows::Win32::Foundation::POINT {
                x: r.left,
                y: r.top,
            },
            windows::Win32::Foundation::POINT {
                x: r.right,
                y: r.bottom,
            },
        ];
        MapWindowPoints(None, Some(parent), &mut points);
        r.left = points[0].x;
        r.top = points[0].y;
        r.right = points[1].x;
        r.bottom = points[1].y;
        let mut client = RECT::default();
        GetClientRect(parent, &mut client).ok()?;
        Some(LegacyArea {
            list: list.0 as usize,
            parent: parent.0 as usize,
            right_gap: client.right - r.right,
            bottom_gap: client.bottom - r.bottom,
        })
    });
    // 结构变化由 UIA 监听，位置变化由 WinEvent 监听；避免传递 owned VARIANT 的属性回调。
    let structure_handler = if tasklist.is_none() {
        let root = automation.ElementFromHandle(hwnd).ok()?;
        let handler: IUIAutomationStructureChangedEventHandler = StructureHandler {
            thread_id: GetCurrentThreadId(),
            stopped: stopped.clone(),
        }
        .into();
        automation
            .AddStructureChangedEventHandler(&root, TreeScope_Descendants, None, &handler)
            .ok()?;
        Some(handler)
    } else {
        None
    };
    Some(Shell {
        hwnd,
        child,
        tasklist,
        automation: automation.clone(),
        _structure_handler: structure_handler,
    })
}
impl Shell {
    unsafe fn layout(&self, width: i32) -> Option<TaskbarLyricLayout> {
        let bar = rect(self.hwnd)?;
        let scale = (GetDpiForWindow(self.hwnd) as f64 / 96.0).max(1.0);
        let centered = self.tasklist.is_none()
            && registry_bool(
                "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced",
                "TaskbarAl",
                true,
            );
        let mut layout = TaskbarLyricLayout {
            left: TaskbarRect::default(),
            right: TaskbarRect::default(),
            scale_factor: scale,
            centered,
            is_dark: !registry_bool(
                "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
                "SystemUsesLightTheme",
                false,
            ),
            available: false,
        };
        let height = bar.bottom - bar.top;
        let bar_width = bar.right - bar.left;
        // 自动隐藏任务栏随父窗口移动；竖向任务栏不强行排成窄条。
        if height <= 0 || height > bar_width {
            return Some(layout);
        }
        let foreground = GetForegroundWindow();
        let mut foreground_pid = 0;
        GetWindowThreadProcessId(foreground, Some(&mut foreground_pid));
        let mut cloaked: u32 = 0;
        let _ = DwmGetWindowAttribute(
            foreground,
            DWMWA_CLOAKED,
            &mut cloaked as *mut _ as *mut c_void,
            size_of::<u32>() as u32,
        );
        if foreground != self.hwnd
            && foreground != self.child
            && IsWindowVisible(foreground).as_bool()
            && !IsIconic(foreground).as_bool()
            && cloaked == 0
            && SHELL_PID.with(|value| value.get() != foreground_pid)
            // shell 自身的弹出面板不算「全屏窗口」：快速设置/通知中心/日历这些
            // 面板会短暂占据前台并覆盖任务栏区域，不该因此让歌词消失。
            && !is_shell_flyout(foreground, foreground_pid)
        {
            if let Some(r) = rect(foreground) {
                let monitor = MonitorFromWindow(self.hwnd, MONITOR_DEFAULTTONEAREST);
                let mut info = MONITORINFO {
                    cbSize: size_of::<MONITORINFO>() as u32,
                    ..Default::default()
                };
                if GetMonitorInfoW(monitor, &mut info).as_bool()
                    && r.left <= info.rcMonitor.left
                    && r.top <= info.rcMonitor.top
                    && r.right >= info.rcMonitor.right
                    && r.bottom >= info.rcMonitor.bottom
                {
                    return Some(layout);
                }
            }
        }
        if let Some(area) = self.tasklist {
            let original = area.bounds()?;
            let list = HWND(area.list as *mut c_void);
            if width == 0 {
                return Some(layout);
            }
            let requested = (((width + 16) as f64 * scale).round() as i32)
                .min((original.right - original.left) / 2);
            let reserved = original.right - original.left - requested;
            if requested < (160.0 * scale) as i32 {
                return Some(layout);
            }
            let current = rect(list)?;
            if current.right - current.left != reserved
                || current.bottom - current.top != original.bottom - original.top
            {
                // SWP_ASYNCWINDOWPOS：任务列表归 explorer 所有，跨线程 MoveWindow 会
                // 同步等它回消息，shell 一忙就卡住整个歌词会话。异步投递不阻塞。
                SetWindowPos(
                    list,
                    None,
                    original.left,
                    original.top,
                    reserved,
                    original.bottom - original.top,
                    SWP_ASYNCWINDOWPOS | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
                )
                .ok()?;
            }
            let r = rect(list)?;
            layout.right = TaskbarRect {
                x: r.right - bar.left,
                y: r.top - bar.top,
                width: requested,
                height: r.bottom - r.top,
            };
            layout.available = true;
            return Some(layout);
        }
        // 只扫描 XAML 桥，避免把自己的歌词子窗口纳入占用区域。
        let mut occupied: Vec<(i32, i32)> = Vec::new();
        let mut has_start = false;
        let mut content: Option<(i32, i32)> = None;
        let mut previous = None;
        while let Ok(bridge) = FindWindowExW(
            Some(self.hwnd),
            previous,
            w!("Windows.UI.Composition.DesktopWindowContentBridge"),
            None,
        ) {
            previous = Some(bridge);
            let root = self.automation.ElementFromHandle(bridge).ok()?;
            let condition = self.automation.CreateTrueCondition().ok()?;
            let elements = root.FindAll(TreeScope_Descendants, &condition).ok()?;
            let count = elements.Length().ok()?;
            // 扫描不完整就不能声称剩余区域安全，避免漏掉后面的应用图标。
            if count > 2048 {
                return None;
            }
            for index in 0..count {
                let element = elements.GetElement(index).ok()?;
                if element
                    .CurrentIsOffscreen()
                    .map(|v| v.as_bool())
                    .unwrap_or(true)
                {
                    continue;
                }
                let id = element
                    .CurrentAutomationId()
                    .ok()
                    .map(|v| v.to_string())
                    .unwrap_or_default();
                let class = element
                    .CurrentClassName()
                    .ok()
                    .map(|v| v.to_string())
                    .unwrap_or_default();
                let is_button = element.CurrentControlType().ok()?.0 == 50000;
                let is_content = class.contains("TaskListButton")
                    || matches!(
                        id.as_str(),
                        "StartButton" | "SearchButton" | "SearchBoxTextBlock" | "TaskViewButton"
                    );
                if is_button || is_content || id == "WidgetsButton" {
                    let r = element.CurrentBoundingRectangle().ok()?;
                    if r.right > r.left && r.bottom > r.top {
                        let bounds = (
                            (r.left - bar.left).clamp(0, bar_width),
                            (r.right - bar.left).clamp(0, bar_width),
                        );
                        occupied.push(bounds);
                        if is_content {
                            content = Some(match content {
                                Some((start, end)) => (start.min(bounds.0), end.max(bounds.1)),
                                None => bounds,
                            });
                        }
                        if id == "StartButton" {
                            has_start = true;
                        }
                    }
                }
            }
        }
        if !has_start || occupied.is_empty() {
            return None;
        }
        if let Ok(tray) = FindWindowExW(Some(self.hwnd), None, w!("TrayNotifyWnd"), None) {
            let r = rect(tray)?;
            occupied.push((r.left - bar.left, bar_width));
        } else {
            return None;
        }
        let (left, right) = super::geometry::taskbar_spaces(bar_width, content?, occupied);
        let space = |(x, width)| TaskbarRect {
            x,
            y: 0,
            width,
            height,
        };
        layout.left = space(left);
        layout.right = space(right);
        layout.available = true;
        Some(layout)
    }
}
unsafe fn run(
    child: usize,
    stopped: Arc<AtomicBool>,
    thread_id: Arc<AtomicU32>,
    width: Arc<AtomicI32>,
    restore: Arc<Mutex<Option<LegacyArea>>>,
    callback: Callback,
) {
    // 串行交接 shell，确保旧窗口先恢复 Win10 按钮区，再让新窗口预留空间。
    // 用 try_lock 而非 lock：持锁线程一旦卡在跨进程 UIA 调用上，阻塞式加锁会让
    // 每次开关都永久挂起，表现为应用无响应。抢不到锁就直接放弃本次会话。
    let Ok(_exclusive) = WORKER_LOCK.try_lock() else {
        return;
    };
    if stopped.load(Ordering::Acquire) {
        return;
    }
    if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
        return;
    }
    let _apartment = Apartment;
    let mut message = MSG::default();
    let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
    thread_id.store(GetCurrentThreadId(), Ordering::Release);
    let _thread_id_guard = ThreadIdGuard(thread_id.clone());
    if stopped.load(Ordering::Acquire) {
        return;
    }
    let Ok(automation): windows::core::Result<IUIAutomation> =
        CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
    else {
        return;
    };
    CREATED.with(|value| value.set(RegisterWindowMessageW(w!("TaskbarCreated"))));
    let instance = GetModuleHandleW(None).unwrap_or_default();
    let class = WNDCLASSW {
        lpfnWndProc: Some(watcher_proc),
        hInstance: instance.into(),
        lpszClassName: w!("EchoMusicTaskbarWatcher"),
        ..Default::default()
    };
    RegisterClassW(&class);
    let window = CreateWindowExW(
        WINDOW_EX_STYLE::default(),
        class.lpszClassName,
        w!("EchoMusic Taskbar Watcher"),
        WINDOW_STYLE::default(),
        0,
        0,
        0,
        0,
        None,
        None,
        Some(instance.into()),
        None,
    )
    .unwrap_or_default();
    if window.0.is_null() {
        return;
    }
    let mut watchers = Watchers {
        window,
        hooks: Vec::new(),
    };
    FOREGROUND_HWND.with(|value| value.set(GetForegroundWindow().0 as isize));
    // 前台回到 EchoMusic 也是恢复截图隐藏的必要事件，不能跳过自己的进程。
    for (first, last, flags) in [
        (
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            WINEVENT_OUTOFCONTEXT,
        ),
        (
            EVENT_OBJECT_CREATE,
            EVENT_OBJECT_NAMECHANGE,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        ),
        (
            EVENT_SYSTEM_CAPTUREEND,
            EVENT_SYSTEM_CAPTUREEND,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        ),
        (
            EVENT_OBJECT_CLOAKED,
            EVENT_OBJECT_UNCLOAKED,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        ),
    ] {
        let hook = SetWinEventHook(first, last, None, Some(shell_event), 0, 0, flags);
        if !hook.0.is_null() {
            watchers.hooks.push(hook);
        }
    }
    let child = HWND(child as *mut c_void);
    let mut shell: Option<Shell> = None;
    let mut scheduled = false;
    let mut retry = 0;
    let mut last_layout = None;
    // 兜底置顶在整个会话期间常驻，不随布局定时器取消。
    let _ = PostThreadMessageW(GetCurrentThreadId(), CHANGE, WPARAM(0), LPARAM(0));
    while !stopped.load(Ordering::Acquire) && GetMessageW(&mut message, None, 0, 0).0 > 0 {
        if message.message == CHANGE {
            if message.wParam.0 == 1 {
                shell.take();
                last_layout = None;
            } else if message.wParam.0 == 2 {
                // 前台恢复 / 手动重新显示时，几何未变也要重发，恢复被系统隐藏的窗口。
                last_layout = None;
            }
            // 已是任务栏子窗口时这里是空操作；挂载前才需要抢一次置顶，
            // 否则窗口在 SetParent 之前会闪到任务栏之外。
            raise_lyric(child);
            if !scheduled {
                SetTimer(Some(window), TIMER, 120, None);
                scheduled = true;
            }
        } else if message.message == WM_TIMER {
            let _ = KillTimer(Some(window), TIMER);
            scheduled = false;
            if !IsWindow(Some(child)).as_bool() {
                break;
            }
            let stale_shell = shell
                .as_ref()
                .map(|s| !IsWindow(Some(s.hwnd)).as_bool())
                .unwrap_or(true);
            if stale_shell || shell.is_none() {
                // 冷却期内不重新挂载：此时 Explorer 正忙着重排任务栏，
                // attach() 里的同步 UIA 调用会被编组到 explorer 线程并互相等待，
                // 把工作线程和整个 shell 一起拖死。等冷却结束再重挂。
                if !probe_cooling_down() {
                    shell.take();
                    shell = attach(child, &automation, &stopped);
                    if let Ok(mut value) = restore.lock() {
                        *value = shell.as_ref().and_then(|s| s.tasklist);
                    }
                }
            }
            // 冷却期内也跳过同步探测，沿用上一份布局。
            let layout = if probe_cooling_down() {
                last_layout.clone()
            } else {
                shell
                    .as_ref()
                    .and_then(|s| s.layout(width.load(Ordering::Acquire)))
            };
            let failed = layout.is_none();
            let value = layout.unwrap_or(TaskbarLyricLayout {
                left: TaskbarRect::default(),
                right: TaskbarRect::default(),
                scale_factor: 1.0,
                centered: false,
                is_dark: true,
                available: false,
            });
            if !value.available || stopped.load(Ordering::Acquire) {
                if let Some(area) = shell.as_ref().and_then(|s| s.tasklist) {
                    area.restore();
                }
            }
            if !stopped.load(Ordering::Acquire) && last_layout.as_ref() != Some(&value) {
                last_layout = Some(value.clone());
                callback.call(value, ThreadsafeFunctionCallMode::NonBlocking);
            }
            if failed {
                retry += 1;
                // 先用递增间隔快速重试（应对任务栏重建的短暂空窗）。
                // 超过上限后**仍要保持低频重试**：Explorer 打开快速设置 / 通知中心
                // 这类 XAML 弹层时会销毁并重建 Shell_TrayWnd，重建窗口期通常长于
                // 快速重试的总时长。若此时停止安排定时器，attach() 再也不会被调用，
                // 歌词窗口就永久停在初始位置（表现为「窗口消失」）。
                let delay = if retry <= 5 {
                    250 * retry
                } else {
                    RETRY_IDLE_MS
                };
                SetTimer(Some(window), TIMER, delay, None);
                scheduled = true;
            } else {
                retry = 0;
            }
        } else {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    // 先释放 UIA / shell / watcher，再退出 COM apartment；不在 Electron 主线程等待 UIA。
    drop(shell);
    drop(watchers);
    drop(automation);
    // 解挂：不让跨进程的父子关系活到进程退出。
    //
    // Chromium 窗口随后会在 Electron 自己的线程上被销毁并收到完整的
    // WM_DESTROY → WM_NCDESTROY 序列；若此时它仍是 explorer 的子窗口，销毁流程
    // 就会跨进程执行，两边都可能崩。做法参考 AF-Media-Bar 的 UndockWindow。
    unsafe { detach(child) };
    thread_id.store(0, Ordering::Release);
    // 工作线程退出即视为会话失效，JS 心跳据此判定需要重建窗口。
    MOUNTED_TASKBAR.store(0, Ordering::Release);
}
