use std::path::PathBuf;

pub fn source_path_from_url(value: &str) -> Result<PathBuf, String> {
    if is_file_scheme(value) {
        return file_url_to_path(value, cfg!(windows));
    }
    let path = if cfg!(windows) {
        normalize_windows_file_url_path(value)
    } else {
        value.to_string()
    };
    Ok(PathBuf::from(path))
}

fn file_url_to_path(value: &str, windows: bool) -> Result<PathBuf, String> {
    let Some(mut rest) = strip_file_scheme(value) else {
        return Ok(PathBuf::from(value));
    };
    let mut authority = "";
    if let Some(without_slashes) = rest.strip_prefix("//") {
        let slash_index = without_slashes.find('/').unwrap_or(without_slashes.len());
        authority = &without_slashes[..slash_index];
        rest = &without_slashes[slash_index..];
    }

    let path_part = strip_url_suffix(rest);
    let decoded_path = percent_decode_file_url(path_part);
    let decoded_authority = percent_decode_file_url(authority);
    let has_local_authority =
        decoded_authority.is_empty() || decoded_authority.eq_ignore_ascii_case("localhost");

    if !has_local_authority {
        if !windows {
            return Err(format!(
                "unsupported non-local file URL authority '{}'",
                decoded_authority
            ));
        }
        let unc_path = format!(
            "//{}{}",
            decoded_authority,
            ensure_leading_slash(&decoded_path)
        );
        return Ok(PathBuf::from(unc_path));
    }

    let path = if windows {
        normalize_windows_file_url_path(&decoded_path)
    } else {
        decoded_path
    };
    if path.is_empty() {
        return Err("empty file URL path".to_string());
    }
    Ok(PathBuf::from(path))
}

fn is_file_scheme(value: &str) -> bool {
    value
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file:"))
}

fn strip_file_scheme(value: &str) -> Option<&str> {
    is_file_scheme(value).then_some(&value[5..])
}

fn strip_url_suffix(value: &str) -> &str {
    let suffix_start = value.find(['?', '#']).unwrap_or(value.len());
    &value[..suffix_start]
}

fn ensure_leading_slash(value: &str) -> String {
    if value.starts_with('/') {
        value.to_string()
    } else {
        format!("/{value}")
    }
}

fn normalize_windows_file_url_path(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 3 && bytes[0] == b'/' && bytes[2] == b':' && bytes[1].is_ascii_alphabetic() {
        value[1..].to_string()
    } else {
        value.to_string()
    }
}

fn percent_decode_file_url(value: &str) -> String {
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
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_url_parser_decodes_posix_paths() {
        let path =
            file_url_to_path("file:///Users/whoami/Music/a%20b.flac", false).expect("file url");

        assert_eq!(path, PathBuf::from("/Users/whoami/Music/a b.flac"));
    }

    #[test]
    fn file_url_parser_accepts_localhost_and_strips_url_suffix() {
        let path = file_url_to_path("file://localhost/tmp/a%23b.flac?cache=1#frag", false)
            .expect("file url");

        assert_eq!(path, PathBuf::from("/tmp/a#b.flac"));
    }

    #[test]
    fn file_url_parser_rejects_non_local_authority_on_unix() {
        let err = file_url_to_path("file://server/share/a.flac", false).expect_err("error");

        assert!(err.contains("unsupported non-local file URL authority"));
    }

    #[test]
    fn file_url_parser_handles_windows_drive_paths() {
        let path =
            file_url_to_path("file:///C:/Users/whoami/Music/a%20b.flac", true).expect("file url");

        assert_eq!(path, PathBuf::from("C:/Users/whoami/Music/a b.flac"));
    }

    #[test]
    fn file_url_parser_is_case_insensitive_for_scheme() {
        let path = file_url_to_path("FILE:///D:/.data/Music/a.flac", true).expect("file url");

        assert_eq!(path, PathBuf::from("D:/.data/Music/a.flac"));
    }

    #[test]
    fn local_source_parser_handles_windows_slash_drive_paths() {
        let path = source_path_from_url("/D:/.data/Music/a.flac").expect("local path");

        if cfg!(windows) {
            assert_eq!(path, PathBuf::from("D:/.data/Music/a.flac"));
        } else {
            assert_eq!(path, PathBuf::from("/D:/.data/Music/a.flac"));
        }
    }

    #[test]
    fn file_url_parser_handles_windows_unc_paths() {
        let path = file_url_to_path("file://server/share/a.flac", true).expect("file url");

        assert_eq!(path, PathBuf::from("//server/share/a.flac"));
    }
}
