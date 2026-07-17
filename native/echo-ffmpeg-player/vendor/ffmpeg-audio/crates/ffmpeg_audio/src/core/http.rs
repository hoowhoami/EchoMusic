use std::{
    io::{
        self,
        Error,
        ErrorKind,
        Read,
        Seek,
        SeekFrom,
    },
    sync::{
        Arc,
        atomic::{
            AtomicBool,
            Ordering,
        },
    },
    time::Duration,
};

use ureq::{
    Agent,
    http::Response,
};

use crate::{
    Result,
    error::HttpError,
};

/// Soft Seek threshold
///
/// When the span of a forward seek is less than or equal to this value, addressing
/// is performed by directly reading and discarding data, avoiding breaking the
/// current TCP/TLS connection.
const SHORT_SEEK_THRESHOLD: u64 = 64 * 1024;

const MAX_RETRIES: u32 = 3;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const RECV_TIMEOUT: Duration = Duration::from_secs(10);

/// Maximum allowed retry wait time to prevent thread deadlocks caused by absurdly
/// long wait times specified in the Retry-After header
const MAX_RETRY_DELAY: Duration = Duration::from_secs(30);

const USER_AGENT: &str = "Lavf/62.12.101";

enum FetchAction {
    Success(Box<dyn Read + Send + Sync + 'static>),
    Retry(Option<Duration>),
    Fatal(HttpError),
}

/// An HTTP audio source that supports remote range requests and is compatible with `std::io::Read +
/// Seek`.
pub struct HttpAudioSource {
    /// The URL of the target audio stream.
    url: String,

    /// An internally reused HTTP client instance, managing the connection pool and timeout
    /// configuration.
    agent: Agent,

    /// The total size (in bytes) of the audio file, determined via server probing.
    content_length: u64,

    /// Tracks the current absolute byte offset within the file.
    current_pos: u64,

    /// The currently active HTTP body reader.
    /// This is set to `None` upon a large-span seek or an unrecoverable network error.
    body_reader: Option<Box<dyn Read + Send + Sync + 'static>>,

    /// Cancellation signal token passed in from the upper-layer application
    cancel_flag: Option<Arc<AtomicBool>>,
}

impl HttpAudioSource {
    /// Attempts to connect to and probe the target audio URL.
    ///
    /// Connection is permitted only if the server explicitly supports Range requests
    /// and can provide a stream of determinate length.
    pub fn new(url: &str) -> Result<Self> {
        let agent = Agent::config_builder()
            .timeout_connect(Some(CONNECT_TIMEOUT))
            .timeout_recv_body(Some(RECV_TIMEOUT))
            // Disabling treating 4xx and 5xx HTTP status codes as errors allows us
            // to handle 4xx/5xx errors with a clean match
            .http_status_as_error(false)
            .build()
            .new_agent();

        let response = match agent
            .get(url)
            .header("User-Agent", USER_AGENT)
            .header("Range", "bytes=0-")
            .call()
        {
            Ok(resp) => resp,
            Err(e) => {
                #[cfg(feature = "tracing")]
                tracing::error!("Initial probe failed for {url}: {e}");
                return Err(HttpError::Transport(e.to_string()).into());
            }
        };

        if response.status().as_u16() != 206 {
            return Err(HttpError::UnsupportedRange.into());
        }

        let content_length = Self::parse_total_length(&response).ok_or(HttpError::UnknownLength)?;

        #[cfg(feature = "tracing")]
        tracing::info!("Probing successful. Stream length: {content_length} bytes.");

        let body_reader = Box::new(response.into_body().into_reader());

        Ok(Self {
            url: url.to_string(),
            agent,
            content_length,
            current_pos: 0,
            body_reader: Some(body_reader),
            cancel_flag: None,
        })
    }

    /// Injects an atomic boolean after initialization to interrupt blocking network operations at
    /// any time.
    #[must_use]
    pub fn with_cancel_flag(mut self, flag: Arc<AtomicBool>) -> Self {
        self.cancel_flag = Some(flag);
        self
    }

