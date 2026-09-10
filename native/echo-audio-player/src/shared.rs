use crate::audio_graph::AudioFilterGraph;
use crate::dsp::provider::ProviderDescriptor;
use crate::dsp::DspSettings;
use crate::spectrum::SampleRing;
mod ao_state;
mod clock;
mod decoded_queue;
mod gapless;
mod realtime_ring;
mod session;
mod stats;
mod types;

use ao_state::{AoBufferState, AoBufferingMetrics, AoBufferingState};
use decoded_queue::{DecodedAudioQueue, DecodedQueueItem};
use gapless::{GaplessBoundary, GaplessPrepareState};
use realtime_ring::RealtimeAudioRing;
pub use session::PlaybackSession;
pub use types::{
    AudioOutputStats, AudioSampleFormat, DecodedAudioChunk, DecodedAudioData, DecodedAudioFormat,
    FilterInput, MixFormat, PacketCacheSeekableRange, PacketCacheStats, PlaybackSignal,
    TrackSwitchInfo, MIX_CHANNELS,
};

use clock::stall_timeout_millis;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Condvar, Mutex, OnceLock, TryLockError};

const AO_RING_HEADROOM_SECS: f64 = 2.0;
const DSP_GRAPH_TRANSITION_MS: usize = 15;

struct DspGraphBoundary {
    remaining_samples: usize,
    fade_samples: usize,
    post_samples: usize,
    crossed: bool,
}

pub(crate) struct FilterGraphUpdate {
    pub filter_generation: u64,
    pub decode_generation: u64,
    pub settings: DspSettings,
    pub staged_graph: Option<(AudioFilterGraph, bool)>,
}

pub struct SharedAudio {
    output_queue_wait: Mutex<()>,
    realtime_output: RealtimeAudioRing,
    decoded_queue: Mutex<DecodedAudioQueue>,
    output_queue_changed: Condvar,
    decoded_queue_changed: Condvar,
    output_ring_capacity: usize,
    configured_output_buffer_samples: usize,
    output_device_buffer_samples: AtomicUsize,
    output_buffer_target_samples: AtomicUsize,
    max_output_request_samples: AtomicUsize,
    output_demand_since_producer_progress: AtomicUsize,
    decoded_queue_capacity_frames: usize,
    requested_output_buffer_secs: f64,
    ao_state: AoBufferingState,
    pub spectrum_ring: Mutex<SampleRing>,
    dsp_settings: Mutex<DspSettings>,
    staged_filter_graph: Mutex<Option<(u64, AudioFilterGraph, bool)>>,
    provider_descriptor: Mutex<Option<ProviderDescriptor>>,
    pub paused: AtomicBool,
    pub stop: AtomicBool,
    output_started: AtomicBool,
    output_underruns: AtomicU64,
    pending_playback_restart_bits: AtomicU64,
    pending_ao_state_sequence: AtomicU64,
    consumed_ao_state_sequence: AtomicU64,
    pending_ao_state_paused: AtomicBool,
    pending_ao_state_reason_is_underrun: AtomicBool,
    pending_ao_state_buffering_state_bits: AtomicU64,
    pending_ao_state_buffered_secs_bits: AtomicU64,
    pending_ao_state_target_secs_bits: AtomicU64,
    pending_track_switch: Mutex<Option<TrackSwitchInfo>>,
    pending_playback_end: AtomicBool,
    decode_stop: AtomicBool,
    decode_generation: AtomicU64,
    filter_generation: AtomicU64,
    decoded_eof: AtomicBool,
    eof: AtomicBool,
    decode_failed: AtomicBool,
    end_reported: AtomicBool,
    packet_cache_stats: Mutex<Option<PacketCacheStats>>,
    output_stats: Mutex<Option<AudioOutputStats>>,
    gapless_boundary: Mutex<Option<GaplessBoundary>>,
    dsp_graph_boundary: Mutex<Option<DspGraphBoundary>>,
    gapless_prepare: Mutex<GaplessPrepareState>,
    gapless_prepare_changed: Condvar,
    volume_bits: AtomicU32,
    normalization_gain_bits: AtomicU32,
    effect_limiter_active: AtomicBool,
    /// Gain actually applied at the end of the previous output callback buffer.
    /// Stored as f32 bits; NaN means "unset" (first buffer applies the target directly).
    /// Written only by the single active output callback, so no producer contention.
    applied_output_gain_bits: AtomicU32,
    pub mix_format: MixFormat,
    track_seq: AtomicU64,
    pub played_samples: AtomicU64,
    stall_timeout_ms: AtomicU64,
    output_delay_us: AtomicU64,
    live_output_delay_us: AtomicU64,
    filter_latency_us: AtomicU64,
    output_recovering: AtomicBool,
    pause_on_device_disconnect: AtomicBool,
    speed_bits: AtomicU32,
    source_sample_format: AtomicU32,
    preferred_output_sample_format: AtomicU32,
    spectrum_sample_rate: AtomicU32,
    interrupt: Mutex<Option<Arc<AtomicBool>>>,
    control_signal_tx: OnceLock<SyncSender<()>>,
    telemetry_signal_tx: OnceLock<SyncSender<PlaybackSignal>>,
}

impl SharedAudio {
    #[cfg(test)]
    pub fn new(
        mix_format: MixFormat,
        buffer_secs: f64,
        stall_timeout_secs: f64,
        dsp_settings: &DspSettings,
    ) -> Self {
        Self::with_output_buffer(mix_format, buffer_secs, stall_timeout_secs, dsp_settings)
    }

