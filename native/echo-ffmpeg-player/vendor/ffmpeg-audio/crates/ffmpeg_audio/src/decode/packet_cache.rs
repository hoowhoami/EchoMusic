use std::{
    sync::{Arc, Condvar, Mutex},
    thread,
    time::Duration,
};

use super::demuxer::Demuxer;
use crate::{AudioError, Result, TimeBase, sys};

#[derive(Clone, Copy, Debug)]
pub struct PacketCacheOptions {
    pub max_bytes: usize,
    pub max_back_bytes: usize,
    pub max_duration: Duration,
    pub donate_forward_budget: bool,
    pub pause_wait: Option<Duration>,
}

impl PacketCacheOptions {
    pub fn new(max_bytes: usize, max_back_bytes: usize, max_duration: Duration) -> Self {
        let max_bytes = max_bytes.max(1);
        Self {
            max_bytes,
            max_back_bytes,
            max_duration,
            donate_forward_budget: true,
            pause_wait: None,
        }
    }

    pub fn with_donate_forward_budget(mut self, enabled: bool) -> Self {
        self.donate_forward_budget = enabled;
        self
    }

    pub fn with_pause_wait(mut self, pause_wait: Option<Duration>) -> Self {
        self.pause_wait = pause_wait;
        self
    }
}

