use crate::error::{PlayerError, PlayerResult};
use crate::http_range::{HttpRangeError, HttpRangeInput};
use crate::types::TrackInfo;
use ffmpeg::software::resampling;
use ffmpeg::util::format::sample::{Sample, Type};
use ffmpeg::{codec, format, frame, media, ChannelLayout, Packet, Rational};
use ffmpeg_next as ffmpeg;
use std::collections::VecDeque;
use std::ffi::{c_void, CString};
use std::os::raw::c_int;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TryRecvError, TrySendError};
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub const PCM_FORMAT_SAMPLE: &str = "f32";
const FFMPEG_TIME_BASE: f64 = 1_000_000.0;
const PACKET_QUEUE_CAPACITY: usize = 512;
const PACKET_RECV_TIMEOUT: Duration = Duration::from_millis(15);
const DEMUX_QUEUE_RETRY_DELAY: Duration = Duration::from_millis(2);
const DEMUX_SEEK_ACK_TIMEOUT: Duration = Duration::from_secs(5);
const NETWORK_RW_TIMEOUT_US: &str = "15000000";
const NETWORK_RECONNECT_DELAY_MAX_SECONDS: &str = "5";
const NETWORK_PROBE_SIZE: &str = "262144";
const NETWORK_ANALYZE_DURATION_US: &str = "1000000";
const HTTP_AVIO_BUFFER_BYTES: usize = 64 * 1024;
const DEMUX_PACKET_CACHE_SECONDS: f64 = 90.0;
const DEMUX_PACKET_CACHE_MAX_BYTES: usize = 32 * 1024 * 1024;
const DEMUX_PACKET_CACHE_REPLAY_SECONDS: f64 = 4.0;
const DEMUX_PACKET_CACHE_MIN_REPLAY_SECONDS: f64 = 0.20;
const DEMUX_PACKET_CACHE_SEEK_TOLERANCE_SECONDS: f64 = 0.08;
const DEMUX_PACKET_CACHE_GAP_TOLERANCE_SECONDS: f64 = 1.0;
const DEMUX_PACKET_DROP_TOLERANCE_SECONDS: f64 = 0.025;
const NETWORK_RECONNECT_ATTEMPTS: usize = 5;
const NETWORK_RECONNECT_OVERLAP_SECONDS: f64 = 0.75;
const NETWORK_EOF_TOLERANCE_SECONDS: f64 = 2.0;
const DURATION_DISAGREEMENT_LOG_SECONDS: f64 = 1.0;
const DURATION_DISAGREEMENT_LOG_RATIO: f64 = 0.01;
const MAX_CONSECUTIVE_DECODE_ERRORS: usize = 16;
const NETWORK_RECONNECT_BACKOFFS: [Duration; NETWORK_RECONNECT_ATTEMPTS] = [
    Duration::from_millis(150),
    Duration::from_millis(300),
    Duration::from_millis(700),
    Duration::from_millis(1_500),
    Duration::from_millis(3_000),
];

static FFMPEG_INIT: OnceLock<PlayerResult<()>> = OnceLock::new();

