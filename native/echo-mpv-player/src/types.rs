// NAPI 导出的共享类型

use napi_derive::napi;

/// 播放器状态快照
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
        }
    }
}

/// 播放器事件
#[napi(object)]
#[derive(Clone, Debug)]
pub struct PlayerEvent {
    /// time-update / duration-change / state-change / playback-end / file-loaded / idle / error
    pub r#type: String,
    /// 事件关联的数值（time-pos、duration、volume 等）
    pub value: Option<f64>,
    /// 事件关联的布尔值（paused、playing 等）
    pub flag: Option<bool>,
    /// 事件关联的字符串（错误信息、end-file reason 等）
    pub message: Option<String>,
}

impl PlayerEvent {
    pub fn time_update(time: f64) -> Self {
        Self {
            r#type: "time-update".to_string(),
            value: Some(time),
            flag: None,
            message: None,
        }
    }

    pub fn duration_change(duration: f64) -> Self {
        Self {
            r#type: "duration-change".to_string(),
            value: Some(duration),
            flag: None,
            message: None,
        }
    }

    pub fn state_change(paused: bool) -> Self {
        Self {
            r#type: "state-change".to_string(),
            value: None,
            flag: Some(paused),
            message: None,
        }
    }

    pub fn playback_end(reason: &str) -> Self {
        Self {
            r#type: "playback-end".to_string(),
            value: None,
            flag: None,
            message: Some(reason.to_string()),
        }
    }

    pub fn file_loaded() -> Self {
        Self {
            r#type: "file-loaded".to_string(),
            value: None,
            flag: None,
            message: None,
        }
    }

    pub fn idle() -> Self {
        Self {
            r#type: "idle".to_string(),
            value: None,
            flag: None,
            message: None,
        }
    }

    pub fn error(msg: &str) -> Self {
        Self {
            r#type: "error".to_string(),
            value: None,
            flag: None,
            message: Some(msg.to_string()),
        }
    }

    pub fn fade_complete() -> Self {
        Self {
            r#type: "fade-complete".to_string(),
            value: None,
            flag: None,
            message: None,
        }
    }
}

/// 音轨信息
#[napi(object)]
#[derive(Clone, Debug)]
pub struct TrackInfo {
    pub id: i64,
    pub r#type: String,
    pub codec: String,
    pub title: Option<String>,
    pub lang: Option<String>,
}

/// 音频设备信息
#[napi(object)]
#[derive(Clone, Debug)]
pub struct AudioDevice {
    pub name: String,
    pub description: String,
}
