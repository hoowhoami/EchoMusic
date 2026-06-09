use napi::{Error, Status};
use std::fmt;

pub type PlayerResult<T> = Result<T, PlayerError>;

#[derive(Debug, Clone)]
pub enum PlayerError {
    NotInitialized,
    InvalidInput(String),
    Unsupported(String),
    Backend(String),
    State(String),
}

impl PlayerError {
    fn code(&self) -> &'static str {
        match self {
            Self::NotInitialized => "not_initialized",
            Self::InvalidInput(_) => "invalid_input",
            Self::Unsupported(_) => "unsupported",
            Self::Backend(_) => "backend",
            Self::State(_) => "state",
        }
    }

    pub fn into_napi(self) -> Error {
        Error::new(Status::GenericFailure, self.to_string())
    }
}

impl fmt::Display for PlayerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotInitialized => {
                write!(
                    f,
                    "[EchoFfmpegPlayer:{}] player not initialized",
                    self.code()
                )
            }
            Self::InvalidInput(message)
            | Self::Unsupported(message)
            | Self::Backend(message)
            | Self::State(message) => {
                write!(f, "[EchoFfmpegPlayer:{}] {message}", self.code())
            }
        }
    }
}

impl std::error::Error for PlayerError {}

pub fn clamp_f64(value: f64, min: f64, max: f64) -> PlayerResult<f64> {
    if !value.is_finite() {
        return Err(PlayerError::InvalidInput(
            "number must be finite".to_string(),
        ));
    }
    Ok(value.clamp(min, max))
}
