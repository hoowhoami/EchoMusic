//! Observe WM_LBUTTONDBLCLK so the main process can emulate a caption
//! double-click for transparent Windows windows, which have no system caption.
//! A WH_MOUSE thread hook reports the message before Chromium processes it;
//! the hook never consumes, reposts, or modifies the event. The OS already
//! applied its own double-click timing/distance rules when translating the
//! second WM_LBUTTONDOWN into WM_LBUTTONDBLCLK (CS_DBLCLKS windows), so no
//! manual pairing is needed.
use napi::bindgen_prelude::Buffer;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::cell::RefCell;
use std::ffi::c_void;

#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}
#[repr(C)]
struct MouseHookStruct {
    pt: Point,
    hwnd: usize,
    hit_test: u32,
    extra: usize,
}

type HookProc = unsafe extern "system" fn(i32, usize, isize) -> isize;

#[link(name = "user32")]
extern "system" {
    fn SetWindowsHookExW(id_hook: i32, proc: HookProc, module: *mut c_void, thread_id: u32) -> usize;
    fn UnhookWindowsHookEx(hook: usize) -> i32;
    fn CallNextHookEx(hook: usize, code: i32, wparam: usize, lparam: isize) -> isize;
    fn IsChild(parent: *mut c_void, child: *mut c_void) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentThreadId() -> u32;
}

const WH_MOUSE: i32 = 7;
const WM_LBUTTONDBLCLK: usize = 0x0203;

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

// A double-click in the client area is delivered to the target HWND, which for
// Windows Composition Overlay is a child of the top-level window. Only report
// events within this window tree: other windows in the thread (menus, popups)
// must stay out of the toggle path.
unsafe extern "system" fn mouse_proc(code: i32, wparam: usize, lparam: isize) -> isize {
    if code >= 0 && wparam == WM_LBUTTONDBLCLK {
        HOOK.with(|slot| {
            if let Some(state) = slot.borrow().as_ref() {
                let ms = &*(lparam as *const MouseHookStruct);
                let root = state.root as *mut c_void;
                let hwnd = ms.hwnd as *mut c_void;
                if !hwnd.is_null() && (hwnd == root || IsChild(root, hwnd) != 0) {
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
    // Always forward: reproducing the event depends on unmodified handling.
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
    let hook = unsafe { SetWindowsHookExW(WH_MOUSE, mouse_proc, std::ptr::null_mut(), GetCurrentThreadId()) };
    if hook == 0 {
        return Err(napi::Error::from_reason("Could not install WH_MOUSE hook"));
    }
    HOOK.with(|slot| {
        *slot.borrow_mut() = Some(HookState {
            hook,
            root,
            callback,
        })
    });
    Ok(())
}