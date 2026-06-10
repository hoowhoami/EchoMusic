use crate::error::{PlayerError, PlayerResult};
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, ACCEPT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE, RANGE};
use reqwest::StatusCode;
use std::collections::VecDeque;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

const FETCH_CHUNK_BYTES: u64 = 512 * 1024;
const FETCH_STREAM_BUFFER_BYTES: usize = 64 * 1024;
const PREFETCH_TARGET_BYTES: u64 = 6 * 1024 * 1024;
// Keep the raw HTTP byte cache bounded: this cache duplicates part of the
// demux packet cache, so 64 MiB is a better default for long-running playback.
const MAX_CACHE_BYTES: usize = 64 * 1024 * 1024;
const MAX_IN_FLIGHT: usize = 6;
const WAIT_SLICE: Duration = Duration::from_millis(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(25);
const MAX_REDIRECTS: usize = 5;
const FETCH_RETRY_BACKOFFS: [Duration; 3] = [
    Duration::from_millis(150),
    Duration::from_millis(500),
    Duration::from_millis(1_200),
];
const MERGE_RANGE_LIMIT_BYTES: usize = FETCH_CHUNK_BYTES as usize;
const SEEK_MODE_MASK: i32 = 0xFFFF;
const SEEK_SET: i32 = 0;
const SEEK_CUR: i32 = 1;
const SEEK_END: i32 = 2;

#[derive(Debug)]
pub enum HttpRangeError {
    Interrupted,
    Eof,
    Backend(String),
}

pub struct HttpRangeInput {
    shared: Arc<HttpRangeShared>,
    position: u64,
}

struct HttpRangeShared {
    client: Client,
    url: String,
    interrupt: Arc<AtomicBool>,
    io_interrupt: Arc<AtomicBool>,
    state: Mutex<HttpRangeState>,
    ready: Condvar,
}

struct HttpRangeState {
    content_length: u64,
    cache: VecDeque<CachedByteRange>,
    cached_bytes: usize,
    in_flight: Vec<InFlightRange>,
    request_seq: u64,
    generation: u64,
    last_error: Option<FetchRangeError>,
}

struct CachedByteRange {
    start: u64,
    data: Vec<u8>,
}

#[derive(Clone, Copy)]
struct InFlightRange {
    start: u64,
    end: u64,
    seq: u64,
    generation: u64,
    demanded: bool,
}

struct FetchRangeError {
    start: u64,
    end: u64,
    demanded: bool,
    message: String,
}

enum FetchRangeResult {
    Completed,
    Stale,
    Failed(String),
}

enum FetchStreamError {
    Stale,
    Failed { message: String, next_start: u64 },
}

impl HttpRangeInput {
    pub fn open(
        url: &str,
        interrupt: Arc<AtomicBool>,
        io_interrupt: Arc<AtomicBool>,
    ) -> PlayerResult<Self> {
        let client = Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .user_agent("EchoMusic/ffmpeg-player")
            .build()
            .map_err(|err| PlayerError::Backend(format!("http client init failed: {err}")))?;
        let metadata = probe_http_range(&client, url)?;
        if metadata.content_length == 0 {
            return Err(PlayerError::Unsupported(
                "http range input has an empty content length".to_string(),
            ));
        }
        if !metadata.seekable {
            return Err(PlayerError::Unsupported(
                "http server does not support byte range requests".to_string(),
            ));
        }

        let shared = Arc::new(HttpRangeShared {
            client,
            url: url.to_string(),
            interrupt,
            io_interrupt,
            state: Mutex::new(HttpRangeState {
                content_length: metadata.content_length,
                cache: VecDeque::new(),
                cached_bytes: 0,
                in_flight: Vec::new(),
                request_seq: 0,
                generation: 0,
                last_error: None,
            }),
            ready: Condvar::new(),
        });
        HttpRangeShared::ensure_readahead(&shared, 0);

        Ok(Self {
            shared,
            position: 0,
        })
    }

    pub fn len(&self) -> u64 {
        self.shared
            .state
            .lock()
            .map(|state| state.content_length)
            .unwrap_or_default()
    }

    pub fn read(&mut self, out: &mut [u8]) -> Result<usize, HttpRangeError> {
        if out.is_empty() {
            return Ok(0);
        }
        let copied = self.shared.read_at(self.position, out)?;
        self.position = self.position.saturating_add(copied as u64);
        HttpRangeShared::ensure_readahead(&self.shared, self.position);
        Ok(copied)
    }

    pub fn seek(&mut self, offset: i64, whence: i32) -> Result<i64, HttpRangeError> {
        if (whence & SEEK_MODE_MASK) == SEEK_CUR && offset == 0 {
            return Ok(self.position as i64);
        }

        let len = self.len();
        self.position = resolve_seek_position(self.position, len, offset, whence)?;
        HttpRangeShared::seek_to(&self.shared, self.position);
        Ok(self.position as i64)
    }
}

fn resolve_seek_position(
    position: u64,
    len: u64,
    offset: i64,
    whence: i32,
) -> Result<u64, HttpRangeError> {
    let mode = whence & SEEK_MODE_MASK;
    let base = match mode {
        SEEK_SET => 0i128,
        SEEK_CUR => position as i128,
        SEEK_END => len as i128,
        _ => {
            return Err(HttpRangeError::Backend(format!(
                "unsupported seek mode: {whence}"
            )))
        }
    };
    let next = base + offset as i128;
    if next < 0 {
        return Err(HttpRangeError::Backend(
            "negative seek is invalid".to_string(),
        ));
    }
    Ok((next as u64).min(len))
}

impl HttpRangeShared {
    fn read_at(self: &Arc<Self>, position: u64, out: &mut [u8]) -> Result<usize, HttpRangeError> {
        loop {
            if self.interrupt.load(Ordering::SeqCst) || self.io_interrupt.load(Ordering::SeqCst) {
                return Err(HttpRangeError::Interrupted);
            }

            let mut state = self
                .state
                .lock()
                .map_err(|err| HttpRangeError::Backend(format!("http range lock failed: {err}")))?;
            if position >= state.content_length {
                return Err(HttpRangeError::Eof);
            }
            if let Some(copied) = copy_from_cache(&state.cache, position, out) {
                return Ok(copied);
            }

            if range_failed_without_retry(&state, position) {
                let error = state.last_error.take().expect("range failure should exist");
                return Err(HttpRangeError::Backend(error.message));
            }
            self.ensure_fetch_locked(&mut state, position, true);
            let (next_state, _) = self
                .ready
                .wait_timeout(state, WAIT_SLICE)
                .map_err(|err| HttpRangeError::Backend(format!("http range wait failed: {err}")))?;
            drop(next_state);
        }
    }

    fn ensure_readahead(self: &Arc<Self>, position: u64) {
        if let Ok(mut state) = self.state.lock() {
            self.ensure_readahead_locked(&mut state, position);
        }
    }

    fn seek_to(self: &Arc<Self>, position: u64) {
        if let Ok(mut state) = self.state.lock() {
            state.generation = state.generation.saturating_add(1);
            state.in_flight.clear();
            state.last_error = None;
            self.ensure_readahead_locked(&mut state, position);
        }
        self.ready.notify_all();
    }

    fn ensure_readahead_locked(self: &Arc<Self>, state: &mut HttpRangeState, position: u64) {
        if position >= state.content_length {
            return;
        }

        let target = position
            .saturating_add(PREFETCH_TARGET_BYTES)
            .min(state.content_length);
        let mut cursor = position;
        while cursor < target && state.in_flight.len() < MAX_IN_FLIGHT {
            let covered_end = cached_or_in_flight_contiguous_end(state, cursor);
            if covered_end > cursor {
                cursor = covered_end;
                continue;
            }

            let start = cursor;
            let end = start
                .saturating_add(FETCH_CHUNK_BYTES)
                .saturating_sub(1)
                .min(state.content_length.saturating_sub(1));

            self.start_fetch_locked(state, start, end, false);
            cursor = cursor
                .saturating_add(FETCH_CHUNK_BYTES)
                .min(state.content_length);
        }
    }

    fn ensure_fetch_locked(
        self: &Arc<Self>,
        state: &mut HttpRangeState,
        position: u64,
        demanded: bool,
    ) {
        if position >= state.content_length || cache_contains(&state.cache, position) {
            return;
        }
        if state
            .in_flight
            .iter()
            .any(|range| position >= range.start && position <= range.end)
        {
            return;
        }

        let start = position;
        let end = start
            .saturating_add(FETCH_CHUNK_BYTES)
            .saturating_sub(1)
            .min(state.content_length.saturating_sub(1));
        self.start_fetch_locked(state, start, end, demanded);
    }

    fn start_fetch_locked(
        self: &Arc<Self>,
        state: &mut HttpRangeState,
        start: u64,
        end: u64,
        demanded: bool,
    ) {
        if state.in_flight.len() >= MAX_IN_FLIGHT {
            state.in_flight.sort_by_key(|range| range.seq);
            let remove_index = state
                .in_flight
                .iter()
                .position(|range| !range.demanded)
                .unwrap_or(0);
            state.in_flight.remove(remove_index);
        }

        state.request_seq = state.request_seq.saturating_add(1);
        let seq = state.request_seq;
        let generation = state.generation;
        state.in_flight.push(InFlightRange {
            start,
            end,
            seq,
            generation,
            demanded,
        });
        if let Err(message) = spawn_fetch(Arc::clone(self), start, end, seq, generation) {
            state.in_flight.retain(|range| {
                !(range.seq == seq && range.start == start && range.generation == generation)
            });
            state.last_error = Some(FetchRangeError {
                start,
                end,
                demanded,
                message,
            });
        }
    }
}

fn spawn_fetch(
    shared: Arc<HttpRangeShared>,
    start: u64,
    end: u64,
    seq: u64,
    generation: u64,
) -> Result<(), String> {
    thread::Builder::new()
        .name("echo-http-range-fetch".to_string())
        .spawn(move || {
            let result = fetch_range_with_retries(&shared, start, end, seq, generation);
            if let Ok(mut state) = shared.state.lock() {
                let tracked_range = state.in_flight.iter().find(|range| {
                    range.seq == seq && range.start == start && range.generation == generation
                });
                let was_tracked = tracked_range.is_some();
                let demanded = tracked_range.map(|range| range.demanded).unwrap_or(false);
                state.in_flight.retain(|range| {
                    !(range.seq == seq && range.start == start && range.generation == generation)
                });
                match result {
                    FetchRangeResult::Completed => {
                        if state.generation == generation {
                            state.last_error = None;
                        }
                    }
                    FetchRangeResult::Stale => {}
                    FetchRangeResult::Failed(message)
                        if demanded && was_tracked && state.generation == generation =>
                    {
                        state.last_error = Some(FetchRangeError {
                            start,
                            end,
                            demanded,
                            message,
                        });
                    }
                    FetchRangeResult::Failed(_) => {}
                }
            }
            shared.ready.notify_all();
        })
        .map(|_| ())
        .map_err(|err| format!("failed to spawn http range fetch thread: {err}"))
}

fn fetch_range_with_retries(
    shared: &Arc<HttpRangeShared>,
    start: u64,
    end: u64,
    seq: u64,
    generation: u64,
) -> FetchRangeResult {
    let mut next_start = start;
    let mut last_error = None;
    for (attempt, backoff) in FETCH_RETRY_BACKOFFS.iter().enumerate() {
        if next_start > end {
            return FetchRangeResult::Completed;
        }

        match fetch_range(shared, next_start, end, seq, generation) {
            Ok(()) => return FetchRangeResult::Completed,
            Err(FetchStreamError::Stale) => return FetchRangeResult::Stale,
            Err(FetchStreamError::Failed {
                message,
                next_start: retry_start,
            }) => {
                last_error = Some(message);
                next_start = retry_start;
                if attempt + 1 < FETCH_RETRY_BACKOFFS.len() {
                    thread::sleep(*backoff);
                }
            }
        }
    }
    FetchRangeResult::Failed(last_error.unwrap_or_else(|| "http range request failed".to_string()))
}

fn fetch_range(
    shared: &Arc<HttpRangeShared>,
    start: u64,
    end: u64,
    seq: u64,
    generation: u64,
) -> Result<(), FetchStreamError> {
    if fetch_is_stale(shared, seq, generation) {
        return Err(FetchStreamError::Stale);
    }

    let mut redirect_count = 0;
    let mut current_url = shared.url.clone();

    loop {
        let mut response = shared
            .client
            .get(&current_url)
            .header(RANGE, format!("bytes={start}-{end}"))
            .header(ACCEPT_ENCODING, "identity")
            .send()
            .map_err(|err| FetchStreamError::Failed {
                message: format!("http range request failed: {err}"),
                next_start: start,
            })?;
        let status = response.status();

        if status.is_redirection() {
            redirect_count += 1;
            if redirect_count > MAX_REDIRECTS {
                return Err(FetchStreamError::Failed {
                    message: format!("too many redirects (>{MAX_REDIRECTS})"),
                    next_start: start,
                });
            }
            if let Some(location) = response.headers().get("location") {
                current_url = location
                    .to_str()
                    .map_err(|_| FetchStreamError::Failed {
                        message: "invalid redirect location".to_string(),
                        next_start: start,
                    })?
                    .to_string();
                continue;
            }
            return Err(FetchStreamError::Failed {
                message: format!("redirect {status} without location header"),
                next_start: start,
            });
        }

        if status != StatusCode::PARTIAL_CONTENT {
            return Err(FetchStreamError::Failed {
                message: format!("http range request returned status {status}"),
                next_start: start,
            });
        }
        if !content_range_starts_at(response.headers(), start) {
            return Err(FetchStreamError::Failed {
                message: format!("http range response did not start at byte {start}"),
                next_start: start,
            });
        }

        let mut buffer = vec![0u8; FETCH_STREAM_BUFFER_BYTES];
        let mut next_start = start;
        loop {
            if fetch_is_stale(shared, seq, generation) {
                return Err(FetchStreamError::Stale);
            }

            let read = response
                .read(&mut buffer)
                .map_err(|err| FetchStreamError::Failed {
                    message: format!("http range body read failed: {err}"),
                    next_start,
                })?;
            if read == 0 {
                break;
            }

            let remaining = end.saturating_sub(next_start).saturating_add(1) as usize;
            let used = read.min(remaining);
            if used == 0 {
                break;
            }

            if !insert_cache_range_for_generation(
                shared,
                seq,
                generation,
                next_start,
                buffer[..used].to_vec(),
            ) {
                return Err(FetchStreamError::Stale);
            }
            next_start = next_start.saturating_add(used as u64);
            if next_start > end {
                break;
            }
        }

        if next_start <= end {
            return Err(FetchStreamError::Failed {
                message: format!(
                    "http range ended early at byte {}, expected through {end}",
                    next_start.saturating_sub(1)
                ),
                next_start,
            });
        }

        return Ok(());
    }
}

fn fetch_is_stale(shared: &HttpRangeShared, seq: u64, generation: u64) -> bool {
    if shared.interrupt.load(Ordering::SeqCst) || shared.io_interrupt.load(Ordering::SeqCst) {
        return true;
    }
    shared
        .state
        .lock()
        .map(|state| {
            state.generation != generation
                || !state
                    .in_flight
                    .iter()
                    .any(|range| range.seq == seq && range.generation == generation)
        })
        .unwrap_or(true)
}

fn copy_from_cache(
    cache: &VecDeque<CachedByteRange>,
    position: u64,
    out: &mut [u8],
) -> Option<usize> {
    for range in cache {
        let end = range.start.saturating_add(range.data.len() as u64);
        if position >= range.start && position < end {
            let offset = (position - range.start) as usize;
            let copied = out.len().min(range.data.len().saturating_sub(offset));
            out[..copied].copy_from_slice(&range.data[offset..offset + copied]);
            return Some(copied);
        }
    }
    None
}

fn cache_contains(cache: &VecDeque<CachedByteRange>, position: u64) -> bool {
    cache.iter().any(|range| {
        let end = range.start.saturating_add(range.data.len() as u64);
        position >= range.start && position < end
    })
}

fn cached_or_in_flight_contiguous_end(state: &HttpRangeState, position: u64) -> u64 {
    let mut cursor = position;
    loop {
        let mut advanced = false;
        for range in &state.cache {
            let end = range.start.saturating_add(range.data.len() as u64);
            if range.start <= cursor && cursor < end {
                cursor = end;
                advanced = true;
            }
        }
        for range in &state.in_flight {
            let end = range.end.saturating_add(1);
            if range.start <= cursor && cursor < end {
                cursor = end;
                advanced = true;
            }
        }
        if !advanced {
            return cursor;
        }
    }
}

fn range_failed_without_retry(state: &HttpRangeState, position: u64) -> bool {
    let Some(error) = state.last_error.as_ref() else {
        return false;
    };
    if !error.demanded {
        return false;
    }
    if position < error.start || position > error.end {
        return false;
    }
    !state
        .in_flight
        .iter()
        .any(|range| position >= range.start && position <= range.end)
}

fn insert_cache_range_for_generation(
    shared: &HttpRangeShared,
    seq: u64,
    generation: u64,
    start: u64,
    data: Vec<u8>,
) -> bool {
    let Ok(mut state) = shared.state.lock() else {
        return false;
    };
    if state.generation != generation {
        return false;
    }
    if !state
        .in_flight
        .iter()
        .any(|range| range.seq == seq && range.generation == generation)
    {
        return false;
    }
    insert_cache_range(&mut state, start, data);
    trim_cache(&mut state);
    state.last_error = None;
    drop(state);
    shared.ready.notify_all();
    true
}

fn insert_cache_range(state: &mut HttpRangeState, start: u64, data: Vec<u8>) {
    if data.is_empty() {
        return;
    }
    state.cached_bytes = state.cached_bytes.saturating_add(data.len());
    state.cache.push_back(CachedByteRange { start, data });
    state
        .cache
        .make_contiguous()
        .sort_by_key(|range| range.start);
    merge_cache_ranges(state);
}

fn merge_cache_ranges(state: &mut HttpRangeState) {
    let mut merged: VecDeque<CachedByteRange> = VecDeque::with_capacity(state.cache.len());
    for range in state.cache.drain(..) {
        let Some(last) = merged.back_mut() else {
            merged.push_back(range);
            continue;
        };

        let last_end = last.start.saturating_add(last.data.len() as u64);
        if range.start < last_end
            || (range.start == last_end
                && last.data.len().saturating_add(range.data.len()) <= MERGE_RANGE_LIMIT_BYTES)
        {
            let overlap = last_end.saturating_sub(range.start) as usize;
            if overlap < range.data.len() {
                last.data.extend_from_slice(&range.data[overlap..]);
            }
        } else {
            merged.push_back(range);
        }
    }

    state.cached_bytes = merged.iter().map(|range| range.data.len()).sum();
    state.cache = merged;
}

fn trim_cache(state: &mut HttpRangeState) {
    trim_cache_to(state, MAX_CACHE_BYTES);
}

fn trim_cache_to(state: &mut HttpRangeState, max_bytes: usize) {
    while state.cached_bytes > max_bytes {
        let overflow = state.cached_bytes.saturating_sub(max_bytes);
        let Some(front) = state.cache.front_mut() else {
            break;
        };
        if front.data.len() <= overflow {
            if let Some(range) = state.cache.pop_front() {
                state.cached_bytes = state.cached_bytes.saturating_sub(range.data.len());
            }
            continue;
        }

        if overflow == 0 {
            break;
        }
        let retained = front.data.split_off(overflow);
        front.start = front.start.saturating_add(overflow as u64);
        front.data = retained;
        state.cached_bytes = state.cached_bytes.saturating_sub(overflow);
    }
}

struct HttpRangeMetadata {
    content_length: u64,
    seekable: bool,
}

fn probe_http_range(client: &Client, url: &str) -> PlayerResult<HttpRangeMetadata> {
    // Try HEAD first for efficiency
    if let Ok(response) = client.head(url).header(ACCEPT_ENCODING, "identity").send() {
        if response.status().is_success() {
            let length = response.content_length().or_else(|| {
                response
                    .headers()
                    .get(CONTENT_LENGTH)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok())
            });
            let range_hint = response
                .headers()
                .get("accept-ranges")
                .and_then(|value| value.to_str().ok())
                .map(|value| value.eq_ignore_ascii_case("bytes"))
                .unwrap_or(false);
            if let Some(content_length) = length {
                if content_length > 0 && range_hint {
                    return Ok(HttpRangeMetadata {
                        content_length,
                        seekable: true,
                    });
                }
            }
        }
    }

    // Try a range request to probe support and get total length from Content-Range
    let response = client
        .get(url)
        .header(RANGE, "bytes=0-0")
        .header(ACCEPT_ENCODING, "identity")
        .send()
        .map_err(|err| PlayerError::Backend(format!("http range probe failed: {err}")))?;
    let status = response.status();
    let headers = response.headers().clone();

    if status == StatusCode::PARTIAL_CONTENT {
        if let Some(content_length) = parse_content_range_total(&headers) {
            if content_length > 0 {
                return Ok(HttpRangeMetadata {
                    content_length,
                    seekable: true,
                });
            }
        }
    }

    // If we got 200 OK instead of 206, the server doesn't support ranges
    if status == StatusCode::OK {
        return Err(PlayerError::Unsupported(
            "server responded with 200 OK instead of 206 Partial Content".to_string(),
        ));
    }

    Err(PlayerError::Unsupported(format!(
        "http range probe failed: status={status}, no valid content length"
    )))
}

