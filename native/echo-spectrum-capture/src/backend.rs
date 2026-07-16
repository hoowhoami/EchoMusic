use crate::dsp::SampleRing;
#[cfg(any(target_os = "windows", target_os = "linux"))]
use crate::dsp::ToF32Sample;
#[cfg(any(target_os = "windows", target_os = "linux"))]
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
#[cfg(any(target_os = "windows", target_os = "linux"))]
use cpal::{Device, SampleFormat, SupportedStreamConfig};
#[cfg(target_os = "linux")]
use std::io::Read;
#[cfg(target_os = "linux")]
use std::process::{Child, Command, Stdio};
#[cfg(target_os = "linux")]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(target_os = "linux")]
use std::thread::{self, JoinHandle};

#[cfg(target_os = "macos")]
mod macos_sck;

pub struct CaptureBackend {
    pub sample_rate: u32,
    pub last_error: Arc<Mutex<Option<String>>>,
    #[cfg(target_os = "windows")]
    _stream: cpal::Stream,
    #[cfg(target_os = "linux")]
    _linux_session: LinuxCaptureSession,
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

#[cfg(target_os = "windows")]
pub fn start_loopback(ring: Arc<Mutex<SampleRing>>) -> Result<CaptureBackend, String> {
    let (sample_rate, last_error, stream) = start_cpal_loopback(ring)?;
    Ok(CaptureBackend {
        sample_rate,
        last_error,
        _stream: stream,
    })
}

#[cfg(target_os = "linux")]
pub fn start_loopback(ring: Arc<Mutex<SampleRing>>) -> Result<CaptureBackend, String> {
    match start_cpal_loopback(ring.clone()) {
        Ok((sample_rate, last_error, stream)) => Ok(CaptureBackend {
            sample_rate,
            last_error,
            _linux_session: LinuxCaptureSession::Cpal(stream),
        }),
        Err(cpal_reason) => match start_pulse_monitor_capture(ring) {
            Ok(session) => Ok(CaptureBackend {
                sample_rate: session.sample_rate,
                last_error: session.last_error.clone(),
                _linux_session: LinuxCaptureSession::Process(session.capture),
            }),
            Err(fallback_reason) => Err(format!("{cpal_reason}; {fallback_reason}")),
        },
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn start_cpal_loopback(
    ring: Arc<Mutex<SampleRing>>,
) -> Result<(u32, Arc<Mutex<Option<String>>>, cpal::Stream), String> {
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

    Ok((sample_rate, last_error, stream))
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

#[cfg(target_os = "linux")]
enum LinuxCaptureSession {
    Cpal(cpal::Stream),
    Process(ProcessCapture),
}

#[cfg(target_os = "linux")]
struct PulseMonitorSession {
    sample_rate: u32,
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
        sample_rate: SAMPLE_RATE,
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
    if let Ok(value) = std::env::var("ECHO_MUSIC_SPECTRUM_SOURCE") {
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
                            let mut mono = 0.0f32;
                            for sample in frame.chunks_exact(BYTES_PER_SAMPLE).take(channels) {
                                let value = i16::from_le_bytes([sample[0], sample[1]]);
                                mono += value as f32 / i16::MAX as f32;
                            }
                            guard.push(mono / channels as f32);
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
