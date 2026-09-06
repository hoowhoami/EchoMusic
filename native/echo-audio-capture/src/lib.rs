mod backend;
mod buffer;
mod resample;

use backend::{
    list_input_devices as enumerate_input_devices, start_input_device, start_system, CaptureBackend,
};
use buffer::{CapturedSamples, SampleRing};
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use std::cell::RefCell;
use std::sync::{Arc, Mutex};

const DEFAULT_BUFFER_DURATION_MS: u32 = 30_000;
const MIN_BUFFER_DURATION_MS: u32 = 1_000;
const MAX_BUFFER_DURATION_MS: u32 = 300_000;

thread_local! {
    static STATE: RefCell<Option<CaptureSession>> = const { RefCell::new(None) };
}

struct CaptureSession {
    backend: CaptureBackend,
    samples: Arc<Mutex<SampleRing>>,
}

#[napi(object)]
pub struct CaptureStartOptions {
    /// `system` for global output audio or `input` for a microphone/input device.
    pub source: String,
    /// CPAL device id returned by `listInputDevices`. Omit for the default input device.
    pub device_id: Option<String>,
    pub max_buffer_duration_ms: Option<u32>,
}

#[napi(object)]
pub struct CaptureDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub sample_rate: u32,
    pub channels: u32,
}

#[napi(object)]
#[derive(Clone, Default)]
pub struct CaptureReadOptions {
    /// Read only the newest duration. Omit to read the complete retained buffer.
    pub duration_ms: Option<u32>,
    /// Output sample rate. Omit to preserve the capture rate.
    pub sample_rate: Option<u32>,
    /// Output channels. Omit to preserve the capture channel count.
    pub channels: Option<u32>,
    /// `f32le` (default) or `s16le`.
    pub sample_format: Option<String>,
}

#[napi(object)]
pub struct CaptureStatus {
    pub running: bool,
    pub source: Option<String>,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub sample_rate: u32,
    pub channels: u32,
    pub captured_frames: u32,
    pub duration_ms: u32,
    pub error: Option<String>,
}

#[napi(object)]
pub struct CapturedAudio {
    pub data: Buffer,
    pub sample_rate: u32,
    pub channels: u32,
    pub sample_format: String,
    pub frames: u32,
    pub duration_ms: u32,
    pub source_sample_rate: u32,
    pub source_channels: u32,
}

#[napi]
pub fn list_input_devices() -> napi::Result<Vec<CaptureDevice>> {
    enumerate_input_devices()
        .map(|devices| {
            devices
                .into_iter()
                .map(|device| CaptureDevice {
                    id: device.id,
                    name: device.name,
                    is_default: device.is_default,
                    sample_rate: device.sample_rate,
                    channels: device.channels.min(u32::MAX as usize) as u32,
                })
                .collect()
        })
        .map_err(napi::Error::from_reason)
}

#[napi]
pub fn start_capture(options: CaptureStartOptions) -> napi::Result<CaptureStatus> {
    STATE
        .try_with(|state| {
            let mut state = state.try_borrow_mut().map_err(|err| {
                napi::Error::from_reason(format!("failed to access audio capture state: {err}"))
            })?;
            state.take();

            let requested_duration = options
                .max_buffer_duration_ms
                .unwrap_or(DEFAULT_BUFFER_DURATION_MS);
            let max_duration_ms =
                requested_duration.clamp(MIN_BUFFER_DURATION_MS, MAX_BUFFER_DURATION_MS);
            let samples = Arc::new(Mutex::new(SampleRing::new(max_duration_ms)));
            let source = options.source.trim().to_ascii_lowercase();
            let backend = match source.as_str() {
                "system" => start_system(samples.clone()),
                "input" => start_input_device(samples.clone(), options.device_id.as_deref()),
                _ => Err(format!(
                    "unsupported audio capture source: {}",
                    options.source
                )),
            }
            .map_err(napi::Error::from_reason)?;
            let status = status_for_session(&backend, &samples)?;
            *state = Some(CaptureSession { backend, samples });
            Ok(status)
        })
        .map_err(|_| napi::Error::from_reason("audio capture state is unavailable".to_string()))?
}

/// Return a converted copy of the newest captured samples without stopping.
#[napi]
pub fn snapshot_capture(options: Option<CaptureReadOptions>) -> napi::Result<CapturedAudio> {
    STATE
        .try_with(|state| {
            let state = state.try_borrow().map_err(|err| {
                napi::Error::from_reason(format!("failed to access audio capture state: {err}"))
            })?;
            let session = state.as_ref().ok_or_else(|| {
                napi::Error::from_reason("audio capture is not running".to_string())
            })?;
            ensure_backend_healthy(&session.backend)?;
            let captured = capture_snapshot(&session.samples, options.as_ref())?;
            render_capture(captured, options.as_ref())
        })
        .map_err(|_| napi::Error::from_reason("audio capture state is unavailable".to_string()))?
}

