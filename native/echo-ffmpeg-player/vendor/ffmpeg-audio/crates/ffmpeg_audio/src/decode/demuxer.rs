use std::{
    collections::HashMap,
    ffi::CStr,
    ptr,
    sync::{
        Arc,
        Condvar,
        Mutex,
    },
    thread,
    time::Duration,
};

use crate::{
    AudioCover,
    AudioError,
    AudioStreamInfo,
    FfErrorExt as _,
    IoContext,
    Result,
    TimeBase,
    sys,
};

pub struct Demuxer {
    ctx: *mut sys::AVFormatContext,
    packet: *mut sys::AVPacket,
    audio_stream_idx: usize,
    _io_ctx: IoContext,
}

unsafe impl Send for Demuxer {}

#[derive(Clone, Copy, Debug)]
pub struct PacketCacheOptions {
    pub max_bytes: usize,
    pub back_bytes: usize,
    pub max_duration: Duration,
}

impl PacketCacheOptions {
    pub fn new(max_bytes: usize, back_bytes: usize, max_duration: Duration) -> Self {
        let max_bytes = max_bytes.max(1);
        Self {
            max_bytes,
            back_bytes: back_bytes.min(max_bytes),
            max_duration,
        }
    }
}

impl Default for PacketCacheOptions {
    fn default() -> Self {
        Self::new(8 * 1024 * 1024, 2 * 1024 * 1024, Duration::from_secs(30))
    }
}

pub struct CachedPacket {
    packet: *mut sys::AVPacket,
    pts: Option<Duration>,
    end: Option<Duration>,
    size: usize,
}

unsafe impl Send for CachedPacket {}

impl CachedPacket {
    pub const fn as_ptr(&self) -> *const sys::AVPacket {
        self.packet
    }

    fn clone_packet(&self) -> Result<Self> {
        unsafe {
            let packet = sys::av_packet_clone(self.packet);
            if packet.is_null() {
                return Err(AudioError::from_ffmpeg(sys::AVERROR_ENOMEM));
            }
            Ok(Self {
                packet,
                pts: self.pts,
                end: self.end,
                size: self.size,
            })
        }
    }
}

impl Drop for CachedPacket {
    fn drop(&mut self) {
        unsafe {
            if !self.packet.is_null() {
                sys::av_packet_free(&raw mut self.packet);
            }
        }
    }
}

struct PacketCacheState {
    packets: Vec<CachedPacket>,
    base_index: u64,
    read_index: u64,
    total_bytes: usize,
    eof: bool,
    stop: bool,
    pending_seek: Option<Duration>,
    error: Option<AudioError>,
    epoch: u64,
}

struct SharedPacketCache {
    state: Mutex<PacketCacheState>,
    changed: Condvar,
}

pub struct PacketCache {
    shared: Arc<SharedPacketCache>,
    _worker: thread::JoinHandle<()>,
}

