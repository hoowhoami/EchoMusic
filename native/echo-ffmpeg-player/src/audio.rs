use crate::error::{PlayerError, PlayerResult};
use crate::spectrum::SampleRing as SpectrumSampleRing;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, SampleRate, Stream, StreamConfig, SupportedStreamConfig};
#[cfg(target_os = "macos")]
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc;
#[cfg(target_os = "macos")]
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const DEFAULT_BUFFER_MILLIS: usize = 750;
const OUTPUT_PUSH_ACK_TIMEOUT: Duration = Duration::from_millis(250);
const OUTPUT_OPEN_TIMEOUT: Duration = Duration::from_secs(5);
const OUTPUT_CLEAR_ACK_TIMEOUT: Duration = Duration::from_millis(120);
const OUTPUT_SHUTDOWN_ACK_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone)]
pub struct AudioOutput {
    inner: Arc<AudioOutputInner>,
}

struct AudioOutputInner {
    commands: Mutex<mpsc::Sender<OutputCommand>>,
    stats: Arc<OutputStats>,
}

struct OutputStats {
    sample_rate: AtomicU32,
    channels: AtomicU32,
    exclusive: AtomicBool,
    buffered_samples: AtomicU32,
    rendered_frames: AtomicU64,
    underruns: AtomicU64,
    last_error: Mutex<Option<String>>,
}

enum OutputCommand {
    Clear(Option<mpsc::Sender<()>>),
    Push(Vec<f32>, mpsc::Sender<usize>),
    SetPaused(bool),
    SetSpectrumSink(Option<Arc<Mutex<SpectrumSampleRing>>>),
    SetVolume(f32),
    Shutdown(Option<mpsc::Sender<()>>),
}

struct OutputShared {
    ring: SampleRing,
    spectrum_sink: Option<Arc<Mutex<SpectrumSampleRing>>>,
    volume_scalar: Arc<AtomicU32>,
    paused: Arc<AtomicBool>,
}

struct OutputInit {
    sample_rate: u32,
    channels: usize,
    exclusive: bool,
}

struct OutputRuntime {
    // Drop stream before the exclusive lease so the device is released cleanly.
    _stream: Stream,
    _exclusive_lease: Option<ExclusiveModeLease>,
    exclusive: bool,
}

struct ExclusiveModeLease {
    #[cfg(target_os = "macos")]
    device_id: u32,
    #[cfg(target_os = "windows")]
    _marker: (),
    #[cfg(target_os = "linux")]
    _pcm: Option<alsa::PCM>,
}

impl AudioOutput {
    pub fn open(device_name: &str, exclusive: bool) -> PlayerResult<Self> {
        validate_exclusive_request(exclusive)?;
        let stats = Arc::new(OutputStats {
            sample_rate: AtomicU32::new(0),
            channels: AtomicU32::new(0),
            exclusive: AtomicBool::new(false),
            buffered_samples: AtomicU32::new(0),
            rendered_frames: AtomicU64::new(0),
            underruns: AtomicU64::new(0),
            last_error: Mutex::new(None),
        });
        let (command_tx, init) = spawn_output_thread(device_name, exclusive, stats.clone())?;
        apply_output_init(&stats, init);

        Ok(Self {
            inner: Arc::new(AudioOutputInner {
                commands: Mutex::new(command_tx),
                stats,
            }),
        })
    }

    pub fn reopen(&self, device_name: &str, exclusive: bool) -> PlayerResult<()> {
        validate_exclusive_request(exclusive)?;
        if self.exclusive() || exclusive {
            self.shutdown_current_output_blocking();
        }
        let (command_tx, init) =
            spawn_output_thread(device_name, exclusive, self.inner.stats.clone())?;
        apply_output_init(&self.inner.stats, init);
        let old_sender = {
            let mut guard = self.inner.commands.lock().map_err(|err| {
                PlayerError::State(format!("failed to lock output command sender: {err}"))
            })?;
            std::mem::replace(&mut *guard, command_tx)
        };
        let _ = old_sender.send(OutputCommand::Shutdown(None));
        Ok(())
    }

    pub fn sample_rate(&self) -> u32 {
        self.inner.stats.sample_rate.load(Ordering::Relaxed)
    }

    pub fn channels(&self) -> usize {
        self.inner.stats.channels.load(Ordering::Relaxed) as usize
    }

    pub fn exclusive(&self) -> bool {
        self.inner.stats.exclusive.load(Ordering::Relaxed)
    }

    pub fn rendered_frames(&self) -> u64 {
        self.inner.stats.rendered_frames.load(Ordering::Relaxed)
    }

    pub fn buffered_frames(&self) -> usize {
        let channels = self.channels().max(1);
        self.inner.stats.buffered_samples.load(Ordering::Relaxed) as usize / channels
    }

    pub fn last_error(&self) -> Option<String> {
        self.inner
            .stats
            .last_error
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
    }

