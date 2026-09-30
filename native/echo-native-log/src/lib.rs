//! Shared native-to-main-process logging bridge for EchoMusic native modules.

#![deny(unsafe_code)]

use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::{Arc, Mutex, OnceLock};

pub type NativeLogCallback = ThreadsafeFunction<NativeLogEntry>;

static LOG_CALLBACK: OnceLock<Mutex<Option<Arc<NativeLogCallback>>>> = OnceLock::new();

fn callback_slot() -> &'static Mutex<Option<Arc<NativeLogCallback>>> {
    LOG_CALLBACK.get_or_init(|| Mutex::new(None))
}

#[napi(object)]
pub struct NativeLogEntry {
    pub level: String,
    pub message: String,
}

pub fn set_log_handler(callback: NativeLogCallback) -> napi::Result<()> {
    let mut guard = callback_slot()
        .lock()
        .map_err(|err| napi::Error::from_reason(format!("native 日志回调锁定失败: {err}")))?;
    *guard = Some(Arc::new(callback));
    Ok(())
}

pub fn emit(level: &str, message: impl Into<String>) {
    let callback = callback_slot()
        .try_lock()
        .ok()
        .and_then(|guard| guard.as_ref().cloned());
    if let Some(callback) = callback {
        let _ = callback.call(
            Ok(NativeLogEntry {
                level: level.to_string(),
                message: message.into(),
            }),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    }
}

pub fn info(message: impl Into<String>) {
    emit("info", message);
}

pub fn debug(message: impl Into<String>) {
    emit("debug", message);
}

pub fn warn(message: impl Into<String>) {
    emit("warn", message);
}

pub fn error(message: impl Into<String>) {
    emit("error", message);
}
