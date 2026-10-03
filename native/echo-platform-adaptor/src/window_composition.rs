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
const ACRYLIC_DRAG_SUBCLASS: usize = 0x45434841;

// 组合属性相关 API 未公开，按名称运行时解析；缺失时由调用方按失败处理。
unsafe fn resolve_user32_proc(name: &[u8]) -> *mut c_void {
    let module: Vec<u16> = "user32.dll\0".encode_utf16().collect();
    let module = GetModuleHandleW(module.as_ptr());
    if module.is_null() {
        std::ptr::null_mut()
    } else {
        GetProcAddress(module, name.as_ptr())
    }
}

// color 为 AccentPolicy 的 GradientColor（ABGR）；仅 state 4（Acrylic）使用它。
unsafe fn set_accent(handle: *mut c_void, state: i32, color: u32) -> bool {
    let proc = resolve_user32_proc(b"SetWindowCompositionAttribute\0");
    if proc.is_null() {
        return state == 0;
    }
    let set: SetComposition = transmute(proc);
    let mut policy = AccentPolicy {
        state,
        flags: 0,
        // window-vibrancy's legacy Acrylic path requires nonzero tint alpha;
        // 失焦保持模式传入主题化的着色，贴近 system backdrop 的提亮观感。
        color: if state == 4 { color } else { 0 },
        animation: 0,
    };
    let mut data = AttributeData {
        attribute: 19,
        data: (&mut policy as *mut AccentPolicy).cast(),
        size: size_of::<AccentPolicy>(),
    };
    set(handle, &mut data) != 0
}

// Suspend expensive legacy Acrylic during the OS modal move/resize loop.
// Unlike a JS debounce, these messages also cover a paused mouse inside the loop.
// 失焦保持（keep 位，bit 3）：聚焦时用 Acrylic(4，带主题着色)，失焦时切换为
// 不受激活状态影响的旧版模糊(3)。着色存于 data 高 32 位，切换时原样复用。
// Data bits: 1 = suspended, 2 = last failed, 4 = keep on blur; bits 32+ = tint ABGR.
unsafe extern "system" fn acrylic_drag_proc(
    hwnd: *mut c_void,
    message: u32,
    wparam: usize,
    lparam: isize,
    id: usize,
    ref_data: usize,
) -> isize {
    if message == 0x0082 {
        RemoveWindowSubclass(hwnd, acrylic_drag_proc, id); // WM_NCDESTROY
        return DefSubclassProc(hwnd, message, wparam, lparam);
    }
    if message == 0x0231 {
        // WM_ENTERSIZEMOVE: disable before the modal loop.
        let ok = set_accent(hwnd, 0, 0);
        SetWindowSubclass(hwnd, acrylic_drag_proc, id, (ref_data & !3) | 1 | if ok { 0 } else { 2 });
    }
    let result = DefSubclassProc(hwnd, message, wparam, lparam);
    let mut data = 0;
    if matches!(message, 0x0006 | 0x0232 | 0x031e) // WM_ACTIVATE / WM_EXITSIZEMOVE / WM_DWMCOMPOSITIONCHANGED
        && IsWindow(hwnd) != 0
        && GetWindowSubclass(hwnd, acrylic_drag_proc, id, &mut data) != 0
    {
        let keep = data & 4 != 0;
        let suspended = data & 1 != 0;
        let restore = match message {
            0x0232 => true,          // 拖动/缩放结束，无条件恢复（顺带清 suspended 位）
            0x031e => !suspended,    // 合成状态变化，暂停期间不抢恢复
            _ => keep && !suspended, // WM_ACTIVATE：仅失焦保持模式需要切换
        };
        if restore {
            let focused = if message == 0x0006 {
                (wparam & 0xffff) != 0 // WA_INACTIVE=0，WA_ACTIVE/WA_CLICKACTIVE 非零
            } else {
                GetForegroundWindow() == hwnd
            };
            let ok = if keep && !focused {
                set_accent(hwnd, 3, 0)
            } else {
                // 未存着色的遗留安装（mode 8/10 非 keep）回退到 0x01000000。
                let tint = (data >> 32) as u32;
                set_accent(hwnd, 4, if tint == 0 { 0x01000000 } else { tint })
            };
            SetWindowSubclass(hwnd, acrylic_drag_proc, id, (data & !3) | if ok { 0 } else { 2 });
        }
    }
    result
}

