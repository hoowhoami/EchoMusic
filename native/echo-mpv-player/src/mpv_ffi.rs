// libmpv C API 的 FFI 声明
// 通过 libloading 运行时动态加载，不需要编译时链接

use std::os::raw::{c_char, c_int, c_void};

// mpv_handle 不透明指针
pub enum MpvHandle {}

// mpv_format 枚举
pub const MPV_FORMAT_NONE: c_int = 0;
pub const MPV_FORMAT_STRING: c_int = 1;
pub const MPV_FORMAT_OSD_STRING: c_int = 2;
pub const MPV_FORMAT_FLAG: c_int = 3;
pub const MPV_FORMAT_INT64: c_int = 4;
pub const MPV_FORMAT_DOUBLE: c_int = 5;
pub const MPV_FORMAT_NODE: c_int = 6;

// mpv_event_id 枚举
pub const MPV_EVENT_NONE: c_int = 0;
pub const MPV_EVENT_SHUTDOWN: c_int = 1;
#[allow(dead_code)]
pub const MPV_EVENT_LOG_MESSAGE: c_int = 2;
#[allow(dead_code)]
pub const MPV_EVENT_GET_PROPERTY_REPLY: c_int = 3;
#[allow(dead_code)]
pub const MPV_EVENT_SET_PROPERTY_REPLY: c_int = 4;
#[allow(dead_code)]
pub const MPV_EVENT_COMMAND_REPLY: c_int = 5;
#[allow(dead_code)]
pub const MPV_EVENT_START_FILE: c_int = 6;
pub const MPV_EVENT_END_FILE: c_int = 7;
pub const MPV_EVENT_FILE_LOADED: c_int = 8;
pub const MPV_EVENT_IDLE: c_int = 11;
#[allow(dead_code)]
pub const MPV_EVENT_TICK: c_int = 14;
pub const MPV_EVENT_PROPERTY_CHANGE: c_int = 22;

// mpv_end_file_reason 枚举
pub const MPV_END_FILE_REASON_EOF: c_int = 0;
pub const MPV_END_FILE_REASON_STOP: c_int = 2;
pub const MPV_END_FILE_REASON_ERROR: c_int = 4;

// mpv_event 结构体
#[repr(C)]
pub struct MpvEvent {
    pub event_id: c_int,
    pub error: c_int,
    pub reply_userdata: u64,
    pub data: *mut c_void,
}

// mpv_event_property 结构体
#[repr(C)]
pub struct MpvEventProperty {
    pub name: *const c_char,
    pub format: c_int,
    pub data: *mut c_void,
}

// mpv_event_end_file 结构体
#[repr(C)]
pub struct MpvEventEndFile {
    pub reason: c_int,
    pub error: c_int,
}

// mpv_node 及相关结构体（用于解析 track-list、audio-device-list 等复杂属性）
#[repr(C)]
pub struct MpvNode {
    pub u: MpvNodeUnion,
    pub format: c_int,
}

#[repr(C)]
pub union MpvNodeUnion {
    pub string: *const c_char,
    pub flag: c_int,
    pub int64: i64,
    pub double: f64,
    pub list: *mut MpvNodeList,
}

#[repr(C)]
pub struct MpvNodeList {
    pub num: c_int,
    pub values: *mut MpvNode,
    pub keys: *mut *mut c_char,
}

// 动态加载的 libmpv 函数表
pub struct MpvLib {
    pub _lib: libloading::Library,
    pub mpv_create:
        libloading::Symbol<'static, unsafe extern "C" fn() -> *mut MpvHandle>,
    pub mpv_initialize:
        libloading::Symbol<'static, unsafe extern "C" fn(*mut MpvHandle) -> c_int>,
    pub mpv_terminate_destroy:
        libloading::Symbol<'static, unsafe extern "C" fn(*mut MpvHandle)>,
    pub mpv_command:
        libloading::Symbol<'static, unsafe extern "C" fn(*mut MpvHandle, *const *const c_char) -> c_int>,
    #[allow(dead_code)]
    pub mpv_command_string:
        libloading::Symbol<'static, unsafe extern "C" fn(*mut MpvHandle, *const c_char) -> c_int>,
    pub mpv_set_property:
        libloading::Symbol<'static, unsafe extern "C" fn(*mut MpvHandle, *const c_char, c_int, *mut c_void) -> c_int>,
    pub mpv_set_property_string:
        libloading::Symbol<'static, unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> c_int>,
    pub mpv_get_property:
        libloading::Symbol<'static, unsafe extern "C" fn(*mut MpvHandle, *const c_char, c_int, *mut c_void) -> c_int>,
    pub mpv_get_property_string:
        libloading::Symbol<'static, unsafe extern "C" fn(*mut MpvHandle, *const c_char) -> *mut c_char>,
    pub mpv_set_option_string:
        libloading::Symbol<'static, unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> c_int>,
    pub mpv_observe_property:
        libloading::Symbol<'static, unsafe extern "C" fn(*mut MpvHandle, u64, *const c_char, c_int) -> c_int>,
    pub mpv_wait_event:
        libloading::Symbol<'static, unsafe extern "C" fn(*mut MpvHandle, f64) -> *mut MpvEvent>,
    pub mpv_free:
        libloading::Symbol<'static, unsafe extern "C" fn(*mut c_void)>,
    pub mpv_free_node_contents:
        libloading::Symbol<'static, unsafe extern "C" fn(*mut MpvNode)>,
    pub mpv_wakeup:
        libloading::Symbol<'static, unsafe extern "C" fn(*mut MpvHandle)>,
    pub mpv_error_string:
        libloading::Symbol<'static, unsafe extern "C" fn(c_int) -> *const c_char>,
}