#[derive(Clone, Copy)]
struct DurationCandidate {
    source: &'static str,
    seconds: f64,
    bitrate_estimate: bool,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct AudioFormat {
    pub sample_rate: u32,
    pub channels: usize,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct DecodedAudioChunk {
    pub format: AudioFormat,
    pub time_pos: f64,
    pub samples: Vec<f32>,
}

#[derive(Debug)]
pub enum DecodeReadResult {
    Chunk(DecodedAudioChunk),
    Buffering,
    Eof,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub enum DecoderCommand {
    Load { url: String, audio_track_id: i64 },
    Play,
    Pause,
    Seek(f64),
    Stop,
    Shutdown,
}

#[allow(dead_code)]
pub trait DecoderBackend: Send + 'static {
    fn load(&mut self, url: &str, audio_track_id: i64) -> PlayerResult<AudioFormat>;
    fn seek(&mut self, time_pos: f64) -> PlayerResult<()>;
    fn read_chunk(&mut self) -> PlayerResult<DecodeReadResult>;
}

struct QueuedPacket {
    generation: u64,
    time_base: Rational,
    packet: Packet,
}

enum DemuxEvent {
    Packet(QueuedPacket),
    Eof { generation: u64 },
    Error { generation: u64, message: String },
}

impl DemuxEvent {
    fn generation(&self) -> u64 {
        match self {
            Self::Packet(packet) => packet.generation,
            Self::Eof { generation } | Self::Error { generation, .. } => *generation,
        }
    }
}

struct SeekAck {
    generation: u64,
    result: PlayerResult<()>,
}

enum DemuxCommand {
    Seek {
        time_pos: f64,
        response: mpsc::Sender<SeekAck>,
    },
    Shutdown,
}

struct DemuxHandle {
    commands: mpsc::Sender<DemuxCommand>,
    handle: Option<JoinHandle<()>>,
    interrupt: Arc<AtomicBool>,
    io_interrupt: Arc<AtomicBool>,
}

#[derive(Clone)]
struct DemuxSource {
    url: String,
    audio_track_id: i64,
    is_network: bool,
}

struct OpenedInput {
    // Keep Input before the callback holder so FFmpeg closes before opaque is freed.
    input: format::context::Input,
    _custom_io: Option<HttpAvioContext>,
    _interrupt: FfmpegInterrupt,
}

struct DemuxState {
    source: DemuxSource,
    opened: OpenedInput,
    io_interrupt: Arc<AtomicBool>,
    cache: DemuxPacketCache,
    stream_index: usize,
    time_base: Rational,
    duration: Option<f64>,
    generation: u64,
    last_packet_time: Option<f64>,
    reconnect_failures: usize,
    drop_packets_before: Option<f64>,
    replay_queue: VecDeque<CachedPacketReplay>,
    pending_resume_seek: Option<f64>,
}

struct CachedPacket {
    start: f64,
    end: f64,
    size: usize,
    time_base: Rational,
    packet: Packet,
}

struct CacheReplay {
    packets: Vec<CachedPacketReplay>,
    resume_time: f64,
}

struct CachedPacketReplay {
    time_base: Rational,
    packet: Packet,
}

#[derive(Default)]
struct DemuxPacketCache {
    packets: VecDeque<CachedPacket>,
    bytes: usize,
}

enum PacketReadState {
    Sent,
    Buffering,
    Eof,
}

enum DemuxCommandResult {
    Sought,
    Shutdown,
}

enum DemuxSendResult {
    Sent,
    Superseded,
    Shutdown,
}

pub struct FfmpegDecoder {
    target: AudioFormat,
    interrupt: Arc<AtomicBool>,
    decoder: Option<codec::decoder::Audio>,
    resampler: Option<resampling::Context>,
    demux: Option<DemuxHandle>,
    packets: Option<Receiver<DemuxEvent>>,
    pending_events: VecDeque<DemuxEvent>,
    duration: Option<f64>,
    generation: u64,
    time_base: Rational,
    tracks: Vec<TrackInfo>,
    codec_name: String,
    eof_sent: bool,
    finished: bool,
    decode_error_streak: usize,
}

impl FfmpegDecoder {
    pub fn new(target: AudioFormat, interrupt: Arc<AtomicBool>) -> PlayerResult<Self> {
        init_ffmpeg()?;
        Ok(Self {
            target,
            interrupt,
            decoder: None,
            resampler: None,
            demux: None,
            packets: None,
            pending_events: VecDeque::new(),
            duration: None,
            generation: 0,
            time_base: Rational(1, 1),
            tracks: Vec::new(),
            codec_name: String::new(),
            eof_sent: false,
            finished: false,
            decode_error_streak: 0,
        })
    }

    pub fn duration(&self) -> Option<f64> {
        self.duration
    }

    pub fn track_list(&self) -> Vec<TrackInfo> {
        self.tracks.clone()
    }

    pub fn codec_name(&self) -> String {
        self.codec_name.clone()
    }

    pub fn interrupted(&self) -> bool {
        self.interrupt.load(Ordering::SeqCst)
    }

    fn receive_resampled_frame(&mut self) -> PlayerResult<Option<DecodedAudioChunk>> {
        let mut decoded = frame::Audio::empty();
        let result = {
            let decoder = self
                .decoder
                .as_mut()
                .ok_or_else(|| PlayerError::State("decoder is not loaded".to_string()))?;
            decoder.receive_frame(&mut decoded)
        };

        match result {
            Ok(()) => {
                self.decode_error_streak = 0;
                let time_pos = decoded
                    .timestamp()
                    .map(|pts| rational_seconds(pts, self.time_base))
                    .unwrap_or_default();
                self.normalize_decoded_frame_layout(&mut decoded);
                let converted = self.resample_frame(&decoded)?;
                Ok(Some(self.frame_to_chunk(&converted, time_pos)))
            }
            Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN => Ok(None),
            Err(ffmpeg::Error::Eof) => Ok(None),
            Err(err) if is_recoverable_decode_error(&err) => {
                self.record_decode_error("receive frame", &err)?;
                Ok(None)
            }
            Err(err) => Err(PlayerError::Backend(format!(
                "ffmpeg receive frame failed: {err}"
            ))),
        }
    }

    fn read_next_packet(&mut self) -> PlayerResult<PacketReadState> {
        if self.interrupted() {
            return Err(PlayerError::State("decoder interrupted".to_string()));
        }
        let event = match self.next_demux_event()? {
            Some(event) => event,
            None => return Ok(PacketReadState::Buffering),
        };

        if event.generation() < self.generation {
            return Ok(PacketReadState::Buffering);
        }
        if event.generation() > self.generation {
            self.generation = event.generation();
            self.reset_decode_pipeline();
        }

        match event {
            DemuxEvent::Packet(packet) => {
                self.time_base = packet.time_base;
                let result = {
                    let decoder = self
                        .decoder
                        .as_mut()
                        .ok_or_else(|| PlayerError::State("decoder is not loaded".to_string()))?;
                    decoder.send_packet(&packet.packet)
                };
                match result {
                    Ok(()) => Ok(PacketReadState::Sent),
                    Err(err) if is_recoverable_decode_error(&err) => {
                        self.record_decode_error("send packet", &err)?;
                        Ok(PacketReadState::Sent)
                    }
                    Err(err) => Err(PlayerError::Backend(format!(
                        "ffmpeg send packet failed: {err}"
                    ))),
                }
            }
            DemuxEvent::Eof { .. } => Ok(PacketReadState::Eof),
            DemuxEvent::Error { message, .. } => Err(PlayerError::Backend(message)),
        }
    }

    fn next_demux_event(&mut self) -> PlayerResult<Option<DemuxEvent>> {
        loop {
            if let Some(event) = self.pending_events.pop_front() {
                if event.generation() >= self.generation {
                    return Ok(Some(event));
                }
                continue;
            }

            let packets = self
                .packets
                .as_ref()
                .ok_or_else(|| PlayerError::State("demux queue is not loaded".to_string()))?;
            match packets.recv_timeout(PACKET_RECV_TIMEOUT) {
                Ok(event) if event.generation() >= self.generation => return Ok(Some(event)),
                Ok(_) => continue,
                Err(RecvTimeoutError::Timeout) => return Ok(None),
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(PlayerError::State("demux queue disconnected".to_string()));
                }
            }
        }
    }

    fn drain_packet_queue(&mut self) {
        if let Some(packets) = self.packets.as_ref() {
            while let Ok(event) = packets.try_recv() {
                if event.generation() >= self.generation {
                    self.pending_events.push_back(event);
                }
            }
        }
    }

    fn reset_decode_pipeline(&mut self) {
        if let Some(decoder) = self.decoder.as_mut() {
            decoder.flush();
        }
        self.resampler = None;
        self.eof_sent = false;
        self.finished = false;
        self.decode_error_streak = 0;
    }

    fn record_decode_error(&mut self, stage: &str, err: &ffmpeg::Error) -> PlayerResult<()> {
        self.decode_error_streak = self.decode_error_streak.saturating_add(1);
        if self.decode_error_streak > MAX_CONSECUTIVE_DECODE_ERRORS {
            return Err(PlayerError::Backend(format!(
                "ffmpeg {stage} failed repeatedly: {err}"
            )));
        }

        if self.decode_error_streak <= 3 || self.decode_error_streak.is_multiple_of(8) {
            crate::emit_event(crate::log::event(
                crate::log::LogLevel::Warn,
                format!(
                    "ffmpeg {stage} skipped corrupt audio data: {err} (streak={}/{MAX_CONSECUTIVE_DECODE_ERRORS})",
                    self.decode_error_streak
                ),
            ));
        }
        Ok(())
    }

    fn flush_resampler(&mut self) -> PlayerResult<Option<DecodedAudioChunk>> {
        let Some(resampler) = self.resampler.as_mut() else {
            return Ok(None);
        };
        let mut converted = frame::Audio::empty();
        match resampler.flush(&mut converted) {
            Ok(Some(_)) | Ok(None) => {
                if converted.samples() == 0 {
                    Ok(None)
                } else {
                    Ok(Some(self.frame_to_chunk(&converted, 0.0)))
                }
            }
            Err(err) if is_resampler_flush_format_change(&err) => {
                self.resampler = None;
                crate::emit_event(crate::log::event(
                    crate::log::LogLevel::Warn,
                    format!("ffmpeg resampler flush ignored format change: {err}"),
                ));
                Ok(None)
            }
            Err(err) => Err(PlayerError::Backend(format!(
                "ffmpeg resampler flush failed: {err}"
            ))),
        }
    }

    fn frame_to_chunk(&self, frame: &frame::Audio, time_pos: f64) -> DecodedAudioChunk {
        let channels = usize::from(frame.channels());
        let sample_count = frame.samples().saturating_mul(channels);
        let samples = if sample_count == 0 {
            Vec::new()
        } else {
            let bytes = frame.data(0);
            let ptr = bytes.as_ptr().cast::<f32>();
            unsafe { std::slice::from_raw_parts(ptr, sample_count) }.to_vec()
        };

        DecodedAudioChunk {
            format: AudioFormat {
                sample_rate: frame.rate(),
                channels,
            },
            time_pos,
            samples,
        }
    }

    fn normalize_decoded_frame_layout(&self, frame: &mut frame::Audio) {
        if frame.channel_layout().is_empty() {
            frame.set_channel_layout(actual_frame_layout(frame));
        }
    }

    fn resample_frame(&mut self, frame: &frame::Audio) -> PlayerResult<frame::Audio> {
        let mut converted = frame::Audio::empty();
        match self.run_resampler(frame, &mut converted)? {
            Ok(()) => Ok(converted),
            Err(ffmpeg::Error::InputChanged | ffmpeg::Error::OutputChanged) => {
                self.resampler = None;
                let mut converted = frame::Audio::empty();
                self.run_resampler(frame, &mut converted)?.map_err(|err| {
                    PlayerError::Backend(format!("ffmpeg resample failed after reinit: {err}"))
                })?;
                Ok(converted)
            }
            Err(err) => Err(PlayerError::Backend(format!(
                "ffmpeg resample failed: {err}"
            ))),
        }
    }

    fn run_resampler(
        &mut self,
        frame: &frame::Audio,
        converted: &mut frame::Audio,
    ) -> PlayerResult<Result<(), ffmpeg::Error>> {
        let resampler = self.resampler_for_frame(frame)?;
        Ok(resampler.run(frame, converted).map(|_| ()))
    }

    fn resampler_for_frame(
        &mut self,
        frame: &frame::Audio,
    ) -> PlayerResult<&mut resampling::Context> {
        let frame_layout = actual_frame_layout(frame);
        let needs_new = self
            .resampler
            .as_ref()
            .map(|resampler| {
                let input = resampler.input();
                input.format != frame.format()
                    || input.rate != frame.rate()
                    || input.channel_layout != frame_layout
            })
            .unwrap_or(true);

        if needs_new {
            let target_channels = self.target.channels.clamp(1, 8);
            let target_layout = ChannelLayout::default(target_channels as i32);
            self.resampler = Some(
                resampling::Context::get(
                    frame.format(),
                    frame_layout,
                    frame.rate(),
                    Sample::F32(Type::Packed),
                    target_layout,
                    self.target.sample_rate,
                )
                .map_err(|err| {
                    PlayerError::Backend(format!("ffmpeg resampler init failed: {err}"))
                })?,
            );
        }

        self.resampler
            .as_mut()
            .ok_or_else(|| PlayerError::State("resampler is not initialized".to_string()))
    }
}

impl DecoderBackend for FfmpegDecoder {
    fn load(&mut self, url: &str, audio_track_id: i64) -> PlayerResult<AudioFormat> {
        self.shutdown_demux();
        let source = DemuxSource {
            url: url.to_string(),
            audio_track_id,
            is_network: is_network_url(url),
        };
        let io_interrupt = Arc::new(AtomicBool::new(false));
        let opened = open_input(&source.url, self.interrupt.clone(), io_interrupt.clone())?;
        let tracks = collect_track_info(&opened.input);
        let (stream_index, time_base, parameters, codec_name) = {
            let stream = select_audio_stream(&opened.input, audio_track_id)?;
            let parameters = stream.parameters();
            let codec_name = parameters.id().name().to_string();
            (stream.index(), stream.time_base(), parameters, codec_name)
        };
        let duration = input_duration(&opened.input, stream_index);
        let context = codec::context::Context::from_parameters(parameters)
            .map_err(|err| PlayerError::Backend(format!("ffmpeg codec context failed: {err}")))?;
        let decoder = context
            .decoder()
            .audio()
            .map_err(|err| PlayerError::Backend(format!("ffmpeg audio decoder failed: {err}")))?;

        let target_channels = self.target.channels.clamp(1, 8);
        let (demux, packets) = start_demux_thread(
            source,
            opened,
            stream_index,
            time_base,
            duration,
            self.interrupt.clone(),
            io_interrupt,
        )?;

        self.decoder = Some(decoder);
        self.resampler = None;
        self.demux = Some(demux);
        self.packets = Some(packets);
        self.pending_events.clear();
        self.duration = duration;
        self.generation = 0;
        self.time_base = time_base;
        self.tracks = tracks;
        self.codec_name = codec_name;
        self.eof_sent = false;
        self.finished = false;
        self.decode_error_streak = 0;

        Ok(AudioFormat {
            sample_rate: self.target.sample_rate,
            channels: target_channels,
        })
    }