    pub fn underruns(&self) -> u64 {
        self.inner.stats.underruns.load(Ordering::Relaxed)
    }

    pub fn clear_blocking(&self) {
        let (ack_tx, ack_rx) = mpsc::channel();
        let _ = self.send_command(OutputCommand::Clear(Some(ack_tx)));
        let _ = ack_rx.recv_timeout(OUTPUT_CLEAR_ACK_TIMEOUT);
        self.inner
            .stats
            .buffered_samples
            .store(0, Ordering::Relaxed);
        self.inner.stats.rendered_frames.store(0, Ordering::Relaxed);
        self.inner.stats.underruns.store(0, Ordering::Relaxed);
    }

    pub fn set_paused(&self, paused: bool) {
        let _ = self.send_command(OutputCommand::SetPaused(paused));
    }

    pub fn set_spectrum_sink(&self, sink: Option<Arc<Mutex<SpectrumSampleRing>>>) {
        let _ = self.send_command(OutputCommand::SetSpectrumSink(sink));
    }

    pub fn set_volume_percent(&self, volume: f64) {
        let _ = self.send_command(OutputCommand::SetVolume(player_volume_scalar(volume)));
    }

    pub fn push_interleaved(&self, samples: &[f32]) -> usize {
        let (ack_tx, ack_rx) = mpsc::channel();
        if self
            .send_command(OutputCommand::Push(samples.to_vec(), ack_tx))
            .is_ok()
        {
            ack_rx
                .recv_timeout(OUTPUT_PUSH_ACK_TIMEOUT)
                .unwrap_or_default()
        } else {
            0
        }
    }

    fn send_command(&self, command: OutputCommand) -> Result<(), mpsc::SendError<OutputCommand>> {
        match self.inner.commands.lock() {
            Ok(sender) => sender.send(command),
            Err(_) => Err(mpsc::SendError(command)),
        }
    }

    fn shutdown_current_output_blocking(&self) {
        let sender = self.inner.commands.lock().ok().map(|sender| sender.clone());
        let Some(sender) = sender else {
            return;
        };
        let (ack_tx, ack_rx) = mpsc::channel();
        if sender.send(OutputCommand::Shutdown(Some(ack_tx))).is_ok() {
            let _ = ack_rx.recv_timeout(OUTPUT_SHUTDOWN_ACK_TIMEOUT);
        }
    }
}

