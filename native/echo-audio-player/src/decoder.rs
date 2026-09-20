use crate::events::{PlayerErrorCode, PlayerEvent, TrackInfo};
use crate::shared::{
    AudioSampleFormat, DecodedAudioChunk, DecodedAudioData, DecodedAudioFormat,
    PacketCacheSeekableRange, PacketCacheStats, SharedAudio,
};
use crate::stream::{open_stream, ReadSeek, StreamOptions};
use crate::transition_runner::{
    split_chunk_at, AbortedTransition, ArmedTransition, RunnerStep, TransitionRunner,
};
use ffmpeg_audio::{sys, AudioError, AudioReader, PacketCacheOptions, RawAudioData, SeekMode};
use std::collections::VecDeque;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TryRecvError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub enum DecodeCommand {
    Seek {
        position_secs: f64,
        generation: u64,
        /// Track the caller believes is playing (`runtime.current_seq`). During a
        /// transition this decides whether the seek targets the outgoing or the incoming
        /// track; `None` means "whatever is live".
        track_seq: Option<u64>,
        reply: SyncSender<Result<(), String>>,
    },
    PrepareSourceSwitch {
        track_seq: u64,
        generation: u64,
        interrupt: Arc<AtomicBool>,
        reply: SyncSender<Result<(), String>>,
    },
    SwitchSource {
        decoder: Box<DecoderData>,
        predecoded: Vec<DecodedAudioChunk>,
        switch_at_secs: f64,
        generation: u64,
        track_seq: Option<u64>,
        reply: SyncSender<Result<f64, String>>,
    },
    SwitchTrack {
        decoder: Box<DecoderData>,
        predecoded: Vec<DecodedAudioChunk>,
        info: crate::shared::TrackSwitchInfo,
        preferred_output_sample_format: AudioSampleFormat,
        normalization_gain_db: f32,
        transition_fade_frames: usize,
        generation: u64,
        reply: SyncSender<Result<(), String>>,
    },
    /// Hold a prepared transition until the current decoder reaches its cut point.
    ArmTransition {
        armed: Box<ArmedTransition>,
        generation: u64,
    },
    /// Drop the armed transition (queue changed, settings changed, prepare cancelled).
    DisarmTransition {
        request_id: Option<u64>,
        reset_position_secs: Option<f64>,
    },
    /// Start the armed transition now (manual skip). The caller has already reset the
    /// pipeline to `generation` at `resume_position_secs` (the audible position), so the
    /// outgoing decoder is re-seeked there and the blend starts where the listener is,
    /// capped to `max_overlap_secs`.
    StartTransition {
        max_overlap_secs: f64,
        resume_position_secs: f64,
        generation: u64,
        reply: SyncSender<Result<(), String>>,
    },
    Stop,
}

pub struct DecoderData {
    reader: AudioReader,
    interrupt: Arc<AtomicBool>,
    duration: Option<Duration>,
    pending_playback_restart_position: Option<f64>,
    seeked_to_end: bool,
    mix_sample_rate: u32,
    source_channels: usize,
    source_sample_format: AudioSampleFormat,
    discard_before_secs: Option<f64>,
}

impl DecoderData {
    pub fn open(
        url: String,
        audio_stream_ordinal: Option<usize>,
        mix_sample_rate: Option<u32>,
        interrupt: Arc<AtomicBool>,
        packet_cache: PacketCacheOptions,
        stream_options: &StreamOptions,
    ) -> Result<Self, String> {
        let source = open_stream(&url, interrupt.clone(), stream_options)?;
        Self::from_source(
            url,
            audio_stream_ordinal,
            mix_sample_rate,
            interrupt,
            source,
            packet_cache,
        )
    }

    fn from_source(
        _url: String,
        audio_stream_ordinal: Option<usize>,
        mix_sample_rate: Option<u32>,
        interrupt: Arc<AtomicBool>,
        source: Box<dyn ReadSeek>,
        packet_cache: PacketCacheOptions,
    ) -> Result<Self, String> {
        let reader = AudioReader::new_with_audio_stream_packet_cache_and_interrupt(
            source,
            audio_stream_ordinal,
            packet_cache,
            interrupt.clone(),
        )
        .map_err(|err| format!("failed to create audio decoder: {err}"))?;
        let duration = reader.duration();
        let source_info = reader.source_info();
        let source_sample_format = source_sample_format(source_info);
        let source_channels = source_channels(source_info);
        let mix_sample_rate = mix_sample_rate.unwrap_or_else(|| source_sample_rate(source_info));
        Ok(Self {
            reader,
            interrupt,
            duration,
            pending_playback_restart_position: None,
            seeked_to_end: false,
            mix_sample_rate,
            source_channels,
            source_sample_format,
            discard_before_secs: None,
        })
    }

    pub fn duration_secs(&self) -> f64 {
        self.duration
            .map(|duration| duration.as_secs_f64())
            .unwrap_or_default()
    }

    pub fn interrupt_handle(&self) -> Arc<AtomicBool> {
        self.interrupt.clone()
    }

    pub fn source_sample_format(&self) -> AudioSampleFormat {
        self.source_sample_format
    }

    pub fn mix_sample_rate(&self) -> u32 {
        self.mix_sample_rate
    }

    pub fn source_channels(&self) -> usize {
        self.source_channels
    }

    pub fn seek(&mut self, position_secs: f64) -> Result<(), String> {
        let elapsed_ms = self.seek_and_measure(position_secs, true, || false)?;
        log_seek_elapsed(position_secs, elapsed_ms);
        Ok(())
    }

    pub fn prepare_seamless_seek(&mut self, position_secs: f64) -> Result<u128, String> {
        self.seek_and_measure(position_secs, false, || false)
    }

    pub fn prepare_cancellable_seek(
        &mut self,
        position_secs: f64,
        is_cancelled: impl Fn() -> bool,
    ) -> Result<u128, String> {
        self.seek_and_measure(position_secs, false, is_cancelled)
    }

    /// Drop decoded frames before `position_secs` (sample-accurate alignment after a
    /// seek that landed on an earlier codec frame). `None` disables trimming.
    pub fn set_discard_before_secs(&mut self, position_secs: Option<f64>) {
        self.discard_before_secs = position_secs.filter(|secs| secs.is_finite() && *secs > 0.0);
    }

    fn seek_and_measure(
        &mut self,
        position_secs: f64,
        announce_restart: bool,
        is_cancelled: impl Fn() -> bool,
    ) -> Result<u128, String> {
        if is_cancelled() {
            return Err("decoder seek cancelled".to_string());
        }
        let position_secs = normalize_seek_position(position_secs);
        let target = Duration::from_secs_f64(position_secs);
        let started = Instant::now();
        if self
            .duration
            .is_some_and(|duration| seek_position_is_at_end(target, duration))
        {
            self.seeked_to_end = true;
            self.pending_playback_restart_position = None;
            return Ok(started.elapsed().as_millis());
        }

        self.seeked_to_end = false;
        self.reader
            .seek(target, SeekMode::Accurate)
            .or_else(|accurate_err| {
                // Request cancellation is separate from the reader's temporary seek interrupt.
                if is_cancelled() {
                    return Err("decoder seek cancelled".to_string());
                }
                emit_decode_warning(format!(
                    "accurate seek failed, falling back to coarse seek: {accurate_err}"
                ));
                self.reader.seek(target, SeekMode::Coarse).map_err(|coarse_err| {
                    format!(
                        "failed to seek decoder: accurate seek failed with {accurate_err}; coarse seek failed with {coarse_err}"
                    )
                })
            })?;
        if is_cancelled() {
            return Err("decoder seek cancelled".to_string());
        }
        self.pending_playback_restart_position = announce_restart.then_some(position_secs);
        Ok(started.elapsed().as_millis())
    }

    /// Emit the playback-restart confirmation after the first decoded frame reaches the audio pipeline.
    pub fn confirm_playback_restart_when_audio_ready(&mut self, position_secs: f64) {
        self.pending_playback_restart_position = Some(position_secs.max(0.0));
    }

    pub fn decode_next_chunk(&mut self) -> Result<Option<DecodedAudioChunk>, String> {
        loop {
            let chunk = self
                .reader
                .receive_frame()
                .map_err(|err| format!("failed to decode audio source: {err}"))?
                .map(|frame| decoded_chunk_from_frame(&frame))
                .transpose()?;
            let Some(mut chunk) = chunk else {
                return Ok(None);
            };
            // Honour a pending sample-accurate alignment (seek landed on an earlier frame).
            if !align_switched_chunk(&mut chunk, &mut self.discard_before_secs) {
                continue;
            }
            return Ok(Some(chunk));
        }
    }

    #[cfg(test)]
    pub fn predecode_chunks(&mut self, seconds: f64) -> Result<Vec<DecodedAudioChunk>, String> {
        let mut chunks = Vec::new();
        let mut decoded_secs = 0.0;
        while decoded_secs < seconds.max(0.0) && !self.seeked_to_end {
            let Some(chunk) = self.decode_next_chunk()? else {
                break;
            };
            decoded_secs += chunk.frames as f64 / f64::from(chunk.format.sample_rate.max(1));
            chunks.push(chunk);
        }
        Ok(chunks)
    }

    pub fn prepare_source_switch_chunks(
        &mut self,
        seek_position_secs: f64,
        predecode_secs: f64,
        playback_position: impl Fn() -> f64,
        is_cancelled: impl Fn() -> bool,
    ) -> Result<(f64, Vec<DecodedAudioChunk>), String> {
        catch_up_source_switch(
            seek_position_secs,
            self.duration_secs(),
            predecode_secs,
            playback_position,
            is_cancelled,
            || self.decode_next_chunk(),
            Duration::from_secs(5),
        )
    }

    fn publish_packet_cache_stats(&self, shared: &SharedAudio) {
        shared.update_packet_cache_stats(packet_cache_stats_from_reader(&self.reader));
    }

    fn is_recoverable_tail_error(&self, err: &AudioError, produced_frames: u64) -> bool {
        let is_invalid_data =
            matches!(err, AudioError::FFmpeg(code, _) if *code == sys::AVERROR_INVALIDDATA);
        let is_io_error =
            matches!(err, AudioError::FFmpeg(code, _) if *code == sys::averror(libc::EIO));
        if !is_invalid_data && !is_io_error {
            return false;
        }
        let Some(duration) = self.duration else {
            return false;
        };
        if self
            .pending_playback_restart_position
            .is_some_and(|position| seek_position_is_near_end(position, duration))
        {
            return true;
        }
        if produced_frames == 0 || !is_invalid_data {
            return false;
        }
        let Some(position) = self.reader.stream_position() else {
            return false;
        };
        let tail_tolerance = Duration::from_secs_f64(duration.as_secs_f64().mul_add(0.02, 1.0));
        position.saturating_add(tail_tolerance) >= duration
    }
}

