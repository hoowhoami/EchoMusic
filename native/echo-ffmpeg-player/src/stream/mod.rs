mod file;
mod http;
mod url;

use std::io::{Read, Seek};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

pub trait ReadSeek: Read + Seek + Send {}

impl<T> ReadSeek for T where T: Read + Seek + Send {}

#[derive(Clone, Debug)]
pub struct StreamOptions {
    pub network_timeout: Duration,
    pub http_proxy: Option<String>,
}

impl Default for StreamOptions {
    fn default() -> Self {
        Self {
            network_timeout: Duration::from_secs(60),
            http_proxy: None,
        }
    }
}

pub fn open_stream(
    url: &str,
    interrupt: Arc<AtomicBool>,
    options: &StreamOptions,
) -> Result<Box<dyn ReadSeek>, String> {
    if http::is_http_url(url) {
        return http::open(url, interrupt, options);
    }
    file::open(url)
}