    fn seek(&mut self, time_pos: f64) -> PlayerResult<()> {
        if self.interrupted() {
            return Err(PlayerError::State("decoder interrupted".to_string()));
        }
        let started = Instant::now();
        let demux = self
            .demux
            .as_ref()
            .ok_or_else(|| PlayerError::State("demux thread is not loaded".to_string()))?;
        let (response_tx, response_rx) = mpsc::channel();
        demux.io_interrupt.store(true, Ordering::SeqCst);
        demux
            .commands
            .send(DemuxCommand::Seek {
                time_pos,
                response: response_tx,
            })
            .map_err(|err| PlayerError::State(format!("demux thread is not available: {err}")))?;
        let ack = response_rx
            .recv_timeout(DEMUX_SEEK_ACK_TIMEOUT)
            .map_err(|err| PlayerError::Backend(format!("demux seek did not complete: {err}")))?;
        ack.result?;
        self.generation = ack.generation;
        self.pending_events.clear();
        self.drain_packet_queue();
        self.reset_decode_pipeline();
        let elapsed = started.elapsed();
        if elapsed >= Duration::from_millis(250) {
            crate::emit_event(crate::log::event(
                crate::log::LogLevel::Warn,
                format!("decoder seek completed slowly: {elapsed:?} target={time_pos:.3}s"),
            ));
        }
        Ok(())
    }

    fn read_chunk(&mut self) -> PlayerResult<DecodeReadResult> {
        if self.interrupted() {
            return Err(PlayerError::State("decoder interrupted".to_string()));
        }
        if self.finished {
            return Ok(DecodeReadResult::Eof);
        }

        loop {
            if let Some(chunk) = self.receive_resampled_frame()? {
                if !chunk.samples.is_empty() {
                    return Ok(DecodeReadResult::Chunk(chunk));
                }
            }

            if self.eof_sent {
                if let Some(chunk) = self.flush_resampler()? {
                    return Ok(DecodeReadResult::Chunk(chunk));
                }
                self.finished = true;
                return Ok(DecodeReadResult::Eof);
            }

            match self.read_next_packet()? {
                PacketReadState::Sent => continue,
                PacketReadState::Buffering => return Ok(DecodeReadResult::Buffering),
                PacketReadState::Eof => {
                    if let Some(decoder) = self.decoder.as_mut() {
                        decoder.send_eof().map_err(|err| {
                            PlayerError::Backend(format!("ffmpeg send eof failed: {err}"))
                        })?;
                    }
                    self.eof_sent = true;
                }
            }
        }
    }
}

impl FfmpegDecoder {
    fn shutdown_demux(&mut self) {
        if let Some(mut demux) = self.demux.take() {
            demux.shutdown();
        }
        self.packets = None;
        self.pending_events.clear();
    }
}

impl Drop for FfmpegDecoder {
    fn drop(&mut self) {
        self.shutdown_demux();
    }
}

impl DemuxHandle {
    fn shutdown(&mut self) {
        self.interrupt.store(true, Ordering::SeqCst);
        self.io_interrupt.store(true, Ordering::SeqCst);
        let _ = self.commands.send(DemuxCommand::Shutdown);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn start_demux_thread(
    source: DemuxSource,
    opened: OpenedInput,
    stream_index: usize,
    time_base: Rational,
    duration: Option<f64>,
    interrupt: Arc<AtomicBool>,
    io_interrupt: Arc<AtomicBool>,
) -> PlayerResult<(DemuxHandle, Receiver<DemuxEvent>)> {
    let (event_tx, event_rx) = mpsc::sync_channel(PACKET_QUEUE_CAPACITY);
    let (command_tx, command_rx) = mpsc::channel();
    let interrupt_for_thread = interrupt.clone();
    let io_interrupt_for_thread = io_interrupt.clone();
    let handle = thread::Builder::new()
        .name("echo-ffmpeg-demux".to_string())
        .spawn(move || {
            let state = DemuxState {
                source,
                opened,
                io_interrupt: io_interrupt_for_thread,
                cache: DemuxPacketCache::default(),
                stream_index,
                time_base,
                duration,
                generation: 0,
                last_packet_time: None,
                reconnect_failures: 0,
                drop_packets_before: None,
                replay_queue: VecDeque::new(),
                pending_resume_seek: None,
            };
            run_demux_thread(state, interrupt_for_thread, event_tx, command_rx);
        })
        .map_err(|err| PlayerError::Backend(format!("failed to spawn demux thread: {err}")))?;

    Ok((
        DemuxHandle {
            commands: command_tx,
            handle: Some(handle),
            interrupt,
            io_interrupt,
        },
        event_rx,
    ))
}

fn run_demux_thread(
    mut state: DemuxState,
    interrupt: Arc<AtomicBool>,
    events: SyncSender<DemuxEvent>,
    commands: Receiver<DemuxCommand>,
) {
    'outer: loop {
        if interrupt.load(Ordering::SeqCst) {
            break;
        }

        loop {
            match commands.try_recv() {
                Ok(command) => match handle_demux_command(command, &mut state) {
                    DemuxCommandResult::Sought => continue,
                    DemuxCommandResult::Shutdown => break 'outer,
                },
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break 'outer,
            }
        }

        if let Some(replay) = state.replay_queue.pop_front() {
            let replay_generation = state.generation;
            match send_demux_event(
                &events,
                &commands,
                &interrupt,
                &mut state,
                DemuxEvent::Packet(QueuedPacket {
                    generation: replay_generation,
                    time_base: replay.time_base,
                    packet: replay.packet,
                }),
            ) {
                DemuxSendResult::Sent => {}
                DemuxSendResult::Superseded => continue,
                DemuxSendResult::Shutdown => break,
            }
            continue;
        }

        if let Some(resume_time) = state.pending_resume_seek.take() {
            if let Err(err) = seek_demux_input(&mut state, resume_time) {
                let _ = events.try_send(DemuxEvent::Error {
                    generation: state.generation,
                    message: format!("ffmpeg seek after demux cache replay failed: {err}"),
                });
                if !wait_for_demux_seek_or_shutdown(&commands, &interrupt, &mut state) {
                    break;
                }
                continue;
            }
        }

        let mut packet = Packet::empty();
        match packet.read(&mut state.opened.input) {
            Ok(()) if packet.stream() == state.stream_index => {
                if should_drop_demux_packet(&mut state, &packet) {
                    continue;
                }
                update_demux_position(&mut state, &packet);
                state.reconnect_failures = 0;
                let packet_generation = state.generation;
                let packet_time_base = state.time_base;
                state.cache.push(state.time_base, &packet);
                match send_demux_event(
                    &events,
                    &commands,
                    &interrupt,
                    &mut state,
                    DemuxEvent::Packet(QueuedPacket {
                        generation: packet_generation,
                        time_base: packet_time_base,
                        packet,
                    }),
                ) {
                    DemuxSendResult::Sent => {}
                    DemuxSendResult::Superseded => continue,
                    DemuxSendResult::Shutdown => break,
                }
            }
            Ok(()) => continue,
            Err(ffmpeg::Error::Eof) => {
                if should_reconnect_after_eof(&state) {
                    match reconnect_demux(
                        &mut state,
                        &commands,
                        &interrupt,
                        "ffmpeg reached EOF before media duration",
                    ) {
                        DemuxReconnectResult::Recovered => continue,
                        DemuxReconnectResult::Shutdown => break,
                        DemuxReconnectResult::Failed(message) => {
                            crate::emit_event(crate::log::event(
                                crate::log::LogLevel::Warn,
                                format!(
                                    "{message}; treating network EOF as media end after reconnect failed"
                                ),
                            ));
                        }
                    }
                }

                let eof_generation = state.generation;
                match send_demux_event(
                    &events,
                    &commands,
                    &interrupt,
                    &mut state,
                    DemuxEvent::Eof {
                        generation: eof_generation,
                    },
                ) {
                    DemuxSendResult::Sent | DemuxSendResult::Superseded => {}
                    DemuxSendResult::Shutdown => break,
                }
                if !wait_for_demux_seek_or_shutdown(&commands, &interrupt, &mut state) {
                    break;
                }
            }
            Err(_) if interrupt.load(Ordering::SeqCst) => break,
            Err(_) if state.io_interrupt.load(Ordering::SeqCst) => {
                state.io_interrupt.store(false, Ordering::SeqCst);
                continue;
            }
            Err(err) if is_controlled_demux_interrupt(&err) => {
                state.io_interrupt.store(false, Ordering::SeqCst);
                continue;
            }
            Err(err) => {
                let read_error = format!("ffmpeg read packet failed: {err}");
                match reconnect_demux(&mut state, &commands, &interrupt, &read_error) {
                    DemuxReconnectResult::Recovered => continue,
                    DemuxReconnectResult::Shutdown => break,
                    DemuxReconnectResult::Failed(message) => {
                        let _ = events.try_send(DemuxEvent::Error {
                            generation: state.generation,
                            message,
                        });
                    }
                }
                if !wait_for_demux_seek_or_shutdown(&commands, &interrupt, &mut state) {
                    break;
                }
            }
        }
    }
}

fn send_demux_event(
    events: &SyncSender<DemuxEvent>,
    commands: &Receiver<DemuxCommand>,
    interrupt: &Arc<AtomicBool>,
    state: &mut DemuxState,
    mut event: DemuxEvent,
) -> DemuxSendResult {
    loop {
        if interrupt.load(Ordering::SeqCst) {
            return DemuxSendResult::Shutdown;
        }
        if event.generation() < state.generation {
            return DemuxSendResult::Superseded;
        }

        match events.try_send(event) {
            Ok(()) => return DemuxSendResult::Sent,
            Err(TrySendError::Disconnected(_)) => return DemuxSendResult::Shutdown,
            Err(TrySendError::Full(returned)) => {
                event = returned;
                match commands.try_recv() {
                    Ok(command) => match handle_demux_command(command, state) {
                        DemuxCommandResult::Sought => return DemuxSendResult::Superseded,
                        DemuxCommandResult::Shutdown => return DemuxSendResult::Shutdown,
                    },
                    Err(TryRecvError::Empty) => thread::sleep(DEMUX_QUEUE_RETRY_DELAY),
                    Err(TryRecvError::Disconnected) => return DemuxSendResult::Shutdown,
                }
            }
        }
    }
}

fn wait_for_demux_seek_or_shutdown(
    commands: &Receiver<DemuxCommand>,
    interrupt: &Arc<AtomicBool>,
    state: &mut DemuxState,
) -> bool {
    loop {
        if interrupt.load(Ordering::SeqCst) {
            return false;
        }
        match commands.recv_timeout(PACKET_RECV_TIMEOUT) {
            Ok(command) => match handle_demux_command(command, state) {
                DemuxCommandResult::Sought => return true,
                DemuxCommandResult::Shutdown => return false,
            },
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return false,
        }
    }
}

impl DemuxPacketCache {
    fn push(&mut self, time_base: Rational, packet: &Packet) {
        let Some((start, end)) = packet_time_range(packet, time_base) else {
            return;
        };
        if !start.is_finite() || !end.is_finite() || start < 0.0 {
            return;
        }

        let size = packet.size().max(1);
        self.bytes = self.bytes.saturating_add(size);
        self.packets.push_back(CachedPacket {
            start,
            end,
            size,
            time_base,
            packet: packet.clone(),
        });
        self.trim();
    }