// Keep a short rolling PCM window near the live clock. A slow initial seek
// must not trigger another remote seek followed by seconds of scheduled waiting.
fn catch_up_source_switch(
    seek_position_secs: f64,
    duration_secs: f64,
    predecode_secs: f64,
    playback_position: impl Fn() -> f64,
    is_cancelled: impl Fn() -> bool,
    mut decode_next: impl FnMut() -> Result<Option<DecodedAudioChunk>, String>,
    budget: Duration,
) -> Result<(f64, Vec<DecodedAudioChunk>), String> {
    let started = Instant::now();
    let mut chunks: VecDeque<DecodedAudioChunk> = VecDeque::new();
    let mut decoded_end = seek_position_secs;
    let mut eof = false;
    loop {
        if is_cancelled() {
            return Err("source switch cancelled during catch-up".to_string());
        }
        if started.elapsed() >= budget {
            return Err("source switch preparation timed out during catch-up".to_string());
        }
        let position = playback_position().max(0.0);
        if duration_secs > 0.0 && position >= duration_secs {
            return Err("source switch cancelled: replacement ended before hand-off".to_string());
        }
        let mut switch_at = position + 0.2;
        if duration_secs > 0.0 {
            switch_at = switch_at.min((duration_secs - 0.05).max(0.0));
        }
        let mut discard_before = Some(switch_at);
        while let Some(front) = chunks.front_mut() {
            if align_switched_chunk(front, &mut discard_before) {
                break;
            }
            chunks.pop_front();
        }
        if !chunks.is_empty() && (decoded_end >= switch_at + predecode_secs.max(0.5) || eof) {
            return Ok((switch_at, chunks.into_iter().collect()));
        }
        if eof {
            return Err("source switch cancelled: replacement ended before hand-off".to_string());
        }
        match decode_next()? {
            Some(mut chunk) => {
                // Some demuxers omit frame timestamps; retain the sequential clock
                // so trimming and the worker hand-off still agree on sample position.
                if chunk.pts_secs.is_none() {
                    chunk.pts_secs = Some(decoded_end);
                }
                decoded_end = decoded_chunk_end_secs(&chunk, decoded_end);
                chunks.push_back(chunk);
            }
            None => eof = true,
        }
    }
}

const TERMINAL_SEEK_TOLERANCE: Duration = Duration::from_millis(50);
const TAIL_SEEK_ERROR_TOLERANCE: Duration = Duration::from_millis(250);
fn normalize_seek_position(position_secs: f64) -> f64 {
    if position_secs.is_finite() {
        position_secs.max(0.0)
    } else {
        0.0
    }
}

fn seek_position_is_at_end(target: Duration, duration: Duration) -> bool {
    !duration.is_zero() && target.saturating_add(TERMINAL_SEEK_TOLERANCE) >= duration
}

fn seek_position_is_near_end(position_secs: f64, duration: Duration) -> bool {
    if duration.is_zero() {
        return false;
    }
    let target = Duration::from_secs_f64(normalize_seek_position(position_secs));
    target.saturating_add(TAIL_SEEK_ERROR_TOLERANCE) >= duration
}

fn await_gapless_decoder<F>(
    shared: &Arc<SharedAudio>,
    generation: u64,
    mut activate: F,
) -> crate::GaplessDecodeResult
where
    F: FnMut() -> crate::GaplessDecodeResult,
{
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match activate() {
            result @ crate::GaplessDecodeResult::Activated(_) => return result,
            crate::GaplessDecodeResult::NotPrepared => {}
        }
        if shared.should_stop_decoding() || !shared.is_decode_generation_current(generation) {
            return crate::GaplessDecodeResult::NotPrepared;
        }

        let Some(request_id) = shared.pending_gapless_prepare_request() else {
            // Preparation may finish after the first activation check but before the
            // pending flag is read. Give the newly published source one final check.
            return activate();
        };
        if Instant::now() >= deadline {
            shared.cancel_gapless_prepare(request_id);
            emit_decode_warning(
                "gapless EOF wait timed out; continuing with normal track change".to_string(),
            );
            return crate::GaplessDecodeResult::NotPrepared;
        }
        shared.wait_for_gapless_prepare_change(request_id);
    }
}

fn activate_gapless_at_eof(
    shared: &Arc<SharedAudio>,
    generation: u64,
) -> crate::GaplessDecodeResult {
    await_gapless_decoder(shared, generation, || {
        crate::activate_gapless_next_decoder(shared.clone(), generation)
    })
}

fn source_sample_format(info: &ffmpeg_audio::SourceAudioInfo) -> AudioSampleFormat {
    match info.sample_fmt.as_deref().map(strip_planar_suffix) {
        Some("u8") => AudioSampleFormat::U8,
        Some("s16") => AudioSampleFormat::S16,
        Some("s32") => AudioSampleFormat::S32,
        Some("flt") => AudioSampleFormat::F32,
        Some("dbl") => AudioSampleFormat::F64,
        _ if info.bits_per_sample > 16 => AudioSampleFormat::S32,
        _ if info.bits_per_sample > 0 => AudioSampleFormat::S16,
        _ => AudioSampleFormat::Unknown,
    }
}

fn strip_planar_suffix(format: &str) -> &str {
    format.strip_suffix('p').unwrap_or(format)
}

fn decoded_chunk_from_frame(
    frame: &ffmpeg_audio::AudioFrame<'_>,
) -> Result<DecodedAudioChunk, String> {
    let sample_format = frame_sample_format(frame.sample_fmt()).ok_or_else(|| {
        format!(
            "unsupported decoded sample format: {:?}",
            frame.sample_fmt()
        )
    })?;
    let sample_rate = u32::try_from(frame.frame_sample_rate())
        .ok()
        .filter(|rate| *rate > 0)
        .unwrap_or(48_000);
    let channels = frame.channels().max(1);
    let frames = frame.samples();
    let pts_secs = frame.pts().map(|pts| pts.as_secs_f64());
    let format = DecodedAudioFormat {
        sample_rate,
        sample_format,
        channels,
    };

    let data = match sample_format {
        AudioSampleFormat::U8 => DecodedAudioData::U8(copy_frame_data::<u8>(frame, channels)?),
        AudioSampleFormat::S16 => DecodedAudioData::I16(copy_frame_data::<i16>(frame, channels)?),
        AudioSampleFormat::S32 => DecodedAudioData::I32(copy_frame_data::<i32>(frame, channels)?),
        AudioSampleFormat::F32 => DecodedAudioData::F32(copy_frame_data::<f32>(frame, channels)?),
        AudioSampleFormat::F64 => DecodedAudioData::F64(copy_frame_data::<f64>(frame, channels)?),
        AudioSampleFormat::Unknown => {
            return Err("decoded audio frame has unknown sample format".to_string());
        }
    };

    Ok(DecodedAudioChunk::new(format, frames, pts_secs, data))
}

fn frame_sample_format(format: sys::AVSampleFormat) -> Option<AudioSampleFormat> {
    match format {
        sys::AVSampleFormat_AV_SAMPLE_FMT_U8 | sys::AVSampleFormat_AV_SAMPLE_FMT_U8P => {
            Some(AudioSampleFormat::U8)
        }
        sys::AVSampleFormat_AV_SAMPLE_FMT_S16 | sys::AVSampleFormat_AV_SAMPLE_FMT_S16P => {
            Some(AudioSampleFormat::S16)
        }
        sys::AVSampleFormat_AV_SAMPLE_FMT_S32 | sys::AVSampleFormat_AV_SAMPLE_FMT_S32P => {
            Some(AudioSampleFormat::S32)
        }
        sys::AVSampleFormat_AV_SAMPLE_FMT_FLT | sys::AVSampleFormat_AV_SAMPLE_FMT_FLTP => {
            Some(AudioSampleFormat::F32)
        }
        sys::AVSampleFormat_AV_SAMPLE_FMT_DBL | sys::AVSampleFormat_AV_SAMPLE_FMT_DBLP => {
            Some(AudioSampleFormat::F64)
        }
        _ => None,
    }
}

fn copy_frame_data<T>(
    frame: &ffmpeg_audio::AudioFrame<'_>,
    channels: usize,
) -> Result<Vec<T>, String>
where
    T: ffmpeg_audio::AudioSample,
{
    match frame.raw_data::<T>() {
        Ok(RawAudioData::Packed(samples)) => Ok(samples.to_vec()),
        Ok(RawAudioData::Planar(planes)) => Ok(interleave_planes(&planes, channels)),
        Err(err) => Err(format!("failed to read decoded frame data: {err}")),
    }
}

fn interleave_planes<T>(planes: &[&[T]], channels: usize) -> Vec<T>
where
    T: Copy,
{
    let frames = planes.first().map(|plane| plane.len()).unwrap_or_default();
    let channels = channels.max(1);
    let mut output = Vec::with_capacity(frames.saturating_mul(channels));
    for frame in 0..frames {
        for channel in 0..channels {
            if let Some(sample) = planes
                .get(channel)
                .and_then(|plane| plane.get(frame))
                .or_else(|| planes.first().and_then(|plane| plane.get(frame)))
            {
                output.push(*sample);
            }
        }
    }
    output
}

fn source_sample_rate(info: &ffmpeg_audio::SourceAudioInfo) -> u32 {
    u32::try_from(info.sample_rate)
        .ok()
        .filter(|sample_rate| *sample_rate > 0)
        .unwrap_or(48_000)
}

fn source_channels(info: &ffmpeg_audio::SourceAudioInfo) -> usize {
    usize::try_from(info.channels)
        .ok()
        .filter(|channels| *channels > 0)
        .unwrap_or(2)
}

fn packet_cache_stats_from_reader(reader: &AudioReader) -> PacketCacheStats {
    let stats = reader.packet_cache_stats();
    PacketCacheStats {
        forward_bytes: stats.forward_bytes as f64,
        back_bytes: stats.back_bytes as f64,
        total_bytes: stats.total_bytes as f64,
        forward_secs: stats
            .forward_duration
            .map(|duration| duration.as_secs_f64()),
        seekable_ranges: stats
            .seekable_ranges
            .into_iter()
            .map(|range| PacketCacheSeekableRange {
                start_secs: range.start.as_secs_f64(),
                end_secs: range.end.as_secs_f64(),
            })
            .collect(),
        eof: stats.eof,
        pending_seek: stats.pending_seek,
        has_error: stats.has_error,
    }
}

pub fn open_decoder(
    url: String,
    audio_stream_ordinal: Option<usize>,
    mix_sample_rate: Option<u32>,
    packet_cache: PacketCacheOptions,
    stream_options: &StreamOptions,
) -> Result<DecoderData, String> {
    open_decoder_with_interrupt(
        url,
        audio_stream_ordinal,
        mix_sample_rate,
        Arc::new(AtomicBool::new(false)),
        packet_cache,
        stream_options,
    )
}

pub fn open_decoder_with_interrupt(
    url: String,
    audio_stream_ordinal: Option<usize>,
    mix_sample_rate: Option<u32>,
    interrupt: Arc<AtomicBool>,
    packet_cache: PacketCacheOptions,
    stream_options: &StreamOptions,
) -> Result<DecoderData, String> {
    DecoderData::open(
        url,
        audio_stream_ordinal,
        mix_sample_rate,
        interrupt,
        packet_cache,
        stream_options,
    )
}

pub fn spawn_decode_worker(
    data: DecoderData,
    shared: Arc<SharedAudio>,
    generation: u64,
) -> Result<(JoinHandle<Option<DecoderData>>, SyncSender<DecodeCommand>), String> {
    let (tx, rx) = sync_channel::<DecodeCommand>(8);
    let panic_shared = shared.clone();
    let handle = thread::Builder::new()
        .name("player-decode".to_string())
        .spawn(move || {
            let _qos = crate::platform_qos::boost_audio_producer_thread();
            match catch_unwind(AssertUnwindSafe(|| {
                decode_worker_loop(data, shared, generation, rx)
            })) {
                Ok(result) => result,
                Err(payload) => {
                    panic_shared.mark_decode_failed();
                    emit_decode_error(
                        &panic_shared,
                        format!(
                            "decoder worker panicked: {}",
                            panic_payload_message(payload.as_ref())
                        ),
                    );
                    None
                }
            }
        })
        .map_err(|err| format!("failed to spawn player decode worker: {err}"))?;
    Ok((handle, tx))
}

/// Mutable per-worker state shared by the main loop and the command handlers.
struct WorkerState {
    decoded_position_secs: f64,
    /// Track sequence of the decoder currently in `data` (the live/outgoing track).
    live_seq: u64,
    pending_source_switch: Option<PendingSourceSwitch>,
    /// Transition waiting for the current decoder to reach its cut point.
    armed_transition: Option<Box<ArmedTransition>>,
    /// A transition armed for the *next* hand-off while a runner is still active
    /// (short incoming track, or the renderer prefetched early). Promoted when the
    /// runner finishes and its outgoing track matches.
    pending_arm: Option<Box<ArmedTransition>>,
    /// Transition currently being rendered.
    runner: Option<TransitionRunner>,
    /// Manual-skip request that arrived before the transition could start:
    /// `(max_overlap_secs, resume_position_secs, reply)`.
    start_now: Option<(f64, f64, SyncSender<Result<(), String>>)>,
    /// Recent decoded chunks of the live track (kept only while a transition is armed),
    /// used to pre-roll the tempo stretcher with audio from before the cut point.
    recent_chunks: std::collections::VecDeque<DecodedAudioChunk>,
    recent_frames: usize,
}

