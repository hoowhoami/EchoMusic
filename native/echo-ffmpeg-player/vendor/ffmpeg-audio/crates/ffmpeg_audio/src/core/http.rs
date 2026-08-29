use std::{
    io::{self, Error, ErrorKind, Read, Seek, SeekFrom},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use futures_util::TryStreamExt;
use reqwest::{Client, Proxy, StatusCode, header};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    runtime::{Builder, Runtime},
};
use tokio_util::{io::StreamReader, sync::CancellationToken};

use crate::{Result, error::HttpError};

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

const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(120);
const MAX_RECONNECT_TOTAL_DELAY: Duration = Duration::from_secs(256);

const USER_AGENT: &str = "Lavf/62.12.101";
const CANCEL_BRIDGE_POLL: Duration = Duration::from_millis(25);
const RUNTIME_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(200);

type AsyncReader = Pin<Box<dyn AsyncRead + Send + Sync + 'static>>;

enum FetchAction {
    Success(AsyncReader, Option<u64>),
    Retry(Option<Duration>),
    Fatal(HttpError),
}

#[derive(Clone, Copy)]
struct ContentRange {
    start: u64,
    end: u64,
    total: Option<u64>,
}

fn next_reconnect_delay(current: Duration) -> io::Result<Duration> {
    let seconds = current
        .as_secs()
        .checked_mul(2)
        .and_then(|seconds| seconds.checked_add(1))
        .ok_or_else(|| Error::other("Reconnect delay overflow"))?;
    Ok(Duration::from_secs(seconds))
}

#[derive(Clone, Debug)]
pub struct HttpAudioSourceOptions {
    pub connect_timeout: Duration,
    pub recv_timeout: Duration,
    pub proxy_url: Option<String>,
}

impl Default for HttpAudioSourceOptions {
    fn default() -> Self {
        Self {
            connect_timeout: CONNECT_TIMEOUT,
            recv_timeout: RECV_TIMEOUT,
            proxy_url: None,
        }
    }
}

/// An opaque, thread-safe handle used to trigger and reset cancellation of network operations on
/// [`HttpAudioSource`].
#[derive(Clone, Default)]
pub struct HttpCancelHandle {
    inner: Arc<Mutex<CancellationToken>>,
}

impl HttpCancelHandle {
    /// Creates a new [`HttpCancelHandle`].
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(CancellationToken::new())),
        }
    }

    /// Triggers immediate cancellation of ongoing network operations associated with this handle.
    pub fn cancel(&self) {
        self.inner.lock().unwrap().cancel();
    }

    /// Resets the cancellation state, allowing subsequent operations to proceed normally.
    ///
    /// This is typically called prior to a seek operation on a reused audio source.
    pub fn reset(&self) {
        let mut token = self.inner.lock().unwrap();
        if token.is_cancelled() {
            *token = CancellationToken::new();
        }
    }

    /// Returns `true` if the cancellation signal has been triggered and not yet reset.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.inner.lock().unwrap().is_cancelled()
    }

    fn token(&self) -> CancellationToken {
        self.inner.lock().unwrap().clone()
    }
}

impl From<&Self> for HttpCancelHandle {
    fn from(handle: &Self) -> Self {
        handle.clone()
    }
}

/// An HTTP audio source that supports remote range requests and is compatible with `std::io::Read +
/// Seek`.
pub struct HttpAudioSource {
    /// The URL of the target audio stream.
    url: String,

    /// An internally reused HTTP client instance, managing the connection pool and timeout
    /// configuration.
    client: Client,

    /// The total size (in bytes) of the audio file, determined via server probing.
    content_length: Option<u64>,

    /// Whether nonzero byte offsets can be reopened with a Range request.
    range_supported: bool,

    /// Tracks the current absolute byte offset within the file.
    current_pos: u64,

    /// The currently active HTTP body reader.
    /// This is set to `None` upon a large-span seek or an unrecoverable network error.
    body_reader: Option<AsyncReader>,

    /// The exclusive end offset of the currently active HTTP response range.
    stream_end: Option<u64>,

    /// Backoff state for consecutive reconnects without a successful read.
    reconnect_delay: Duration,
    reconnect_total_delay: Duration,

    /// Opaque cancellation handle passed in from the upper-layer application
    cancel_handle: HttpCancelHandle,

    /// Whether this source created the cancellation handle and may cancel it
    /// during teardown. Externally supplied handles can be shared by callers.
    owns_cancel_handle: bool,

    /// Optional application interrupt flag mirrored by the cancellation bridge.
    cancel_flag: Option<Arc<AtomicBool>>,

    /// Locally cached active token to eliminate Mutex lock overhead during high-frequency `read()`
    /// calls.
    active_token: CancellationToken,

    /// Stops the optional AtomicBool-to-HttpCancelHandle bridge used by EchoMusic.
    cancel_bridge_stop: Option<Arc<AtomicBool>>,

    /// Thread that maps EchoMusic's existing interrupt flag to the cancellation handle.
    cancel_bridge_thread: Option<JoinHandle<()>>,

    /// Per-read timeout. EchoMusic feeds this from player network settings.
    recv_timeout: Duration,

    /// An isolated Tokio runtime dedicated to driving current asynchronous network operations.
    rt: Option<Runtime>,
}

impl HttpAudioSource {
    /// Attempts to connect to and probe the target remote URL using a default cancellation token.
    ///
    /// Finite range-capable files retain random-access support. Sequential HTTP streams without
    /// `Content-Length` are also accepted, but only support forward reading from byte zero.
    ///
    /// This is a convenience constructor that delegates to [`Self::new_with_cancel_handle`] with a
    /// newly created, non-canceled [`HttpCancelHandle`].
    ///
    /// # Arguments
    ///
    /// * `url` - The URL of the target remote audio stream.
    ///
    /// # Errors
    ///
    /// Returns an error if:
    /// * The remote server returns an unsupported status or malformed range metadata.
    /// * A transport or connection error occurs during the initial network probe.
    pub fn new(url: &str) -> Result<Self> {
        Self::new_with_options(url, HttpAudioSourceOptions::default())
    }

