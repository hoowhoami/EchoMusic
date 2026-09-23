//! Observe WM_LBUTTONDBLCLK so the main process can emulate a caption
//! double-click for transparent Windows windows, which have no system caption.
//!
//! The web-contents HWND of a composed/transparent window is not guaranteed to
//! go through the installing thread's message retrieval path, so a WH_MOUSE
//! *thread* hook can silently see nothing. We therefore use a low-level
//! WH_MOUSE_LL hook, which observes every mouse message as it enters the input
//! stream, regardless of the target window or thread. The hook never consumes
//! or reposts input; it only reads the screen point and queues an async
//! callback. The OS already applies its own double-click timing/distance rules:
//! WM_LBUTTONDBLCLK is only produced for windows with CS_DBLCLKS, so no manual
//! pairing is needed.
use napi::bindgen_prelude::Buffer;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::cell::RefCell;
use std::ffi::c_void;
use std::sync::atomic::{AtomicU64, Ordering};

#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}
#[repr(C)]
struct MsllHookStruct {
    pt: Point,
    mouse_data: usize,
    flags: u32,
    time: u32,
    extra: usize,
}

type HookProc = unsafe extern "system" fn(i32, usize, isize) -> isize;

#[link(name = "user32")]
extern "system" {
    fn SetWindowsHookExW(id_hook: i32, proc: HookProc, module: *mut c_void, thread_id: u32) -> usize;
    fn UnhookWindowsHookEx(hook: usize) -> i32;
    fn CallNextHookEx(hook: usize, code: i32, wparam: usize, lparam: isize) -> isize;
    fn GetForegroundWindow() -> *mut c_void;
}

const WH_MOUSE_LL: i32 = 14;
const WM_LBUTTONDBLCLK: usize = 0x0203;

// Read-only diagnostics: how many double-clicks reached the hook, and how many
// of those belonged to the monitored window (foreground at the time). Lets the
// log distinguish "no WM_LBUTTONDBLCLK generated at all" from "dropped by gating".
static TOTAL_DBLCLK: AtomicU64 = AtomicU64::new(0);
static FOREGROUND_DBLCLK: AtomicU64 = AtomicU64::new(0);

struct HookState {
    hook: usize,
    root: usize,
    callback: ThreadsafeFunction<WindowDoubleClickPosition>,
}
thread_local! {
    static HOOK: RefCell<Option<HookState>> = const { RefCell::new(None) };
}

#[napi(object)]
pub struct WindowDoubleClickPosition {
    pub x: f64,
    pub y: f64,
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: usize, lparam: isize) -> isize {
    if code >= 0 && wparam == WM_LBUTTONDBLCLK {
        TOTAL_DBLCLK.fetch_add(1, Ordering::Relaxed);
        let ms = &*(lparam as *const MsllHookStruct);
        HOOK.with(|slot| {
            if let Some(state) = slot.borrow().as_ref() {
                // The double-click belongs to our window only when our window is
                // foreground; otherwise the point may land in a stacked window
                // overlapping our titlebar band. The JS side still applies the
                // band filter and the renderer confirms the drag region.
                if GetForegroundWindow() == state.root as *mut c_void {
                    FOREGROUND_DBLCLK.fetch_add(1, Ordering::Relaxed);
                    state.callback.call(
                        Ok(WindowDoubleClickPosition {
                            x: ms.pt.x as f64,
                            y: ms.pt.y as f64,
                        }),
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                }
            }
        });
    }
    // Always forward: reproducing the event depends on unmodified input handling.
    CallNextHookEx(0, code, wparam, lparam)
}

#[napi]
pub fn stop_windows_double_click_monitor() {
    HOOK.with(|slot| {
        if let Some(state) = slot.borrow_mut().take() {
            if state.hook != 0 {
                unsafe {
                    UnhookWindowsHookEx(state.hook);
                }
            }
        }
    });
}

#[napi]
pub fn start_windows_double_click_monitor(
    handle: Buffer,
    callback: ThreadsafeFunction<WindowDoubleClickPosition>,
) -> napi::Result<()> {
    let bytes: [u8; std::mem::size_of::<usize>()] = handle
        .as_ref()
        .try_into()
        .map_err(|_| napi::Error::from_reason("Invalid window handle"))?;
    let root = usize::from_ne_bytes(bytes);
    if root == 0 {
        return Err(napi::Error::from_reason("Null window handle"));
    }
    stop_windows_double_click_monitor();
    // A low-level hook is process-global: dwThreadId must be 0. It is delivered
    // on the thread that installed it (the Electron main thread's message loop).
    let hook =
        unsafe { SetWindowsHookExW(WH_MOUSE_LL, mouse_proc, std::ptr::null_mut(), 0) };
    if hook == 0 {
        return Err(napi::Error::from_reason("Could not install WH_MOUSE_LL hook"));
    }
    TOTAL_DBLCLK.store(0, Ordering::Relaxed);
    FOREGROUND_DBLCLK.store(0, Ordering::Relaxed);
    HOOK.with(|slot| {
        *slot.borrow_mut() = Some(HookState {
            hook,
            root,
            callback,
        })
    });
    Ok(())
}

#[napi(object)]
pub struct WindowsDoubleClickDiagnostics {
    pub installed: bool,
    pub total_dblclick: f64,
    pub foreground_dblclick: f64,
}

#[napi]
pub fn get_windows_double_click_diagnostics() -> WindowsDoubleClickDiagnostics {
    WindowsDoubleClickDiagnostics {
        installed: HOOK.with(|slot| slot.borrow().is_some()),
        total_dblclick: TOTAL_DBLCLK.load(Ordering::Relaxed) as f64,
        foreground_dblclick: FOREGROUND_DBLCLK.load(Ordering::Relaxed) as f64,
    }
}