impl Demuxer {
    pub fn new_with_audio_stream(
        io_ctx: IoContext,
        audio_stream_ordinal: Option<usize>,
    ) -> Result<Self> {
        unsafe {
            let mut ctx = sys::avformat_alloc_context();
            if ctx.is_null() {
                return Err(AudioError::from_ffmpeg(sys::AVERROR_ENOMEM));
            }

            (*ctx).pb = io_ctx.ctx;

            (*ctx).flags |= sys::AVFMT_FLAG_CUSTOM_IO.cast_signed();

            let ret = sys::avformat_open_input(
                &raw mut ctx,
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
            );
            if ret < 0 {
                return Err(AudioError::from_ffmpeg(ret));
            }

            let ret = sys::avformat_find_stream_info(ctx, ptr::null_mut());
            if ret < 0 {
                sys::avformat_close_input(&raw mut ctx);
                return Err(AudioError::from_ffmpeg(ret));
            }

            let stream_idx = if let Some(audio_stream_ordinal) = audio_stream_ordinal {
                let mut seen_audio_streams = 0usize;
                let mut selected_stream = None;
                for i in 0..(*ctx).nb_streams {
                    let stream_ptr = *(*ctx).streams.add(i as usize);
                    if (*(*stream_ptr).codecpar).codec_type
                        != sys::AVMediaType_AVMEDIA_TYPE_AUDIO
                    {
                        continue;
                    }
                    if seen_audio_streams == audio_stream_ordinal {
                        selected_stream = Some(i as i32);
                        break;
                    }
                    seen_audio_streams += 1;
                }
                selected_stream.unwrap_or(-1)
            } else {
                sys::av_find_best_stream(
                    ctx,
                    sys::AVMediaType_AVMEDIA_TYPE_AUDIO,
                    -1,
                    -1,
                    ptr::null_mut(),
                    0,
                )
            };

            if stream_idx < 0 {
                sys::avformat_close_input(&raw mut ctx);
                return Err(AudioError::InvalidParameter(
                    "requested audio stream was not found".to_string(),
                ));
            }

            for i in 0..(*ctx).nb_streams {
                let stream_ptr = *(*ctx).streams.add(i as usize);
                if i as i32 != stream_idx {
                    (*stream_ptr).discard = sys::AVDiscard_AVDISCARD_ALL;
                }
            }

            let packet = sys::av_packet_alloc();
            if packet.is_null() {
                sys::avformat_close_input(&raw mut ctx);
                return Err(AudioError::from_ffmpeg(sys::AVERROR_ENOMEM));
            }

            Ok(Self {
                ctx,
                packet,
                audio_stream_idx: stream_idx as usize,
                _io_ctx: io_ctx,
            })
        }
    }

    pub fn stream_codec_params(&self) -> *mut sys::AVCodecParameters {
        unsafe {
            let stream_ptr = *(*self.ctx).streams.add(self.audio_stream_idx);
            (*stream_ptr).codecpar
        }
    }

    pub fn read_packet(&mut self) -> Result<Option<*mut sys::AVPacket>> {
        loop {
            unsafe {
                sys::av_packet_unref(self.packet);

                if sys::av_read_frame(self.ctx, self.packet)
                    .into_ff_opt()?
                    .is_none()
                {
                    return Ok(None);
                }

                if (*self.packet).stream_index == self.audio_stream_idx as i32 {
                    return Ok(Some(self.packet));
                }
            }
        }
    }

    fn read_cached_packet(&mut self, time_base: TimeBase) -> Result<Option<CachedPacket>> {
        let Some(packet) = self.read_packet()? else {
            return Ok(None);
        };
        unsafe {
            let cloned = sys::av_packet_clone(packet);
            if cloned.is_null() {
                return Err(AudioError::from_ffmpeg(sys::AVERROR_ENOMEM));
            }
            let pts = packet_pts(packet, time_base);
            let end = packet_end(packet, time_base).or(pts);
            let size = (*packet).size.max(0) as usize;
            Ok(Some(CachedPacket {
                packet: cloned,
                pts,
                end,
                size,
            }))
        }
    }

    pub fn time_base(&self) -> Result<TimeBase> {
        unsafe {
            if self.audio_stream_idx >= (*self.ctx).nb_streams as usize {
                return Err(AudioError::InvalidParameter(
                    "Audio stream index out of bounds".to_string(),
                ));
            }

            let stream = *(*self.ctx).streams.add(self.audio_stream_idx);
            let raw_tb = (*stream).time_base;

            TimeBase::try_new(raw_tb)
        }
    }

    /// Returns the raw stream PTS corresponding to the public timeline origin.
    pub fn timeline_origin_pts(&self) -> i64 {
        unsafe {
            let stream_ptr = *(*self.ctx).streams.add(self.audio_stream_idx);
            let start_time = (*stream_ptr).start_time;
            if start_time == sys::AV_NOPTS_VALUE {
                0
            } else {
                start_time.max(0)
            }
        }
    }