/// Stop capture and return the retained audio in the requested output format.
#[napi]
pub fn stop_capture(options: Option<CaptureReadOptions>) -> napi::Result<CapturedAudio> {
    STATE
        .try_with(|state| {
            let session = state
                .try_borrow_mut()
                .map_err(|err| {
                    napi::Error::from_reason(format!("failed to access audio capture state: {err}"))
                })?
                .take()
                .ok_or_else(|| {
                    napi::Error::from_reason("audio capture is not running".to_string())
                })?;

            ensure_backend_healthy(&session.backend)?;
            let CaptureSession { backend, samples } = session;
            drop(backend);
            let captured = capture_snapshot(&samples, options.as_ref())?;
            render_capture(captured, options.as_ref())
        })
        .map_err(|_| napi::Error::from_reason("audio capture state is unavailable".to_string()))?
}

#[napi]
pub fn cancel_capture() -> napi::Result<()> {
    STATE
        .try_with(|state| {
            state
                .try_borrow_mut()
                .map_err(|err| {
                    napi::Error::from_reason(format!("failed to access audio capture state: {err}"))
                })?
                .take();
            Ok(())
        })
        .map_err(|_| napi::Error::from_reason("audio capture state is unavailable".to_string()))?
}

#[napi]
pub fn get_capture_status() -> napi::Result<CaptureStatus> {
    STATE
        .try_with(|state| {
            let state = state.try_borrow().map_err(|err| {
                napi::Error::from_reason(format!("failed to access audio capture state: {err}"))
            })?;
            match state.as_ref() {
                Some(session) => status_for_session(&session.backend, &session.samples),
                None => Ok(CaptureStatus {
                    running: false,
                    source: None,
                    device_id: None,
                    device_name: None,
                    sample_rate: 0,
                    channels: 0,
                    captured_frames: 0,
                    duration_ms: 0,
                    error: None,
                }),
            }
        })
        .map_err(|_| napi::Error::from_reason("audio capture state is unavailable".to_string()))?
}

fn capture_snapshot(
    samples: &Arc<Mutex<SampleRing>>,
    options: Option<&CaptureReadOptions>,
) -> napi::Result<CapturedSamples> {
    samples
        .lock()
        .map_err(|err| napi::Error::from_reason(format!("failed to read captured audio: {err}")))
        .map(|samples| samples.snapshot(options.and_then(|options| options.duration_ms)))
}

fn render_capture(
    captured: CapturedSamples,
    options: Option<&CaptureReadOptions>,
) -> napi::Result<CapturedAudio> {
    let source_sample_rate = captured.sample_rate;
    let source_channels = captured.channels;
    let converted = resample::convert(
        captured,
        options.and_then(|options| options.sample_rate),
        options.and_then(|options| options.channels),
        options.and_then(|options| options.sample_format.as_deref()),
    )
    .map_err(napi::Error::from_reason)?;
    let duration_ms = converted.frames as u64 * 1_000 / converted.sample_rate.max(1) as u64;
    Ok(CapturedAudio {
        data: Buffer::from(converted.data),
        sample_rate: converted.sample_rate,
        channels: converted.channels.min(u32::MAX as usize) as u32,
        sample_format: converted.sample_format.to_string(),
        frames: converted.frames.min(u32::MAX as usize) as u32,
        duration_ms: duration_ms.min(u32::MAX as u64) as u32,
        source_sample_rate,
        source_channels: source_channels.min(u32::MAX as usize) as u32,
    })
}

fn ensure_backend_healthy(backend: &CaptureBackend) -> napi::Result<()> {
    if let Some(error) = backend
        .last_error
        .lock()
        .ok()
        .and_then(|error| error.clone())
    {
        return Err(napi::Error::from_reason(format!(
            "audio capture failed: {error}"
        )));
    }
    Ok(())
}

fn status_for_session(
    backend: &CaptureBackend,
    samples: &Arc<Mutex<SampleRing>>,
) -> napi::Result<CaptureStatus> {
    let captured_frames = samples
        .lock()
        .map_err(|err| napi::Error::from_reason(format!("failed to read capture status: {err}")))?
        .captured_frames();
    let error = backend
        .last_error
        .lock()
        .ok()
        .and_then(|error| error.clone());
    let duration_ms = captured_frames as u64 * 1_000 / backend.sample_rate.max(1) as u64;
    Ok(CaptureStatus {
        running: error.is_none(),
        source: Some(backend.source.to_string()),
        device_id: backend.device_id.clone(),
        device_name: backend.device_name.clone(),
        sample_rate: backend.sample_rate,
        channels: backend.channels.min(u32::MAX as usize) as u32,
        captured_frames: captured_frames.min(u32::MAX as usize) as u32,
        duration_ms: duration_ms.min(u32::MAX as u64) as u32,
        error,
    })
}
