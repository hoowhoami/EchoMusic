//! Playback state and information.

/// Current playback state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybackState {
    /// Not playing.
    Stopped,
    /// Currently playing.
    Playing,
    /// Paused.
    Paused,
    /// Buffering audio.
    Buffering,
    /// Error occurred.
    Error,
}

/// Detailed playback information.
#[derive(Debug, Clone)]
pub struct PlaybackInfo {
    /// Current state.
    pub state: PlaybackState,
    /// Current position in seconds.
    pub position: f64,
    /// Total duration in seconds (if known).
    pub duration: Option<f64>,
    /// Current volume (0.0 to 1.0).
    pub volume: f32,
    /// Buffer fill percentage.
    pub buffer_level: f32,
    /// Whether audio is muted.
    pub is_muted: bool,
}

impl Default for PlaybackInfo {
    fn default() -> Self {
        Self {
            state: PlaybackState::Stopped,
            position: 0.0,
            duration: None,
            volume: 1.0,
            buffer_level: 0.0,
            is_muted: false,
        }
    }
}

impl PlaybackInfo {
    /// Get remaining time in seconds.
    pub fn remaining(&self) -> Option<f64> {
        self.duration.map(|d| d - self.position)
    }

    /// Get progress percentage (0.0 to 100.0).
    pub fn progress_percentage(&self) -> Option<f32> {
        self.duration.map(|d| (self.position / d * 100.0) as f32)
    }

    /// Check if playback is active (playing or buffering).
    pub fn is_active(&self) -> bool {
        matches!(self.state, PlaybackState::Playing | PlaybackState::Buffering)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod playback_state {
        use super::*;

        #[test]
        fn all_states_exist() {
            let _ = PlaybackState::Stopped;
            let _ = PlaybackState::Playing;
            let _ = PlaybackState::Paused;
            let _ = PlaybackState::Buffering;
            let _ = PlaybackState::Error;
        }
    }

    mod playback_info {
        use super::*;

        #[test]
        fn default_is_stopped() {
            let info = PlaybackInfo::default();
            assert_eq!(info.state, PlaybackState::Stopped);
            assert_eq!(info.position, 0.0);
            assert!(info.duration.is_none());
            assert_eq!(info.volume, 1.0);
            assert_eq!(info.buffer_level, 0.0);
            assert!(!info.is_muted);
        }

        #[test]
        fn remaining_calculates_correctly() {
            let info = PlaybackInfo {
                state: PlaybackState::Playing,
                position: 30.0,
                duration: Some(120.0),
                volume: 1.0,
                buffer_level: 0.5,
                is_muted: false,
            };
            assert_eq!(info.remaining(), Some(90.0));
        }

        #[test]
        fn remaining_none_when_no_duration() {
            let info = PlaybackInfo {
                state: PlaybackState::Playing,
                position: 30.0,
                duration: None,
                volume: 1.0,
                buffer_level: 0.5,
                is_muted: false,
            };
            assert!(info.remaining().is_none());
        }

        #[test]
        fn progress_percentage_calculates_correctly() {
            let info = PlaybackInfo {
                state: PlaybackState::Playing,
                position: 60.0,
                duration: Some(120.0),
                volume: 1.0,
                buffer_level: 0.5,
                is_muted: false,
            };
            let progress = info.progress_percentage().unwrap();
            assert!((progress - 50.0).abs() < 0.01);
        }

        #[test]
        fn is_active_when_playing() {
            let info = PlaybackInfo {
                state: PlaybackState::Playing,
                ..Default::default()
            };
            assert!(info.is_active());
        }

        #[test]
        fn is_active_when_buffering() {
            let info = PlaybackInfo {
                state: PlaybackState::Buffering,
                ..Default::default()
            };
            assert!(info.is_active());
        }

        #[test]
        fn not_active_when_stopped() {
            let info = PlaybackInfo {
                state: PlaybackState::Stopped,
                ..Default::default()
            };
            assert!(!info.is_active());
        }

        #[test]
        fn not_active_when_paused() {
            let info = PlaybackInfo {
                state: PlaybackState::Paused,
                ..Default::default()
            };
            assert!(!info.is_active());
        }
    }
}
