mod cpal_shared;

pub(crate) const MIN_REALTIME_BUFFER_FRAMES: usize = 32_768;

use crate::events::{PlayerErrorCode, PlayerEvent};
use crate::shared::{AudioOutputStats, AudioSampleFormat, SharedAudio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex};
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

#[derive(Clone, Debug)]
pub(crate) struct OutputStopToken {
    stopped: Arc<AtomicBool>,
}

impl OutputStopToken {
    fn new() -> Self {
        Self {
            stopped: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn request_stop(&self) {
        self.stopped.store(true, Ordering::Release);
    }

    pub(crate) fn should_stop(&self, shared: &SharedAudio) -> bool {
        self.stopped.load(Ordering::Acquire) || shared.stop.load(Ordering::Acquire)
    }
}

pub(crate) struct AudioOutputHandle {
    stop: OutputStopToken,
    thread: Option<JoinHandle<()>>,
}

impl AudioOutputHandle {
    fn new(stop: OutputStopToken, thread: JoinHandle<()>) -> Self {
        Self {
            stop,
            thread: Some(thread),
        }
    }

    pub(crate) fn shutdown(mut self) {
        self.stop.request_stop();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }

    pub(crate) fn has_exited(&self) -> bool {
        self.thread
            .as_ref()
            .is_none_or(std::thread::JoinHandle::is_finished)
    }

    /// Stops an output that never confirmed startup without blocking the core dispatcher on a
    /// backend call that may itself be stuck. Successfully started outputs must still use
    /// `shutdown()` so AO generations cannot overlap.
    pub(crate) fn shutdown_in_background(mut self, reason: &'static str) {
        self.stop.request_stop();
        let Some(thread) = self.thread.take() else {
            return;
        };
        let pending = Arc::new(Mutex::new(Some(thread)));
        let worker_pending = pending.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("player-output-reaper-{reason}"))
            .spawn(move || {
                if let Some(thread) = take_pending_thread(&worker_pending) {
                    let _ = thread.join();
                }
            });
        if spawned.is_err() {
            if let Some(thread) = take_pending_thread(&pending) {
                let _ = thread.join();
            }
        }
    }
}

fn take_pending_thread(pending: &Mutex<Option<JoinHandle<()>>>) -> Option<JoinHandle<()>> {
    pending
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
}

impl Drop for AudioOutputHandle {
    fn drop(&mut self) {
        self.stop.request_stop();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

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
        stop: OutputStopToken,
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
        stop: OutputStopToken,
        emit: fn(PlayerEvent),
        start_notify: Option<OutputStartSender>,
    ) -> JoinHandle<()> {
        spawn_selected_backend(
            self.device_name,
            self.exclusive,
            shared,
            stop,
            emit,
            start_notify,
        )
    }
}

pub(crate) fn spawn_output_backend(
    device_name: String,
    exclusive: bool,
    shared: Arc<SharedAudio>,
    emit: fn(PlayerEvent),
    start_notify: Option<OutputStartSender>,
) -> AudioOutputHandle {
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
    let stop = OutputStopToken::new();
    let thread = backend.spawn(shared, stop.clone(), emit, start_notify);
    AudioOutputHandle::new(stop, thread)
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
    stop: &OutputStopToken,
    emit: fn(PlayerEvent),
    error_code: PlayerErrorCode,
    message: String,
) {
    stop.request_stop();
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
    stop: OutputStopToken,
    emit: fn(PlayerEvent),
    start_notify: Option<OutputStartSender>,
) -> JoinHandle<()> {
    #[cfg(target_os = "windows")]
    {
        wasapi::spawn_output_thread(device_name, exclusive, shared, stop, emit, start_notify)
    }
    #[cfg(target_os = "linux")]
    {
        if exclusive {
            alsa_exclusive::spawn_output_thread(device_name, shared, stop, emit, start_notify)
        } else {
            cpal_shared::spawn_shared_output_thread(
                device_name,
                exclusive,
                shared,
                stop,
                emit,
                start_notify,
            )
        }
    }
    #[cfg(target_os = "macos")]
    {
        if exclusive {
            coreaudio_exclusive::spawn_output_thread(device_name, shared, stop, emit, start_notify)
        } else {
            cpal_shared::spawn_shared_output_thread(
                device_name,
                exclusive,
                shared,
                stop,
                emit,
                start_notify,
            )
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        cpal_shared::spawn_shared_output_thread(
            device_name,
            exclusive,
            shared,
            stop,
            emit,
            start_notify,
        )
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

pub(crate) fn output_start_was_cancelled(
    stop: &OutputStopToken,
    shared: &SharedAudio,
    start_notify: &mut Option<OutputStartSender>,
) -> bool {
    if !stop.should_stop(shared) {
        return false;
    }
    report_output_start(
        start_notify,
        Err("audio output startup was cancelled".to_string()),
    );
    true
}

/// Service exactly one signalled WASAPI buffer. Exclusive event streams hand
/// over a whole packet per event; padding is only meaningful for shared streams.
/// Keep this protocol independent of COM so it can be tested on every platform.
#[cfg(any(target_os = "windows", test))]
fn service_wasapi_event<E>(
    exclusive: bool,
    buffer_frames: u32,
    query_padding: impl FnOnce() -> Result<u32, E>,
    write: impl FnOnce(u32) -> Result<(), E>,
) -> Result<u32, E> {
    if buffer_frames == 0 {
        return Ok(0);
    }
    let padding = if exclusive {
        0
    } else {
        query_padding()?.min(buffer_frames)
    };
    let frames = buffer_frames - padding;
    if frames > 0 {
        write(frames)?;
    }
    Ok(buffer_frames)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::DspSettings;
    use crate::shared::MixFormat;

    #[test]
    fn exclusive_events_consume_one_packet_without_querying_padding() {
        let mut consumed_frames = 0;
        for event in 1..=20 {
            let queued = service_wasapi_event(
                true,
                2400,
                || -> Result<u32, &str> { panic!("exclusive events must not query padding") },
                |frames| {
                    consumed_frames += frames;
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(queued, 2400);
            assert_eq!(consumed_frames, event * 2400);
        }
        // Twenty 50 ms events at 48 kHz consume one second, not two.
        assert_eq!(consumed_frames, 48_000);
    }

    #[test]
    fn shared_events_only_write_available_space() {
        for (padding, expected) in [(0, 960), (480, 480), (960, 0), (1920, 0)] {
            let mut written = 0;
            service_wasapi_event::<()>(
                false,
                960,
                || Ok(padding),
                |frames| {
                    written += frames;
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(written, expected);
        }
        let result = service_wasapi_event(
            false,
            960,
            || Err("device lost"),
            |_| panic!("failed padding queries must not consume audio"),
        );
        assert_eq!(result, Err("device lost"));
    }

    #[test]
    fn failed_exclusive_write_waits_for_another_event() {
        let mut writes = 0;
        let result = service_wasapi_event(
            true,
            960,
            || Ok(0),
            |_| {
                writes += 1;
                Err("buffer unavailable")
            },
        );
        assert_eq!(result, Err("buffer unavailable"));
        assert_eq!(writes, 1);
    }

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

    #[test]
    fn output_stop_tokens_are_isolated_between_ao_instances() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(48_000),
            0.2,
            1.0,
            &DspSettings::default(),
        );
        let old = OutputStopToken::new();
        let next = OutputStopToken::new();

        old.request_stop();
        shared.prepare_output_start();

        assert!(old.should_stop(&shared));
        assert!(!next.should_stop(&shared));
    }

    #[test]
    fn output_handle_shutdown_waits_for_owner_thread() {
        let shared = Arc::new(SharedAudio::new(
            MixFormat::stereo_f32(48_000),
            0.2,
            1.0,
            &DspSettings::default(),
        ));
        let stop = OutputStopToken::new();
        let thread_stop = stop.clone();
        let thread_shared = shared.clone();
        let (done_tx, done_rx) = std::sync::mpsc::sync_channel(1);
        let thread = std::thread::spawn(move || {
            while !thread_stop.should_stop(&thread_shared) {
                std::thread::yield_now();
            }
            let _ = done_tx.send(());
        });

        AudioOutputHandle::new(stop, thread).shutdown();

        assert_eq!(done_rx.try_recv(), Ok(()));
    }

    #[test]
    fn output_handle_reports_when_owner_thread_has_exited() {
        let stop = OutputStopToken::new();
        let thread = std::thread::spawn(|| {});
        let handle = AudioOutputHandle::new(stop, thread);

        for _ in 0..100 {
            if handle.has_exited() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }

        assert!(handle.has_exited());
        handle.shutdown();
    }
}
