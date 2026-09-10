//! Windows DWM alpha composition and optional Accent blur. Never changes HWND styles or shape.
//! The Accent policy is undocumented: resolve it at runtime and report failure.
use napi_derive::napi;
use std::cell::Cell;
use std::ffi::c_void;
use std::mem::{size_of, transmute};

#[repr(C)]
struct AccentPolicy {
    state: i32,
    flags: u32,
    color: u32,
    animation: u32,
}
#[repr(C)]
struct AttributeData {
    attribute: i32,
    data: *mut c_void,
    size: usize,
}
#[repr(C)]
struct Margins {
    left: i32,
    right: i32,
    top: i32,
    bottom: i32,
}

#[repr(C)]
struct BlurBehind {
    flags: u32,
    enabled: i32,
    region: *mut c_void,
    transition_on_maximized: i32,
}
#[link(name = "gdi32")]
extern "system" {
    fn CreateRectRgn(left: i32, top: i32, right: i32, bottom: i32) -> *mut c_void;
    fn DeleteObject(object: *mut c_void) -> i32;
}

type SetComposition = unsafe extern "system" fn(*mut c_void, *mut AttributeData) -> i32;
#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
}
#[link(name = "user32")]
extern "system" {
    fn IsWindow(hwnd: *mut c_void) -> i32;
    fn GetWindowLongW(hwnd: *mut c_void, index: i32) -> i32;
    fn GetSystemMetrics(index: i32) -> i32;
    fn GetForegroundWindow() -> *mut c_void;
    fn DefWindowProcW(hwnd: *mut c_void, message: u32, wparam: usize, lparam: isize) -> isize;
}
#[link(name = "dwmapi")]
extern "system" {
    fn DwmExtendFrameIntoClientArea(hwnd: *mut c_void, margins: *const Margins) -> i32;
    fn DwmGetWindowAttribute(
        hwnd: *mut c_void,
        attribute: u32,
        value: *mut c_void,
        size: u32,
    ) -> i32;
    fn DwmIsCompositionEnabled(enabled: *mut i32) -> i32;
    fn DwmEnableBlurBehindWindow(hwnd: *mut c_void, options: *const BlurBehind) -> i32;
    fn DwmSetWindowAttribute(
        hwnd: *mut c_void,
        attribute: u32,
        value: *const c_void,
        size: u32,
    ) -> i32;
}

type SubclassProc =
    unsafe extern "system" fn(*mut c_void, u32, usize, isize, usize, usize) -> isize;
#[link(name = "comctl32")]
extern "system" {
    fn SetWindowSubclass(hwnd: *mut c_void, proc: SubclassProc, id: usize, data: usize) -> i32;
    fn GetWindowSubclass(hwnd: *mut c_void, proc: SubclassProc, id: usize, data: *mut usize)
        -> i32;
    fn RemoveWindowSubclass(hwnd: *mut c_void, proc: SubclassProc, id: usize) -> i32;
    fn DefSubclassProc(hwnd: *mut c_void, message: u32, wparam: usize, lparam: isize) -> isize;
}
const LEGACY_COMPOSITION_SUBCLASS: usize = 0x4543484f;
thread_local! { static REPAIRING_LEGACY_FRAME: Cell<bool> = const { Cell::new(false) }; }

// Electron <Win11 22H2 leaves HWNDMessageHandler::is_translucent_ false.
// Its SetDwmFrameExtension can restore 0/1px insets after our full-client margins.
// Repair only legacy effect windows, after Chromium has finished processing.
unsafe extern "system" fn legacy_composition_proc(
    hwnd: *mut c_void,
    message: u32,
    wparam: usize,
    lparam: isize,
    id: usize,
    _data: usize,
) -> isize {
    if message == 0x0082 {
        // WM_NCDESTROY
        RemoveWindowSubclass(hwnd, legacy_composition_proc, id);
        return DefSubclassProc(hwnd, message, wparam, lparam);
    }
    let result = DefSubclassProc(hwnd, message, wparam, lparam);
    // WM_WINDOWPOSCHANGED (show/resize), WM_NCACTIVATE, WM_DWMCOMPOSITIONCHANGED.
    if !matches!(message, 0x0047 | 0x0086 | 0x031e) || IsWindow(hwnd) == 0 {
        return result;
    }
    let mut mode = 0;
    if GetWindowSubclass(hwnd, legacy_composition_proc, id, &mut mode) == 0 {
        return result;
    }
    let mode = mode & 0xff;
    if !REPAIRING_LEGACY_FRAME.with(|busy| busy.replace(true)) {
        let active = if message == 0x0086 {
            wparam != 0
        } else {
            GetForegroundWindow() == hwnd
        };
        let repaired = if message == 0x031e {
            set_window_composition((hwnd as usize).to_string(), mode as u32)
        } else {
            refresh_legacy_frame(hwnd, mode as u32, active, false)
        };
        // Retain read-only evidence of a later repair failure without allocating
        // callback state. Recheck installation because reapplication can remove it.
        let mut current = 0;
        if GetWindowSubclass(hwnd, legacy_composition_proc, id, &mut current) != 0
            && current & 0xff == mode
        {
            SetWindowSubclass(
                hwnd,
                legacy_composition_proc,
                id,
                mode | if repaired { 0 } else { 0x100 },
            );
        }
        REPAIRING_LEGACY_FRAME.with(|busy| busy.set(false));
    }
    result
}