/// Seconds of recent audio retained for the stretcher pre-roll.
const RECENT_HISTORY_SECS: f64 = 0.5;

impl WorkerState {
    fn new(decoded_position_secs: f64, live_seq: u64) -> Self {
        Self {
            decoded_position_secs,
            live_seq,
            pending_source_switch: None,
            armed_transition: None,
            pending_arm: None,
            runner: None,
            start_now: None,
            recent_chunks: std::collections::VecDeque::new(),
            recent_frames: 0,
        }
    }

    /// Remember a chunk of the live track for the stretcher pre-roll.
    fn remember_chunk(&mut self, chunk: &DecodedAudioChunk) {
        if self.armed_transition.is_none() {
            if !self.recent_chunks.is_empty() {
                self.recent_chunks.clear();
                self.recent_frames = 0;
            }
            return;
        }
        let limit = (RECENT_HISTORY_SECS * f64::from(chunk.format.sample_rate.max(1))) as usize;
        self.recent_chunks.push_back(chunk.clone());
        self.recent_frames += chunk.frames;
        while self.recent_frames > limit && self.recent_chunks.len() > 1 {
            if let Some(dropped) = self.recent_chunks.pop_front() {
                self.recent_frames = self.recent_frames.saturating_sub(dropped.frames);
            }
        }
    }

    fn take_recent_chunks(&mut self) -> Vec<DecodedAudioChunk> {
        self.recent_frames = 0;
        self.recent_chunks.drain(..).collect()
    }

    /// Drop everything transition-related (Stop / source replacement).
    fn drop_transition_state(&mut self) {
        crate::retire_value_background(
            self.armed_transition.take(),
            "player-transition-armed-reaper".to_string(),
        );
        crate::retire_value_background(
            self.pending_arm.take(),
            "player-transition-pending-reaper".to_string(),
        );
        self.fail_start_now("transition cancelled");
    }

    fn fail_start_now(&mut self, reason: &str) {
        if let Some((_, _, reply)) = self.start_now.take() {
            let _ = reply.send(Err(reason.to_string()));
        }
    }

    /// Whether a command that names `track_seq` refers to the incoming deck of the
    /// active runner (the UI has already switched to it).
    fn targets_incoming(&self, track_seq: Option<u64>, shared: &SharedAudio) -> bool {
        match (track_seq, self.runner.as_ref()) {
            (Some(seq), Some(runner)) => seq == runner.incoming_seq(),
            (None, Some(runner)) => shared.current_track_seq() == runner.incoming_seq(),
            _ => false,
        }
    }
}

/// Stop the mix without seeking the unused deck; the audible track remains live.
fn abort_runner(
    data: &mut DecoderData,
    shared: &Arc<SharedAudio>,
    state: &mut WorkerState,
    prefer_incoming: bool,
) {
    let Some(runner) = state.runner.take() else {
        return;
    };
    shared.bind_secondary_interrupt(None);
    let incoming_seq = runner.incoming_seq();
    // The output callback publishes the incoming track's sequence exactly when it crosses
    // the boundary; anything queued but not yet rendered was thrown away by the reset.
    let incoming_is_audible = shared.current_track_seq() == incoming_seq;
    match runner.abort_for_transport(incoming_is_audible || prefer_incoming) {
        Some((decoder, position)) => {
            // The incoming track is already audible: it is the live decoder now, whatever
            // the caller asked for.
            let previous = std::mem::replace(data, decoder);
            crate::retire_value_background(
                Some(previous),
                "player-transition-outgoing-reaper".to_string(),
            );
            state.decoded_position_secs = position;
            state.live_seq = incoming_seq;
            shared.bind_interrupt(data.interrupt.clone());
        }
        None => {
            shared.bind_interrupt(data.interrupt.clone());
        }
    }
}

fn disarm_matching_runner(
    data: &mut DecoderData,
    shared: &Arc<SharedAudio>,
    state: &mut WorkerState,
    request_id: Option<u64>,
) {
    let Some(runner) = state.runner.take() else {
        return;
    };
    if !runner.matches_request(request_id) {
        state.runner = Some(runner);
        return;
    }
    shared.bind_secondary_interrupt(None);
    let incoming_seq = runner.incoming_seq();
    let incoming_is_audible = shared.current_track_seq() == incoming_seq;
    match runner.abort(incoming_is_audible) {
        Some(AbortedTransition::Live(decoder, position)) => {
            let previous = std::mem::replace(data, decoder);
            crate::retire_value_background(
                Some(previous),
                "player-transition-disarm-outgoing-reaper".to_string(),
            );
            state.decoded_position_secs = position;
            state.live_seq = incoming_seq;
            shared.bind_interrupt(data.interrupt.clone());
        }
        Some(AbortedTransition::Rearm(armed)) => {
            crate::retire_value_background(
                Some(armed),
                "player-transition-disarm-incoming-reaper".to_string(),
            );
            shared.bind_interrupt(data.interrupt.clone());
        }
        None => {
            shared.bind_interrupt(data.interrupt.clone());
        }
    }
}

fn decode_worker_loop(
    mut data: DecoderData,
    shared: Arc<SharedAudio>,
    mut generation: u64,
    commands: Receiver<DecodeCommand>,
) -> Option<DecoderData> {
    shared.bind_interrupt(data.interrupt.clone());
    let mut produced_frames = 0u64;
    let mut state = WorkerState::new(shared.position_secs(), shared.current_track_seq());

    loop {
        match handle_decode_commands(&mut data, &shared, &commands, &mut state) {
            DecodeCommandDrain::Continue(Some(next_generation)) => {
                generation = next_generation;
                produced_frames = 0;
            }
            DecodeCommandDrain::Continue(None) => {}
            DecodeCommandDrain::Stop => {
                return (!shared.stop.load(Ordering::Acquire)).then_some(data);
            }
        }
        if activate_pending_source_switch(&mut data, &shared, &mut state) {
            produced_frames = 0;
        }
        data.publish_packet_cache_stats(&shared);
        if shared.should_stop_decoding() {
            return (!shared.stop.load(Ordering::Acquire)).then_some(data);
        }
        if !shared.is_decode_generation_current(generation) {
            // A reset invalidated everything in flight. A running mix is abandoned; if
            // the incoming track was already audible it stays live, otherwise deck B is
            // retired and the outgoing track resumes when the next command arrives.
            abort_runner(&mut data, &shared, &mut state, false);
            state.fail_start_now("playback reset");
            match wait_for_generation_command(&mut data, &shared, &commands, &mut state) {
                Some(next_generation) => {
                    generation = next_generation;
                    produced_frames = 0;
                    continue;
                }
                None => return (!shared.stop.load(Ordering::Acquire)).then_some(data),
            }
        }

        // ---- Transition rendering -------------------------------------------------------
        if let Some(runner) = state.runner.as_mut() {
            match runner.step(&shared, &mut data) {
                RunnerStep::Continue => {
                    // Yield briefly when the output queue is full or a deck is starved so the
                    // loop does not spin; the decoded-queue wait inside push already blocks
                    // when the queue is at capacity.
                    continue;
                }
                RunnerStep::Finished(handoff) => {
                    let finished_seq = state
                        .runner
                        .as_ref()
                        .map(|runner| runner.incoming_seq())
                        .unwrap_or(state.live_seq);
                    state.runner = None;
                    let outgoing = std::mem::replace(&mut data, handoff.decoder);
                    crate::retire_value_background(
                        Some(outgoing),
                        "player-transition-outgoing-reaper".to_string(),
                    );
                    state.decoded_position_secs = handoff.decoded_position_secs;
                    state.live_seq = finished_seq;
                    produced_frames = handoff.produced_frames;
                    shared.bind_interrupt(data.interrupt.clone());
                    shared.bind_secondary_interrupt(None);
                    data.publish_packet_cache_stats(&shared);
                    // A transition prepared for the track that just became live can now
                    // be armed normally.
                    if let Some(pending) = state.pending_arm.take() {
                        if pending.outgoing_seq == state.live_seq {
                            state.armed_transition = Some(pending);
                        } else {
                            crate::retire_value_background(
                                Some(pending),
                                "player-transition-stale-arm-reaper".to_string(),
                            );
                        }
                    }
                    emit_decode_info(&shared, "transition finished; incoming track continues");
                    continue;
                }
                RunnerStep::Failed(err) => {
                    state.runner = None;
                    shared.mark_decode_failed();
                    emit_decode_error(&shared, format!("song transition failed: {err}"));
                    return None;
                }
            }
        }

        // ---- Manual start request -------------------------------------------------------
        if let Some((max_overlap_secs, resume_position_secs, reply)) = state.start_now.take() {
            match state.armed_transition.take() {
                Some(mut armed) => {
                    // The control side reset the queues at the audible position; move the
                    // outgoing decoder there so the blend starts where the listener is.
                    if (state.decoded_position_secs - resume_position_secs).abs() > 0.05 {
                        match data.prepare_seamless_seek(resume_position_secs) {
                            Ok(_) => {
                                data.set_discard_before_secs(Some(resume_position_secs));
                                state.decoded_position_secs = resume_position_secs;
                            }
                            Err(err) => {
                                emit_decode_warning(format!(
                                    "manual transition: re-seek to audible position failed, blending from decode position: {err}"
                                ));
                            }
                        }
                    }
                    armed.start_now(state.decoded_position_secs, max_overlap_secs);
                    match begin_transition(
                        &shared,
                        &mut data,
                        armed,
                        None,
                        state.take_recent_chunks(),
                        &mut state,
                        generation,
                    ) {
                        Ok(()) => {
                            let _ = reply.send(Ok(()));
                        }
                        Err((err, armed)) => {
                            emit_decode_warning(format!(
                                "manual transition could not start; switching directly: {err}"
                            ));
                            hand_off_armed_directly(
                                &shared, &mut data, armed, &mut state, generation,
                            );
                            let _ = reply.send(Ok(()));
                        }
                    }
                }
                None => {
                    let _ = reply.send(Err("no transition armed".to_string()));
                }
            }
            continue;
        }

        let decode_result = if data.seeked_to_end {
            Ok(None)
        } else {
            data.reader.receive_frame()
        };
        match decode_result {
            Ok(Some(frame)) => match decoded_chunk_from_frame(&frame) {
                Ok(mut chunk) => {
                    if !align_switched_chunk(&mut chunk, &mut data.discard_before_secs) {
                        continue;
                    }
                    data.publish_packet_cache_stats(&shared);
                    if !shared.is_decode_generation_current(generation) {
                        continue;
                    }
                    if let Some(requested_position) = data.pending_playback_restart_position {
                        if chunk.frames > 0 {
                            let position = chunk.pts_secs.unwrap_or(requested_position);
                            shared.mark_playback_restart_ready_for_generation(position, generation);
                            data.pending_playback_restart_position = None;
                        }
                    }
                    if produced_frames > 0 {
                        if let Some(actual_pts) = chunk.pts_secs {
                            if let Some(delta_secs) = decoded_pts_discontinuity(
                                state.decoded_position_secs,
                                actual_pts,
                                chunk.format.sample_rate,
                            ) {
                                emit_decode_warning(format!(
                                    "decoded audio timestamp discontinuity: expected={:.6}s actual={:.6}s delta={:+.3}ms generation={generation}",
                                    state.decoded_position_secs,
                                    actual_pts,
                                    delta_secs * 1_000.0
                                ));
                            }
                        }
                    }
                    let chunk_start_secs = chunk.pts_secs.unwrap_or(state.decoded_position_secs);
                    let chunk_end_secs =
                        decoded_chunk_end_secs(&chunk, state.decoded_position_secs);

                    // ---- Armed transition reaching its cut point ---------------------------
                    let reaches_cut = state
                        .armed_transition
                        .as_ref()
                        .is_some_and(|armed| armed.should_start(chunk_end_secs));
                    if reaches_cut {
                        let armed = state
                            .armed_transition
                            .take()
                            .expect("armed transition checked above");
                        let cut = armed.plan.a_cut_secs.max(chunk_start_secs);
                        let (head, tail) = split_chunk_at(chunk, chunk_start_secs, cut);
                        let mut preroll = state.take_recent_chunks();
                        if let Some(head) = head.as_ref() {
                            preroll.push(head.clone());
                        }
                        if let Some(head) = head {
                            produced_frames = produced_frames.saturating_add(head.frames as u64);
                            state.decoded_position_secs =
                                decoded_chunk_end_secs(&head, state.decoded_position_secs);
                            if !shared.push_decoded_chunk_for_generation(head, generation) {
                                if shared.should_stop_decoding() {
                                    return (!shared.stop.load(Ordering::Acquire)).then_some(data);
                                }
                                continue;
                            }
                        }
                        let mut armed = armed;
                        armed.rebase_to(state.decoded_position_secs);
                        if let Err((err, armed)) = begin_transition(
                            &shared, &mut data, armed, tail, preroll, &mut state, generation,
                        ) {
                            emit_decode_warning(format!(
                                "song transition could not start; falling back to gapless: {err}"
                            ));
                            // Keep the outgoing track playing to its end, then hand off.
                            state.armed_transition = Some(armed);
                            if let Some(armed) = state.armed_transition.as_mut() {
                                armed.plan.overlap_secs = 0.0;
                                armed.plan.a_cut_secs = f64::MAX;
                            }
                        }
                        continue;
                    }

                    produced_frames = produced_frames.saturating_add(chunk.frames as u64);
                    state.decoded_position_secs = chunk_end_secs;
                    state.remember_chunk(&chunk);

                    if !shared.push_decoded_chunk_for_generation(chunk, generation) {
                        if shared.should_stop_decoding() {
                            return (!shared.stop.load(Ordering::Acquire)).then_some(data);
                        }
                        continue;
                    }
                }
                Err(err) => {
                    shared.mark_decode_failed();
                    emit_decode_error(
                        &shared,
                        format!("failed to materialize decoded audio frame: {err}"),
                    );
                    return None;
                }
            },
            Ok(None) => {
                data.publish_packet_cache_stats(&shared);
                if !shared.is_decode_generation_current(generation) {
                    continue;
                }
                // A transition armed for a cut point we never reached (track shorter than
                // expected, trailing-silence trim beyond the real end): run it now as a
                // gapless hand-off so the incoming track still starts at its cue point.
                if let Some(mut armed) = state.armed_transition.take() {
                    armed.rebase_to(state.decoded_position_secs);
                    armed.plan.overlap_secs = 0.0;
                    armed.plan.a_end_secs = state.decoded_position_secs;
                    match begin_transition(
                        &shared,
                        &mut data,
                        armed,
                        None,
                        state.take_recent_chunks(),
                        &mut state,
                        generation,
                    ) {
                        Ok(()) => {}
                        Err((_, armed)) => {
                            hand_off_armed_directly(
                                &shared, &mut data, armed, &mut state, generation,
                            );
                        }
                    }
                    continue;
                }
                match activate_gapless_at_eof(&shared, generation) {
                    crate::GaplessDecodeResult::Activated(activation) => {
                        if let Some(activation) = activation {
                            data = activation.decoder;
                            state.decoded_position_secs = activation.decoded_position_secs;
                            produced_frames = activation.produced_frames;
                            data.publish_packet_cache_stats(&shared);
                            continue;
                        }
                        return None;
                    }
                    crate::GaplessDecodeResult::NotPrepared => {
                        if shared.should_stop_decoding() {
                            return (!shared.stop.load(Ordering::Acquire)).then_some(data);
                        }
                        if !shared.is_decode_generation_current(generation) {
                            continue;
                        }
                    }
                }
                data.pending_playback_restart_position = None;
                shared.mark_decoded_eof();
                return Some(data);
            }
            Err(err) => {
                data.publish_packet_cache_stats(&shared);
                if data.interrupt.load(Ordering::Acquire)
                    || shared.should_stop_decoding()
                    || !shared.is_decode_generation_current(generation)
                {
                    continue;
                }
                if data.is_recoverable_tail_error(&err, produced_frames) {
                    emit_decode_warning(format!("treating trailing decode error as EOF: {err}"));
                    if !shared.is_decode_generation_current(generation) {
                        continue;
                    }
                    if let Some(mut armed) = state.armed_transition.take() {
                        armed.rebase_to(state.decoded_position_secs);
                        armed.plan.overlap_secs = 0.0;
                        armed.plan.a_end_secs = state.decoded_position_secs;
                        match begin_transition(
                            &shared,
                            &mut data,
                            armed,
                            None,
                            Vec::new(),
                            &mut state,
                            generation,
                        ) {
                            Ok(()) => {}
                            Err((_, armed)) => {
                                hand_off_armed_directly(
                                    &shared, &mut data, armed, &mut state, generation,
                                );
                            }
                        }
                        continue;
                    }
                    match activate_gapless_at_eof(&shared, generation) {
                        crate::GaplessDecodeResult::Activated(activation) => {
                            if let Some(activation) = activation {
                                data = activation.decoder;
                                state.decoded_position_secs = activation.decoded_position_secs;
                                produced_frames = activation.produced_frames;
                                continue;
                            }
                            return None;
                        }
                        crate::GaplessDecodeResult::NotPrepared => {
                            if shared.should_stop_decoding() {
                                return (!shared.stop.load(Ordering::Acquire)).then_some(data);
                            }
                            if !shared.is_decode_generation_current(generation) {
                                continue;
                            }
                        }
                    }
                    data.pending_playback_restart_position = None;
                    shared.mark_decoded_eof();
                    return Some(data);
                }
                shared.mark_decode_failed();
                emit_decode_error(&shared, format!("failed to decode audio source: {err}"));
                return None;
            }
        }
    }
}