    pub fn new_with_options(url: &str, options: HttpAudioSourceOptions) -> Result<Self> {
        Self::new_with_options_and_cancel_handle_owned(url, options, HttpCancelHandle::new(), true)
    }

    /// Attempts to connect to and probe the target remote URL, allowing the initial connection
    /// and response probing phase to be interrupted.
    ///
    /// Finite range-capable files retain random-access support. Sequential HTTP streams without
    /// `Content-Length` are also accepted, but only support forward reading from byte zero.
    ///
    /// The initial HTTP probe request runs inside an internally managed Tokio runtime. By passing
    /// an opaque [`HttpCancelHandle`], the caller can immediately abort this
    /// synchronous initialization block if the remote server hangs or is unresponsive during
    /// TCP connection, TLS handshake, or while waiting for response headers.
    ///
    /// # Arguments
    ///
    /// * `url` - The URL of the target remote audio stream.
    /// * `handle` - An opaque cancellation handle ([`HttpCancelHandle`]) or reference to it.
    ///
    /// # Errors
    ///
    /// Returns an error if:
    /// * The operation is canceled via the provided `handle` (returns [`HttpError::Cancelled`]).
    /// * The remote server returns an unsupported status or malformed range metadata.
    /// * A transport or connection error occurs during the initial network probe.
    pub fn new_with_cancel_handle(url: &str, handle: impl Into<HttpCancelHandle>) -> Result<Self> {
        Self::new_with_options_and_cancel_handle(url, HttpAudioSourceOptions::default(), handle)
    }

    pub fn new_with_options_and_cancel_flag(
        url: &str,
        options: HttpAudioSourceOptions,
        flag: Arc<AtomicBool>,
    ) -> Result<Self> {
        let cancel_handle = HttpCancelHandle::new();
        let (stop, thread) = spawn_cancel_bridge(flag.clone(), cancel_handle.clone());
        match Self::new_with_options_and_cancel_handle_owned(url, options, cancel_handle, true) {
            Ok(mut source) => {
                source.cancel_flag = Some(flag);
                source.cancel_bridge_stop = Some(stop);
                source.cancel_bridge_thread = Some(thread);
                Ok(source)
            }
            Err(err) => {
                stop_cancel_bridge(stop, Some(thread));
                Err(err)
            }
        }
    }

    pub fn new_with_options_and_cancel_handle(
        url: &str,
        options: HttpAudioSourceOptions,
        handle: impl Into<HttpCancelHandle>,
    ) -> Result<Self> {
        Self::new_with_options_and_cancel_handle_owned(url, options, handle.into(), false)
    }

    fn new_with_options_and_cancel_handle_owned(
        url: &str,
        options: HttpAudioSourceOptions,
        handle: HttpCancelHandle,
        owns_cancel_handle: bool,
    ) -> Result<Self> {
        let rt = Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .map_err(|e| HttpError::Transport(e.to_string()))?;

        let mut client_builder = Client::builder().connect_timeout(options.connect_timeout);
        if let Some(proxy_url) = options.proxy_url.as_deref() {
            let proxy = Proxy::all(proxy_url)
                .map_err(|err| HttpError::Transport(format!("invalid proxy url: {err}")))?;
            client_builder = client_builder.proxy(proxy);
        } else {
            // `None` means the application explicitly selected direct networking. Do not let
            // process-level HTTP_PROXY/HTTPS_PROXY environment variables override that choice.
            client_builder = client_builder.no_proxy();
        }
        let client = client_builder
            .build()
            .map_err(|e| HttpError::Transport(e.to_string()))?;

        let active_token = handle.token();
        let (content_length, range_supported, stream_end, body_reader) = rt.block_on(async {
            tokio::select! {
                res = Self::probe_stream(&client, url, options.recv_timeout) => res,

                () = active_token.cancelled() => {
                    Err(HttpError::Cancelled.into())
                }
            }
        })?;

        Ok(Self {
            url: url.to_string(),
            client,
            content_length,
            range_supported,
            current_pos: 0,
            body_reader: Some(body_reader),
            stream_end,
            reconnect_delay: Duration::ZERO,
            reconnect_total_delay: Duration::ZERO,
            cancel_handle: handle,
            owns_cancel_handle,
            cancel_flag: None,
            active_token,
            cancel_bridge_stop: None,
            cancel_bridge_thread: None,
            recv_timeout: options.recv_timeout,
            rt: Some(rt),
        })
    }

    /// Injects EchoMusic's legacy atomic interrupt flag after initialization.
    #[must_use]
    pub fn with_cancel_flag(mut self, flag: Arc<AtomicBool>) -> Self {
        self.stop_cancel_bridge();
        let (stop, thread) = spawn_cancel_bridge(flag.clone(), self.cancel_handle.clone());
        self.cancel_flag = Some(flag);
        self.cancel_bridge_stop = Some(stop);
        self.cancel_bridge_thread = Some(thread);
        self
    }

    fn sync_cancel_state(&mut self) {
        let Some(flag) = self.cancel_flag.as_ref() else {
            return;
        };
        let cancel_requested = flag.load(Ordering::Acquire);
        if cancel_requested == self.active_token.is_cancelled() {
            return;
        }
        if cancel_requested {
            self.cancel_handle.cancel();
        } else {
            self.cancel_handle.reset();
        }
        self.refresh_active_token();
    }

    fn refresh_active_token(&mut self) -> CancellationToken {
        self.active_token = self.cancel_handle.token();
        self.active_token.clone()
    }

    fn cancel_token(&mut self) -> CancellationToken {
        if self.active_token.is_cancelled() {
            self.refresh_active_token();
        }
        self.active_token.clone()
    }

    fn discard_completed_range(&mut self) -> bool {
        if self.range_supported
            && self.body_reader.is_some()
            && self
                .stream_end
                .is_some_and(|stream_end| self.current_pos >= stream_end)
        {
            self.body_reader = None;
            return true;
        }
        false
    }

