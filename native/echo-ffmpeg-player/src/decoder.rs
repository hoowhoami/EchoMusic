use crate::events::{PlayerErrorCode, PlayerEvent, TrackInfo};
use crate::network_stream::{open_source, ReadSeek};
use crate::shared::SharedAudio;
use crate::tempo::TempoProcessor;
use ffmpeg_audio::{
    sys, AudioError, AudioReader, PacketCacheOptions, ResampleOptions, Resampler, SeekMode,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

pub struct DecoderData {
    reader: AudioReader,
    resampler: Resampler,
    interrupt: Arc<AtomicBool>,
    duration: Option<Duration>,
    pending_seek_position: Option<f64>,
}

impl DecoderData {
    pub fn open(
        url: String,
        audio_stream_ordinal: Option<usize>,
        sample_rate: u32,
        interrupt: Arc<AtomicBool>,
        packet_cache: PacketCacheOptions,
    ) -> Result<Self, String> {
        let source = open_source(&url, interrupt.clone())?;
        Self::from_source(
            url,
            audio_stream_ordinal,
            sample_rate,
            interrupt,
            source,
            packet_cache,
        )
    }

    fn from_source(
        _url: String,
        audio_stream_ordinal: Option<usize>,
        sample_rate: u32,
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
        let resampler = reader
            .build_resampler(
                ResampleOptions::new()
                    .sample_rate(sample_rate as i32)
                    .channels(crate::shared::TARGET_CHANNELS as i32)
                    .format::<f32>(),
            )
            .map_err(|err| format!("failed to create audio resampler: {err}"))?;
        Ok(Self {
            reader,
            resampler,
            interrupt,
            duration,
            pending_seek_position: None,
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

    pub fn reset_interrupt(&self) {
        self.interrupt.store(false, Ordering::Release);
    }

    pub fn seek(&mut self, position_secs: f64) -> Result<(), String> {
        let target = Duration::from_secs_f64(position_secs.max(0.0));
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
        self.resampler
            .flush()
            .map_err(|err| format!("failed to flush resampler after seek: {err}"))?;
        self.pending_seek_position = Some(position_secs.max(0.0));
        Ok(())
    }

    pub fn decode_into(mut self, shared: Arc<SharedAudio>) -> Option<Self> {
        shared.bind_interrupt(self.interrupt.clone());
        let mut produced_frames = 0u64;
        let mut tempo = match TempoProcessor::new(shared.speed(), shared.sample_rate) {
            Ok(tempo) => tempo,
            Err(err) => {
                shared.mark_decode_failed();
                emit_decode_error(err);
                return None;
            }
        };
        let mut tempo_output = Vec::<f32>::new();
        loop {
            if shared.should_stop_decoding() {
                return (!shared.stop.load(Ordering::Acquire)).then_some(self);
            }
            match self.reader.receive_frame() {
                Ok(Some(frame)) => match self.resampler.process::<f32>(Some(&frame)) {
                    Ok(true) => {
                        let output = self.resampler.output_as::<f32>();
                        if let Some(requested_position) = self.pending_seek_position {
                            if !output.is_empty() {
                                let position = frame
                                    .pts()
                                    .map(|position| position.as_secs_f64())
                                    .unwrap_or(requested_position);
                                shared.set_position_secs(position);
                                shared.notify_signal(crate::shared::PlaybackSignal::Seeked);
                                self.pending_seek_position = None;
                            }
                        }
                        let speed = shared.speed();
                        if let Err(err) = tempo
                            .set_speed(speed)
                            .and_then(|_| tempo.process_into(output, &mut tempo_output))
                        {
                            shared.mark_decode_failed();
                            emit_decode_error(err);
                            return None;
                        }
                        produced_frames = produced_frames.saturating_add(
                            (tempo_output.len() / crate::shared::TARGET_CHANNELS) as u64,
                        );
                        let source_frames = tempo_source_frames(tempo_output.len(), speed);
                        if !shared.push_samples_with_source_frames(&tempo_output, source_frames) {
                            return (!shared.stop.load(Ordering::Acquire)).then_some(self);
                        }
                    }
                    Ok(false) => {}
                    Err(err) => {
                        shared.mark_decode_failed();
                        emit_decode_error(format!("failed to resample audio frame: {err}"));
                        return None;
                    }
                },
                Ok(None) => {
                    if let Ok(true) = self.resampler.process::<f32>(None) {
                        let speed = shared.speed();
                        if let Err(err) = tempo.set_speed(speed).and_then(|_| {
                            tempo.process_into(self.resampler.output_as::<f32>(), &mut tempo_output)
                        }) {
                            shared.mark_decode_failed();
                            emit_decode_error(err);
                            return None;
                        }
                        let source_frames = tempo_source_frames(tempo_output.len(), speed);
                        let _ =
                            shared.push_samples_with_source_frames(&tempo_output, source_frames);
                    }
                    if let Err(err) = tempo.finish_into(&mut tempo_output) {
                        shared.mark_decode_failed();
                        emit_decode_error(err);
                        return None;
                    }
                    let source_frames = tempo_source_frames(tempo_output.len(), tempo.speed());
                    let _ = shared.push_samples_with_source_frames(&tempo_output, source_frames);
                    match crate::try_activate_gapless_next(shared.clone()) {
                        crate::GaplessDecodeResult::Activated(decoder) => return decoder,
                        crate::GaplessDecodeResult::NotPrepared => {}
                    }
                    shared.mark_eof();
                    return Some(self);
                }
                Err(err) => {
                    if self.interrupt.load(Ordering::Acquire) || shared.should_stop_decoding() {
                        return (!shared.stop.load(Ordering::Acquire)).then_some(self);
                    }
                    if self.is_recoverable_tail_error(&err, produced_frames) {
                        emit_decode_warning(format!(
                            "treating trailing decode error as EOF: {err}"
                        ));
                        if let Ok(true) = self.resampler.process::<f32>(None) {
                            let speed = shared.speed();
                            if let Err(err) = tempo.set_speed(speed).and_then(|_| {
                                tempo.process_into(
                                    self.resampler.output_as::<f32>(),
                                    &mut tempo_output,
                                )
                            }) {
                                shared.mark_decode_failed();
                                emit_decode_error(err);
                                return None;
                            }
                            let source_frames = tempo_source_frames(tempo_output.len(), speed);
                            let _ = shared
                                .push_samples_with_source_frames(&tempo_output, source_frames);
                        }
                        if let Err(err) = tempo.finish_into(&mut tempo_output) {
                            shared.mark_decode_failed();
                            emit_decode_error(err);
                            return None;
                        }
                        let source_frames = tempo_source_frames(tempo_output.len(), tempo.speed());
                        let _ =
                            shared.push_samples_with_source_frames(&tempo_output, source_frames);
                        match crate::try_activate_gapless_next(shared.clone()) {
                            crate::GaplessDecodeResult::Activated(decoder) => return decoder,
                            crate::GaplessDecodeResult::NotPrepared => {}
                        }
                        shared.mark_eof();
                        return Some(self);
                    }
                    shared.mark_decode_failed();
                    emit_decode_error(format!("failed to decode audio source: {err}"));
                    return None;
                }
            }
        }
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

pub fn open_decoder(
    url: String,
    audio_stream_ordinal: Option<usize>,
    sample_rate: u32,
    packet_cache: PacketCacheOptions,
) -> Result<DecoderData, String> {
    DecoderData::open(
        url,
        audio_stream_ordinal,
        sample_rate,
        Arc::new(AtomicBool::new(false)),
        packet_cache,
    )
}

fn tempo_source_frames(output_samples: usize, speed: f32) -> u64 {
    let output_frames = output_samples / crate::shared::TARGET_CHANNELS;
    ((output_frames as f64) * speed.clamp(0.25, 4.0) as f64).round() as u64
}

pub fn spawn_decode_thread(
    data: DecoderData,
    shared: Arc<SharedAudio>,
) -> JoinHandle<Option<DecoderData>> {
    thread::Builder::new()
        .name("player-decode".to_string())
        .spawn(move || data.decode_into(shared))
        .expect("failed to spawn player decode thread")
}

pub fn list_tracks_for_url(url: &str) -> Vec<TrackInfo> {
    let interrupt = Arc::new(AtomicBool::new(false));
    let Ok(source) = open_source(url, interrupt) else {
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

fn emit_decode_error(message: String) {
    crate::emit_event(PlayerEvent::error(PlayerErrorCode::Decode, message));
}

fn emit_decode_warning(message: String) {
    crate::emit_event(PlayerEvent::log("warn", message));
}