    pub fn seek_to(&mut self, target: Duration) -> Result<()> {
        unsafe {
            let stream_ptr = *(*self.ctx).streams.add(self.audio_stream_idx);
            let time_base = (*stream_ptr).time_base;

            let target_us = i64::try_from(target.as_micros()).unwrap_or(i64::MAX);

            let mut pts = sys::av_rescale_q(target_us, sys::MICROSECONDS_Q, time_base);

            pts = pts.saturating_add(self.timeline_origin_pts());

            let min_pts = i64::MIN;
            let max_pts = pts;

            let ret = sys::avformat_seek_file(
                self.ctx,
                self.audio_stream_idx as i32,
                min_pts,
                pts,
                max_pts,
                sys::AVSEEK_FLAG_BACKWARD.cast_signed(),
            );

            if ret < 0 {
                return Err(AudioError::from_ffmpeg(ret));
            }

            Ok(())
        }
    }

    pub fn metadata(&self) -> HashMap<String, String> {
        let mut map = HashMap::new();
        unsafe {
            extract_dict((*self.ctx).metadata, &mut map);

            let stream_ptr = *(*self.ctx).streams.add(self.audio_stream_idx);
            extract_dict((*stream_ptr).metadata, &mut map);
        }
        map
    }

    pub fn audio_streams(&self) -> Vec<AudioStreamInfo> {
        unsafe {
            let mut streams = Vec::new();
            for i in 0..(*self.ctx).nb_streams {
                let stream_ptr = *(*self.ctx).streams.add(i as usize);
                if stream_ptr.is_null() || (*stream_ptr).codecpar.is_null() {
                    continue;
                }

                let codec_params = (*stream_ptr).codecpar;
                if (*codec_params).codec_type != sys::AVMediaType_AVMEDIA_TYPE_AUDIO {
                    continue;
                }

                let codec_name_ptr = sys::avcodec_get_name((*codec_params).codec_id);
                let codec_name = if codec_name_ptr.is_null() {
                    None
                } else {
                    Some(CStr::from_ptr(codec_name_ptr).to_string_lossy().into_owned())
                };

                let mut metadata = HashMap::new();
                extract_dict((*stream_ptr).metadata, &mut metadata);
                let title = metadata.get("title").cloned();
                let lang = metadata
                    .get("language")
                    .or_else(|| metadata.get("lang"))
                    .cloned();

                streams.push(AudioStreamInfo {
                    ordinal: streams.len(),
                    stream_index: i as usize,
                    selected: i as usize == self.audio_stream_idx,
                    codec_name,
                    title,
                    lang,
                });
            }
            streams
        }
    }

    pub fn cover(&self) -> Option<AudioCover> {
        unsafe {
            for i in 0..(*self.ctx).nb_streams {
                let stream_ptr = *(*self.ctx).streams.add(i as usize);
                if (*stream_ptr).codecpar.is_null() {
                    continue;
                }

                let is_video =
                    (*(*stream_ptr).codecpar).codec_type == sys::AVMediaType_AVMEDIA_TYPE_VIDEO;
                let is_attached_pic = ((*stream_ptr).disposition
                    & (sys::AV_DISPOSITION_ATTACHED_PIC.cast_signed()))
                    != 0;

                if is_video && is_attached_pic {
                    let pkt = &(*stream_ptr).attached_pic;
                    if pkt.data.is_null() || pkt.size <= 0 {
                        continue;
                    }

                    let data = std::slice::from_raw_parts(pkt.data, pkt.size as usize).to_vec();

                    let codec_id = (*(*stream_ptr).codecpar).codec_id;
                    let desc = sys::avcodec_descriptor_get(codec_id);
                    let mime_type = if !desc.is_null() && !(*desc).mime_types.is_null() {
                        let first = *(*desc).mime_types;
                        if first.is_null() {
                            None
                        } else {
                            Some(CStr::from_ptr(first).to_string_lossy().into_owned())
                        }
                    } else {
                        None
                    };

                    return Some(AudioCover { data, mime_type });
                }
            }

            None
        }
    }

    pub fn bit_rate(&self) -> i64 {
        unsafe { (*self.ctx).bit_rate }
    }

