// 事件轮询线程

use crate::mpv_ffi::*;
use crate::player::MpvPlayer;
use crate::take_pending_load;
use crate::types::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use std::ffi::{CStr, CString};
use std::os::raw::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

/// 解码相关的高频噪声日志前缀：坏帧/解码错误（如从 CDN 流式拉取的 FLAC 字节错位）会逐帧上报，
/// 这类日志诊断价值低、却可能成簇爆发并逐条经 ThreadsafeFunction 派发到主进程。
/// 直接在事件线程按前缀丢弃，根本不跨线程，避免给主进程添负担。
const NOISE_LOG_PREFIXES: &[&str] = &["ffmpeg/audio", "ad"];

/// 包装裸指针使其可以跨线程传递
/// libmpv 文档保证 mpv_handle 的线程安全性
struct SendPtr(usize);
unsafe impl Send for SendPtr {}

/// 启动事件轮询线程
pub fn start_event_loop(
    lib: Arc<MpvLib>,
    handle: *mut MpvHandle,
    state: Arc<Mutex<PlayerState>>,
    shutdown: Arc<AtomicBool>,
    callback: Arc<Mutex<ThreadsafeFunction<PlayerEvent>>>,
) -> JoinHandle<()> {
    // 将裸指针转为 usize 以绕过 Send 限制
    let handle_addr = SendPtr(handle as usize);

    std::thread::Builder::new()
        .name("mpv-event-loop".to_string())
        .spawn(move || {
            let handle = handle_addr.0 as *mut MpvHandle;
            loop {
                if shutdown.load(Ordering::SeqCst) {
                    break;
                }

                // 阻塞等待事件，超时 0.5 秒
                let event = unsafe { (lib.mpv_wait_event)(handle, 0.5) };
                if event.is_null() {
                    continue;
                }
                if shutdown.load(Ordering::SeqCst) {
                    break;
                }

                let event_ref = unsafe { &*event };
                match event_ref.event_id {
                    MPV_EVENT_NONE => continue,
                    MPV_EVENT_SHUTDOWN => break,
                    MPV_EVENT_PROPERTY_CHANGE => {
                        if event_ref.data.is_null() {
                            continue;
                        }
                        let prop = unsafe { &*(event_ref.data as *const MpvEventProperty) };
                        handle_property_change(prop, &state, &callback);
                    }
                    MPV_EVENT_LOG_MESSAGE => {
                        if event_ref.data.is_null() {
                            continue;
                        }
                        let message = unsafe { &*(event_ref.data as *const MpvEventLogMessage) };
                        handle_log_message(message, &callback);
                    }
                    MPV_EVENT_END_FILE => {
                        let reason = if event_ref.data.is_null() {
                            "eof"
                        } else {
                            let end_file = unsafe { &*(event_ref.data as *const MpvEventEndFile) };
                            match end_file.reason {
                                MPV_END_FILE_REASON_EOF => "eof",
                                MPV_END_FILE_REASON_STOP => "stop",
                                MPV_END_FILE_REASON_ERROR => "error",
                                _ => "unknown",
                            }
                        };
                        if let Ok(mut s) = state.lock() {
                            s.playing = false;
                            s.paused = true;
                        }
                        call_callback(&callback, PlayerEvent::playback_end(reason));
                    }
                    MPV_EVENT_FILE_LOADED => {
                        let loaded_path = get_string_property(&lib, handle, "path");
                        let pending = take_pending_load(&loaded_path);
                        let path = pending
                            .as_ref()
                            .map(|load| load.path.clone())
                            .filter(|path| !path.is_empty())
                            .unwrap_or_else(|| loaded_path.clone());
                        if let Ok(mut s) = state.lock() {
                            s.idle = false;
                            if !path.is_empty() {
                                s.path = path.clone();
                            }
                        }
                        let seq = pending.map(|load| load.seq).unwrap_or(0);
                        call_callback(&callback, PlayerEvent::file_loaded(seq, path));
                    }
                    MPV_EVENT_IDLE => {
                        if let Ok(mut s) = state.lock() {
                            s.idle = true;
                        }
                        call_callback(&callback, PlayerEvent::idle());
                    }
                    _ => {}
                }
            }
        })
        .expect("failed to spawn mpv event loop thread")
}