    fn replay(&self, time_pos: f64) -> Option<CacheReplay> {
        let target = time_pos.max(0.0);
        let start_index = self.packets.iter().position(|packet| {
            packet.end + DEMUX_PACKET_CACHE_SEEK_TOLERANCE_SECONDS >= target
                && packet.start <= target + DEMUX_PACKET_CACHE_SEEK_TOLERANCE_SECONDS
        })?;

        let mut packets = Vec::new();
        let mut previous_end: Option<f64> = None;
        let mut replay_end = target;
        for packet in self.packets.iter().skip(start_index) {
            if let Some(previous_end) = previous_end {
                if packet.start - previous_end > DEMUX_PACKET_CACHE_GAP_TOLERANCE_SECONDS {
                    break;
                }
            }
            if packet.start > target + DEMUX_PACKET_CACHE_REPLAY_SECONDS {
                break;
            }

            replay_end = replay_end.max(packet.end);
            previous_end = Some(packet.end);
            packets.push(CachedPacketReplay {
                time_base: packet.time_base,
                packet: packet.packet.clone(),
            });

            if replay_end >= target + DEMUX_PACKET_CACHE_REPLAY_SECONDS {
                break;
            }
        }

        if replay_end < target + DEMUX_PACKET_CACHE_MIN_REPLAY_SECONDS || packets.is_empty() {
            return None;
        }

        Some(CacheReplay {
            packets,
            resume_time: replay_end,
        })
    }

    fn note_seek_miss(&self, time_pos: f64) {
        crate::emit_event(crate::log::event(
            crate::log::LogLevel::Info,
            format!("demux cache seek miss: target={time_pos:.3}s"),
        ));
    }