    fn parse_total_length<T>(response: &Response<T>) -> Option<u64> {
        if let Some(range_hdr) = response.headers().get("Content-Range")
            && let Ok(range_str) = range_hdr.to_str()
            && let Some(slash_idx) = range_str.rfind('/')
        {
            let total_str = &range_str[slash_idx + 1..];
            if total_str != "*"
                && let Ok(total) = total_str.parse::<u64>()
            {
                return Some(total);
            }
        }

        if let Some(len_hdr) = response.headers().get("Content-Length")
            && let Ok(len_str) = len_hdr.to_str()
            && let Ok(total) = len_str.parse::<u64>()
        {
            return Some(total);
        }

        None
    }

    fn execute_seek_request(&self, target_pos: u64) -> FetchAction {
        let range_header = format!("bytes={target_pos}-");
        let result = self
            .agent
            .get(&self.url)
            .header("User-Agent", USER_AGENT)
            .header("Range", &range_header)
            .call();

        match result {
            Ok(resp) => {
                let status = resp.status().as_u16();

                match status {
                    206 => FetchAction::Success(Box::new(resp.into_body().into_reader())),

                    429 | 500..=599 => {
                        let delay = resp
                            .headers()
                            .get("Retry-After")
                            .and_then(|h| h.to_str().ok())
                            .and_then(|s| s.trim().parse::<u64>().ok())
                            .map(Duration::from_secs);

                        #[cfg(feature = "tracing")]
                        if let Some(d) = delay {
                            tracing::info!("Server requested Retry-After: {}s", d.as_secs());
                        } else {
                            tracing::warn!("Server error HTTP {status}. Tagged for retry.");
                        }

                        FetchAction::Retry(delay)
                    }

                    200 if target_pos != 0 => FetchAction::Fatal(HttpError::UnsupportedRange),

                    400..=499 => {
                        #[cfg(feature = "tracing")]
                        tracing::error!("Fatal client error: HTTP {status}");
                        FetchAction::Fatal(HttpError::Status(status))
                    }

                    _ => FetchAction::Fatal(HttpError::Status(status)),
                }
            }

            Err(e) => {
                #[cfg(feature = "tracing")]
                tracing::warn!("Transport error: {e}. Tagged for retry.");

                FetchAction::Retry(None)
            }
        }
    }

    fn hard_seek_with_retry(&mut self, target_pos: u64) -> Result<()> {
        self.body_reader = None;

        if target_pos >= self.content_length {
            self.current_pos = target_pos;
            return Ok(());
        }

        let mut retry_policy = RetryPolicy::new(self.cancel_flag.clone());

        loop {
            match self.execute_seek_request(target_pos) {
                FetchAction::Success(reader) => {
                    self.body_reader = Some(reader);
                    self.current_pos = target_pos;
                    return Ok(());
                }
                FetchAction::Fatal(err) => {
                    return Err(err.into());
                }
                FetchAction::Retry(custom_delay) => {
                    retry_policy.wait_next(custom_delay)?;
                }
            }
        }
    }
}

struct RetryPolicy {
    attempt: u32,
    max_retries: u32,
    max_retry_delay: Duration,
    cancel_flag: Option<Arc<AtomicBool>>,
}

impl RetryPolicy {
    const fn new(cancel_flag: Option<Arc<AtomicBool>>) -> Self {
        Self {
            attempt: 0,
            max_retries: MAX_RETRIES,
            max_retry_delay: MAX_RETRY_DELAY,
            cancel_flag,
        }
    }

    fn wait_next(&mut self, custom_delay: Option<Duration>) -> Result<()> {
        self.attempt += 1;
        if self.attempt > self.max_retries {
            return Err(HttpError::Timeout.into());
        }

        let wait_time =
            custom_delay.unwrap_or_else(|| Duration::from_secs(1 << (self.attempt - 1)));

        if wait_time > self.max_retry_delay {
            #[cfg(feature = "tracing")]
            tracing::error!("Retry delay {wait_time:?} exceeds limit. Aborting.");
            return Err(HttpError::Timeout.into());
        }

        #[cfg(feature = "tracing")]
        tracing::warn!(
            "Waiting {wait_time:?} before next attempt (Attempt {}/{})...",
            self.attempt,
            self.max_retries
        );

        self.sleep_interruptible(wait_time)
    }