    async fn probe_stream(
        client: &Client,
        url: &str,
        recv_timeout: Duration,
    ) -> Result<(Option<u64>, bool, Option<u64>, AsyncReader)> {
        let response = tokio::time::timeout(
            recv_timeout,
            client
                .get(url)
                .header(header::USER_AGENT, USER_AGENT)
                .header(header::RANGE, "bytes=0-")
                .send(),
        )
        .await
        .map_err(|_| HttpError::Timeout)?
        .map_err(|e| HttpError::Transport(e.to_string()))?;

        let (content_length, range_supported, stream_end) = match response.status() {
            StatusCode::PARTIAL_CONTENT => {
                let content_range = Self::parse_and_validate_content_range(&response, 0, None)?;
                (
                    content_range.total,
                    true,
                    Some(content_range.end.saturating_add(1)),
                )
            }
            StatusCode::OK => {
                let content_length = response.content_length();
                (content_length, false, content_length)
            }
            status => return Err(HttpError::Status(status.as_u16()).into()),
        };

        #[cfg(feature = "tracing")]
        tracing::info!("Probing successful. Stream length: {content_length:?} bytes.");

        let stream = response.bytes_stream().map_err(io::Error::other);
        let reader: AsyncReader = Box::pin(StreamReader::new(stream));

        Ok((content_length, range_supported, stream_end, reader))
    }

    fn parse_content_range(value: &str) -> Option<ContentRange> {
        let (unit, range_and_total) = value.trim().split_once(' ')?;
        if unit != "bytes" {
            return None;
        }
        let (range, total) = range_and_total.split_once('/')?;
        let (start, end) = range.split_once('-')?;
        let start = start.parse().ok()?;
        let end = end.parse().ok()?;
        let total = if total == "*" {
            None
        } else {
            Some(total.parse().ok()?)
        };
        (start <= end).then_some(ContentRange { start, end, total })
    }

    fn validate_content_range(
        range: ContentRange,
        expected_start: u64,
        expected_total: Option<u64>,
    ) -> std::result::Result<ContentRange, HttpError> {
        if range.start != expected_start {
            return Err(HttpError::InvalidContentRange(format!(
                "range starts at {}, expected {expected_start}",
                range.start
            )));
        }
        let effective_total = range.total.or(expected_total);
        if let Some(total) = effective_total
            && range.end >= total
        {
            return Err(HttpError::InvalidContentRange(format!(
                "range ends at {}, total length is {total}",
                range.end
            )));
        }
        if let (Some(expected_total), Some(actual_total)) = (expected_total, range.total)
            && actual_total != expected_total
        {
            return Err(HttpError::InvalidContentRange(format!(
                "total length is {actual_total}, expected {expected_total}"
            )));
        }
        Ok(range)
    }

    fn parse_and_validate_content_range(
        response: &reqwest::Response,
        expected_start: u64,
        expected_total: Option<u64>,
    ) -> std::result::Result<ContentRange, HttpError> {
        let value = response
            .headers()
            .get(header::CONTENT_RANGE)
            .ok_or_else(|| HttpError::InvalidContentRange("missing Content-Range header".into()))?
            .to_str()
            .map_err(|_| HttpError::InvalidContentRange("invalid header encoding".into()))?;
        let range = Self::parse_content_range(value)
            .ok_or_else(|| HttpError::InvalidContentRange("missing or malformed header".into()))?;
        Self::validate_content_range(range, expected_start, expected_total)
    }

    async fn execute_seek_request(&self, target_pos: u64) -> FetchAction {
        if target_pos != 0 && !self.range_supported {
            return FetchAction::Fatal(HttpError::UnsupportedRange);
        }
        let range_header = format!("bytes={target_pos}-");
        let result = match tokio::time::timeout(
            self.recv_timeout,
            self.client
                .get(&self.url)
                .header(header::USER_AGENT, USER_AGENT)
                .header(header::RANGE, range_header)
                .send(),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => return FetchAction::Retry(None),
        };

        match result {
            Ok(resp) => {
                let status = resp.status();

                match status {
                    StatusCode::PARTIAL_CONTENT => {
                        let content_range = match Self::parse_and_validate_content_range(
                            &resp,
                            target_pos,
                            self.content_length,
                        ) {
                            Ok(range) => range,
                            Err(error) => return FetchAction::Fatal(error),
                        };

                        let stream = resp.bytes_stream().map_err(io::Error::other);
                        let reader: AsyncReader = Box::pin(StreamReader::new(stream));

                        FetchAction::Success(reader, Some(content_range.end.saturating_add(1)))
                    }
                    _ if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() => {
                        let delay = resp
                            .headers()
                            .get(header::RETRY_AFTER)
                            .and_then(|h| h.to_str().ok())
                            .and_then(|s| s.trim().parse::<u64>().ok())
                            .map(Duration::from_secs);

                        #[cfg(feature = "tracing")]
                        if let Some(d) = delay {
                            tracing::info!("Server requested Retry-After: {}s", d.as_secs());
                        } else {
                            tracing::warn!(
                                "Server error HTTP {}. Tagged for retry.",
                                status.as_u16()
                            );
                        }

                        FetchAction::Retry(delay)
                    }
                    StatusCode::OK if target_pos == 0 => {
                        let stream_end = resp.content_length();
                        let stream = resp.bytes_stream().map_err(io::Error::other);
                        FetchAction::Success(Box::pin(StreamReader::new(stream)), stream_end)
                    }
                    StatusCode::OK => FetchAction::Fatal(HttpError::UnsupportedRange),
                    _ if status.is_client_error() => {
                        #[cfg(feature = "tracing")]
                        tracing::error!("Fatal client error: HTTP {}", status.as_u16());

                        FetchAction::Fatal(HttpError::Status(status.as_u16()))
                    }
                    _ => FetchAction::Fatal(HttpError::Status(status.as_u16())),
                }
            }

            #[allow(unused_variables)]
            Err(e) => {
                #[cfg(feature = "tracing")]
                tracing::warn!("Transport error during seek request: {e}. Tagged for retry.");

                FetchAction::Retry(None)
            }
        }
    }

