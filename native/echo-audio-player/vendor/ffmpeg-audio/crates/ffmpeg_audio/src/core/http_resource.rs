//! A single HTTP client/runtime for one resource-oriented media input.
//! The blocking AVIO facade runs only on the demux worker; response bodies are
//! streamed and every network wait observes the input's interrupt flag.
use crate::{
    AudioError, HttpAudioSourceOptions, Result,
    decode::resource::{OpenedResource, ResourceOpener},
    error::HttpError,
};
use futures_util::TryStreamExt;
use reqwest::{Client, Proxy, StatusCode, header};
use std::{
    io::{self, Read, Seek, SeekFrom},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    runtime::{Builder, Runtime},
};
use tokio_util::io::StreamReader;

type Body = Pin<Box<dyn AsyncRead + Send + Sync>>;
pub struct HttpResourceSession {
    runtime: Option<Runtime>,
    client: Client,
    timeout: Duration,
    interrupt: Arc<AtomicBool>,
}
impl HttpResourceSession {
    pub fn new(options: HttpAudioSourceOptions, interrupt: Arc<AtomicBool>) -> Result<Arc<Self>> {
        let mut client = Client::builder().connect_timeout(options.connect_timeout);
        if let Some(proxy) = options.proxy_url {
            client =
                client.proxy(Proxy::all(proxy).map_err(|e| HttpError::Transport(e.to_string()))?);
        } else {
            client = client.no_proxy();
        }
        if let Some(agent) = options.user_agent.filter(|agent| !agent.is_empty()) {
            client = client.user_agent(agent);
        }
        // Redirect targets obey the same protocol boundary as nested resources.
        client = client.redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 10 {
                attempt.error("too many media redirects")
            } else if !matches!(attempt.url().scheme(), "http" | "https") {
                attempt.error("unsupported media redirect")
            } else {
                attempt.follow()
            }
        }));
        Ok(Arc::new(Self {
            runtime: Some(
                Builder::new_multi_thread()
                    .worker_threads(1)
                    .enable_all()
                    .build()?,
            ),
            client: client
                .build()
                .map_err(|e| HttpError::Transport(e.to_string()))?,
            timeout: options.recv_timeout,
            interrupt,
        }))
    }
    async fn cancelled(&self) {
        loop {
            if self.interrupt.load(Ordering::Acquire) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    fn open_inner(
        self: &Arc<Self>,
        url: &str,
        offset: u64,
        end: Option<u64>,
    ) -> Result<OpenedResource> {
        let parsed = reqwest::Url::parse(url)
            .map_err(|_| AudioError::InvalidParameter("Invalid media URL".into()))?;
        if !matches!(parsed.scheme(), "http" | "https") || end.is_some_and(|end| end <= offset) {
            return Err(AudioError::InvalidParameter(
                "Unsupported media resource".into(),
            ));
        }
        if self.interrupt.load(Ordering::Acquire) {
            return Err(HttpError::Cancelled.into());
        }
        self.runtime.as_ref().unwrap().block_on(async {
            let request = self.client.get(parsed);
            let request = if offset > 0 || end.is_some() {
                request.header(header::RANGE, format!("bytes={offset}-{}", end.map(|v| (v-1).to_string()).unwrap_or_default()))
            } else { request };
            let response = tokio::select! {
                () = self.cancelled() => return Err(HttpError::Cancelled.into()),
                result = tokio::time::timeout(self.timeout, request.send()) => result
                    .map_err(|_| HttpError::Timeout)?.map_err(|e| HttpError::Transport(e.to_string()))?,
            };
            if !response.status().is_success() { return Err(HttpError::Status(response.status().as_u16()).into()); }
            if (offset > 0 || end.is_some()) && response.status() != StatusCode::PARTIAL_CONTENT {
                return Err(HttpError::UnsupportedRange.into());
            }
            if response.status() == StatusCode::PARTIAL_CONTENT {
                let range = response.headers().get(header::CONTENT_RANGE).and_then(|v| v.to_str().ok()).unwrap_or_default();
                let bounds = range.strip_prefix("bytes ").and_then(|v| v.split_once('/'))
                    .and_then(|(bounds, _)| bounds.split_once('-'))
                    .and_then(|(start, last)| Some((start.parse::<u64>().ok()?, last.parse::<u64>().ok()?)));
                if !bounds.is_some_and(|(start, last)| start == offset && last >= start &&
                    last.checked_add(1).is_some_and(|limit| end.is_none_or(|end| limit == end)) &&
                    response.content_length().is_none_or(|length| length == last - start + 1)) {
                    return Err(HttpError::InvalidContentRange(range.to_string()).into());
                }
            }
            let effective_url = response.url().to_string();
            let length = response.content_length();
            let mut body: Body = Box::pin(StreamReader::new(response.bytes_stream().map_err(io::Error::other)));
            let mut prefix = Vec::with_capacity(8);
            while prefix.len() < 8 {
                let mut bytes = [0; 8];
                let count = tokio::select! {
                    () = self.cancelled() => return Err(HttpError::Cancelled.into()),
                    result = tokio::time::timeout(self.timeout, body.read(&mut bytes[..8 - prefix.len()])) =>
                        result.map_err(|_| HttpError::Timeout)??,
                };
                if count == 0 { break; }
                prefix.extend_from_slice(&bytes[..count]);
            }
            let is_playlist = prefix.starts_with(b"#EXTM3U");
            let body: Body = Box::pin(AsyncReadExt::chain(std::io::Cursor::new(prefix), body));
            Ok(OpenedResource { effective_url, is_playlist, source: Box::new(HttpResource {
                session: self.clone(), body, position: offset,
                end: end.or_else(|| length.map(|length| offset.saturating_add(length))),
            }) })
        })
    }
}
// The trait is implemented on Arc so each opened body owns the same session.
impl ResourceOpener for Arc<HttpResourceSession> {
    fn timeout(&self) -> Duration {
        self.timeout
    }
    fn open(&self, url: &str, offset: u64, end: Option<u64>) -> Result<OpenedResource> {
        self.open_inner(url, offset, end)
    }
}
impl Drop for HttpResourceSession {
    fn drop(&mut self) {
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_timeout(Duration::from_millis(200));
        }
    }
}
struct HttpResource {
    session: Arc<HttpResourceSession>,
    body: Body,
    position: u64,
    end: Option<u64>,
}
impl Read for HttpResource {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        let limit = self.end.map_or(bytes.len(), |end| {
            end.saturating_sub(self.position).min(bytes.len() as u64) as usize
        });
        if limit == 0 {
            return Ok(0);
        }
        let bytes = &mut bytes[..limit];
        let count = self.session.runtime.as_ref().unwrap().block_on(async {
            tokio::select! {
                () = self.session.cancelled() => Err(io::Error::new(io::ErrorKind::Interrupted, "Media input cancelled")),
                result = tokio::time::timeout(self.session.timeout, self.body.read(bytes)) =>
                    result.map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Media resource stalled"))?,
            }
        })?;
        if count == 0 && self.end.is_some_and(|end| self.position < end) {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Truncated media resource",
            ));
        }
        self.position += count as u64;
        Ok(count)
    }
}
impl Seek for HttpResource {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        // FFmpeg issues byte-range opens for HLS subresources. AVIO can seek in
        // its own small buffer; this sequential body never downloads a file to seek.
        let target = match from {
            SeekFrom::Start(value) => Some(value),
            SeekFrom::Current(value) => self.position.checked_add_signed(value),
            SeekFrom::End(0) => self.end,
            _ => None,
        };
        if let Some(target) = target.filter(|target| *target == self.position) {
            return Ok(target);
        }
        // AVSEEK_SIZE uses SeekFrom::End(0) and then restores the current cursor.
        if matches!(from, SeekFrom::End(0)) {
            return self
                .end
                .ok_or_else(|| io::Error::from(io::ErrorKind::Unsupported));
        }
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }
}