unsafe fn refresh_legacy_frame(
    hwnd: *mut c_void,
    mode: u32,
    active: bool,
    reset_alpha: bool,
) -> bool {
    // Same non-client activation used by Electron's Win11 material path. The -1
    // parameter prevents Windows painting a system caption over custom controls.
    DefWindowProcW(hwnd, 0x0086, usize::from(active), -1);
    if DwmExtendFrameIntoClientArea(
        hwnd,
        &Margins {
            left: -1,
            right: -1,
            top: -1,
            bottom: -1,
        },
    ) < 0
    {
        return false;
    }
    !reset_alpha || mode != 6 || set_alpha_composition(hwnd, true)
}

unsafe fn remove_legacy_frame_repair(hwnd: *mut c_void) -> bool {
    let mut mode = 0;
    GetWindowSubclass(
        hwnd,
        legacy_composition_proc,
        LEGACY_COMPOSITION_SUBCLASS,
        &mut mode,
    ) == 0
        || RemoveWindowSubclass(hwnd, legacy_composition_proc, LEGACY_COMPOSITION_SUBCLASS) != 0
}

#[napi(object)]
pub struct WindowCompositionDiagnostics {
    pub legacy_frame_repair_installed: bool,
    pub legacy_frame_repair_last_succeeded: Option<bool>,
    pub layered: bool,
    pub no_redirection_bitmap: bool,
    pub remote_session: bool,
    pub composition_enabled: Option<bool>,
    pub accent_state: Option<i32>,
    pub system_backdrop: Option<u32>,
}

/// Read back state without changing styles, materials, or capturing other windows.
#[napi]
pub fn get_window_composition_diagnostics(hwnd: String) -> Option<WindowCompositionDiagnostics> {
    let handle = hwnd.parse::<usize>().ok()? as *mut c_void;
    unsafe {
        if handle.is_null() || IsWindow(handle) == 0 {
            return None;
        }
        let styles = GetWindowLongW(handle, -20) as u32;
        let mut enabled = 0;
        let composition_enabled =
            (DwmIsCompositionEnabled(&mut enabled) >= 0).then_some(enabled != 0);
        let mut backdrop: u32 = 0;
        let system_backdrop = (DwmGetWindowAttribute(
            handle,
            38,
            (&mut backdrop as *mut u32).cast(),
            size_of::<u32>() as u32,
        ) >= 0)
            .then_some(backdrop);
        let name: Vec<u16> = "user32.dll\0".encode_utf16().collect();
        let module = GetModuleHandleW(name.as_ptr());
        let proc = if module.is_null() {
            std::ptr::null_mut()
        } else {
            GetProcAddress(module, b"GetWindowCompositionAttribute\0".as_ptr())
        };
        let mut accent_state = None;
        if !proc.is_null() {
            let get: SetComposition = transmute(proc);
            let mut policy = AccentPolicy {
                state: 0,
                flags: 0,
                color: 0,
                animation: 0,
            };
            let mut data = AttributeData {
                attribute: 19,
                data: (&mut policy as *mut AccentPolicy).cast(),
                size: size_of::<AccentPolicy>(),
            };
            if get(handle, &mut data) != 0 {
                accent_state = Some(policy.state);
            }
        }
        let mut legacy_mode = 0;
        let legacy_frame_repair_installed = GetWindowSubclass(
            handle,
            legacy_composition_proc,
            LEGACY_COMPOSITION_SUBCLASS,
            &mut legacy_mode,
        ) != 0;
        Some(WindowCompositionDiagnostics {
            legacy_frame_repair_installed,
            legacy_frame_repair_last_succeeded: legacy_frame_repair_installed
                .then_some(legacy_mode & 0x100 == 0),
            layered: styles & 0x00080000 != 0,
            no_redirection_bitmap: styles & 0x00200000 != 0,
            remote_session: GetSystemMetrics(0x1000) != 0,
            composition_enabled,
            accent_state,
            system_backdrop,
        })
    }
}