    async fn execute_reconnect_request(
        &self,
        target_pos: u64,
    ) -> Result<(AsyncReader, Option<u64>)> {
        let mut request = self
            .client
            .get(&self.url)
            .header(header::USER_AGENT, USER_AGENT);
        if self.range_supported {
            request = request.header(header::RANGE, format!("bytes={target_pos}-"));
        }
        let response = request
            .send()
            .await
            .map_err(|e| HttpError::Transport(e.to_string()))?;

        if !self.range_supported {
            if self.content_length.is_none() && response.status() == StatusCode::OK {
                let stream = response.bytes_stream().map_err(io::Error::other);
                return Ok((Box::pin(StreamReader::new(stream)), None));
            }
            return Err(HttpError::Status(response.status().as_u16()).into());
        }

        if response.status() != StatusCode::PARTIAL_CONTENT {
            return Err(if response.status() == StatusCode::OK {
                HttpError::UnsupportedRange.into()
            } else {
                HttpError::Status(response.status().as_u16()).into()
            });
        }

        let content_range =
            Self::parse_and_validate_content_range(&response, target_pos, self.content_length)?;

        let stream = response.bytes_stream().map_err(io::Error::other);
        let reader: AsyncReader = Box::pin(StreamReader::new(stream));

        Ok((reader, Some(content_range.end.saturating_add(1))))
    }

    async fn wait_for_reconnect(&mut self) -> io::Result<()> {
        loop {
            let next_delay = next_reconnect_delay(self.reconnect_delay)?;

            if next_delay > MAX_RECONNECT_DELAY
                || self
                    .reconnect_total_delay
                    .checked_add(next_delay)
                    .is_none_or(|delay| delay > MAX_RECONNECT_TOTAL_DELAY)
            {
                return Err(Error::other("HTTP reconnect timeout"));
            }

            self.reconnect_delay = next_delay;
            self.reconnect_total_delay += next_delay;

            let target_pos = self.current_pos;
            let cancel_token = self.cancel_token();
            tokio::select! {
                () = tokio::time::sleep(next_delay) => {},
                () = cancel_token.cancelled() => {
                    return Err(Error::new(ErrorKind::Interrupted, "Cancelled"));
                }
            }

            let result = tokio::select! {
                result = tokio::time::timeout(
                    self.recv_timeout,
                    self.execute_reconnect_request(target_pos),
                ) => result
                    .map_err(|_| Error::new(ErrorKind::TimedOut, "Reconnect request timeout"))
                    .and_then(|result| result.map_err(io::Error::from)),
                () = cancel_token.cancelled() => {
                    return Err(Error::new(ErrorKind::Interrupted, "Cancelled"));
                }
            };

            match result {
                Ok((reader, stream_end)) => {
                    self.body_reader = Some(reader);
                    self.stream_end = stream_end;
                    return Ok(());
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => return Err(error),
                Err(_) => continue,
            }
        }
    }

    async fn hard_seek_with_retry(&mut self, target_pos: u64) -> Result<()> {
        self.body_reader = None;

        if self
            .content_length
            .is_some_and(|content_length| target_pos >= content_length)
        {
            self.current_pos = target_pos;
            return Ok(());
        }

        let cancel_token = self.cancel_token();
        let mut retry_policy = RetryPolicy::new(cancel_token.clone());

        loop {
            if cancel_token.is_cancelled() {
                return Err(HttpError::Cancelled.into());
            }

            match self.execute_seek_request(target_pos).await {
                FetchAction::Success(reader, stream_end) => {
                    self.body_reader = Some(reader);
                    self.stream_end = stream_end;
                    self.current_pos = target_pos;
                    self.reconnect_delay = Duration::ZERO;
                    self.reconnect_total_delay = Duration::ZERO;
                    return Ok(());
                }
                FetchAction::Fatal(err) => {
                    return Err(err.into());
                }
                FetchAction::Retry(custom_delay) => {
                    retry_policy.wait_next(custom_delay).await?;
                }
            }
        }
    }
}

struct RetryPolicy {
    attempt: u32,
    max_retries: u32,
    max_retry_delay: Duration,
    cancel_token: CancellationToken,
}

impl RetryPolicy {
    const fn new(cancel_token: CancellationToken) -> Self {
        Self {
            attempt: 0,
            max_retries: MAX_RETRIES,
            max_retry_delay: MAX_RETRY_DELAY,
            cancel_token,
        }
    }

    async fn wait_next(&mut self, custom_delay: Option<Duration>) -> Result<()> {
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

        tokio::select! {
            () = tokio::time::sleep(wait_time) => Ok(()),
            () = self.cancel_token.cancelled() => Err(HttpError::Cancelled.into()),
        }
    }
}

impl Read for HttpAudioSource {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.sync_cancel_state();
        if self
            .content_length
            .is_some_and(|content_length| self.current_pos >= content_length)
            || buf.is_empty()
        {
            return Ok(0);
        }