    pub fn duration(&self) -> Option<Duration> {
        unsafe {
            let stream_ptr = *(*self.ctx).streams.add(self.audio_stream_idx);
            let stream_duration = (*stream_ptr).duration;

            if stream_duration >= 0 && stream_duration != sys::AV_NOPTS_VALUE {
                let time_base = (*stream_ptr).time_base;

                let duration_us =
                    sys::av_rescale_q(stream_duration, time_base, sys::MICROSECONDS_Q);

                if duration_us >= 0 {
                    return Some(Duration::from_micros(duration_us.cast_unsigned()));
                }
            }

            let ctx_duration = (*self.ctx).duration;
            if ctx_duration >= 0 && ctx_duration != sys::AV_NOPTS_VALUE {
                return Some(Duration::from_micros(ctx_duration.cast_unsigned()));
            }

            None
        }
    }
}

impl PacketCache {
    pub fn new(demuxer: Demuxer, time_base: TimeBase, options: PacketCacheOptions) -> Self {
        let shared = Arc::new(SharedPacketCache {
            state: Mutex::new(PacketCacheState {
                packets: Vec::new(),
                base_index: 0,
                read_index: 0,
                total_bytes: 0,
                eof: false,
                stop: false,
                pending_seek: None,
                error: None,
                epoch: 0,
            }),
            changed: Condvar::new(),
        });
        let worker_shared = shared.clone();
        let worker = thread::Builder::new()
            .name("ffmpeg-audio-packet-cache".to_string())
            .spawn(move || run_packet_cache_worker(demuxer, time_base, options, worker_shared))
            .expect("failed to spawn packet cache thread");

        Self {
            shared,
            _worker: worker,
        }
    }

    pub fn read_packet(&mut self) -> Result<Option<CachedPacket>> {
        let mut state = self
            .shared
            .state
            .lock()
            .map_err(|_| AudioError::InvalidData("packet cache lock poisoned".to_string()))?;
        loop {
            if state.stop {
                return Ok(None);
            }
            if state.read_index < state.base_index {
                return Err(AudioError::InvalidData(
                    "packet cache read position fell behind retained window".to_string(),
                ));
            }

            let offset = (state.read_index - state.base_index) as usize;
            if let Some(packet) = state.packets.get(offset) {
                let cloned = packet.clone_packet()?;
                state.read_index = state.read_index.saturating_add(1);
                prune_packet_cache(&mut state, usize::MAX);
                self.shared.changed.notify_all();
                return Ok(Some(cloned));
            }

            if state.eof {
                return Ok(None);
            }
            if let Some(error) = state.error.take() {
                return Err(error);
            }

            state = self
                .shared
                .changed
                .wait(state)
                .map_err(|_| AudioError::InvalidData("packet cache lock poisoned".to_string()))?;
        }
    }

    pub fn seek_to(&mut self, target: Duration) {
        if self.try_seek_cached(target) {
            return;
        }

        if let Ok(mut state) = self.shared.state.lock() {
            state.packets.clear();
            state.base_index = 0;
            state.read_index = 0;
            state.total_bytes = 0;
            state.eof = false;
            state.error = None;
            state.pending_seek = Some(target);
            state.epoch = state.epoch.wrapping_add(1);
            self.shared.changed.notify_all();
        }
    }

    fn try_seek_cached(&mut self, target: Duration) -> bool {
        let Ok(mut state) = self.shared.state.lock() else {
            return false;
        };
        let Some(offset) = packet_cache_seek_offset(&state, target) else {
            return false;
        };
        state.read_index = state.base_index.saturating_add(offset as u64);
        self.shared.changed.notify_all();
        true
    }
}

impl Drop for PacketCache {
    fn drop(&mut self) {
        if let Ok(mut state) = self.shared.state.lock() {
            state.stop = true;
            self.shared.changed.notify_all();
        }
    }
}

