mod cpal_shared;

#[cfg(target_os = "windows")]
mod wasapi_exclusive;

#[cfg(target_os = "windows")]
pub(crate) use cpal_shared::fill_output;
pub use cpal_shared::spawn_output_thread;