/// Start rendering an armed transition. `data` (the outgoing decoder) stays with the
/// worker and is borrowed by the runner on every step; the runner owns deck B. On failure
/// the incoming deck is handed back so the caller can fall back to a plain hand-off.
fn begin_transition(
    shared: &Arc<SharedAudio>,
    data: &mut DecoderData,
    armed: Box<ArmedTransition>,
    a_tail: Option<DecodedAudioChunk>,
    a_preroll: Vec<DecodedAudioChunk>,
    state: &mut WorkerState,
    generation: u64,
) -> Result<(), (String, Box<ArmedTransition>)> {
    let plan_note = armed.plan.note.clone();
    let mode = armed.mode();
    let overlap = armed.plan.overlap_secs;
    let b_start = armed.plan.b_start_secs;
    if overlap <= 0.0 {
        // Gapless (or a fade that degenerated to a splice): no mixer, no edge fades — the
        // incoming track is queued sample-exactly behind the outgoing one. `a_tail`
        // (audio past the cut, i.e. trimmed trailing silence) is dropped.
        emit_decode_info(
            shared,
            &format!(
                "song transition: direct hand-off, mode={} b_start={b_start:.2}s ({plan_note})",
                mode.as_str()
            ),
        );
        hand_off_armed_directly(shared, data, armed, state, generation);
        return Ok(());
    }
    shared.set_source_sample_format(armed.decoder.source_sample_format());
    shared.set_preferred_output_sample_format(armed.preferred_output_sample_format);
    // Both decoders must be cancellable while the blend runs (seek/stop set the flag
    // bound here); route the incoming deck's flag through the outgoing one.
    let incoming_interrupt = armed.decoder.interrupt_handle();
    incoming_interrupt.store(false, Ordering::Release);
    let runner = TransitionRunner::start(
        shared,
        *armed,
        a_tail,
        a_preroll,
        state.decoded_position_secs,
        generation,
    )?;
    shared.bind_interrupt(data.interrupt.clone());
    shared.bind_secondary_interrupt(Some(incoming_interrupt));
    state.runner = Some(runner);
    emit_decode_info(
        shared,
        &format!(
            "song transition started: mode={} overlap={overlap:.2}s b_start={b_start:.2}s ({plan_note})",
            mode.as_str()
        ),
    );
    Ok(())
}

/// Make the incoming deck live without mixing (the runner could not be built). The
/// pre-decoded head is queued behind a continuous boundary so the switch stays gapless.
fn hand_off_armed_directly(
    shared: &Arc<SharedAudio>,
    data: &mut DecoderData,
    armed: Box<ArmedTransition>,
    state: &mut WorkerState,
    generation: u64,
) {
    let armed = *armed;
    let mut info = armed.info;
    info.start_position_secs = armed.plan.b_start_secs;
    info.transition = Some(crate::events::TrackTransitionInfo {
        mode: "gapless".to_string(),
        overlap_secs: 0.0,
    });
    // No overlap: the boundary itself switches straight to the incoming track's own gain
    // (the shared reference gain only matters while both decks are summed).
    info.normalization_gain_db = Some(armed.post_overlap_normalization_gain_db);
    let live_seq = info.seq;
    shared.set_source_sample_format(armed.decoder.source_sample_format());
    shared.set_preferred_output_sample_format(armed.preferred_output_sample_format);
    shared.mark_track_boundary_continuous(info);
    let previous = std::mem::replace(data, *armed.decoder);
    crate::retire_value_background(
        Some(previous),
        "player-transition-outgoing-reaper".to_string(),
    );
    shared.bind_interrupt(data.interrupt.clone());
    shared.bind_secondary_interrupt(None);
    state.live_seq = live_seq;
    state.decoded_position_secs = armed.plan.b_start_secs;
    for chunk in armed.predecoded {
        state.decoded_position_secs = decoded_chunk_end_secs(&chunk, state.decoded_position_secs);
        if !shared.push_decoded_chunk_for_generation(chunk, generation) {
            break;
        }
    }
}

pub(crate) fn emit_decode_info(shared: &SharedAudio, message: &str) {
    crate::emit_shared_event(shared, PlayerEvent::log("info", message.to_string()));
}

fn decoded_pts_discontinuity(
    expected_secs: f64,
    actual_secs: f64,
    sample_rate: u32,
) -> Option<f64> {
    if !expected_secs.is_finite() || !actual_secs.is_finite() {
        return None;
    }
    // Audio PTS values are commonly expressed in a coarse stream time base. Allow a few
    // samples plus 5 ms of rounding jitter, but surface any larger forward gap or overlap.
    let tolerance_secs = (4.0 / f64::from(sample_rate.max(1))).max(0.005);
    let delta_secs = actual_secs - expected_secs;
    (delta_secs.abs() > tolerance_secs).then_some(delta_secs)
}

pub(crate) fn decoded_chunk_end_secs(chunk: &DecodedAudioChunk, previous_secs: f64) -> f64 {
    let duration_secs = chunk.frames as f64 / f64::from(chunk.format.sample_rate.max(1));
    chunk
        .pts_secs
        .map(|pts| pts + duration_secs)
        .unwrap_or(previous_secs + duration_secs)
}

fn wait_for_generation_command(
    data: &mut DecoderData,
    shared: &Arc<SharedAudio>,
    commands: &Receiver<DecodeCommand>,
    state: &mut WorkerState,
) -> Option<u64> {
    loop {
        if shared.should_stop_decoding() {
            return None;
        }
        match commands.recv_timeout(Duration::from_millis(50)) {
            Ok(command) => match handle_decode_command(data, shared, command, state) {
                DecodeCommandResult::Continue(generation) => return Some(generation),
                DecodeCommandResult::Stop => return None,
                DecodeCommandResult::Ignored => continue,
            },
            Err(RecvTimeoutError::Timeout) => {
                if shared.should_stop_decoding() {
                    return None;
                }
            }
            Err(RecvTimeoutError::Disconnected) => return None,
        }
    }
}

