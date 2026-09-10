//! Optional Windows 10/11 Accent fallback. Never changes HWND styles or regions.
//! The Accent policy is undocumented: resolve it at runtime and report failure.
use napi_derive::napi;
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

type SetComposition = unsafe extern "system" fn(*mut c_void, *mut AttributeData) -> i32;
#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
}
#[link(name = "user32")]
extern "system" {
    fn IsWindow(hwnd: *mut c_void) -> i32;
}
#[link(name = "dwmapi")]
extern "system" {
    fn DwmExtendFrameIntoClientArea(hwnd: *mut c_void, margins: *const Margins) -> i32;
}

/// mode: 0=off, 1=clear, 2=blur. Called synchronously on Electron's UI thread.
#[napi]
pub fn set_window_composition(hwnd: String, mode: u32) -> bool {
    if mode > 2 {
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
        if module.is_null() {
            return false;
        }
        let proc = GetProcAddress(module, b"SetWindowCompositionAttribute\0".as_ptr());
        if proc.is_null() {
            return false;
        }
        let set: SetComposition = transmute(proc);
        // BlurBehind avoids Windows 10 Acrylic's synchronous resize/drag stalls.
        let mut policy = AccentPolicy {
            state: match mode {
                1 => 2,
                2 => 3,
                _ => 0,
            },
            flags: 0,
            color: 0,
            animation: 0,
        };
        let mut data = AttributeData {
            attribute: 19,
            data: (&mut policy as *mut AccentPolicy).cast(),
            size: size_of::<AccentPolicy>(),
        };
        if set(handle, &mut data) == 0 {
            return false;
        }
        let edge = if mode == 0 { 0 } else { -1 };
        let margins = Margins {
            left: edge,
            right: edge,
            top: edge,
            bottom: edge,
        };
        if DwmExtendFrameIntoClientArea(handle, &margins) < 0 {
            let mut disabled = AccentPolicy {
                state: 0,
                flags: 0,
                color: 0,
                animation: 0,
            };
            data.data = (&mut disabled as *mut AccentPolicy).cast();
            let _ = set(handle, &mut data);
            return false;
        }
        true
    }
}