impl MpvLib {
    /// 运行时加载 libmpv 动态库
    pub unsafe fn load(lib_path: &str) -> Result<Self, String> {
        #[cfg(target_os = "linux")]
        let lib: libloading::Library = {
            use libloading::os::unix::Library as UnixLibrary;
            // RTLD_NOW = 0x2, RTLD_DEEPBIND = 0x8
            // 使用 RTLD_DEEPBIND 优先使用 libmpv 自身的依赖库（如 libavcodec），
            // 防止与 Electron 进程中已加载的、裁剪版的 libffmpeg 发生符号冲突，从而导致网络流无法播放。
            UnixLibrary::open(Some(lib_path), 0x2 | 0x8)
                .map_err(|e| format!("failed to load libmpv with DEEPBIND: {e}"))?
                .into()
        };

        #[cfg(not(target_os = "linux"))]
        let lib: libloading::Library = libloading::Library::new(lib_path)
            .map_err(|e| format!("failed to load libmpv: {e}"))?;

        // 使用 transmute 延长 Symbol 生命周期，因为 Library 和 Symbol 存储在同一结构体中
        // Library 不会在 Symbol 之前被释放
        macro_rules! load_fn {
            ($name:ident, $ty:ty) => {{
                let sym: libloading::Symbol<$ty> = lib.get(stringify!($name).as_bytes())
                    .map_err(|e| format!("failed to load symbol {}: {e}", stringify!($name)))?;
                std::mem::transmute(sym)
            }};
        }

        Ok(Self {
            mpv_create: load_fn!(mpv_create, unsafe extern "C" fn() -> *mut MpvHandle),
            mpv_initialize: load_fn!(mpv_initialize, unsafe extern "C" fn(*mut MpvHandle) -> c_int),
            mpv_terminate_destroy: load_fn!(mpv_terminate_destroy, unsafe extern "C" fn(*mut MpvHandle)),
            mpv_command: load_fn!(mpv_command, unsafe extern "C" fn(*mut MpvHandle, *const *const c_char) -> c_int),
            mpv_command_string: load_fn!(mpv_command_string, unsafe extern "C" fn(*mut MpvHandle, *const c_char) -> c_int),
            mpv_set_property: load_fn!(mpv_set_property, unsafe extern "C" fn(*mut MpvHandle, *const c_char, c_int, *mut c_void) -> c_int),
            mpv_set_property_string: load_fn!(mpv_set_property_string, unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> c_int),
            mpv_get_property: load_fn!(mpv_get_property, unsafe extern "C" fn(*mut MpvHandle, *const c_char, c_int, *mut c_void) -> c_int),
            mpv_get_property_string: load_fn!(mpv_get_property_string, unsafe extern "C" fn(*mut MpvHandle, *const c_char) -> *mut c_char),
            mpv_set_option_string: load_fn!(mpv_set_option_string, unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> c_int),
            mpv_observe_property: load_fn!(mpv_observe_property, unsafe extern "C" fn(*mut MpvHandle, u64, *const c_char, c_int) -> c_int),
            mpv_wait_event: load_fn!(mpv_wait_event, unsafe extern "C" fn(*mut MpvHandle, f64) -> *mut MpvEvent),
            mpv_free: load_fn!(mpv_free, unsafe extern "C" fn(*mut c_void)),
            mpv_free_node_contents: load_fn!(mpv_free_node_contents, unsafe extern "C" fn(*mut MpvNode)),
            mpv_wakeup: load_fn!(mpv_wakeup, unsafe extern "C" fn(*mut MpvHandle)),
            mpv_error_string: load_fn!(mpv_error_string, unsafe extern "C" fn(c_int) -> *const c_char),
            _lib: lib,
        })
    }
}