enum DecodeCommandDrain {
    Continue(Option<u64>),
    Stop,
}

fn handle_decode_commands(
    data: &mut DecoderData,
    shared: &Arc<SharedAudio>,
    commands: &Receiver<DecodeCommand>,
    state: &mut WorkerState,
) -> DecodeCommandDrain {
    let mut next_generation = None;
    loop {
        match commands.try_recv() {
            Ok(command) => match handle_decode_command(data, shared, command, state) {
                DecodeCommandResult::Continue(generation) => next_generation = Some(generation),
                DecodeCommandResult::Stop => return DecodeCommandDrain::Stop,
                DecodeCommandResult::Ignored => {}
            },
            Err(TryRecvError::Empty) => return DecodeCommandDrain::Continue(next_generation),
            Err(TryRecvError::Disconnected) => return DecodeCommandDrain::Stop,
        }
    }
}

fn panic_payload_message(payload: &(dyn std::any::Any + Send)) -> &str {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("unknown panic payload")
}

enum DecodeCommandResult {
    Continue(u64),
    Stop,
    Ignored,
}

fn handle_decode_command(
    data: &mut DecoderData,
    shared: &Arc<SharedAudio>,
    command: DecodeCommand,
    state: &mut WorkerState,
) -> DecodeCommandResult {
    match command {
        DecodeCommand::Seek {
            position_secs,
            generation,
            track_seq,
            reply,
        } => {
            if shared.should_stop_decoding() {
                let _ = reply.send(Err("decoder stopping".to_string()));
                return DecodeCommandResult::Stop;
            }
            if !shared.is_decode_generation_current(generation) {
                let _ = reply.send(Err("stale seek generation".to_string()));
                return DecodeCommandResult::Ignored;
            }
            state.pending_source_switch.take();
            // A seek during a blend aborts it. Which deck the seek applies to follows the
            // track the UI shows: the incoming one once the boundary has been crossed (or
            // when the caller names it), otherwise the outgoing track remains live.
            let prefer_incoming = state.targets_incoming(track_seq, shared);
            abort_runner(data, shared, state, prefer_incoming);
            state.drop_transition_state();
            if let Some(seq) = track_seq {
                if seq != state.live_seq && state.runner.is_none() {
                    // The caller is on a track we do not have (should not happen); the seek
                    // still applies to the live decoder so playback never stalls.
                    emit_decode_warning(format!(
                        "seek targets track seq {seq} but live seq is {}",
                        state.live_seq
                    ));
                }
            }
            let result = data.seek_and_measure(position_secs, true, || {
                shared.should_stop_decoding() || !shared.is_decode_generation_current(generation)
            });
            let generation_current = shared.is_decode_generation_current(generation);
            let seek_succeeded = result.is_ok();
            if let Ok(elapsed_ms) = result.as_ref() {
                if generation_current {
                    log_seek_elapsed(position_secs, *elapsed_ms);
                }
            }
            let _ = reply.send(result.map(|_| ()));
            if generation_current && seek_succeeded {
                state.decoded_position_secs = position_secs;
                // The renderer may prepare a new transition after this seek completes.
                DecodeCommandResult::Continue(generation)
            } else {
                DecodeCommandResult::Ignored
            }
        }
        DecodeCommand::PrepareSourceSwitch {
            track_seq,
            generation,
            interrupt,
            reply,
        } => {
            if interrupt.load(Ordering::Acquire)
                || shared.should_stop_decoding()
                || !shared.is_decode_generation_current(generation)
            {
                let _ = reply.send(Err("source switch cancelled before preparation".to_string()));
                return DecodeCommandResult::Ignored;
            }
            let target_seq = state
                .runner
                .as_ref()
                .map_or(state.live_seq, |runner| runner.incoming_seq());
            if target_seq != track_seq || shared.current_track_seq() != track_seq {
                let _ = reply.send(Err("source switch cancelled: track changed".to_string()));
                return DecodeCommandResult::Ignored;
            }
            state.drop_transition_state();
            if let Some(runner) = state.runner.as_mut() {
                runner.finish_for_source_switch();
                emit_decode_info(
                    shared,
                    "source switch: releasing active song transition into current track",
                );
            }
            let _ = reply.send(Ok(()));
            DecodeCommandResult::Ignored
        }
        DecodeCommand::SwitchSource {
            decoder,
            predecoded,
            switch_at_secs,
            generation,
            track_seq,
            reply,
        } => {
            if shared.should_stop_decoding() {
                let _ = reply.send(Err("decoder stopping".to_string()));
                return DecodeCommandResult::Stop;
            }
            if !shared.is_decode_generation_current(generation) {
                let _ = reply.send(Err("stale source switch generation".to_string()));
                return DecodeCommandResult::Ignored;
            }
            let target_seq = state
                .runner
                .as_ref()
                .map_or(state.live_seq, |runner| runner.incoming_seq());
            if track_seq.is_some_and(|seq| seq != target_seq) {
                let _ = reply.send(Err("source switch cancelled: track changed".to_string()));
                return DecodeCommandResult::Ignored;
            }
            state.drop_transition_state();
            if let Some(runner) = state.runner.as_mut() {
                runner.finish_for_source_switch();
            }
            state.pending_source_switch.take();
            state.pending_source_switch = Some(PendingSourceSwitch {
                decoder: Some(decoder),
                predecoded,
                switch_at_secs: switch_at_secs.max(0.0),
                generation,
                track_seq: target_seq,
                reply: Some(reply),
            });
            if activate_pending_source_switch(data, shared, state) {
                DecodeCommandResult::Continue(generation)
            } else {
                DecodeCommandResult::Ignored
            }
        }
        DecodeCommand::SwitchTrack {
            mut decoder,
            mut predecoded,
            info,
            preferred_output_sample_format,
            normalization_gain_db,
            transition_fade_frames,
            generation,
            reply,
        } => {
            if shared.should_stop_decoding() {
                let _ = reply.send(Err("decoder stopping".to_string()));
                return DecodeCommandResult::Stop;
            }
            if !shared.is_decode_generation_current(generation) {
                let _ = reply.send(Err("stale track switch generation".to_string()));
                return DecodeCommandResult::Ignored;
            }
            state.pending_source_switch.take();
            // A manual track load replaces everything: abandon any blend and forget the
            // armed transition (it was planned against the track being replaced).
            if let Some(runner) = state.runner.take() {
                drop(runner.abort(true));
            }
            state.drop_transition_state();
            decoder.interrupt.store(false, Ordering::Release);
            decoder.discard_before_secs = None;
            // Manual track changes are interactive: discard the old decoded/output backlog
            // instead of appending the new track after hundreds of milliseconds of queued PCM.
            // The caller has already faded the audible tail to zero; the reset also publishes a
            // new generation so output-side converted PCM from the old source is invalidated.
            let next_generation = shared.reset_for_decode_resume(0.0, &shared.dsp_settings());
            shared.set_source_sample_format(decoder.source_sample_format());
            shared.set_preferred_output_sample_format(preferred_output_sample_format);
            shared.set_normalization_gain_db(normalization_gain_db);
            let switched_seq = info.seq;
            shared.mark_track_boundary(info, transition_fade_frames);
            shared.bind_interrupt(decoder.interrupt.clone());
            let previous = std::mem::replace(data, *decoder);
            crate::retire_value_background(
                Some(previous),
                "player-track-switch-reaper".to_string(),
            );
            state.live_seq = switched_seq;
            state.decoded_position_secs = 0.0;
            let mut accepted = false;
            for chunk in predecoded.drain(..) {
                state.decoded_position_secs =
                    decoded_chunk_end_secs(&chunk, state.decoded_position_secs);
                if !shared.push_decoded_chunk_for_generation(chunk, next_generation) {
                    if !accepted {
                        let _ = reply.send(Err(
                            "track switch stopped while queuing prepared audio".to_string(),
                        ));
                    }
                    return DecodeCommandResult::Ignored;
                }
                if !accepted {
                    let _ = reply.send(Ok(()));
                    accepted = true;
                }
            }
            if !accepted {
                let _ = reply.send(Ok(()));
            }
            DecodeCommandResult::Continue(next_generation)
        }
        DecodeCommand::ArmTransition { armed, generation } => {
            if shared.should_stop_decoding() {
                return DecodeCommandResult::Stop;
            }
            if !shared.is_decode_generation_current(generation) {
                crate::retire_value_background(
                    Some(armed),
                    "player-transition-stale-arm-reaper".to_string(),
                );
                return DecodeCommandResult::Ignored;
            }
            if let Some(runner) = state.runner.as_ref() {
                if armed.outgoing_seq == runner.incoming_seq() {
                    // Prepared for the track that is currently fading in: keep it until
                    // the blend finishes.
                    if let Some(previous) = state.pending_arm.replace(armed) {
                        crate::retire_value_background(
                            Some(previous),
                            "player-transition-replaced-arm-reaper".to_string(),
                        );
                    }
                } else {
                    crate::retire_value_background(
                        Some(armed),
                        "player-transition-stale-arm-reaper".to_string(),
                    );
                }
                return DecodeCommandResult::Ignored;
            }
            if let Some(previous) = state.armed_transition.replace(armed) {
                crate::retire_value_background(
                    Some(previous),
                    "player-transition-replaced-arm-reaper".to_string(),
                );
            }
            DecodeCommandResult::Ignored
        }
        DecodeCommand::DisarmTransition {
            request_id,
            reset_position_secs,
        } => {
            let matches =
                |armed: &ArmedTransition| request_id.is_none_or(|id| armed.request_id == id);
            let mut next_generation = None;
            if let Some(position_secs) = reset_position_secs {
                disarm_matching_runner(data, shared, state, request_id);
                state.fail_start_now("transition disarmed");
                let position_secs = position_secs.max(0.0);
                let generation =
                    shared.reset_for_decode_resume(position_secs, &shared.dsp_settings());
                match data.prepare_seamless_seek(position_secs) {
                    Ok(_) => {
                        data.set_discard_before_secs(if position_secs > 0.0 {
                            Some(position_secs)
                        } else {
                            None
                        });
                        state.decoded_position_secs = position_secs;
                    }
                    Err(err) => {
                        emit_decode_warning(format!(
                            "transition disarmed but live decoder could not seek to {position_secs:.2}s: {err}"
                        ));
                    }
                }
                next_generation = Some(generation);
            }
            if state.armed_transition.as_deref().is_some_and(matches) {
                crate::retire_value_background(
                    state.armed_transition.take(),
                    "player-transition-disarm-reaper".to_string(),
                );
            }
            if state.pending_arm.as_deref().is_some_and(matches) {
                crate::retire_value_background(
                    state.pending_arm.take(),
                    "player-transition-disarm-reaper".to_string(),
                );
            }
            next_generation
                .map(DecodeCommandResult::Continue)
                .unwrap_or(DecodeCommandResult::Ignored)
        }
        DecodeCommand::StartTransition {
            max_overlap_secs,
            resume_position_secs,
            generation,
            reply,
        } => {
            if shared.should_stop_decoding() {
                let _ = reply.send(Err("decoder stopping".to_string()));
                return DecodeCommandResult::Stop;
            }
            if !shared.is_decode_generation_current(generation) {
                let _ = reply.send(Err("stale transition generation".to_string()));
                return DecodeCommandResult::Ignored;
            }
            if state.runner.is_some() {
                // Already blending: nothing to do, report success.
                let _ = reply.send(Ok(()));
                return DecodeCommandResult::Continue(generation);
            }
            if state.armed_transition.is_none() {
                let _ = reply.send(Err("no transition armed".to_string()));
                return DecodeCommandResult::Ignored;
            }
            state.fail_start_now("superseded");
            state.start_now = Some((
                max_overlap_secs.max(0.0),
                resume_position_secs.max(0.0),
                reply,
            ));
            // The caller bumped the generation when it reset the queues; adopt it so the
            // blend is queued under the live generation.
            DecodeCommandResult::Continue(generation)
        }
        DecodeCommand::Stop => {
            state.pending_source_switch.take();
            if let Some(runner) = state.runner.take() {
                drop(runner.abort(true));
            }
            state.drop_transition_state();
            DecodeCommandResult::Stop
        }
    }
}

