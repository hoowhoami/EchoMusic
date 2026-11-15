//! 桌面壁纸层：把 Electron 窗口挂到 Explorer 的桌面（WorkerW）上，并按前景
//! 窗口的覆盖比例回报遮挡状态，供主进程决定降帧还是停画。
//!
//! 挂载顺序沿用任务栏歌词的结论：先 SetParent 再补样式，且必须先安装
//! window_lifecycle，否则桌面层被 Explorer 重建时本进程会 CHECK 崩溃。
use napi::{
    bindgen_prelude::Function,
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue},
    Status,
};
use napi_derive::napi;
use std::{
    ffi::c_void,
    mem::size_of,
    sync::{
        atomic::{AtomicBool, AtomicI32, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use windows::{
    core::{w, BOOL},
    Win32::{
        Foundation::{HWND, RECT, LPARAM},
        Graphics::{
            Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS},
            Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST},
        },
        UI::{
            Shell::{
                SHQueryUserNotificationState, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
            },
            WindowsAndMessaging::*,
        },
    },
};

type Callback =
    ThreadsafeFunction<WallpaperOcclusion, UnknownReturnValue, WallpaperOcclusion, Status, false>;

/// 遮挡状态。coverage 是「单个窗口」覆盖壁纸所在显示器的最大比例，
/// lyric_coverage 是「单个窗口」盖住「歌词区域」的最大比例（都是 0~1，按 1% 取整）。
/// 不按所有窗口的并集算：几个窗口各盖一块拼到 80% 时，拖动其中任意一个都会改变总量，
/// 判定跟着来回跳，冻结/解冻就会闪。按最大的那一个算，判定只跟「有没有一个窗口真的盖住了」有关。
/// 判断要不要降帧看的是歌词区域：歌词露着就没必要停，哪怕整屏大部分被挡住。
#[napi(object)]
pub struct WallpaperOcclusion {
    pub coverage: f64,
    pub lyric_coverage: f64,
    pub fullscreen: bool,
    /// 窗口句柄是否还有效。桌面层被 Explorer 重建时子窗口会被一起销毁，
    /// 而 Electron 侧不一定收到通知，靠这里报给主进程去重建。
    pub alive: bool,
}

const DESKTOP_CLASSES: [&str; 6] = [
    "Progman",
    "WorkerW",
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "ApplicationManager_DesktopShellWindow",
    "SysListView32",
];

fn parse_handle(handle: &str) -> napi::Result<HWND> {
    let value = handle
        .parse::<usize>()
        .map_err(|_| napi::Error::from_reason("Invalid window handle"))?;
    let hwnd = HWND(value as *mut c_void);
    if value == 0 || !unsafe { IsWindow(Some(hwnd)).as_bool() } {
        return Err(napi::Error::from_reason(
            "Wallpaper window no longer exists",
        ));
    }
    Ok(hwnd)
}

unsafe extern "system" fn probe_desktop(top: HWND, lparam: LPARAM) -> BOOL {
    let found = lparam.0 as *mut isize;
    // 图标窗口 SHELLDLL_DefView 所在顶层窗口的**后面**才是可挂载的 WorkerW。
    if let Ok(view) = FindWindowExW(Some(top), None, w!("SHELLDLL_DefView"), None) {
        if !view.0.is_null() {
            if let Ok(worker) = FindWindowExW(None, Some(top), w!("WorkerW"), None) {
                if !worker.0.is_null() {
                    *found = worker.0 as isize;
                    return BOOL(0);
                }
            }
        }
    }
    BOOL(1)
}

/// 让 Explorer 生成挂载用的 WorkerW，然后返回它。
unsafe fn find_host() -> Option<HWND> {
    let progman = FindWindowW(w!("Progman"), None)
        .ok()
        .filter(|hwnd| !hwnd.0.is_null());
    let Some(progman) = progman else {
        return None;
    };
    // 0x052C：让 Explorer 把桌面拆出一个独立的 WorkerW，两条经典参数各发一次。
    for (wparam, lparam) in [(0usize, 0isize), (0xD, 1)] {
        let mut result = 0usize;
        let _ = SendMessageTimeoutW(
            progman,
            0x052C,
            windows::Win32::Foundation::WPARAM(wparam),
            LPARAM(lparam),
            SMTO_NORMAL,
            1000,
            Some(&mut result as *mut usize),
        );
    }
    thread::sleep(Duration::from_millis(80));
    // Win10/11 通用：图标窗口 SHELLDLL_DefView 所在顶层窗口后面那个 WorkerW。
    let mut found = 0isize;
    let _ = EnumWindows(Some(probe_desktop), LPARAM(&mut found as *mut isize as isize));
    if found != 0 {
        return Some(HWND(found as *mut c_void));
    }
    // 部分配置下 WorkerW 直接是 Progman 的子窗口。
    if let Ok(child) = FindWindowExW(Some(progman), None, w!("WorkerW"), None) {
        if !child.0.is_null() {
            return Some(child);
        }
    }
    // 最后兜底挂到 Progman 自己。
    Some(progman)
}

/// 把窗口挂到桌面层。返回是否成功挂到了 WorkerW（而非 Progman 兜底）。
#[napi]
pub fn wallpaper_attach(handle: String) -> napi::Result<()> {
    let child = parse_handle(&handle)?;
    unsafe {
        // 与任务栏歌词相同的宿主契约保护：桌面被 Explorer 重建时补发 WM_DESTROY。
        super::taskbar::window_lifecycle::install(child)?;
        let host = find_host()
            .ok_or_else(|| napi::Error::from_reason("找不到桌面宿主窗口（WorkerW）"))?;
        let style = GetWindowLongPtrW(child, GWL_STYLE);
        let ex = GetWindowLongPtrW(child, GWL_EXSTYLE);
        SetParent(child, Some(host)).map_err(|error| napi::Error::from_reason(error.message()))?;
        // 挂成子窗口：去掉弹出式边框，并禁止激活、不在任务栏出现。
        let popup = WS_POPUP.0 as isize;
        let caption = WS_CAPTION.0 as isize;
        let child_flag = WS_CHILD.0 as isize;
        SetWindowLongPtrW(
            child,
            GWL_STYLE,
            (style & !popup & !caption) | child_flag,
        );
        let no_activate = WS_EX_NOACTIVATE.0 as isize;
        let tool_window = WS_EX_TOOLWINDOW.0 as isize;
        let app_window = WS_EX_APPWINDOW.0 as isize;
        SetWindowLongPtrW(
            child,
            GWL_EXSTYLE,
            (ex | no_activate | tool_window) & !app_window,
        );
        // 挂到 Progman 时插到图标窗口（SHELLDLL_DefView）下面，桌面图标仍在壁纸上层。
        let mut insert_after = Some(HWND_BOTTOM);
        if class_name(host) == "Progman" {
            if let Ok(view) = FindWindowExW(Some(host), None, w!("SHELLDLL_DefView"), None) {
                if !view.0.is_null() {
                    insert_after = Some(view);
                }
            }
        }
        SetWindowPos(
            child,
            insert_after,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW,
        )
        .ok();
        Ok(())
    }
}

/// 子窗口坐标相对**当前父窗口**换算。父窗口每次都现查：桌面宿主被 Explorer
/// 重建、窗口换了父窗口、或者挂载时机和摆放时机交错时，缓存下来的句柄会过期。
unsafe fn parent_origin(child: HWND) -> (i32, i32) {
    let parent = GetParent(child).unwrap_or_default();
    let mut origin = RECT::default();
    if !parent.0.is_null() {
        let _ = GetWindowRect(parent, &mut origin);
    }
    (origin.left, origin.top)
}

unsafe fn apply_rect(child: HWND, x: i32, y: i32, width: i32, height: i32) {
    let (origin_x, origin_y) = parent_origin(child);
    SetWindowPos(
        child,
        Some(HWND_BOTTOM),
        x - origin_x,
        y - origin_y,
        width.max(1),
        height.max(1),
        SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
    )
    .ok();
}
/// 按屏幕坐标摆放壁纸窗口（会换算成宿主的客户区坐标）。
#[napi]
pub fn wallpaper_resize(
    handle: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> napi::Result<()> {
    let child = parse_handle(&handle)?;
    unsafe { apply_rect(child, x, y, width, height) };
    Ok(())
}

/// 解挂：先隐藏再 SetParent(None)，与任务栏歌词的退出顺序一致。
#[napi]
pub fn wallpaper_detach(handle: String) -> napi::Result<()> {
    let child = parse_handle(&handle)?;
    unsafe {
        let _ = ShowWindow(child, SW_HIDE);
        let _ = SetParent(child, None);
        let style = GetWindowLongPtrW(child, GWL_STYLE);
        SetWindowLongPtrW(
            child,
            GWL_STYLE,
            (style & !(WS_CHILD.0 as isize)) | WS_POPUP.0 as isize,
        );
        let ex = GetWindowLongPtrW(child, GWL_EXSTYLE);
        let mask = (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0) as isize;
        SetWindowLongPtrW(child, GWL_EXSTYLE, ex & !mask);
    }
    Ok(())
}

unsafe fn class_name(hwnd: HWND) -> String {
    let mut buffer = [0u16; 64];
    let len = GetClassNameW(hwnd, &mut buffer);
    String::from_utf16_lossy(&buffer[..len.max(0) as usize])
}

/// 挡住桌面的一个窗口矩形（已裁剪到显示器范围）。
#[derive(Clone, Copy)]
struct CoverRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

struct CoverScan {
    screen: RECT,
    own: HWND,
    rects: Vec<CoverRect>,
}

/// 收集所有可能挡住桌面的顶层窗口矩形：只看可见、未被最小化、不在别的虚拟桌面上的窗口。
unsafe extern "system" fn collect_cover(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let scan = &mut *(lparam.0 as *mut CoverScan);
    if hwnd == scan.own {
        return BOOL(1);
    }
    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
        return BOOL(1);
    }
    if DESKTOP_CLASSES.contains(&class_name(hwnd).as_str()) {
        return BOOL(1);
    }
    // 在别的虚拟桌面上、或被 DWM 挂起的窗口依然 IsWindowVisible，但它们并没有显示出来。
    let mut cloaked = 0u32;
    if DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        &mut cloaked as *mut u32 as *mut c_void,
        size_of::<u32>() as u32,
    )
    .is_ok()
        && cloaked != 0
    {
        return BOOL(1);
    }
    // 视觉边界：不含 Win10 那种隐形边框，和眼睛看到的一致。
    let mut rect = RECT::default();
    let mut ok = DwmGetWindowAttribute(
        hwnd,
        DWMWA_EXTENDED_FRAME_BOUNDS,
        &mut rect as *mut RECT as *mut c_void,
        size_of::<RECT>() as u32,
    )
    .is_ok();
    if !ok {
        ok = GetWindowRect(hwnd, &mut rect).is_ok();
    }
    if !ok {
        return BOOL(1);
    }
    let left = rect.left.max(scan.screen.left);
    let top = rect.top.max(scan.screen.top);
    let right = rect.right.min(scan.screen.right);
    let bottom = rect.bottom.min(scan.screen.bottom);
    if right > left && bottom > top {
        scan.rects.push(CoverRect {
            left,
            top,
            right,
            bottom,
        });
    }
    BOOL(1)
}