    pub fn with_output_buffer(
        mix_format: MixFormat,
        buffer_secs: f64,
        stall_timeout_secs: f64,
        dsp_settings: &DspSettings,
    ) -> Self {
        let mix_sample_rate = mix_format.sample_rate.max(1);
        let mix_channels = mix_format.channels.max(1);
        let configured_output_buffer_frames =
            ((mix_sample_rate as f64 * buffer_secs) as usize).max(mix_sample_rate as usize / 20);
        let decoded_queue_capacity_frames = configured_output_buffer_frames;
        let configured_output_buffer_samples = configured_output_buffer_frames
            .saturating_mul(mix_channels)
            .max(mix_sample_rate as usize / 20);
        // The ring is preallocated for callback headroom, but producers only fill
        // to output_buffer_target_samples. Capacity therefore does not add latency.
        let output_ring_capacity_frames = configured_output_buffer_frames
            .max((mix_sample_rate as f64 * AO_RING_HEADROOM_SECS).round() as usize);
        let output_ring_capacity = output_ring_capacity_frames
            .saturating_mul(mix_channels)
            .max(configured_output_buffer_samples);
        Self {
            output_queue_wait: Mutex::new(()),
            realtime_output: RealtimeAudioRing::new(output_ring_capacity),
            decoded_queue: Mutex::new(DecodedAudioQueue::default()),
            output_queue_changed: Condvar::new(),
            decoded_queue_changed: Condvar::new(),
            output_ring_capacity,
            configured_output_buffer_samples,
            output_device_buffer_samples: AtomicUsize::new(0),
            output_buffer_target_samples: AtomicUsize::new(configured_output_buffer_samples),
            max_output_request_samples: AtomicUsize::new(0),
            output_demand_since_producer_progress: AtomicUsize::new(0),
            decoded_queue_capacity_frames,
            requested_output_buffer_secs: buffer_secs.clamp(0.0, 10.0),
            ao_state: AoBufferingState::new(),
            spectrum_ring: Mutex::new(SampleRing::new(mix_sample_rate as usize)),
            dsp_settings: Mutex::new(dsp_settings.clone()),
            staged_filter_graph: Mutex::new(None),
            provider_descriptor: Mutex::new(None),
            paused: AtomicBool::new(true),
            stop: AtomicBool::new(false),
            output_started: AtomicBool::new(false),
            output_underruns: AtomicU64::new(0),
            pending_playback_restart_bits: AtomicU64::new(f64::NAN.to_bits()),
            pending_ao_state_sequence: AtomicU64::new(0),
            consumed_ao_state_sequence: AtomicU64::new(0),
            pending_ao_state_paused: AtomicBool::new(true),
            pending_ao_state_reason_is_underrun: AtomicBool::new(false),
            pending_ao_state_buffering_state_bits: AtomicU64::new(0.0f64.to_bits()),
            pending_ao_state_buffered_secs_bits: AtomicU64::new(0.0f64.to_bits()),
            pending_ao_state_target_secs_bits: AtomicU64::new(0.0f64.to_bits()),
            pending_track_switch: Mutex::new(None),
            pending_playback_end: AtomicBool::new(false),
            decode_stop: AtomicBool::new(false),
            decode_generation: AtomicU64::new(0),
            filter_generation: AtomicU64::new(0),
            decoded_eof: AtomicBool::new(false),
            eof: AtomicBool::new(false),
            decode_failed: AtomicBool::new(false),
            end_reported: AtomicBool::new(false),
            packet_cache_stats: Mutex::new(None),
            output_stats: Mutex::new(None),
            gapless_boundary: Mutex::new(None),
            dsp_graph_boundary: Mutex::new(None),
            gapless_prepare: Mutex::new(GaplessPrepareState::default()),
            gapless_prepare_changed: Condvar::new(),
            volume_bits: AtomicU32::new(1.0f32.to_bits()),
            normalization_gain_bits: AtomicU32::new(
                dsp_settings.normalization_gain_linear().to_bits(),
            ),
            effect_limiter_active: AtomicBool::new(
                dsp_settings.provider_path.is_some() || dsp_settings.spatial.is_some(),
            ),
            applied_output_gain_bits: AtomicU32::new(f32::NAN.to_bits()),
            mix_format,
            played_samples: AtomicU64::new(0),
            stall_timeout_ms: AtomicU64::new(stall_timeout_millis(stall_timeout_secs)),
            output_delay_us: AtomicU64::new(0),
            live_output_delay_us: AtomicU64::new(0),
            filter_latency_us: AtomicU64::new(0),
            output_recovering: AtomicBool::new(false),
            pause_on_device_disconnect: AtomicBool::new(false),
            speed_bits: AtomicU32::new(dsp_settings.speed.to_bits()),
            source_sample_format: AtomicU32::new(AudioSampleFormat::Unknown as u32),
            preferred_output_sample_format: AtomicU32::new(AudioSampleFormat::Unknown as u32),
            spectrum_sample_rate: AtomicU32::new(mix_sample_rate),
            interrupt: Mutex::new(None),
            control_signal_tx: OnceLock::new(),
            telemetry_signal_tx: OnceLock::new(),
            track_seq: AtomicU64::new(0),
        }
    }

    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::Release);
        self.output_recovering.store(false, Ordering::Release);
        self.decode_stop.store(true, Ordering::Release);
        if let Ok(guard) = self.interrupt.lock() {
            if let Some(interrupt) = guard.as_ref() {
                interrupt.store(true, Ordering::Release);
            }
        }
        self.wake_control_signal();
        self.output_queue_changed.notify_all();
        self.decoded_queue_changed.notify_all();
        self.gapless_prepare_changed.notify_all();
    }

    pub fn prepare_output_start(&self) {
        if self.stop.load(Ordering::Acquire) {
            return;
        }
        self.output_started.store(false, Ordering::Release);
        self.live_output_delay_us.store(0, Ordering::Release);
        // Device restarts may change the callback and hardware-buffer geometry.
        // Drop both the previous device floor and any adaptive underrun growth;
        // the new backend registers its actual buffer before it starts rendering.
        self.output_device_buffer_samples
            .store(0, Ordering::Release);
        self.reset_output_buffering_state();
        self.ao_state.begin_preroll();
        // A fresh output stream should apply the current target gain directly
        // rather than ramping from whatever the previous stream last applied.
        self.reset_applied_output_gain();
        self.output_queue_changed.notify_all();
    }

    pub fn try_begin_output_recovery(&self) -> bool {
        !self.output_recovering.swap(true, Ordering::AcqRel)
    }

    pub fn finish_output_recovery(&self) {
        self.output_recovering.store(false, Ordering::Release);
    }

    pub fn set_pause_on_device_disconnect(&self, enabled: bool) {
        self.pause_on_device_disconnect
            .store(enabled, Ordering::Release);
    }

    pub fn should_pause_on_device_disconnect(&self) -> bool {
        self.pause_on_device_disconnect.load(Ordering::Acquire)
    }

    pub fn should_stop_output(&self) -> bool {
        self.stop.load(Ordering::Acquire)
    }

    pub fn mark_output_started(&self) {
        self.output_started.store(true, Ordering::Release);
    }

    pub fn output_has_started(&self) -> bool {
        self.output_started.load(Ordering::Acquire)
    }

    pub fn begin_output_preroll(&self) {
        self.ao_state.begin_preroll();
        self.output_queue_changed.notify_all();
    }

    pub fn request_decode_stop(&self) {
        self.decode_stop.store(true, Ordering::Release);
        if let Ok(guard) = self.interrupt.lock() {
            if let Some(interrupt) = guard.as_ref() {
                interrupt.store(true, Ordering::Release);
            }
        }
        self.output_queue_changed.notify_all();
        self.decoded_queue_changed.notify_all();
        self.gapless_prepare_changed.notify_all();
    }

    pub fn request_decode_interrupt(&self) {
        if let Ok(guard) = self.interrupt.lock() {
            if let Some(interrupt) = guard.as_ref() {
                interrupt.store(true, Ordering::Release);
            }
        }
        self.output_queue_changed.notify_all();
        self.decoded_queue_changed.notify_all();
        self.gapless_prepare_changed.notify_all();
    }

    pub fn should_stop_decoding(&self) -> bool {
        self.stop.load(Ordering::Acquire) || self.decode_stop.load(Ordering::Acquire)
    }

    pub fn current_decode_generation(&self) -> u64 {
        self.decode_generation.load(Ordering::Acquire)
    }

    pub fn current_track_seq(&self) -> u64 {
        self.track_seq.load(Ordering::Acquire)
    }

    pub fn set_track_seq(&self, seq: u64) {
        self.track_seq.store(seq, Ordering::Release);
    }

    pub fn set_source_sample_format(&self, format: AudioSampleFormat) {
        self.source_sample_format
            .store(format as u32, Ordering::Release);
    }

    pub fn source_sample_format(&self) -> AudioSampleFormat {
        AudioSampleFormat::from_u32(self.source_sample_format.load(Ordering::Acquire))
    }

    pub fn set_preferred_output_sample_format(&self, format: AudioSampleFormat) {
        self.preferred_output_sample_format
            .store(format as u32, Ordering::Release);
    }

    pub fn preferred_output_sample_format(&self) -> AudioSampleFormat {
        let preferred = AudioSampleFormat::from_u32(
            self.preferred_output_sample_format.load(Ordering::Acquire),
        );
        if preferred == AudioSampleFormat::Unknown {
            self.source_sample_format()
        } else {
            preferred
        }
    }

    pub fn set_spectrum_sample_rate(&self, sample_rate: u32) {
        self.spectrum_sample_rate
            .store(sample_rate.max(1), Ordering::Release);
    }

    pub fn spectrum_sample_rate(&self) -> u32 {
        self.spectrum_sample_rate.load(Ordering::Acquire).max(1)
    }

    pub fn dsp_settings(&self) -> DspSettings {
        self.dsp_settings
            .lock()
            .map(|settings| settings.clone())
            .unwrap_or_default()
    }

    pub fn provider_descriptor(&self) -> Option<ProviderDescriptor> {
        self.provider_descriptor
            .lock()
            .ok()
            .and_then(|descriptor| descriptor.clone())
    }

    pub fn set_provider_descriptor(&self, descriptor: Option<ProviderDescriptor>) {
        if let Ok(mut current) = self.provider_descriptor.lock() {
            *current = descriptor;
        }
    }

    pub fn update_dsp_settings(&self, settings: &DspSettings) {
        self.set_speed(settings.speed);
        let normalization_gain = settings.normalization_gain_linear();
        self.normalization_gain_bits.store(
            if normalization_gain.is_finite() {
                normalization_gain.clamp(0.0, 16.0)
            } else {
                1.0
            }
            .to_bits(),
            Ordering::Release,
        );
        self.effect_limiter_active.store(
            settings.provider_path.is_some() || settings.spatial.is_some(),
            Ordering::Release,
        );
        if let Ok(mut current) = self.dsp_settings.lock() {
            let provider_changed = current.provider_path != settings.provider_path
                || current.provider_mode != settings.provider_mode
                || current.provider_resource_json != settings.provider_resource_json
                || current.provider_preset_json != settings.provider_preset_json;
            *current = settings.clone();
            if provider_changed {
                self.set_provider_descriptor(None);
            }
        }
        self.decoded_queue_changed.notify_all();
    }

    pub fn effect_limiter_active(&self) -> bool {
        self.effect_limiter_active.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub fn set_effect_limiter_active_for_test(&self, active: bool) {
        self.effect_limiter_active.store(active, Ordering::Release);
    }

    pub fn set_normalization_gain_db(&self, gain_db: f32) {
        let gain_db = if gain_db.is_finite() {
            gain_db.clamp(-40.0, 24.0)
        } else {
            0.0
        };
        let gain = 10.0f32.powf(gain_db / 20.0).clamp(0.0, 16.0);
        self.normalization_gain_bits
            .store(gain.to_bits(), Ordering::Release);
        if let Ok(mut settings) = self.dsp_settings.lock() {
            settings.normalization_gain_db = gain_db;
        }
        self.decoded_queue_changed.notify_all();
    }

    pub fn is_decode_generation_current(&self, generation: u64) -> bool {
        self.decode_generation.load(Ordering::Acquire) == generation
    }

    pub fn current_filter_generation(&self) -> u64 {
        self.filter_generation.load(Ordering::Acquire)
    }

    pub(crate) fn take_filter_graph_update(
        &self,
        previous_generation: u64,
    ) -> Option<FilterGraphUpdate> {
        // Generation changes are rare compared with decoded audio chunks. Keep the steady-state
        // filter loop lock-free and only serialize the snapshot after the atomic fast path sees
        // pending work.
        if self.current_filter_generation() == previous_generation {
            return None;
        }
        // DSP mutations publish their settings and staged graph while holding this lock. Taking
        // one snapshot here prevents the filter worker from pairing a new generation with the
        // settings that preceded it.
        let _queue = match self.output_queue_wait.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let filter_generation = self.current_filter_generation();
        if filter_generation == previous_generation {
            return None;
        }
        Some(FilterGraphUpdate {
            filter_generation,
            decode_generation: self.current_decode_generation(),
            settings: self.dsp_settings(),
            staged_graph: self.take_staged_filter_graph(filter_generation),
        })
    }

    pub fn is_filter_generation_current(&self, generation: u64) -> bool {
        self.filter_generation.load(Ordering::Acquire) == generation
    }

    pub fn bind_interrupt(&self, interrupt: Arc<AtomicBool>) {
        interrupt.store(false, Ordering::Release);
        if let Ok(mut guard) = self.interrupt.lock() {
            *guard = Some(interrupt);
        }
    }

    #[cfg(test)]
    pub fn push_samples(&self, samples: &[f32]) -> bool {
        self.push_samples_with_source_frames(samples, self.source_frames_for_output(samples.len()))
    }

    #[cfg(test)]
    pub fn push_samples_with_source_frames(&self, samples: &[f32], source_frames: u64) -> bool {
        self.push_output_samples_with_source_frames_checked(samples, source_frames, None)
    }

    pub fn push_output_samples_with_source_frames_for_decode_generation(
        &self,
        samples: &[f32],
        source_frames: u64,
        decode_generation: u64,
    ) -> bool {
        self.push_output_samples_with_source_frames_checked(
            samples,
            source_frames,
            Some(decode_generation),
        )
    }

    pub fn push_decoded_chunk_for_generation(
        &self,
        chunk: DecodedAudioChunk,
        generation: u64,
    ) -> bool {
        self.push_decoded_chunk_checked(chunk, generation)
    }

    fn push_output_samples_with_source_frames_checked(
        &self,
        samples: &[f32],
        source_frames: u64,
        decode_generation: Option<u64>,
    ) -> bool {
        self.push_queue_samples_with_source_frames_checked(
            samples,
            source_frames,
            decode_generation,
        )
    }

    fn push_decoded_chunk_checked(&self, chunk: DecodedAudioChunk, generation: u64) -> bool {
        if chunk.frames == 0 {
            return true;
        }
        if self.should_stop_decoding() || !self.is_decode_generation_current(generation) {
            return false;
        }
        let mut queue = match self.decoded_queue.lock() {
            Ok(queue) => queue,
            Err(_) => return false,
        };
        while queue.estimated_mix_frames >= self.decoded_queue_capacity_frames
            && !self.should_stop_decoding()
            && self.is_decode_generation_current(generation)
        {
            queue = match self.decoded_queue_changed.wait(queue) {
                Ok(queue) => queue,
                Err(_) => return false,
            };
        }
        if self.should_stop_decoding() || !self.is_decode_generation_current(generation) {
            return false;
        }
        queue.push(chunk, self.mix_format.sample_rate);
        drop(queue);
        self.decoded_queue_changed.notify_all();
        true
    }

    fn push_queue_samples_with_source_frames_checked(
        &self,
        samples: &[f32],
        source_frames: u64,
        decode_generation: Option<u64>,
    ) -> bool {
        if samples.is_empty() {
            return true;
        }
        let mut offset = 0usize;
        let mut source_frames_remaining = source_frames;
        while offset < samples.len() {
            // Serialize the decode-generation check with seek/source-reset clear. A pure
            // filter-generation change intentionally does not invalidate this already
            // processed chunk: finishing it is the lossless hand-off to the new graph.
            let mut queue = match self.output_queue_wait.lock() {
                Ok(queue) => queue,
                Err(poisoned) => poisoned.into_inner(),
            };
            if self.should_stop_decoding()
                || decode_generation.is_some_and(|value| !self.is_decode_generation_current(value))
            {
                return false;
            }
            let target_samples = self.output_buffer_target_samples();
            let (pushed_samples, pushed_source_frames) = self.realtime_output.push_limited(
                &samples[offset..],
                source_frames_remaining,
                target_samples,
            );
            if pushed_samples > 0 {
                drop(queue);
                self.output_demand_since_producer_progress
                    .store(0, Ordering::Release);
                offset = offset.saturating_add(pushed_samples);
                source_frames_remaining =
                    source_frames_remaining.saturating_sub(pushed_source_frames);
                self.publish_restart_buffering_progress(pushed_samples);
                self.output_queue_changed.notify_all();
                continue;
            }
            while self.realtime_output.buffered_samples() >= self.output_buffer_target_samples()
                && !self.should_stop_decoding()
                && !decode_generation.is_some_and(|value| !self.is_decode_generation_current(value))
            {
                queue = match self.output_queue_changed.wait(queue) {
                    Ok(queue) => queue,
                    Err(poisoned) => poisoned.into_inner(),
                };
            }
            if self.should_stop_decoding()
                || decode_generation.is_some_and(|value| !self.is_decode_generation_current(value))
            {
                return false;
            }
            drop(queue);
        }
        true
    }

    fn publish_restart_buffering_progress(&self, pushed_samples: usize) {
        if !self.ao_state.is_buffering() {
            return;
        }
        let requested_samples = pushed_samples.max(1);
        let buffered_samples = self.realtime_output.buffered_samples().max(pushed_samples);
        let metrics = self.ao_buffering_metrics(buffered_samples, requested_samples);
        let reason = if self.ao_state.ao_underrun() {
            ao_state::AoBufferingReason::Underrun
        } else {
            ao_state::AoBufferingReason::Preroll
        };
        let state = self
            .ao_state
            .state(true, reason, buffered_samples, &metrics);
        self.emit_ao_state(state);
    }

    pub fn pop_decoded_for_filter(&self, generation: u64) -> FilterInput {
        let mut queue = match self.decoded_queue.lock() {
            Ok(queue) => queue,
            Err(_) => return FilterInput::Stopped,
        };
        while queue.is_empty()
            && !self.decoded_eof.load(Ordering::Acquire)
            && !self.should_stop_decoding()
            && self.is_filter_generation_current(generation)
        {
            queue = match self.decoded_queue_changed.wait(queue) {
                Ok(queue) => queue,
                Err(_) => return FilterInput::Stopped,
            };
        }
        if self.should_stop_decoding() || !self.is_filter_generation_current(generation) {
            return FilterInput::Stopped;
        }
        if queue.is_empty() && self.decoded_eof.load(Ordering::Acquire) {
            return FilterInput::Eof;
        }

        let item = queue.pop(self.mix_format.sample_rate);
        drop(queue);
        self.decoded_queue_changed.notify_all();
        match item {
            Some(DecodedQueueItem::Chunk(chunk)) => FilterInput::Frame(chunk),
            Some(DecodedQueueItem::Boundary) => FilterInput::Boundary,
            None => FilterInput::Stopped,
        }
    }

    pub fn wait_for_filter_generation_change(&self, generation: u64) {
        let queue = match self.decoded_queue.lock() {
            Ok(queue) => queue,
            Err(_) => return,
        };
        let _guard = self.decoded_queue_changed.wait_while(queue, |_| {
            !self.stop.load(Ordering::Acquire) && self.is_filter_generation_current(generation)
        });
    }

    #[cfg(test)]
    pub fn mark_playback_restart_ready(&self, position_secs: f64) {
        self.mark_playback_restart_ready_for_generation(
            position_secs,
            self.current_decode_generation(),
        );
    }

    pub fn mark_playback_restart_ready_for_generation(&self, position_secs: f64, generation: u64) {
        if !self.is_decode_generation_current(generation) {
            return;
        }
        let position_secs = position_secs.max(0.0);
        self.set_position_secs(position_secs);
        self.notify_playback_restart(position_secs);
    }

    pub fn pop_into(&self, output: &mut [f32]) -> usize {
        self.output_demand_since_producer_progress
            .fetch_add(output.len(), Ordering::AcqRel);
        self.observe_output_request(output.len());
        let chunk_samples = self.output_pop_chunk_samples();
        if output.len() > chunk_samples {
            output.fill(0.0);
            let mut consumed_frames = 0usize;
            for chunk in output.chunks_mut(chunk_samples) {
                let frames = self.pop_chunk_into(chunk);
                consumed_frames = consumed_frames.saturating_add(frames);
                if frames == 0 && !self.eof.load(Ordering::Acquire) {
                    break;
                }
            }
            return consumed_frames;
        }
        self.pop_chunk_into(output)
    }

    fn output_pop_chunk_samples(&self) -> usize {
        let channels = self.mix_format.channels.max(1);
        ((self.output_ring_capacity / channels).max(1) * channels).max(1)
    }

    fn pop_chunk_into(&self, output: &mut [f32]) -> usize {
        output.fill(0.0);
        let queued_samples = self.realtime_output.buffered_samples();
        if self.should_hold_for_buffering(queued_samples, output.len()) {
            return 0;
        }
        // Never wait in the audio callback for boundary updates. Keep both the output ring and
        // playback clock untouched and render one silent callback instead.
        let mut dsp_boundary = match self.dsp_graph_boundary.try_lock() {
            Ok(boundary) => boundary,
            Err(TryLockError::WouldBlock) => return 0,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        };
        let mut boundary = match self.gapless_boundary.try_lock() {
            Ok(boundary) => boundary,
            Err(TryLockError::WouldBlock) => return 0,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        };
        // A gapless boundary carries heap-owned track metadata. Reserve its single pending
        // mailbox before consuming any boundary samples. If the signal thread is taking the
        // previous value, render silence and retry next callback without advancing the ring.
        let mut pending_track_switch = if boundary.is_some() {
            let pending = match self.pending_track_switch.try_lock() {
                Ok(pending) => pending,
                Err(TryLockError::WouldBlock) => return 0,
                Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            };
            if pending.is_some() {
                return 0;
            }
            Some(pending)
        } else {
            None
        };
        let (consumed_samples, consumed_source_frames) = self.realtime_output.pop_into(output);
        if consumed_samples > 0 {
            if let Some(active) = boundary.as_ref() {
                apply_track_boundary_fade(
                    &mut output[..consumed_samples],
                    active.remaining_samples,
                    active.fade_samples,
                    self.mix_format.channels,
                );
            }
            if let Some(active) = dsp_boundary.as_ref() {
                apply_dsp_graph_boundary_fade(
                    &mut output[..consumed_samples],
                    active,
                    self.mix_format.channels,
                );
            }
            self.output_queue_changed.notify_all();
            let underrun = consumed_samples < output.len()
                && !self.decoded_eof.load(Ordering::Acquire)
                && !self.eof.load(Ordering::Acquire);
            let consumed_frames = consumed_samples / self.mix_format.channels.max(1);
            let mut boundary_signal = None;
            let post_boundary_samples = if let Some(active) = boundary.as_mut() {
                if consumed_samples >= active.remaining_samples {
                    let post = consumed_samples - active.remaining_samples;
                    boundary_signal = boundary.take().map(|boundary| boundary.info);
                    post
                } else {
                    active.remaining_samples -= consumed_samples;
                    0
                }
            } else {
                consumed_samples
            };
            drop(boundary);
            if let Some(active) = dsp_boundary.as_mut() {
                if active.crossed {
                    active.post_samples = active.post_samples.saturating_add(consumed_samples);
                } else if consumed_samples >= active.remaining_samples {
                    active.post_samples = consumed_samples.saturating_sub(active.remaining_samples);
                    active.remaining_samples = 0;
                    active.crossed = true;
                } else {
                    active.remaining_samples -= consumed_samples;
                }
                if active.crossed && active.post_samples >= active.fade_samples {
                    *dsp_boundary = None;
                }
            }
            drop(dsp_boundary);

            let mut track_switch_ready = false;
            if let Some(info) = boundary_signal {
                let post_boundary_frames = self.source_frames_for_output(post_boundary_samples);
                self.played_samples
                    .store(post_boundary_frames, Ordering::Release);
                self.set_track_seq(info.seq);
                if let Ok(mut ring) = self.spectrum_ring.try_lock() {
                    ring.clear();
                }
                self.reset_output_buffering_state();
                if let Some(pending) = pending_track_switch.as_mut() {
                    **pending = Some(info);
                    track_switch_ready = true;
                } else {
                    debug_assert!(false, "crossed gapless boundary without a pending mailbox");
                }
            } else {
                self.played_samples
                    .fetch_add(consumed_source_frames, Ordering::AcqRel);
            }
            drop(pending_track_switch);
            if track_switch_ready {
                self.wake_control_signal();
            }
            // Handle a short read after a possible gapless-boundary reset so the
            // new track keeps its underrun hold instead of immediately clearing it.
            if underrun {
                self.enter_output_underrun(self.realtime_output.buffered_samples(), output.len());
            }
            consumed_frames
        } else {
            drop(boundary);
            drop(dsp_boundary);
            if !self.decoded_eof.load(Ordering::Acquire) && !self.eof.load(Ordering::Acquire) {
                self.enter_output_underrun(0, output.len());
            }
            0
        }
    }

    fn should_hold_for_buffering(&self, queued_samples: usize, requested_samples: usize) -> bool {
        if requested_samples == 0
            || self.decoded_eof.load(Ordering::Acquire)
            || self.eof.load(Ordering::Acquire)
        {
            self.ao_state.reset();
            return false;
        }

        let decision = self.ao_state.should_hold_for_buffering(
            self.ao_buffering_metrics(queued_samples, requested_samples),
        );
        self.emit_ao_state(decision.state);
        decision.hold
    }

    fn enter_output_underrun(&self, buffered_samples: usize, requested_samples: usize) {
        let observed_burst = self
            .output_demand_since_producer_progress
            .load(Ordering::Acquire);
        let observed_demand = observed_burst.saturating_add(requested_samples);
        self.raise_output_buffer_target(observed_demand);
        let metrics = self.ao_buffering_metrics(buffered_samples, requested_samples);
        let state = self
            .ao_state
            .enter_output_underrun(buffered_samples, &metrics);
        self.emit_ao_state(state);
        self.record_output_underrun();
    }

    fn emit_ao_state(&self, state: Option<AoBufferState>) {
        let Some(state) = state else {
            return;
        };
        self.notify_ao_state(
            state.paused,
            state.reason.as_str(),
            state.buffering_state,
            state.buffered_secs,
            state.target_secs,
        );
    }

    fn observe_output_request(&self, requested_samples: usize) {
        if requested_samples == 0 {
            return;
        }
        self.max_output_request_samples
            .fetch_max(requested_samples, Ordering::AcqRel);
        self.raise_output_buffer_target(requested_samples);
    }

    pub fn register_output_device_buffer(&self, device_frames: u32, device_sample_rate: u32) {
        if device_frames == 0 {
            return;
        }
        let engine_frames = ((u64::from(device_frames)
            * u64::from(self.mix_format.sample_rate.max(1)))
        .div_ceil(u64::from(device_sample_rate.max(1)))) as usize;
        let device_samples = engine_frames
            .saturating_mul(self.mix_format.channels.max(1))
            .min(self.output_ring_capacity);
        self.output_device_buffer_samples
            .store(device_samples, Ordering::Release);
        self.raise_output_buffer_target(device_samples);
    }

    pub(super) fn reset_adaptive_output_buffer_target(&self) {
        let device_samples = self.output_device_buffer_samples.load(Ordering::Acquire);
        let target = self
            .configured_output_buffer_samples
            .max(device_samples)
            .min(self.output_ring_capacity)
            .max(1);
        let current = self.output_buffer_target_samples.load(Ordering::Acquire);
        if current < target {
            self.output_buffer_target_samples
                .fetch_max(target, Ordering::AcqRel);
        } else if current > target {
            // Lower only the value this reset observed. If a realtime callback
            // concurrently raises the target, preserve that newer requirement.
            let _ = self.output_buffer_target_samples.compare_exchange(
                current,
                target,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
        // The device may have registered a new floor after `target` was
        // calculated but before the CAS above. Re-read it and restore the floor
        // with a monotonic update so reset can never leave the target below the
        // latest device requirement.
        let latest_device_samples = self.output_device_buffer_samples.load(Ordering::Acquire);
        let latest_floor = self
            .configured_output_buffer_samples
            .max(latest_device_samples)
            .min(self.output_ring_capacity)
            .max(1);
        self.output_buffer_target_samples
            .fetch_max(latest_floor, Ordering::AcqRel);
        self.max_output_request_samples.store(0, Ordering::Release);
        self.output_demand_since_producer_progress
            .store(0, Ordering::Release);
        self.output_queue_changed.notify_all();
    }

    fn raise_output_buffer_target(&self, required_samples: usize) {
        let target = self
            .configured_output_buffer_samples
            .max(required_samples.min(self.output_ring_capacity));
        let previous = self
            .output_buffer_target_samples
            .fetch_max(target, Ordering::AcqRel);
        if target > previous {
            self.output_queue_changed.notify_all();
        }
    }

    fn output_buffer_target_samples(&self) -> usize {
        self.output_buffer_target_samples
            .load(Ordering::Acquire)
            .min(self.output_ring_capacity)
            .max(1)
    }

    pub(super) fn output_buffer_target_secs(&self) -> f64 {
        self.output_buffer_target_samples() as f64
            / self.mix_format.channels.max(1) as f64
            / self.mix_format.sample_rate.max(1) as f64
    }

    pub(super) fn output_ring_capacity_secs(&self) -> f64 {
        self.output_ring_capacity as f64
            / self.mix_format.channels.max(1) as f64
            / self.mix_format.sample_rate.max(1) as f64
    }

    pub(super) fn max_output_request_frames(&self) -> usize {
        self.max_output_request_samples.load(Ordering::Acquire) / self.mix_format.channels.max(1)
    }

    fn ao_buffering_metrics(
        &self,
        queued_samples: usize,
        requested_samples: usize,
    ) -> AoBufferingMetrics {
        let channels = self.mix_format.channels.max(1);
        AoBufferingMetrics {
            queued_samples,
            requested_samples,
            target_samples: self.output_buffer_target_samples(),
            channels,
            sample_rate: self.mix_format.sample_rate,
        }
    }

    pub fn mark_eof(&self) {
        self.eof.store(true, Ordering::Release);
        self.ao_state.reset();
        self.output_queue_changed.notify_all();
    }

    pub fn mark_decoded_eof(&self) {
        self.decoded_eof.store(true, Ordering::Release);
        self.decoded_queue_changed.notify_all();
    }

    pub fn mark_decode_failed(&self) {
        self.decode_failed.store(true, Ordering::Release);
    }

    #[cfg(test)]
    fn is_drained(&self) -> bool {
        if !self.eof.load(Ordering::Acquire) {
            return false;
        }
        self.realtime_output.is_empty()
    }

    pub fn is_drained_for_output(&self) -> bool {
        if !self.eof.load(Ordering::Acquire) {
            return false;
        }
        self.realtime_output.is_empty()
    }

    pub fn mark_end_reported(&self) -> bool {
        self.end_reported
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub fn reset_for_decode_resume(&self, position_secs: f64, dsp_settings: &DspSettings) -> u64 {
        self.reset_decode_pipeline(position_secs, dsp_settings)
    }

    fn reset_decode_pipeline(&self, position_secs: f64, dsp_settings: &DspSettings) -> u64 {
        let _queue = self.output_queue_wait.lock();
        self.realtime_output.clear();
        if let Ok(mut queue) = self.decoded_queue.lock() {
            queue.clear();
        }
        let generation = self.decode_generation.fetch_add(1, Ordering::AcqRel) + 1;
        self.filter_generation.fetch_add(1, Ordering::AcqRel);
        self.decode_stop.store(false, Ordering::Release);
        self.decoded_eof.store(false, Ordering::Release);
        self.eof.store(false, Ordering::Release);
        self.decode_failed.store(false, Ordering::Release);
        self.end_reported.store(false, Ordering::Release);
        self.reset_output_buffering_state();
        self.ao_state.begin_preroll();
        // A decoder generation is a discontinuity (seek, loop or replacement source). Start the
        // next audible callback at zero instead of reusing the preceding generation's gain.
        self.store_applied_output_gain(0.0);
        if let Ok(mut boundary) = self.gapless_boundary.lock() {
            *boundary = None;
        }
        if let Ok(mut boundary) = self.dsp_graph_boundary.lock() {
            *boundary = None;
        }
        self.set_position_secs(position_secs);
        self.set_speed(dsp_settings.speed);
        if let Ok(mut ring) = self.spectrum_ring.lock() {
            *ring = SampleRing::new(self.mix_format.sample_rate as usize);
        }
        self.update_dsp_settings(dsp_settings);
        self.output_queue_changed.notify_all();
        self.decoded_queue_changed.notify_all();
        self.gapless_prepare_changed.notify_all();
        generation
    }

    pub fn reset_filter_for_dsp_change(&self, dsp_settings: &DspSettings) {
        let _queue = self.output_queue_wait.lock();
        // Keep both ready output and the chunk currently being published. They form a
        // lossless hand-off tail while the filter worker adopts the new speed/tempo graph.
        // If playback is paused with a full output ring, graph adoption intentionally waits
        // until playback resumes and makes room rather than dropping audio. Decode resets
        // (seek/source changes) still clear both queues separately.
        self.filter_generation.fetch_add(1, Ordering::AcqRel);
        self.eof.store(false, Ordering::Release);
        self.end_reported.store(false, Ordering::Release);
        self.set_speed(dsp_settings.speed);
        self.update_dsp_settings(dsp_settings);
        self.output_queue_changed.notify_all();
        self.decoded_queue_changed.notify_all();
    }

    pub fn stage_audio_effect_graph(
        &self,
        dsp_settings: &DspSettings,
        graph: AudioFilterGraph,
        prefer_in_place_update: bool,
    ) {
        let _queue = self.output_queue_wait.lock();
        let generation = self
            .filter_generation
            .load(Ordering::Acquire)
            .wrapping_add(1);
        if let Ok(mut staged) = self.staged_filter_graph.lock() {
            *staged = Some((generation, graph, prefer_in_place_update));
        }
        // Keep already processed audio in the output ring. It forms a natural
        // hand-off tail while the filter thread adopts the prepared graph.
        self.filter_generation.store(generation, Ordering::Release);
        self.eof.store(false, Ordering::Release);
        self.end_reported.store(false, Ordering::Release);
        self.set_speed(dsp_settings.speed);
        self.update_dsp_settings(dsp_settings);
        self.output_queue_changed.notify_all();
        self.decoded_queue_changed.notify_all();
    }

    pub fn take_staged_filter_graph(&self, generation: u64) -> Option<(AudioFilterGraph, bool)> {
        let mut staged = self.staged_filter_graph.lock().ok()?;
        if staged
            .as_ref()
            // A later non-structural update (for example playback speed) may advance the filter
            // generation before the worker consumes this graph. The validated candidate remains
            // applicable and will be refreshed with the snapshot's latest settings before use.
            .is_some_and(|(value, _, _)| *value <= generation)
        {
            return staged
                .take()
                .map(|(_, graph, prefer_in_place)| (graph, prefer_in_place));
        }
        None
    }

    /// Mark the exact producer boundary between the old graph tail and the first samples from a
    /// newly prepared graph. The callback applies a short zero-point envelope across that marker,
    /// avoiding a discontinuity without clearing ready audio or restarting the output device.
    pub fn mark_dsp_graph_boundary(&self) {
        let mut boundary = match self.dsp_graph_boundary.lock() {
            Ok(boundary) => boundary,
            Err(poisoned) => poisoned.into_inner(),
        };
        let remaining_samples = self.realtime_output.buffered_samples();
        let channels = self.mix_format.channels.max(1);
        let fade_frames =
            (self.mix_format.sample_rate as usize * DSP_GRAPH_TRANSITION_MS / 1_000).max(1);
        *boundary = Some(DspGraphBoundary {
            remaining_samples,
            fade_samples: fade_frames.saturating_mul(channels),
            post_samples: 0,
            crossed: remaining_samples == 0,
        });
    }
}

fn apply_track_boundary_fade(
    output: &mut [f32],
    remaining_samples: usize,
    fade_samples: usize,
    channels: usize,
) {
    let channels = channels.max(1);
    let fade_frames = fade_samples / channels;
    if fade_frames == 0 {
        return;
    }
    for (frame_index, frame) in output.chunks_exact_mut(channels).enumerate() {
        let sample_offset = frame_index.saturating_mul(channels);
        let gain = if sample_offset < remaining_samples {
            let distance_frames = remaining_samples
                .saturating_sub(sample_offset)
                .div_ceil(channels);
            if distance_frames > fade_frames {
                1.0
            } else {
                distance_frames as f32 / fade_frames as f32
            }
        } else {
            let post_frames = sample_offset
                .saturating_sub(remaining_samples)
                .div_ceil(channels);
            ((post_frames + 1) as f32 / fade_frames as f32).min(1.0)
        };
        for sample in frame {
            *sample *= gain;
        }
    }
}

fn apply_dsp_graph_boundary_fade(output: &mut [f32], boundary: &DspGraphBoundary, channels: usize) {
    let channels = channels.max(1);
    let fade_frames = (boundary.fade_samples / channels).max(1);
    let fade_span = fade_frames.saturating_sub(1).max(1);
    for (frame_index, frame) in output.chunks_exact_mut(channels).enumerate() {
        let sample_offset = frame_index.saturating_mul(channels);
        let gain = if !boundary.crossed && sample_offset < boundary.remaining_samples {
            let distance_frames = boundary
                .remaining_samples
                .saturating_sub(sample_offset)
                .div_ceil(channels);
            if distance_frames > fade_frames {
                1.0
            } else {
                distance_frames.saturating_sub(1) as f32 / fade_span as f32
            }
        } else {
            let local_post_samples = if boundary.crossed {
                sample_offset
            } else {
                sample_offset.saturating_sub(boundary.remaining_samples)
            };
            let post_frames = boundary.post_samples.saturating_add(local_post_samples) / channels;
            (post_frames as f32 / fade_span as f32).min(1.0)
        };
        for sample in frame {
            *sample *= gain;
        }
    }
}

#[cfg(test)]
mod tests;
