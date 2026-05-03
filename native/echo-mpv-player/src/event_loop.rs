// 事件轮询线程

use crate::mpv_ffi::*;
use crate::types::*;
use crate::player::MpvPlayer;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use std::ffi::CStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

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

                let event_ref = unsafe { &*event };
                match event_ref.event_id {
                    MPV_EVENT_NONE => continue,
                    MPV_EVENT_SHUTDOWN => break,
                    MPV_EVENT_PROPERTY_CHANGE => {
                        if event_ref.data.is_null() {
                            continue;
                        }
                        let prop =
                            unsafe { &*(event_ref.data as *const MpvEventProperty) };
                        handle_property_change(prop, &state, &callback);
                    }
                    MPV_EVENT_END_FILE => {
                        let reason = if event_ref.data.is_null() {
                            "eof"
                        } else {
                            let end_file =
                                unsafe { &*(event_ref.data as *const MpvEventEndFile) };
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
                        if let Ok(mut s) = state.lock() {
                            s.idle = false;
                        }
                        call_callback(&callback, PlayerEvent::file_loaded());
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

/// 通过 Arc<Mutex> 包装的回调发送事件
fn call_callback(
    callback: &Arc<Mutex<ThreadsafeFunction<PlayerEvent>>>,
    event: PlayerEvent,
) {
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
            let devices = MpvPlayer::parse_audio_device_list_json(prop)
                .unwrap_or_default();
            call_callback(callback, PlayerEvent::audio_device_list_changed(devices));
        }
        _ => {}
    }
}