/// 单个窗口矩形的面积（已裁剪到显示器范围）。
fn rect_area(rect: CoverRect) -> i64 {
    (rect.right - rect.left) as i64 * (rect.bottom - rect.top) as i64
}

/// 把一个窗口矩形裁剪进 region；完全落在外面时返回 None。
fn clip_rect(rect: CoverRect, region: CoverRect) -> Option<CoverRect> {
    let clipped = CoverRect {
        left: rect.left.max(region.left),
        top: rect.top.max(region.top),
        right: rect.right.min(region.right),
        bottom: rect.bottom.min(region.bottom),
    };
    if clipped.right > clipped.left && clipped.bottom > clipped.top {
        Some(clipped)
    } else {
        None
    }
}

/// 计算「哪一个窗口」对壁纸所在显示器的覆盖最大，以及它盖住歌词区域的比例。
unsafe fn measure(child: HWND, lyric: Option<CoverRect>) -> WallpaperOcclusion {
    let none = WallpaperOcclusion {
        coverage: 0.0,
        lyric_coverage: 0.0,
        fullscreen: false,
        alive: true,
    };
    let monitor = MonitorFromWindow(child, MONITOR_DEFAULTTONEAREST);
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !GetMonitorInfoW(monitor, &mut info).as_bool() {
        return none;
    }
    let screen = info.rcMonitor;
    let area = (screen.right - screen.left) as i64 * (screen.bottom - screen.top) as i64;
    if area <= 0 {
        return none;
    }
    let mut scan = CoverScan {
        screen,
        own: child,
        rects: Vec::new(),
    };
    let _ = EnumWindows(
        Some(collect_cover),
        LPARAM(&mut scan as *mut CoverScan as isize),
    );
    // 只取最大的那一个窗口，不取并集：并集会把几个窗口各盖一块拼成 80%，
    // 拖动其中任意一个都会让总量跨过阈值，冻结跟着失效/恢复来回跳。
    let covered = scan
        .rects
        .iter()
        .map(|rect| rect_area(*rect))
        .max()
        .unwrap_or(0)
        .min(area);
    let coverage = (covered as f64 / area as f64).clamp(0.0, 1.0);
    // 歌词区域被盖住多少：把同一批窗口矩形裁剪进歌词矩形再求并集，
    // 用的是刚扫出来的数据，不额外枚举窗口。
    // 歌词区域同理：取单个窗口盖住歌词区的最大比例。
    let lyric_coverage = match lyric {
        Some(region) if region.right > region.left && region.bottom > region.top => {
            let total = (region.right - region.left) as i64 * (region.bottom - region.top) as i64;
            let covered = scan
                .rects
                .iter()
                .filter_map(|rect| clip_rect(*rect, region))
                .map(rect_area)
                .max()
                .unwrap_or(0);
            (covered as f64 / total as f64).clamp(0.0, 1.0)
        }
        _ => 0.0,
    };
    // 独占全屏的 D3D 程序不一定留下一个铺满屏幕的顶层窗口，用系统通知状态补一刀。
    let exclusive = is_exclusive_fullscreen();
    // 全屏只认系统通知状态（独占 D3D 全屏 / 演示模式）。整块屏被窗口盖住不在这里判：
    // 那属于渲染层「占比超 80% 就暂停刷新」的档位，画面原地冻住等窗口挪开；
    // 藏起窗口在用户眼里就是壁纸突然消失，鼠标划过任务栏放大预览时尤其明显。
    WallpaperOcclusion {
        coverage: (coverage * 100.0).round() / 100.0,
        lyric_coverage: (lyric_coverage * 100.0).round() / 100.0,
        fullscreen: exclusive,
        alive: true,
    }
}

