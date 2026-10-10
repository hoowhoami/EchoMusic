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
        atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering},
        Arc,
    },
    thread,
};
use windows::{
    core::{implement, w, Ref},
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
        Graphics::Gdi::{
            GetMonitorInfoW, MapWindowPoints, MonitorFromWindow, MONITORINFO,
            MONITOR_DEFAULTTONEAREST,
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
thread_local! {
    static SHELL_PID: Cell<u32> = const { Cell::new(0) };
    static SHELL_HWND: Cell<isize> = const { Cell::new(0) };
    static CREATED: Cell<u32> = const { Cell::new(0) };
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

#[napi]
pub struct TaskbarLyricSession {
    stopped: Arc<AtomicBool>,
    thread_id: Arc<AtomicU32>,
    width: Arc<AtomicI32>,
    restore: Arc<Mutex<Option<LegacyArea>>>,
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
        let session = Self {
            stopped: Arc::new(AtomicBool::new(false)),
            thread_id: Arc::new(AtomicU32::new(0)),
            width: Arc::new(AtomicI32::new(width.clamp(0, 1000))),
            restore: Arc::new(Mutex::new(None)),
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
                let _ = PostThreadMessageW(id, CHANGE, WPARAM(0), LPARAM(0));
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
    _: i32,
    _: i32,
    _: u32,
    _: u32,
) {
    let mut pid = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if event == 3
        || (SHELL_PID.with(|p| p.get() == pid && pid != 0)
            && SHELL_HWND.with(|value| value.get() == GetAncestor(hwnd, GA_ROOT).0 as isize))
    {
        let _ = PostThreadMessageW(GetCurrentThreadId(), CHANGE, WPARAM(0), LPARAM(0));
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
            let _ = MoveWindow(
                list,
                bounds.left,
                bounds.top,
                (bounds.right - bounds.left).max(0),
                (bounds.bottom - bounds.top).max(0),
                true,
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
    let original_style = GetWindowLongPtrW(child, GWL_STYLE);
    let original_ex = GetWindowLongPtrW(child, GWL_EXSTYLE);
    // SetParent 不会自动调整 WS_CHILD / WS_POPUP；失败必须恢复窗口样式。
    SetWindowLongPtrW(
        child,
        GWL_STYLE,
        (original_style & !(WS_POPUP.0 as isize)) | WS_CHILD.0 as isize,
    );
    SetWindowLongPtrW(
        child,
        GWL_EXSTYLE,
        original_ex | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize,
    );
    if SetParent(child, Some(hwnd)).is_err() {
        SetWindowLongPtrW(child, GWL_STYLE, original_style);
        SetWindowLongPtrW(child, GWL_EXSTYLE, original_ex);
        return None;
    }
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
        if foreground != self.hwnd
            && foreground != self.child
            && SHELL_PID.with(|value| value.get() != foreground_pid)
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
                MoveWindow(
                    list,
                    original.left,
                    original.top,
                    reserved,
                    original.bottom - original.top,
                    true,
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
    let Ok(_exclusive) = WORKER_LOCK.lock() else {
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
    for (first, last) in [(3, 3), (0x8000, 0x800c)] {
        let hook = SetWinEventHook(
            first,
            last,
            None,
            Some(shell_event),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );
        if !hook.0.is_null() {
            watchers.hooks.push(hook);
        }
    }
    let child = HWND(child as *mut c_void);
    let mut shell: Option<Shell> = None;
    let mut scheduled = false;
    let mut retry = 0;
    let mut last_layout = None;
    let _ = PostThreadMessageW(GetCurrentThreadId(), CHANGE, WPARAM(0), LPARAM(0));
    while !stopped.load(Ordering::Acquire) && GetMessageW(&mut message, None, 0, 0).0 > 0 {
        if message.message == CHANGE {
            if message.wParam.0 == 1 {
                shell.take();
                last_layout = None;
            }
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
            if shell
                .as_ref()
                .map(|s| !IsWindow(Some(s.hwnd)).as_bool())
                .unwrap_or(true)
            {
                shell.take();
                shell = attach(child, &automation, &stopped);
                if let Ok(mut value) = restore.lock() {
                    *value = shell.as_ref().and_then(|s| s.tasklist);
                }
            }
            let layout = shell
                .as_ref()
                .and_then(|s| s.layout(width.load(Ordering::Acquire)));
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
            if failed && retry < 5 {
                retry += 1;
                SetTimer(Some(window), TIMER, 250 * retry, None);
                scheduled = true;
            } else if !failed {
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
    thread_id.store(0, Ordering::Release);
}
