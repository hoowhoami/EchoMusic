use crate::buffer::SampleRing;
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use crate::buffer::ToF32Sample;
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use cpal::{Device, DeviceId, SampleFormat, SupportedStreamConfig};
#[cfg(target_os = "linux")]
use std::io::Read;
#[cfg(target_os = "linux")]
use std::process::{Child, Command, Stdio};
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use std::str::FromStr;
#[cfg(target_os = "linux")]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(target_os = "linux")]
use std::thread::{self, JoinHandle};

#[cfg(target_os = "macos")]
mod macos_sck;

pub struct CaptureBackend {
    pub source: &'static str,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub sample_rate: u32,
    pub channels: usize,
    pub last_error: Arc<Mutex<Option<String>>>,
    _session: BackendSession,
}

enum BackendSession {
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    Cpal { _stream: cpal::Stream },
    #[cfg(target_os = "linux")]
    Process { _capture: ProcessCapture },
    #[cfg(target_os = "macos")]
    MacSystem { _session: macos_sck::MacSckSession },
}

pub struct CaptureDeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub sample_rate: u32,
    pub channels: usize,
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
type CpalCapture = (u32, usize, Arc<Mutex<Option<String>>>, cpal::Stream);

#[cfg(target_os = "macos")]
pub fn start_system(ring: Arc<Mutex<SampleRing>>) -> Result<CaptureBackend, String> {
    let session = macos_sck::start(ring)?;
    Ok(CaptureBackend {
        source: "system",
        device_id: None,
        device_name: Some("System Audio".to_string()),
        sample_rate: session.sample_rate,
        channels: 2,
        last_error: session.last_error.clone(),
        _session: BackendSession::MacSystem { _session: session },
    })
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
pub fn start_system(_ring: Arc<Mutex<SampleRing>>) -> Result<CaptureBackend, String> {
    Err("native system audio capture is not supported on this platform yet".to_string())
}

#[cfg(target_os = "windows")]
pub fn start_system(ring: Arc<Mutex<SampleRing>>) -> Result<CaptureBackend, String> {
    let host = cpal::default_host();
    let (device, config) = select_loopback_device(&host)?;
    let device_id = device.id().ok().map(|id| id.to_string());
    let device_name = Some(read_device_name(&device));
    let (sample_rate, channels, last_error, stream) = start_cpal_device(ring, device, config)?;
    Ok(CaptureBackend {
        source: "system",
        device_id,
        device_name,
        sample_rate,
        channels,
        last_error,
        _session: BackendSession::Cpal { _stream: stream },
    })
}

#[cfg(target_os = "linux")]
pub fn start_system(ring: Arc<Mutex<SampleRing>>) -> Result<CaptureBackend, String> {
    let host = cpal::default_host();
    let cpal_capture = select_loopback_device(&host).and_then(|(device, config)| {
        let device_id = device.id().ok().map(|id| id.to_string());
        let device_name = Some(read_device_name(&device));
        start_cpal_device(ring.clone(), device, config)
            .map(|capture| (device_id, device_name, capture))
    });
    match cpal_capture {
        Ok((device_id, device_name, (sample_rate, channels, last_error, stream))) => {
            Ok(CaptureBackend {
                source: "system",
                device_id,
                device_name,
                sample_rate,
                channels,
                last_error,
                _session: BackendSession::Cpal { _stream: stream },
            })
        }
        Err(cpal_reason) => match start_pulse_monitor_capture(ring) {
            Ok(session) => Ok(CaptureBackend {
                source: "system",
                device_id: Some(session.device_id.clone()),
                device_name: Some(session.device_id.clone()),
                sample_rate: session.sample_rate,
                channels: session.channels,
                last_error: session.last_error.clone(),
                _session: BackendSession::Process {
                    _capture: session.capture,
                },
            }),
            Err(fallback_reason) => Err(format!("{cpal_reason}; {fallback_reason}")),
        },
    }
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
pub fn start_input_device(
    ring: Arc<Mutex<SampleRing>>,
    requested_device_id: Option<&str>,
) -> Result<CaptureBackend, String> {
    let host = cpal::default_host();
    let device = resolve_input_device(&host, requested_device_id)?;
    // A default device can still be usable even when a backend cannot expose a stable ID.
    // Explicit device selection always resolves by ID before reaching this point.
    let device_id = device.id().ok().map(|id| id.to_string());
    let device_name = read_device_name(&device);
    let config = device
        .default_input_config()
        .map_err(|err| format!("failed to read input device format: {err}"))?;
    let (sample_rate, channels, last_error, stream) = start_cpal_device(ring, device, config)?;
    Ok(CaptureBackend {
        source: "input",
        device_id,
        device_name: Some(device_name),
        sample_rate,
        channels,
        last_error,
        _session: BackendSession::Cpal { _stream: stream },
    })
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
pub fn start_input_device(
    _ring: Arc<Mutex<SampleRing>>,
    _requested_device_id: Option<&str>,
) -> Result<CaptureBackend, String> {
    Err("native microphone capture is not supported on this platform yet".to_string())
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
pub fn list_input_devices() -> Result<Vec<CaptureDeviceInfo>, String> {
    let host = cpal::default_host();
    let default_id = host
        .default_input_device()
        .and_then(|device| device.id().ok());
    let devices = host
        .input_devices()
        .map_err(|err| format!("failed to enumerate input devices: {err}"))?;
    let mut result = Vec::new();

    for device in devices {
        let Ok(id) = device.id() else {
            continue;
        };
        let Ok(config) = device.default_input_config() else {
            continue;
        };
        result.push(CaptureDeviceInfo {
            is_default: default_id.as_ref() == Some(&id),
            id: id.to_string(),
            name: read_device_name(&device),
            sample_rate: config.sample_rate(),
            channels: config.channels() as usize,
        });
    }

    result.sort_by(|left, right| {
        right
            .is_default
            .cmp(&left.is_default)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(result)
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
pub fn list_input_devices() -> Result<Vec<CaptureDeviceInfo>, String> {
    Ok(Vec::new())
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn resolve_input_device(
    host: &cpal::Host,
    requested_device_id: Option<&str>,
) -> Result<Device, String> {
    let requested = requested_device_id
        .map(str::trim)
        .filter(|id| !id.is_empty() && *id != "default");
    if let Some(requested) = requested {
        let id = DeviceId::from_str(requested)
            .map_err(|err| format!("invalid input device id: {err}"))?;
        return host
            .device_by_id(&id)
            .filter(DeviceTrait::supports_input)
            .ok_or_else(|| format!("input device is no longer available: {requested}"));
    }

    host.default_input_device()
        .ok_or_else(|| "no default input device was found".to_string())
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn read_device_name(device: &Device) -> String {
    device
        .description()
        .map(|description| description.name().to_string())
        .unwrap_or_else(|_| "Unknown Audio Device".to_string())
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn start_cpal_device(
    ring: Arc<Mutex<SampleRing>>,
    device: Device,
    config: SupportedStreamConfig,
) -> Result<CpalCapture, String> {
    let sample_rate = config.sample_rate();
    let channels = config.channels();
    let sample_format = config.sample_format();
    let stream_config = config.into();
    let last_error = Arc::new(Mutex::new(None));
    let error_slot = last_error.clone();
    let err_fn = move |err: cpal::Error| {
        // CPAL reports a transient underrun/overrun as an Xrun notification while
        // keeping the stream usable. Treating it as fatal poisons an otherwise
        // successful capture when stop_capture checks the backend health later.
        if matches!(err.kind(), cpal::ErrorKind::Xrun) {
            return;
        }
        if let Ok(mut guard) = error_slot.try_lock() {
            *guard = Some(err.to_string());
        }
    };

    ring.lock()
        .map_err(|err| format!("failed to configure capture buffer: {err}"))?
        .configure(sample_rate, channels as usize)?;

    let stream = match sample_format {
        SampleFormat::F32 => build_stream::<f32>(&device, stream_config, channels, ring, err_fn),
        SampleFormat::F64 => build_stream::<f64>(&device, stream_config, channels, ring, err_fn),
        SampleFormat::I8 => build_stream::<i8>(&device, stream_config, channels, ring, err_fn),
        SampleFormat::I16 => build_stream::<i16>(&device, stream_config, channels, ring, err_fn),
        SampleFormat::I32 => build_stream::<i32>(&device, stream_config, channels, ring, err_fn),
        SampleFormat::I64 => build_stream::<i64>(&device, stream_config, channels, ring, err_fn),
        SampleFormat::U8 => build_stream::<u8>(&device, stream_config, channels, ring, err_fn),
        SampleFormat::U16 => build_stream::<u16>(&device, stream_config, channels, ring, err_fn),
        SampleFormat::U32 => build_stream::<u32>(&device, stream_config, channels, ring, err_fn),
        SampleFormat::U64 => build_stream::<u64>(&device, stream_config, channels, ring, err_fn),
        _ => Err(cpal::Error::new(cpal::ErrorKind::UnsupportedConfig)),
    }
    .map_err(|err| format!("failed to build audio capture stream: {err}"))?;

    stream
        .play()
        .map_err(|err| format!("failed to start audio capture stream: {err}"))?;

    Ok((sample_rate, channels as usize, last_error, stream))
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
        let name = read_device_name(&device);
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
        let name = read_device_name(&device);
        if name.to_ascii_lowercase().contains("monitor") {
            let config = device
                .default_input_config()
                .map_err(|err| format!("failed to read monitor input format: {err}"))?;
            return Ok((device, config));
        }
    }

    Err("no PulseAudio/PipeWire monitor input device was found".to_string())
}

#[cfg(target_os = "linux")]
struct PulseMonitorSession {
    device_id: String,
    sample_rate: u32,
    channels: usize,
    last_error: Arc<Mutex<Option<String>>>,
    capture: ProcessCapture,
}

#[cfg(target_os = "linux")]
struct ProcessCapture {
    child: Option<Child>,
    stop_flag: Arc<AtomicBool>,
    reader_thread: Option<JoinHandle<()>>,
}

#[cfg(target_os = "linux")]
impl Drop for ProcessCapture {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::Release);
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(handle) = self.reader_thread.take() {
            let _ = handle.join();
        }
    }
}

#[cfg(target_os = "linux")]
fn start_pulse_monitor_capture(
    ring: Arc<Mutex<SampleRing>>,
) -> Result<PulseMonitorSession, String> {
    const SAMPLE_RATE: u32 = 48_000;
    const CHANNELS: usize = 2;

    let source = find_pulse_monitor_source()?;
    ring.lock()
        .map_err(|err| format!("failed to configure capture buffer: {err}"))?
        .configure(SAMPLE_RATE, CHANNELS)?;
    let mut child = spawn_pulse_recorder(&source, SAMPLE_RATE, CHANNELS)?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture recorder stdout".to_string())?;
    let stop_flag = Arc::new(AtomicBool::new(false));
    let last_error = Arc::new(Mutex::new(None));
    let reader_thread = spawn_pulse_reader(
        stdout,
        ring,
        last_error.clone(),
        stop_flag.clone(),
        CHANNELS,
    );

    Ok(PulseMonitorSession {
        device_id: source,
        sample_rate: SAMPLE_RATE,
        channels: CHANNELS,
        last_error,
        capture: ProcessCapture {
            child: Some(child),
            stop_flag,
            reader_thread: Some(reader_thread),
        },
    })
}

#[cfg(target_os = "linux")]
fn find_pulse_monitor_source() -> Result<String, String> {
    if let Ok(value) = std::env::var("ECHO_MUSIC_AUDIO_CAPTURE_SOURCE")
        .or_else(|_| std::env::var("ECHO_MUSIC_SPECTRUM_SOURCE"))
    {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    let output = run_command_output(
        &["pactl", "/usr/bin/pactl", "/bin/pactl"],
        &["list", "short", "sources"],
    )?;

    for line in output.lines() {
        let mut fields = line.split_whitespace();
        let _index = fields.next();
        let Some(name) = fields.next() else {
            continue;
        };
        let lowered = name.to_ascii_lowercase();
        if lowered.ends_with(".monitor") || lowered.contains(".monitor.") {
            return Ok(name.to_string());
        }
    }

    Err("no PulseAudio/PipeWire monitor source was reported by pactl".to_string())
}

#[cfg(target_os = "linux")]
fn run_command_output(commands: &[&str], args: &[&str]) -> Result<String, String> {
    let mut errors = Vec::new();
    for command in commands {
        match Command::new(command).args(args).output() {
            Ok(output) if output.status.success() => {
                return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                errors.push(format!("{command} exited with {}: {stderr}", output.status));
            }
            Err(err) => errors.push(format!("{command}: {err}")),
        }
    }
    Err(format!("failed to run pactl: {}", errors.join("; ")))
}

#[cfg(target_os = "linux")]
fn spawn_pulse_recorder(source: &str, sample_rate: u32, channels: usize) -> Result<Child, String> {
    let rate = sample_rate.to_string();
    let channels = channels.to_string();
    let attempts = [
        ("parec", false),
        ("/usr/bin/parec", false),
        ("pacat", true),
        ("/usr/bin/pacat", true),
    ];
    let mut errors = Vec::new();
    for (command, needs_record_arg) in attempts {
        let mut process = Command::new(command);
        if needs_record_arg {
            process.arg("--record");
        }
        match process
            .arg("--raw")
            .arg("--format=s16le")
            .arg("--rate")
            .arg(&rate)
            .arg("--channels")
            .arg(&channels)
            .arg("--device")
            .arg(source)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => return Ok(child),
            Err(err) => errors.push(format!("{command}: {err}")),
        }
    }
    Err(format!(
        "failed to spawn PulseAudio/PipeWire monitor recorder for {source}: {}",
        errors.join("; ")
    ))
}

#[cfg(target_os = "linux")]
fn spawn_pulse_reader(
    mut stdout: impl Read + Send + 'static,
    ring: Arc<Mutex<SampleRing>>,
    last_error: Arc<Mutex<Option<String>>>,
    stop_flag: Arc<AtomicBool>,
    channels: usize,
) -> JoinHandle<()> {
    thread::spawn(move || {
        const BYTES_PER_SAMPLE: usize = 2;
        let frame_bytes = channels * BYTES_PER_SAMPLE;
        let mut read_buffer = [0u8; 8192];
        let mut pending = Vec::<u8>::with_capacity(frame_bytes * 2);

        while !stop_flag.load(Ordering::Acquire) {
            match stdout.read(&mut read_buffer) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&read_buffer[..n]);
                    let complete_len = pending.len() / frame_bytes * frame_bytes;
                    if complete_len == 0 {
                        continue;
                    }

                    if let Ok(mut guard) = ring.try_lock() {
                        for frame in pending[..complete_len].chunks_exact(frame_bytes) {
                            for sample in frame.chunks_exact(BYTES_PER_SAMPLE).take(channels) {
                                let value = i16::from_le_bytes([sample[0], sample[1]]);
                                guard.push(value as f32 / i16::MAX as f32);
                            }
                        }
                    }
                    pending.drain(..complete_len);
                }
                Err(err) => {
                    if !stop_flag.load(Ordering::Acquire) {
                        if let Ok(mut guard) = last_error.try_lock() {
                            *guard = Some(err.to_string());
                        }
                    }
                    break;
                }
            }
        }
    })
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn build_stream<T>(
    device: &Device,
    config: cpal::StreamConfig,
    channels: u16,
    ring: Arc<Mutex<SampleRing>>,
    err_fn: impl FnMut(cpal::Error) + Send + 'static,
) -> Result<cpal::Stream, cpal::Error>
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