    fn sleep_interruptible(&self, wait_time: Duration) -> Result<()> {
        if let Some(flag) = &self.cancel_flag {
            let chunk = Duration::from_millis(50);
            let mut elapsed = Duration::ZERO;

            while elapsed < wait_time {
                if flag.load(Ordering::Relaxed) {
                    return Err(HttpError::Cancelled.into());
                }

                let sleep_duration = std::cmp::min(chunk, wait_time.checked_sub(elapsed).unwrap());
                std::thread::sleep(sleep_duration);
                elapsed += sleep_duration;
            }
        } else {
            std::thread::sleep(wait_time);
        }

        Ok(())
    }
}

impl Read for HttpAudioSource {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.current_pos >= self.content_length {
            return Ok(0);
        }

        let mut network_retried = false;

        loop {
            if self.body_reader.is_none() {
                self.hard_seek_with_retry(self.current_pos)
                    .map_err(io::Error::from)?;

                if self.body_reader.is_none() {
                    return Ok(0);
                }
            }

            match self.body_reader.as_mut().unwrap().read(buf) {
                Ok(0) => {
                    if self.current_pos < self.content_length {
                        if network_retried {
                            return Err(Error::new(
                                ErrorKind::UnexpectedEof,
                                "Premature EOF: Server closed connection repeatedly",
                            ));
                        }

                        #[cfg(feature = "tracing")]
                        tracing::warn!(
                            "Premature EOF at offset {} (expected {}). Connection dropped by server. Recovering.",
                            self.current_pos,
                            self.content_length
                        );

                        self.body_reader = None;
                        self.hard_seek_with_retry(self.current_pos)
                            .map_err(io::Error::from)?;
                        network_retried = true;
                    } else {
                        return Ok(0);
                    }
                }
                Ok(n) => {
                    self.current_pos += n as u64;
                    return Ok(n);
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(e) => {
                    if network_retried {
                        return Err(e);
                    }

                    #[cfg(feature = "tracing")]
                    tracing::warn!(
                        "Network read error at offset {}: {}. Attempting to recover...",
                        self.current_pos,
                        e
                    );

                    self.body_reader = None;
                    self.hard_seek_with_retry(self.current_pos)
                        .map_err(io::Error::from)?;
                    network_retried = true;
                }
            }
        }
    }
}

impl Seek for HttpAudioSource {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let target_pos = match pos {
            SeekFrom::Start(offset) => offset,
            SeekFrom::Current(offset) => {
                let new_pos = self.current_pos.cast_signed() + offset;
                if new_pos < 0 {
                    return Err(Error::new(
                        ErrorKind::InvalidInput,
                        "Cannot seek to a negative position",
                    ));
                }
                new_pos.cast_unsigned()
            }
            SeekFrom::End(offset) => {
                let new_pos = self.content_length.cast_signed() + offset;
                if new_pos < 0 {
                    return Err(Error::new(
                        ErrorKind::InvalidInput,
                        "Cannot seek to a negative position",
                    ));
                }
                new_pos.cast_unsigned()
            }
        };

        if target_pos == self.current_pos {
            return Ok(target_pos);
        }

        if target_pos > self.current_pos {
            let delta = target_pos - self.current_pos;

            if delta <= SHORT_SEEK_THRESHOLD
                && let Some(reader) = self.body_reader.as_mut()
            {
                #[cfg(feature = "tracing")]
                tracing::debug!(
                    "Soft-seeking to offset {target_pos} by draining {delta} remaining byte(s)",
                );

                let mut discard_buf = [0u8; 4096];
                let mut remaining = delta;
                let mut soft_seek_success = true;

                while remaining > 0 {
                    let to_read = std::cmp::min(remaining, discard_buf.len() as u64) as usize;
                    match reader.read(&mut discard_buf[..to_read]) {
                        Ok(0) => {
                            soft_seek_success = false;
                            break;
                        }
                        Ok(n) => {
                            remaining -= n as u64;
                        }
                        Err(e) if e.kind() == ErrorKind::Interrupted => {}
                        Err(_) => {
                            soft_seek_success = false;
                            break;
                        }
                    }
                }

                if soft_seek_success {
                    self.current_pos = target_pos;
                    return Ok(target_pos);
                }

                #[cfg(feature = "tracing")]
                tracing::warn!("Soft seek failed. Falling back to hard seek.");
            }
        }

        self.hard_seek_with_retry(target_pos)
            .map_err(io::Error::from)?;

        Ok(target_pos)
    }
}