fn run_packet_cache_worker(
    mut demuxer: Demuxer,
    time_base: TimeBase,
    options: PacketCacheOptions,
    shared: Arc<SharedPacketCache>,
) {
    loop {
        let action = {
            let mut state = match shared.state.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            loop {
                if state.stop {
                    return;
                }
                if let Some(target) = state.pending_seek.take() {
                    break PacketCacheAction::Seek {
                        target,
                        epoch: state.epoch,
                    };
                }

                prune_packet_cache(&mut state, options.back_bytes);
                let forward_bytes = packet_cache_forward_bytes(&state);
                let forward_duration = packet_cache_forward_duration(&state);
                let has_duration_budget = forward_duration
                    .map(|duration| duration < options.max_duration)
                    .unwrap_or(true);
                if !state.eof && forward_bytes < options.max_bytes && has_duration_budget {
                    break PacketCacheAction::Read { epoch: state.epoch };
                }

                state = match shared.changed.wait(state) {
                    Ok(state) => state,
                    Err(_) => return,
                };
            }
        };

        match action {
            PacketCacheAction::Seek { target, epoch } => {
                let result = demuxer.seek_to(target);
                if let Err(error) = result {
                    set_packet_cache_error(&shared, epoch, error);
                }
            }
            PacketCacheAction::Read { epoch } => match demuxer.read_cached_packet(time_base) {
                Ok(Some(packet)) => {
                    if let Ok(mut state) = shared.state.lock() {
                        if state.epoch != epoch {
                            continue;
                        }
                        state.total_bytes = state.total_bytes.saturating_add(packet.size);
                        state.packets.push(packet);
                        prune_packet_cache(&mut state, options.back_bytes);
                        shared.changed.notify_all();
                    }
                }
                Ok(None) => {
                    if let Ok(mut state) = shared.state.lock() {
                        if state.epoch != epoch {
                            continue;
                        }
                        state.eof = true;
                        prune_packet_cache(
                            &mut state,
                            options.back_bytes.saturating_add(options.max_bytes),
                        );
                        shared.changed.notify_all();
                    }
                }
                Err(error) => set_packet_cache_error(&shared, epoch, error),
            },
        }
    }
}

enum PacketCacheAction {
    Seek { target: Duration, epoch: u64 },
    Read { epoch: u64 },
}

fn packet_cache_forward_bytes(state: &PacketCacheState) -> usize {
    state
        .packets
        .iter()
        .skip(state.read_index.saturating_sub(state.base_index) as usize)
        .map(|packet| packet.size)
        .sum()
}

fn packet_cache_forward_duration(state: &PacketCacheState) -> Option<Duration> {
    let read_offset = state.read_index.saturating_sub(state.base_index) as usize;
    let mut iter = state.packets.iter().skip(read_offset);
    let first = iter
        .next()
        .and_then(|packet| packet.pts.or(packet.end))?;
    let last = state
        .packets
        .iter()
        .rev()
        .find_map(|packet| packet.end.or(packet.pts))?;
    last.checked_sub(first)
}

fn packet_cache_seek_offset(state: &PacketCacheState, target: Duration) -> Option<usize> {
    let first = state.packets.iter().find_map(|packet| packet.pts.or(packet.end))?;
    let last = state
        .packets
        .iter()
        .rev()
        .find_map(|packet| packet.end.or(packet.pts))?;
    if target < first || target > last {
        return None;
    }

    state
        .packets
        .iter()
        .enumerate()
        .find(|(_, packet)| packet.end.or(packet.pts).is_some_and(|end| end >= target))
        .map(|(offset, _)| offset)
}

fn prune_packet_cache(state: &mut PacketCacheState, back_bytes: usize) {
    let read_offset = state.read_index.saturating_sub(state.base_index) as usize;
    let mut retained_back = 0usize;
    let mut keep_from = read_offset.min(state.packets.len());

    while keep_from > 0 {
        let packet_size = state.packets[keep_from - 1].size;
        if retained_back.saturating_add(packet_size) > back_bytes {
            break;
        }
        retained_back = retained_back.saturating_add(packet_size);
        keep_from -= 1;
    }

    if keep_from > 0 {
        let removed_bytes: usize = state.packets.drain(..keep_from).map(|packet| packet.size).sum();
        state.total_bytes = state.total_bytes.saturating_sub(removed_bytes);
        state.base_index = state.base_index.saturating_add(keep_from as u64);
    }
}

