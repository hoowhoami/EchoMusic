use crate::dsp::SampleRing;
#[cfg(any(target_os = "windows", target_os = "linux"))]
use crate::dsp::ToF32Sample;
#[cfg(any(target_os = "windows", target_os = "linux"))]
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
#[cfg(any(target_os = "windows", target_os = "linux"))]
use cpal::{Device, SampleFormat, SupportedStreamConfig};
use std::sync::{Arc, Mutex};

#[cfg(target_os = "macos")]
mod macos_sck;

pub struct CaptureBackend {
    pub sample_rate: u32,
    pub last_error: Arc<Mutex<Option<String>>>,
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    _stream: cpal::Stream,
    #[cfg(target_os = "macos")]
    _mac_session: Option<macos_sck::MacSckSession>,
}

#[cfg(target_os = "macos")]
pub fn start_loopback(ring: Arc<Mutex<SampleRing>>) -> Result<CaptureBackend, String> {
    let session = macos_sck::start(ring)?;
    Ok(CaptureBackend {
        sample_rate: session.sample_rate,
        last_error: session.last_error.clone(),
        _mac_session: Some(session),
    })
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
pub fn start_loopback(_ring: Arc<Mutex<SampleRing>>) -> Result<CaptureBackend, String> {
    Err("native system audio capture is not supported on this platform yet".to_string())
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub fn start_loopback(ring: Arc<Mutex<SampleRing>>) -> Result<CaptureBackend, String> {
    let host = cpal::default_host();
    let (device, config) = select_loopback_device(&host)?;
    let sample_rate = config.sample_rate().0;
    let channels = config.channels();
    let sample_format = config.sample_format();
    let stream_config = config.into();
    let last_error = Arc::new(Mutex::new(None));
    let error_slot = last_error.clone();
    let err_fn = move |err: cpal::StreamError| {
        if let Ok(mut guard) = error_slot.try_lock() {
            *guard = Some(err.to_string());
        }
    };

    let stream = match sample_format {
        SampleFormat::F32 => build_stream::<f32>(&device, &stream_config, channels, ring, err_fn),
        SampleFormat::F64 => build_stream::<f64>(&device, &stream_config, channels, ring, err_fn),
        SampleFormat::I8 => build_stream::<i8>(&device, &stream_config, channels, ring, err_fn),
        SampleFormat::I16 => build_stream::<i16>(&device, &stream_config, channels, ring, err_fn),
        SampleFormat::I32 => build_stream::<i32>(&device, &stream_config, channels, ring, err_fn),
        SampleFormat::I64 => build_stream::<i64>(&device, &stream_config, channels, ring, err_fn),
        SampleFormat::U8 => build_stream::<u8>(&device, &stream_config, channels, ring, err_fn),
        SampleFormat::U16 => build_stream::<u16>(&device, &stream_config, channels, ring, err_fn),
        SampleFormat::U32 => build_stream::<u32>(&device, &stream_config, channels, ring, err_fn),
        SampleFormat::U64 => build_stream::<u64>(&device, &stream_config, channels, ring, err_fn),
        _ => Err(cpal::BuildStreamError::StreamConfigNotSupported),
    }
    .map_err(|err| format!("failed to build loopback stream: {err}"))?;

    stream
        .play()
        .map_err(|err| format!("failed to start loopback stream: {err}"))?;

    Ok(CaptureBackend {
        sample_rate,
        last_error,
        _stream: stream,
    })
}

#[cfg(target_os = "windows")]
fn select_loopback_device(host: &cpal::Host) -> Result<(Device, SupportedStreamConfig), String> {
    let device = host
        .default_output_device()
        .ok_or_else(|| "no default output device for WASAPI loopback".to_string())?;
    let config = device
        .default_output_config()
        .map_err(|err| format!("failed to read output mix format: {err}"))?;
    Ok((device, config))
}

#[cfg(target_os = "linux")]
fn select_loopback_device(host: &cpal::Host) -> Result<(Device, SupportedStreamConfig), String> {
    let devices = host
        .input_devices()
        .map_err(|err| format!("failed to enumerate input devices: {err}"))?;
    let mut fallback: Option<Device> = None;

    for device in devices {
        let name = device.name().unwrap_or_default();
        let lowered = name.to_ascii_lowercase();
        if lowered.contains("monitor")
            || lowered.contains(".monitor")
            || lowered.contains("loopback")
            || lowered.contains("stereo mix")
        {
            let config = device
                .default_input_config()
                .map_err(|err| format!("failed to read monitor input format: {err}"))?;
            return Ok((device, config));
        }
        if fallback.is_none() {
            fallback = Some(device);
        }
    }

    if let Some(device) = fallback {
        let name = device.name().unwrap_or_default();
        if name.to_ascii_lowercase().contains("monitor") {
            let config = device
                .default_input_config()
                .map_err(|err| format!("failed to read monitor input format: {err}"))?;
            return Ok((device, config));
        }
    }

    Err("no PulseAudio/PipeWire monitor input device was found".to_string())
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn build_stream<T>(
    device: &Device,
    config: &cpal::StreamConfig,
    channels: u16,
    ring: Arc<Mutex<SampleRing>>,
    err_fn: impl FnMut(cpal::StreamError) + Send + 'static,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: cpal::SizedSample + ToF32Sample,
{
    let channel_count = channels as usize;
    device.build_input_stream(
        config,
        move |data: &[T], _| {
            if let Ok(mut guard) = ring.try_lock() {
                guard.push_interleaved(data, channel_count);
            }
        },
        err_fn,
        None,
    )
}
