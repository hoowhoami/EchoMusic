use napi_derive::napi;

#[napi(object)]
#[derive(Clone, Debug)]
pub struct AudioDevice {
    pub name: String,
    pub description: String,
    pub is_default: Option<bool>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct TrackInfo {
    pub id: i64,
    pub r#type: String,
    pub selected: bool,
    pub codec: Option<String>,
    pub title: Option<String>,
    pub lang: Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug, Default)]
pub struct PlayerState {
    pub playing: bool,
    pub paused: bool,
    pub duration: f64,
    pub time_pos: f64,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct SpectrumFrame {
    pub bins: Vec<f64>,
    pub peak: f64,
    pub rms: f64,
    pub timestamp: f64,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct SpectrumStatus {
    pub available: bool,
    pub running: bool,
    pub reason: Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct SpectrumOptions {
    pub bands: Option<u32>,
    pub fps: Option<u32>,
    pub min_frequency: Option<f64>,
    pub max_frequency: Option<f64>,
    pub smoothing: Option<f64>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct PlayerEvent {
    pub event: String,
    pub time: Option<f64>,
    pub duration: Option<f64>,
    pub state: Option<PlayerState>,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub error_code: Option<String>,
    pub level: Option<String>,
    pub devices: Option<Vec<AudioDevice>>,
    pub device_change_kind: Option<String>,
    pub disconnected_devices: Option<Vec<AudioDevice>>,
    pub path: Option<String>,
    pub seq: Option<f64>,
}

#[derive(Clone, Copy, Debug)]
pub enum PlayerErrorCode {
    Decode,
    OutputConfig,
    OutputDeviceUnavailable,
    OutputExclusive,
    OutputRuntime,
    OutputStream,
}

impl PlayerErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Decode => "decode",
            Self::OutputConfig => "output-config",
            Self::OutputDeviceUnavailable => "output-device-unavailable",
            Self::OutputExclusive => "output-exclusive",
            Self::OutputRuntime => "output-runtime",
            Self::OutputStream => "output-stream",
        }
    }
}

impl PlayerEvent {
    pub fn time_update(time: f64) -> Self {
        Self {
            event: "time-update".to_string(),
            time: Some(time),
            duration: None,
            state: None,
            reason: None,
            message: None,
            error_code: None,
            level: None,
            devices: None,
            device_change_kind: None,
            disconnected_devices: None,
            path: None,
            seq: None,
        }
    }

    pub fn duration_change(duration: f64) -> Self {
        Self {
            event: "duration-change".to_string(),
            duration: Some(duration),
            ..Self::empty("duration-change")
        }
    }

    pub fn file_loaded(path: String, seq: u64) -> Self {
        Self {
            event: "file-loaded".to_string(),
            path: Some(path),
            seq: Some(seq as f64),
            ..Self::empty("file-loaded")
        }
    }

    pub fn state_change(state: PlayerState) -> Self {
        Self {
            event: "state-change".to_string(),
            state: Some(state),
            ..Self::empty("state-change")
        }
    }

    pub fn playback_end(reason: &str) -> Self {
        Self {
            event: "playback-end".to_string(),
            reason: Some(reason.to_string()),
            ..Self::empty("playback-end")
        }
    }

    pub fn stalled(time: f64) -> Self {
        Self {
            event: "stalled".to_string(),
            time: Some(time),
            ..Self::empty("stalled")
        }
    }

    pub fn seeked(time: f64) -> Self {
        Self {
            event: "seeked".to_string(),
            time: Some(time),
            ..Self::empty("seeked")
        }
    }

    pub fn audio_device_list_changed(
        devices: Vec<AudioDevice>,
        device_change_kind: &str,
        disconnected_devices: Vec<AudioDevice>,
    ) -> Self {
        Self {
            event: "audio-device-list-changed".to_string(),
            devices: Some(devices),
            device_change_kind: Some(device_change_kind.to_string()),
            disconnected_devices: Some(disconnected_devices),
            ..Self::empty("audio-device-list-changed")
        }
    }

    pub fn error(code: PlayerErrorCode, message: String) -> Self {
        Self {
            event: "error".to_string(),
            message: Some(message),
            error_code: Some(code.as_str().to_string()),
            ..Self::empty("error")
        }
    }

    pub fn log(level: &str, message: String) -> Self {
        Self {
            event: "log".to_string(),
            level: Some(level.to_string()),
            message: Some(message),
            ..Self::empty("log")
        }
    }

    pub fn impulse_response_disabled(reason: String) -> Self {
        Self {
            event: "impulse-response-disabled".to_string(),
            reason: Some(reason),
            ..Self::empty("impulse-response-disabled")
        }
    }

    fn empty(event: &str) -> Self {
        Self {
            event: event.to_string(),
            time: None,
            duration: None,
            state: None,
            reason: None,
            message: None,
            error_code: None,
            level: None,
            devices: None,
            device_change_kind: None,
            disconnected_devices: None,
            path: None,
            seq: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_event_exposes_stable_error_code() {
        let event = PlayerEvent::error(PlayerErrorCode::OutputStream, "failed".to_string());

        assert_eq!(event.error_code.as_deref(), Some("output-stream"));
        assert_eq!(event.message.as_deref(), Some("failed"));
    }
}
