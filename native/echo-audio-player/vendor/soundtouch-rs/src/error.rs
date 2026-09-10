use thiserror::Error;

/// Errors that can occur during SoundTouch processing.
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum SoundTouchError {
    /// Provided channel count is invalid (must be > 0).
    #[error("Invalid channel count: {provided}. Must be greater than 0.")]
    InvalidChannels { provided: usize },

    /// Provided sample rate is invalid (must be > 0).
    #[error("Invalid sample rate: {provided}. Must be greater than 0.")]
    InvalidSampleRate { provided: usize },

    /// Maximum safety limit for the internal buffer has been exceeded, preventing Out-Of-Memory
    /// (OOM).
    #[error("Buffer capacity limit exceeded. Max allowed frames: {limit}, requested: {requested}.")]
    CapacityLimitExceeded { limit: usize, requested: usize },

    /// The length of the anti-aliasing filter must be a multiple of 4.
    #[error("Filter length must be a multiple of 4, provided: {provided}.")]
    FilterLengthNotMultipleOf4 { provided: usize },

    /// The requested filter length exceeds the statically pre-allocated memory.
    #[error("Requested filter length {provided} exceeds pre-allocated capacity {capacity}.")]
    FilterCapacityExceeded { provided: usize, capacity: usize },

    /// The number of slices provided does not match the configured channel count.
    #[error(
        "Channel count mismatch. Expected {expected} channels, but provided slice array contains {provided}."
    )]
    ChannelCountMismatch { expected: usize, provided: usize },

    /// The slices provided for planar audio do not have identical lengths.
    #[error(
        "Planar channel length mismatch. Channel 0 has {expected_len} frames, but channel {mismatched_channel} has {mismatched_len} frames."
    )]
    PlanarLengthMismatch {
        expected_len: usize,
        mismatched_channel: usize,
        mismatched_len: usize,
    },
}

pub type Result<T, E = SoundTouchError> = std::result::Result<T, E>;
