use crate::types::PlayerEvent;

#[derive(Clone, Copy, Debug)]
#[allow(dead_code)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

pub fn event(level: LogLevel, message: impl Into<String>) -> PlayerEvent {
    PlayerEvent::log_message("echo-ffmpeg-player", level.as_str(), message)
}
