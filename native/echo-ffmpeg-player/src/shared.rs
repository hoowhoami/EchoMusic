use crate::dsp::SampleRing;
use crate::effects::DspSettings;
mod ao_state;
mod clock;
mod decoded_queue;
mod gapless;
mod realtime_ring;
mod session;
mod stats;
mod types;

use ao_state::{AoBufferingMetrics, AoBufferingState, AoCacheState};
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
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Condvar, Mutex};

#[cfg(test)]
const CACHE_PAUSE_WAIT_SECS: f64 = 1.0;

pub struct SharedAudio {
    output_queue_wait: Mutex<()>,
    realtime_output: RealtimeAudioRing,
    decoded_queue: Mutex<DecodedAudioQueue>,
    output_queue_changed: Condvar,
    decoded_queue_changed: Condvar,
    output_queue_capacity: usize,
    decoded_queue_capacity_frames: usize,
    requested_output_buffer_secs: f64,
    ao_state: AoBufferingState,
    pub spectrum_ring: Mutex<SampleRing>,
    dsp_settings: Mutex<DspSettings>,
    pub paused: AtomicBool,
    pub stop: AtomicBool,
    output_stop: AtomicBool,
    output_started: AtomicBool,
    output_underruns: AtomicU64,
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
    gapless_prepare: Mutex<GaplessPrepareState>,
    gapless_prepare_changed: Condvar,
    volume_bits: AtomicU32,
    normalization_gain_bits: AtomicU32,
    pub mix_format: MixFormat,
    track_seq: AtomicU64,
    pub played_samples: AtomicU64,
    last_time_event_samples: AtomicU64,
    stall_timeout_ms: AtomicU64,
    output_delay_us: AtomicU64,
    live_output_delay_us: AtomicU64,
    filter_latency_us: AtomicU64,
    output_recovering: AtomicBool,
    pause_on_device_disconnect: AtomicBool,
    speed_bits: AtomicU32,
    source_sample_format: AtomicU32,
    preferred_output_sample_format: AtomicU32,
    decode_throughput_ratio_milli: AtomicU64,
    spectrum_sample_rate: AtomicU32,
    interrupt: Mutex<Option<Arc<AtomicBool>>>,
    signal_tx: Mutex<Option<SyncSender<PlaybackSignal>>>,
}

impl SharedAudio {
    #[cfg(test)]
    pub fn new(
        mix_format: MixFormat,
        buffer_secs: f64,
        stall_timeout_secs: f64,
        dsp_settings: &DspSettings,
    ) -> Self {
        Self::with_cache_pause_wait(
            mix_format,
            buffer_secs,
            true,
            CACHE_PAUSE_WAIT_SECS,
            stall_timeout_secs,
            dsp_settings,
        )
    }

