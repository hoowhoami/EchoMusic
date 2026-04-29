use napi_derive::napi;

/// 歌曲元数据
#[napi(object)]
pub struct MetadataPayload {
    /// 歌曲标题
    pub title: String,
    /// 歌手名
    pub artist: String,
    /// 专辑名
    pub album: String,
    /// 封面图片原始字节
    pub cover_data: Option<Vec<u8>>,
    /// 封面 HTTP URL（Linux MPRIS 备用）
    pub cover_url: Option<String>,
    /// 歌曲时长，单位毫秒
    pub duration_ms: Option<f64>,
}

/// 播放状态
#[napi(object)]
pub struct PlayStatePayload {
    /// Playing / Paused / Stopped
    pub status: String,
}

/// 播放进度
#[napi(object)]
pub struct TimelinePayload {
    /// 当前播放位置，单位毫秒
    pub current_time_ms: f64,
    /// 总时长，单位毫秒
    pub total_time_ms: f64,
}

/// 系统媒体控制事件
#[napi(object)]
#[derive(Clone)]
pub struct MediaControlEvent {
    /// Play / Pause / Stop / NextSong / PreviousSong / Seek
    pub r#type: String,
    /// Seek 事件的目标位置，单位毫秒
    pub position_ms: Option<f64>,
}

impl MediaControlEvent {
    pub fn play() -> Self {
        Self {
            r#type: "Play".to_string(),
            position_ms: None,
        }
    }

    pub fn pause() -> Self {
        Self {
            r#type: "Pause".to_string(),
            position_ms: None,
        }
    }

    pub fn stop() -> Self {
        Self {
            r#type: "Stop".to_string(),
            position_ms: None,
        }
    }

    pub fn next() -> Self {
        Self {
            r#type: "NextSong".to_string(),
            position_ms: None,
        }
    }

    pub fn previous() -> Self {
        Self {
            r#type: "PreviousSong".to_string(),
            position_ms: None,
        }
    }

    pub fn seek(position_ms: f64) -> Self {
        Self {
            r#type: "Seek".to_string(),
            position_ms: Some(position_ms),
        }
    }
}
