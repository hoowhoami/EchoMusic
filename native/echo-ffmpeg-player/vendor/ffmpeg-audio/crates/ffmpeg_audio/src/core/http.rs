use std::{
    io::{
        self,
        Error,
        ErrorKind,
        Read,
        Seek,
        SeekFrom,
    },
    pin::Pin,
    sync::{
        atomic::{
            AtomicBool,
            Ordering,
        },
        Arc,
    },
    thread::{
        self,
        JoinHandle,
    },
    time::Duration,
};

use futures_util::TryStreamExt;
use reqwest::{
    Client,
    Proxy,
    StatusCode,
    header,
};
use tokio::{
    io::{
        AsyncRead,
        AsyncReadExt,
    },
    runtime::{
        Builder,
        Runtime,
    },
};
use tokio_util::{
    io::StreamReader,
    sync::CancellationToken,
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
const CANCEL_BRIDGE_POLL: Duration = Duration::from_millis(25);

type AsyncReader = Pin<Box<dyn AsyncRead + Send + Sync + 'static>>;

enum FetchAction {
    Success(AsyncReader),
    Retry(Option<Duration>),
    Fatal(HttpError),
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

/// An HTTP audio source that supports remote range requests and is compatible with `std::io::Read +
/// Seek`.
pub struct HttpAudioSource {
    /// The URL of the target audio stream.
    url: String,

    /// An internally reused HTTP client instance, managing the connection pool and timeout
    /// configuration.
    client: Client,

    /// The total size (in bytes) of the audio file, determined via server probing.
    content_length: u64,

    /// Tracks the current absolute byte offset within the file.
    current_pos: u64,

    /// The currently active HTTP body reader.
    /// This is set to `None` upon a large-span seek or an unrecoverable network error.
    body_reader: Option<AsyncReader>,

    /// Cancellation token passed in from the upper-layer application
    cancel_token: CancellationToken,

    /// Stops the optional AtomicBool-to-CancellationToken bridge.
    cancel_bridge_stop: Option<Arc<AtomicBool>>,

    /// Thread that maps EchoMusic's existing interrupt flag to the cancellation token.
    cancel_bridge_thread: Option<JoinHandle<()>>,

    /// Per-read timeout. EchoMusic feeds this from player network settings.
    recv_timeout: Duration,

    /// An isolated single-threaded Tokio runtime dedicated to driving current asynchronous network
    /// operations.
    rt: Runtime,
}

impl HttpAudioSource {
    /// Attempts to connect to and probe the target remote URL using a default cancellation token.
    ///
    /// Connection is permitted only if the server explicitly supports HTTP Range requests
    /// and provides a determinate content length.
    ///
    /// This is a convenience constructor that delegates to [`Self::new_with_token`] with a newly
    /// created, non-canceled [`CancellationToken`].
    ///
    /// # Arguments
    ///
    /// * `url` - The URL of the target remote audio stream.
    ///
    /// # Errors
    ///
    /// Returns an error if:
    /// * The remote server does not support HTTP Range requests (fails to return HTTP 206).
    /// * The total stream length cannot be determined from the headers.
    /// * A transport or connection error occurs during the initial network probe.
    pub fn new(url: &str) -> Result<Self> {
        Self::new_with_options(url, HttpAudioSourceOptions::default())
    }

    pub fn new_with_options(url: &str, options: HttpAudioSourceOptions) -> Result<Self> {
        Self::new_with_options_and_token(url, options, CancellationToken::new())
    }

    /// Attempts to connect to and probe the target remote URL, allowing the initial connection
    /// and response probing phase to be interrupted.
    ///
    /// Connection is permitted only if the server explicitly supports HTTP Range requests
    /// and provides a determinate content length.
    ///
    /// The initial HTTP probe request runs inside an internally managed, single-threaded Tokio
    /// runtime. By passing a [`CancellationToken`], the caller can immediately abort this
    /// synchronous initialization block if the remote server hangs or is unresponsive during
    /// TCP connection, TLS handshake, or while waiting for response headers.
    ///
    /// # Arguments
    ///
    /// * `url` - The URL of the target remote audio stream.
    /// * `cancel_token` - A token used to interrupt the initialization probe as well as any
    ///   subsequent read or seek operations.
    ///
    /// # Errors
    ///
    /// Returns an error if:
    /// * The operation is canceled via the provided `cancel_token` (returns
    ///   [`HttpError::Cancelled`]).
    /// * The remote server does not support HTTP Range requests (fails to return HTTP 206).
    /// * The total stream length cannot be determined.
    /// * A transport or connection error occurs during the initial network probe.
    pub fn new_with_token(url: &str, cancel_token: CancellationToken) -> Result<Self> {
        Self::new_with_options_and_token(url, HttpAudioSourceOptions::default(), cancel_token)
    }

    pub fn new_with_options_and_cancel_flag(
        url: &str,
        options: HttpAudioSourceOptions,
        flag: Arc<AtomicBool>,
    ) -> Result<Self> {
        let cancel_token = CancellationToken::new();
        let (stop, thread) = spawn_cancel_bridge(flag, cancel_token.clone());
        match Self::new_with_options_and_token(url, options, cancel_token) {
            Ok(mut source) => {
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

    pub fn new_with_options_and_token(
        url: &str,
        options: HttpAudioSourceOptions,
        cancel_token: CancellationToken,
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
        }
        let client = client_builder
            .build()
            .map_err(|e| HttpError::Transport(e.to_string()))?;

        let (content_length, body_reader) = rt.block_on(async {
            tokio::select! {
                res = Self::probe_stream(&client, url) => res,

                () = cancel_token.cancelled() => {
                    Err(HttpError::Cancelled.into())
                }
            }
        })?;

        Ok(Self {
            url: url.to_string(),
            client,
            content_length,
            current_pos: 0,
            body_reader: Some(body_reader),
            cancel_token,
            cancel_bridge_stop: None,
            cancel_bridge_thread: None,
            recv_timeout: options.recv_timeout,
            rt,
        })
    }

    /// Injects EchoMusic's legacy atomic interrupt flag after initialization.
    #[must_use]
    pub fn with_cancel_flag(mut self, flag: Arc<AtomicBool>) -> Self {
        self.stop_cancel_bridge();
        let (stop, thread) = spawn_cancel_bridge(flag, self.cancel_token.clone());
        self.cancel_bridge_stop = Some(stop);
        self.cancel_bridge_thread = Some(thread);
        self
    }

    async fn probe_stream(client: &Client, url: &str) -> Result<(u64, AsyncReader)> {
        let response = client
            .get(url)
            .header(header::USER_AGENT, USER_AGENT)
            .header(header::RANGE, "bytes=0-")
            .send()
            .await
            .map_err(|e| HttpError::Transport(e.to_string()))?;

        if response.status() != StatusCode::PARTIAL_CONTENT {
            return Err(HttpError::UnsupportedRange.into());
        }

        let content_length = Self::parse_total_length(&response).ok_or(HttpError::UnknownLength)?;

        #[cfg(feature = "tracing")]
        tracing::info!("Probing successful. Stream length: {content_length} bytes.");

        let stream = response.bytes_stream().map_err(io::Error::other);
        let reader: AsyncReader = Box::pin(StreamReader::new(stream));

        Ok((content_length, reader))
    }

    fn parse_total_length(response: &reqwest::Response) -> Option<u64> {
        if let Some(range_hdr) = response.headers().get(header::CONTENT_RANGE)
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

        if let Some(len_hdr) = response.headers().get(header::CONTENT_LENGTH)
            && let Ok(len_str) = len_hdr.to_str()
            && let Ok(total) = len_str.parse::<u64>()
        {
            return Some(total);
        }

        None
    }

    async fn execute_seek_request(&self, target_pos: u64) -> FetchAction {
        let range_header = format!("bytes={target_pos}-");
        let result = self
            .client
            .get(&self.url)
            .header(header::USER_AGENT, USER_AGENT)
            .header(header::RANGE, range_header)
            .send()
            .await;

        match result {
            Ok(resp) => {
                let status = resp.status();

                match status {
                    StatusCode::PARTIAL_CONTENT => {
                        let stream = resp.bytes_stream().map_err(io::Error::other);
                        let reader: AsyncReader = Box::pin(StreamReader::new(stream));

                        FetchAction::Success(reader)
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
                    StatusCode::OK if target_pos != 0 => {
                        FetchAction::Fatal(HttpError::UnsupportedRange)
                    }
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
                tracing::warn!("Transport error: {e}. Tagged for retry.");

                FetchAction::Retry(None)
            }
        }
    }

    async fn hard_seek_with_retry(&mut self, target_pos: u64) -> Result<()> {
        self.body_reader = None;

        if target_pos >= self.content_length {
            self.current_pos = target_pos;
            return Ok(());
        }

        let mut retry_policy = RetryPolicy::new(self.cancel_token.clone());

        loop {
            if self.cancel_token.is_cancelled() {
                return Err(HttpError::Cancelled.into());
            }

            match self.execute_seek_request(target_pos).await {
                FetchAction::Success(reader) => {
                    self.body_reader = Some(reader);
                    self.current_pos = target_pos;
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
        if self.current_pos >= self.content_length {
            return Ok(0);
        }

        let mut network_retried = false;

        loop {
            if self.body_reader.is_none() {
                let rt_handle = self.rt.handle().clone();
                let cancel_token = self.cancel_token.clone();
                let target_pos = self.current_pos;

                rt_handle.block_on(async {
                    tokio::select! {
                        res = self.hard_seek_with_retry(target_pos) => res.map_err(io::Error::from),
                        () = cancel_token.cancelled() => Err(Error::new(ErrorKind::Interrupted, "Cancelled")),
                    }
                })?;

                if self.body_reader.is_none() {
                    return Ok(0);
                }
            }

            let rt_handle = self.rt.handle().clone();
            let cancel_token = self.cancel_token.clone();
            let reader = self.body_reader.as_mut().unwrap();

            let read_result = rt_handle.block_on(async {
                tokio::select! {
                    res = tokio::time::timeout(self.recv_timeout, reader.read(buf)) => {
                        res.unwrap_or_else(|_| Err(Error::new(ErrorKind::TimedOut, "Stream read timeout")))
                    }
                    () = cancel_token.cancelled() => {
                        Err(Error::new(ErrorKind::Interrupted, "Cancelled"))
                    }
                }
            });

            match read_result {
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
                        network_retried = true;
                    } else {
                        return Ok(0);
                    }
                }
                Ok(n) => {
                    self.current_pos += n as u64;
                    return Ok(n);
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => {
                    return Err(e);
                }
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
                    network_retried = true;
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
    }
}

fn spawn_cancel_bridge(
    flag: Arc<AtomicBool>,
    token: CancellationToken,
) -> (Arc<AtomicBool>, JoinHandle<()>) {
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let thread = thread::Builder::new()
        .name("ffmpeg-audio-cancel-bridge".to_string())
        .spawn(move || {
            while !thread_stop.load(Ordering::Acquire) && !token.is_cancelled() {
                if flag.load(Ordering::Acquire) {
                    token.cancel();
                    break;
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

        let rt_handle = self.rt.handle().clone();
        let cancel_token = self.cancel_token.clone();

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
    use std::{
        io::{
            Read,
            Seek,
            SeekFrom,
        },
        thread,
        time::Instant,
    };

    use super::*;
    use crate::{
        AudioError,
        error::HttpError::Cancelled,
    };

    const TEST_URL: &str = "http://localhost:8000/test.mp3";
    const CHAOS_URL: &str = "http://localhost:8000/chaos.mp3";
    const BLOCKHOLE_URL: &str = "http://192.0.2.1/test.mp3";

    #[test]
    #[ignore = "A network connection is required. Use tests/server.go to set up the mock server."]
    fn test_basic_read_and_seek() {
        let mut source = HttpAudioSource::new(TEST_URL).unwrap();

        let total_length = source.content_length;
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
        let token = CancellationToken::new();
        let token_clone = token.clone();

        let handle =
            thread::spawn(move || HttpAudioSource::new_with_token(BLOCKHOLE_URL, token_clone));

        thread::sleep(Duration::from_millis(100));

        let cancel_start_time = Instant::now();

        token.cancel();

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
}
