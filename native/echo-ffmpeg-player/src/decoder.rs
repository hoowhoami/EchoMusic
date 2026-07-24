use crate::events::{PlayerErrorCode, PlayerEvent, TrackInfo};
use crate::shared::{
    AudioSampleFormat, DecodedAudioChunk, DecodedAudioData, DecodedAudioFormat, PacketCacheStats,
    SharedAudio,
};
use crate::stream::{open_stream, ReadSeek, StreamOptions};
use ffmpeg_audio::{sys, AudioError, AudioReader, PacketCacheOptions, RawAudioData, SeekMode};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TryRecvError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub enum DecodeCommand {
    Seek {
        position_secs: f64,
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
    mix_sample_rate: u32,
    source_channels: usize,
    source_sample_format: AudioSampleFormat,
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
        let reader = AudioReader::new_with_audio_stream_and_packet_cache(
            source,
            audio_stream_ordinal,
            packet_cache,
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
            mix_sample_rate,
            source_channels,
            source_sample_format,
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
        let target = Duration::from_secs_f64(position_secs.max(0.0));
        let started = Instant::now();
        self.reader
            .seek(target, SeekMode::Accurate)
            .or_else(|accurate_err| {
                emit_decode_warning(format!(
                    "accurate seek failed, falling back to coarse seek: {accurate_err}"
                ));
                self.reader.seek(target, SeekMode::Coarse).map_err(|coarse_err| {
                    format!(
                        "failed to seek decoder: accurate seek failed with {accurate_err}; coarse seek failed with {coarse_err}"
                    )
                })
            })?;
        self.pending_playback_restart_position = Some(position_secs.max(0.0));
        let elapsed_ms = started.elapsed().as_millis();
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
        Ok(())
    }

    /// Emit the playback-restart confirmation after the first decoded frame reaches the audio pipeline.
    pub fn confirm_playback_restart_when_audio_ready(&mut self, position_secs: f64) {
        self.pending_playback_restart_position = Some(position_secs.max(0.0));
    }

    pub fn decode_next_chunk(&mut self) -> Result<Option<DecodedAudioChunk>, String> {
        self.reader
            .receive_frame()
            .map_err(|err| format!("failed to decode audio source: {err}"))?
            .map(|frame| decoded_chunk_from_frame(&frame))
            .transpose()
    }

    fn publish_packet_cache_stats(&self, shared: &SharedAudio) {
        shared.update_packet_cache_stats(packet_cache_stats_from_reader(&self.reader));
    }

    fn is_recoverable_tail_error(&self, err: &AudioError, produced_frames: u64) -> bool {
        if produced_frames == 0 {
            return false;
        }
        if !matches!(err, AudioError::FFmpeg(code, _) if *code == sys::AVERROR_INVALIDDATA) {
            return false;
        }
        let Some(duration) = self.duration else {
            return false;
        };
        let Some(position) = self.reader.stream_position() else {
            return false;
        };
        let tail_tolerance = Duration::from_secs_f64(duration.as_secs_f64().mul_add(0.02, 1.0));
        position.saturating_add(tail_tolerance) >= duration
    }
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
        seekable_start_secs: stats.seekable_start.map(|duration| duration.as_secs_f64()),
        seekable_end_secs: stats.seekable_end.map(|duration| duration.as_secs_f64()),
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
    DecoderData::open(
        url,
        audio_stream_ordinal,
        mix_sample_rate,
        Arc::new(AtomicBool::new(false)),
        packet_cache,
        stream_options,
    )
}

pub fn spawn_decode_worker(
    data: DecoderData,
    shared: Arc<SharedAudio>,
    generation: u64,
) -> (JoinHandle<Option<DecoderData>>, SyncSender<DecodeCommand>) {
    let (tx, rx) = sync_channel::<DecodeCommand>(8);
    let handle = thread::Builder::new()
        .name("player-decode".to_string())
        .spawn(move || decode_worker_loop(data, shared, generation, rx))
        .expect("failed to spawn player decode worker");
    (handle, tx)
}

fn decode_worker_loop(
    mut data: DecoderData,
    shared: Arc<SharedAudio>,
    mut generation: u64,
    commands: Receiver<DecodeCommand>,
) -> Option<DecoderData> {
    shared.bind_interrupt(data.interrupt.clone());
    let mut produced_frames = 0u64;
    loop {
        if let Some(next_generation) = handle_decode_commands(&mut data, &shared, &commands) {
            generation = next_generation;
            produced_frames = 0;
        }
        data.publish_packet_cache_stats(&shared);
        if shared.should_stop_decoding() {
            return (!shared.stop.load(Ordering::Acquire)).then_some(data);
        }
        if !shared.is_decode_generation_current(generation) {
            match wait_for_generation_command(&mut data, &shared, &commands) {
                Some(next_generation) => {
                    generation = next_generation;
                    produced_frames = 0;
                    continue;
                }
                None => return (!shared.stop.load(Ordering::Acquire)).then_some(data),
            }
        }
        match data.reader.receive_frame() {
            Ok(Some(frame)) => match decoded_chunk_from_frame(&frame) {
                Ok(chunk) => {
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
                    produced_frames = produced_frames.saturating_add(chunk.frames as u64);
                    if !shared.push_decoded_chunk_for_generation(chunk, generation) {
                        if shared.should_stop_decoding() {
                            return (!shared.stop.load(Ordering::Acquire)).then_some(data);
                        }
                        continue;
                    }
                }
                Err(err) => {
                    shared.mark_decode_failed();
                    emit_decode_error(format!("failed to materialize decoded audio frame: {err}"));
                    return None;
                }
            },
            Ok(None) => {
                data.publish_packet_cache_stats(&shared);
                if !shared.is_decode_generation_current(generation) {
                    continue;
                }
                match crate::activate_gapless_next_decoder(shared.clone(), generation) {
                    crate::GaplessDecodeResult::Activated(decoder) => {
                        if let Some(decoder) = decoder {
                            data = decoder;
                            data.publish_packet_cache_stats(&shared);
                            continue;
                        }
                        return None;
                    }
                    crate::GaplessDecodeResult::NotPrepared => {}
                }
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
                    match crate::activate_gapless_next_decoder(shared.clone(), generation) {
                        crate::GaplessDecodeResult::Activated(decoder) => {
                            if let Some(decoder) = decoder {
                                data = decoder;
                                continue;
                            }
                            return None;
                        }
                        crate::GaplessDecodeResult::NotPrepared => {}
                    }
                    shared.mark_decoded_eof();
                    return Some(data);
                }
                shared.mark_decode_failed();
                emit_decode_error(format!("failed to decode audio source: {err}"));
                return None;
            }
        }
    }
}

