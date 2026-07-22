use super::ReadSeek;
use ffmpeg_audio::HttpAudioSource;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

pub fn is_http_url(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

pub fn open(url: &str, interrupt: Arc<AtomicBool>) -> Result<Box<dyn ReadSeek>, String> {
    HttpAudioSource::new(url)
        .map(|source| Box::new(source.with_cancel_flag(interrupt)) as Box<dyn ReadSeek>)
        .map_err(|err| format!("failed to open network audio source: {err}"))
}