struct PendingSourceSwitch {
    decoder: Option<Box<DecoderData>>,
    predecoded: Vec<DecodedAudioChunk>,
    switch_at_secs: f64,
    generation: u64,
    track_seq: u64,
    reply: Option<SyncSender<Result<f64, String>>>,
}

impl Drop for PendingSourceSwitch {
    fn drop(&mut self) {
        if let Some(reply) = self.reply.take() {
            let _ = reply.send(Err("source switch cancelled".to_string()));
        }
        crate::retire_value_background(
            self.decoder.take(),
            "player-pending-source-reaper".to_string(),
        );
    }
}

const SOURCE_SWITCH_MIN_BUFFER_SECS: f64 = 0.2;

fn align_source_switch_buffer(chunks: &mut Vec<DecodedAudioChunk>, handoff: f64) -> f64 {
    let mut discard_before = Some(handoff);
    chunks.retain_mut(|chunk| align_switched_chunk(chunk, &mut discard_before));
    let mut end = handoff;
    let mut buffered_secs = 0.0;
    for (index, chunk) in chunks.iter().enumerate() {
        let Some(start) = chunk.pts_secs.filter(|pts| pts.is_finite()) else {
            return 0.0;
        };
        let rate = f64::from(chunk.format.sample_rate.max(1));
        // The reader exposes microseconds, but containers such as Matroska store
        // millisecond PTS. Consecutive AAC/PCM frames can therefore differ from
        // their sample-count clock by up to one millisecond without missing audio.
        // The first sample can also round up to the replacement's sample grid.
        let tolerance = if index == 0 {
            1.0 / rate + 1.0e-3 + 2.0e-6
        } else {
            1.0e-3 + 2.0e-6
        };
        if (start - end).abs() > tolerance {
            return 0.0;
        }
        let seconds = chunk.frames as f64 / rate;
        // Anchor once and count samples, so repeated small gaps cannot accumulate
        // unnoticed merely because each individual gap fits the PTS tolerance.
        if index == 0 {
            end = start;
        }
        end += seconds;
        buffered_secs += seconds;
    }
    buffered_secs
}

fn activate_pending_source_switch(
    data: &mut DecoderData,
    shared: &SharedAudio,
    state: &mut WorkerState,
) -> bool {
    let Some(pending) = state.pending_source_switch.as_ref() else {
        return false;
    };
    if !shared.is_decode_generation_current(pending.generation) {
        state.pending_source_switch.take();
        return false;
    }
    // The outgoing decoder still owns A until the short release hands B back.
    if state.runner.is_some() {
        return false;
    }
    if pending.track_seq != state.live_seq {
        state.pending_source_switch.take();
        return false;
    }
    if pending
        .decoder
        .as_ref()
        .is_some_and(|decoder| decoder.interrupt.load(Ordering::Acquire))
    {
        state.pending_source_switch.take();
        return false;
    }
    if state.decoded_position_secs + f64::EPSILON < pending.switch_at_secs {
        return false;
    }

    let mut pending = state
        .pending_source_switch
        .take()
        .expect("pending source switch checked above");
    let handoff_position = state.decoded_position_secs.max(0.0);
    let buffered_secs = align_source_switch_buffer(&mut pending.predecoded, handoff_position);
    if buffered_secs + 1.0e-6 < SOURCE_SWITCH_MIN_BUFFER_SECS {
        let error = format!(
            "source switch cancelled: insufficient prepared audio at hand-off (position={handoff_position:.3}, buffered_secs={buffered_secs:.3}, required_secs={SOURCE_SWITCH_MIN_BUFFER_SECS:.3}); old source kept"
        );
        emit_decode_info(shared, &error);
        if let Some(reply) = pending.reply.take() {
            let _ = reply.send(Err(error));
        }
        return false;
    }
    emit_decode_info(shared, &format!(
        "source switch buffer ready: position={handoff_position:.3}, buffered_secs={buffered_secs:.3}"
    ));
    let mut decoder = pending
        .decoder
        .take()
        .expect("pending source switch decoder is available");
    decoder.interrupt.store(false, Ordering::Release);
    decoder.discard_before_secs = Some(handoff_position);
    shared.set_source_sample_format(decoder.source_sample_format());
    shared.bind_interrupt(decoder.interrupt.clone());
    let previous = std::mem::replace(data, *decoder);
    crate::retire_value_background(Some(previous), "player-source-switch-reaper".to_string());
    for mut chunk in pending.predecoded.drain(..) {
        if !align_switched_chunk(&mut chunk, &mut data.discard_before_secs) {
            continue;
        }
        state.decoded_position_secs = decoded_chunk_end_secs(&chunk, state.decoded_position_secs);
        if !shared.push_decoded_chunk_for_generation(chunk, pending.generation) {
            if let Some(reply) = pending.reply.take() {
                let _ = reply.send(Err("source switch stopped while queuing audio".to_string()));
            }
            return false;
        }
    }
    if let Some(reply) = pending.reply.take() {
        let _ = reply.send(Ok(handoff_position));
    }
    true
}

/// Align the first frame from the replacement source to the exact end of the
/// old source. Accurate seeks can still return a codec frame beginning a few
/// milliseconds before that point; replaying those samples sounds like a short
/// hitch even when the output device never underruns.
fn align_switched_chunk(
    chunk: &mut DecodedAudioChunk,
    discard_before_secs: &mut Option<f64>,
) -> bool {
    let Some(target) = *discard_before_secs else {
        return chunk.frames > 0;
    };
    let Some(start) = chunk.pts_secs else {
        *discard_before_secs = None;
        return chunk.frames > 0;
    };
    let sample_rate = f64::from(chunk.format.sample_rate.max(1));
    let end = start + chunk.frames as f64 / sample_rate;
    if end <= target {
        return false;
    }
    if start < target {
        // Reader PTS values are rounded to microseconds. Account for that precision
        // before ceil, or a matching sample boundary can lose one extra frame.
        let timestamp_tolerance_frames = (sample_rate * 1.0e-6).min(0.49) + 1.0e-7;
        let trim_frames =
            (((target - start) * sample_rate) - timestamp_tolerance_frames).ceil() as usize;
        chunk.trim_start_frames(trim_frames);
    }
    *discard_before_secs = None;
    chunk.frames > 0
}

pub fn list_tracks_for_url(url: &str, stream_options: &StreamOptions) -> Vec<TrackInfo> {
    let interrupt = Arc::new(AtomicBool::new(false));
    let Ok(source) = open_stream(url, interrupt, stream_options) else {
        return Vec::new();
    };
    let Ok(reader) = AudioReader::new(source) else {
        return Vec::new();
    };

    reader
        .audio_streams()
        .into_iter()
        .map(|stream| TrackInfo {
            id: (stream.ordinal + 1) as i64,
            r#type: "audio".to_string(),
            selected: stream.selected,
            codec: stream.codec_name,
            title: stream.title,
            lang: stream.lang,
        })
        .collect()
}

