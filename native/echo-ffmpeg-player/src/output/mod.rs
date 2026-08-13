mod cpal_shared;

use crate::events::{PlayerErrorCode, PlayerEvent};
use crate::shared::{AudioOutputStats, AudioSampleFormat, SharedAudio};
use std::sync::mpsc::SyncSender;
use std::sync::Arc;
use std::thread::JoinHandle;

#[cfg(target_os = "linux")]
pub(crate) mod alsa_exclusive;

#[cfg(target_os = "macos")]
mod coreaudio_exclusive;

#[cfg(target_os = "windows")]
mod wasapi;

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) use cpal_shared::fill_output_reusing;

pub(crate) type OutputStartSender = SyncSender<Result<(), String>>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AudioOutputCapability {
    pub backend: &'static str,
    pub exclusive: bool,
    pub sample_rate: u32,
    pub channels: usize,
    pub negotiated_format: &'static str,
    pub sample_formats: Vec<&'static str>,
}

pub trait AudioOutputBackend: Send {
    fn backend_name(&self) -> &'static str;
    fn exclusive(&self) -> bool;

    /// The sample format the backend will use for its audio stream.
    /// Returns `F32` by default; most backends prefer float internally.
    /// Override to report a different negotiated format (e.g. when the device
    /// does not support float).
    fn negotiated_format(&self, _shared: &SharedAudio) -> AudioSampleFormat {
        AudioSampleFormat::F32
    }

    fn capability(&self, shared: &SharedAudio) -> AudioOutputCapability;
    fn spawn(
        self: Box<Self>,
        shared: Arc<SharedAudio>,
        emit: fn(PlayerEvent),
        start_notify: Option<OutputStartSender>,
    ) -> JoinHandle<()>;
}

#[derive(Clone, Debug)]
pub struct SelectedAudioOutputBackend {
    device_name: String,
    exclusive: bool,
}

impl SelectedAudioOutputBackend {
    pub fn new(device_name: String, exclusive: bool) -> Self {
        Self {
            device_name,
            exclusive,
        }
    }
}

impl AudioOutputBackend for SelectedAudioOutputBackend {
    fn backend_name(&self) -> &'static str {
        selected_backend_name(self.exclusive)
    }

    fn exclusive(&self) -> bool {
        self.exclusive
    }

    fn capability(&self, shared: &SharedAudio) -> AudioOutputCapability {
        AudioOutputCapability {
            backend: self.backend_name(),
            exclusive: self.exclusive,
            sample_rate: shared.mix_format.sample_rate,
            channels: shared.mix_format.channels,
            negotiated_format: sample_format_name(self.negotiated_format(shared)),
            sample_formats: shared
                .preferred_output_sample_format()
                .best_output_formats()
                .into_iter()
                .map(sample_format_name)
                .collect(),
        }
    }

    fn spawn(
        self: Box<Self>,
        shared: Arc<SharedAudio>,
        emit: fn(PlayerEvent),
        start_notify: Option<OutputStartSender>,
    ) -> JoinHandle<()> {
        spawn_selected_backend(self.device_name, self.exclusive, shared, emit, start_notify)
    }
}

pub(crate) fn spawn_output_backend(
    device_name: String,
    exclusive: bool,
    shared: Arc<SharedAudio>,
    emit: fn(PlayerEvent),
    start_notify: Option<OutputStartSender>,
) -> JoinHandle<()> {
    let backend: Box<dyn AudioOutputBackend> =
        Box::new(SelectedAudioOutputBackend::new(device_name, exclusive));
    let selected_exclusive = backend.exclusive();
    let capability = backend.capability(&shared);
    emit(PlayerEvent::log(
        "info",
        format!(
            "audio output backend selected: backend={}, exclusive={}, engine_sample_rate={}, engine_channels={}, negotiated_format={}, sample_formats={}",
            capability.backend,
            selected_exclusive,
            capability.sample_rate,
            capability.channels,
            capability.negotiated_format,
            capability.sample_formats.join(",")
        ),
    ));
    backend.spawn(shared, emit, start_notify)
}

pub(crate) fn build_output_stats(
    backend: &str,
    shared: &SharedAudio,
    sample_rate: u32,
    channels: usize,
    format: String,
    buffer_mode: String,
    buffer_frames: f64,
    device_buffer_secs: f64,
) -> AudioOutputStats {
    shared.register_output_device_buffer(buffer_frames.max(0.0).round() as u32, sample_rate);
    let requested_buffer_secs = shared.requested_output_buffer_secs().max(0.0);
    let device_buffer_secs = device_buffer_secs.max(0.0);
    let ao_buffer_target_secs = shared.output_buffer_target_secs();
    let software_buffer_secs = (ao_buffer_target_secs - device_buffer_secs).max(0.0);
    AudioOutputStats {
        backend: backend.to_string(),
        sample_rate: f64::from(sample_rate.max(1)),
        engine_sample_rate: f64::from(shared.mix_format.sample_rate),
        channels: channels.max(1) as f64,
        format,
        buffer_mode,
        buffer_frames,
        buffer_secs: device_buffer_secs,
        requested_buffer_secs,
        device_buffer_secs,
        software_buffer_secs,
        ao_buffer_target_secs,
        ao_buffer_capacity_secs: shared.output_ring_capacity_secs(),
        ao_request_frames: shared.max_output_request_frames() as f64,
        delay_secs: ao_buffer_target_secs.max(device_buffer_secs),
        underruns: 0.0,
    }
}