    fn trim(&mut self) {
        if let Some(newest_end) = self.packets.back().map(|packet| packet.end) {
            while self
                .packets
                .front()
                .map(|packet| packet.end + DEMUX_PACKET_CACHE_SECONDS < newest_end)
                .unwrap_or(false)
            {
                if let Some(packet) = self.packets.pop_front() {
                    self.bytes = self.bytes.saturating_sub(packet.size);
                }
            }
        }

        while self.bytes > DEMUX_PACKET_CACHE_MAX_BYTES {
            if let Some(packet) = self.packets.pop_front() {
                self.bytes = self.bytes.saturating_sub(packet.size);
            } else {
                break;
            }
        }
    }
}

fn handle_demux_command(command: DemuxCommand, state: &mut DemuxState) -> DemuxCommandResult {
    match command {
        DemuxCommand::Seek { time_pos, response } => {
            state.generation = state.generation.saturating_add(1);
            state.last_packet_time = Some(time_pos.max(0.0));
            state.reconnect_failures = 0;
            state.io_interrupt.store(false, Ordering::SeqCst);
            state.replay_queue.clear();
            state.pending_resume_seek = None;

            let result = if let Some(replay) = state.cache.replay(time_pos) {
                state.drop_packets_before = Some(replay.resume_time);
                state.pending_resume_seek = Some(replay.resume_time);
                state.replay_queue = replay.packets.into();
                crate::emit_event(crate::log::event(
                    crate::log::LogLevel::Info,
                    format!(
                        "demux cache seek hit: target={:.3}s packets={} resume={:.3}s",
                        time_pos,
                        state.replay_queue.len(),
                        replay.resume_time
                    ),
                ));
                Ok(())
            } else {
                state.drop_packets_before = Some(time_pos.max(0.0));
                state.cache.note_seek_miss(time_pos);
                seek_demux_input(state, time_pos)
                    .map_err(|err| PlayerError::Backend(format!("ffmpeg seek failed: {err}")))
            };
            let _ = response.send(SeekAck {
                generation: state.generation,
                result,
            });
            DemuxCommandResult::Sought
        }
        DemuxCommand::Shutdown => DemuxCommandResult::Shutdown,
    }
}

fn update_demux_position(state: &mut DemuxState, packet: &Packet) {
    if let Some(timestamp) = packet.pts().or_else(|| packet.dts()) {
        let seconds = rational_seconds(timestamp, state.time_base);
        if seconds.is_finite() && seconds >= 0.0 {
            state.last_packet_time = Some(seconds);
        }
    }
}

fn should_drop_demux_packet(state: &mut DemuxState, packet: &Packet) -> bool {
    let Some(drop_before) = state.drop_packets_before else {
        return false;
    };
    let Some((start, end)) = packet_time_range(packet, state.time_base) else {
        state.drop_packets_before = None;
        return false;
    };
    if end + DEMUX_PACKET_DROP_TOLERANCE_SECONDS < drop_before {
        return true;
    }
    if start + DEMUX_PACKET_DROP_TOLERANCE_SECONDS >= drop_before || end >= drop_before {
        state.drop_packets_before = None;
    }
    false
}

fn packet_time_range(packet: &Packet, time_base: Rational) -> Option<(f64, f64)> {
    let start = packet
        .pts()
        .or_else(|| packet.dts())
        .map(|timestamp| rational_seconds(timestamp, time_base))?;
    let duration = packet.duration();
    let end = if duration > 0 {
        start + rational_seconds(duration, time_base).max(0.0)
    } else {
        start
    };
    Some((start, end.max(start)))
}

fn seek_demux_input(state: &mut DemuxState, time_pos: f64) -> Result<(), ffmpeg::Error> {
    let timestamp = seconds_to_ffmpeg_timestamp(time_pos);
    state.opened.input.seek(timestamp, ..timestamp)
}

fn should_reconnect_after_eof(state: &DemuxState) -> bool {
    should_reconnect_after_eof_values(
        state.source.is_network,
        state.last_packet_time,
        state.duration,
    )
}

fn should_reconnect_after_eof_values(
    is_network: bool,
    last_packet_time: Option<f64>,
    duration: Option<f64>,
) -> bool {
    if !is_network {
        return false;
    }
    match (last_packet_time, duration) {
        (Some(last), Some(duration)) => last + NETWORK_EOF_TOLERANCE_SECONDS < duration,
        (None, Some(duration)) => duration > NETWORK_EOF_TOLERANCE_SECONDS,
        (_, None) => false,
    }
}

fn is_controlled_demux_interrupt(err: &ffmpeg::Error) -> bool {
    matches!(err, ffmpeg::Error::Exit)
}

fn reconnect_demux(
    state: &mut DemuxState,
    commands: &Receiver<DemuxCommand>,
    interrupt: &Arc<AtomicBool>,
    reason: &str,
) -> DemuxReconnectResult {
    if !state.source.is_network {
        return DemuxReconnectResult::Failed(reason.to_string());
    }
    if state.reconnect_failures >= NETWORK_RECONNECT_ATTEMPTS {
        return DemuxReconnectResult::Failed(format!(
            "{reason}; network reconnect attempts exhausted"
        ));
    }

    while state.reconnect_failures < NETWORK_RECONNECT_ATTEMPTS {
        if interrupt.load(Ordering::SeqCst) {
            return DemuxReconnectResult::Shutdown;
        }

        let attempt = state.reconnect_failures + 1;
        let backoff = NETWORK_RECONNECT_BACKOFFS[state.reconnect_failures];
        crate::emit_event(crate::log::event(
            crate::log::LogLevel::Warn,
            format!(
                "{reason}; reconnecting network input attempt {attempt}/{NETWORK_RECONNECT_ATTEMPTS}"
            ),
        ));
        state.reconnect_failures += 1;

        match wait_before_reconnect(commands, interrupt, state, backoff) {
            DemuxReconnectDelay::Continue => {}
            DemuxReconnectDelay::Shutdown => return DemuxReconnectResult::Shutdown,
        }

        match reopen_demux_input(state, interrupt.clone()) {
            Ok(()) => {
                state.generation = state.generation.saturating_add(1);
                crate::emit_event(crate::log::event(
                    crate::log::LogLevel::Info,
                    "network input reconnected",
                ));
                return DemuxReconnectResult::Recovered;
            }
            Err(err) => {
                crate::emit_event(crate::log::event(
                    crate::log::LogLevel::Warn,
                    format!("network input reconnect failed: {err}"),
                ));
            }
        }
    }

    DemuxReconnectResult::Failed(format!("{reason}; network reconnect attempts exhausted"))
}

fn reopen_demux_input(state: &mut DemuxState, interrupt: Arc<AtomicBool>) -> PlayerResult<()> {
    let opened = open_input(&state.source.url, interrupt, state.io_interrupt.clone())?;
    let (stream_index, time_base) = {
        let stream = select_audio_stream(&opened.input, state.source.audio_track_id)?;
        (stream.index(), stream.time_base())
    };

    state.duration = input_duration(&opened.input, stream_index).or(state.duration);
    state.opened = opened;
    state.stream_index = stream_index;
    state.time_base = time_base;

    if let Some(time_pos) = state.last_packet_time {
        let reconnect_pos = (time_pos - NETWORK_RECONNECT_OVERLAP_SECONDS).max(0.0);
        let timestamp = seconds_to_ffmpeg_timestamp(reconnect_pos);
        state
            .opened
            .input
            .seek(timestamp, ..timestamp)
            .map_err(|err| {
                PlayerError::Backend(format!("ffmpeg seek after network reconnect failed: {err}"))
            })?;
    }

    Ok(())
}

fn wait_before_reconnect(
    commands: &Receiver<DemuxCommand>,
    interrupt: &Arc<AtomicBool>,
    state: &mut DemuxState,
    timeout: Duration,
) -> DemuxReconnectDelay {
    let deadline = Instant::now() + timeout;
    loop {
        if interrupt.load(Ordering::SeqCst) {
            return DemuxReconnectDelay::Shutdown;
        }
        let now = Instant::now();
        if now >= deadline {
            return DemuxReconnectDelay::Continue;
        }
        let wait = deadline
            .saturating_duration_since(now)
            .min(PACKET_RECV_TIMEOUT);

        match commands.recv_timeout(wait) {
            Ok(DemuxCommand::Seek { time_pos, response }) => {
                state.generation = state.generation.saturating_add(1);
                state.last_packet_time = Some(time_pos.max(0.0));
                state.io_interrupt.store(false, Ordering::SeqCst);
                let _ = response.send(SeekAck {
                    generation: state.generation,
                    result: Ok(()),
                });
                return DemuxReconnectDelay::Continue;
            }
            Ok(DemuxCommand::Shutdown) => return DemuxReconnectDelay::Shutdown,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return DemuxReconnectDelay::Shutdown,
        }
    }
}

enum DemuxReconnectResult {
    Recovered,
    Failed(String),
    Shutdown,
}

enum DemuxReconnectDelay {
    Continue,
    Shutdown,
}

fn seconds_to_ffmpeg_timestamp(time_pos: f64) -> i64 {
    (time_pos.max(0.0) * FFMPEG_TIME_BASE).round() as i64
}

unsafe impl Send for FfmpegInterrupt {}

impl FfmpegInterrupt {
    fn new(shutdown: Arc<AtomicBool>, io_interrupt: Arc<AtomicBool>) -> Self {
        let opaque = Box::into_raw(Box::new(FfmpegInterruptState {
            shutdown,
            io_interrupt,
        }))
        .cast::<c_void>();
        Self {
            raw: ffmpeg::ffi::AVIOInterruptCB {
                callback: Some(ffmpeg_interrupt_callback),
                opaque,
            },
        }
    }
}

impl Drop for FfmpegInterrupt {
    fn drop(&mut self) {
        if !self.raw.opaque.is_null() {
            unsafe {
                drop(Box::from_raw(
                    self.raw.opaque.cast::<FfmpegInterruptState>(),
                ));
            }
            self.raw.opaque = ptr::null_mut();
        }
    }
}

struct FfmpegInterrupt {
    raw: ffmpeg::ffi::AVIOInterruptCB,
}

struct HttpAvioContext {
    context: *mut ffmpeg::ffi::AVIOContext,
    opaque: *mut HttpAvioOpaque,
}

struct HttpAvioOpaque {
    input: Mutex<HttpRangeInput>,
}

unsafe impl Send for HttpAvioContext {}

impl HttpAvioContext {
    fn new(input: HttpRangeInput) -> PlayerResult<Self> {
        let buffer = unsafe { ffmpeg::ffi::av_malloc(HTTP_AVIO_BUFFER_BYTES) }.cast::<u8>();
        if buffer.is_null() {
            return Err(PlayerError::Backend(
                "ffmpeg custom IO buffer allocation failed".to_string(),
            ));
        }

        let opaque = Box::into_raw(Box::new(HttpAvioOpaque {
            input: Mutex::new(input),
        }));
        let context = unsafe {
            ffmpeg::ffi::avio_alloc_context(
                buffer,
                HTTP_AVIO_BUFFER_BYTES as c_int,
                0,
                opaque.cast::<c_void>(),
                Some(http_avio_read_packet),
                None,
                Some(http_avio_seek),
            )
        };
        if context.is_null() {
            unsafe {
                ffmpeg::ffi::av_free(buffer.cast::<c_void>());
                drop(Box::from_raw(opaque));
            }
            return Err(PlayerError::Backend(
                "ffmpeg custom IO context allocation failed".to_string(),
            ));
        }

        Ok(Self { context, opaque })
    }
}

impl Drop for HttpAvioContext {
    fn drop(&mut self) {
        unsafe {
            if !self.context.is_null() {
                ffmpeg::ffi::avio_context_free(&mut self.context);
            }
            if !self.opaque.is_null() {
                drop(Box::from_raw(self.opaque));
                self.opaque = ptr::null_mut();
            }
        }
    }
}

unsafe extern "C" fn http_avio_read_packet(
    opaque: *mut c_void,
    buf: *mut u8,
    buf_size: c_int,
) -> c_int {
    if opaque.is_null() || buf.is_null() || buf_size <= 0 {
        return ffmpeg::ffi::AVERROR_EXTERNAL;
    }
    let opaque = unsafe { &*opaque.cast::<HttpAvioOpaque>() };
    let Ok(mut input) = opaque.input.lock() else {
        return ffmpeg::ffi::AVERROR_EXTERNAL;
    };
    let out = unsafe { std::slice::from_raw_parts_mut(buf, buf_size as usize) };
    match input.read(out) {
        Ok(size) if size > 0 => size as c_int,
        Ok(_) | Err(HttpRangeError::Eof) => ffmpeg::ffi::AVERROR_EOF,
        Err(HttpRangeError::Interrupted) => ffmpeg::ffi::AVERROR_EXIT,
        Err(HttpRangeError::Backend(message)) => {
            crate::emit_event(crate::log::event(
                crate::log::LogLevel::Warn,
                format!("http range read failed: {message}"),
            ));
            ffmpeg::ffi::AVERROR_EXTERNAL
        }
    }
}

unsafe extern "C" fn http_avio_seek(opaque: *mut c_void, offset: i64, whence: c_int) -> i64 {
    if opaque.is_null() {
        return i64::from(ffmpeg::ffi::AVERROR_EXTERNAL);
    }
    let opaque = unsafe { &*opaque.cast::<HttpAvioOpaque>() };
    let Ok(mut input) = opaque.input.lock() else {
        return i64::from(ffmpeg::ffi::AVERROR_EXTERNAL);
    };
    if whence & ffmpeg::ffi::AVSEEK_SIZE != 0 {
        return input.len() as i64;
    }
    match input.seek(offset, whence) {
        Ok(position) => position,
        Err(HttpRangeError::Interrupted) => i64::from(ffmpeg::ffi::AVERROR_EXIT),
        Err(HttpRangeError::Eof) => input.len() as i64,
        Err(HttpRangeError::Backend(message)) => {
            crate::emit_event(crate::log::event(
                crate::log::LogLevel::Warn,
                format!("http range seek failed: {message}"),
            ));
            i64::from(ffmpeg::ffi::AVERROR_EXTERNAL)
        }
    }
}

struct FfmpegInterruptState {
    shutdown: Arc<AtomicBool>,
    io_interrupt: Arc<AtomicBool>,
}

extern "C" fn ffmpeg_interrupt_callback(opaque: *mut c_void) -> c_int {
    if opaque.is_null() {
        return 0;
    }
    let state = unsafe { &*opaque.cast::<FfmpegInterruptState>() };
    if state.shutdown.load(Ordering::SeqCst) || state.io_interrupt.load(Ordering::SeqCst) {
        1
    } else {
        0
    }
}

fn open_input(
    url: &str,
    interrupt: Arc<AtomicBool>,
    io_interrupt: Arc<AtomicBool>,
) -> PlayerResult<OpenedInput> {
    if is_http_url(url) {
        match open_http_range_input(url, interrupt.clone(), io_interrupt.clone()) {
            Ok(opened) => return Ok(opened),
            Err(err) => {
                crate::emit_event(crate::log::event(
                    crate::log::LogLevel::Warn,
                    format!("http range input unavailable, falling back to ffmpeg protocol: {err}"),
                ));
            }
        }
    }

    let interrupt_callback = FfmpegInterrupt::new(interrupt, io_interrupt);
    let path = CString::new(url)
        .map_err(|_| PlayerError::InvalidInput("url cannot contain NUL bytes".to_string()))?;
    let mut options = unsafe { input_options(url).disown() };

    unsafe {
        let mut input = ffmpeg::ffi::avformat_alloc_context();
        if input.is_null() {
            ffmpeg::Dictionary::own(options);
            return Err(PlayerError::Backend(
                "ffmpeg input context allocation failed".to_string(),
            ));
        }

        (*input).interrupt_callback = interrupt_callback.raw;
        let open_result = ffmpeg::ffi::avformat_open_input(
            &mut input,
            path.as_ptr(),
            ptr::null_mut(),
            &mut options,
        );
        ffmpeg::Dictionary::own(options);

        if open_result < 0 {
            if !input.is_null() {
                ffmpeg::ffi::avformat_close_input(&mut input);
            }
            return Err(PlayerError::Backend(format!(
                "ffmpeg open input failed: {}",
                ffmpeg::Error::from(open_result)
            )));
        }

        let stream_result = ffmpeg::ffi::avformat_find_stream_info(input, ptr::null_mut());
        if stream_result < 0 {
            ffmpeg::ffi::avformat_close_input(&mut input);
            return Err(PlayerError::Backend(format!(
                "ffmpeg stream info failed: {}",
                ffmpeg::Error::from(stream_result)
            )));
        }

        Ok(OpenedInput {
            input: format::context::Input::wrap(input),
            _custom_io: None,
            _interrupt: interrupt_callback,
        })
    }
}

fn open_http_range_input(
    url: &str,
    interrupt: Arc<AtomicBool>,
    io_interrupt: Arc<AtomicBool>,
) -> PlayerResult<OpenedInput> {
    let range_input = HttpRangeInput::open(url, interrupt.clone(), io_interrupt.clone())?;
    let content_length = range_input.len();
    let interrupt_callback = FfmpegInterrupt::new(interrupt, io_interrupt);
    let custom_io = HttpAvioContext::new(range_input)?;
    let mut options = unsafe { custom_input_options().disown() };

    unsafe {
        let mut input = ffmpeg::ffi::avformat_alloc_context();
        if input.is_null() {
            ffmpeg::Dictionary::own(options);
            return Err(PlayerError::Backend(
                "ffmpeg input context allocation failed".to_string(),
            ));
        }

        (*input).interrupt_callback = interrupt_callback.raw;
        (*input).pb = custom_io.context;
        (*input).flags |= ffmpeg::ffi::AVFMT_FLAG_CUSTOM_IO as c_int;

        let open_result = ffmpeg::ffi::avformat_open_input(
            &mut input,
            ptr::null(),
            ptr::null_mut(),
            &mut options,
        );
        ffmpeg::Dictionary::own(options);

        if open_result < 0 {
            if !input.is_null() {
                ffmpeg::ffi::avformat_close_input(&mut input);
            }
            return Err(PlayerError::Backend(format!(
                "ffmpeg open custom http range input failed: {}",
                ffmpeg::Error::from(open_result)
            )));
        }

        let stream_result = ffmpeg::ffi::avformat_find_stream_info(input, ptr::null_mut());
        if stream_result < 0 {
            ffmpeg::ffi::avformat_close_input(&mut input);
            return Err(PlayerError::Backend(format!(
                "ffmpeg custom http range stream info failed: {}",
                ffmpeg::Error::from(stream_result)
            )));
        }

        crate::emit_event(crate::log::event(
            crate::log::LogLevel::Info,
            format!("http range input enabled: length={content_length} bytes"),
        ));
        Ok(OpenedInput {
            input: format::context::Input::wrap(input),
            _custom_io: Some(custom_io),
            _interrupt: interrupt_callback,
        })
    }
}

fn input_options(url: &str) -> ffmpeg::Dictionary<'_> {
    let mut options = ffmpeg::Dictionary::new();
    if is_network_url(url) {
        options.set("rw_timeout", NETWORK_RW_TIMEOUT_US);
        options.set("timeout", NETWORK_RW_TIMEOUT_US);
        options.set("probesize", NETWORK_PROBE_SIZE);
        options.set("analyzeduration", NETWORK_ANALYZE_DURATION_US);
        options.set("seekable", "1");
        options.set("reconnect", "1");
        options.set("reconnect_streamed", "1");
        options.set("reconnect_on_network_error", "1");
        options.set("reconnect_on_http_error", "408,429,500,502,503,504");
        options.set("reconnect_delay_max", NETWORK_RECONNECT_DELAY_MAX_SECONDS);
        options.set("multiple_requests", "1");
    }
    options
}

fn custom_input_options() -> ffmpeg::Dictionary<'static> {
    let mut options = ffmpeg::Dictionary::new();
    options.set("probesize", NETWORK_PROBE_SIZE);
    options.set("analyzeduration", NETWORK_ANALYZE_DURATION_US);
    options
}