fn wait_for_generation_command(
    data: &mut DecoderData,
    shared: &SharedAudio,
    commands: &Receiver<DecodeCommand>,
) -> Option<u64> {
    loop {
        if shared.should_stop_decoding() {
            return None;
        }
        match commands.recv_timeout(Duration::from_millis(50)) {
            Ok(command) => match handle_decode_command(data, shared, command) {
                DecodeCommandResult::Continue(generation) => return Some(generation),
                DecodeCommandResult::Stop => return None,
                DecodeCommandResult::Ignored => continue,
            },
            Err(_) => {
                if shared.should_stop_decoding() {
                    return None;
                }
            }
        }
    }
}

fn handle_decode_commands(
    data: &mut DecoderData,
    shared: &SharedAudio,
    commands: &Receiver<DecodeCommand>,
) -> Option<u64> {
    let mut next_generation = None;
    loop {
        match commands.try_recv() {
            Ok(command) => match handle_decode_command(data, shared, command) {
                DecodeCommandResult::Continue(generation) => next_generation = Some(generation),
                DecodeCommandResult::Stop => return None,
                DecodeCommandResult::Ignored => {}
            },
            Err(TryRecvError::Empty) => return next_generation,
            Err(TryRecvError::Disconnected) => return next_generation,
        }
    }
}

enum DecodeCommandResult {
    Continue(u64),
    Stop,
    Ignored,
}

fn handle_decode_command(
    data: &mut DecoderData,
    shared: &SharedAudio,
    command: DecodeCommand,
) -> DecodeCommandResult {
    match command {
        DecodeCommand::Seek {
            position_secs,
            generation,
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
            data.interrupt.store(false, Ordering::Release);
            let result = data.seek(position_secs);
            let _ = reply.send(result);
            if shared.is_decode_generation_current(generation) {
                DecodeCommandResult::Continue(generation)
            } else {
                DecodeCommandResult::Ignored
            }
        }
        DecodeCommand::Stop => DecodeCommandResult::Stop,
    }
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

pub(crate) fn emit_decode_error(message: String) {
    crate::emit_event(PlayerEvent::error(PlayerErrorCode::Decode, message));
}

fn emit_decode_warning(message: String) {
    crate::emit_event(PlayerEvent::log("warn", message));
}

fn emit_decode_debug(message: String) {
    crate::emit_event(PlayerEvent::log("debug", message));
}
