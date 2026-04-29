// MpvPlayer 核心实现

use crate::mpv_ffi::*;
use crate::types::*;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// 淡入淡出请求
#[allow(dead_code)]
pub struct FadeRequest {
    pub from: f64,
    pub to: f64,
    pub duration_ms: u64,
    pub seq: u64,
}

pub struct MpvPlayer {
    lib: Arc<MpvLib>,
    handle: *mut MpvHandle,
    // 淡入淡出控制
    fade_seq: Arc<AtomicU64>,
    fade_active: Arc<AtomicBool>,
    // 状态
    state: Arc<Mutex<PlayerState>>,
    // 事件线程停止标志
    shutdown: Arc<AtomicBool>,
}

// MpvHandle 指针在线程间传递是安全的（libmpv 文档保证线程安全）
unsafe impl Send for MpvPlayer {}
unsafe impl Sync for MpvPlayer {}

impl MpvPlayer {
    /// 创建并初始化 libmpv 播放器
    pub unsafe fn new(lib: Arc<MpvLib>) -> Result<Self, String> {
        let handle = (lib.mpv_create)();
        if handle.is_null() {
            return Err("mpv_create returned null".to_string());
        }

        let player = Self {
            lib,
            handle,
            fade_seq: Arc::new(AtomicU64::new(0)),
            fade_active: Arc::new(AtomicBool::new(false)),
            state: Arc::new(Mutex::new(PlayerState::default())),
            shutdown: Arc::new(AtomicBool::new(false)),
        };

        // 设置初始化选项（必须在 mpv_initialize 之前）
        player.set_option("idle", "yes");
        player.set_option("pause", "yes");
        player.set_option("video", "no");
        player.set_option("terminal", "no");
        player.set_option("config", "no");
        player.set_option("volume", "100");
        player.set_option("audio-display", "no");
        player.set_option("hr-seek", "yes");
        player.set_option("volume-max", "100");
        player.set_option("demuxer-max-bytes", "50MiB");
        player.set_option("demuxer-max-back-bytes", "10MiB");
        player.set_option("cache", "yes");
        player.set_option("cache-secs", "30");
        player.set_option("user-agent", "Mozilla/5.0");
        player.set_option("input-media-keys", "no");
        player.set_option("audio-client-name", "EchoMusic");
        player.set_option("audio-samplerate", "0");
        player.set_option("audio-channels", "stereo");

        let rc = (player.lib.mpv_initialize)(player.handle);
        if rc < 0 {
            let err_str = player.error_string(rc);
            (player.lib.mpv_terminate_destroy)(player.handle);
            return Err(format!("mpv_initialize failed: {err_str}"));
        }

        // 注册属性观察
        player.observe_property("time-pos", MPV_FORMAT_DOUBLE);
        player.observe_property("duration", MPV_FORMAT_DOUBLE);
        player.observe_property("pause", MPV_FORMAT_FLAG);
        player.observe_property("volume", MPV_FORMAT_DOUBLE);
        player.observe_property("speed", MPV_FORMAT_DOUBLE);
        player.observe_property("eof-reached", MPV_FORMAT_FLAG);
        player.observe_property("idle-active", MPV_FORMAT_FLAG);

        Ok(player)
    }

    // ── 内部辅助方法 ──

    fn set_option(&self, name: &str, value: &str) {
        let c_name = CString::new(name).unwrap();
        let c_value = CString::new(value).unwrap();
        unsafe {
            (self.lib.mpv_set_option_string)(self.handle, c_name.as_ptr(), c_value.as_ptr());
        }
    }

    fn observe_property(&self, name: &str, format: c_int) {
        let c_name = CString::new(name).unwrap();
        unsafe {
            (self.lib.mpv_observe_property)(self.handle, 0, c_name.as_ptr(), format);
        }
    }

    fn error_string(&self, code: c_int) -> String {
        unsafe {
            let ptr = (self.lib.mpv_error_string)(code);
            if ptr.is_null() {
                return format!("error code {code}");
            }
            CStr::from_ptr(ptr).to_string_lossy().into_owned()
        }
    }