fn is_network_url(url: &str) -> bool {
    let Some((scheme, _)) = url.split_once(':') else {
        return false;
    };
    matches!(
        scheme.to_ascii_lowercase().as_str(),
        "http" | "https" | "tcp" | "tls"
    )
}

fn is_http_url(url: &str) -> bool {
    let Some((scheme, _)) = url.split_once(':') else {
        return false;
    };
    matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https")
}

fn input_duration(input: &format::context::Input, stream_index: usize) -> Option<f64> {
    let mut candidates = Vec::new();

    push_duration_candidate(
        &mut candidates,
        "format",
        format_duration_seconds(input),
        false,
    );

    if let Some(stream) = input.stream(stream_index) {
        push_duration_candidate(
            &mut candidates,
            "stream",
            stream_duration_seconds(&stream),
            false,
        );
        push_duration_candidate(
            &mut candidates,
            "stream-frames",
            stream_frame_duration_seconds(&stream),
            false,
        );
        push_duration_candidate(
            &mut candidates,
            "stream-bitrate",
            stream_bitrate_duration_seconds(input, &stream),
            true,
        );
    }

    push_duration_candidate(
        &mut candidates,
        "bitrate",
        bitrate_duration_seconds(input),
        true,
    );

    choose_duration_candidate(&candidates)
}