        loop {
            let cancel_token = self.cancel_token();
            let rt_handle = self
                .rt
                .as_ref()
                .ok_or_else(|| Error::other("HTTP runtime is shut down"))?
                .handle()
                .clone();

            // A server may legally cap `bytes=N-` to a finite response segment. Reopen the next
            // segment immediately; this is a normal boundary, not a failed transfer.
            self.discard_completed_range();

            if self.body_reader.is_none() {
                let target_pos = self.current_pos;
                let token = cancel_token.clone();

                rt_handle.block_on(async {
                    tokio::select! {
                        res = self.hard_seek_with_retry(target_pos) => res.map_err(io::Error::from),
                        () = token.cancelled() => Err(Error::new(ErrorKind::Interrupted, "Cancelled")),
                    }
                })?;

                if self.body_reader.is_none() {
                    return Ok(0);
                }
            }

            let reader = self.body_reader.as_mut().unwrap();
            let read_buf_len = self.stream_end.map_or(buf.len(), |stream_end| {
                std::cmp::min(
                    stream_end.saturating_sub(self.current_pos),
                    buf.len() as u64,
                ) as usize
            });
            let recv_timeout = self.recv_timeout;

            let read_result = rt_handle.block_on(async {
                tokio::select! {
                    res = tokio::time::timeout(recv_timeout, reader.read(&mut buf[..read_buf_len])) => {
                        res.unwrap_or_else(|_| Err(Error::new(ErrorKind::TimedOut, "Stream read timeout")))
                    }
                    () = cancel_token.cancelled() => {
                        Err(Error::new(ErrorKind::Interrupted, "Cancelled"))
                    }
                }
            });

            match read_result {
                Ok(0) => {
                    if !self.range_supported {
                        return Ok(0);
                    }
                    if self
                        .stream_end
                        .is_some_and(|stream_end| self.current_pos < stream_end)
                    {
                        #[cfg(feature = "tracing")]
                        tracing::warn!(
                            "Premature EOF at offset {} (expected {}). Reconnecting...",
                            self.current_pos,
                            self.stream_end.unwrap_or(self.current_pos)
                        );
                    }

                    if self
                        .content_length
                        .is_some_and(|content_length| self.current_pos >= content_length)
                    {
                        return Ok(0);
                    }

                    self.body_reader = None;
                    rt_handle.block_on(self.wait_for_reconnect())?;
                }
                Ok(n) => {
                    self.current_pos += n as u64;
                    self.reconnect_delay = Duration::ZERO;
                    self.reconnect_total_delay = Duration::ZERO;
                    return Ok(n);
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => {
                    return Err(e);
                }
                #[allow(unused_variables)]
                Err(e) => {
                    if !self.range_supported && self.content_length.is_some() {
                        return Err(e);
                    }
                    #[cfg(feature = "tracing")]
                    tracing::warn!(
                        "Network read error at offset {}: {}. Reconnecting...",
                        self.current_pos,
                        e
                    );

                    self.body_reader = None;
                    rt_handle.block_on(self.wait_for_reconnect())?;
                }
            }
        }
    }
}

impl HttpAudioSource {
    fn stop_cancel_bridge(&mut self) {
        if let Some(stop) = self.cancel_bridge_stop.take() {
            stop_cancel_bridge(stop, self.cancel_bridge_thread.take());
        }
    }
}

impl Drop for HttpAudioSource {
    fn drop(&mut self) {
        self.stop_cancel_bridge();
        if self.owns_cancel_handle {
            self.cancel_handle.cancel();
        }
        self.body_reader = None;
        if let Some(rt) = self.rt.take() {
            rt.shutdown_timeout(RUNTIME_SHUTDOWN_TIMEOUT);
        }
    }
}

fn spawn_cancel_bridge(
    flag: Arc<AtomicBool>,
    handle: HttpCancelHandle,
) -> (Arc<AtomicBool>, JoinHandle<()>) {
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let thread = thread::Builder::new()
        .name("ffmpeg-audio-cancel-bridge".to_string())
        .spawn(move || {
            while !thread_stop.load(Ordering::Acquire) {
                let cancel_requested = flag.load(Ordering::Acquire);
                let cancelled = handle.is_cancelled();
                if cancel_requested && !cancelled {
                    handle.cancel();
                } else if !cancel_requested && cancelled {
                    handle.reset();
                }
                thread::sleep(CANCEL_BRIDGE_POLL);
            }
        })
        .expect("failed to spawn ffmpeg audio cancel bridge");
    (stop, thread)
}

fn stop_cancel_bridge(stop: Arc<AtomicBool>, thread: Option<JoinHandle<()>>) {
    stop.store(true, Ordering::Release);
    if let Some(thread) = thread {
        let _ = thread.join();
    }
}

impl Seek for HttpAudioSource {
    /// Seeks to an offset in bytes.
    ///
    /// Note on Seek Strategy:
    ///
    /// Implementing a lazy seek (deferring HTTP Range requests until the next `read()`)
    /// might improve performance.
    ///
    /// However, to strictly match FFmpeg's internal protocol behavior (where `http_seek`
    /// immediately attempts reconnection and returns exact I/O results to the demuxer), we
    /// perform a synchronous, immediate seek here.
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.sync_cancel_state();
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
                let content_length = self.content_length.ok_or_else(|| {
                    Error::new(
                        ErrorKind::Unsupported,
                        "Cannot seek from end on a stream with unknown length",
                    )
                })?;
                let new_pos = content_length.cast_signed() + offset;
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

            if delta <= SHORT_SEEK_THRESHOLD && self.body_reader.is_some() {
                #[cfg(feature = "tracing")]
                tracing::debug!(
                    "Soft-seeking to offset {target_pos} by draining {delta} remaining byte(s)",
                );

                let mut discard_buf = [0u8; 4096];
                let mut remaining = delta;
                let mut soft_seek_success = true;

                while remaining > 0 {
                    let to_read = std::cmp::min(remaining, discard_buf.len() as u64) as usize;
                    match self.read(&mut discard_buf[..to_read]) {
                        Ok(0) => {
                            soft_seek_success = false;
                            break;
                        }
                        Ok(n) => {
                            remaining -= n as u64;
                        }
                        Err(e) if e.kind() == ErrorKind::Interrupted => {
                            return Err(e);
                        }
                        Err(_) => {
                            soft_seek_success = false;
                            break;
                        }
                    }
                }

                if soft_seek_success {
                    return Ok(target_pos);
                }

                #[cfg(feature = "tracing")]
                tracing::warn!("Soft seek failed. Falling back to hard seek.");
            }
        }

        if !self.range_supported && target_pos != 0 {
            return Err(Error::new(
                ErrorKind::Unsupported,
                "Server does not support byte-range seeking",
            ));
        }

        let rt_handle = self
            .rt
            .as_ref()
            .ok_or_else(|| Error::other("HTTP runtime is shut down"))?
            .handle()
            .clone();
        let cancel_token = self.cancel_token();

        rt_handle.block_on(async {
            tokio::select! {
                res = self.hard_seek_with_retry(target_pos) => res.map_err(io::Error::from),
                () = cancel_token.cancelled() => Err(Error::new(ErrorKind::Interrupted, "Cancelled")),
            }
        })?;

