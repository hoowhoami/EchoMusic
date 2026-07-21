mod cpal_shared;

use std::sync::mpsc::SyncSender;

#[cfg(target_os = "linux")]
pub(crate) mod alsa_exclusive;

#[cfg(target_os = "macos")]
mod coreaudio_exclusive;

#[cfg(target_os = "windows")]
mod wasapi_exclusive;

#[cfg(target_os = "windows")]
pub(crate) use cpal_shared::fill_output;
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) use cpal_shared::fill_output_reusing;
pub use cpal_shared::spawn_output_thread;
pub(crate) use cpal_shared::spawn_output_thread_with_start_notify;

pub(crate) type OutputStartSender = SyncSender<Result<(), String>>;

pub(crate) fn report_output_start(
    start_notify: &mut Option<OutputStartSender>,
    result: Result<(), String>,
) {
    if let Some(sender) = start_notify.take() {
        let _ = sender.send(result);
    }
}