fn format_duration_seconds(input: &format::context::Input) -> Option<f64> {
    let duration = input.duration();
    (duration > 0).then_some(duration as f64 / FFMPEG_TIME_BASE)
}

fn stream_duration_seconds(stream: &format::stream::Stream<'_>) -> Option<f64> {
    let duration = stream.duration();
    (duration > 0).then_some(rational_seconds(duration, stream.time_base()))
}

fn stream_frame_duration_seconds(stream: &format::stream::Stream<'_>) -> Option<f64> {
    let frames = stream.frames();
    if frames <= 0 {
        return None;
    }
    let parameters = stream.parameters();
    let (sample_rate, frame_size) = unsafe {
        let params = parameters.as_ptr();
        ((*params).sample_rate, (*params).frame_size)
    };
    if sample_rate <= 0 || frame_size <= 0 {
        return None;
    }
    Some(frames as f64 * frame_size as f64 / sample_rate as f64)
}

fn bitrate_duration_seconds(input: &format::context::Input) -> Option<f64> {
    let bit_rate = input.bit_rate();
    duration_from_size_and_bitrate(input, bit_rate)
}

fn stream_bitrate_duration_seconds(
    input: &format::context::Input,
    stream: &format::stream::Stream<'_>,
) -> Option<f64> {
    let parameters = stream.parameters();
    let bit_rate = unsafe { (*parameters.as_ptr()).bit_rate };
    duration_from_size_and_bitrate(input, bit_rate)
}

fn duration_from_size_and_bitrate(input: &format::context::Input, bit_rate: i64) -> Option<f64> {
    if bit_rate <= 0 {
        return None;
    }
    let size = input_size_bytes(input)?;
    if size <= 0 {
        return None;
    }
    Some(size as f64 * 8.0 / bit_rate as f64)
}

fn input_size_bytes(input: &format::context::Input) -> Option<i64> {
    unsafe {
        let context = input.as_ptr();
        if context.is_null() || (*context).pb.is_null() {
            return None;
        }
        let size = ffmpeg::ffi::avio_size((*context).pb);
        (size > 0).then_some(size)
    }
}

fn push_duration_candidate(
    candidates: &mut Vec<DurationCandidate>,
    source: &'static str,
    seconds: Option<f64>,
    bitrate_estimate: bool,
) {
    let Some(seconds) = seconds else {
        return;
    };
    if !seconds.is_finite() || seconds <= 0.0 {
        return;
    }
    candidates.push(DurationCandidate {
        source,
        seconds,
        bitrate_estimate,
    });
}

fn choose_duration_candidate(candidates: &[DurationCandidate]) -> Option<f64> {
    let best = candidates
        .iter()
        .filter(|candidate| !candidate.bitrate_estimate)
        .max_by(|a, b| a.seconds.total_cmp(&b.seconds))
        .copied()
        .or_else(|| {
            candidates
                .iter()
                .filter(|candidate| candidate.bitrate_estimate)
                .max_by(|a, b| a.seconds.total_cmp(&b.seconds))
                .copied()
        });

    let best = best?;
    log_duration_candidates(candidates, best);
    Some(best.seconds)
}

fn log_duration_candidates(candidates: &[DurationCandidate], selected: DurationCandidate) {
    if candidates.len() <= 1 {
        return;
    }
    let shortest = candidates
        .iter()
        .map(|candidate| candidate.seconds)
        .fold(f64::INFINITY, f64::min);
    let longest = candidates
        .iter()
        .map(|candidate| candidate.seconds)
        .fold(0.0, f64::max);
    let diff = longest - shortest;
    if diff < DURATION_DISAGREEMENT_LOG_SECONDS
        || diff / longest.max(1.0) < DURATION_DISAGREEMENT_LOG_RATIO
    {
        return;
    }
    let candidates = candidates
        .iter()
        .map(|candidate| format!("{}={:.3}", candidate.source, candidate.seconds))
        .collect::<Vec<_>>()
        .join(" ");
    crate::emit_event(crate::log::event(
        crate::log::LogLevel::Info,
        format!(
            "duration candidates: selected={}({:.3}s) {candidates}",
            selected.source, selected.seconds
        ),
    ));
}

fn is_recoverable_decode_error(err: &ffmpeg::Error) -> bool {
    matches!(err, ffmpeg::Error::InvalidData)
}

fn is_resampler_flush_format_change(err: &ffmpeg::Error) -> bool {
    matches!(
        err,
        ffmpeg::Error::InputChanged | ffmpeg::Error::OutputChanged
    )
}

