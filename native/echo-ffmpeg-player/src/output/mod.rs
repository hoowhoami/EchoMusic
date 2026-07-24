mod cpal_shared;

use crate::events::PlayerEvent;
use crate::shared::SharedAudio;
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
    pub sample_formats: Vec<&'static str>,
}

pub trait AudioOutputBackend: Send {
    fn backend_name(&self) -> &'static str;
    fn exclusive(&self) -> bool;
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
            sample_formats: shared
                .source_sample_format()
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
            "audio output backend selected: backend={}, exclusive={}, engine_sample_rate={}, engine_channels={}, sample_formats={}",
            capability.backend,
            selected_exclusive,
            capability.sample_rate,
            capability.channels,
            capability.sample_formats.join(",")
        ),
    ));
    backend.spawn(shared, emit, start_notify)
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
        assert_eq!(capability.sample_formats[0], "s16");
    }
}
