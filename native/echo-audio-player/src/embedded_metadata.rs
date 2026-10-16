use ffmpeg_audio::AudioReader;
use napi::{Env, Task};
use napi_derive::napi;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

const MAX_COVER_BYTES: usize = 8 * 1024 * 1024;
const MAX_TEXT_CHARS: usize = 4096;

#[derive(Debug, Default, PartialEq)]
pub struct EmbeddedMetadata {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    lyric: Option<String>,
    cover: Option<Vec<u8>>,
}

#[napi(object)]
pub struct EmbeddedTrackMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub lyric: Option<String>,
    pub cover_file: Option<String>,
}

pub struct GetEmbeddedMetadataTask {
    pub(crate) seq: f64,
    pub(crate) cover_cache_dir: Option<String>,
}

impl Task for GetEmbeddedMetadataTask {
    type Output = Option<EmbeddedTrackMetadata>;
    type JsValue = Option<EmbeddedTrackMetadata>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let seq = self.seq;
        if !seq.is_finite() || seq <= 0.0 || seq.fract() != 0.0 {
            return Ok(None);
        }
        let snapshot =
            crate::dispatcher::call_core_command("get-embedded-metadata", move |runtime| {
                Ok(
                    if runtime.current_seq == seq as u64 && runtime.session.is_some() {
                        runtime.embedded_metadata.clone()
                    } else {
                        None
                    },
                )
            })?;
        // Only acquire the Arc on the audio dispatcher. Artwork hashing and disk I/O
        // run here on the N-API worker, never on the audio or Electron main thread.
        Ok(
            snapshot
                .map(|metadata| metadata.export(self.cover_cache_dir.as_deref().map(Path::new))),
        )
    }

    fn resolve(&mut self, _env: Env, snapshot: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(snapshot)
    }
}

impl EmbeddedMetadata {
    /// Only consume tags/artwork already read by FFmpeg. Never seek or probe here.
    pub(crate) fn from_reader(reader: &mut AudioReader) -> Arc<Self> {
        let tags = reader.metadata();
        let cover = reader.take_cover().and_then(|cover| {
            (!cover.data.is_empty() && cover.data.len() <= MAX_COVER_BYTES).then_some(cover.data)
        });
        Arc::new(Self {
            title: text(&tags, "title"),
            artist: text(&tags, "artist"),
            album: text(&tags, "album"),
            lyric: lyrics(&tags),
            cover,
        })
    }

    fn export(&self, cover_cache_dir: Option<&Path>) -> EmbeddedTrackMetadata {
        EmbeddedTrackMetadata {
            title: self.title.clone(),
            artist: self.artist.clone(),
            album: self.album.clone(),
            lyric: self.lyric.clone(),
            // Keep artwork out of V8 entirely: Electron may copy native Buffers
            // on its main thread even when they were created in a worker.
            // Cache failure must not discard otherwise usable tags or lyrics.
            cover_file: cover_cache_dir.and_then(|root| {
                self.cover
                    .as_deref()
                    .and_then(|data| cache_cover(root, data).ok())
            }),
        }
    }
}

fn image_extension(data: &[u8]) -> Option<&'static str> {
    if data.len() < 12 || data.len() > MAX_COVER_BYTES {
        return None;
    }
    if data.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("jpg");
    }
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("png");
    }
    if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        return Some("gif");
    }
    if data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
        return Some("webp");
    }
    None
}

fn cache_cover(root: &Path, data: &[u8]) -> io::Result<String> {
    let ext = image_extension(data)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "unsupported artwork"))?;
    let name = format!("{:x}.{ext}", Sha256::digest(data));
    fs::create_dir_all(root)?;
    let destination = root.join(&name);
    if fs::metadata(&destination)
        .is_ok_and(|stat| stat.is_file() && stat.len() == data.len() as u64)
    {
        return Ok(name);
    }
    // Publish a complete file atomically, including concurrent requests for the
    // same artwork. No second artwork-sized allocation is needed.
    static TEMP_ID: AtomicU64 = AtomicU64::new(0);
    let temporary = root.join(format!(
        ".{name}-{}-{}.tmp",
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(data)?;
        drop(file);
        match fs::rename(&temporary, &destination) {
            Ok(()) => Ok(()),
            // Windows does not replace an existing destination on rename.
            Err(_)
                if fs::metadata(&destination)
                    .is_ok_and(|stat| stat.is_file() && stat.len() == data.len() as u64) =>
            {
                Ok(())
            }
            Err(error) => Err(error),
        }
    })();
    let _ = fs::remove_file(temporary);
    result.map(|()| name)
}

fn lyrics(tags: &HashMap<String, String>) -> Option<String> {
    ["lyrics", "unsyncedlyrics", "unsynced lyrics"]
        .into_iter()
        .find_map(|name| {
            tags.iter()
                .find(|(key, value)| key.eq_ignore_ascii_case(name) && !value.trim().is_empty())
        })
        .or_else(|| {
            tags.iter().find(|(key, value)| {
                let key = key.to_ascii_lowercase();
                (key.starts_with("lyrics-") || key.starts_with("lyrics:"))
                    && !value.trim().is_empty()
            })
        })
        .map(|(_, value)| value.trim_matches(|c: char| c.is_whitespace() || c == '\0'))
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(256 * 1024).collect())
}

fn text(tags: &HashMap<String, String>, name: &str) -> Option<String> {
    tags.iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim_matches(|c: char| c.is_whitespace() || c == '\0'))
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(MAX_TEXT_CHARS).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_only_display_tags_and_bounds_text() {
        let tags = HashMap::from([
            ("TITLE".into(), " \0Song\0 ".into()),
            ("artist".into(), "歌手".into()),
            ("album".into(), " ".into()),
            ("album_id".into(), "123".into()),
        ]);
        assert_eq!(text(&tags, "title").as_deref(), Some("Song"));
        assert_eq!(text(&tags, "artist").as_deref(), Some("歌手"));
        assert_eq!(text(&tags, "album"), None);
        let tags = HashMap::from([("title".into(), "歌".repeat(5000))]);
        assert_eq!(
            text(&tags, "title").unwrap().chars().count(),
            MAX_TEXT_CHARS
        );
    }
}
