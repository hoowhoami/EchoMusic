use super::{ReadSeek, StreamOptions};
use ffmpeg_audio::{error::HttpError, AudioError, HttpAudioSource, HttpAudioSourceOptions};
use std::sync::atomic::{AtomicBool, Ordering};
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
    let candidates = if options.http_proxies.is_empty() {
        vec![None]
    } else {
        options.http_proxies.clone()
    };
    let mut last_error = None;
    for proxy_url in candidates {
        match HttpAudioSource::new_with_options_and_cancel_flag(
            url,
            HttpAudioSourceOptions {
                connect_timeout: connect_timeout(options.network_timeout),
                recv_timeout: options.network_timeout,
                proxy_url,
            },
            interrupt.clone(),
        ) {
            Ok(source) => return Ok(Box::new(source) as Box<dyn ReadSeek>),
            Err(error) => {
                let can_fallback = can_fallback_proxy_candidate(&error);
                last_error = Some(error);
                if interrupt.load(Ordering::SeqCst) || !can_fallback {
                    break;
                }
            }
        }
    }
    Err(format!(
        "failed to open network audio source: {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "no usable proxy candidate".to_string())
    ))
}

fn connect_timeout(network_timeout: Duration) -> Duration {
    network_timeout.min(Duration::from_secs(10))
}

fn can_fallback_proxy_candidate(error: &AudioError) -> bool {
    matches!(
        error,
        AudioError::Http(HttpError::Transport(_) | HttpError::Timeout)
    )
}

#[cfg(test)]
mod tests {
    use super::can_fallback_proxy_candidate;
    use ffmpeg_audio::{error::HttpError, AudioError};

    #[test]
    fn transport_failures_can_try_the_next_proxy_candidate() {
        assert!(can_fallback_proxy_candidate(&AudioError::Http(
            HttpError::Transport("proxy unavailable".to_string()),
        )));
        assert!(can_fallback_proxy_candidate(&AudioError::Http(
            HttpError::Timeout,
        )));
    }

    #[test]
    fn server_responses_do_not_bypass_the_selected_proxy() {
        assert!(!can_fallback_proxy_candidate(&AudioError::Http(
            HttpError::Status(404),
        )));
        assert!(!can_fallback_proxy_candidate(&AudioError::Http(
            HttpError::InvalidContentRange("invalid".to_string()),
        )));
    }
}