    pub fn with_cache_pause_wait(
        mix_format: MixFormat,
        buffer_secs: f64,
        cache_pause: bool,
        cache_pause_wait_secs: f64,
        stall_timeout_secs: f64,
        dsp_settings: &DspSettings,
    ) -> Self {
        let mix_sample_rate = mix_format.sample_rate.max(1);
        let mix_channels = mix_format.channels.max(1);
        let cache_pause_wait_secs = cache_pause_wait_secs.clamp(0.0, 3_600_000.0);
        let decoded_queue_capacity_frames = ((mix_sample_rate as f64 * buffer_secs) as usize)
            .max((mix_sample_rate as f64 * cache_pause_wait_secs) as usize);
        let output_queue_capacity_frames =
            ((mix_sample_rate as f64 * buffer_secs) as usize).max(mix_sample_rate as usize / 20);
        let output_queue_capacity = output_queue_capacity_frames
            .saturating_mul(mix_channels)
            .max(mix_sample_rate as usize / 20);
        Self {
            output_queue_wait: Mutex::new(()),
            realtime_output: RealtimeAudioRing::new(output_queue_capacity),
            decoded_queue: Mutex::new(DecodedAudioQueue::default()),
            output_queue_changed: Condvar::new(),
            decoded_queue_changed: Condvar::new(),
            output_queue_capacity,
            decoded_queue_capacity_frames,
            requested_output_buffer_secs: buffer_secs.clamp(0.0, 10.0),
            ao_state: AoBufferingState::new(cache_pause, cache_pause_wait_secs),
            spectrum_ring: Mutex::new(SampleRing::new(mix_sample_rate as usize * mix_channels)),
            dsp_settings: Mutex::new(dsp_settings.clone()),
            paused: AtomicBool::new(true),
            stop: AtomicBool::new(false),
            output_stop: AtomicBool::new(false),
            output_started: AtomicBool::new(false),
            output_underruns: AtomicU64::new(0),
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
            gapless_prepare: Mutex::new(GaplessPrepareState::default()),
            gapless_prepare_changed: Condvar::new(),
            volume_bits: AtomicU32::new(1.0f32.to_bits()),
            normalization_gain_bits: AtomicU32::new(
                dsp_settings.normalization_gain_linear().to_bits(),
            ),
            mix_format,
            played_samples: AtomicU64::new(0),
            last_time_event_samples: AtomicU64::new(0),
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
            signal_tx: Mutex::new(None),
            track_seq: AtomicU64::new(0),
            decode_throughput_ratio_milli: AtomicU64::new(0),
        }
    }

    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::Release);
        self.output_stop.store(true, Ordering::Release);
        self.output_recovering.store(false, Ordering::Release);
        self.decode_stop.store(true, Ordering::Release);
        if let Ok(guard) = self.interrupt.lock() {
            if let Some(interrupt) = guard.as_ref() {
                interrupt.store(true, Ordering::Release);
            }
        }
        self.notify_signal(PlaybackSignal::Stop);
        self.output_queue_changed.notify_all();
        self.decoded_queue_changed.notify_all();
        self.gapless_prepare_changed.notify_all();
    }

    pub fn request_output_stop(&self) {
        self.output_stop.store(true, Ordering::Release);
        self.output_started.store(false, Ordering::Release);
        self.output_queue_changed.notify_all();
        self.decoded_queue_changed.notify_all();
        self.gapless_prepare_changed.notify_all();
    }

    pub fn prepare_output_restart(&self) {
        if self.stop.load(Ordering::Acquire) {
            return;
        }
        self.output_stop.store(false, Ordering::Release);
        self.output_started.store(false, Ordering::Release);
        self.live_output_delay_us.store(0, Ordering::Release);
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
        self.stop.load(Ordering::Acquire) || self.output_stop.load(Ordering::Acquire)
    }

    pub fn output_is_stopped(&self) -> bool {
        self.output_stop.load(Ordering::Acquire)
    }

    pub fn mark_output_started(&self) {
        self.output_started.store(true, Ordering::Release);
    }

    pub fn output_has_started(&self) -> bool {
        self.output_started.load(Ordering::Acquire)
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
        if let Ok(mut current) = self.dsp_settings.lock() {
            *current = settings.clone();
        }
        self.decoded_queue_changed.notify_all();
    }

    /// Updates decoded-audio throughput relative to real-time decode requirements.
    /// `1000` means decoding is keeping pace with real time; `0` means "unknown".
    pub fn update_decode_throughput_ratio(&self, ratio_milli: u64) {
        self.decode_throughput_ratio_milli
            .store(ratio_milli, Ordering::Release);
    }

    pub fn is_decode_generation_current(&self, generation: u64) -> bool {
        self.decode_generation.load(Ordering::Acquire) == generation
    }

    pub fn current_filter_generation(&self) -> u64 {
        self.filter_generation.load(Ordering::Acquire)
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

    pub fn push_output_samples_with_source_frames_for_filter_generation(
        &self,
        samples: &[f32],
        source_frames: u64,
        generation: u64,
    ) -> bool {
        self.push_output_samples_with_source_frames_checked(
            samples,
            source_frames,
            Some(generation),
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
        generation: Option<u64>,
    ) -> bool {
        self.push_queue_samples_with_source_frames_checked(
            &self.output_queue_wait,
            self.output_queue_capacity,
            samples,
            source_frames,
            generation,
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
        _queue_lock: &Mutex<()>,
        queue_capacity: usize,
        samples: &[f32],
        source_frames: u64,
        generation: Option<u64>,
    ) -> bool {
        if samples.is_empty() {
            return true;
        }
        let mut offset = 0usize;
        let mut source_frames_remaining = source_frames;
        while offset < samples.len() {
            if self.should_stop_decoding()
                || generation.is_some_and(|value| !self.is_filter_generation_current(value))
            {
                return false;
            }
            let (pushed_samples, pushed_source_frames) = self
                .realtime_output
                .push(&samples[offset..], source_frames_remaining);
            if pushed_samples > 0 {
                offset = offset.saturating_add(pushed_samples);
                source_frames_remaining =
                    source_frames_remaining.saturating_sub(pushed_source_frames);
                self.publish_restart_buffering_progress(pushed_samples);
                self.output_queue_changed.notify_all();
                continue;
            }
            let mut queue = match self.output_queue_wait.lock() {
                Ok(queue) => queue,
                Err(_) => return false,
            };
            while self.realtime_output.buffered_samples() >= queue_capacity
                && !self.should_stop_decoding()
                && !generation.is_some_and(|value| !self.is_filter_generation_current(value))
            {
                queue = match self.output_queue_changed.wait(queue) {
                    Ok(queue) => queue,
                    Err(_) => return false,
                };
            }
            if self.should_stop_decoding()
                || generation.is_some_and(|value| !self.is_filter_generation_current(value))
            {
                return false;
            }
            drop(queue);
        }
        true
    }

    fn publish_restart_buffering_progress(&self, pushed_samples: usize) {
        if !self.ao_state.cache_pause_enabled() || !self.ao_state.resume_when_buffered() {
            return;
        }
        let requested_samples = pushed_samples.max(1);
        let resume_threshold = self.cache_pause_resume_threshold(requested_samples);
        let buffered_samples = self.total_buffered_output_samples(
            self.realtime_output.buffered_samples().max(pushed_samples),
        );
        self.publish_cache_state(true, buffered_samples, resume_threshold, requested_samples);
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
        self.notify_signal(PlaybackSignal::PlaybackRestart(position_secs));
    }

    pub fn pop_into(&self, output: &mut [f32]) -> usize {
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
        ((self.output_queue_capacity / channels).max(1) * channels).max(1)
    }

    fn pop_chunk_into(&self, output: &mut [f32]) -> usize {
        output.fill(0.0);
        let queued_samples = self.realtime_output.buffered_samples();
        if self.should_hold_for_buffering(queued_samples, output.len()) {
            return 0;
        }
        let (consumed_samples, consumed_source_frames) = self.realtime_output.pop_into(output);
        if consumed_samples > 0 {
            self.output_queue_changed.notify_all();
            if consumed_samples < output.len()
                && !self.decoded_eof.load(Ordering::Acquire)
                && !self.eof.load(Ordering::Acquire)
            {
                self.enter_output_underrun(self.realtime_output.buffered_samples(), output.len());
            }
            let consumed_frames = consumed_samples / self.mix_format.channels.max(1);
            let mut boundary_signal = None;
            let post_boundary_samples = if let Ok(mut boundary) = self.gapless_boundary.lock() {
                if let Some(active) = boundary.as_mut() {
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
                }
            } else {
                consumed_samples
            };

            if let Some(info) = boundary_signal {
                let post_boundary_frames = self.source_frames_for_output(post_boundary_samples);
                self.played_samples
                    .store(post_boundary_frames, Ordering::Release);
                self.last_time_event_samples
                    .store(post_boundary_frames, Ordering::Release);
                if let Ok(mut ring) = self.spectrum_ring.try_lock() {
                    *ring = SampleRing::new(
                        self.mix_format.sample_rate as usize * self.mix_format.channels.max(1),
                    );
                }
                self.reset_adaptive_buffering();
                self.notify_signal(PlaybackSignal::TrackSwitch(info));
            } else {
                let previous = self
                    .played_samples
                    .fetch_add(consumed_source_frames, Ordering::AcqRel);
                let current = previous.saturating_add(consumed_source_frames);
                self.notify_time_update_if_due(current);
            }
            consumed_frames
        } else {
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
        self.emit_cache_state(decision.cache_state);
        decision.hold
    }

    fn enter_output_underrun(&self, buffered_samples: usize, requested_samples: usize) {
        let state = self.ao_state.enter_output_underrun(
            buffered_samples,
            requested_samples,
            self.output_queue_capacity,
            self.mix_format.channels.max(1),
            self.mix_format.sample_rate,
        );
        self.emit_cache_state(state);
        self.record_output_underrun();
    }

    fn publish_cache_state(
        &self,
        paused: bool,
        buffered_samples: usize,
        target_samples: usize,
        requested_samples: usize,
    ) {
        let state = self.ao_state.cache_state(
            paused,
            buffered_samples,
            target_samples,
            requested_samples,
            self.mix_format.channels.max(1),
            self.mix_format.sample_rate,
        );
        self.emit_cache_state(state);
    }

    fn emit_cache_state(&self, state: Option<AoCacheState>) {
        let Some(state) = state else {
            return;
        };
        self.notify_signal(PlaybackSignal::CacheState {
            paused: state.paused,
            buffering_state: state.buffering_state,
            buffered_secs: state.buffered_secs,
            target_secs: state.target_secs,
            packet_cache: self.packet_cache_stats(),
        });
    }

    fn cache_pause_resume_threshold(&self, requested_samples: usize) -> usize {
        self.ao_state
            .cache_pause_resume_threshold(&self.ao_buffering_metrics(0, requested_samples))
    }

    fn ao_buffering_metrics(
        &self,
        queued_samples: usize,
        requested_samples: usize,
    ) -> AoBufferingMetrics {
        let channels = self.mix_format.channels.max(1);
        AoBufferingMetrics {
            queued_samples,
            decoded_samples: self.decoded_buffered_samples(),
            requested_samples,
            output_queue_capacity: self.output_queue_capacity,
            decoded_queue_capacity_frames: self.decoded_queue_capacity_frames,
            channels,
            sample_rate: self.mix_format.sample_rate,
            speed: self.speed(),
            output_underruns: self.output_underruns.load(Ordering::Acquire),
            decode_throughput_ratio_milli: self
                .decode_throughput_ratio_milli
                .load(Ordering::Acquire),
        }
    }

    fn total_buffered_output_samples(&self, queued_output_samples: usize) -> usize {
        queued_output_samples.saturating_add(self.decoded_buffered_samples())
    }

    fn decoded_buffered_samples(&self) -> usize {
        self.decoded_queue
            .try_lock()
            .map(|queue| {
                (((queue.estimated_mix_frames * self.mix_format.channels.max(1)) as f64)
                    / self.speed().max(0.001) as f64)
                    .round() as usize
            })
            .unwrap_or_default()
    }

    pub fn mark_eof(&self) {
        self.eof.store(true, Ordering::Release);
        self.ao_state.reset();
        self.publish_cache_state(false, 0, 1, 1);
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
        self.reset_decode_pipeline(position_secs, dsp_settings, true)
    }

    fn reset_decode_pipeline(
        &self,
        position_secs: f64,
        dsp_settings: &DspSettings,
        resume_when_buffered: bool,
    ) -> u64 {
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
        self.reset_adaptive_buffering();
        self.ao_state
            .begin_resume_when_buffered(resume_when_buffered);
        self.publish_cache_state(false, 0, 1, 1);
        if let Ok(mut boundary) = self.gapless_boundary.lock() {
            *boundary = None;
        }
        self.set_position_secs(position_secs);
        self.set_speed(dsp_settings.speed);
        if let Ok(mut ring) = self.spectrum_ring.lock() {
            *ring = SampleRing::new(
                self.mix_format.sample_rate as usize * self.mix_format.channels.max(1),
            );
        }
        self.update_dsp_settings(dsp_settings);
        self.output_queue_changed.notify_all();
        self.decoded_queue_changed.notify_all();
        self.gapless_prepare_changed.notify_all();
        generation
    }

    pub fn reset_filter_for_dsp_change(&self, dsp_settings: &DspSettings) {
        let _queue = self.output_queue_wait.lock();
        self.realtime_output.clear();
        self.filter_generation.fetch_add(1, Ordering::AcqRel);
        self.eof.store(false, Ordering::Release);
        self.end_reported.store(false, Ordering::Release);
        self.reset_adaptive_buffering();
        self.ao_state.begin_filter_resume();
        self.publish_cache_state(false, 0, 1, 1);
        self.set_speed(dsp_settings.speed);
        if let Ok(mut ring) = self.spectrum_ring.lock() {
            *ring = SampleRing::new(
                self.mix_format.sample_rate as usize * self.mix_format.channels.max(1),
            );
        }
        self.update_dsp_settings(dsp_settings);
        self.output_queue_changed.notify_all();
        self.decoded_queue_changed.notify_all();
    }
}

#[cfg(test)]
mod tests;
