use crate::audio_graph::AudioGraphSnapshot;
use crate::shared::{AudioOutputStats, PacketCacheStats};
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
    pub event_id: Option<f64>,
    pub track_seq: Option<f64>,
    pub generation: Option<f64>,
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
    pub core_state: Option<String>,
    pub cache_paused: Option<bool>,
    pub cache_buffering_state: Option<f64>,
    pub cache_buffered_secs: Option<f64>,
    pub cache_target_secs: Option<f64>,
    pub packet_cache: Option<PacketCacheStats>,
    pub output_stats: Option<AudioOutputStats>,
    pub audio_graph: Option<AudioGraphSnapshot>,
}

#[derive(Clone, Copy, Debug)]
pub enum PlayerErrorCode {
    Cache,
    Decode,
    Dsp,
    Network,
    OutputConfig,
    OutputDeviceUnavailable,
    OutputExclusive,
    OutputRuntime,
    OutputStream,
    Seek,
}

impl PlayerErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Cache => "cache",
            Self::Decode => "decode",
            Self::Dsp => "dsp",
            Self::Network => "network",
            Self::OutputConfig => "output-config",
            Self::OutputDeviceUnavailable => "output-device-unavailable",
            Self::OutputExclusive => "output-exclusive",
            Self::OutputRuntime => "output-runtime",
            Self::OutputStream => "output-stream",
            Self::Seek => "seek",
        }
    }
}

impl PlayerEvent {
    pub fn time_update(time: f64) -> Self {
        Self {
            event: "time-update".to_string(),
            time: Some(time),
            ..Self::empty("time-update")
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

    pub fn playback_restart(time: f64, reason: &str) -> Self {
        Self {
            event: "playback-restart".to_string(),
            time: Some(time.max(0.0)),
            reason: Some(reason.to_string()),
            ..Self::empty("playback-restart")
        }
    }

    pub fn seek(time: f64) -> Self {
        Self {
            event: "seek".to_string(),
            time: Some(time.max(0.0)),
            ..Self::empty("seek")
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

    pub fn core_state_change(state: &str, reason: &str) -> Self {
        Self {
            event: "core-state-change".to_string(),
            core_state: Some(state.to_string()),
            reason: Some(reason.to_string()),
            ..Self::empty("core-state-change")
        }
    }

    pub fn cache_state_change(
        paused: bool,
        buffering_state: f64,
        buffered_secs: f64,
        target_secs: f64,
        packet_cache: Option<PacketCacheStats>,
    ) -> Self {
        Self {
            event: "cache-state-change".to_string(),
            cache_paused: Some(paused),
            cache_buffering_state: Some(buffering_state.clamp(0.0, 100.0)),
            cache_buffered_secs: Some(buffered_secs.max(0.0)),
            cache_target_secs: Some(target_secs.max(0.0)),
            packet_cache,
            ..Self::empty("cache-state-change")
        }
    }

    pub fn packet_cache_stats(stats: PacketCacheStats) -> Self {
        Self {
            event: "packet-cache-stats".to_string(),
            packet_cache: Some(stats),
            ..Self::empty("packet-cache-stats")
        }
    }

    pub fn output_stats(stats: AudioOutputStats) -> Self {
        Self {
            event: "audio-output-stats".to_string(),
            output_stats: Some(stats),
            ..Self::empty("audio-output-stats")
        }
    }

    pub fn audio_graph_change(graph: AudioGraphSnapshot) -> Self {
        Self {
            event: "audio-graph-change".to_string(),
            audio_graph: Some(graph),
            ..Self::empty("audio-graph-change")
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
            event_id: None,
            track_seq: None,
            generation: None,
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
            core_state: None,
            cache_paused: None,
            cache_buffering_state: None,
            cache_buffered_secs: None,
            cache_target_secs: None,
            packet_cache: None,
            output_stats: None,
            audio_graph: None,
        }
    }

    pub fn with_event_id(mut self, event_id: u64) -> Self {
        self.event_id = Some(event_id as f64);
        self
    }

    pub fn with_playback_context(mut self, track_seq: u64, generation: u64) -> Self {
        if track_seq > 0 {
            self.track_seq = Some(track_seq as f64);
        }
        self.generation = Some(generation as f64);
        self
    }

    pub fn is_droppable_when_event_queue_is_full(&self) -> bool {
        matches!(
            self.event.as_str(),
            "time-update"
                | "log"
                | "cache-state-change"
                | "packet-cache-stats"
                | "audio-output-stats"
        )
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

    #[test]
    fn cache_state_event_clamps_public_values() {
        let event = PlayerEvent::cache_state_change(true, 120.0, -1.0, -2.0, None);

        assert_eq!(event.event, "cache-state-change");
        assert_eq!(event.cache_paused, Some(true));
        assert_eq!(event.cache_buffering_state, Some(100.0));
        assert_eq!(event.cache_buffered_secs, Some(0.0));
        assert_eq!(event.cache_target_secs, Some(0.0));
        assert!(event.packet_cache.is_none());
    }

    #[test]
    fn audio_graph_event_carries_structured_snapshot() {
        let event = PlayerEvent::audio_graph_change(AudioGraphSnapshot::default());

        assert_eq!(event.event, "audio-graph-change");
        assert!(event.audio_graph.is_some());
        assert!(!event.is_droppable_when_event_queue_is_full());
    }
}