    /// 执行 mpv 命令（如 loadfile、stop、seek 等）
    fn command(&self, args: &[&str]) -> Result<(), String> {
        let c_args: Vec<CString> = args.iter().map(|s| CString::new(*s).unwrap()).collect();
        let mut ptrs: Vec<*const c_char> = c_args.iter().map(|s| s.as_ptr()).collect();
        ptrs.push(std::ptr::null());

        let rc = unsafe { (self.lib.mpv_command)(self.handle, ptrs.as_ptr()) };
        if rc < 0 {
            Err(format!("mpv command {:?} failed: {}", args, self.error_string(rc)))
        } else {
            Ok(())
        }
    }

    /// 设置字符串属性
    fn set_property_string(&self, name: &str, value: &str) -> Result<(), String> {
        let c_name = CString::new(name).unwrap();
        let c_value = CString::new(value).unwrap();
        let rc = unsafe {
            (self.lib.mpv_set_property_string)(self.handle, c_name.as_ptr(), c_value.as_ptr())
        };
        if rc < 0 {
            Err(format!("failed to set property {name}={value}: {}", self.error_string(rc)))
        } else {
            Ok(())
        }
    }

    /// 设置 double 属性
    fn set_property_double(&self, name: &str, value: f64) -> Result<(), String> {
        let c_name = CString::new(name).unwrap();
        let mut val = value;
        let rc = unsafe {
            (self.lib.mpv_set_property)(
                self.handle,
                c_name.as_ptr(),
                MPV_FORMAT_DOUBLE,
                &mut val as *mut f64 as *mut c_void,
            )
        };
        if rc < 0 {
            Err(format!("failed to set property {name}={value}: {}", self.error_string(rc)))
        } else {
            Ok(())
        }
    }

    /// 设置 flag 属性
    fn set_property_flag(&self, name: &str, value: bool) -> Result<(), String> {
        let c_name = CString::new(name).unwrap();
        let mut val: c_int = if value { 1 } else { 0 };
        let rc = unsafe {
            (self.lib.mpv_set_property)(
                self.handle,
                c_name.as_ptr(),
                MPV_FORMAT_FLAG,
                &mut val as *mut c_int as *mut c_void,
            )
        };
        if rc < 0 {
            Err(format!("failed to set property {name}={value}: {}", self.error_string(rc)))
        } else {
            Ok(())
        }
    }

    /// 获取 double 属性
    #[allow(dead_code)]
    fn get_property_double(&self, name: &str) -> Result<f64, String> {
        let c_name = CString::new(name).unwrap();
        let mut val: f64 = 0.0;
        let rc = unsafe {
            (self.lib.mpv_get_property)(
                self.handle,
                c_name.as_ptr(),
                MPV_FORMAT_DOUBLE,
                &mut val as *mut f64 as *mut c_void,
            )
        };
        if rc < 0 {
            Err(format!("failed to get property {name}: {}", self.error_string(rc)))
        } else {
            Ok(val)
        }
    }