fn init_ffmpeg() -> PlayerResult<()> {
    FFMPEG_INIT
        .get_or_init(|| {
            let result = ffmpeg::init()
                .map_err(|err| PlayerError::Backend(format!("ffmpeg init failed: {err}")));
            if result.is_ok() {
                format::network::init();
            }
            result
        })
        .clone()
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::{AudioFormat, DecoderBackend, FfmpegDecoder};
    use ffmpeg_next as ffmpeg;
    use std::fs;
    use std::io::Write;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    #[test]
    fn decodes_pcm_wav_to_target_format() {
        let path = std::env::temp_dir().join(format!(
            "echo-ffmpeg-player-test-{}.wav",
            std::process::id()
        ));
        write_test_wav(&path);

        let mut decoder = FfmpegDecoder::new(
            AudioFormat {
                sample_rate: 48_000,
                channels: 2,
            },
            Arc::new(AtomicBool::new(false)),
        )
        .expect("ffmpeg decoder should initialize");
        let format = decoder
            .load(path.to_str().expect("temp path should be utf-8"), 0)
            .expect("wav should load");
        assert_eq!(format.sample_rate, 48_000);
        assert_eq!(format.channels, 2);
        assert!(!decoder.codec_name().is_empty());
        assert_eq!(
            decoder
                .track_list()
                .iter()
                .filter(|track| track.r#type == "audio")
                .count(),
            1
        );

        let chunk = match decoder.read_chunk().expect("decode should succeed") {
            super::DecodeReadResult::Chunk(chunk) => chunk,
            other => panic!("wav should produce a chunk, got {other:?}"),
        };
        assert_eq!(chunk.format.sample_rate, 48_000);
        assert_eq!(chunk.format.channels, 2);
        assert!(!chunk.samples.is_empty());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn network_input_options_enable_http_reconnect() {
        assert!(super::is_network_url("https://example.test/audio.flac"));
        assert!(super::is_network_url("HTTP://example.test/audio.flac"));
        assert!(!super::is_network_url("/Users/me/Music/audio.flac"));
        assert!(!super::is_network_url("file:///Users/me/Music/audio.flac"));

        let network = super::input_options("https://example.test/audio.flac");
        assert_eq!(network.get("reconnect"), Some("1"));
        assert_eq!(network.get("reconnect_streamed"), Some("1"));
        assert_eq!(
            network.get("rw_timeout"),
            Some(super::NETWORK_RW_TIMEOUT_US)
        );
        assert_eq!(network.get("seekable"), Some("1"));
        assert_eq!(network.get("probesize"), Some(super::NETWORK_PROBE_SIZE));
        assert_eq!(
            network.get("analyzeduration"),
            Some(super::NETWORK_ANALYZE_DURATION_US)
        );

        let local = super::input_options("/Users/me/Music/audio.flac");
        assert!(local.get("reconnect").is_none());
        assert!(local.get("rw_timeout").is_none());
    }

    #[test]
    fn unexpected_network_eof_reconnects_before_media_end() {
        assert!(super::should_reconnect_after_eof_values(
            true,
            Some(10.0),
            Some(60.0)
        ));
        assert!(!super::should_reconnect_after_eof_values(
            true,
            Some(59.0),
            Some(60.0)
        ));
        assert!(!super::should_reconnect_after_eof_values(
            false,
            Some(10.0),
            Some(60.0)
        ));
        assert!(!super::should_reconnect_after_eof_values(true, None, None));
    }

    #[test]
    fn controlled_demux_interrupt_is_not_a_network_failure() {
        assert!(super::is_controlled_demux_interrupt(&ffmpeg::Error::Exit));
        assert!(!super::is_controlled_demux_interrupt(
            &ffmpeg::Error::External
        ));
    }

    #[test]
    fn duration_selection_prefers_longer_stream_candidate() {
        let candidates = [
            super::DurationCandidate {
                source: "format",
                seconds: 120.0,
                bitrate_estimate: false,
            },
            super::DurationCandidate {
                source: "stream",
                seconds: 124.0,
                bitrate_estimate: false,
            },
        ];

        assert_eq!(super::choose_duration_candidate(&candidates), Some(124.0));
    }

    #[test]
    fn duration_selection_uses_bitrate_only_as_fallback() {
        let small_diff = [
            super::DurationCandidate {
                source: "format",
                seconds: 120.0,
                bitrate_estimate: false,
            },
            super::DurationCandidate {
                source: "bitrate",
                seconds: 121.0,
                bitrate_estimate: true,
            },
        ];
        assert_eq!(super::choose_duration_candidate(&small_diff), Some(120.0));

        let clear_diff_still_prefers_container = [
            super::DurationCandidate {
                source: "format",
                seconds: 120.0,
                bitrate_estimate: false,
            },
            super::DurationCandidate {
                source: "bitrate",
                seconds: 128.0,
                bitrate_estimate: true,
            },
        ];
        assert_eq!(
            super::choose_duration_candidate(&clear_diff_still_prefers_container),
            Some(120.0)
        );

        let bitrate_only = [super::DurationCandidate {
            source: "bitrate",
            seconds: 128.0,
            bitrate_estimate: true,
        }];
        assert_eq!(super::choose_duration_candidate(&bitrate_only), Some(128.0));
    }

    #[test]
    fn demux_packet_cache_replays_contiguous_packets_near_seek_target() {
        let mut cache = super::DemuxPacketCache::default();
        let time_base = ffmpeg::Rational(1, 1000);
        for pts in [1_000, 1_100, 1_200, 1_300, 1_400] {
            cache.push(time_base, &test_packet(pts, 100));
        }

        let replay = cache
            .replay(1.15)
            .expect("cache should cover the seek target");
        assert!(!replay.packets.is_empty());
        assert!(replay.resume_time >= 1.35);
    }

    #[test]
    fn demux_packet_cache_misses_when_target_is_outside_cached_range() {
        let mut cache = super::DemuxPacketCache::default();
        let time_base = ffmpeg::Rational(1, 1000);
        cache.push(time_base, &test_packet(1_000, 100));
        cache.push(time_base, &test_packet(1_100, 100));

        assert!(cache.replay(5.0).is_none());
    }

    #[test]
    fn invalid_decode_data_is_recoverable() {
        assert!(super::is_recoverable_decode_error(
            &ffmpeg::Error::InvalidData
        ));
        assert!(!super::is_recoverable_decode_error(&ffmpeg::Error::Eof));
    }

    #[test]
    fn resampler_flush_format_changes_are_nonfatal() {
        assert!(super::is_resampler_flush_format_change(
            &ffmpeg::Error::OutputChanged
        ));
        assert!(super::is_resampler_flush_format_change(
            &ffmpeg::Error::InputChanged
        ));
        assert!(!super::is_resampler_flush_format_change(
            &ffmpeg::Error::InvalidData
        ));
    }

    fn write_test_wav(path: &std::path::Path) {
        let sample_rate = 8_000u32;
        let channels = 1u16;
        let bits_per_sample = 16u16;
        let samples = 800u32;
        let byte_rate = sample_rate * u32::from(channels) * u32::from(bits_per_sample) / 8;
        let block_align = channels * bits_per_sample / 8;
        let data_size = samples * u32::from(block_align);

        let mut file = fs::File::create(path).expect("temp wav should be writable");
        file.write_all(b"RIFF").unwrap();
        file.write_all(&(36 + data_size).to_le_bytes()).unwrap();
        file.write_all(b"WAVEfmt ").unwrap();
        file.write_all(&16u32.to_le_bytes()).unwrap();
        file.write_all(&1u16.to_le_bytes()).unwrap();
        file.write_all(&channels.to_le_bytes()).unwrap();
        file.write_all(&sample_rate.to_le_bytes()).unwrap();
        file.write_all(&byte_rate.to_le_bytes()).unwrap();
        file.write_all(&block_align.to_le_bytes()).unwrap();
        file.write_all(&bits_per_sample.to_le_bytes()).unwrap();
        file.write_all(b"data").unwrap();
        file.write_all(&data_size.to_le_bytes()).unwrap();

        for index in 0..samples {
            let phase = index as f32 / sample_rate as f32 * 440.0 * std::f32::consts::TAU;
            let sample = (phase.sin() * i16::MAX as f32 * 0.25).round() as i16;
            file.write_all(&sample.to_le_bytes()).unwrap();
        }
    }

    fn test_packet(pts_ms: i64, duration_ms: i64) -> ffmpeg::Packet {
        let mut packet = ffmpeg::Packet::copy(&[0x42, 0x24]);
        packet.set_pts(Some(pts_ms));
        packet.set_dts(Some(pts_ms));
        packet.set_duration(duration_ms);
        packet
    }
}

fn select_audio_stream<'a>(
    input: &'a format::context::Input,
    audio_track_id: i64,
) -> PlayerResult<format::stream::Stream<'a>> {
    if audio_track_id > 0 {
        let mut audio_order = 0i64;
        for stream in input.streams() {
            let is_audio = stream.parameters().medium() == media::Type::Audio;
            if is_audio {
                audio_order += 1;
            }
            if is_audio
                && (audio_order == audio_track_id
                    || i64::from(stream.id()) == audio_track_id
                    || stream.index() as i64 == audio_track_id)
            {
                return Ok(stream);
            }
        }
    }

    input
        .streams()
        .best(media::Type::Audio)
        .ok_or_else(|| PlayerError::Backend("no audio stream found".to_string()))
}

fn collect_track_info(input: &format::context::Input) -> Vec<TrackInfo> {
    let mut audio_order = 0i64;
    input
        .streams()
        .map(|stream| {
            let parameters = stream.parameters();
            let medium = parameters.medium();
            let metadata = stream.metadata();
            let title = metadata.get("title").map(str::to_string);
            let lang = metadata
                .get("lang")
                .or_else(|| metadata.get("language"))
                .map(str::to_string);

            let id = if medium == media::Type::Audio {
                audio_order += 1;
                audio_order
            } else {
                stream.index() as i64 + 1
            };

            TrackInfo {
                id,
                r#type: track_type_name(medium).to_string(),
                codec: parameters.id().name().to_string(),
                title,
                lang,
            }
        })
        .collect()
}

fn track_type_name(media_type: media::Type) -> &'static str {
    match media_type {
        media::Type::Audio => "audio",
        media::Type::Video => "video",
        media::Type::Subtitle => "sub",
        media::Type::Data => "data",
        media::Type::Attachment => "attachment",
        _ => "unknown",
    }
}

fn rational_seconds(value: i64, time_base: Rational) -> f64 {
    value as f64 * f64::from(time_base)
}

fn actual_frame_layout(frame: &frame::Audio) -> ChannelLayout {
    let layout = frame.channel_layout();
    if layout.is_empty() {
        ChannelLayout::default(i32::from(frame.channels()))
    } else {
        layout
    }
}