unsafe fn remove_acrylic_drag(hwnd: *mut c_void) -> bool {
    let mut data = 0;
    GetWindowSubclass(hwnd, acrylic_drag_proc, ACRYLIC_DRAG_SUBCLASS, &mut data) == 0
        || RemoveWindowSubclass(hwnd, acrylic_drag_proc, ACRYLIC_DRAG_SUBCLASS) != 0
}
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
            set_window_composition((hwnd as usize).to_string(), mode as u32, None, None)
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
    pub acrylic_drag_handler_installed: bool,
    pub acrylic_suspended: bool,
    pub acrylic_last_operation_succeeded: Option<bool>,
    pub acrylic_keep_on_blur: bool,
    pub legacy_frame_repair_installed: bool,
    pub legacy_frame_repair_last_succeeded: Option<bool>,
    pub layered: bool,
    pub no_redirection_bitmap: bool,
    pub remote_session: bool,
    pub composition_enabled: Option<bool>,
    pub accent_state: Option<i32>,
    pub system_backdrop: Option<u32>,
    pub force_active_appearance: Option<bool>,
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
        let proc = resolve_user32_proc(b"GetWindowCompositionAttribute\0");
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
        // WCA_FORCE_ACTIVEWINDOW_APPEARANCE(15) 回读；数据是单个 BOOL。
        let mut force_active_appearance = None;
        if !proc.is_null() {
            let get: SetComposition = transmute(proc);
            let mut value: i32 = 0;
            let mut data = AttributeData {
                attribute: 15,
                data: (&mut value as *mut i32).cast(),
                size: size_of::<i32>(),
            };
            if get(handle, &mut data) != 0 {
                force_active_appearance = Some(value != 0);
            }
        }
        let mut legacy_mode = 0;
        let legacy_frame_repair_installed = GetWindowSubclass(
            handle,
            legacy_composition_proc,
            LEGACY_COMPOSITION_SUBCLASS,
            &mut legacy_mode,
        ) != 0;
        let mut acrylic_data = 0;
        let acrylic_drag_handler_installed = GetWindowSubclass(
            handle,
            acrylic_drag_proc,
            ACRYLIC_DRAG_SUBCLASS,
            &mut acrylic_data,
        ) != 0;
        Some(WindowCompositionDiagnostics {
            acrylic_drag_handler_installed,
            acrylic_suspended: acrylic_drag_handler_installed && acrylic_data & 1 != 0,
            acrylic_last_operation_succeeded: acrylic_drag_handler_installed
                .then_some(acrylic_data & 2 == 0),
            acrylic_keep_on_blur: acrylic_drag_handler_installed && acrylic_data & 4 != 0,
            legacy_frame_repair_installed,
            legacy_frame_repair_last_succeeded: legacy_frame_repair_installed
                .then_some(legacy_mode & 0x100 == 0),
            layered: styles & 0x00080000 != 0,
            no_redirection_bitmap: styles & 0x00200000 != 0,
            remote_session: GetSystemMetrics(0x1000) != 0,
            composition_enabled,
            accent_state,
            system_backdrop,
            force_active_appearance,
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

/// mode: 0=off, 5=Win11 DWM clear, 6=legacy DWM clear+frame repair, 7=legacy blur+frame repair,
/// 8=old opaque-window Acrylic; 10/11=enable/clear Accent on an Electron transparent
/// window without modifying Electron's DWM alpha or frame margins;
/// 12=Accent Acrylic on a Win11 material-prepared window: clear only the system
/// backdrop, enable per-pixel alpha, then stack Accent Acrylic (keep-on-blur always on).
/// keep_on_blur 仅对 10/12 有意义：子类在失焦时切换到旧版模糊(3)，聚焦时切回。
/// tint 为 keep 模式 AccentPolicy 的 GradientColor（ABGR）；缺省沿用遗留的
/// 0x01000000（近乎透明的 tint，与旧 addon 行为一致）。
/// Modes 6/7 deliberately differ from the former legacy 4/2 protocol:
/// old addons reject them, causing an explicit fallback instead of silent failure.
#[napi]
pub fn set_window_composition(
    hwnd: String,
    mode: u32,
    keep_on_blur: Option<bool>,
    tint: Option<u32>,
) -> bool {
    if !matches!(mode, 0 | 5 | 6 | 7 | 8 | 10 | 11 | 12) {
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
        // 非 keep 路径沿用遗留 0x01000000 着色（仅 mode 8 的 accent 4 会用到）。
        let accent = |state: i32| set_accent(handle, state, 0x01000000);
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
        if matches!(mode, 10 | 11 | 12) {
            // Electron owns the alpha surface and margins of mode 10/11 windows. Never
            // reset them on entry, exit or rollback; doing so can break clear.
            if !remove_acrylic_drag(handle) {
                return false;
            }
            if mode == 11 {
                return set_accent(handle, 0, 0);
            }
            let keep = mode == 12 || keep_on_blur.unwrap_or(false);
            let tint = tint.unwrap_or(0x01000000);
            if mode == 12 {
                // Win11 material-prepared window: Electron already prepared the
                // translucent surface via setBackgroundMaterial('acrylic'); clear only
                // the system backdrop, then enable per-pixel alpha and stack Accent
                // Acrylic on top. Margins(-1) matches mode 5 and is idempotent.
                let applied = {
                    let none: u32 = 1; // DWMSBT_NONE
                    DwmSetWindowAttribute(
                        handle,
                        38,
                        (&none as *const u32).cast(),
                        size_of::<u32>() as u32,
                    ) >= 0 && margins(-1)
                        && set_alpha_composition(handle, true)
                        && set_accent(handle, 4, tint)
                };
                if applied
                    && SetWindowSubclass(
                        handle,
                        acrylic_drag_proc,
                        ACRYLIC_DRAG_SUBCLASS,
                        ((tint as usize) << 32) | 4,
                    ) != 0
                {
                    return true;
                }
                // Best-effort rollback; the backdrop stays DWMSBT_NONE like mode 5's.
                let _ = set_alpha_composition(handle, false);
                let _ = set_accent(handle, 0, 0);
                return false;
            }
            if set_accent(handle, 4, tint)
                && SetWindowSubclass(
                    handle,
                    acrylic_drag_proc,
                    ACRYLIC_DRAG_SUBCLASS,
                    if keep { ((tint as usize) << 32) | 4 } else { 0 },
                ) != 0
            {
                return true;
            }
            let _ = remove_acrylic_drag(handle);
            let _ = set_accent(handle, 0, 0);
            return false;
        }
        let success = (|| {
            if !remove_legacy_frame_repair(handle) {
                return false;
            }
            if !remove_acrylic_drag(handle) {
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
            if !margins(if matches!(mode, 0 | 8) { 0 } else { -1 }) {
                return false;
            }
            let applied = match mode {
                6 | 5 => set_alpha_composition(handle, true),
                7 => accent(3), // Retained for comparison with older releases.
                8 => accent(4),
                _ => true,
            };
            if !applied {
                return false;
            }
            if mode == 8
                && SetWindowSubclass(handle, acrylic_drag_proc, ACRYLIC_DRAG_SUBCLASS, 0) == 0
            {
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
            let _ = remove_acrylic_drag(handle);
            let _ = set_alpha_composition(handle, false);
            let _ = accent(0);
            let _ = margins(0);
        }
        success
    }
}

/// WCA_FORCE_ACTIVEWINDOW_APPEARANCE(15)：未公开的组合属性，强制 DWM 始终按激活态
/// 渲染窗口，使 Acrylic/system backdrop 在窗口失焦时不降级为灰色。数据为单个 BOOL。
#[napi]
pub fn set_window_force_active_appearance(hwnd: String, enabled: bool) -> bool {
    let Ok(address) = hwnd.parse::<usize>() else {
        return false;
    };
    let handle = address as *mut c_void;
    unsafe {
        if handle.is_null() || IsWindow(handle) == 0 {
            return false;
        }
        let proc = resolve_user32_proc(b"SetWindowCompositionAttribute\0");
        if proc.is_null() {
            return false;
        }
        let set: SetComposition = transmute(proc);
        let mut value: i32 = i32::from(enabled);
        let mut data = AttributeData {
            attribute: 15,
            data: (&mut value as *mut i32).cast(),
            size: size_of::<i32>(),
        };
        set(handle, &mut data) != 0
    }
}