        Ok(target_pos)
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;
    use std::{
        io::{Read, Seek, SeekFrom},
        net::TcpListener,
        sync::mpsc::sync_channel,
        thread,
        time::Instant,
    };

    use super::*;
    use crate::{AudioError, error::HttpError::Cancelled};

    const TEST_URL: &str = "http://localhost:8000/test.mp3";
    const CHAOS_URL: &str = "http://localhost:8000/chaos.mp3";
    const BLOCKHOLE_URL: &str = "http://192.0.2.1/test.mp3";

    fn local_options(recv_timeout: Duration) -> HttpAudioSourceOptions {
        HttpAudioSourceOptions {
            connect_timeout: Duration::from_secs(1),
            recv_timeout,
            proxy_url: None,
        }
    }

    fn test_source(
        content_length: Option<u64>,
        range_supported: bool,
        stream_end: Option<u64>,
        body_reader: Option<AsyncReader>,
    ) -> HttpAudioSource {
        let cancel_handle = HttpCancelHandle::new();
        HttpAudioSource {
            url: "http://localhost/dummy.mp3".to_string(),
            client: Client::builder().no_proxy().build().unwrap(),
            content_length,
            range_supported,
            current_pos: 0,
            body_reader,
            stream_end,
            reconnect_delay: Duration::ZERO,
            reconnect_total_delay: Duration::ZERO,
            cancel_handle: cancel_handle.clone(),
            owns_cancel_handle: true,
            cancel_flag: None,
            active_token: cancel_handle.token(),
            cancel_bridge_stop: None,
            cancel_bridge_thread: None,
            recv_timeout: RECV_TIMEOUT,
            rt: Some(
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(1)
                    .enable_all()
                    .build()
                    .unwrap(),
            ),
        }
    }