pub fn audio_stream_ordinal_from_track_id(track_id: i64) -> Option<usize> {
    if track_id <= 0 {
        None
    } else {
        Some((track_id - 1) as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn switch_test_chunk(start: f64, frames: usize) -> DecodedAudioChunk {
        DecodedAudioChunk {
            format: DecodedAudioFormat {
                sample_rate: 1_000,
                sample_format: AudioSampleFormat::F32,
                channels: 2,
            },
            pts_secs: Some(start),
            frames,
            data: DecodedAudioData::F32(vec![0.25; frames * 2]),
        }
    }

    #[test]
    fn source_switch_catchup_keeps_a_short_contiguous_window_after_a_slow_seek() {
        let live = std::cell::Cell::new(14.0);
        let mut next = 10.0;
        let (switch_at, chunks) = catch_up_source_switch(
            10.0,
            300.0,
            0.5,
            || live.get(),
            || false,
            || {
                let chunk = switch_test_chunk(next, 100);
                next += 0.1;
                live.set(live.get() + 0.001);
                Ok(Some(chunk))
            },
            Duration::from_secs(1),
        )
        .unwrap();
        assert!((switch_at - live.get() - 0.2).abs() < 1e-6);
        assert!((chunks[0].pts_secs.unwrap() - switch_at).abs() <= 0.001);
        let mut end = chunks[0].pts_secs.unwrap();
        for chunk in &chunks {
            assert!((chunk.pts_secs.unwrap() - end).abs() < 1e-6);
            end = decoded_chunk_end_secs(chunk, end);
        }
        assert!(end >= switch_at + 0.5);
        assert!(end < switch_at + 0.61);
    }

    #[test]
    fn source_switch_catchup_supports_paused_playback_and_missing_timestamps() {
        let (switch_at, chunks) = catch_up_source_switch(
            10.0,
            0.0,
            0.5,
            || 10.0,
            || false,
            || {
                let mut chunk = switch_test_chunk(0.0, 100);
                chunk.pts_secs = None;
                Ok(Some(chunk))
            },
            Duration::from_secs(1),
        )
        .unwrap();
        assert!((switch_at - 10.2).abs() < 1e-6);
        assert!((chunks[0].pts_secs.unwrap() - switch_at).abs() < 0.001);
    }

    #[test]
    fn source_switch_catchup_cancels_without_consuming_more_audio() {
        let cancelled = std::cell::Cell::new(false);
        let mut reads = 0;
        let result = catch_up_source_switch(
            10.0,
            300.0,
            0.5,
            || 14.0,
            || cancelled.get(),
            || {
                reads += 1;
                cancelled.set(true);
                Ok(Some(switch_test_chunk(10.0, 100)))
            },
            Duration::from_secs(1),
        );
        assert!(result.unwrap_err().contains("cancelled"));
        assert_eq!(reads, 1);
        let timed_out = catch_up_source_switch(
            10.0,
            300.0,
            0.5,
            || 14.0,
            || false,
            || panic!("expired catch-up must not decode"),
            Duration::ZERO,
        );
        assert!(timed_out.unwrap_err().contains("preparation timed out"));
    }

    #[test]
    fn source_switch_catchup_accepts_a_short_tail_but_rejects_an_exhausted_source() {
        let mut tail = Some(switch_test_chunk(0.8, 200));
        let (switch_at, chunks) = catch_up_source_switch(
            0.8,
            1.0,
            0.5,
            || 0.9,
            || false,
            || Ok(tail.take()),
            Duration::from_secs(1),
        )
        .unwrap();
        assert!((switch_at - 0.95).abs() < 1e-6);
        assert_eq!(chunks.iter().map(|chunk| chunk.frames).sum::<usize>(), 50);
        let result = catch_up_source_switch(
            0.0,
            1.0,
            0.5,
            || 0.9,
            || false,
            || Ok(None),
            Duration::from_secs(1),
        );
        assert!(result.unwrap_err().contains("replacement ended"));
    }

    #[test]
    fn source_switch_catchup_propagates_decode_failure_before_handoff() {
        let result = catch_up_source_switch(
            10.0,
            300.0,
            0.5,
            || 10.0,
            || false,
            || Err("invalid audio data".to_string()),
            Duration::from_secs(1),
        );
        assert_eq!(result.unwrap_err(), "invalid audio data");
    }

    #[test]
    fn source_switch_catchup_with_real_decoder_preserves_the_next_frame_position() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/gapless-silence.flac");
        let mut decoder = DecoderData::open(
            path.to_string_lossy().into_owned(),
            None,
            Some(48_000),
            Arc::new(AtomicBool::new(false)),
            PacketCacheOptions::default(),
            &StreamOptions::default(),
        )
        .unwrap();
        decoder.prepare_cancellable_seek(1.0, || false).unwrap();
        // Simulate playback advancing while a seek takes three seconds.
        let (switch_at, chunks) = decoder
            .prepare_source_switch_chunks(1.0, 0.9, || 4.0, || false)
            .unwrap();
        assert!((switch_at - 4.2).abs() < 1e-6);
        assert!((chunks[0].pts_secs.unwrap() - switch_at).abs() < 0.001);
        let last = chunks.last().unwrap();
        let end = decoded_chunk_end_secs(last, switch_at);
        assert!(
            end >= switch_at + 0.9,
            "requested pipeline reserve must be prepared"
        );
        let next = decoder.decode_next_chunk().unwrap().unwrap();
        assert!((next.pts_secs.unwrap() - end).abs() < 0.001);
    }

    fn source_switch_decoder() -> DecoderData {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("vendor/ffmpeg-audio/crates/ffmpeg_audio/tests/assets/seek_test.aac");
        DecoderData::open(
            path.to_string_lossy().into_owned(),
            None,
            Some(48_000),
            Arc::new(AtomicBool::new(false)),
            PacketCacheOptions::default(),
            &StreamOptions::default(),
        )
        .unwrap()
    }

    #[test]
    fn source_switch_real_buffers_are_contiguous_at_arbitrary_handoff_positions() {
        for asset in [
            "tests/fixtures/gapless-silence.flac",
            "vendor/ffmpeg-audio/crates/ffmpeg_audio/tests/assets/seek_test.aac",
            "vendor/ffmpeg-audio/crates/ffmpeg_audio/tests/assets/negative_pts.mkv",
        ] {
            for position in [0.0, 0.137] {
                let mut decoder = DecoderData::open(
                    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join(asset)
                        .to_string_lossy()
                        .into_owned(),
                    None,
                    Some(48_000),
                    Arc::new(AtomicBool::new(false)),
                    PacketCacheOptions::default(),
                    &StreamOptions::default(),
                )
                .unwrap();
                decoder
                    .prepare_cancellable_seek(position, || false)
                    .unwrap();
                let (switch_at, mut chunks) = decoder
                    .prepare_source_switch_chunks(position, 0.5, || position, || false)
                    .unwrap();
                let buffered = align_source_switch_buffer(&mut chunks, switch_at + 0.153);
                assert!(
                    buffered >= 0.3,
                    "{asset} at {position}: reserve={buffered}, chunks={:?}",
                    chunks
                        .iter()
                        .map(|c| (c.pts_secs, c.frames, c.format.sample_rate))
                        .collect::<Vec<_>>()
                );
            }
        }
    }

    #[test]
    fn source_switch_rejects_exhausted_short_or_discontinuous_buffers_without_touching_live_audio()
    {
        let cases = [
            Vec::new(),
            vec![switch_test_chunk(10.0, 500)],
            vec![switch_test_chunk(10.0, 650)],
            vec![switch_test_chunk(10.6, 900)],
            vec![switch_test_chunk(10.538, 100), switch_test_chunk(10.8, 400)],
            vec![switch_test_chunk(10.538, 100), switch_test_chunk(10.6, 400)],
            vec![switch_test_chunk(10.538, 50)],
        ];
        for predecoded in cases {
            let shared = SharedAudio::new(
                crate::shared::MixFormat::stereo_f32(48_000),
                1.0,
                8.0,
                &crate::dsp::DspSettings::default(),
            );
            shared.set_track_seq(7);
            let generation = shared.current_decode_generation();
            let mut data = source_switch_decoder();
            let old_interrupt = data.interrupt.clone();
            let mut state = WorkerState::new(10.538, 7);
            let (reply, received) = sync_channel(1);
            state.pending_source_switch = Some(PendingSourceSwitch {
                decoder: Some(Box::new(source_switch_decoder())),
                predecoded,
                switch_at_secs: 10.0,
                generation,
                track_seq: 7,
                reply: Some(reply),
            });
            assert!(!activate_pending_source_switch(
                &mut data, &shared, &mut state
            ));
            assert!(received
                .try_recv()
                .unwrap()
                .unwrap_err()
                .contains("insufficient prepared audio"));
            assert!(state.pending_source_switch.is_none());
            assert!(Arc::ptr_eq(&data.interrupt, &old_interrupt));
            assert!(!old_interrupt.load(Ordering::Acquire));
            assert_eq!(state.decoded_position_secs, 10.538);
            assert_eq!(state.live_seq, 7);
            assert_eq!(shared.current_decode_generation(), generation);
            let next = data.decode_next_chunk().unwrap().unwrap();
            let expected = source_switch_decoder()
                .decode_next_chunk()
                .unwrap()
                .unwrap();
            assert_eq!(next.pts_secs, expected.pts_secs);
            assert_eq!(next.data, expected.data);
        }
    }

    #[test]
    fn source_switch_checks_reserve_at_the_delayed_actual_handoff() {
        let shared = SharedAudio::new(
            crate::shared::MixFormat::stereo_f32(48_000),
            1.0,
            8.0,
            &crate::dsp::DspSettings::default(),
        );
        shared.set_track_seq(7);
        let mut data = source_switch_decoder();
        let old_interrupt = data.interrupt.clone();
        let mut replacement = source_switch_decoder();
        replacement.duration = Some(Duration::from_secs(20));
        let new_interrupt = replacement.interrupt.clone();
        let mut state = WorkerState::new(10.0, 7);
        let (reply, received) = sync_channel(1);
        state.pending_source_switch = Some(PendingSourceSwitch {
            decoder: Some(Box::new(replacement)),
            predecoded: vec![switch_test_chunk(10.2, 900)],
            switch_at_secs: 10.2,
            generation: shared.current_decode_generation(),
            track_seq: 7,
            reply: Some(reply),
        });
        assert!(!activate_pending_source_switch(
            &mut data, &shared, &mut state
        ));
        assert!(Arc::ptr_eq(&data.interrupt, &old_interrupt));
        assert!(matches!(received.try_recv(), Err(TryRecvError::Empty)));
        state.decoded_position_secs = 10.738;
        assert!(activate_pending_source_switch(
            &mut data, &shared, &mut state
        ));
        assert_eq!(received.try_recv().unwrap().unwrap(), 10.738);
        assert!(Arc::ptr_eq(&data.interrupt, &new_interrupt));
        assert!((state.decoded_position_secs - 11.1).abs() < 1.0e-6);
        assert_eq!(state.live_seq, 7);
    }

    #[test]
    fn source_switch_buffer_alignment_rejects_unknown_pts_and_preserves_the_reserve_boundary() {
        let mut chunks = vec![switch_test_chunk(10.0, 900)];
        assert!((align_source_switch_buffer(&mut chunks, 10.7) - 0.2).abs() < 1e-6);
        let mut unknown = vec![switch_test_chunk(10.0, 900)];
        unknown[0].pts_secs = None;
        assert_eq!(align_source_switch_buffer(&mut unknown, 10.5), 0.0);
    }

    #[test]
    fn source_switch_buffer_tolerates_rounded_pts_but_rejects_gaps_and_drift() {
        let make_chunks = |starts: &[f64]| {
            starts
                .iter()
                .map(|&start| {
                    let mut chunk = switch_test_chunk(start, 1024);
                    chunk.format.sample_rate = 48_000;
                    chunk
                })
                .collect::<Vec<_>>()
        };
        let mut rounded = make_chunks(&[0.0, 0.021, 0.043, 0.064]);
        assert!((align_source_switch_buffer(&mut rounded, 0.0) - 4096.0 / 48_000.0).abs() < 1e-9);
        let mut gap = make_chunks(&[0.0, 0.024, 0.045]);
        assert_eq!(align_source_switch_buffer(&mut gap, 0.0), 0.0);
        let mut overlap = make_chunks(&[0.0, 0.019, 0.040]);
        assert_eq!(align_source_switch_buffer(&mut overlap, 0.0), 0.0);
        let mut drift = make_chunks(&[0.0, 0.022, 0.044, 0.066]);
        assert_eq!(align_source_switch_buffer(&mut drift, 0.0), 0.0);
    }

    #[test]
    fn source_switch_releases_active_blend_and_never_replaces_outgoing_decoder() {
        use crate::shared::{MixFormat, TrackSwitchInfo};
        use crate::transition::decide::{
            DecisionStrategy, SpeedType, TransitionPlan, TransitionTrigger,
        };
        use crate::transition::TransitionMode;
        let shared = Arc::new(SharedAudio::new(
            MixFormat::stereo_f32(48_000),
            8.0,
            8.0,
            &crate::dsp::DspSettings::default(),
        ));
        let generation = shared.current_decode_generation();
        let _filter = crate::filter::TestFilterWorker::start(shared.clone());
        shared.set_track_seq(2);
        let mut data = source_switch_decoder();
        let mut state = WorkerState::new(100.0, 1);
        let format = DecodedAudioFormat {
            sample_rate: 48_000,
            sample_format: AudioSampleFormat::F32,
            channels: 2,
        };
        let armed = ArmedTransition {
            plan: TransitionPlan {
                mode: TransitionMode::AutomixPro,
                strategy: DecisionStrategy::Fade,
                trigger: TransitionTrigger::EndOfTrack,
                a_cut_secs: 100.0,
                a_end_secs: 115.0,
                b_start_secs: 0.0,
                overlap_secs: 15.0,
                template: Some(crate::transition::plan::PlanTemplate::LayeredFilter),
                a_tempo_ratio: 1.0,
                speed_type: SpeedType::None,
                bpm_a: None,
                bpm_b: None,
                bars: None,
                a_beat_secs: None,
                b_beat_secs: None,
                note: String::new(),
            },
            decoder: Box::new(source_switch_decoder()),
            predecoded: vec![DecodedAudioChunk::new(
                format,
                24_000,
                Some(0.0),
                DecodedAudioData::F32(vec![0.2; 48_000]),
            )],
            info: TrackSwitchInfo::new("incoming".to_string(), None, 2, 200.0),
            preferred_output_sample_format: AudioSampleFormat::F32,
            a_gain: 1.0,
            b_gain: 0.5,
            post_overlap_normalization_gain_db: -6.0,
            request_id: 1,
            outgoing_seq: 1,
        };
        state.runner = Some(
            TransitionRunner::start(&shared, armed, None, Vec::new(), 100.0, generation)
                .unwrap_or_else(|(err, _)| panic!("{err}")),
        );
        let (tx, rx) = sync_channel(1);
        handle_decode_command(
            &mut data,
            &shared,
            DecodeCommand::PrepareSourceSwitch {
                track_seq: 1,
                generation,
                interrupt: Arc::new(AtomicBool::new(false)),
                reply: tx,
            },
            &mut state,
        );
        assert!(rx
            .try_recv()
            .unwrap()
            .unwrap_err()
            .contains("track changed"));
        let (tx, rx) = sync_channel(1);
        handle_decode_command(
            &mut data,
            &shared,
            DecodeCommand::PrepareSourceSwitch {
                track_seq: 2,
                generation,
                interrupt: Arc::new(AtomicBool::new(false)),
                reply: tx,
            },
            &mut state,
        );
        assert_eq!(rx.try_recv().unwrap(), Ok(()));
        let (tx, rx) = sync_channel(1);
        handle_decode_command(
            &mut data,
            &shared,
            DecodeCommand::SwitchSource {
                track_seq: Some(2),
                generation,
                decoder: Box::new(source_switch_decoder()),
                predecoded: vec![DecodedAudioChunk::new(
                    format,
                    24_000,
                    Some(0.5),
                    DecodedAudioData::F32(vec![0.2; 48_000]),
                )],
                switch_at_secs: 0.1,
                reply: tx,
            },
            &mut state,
        );
        assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));
        assert!(state.runner.is_some());
        assert_eq!(state.live_seq, 1);
        for _ in 0..100 {
            match state.runner.as_mut().unwrap().step(&shared, &mut data) {
                RunnerStep::Continue => {}
                RunnerStep::Failed(err) => panic!("{err}"),
                RunnerStep::Finished(handoff) => {
                    data = handoff.decoder;
                    state.decoded_position_secs = handoff.decoded_position_secs;
                    state.live_seq = 2;
                    state.runner = None;
                    break;
                }
            }
        }
        assert!(
            state.runner.is_none(),
            "quality switch must not wait for the full overlap"
        );
        assert!(
            (state.decoded_position_secs - 0.5).abs() < 1e-6,
            "B read-ahead is preserved"
        );
        assert!(activate_pending_source_switch(
            &mut data, &shared, &mut state
        ));
        assert!((rx.try_recv().unwrap().unwrap() - 0.5).abs() < 1e-6);
        assert_eq!(state.live_seq, 2);
    }

    #[test]
    fn cancelled_source_switch_preflight_does_not_change_the_live_decoder() {
        let shared = Arc::new(SharedAudio::new(
            crate::shared::MixFormat::stereo_f32(48_000),
            1.0,
            8.0,
            &crate::dsp::DspSettings::default(),
        ));
        shared.set_track_seq(7);
        let mut data = source_switch_decoder();
        let mut state = WorkerState::new(42.0, 7);
        let (tx, rx) = sync_channel(1);
        handle_decode_command(
            &mut data,
            &shared,
            DecodeCommand::PrepareSourceSwitch {
                track_seq: 7,
                generation: shared.current_decode_generation(),
                interrupt: Arc::new(AtomicBool::new(true)),
                reply: tx,
            },
            &mut state,
        );
        assert!(rx.try_recv().unwrap().is_err());
        assert_eq!(state.decoded_position_secs, 42.0);
        assert_eq!(state.live_seq, 7);
    }

    #[test]
    fn seek_target_at_duration_is_terminal() {
        let duration = Duration::from_secs(180);

        assert!(seek_position_is_at_end(duration, duration));
        assert!(seek_position_is_at_end(
            duration - Duration::from_millis(25),
            duration
        ));
        assert!(!seek_position_is_at_end(
            duration - Duration::from_millis(100),
            duration
        ));
        assert!(!seek_position_is_at_end(Duration::ZERO, Duration::ZERO));
    }

    #[test]
    fn seek_tail_error_tolerance_is_narrower_than_normal_playback_tail() {
        let duration = Duration::from_secs(180);

        assert!(seek_position_is_near_end(179.8, duration));
        assert!(!seek_position_is_near_end(179.0, duration));
    }

    #[test]
    fn non_finite_seek_positions_normalize_to_start() {
        assert_eq!(normalize_seek_position(f64::NAN), 0.0);
        assert_eq!(normalize_seek_position(f64::INFINITY), 0.0);
        assert_eq!(normalize_seek_position(-1.0), 0.0);
    }

    #[test]
    fn decoded_pts_continuity_ignores_rounding_but_reports_missing_audio() {
        assert_eq!(decoded_pts_discontinuity(1.0, 1.004, 48_000), None);
        let forward = decoded_pts_discontinuity(1.0, 1.025, 48_000)
            .expect("25 ms missing audio should be reported");
        let backward = decoded_pts_discontinuity(1.0, 0.975, 48_000)
            .expect("25 ms overlap should be reported");
        assert!((forward - 0.025).abs() < 1.0e-9);
        assert!((backward + 0.025).abs() < 1.0e-9);
        assert_eq!(decoded_pts_discontinuity(f64::NAN, 1.0, 48_000), None);
    }

    #[test]
    fn predecoded_timeline_uses_the_new_tracks_pts() {
        let format = DecodedAudioFormat {
            sample_rate: 48_000,
            sample_format: AudioSampleFormat::F32,
            channels: 2,
        };
        let first =
            DecodedAudioChunk::new(format, 24_000, Some(0.0), DecodedAudioData::F32(Vec::new()));
        let second =
            DecodedAudioChunk::new(format, 576, Some(0.5), DecodedAudioData::F32(Vec::new()));

        let first_end = decoded_chunk_end_secs(&first, 187.477_914);
        let second_end = decoded_chunk_end_secs(&second, first_end);

        assert!((first_end - 0.5).abs() < 1.0e-9);
        assert!((second_end - 0.512).abs() < 1.0e-9);
        assert_eq!(decoded_pts_discontinuity(first_end, 0.5, 48_000), None);
    }

    #[test]
    fn decoder_seek_to_known_duration_enters_terminal_state_without_demux_seek() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("vendor/ffmpeg-audio/crates/ffmpeg_audio/tests/assets/seek_test.aac");
        let mut decoder = DecoderData::open(
            path.to_string_lossy().into_owned(),
            None,
            None,
            Arc::new(AtomicBool::new(false)),
            PacketCacheOptions::default(),
            &StreamOptions::default(),
        )
        .expect("fixture decoder should open");
        let duration = decoder.duration_secs();
        assert!(duration > 0.0);

        decoder
            .seek(duration)
            .expect("terminal seek should not reach the demuxer EOF");

        assert!(decoder.seeked_to_end);
        assert!(decoder.pending_playback_restart_position.is_none());
    }

    #[test]
    fn switched_source_drops_frames_before_handoff_and_trims_crossing_frame() {
        let format = DecodedAudioFormat {
            sample_rate: 100,
            sample_format: AudioSampleFormat::F32,
            channels: 2,
        };
        let mut discard_before = Some(1.05);
        let mut old_frame =
            DecodedAudioChunk::new(format, 5, Some(1.0), DecodedAudioData::F32(vec![0.0; 10]));
        assert!(!align_switched_chunk(&mut old_frame, &mut discard_before));
        assert_eq!(discard_before, Some(1.05));

        let samples = (0..20).map(|sample| sample as f32).collect::<Vec<_>>();
        let mut crossing_frame =
            DecodedAudioChunk::new(format, 10, Some(1.0), DecodedAudioData::F32(samples));
        assert!(align_switched_chunk(
            &mut crossing_frame,
            &mut discard_before
        ));
        assert_eq!(discard_before, None);
        assert_eq!(crossing_frame.frames, 5);
        assert_eq!(crossing_frame.pts_secs, Some(1.05));
        assert_eq!(
            crossing_frame.data,
            DecodedAudioData::F32((10..20).map(|sample| sample as f32).collect())
        );
    }

    #[test]
    fn switched_source_keeps_first_frame_when_pts_is_already_aligned() {
        let mut discard_before = Some(2.0);
        let mut chunk = DecodedAudioChunk::new(
            DecodedAudioFormat {
                sample_rate: 48_000,
                sample_format: AudioSampleFormat::S16,
                channels: 1,
            },
            2,
            Some(2.0),
            DecodedAudioData::I16(vec![1, 2]),
        );

        assert!(align_switched_chunk(&mut chunk, &mut discard_before));
        assert_eq!(discard_before, None);
        assert_eq!(chunk.frames, 2);
        assert_eq!(chunk.data, DecodedAudioData::I16(vec![1, 2]));
    }

    #[test]
    fn eof_waits_for_registered_gapless_prepare_completion() {
        let shared = Arc::new(SharedAudio::new(
            crate::shared::MixFormat::stereo_f32(48_000),
            0.2,
            8.0,
            &crate::dsp::DspSettings::default(),
        ));
        let ready = Arc::new(AtomicBool::new(false));
        let request_id = shared.begin_gapless_prepare();
        let waiter_shared = shared.clone();
        let waiter_ready = ready.clone();
        let (waiting_tx, waiting_rx) = sync_channel(1);
        let (published_tx, published_rx) = sync_channel(1);
        let waiter = thread::spawn(move || {
            let mut reported_wait = false;
            await_gapless_decoder(&waiter_shared, 0, || {
                if waiter_ready.load(Ordering::Acquire) {
                    crate::GaplessDecodeResult::Activated(None)
                } else {
                    if !reported_wait {
                        reported_wait = true;
                        let _ = waiting_tx.send(());
                        // Publish between the activation check and the pending-flag read.
                        published_rx.recv_timeout(Duration::from_secs(1)).unwrap();
                    }
                    crate::GaplessDecodeResult::NotPrepared
                }
            })
        });

        waiting_rx.recv().unwrap();
        ready.store(true, Ordering::Release);
        shared.finish_gapless_prepare(request_id);
        published_tx.send(()).unwrap();
        let result = waiter.join().unwrap();
        assert!(matches!(
            result,
            crate::GaplessDecodeResult::Activated(None)
        ));
    }

    #[test]
    fn eof_gapless_wait_has_a_native_deadline() {
        let shared = Arc::new(SharedAudio::new(
            crate::shared::MixFormat::stereo_f32(48_000),
            0.2,
            8.0,
            &crate::dsp::DspSettings::default(),
        ));
        shared.begin_gapless_prepare();
        let started = Instant::now();
        let result = await_gapless_decoder(&shared, 0, || crate::GaplessDecodeResult::NotPrepared);
        assert!(matches!(result, crate::GaplessDecodeResult::NotPrepared));
        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(!shared.gapless_prepare_is_pending());
    }

    #[test]
    fn eof_does_not_wait_without_registered_gapless_prepare() {
        let shared = Arc::new(SharedAudio::new(
            crate::shared::MixFormat::stereo_f32(48_000),
            0.2,
            8.0,
            &crate::dsp::DspSettings::default(),
        ));
        let result = await_gapless_decoder(&shared, 0, || crate::GaplessDecodeResult::NotPrepared);

        assert!(matches!(result, crate::GaplessDecodeResult::NotPrepared));
    }

    #[test]
    fn eof_gapless_wait_stops_when_decode_generation_changes() {
        let settings = crate::dsp::DspSettings::default();
        let shared = Arc::new(SharedAudio::new(
            crate::shared::MixFormat::stereo_f32(48_000),
            0.2,
            8.0,
            &settings,
        ));
        let epoch = shared.begin_gapless_prepare();
        let reset_shared = shared.clone();
        let reset_settings = settings.clone();
        let (waiting_tx, waiting_rx) = sync_channel(1);
        let waiter_shared = shared.clone();
        let waiter = thread::spawn(move || {
            let mut reported_wait = false;
            await_gapless_decoder(&waiter_shared, 0, || {
                if !reported_wait {
                    reported_wait = true;
                    let _ = waiting_tx.send(());
                }
                crate::GaplessDecodeResult::NotPrepared
            })
        });

        waiting_rx.recv().unwrap();
        reset_shared.reset_for_decode_resume(1.0, &reset_settings);
        let result = waiter.join().unwrap();
        shared.finish_gapless_prepare(epoch);
        assert!(matches!(result, crate::GaplessDecodeResult::NotPrepared));
        assert_eq!(shared.current_decode_generation(), 1);
    }
}

pub(crate) fn emit_decode_error(shared: &SharedAudio, message: String) {
    crate::emit_shared_event(shared, PlayerEvent::error(PlayerErrorCode::Decode, message));
}

pub(crate) fn emit_decode_warning(message: String) {
    crate::emit_event(PlayerEvent::log("warn", message));
}

fn emit_decode_debug(message: String) {
    crate::emit_event(PlayerEvent::log("debug", message));
}

fn log_seek_elapsed(position_secs: f64, elapsed_ms: u128) {
    if elapsed_ms >= 250 {
        emit_decode_warning(format!(
            "decoder seek completed slowly: target={:.3}s elapsed={}ms",
            position_secs.max(0.0),
            elapsed_ms
        ));
    } else {
        emit_decode_debug(format!(
            "decoder seek completed: target={:.3}s elapsed={}ms",
            position_secs.max(0.0),
            elapsed_ms
        ));
    }
}
