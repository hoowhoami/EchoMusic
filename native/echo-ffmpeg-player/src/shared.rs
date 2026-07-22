use crate::dsp::SampleRing;
use crate::effects::DspSettings;
mod decoded_queue;
mod realtime_ring;
mod session;
mod types;

use decoded_queue::{DecodedAudioQueue, DecodedQueueItem};
use realtime_ring::RealtimeAudioRing;
pub use session::PlaybackSession;
pub use types::{
    AudioOutputStats, AudioSampleFormat, DecodedAudioChunk, DecodedAudioData, DecodedAudioFormat,
    FilterInput, MixFormat, PacketCacheStats, PlaybackSignal, TrackSwitchInfo, MIX_CHANNELS,
};

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

const CACHE_PAUSE_WAIT_SECS: f64 = 1.0;
const CACHE_STATE_INACTIVE_BUCKET: u32 = u32::MAX;

struct GaplessBoundary {
    remaining_samples: usize,
    info: TrackSwitchInfo,
}

pub struct SharedAudio {
    output_queue_wait: Mutex<()>,
    realtime_output: RealtimeAudioRing,
    decoded_queue: Mutex<DecodedAudioQueue>,
    output_queue_changed: Condvar,
    decoded_queue_changed: Condvar,
    output_queue_capacity: usize,
    decoded_queue_capacity_frames: usize,
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
    underflow_buffering: AtomicBool,
    resume_when_buffered: AtomicBool,
    cache_state_bucket: AtomicU32,
    packet_cache_stats: Mutex<Option<PacketCacheStats>>,
    output_stats: Mutex<Option<AudioOutputStats>>,
    gapless_boundary: Mutex<Option<GaplessBoundary>>,
    volume_bits: AtomicU32,
    pub mix_format: MixFormat,
    track_seq: AtomicU64,
    pub played_samples: AtomicU64,
    last_time_event_samples: AtomicU64,
    stall_timeout_ms: AtomicU64,
    output_delay_us: AtomicU64,
    filter_latency_us: AtomicU64,
    speed_bits: AtomicU32,
    source_sample_format: AtomicU32,
    spectrum_sample_rate: AtomicU32,
    interrupt: Mutex<Option<Arc<AtomicBool>>>,
    signal_tx: Mutex<Option<SyncSender<PlaybackSignal>>>,
}

