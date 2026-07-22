use super::{ReadSeek, StreamOptions};
use ffmpeg_audio::{HttpAudioSource, HttpAudioSourceOptions};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

pub fn is_http_url(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

pub fn open(
    url: &str,
    interrupt: Arc<AtomicBool>,
    options: &StreamOptions,
) -> Result<Box<dyn ReadSeek>, String> {
    HttpAudioSource::new_with_options(
        url,
        HttpAudioSourceOptions {
            connect_timeout: connect_timeout(options.network_timeout),
            recv_timeout: options.network_timeout,
            proxy_url: options.http_proxy.clone(),
        },
    )
    .map(|source| Box::new(source.with_cancel_flag(interrupt)) as Box<dyn ReadSeek>)
    .map_err(|err| format!("failed to open network audio source: {err}"))
}

fn connect_timeout(network_timeout: Duration) -> Duration {
    network_timeout.min(Duration::from_secs(10))
}