/// 当前是否有独占全屏的程序在跑（D3D 全屏 / 演示模式）。
///
/// 不需要任何窗口句柄：壁纸窗口被销毁期间也要能问出「现在该不该创建壁纸」，
/// 所以它不能挂在 WallpaperMonitor 上，由主进程定时轮询。
#[napi]
pub fn is_exclusive_fullscreen() -> bool {
    // 只读系统通知状态，没有指针参数。
    let state = unsafe { SHQueryUserNotificationState() };
    match state {
        Ok(state) => state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_PRESENTATION_MODE,
        Err(_) => false,
    }
}

fn run(
    child: usize,
    stopped: Arc<AtomicBool>,
    interval: Arc<AtomicI32>,
    callback: Callback,
    region: Arc<Mutex<Option<CoverRect>>>,
) {
    let hwnd = HWND(child as *mut c_void);
    let mut last: Option<(i32, i32, bool)> = None;
    while !stopped.load(Ordering::Acquire) {
        // 句柄没了说明桌面层被重建（显示桌面、切虚拟桌面、Explorer 重启），
        // 挂在它下面的子窗口会被系统直接销毁；这个线程本来就在跑，顺手报一次。
        if !unsafe { IsWindow(Some(hwnd)).as_bool() } {
            let _ = callback.call(
                WallpaperOcclusion {
                    coverage: 0.0,
                    lyric_coverage: 0.0,
                    fullscreen: false,
                    alive: false,
                },
                ThreadsafeFunctionCallMode::NonBlocking,
            );
            break;
        }
        let lyric = match region.lock() {
            Ok(guard) => *guard,
            Err(poisoned) => *poisoned.into_inner(),
        };
        let state = unsafe { measure(hwnd, lyric) };
        let key = (
            (state.coverage * 100.0) as i32,
            (state.lyric_coverage * 100.0) as i32,
            state.fullscreen,
        );
        if last != Some(key) {
            last = Some(key);
            let _ = callback.call(state, ThreadsafeFunctionCallMode::NonBlocking);
        }
        thread::sleep(Duration::from_millis(
            interval.load(Ordering::Acquire).max(120) as u64,
        ));
    }
}

