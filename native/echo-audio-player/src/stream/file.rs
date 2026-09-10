use super::ReadSeek;
use crate::stream::url::source_path_from_url;
use std::fs::File;

pub fn open(url: &str) -> Result<Box<dyn ReadSeek>, String> {
    let path = source_path_from_url(url)?;
    File::open(&path)
        .map(|file| Box::new(file) as Box<dyn ReadSeek>)
        .map_err(|err| format!("failed to open audio source '{}': {err}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_stream_accepts_plain_local_paths() {
        let path = std::env::temp_dir().join(format!(
            "echo-local-source-smoke-{}.bin",
            std::process::id()
        ));
        std::fs::write(&path, b"local").expect("write fixture");

        let source = open(path.to_str().expect("utf8 path"));
        let _ = std::fs::remove_file(&path);

        assert!(source.is_ok());
    }
}
