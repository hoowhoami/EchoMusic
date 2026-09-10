use std::{
    collections::VecDeque,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
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
    pub seek_timeout: Duration,
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
            seek_timeout: Duration::from_secs(2),
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

    pub fn with_seek_timeout(mut self, seek_timeout: Duration) -> Self {
        self.seek_timeout = seek_timeout.max(Duration::from_millis(1));
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
    packets: VecDeque<CachedPacket>,
    base_index: u64,
    read_index: u64,
    cached_bytes: usize,
    read_bytes: usize,
    first_time: Option<Duration>,
    last_time: Option<Duration>,
    forward_start_time: Option<Duration>,
    eof: bool,
    last_used: u64,
}

impl PacketCacheRange {
    const fn new(base_index: u64, last_used: u64) -> Self {
        Self {
            packets: VecDeque::new(),
            base_index,
            read_index: base_index,
            cached_bytes: 0,
            read_bytes: 0,
            first_time: None,
            last_time: None,
            forward_start_time: None,
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
    read_failed: bool,
    read_cancelled: bool,
    resume_after_cancel: bool,
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
    interrupt: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl PacketCache {
    pub(crate) fn new(demuxer: Demuxer, time_base: TimeBase, options: PacketCacheOptions) -> Self {
        let interrupt = demuxer.interrupt_flag();
        let shared = Arc::new(SharedPacketCache {
            state: Mutex::new(PacketCacheState {
                ranges: vec![PacketCacheRange::new(0, 0)],
                current_range: 0,
                next_packet_index: 0,
                total_bytes: 0,
                stop: false,
                pending_seek: None,
                error: None,
                read_failed: false,
                read_cancelled: false,
                resume_after_cancel: false,
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
            interrupt,
            worker: Some(worker),
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
                let packet_size = packet.size;
                range.read_index = range.read_index.saturating_add(1);
                range.read_bytes = range.read_bytes.saturating_add(packet_size);
                range.forward_start_time = range
                    .packets
                    .get(offset + 1)
                    .and_then(|packet| packet.pts.or(packet.end));
                touch_current_range(&mut state);
                prune_packet_cache(&mut state, self.options);
                self.shared.changed.notify_all();
                self.has_returned_packet = true;
                return Ok(Some(cloned));
            }

            if state.read_failed {
                return Err(state.error.take().unwrap_or_else(|| {
                    AudioError::InvalidData(
                        "packet cache read failed; a real seek is required".to_string(),
                    )
                }));
            }
            if state.read_cancelled {
                return Err(AudioError::from_ffmpeg(sys::AVERROR_EXIT));
            }
            if state.ranges[current_range].eof {
                return Ok(None);
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
        // Interrupt an in-flight read before deciding whether this seek can be
        // satisfied from the current range. The worker owns clearing the flag
        // once it has observed the request and selected a resume/seek action.
        self.interrupt.store(true, Ordering::Release);
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
        state.read_failed = false;
        state.read_cancelled = false;
        state.resume_after_cancel = false;
        state.pending_seek = Some(target);
        state.epoch = state.epoch.wrapping_add(1);
        let epoch = state.epoch;
        state.read_hysteresis = false;
        prune_packet_cache(&mut state, self.options);
        self.shared.changed.notify_all();

        let deadline = Instant::now() + self.options.seek_timeout;
        while !state.stop && state.epoch == epoch && state.seek_completed_epoch < epoch {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                abort_timed_out_packet_cache_seek(&self.shared, &self.interrupt, &mut state, epoch);
                return Err(AudioError::InvalidData(
                    "packet cache seek timed out".to_string(),
                ));
            }
            let (next_state, wait_result) = self
                .shared
                .changed
                .wait_timeout(state, remaining)
                .map_err(|_| AudioError::InvalidData("packet cache lock poisoned".to_string()))?;
            state = next_state;
            if wait_result.timed_out()
                && !state.stop
                && state.epoch == epoch
                && state.seek_completed_epoch < epoch
            {
                abort_timed_out_packet_cache_seek(&self.shared, &self.interrupt, &mut state, epoch);
                return Err(AudioError::InvalidData(
                    "packet cache seek timed out".to_string(),
                ));
            }
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
            has_error: state.read_failed,
        }
    }

    fn try_seek_cached(&mut self, target: Duration) -> bool {
        let Ok(mut state) = self.shared.state.lock() else {
            return false;
        };
        if !apply_cached_seek(&mut state, target) {
            return false;
        }
        self.shared.changed.notify_all();
        true
    }
}

fn apply_cached_seek(state: &mut PacketCacheState, target: Duration) -> bool {
    if state.read_failed {
        return false;
    }
    let Some((range_index, offset)) = packet_cache_seek_offset(state, target) else {
        return false;
    };
    state.current_range = range_index;
    let range = &mut state.ranges[range_index];
    set_packet_cache_read_offset(range, offset);
    touch_current_range(state);
    state.pending_seek = None;
    state.error = None;
    state.read_cancelled = false;
    state.resume_after_cancel = true;
    state.read_hysteresis = false;
    true
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
        || state.read_failed
        || state.read_cancelled
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
            self.interrupt.store(true, Ordering::Release);
            self.shared.changed.notify_all();
        } else {
            self.interrupt.store(true, Ordering::Release);
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
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
    let interrupt = demuxer.interrupt_flag();
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
                    state.read_cancelled = false;
                    state.resume_after_cancel = false;
                    interrupt.store(false, Ordering::Release);
                    break PacketCacheAction::Seek {
                        target,
                        epoch: state.epoch,
                    };
                }
                if state.resume_after_cancel {
                    state.resume_after_cancel = false;
                    state.read_cancelled = false;
                    interrupt.store(false, Ordering::Release);
                    break PacketCacheAction::Resume;
                }

                prune_packet_cache(&mut state, options);
                let range = &state.ranges[state.current_range];
                let forward_bytes = packet_cache_forward_bytes(range);
                let forward_duration = packet_cache_forward_duration(range);
                update_read_hysteresis(&mut state, options, forward_bytes, forward_duration);
                if packet_cache_worker_can_read(&state, options) {
                    break PacketCacheAction::Read { epoch: state.epoch };
                }

                state = match shared.changed.wait(state) {
                    Ok(state) => state,
                    Err(_) => return,
                };
            }
        };

        match action {
            PacketCacheAction::Resume => demuxer.clear_read_interrupt(),
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
                        push_packet_cache_packet(&mut state.ranges[current_range], packet);
                        touch_current_range(&mut state);
                        prune_packet_cache(&mut state, options);
                        shared.changed.notify_all();
                    }
                }
                Ok(None) => {
                    if interrupt.load(Ordering::Acquire) {
                        set_packet_cache_error(
                            &shared,
                            epoch,
                            AudioError::from_ffmpeg(sys::AVERROR_EXIT),
                        );
                        continue;
                    }
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
    Resume,
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
            if is_interrupt_error(&error) {
                // A newer control operation intentionally interrupted this
                // seek. Report it to the waiter without poisoning the cache;
                // the next seek will resume or reposition the worker.
                state.error = Some(error);
                state.read_cancelled = true;
            } else {
                state.error = Some(error);
                state.read_failed = true;
            }
        }
        shared.changed.notify_all();
    }
}

fn abort_timed_out_packet_cache_seek(
    shared: &SharedPacketCache,
    interrupt: &AtomicBool,
    state: &mut PacketCacheState,
    epoch: u64,
) {
    if state.epoch != epoch || state.seek_completed_epoch >= epoch {
        return;
    }
    interrupt.store(true, Ordering::Release);
    state.epoch = state.epoch.wrapping_add(1);
    state.seek_completed_epoch = state.epoch;
    state.pending_seek = None;
    state.error = Some(AudioError::InvalidData(
        "packet cache seek timed out".to_string(),
    ));
    state.read_failed = true;
    state.read_cancelled = true;
    shared.changed.notify_all();
}

fn packet_cache_worker_can_read(state: &PacketCacheState, options: PacketCacheOptions) -> bool {
    let range = &state.ranges[state.current_range];
    let forward_bytes = packet_cache_forward_bytes(range);
    let has_duration_budget = packet_cache_forward_duration(range)
        .map(|duration| duration < options.max_duration)
        .unwrap_or(true);
    !range.eof
        && !state.read_failed
        && !state.read_cancelled
        && !state.read_hysteresis
        && forward_bytes < options.max_bytes
        && has_duration_budget
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

const fn packet_cache_forward_bytes(range: &PacketCacheRange) -> usize {
    range.cached_bytes.saturating_sub(range.read_bytes)
}

const fn packet_cache_back_bytes(range: &PacketCacheRange) -> usize {
    range.read_bytes
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
    range.last_time?.checked_sub(range.forward_start_time?)
}

fn packet_cache_seekable_ranges(state: &PacketCacheState) -> Vec<PacketCacheSeekableRange> {
    // Only the current range shares its prefetch tail with the demuxer's physical cursor,
    // so it is the only range that packet_cache_seek_offset can replay without a real seek.
    // Retained ranges remain useful for memory-budget pruning but must not be advertised to
    // the UI as immediately seekable.
    let Some(range) = state.ranges.get(state.current_range) else {
        return Vec::new();
    };
    let (Some(start), Some(end)) = (range.first_time, range.last_time) else {
        return Vec::new();
    };
    (end >= start)
        .then_some(PacketCacheSeekableRange { start, end })
        .into_iter()
        .collect()
}

fn packet_cache_seek_offset(state: &PacketCacheState, target: Duration) -> Option<(usize, usize)> {
    // The background demuxer has a single physical cursor, positioned at the prefetch tail of
    // the current range. Rewinding within that range is safe: cached packets are replayed and the
    // worker continues from the same tail. Switching directly to a retained non-current range is
    // not safe because its cached tail and the demuxer cursor are unrelated; when that cache runs
    // out, packets from the old cursor would be appended and create a timestamp discontinuity.
    // Return None for cross-range hits so seek_to performs a real demuxer seek and bumps the epoch.
    if state.read_failed {
        return None;
    }
    let range_index = state.current_range;
    let range = state.ranges.get(range_index)?;
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
    let mut removed_bytes = 0usize;
    let mut removed_first_time = false;
    while range.base_index < range.read_index && range.read_bytes > back_bytes {
        let Some(packet) = range.packets.pop_front() else {
            break;
        };
        removed_first_time |=
            range.first_time.is_some() && packet.pts.or(packet.end) == range.first_time;
        removed_bytes = removed_bytes.saturating_add(packet.size);
        range.cached_bytes = range.cached_bytes.saturating_sub(packet.size);
        range.read_bytes = range.read_bytes.saturating_sub(packet.size);
        range.base_index = range.base_index.saturating_add(1);
    }

    if removed_bytes > 0 {
        state.total_bytes = state.total_bytes.saturating_sub(removed_bytes);
    }
    if removed_first_time {
        range.first_time = range
            .packets
            .iter()
            .find_map(|packet| packet.pts.or(packet.end));
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
    if state.current_range == index {
        debug_assert!(false, "current packet-cache range must not be removed");
        return;
    }
    let removed_bytes = state.ranges[index].cached_bytes;
    state.total_bytes = state.total_bytes.saturating_sub(removed_bytes);
    state.ranges.remove(index);
    if state.current_range > index {
        state.current_range -= 1;
    }
    if state.ranges.is_empty() {
        state
            .ranges
            .push(PacketCacheRange::new(state.next_packet_index, 0));
        state.current_range = 0;
    }
}

fn push_packet_cache_packet(range: &mut PacketCacheRange, packet: CachedPacket) {
    let had_forward_packets = range.read_index < range.base_index + range.packets.len() as u64;
    let start = packet.pts.or(packet.end);
    let end = packet.end.or(packet.pts);
    range.cached_bytes = range.cached_bytes.saturating_add(packet.size);
    if range.first_time.is_none() {
        range.first_time = start;
    }
    if let Some(end) = end {
        range.last_time = Some(end);
    }
    if !had_forward_packets {
        range.forward_start_time = start;
    }
    range.packets.push_back(packet);
}

fn set_packet_cache_read_offset(range: &mut PacketCacheRange, offset: usize) {
    let offset = offset.min(range.packets.len());
    range.read_index = range.base_index.saturating_add(offset as u64);
    range.read_bytes = range
        .packets
        .iter()
        .take(offset)
        .map(|packet| packet.size)
        .sum();
    range.forward_start_time = range
        .packets
        .get(offset)
        .and_then(|packet| packet.pts.or(packet.end));
}

fn set_packet_cache_error(shared: &SharedPacketCache, epoch: u64, error: AudioError) {
    if let Ok(mut state) = shared.state.lock() {
        if state.epoch != epoch {
            return;
        }
        if is_interrupt_error(&error) {
            // AVERROR_EXIT acknowledges an intentional control interrupt.
            // Wait for a cached-seek resume or a real seek instead of
            // poisoning the cache or retrying the sticky AVIO error.
            state.read_cancelled = true;
        } else {
            state.error = Some(error);
            state.read_failed = true;
        }
        shared.changed.notify_all();
    }
}

fn is_interrupt_error(error: &AudioError) -> bool {
    matches!(error, AudioError::FFmpeg(code, _) if *code == sys::AVERROR_EXIT)
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
        let range = test_range(packets, base_index, read_index, 0);
        PacketCacheState {
            ranges: vec![range],
            current_range: 0,
            next_packet_index: read_index,
            total_bytes,
            stop: false,
            pending_seek: None,
            error: None,
            read_failed: false,
            read_cancelled: false,
            resume_after_cancel: false,
            epoch: 0,
            seek_completed_epoch: 0,
            access_clock: 0,
            read_hysteresis: false,
        }
    }

    fn test_range(
        packets: Vec<CachedPacket>,
        base_index: u64,
        read_index: u64,
        last_used: u64,
    ) -> PacketCacheRange {
        let mut range = PacketCacheRange::new(base_index, last_used);
        for packet in packets {
            push_packet_cache_packet(&mut range, packet);
        }
        set_packet_cache_read_offset(&mut range, read_index.saturating_sub(base_index) as usize);
        range
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
        push_packet_cache_packet(&mut state.ranges[0], packet_with_time(1, 2, 100));
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
    fn packet_cache_pause_does_not_hide_a_control_interrupt() {
        let mut state = single_range_state(vec![packet_with_time(0, 1, 100)], 0, 0);
        state.read_cancelled = true;
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
    fn packet_cache_back_pruning_updates_incremental_stats() {
        let mut state = single_range_state(
            vec![
                packet_with_time(10, 11, 80),
                packet_with_time(11, 12, 120),
                packet_with_time(12, 13, 160),
            ],
            5,
            7,
        );

        prune_packet_cache_range_back(&mut state, 0, 100);

        let range = &state.ranges[0];
        assert_eq!(range.base_index, 7);
        assert_eq!(range.read_index, 7);
        assert_eq!(packet_cache_back_bytes(range), 0);
        assert_eq!(packet_cache_forward_bytes(range), 160);
        assert_eq!(state.total_bytes, 160);
        assert_eq!(range.first_time, Some(Duration::from_secs(12)));
        assert_eq!(range.last_time, Some(Duration::from_secs(13)));
        assert_eq!(range.forward_start_time, Some(Duration::from_secs(12)));
    }

    #[test]
    fn packet_cache_back_pruning_preserves_first_time_after_timestamp_less_prefix() {
        let mut state = single_range_state(
            vec![
                packet_without_time(80),
                packet_with_time(10, 11, 120),
                packet_with_time(11, 12, 160),
            ],
            5,
            6,
        );

        prune_packet_cache_range_back(&mut state, 0, 0);

        let range = &state.ranges[0];
        assert_eq!(range.base_index, 6);
        assert_eq!(range.first_time, Some(Duration::from_secs(10)));
        assert_eq!(range.last_time, Some(Duration::from_secs(12)));
        assert_eq!(state.total_bytes, 280);
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
    fn packet_cache_seek_rejects_retained_non_current_range() {
        let mut state = single_range_state(
            vec![packet_with_time(10, 11, 100), packet_with_time(11, 12, 100)],
            0,
            2,
        );
        state.ranges.push(test_range(
            vec![packet_with_time(90, 91, 100), packet_with_time(91, 92, 100)],
            2,
            2,
            1,
        ));
        state.current_range = 1;
        state.total_bytes = 400;

        assert_eq!(
            packet_cache_seek_offset(&state, Duration::from_millis(10_500)),
            None,
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
        state.ranges.push(test_range(
            vec![packet_with_time(90, 91, 100), packet_with_time(91, 92, 100)],
            2,
            2,
            2,
        ));
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
    fn packet_cache_seekable_ranges_only_expose_the_current_range() {
        let mut state = single_range_state(
            vec![packet_with_time(10, 11, 100), packet_with_time(11, 12, 100)],
            0,
            2,
        );
        state.ranges.push(test_range(
            vec![packet_with_time(90, 91, 100), packet_with_time(91, 92, 100)],
            2,
            2,
            1,
        ));

        let ranges = packet_cache_seekable_ranges(&state);
        assert_eq!(
            ranges,
            vec![PacketCacheSeekableRange {
                start: Duration::from_secs(10),
                end: Duration::from_secs(12),
            }]
        );

        state.current_range = 1;
        assert_eq!(
            packet_cache_seekable_ranges(&state),
            vec![PacketCacheSeekableRange {
                start: Duration::from_secs(90),
                end: Duration::from_secs(92),
            }]
        );
    }

    #[test]
    fn packet_cache_seekable_ranges_do_not_expand_into_retained_overlaps() {
        let mut state = single_range_state(
            vec![packet_with_time(10, 11, 100), packet_with_time(11, 13, 100)],
            0,
            2,
        );
        state.ranges.push(test_range(
            vec![packet_with_time(12, 14, 100), packet_with_time(14, 15, 100)],
            2,
            2,
            1,
        ));

        let ranges = packet_cache_seekable_ranges(&state);
        assert_eq!(
            ranges,
            vec![PacketCacheSeekableRange {
                start: Duration::from_secs(10),
                end: Duration::from_secs(13),
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
        assert!(state.read_failed);
    }

    #[test]
    fn packet_cache_read_error_latches_worker_and_rejects_cached_seek() {
        let mut state = single_range_state(
            vec![packet_with_time(10, 11, 100), packet_with_time(11, 12, 100)],
            0,
            0,
        );
        state.error = Some(AudioError::InvalidData("read failed".to_string()));
        state.read_failed = true;
        let options = PacketCacheOptions::new(1_000, 0, Duration::from_secs(10));

        assert!(!packet_cache_worker_can_read(&state, options));
        assert_eq!(
            packet_cache_seek_offset(&state, Duration::from_millis(10_500)),
            None
        );

        let _ = state.error.take();
        assert!(!packet_cache_worker_can_read(&state, options));
    }

    #[test]
    fn intentional_read_interrupt_waits_without_poisoning_cached_seek() {
        let state = single_range_state(
            vec![packet_with_time(10, 11, 100), packet_with_time(11, 12, 100)],
            0,
            0,
        );
        let shared = SharedPacketCache {
            state: Mutex::new(state),
            changed: Condvar::new(),
        };

        set_packet_cache_error(&shared, 0, AudioError::from_ffmpeg(sys::AVERROR_EXIT));

        let mut state = shared.state.lock().unwrap();
        assert!(state.read_cancelled);
        assert!(!state.read_failed);
        assert!(state.error.is_none());
        assert!(!packet_cache_worker_can_read(
            &state,
            PacketCacheOptions::new(1_000, 0, Duration::from_secs(10))
        ));
        assert_eq!(
            packet_cache_seek_offset(&state, Duration::from_millis(10_500)),
            Some((0, 0))
        );
        assert!(apply_cached_seek(&mut state, Duration::from_millis(10_500)));
        assert!(!state.read_cancelled);
        assert!(state.resume_after_cancel);
        assert!(!state.read_failed);
    }

    #[test]
    fn interrupted_seek_is_reported_without_latching_read_failure() {
        let mut state = single_range_state(Vec::new(), 0, 0);
        state.epoch = 3;
        let shared = SharedPacketCache {
            state: Mutex::new(state),
            changed: Condvar::new(),
        };

        complete_packet_cache_seek(&shared, 3, Err(AudioError::from_ffmpeg(sys::AVERROR_EXIT)));

        let state = shared.state.lock().unwrap();
        assert_eq!(state.seek_completed_epoch, 3);
        assert!(state.error.is_some());
        assert!(state.read_cancelled);
        assert!(!state.read_failed);
    }

    #[test]
    fn timed_out_packet_cache_seek_invalidates_old_epoch_and_latches_error() {
        let mut state = single_range_state(Vec::new(), 0, 0);
        state.epoch = 4;
        state.pending_seek = Some(Duration::from_secs(30));
        let shared = SharedPacketCache {
            state: Mutex::new(state),
            changed: Condvar::new(),
        };
        let interrupt = AtomicBool::new(false);

        let mut state = shared.state.lock().unwrap();
        abort_timed_out_packet_cache_seek(&shared, &interrupt, &mut state, 4);

        assert_eq!(state.epoch, 5);
        assert_eq!(state.seek_completed_epoch, 5);
        assert!(state.pending_seek.is_none());
        assert!(state.read_failed);
        assert!(state.read_cancelled);
        assert!(state.error.is_some());
        assert!(interrupt.load(Ordering::Acquire));
    }

    #[test]
    fn packet_cache_seek_timeout_is_configurable() {
        let options = PacketCacheOptions::default().with_seek_timeout(Duration::from_secs(15));
        assert_eq!(options.seek_timeout, Duration::from_secs(15));
    }

    #[test]
    #[should_panic(expected = "current packet-cache range must not be removed")]
    fn removing_current_packet_cache_range_is_a_debug_invariant_violation() {
        let mut state = single_range_state(Vec::new(), 0, 0);
        remove_range(&mut state, 0);
    }
}