fn set_packet_cache_error(shared: &SharedPacketCache, epoch: u64, error: AudioError) {
    if let Ok(mut state) = shared.state.lock() {
        if state.epoch != epoch {
            return;
        }
        state.error = Some(error);
        shared.changed.notify_all();
    }
}

fn packet_pts(packet: *const sys::AVPacket, time_base: TimeBase) -> Option<Duration> {
    unsafe {
        let pts = (*packet).pts;
        if pts == sys::AV_NOPTS_VALUE {
            None
        } else {
            time_base.calc_micros(pts).and_then(duration_from_micros)
        }
    }
}

fn packet_end(packet: *const sys::AVPacket, time_base: TimeBase) -> Option<Duration> {
    unsafe {
        let pts = (*packet).pts;
        if pts == sys::AV_NOPTS_VALUE {
            return None;
        }
        let duration = (*packet).duration.max(0);
        time_base
            .calc_micros(pts.saturating_add(duration))
            .and_then(duration_from_micros)
    }
}

fn duration_from_micros(value: i64) -> Option<Duration> {
    (value >= 0).then(|| Duration::from_micros(value.cast_unsigned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet_with_time(pts: u64, end: u64, size: usize) -> CachedPacket {
        CachedPacket {
            packet: ptr::null_mut(),
            pts: Some(Duration::from_secs(pts)),
            end: Some(Duration::from_secs(end)),
            size,
        }
    }

    #[test]
    fn packet_cache_forward_duration_uses_packet_timestamps() {
        let state = PacketCacheState {
            packets: vec![
                packet_with_time(10, 11, 100),
                packet_with_time(11, 12, 100),
                packet_with_time(12, 14, 100),
            ],
            base_index: 5,
            read_index: 6,
            total_bytes: 300,
            eof: false,
            stop: false,
            pending_seek: None,
            error: None,
            epoch: 0,
        };

        assert_eq!(
            packet_cache_forward_duration(&state),
            Some(Duration::from_secs(3)),
        );
    }

    #[test]
    fn packet_cache_seek_rejects_target_before_retained_window() {
        let state = PacketCacheState {
            packets: vec![
                packet_with_time(88, 89, 100),
                packet_with_time(89, 90, 100),
                packet_with_time(90, 91, 100),
            ],
            base_index: 5,
            read_index: 7,
            total_bytes: 300,
            eof: false,
            stop: false,
            pending_seek: None,
            error: None,
            epoch: 0,
        };

        assert_eq!(packet_cache_seek_offset(&state, Duration::from_secs(30)), None);
    }

    #[test]
    fn packet_cache_seek_uses_cached_packet_inside_retained_window() {
        let state = PacketCacheState {
            packets: vec![
                packet_with_time(88, 89, 100),
                packet_with_time(89, 90, 100),
                packet_with_time(90, 91, 100),
            ],
            base_index: 5,
            read_index: 7,
            total_bytes: 300,
            eof: false,
            stop: false,
            pending_seek: None,
            error: None,
            epoch: 0,
        };

        assert_eq!(
            packet_cache_seek_offset(&state, Duration::from_millis(89_500)),
            Some(1),
        );
    }
}

unsafe fn extract_dict(dict: *mut sys::AVDictionary, map: &mut HashMap<String, String>) {
    if dict.is_null() {
        return;
    }

    let mut entry = ptr::null();
    loop {
        entry = unsafe { sys::av_dict_iterate(dict, entry) };
        if entry.is_null() {
            break;
        }

        let key = unsafe { CStr::from_ptr((*entry).key).to_string_lossy().into_owned() };
        let value = unsafe {
            CStr::from_ptr((*entry).value)
                .to_string_lossy()
                .into_owned()
        };

        map.insert(key, value);
    }
}

impl Drop for Demuxer {
    fn drop(&mut self) {
        unsafe {
            if !self.packet.is_null() {
                sys::av_packet_free(&raw mut self.packet);
            }
            if !self.ctx.is_null() {
                sys::avformat_close_input(&raw mut self.ctx);
            }
        }
    }
}