pub(crate) fn output_buffer_mode_for_frames(frames: u32) -> String {
    if frames == 0 {
        "host_controlled".to_string()
    } else {
        format!("fixed({frames})")
    }
}

pub(crate) fn is_disconnect_recovery_reason(reason: &str) -> bool {
    reason == "device-not-available" || reason == "stream-invalidated"
}

pub(crate) fn emit_output_runtime_error(
    shared: &SharedAudio,
    emit: fn(PlayerEvent),
    error_code: PlayerErrorCode,
    message: String,
) {
    shared.request_output_stop();
    if shared.should_pause_on_device_disconnect() {
        emit(PlayerEvent::error_with_reason(
            PlayerErrorCode::OutputRuntime,
            message,
            "device-not-available",
        ));
    } else {
        emit(PlayerEvent::error(error_code, message));
    }
}

fn selected_backend_name(exclusive: bool) -> &'static str {
    #[cfg(target_os = "windows")]
    {
        let _ = exclusive;
        "wasapi"
    }
    #[cfg(target_os = "linux")]
    {
        if exclusive {
            "alsa"
        } else {
            "cpal"
        }
    }
    #[cfg(target_os = "macos")]
    {
        if exclusive {
            "coreaudio"
        } else {
            "cpal"
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = exclusive;
        "cpal"
    }
}

fn sample_format_name(format: crate::shared::AudioSampleFormat) -> &'static str {
    match format {
        crate::shared::AudioSampleFormat::Unknown => "unknown",
        crate::shared::AudioSampleFormat::U8 => "u8",
        crate::shared::AudioSampleFormat::S16 => "s16",
        crate::shared::AudioSampleFormat::S32 => "s32",
        crate::shared::AudioSampleFormat::F32 => "f32",
        crate::shared::AudioSampleFormat::F64 => "f64",
    }
}

fn spawn_selected_backend(
    device_name: String,
    exclusive: bool,
    shared: Arc<SharedAudio>,
    emit: fn(PlayerEvent),
    start_notify: Option<OutputStartSender>,
) -> JoinHandle<()> {
    #[cfg(target_os = "windows")]
    {
        return wasapi::spawn_output_thread(device_name, exclusive, shared, emit, start_notify);
    }
    #[cfg(target_os = "linux")]
    {
        if exclusive {
            return alsa_exclusive::spawn_output_thread(device_name, shared, emit, start_notify);
        }
        return cpal_shared::spawn_shared_output_thread(
            device_name,
            exclusive,
            shared,
            emit,
            start_notify,
        );
    }
    #[cfg(target_os = "macos")]
    {
        if exclusive {
            return coreaudio_exclusive::spawn_output_thread(
                device_name,
                shared,
                emit,
                start_notify,
            );
        }
        return cpal_shared::spawn_shared_output_thread(
            device_name,
            exclusive,
            shared,
            emit,
            start_notify,
        );
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        cpal_shared::spawn_shared_output_thread(device_name, exclusive, shared, emit, start_notify)
    }
}

pub(crate) fn report_output_start(
    start_notify: &mut Option<OutputStartSender>,
    result: Result<(), String>,
) {
    if let Some(sender) = start_notify.take() {
        let _ = sender.send(result);
    }
}

pub(crate) fn report_output_start_failure(
    start_notify: &mut Option<OutputStartSender>,
    message: String,
) -> bool {
    let was_starting = start_notify.is_some();
    report_output_start(start_notify, Err(message));
    was_starting
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::DspSettings;
    use crate::shared::MixFormat;

    #[test]
    fn selected_backend_reports_engine_capability_through_trait() {
        let shared = Arc::new(SharedAudio::new(
            MixFormat::stereo_f32(48_000),
            0.2,
            1.0,
            &DspSettings::default(),
        ));
        let backend = SelectedAudioOutputBackend::new("auto".to_string(), false);
        let capability = backend.capability(&shared);

        assert_eq!(capability.backend, selected_backend_name(false));
        assert!(!capability.exclusive);
        assert_eq!(capability.sample_rate, 48_000);
        assert_eq!(capability.channels, 2);
        assert_eq!(capability.negotiated_format, "f32");
        assert_eq!(capability.sample_formats[0], "s16");
    }

    #[test]
    fn output_stats_split_device_and_software_buffer_delay() {
        let shared = Arc::new(SharedAudio::new(
            MixFormat::stereo_f32(48_000),
            0.2,
            1.0,
            &DspSettings::default(),
        ));

        let stats = build_output_stats(
            "test",
            &shared,
            48_000,
            2,
            "f32".to_string(),
            "fixed(2400)".to_string(),
            2400.0,
            0.05,
        );

        assert_eq!(stats.requested_buffer_secs, 0.2);
        assert_eq!(stats.buffer_mode, "fixed(2400)");
        assert_eq!(stats.device_buffer_secs, 0.05);
        assert!((stats.software_buffer_secs - 0.15).abs() < f64::EPSILON);
        assert_eq!(stats.delay_secs, 0.2);
    }
}