impl SharedAudio {
    pub fn new(
        mix_format: MixFormat,
        buffer_secs: f64,
        stall_timeout_secs: f64,
        dsp_settings: &DspSettings,
    ) -> Self {
        let mix_sample_rate = mix_format.sample_rate.max(1);
        let mix_channels = mix_format.channels.max(1);
        let decoded_queue_capacity_frames = ((mix_sample_rate as f64 * buffer_secs) as usize)
            .max((mix_sample_rate as f64 * CACHE_PAUSE_WAIT_SECS) as usize);
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
            underflow_buffering: AtomicBool::new(false),
            resume_when_buffered: AtomicBool::new(false),
            cache_state_bucket: AtomicU32::new(CACHE_STATE_INACTIVE_BUCKET),
            packet_cache_stats: Mutex::new(None),
            output_stats: Mutex::new(None),
            gapless_boundary: Mutex::new(None),
            volume_bits: AtomicU32::new(1.0f32.to_bits()),
            mix_format,
            played_samples: AtomicU64::new(0),
            last_time_event_samples: AtomicU64::new(0),
            stall_timeout_ms: AtomicU64::new(stall_timeout_millis(stall_timeout_secs)),
            output_delay_us: AtomicU64::new(0),
            filter_latency_us: AtomicU64::new(0),
            speed_bits: AtomicU32::new(dsp_settings.speed.to_bits()),
            source_sample_format: AtomicU32::new(AudioSampleFormat::Unknown as u32),
            spectrum_sample_rate: AtomicU32::new(mix_sample_rate),
            interrupt: Mutex::new(None),
            signal_tx: Mutex::new(None),
            track_seq: AtomicU64::new(0),
        }
    }

    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::Release);
        self.output_stop.store(true, Ordering::Release);
        self.decode_stop.store(true, Ordering::Release);
        if let Ok(guard) = self.interrupt.lock() {
            if let Some(interrupt) = guard.as_ref() {
                interrupt.store(true, Ordering::Release);
            }
        }
        self.notify_signal(PlaybackSignal::Stop);
        self.output_queue_changed.notify_all();
        self.decoded_queue_changed.notify_all();
    }

    pub fn request_output_stop(&self) {
        self.output_stop.store(true, Ordering::Release);
        self.output_started.store(false, Ordering::Release);
        self.output_queue_changed.notify_all();
        self.decoded_queue_changed.notify_all();
    }

    pub fn prepare_output_restart(&self) {
        if self.stop.load(Ordering::Acquire) {
            return;
        }
        self.output_stop.store(false, Ordering::Release);
        self.output_started.store(false, Ordering::Release);
        self.output_queue_changed.notify_all();
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

    pub fn request_decode_stop(&self) {
        self.decode_stop.store(true, Ordering::Release);
        if let Ok(guard) = self.interrupt.lock() {
            if let Some(interrupt) = guard.as_ref() {
                interrupt.store(true, Ordering::Release);
            }
        }
        self.output_queue_changed.notify_all();
        self.decoded_queue_changed.notify_all();
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
        if let Ok(mut current) = self.dsp_settings.lock() {
            *current = settings.clone();
        }
        self.decoded_queue_changed.notify_all();
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

    pub fn bind_signal_sender(&self, sender: SyncSender<PlaybackSignal>) {
        if let Ok(mut guard) = self.signal_tx.lock() {
            *guard = Some(sender);
        }
    }

    pub fn notify_signal(&self, signal: PlaybackSignal) {
        if let Ok(guard) = self.signal_tx.lock() {
            if let Some(sender) = guard.as_ref() {
                let _ = sender.try_send(signal);
            }
        }
    }

    pub fn update_packet_cache_stats(&self, stats: PacketCacheStats) {
        if let Ok(mut current) = self.packet_cache_stats.lock() {
            let changed = current.as_ref() != Some(&stats);
            *current = Some(stats.clone());
            if changed {
                self.notify_signal(PlaybackSignal::PacketCacheStats(stats));
            }
        }
    }

    pub fn packet_cache_stats(&self) -> Option<PacketCacheStats> {
        self.packet_cache_stats
            .try_lock()
            .ok()
            .and_then(|stats| stats.clone())
    }

    pub fn update_output_stats(&self, stats: AudioOutputStats) {
        if let Ok(mut current) = self.output_stats.lock() {
            let mut stats = stats;
            stats.underruns = self.output_underruns.load(Ordering::Acquire) as f64;
            self.output_delay_us.store(
                (stats.delay_secs.max(0.0) * 1_000_000.0).round() as u64,
                Ordering::Release,
            );
            let changed = current.as_ref() != Some(&stats);
            *current = Some(stats.clone());
            if changed {
                self.notify_signal(PlaybackSignal::OutputStats(stats));
            }
        }
    }

    #[cfg(test)]
    pub fn output_underrun_count(&self) -> u64 {
        self.output_underruns.load(Ordering::Acquire)
    }

    fn record_output_underrun(&self) {
        let underruns = self.output_underruns.fetch_add(1, Ordering::AcqRel) + 1;
        if let Ok(mut current) = self.output_stats.try_lock() {
            if let Some(stats) = current.as_mut() {
                stats.underruns = underruns as f64;
                self.notify_signal(PlaybackSignal::OutputStats(stats.clone()));
            }
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
                self.resume_cache_after_first_seek_audio(pushed_samples);
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

    fn resume_cache_after_first_seek_audio(&self, pushed_samples: usize) {
        if !self.resume_when_buffered.load(Ordering::Acquire) {
            return;
        }
        self.underflow_buffering.store(false, Ordering::Release);
        let buffered_samples = self.realtime_output.buffered_samples().max(pushed_samples);
        self.publish_cache_state(
            false,
            buffered_samples,
            pushed_samples.max(1),
            pushed_samples.max(1),
        );
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

    pub fn mark_seek_audio_ready(&self, position_secs: f64) {
        let position_secs = position_secs.max(0.0);
        self.set_position_secs(position_secs);
        self.notify_signal(PlaybackSignal::Seeked(position_secs));
    }

    pub fn pop_into(&self, output: &mut [f32]) -> usize {
        output.fill(0.0);
        let queued_samples = self.realtime_output.buffered_samples();
        if self.should_hold_for_buffering(queued_samples, output.len()) {
            return 0;
        }
        let (consumed_samples, consumed_source_frames) = self.realtime_output.pop_into(output);
        if consumed_samples > 0 {
            self.output_queue_changed.notify_all();
            if consumed_samples < output.len() && !self.eof.load(Ordering::Acquire) {
                self.record_output_underrun();
                self.underflow_buffering.store(true, Ordering::Release);
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
            if !self.eof.load(Ordering::Acquire) {
                self.record_output_underrun();
            }
            0
        }
    }

    fn should_hold_for_buffering(&self, queued_samples: usize, requested_samples: usize) -> bool {
        if requested_samples == 0 || self.eof.load(Ordering::Acquire) {
            self.underflow_buffering.store(false, Ordering::Release);
            self.resume_when_buffered.store(false, Ordering::Release);
            return false;
        }

        if self.resume_when_buffered.load(Ordering::Acquire) {
            if queued_samples > 0 {
                self.resume_when_buffered.store(false, Ordering::Release);
                self.underflow_buffering.store(false, Ordering::Release);
                self.publish_cache_state(
                    false,
                    queued_samples,
                    requested_samples,
                    requested_samples,
                );
                return false;
            }
            self.publish_cache_state(true, queued_samples, requested_samples, requested_samples);
            self.record_output_underrun();
            return true;
        }

        if self.underflow_buffering.load(Ordering::Acquire) {
            let resume_threshold = self.buffering_resume_threshold(requested_samples);
            let total_buffered = self.total_buffered_output_samples(queued_samples);
            if total_buffered < resume_threshold {
                self.publish_cache_state(true, total_buffered, resume_threshold, requested_samples);
                self.record_output_underrun();
                return true;
            }
            self.underflow_buffering.store(false, Ordering::Release);
            self.publish_cache_state(false, total_buffered, resume_threshold, requested_samples);
            return false;
        }

        if queued_samples < requested_samples {
            self.underflow_buffering.store(true, Ordering::Release);
            self.publish_cache_state(
                true,
                queued_samples,
                self.buffering_resume_threshold(requested_samples),
                requested_samples,
            );
            self.record_output_underrun();
            return true;
        }

        false
    }

    fn publish_cache_state(
        &self,
        paused: bool,
        buffered_samples: usize,
        target_samples: usize,
        requested_samples: usize,
    ) {
        let channels = self.mix_format.channels.max(1);
        let sample_rate = self.mix_format.sample_rate.max(1) as f64;
        let target_samples = target_samples.max(requested_samples).max(1);
        let percent = ((buffered_samples as f64 / target_samples as f64) * 100.0).clamp(0.0, 100.0);
        let bucket = if paused {
            ((percent / 5.0).floor() as u32).min(20)
        } else {
            CACHE_STATE_INACTIVE_BUCKET
        };
        let previous = self.cache_state_bucket.swap(bucket, Ordering::AcqRel);
        if previous == bucket {
            return;
        }
        let buffered_secs = buffered_samples as f64 / channels as f64 / sample_rate;
        let target_secs = target_samples as f64 / channels as f64 / sample_rate;
        self.notify_signal(PlaybackSignal::CacheState {
            paused,
            buffering_state: if paused { percent } else { 100.0 },
            buffered_secs,
            target_secs,
            packet_cache: self.packet_cache_stats(),
        });
    }

    fn buffering_resume_threshold(&self, requested_samples: usize) -> usize {
        let min_buffer_samples = ((self.mix_format.sample_rate as f64 * CACHE_PAUSE_WAIT_SECS)
            as usize)
            .saturating_mul(self.mix_format.channels.max(1));
        min_buffer_samples
            .max(requested_samples)
            .max(self.output_queue_capacity)
    }

    fn total_buffered_output_samples(&self, queued_output_samples: usize) -> usize {
        let decoded_samples = self
            .decoded_queue
            .try_lock()
            .map(|queue| {
                (((queue.estimated_mix_frames * self.mix_format.channels.max(1)) as f64)
                    / self.speed().max(0.001) as f64)
                    .round() as usize
            })
            .unwrap_or_default();
        queued_output_samples.saturating_add(decoded_samples)
    }

    fn notify_time_update_if_due(&self, current_samples: u64) {
        let interval = (self.mix_format.sample_rate as u64 / 5).max(1);
        let mut last = self.last_time_event_samples.load(Ordering::Acquire);
        loop {
            if current_samples.saturating_sub(last) < interval {
                return;
            }
            match self.last_time_event_samples.compare_exchange(
                last,
                current_samples,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    self.notify_signal(PlaybackSignal::TimeUpdate);
                    return;
                }
                Err(actual) => last = actual,
            }
        }
    }

    pub fn mark_eof(&self) {
        self.eof.store(true, Ordering::Release);
        self.underflow_buffering.store(false, Ordering::Release);
        self.resume_when_buffered.store(false, Ordering::Release);
        self.publish_cache_state(false, 0, 1, 1);
        self.output_queue_changed.notify_all();
    }

    pub fn mark_decoded_eof(&self) {
        self.decoded_eof.store(true, Ordering::Release);
        self.decoded_queue_changed.notify_all();
    }

    pub fn mark_gapless_boundary(&self, info: TrackSwitchInfo) {
        let output_samples = self.realtime_output.buffered_samples();
        let decoded_samples = self
            .decoded_queue
            .lock()
            .map(|mut queue| {
                let samples = (((queue.estimated_mix_frames * self.mix_format.channels.max(1))
                    as f64)
                    / self.speed().max(0.001) as f64)
                    .round() as usize;
                queue.push_boundary();
                samples
            })
            .unwrap_or_default();
        if let Ok(mut boundary) = self.gapless_boundary.lock() {
            *boundary = Some(GaplessBoundary {
                remaining_samples: output_samples.saturating_add(decoded_samples),
                info,
            });
        }
        self.eof.store(false, Ordering::Release);
        self.end_reported.store(false, Ordering::Release);
        self.underflow_buffering.store(false, Ordering::Release);
        self.resume_when_buffered.store(false, Ordering::Release);
        self.publish_cache_state(false, 0, 1, 1);
        self.output_queue_changed.notify_all();
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

    pub fn position_secs(&self) -> f64 {
        let raw = self.played_samples.load(Ordering::Acquire) as f64
            / self.mix_format.sample_rate.max(1) as f64;
        let delay = self.output_delay_us.load(Ordering::Acquire) as f64 / 1_000_000.0;
        let filter_latency = self.filter_latency_us.load(Ordering::Acquire) as f64 / 1_000_000.0;
        (raw - delay - filter_latency).max(0.0)
    }

    pub fn set_filter_latency_secs(&self, seconds: f64) {
        self.filter_latency_us.store(
            (seconds.max(0.0) * 1_000_000.0).round() as u64,
            Ordering::Release,
        );
    }

    pub fn set_position_secs(&self, position_secs: f64) {
        let position_samples = (position_secs.max(0.0) * self.mix_format.sample_rate as f64) as u64;
        self.played_samples
            .store(position_samples, Ordering::Release);
        self.last_time_event_samples
            .store(position_samples, Ordering::Release);
    }

    pub fn played_sample_count(&self) -> u64 {
        self.played_samples.load(Ordering::Acquire)
    }

    pub fn set_stall_timeout(&self, seconds: f64) {
        self.stall_timeout_ms
            .store(stall_timeout_millis(seconds), Ordering::Release);
    }

    pub fn set_speed(&self, speed: f32) {
        self.speed_bits.store(
            speed
                .clamp(crate::tempo::MIN_SPEED, crate::tempo::MAX_SPEED)
                .to_bits(),
            Ordering::Release,
        );
    }

    pub fn speed(&self) -> f32 {
        f32::from_bits(self.speed_bits.load(Ordering::Acquire))
            .clamp(crate::tempo::MIN_SPEED, crate::tempo::MAX_SPEED)
    }

    pub fn set_volume(&self, volume: f32) {
        self.volume_bits
            .store(volume.clamp(0.0, 1.5).to_bits(), Ordering::Release);
    }

    pub fn volume(&self) -> f32 {
        f32::from_bits(self.volume_bits.load(Ordering::Acquire)).clamp(0.0, 1.5)
    }

    pub fn stall_timeout(&self) -> Duration {
        Duration::from_millis(self.stall_timeout_ms.load(Ordering::Acquire))
    }

    pub fn should_watch_for_stall(&self) -> bool {
        self.output_started.load(Ordering::Acquire)
            && !self.paused.load(Ordering::Acquire)
            && !self.stop.load(Ordering::Acquire)
            && !self.eof.load(Ordering::Acquire)
            && !self.decode_failed.load(Ordering::Acquire)
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
        self.underflow_buffering.store(false, Ordering::Release);
        self.resume_when_buffered
            .store(resume_when_buffered, Ordering::Release);
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
        generation
    }

    pub fn reset_filter_for_speed_change(&self, dsp_settings: &DspSettings) {
        let _queue = self.output_queue_wait.lock();
        self.realtime_output.clear();
        self.filter_generation.fetch_add(1, Ordering::AcqRel);
        self.eof.store(false, Ordering::Release);
        self.end_reported.store(false, Ordering::Release);
        self.underflow_buffering.store(false, Ordering::Release);
        self.resume_when_buffered.store(true, Ordering::Release);
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

    fn source_frames_for_output(&self, output_samples: usize) -> u64 {
        let output_frames = output_samples / self.mix_format.channels.max(1);
        ((output_frames as f64) * self.speed() as f64).round() as u64
    }
}

fn stall_timeout_millis(seconds: f64) -> u64 {
    if !seconds.is_finite() || seconds <= 0.0 {
        return 0;
    }
    (seconds.clamp(0.0, 60.0) * 1000.0).round() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_sample_format_candidates_follow_mpv_conversion_score() {
        assert_eq!(
            AudioSampleFormat::F32.best_output_formats(),
            vec![
                AudioSampleFormat::F32,
                AudioSampleFormat::F64,
                AudioSampleFormat::S32,
                AudioSampleFormat::S16,
                AudioSampleFormat::U8,
            ]
        );
        assert_eq!(
            AudioSampleFormat::Unknown.best_output_formats(),
            vec![
                AudioSampleFormat::S16,
                AudioSampleFormat::S32,
                AudioSampleFormat::F32,
                AudioSampleFormat::F64,
                AudioSampleFormat::U8,
            ]
        );
    }

    #[test]
    fn pop_into_advances_position_by_consumed_frames() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(100),
            0.1,
            8.0,
            &DspSettings::default(),
        );
        assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]));

        let mut output = [1.0f32; 8];
        let frames = shared.pop_into(&mut output);

        assert_eq!(frames, 4);
        assert_eq!(output, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
        assert!((shared.position_secs() - 0.04).abs() < f64::EPSILON);
    }

    #[test]
    fn queued_audio_keeps_source_clock_when_speed_changes() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(100),
            0.1,
            8.0,
            &DspSettings::default(),
        );
        assert!(
            shared.push_samples_with_source_frames(&[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8], 4,)
        );
        shared.set_speed(2.0);

        let mut output = [0.0f32; 8];
        let frames = shared.pop_into(&mut output);

        assert_eq!(frames, 4);
        assert!((shared.position_secs() - 0.04).abs() < f64::EPSILON);
    }

    #[test]
    fn position_reports_audible_clock_after_output_delay() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(100),
            0.1,
            8.0,
            &DspSettings::default(),
        );
        shared.update_output_stats(AudioOutputStats {
            backend: "test".to_string(),
            sample_rate: 100.0,
            engine_sample_rate: 100.0,
            channels: 2.0,
            format: "F32".to_string(),
            buffer_frames: 2.0,
            buffer_secs: 0.02,
            delay_secs: 0.02,
            underruns: 0.0,
        });
        assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]));

        let mut output = [0.0f32; 8];
        assert_eq!(shared.pop_into(&mut output), 4);

        assert!((shared.position_secs() - 0.02).abs() < f64::EPSILON);
    }

    #[test]
    fn seek_confirmation_is_emitted_when_seek_audio_is_ready() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(100),
            0.1,
            8.0,
            &DspSettings::default(),
        );
        let (tx, rx) = std::sync::mpsc::sync_channel(4);
        shared.bind_signal_sender(tx);
        shared.mark_seek_audio_ready(1.0);

        assert!(matches!(
            rx.try_recv(),
            Ok(PlaybackSignal::Seeked(position)) if (position - 1.0).abs() < f64::EPSILON
        ));
        assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4]));
        let mut output = [0.0f32; 4];
        assert_eq!(shared.pop_into(&mut output), 2);
    }

    #[test]
    fn pop_into_holds_short_non_eof_buffer_to_avoid_partial_silence() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(100),
            0.1,
            8.0,
            &DspSettings::default(),
        );
        assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4]));

        let mut output = [1.0f32; 8];
        let frames = shared.pop_into(&mut output);

        assert_eq!(frames, 0);
        assert_eq!(output, [0.0; 8]);
        assert_eq!(shared.position_secs(), 0.0);
    }

    #[test]
    fn pop_into_does_not_touch_wait_queue_lock() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(100),
            0.1,
            8.0,
            &DspSettings::default(),
        );
        assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4]));
        let _queue = shared.output_queue_wait.lock().expect("queue lock");

        let mut output = [1.0f32; 4];
        assert_eq!(shared.pop_into(&mut output), 2);
        assert_eq!(output, [0.1, 0.2, 0.3, 0.4]);
        assert!((shared.position_secs() - 0.02).abs() < f64::EPSILON);
    }

    #[test]
    fn eof_is_reported_only_after_buffer_is_drained() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(100),
            0.1,
            8.0,
            &DspSettings::default(),
        );
        assert!(shared.push_samples(&[0.1, 0.2]));

        shared.mark_eof();
        assert!(!shared.is_drained());

        let mut output = [0.0f32; 2];
        shared.pop_into(&mut output);

        assert!(shared.is_drained());
        assert!(shared.mark_end_reported());
        assert!(!shared.mark_end_reported());
    }

    #[test]
    fn output_drain_check_does_not_touch_wait_queue_lock() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(100),
            0.1,
            8.0,
            &DspSettings::default(),
        );
        shared.mark_eof();
        let _queue = shared.output_queue_wait.lock().expect("queue lock");

        assert!(shared.is_drained_for_output());
    }

    #[test]
    fn reset_for_decode_resume_clears_buffer_and_sets_position() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(100),
            0.1,
            8.0,
            &DspSettings::default(),
        );
        assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4]));
        shared.mark_eof();

        shared.reset_for_decode_resume(1.25, &DspSettings::default());

        let mut output = [1.0f32; 4];
        assert_eq!(shared.pop_into(&mut output), 0);
        assert_eq!(output, [0.0; 4]);
        assert!((shared.position_secs() - 1.25).abs() < f64::EPSILON);
        assert!(!shared.is_drained());
        assert!(shared.mark_end_reported());
    }

    #[test]
    fn reset_for_decode_resume_outputs_first_buffer_without_waiting_for_resume_threshold() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(100),
            2.0,
            8.0,
            &DspSettings::default(),
        );
        shared.reset_for_decode_resume(1.0, &DspSettings::default());
        assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4]));

        let mut output = [1.0f32; 8];
        let frames = shared.pop_into(&mut output);

        assert_eq!(frames, 2);
        assert_eq!(output, [0.1, 0.2, 0.3, 0.4, 0.0, 0.0, 0.0, 0.0]);
        assert!((shared.position_secs() - 1.02).abs() < f64::EPSILON);
    }

    #[test]
    fn reset_for_decode_resume_publishes_resume_when_first_audio_arrives() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(100),
            2.0,
            8.0,
            &DspSettings::default(),
        );
        let (tx, rx) = std::sync::mpsc::sync_channel(4);
        shared.bind_signal_sender(tx);
        shared.reset_for_decode_resume(1.0, &DspSettings::default());

        let mut output = [1.0f32; 4];
        assert_eq!(shared.pop_into(&mut output), 0);
        assert!(matches!(
            rx.try_recv(),
            Ok(PlaybackSignal::CacheState { paused: true, .. })
        ));

        assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4]));
        assert!(matches!(
            rx.try_recv(),
            Ok(PlaybackSignal::CacheState { paused: false, .. })
        ));
    }

    #[test]
    fn speed_filter_reset_keeps_decoded_queue_available() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(100),
            2.0,
            8.0,
            &DspSettings::default(),
        );
        let generation = shared.current_decode_generation();
        let chunk = DecodedAudioChunk::new(
            DecodedAudioFormat {
                sample_rate: shared.mix_format.sample_rate,
                sample_format: AudioSampleFormat::F32,
                channels: MIX_CHANNELS,
            },
            2,
            None,
            DecodedAudioData::F32(vec![0.1, 0.2, 0.3, 0.4]),
        );
        assert!(shared.push_decoded_chunk_for_generation(chunk.clone(), generation));
        let mut settings = DspSettings::default();
        settings.speed = 2.0;
        shared.reset_filter_for_speed_change(&settings);

        assert_eq!(
            shared.pop_decoded_for_filter(shared.current_filter_generation(),),
            FilterInput::Frame(chunk)
        );
    }

    #[test]
    fn gapless_filter_boundary_keeps_decoded_order() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(100),
            2.0,
            8.0,
            &DspSettings::default(),
        );
        let generation = shared.current_decode_generation();
        let first = DecodedAudioChunk::new(
            DecodedAudioFormat {
                sample_rate: 100,
                sample_format: AudioSampleFormat::F32,
                channels: MIX_CHANNELS,
            },
            1,
            None,
            DecodedAudioData::F32(vec![0.1, 0.2]),
        );
        let second = DecodedAudioChunk::new(
            DecodedAudioFormat {
                sample_rate: 100,
                sample_format: AudioSampleFormat::F32,
                channels: MIX_CHANNELS,
            },
            1,
            None,
            DecodedAudioData::F32(vec![0.3, 0.4]),
        );

        assert!(shared.push_decoded_chunk_for_generation(first.clone(), generation));
        shared.mark_gapless_boundary(TrackSwitchInfo {
            url: "next.flac".to_string(),
            audio_stream_ordinal: None,
            seq: 8,
            duration: 2.0,
        });
        assert!(shared.push_decoded_chunk_for_generation(second.clone(), generation));

        assert_eq!(
            shared.pop_decoded_for_filter(shared.current_filter_generation()),
            FilterInput::Frame(first)
        );
        assert_eq!(
            shared.pop_decoded_for_filter(shared.current_filter_generation()),
            FilterInput::Boundary
        );
        assert_eq!(
            shared.pop_decoded_for_filter(shared.current_filter_generation()),
            FilterInput::Frame(second)
        );
    }

    #[test]
    fn gapless_boundary_resets_position_after_crossing_track_switch() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(100),
            0.1,
            8.0,
            &DspSettings::default(),
        );
        let (tx, rx) = std::sync::mpsc::sync_channel(4);
        shared.bind_signal_sender(tx);
        assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4]));
        shared.mark_gapless_boundary(TrackSwitchInfo {
            url: "next.flac".to_string(),
            audio_stream_ordinal: None,
            seq: 7,
            duration: 3.0,
        });
        assert!(shared.push_samples(&[0.5, 0.6, 0.7, 0.8]));

        let mut output = [0.0f32; 8];
        assert_eq!(shared.pop_into(&mut output), 4);
        assert_eq!(output, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
        assert!((shared.position_secs() - 0.02).abs() < f64::EPSILON);

        match rx.try_recv() {
            Ok(PlaybackSignal::TrackSwitch(info)) => {
                assert_eq!(info.url, "next.flac");
                assert_eq!(info.seq, 7);
            }
            other => panic!("expected track switch signal, got {other:?}"),
        }
    }

    #[test]
    fn stall_timeout_can_be_disabled_and_clamped() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(100),
            0.1,
            8.0,
            &DspSettings::default(),
        );
        assert_eq!(shared.stall_timeout(), Duration::from_secs(8));

        shared.set_stall_timeout(0.0);
        assert_eq!(shared.stall_timeout(), Duration::ZERO);

        shared.set_stall_timeout(120.0);
        assert_eq!(shared.stall_timeout(), Duration::from_secs(60));
    }

    #[test]
    fn output_queue_capacity_follows_mpv_sized_audio_buffer() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(100),
            0.2,
            8.0,
            &DspSettings::default(),
        );

        assert_eq!(shared.output_queue_capacity, 40);
        assert_eq!(shared.decoded_queue_capacity_frames, 100);
    }

    #[test]
    fn cache_pause_resume_counts_decoded_readahead() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(100),
            0.2,
            8.0,
            &DspSettings::default(),
        );
        assert!(shared.push_samples(&vec![0.1; 40]));
        assert!(shared.push_decoded_chunk_for_generation(
            DecodedAudioChunk::new(
                DecodedAudioFormat {
                    sample_rate: 100,
                    sample_format: AudioSampleFormat::F32,
                    channels: MIX_CHANNELS,
                },
                80,
                None,
                DecodedAudioData::F32(vec![0.2; 160]),
            ),
            shared.current_decode_generation(),
        ));
        shared.underflow_buffering.store(true, Ordering::Release);

        let mut output = [0.0f32; 4];
        let frames = shared.pop_into(&mut output);

        assert_eq!(frames, 2);
        assert_eq!(output, [0.1; 4]);
        assert!(!shared.underflow_buffering.load(Ordering::Acquire));
    }
}
