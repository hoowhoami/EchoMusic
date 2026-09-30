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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    // These tests share the process-wide callback slot, just like native callers do.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    struct CountedMessage(Arc<AtomicUsize>);

    impl From<CountedMessage> for String {
        fn from(message: CountedMessage) -> Self {
            message.0.fetch_add(1, Ordering::SeqCst);
            "native message".to_string()
        }
    }

    #[test]
    fn no_handler_drops_every_level_without_converting_the_message() {
        let _test = TEST_LOCK.lock().unwrap();
        assert!(callback_slot().lock().unwrap().is_none());
        let conversions = Arc::new(AtomicUsize::new(0));
        emit("custom", CountedMessage(conversions.clone()));
        debug(CountedMessage(conversions.clone()));
        info(CountedMessage(conversions.clone()));
        warn(CountedMessage(conversions.clone()));
        error(CountedMessage(conversions.clone()));
        assert_eq!(conversions.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn contended_callback_slot_drops_logs_without_waiting_for_the_lock() {
        let _test = TEST_LOCK.lock().unwrap();
        let guard = callback_slot().lock().unwrap();
        let conversions = Arc::new(AtomicUsize::new(0));
        let message = CountedMessage(conversions.clone());
        let (sender, receiver) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            info(message);
            sender.send(()).unwrap();
        });
        let result = receiver.recv_timeout(Duration::from_secs(2));
        // Release before asserting, so a blocking regression cannot strand the worker.
        drop(guard);
        worker.join().unwrap();
        assert!(result.is_ok(), "logging waited for the callback lock");
        assert_eq!(conversions.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn poisoned_callback_slot_drops_logs_without_panicking() {
        let _test = TEST_LOCK.lock().unwrap();
        let poisoned = std::thread::spawn(|| {
            let _guard = callback_slot().lock().unwrap();
            panic!("simulate callback registration panic");
        });
        assert!(poisoned.join().is_err());
        let conversions = Arc::new(AtomicUsize::new(0));
        let result = std::panic::catch_unwind(|| warn(CountedMessage(conversions.clone())));
        callback_slot().clear_poison();
        assert!(result.is_ok());
        assert_eq!(conversions.load(Ordering::SeqCst), 0);
    }
}