fn read_c_string(ptr: *const std::os::raw::c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(ptr).to_string_lossy().trim().to_string() }
}

fn get_string_property(lib: &MpvLib, handle: *mut MpvHandle, name: &str) -> String {
    let c_name = match CString::new(name) {
        Ok(value) => value,
        Err(_) => return String::new(),
    };
    let ptr = unsafe { (lib.mpv_get_property_string)(handle, c_name.as_ptr()) };
    if ptr.is_null() {
        return String::new();
    }
    let value = unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() };
    unsafe { (lib.mpv_free)(ptr as *mut c_void) };
    value
}

fn handle_log_message(
    message: &MpvEventLogMessage,
    callback: &Arc<Mutex<ThreadsafeFunction<PlayerEvent>>>,
) {
    let prefix = read_c_string(message.prefix);
    // 解码噪声（坏帧/解码错误）直接在事件线程丢弃，不跨线程到主进程
    if NOISE_LOG_PREFIXES.contains(&prefix.as_str()) {
        return;
    }
    let level = read_c_string(message.level);
    let text = read_c_string(message.text);
    if text.is_empty() {
        return;
    }
    call_callback(callback, PlayerEvent::log_message(prefix, level, text));
}

/// 通过 Arc<Mutex> 包装的回调发送事件
fn call_callback(callback: &Arc<Mutex<ThreadsafeFunction<PlayerEvent>>>, event: PlayerEvent) {
    if let Ok(cb) = callback.lock() {
        cb.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

/// 处理属性变更事件
fn handle_property_change(
    prop: &MpvEventProperty,
    state: &Arc<Mutex<PlayerState>>,
    callback: &Arc<Mutex<ThreadsafeFunction<PlayerEvent>>>,
) {
    if prop.name.is_null() || prop.data.is_null() {
        return;
    }

    let name = unsafe { CStr::from_ptr(prop.name).to_string_lossy() };

    match name.as_ref() {
        "time-pos" => {
            if prop.format == MPV_FORMAT_DOUBLE {
                let value = unsafe { *(prop.data as *const f64) };
                if let Ok(mut s) = state.lock() {
                    s.time_pos = value;
                }
                call_callback(callback, PlayerEvent::time_update(value));
            }
        }
        "duration" => {
            if prop.format == MPV_FORMAT_DOUBLE {
                let value = unsafe { *(prop.data as *const f64) };
                if let Ok(mut s) = state.lock() {
                    s.duration = value;
                }
                call_callback(callback, PlayerEvent::duration_change(value));
            }
        }
        "pause" => {
            if prop.format == MPV_FORMAT_FLAG {
                let flag = unsafe { *(prop.data as *const i32) };
                let paused = flag != 0;
                if let Ok(mut s) = state.lock() {
                    s.paused = paused;
                    s.playing = !paused;
                }
                call_callback(callback, PlayerEvent::state_change(paused));
            }
        }
        "volume" => {
            if prop.format == MPV_FORMAT_DOUBLE {
                let value = unsafe { *(prop.data as *const f64) };
                if let Ok(mut s) = state.lock() {
                    s.volume = value;
                }
            }
        }
        "speed" => {
            if prop.format == MPV_FORMAT_DOUBLE {
                let value = unsafe { *(prop.data as *const f64) };
                if let Ok(mut s) = state.lock() {
                    s.speed = value;
                }
            }
        }
        "audio-device-list" => {
            // 设备列表变化，解析属性节点中的设备列表一并发送
            let devices = MpvPlayer::parse_audio_device_list_json(prop).unwrap_or_default();
            call_callback(callback, PlayerEvent::audio_device_list_changed(devices));
        }
        _ => {}
    }
}
