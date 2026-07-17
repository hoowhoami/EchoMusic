use ffmpeg_audio::HttpAudioSource;
use std::fs::File;
use std::io::{Read, Seek};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

pub trait ReadSeek: Read + Seek + Send {}

impl<T> ReadSeek for T where T: Read + Seek + Send {}

pub fn open_source(url: &str, interrupt: Arc<AtomicBool>) -> Result<Box<dyn ReadSeek>, String> {
    if url.starts_with("http://") || url.starts_with("https://") {
        return HttpAudioSource::new(url)
            .map(|source| Box::new(source.with_cancel_flag(interrupt)) as Box<dyn ReadSeek>)
            .map_err(|err| format!("failed to open network audio source: {err}"));
    }

    let path = if let Some(stripped) = url.strip_prefix("file://") {
        percent_decode_file_url(stripped)
    } else {
        PathBuf::from(url)
    };
    File::open(&path)
        .map(|file| Box::new(file) as Box<dyn ReadSeek>)
        .map_err(|err| format!("failed to open audio source '{}': {err}", path.display()))
}

fn percent_decode_file_url(value: &str) -> PathBuf {
    let mut out = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&value[i + 1..i + 3], 16) {
                out.push(hex);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    PathBuf::from(String::from_utf8_lossy(&out).into_owned())
}
