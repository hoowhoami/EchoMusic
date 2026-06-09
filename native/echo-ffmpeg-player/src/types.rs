use napi_derive::napi;

#[napi(object)]
#[derive(Clone, Debug)]
pub struct PlayerState {
    pub playing: bool,
    pub paused: bool,
    pub duration: f64,
    pub time_pos: f64,
    pub volume: f64,
    pub speed: f64,
    pub idle: bool,
    pub path: String,
    pub audio_device: String,
    pub audio_track_id: i64,
}

impl Default for PlayerState {
    fn default() -> Self {
        Self {
            playing: false,
            paused: true,
            duration: 0.0,
            time_pos: 0.0,
            volume: 100.0,
            speed: 1.0,
            idle: true,
            path: String::new(),
            audio_device: "auto".to_string(),
            audio_track_id: 0,
        }
    }
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct PlayerEvent {
    pub r#type: String,
    pub value: Option<f64>,
    pub flag: Option<bool>,
    pub message: Option<String>,
    pub devices: Option<Vec<AudioDevice>>,
    pub prefix: Option<String>,
    pub level: Option<String>,
}

impl PlayerEvent {
    fn empty(event_type: &str) -> Self {
        Self {
            r#type: event_type.to_string(),
            value: None,
            flag: None,
            message: None,
            devices: None,
            prefix: None,
            level: None,
        }
    }

    pub fn time_update(time: f64) -> Self {
        Self {
            value: Some(time),
            ..Self::empty("time-update")
        }
    }

    pub fn duration_change(duration: f64) -> Self {
        Self {
            value: Some(duration),
            ..Self::empty("duration-change")
        }
    }

    pub fn state_change(paused: bool) -> Self {
        Self {
            flag: Some(paused),
            ..Self::empty("state-change")
        }
    }

    pub fn playback_end(reason: &str) -> Self {
        Self {
            message: Some(reason.to_string()),
            ..Self::empty("playback-end")
        }
    }

    pub fn file_loaded() -> Self {
        Self::empty("file-loaded")
    }

    pub fn idle() -> Self {
        Self::empty("idle")
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            message: Some(message.into()),
            ..Self::empty("error")
        }
    }

    pub fn audio_device_list_changed(devices: Vec<AudioDevice>) -> Self {
        Self {
            devices: Some(devices),
            ..Self::empty("audio-device-list-changed")
        }
    }

    pub fn fade_complete() -> Self {
        Self::empty("fade-complete")
    }

    pub fn log_message(prefix: &str, level: &str, message: impl Into<String>) -> Self {
        Self {
            message: Some(message.into()),
            prefix: Some(prefix.to_string()),
            level: Some(level.to_string()),
            ..Self::empty("log-message")
        }
    }
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct TrackInfo {
    pub id: i64,
    pub r#type: String,
    pub codec: String,
    pub title: Option<String>,
    pub lang: Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct AudioDevice {
    pub name: String,
    pub description: String,
}