// DWM_BB_ENABLE | DWM_BB_BLURREGION explicitly enables per-pixel alpha.
// Windows 8+ does not blur through this API. The temporary region belongs only
// to DWM's blur description; it is never installed as the HWND's shape.
unsafe fn set_alpha_composition(handle: *mut c_void, enabled: bool) -> bool {
    let region = if enabled {
        CreateRectRgn(0, 0, -1, -1)
    } else {
        std::ptr::null_mut()
    };
    if enabled && region.is_null() {
        return false;
    }
    let options = BlurBehind {
        flags: if enabled { 3 } else { 1 },
        enabled: i32::from(enabled),
        region,
        transition_on_maximized: 0,
    };
    let result = DwmEnableBlurBehindWindow(handle, &options);
    if !region.is_null() {
        DeleteObject(region);
    }
    result >= 0
}

/// mode: 0=off, 5=Win11 DWM clear, 6=legacy DWM clear+frame repair, 7=legacy blur+frame repair.
/// Modes 6/7 deliberately differ from the former legacy 4/2 protocol:
/// old addons reject them, causing an explicit fallback instead of silent failure.
#[napi]
pub fn set_window_composition(hwnd: String, mode: u32) -> bool {
    if !matches!(mode, 0 | 5 | 6 | 7) {
        return false;
    }
    let Ok(address) = hwnd.parse::<usize>() else {
        return false;
    };
    let handle = address as *mut c_void;
    unsafe {
        if handle.is_null() || IsWindow(handle) == 0 {
            return false;
        }
        let name: Vec<u16> = "user32.dll\0".encode_utf16().collect();
        let module = GetModuleHandleW(name.as_ptr());
        let proc = if module.is_null() {
            std::ptr::null_mut()
        } else {
            GetProcAddress(module, b"SetWindowCompositionAttribute\0".as_ptr())
        };
        let set: Option<SetComposition> = if proc.is_null() {
            None
        } else {
            Some(transmute(proc))
        };
        let accent = |state: i32| {
            let Some(set) = set else {
                return state == 0;
            };
            let mut policy = AccentPolicy {
                state,
                flags: 0,
                color: 0,
                animation: 0,
            };
            let mut data = AttributeData {
                attribute: 19,
                data: (&mut policy as *mut AccentPolicy).cast(),
                size: size_of::<AccentPolicy>(),
            };
            set(handle, &mut data) != 0
        };
        let margins = |edge: i32| {
            DwmExtendFrameIntoClientArea(
                handle,
                &Margins {
                    left: edge,
                    right: edge,
                    top: edge,
                    bottom: edge,
                },
            ) >= 0
        };
        let success = (|| {
            if !remove_legacy_frame_repair(handle) {
                return false;
            }
            // Clear both native backends before installing the next one.
            if !set_alpha_composition(handle, false) || !accent(0) {
                return false;
            }
            if mode == 5 {
                // Reset only the system backdrop; Electron must retain its alpha surface.
                let none: u32 = 1; // DWMSBT_NONE
                if DwmSetWindowAttribute(
                    handle,
                    38,
                    (&none as *const u32).cast(),
                    size_of::<u32>() as u32,
                ) < 0
                {
                    return false;
                }
            }
            if !margins(if mode == 0 { 0 } else { -1 }) {
                return false;
            }
            let applied = match mode {
                6 | 5 => set_alpha_composition(handle, true),
                7 => accent(3), // BlurBehind avoids Win10 Acrylic drag stalls.
                _ => true,
            };
            if !applied {
                return false;
            }
            if matches!(mode, 7 | 6) {
                if SetWindowSubclass(
                    handle,
                    legacy_composition_proc,
                    LEGACY_COMPOSITION_SUBCLASS,
                    mode as usize,
                ) == 0
                {
                    return false;
                }
                if !refresh_legacy_frame(handle, mode, GetForegroundWindow() == handle, true) {
                    return false;
                }
            }
            true
        })();
        if !success {
            // Best-effort rollback of every backend, including partial DWM setup.
            let _ = remove_legacy_frame_repair(handle);
            let _ = set_alpha_composition(handle, false);
            let _ = accent(0);
            let _ = margins(0);
        }
        success
    }
}