/// 遮挡监控：只在状态变化时回调，避免每秒唤醒渲染层。
#[napi]
pub struct WallpaperMonitor {
    stopped: Arc<AtomicBool>,
    interval: Arc<AtomicI32>,
    child: usize,
    /// 歌词区域（屏幕物理像素），由渲染层上报；None 表示当前没有歌词区域。
    region: Arc<Mutex<Option<CoverRect>>>,
}

#[napi]
impl WallpaperMonitor {
    #[napi(
        constructor,
        ts_args_type = "handle: string, intervalMs: number, callback: (state: WallpaperOcclusion) => void"
    )]
    pub fn new(
        handle: String,
        interval_ms: i32,
        callback: Function<WallpaperOcclusion, UnknownReturnValue>,
    ) -> napi::Result<Self> {
        let child = parse_handle(&handle)?.0 as usize;
        let callback: Callback = callback
            .build_threadsafe_function::<WallpaperOcclusion>()
            .build_callback(|ctx| Ok(ctx.value))?;
        let stopped = Arc::new(AtomicBool::new(false));
        let interval = Arc::new(AtomicI32::new(interval_ms.clamp(120, 5000)));
        let region = Arc::new(Mutex::new(None));
        let (flag, tick) = (stopped.clone(), interval.clone());
        let region_for_thread = region.clone();
        thread::Builder::new()
            .name("echo-wallpaper-occlusion".into())
            .spawn(move || run(child, flag, tick, callback, region_for_thread))
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        Ok(Self {
            stopped,
            interval,
            child,
            region,
        })
    }

    /// 上报歌词区域（屏幕物理像素）。宽或高 <= 0 表示当前没有歌词区域。
    #[napi]
    pub fn set_lyric_rect(&self, x: i32, y: i32, width: i32, height: i32) {
        let mut guard = match self.region.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        *guard = if width > 0 && height > 0 {
            Some(CoverRect {
                left: x,
                top: y,
                right: x + width,
                bottom: y + height,
            })
        } else {
            None
        };
    }

    /// 调整采样间隔（毫秒）。
    #[napi]
    pub fn set_interval(&self, interval_ms: i32) {
        self.interval
            .store(interval_ms.clamp(120, 5000), Ordering::Release);
    }

    #[napi]
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
    }

    /// 壁纸窗口句柄（十进制字符串），便于日志与调试。
    #[napi(getter)]
    pub fn handle(&self) -> String {
        self.child.to_string()
    }
}