    /// 获取字符串属性
    fn get_property_string(&self, name: &str) -> Result<String, String> {
        let c_name = CString::new(name).unwrap();
        let ptr = unsafe { (self.lib.mpv_get_property_string)(self.handle, c_name.as_ptr()) };
        if ptr.is_null() {
            return Err(format!("failed to get property {name}: returned null"));
        }
        let result = unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() };
        unsafe { (self.lib.mpv_free)(ptr as *mut c_void) };
        Ok(result)
    }

    /// 获取 node 属性（用于 track-list、audio-device-list 等复杂类型）
    fn get_property_node(&self, name: &str) -> Result<MpvNodeOwned, String> {
        let c_name = CString::new(name).unwrap();
        let mut node = std::mem::MaybeUninit::<MpvNode>::uninit();
        let rc = unsafe {
            (self.lib.mpv_get_property)(
                self.handle,
                c_name.as_ptr(),
                MPV_FORMAT_NODE,
                node.as_mut_ptr() as *mut c_void,
            )
        };
        if rc < 0 {
            return Err(format!("failed to get property {name}: {}", self.error_string(rc)));
        }
        let node = unsafe { node.assume_init() };
        let owned = unsafe { parse_mpv_node(&node) };
        unsafe { (self.lib.mpv_free_node_contents)(&node as *const MpvNode as *mut MpvNode) };
        Ok(owned)
    }

    // ── 公开 API ──

    pub fn handle_ptr(&self) -> *mut MpvHandle {
        self.handle
    }

    pub fn lib(&self) -> &Arc<MpvLib> {
        &self.lib
    }

    pub fn state(&self) -> &Arc<Mutex<PlayerState>> {
        &self.state
    }

    pub fn shutdown_flag(&self) -> &Arc<AtomicBool> {
        &self.shutdown
    }

    #[allow(dead_code)]
    pub fn fade_seq(&self) -> &Arc<AtomicU64> {
        &self.fade_seq
    }

    pub fn fade_active(&self) -> &Arc<AtomicBool> {
        &self.fade_active
    }

    /// 加载音频文件
    pub fn load_file(&self, url: &str) -> Result<(), String> {
        if let Ok(mut s) = self.state.lock() {
            s.path = url.to_string();
            s.idle = true;
        }
        self.command(&["loadfile", url, "replace"])
    }

    /// 加载 MKV 并选择音轨（先加载文件，音轨在 file-loaded 事件后由 JS 侧设置）
    pub fn load_mkv_track(&self, url: &str, track_id: i64) -> Result<(), String> {
        if let Ok(mut s) = self.state.lock() {
            s.path = url.to_string();
            s.idle = true;
        }
        self.command(&["loadfile", url, "replace"])?;
        // 音轨 ID 需要在文件加载后设置，这里先记录
        // 实际设置由 TypeScript 层在收到 file-loaded 事件后调用 set_property
        let _ = track_id; // 由 TS 层处理
        Ok(())
    }

    /// 获取音轨列表
    pub fn get_track_list(&self) -> Result<Vec<TrackInfo>, String> {
        let node = self.get_property_node("track-list")?;
        let mut tracks = Vec::new();
        if let MpvNodeOwned::Array(items) = node {
            for item in items {
                if let MpvNodeOwned::Map(map) = item {
                    let id = map.iter()
                        .find(|(k, _)| k == "id")
                        .and_then(|(_, v)| v.as_i64())
                        .unwrap_or(0);
                    let track_type = map.iter()
                        .find(|(k, _)| k == "type")
                        .and_then(|(_, v)| v.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let codec = map.iter()
                        .find(|(k, _)| k == "codec")
                        .and_then(|(_, v)| v.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let title = map.iter()
                        .find(|(k, _)| k == "title")
                        .and_then(|(_, v)| v.as_str())
                        .map(|s| s.to_string());
                    let lang = map.iter()
                        .find(|(k, _)| k == "lang")
                        .and_then(|(_, v)| v.as_str())
                        .map(|s| s.to_string());
                    tracks.push(TrackInfo { id, r#type: track_type, codec, title, lang });
                }
            }
        }
        Ok(tracks)
    }

    /// 播放
    pub fn play(&self) -> Result<(), String> {
        self.set_property_flag("pause", false)
    }

    /// 暂停
    pub fn pause(&self) -> Result<(), String> {
        self.set_property_flag("pause", true)
    }

    /// 停止
    pub fn stop(&self) -> Result<(), String> {
        let result = self.command(&["stop"]);
        if let Ok(mut s) = self.state.lock() {
            s.playing = false;
            s.paused = true;
            s.time_pos = 0.0;
            s.duration = 0.0;
            s.path.clear();
        }
        // stop 在 idle 状态下可能失败，忽略
        result.or(Ok(()))
    }

    /// 跳转（秒）
    pub fn seek(&self, time: f64) -> Result<(), String> {
        self.command(&["seek", &time.to_string(), "absolute"])
    }

    /// 设置音量（0-100）
    pub fn set_volume(&self, volume: f64) -> Result<(), String> {
        let v = volume.clamp(0.0, 100.0);
        self.set_property_double("volume", v)?;
        if let Ok(mut s) = self.state.lock() {
            s.volume = v;
        }
        Ok(())
    }

    /// 设置播放速度
    pub fn set_speed(&self, speed: f64) -> Result<(), String> {
        let s = speed.clamp(0.1, 5.0);
        self.set_property_double("speed", s)?;
        if let Ok(mut state) = self.state.lock() {
            state.speed = s;
        }
        Ok(())
    }

    /// 设置音频输出设备
    pub fn set_audio_device(&self, device_name: &str) -> Result<(), String> {
        self.set_property_string("audio-device", device_name)?;
        if let Ok(mut s) = self.state.lock() {
            s.audio_device = device_name.to_string();
        }
        Ok(())
    }

    /// 获取音频设备列表
    pub fn get_audio_devices(&self) -> Result<Vec<AudioDevice>, String> {
        let node = self.get_property_node("audio-device-list")?;
        let mut devices = Vec::new();
        if let MpvNodeOwned::Array(items) = node {
            for item in items {
                if let MpvNodeOwned::Map(map) = item {
                    let name = map.iter()
                        .find(|(k, _)| k == "name")
                        .and_then(|(_, v)| v.as_str())
                        .unwrap_or("auto")
                        .to_string();
                    let description = map.iter()
                        .find(|(k, _)| k == "description")
                        .and_then(|(_, v)| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    devices.push(AudioDevice { name, description });
                }
            }
        }
        Ok(devices)
    }

    /// 设置音频滤镜
    pub fn set_audio_filter(&self, filter: &str) -> Result<(), String> {
        self.set_property_string("af", filter)
    }

    /// 设置音量均衡增益
    pub fn set_normalization_gain(&self, gain_db: f64) -> Result<(), String> {
        // 优先使用 volume-gain 属性
        match self.set_property_double("volume-gain", gain_db) {
            Ok(()) => Ok(()),
            Err(_) => {
                // 旧版 mpv 不支持 volume-gain，回退到 af 滤镜
                if gain_db == 0.0 {
                    self.set_audio_filter("")
                } else {
                    self.set_audio_filter(&format!("lavfi=[volume={gain_db}dB]"))
                }
            }
        }
    }

    /// 设置独占模式
    pub fn set_exclusive(&self, exclusive: bool) -> Result<(), String> {
        // 先停止当前播放
        let _ = self.stop();
        let value = if exclusive { "yes" } else { "no" };
        self.set_property_string("audio-exclusive", value)?;
        // 强制重新初始化音频输出
        if let Ok(device) = self.get_property_string("audio-device") {
            let _ = self.set_property_string("audio-device", &device);
        }
        Ok(())
    }

    /// 设置 force-media-title
    pub fn set_media_title(&self, title: &str) -> Result<(), String> {
        self.set_property_string("force-media-title", title)
    }

    /// 设置文件循环模式
    pub fn set_loop_file(&self, value: &str) -> Result<(), String> {
        self.set_property_string("loop-file", value)
    }

    /// 设置音轨 ID
    pub fn set_audio_track(&self, track_id: i64) -> Result<(), String> {
        let c_name = CString::new("aid").unwrap();
        let mut val = track_id;
        let rc = unsafe {
            (self.lib.mpv_set_property)(
                self.handle,
                c_name.as_ptr(),
                MPV_FORMAT_INT64,
                &mut val as *mut i64 as *mut c_void,
            )
        };
        if rc < 0 {
            Err(format!("failed to set audio track {track_id}: {}", self.error_string(rc)))
        } else {
            Ok(())
        }
    }

    /// 获取当前状态快照
    pub fn get_state(&self) -> PlayerState {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 获取任意属性（返回字符串）
    pub fn get_property(&self, name: &str) -> Result<String, String> {
        self.get_property_string(name)
    }

    // ── 淡入淡出（方案 B：Rust 侧实现） ──

    /// 启动淡入淡出，返回序列号
    pub fn start_fade(&self, _from: f64, _to: f64, _duration_ms: u64) -> u64 {
        // 取消之前的 fade
        self.cancel_fade();

        let seq = self.fade_seq.fetch_add(1, Ordering::SeqCst) + 1;
        self.fade_active.store(true, Ordering::SeqCst);

        seq
    }

    /// 取消当前淡入淡出
    pub fn cancel_fade(&self) {
        self.fade_seq.fetch_add(1, Ordering::SeqCst);
        self.fade_active.store(false, Ordering::SeqCst);
    }

    /// 在当前线程执行淡入淡出（由 fade 线程调用）
    pub fn execute_fade(&self, from: f64, to: f64, duration_ms: u64, seq: u64) -> bool {
        if duration_ms == 0 {
            let _ = self.set_volume(to);
            self.fade_active.store(false, Ordering::SeqCst);
            return true;
        }

        let steps = (duration_ms / 16).max(1) as usize;
        let step_duration = std::time::Duration::from_millis(duration_ms / steps as u64);
        let diff = to - from;

        for i in 1..=steps {
            // 检查是否被取消
            if self.fade_seq.load(Ordering::SeqCst) != seq {
                return false;
            }

            let progress = i as f64 / steps as f64;
            // ease-out-quad 缓动
            let eased = 1.0 - (1.0 - progress).powi(2);
            let current = from + diff * eased;
            let _ = self.set_property_double("volume", current.clamp(0.0, 100.0));

            if i < steps {
                std::thread::sleep(step_duration);
            }
        }

        // 确保最终值精确
        let _ = self.set_property_double("volume", to.clamp(0.0, 100.0));
        self.fade_active.store(false, Ordering::SeqCst);
        true
    }

    /// 销毁播放器
    pub fn destroy(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
        self.cancel_fade();
        unsafe {
            (self.lib.mpv_terminate_destroy)(self.handle);
        }
    }
}

// ── mpv_node 解析 ──

/// Rust 侧的 mpv_node 所有权类型
#[derive(Debug)]
pub enum MpvNodeOwned {
    None,
    String(String),
    Flag(#[allow(dead_code)] bool),
    Int64(i64),
    Double(f64),
    Array(Vec<MpvNodeOwned>),
    Map(Vec<(String, MpvNodeOwned)>),
}

impl MpvNodeOwned {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            MpvNodeOwned::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            MpvNodeOwned::Int64(v) => Some(*v),
            MpvNodeOwned::Double(v) => Some(*v as i64),
            _ => None,
        }
    }

    #[allow(dead_code)]
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            MpvNodeOwned::Double(v) => Some(*v),
            MpvNodeOwned::Int64(v) => Some(*v as f64),
            _ => None,
        }
    }
}

/// 递归解析 mpv_node 为 Rust 所有权类型
unsafe fn parse_mpv_node(node: &MpvNode) -> MpvNodeOwned {
    match node.format {
        MPV_FORMAT_NONE => MpvNodeOwned::None,
        MPV_FORMAT_STRING | MPV_FORMAT_OSD_STRING => {
            let ptr = node.u.string;
            if ptr.is_null() {
                MpvNodeOwned::String(String::new())
            } else {
                MpvNodeOwned::String(CStr::from_ptr(ptr).to_string_lossy().into_owned())
            }
        }
        MPV_FORMAT_FLAG => MpvNodeOwned::Flag(node.u.flag != 0),
        MPV_FORMAT_INT64 => MpvNodeOwned::Int64(node.u.int64),
        MPV_FORMAT_DOUBLE => MpvNodeOwned::Double(node.u.double),
        MPV_FORMAT_NODE => {
            let list = node.u.list;
            if list.is_null() {
                return MpvNodeOwned::None;
            }
            let list_ref = &*list;
            let num = list_ref.num as usize;

            if list_ref.keys.is_null() {
                // 数组
                let mut arr = Vec::with_capacity(num);
                for i in 0..num {
                    arr.push(parse_mpv_node(&*list_ref.values.add(i)));
                }
                MpvNodeOwned::Array(arr)
            } else {
                // 字典
                let mut map = Vec::with_capacity(num);
                for i in 0..num {
                    let key_ptr = *list_ref.keys.add(i);
                    let key = if key_ptr.is_null() {
                        String::new()
                    } else {
                        CStr::from_ptr(key_ptr).to_string_lossy().into_owned()
                    };
                    let value = parse_mpv_node(&*list_ref.values.add(i));
                    map.push((key, value));
                }
                MpvNodeOwned::Map(map)
            }
        }
        _ => MpvNodeOwned::None,
    }
}