    fn serve_responses(listener: TcpListener, responses: Vec<&'static [u8]>) -> JoinHandle<()> {
        thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0u8; 2048];
                let _ = stream.read(&mut request);
                stream.write_all(response).unwrap();
            }
        })
    }

    #[test]
    #[ignore = "A network connection is required. Use tests/server.go to set up the mock server."]
    fn test_basic_read_and_seek() {
        let mut source = HttpAudioSource::new(TEST_URL).unwrap();

        let total_length = source
            .content_length
            .expect("range test source should have a known length");
        assert!(total_length > 1024 * 1024, "File too small for testing");

        let mut buf1 = vec![0u8; 100];
        let n = source.read(&mut buf1).unwrap();
        assert_eq!(n, 100);
        assert_eq!(source.current_pos, 100);

        for (i, &byte) in buf1.iter().enumerate() {
            assert_eq!(
                byte,
                (i % 256) as u8,
                "Data mismatch at initial read offset {i}"
            );
        }

        let new_pos = source.seek(SeekFrom::Current(1000)).unwrap();
        assert_eq!(new_pos, 1100);
        assert_eq!(source.current_pos, 1100);

        let mut buf2 = vec![0u8; 10];
        let n = source.read(&mut buf2).unwrap();
        assert_eq!(n, 10);

        for (i, &byte) in buf2.iter().enumerate() {
            assert_eq!(
                byte,
                ((1100 + i) % 256) as u8,
                "Data mismatch after soft seek at offset {}",
                1100 + i
            );
        }

        let rewind_pos = source.seek(SeekFrom::Start(50)).unwrap();
        assert_eq!(rewind_pos, 50);

        let mut buf3 = vec![0u8; 10];
        let n = source.read(&mut buf3).unwrap();
        assert_eq!(n, 10);

        for (i, &byte) in buf3.iter().enumerate() {
            assert_eq!(
                byte,
                ((50 + i) % 256) as u8,
                "Data mismatch after hard seek at offset {}",
                50 + i
            );
        }

        source.seek(SeekFrom::End(0)).unwrap();
        let mut eof_buf = vec![0u8; 10];
        let eof_n = source.read(&mut eof_buf).unwrap();
        assert_eq!(eof_n, 0, "Should return 0 at EOF");
    }

    #[test]
    fn test_instant_cancellation() {
        let cancel_handle = HttpCancelHandle::new();
        let cancel_handle_clone = cancel_handle.clone();

        let handle = thread::spawn(move || {
            HttpAudioSource::new_with_cancel_handle(BLOCKHOLE_URL, cancel_handle_clone)
        });

        thread::sleep(Duration::from_millis(100));

        let cancel_start_time = Instant::now();

        cancel_handle.cancel();

        let result = handle.join().unwrap();

        let elapsed = cancel_start_time.elapsed();

        assert!(
            elapsed < Duration::from_millis(50),
            "Cancellation took too long! Elapsed: {elapsed:?}"
        );

        match result {
            Err(e) => {
                assert!(
                    matches!(e, AudioError::Http(Cancelled)),
                    "Expected cancellation error, got: {e:?}"
                );
            }
            Ok(_) => panic!("Should not have successfully connected to a black hole!"),
        }
    }

    #[test]
    #[ignore = "A network connection is required. Use tests/server.go to set up the mock server."]
    fn test_retry_on_503() {
        let start_time = Instant::now();

        let mut source = HttpAudioSource::new(CHAOS_URL).unwrap();

        let seek_pos = source.seek(SeekFrom::Start(100_000)).unwrap();
        assert_eq!(seek_pos, 100_000);

        let mut buf = vec![0u8; 10];
        let n = source.read(&mut buf).unwrap();
        assert_eq!(n, 10);

        for (i, &byte) in buf.iter().enumerate() {
            assert_eq!(byte, ((100_000 + i) % 256) as u8);
        }

        let elapsed = start_time.elapsed();

        assert!(
            elapsed >= Duration::from_secs(2),
            "Should have retried twice and waited at least 2 seconds, elapsed: {elapsed:?}"
        );
    }

    #[test]
    fn test_read_zero_buffer() {
        let cancel_handle = HttpCancelHandle::new();
        let mut source = HttpAudioSource {
            url: "http://localhost/dummy.mp3".to_string(),
            client: Client::new(),
            content_length: Some(1024),
            range_supported: true,
            current_pos: 0,
            body_reader: None,
            stream_end: Some(0),
            reconnect_delay: Duration::ZERO,
            reconnect_total_delay: Duration::ZERO,
            cancel_handle: cancel_handle.clone(),
            owns_cancel_handle: true,
            cancel_flag: None,
            active_token: cancel_handle.token(),
            cancel_bridge_stop: None,
            cancel_bridge_thread: None,
            recv_timeout: RECV_TIMEOUT,
            rt: Some(
                tokio::runtime::Builder::new_current_thread()
                    .build()
                    .unwrap(),
            ),
        };

        let mut empty_buf = [0u8; 0];
        let res = source.read(&mut empty_buf);

        assert!(res.is_ok(), "read(0) must return Ok(0)");
        assert_eq!(res.unwrap(), 0);
        assert_eq!(source.current_pos, 0, "read(0) must not modify current_pos");
        assert!(
            source.body_reader.is_none(),
            "read(0) must not initialize or reset body_reader"
        );
    }

    #[test]
    fn probe_accepts_chunked_stream_without_content_length() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/stream", listener.local_addr().unwrap());
        let server = serve_responses(
            listener,
            vec![b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\ntest\r\n0\r\n\r\n"],
        );

        let mut source =
            HttpAudioSource::new_with_options(&url, local_options(Duration::from_secs(1))).unwrap();
        assert_eq!(source.content_length, None);
        assert!(!source.range_supported);

        let mut output = [0u8; 4];
        assert_eq!(source.read(&mut output).unwrap(), 4);
        assert_eq!(&output, b"test");
        assert_eq!(source.read(&mut output).unwrap(), 0);
        assert_eq!(
            source.seek(SeekFrom::End(0)).unwrap_err().kind(),
            ErrorKind::Unsupported
        );
        server.join().unwrap();
    }

    #[test]
    fn probe_accepts_partial_content_with_unknown_total_length() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/unknown-total", listener.local_addr().unwrap());
        let server = serve_responses(
            listener,
            vec![b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-3/*\r\nContent-Length: 4\r\nConnection: close\r\n\r\ntest"],
        );

        let mut source =
            HttpAudioSource::new_with_options(&url, local_options(Duration::from_secs(1))).unwrap();
        assert_eq!(source.content_length, None);
        assert!(source.range_supported);

        let mut output = [0u8; 4];
        assert_eq!(source.read(&mut output).unwrap(), 4);
        assert_eq!(&output, b"test");
        server.join().unwrap();
    }

    #[test]
    fn unknown_total_partial_content_supports_chunked_body_and_range_seek() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/chunked-range", listener.local_addr().unwrap());
        let server = serve_responses(
            listener,
            vec![
                b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-3/*\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\ntest\r\n0\r\n\r\n",
                b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 1-3/*\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nest\r\n0\r\n\r\n",
            ],
        );

        let mut source =
            HttpAudioSource::new_with_options(&url, local_options(Duration::from_secs(1))).unwrap();
        assert_eq!(source.content_length, None);
        assert!(source.range_supported);

        let mut output = [0u8; 4];
        assert_eq!(source.read(&mut output).unwrap(), 4);
        assert_eq!(&output, b"test");

        assert_eq!(source.seek(SeekFrom::Start(1)).unwrap(), 1);
        assert_eq!(source.read(&mut output).unwrap(), 3);
        assert_eq!(&output[..3], b"est");
        server.join().unwrap();
    }

    #[test]
    fn sequential_unknown_length_stream_reconnects_after_transport_error() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/radio", listener.local_addr().unwrap());
        let server = serve_responses(
            listener,
            vec![
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\nab\r\n5\r\nx",
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\ncd\r\n0\r\n\r\n",
            ],
        );

        let mut source =
            HttpAudioSource::new_with_options(&url, local_options(Duration::from_secs(2))).unwrap();
        let mut output = [0u8; 2];
        let mut received = Vec::new();
        while received.len() < 5 {
            let count = source.read(&mut output).unwrap();
            assert!(count > 0);
            received.extend_from_slice(&output[..count]);
        }
        assert_eq!(&received, b"abxcd");
        server.join().unwrap();
    }

    #[test]
    fn finite_range_boundary_reopens_immediately_without_backoff() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/segmented", listener.local_addr().unwrap());
        let server = serve_responses(
            listener,
            vec![
                b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-3/8\r\nContent-Length: 4\r\nConnection: close\r\n\r\nabcd",
                b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 4-7/8\r\nContent-Length: 4\r\nConnection: close\r\n\r\nefgh",
            ],
        );

        let mut source =
            HttpAudioSource::new_with_options(&url, local_options(Duration::from_secs(1))).unwrap();
        let mut output = [0u8; 4];
        assert_eq!(source.read(&mut output).unwrap(), 4);
        assert_eq!(&output, b"abcd");

        let started = Instant::now();
        assert_eq!(source.read(&mut output).unwrap(), 4);
        assert_eq!(&output, b"efgh");
        assert!(started.elapsed() < Duration::from_millis(500));
        server.join().unwrap();
    }

    #[test]
    fn probe_response_headers_obey_receive_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/silent", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            thread::sleep(Duration::from_millis(200));
        });

        let started = Instant::now();
        let result =
            HttpAudioSource::new_with_options(&url, local_options(Duration::from_millis(30)));
        assert!(matches!(result, Err(AudioError::Http(HttpError::Timeout))));
        assert!(started.elapsed() < Duration::from_millis(150));
        server.join().unwrap();
    }

    #[test]
    fn seek_response_headers_obey_receive_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/silent-seek", listener.local_addr().unwrap());
        let (accepted_tx, accepted_rx) = sync_channel(1);
        let server = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_millis(300);
            while Instant::now() < deadline {
                match listener.accept() {
                    Ok((_stream, _)) => {
                        let _ = accepted_tx.send(());
                        thread::sleep(Duration::from_millis(200));
                        return;
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("seek timeout server failed: {error}"),
                }
            }
        });
        let mut source = test_source(Some(1_000), true, None, None);
        source.url = url;
        source.recv_timeout = Duration::from_millis(30);
        let handle = source.rt.as_ref().unwrap().handle().clone();

        let started = Instant::now();
        let action = handle.block_on(source.execute_seek_request(100));
        assert!(matches!(action, FetchAction::Retry(None)));
        assert!(started.elapsed() < Duration::from_millis(150));
        assert_eq!(accepted_rx.recv_timeout(Duration::from_millis(350)), Ok(()));
        server.join().unwrap();
    }

    #[test]
    fn drop_bounds_runtime_shutdown_when_blocking_work_cannot_be_cancelled() {
        let source = test_source(Some(1), true, None, None);
        source
            .rt
            .as_ref()
            .unwrap()
            .spawn_blocking(|| thread::sleep(Duration::from_secs(1)));

        let started = Instant::now();
        drop(source);
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "runtime drop exceeded its bounded shutdown budget: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn drop_does_not_cancel_an_externally_owned_handle() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/shared-cancel", listener.local_addr().unwrap());
        let server = serve_responses(
            listener,
            vec![b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx"],
        );
        let handle = HttpCancelHandle::new();
        let source = HttpAudioSource::new_with_options_and_cancel_handle(
            &url,
            local_options(Duration::from_secs(1)),
            handle.clone(),
        )
        .unwrap();

        drop(source);

        assert!(!handle.is_cancelled());
        server.join().unwrap();
    }

    #[test]
    fn test_shared_token_cancellation_and_reset() {
        let cancel_handle = HttpCancelHandle::new();

        assert!(!cancel_handle.is_cancelled());

        cancel_handle.cancel();
        assert!(cancel_handle.is_cancelled());

        cancel_handle.reset();
        assert!(
            !cancel_handle.is_cancelled(),
            "Reset token should restore uncancelled state"
        );
    }

    #[test]
    fn test_cancel_bridge_tracks_repeated_flag_changes() {
        fn wait_for_state(handle: &HttpCancelHandle, expected: bool) {
            let deadline = Instant::now() + Duration::from_millis(250);
            while Instant::now() < deadline {
                if handle.is_cancelled() == expected {
                    return;
                }
                thread::sleep(CANCEL_BRIDGE_POLL);
            }
            panic!("cancel bridge did not reach state {expected}");
        }

        let flag = Arc::new(AtomicBool::new(false));
        let handle = HttpCancelHandle::new();
        let (stop, bridge) = spawn_cancel_bridge(flag.clone(), handle.clone());

        flag.store(true, Ordering::Release);
        wait_for_state(&handle, true);
        flag.store(false, Ordering::Release);
        wait_for_state(&handle, false);
        flag.store(true, Ordering::Release);
        wait_for_state(&handle, true);

        stop_cancel_bridge(stop, Some(bridge));
    }

    #[test]
    fn test_seek_resets_cancelled_flag_bridge_state() {
        let flag = Arc::new(AtomicBool::new(false));
        let cancel_handle = HttpCancelHandle::new();
        cancel_handle.cancel();
        let mut source = HttpAudioSource {
            url: "http://localhost/dummy.mp3".to_string(),
            client: Client::new(),
            content_length: Some(1024),
            range_supported: true,
            current_pos: 0,
            body_reader: None,
            stream_end: Some(0),
            reconnect_delay: Duration::ZERO,
            reconnect_total_delay: Duration::ZERO,
            cancel_handle: cancel_handle.clone(),
            owns_cancel_handle: true,
            cancel_flag: Some(flag),
            active_token: cancel_handle.token(),
            cancel_bridge_stop: None,
            cancel_bridge_thread: None,
            recv_timeout: RECV_TIMEOUT,
            rt: Some(
                tokio::runtime::Builder::new_current_thread()
                    .build()
                    .unwrap(),
            ),
        };

        assert_eq!(source.seek(SeekFrom::Current(0)).unwrap(), 0);
        assert!(!cancel_handle.is_cancelled());
        assert!(!source.active_token.is_cancelled());
    }

    #[test]
    fn test_content_range_validation() {
        let valid = ContentRange {
            start: 100,
            end: 199,
            total: Some(1_000),
        };
        assert!(HttpAudioSource::validate_content_range(valid, 100, Some(1_000)).is_ok());

        let wrong_start = ContentRange { start: 99, ..valid };
        assert!(HttpAudioSource::validate_content_range(wrong_start, 100, Some(1_000)).is_err());

        let wrong_total = ContentRange {
            total: Some(2_000),
            ..valid
        };
        assert!(HttpAudioSource::validate_content_range(wrong_total, 100, Some(1_000)).is_err());

        let invalid_end = ContentRange {
            end: 1_000,
            ..valid
        };
        assert!(HttpAudioSource::validate_content_range(invalid_end, 100, Some(1_000)).is_err());

        let unknown_total = ContentRange {
            start: 100,
            end: 199,
            total: None,
        };
        assert!(HttpAudioSource::validate_content_range(unknown_total, 100, None).is_ok());
        assert!(HttpAudioSource::validate_content_range(unknown_total, 100, Some(1_000)).is_ok());
        assert_eq!(
            HttpAudioSource::parse_content_range("bytes 0-1023/*")
                .unwrap()
                .total,
            None
        );
    }

    #[test]
    fn test_reconnect_backoff_and_limits() {
        let mut delay = Duration::ZERO;
        let expected = [1, 3, 7, 15, 31, 63, 127];

        for seconds in expected {
            delay = next_reconnect_delay(delay).unwrap();
            assert_eq!(delay, Duration::from_secs(seconds));
        }

        assert!(delay > MAX_RECONNECT_DELAY);
        assert!(Duration::from_secs(1 + 3 + 7 + 15 + 31 + 63 + 127) < MAX_RECONNECT_TOTAL_DELAY);
        assert!(
            Duration::from_secs(1 + 3 + 7 + 15 + 31 + 63 + 127 + 255) > MAX_RECONNECT_TOTAL_DELAY
        );
    }
}