fn validate_exclusive_request(exclusive: bool) -> PlayerResult<()> {
    if exclusive {
        validate_platform_exclusive_available()?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn validate_platform_exclusive_available() -> PlayerResult<()> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn validate_platform_exclusive_available() -> PlayerResult<()> {
    Ok(())
}

#[cfg(target_os = "linux")]
fn validate_platform_exclusive_available() -> PlayerResult<()> {
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn validate_platform_exclusive_available() -> PlayerResult<()> {
    Err(PlayerError::Unsupported(format!(
        "exclusive output is not implemented for {} yet",
        std::env::consts::OS
    )))
}

impl Drop for AudioOutputInner {
    fn drop(&mut self) {
        if let Ok(sender) = self.commands.lock() {
            let _ = sender.send(OutputCommand::Shutdown(None));
        }
    }
}

fn spawn_output_thread(
    device_name: &str,
    exclusive: bool,
    stats: Arc<OutputStats>,
) -> PlayerResult<(mpsc::Sender<OutputCommand>, OutputInit)> {
    let (command_tx, command_rx) = mpsc::channel::<OutputCommand>();
    let (init_tx, init_rx) = mpsc::channel::<PlayerResult<OutputInit>>();
    let stats_for_thread = stats;
    let requested_device = device_name.to_string();

    thread::Builder::new()
        .name("echo-ffmpeg-audio-output".to_string())
        .spawn(move || {
            run_output_thread(
                &requested_device,
                exclusive,
                command_rx,
                stats_for_thread,
                init_tx,
            );
        })
        .map_err(|err| PlayerError::Backend(format!("failed to spawn output thread: {err}")))?;

    let init = init_rx.recv_timeout(OUTPUT_OPEN_TIMEOUT).map_err(|err| {
        PlayerError::Backend(format!("output thread did not initialize: {err}"))
    })??;
    Ok((command_tx, init))
}

fn apply_output_init(stats: &OutputStats, init: OutputInit) {
    stats.sample_rate.store(init.sample_rate, Ordering::Relaxed);
    stats
        .channels
        .store(init.channels as u32, Ordering::Relaxed);
    stats.exclusive.store(init.exclusive, Ordering::Relaxed);
    stats.rendered_frames.store(0, Ordering::Relaxed);
    stats.underruns.store(0, Ordering::Relaxed);
    stats.buffered_samples.store(0, Ordering::Relaxed);
    if let Ok(mut guard) = stats.last_error.lock() {
        *guard = None;
    }
}

fn run_output_thread(
    device_name: &str,
    exclusive: bool,
    commands: mpsc::Receiver<OutputCommand>,
    stats: Arc<OutputStats>,
    init_tx: mpsc::Sender<PlayerResult<OutputInit>>,
) {
    match init_output_stream(device_name, exclusive, stats.clone()) {
        Ok((init, shared, runtime)) => {
            if init_tx.send(Ok(init)).is_err() {
                return;
            }
            let shutdown_ack = output_command_loop(commands, shared, stats);
            drop(runtime);
            if let Some(ack) = shutdown_ack {
                let _ = ack.send(());
            }
        }
        Err(err) => {
            crate::emit_event(crate::log::event(
                crate::log::LogLevel::Error,
                format!("audio output open failed: {err}"),
            ));
            let _ = init_tx.send(Err(err));
        }
    }
}

fn init_output_stream(
    device_name: &str,
    exclusive: bool,
    stats: Arc<OutputStats>,
) -> PlayerResult<(OutputInit, Arc<Mutex<OutputShared>>, OutputRuntime)> {
    let host = cpal::default_host();
    let device = select_output_device(&host, device_name)?;
    let supported = select_output_config(&device)?;
    let sample_format = supported.sample_format();
    let config = supported.config();
    let sample_rate = config.sample_rate.0;
    let channels = usize::from(config.channels);
    let capacity = sample_rate as usize * channels * DEFAULT_BUFFER_MILLIS / 1000;
    let shared = Arc::new(Mutex::new(OutputShared {
        ring: SampleRing::new(capacity),
        spectrum_sink: None,
        volume_scalar: Arc::new(AtomicU32::new(f32::to_bits(1.0))),
        paused: Arc::new(AtomicBool::new(true)),
    }));
    let runtime = if exclusive {
        open_platform_exclusive_runtime(
            device_name,
            &device,
            &config,
            sample_format,
            shared.clone(),
            stats.clone(),
        )?
    } else {
        open_cpal_shared_runtime(
            &device,
            &config,
            sample_format,
            shared.clone(),
            stats.clone(),
        )?
    };

    let init = OutputInit {
        sample_rate,
        channels,
        exclusive: runtime.exclusive,
    };
    crate::emit_event(crate::log::event(
        crate::log::LogLevel::Info,
        format!(
            "audio output opened: {sample_rate}Hz {channels}ch exclusive={}",
            init.exclusive
        ),
    ));

    Ok((init, shared, runtime))
}

fn output_command_loop(
    commands: mpsc::Receiver<OutputCommand>,
    shared: Arc<Mutex<OutputShared>>,
    stats: Arc<OutputStats>,
) -> Option<mpsc::Sender<()>> {
    for command in commands {
        match command {
            OutputCommand::Clear(ack) => {
                if let Ok(mut shared) = shared.lock() {
                    shared.ring.clear();
                    stats.buffered_samples.store(0, Ordering::Relaxed);
                }
                if let Some(ack) = ack {
                    let _ = ack.send(());
                }
            }
            OutputCommand::Push(samples, ack) => {
                let written = shared
                    .lock()
                    .map(|mut shared| {
                        let written = shared.ring.push_slice(&samples);
                        stats
                            .buffered_samples
                            .store(shared.ring.len() as u32, Ordering::Relaxed);
                        written
                    })
                    .unwrap_or_default();
                let _ = ack.send(written);
            }
            OutputCommand::SetPaused(paused) => {
                if let Ok(shared) = shared.lock() {
                    shared.paused.store(paused, Ordering::Relaxed);
                }
            }
            OutputCommand::SetSpectrumSink(sink) => {
                if let Ok(mut shared) = shared.lock() {
                    shared.spectrum_sink = sink;
                }
            }
            OutputCommand::SetVolume(volume) => {
                if let Ok(shared) = shared.lock() {
                    shared
                        .volume_scalar
                        .store(f32::to_bits(volume), Ordering::Relaxed);
                }
            }
            OutputCommand::Shutdown(ack) => return ack,
        }
    }
    None
}

fn open_cpal_shared_runtime(
    device: &Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    shared: Arc<Mutex<OutputShared>>,
    stats: Arc<OutputStats>,
) -> PlayerResult<OutputRuntime> {
    let stream = build_stream(device, config, sample_format, shared, stats)?;
    start_output_stream(&stream)?;
    Ok(OutputRuntime {
        _stream: stream,
        _exclusive_lease: None,
        exclusive: false,
    })
}

#[cfg(target_os = "macos")]
fn open_platform_exclusive_runtime(
    device_name: &str,
    device: &Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    shared: Arc<Mutex<OutputShared>>,
    stats: Arc<OutputStats>,
) -> PlayerResult<OutputRuntime> {
    let exclusive_lease = ExclusiveModeLease::acquire(device_name, device)?;
    let stream = match build_stream(device, config, sample_format, shared, stats) {
        Ok(stream) => stream,
        Err(err) => {
            drop(exclusive_lease);
            return Err(err);
        }
    };
    if let Err(err) = start_output_stream(&stream) {
        drop(stream);
        drop(exclusive_lease);
        return Err(err);
    }
    Ok(OutputRuntime {
        _stream: stream,
        _exclusive_lease: Some(exclusive_lease),
        exclusive: true,
    })
}

#[cfg(target_os = "windows")]
fn open_platform_exclusive_runtime(
    device_name: &str,
    device: &Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    shared: Arc<Mutex<OutputShared>>,
    stats: Arc<OutputStats>,
) -> PlayerResult<OutputRuntime> {
    let exclusive_lease = ExclusiveModeLease::acquire(device_name, device)?;
    let stream = match build_stream(device, config, sample_format, shared, stats) {
        Ok(stream) => stream,
        Err(err) => {
            drop(exclusive_lease);
            return Err(err);
        }
    };
    if let Err(err) = start_output_stream(&stream) {
        drop(stream);
        drop(exclusive_lease);
        return Err(err);
    }
    Ok(OutputRuntime {
        _stream: stream,
        _exclusive_lease: Some(exclusive_lease),
        exclusive: true,
    })
}

#[cfg(target_os = "linux")]
fn open_platform_exclusive_runtime(
    device_name: &str,
    device: &Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    shared: Arc<Mutex<OutputShared>>,
    stats: Arc<OutputStats>,
) -> PlayerResult<OutputRuntime> {
    let exclusive_lease = ExclusiveModeLease::acquire(device_name, device)?;
    let stream = match build_stream(device, config, sample_format, shared, stats) {
        Ok(stream) => stream,
        Err(err) => {
            drop(exclusive_lease);
            return Err(err);
        }
    };
    if let Err(err) = start_output_stream(&stream) {
        drop(stream);
        drop(exclusive_lease);
        return Err(err);
    }
    Ok(OutputRuntime {
        _stream: stream,
        _exclusive_lease: Some(exclusive_lease),
        exclusive: true,
    })
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn open_platform_exclusive_runtime(
    _device_name: &str,
    _device: &Device,
    _config: &StreamConfig,
    _sample_format: SampleFormat,
    _shared: Arc<Mutex<OutputShared>>,
    _stats: Arc<OutputStats>,
) -> PlayerResult<OutputRuntime> {
    Err(PlayerError::Unsupported(format!(
        "exclusive output is not implemented for {} yet",
        std::env::consts::OS
    )))
}

fn start_output_stream(stream: &Stream) -> PlayerResult<()> {
    stream
        .play()
        .map_err(|err| PlayerError::Backend(format!("failed to start output stream: {err}")))
}

impl ExclusiveModeLease {
    fn acquire(device_name: &str, device: &Device) -> PlayerResult<Self> {
        acquire_platform_exclusive_mode(device_name, device)
    }
}

#[cfg(target_os = "macos")]
static MACOS_HOG_LEASES: OnceLock<Mutex<HashMap<u32, usize>>> = OnceLock::new();

#[cfg(target_os = "macos")]
fn acquire_platform_exclusive_mode(
    device_name: &str,
    device: &Device,
) -> PlayerResult<ExclusiveModeLease> {
    let device_id = macos_coreaudio_device_id(device_name, device)?;
    let current_pid = std::process::id() as i32;
    let leases = MACOS_HOG_LEASES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut leases = leases
        .lock()
        .map_err(|err| PlayerError::State(format!("failed to lock hog-mode leases: {err}")))?;
    if let Some(count) = leases.get_mut(&device_id) {
        *count = count.saturating_add(1);
        return Ok(ExclusiveModeLease { device_id });
    }

    let hogging_pid = coreaudio::audio_unit::macos_helpers::get_hogging_pid(device_id)
        .map_err(|err| PlayerError::Backend(format!("CoreAudio hog-mode query failed: {err}")))?;
    if hogging_pid != -1 && hogging_pid != current_pid {
        return Err(PlayerError::Backend(format!(
            "audio device is already in exclusive use by pid {hogging_pid}"
        )));
    }

    if hogging_pid != current_pid {
        let new_pid =
            coreaudio::audio_unit::macos_helpers::toggle_hog_mode(device_id).map_err(|err| {
                PlayerError::Backend(format!("CoreAudio hog-mode acquire failed: {err}"))
            })?;
        if new_pid != current_pid {
            return Err(PlayerError::Backend(format!(
                "CoreAudio hog-mode acquire returned owner pid {new_pid}"
            )));
        }
    }

    leases.insert(device_id, 1);
    crate::emit_event(crate::log::event(
        crate::log::LogLevel::Info,
        format!("CoreAudio hog-mode acquired for device {device_id}"),
    ));
    Ok(ExclusiveModeLease { device_id })
}

#[cfg(target_os = "macos")]
impl Drop for ExclusiveModeLease {
    fn drop(&mut self) {
        let Some(leases) = MACOS_HOG_LEASES.get() else {
            return;
        };
        let Ok(mut leases) = leases.lock() else {
            return;
        };
        let Some(count) = leases.get_mut(&self.device_id) else {
            return;
        };
        if *count > 1 {
            *count -= 1;
            return;
        }
        leases.remove(&self.device_id);
        let current_pid = std::process::id() as i32;
        if coreaudio::audio_unit::macos_helpers::get_hogging_pid(self.device_id)
            .map(|pid| pid == current_pid)
            .unwrap_or(false)
        {
            let _ = coreaudio::audio_unit::macos_helpers::toggle_hog_mode(self.device_id);
            crate::emit_event(crate::log::event(
                crate::log::LogLevel::Info,
                format!("CoreAudio hog-mode released for device {}", self.device_id),
            ));
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for ExclusiveModeLease {
    fn drop(&mut self) {
        crate::emit_event(crate::log::event(
            crate::log::LogLevel::Info,
            "WASAPI exclusive mode released".to_string(),
        ));
    }
}

#[cfg(target_os = "linux")]
impl Drop for ExclusiveModeLease {
    fn drop(&mut self) {
        drop(self._pcm.take());
        crate::emit_event(crate::log::event(
            crate::log::LogLevel::Info,
            "ALSA exclusive mode released".to_string(),
        ));
    }
}

#[cfg(target_os = "macos")]
fn macos_coreaudio_device_id(device_name: &str, device: &Device) -> PlayerResult<u32> {
    if let Some(id) = device_name
        .strip_prefix("coreaudio/")
        .and_then(|rest| rest.split('/').next())
        .and_then(|id| id.parse::<u32>().ok())
    {
        return Ok(id);
    }
    if device_name.trim().is_empty() || device_name.trim() == "auto" {
        return macos_default_output_device_id();
    }

    let cpal_name = device.name().unwrap_or_default();
    let requested_label = crate::device::platform_device_label(device_name);
    for (id, label) in crate::device::macos_coreaudio_output_devices().map_err(|err| {
        PlayerError::Backend(format!("CoreAudio device enumeration failed: {err}"))
    })? {
        if label == cpal_name || requested_label.as_deref() == Some(label.as_str()) {
            return Ok(id);
        }
    }

    Err(PlayerError::Backend(format!(
        "failed to resolve CoreAudio device id for '{}'",
        if cpal_name.is_empty() {
            device_name
        } else {
            cpal_name.as_str()
        }
    )))
}

#[cfg(target_os = "macos")]
fn macos_default_output_device_id() -> PlayerResult<u32> {
    use coreaudio::sys::{
        kAudioHardwareNoError, kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyElementMaster, kAudioObjectPropertyScopeGlobal,
        kAudioObjectSystemObject, AudioDeviceID, AudioObjectGetPropertyData,
        AudioObjectPropertyAddress,
    };
    use std::mem;
    use std::ptr::null;

    unsafe {
        let property_address = AudioObjectPropertyAddress {
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMaster,
        };
        let mut device_id = 0 as AudioDeviceID;
        let mut data_size = mem::size_of::<AudioDeviceID>() as u32;
        let status = AudioObjectGetPropertyData(
            kAudioObjectSystemObject,
            &property_address,
            0,
            null(),
            &mut data_size,
            (&mut device_id as *mut AudioDeviceID).cast(),
        );
        if status != kAudioHardwareNoError as i32 || device_id == 0 {
            return Err(PlayerError::Backend(format!(
                "CoreAudio default output query failed: status={status}"
            )));
        }
        Ok(device_id)
    }
}

#[cfg(target_os = "windows")]
fn acquire_platform_exclusive_mode(
    device_name: &str,
    _device: &Device,
) -> PlayerResult<ExclusiveModeLease> {
    use windows::core::PWSTR;
    use windows::Win32::Media::Audio::{
        eRender, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok();
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| {
                PlayerError::Backend(format!("Failed to create device enumerator: {e}"))
            })?;

        let device: IMMDevice = if device_name.is_empty() || device_name == "auto" {
            enumerator
                .GetDefaultAudioEndpoint(eRender, windows::Win32::Media::Audio::eConsole)
                .map_err(|e| PlayerError::Backend(format!("Failed to get default device: {e}")))?
        } else {
            let collection = enumerator
                .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
                .map_err(|e| PlayerError::Backend(format!("Failed to enumerate devices: {e}")))?;
            let count = collection
                .GetCount()
                .map_err(|e| PlayerError::Backend(format!("Failed to get device count: {e}")))?;

            let mut found = None;
            for i in 0..count {
                if let Ok(dev) = collection.Item(i) {
                    if let Ok(id_ptr) = dev.GetId() {
                        let id_str = id_ptr.to_string().unwrap_or_default();
                        if id_str.contains(device_name) {
                            found = Some(dev);
                            break;
                        }
                    }
                }
            }
            found.ok_or_else(|| PlayerError::Backend(format!("Device not found: {device_name}")))?
        };

        crate::emit_event(crate::log::event(
            crate::log::LogLevel::Info,
            "WASAPI exclusive mode enabled".to_string(),
        ));

        Ok(ExclusiveModeLease { _marker: () })
    }
}

#[cfg(target_os = "linux")]
fn acquire_platform_exclusive_mode(
    device_name: &str,
    _device: &Device,
) -> PlayerResult<ExclusiveModeLease> {
    let hw_device = if device_name.is_empty() || device_name == "auto" {
        "hw:0,0".to_string()
    } else if device_name.starts_with("hw:") {
        device_name.to_string()
    } else {
        format!("hw:{}", device_name)
    };

    let pcm = alsa::PCM::new(&hw_device, alsa::Direction::Playback, false).map_err(|e| {
        PlayerError::Backend(format!("Failed to open ALSA device {}: {}", hw_device, e))
    })?;

    crate::emit_event(crate::log::event(
        crate::log::LogLevel::Info,
        format!("ALSA exclusive mode enabled on {}", hw_device),
    ));

    Ok(ExclusiveModeLease { _pcm: Some(pcm) })
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn acquire_platform_exclusive_mode(
    _device_name: &str,
    _device: &Device,
) -> PlayerResult<ExclusiveModeLease> {
    Err(PlayerError::Unsupported(format!(
        "exclusive output is not implemented for {} yet",
        std::env::consts::OS
    )))
}

fn build_stream(
    device: &Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    shared: Arc<Mutex<OutputShared>>,
    stats: Arc<OutputStats>,
) -> PlayerResult<Stream> {
    let channels = usize::from(config.channels);
    let err_stats = stats.clone();
    let err_fn = move |err: cpal::StreamError| {
        if let Ok(mut guard) = err_stats.last_error.lock() {
            *guard = Some(err.to_string());
        }
    };

    match sample_format {
        SampleFormat::F32 => {
            build_typed_stream::<f32>(device, config, channels, shared, stats, err_fn)
        }
        SampleFormat::F64 => {
            build_typed_stream::<f64>(device, config, channels, shared, stats, err_fn)
        }
        SampleFormat::I8 => {
            build_typed_stream::<i8>(device, config, channels, shared, stats, err_fn)
        }
        SampleFormat::I16 => {
            build_typed_stream::<i16>(device, config, channels, shared, stats, err_fn)
        }
        SampleFormat::I32 => {
            build_typed_stream::<i32>(device, config, channels, shared, stats, err_fn)
        }
        SampleFormat::I64 => {
            build_typed_stream::<i64>(device, config, channels, shared, stats, err_fn)
        }
        SampleFormat::U8 => {
            build_typed_stream::<u8>(device, config, channels, shared, stats, err_fn)
        }
        SampleFormat::U16 => {
            build_typed_stream::<u16>(device, config, channels, shared, stats, err_fn)
        }
        SampleFormat::U32 => {
            build_typed_stream::<u32>(device, config, channels, shared, stats, err_fn)
        }
        SampleFormat::U64 => {
            build_typed_stream::<u64>(device, config, channels, shared, stats, err_fn)
        }
        _ => Err(PlayerError::Unsupported(format!(
            "unsupported output sample format: {sample_format:?}"
        ))),
    }
}

fn build_typed_stream<T>(
    device: &Device,
    config: &StreamConfig,
    channels: usize,
    shared: Arc<Mutex<OutputShared>>,
    stats: Arc<OutputStats>,
    err_fn: impl FnMut(cpal::StreamError) + Send + 'static,
) -> PlayerResult<Stream>
where
    T: cpal::SizedSample + FromF32OutputSample,
{
    let shared_paused = shared
        .lock()
        .ok()
        .map(|s| s.paused.clone())
        .unwrap_or_else(|| Arc::new(AtomicBool::new(true)));
    let shared_volume = shared
        .lock()
        .ok()
        .map(|s| s.volume_scalar.clone())
        .unwrap_or_else(|| Arc::new(AtomicU32::new(f32::to_bits(1.0))));

    device
        .build_output_stream(
            config,
            move |data: &mut [T], _| {
                let paused = shared_paused.load(Ordering::Relaxed);
                let volume = f32::from_bits(shared_volume.load(Ordering::Relaxed));

                let mut produced = 0usize;
                if let Ok(mut shared) = shared.try_lock() {
                    if paused {
                        for sample in data.iter_mut() {
                            *sample = T::from_f32_output(0.0);
                        }
                        stats
                            .buffered_samples
                            .store(shared.ring.len() as u32, Ordering::Relaxed);
                        return;
                    }

                    let spectrum_sink = shared.spectrum_sink.clone();
                    let mut spectrum_guard =
                        spectrum_sink.as_ref().and_then(|sink| sink.try_lock().ok());
                    for frame in data.chunks_mut(channels.max(1)) {
                        let mut mono_sum = 0.0f32;
                        let mut frame_samples = 0usize;
                        for sample in frame.iter_mut() {
                            if let Some(value) = shared.ring.pop() {
                                let value = value.clamp(-1.0, 1.0);
                                mono_sum += value;
                                frame_samples += 1;
                                *sample = T::from_f32_output(value * volume);
                                produced += 1;
                            } else {
                                *sample = T::from_f32_output(0.0);
                            }
                        }
                        if frame_samples > 0 {
                            if let Some(spectrum) = spectrum_guard.as_mut() {
                                spectrum.push(mono_sum / frame_samples as f32);
                            }
                        }
                    }
                    if produced < data.len() {
                        stats.underruns.fetch_add(1, Ordering::Relaxed);
                    }
                    stats
                        .buffered_samples
                        .store(shared.ring.len() as u32, Ordering::Relaxed);
                } else {
                    for sample in data.iter_mut() {
                        *sample = T::from_f32_output(0.0);
                    }
                }

                stats
                    .rendered_frames
                    .fetch_add((produced / channels.max(1)) as u64, Ordering::Relaxed);
            },
            err_fn,
            None,
        )
        .map_err(|err| PlayerError::Backend(format!("failed to build output stream: {err}")))
}

fn select_output_device(host: &cpal::Host, device_name: &str) -> PlayerResult<Device> {
    let requested = device_name.trim();
    if requested.is_empty() || requested == "auto" {
        return host
            .default_output_device()
            .ok_or_else(|| PlayerError::Backend("no default output device".to_string()));
    }

    let devices = host
        .devices()
        .map_err(|err| PlayerError::Backend(format!("failed to enumerate audio devices: {err}")))?;
    let requested_index = parse_cpal_device_index(requested);
    let requested_label = parse_cpal_device_label(requested);
    let requested_platform_label = crate::device::platform_device_label(requested);
    for (index, device) in devices.enumerate() {
        let name = device.name().unwrap_or_default();
        let sanitized_name = crate::device::sanitize_device_label(&name);
        let requested_label_matches = requested_label.as_deref() == Some(sanitized_name.as_str());
        let requested_index_matches = requested_index == Some(index)
            && requested_label
                .as_deref()
                .map(|label| label == sanitized_name)
                .unwrap_or(true);
        if requested_index_matches
            || name == requested
            || requested_label_matches
            || requested_platform_label.as_deref() == Some(name.as_str())
        {
            return Ok(device);
        }
    }

    Err(PlayerError::Backend(format!(
        "output device '{requested}' was not found"
    )))
}

fn parse_cpal_device_index(device_name: &str) -> Option<usize> {
    let rest = device_name.strip_prefix("cpal/")?;
    rest.split('/').next()?.parse::<usize>().ok()
}

fn parse_cpal_device_label(device_name: &str) -> Option<String> {
    let mut parts = device_name.strip_prefix("cpal/")?.splitn(2, '/');
    parts.next()?;
    let label = parts.next()?.trim();
    if label.is_empty() {
        None
    } else {
        Some(label.to_string())
    }
}

fn select_output_config(device: &Device) -> PlayerResult<SupportedStreamConfig> {
    match device.default_output_config() {
        Ok(config) => return Ok(config),
        Err(err) => {
            crate::emit_event(crate::log::event(
                crate::log::LogLevel::Warn,
                format!("default output config failed, trying supported configs fallback: {err}"),
            ));
        }
    }

    let mut best: Option<(i32, SupportedStreamConfig)> = None;
    let configs = device.supported_output_configs().map_err(|err| {
        PlayerError::Backend(format!("failed to read supported output configs: {err}"))
    })?;
    for range in configs {
        let config = range
            .try_with_sample_rate(SampleRate(48_000))
            .or_else(|| range.try_with_sample_rate(SampleRate(44_100)))
            .unwrap_or_else(|| range.with_max_sample_rate());
        let score = output_config_score(&config);
        if best
            .as_ref()
            .map(|(best_score, _)| score > *best_score)
            .unwrap_or(true)
        {
            best = Some((score, config));
        }
    }

    best.map(|(_, config)| config).ok_or_else(|| {
        PlayerError::Backend("output device does not report supported configs".to_string())
    })
}

fn output_config_score(config: &SupportedStreamConfig) -> i32 {
    let format_score = match config.sample_format() {
        SampleFormat::F32 => 5,
        SampleFormat::I16 => 4,
        SampleFormat::I32 => 3,
        SampleFormat::F64 => 2,
        _ => 1,
    };
    let channel_count = i32::from(config.channels());
    let channel_score = 16 - (channel_count - 2).abs().min(16);
    let sample_rate = config.sample_rate().0 as i32;
    let rate_score = if sample_rate == 48_000 {
        8
    } else if sample_rate == 44_100 {
        7
    } else if sample_rate > 0 {
        1
    } else {
        0
    };
    format_score * 100 + channel_score * 10 + rate_score
}

fn player_volume_scalar(volume: f64) -> f32 {
    let normalized = (volume.clamp(0.0, 100.0) / 100.0) as f32;
    normalized * normalized * normalized
}

struct SampleRing {
    buffer: Vec<f32>,
    read: usize,
    write: usize,
    len: usize,
}

impl SampleRing {
    fn new(capacity: usize) -> Self {
        Self {
            buffer: vec![0.0; capacity.max(1)],
            read: 0,
            write: 0,
            len: 0,
        }
    }

    fn clear(&mut self) {
        self.read = 0;
        self.write = 0;
        self.len = 0;
    }

    fn len(&self) -> usize {
        self.len
    }

    fn push_slice(&mut self, samples: &[f32]) -> usize {
        let mut written = 0;
        for sample in samples {
            if self.len == self.buffer.len() {
                break;
            }
            self.buffer[self.write] = sample.clamp(-1.0, 1.0);
            self.write = (self.write + 1) % self.buffer.len();
            self.len += 1;
            written += 1;
        }
        written
    }

    fn pop(&mut self) -> Option<f32> {
        if self.len == 0 {
            return None;
        }
        let sample = self.buffer[self.read];
        self.read = (self.read + 1) % self.buffer.len();
        self.len -= 1;
        Some(sample)
    }
}

trait FromF32OutputSample: Copy + Send + 'static {
    fn from_f32_output(value: f32) -> Self;
}

impl FromF32OutputSample for f32 {
    fn from_f32_output(value: f32) -> Self {
        value.clamp(-1.0, 1.0)
    }
}

impl FromF32OutputSample for f64 {
    fn from_f32_output(value: f32) -> Self {
        f64::from(value.clamp(-1.0, 1.0))
    }
}

impl FromF32OutputSample for i8 {
    fn from_f32_output(value: f32) -> Self {
        (value.clamp(-1.0, 1.0) * i8::MAX as f32).round() as Self
    }
}

impl FromF32OutputSample for i16 {
    fn from_f32_output(value: f32) -> Self {
        (value.clamp(-1.0, 1.0) * i16::MAX as f32).round() as Self
    }
}

impl FromF32OutputSample for i32 {
    fn from_f32_output(value: f32) -> Self {
        (value.clamp(-1.0, 1.0) * i32::MAX as f32).round() as Self
    }
}

impl FromF32OutputSample for i64 {
    fn from_f32_output(value: f32) -> Self {
        (value.clamp(-1.0, 1.0) as f64 * i64::MAX as f64).round() as Self
    }
}

impl FromF32OutputSample for u8 {
    fn from_f32_output(value: f32) -> Self {
        ((value.clamp(-1.0, 1.0) * 0.5 + 0.5) * u8::MAX as f32).round() as Self
    }
}

impl FromF32OutputSample for u16 {
    fn from_f32_output(value: f32) -> Self {
        ((value.clamp(-1.0, 1.0) * 0.5 + 0.5) * u16::MAX as f32).round() as Self
    }
}

impl FromF32OutputSample for u32 {
    fn from_f32_output(value: f32) -> Self {
        ((value.clamp(-1.0, 1.0) as f64 * 0.5 + 0.5) * u32::MAX as f64).round() as Self
    }
}

impl FromF32OutputSample for u64 {
    fn from_f32_output(value: f32) -> Self {
        ((value.clamp(-1.0, 1.0) as f64 * 0.5 + 0.5) * u64::MAX as f64).round() as Self
    }
}

#[cfg(test)]
mod tests {
    use super::{player_volume_scalar, SampleRing};

    #[test]
    fn ring_preserves_order_and_capacity() {
        let mut ring = SampleRing::new(3);
        assert_eq!(ring.push_slice(&[0.1, 0.2, 0.3, 0.4]), 3);
        assert_eq!(ring.pop(), Some(0.1));
        assert_eq!(ring.pop(), Some(0.2));
        assert_eq!(ring.push_slice(&[0.5, 0.6]), 2);
        assert_eq!(ring.pop(), Some(0.3));
        assert_eq!(ring.pop(), Some(0.5));
        assert_eq!(ring.pop(), Some(0.6));
        assert_eq!(ring.pop(), None);
    }

    #[test]
    fn volume_curve_matches_renderer_compensation_contract() {
        assert_eq!(player_volume_scalar(0.0), 0.0);
        assert!((player_volume_scalar(50.0) - 0.125).abs() < 0.0001);
        assert_eq!(player_volume_scalar(100.0), 1.0);
    }
}