fn content_range_starts_at(headers: &HeaderMap, expected_start: u64) -> bool {
    headers
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_content_range_start_value)
        .map(|start| start == expected_start)
        .unwrap_or(false)
}

fn parse_content_range_total(headers: &HeaderMap) -> Option<u64> {
    let value = headers.get(CONTENT_RANGE)?.to_str().ok()?;
    parse_content_range_total_value(value)
}

fn parse_content_range_start_value(value: &str) -> Option<u64> {
    let value = value.strip_prefix("bytes ")?;
    let (range, _) = value.split_once('/')?;
    let (start, _) = range.split_once('-')?;
    start.parse::<u64>().ok()
}

fn parse_content_range_total_value(value: &str) -> Option<u64> {
    let (_, total) = value.rsplit_once('/')?;
    if total == "*" {
        None
    } else {
        total.parse::<u64>().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        insert_cache_range, parse_content_range_start_value, parse_content_range_total_value,
        resolve_seek_position, trim_cache_to, SEEK_CUR, SEEK_END, SEEK_SET,
    };

    #[test]
    fn parses_content_range_total() {
        assert_eq!(
            parse_content_range_total_value("bytes 0-0/12345"),
            Some(12345)
        );
        assert_eq!(parse_content_range_total_value("bytes 0-0/*"), None);
    }

    #[test]
    fn parses_content_range_start() {
        assert_eq!(
            parse_content_range_start_value("bytes 1024-2047/4096"),
            Some(1024)
        );
        assert_eq!(parse_content_range_start_value("items 0-1/2"), None);
    }

    #[test]
    fn cache_insert_merges_adjacent_ranges() {
        let mut state = super::HttpRangeState {
            content_length: 16,
            cache: std::collections::VecDeque::new(),
            cached_bytes: 0,
            in_flight: Vec::new(),
            request_seq: 0,
            generation: 0,
            last_error: None,
        };

        insert_cache_range(&mut state, 4, vec![4, 5]);
        insert_cache_range(&mut state, 0, vec![0, 1, 2, 3]);
        insert_cache_range(&mut state, 6, vec![6, 7]);

        assert_eq!(state.cache.len(), 1);
        assert_eq!(state.cached_bytes, 8);
        assert_eq!(state.cache[0].start, 0);
        assert_eq!(state.cache[0].data, vec![0, 1, 2, 3, 4, 5, 6, 7]);
    }

    #[test]
    fn cache_trim_can_shrink_front_range_without_dropping_all_cache() {
        let mut state = super::HttpRangeState {
            content_length: 4096,
            cache: std::collections::VecDeque::new(),
            cached_bytes: 0,
            in_flight: Vec::new(),
            request_seq: 0,
            generation: 0,
            last_error: None,
        };
        insert_cache_range(&mut state, 0, vec![0; 2048]);

        trim_cache_to(&mut state, 1024);

        assert_eq!(state.cached_bytes, 1024);
        assert_eq!(state.cache.len(), 1);
        assert_eq!(state.cache[0].start, 1024);
        assert_eq!(state.cache[0].data.len(), 1024);
    }

    #[test]
    fn seek_accepts_ffmpeg_flag_bits() {
        assert_eq!(
            resolve_seek_position(100, 1_000, 50, SEEK_SET | 0x20000).unwrap(),
            50
        );
        assert_eq!(
            resolve_seek_position(50, 1_000, 25, SEEK_CUR | 0x20000).unwrap(),
            75
        );
        assert_eq!(
            resolve_seek_position(75, 1_000, -10, SEEK_END | 0x20000).unwrap(),
            990
        );
    }
}