impl Default for PacketCacheOptions {
    fn default() -> Self {
        Self::new(150 * 1024 * 1024, 50 * 1024 * 1024, Duration::from_secs(1))
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PacketCacheStats {
    pub forward_bytes: usize,
    pub back_bytes: usize,
    pub total_bytes: usize,
    pub forward_duration: Option<Duration>,
    pub seekable_ranges: Vec<PacketCacheSeekableRange>,
    pub eof: bool,
    pub pending_seek: bool,
    pub has_error: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PacketCacheSeekableRange {
    pub start: Duration,
    pub end: Duration,
}

pub(crate) struct CachedPacket {
    packet: *mut sys::AVPacket,
    pts: Option<Duration>,
    end: Option<Duration>,
    size: usize,
}

unsafe impl Send for CachedPacket {}

impl CachedPacket {
    pub(crate) const fn as_ptr(&self) -> *const sys::AVPacket {
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

struct PacketCacheRange {
    packets: Vec<CachedPacket>,
    base_index: u64,
    read_index: u64,
    eof: bool,
    last_used: u64,
}

impl PacketCacheRange {
    const fn new(base_index: u64, last_used: u64) -> Self {
        Self {
            packets: Vec::new(),
            base_index,
            read_index: base_index,
            eof: false,
            last_used,
        }
    }
}

struct PacketCacheState {
    ranges: Vec<PacketCacheRange>,
    current_range: usize,
    next_packet_index: u64,
    total_bytes: usize,
    stop: bool,
    pending_seek: Option<Duration>,
    error: Option<AudioError>,
    epoch: u64,
    seek_completed_epoch: u64,
    access_clock: u64,
    read_hysteresis: bool,
}

struct SharedPacketCache {
    state: Mutex<PacketCacheState>,
    changed: Condvar,
}

pub(crate) struct PacketCache {
    shared: Arc<SharedPacketCache>,
    options: PacketCacheOptions,
    has_returned_packet: bool,
    _worker: thread::JoinHandle<()>,
}

impl PacketCache {
    pub(crate) fn new(demuxer: Demuxer, time_base: TimeBase, options: PacketCacheOptions) -> Self {
        let shared = Arc::new(SharedPacketCache {
            state: Mutex::new(PacketCacheState {
                ranges: vec![PacketCacheRange::new(0, 0)],
                current_range: 0,
                next_packet_index: 0,
                total_bytes: 0,
                stop: false,
                pending_seek: None,
                error: None,
                epoch: 0,
                seek_completed_epoch: 0,
                access_clock: 0,
                read_hysteresis: false,
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
            options,
            has_returned_packet: false,
            _worker: worker,
        }
    }

    pub(crate) fn read_packet(&mut self) -> Result<Option<CachedPacket>> {
        let mut state = self
            .shared
            .state
            .lock()
            .map_err(|_| AudioError::InvalidData("packet cache lock poisoned".to_string()))?;
        let mut buffering = false;
        loop {
            if state.stop {
                return Ok(None);
            }
            let current_range = state.current_range;
            if state.ranges[current_range].read_index < state.ranges[current_range].base_index {
                return Err(AudioError::InvalidData(
                    "packet cache read position fell behind retained window".to_string(),
                ));
            }

            let range = &state.ranges[current_range];
            let offset = (range.read_index - range.base_index) as usize;
            if offset < range.packets.len() {
                if buffering && !packet_cache_pause_ready(&state, current_range, self.options) {
                    state = self.shared.changed.wait(state).map_err(|_| {
                        AudioError::InvalidData("packet cache lock poisoned".to_string())
                    })?;
                    continue;
                }
                let range = &mut state.ranges[current_range];
                let packet = &range.packets[offset];
                let cloned = packet.clone_packet()?;
                range.read_index = range.read_index.saturating_add(1);
                touch_current_range(&mut state);
                prune_packet_cache(&mut state, self.options);
                self.shared.changed.notify_all();
                self.has_returned_packet = true;
                return Ok(Some(cloned));
            }

            if state.ranges[current_range].eof {
                return Ok(None);
            }
            if let Some(error) = state.error.take() {
                return Err(error);
            }

            buffering = self.options.pause_wait.is_some() && self.has_returned_packet;

            state =
                self.shared.changed.wait(state).map_err(|_| {
                    AudioError::InvalidData("packet cache lock poisoned".to_string())
                })?;
        }
    }

    pub(crate) fn seek_to(&mut self, target: Duration) -> Result<()> {
        self.has_returned_packet = false;
        if self.try_seek_cached(target) {
            return Ok(());
        }

        let mut state = self
            .shared
            .state
            .lock()
            .map_err(|_| AudioError::InvalidData("packet cache lock poisoned".to_string()))?;
        let range_index = push_empty_range(&mut state);
        state.current_range = range_index;
        state.error = None;
        state.pending_seek = Some(target);
        state.epoch = state.epoch.wrapping_add(1);
        let epoch = state.epoch;
        state.read_hysteresis = false;
        prune_packet_cache(&mut state, self.options);
        self.shared.changed.notify_all();

        while !state.stop && state.epoch == epoch && state.seek_completed_epoch < epoch {
            state =
                self.shared.changed.wait(state).map_err(|_| {
                    AudioError::InvalidData("packet cache lock poisoned".to_string())
                })?;
        }

        if state.stop || state.epoch != epoch {
            return Err(AudioError::InvalidData(
                "packet cache seek interrupted".to_string(),
            ));
        }
        if let Some(error) = state.error.take() {
            return Err(error);
        }
        Ok(())
    }

    pub(crate) fn stats(&self) -> PacketCacheStats {
        let Ok(state) = self.shared.state.lock() else {
            return PacketCacheStats::default();
        };
        let range = &state.ranges[state.current_range];
        let seekable_ranges = packet_cache_seekable_ranges(&state);
        PacketCacheStats {
            forward_bytes: packet_cache_forward_bytes(range),
            back_bytes: packet_cache_back_bytes(range),
            total_bytes: state.total_bytes,
            forward_duration: packet_cache_forward_duration(range),
            seekable_ranges,
            eof: range.eof,
            pending_seek: state.pending_seek.is_some() || state.seek_completed_epoch < state.epoch,
            has_error: state.error.is_some(),
        }
    }

    fn try_seek_cached(&mut self, target: Duration) -> bool {
        let Ok(mut state) = self.shared.state.lock() else {
            return false;
        };
        let Some((range_index, offset)) = packet_cache_seek_offset(&state, target) else {
            return false;
        };
        state.current_range = range_index;
        let range = &mut state.ranges[range_index];
        range.read_index = range.base_index.saturating_add(offset as u64);
        touch_current_range(&mut state);
        state.error = None;
        state.pending_seek = None;
        state.read_hysteresis = false;
        self.shared.changed.notify_all();
        true
    }
}

fn packet_cache_pause_ready(
    state: &PacketCacheState,
    range_index: usize,
    options: PacketCacheOptions,
) -> bool {
    let Some(pause_wait) = options.pause_wait else {
        return true;
    };
    let range = &state.ranges[range_index];
    if pause_wait.is_zero()
        || options.max_duration.is_zero()
        || range.eof
        || state.error.is_some()
        || state.read_hysteresis
    {
        return true;
    }
    let Some(forward_duration) = packet_cache_forward_duration(range) else {
        // Timestamp-less streams cannot satisfy a duration-based pause target.
        // Resume as soon as a packet is available instead of waiting for the
        // entire byte budget or EOF.
        return true;
    };
    let forward_bytes = packet_cache_forward_bytes(range);
    forward_bytes >= options.max_bytes
        || forward_duration >= pause_wait
        || forward_duration >= options.max_duration
}

impl Drop for PacketCache {
    fn drop(&mut self) {
        if let Ok(mut state) = self.shared.state.lock() {
            state.stop = true;
            self.shared.changed.notify_all();
        }
    }
}

impl Demuxer {
    pub(crate) fn read_cached_packet(
        &mut self,
        time_base: TimeBase,
    ) -> Result<Option<CachedPacket>> {
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

                prune_packet_cache(&mut state, options);
                let range = &state.ranges[state.current_range];
                let forward_bytes = packet_cache_forward_bytes(range);
                let forward_duration = packet_cache_forward_duration(range);
                update_read_hysteresis(&mut state, options, forward_bytes, forward_duration);
                let has_duration_budget = forward_duration
                    .map(|duration| duration < options.max_duration)
                    .unwrap_or(true);
                if !state.ranges[state.current_range].eof
                    && !state.read_hysteresis
                    && forward_bytes < options.max_bytes
                    && has_duration_budget
                {
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
                complete_packet_cache_seek(&shared, epoch, result);
            }
            PacketCacheAction::Read { epoch } => match demuxer.read_cached_packet(time_base) {
                Ok(Some(packet)) => {
                    if let Ok(mut state) = shared.state.lock() {
                        if state.epoch != epoch {
                            continue;
                        }
                        let current_range = state.current_range;
                        state.total_bytes = state.total_bytes.saturating_add(packet.size);
                        state.next_packet_index = state.next_packet_index.saturating_add(1);
                        state.ranges[current_range].packets.push(packet);
                        touch_current_range(&mut state);
                        prune_packet_cache(&mut state, options);
                        shared.changed.notify_all();
                    }
                }
                Ok(None) => {
                    if let Ok(mut state) = shared.state.lock() {
                        if state.epoch != epoch {
                            continue;
                        }
                        let current_range = state.current_range;
                        state.ranges[current_range].eof = true;
                        prune_packet_cache(&mut state, options);
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

fn complete_packet_cache_seek(shared: &SharedPacketCache, epoch: u64, result: Result<()>) {
    if let Ok(mut state) = shared.state.lock() {
        if state.epoch != epoch {
            return;
        }
        state.seek_completed_epoch = epoch;
        if let Err(error) = result {
            state.error = Some(error);
        }
        shared.changed.notify_all();
    }
}

fn push_empty_range(state: &mut PacketCacheState) -> usize {
    state.access_clock = state.access_clock.wrapping_add(1);
    let base_index = state.next_packet_index;
    state
        .ranges
        .push(PacketCacheRange::new(base_index, state.access_clock));
    state.ranges.len() - 1
}

fn touch_current_range(state: &mut PacketCacheState) {
    state.access_clock = state.access_clock.wrapping_add(1);
    let current_range = state.current_range;
    state.ranges[current_range].last_used = state.access_clock;
}

fn update_read_hysteresis(
    state: &mut PacketCacheState,
    options: PacketCacheOptions,
    forward_bytes: usize,
    forward_duration: Option<Duration>,
) {
    let max_duration = options.max_duration;
    let over_duration = forward_duration
        .map(|duration| duration >= max_duration)
        .unwrap_or(false);
    if forward_bytes >= options.max_bytes || over_duration {
        state.read_hysteresis = true;
        return;
    }

    if !state.read_hysteresis {
        return;
    }

    let resume_bytes = options.max_bytes.saturating_mul(3) / 4;
    let below_bytes = forward_bytes <= resume_bytes;
    let below_duration = forward_duration
        .map(|duration| duration <= scale_duration(max_duration, 3, 4))
        .unwrap_or(true);
    if below_bytes && below_duration {
        state.read_hysteresis = false;
    }
}

fn scale_duration(duration: Duration, numerator: u32, denominator: u32) -> Duration {
    let micros =
        duration.as_micros().saturating_mul(numerator as u128) / denominator.max(1) as u128;
    Duration::from_micros(micros.min(u64::MAX as u128) as u64)
}

fn packet_cache_forward_bytes(range: &PacketCacheRange) -> usize {
    range
        .packets
        .iter()
        .skip(range.read_index.saturating_sub(range.base_index) as usize)
        .map(|packet| packet.size)
        .sum()
}

fn packet_cache_back_bytes(range: &PacketCacheRange) -> usize {
    let read_offset = range.read_index.saturating_sub(range.base_index) as usize;
    range
        .packets
        .iter()
        .take(read_offset.min(range.packets.len()))
        .map(|packet| packet.size)
        .sum()
}

fn packet_cache_effective_back_bytes(
    range: &PacketCacheRange,
    options: PacketCacheOptions,
) -> usize {
    if options.max_back_bytes == 0 {
        return 0;
    }
    if !options.donate_forward_budget {
        return options.max_back_bytes;
    }
    options.max_back_bytes.saturating_add(
        options
            .max_bytes
            .saturating_sub(packet_cache_forward_bytes(range)),
    )
}

fn packet_cache_forward_duration(range: &PacketCacheRange) -> Option<Duration> {
    let read_offset = range.read_index.saturating_sub(range.base_index) as usize;
    let mut iter = range.packets.iter().skip(read_offset);
    let first = iter.next().and_then(|packet| packet.pts.or(packet.end))?;
    let last = range
        .packets
        .iter()
        .rev()
        .find_map(|packet| packet.end.or(packet.pts))?;
    last.checked_sub(first)
}

fn packet_cache_seekable_ranges(state: &PacketCacheState) -> Vec<PacketCacheSeekableRange> {
    let mut ranges = state
        .ranges
        .iter()
        .filter_map(|range| {
            let start = range
                .packets
                .iter()
                .find_map(|packet| packet.pts.or(packet.end))?;
            let end = range
                .packets
                .iter()
                .rev()
                .find_map(|packet| packet.end.or(packet.pts))?;
            (end >= start).then_some(PacketCacheSeekableRange { start, end })
        })
        .collect::<Vec<_>>();
    ranges.sort_unstable_by_key(|range| (range.start, range.end));

    let mut normalized: Vec<PacketCacheSeekableRange> = Vec::with_capacity(ranges.len());
    for range in ranges {
        if let Some(previous) = normalized.last_mut()
            && range.start <= previous.end
        {
            previous.end = previous.end.max(range.end);
            continue;
        }
        normalized.push(range);
    }
    normalized
}

fn packet_cache_seek_offset(state: &PacketCacheState, target: Duration) -> Option<(usize, usize)> {
    state
        .ranges
        .iter()
        .enumerate()
        .filter_map(|(range_index, range)| {
            let first = range
                .packets
                .iter()
                .find_map(|packet| packet.pts.or(packet.end))?;
            let last = range
                .packets
                .iter()
                .rev()
                .find_map(|packet| packet.end.or(packet.pts))?;
            if target < first || target > last {
                return None;
            }

            range
                .packets
                .iter()
                .enumerate()
                .find(|(_, packet)| packet.end.or(packet.pts).is_some_and(|end| end >= target))
                .map(|(offset, _)| (range_index, offset))
        })
        .next()
}

fn prune_packet_cache(state: &mut PacketCacheState, options: PacketCacheOptions) {
    if state.ranges.is_empty() {
        state
            .ranges
            .push(PacketCacheRange::new(state.next_packet_index, 0));
        state.current_range = 0;
    }

    let current_range = state.current_range;
    let back_bytes = packet_cache_effective_back_bytes(&state.ranges[current_range], options);
    prune_packet_cache_range_back(state, current_range, back_bytes);
    prune_empty_non_current_ranges(state);

    let max_total_bytes = options
        .max_bytes
        .saturating_add(options.max_back_bytes)
        .max(1);
    while state.total_bytes > max_total_bytes && state.ranges.len() > 1 {
        let Some(remove_index) = state
            .ranges
            .iter()
            .enumerate()
            .filter(|(index, range)| *index != state.current_range && !range.packets.is_empty())
            .min_by_key(|(_, range)| range.last_used)
            .map(|(index, _)| index)
        else {
            break;
        };
        remove_range(state, remove_index);
    }
}

fn prune_packet_cache_range_back(
    state: &mut PacketCacheState,
    range_index: usize,
    back_bytes: usize,
) {
    let range = &mut state.ranges[range_index];
    let read_offset = range.read_index.saturating_sub(range.base_index) as usize;
    let mut retained_back = 0usize;
    let mut keep_from = read_offset.min(range.packets.len());

    while keep_from > 0 {
        let packet_size = range.packets[keep_from - 1].size;
        if retained_back.saturating_add(packet_size) > back_bytes {
            break;
        }
        retained_back = retained_back.saturating_add(packet_size);
        keep_from -= 1;
    }

    if keep_from > 0 {
        let removed_bytes: usize = range
            .packets
            .drain(..keep_from)
            .map(|packet| packet.size)
            .sum();
        state.total_bytes = state.total_bytes.saturating_sub(removed_bytes);
        range.base_index = range.base_index.saturating_add(keep_from as u64);
    }
}

fn prune_empty_non_current_ranges(state: &mut PacketCacheState) {
    let mut index = 0usize;
    while index < state.ranges.len() {
        if index != state.current_range && state.ranges[index].packets.is_empty() {
            remove_range(state, index);
            continue;
        }
        index += 1;
    }
}

fn remove_range(state: &mut PacketCacheState, index: usize) {
    let removed_bytes: usize = state.ranges[index]
        .packets
        .iter()
        .map(|packet| packet.size)
        .sum();
    state.total_bytes = state.total_bytes.saturating_sub(removed_bytes);
    state.ranges.remove(index);
    if state.current_range > index {
        state.current_range -= 1;
    } else if state.current_range == index {
        state.current_range = state
            .current_range
            .min(state.ranges.len().saturating_sub(1));
    }
    if state.ranges.is_empty() {
        state
            .ranges
            .push(PacketCacheRange::new(state.next_packet_index, 0));
        state.current_range = 0;
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
    use std::ptr;

    fn packet_with_time(pts: u64, end: u64, size: usize) -> CachedPacket {
        CachedPacket {
            packet: ptr::null_mut(),
            pts: Some(Duration::from_secs(pts)),
            end: Some(Duration::from_secs(end)),
            size,
        }
    }

    fn packet_without_time(size: usize) -> CachedPacket {
        CachedPacket {
            packet: ptr::null_mut(),
            pts: None,
            end: None,
            size,
        }
    }

    fn single_range_state(
        packets: Vec<CachedPacket>,
        base_index: u64,
        read_index: u64,
    ) -> PacketCacheState {
        let total_bytes = packets.iter().map(|packet| packet.size).sum();
        PacketCacheState {
            ranges: vec![PacketCacheRange {
                packets,
                base_index,
                read_index,
                eof: false,
                last_used: 0,
            }],
            current_range: 0,
            next_packet_index: read_index,
            total_bytes,
            stop: false,
            pending_seek: None,
            error: None,
            epoch: 0,
            seek_completed_epoch: 0,
            access_clock: 0,
            read_hysteresis: false,
        }
    }

    #[test]
    fn packet_cache_forward_duration_uses_packet_timestamps() {
        let state = single_range_state(
            vec![
                packet_with_time(10, 11, 100),
                packet_with_time(11, 12, 100),
                packet_with_time(12, 14, 100),
            ],
            5,
            6,
        );

        assert_eq!(
            packet_cache_forward_duration(&state.ranges[0]),
            Some(Duration::from_secs(3)),
        );
    }

    #[test]
    fn packet_cache_byte_stats_split_back_and_forward_windows() {
        let state = single_range_state(
            vec![
                packet_with_time(10, 11, 80),
                packet_with_time(11, 12, 120),
                packet_with_time(12, 13, 160),
            ],
            5,
            7,
        );

        assert_eq!(packet_cache_back_bytes(&state.ranges[0]), 200);
        assert_eq!(packet_cache_forward_bytes(&state.ranges[0]), 160);
    }

    #[test]
    fn packet_cache_pause_waits_for_forward_duration_after_underrun() {
        let mut state = single_range_state(vec![packet_with_time(0, 1, 100)], 0, 0);
        let options = PacketCacheOptions::new(1_000, 0, Duration::from_secs(10))
            .with_pause_wait(Some(Duration::from_secs(2)));

        assert!(!packet_cache_pause_ready(&state, 0, options));
        state.ranges[0].packets.push(packet_with_time(1, 2, 100));
        assert!(packet_cache_pause_ready(&state, 0, options));
    }

    #[test]
    fn packet_cache_pause_resumes_early_at_eof() {
        let mut state = single_range_state(vec![packet_with_time(0, 1, 100)], 0, 0);
        state.ranges[0].eof = true;
        let options = PacketCacheOptions::new(1_000, 0, Duration::from_secs(10))
            .with_pause_wait(Some(Duration::from_secs(2)));

        assert!(packet_cache_pause_ready(&state, 0, options));
    }

    #[test]
    fn packet_cache_pause_skips_duration_wait_without_timestamps() {
        let state = single_range_state(vec![packet_without_time(100)], 0, 0);
        let options = PacketCacheOptions::new(150 * 1024 * 1024, 0, Duration::from_secs(10))
            .with_pause_wait(Some(Duration::from_secs(2)));

        assert!(packet_cache_pause_ready(&state, 0, options));
    }

    #[test]
    fn packet_cache_pause_skips_duration_wait_when_forward_start_has_no_timestamp() {
        let state = single_range_state(
            vec![packet_without_time(100), packet_with_time(1, 2, 100)],
            0,
            0,
        );
        let options = PacketCacheOptions::new(150 * 1024 * 1024, 0, Duration::from_secs(10))
            .with_pause_wait(Some(Duration::from_secs(2)));

        assert!(packet_cache_pause_ready(&state, 0, options));
    }

    #[test]
    fn packet_cache_back_buffer_can_use_unused_forward_budget() {
        let state = single_range_state(
            vec![
                packet_with_time(10, 11, 80),
                packet_with_time(11, 12, 120),
                packet_with_time(12, 13, 160),
            ],
            5,
            7,
        );
        let options = PacketCacheOptions::new(1_000, 200, Duration::from_secs(1));

        assert_eq!(
            packet_cache_effective_back_bytes(&state.ranges[0], options),
            1_040
        );

        let no_donation = PacketCacheOptions::new(1_000, 200, Duration::from_secs(1))
            .with_donate_forward_budget(false);
        assert_eq!(
            packet_cache_effective_back_bytes(&state.ranges[0], no_donation),
            200
        );

        let disabled = PacketCacheOptions::new(1_000, 0, Duration::from_secs(1));
        assert_eq!(
            packet_cache_effective_back_bytes(&state.ranges[0], disabled),
            0
        );
    }

    #[test]
    fn packet_cache_seek_rejects_target_before_retained_window() {
        let state = single_range_state(
            vec![
                packet_with_time(88, 89, 100),
                packet_with_time(89, 90, 100),
                packet_with_time(90, 91, 100),
            ],
            5,
            7,
        );

        assert_eq!(
            packet_cache_seek_offset(&state, Duration::from_secs(30)),
            None
        );
    }

    #[test]
    fn packet_cache_seek_uses_cached_packet_inside_retained_window() {
        let state = single_range_state(
            vec![
                packet_with_time(88, 89, 100),
                packet_with_time(89, 90, 100),
                packet_with_time(90, 91, 100),
            ],
            5,
            7,
        );

        assert_eq!(
            packet_cache_seek_offset(&state, Duration::from_millis(89_500)),
            Some((0, 1)),
        );
    }

    #[test]
    fn packet_cache_seek_can_hit_retained_non_current_range() {
        let mut state = single_range_state(
            vec![packet_with_time(10, 11, 100), packet_with_time(11, 12, 100)],
            0,
            2,
        );
        state.ranges.push(PacketCacheRange {
            packets: vec![packet_with_time(90, 91, 100), packet_with_time(91, 92, 100)],
            base_index: 2,
            read_index: 2,
            eof: false,
            last_used: 1,
        });
        state.current_range = 1;
        state.total_bytes = 400;

        assert_eq!(
            packet_cache_seek_offset(&state, Duration::from_millis(10_500)),
            Some((0, 0)),
        );
    }

    #[test]
    fn packet_cache_prune_drops_old_non_current_ranges_over_budget() {
        let mut state = single_range_state(
            vec![packet_with_time(10, 11, 100), packet_with_time(11, 12, 100)],
            0,
            2,
        );
        state.ranges[0].last_used = 1;
        state.ranges.push(PacketCacheRange {
            packets: vec![packet_with_time(90, 91, 100), packet_with_time(91, 92, 100)],
            base_index: 2,
            read_index: 2,
            eof: false,
            last_used: 2,
        });
        state.current_range = 1;
        state.total_bytes = 400;

        prune_packet_cache(
            &mut state,
            PacketCacheOptions::new(150, 50, Duration::from_secs(10)),
        );

        assert_eq!(state.ranges.len(), 1);
        assert_eq!(
            packet_cache_seekable_ranges(&state),
            vec![PacketCacheSeekableRange {
                start: Duration::from_secs(90),
                end: Duration::from_secs(92),
            }]
        );
        assert_eq!(state.total_bytes, 200);
    }

    #[test]
    fn packet_cache_seekable_ranges_preserve_holes() {
        let mut state = single_range_state(
            vec![packet_with_time(10, 11, 100), packet_with_time(11, 12, 100)],
            0,
            2,
        );
        state.ranges.push(PacketCacheRange {
            packets: vec![packet_with_time(90, 91, 100), packet_with_time(91, 92, 100)],
            base_index: 2,
            read_index: 2,
            eof: false,
            last_used: 1,
        });

        let ranges = packet_cache_seekable_ranges(&state);
        assert_eq!(
            ranges,
            vec![
                PacketCacheSeekableRange {
                    start: Duration::from_secs(10),
                    end: Duration::from_secs(12),
                },
                PacketCacheSeekableRange {
                    start: Duration::from_secs(90),
                    end: Duration::from_secs(92),
                },
            ]
        );
        assert_eq!(
            packet_cache_seek_offset(&state, Duration::from_secs(50)),
            None
        );
    }

    #[test]
    fn packet_cache_seekable_ranges_merge_overlaps() {
        let mut state = single_range_state(
            vec![packet_with_time(10, 11, 100), packet_with_time(11, 13, 100)],
            0,
            2,
        );
        state.ranges.push(PacketCacheRange {
            packets: vec![packet_with_time(12, 14, 100), packet_with_time(14, 15, 100)],
            base_index: 2,
            read_index: 2,
            eof: false,
            last_used: 1,
        });

        let ranges = packet_cache_seekable_ranges(&state);
        assert_eq!(
            ranges,
            vec![PacketCacheSeekableRange {
                start: Duration::from_secs(10),
                end: Duration::from_secs(15),
            }]
        );
    }

    #[test]
    fn packet_cache_hysteresis_waits_for_lower_watermark() {
        let mut state = single_range_state(
            vec![packet_with_time(10, 11, 80), packet_with_time(11, 12, 30)],
            0,
            0,
        );
        let options = PacketCacheOptions::new(100, 0, Duration::from_secs(10));

        update_read_hysteresis(&mut state, options, 110, Some(Duration::from_secs(2)));
        assert!(state.read_hysteresis);
        update_read_hysteresis(&mut state, options, 90, Some(Duration::from_secs(2)));
        assert!(state.read_hysteresis);
        update_read_hysteresis(&mut state, options, 70, Some(Duration::from_secs(2)));
        assert!(!state.read_hysteresis);
    }

    #[test]
    fn packet_cache_seek_completion_tracks_matching_epoch() {
        let mut state = single_range_state(Vec::new(), 0, 0);
        state.epoch = 7;
        let shared = SharedPacketCache {
            state: Mutex::new(state),
            changed: Condvar::new(),
        };

        complete_packet_cache_seek(&shared, 6, Ok(()));
        assert_eq!(shared.state.lock().unwrap().seek_completed_epoch, 0);

        complete_packet_cache_seek(&shared, 7, Ok(()));
        let state = shared.state.lock().unwrap();
        assert_eq!(state.seek_completed_epoch, 7);
        assert!(state.error.is_none());
    }

    #[test]
    fn packet_cache_seek_completion_preserves_seek_error() {
        let mut state = single_range_state(Vec::new(), 0, 0);
        state.epoch = 3;
        let shared = SharedPacketCache {
            state: Mutex::new(state),
            changed: Condvar::new(),
        };

        complete_packet_cache_seek(
            &shared,
            3,
            Err(AudioError::InvalidData("seek failed".to_string())),
        );
        let state = shared.state.lock().unwrap();
        assert_eq!(state.seek_completed_epoch, 3);
        assert!(state.error.is_some());
    }
}
